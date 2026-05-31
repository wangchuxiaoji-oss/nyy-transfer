"""分享 API：查看 / 验证提取码 / 下载。

GET  /api/v1/shares/:code          — 分享详情（公开信息）
POST /api/v1/shares/:code/verify   — 验证提取码（有密码时需要）
GET  /api/v1/shares/:code/download — 获取下载 URL（计数 +1）
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.share import Share, ShareLogicalFile
from app.models.system import Report
from app.schemas.share import (
    ChunkDownloadInfo,
    ShareDownloadResponse,
    ShareFileDownload,
    ShareFileInfo,
    ShareInfoResponse,
    ShareVerifyRequest,
    ShareVerifyResponse,
)
from app.services.doubao_client import DoubaoClientError, get_doubao_client
from app.utils.security import verify_secret

log = logging.getLogger(__name__)
router = APIRouter(prefix="/shares", tags=["shares"])
_EMPTY_URI_PREFIX = "nyy-empty://"
_EMPTY_FILE_DATA_URL = "data:application/octet-stream;base64,"


class ShareReportRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=64)
    detail: str = Field(default="", max_length=2000)


class MessageResponse(BaseModel):
    message: str


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
    if share.expires_at and share.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status.HTTP_410_GONE, "分享已过期")
    if share.max_downloads > 0 and share.download_count >= share.max_downloads:
        raise HTTPException(status.HTTP_410_GONE, "下载次数已用完")
    return share


async def _get_download_urls(logical_files: list[ShareLogicalFile]) -> list[ShareFileDownload]:
    """为所有逻辑文件获取临时下载 URL。"""
    client = None

    results: list[ShareFileDownload] = []
    for logical_file in sorted(logical_files, key=lambda item: item.sort_index):
        chunks_sorted = sorted(logical_file.files, key=lambda item: item.chunk_index)
        if not chunks_sorted:
            continue

        if len(chunks_sorted) == 1 and logical_file.chunk_total == 1:
            chunk = chunks_sorted[0]
            if chunk.tos_uri.startswith(_EMPTY_URI_PREFIX):
                results.append(ShareFileDownload(
                    file_name=logical_file.original_name,
                    file_size=logical_file.size,
                    content_type=logical_file.content_type or "",
                    is_chunked=False,
                    download_url=_EMPTY_FILE_DATA_URL,
                    chunks=[],
                    media_metadata=logical_file.media_metadata,
                ))
                continue

            if client is None:
                client = await get_doubao_client()
            try:
                url = await client.get_download_url(chunk.tos_uri, expire_seconds=86400)
            except DoubaoClientError as e:
                log.error("get_download_url failed for %s: %s", chunk.tos_uri, e)
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "下载服务暂时不可用，请稍后重试")
            results.append(ShareFileDownload(
                file_name=logical_file.original_name,
                file_size=logical_file.size,
                content_type=logical_file.content_type or "",
                is_chunked=False,
                download_url=url,
                chunks=[],
                media_metadata=logical_file.media_metadata,
            ))
            continue

        chunk_downloads: list[ChunkDownloadInfo] = []
        for c in chunks_sorted:
            if client is None:
                client = await get_doubao_client()
            try:
                url = await client.get_download_url(c.tos_uri, expire_seconds=86400)
            except DoubaoClientError as e:
                log.error("get_download_url failed for chunk %s: %s", c.tos_uri, e)
                raise HTTPException(status.HTTP_502_BAD_GATEWAY, "下载服务暂时不可用，请稍后重试")
            chunk_downloads.append(ChunkDownloadInfo(
                index=c.chunk_index,
                size=c.size,
                download_url=url,
            ))

        results.append(ShareFileDownload(
            file_name=logical_file.original_name,
            file_size=logical_file.size,
            content_type=logical_file.content_type or "",
            is_chunked=True,
            download_url="",
            chunks=chunk_downloads,
            media_metadata=logical_file.media_metadata,
        ))

    return results


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
            media_metadata=logical_file.media_metadata,
        ))

    return results


@router.get("/guest-mine", summary="游客查询自己的活跃分享")
async def guest_my_shares(request: Request):
    """通过 IP 查询游客的活跃分享列表。"""
    from app.db.session import get_session_factory
    from app.api.v1.uploads import _get_client_ip
    from sqlalchemy import or_, cast
    from sqlalchemy.dialects.postgresql import INET
    from app.core.config import get_settings

    settings = get_settings()
    ip = _get_client_ip(request)
    now = datetime.now(timezone.utc)

    async with get_session_factory()() as db:
        stmt = (
            select(Share)
            .where(
                Share.ip_created_from == cast(ip, INET),
                Share.owner_id.is_(None),
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
            "created_at": s.created_at.isoformat() if s.created_at else None,
            "expires_at": s.expires_at.isoformat() if s.expires_at else None,
            "total_bytes": s.total_bytes,
            "download_count": s.download_count,
            "max_downloads": s.max_downloads,
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

    return ShareInfoResponse(
        code=share.code,
        files=_aggregate_file_info(share.logical_files),
        empty_dirs=share.empty_dirs or [],
        total_bytes=share.total_bytes,
        created_at=share.created_at,
        expires_at=share.expires_at,
        download_count=share.download_count,
        max_downloads=share.max_downloads,
        has_password=share.password_hash is not None,
    )


@router.post(
    "/{code}/verify",
    response_model=ShareVerifyResponse,
    summary="验证提取码",
)
async def verify_share(code: str, body: ShareVerifyRequest, request: Request):
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
        share.download_count += 1
        await db.commit()
    return ShareVerifyResponse(files=downloads, empty_dirs=share.empty_dirs or [])


@router.get(
    "/{code}/download",
    response_model=ShareDownloadResponse,
    summary="获取下载链接",
)
async def download_share(code: str, request: Request):
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
        share.download_count += 1
        await db.commit()
    return ShareDownloadResponse(files=downloads, empty_dirs=share.empty_dirs or [])


@router.post("/{code}/report", response_model=MessageResponse, summary="举报分享")
async def report_share(code: str, body: ShareReportRequest, request: Request):
    from app.db.session import get_session_factory
    from app.api.v1.uploads import _get_client_ip

    async with get_session_factory()() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        if not share:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在或已被删除")
        db.add(Report(
            share_id=share.id,
            reporter_ip=_get_client_ip(request),
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
            select(Share).where(Share.code == code, Share.revoke_token == body.revoke_token)
        )
        if not share:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在或令牌无效")
        if share.revoked_at:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "已撤销")
        share.revoked_at = datetime.now(timezone.utc)
        await db.commit()
    return MessageResponse(message="分享已撤销")
