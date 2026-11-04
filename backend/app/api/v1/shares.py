"""分享 API：查看 / 验证提取码 / 下载。

GET  /api/v1/shares/:code          — 分享详情（公开信息）
POST /api/v1/shares/:code/verify   — 验证提取码（有密码时需要）
GET  /api/v1/shares/:code/download — 获取下载 URL（计数 +1）
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote
from uuid import UUID, uuid4

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import get_current_user_optional
from app.models.media import MediaProcessingJob, ShareMediaAsset
from app.models.share import DownloadLog, DownloadSession, Share, ShareLogicalFile
from app.models.system import Report
from app.models.user import User
from app.schemas.admin import DownloadConfigResponse
from app.schemas.share import (
    ChunkDownloadInfo,
    GalleryAssetInfo,
    GalleryFileInfo,
    GallerySessionRequest,
    GallerySessionResponse,
    ShareDownloadResponse,
    ShareDownloadSessionRequest,
    ShareFileDownload,
    ShareFileInfo,
    ShareInfoResponse,
    ShareInteractionRequest,
    ShareVerifyRequest,
    ShareVerifyResponse,
)
from app.services.app_config import get_download_config
from app.services.doubao_client import (
    DoubaoClientError,
    DoubaoDownloadUrlResolver,
    DownloadUrlResult,
)
from app.services.growth import trigger_referral_qualification
from app.services.media_jobs import (
    MEDIA_PROCESSING_VERSION,
    REQUIRED_GALLERY_ASSET_KINDS,
    ensure_gallery_jobs,
    is_gallery_eligible,
    is_supported_image,
    uses_original_jpeg_preview,
)
from app.services.share_access import record_share_access
from app.services.visitor_identity import (
    INTERACTION_RATE_LIMIT,
    check_public_event_rate_limit,
    public_event_rate_limit_key,
    resolve_visitor_identity,
)
from app.utils.client_ip import get_client_ip
from app.utils.security import verify_secret

log = logging.getLogger(__name__)
router = APIRouter(prefix="/shares", tags=["shares"])
_EMPTY_URI_PREFIX = "nyy-empty://"
_EMPTY_FILE_DATA_URL = "data:application/octet-stream;base64,"
_DOWNLOAD_SESSION_TTL = timedelta(minutes=5)
_WECHAT_PROXY_CACHE_DIR = Path("/data/nyy-runtime/download-proxy-cache")
_WECHAT_PROXY_CACHE_TTL_SECONDS = 6 * 60 * 60
_WECHAT_PROXY_CACHE_MAX_BYTES = 10 * 1024**3
_WECHAT_PROXY_CACHE_PRUNE_LOCK = asyncio.Lock()
_WECHAT_PROXY_FILE_LOCKS: dict[UUID, asyncio.Lock] = {}
_SHARE_PASSWORD_ATTEMPT_LIMIT = 10


def _is_wechat_user_agent(user_agent: str) -> bool:
    return bool(re.search(r"MicroMessenger|\bwxwork/", user_agent, re.IGNORECASE))


async def _enforce_share_password_rate_limit(code: str, request: Request) -> None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "服务暂时不可用")
    key = public_event_rate_limit_key(f"share-password:{code}", get_client_ip(request))
    failed_attempts = int(await redis.get(key) or 0)
    if failed_attempts >= _SHARE_PASSWORD_ATTEMPT_LIMIT:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "提取码尝试过于频繁，请稍后再试")


async def _raise_invalid_share_password(code: str, request: Request) -> None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "服务暂时不可用")
    allowed = await check_public_event_rate_limit(
        redis,
        scope=f"share-password:{code}",
        client_ip=get_client_ip(request),
        limit=_SHARE_PASSWORD_ATTEMPT_LIMIT,
    )
    if not allowed:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "提取码尝试过于频繁，请稍后再试")
    raise HTTPException(status.HTTP_403_FORBIDDEN, "提取码错误")


def _attach_same_origin_download_urls(
    response: ShareDownloadResponse,
    share: Share,
    logical_files: list[ShareLogicalFile],
    request_id: str,
) -> None:
    for logical_file, download in zip(
        sorted(logical_files, key=lambda item: item.sort_index),
        response.files,
        strict=False,
    ):
        if logical_file.chunk_total != 1 or len(logical_file.files) != 1:
            continue
        download.proxy_download_url = (
            f"/api/v1/shares/{share.code}/download-proxy/{logical_file.id}"
            f"?session={request_id}"
        )


def _download_content_disposition(file_name: str) -> str:
    extension = file_name.rsplit(".", 1)[1] if "." in file_name else "bin"
    safe_extension = re.sub(r"[^A-Za-z0-9]", "", extension)[:16] or "bin"
    return f"attachment; filename=download.{safe_extension}; filename*=UTF-8''{quote(file_name, safe='')}"


def _create_proxy_http_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        follow_redirects=True,
        timeout=httpx.Timeout(connect=15.0, read=None, write=15.0, pool=15.0),
    )


def _prune_proxy_cache(required_bytes: int) -> None:
    _WECHAT_PROXY_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    now = time.time()
    cached_files: list[tuple[Path, os.stat_result]] = []
    for entry in _WECHAT_PROXY_CACHE_DIR.iterdir():
        try:
            if entry.is_symlink():
                entry.unlink(missing_ok=True)
                continue
            file_stat = entry.stat()
        except FileNotFoundError:
            continue
        if not entry.is_file():
            continue
        age = now - file_stat.st_mtime
        if entry.name.endswith(".part"):
            if age > 60 * 60:
                entry.unlink(missing_ok=True)
            continue
        if age > _WECHAT_PROXY_CACHE_TTL_SECONDS:
            entry.unlink(missing_ok=True)
            continue
        cached_files.append((entry, file_stat))

    total_bytes = sum(file_stat.st_size for _, file_stat in cached_files)
    for entry, file_stat in sorted(cached_files, key=lambda item: item[1].st_mtime):
        if total_bytes + required_bytes <= _WECHAT_PROXY_CACHE_MAX_BYTES:
            break
        entry.unlink(missing_ok=True)
        total_bytes -= file_stat.st_size


async def _ensure_proxy_cache_file(
    logical_file_id: UUID,
    file_name: str,
    file_size: int,
    store_uri: str,
) -> Path:
    suffix = Path(file_name).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,16}", suffix):
        suffix = ".bin"
    target = _WECHAT_PROXY_CACHE_DIR / f"{logical_file_id}{suffix}"
    if target.is_file() and target.stat().st_size == file_size:
        return target

    file_lock = _WECHAT_PROXY_FILE_LOCKS.setdefault(logical_file_id, asyncio.Lock())
    async with file_lock:
        if target.is_file() and target.stat().st_size == file_size:
            return target
        async with _WECHAT_PROXY_CACHE_PRUNE_LOCK:
            await asyncio.to_thread(_prune_proxy_cache, file_size)
        resolver = DoubaoDownloadUrlResolver()
        try:
            urls = await resolver.get_download_urls(store_uri, expire_seconds=900)
        except Exception as exc:
            log.warning("wechat download cache sign failed: %s", exc)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "暂时无法准备下载，请稍后重试") from exc

        client = _create_proxy_http_client()
        temporary = target.with_name(f".{target.name}.{uuid4().hex}.part")
        upstream = None
        try:
            upstream = await client.send(
                client.build_request("GET", urls.main_url, headers={"Accept-Encoding": "identity"}),
                stream=True,
            )
            if upstream.status_code != status.HTTP_200_OK:
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "文件源暂时不可用，请稍后重试")
            downloaded = 0
            with temporary.open("wb") as output:
                async for chunk in upstream.aiter_raw():
                    downloaded += len(chunk)
                    if downloaded > file_size:
                        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "文件源返回大小异常，请稍后重试")
                    await asyncio.to_thread(output.write, chunk)
                await asyncio.to_thread(output.flush)
                await asyncio.to_thread(os.fsync, output.fileno())
            if downloaded != file_size:
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "文件源返回不完整，请稍后重试")
            await asyncio.to_thread(os.replace, temporary, target)
            await asyncio.to_thread(os.chmod, target, 0o644)
            return target
        except HTTPException:
            raise
        except Exception as exc:
            log.warning("wechat download cache fill failed: %s", exc)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "文件源暂时不可用，请稍后重试") from exc
        finally:
            if upstream is not None:
                await upstream.aclose()
            await client.aclose()
            temporary.unlink(missing_ok=True)


async def _record_link_issued(
    share_id,
    request: Request,
    *,
    user_id=None,
    request_id: str | None = None,
    http_status: int | None = None,
    request_time_ms: int | None = None,
) -> None:
    trusted_visitor_id = None
    if user_id is None:
        trusted_visitor_id = await resolve_visitor_identity(
            request,
            redis=getattr(request.app.state, "redis", None),
        )
    await record_share_access(
        share_id,
        "link_issued",
        request,
        user_id=user_id,
        request_id=request_id,
        http_status=http_status,
        request_time_ms=request_time_ms,
        trusted_visitor_id=trusted_visitor_id,
    )
    await trigger_referral_qualification(share_id)


async def _reserve_download_link(
    db: AsyncSession,
    share: Share,
    request: Request,
    *,
    request_id: str | None = None,
    response_metadata: dict | None = None,
) -> bool:
    now = datetime.now(UTC)
    if request_id:
        inserted_id = await db.scalar(
            pg_insert(DownloadSession)
            .values(
                share_id=share.id,
                request_id=request_id,
                response_payload=response_metadata or {},
                created_at=now,
                expires_at=now + _DOWNLOAD_SESSION_TTL,
            )
            .on_conflict_do_nothing(
                constraint="uq_download_sessions_share_request",
            )
            .returning(DownloadSession.id)
        )
        if inserted_id is None:
            existing = await db.scalar(
                select(DownloadSession)
                .where(
                    DownloadSession.share_id == share.id,
                    DownloadSession.request_id == request_id,
                )
                .with_for_update()
            )
            if existing is not None and existing.expires_at > now:
                return False
            if existing is not None:
                existing.response_payload = response_metadata or {}
                existing.created_at = now
                existing.expires_at = now + _DOWNLOAD_SESSION_TTL
    db.add(DownloadLog(
        share_id=share.id,
        ip=get_client_ip(request),
        ua=(request.headers.get("user-agent") or "")[:512],
        request_id=request_id,
        downloaded_at=now,
    ))

    result = await db.execute(
        update(Share)
        .where(
            Share.id == share.id,
            Share.revoked_at.is_(None),
            Share.banned_at.is_(None),
            or_(Share.expires_at.is_(None), Share.expires_at > now),
            or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
        )
        .values(download_count=Share.download_count + 1)
        .returning(Share.download_count)
    )
    if result.scalar_one_or_none() is None:
        raise HTTPException(status.HTTP_410_GONE, "下载次数已用完或分享已失效")
    share.last_activity_at = now
    return True


def _public_media_metadata(metadata: dict[str, Any] | None) -> dict[str, Any] | None:
    """返回公开详情可暴露的媒体元数据，隐藏内部 TOS 对象引用。"""
    if not metadata:
        return metadata
    result = deepcopy(metadata)
    assets = result.get("playback_assets")
    if isinstance(assets, list):
        public_assets: list[dict[str, Any]] = []
        for asset in assets:
            if not isinstance(asset, dict):
                continue
            public_asset = {
                k: v
                for k, v in asset.items()
                if k not in {"store_uri", "download_url", "backup_download_url"}
            }
            public_assets.append(public_asset)
        result["playback_assets"] = public_assets
    return result


async def _metadata_with_signed_assets(
    metadata: dict[str, Any] | None,
    resolver: DoubaoDownloadUrlResolver,
    semaphore,
) -> dict[str, Any] | None:
    """为下载响应里的播放 sidecar 签发临时 URL。"""
    if not metadata:
        return metadata
    result = deepcopy(metadata)
    assets = result.get("playback_assets")
    if not isinstance(assets, list):
        return result

    signed_assets: list[dict[str, Any]] = []
    for asset in assets:
        if not isinstance(asset, dict):
            continue
        signed = deepcopy(asset)
        store_uri = signed.get("store_uri")
        if isinstance(store_uri, str) and store_uri:
            async with semaphore:
                urls = await resolver.get_download_urls(store_uri, expire_seconds=86400)
            signed["download_url"] = urls.main_url
            signed["backup_download_url"] = urls.backup_url
        signed.pop("store_uri", None)
        signed_assets.append(signed)
    result["playback_assets"] = signed_assets
    return result


class ShareReportRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=64)
    detail: str = Field(default="", max_length=2000)


class MessageResponse(BaseModel):
    message: str


class GuestShareReference(BaseModel):
    code: str = Field(..., min_length=1, max_length=16)
    revoke_token: str = Field(..., min_length=1, max_length=64)


class GuestSharesMineRequest(BaseModel):
    shares: list[GuestShareReference] = Field(default_factory=list, max_length=50)


@router.get("/download-config", response_model=DownloadConfigResponse, summary="获取下载行为配置")
async def get_public_download_config():
    """分享页读取公开下载行为配置，不包含敏感信息。"""
    from app.db.session import get_session_factory

    async with get_session_factory()() as session:
        return DownloadConfigResponse(**await get_download_config(session))


@router.post("/{code}/access", status_code=status.HTTP_204_NO_CONTENT, summary="记录分享页面访问")
async def record_share_view(
    code: str,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        share = await _get_share_or_404(code, db)
        share_id = share.id
    await record_share_access(share_id, "view", request, user_id=user.id if user else None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{code}/interaction", status_code=status.HTTP_204_NO_CONTENT, summary="记录页面渲染或真人互动")
async def record_share_interaction(
    code: str,
    body: ShareInteractionRequest,
    request: Request,
    response: Response,
    user: User | None = Depends(get_current_user_optional),
):
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        share = await _get_share_or_404(code, db)
        share_id = share.id
    trusted_visitor_id = None
    if user is None:
        redis = getattr(request.app.state, "redis", None)
        if redis is None:
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "服务暂时不可用")
        allowed = await check_public_event_rate_limit(
            redis,
            scope="share-interaction",
            client_ip=get_client_ip(request),
            limit=INTERACTION_RATE_LIMIT,
        )
        if not allowed:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "请求过于频繁，请稍后再试")
        trusted_visitor_id = await resolve_visitor_identity(
            request,
            response=response,
            redis=redis,
            issue=True,
        )
    await record_share_access(
        share_id,
        body.event_type,
        request,
        user_id=user.id if user else None,
        request_id=body.request_id,
        http_status=status.HTTP_204_NO_CONTENT,
        request_time_ms=body.request_time_ms,
        trusted_visitor_id=trusted_visitor_id,
    )
    response.status_code = status.HTTP_204_NO_CONTENT


async def _get_share_or_404(
    code: str,
    db: AsyncSession,
    *,
    enforce_download_limit: bool = False,
) -> Share:
    """按短码查 Share + files，不存在 / 已撤销 / 已过期则 404。"""
    stmt = (
        select(Share)
        .options(selectinload(Share.files), selectinload(Share.logical_files).selectinload(ShareLogicalFile.files))
        .where(Share.code == code, Share.revoked_at.is_(None), Share.banned_at.is_(None))
    )
    result = await db.execute(stmt)
    share = result.scalar_one_or_none()
    if share is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在或已被删除")
    if share.expires_at and share.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "分享已过期")
    if enforce_download_limit and share.max_downloads > 0 and share.download_count >= share.max_downloads:
        raise HTTPException(status.HTTP_410_GONE, "下载次数已用完")
    return share


async def _get_download_urls(logical_files: list[ShareLogicalFile]) -> list[ShareFileDownload]:
    """为所有逻辑文件获取临时下载 URL（并行获取以提升性能）。"""
    import asyncio

    from app.core.config import get_settings

    resolver = DoubaoDownloadUrlResolver()
    semaphore = asyncio.Semaphore(max(1, get_settings().admin_preview_sign_concurrency))

    try:
        sorted_files = sorted(logical_files, key=lambda item: item.sort_index)
        if not sorted_files:
            return []

        async def resolve_single_file(logical_file: ShareLogicalFile) -> ShareFileDownload | None:
            """处理单个逻辑文件，返回 ShareFileDownload 或 None（空文件时）。"""
            chunks_sorted = sorted(logical_file.files, key=lambda item: item.chunk_index)
            if not chunks_sorted:
                return None

            # 单 chunk 文件
            if len(chunks_sorted) == 1 and logical_file.chunk_total == 1:
                chunk = chunks_sorted[0]
                if chunk.tos_uri.startswith(_EMPTY_URI_PREFIX):
                    return ShareFileDownload(
                        file_name=logical_file.original_name,
                        file_size=logical_file.size,
                        content_type=logical_file.content_type or "",
                        is_chunked=False,
                        download_url=_EMPTY_FILE_DATA_URL,
                        chunks=[],
                        media_metadata=logical_file.media_metadata,
                    )

                # 并行获取 URL 和签名资源
                async def resolve_url() -> DownloadUrlResult:
                    async with semaphore:
                        return await resolver.get_download_urls(chunk.tos_uri, expire_seconds=86400)

                url_coro = resolve_url()
                meta_coro = _metadata_with_signed_assets(logical_file.media_metadata, resolver, semaphore)
                urls, media_metadata = await asyncio.gather(url_coro, meta_coro)
                return ShareFileDownload(
                    file_name=logical_file.original_name,
                    file_size=logical_file.size,
                    content_type=logical_file.content_type or "",
                    is_chunked=False,
                    download_url=urls.main_url,
                    backup_download_url=urls.backup_url,
                    chunks=[],
                    media_metadata=media_metadata,
                )

            # 多 chunk 文件：并行获取所有 chunk 的下载 URL
            async def resolve_chunk_url(store_uri: str) -> DownloadUrlResult:
                async with semaphore:
                    return await resolver.get_download_urls(store_uri, expire_seconds=86400)

            chunk_url_coros = [resolve_chunk_url(c.tos_uri) for c in chunks_sorted]
            meta_coro = _metadata_with_signed_assets(logical_file.media_metadata, resolver, semaphore)

            # 并行执行所有 chunk URL 获取 + 元数据签名
            all_results = await asyncio.gather(*chunk_url_coros, meta_coro)
            chunk_urls = all_results[:-1]
            media_metadata = all_results[-1]

            chunk_downloads = [
                ChunkDownloadInfo(
                    index=c.chunk_index,
                    size=c.size,
                    download_url=urls.main_url,
                    backup_download_url=urls.backup_url,
                )
                for c, urls in zip(chunks_sorted, chunk_urls, strict=True)
            ]

            return ShareFileDownload(
                file_name=logical_file.original_name,
                file_size=logical_file.size,
                content_type=logical_file.content_type or "",
                is_chunked=True,
                download_url="",
                chunks=chunk_downloads,
                media_metadata=media_metadata,
            )

        # 并行处理所有文件
        file_coros = [resolve_single_file(lf) for lf in sorted_files]
        file_results = await asyncio.gather(*file_coros)

        # 过滤掉 None（空文件），保持原始顺序
        return [r for r in file_results if r is not None]

    finally:
        await resolver.close()


def _aggregate_file_info(logical_files: list[ShareLogicalFile]) -> list[ShareFileInfo]:
    """将逻辑文件行转换为详情展示列表。"""
    results: list[ShareFileInfo] = []
    for idx, logical_file in enumerate(sorted(logical_files, key=lambda item: item.sort_index)):
        results.append(ShareFileInfo(
            file_name=logical_file.original_name,
            file_size=logical_file.size,
            file_ext=logical_file.original_name.rsplit(".", 1)[-1] if "." in logical_file.original_name else "",
            content_type=logical_file.content_type or "",
            index=idx,
            is_chunked=logical_file.chunk_total > 1,
            chunk_count=logical_file.chunk_total,
            media_metadata=_public_media_metadata(logical_file.media_metadata),
        ))

    return results


def _image_metadata(logical_file: ShareLogicalFile) -> dict[str, Any]:
    metadata = logical_file.media_metadata
    if not isinstance(metadata, dict):
        return {}
    image = metadata.get("image")
    return image if isinstance(image, dict) else {}


def _select_download_files(
    logical_files: list[ShareLogicalFile],
    file_indices: list[int] | None,
) -> list[ShareLogicalFile]:
    sorted_files = sorted(logical_files, key=lambda item: item.sort_index)
    if file_indices is None:
        return sorted_files
    unique_indices = list(dict.fromkeys(file_indices))
    if any(index < 0 or index >= len(sorted_files) for index in unique_indices):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "所选文件不存在")
    selected = {index for index in unique_indices}
    return [logical_file for index, logical_file in enumerate(sorted_files) if index in selected]


async def _sign_gallery_store_uris(store_uris: list[str]) -> dict[str, DownloadUrlResult]:
    store_uris = sorted(set(store_uris))
    if not store_uris:
        return {}

    semaphore = asyncio.Semaphore(4)

    async def request_batch(batch: list[str]) -> dict[str, DownloadUrlResult]:
        resolver = DoubaoDownloadUrlResolver()
        try:
            async with semaphore:
                return await resolver.get_download_urls_batch(batch, expire_seconds=3600)
        finally:
            await resolver.close()

    async def sign_batch(batch: list[str]) -> dict[str, DownloadUrlResult]:
        try:
            return await request_batch(batch)
        except DoubaoClientError as exc:
            if len(batch) > 1:
                midpoint = len(batch) // 2
                left, right = await asyncio.gather(
                    sign_batch(batch[:midpoint]),
                    sign_batch(batch[midpoint:]),
                )
                return {**left, **right}
            if len(batch) == 1:
                log.warning("gallery asset skipped because signing failed: %s (%s)", batch[0], exc)
                return {}
            raise

    try:
        signed_batches = await asyncio.gather(*(
            sign_batch(store_uris[start:start + 100])
            for start in range(0, len(store_uris), 100)
        ))
    except Exception as exc:
        log.warning("gallery asset signing failed: %s", exc)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "图片画廊暂时不可用，请稍后重试") from exc
    return {
        store_uri: urls
        for signed_batch in signed_batches
        for store_uri, urls in signed_batch.items()
    }


async def _sign_gallery_assets(
    assets: list[ShareMediaAsset],
) -> dict[str, DownloadUrlResult]:
    return await _sign_gallery_store_uris([asset.store_uri for asset in assets])


def _gallery_asset_kinds_complete(processing_version: int, kinds: set[str]) -> bool:
    if processing_version >= 2:
        return REQUIRED_GALLERY_ASSET_KINDS.issubset(kinds)
    return "preview_2048" in kinds and bool({"thumbnail_480", "thumbnail_960"} & kinds)


def _gallery_assets_complete(
    assets: list[ShareMediaAsset],
    signed_urls: dict[str, DownloadUrlResult] | None = None,
) -> bool:
    if not assets:
        return False
    kinds = {
        asset.kind
        for asset in assets
        if signed_urls is None or asset.store_uri in signed_urls
    }
    return _gallery_asset_kinds_complete(assets[0].processing_version, kinds)


def _guest_share_status(share: Share, now: datetime) -> str:
    if share.expires_at and share.expires_at <= now + timedelta(hours=1):
        return "expiring"
    return "active"


@router.post("/guest-mine", summary="游客查询自己的活跃分享")
async def guest_my_shares(body: GuestSharesMineRequest):
    """通过本机保存的撤销令牌查询游客的活跃分享列表。"""
    from app.core.config import get_settings
    from app.db.session import get_session_factory

    settings = get_settings()
    now = datetime.now(UTC)
    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for item in body.shares:
        code = item.code.strip()
        revoke_token = item.revoke_token.strip()
        key = (code, revoke_token)
        if not code or not revoke_token or key in seen:
            continue
        seen.add(key)
        pairs.append(key)

    if not pairs:
        return []

    async with get_session_factory()() as db:
        stmt = (
            select(Share)
            .options(selectinload(Share.logical_files))
            .where(
                Share.owner_id.is_(None),
                or_(*[and_(Share.code == code, Share.revoke_token == token) for code, token in pairs]),
                Share.revoked_at.is_(None),
                Share.banned_at.is_(None),
                or_(Share.expires_at.is_(None), Share.expires_at > now),
                or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
            )
            .order_by(Share.created_at.desc())
            .limit(10)
        )
        result = await db.execute(stmt)
        shares = result.scalars().all()

    return [
        {
            "code": s.code,
            "url": f"{settings.app_base_url}/{s.code}",
            "has_revoke_token": s.revoke_token is not None,
            "preview_files": [f.original_name for f in sorted(s.logical_files, key=lambda item: item.sort_index)[:3]],
            "file_count": len(s.logical_files or []),
            "empty_dir_count": len(s.empty_dirs or []),
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "total_bytes": s.total_bytes,
            "download_count": s.download_count,
            "max_downloads": s.max_downloads,
            "has_password": s.password_hash is not None,
            "status": _guest_share_status(s, now),
        }
        for s in shares
    ]


@router.get(
    "/{code}",
    response_model=ShareInfoResponse,
    summary="获取分享详情",
)
async def get_share(code: str, request: Request):
    """返回分享的公开信息（文件列表、是否有密码等）。"""
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        share = await _get_share_or_404(code, db)

    locked = share.password_hash is not None
    return ShareInfoResponse(
        code=share.code,
        files=[] if locked else _aggregate_file_info(share.logical_files),
        empty_dirs=[] if locked else share.empty_dirs or [],
        total_bytes=0 if locked else share.total_bytes,
        created_at=share.created_at,
        expires_at=share.expires_at,
        download_count=share.download_count,
        max_downloads=share.max_downloads,
        has_password=locked,
        gallery_eligible=not locked and is_gallery_eligible(share.logical_files),
    )


@router.post(
    "/{code}/gallery-session",
    response_model=GallerySessionResponse,
    summary="获取图片画廊会话",
)
async def create_gallery_session(
    code: str,
    body: GallerySessionRequest,
    request: Request,
):
    """验证分享访问权限，按需入队历史图片并返回派生资源。"""
    from app.db.session import get_session_factory

    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "图片画廊暂时不可用")
    if not await check_public_event_rate_limit(
        redis,
        scope=f"share-gallery:{code}",
        client_ip=get_client_ip(request),
        limit=60,
    ):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "请求过于频繁，请稍后再试")

    async with get_session_factory()() as db:
        share = await _get_share_or_404(code, db)
        if share.password_hash:
            await _enforce_share_password_rate_limit(code, request)
            if not body.password:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "该分享需要提取码")
            if not verify_secret(body.password, share.password_hash):
                await _raise_invalid_share_password(code, request)
        elif body.password:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该分享未设置提取码")

        logical_files = sorted(share.logical_files, key=lambda item: item.sort_index)
        if not is_gallery_eligible(logical_files):
            return GallerySessionResponse(eligible=False)

        gallery_files = [item for item in logical_files if is_supported_image(item.original_name)]
        original_preview_files = {
            logical_file.id: logical_file.files[0]
            for logical_file in gallery_files
            if uses_original_jpeg_preview(logical_file)
            and len(logical_file.files) == 1
            and logical_file.files[0].chunk_index == 0
        }
        processing_files = [
            logical_file
            for logical_file in gallery_files
            if logical_file.id not in original_preview_files
        ]
        logical_file_ids = [item.id for item in processing_files]
        jobs = list((await db.scalars(
            select(MediaProcessingJob).where(
                MediaProcessingJob.logical_file_id.in_(logical_file_ids),
                MediaProcessingJob.processing_version == MEDIA_PROCESSING_VERSION,
            )
        )).all()) if logical_file_ids else []
        jobs_by_file = {job.logical_file_id: job for job in jobs}
        needs_enqueue = [
            logical_file
            for logical_file in processing_files
            if logical_file.id not in jobs_by_file
            or (
                jobs_by_file[logical_file.id].status == "pending"
                and jobs_by_file[logical_file.id].priority < 10
            )
        ]
        if needs_enqueue:
            await ensure_gallery_jobs(db, needs_enqueue, priority=10)
            jobs = list((await db.scalars(
                select(MediaProcessingJob)
                .where(
                    MediaProcessingJob.logical_file_id.in_(logical_file_ids),
                    MediaProcessingJob.processing_version == MEDIA_PROCESSING_VERSION,
                )
                .execution_options(populate_existing=True)
            )).all())
        assets = list((await db.scalars(
            select(ShareMediaAsset).where(
                ShareMediaAsset.logical_file_id.in_(logical_file_ids),
                ShareMediaAsset.processing_version <= MEDIA_PROCESSING_VERSION,
            )
        )).all()) if logical_file_ids else []
        await db.commit()

    file_indices = {item.id: index for index, item in enumerate(logical_files)}
    known_ready_indices = {
        index
        for index in body.known_ready_indices
        if 0 <= index < len(logical_files)
    }
    versioned_assets_by_file: dict[UUID, dict[int, list[ShareMediaAsset]]] = {}
    for asset in assets:
        versioned_assets_by_file.setdefault(asset.logical_file_id, {}).setdefault(
            asset.processing_version, []
        ).append(asset)
    complete_versions_by_file: dict[UUID, list[list[ShareMediaAsset]]] = {}
    for logical_file_id, versions in versioned_assets_by_file.items():
        for processing_version in sorted(versions, reverse=True):
            candidates = [
                asset
                for asset in versions[processing_version]
                if asset.kind == "exif_json" or asset.format == "webp"
            ]
            if _gallery_assets_complete(candidates):
                complete_versions_by_file.setdefault(logical_file_id, []).append(candidates)

    selected_assets = [
        asset
        for versions in complete_versions_by_file.values()
        for candidates in versions[:1]
        for asset in candidates
    ]
    assets_to_sign = [
        asset
        for asset in selected_assets
        if file_indices.get(asset.logical_file_id) not in known_ready_indices
        and (
            asset.kind == "exif_json"
            or (
                asset.format == "webp"
                and asset.kind in {"thumbnail_480", "thumbnail_960", "preview_2048"}
            )
        )
    ]
    original_preview_uris = [
        source_file.tos_uri
        for logical_file_id, source_file in original_preview_files.items()
        if file_indices.get(logical_file_id) not in known_ready_indices
    ]
    jobs_by_file: dict[UUID, MediaProcessingJob] = {
        job.logical_file_id: job for job in jobs
    }
    signed_urls = await _sign_gallery_store_uris([
        *[asset.store_uri for asset in assets_to_sign],
        *original_preview_uris,
    ])
    fallback_assets: list[ShareMediaAsset] = []
    for logical_file_id, versions in complete_versions_by_file.items():
        logical_file_index = file_indices.get(logical_file_id)
        if logical_file_index in known_ready_indices or len(versions) < 2:
            continue
        if not _gallery_assets_complete(versions[0], signed_urls):
            fallback_assets.extend(versions[1])
    if fallback_assets:
        signed_urls.update(await _sign_gallery_store_uris([
            asset.store_uri for asset in fallback_assets
        ]))

    assets_by_file: dict[UUID, list[ShareMediaAsset]] = {}
    for logical_file_id, versions in complete_versions_by_file.items():
        logical_file_index = file_indices.get(logical_file_id)
        if logical_file_index in known_ready_indices:
            assets_by_file[logical_file_id] = versions[0]
            continue
        assets_by_file[logical_file_id] = next(
            (
                candidates
                for candidates in versions
                if _gallery_assets_complete(candidates, signed_urls)
            ),
            versions[0],
        )

    response_files: list[GalleryFileInfo] = []
    for logical_file in gallery_files:
        logical_file_index = file_indices[logical_file.id]
        image = _image_metadata(logical_file)
        original_preview = original_preview_files.get(logical_file.id)
        if original_preview is not None:
            preview_urls = signed_urls.get(original_preview.tos_uri)
            signed_preview_missing = (
                logical_file_index not in known_ready_indices
                and preview_urls is None
            )
            width = image.get("width") if isinstance(image.get("width"), int) else 0
            height = image.get("height") if isinstance(image.get("height"), int) else 0
            response_files.append(GalleryFileInfo(
                index=logical_file_index,
                file_name=logical_file.original_name,
                file_size=logical_file.size,
                content_type=logical_file.content_type or "image/jpeg",
                status="failed" if signed_preview_missing else "ready",
                width=width,
                height=height,
                error_code="asset_signing_failed" if signed_preview_missing else None,
                exif_summary=None,
                is_animated=False,
                frame_count=1,
                assets=[GalleryAssetInfo(
                    kind="original_preview",
                    format="jpeg",
                    content_type=original_preview.content_type or "image/jpeg",
                    width=width,
                    height=height,
                    byte_size=original_preview.size,
                    download_url=preview_urls.main_url,
                    backup_download_url=preview_urls.backup_url,
                )] if preview_urls is not None else [],
            ))
            continue
        file_assets = sorted(
            assets_by_file.get(logical_file.id, []),
            key=lambda item: (
                item.kind,
                0 if item.format == "webp" else 1 if item.format == "jpeg" else 2,
            ),
        )
        has_preview = _gallery_assets_complete(file_assets)
        response_assets = [
            asset
            for asset in file_assets
            if asset.store_uri in signed_urls
        ]
        signed_preview_missing = (
            has_preview
            and logical_file_index not in known_ready_indices
            and not _gallery_assets_complete(file_assets, signed_urls)
        )
        job = jobs_by_file.get(logical_file.id)
        if signed_preview_missing:
            file_status = "failed"
        elif has_preview:
            file_status = "ready"
        elif job and job.status in {"failed", "unsupported"}:
            file_status = "failed"
        elif job and job.status == "succeeded":
            file_status = "failed"
        else:
            file_status = "pending"

        error_code = image.get("error_code") if isinstance(image.get("error_code"), str) else None
        if file_status == "failed" and not error_code:
            if signed_preview_missing:
                error_code = "asset_signing_failed"
            else:
                error_code = "asset_missing" if job and job.status == "succeeded" else job.status if job else "processing_error"
        exif_summary = image.get("exif_summary")
        if not isinstance(exif_summary, dict):
            exif_summary = None
        width = image.get("width") if isinstance(image.get("width"), int) else 0
        height = image.get("height") if isinstance(image.get("height"), int) else 0
        response_files.append(GalleryFileInfo(
            index=logical_file_index,
            file_name=logical_file.original_name,
            file_size=logical_file.size,
            content_type=logical_file.content_type or "",
            status=file_status,
            width=width,
            height=height,
            error_code=error_code,
            exif_summary=exif_summary,
            is_animated=image.get("is_animated") is True,
            frame_count=max(1, image.get("frame_count", 1))
            if isinstance(image.get("frame_count"), int) else 1,
            assets=[
                GalleryAssetInfo(
                    kind=asset.kind,
                    format=asset.format,
                    content_type=asset.content_type,
                    width=asset.width or 0,
                    height=asset.height or 0,
                    byte_size=asset.byte_size,
                    download_url=signed_urls[asset.store_uri].main_url,
                    backup_download_url=signed_urls[asset.store_uri].backup_url,
                )
                for asset in response_assets
            ],
        ))

    ready_count = sum(item.status == "ready" for item in response_files)
    failed_count = sum(item.status == "failed" for item in response_files)
    pending_count = len(response_files) - ready_count - failed_count
    return GallerySessionResponse(
        eligible=True,
        files=response_files,
        ready_count=ready_count,
        pending_count=pending_count,
        failed_count=failed_count,
        retry_after_seconds=5 if pending_count else 0,
        expires_in=3600,
    )


@router.post(
    "/{code}/unlock",
    response_model=ShareInfoResponse,
    summary="验证提取码并获取分享元数据",
)
async def unlock_share(code: str, body: ShareVerifyRequest, request: Request):
    """验证提取码，但不签发任何原文件访问地址。"""
    from app.db.session import get_session_factory

    await _enforce_share_password_rate_limit(code, request)

    async with get_session_factory()() as db:
        share = await _get_share_or_404(code, db)
        if not share.password_hash:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该分享未设置提取码")
        if not verify_secret(body.password, share.password_hash):
            await _raise_invalid_share_password(code, request)
        return ShareInfoResponse(
            code=share.code,
            files=_aggregate_file_info(share.logical_files),
            empty_dirs=share.empty_dirs or [],
            total_bytes=share.total_bytes,
            created_at=share.created_at,
            expires_at=share.expires_at,
            download_count=share.download_count,
            max_downloads=share.max_downloads,
            has_password=True,
            gallery_eligible=is_gallery_eligible(share.logical_files),
        )


@router.post(
    "/{code}/verify",
    response_model=ShareVerifyResponse,
    summary="验证提取码",
)
async def verify_share(
    code: str,
    body: ShareVerifyRequest,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    """验证提取码后返回所有文件的临时下载 URL。"""
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        share = await _get_share_or_404(code, db, enforce_download_limit=True)

        if not share.password_hash:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该分享未设置提取码")

        await _enforce_share_password_rate_limit(code, request)
        if not verify_secret(body.password, share.password_hash):
            await _raise_invalid_share_password(code, request)

        if not share.files and not (share.empty_dirs or []):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享中没有可下载文件")

        downloads = await _get_download_urls(share.logical_files)
        await _reserve_download_link(db, share, request)
        await db.commit()
        share_id = share.id
    await _record_link_issued(share_id, request, user_id=user.id if user else None)
    return ShareVerifyResponse(files=downloads, empty_dirs=share.empty_dirs or [])


@router.get(
    "/{code}/download",
    response_model=ShareDownloadResponse,
    summary="获取下载链接",
)
async def download_share(
    code: str,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    """获取所有文件的临时下载 URL，download_count +1。

    无密码分享直接调用；有密码分享需先 verify 拿 URL。
    """
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        share = await _get_share_or_404(code, db, enforce_download_limit=True)

        if share.password_hash:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "该分享需要提取码",
            )

        if not share.files and not (share.empty_dirs or []):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享中没有可下载文件")

        downloads = await _get_download_urls(share.logical_files)
        await _reserve_download_link(db, share, request)
        await db.commit()
        share_id = share.id
    await _record_link_issued(share_id, request, user_id=user.id if user else None)
    return ShareDownloadResponse(files=downloads, empty_dirs=share.empty_dirs or [])


@router.post(
    "/{code}/download-session",
    response_model=ShareDownloadResponse,
    summary="幂等获取下载链接",
)
async def create_download_session(
    code: str,
    body: ShareDownloadSessionRequest,
    request: Request,
    request_id: str = Header(
        ...,
        alias="X-NYY-Link-Request-ID",
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    ),
    user: User | None = Depends(get_current_user_optional),
):
    """同一分享与请求 ID 在短期内只计数一次，每次重新签发临时 URL。"""

    from app.db.session import get_session_factory

    started_at = time.perf_counter()
    normalized_request_id = request_id.strip()
    async with get_session_factory()() as db:
        result = await db.execute(
            select(Share)
            .options(
                selectinload(Share.files),
                selectinload(Share.logical_files).selectinload(ShareLogicalFile.files),
            )
            .where(Share.code == code)
        )
        share = result.scalar_one_or_none()
        if share is None or share.revoked_at is not None or share.banned_at is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在或已被删除")

        now = datetime.now(UTC)
        if share.expires_at and share.expires_at < now:
            raise HTTPException(status.HTTP_410_GONE, "分享已过期")
        if body.intent == "download" and share.max_downloads > 0 and share.download_count >= share.max_downloads:
            raise HTTPException(status.HTTP_410_GONE, "下载次数已用完")
        if share.password_hash:
            await _enforce_share_password_rate_limit(code, request)
            if not body.password:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "该分享需要提取码")
            if not verify_secret(body.password, share.password_hash):
                await _raise_invalid_share_password(code, request)
        elif body.password:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该分享未设置提取码")
        if body.intent == "preview" and is_gallery_eligible(share.logical_files):
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "图片画廊预览不提供原文件地址，请使用画廊会话",
            )
        if not share.files and not (share.empty_dirs or []):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享中没有可下载文件")

        selected_logical_files = _select_download_files(share.logical_files, body.file_indices)
        downloads = await _get_download_urls(selected_logical_files)
        response_empty_dirs = [] if body.file_indices is not None else share.empty_dirs or []
        response = ShareDownloadResponse(files=downloads, empty_dirs=response_empty_dirs)
        reserved = False
        if body.intent == "download":
            reserved = await _reserve_download_link(
                db,
                share,
                request,
                request_id=normalized_request_id,
                response_metadata={
                    "file_count": len(downloads),
                    "empty_dir_count": len(response_empty_dirs),
                    **({
                        "logical_file_ids": [str(item.id) for item in selected_logical_files],
                    } if body.file_indices is not None else {}),
                },
            )
            if body.delivery == "same_origin" and _is_wechat_user_agent(request.headers.get("user-agent", "")):
                _attach_same_origin_download_urls(
                    response,
                    share,
                    selected_logical_files,
                    normalized_request_id,
                )
        await db.commit()
        share_id = share.id

    if reserved:
        await _record_link_issued(
            share_id,
            request,
            user_id=user.id if user else None,
            request_id=normalized_request_id,
            http_status=status.HTTP_200_OK,
            request_time_ms=round((time.perf_counter() - started_at) * 1000),
        )
    return response


@router.api_route(
    "/{code}/download-proxy/{logical_file_id}",
    methods=["GET", "HEAD"],
    summary="同域缓存下载",
)
async def proxy_share_download(
    code: str,
    logical_file_id: UUID,
    request: Request,
    session: str = Query(
        ...,
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    ),
):
    from app.db.session import get_session_factory

    now = datetime.now(UTC)
    async with get_session_factory()() as db:
        result = await db.execute(
            select(Share)
            .options(selectinload(Share.logical_files).selectinload(ShareLogicalFile.files))
            .where(
                Share.code == code,
                Share.revoked_at.is_(None),
                Share.banned_at.is_(None),
                or_(Share.expires_at.is_(None), Share.expires_at > now),
            )
        )
        share = result.scalar_one_or_none()
        if share is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在或已失效")
        download_session = await db.scalar(
            select(DownloadSession).where(
                DownloadSession.share_id == share.id,
                DownloadSession.request_id == session,
                DownloadSession.expires_at > now,
            )
        )
        if download_session is None:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "下载授权已失效，请返回分享页重试")
        allowed_logical_file_ids = download_session.response_payload.get("logical_file_ids")
        if isinstance(allowed_logical_file_ids, list) and str(logical_file_id) not in allowed_logical_file_ids:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "当前下载授权不包含此文件")
        logical_file = next((item for item in share.logical_files if item.id == logical_file_id), None)
        if logical_file is None or logical_file.chunk_total != 1 or len(logical_file.files) != 1:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不存在或不支持同域下载")
        stored_file = logical_file.files[0]
        file_name = logical_file.original_name
        file_size = logical_file.size
        content_type = logical_file.content_type or "application/octet-stream"
        store_uri = stored_file.tos_uri

    cached_file = await _ensure_proxy_cache_file(
        logical_file.id,
        file_name,
        file_size,
        store_uri,
    )
    return Response(
        status_code=status.HTTP_200_OK,
        headers={
            "Cache-Control": "private, no-store",
            "Content-Disposition": _download_content_disposition(file_name),
            "Content-Type": content_type,
            "X-Accel-Redirect": f"/_internal-download-cache/{cached_file.name}",
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/{code}/report", response_model=MessageResponse, summary="举报分享")
async def report_share(code: str, body: ShareReportRequest, request: Request):
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        if not share:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在或已被删除")
        db.add(Report(
            share_id=share.id,
            reporter_ip=get_client_ip(request),
            reason=body.reason,
            detail=body.detail or None,
            status="pending",
        ))
        await db.commit()
    return MessageResponse(message="举报已提交")


class GuestRevokeRequest(BaseModel):
    revoke_token: str = Field(..., min_length=1)


@router.delete("/{code}/guest-revoke", response_model=MessageResponse, summary="游客撤销分享")
async def guest_revoke_share(code: str, body: GuestRevokeRequest):
    """游客凭 revoke_token 撤销自己的分享。"""
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        share = await db.scalar(
            select(Share).where(
                Share.code == code,
                Share.owner_id.is_(None),
                Share.revoke_token == body.revoke_token,
            )
        )
        if not share:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在或令牌无效")
        if share.revoked_at:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "已撤销")
        share.revoked_at = datetime.now(UTC)
        await db.commit()
    return MessageResponse(message="分享已撤销")
