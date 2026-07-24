"""分享 API：查看 / 验证提取码 / 下载。

GET  /api/v1/shares/:code          — 分享详情（公开信息）
POST /api/v1/shares/:code/verify   — 验证提取码（有密码时需要）
GET  /api/v1/shares/:code/download — 获取下载 URL（计数 +1）
"""

from __future__ import annotations

import logging
import time
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import get_current_user_optional
from app.models.share import DownloadLog, DownloadSession, Share, ShareLogicalFile
from app.models.system import Report
from app.models.user import User
from app.schemas.admin import DownloadConfigResponse
from app.schemas.share import (
    ChunkDownloadInfo,
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
from app.services.doubao_client import DoubaoDownloadUrlResolver, DownloadUrlResult
from app.services.growth import trigger_referral_qualification
from app.services.share_access import record_share_access
from app.services.visitor_identity import (
    INTERACTION_RATE_LIMIT,
    check_public_event_rate_limit,
    resolve_visitor_identity,
)
from app.utils.client_ip import get_client_ip
from app.utils.security import verify_secret

log = logging.getLogger(__name__)
router = APIRouter(prefix="/shares", tags=["shares"])
_EMPTY_URI_PREFIX = "nyy-empty://"
_EMPTY_FILE_DATA_URL = "data:application/octet-stream;base64,"
_DOWNLOAD_SESSION_TTL = timedelta(minutes=5)


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


async def _get_share_or_404(code: str, db: AsyncSession) -> Share:
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
    if share.max_downloads > 0 and share.download_count >= share.max_downloads:
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
        share = await _get_share_or_404(code, db)

        if not share.password_hash:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该分享未设置提取码")

        if not verify_secret(body.password, share.password_hash):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "提取码错误")

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
        share = await _get_share_or_404(code, db)

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
        if share.max_downloads > 0 and share.download_count >= share.max_downloads:
            raise HTTPException(status.HTTP_410_GONE, "下载次数已用完")
        if share.password_hash:
            if not body.password:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "该分享需要提取码")
            if not verify_secret(body.password, share.password_hash):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "提取码错误")
        elif body.password:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "该分享未设置提取码")
        if not share.files and not (share.empty_dirs or []):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享中没有可下载文件")

        downloads = await _get_download_urls(share.logical_files)
        response = ShareDownloadResponse(files=downloads, empty_dirs=share.empty_dirs or [])
        reserved = await _reserve_download_link(
            db,
            share,
            request,
            request_id=normalized_request_id,
            response_metadata={
                "file_count": len(downloads),
                "empty_dir_count": len(share.empty_dirs or []),
            },
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
