"""我的分享 API：列表 / 撤销 / 编辑。

GET    /api/v1/my/shares          — 列表（分页）
DELETE /api/v1/my/shares/:code    — 撤销
PATCH  /api/v1/my/shares/:code    — 编辑（密码/过期时间/下载次数）
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import get_current_user_required
from app.db.session import get_db
from app.models.share import DownloadLog, Share, ShareFile
from app.models.user import User

log = logging.getLogger(__name__)
router = APIRouter(prefix="/my", tags=["my-shares"])


# ─── Schemas ─────────────────────────────────────────────────────

class MyShareItem(BaseModel):
    code: str
    title: str | None = None
    preview_files: list[str] = Field(default_factory=list)
    empty_dir_count: int = 0
    file_count: int
    total_bytes: int
    has_password: bool
    download_count: int
    max_downloads: int
    retention_options_hours: list[int]
    download_options: list[int]
    last_downloaded_at: str | None = None
    created_at: str
    expires_at: str | None
    revoked: bool


class MySharesListResponse(BaseModel):
    shares: list[MyShareItem]
    total: int
    page: int
    page_size: int


class ShareEditRequest(BaseModel):
    password: str | None = Field(default=None, max_length=4, pattern=r"^(?:[0-9]{4})?$", description="新提取码，空字符串表示清除")
    expires_hours: int | None = Field(default=None, ge=0, description="从现在起的过期小时数，0=永不过期")
    max_downloads: int | None = Field(default=None, ge=0, le=1_000_000, description="最大下载次数，0=不限")


class MessageResponse(BaseModel):
    message: str


# ─── 列表 ────────────────────────────────────────────────────────

@router.get("/shares", response_model=MySharesListResponse)
async def list_my_shares(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|revoked|expired)$"),
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|size_desc|downloads_desc|expires_asc)$"),
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    """获取当前用户的分享列表（按创建时间倒序）。"""
    offset = (page - 1) * page_size

    now = datetime.now(UTC)
    filters = [Share.owner_id == user.id]
    if q:
        like = f"%{q}%"
        filters.append(or_(Share.code.ilike(like), Share.files.any(ShareFile.original_name.ilike(like))))
    if status_filter == "revoked":
        filters.append(Share.revoked_at.is_not(None))
    elif status_filter == "expired":
        filters.append(Share.revoked_at.is_(None))
        filters.append(Share.expires_at.is_not(None))
        filters.append(Share.expires_at <= now)
    elif status_filter == "active":
        filters.append(Share.revoked_at.is_(None))
        filters.append(or_(Share.expires_at.is_(None), Share.expires_at > now))

    order_by = {
        "created_desc": Share.created_at.desc(),
        "created_asc": Share.created_at.asc(),
        "size_desc": Share.total_bytes.desc(),
        "downloads_desc": Share.download_count.desc(),
        "expires_asc": Share.expires_at.asc().nullslast(),
    }[sort]

    count_stmt = select(func.count()).select_from(Share).where(*filters)
    total = (await db.execute(count_stmt)).scalar() or 0

    # 分页查询
    stmt = (
        select(Share)
        .options(selectinload(Share.files), selectinload(Share.logical_files))
        .where(*filters)
        .order_by(order_by)
        .offset(offset)
        .limit(page_size)
    )
    result = await db.execute(stmt)
    shares = result.scalars().all()

    from app.models.quota import QuotaPolicyVersion
    from app.schemas.quota_policy import QuotaPolicyConfig
    from app.services.quota_policy import default_policy_config

    versions = {share.policy_version for share in shares if share.policy_version}
    policy_rows = (
        await db.scalars(select(QuotaPolicyVersion).where(QuotaPolicyVersion.version.in_(versions)))
    ).all() if versions else []
    policies = {
        row.version: QuotaPolicyConfig.model_validate(row.config).user
        for row in policy_rows
    }
    fallback_policy = default_policy_config().user

    share_ids = [s.id for s in shares]
    last_downloaded_by_share = {}
    if share_ids:
        last_download_rows = await db.execute(
            select(DownloadLog.share_id, func.max(DownloadLog.downloaded_at))
            .where(DownloadLog.share_id.in_(share_ids))
            .group_by(DownloadLog.share_id)
        )
        last_downloaded_by_share = dict(last_download_rows.all())

    def build_preview(s: Share) -> tuple[list[str], int]:
        logical_files = list(s.logical_files or [])
        if logical_files:
            return [f.original_name for f in logical_files[:3]], len(logical_files)

        names: list[str] = []
        seen: set[str] = set()
        for file in s.files or []:
            if file.original_name in seen:
                continue
            seen.add(file.original_name)
            names.append(file.original_name)
        return names[:3], len(names)

    items = []
    for s in shares:
        share_policy = policies.get(s.policy_version, fallback_policy)
        preview_files, file_count = build_preview(s)
        last_downloaded_at = last_downloaded_by_share.get(s.id)
        items.append(MyShareItem(
            code=s.code,
            title=s.title,
            preview_files=preview_files,
            empty_dir_count=len(s.empty_dirs or []),
            file_count=file_count,
            total_bytes=s.total_bytes,
            has_password=s.password_hash is not None,
            download_count=s.download_count,
            max_downloads=s.max_downloads,
            retention_options_hours=share_policy.retention_options_hours,
            download_options=share_policy.download_options,
            last_downloaded_at=last_downloaded_at.isoformat() if last_downloaded_at else None,
            created_at=s.created_at.isoformat() if s.created_at else "",
            expires_at=s.expires_at.isoformat() if s.expires_at else None,
            revoked=s.revoked_at is not None,
        ))

    return MySharesListResponse(
        shares=items, total=total, page=page, page_size=page_size
    )


# ─── 撤销 ────────────────────────────────────────────────────────

@router.delete("/shares/{code}", response_model=MessageResponse)
async def revoke_share(
    code: str,
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    """撤销分享（软删除，文件不再可下载）。"""
    stmt = select(Share).where(Share.code == code, Share.owner_id == user.id)
    result = await db.execute(stmt)
    share = result.scalar_one_or_none()

    if not share:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在")
    if share.revoked_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "已撤销")

    share.revoked_at = datetime.now(UTC)
    await db.commit()
    return MessageResponse(message="分享已撤销")


# ─── 编辑 ────────────────────────────────────────────────────────

@router.patch("/shares/{code}", response_model=MessageResponse)
async def edit_share(
    code: str,
    body: ShareEditRequest,
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    """编辑分享（修改密码/过期时间）。"""
    stmt = select(Share).where(Share.code == code, Share.owner_id == user.id)
    result = await db.execute(stmt)
    share = result.scalar_one_or_none()

    if not share:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "分享不存在")
    if share.revoked_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "已撤销的分享不可编辑")

    await db.scalar(select(func.pg_advisory_xact_lock(func.hashtext(f"share:user:{user.id}"))))
    now = datetime.now(UTC)
    was_active = (
        share.banned_at is None
        and (share.expires_at is None or share.expires_at > now)
        and (share.max_downloads == 0 or share.download_count < share.max_downloads)
    )

    from app.models.quota import QuotaPolicyVersion
    from app.schemas.quota_policy import QuotaPolicyConfig
    from app.services.quota_policy import default_policy_config

    policy_row = None
    if share.policy_version:
        policy_row = await db.scalar(
            select(QuotaPolicyVersion).where(QuotaPolicyVersion.version == share.policy_version)
        )
    policy = (
        QuotaPolicyConfig.model_validate(policy_row.config).user
        if policy_row
        else default_policy_config().user
    )

    if body.password is not None:
        if body.password == "":
            share.password_hash = None
        else:
            from app.utils.security import hash_secret
            share.password_hash = hash_secret(body.password)

    if body.expires_hours is not None:
        if body.expires_hours == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "永久有效不在创建时策略选项中")
        else:
            if body.expires_hours not in policy.retention_options_hours:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "分享有效期不在创建时策略选项中")
            share.expires_at = datetime.now(UTC) + timedelta(hours=body.expires_hours)

    if body.max_downloads is not None:
        if body.max_downloads not in policy.download_options:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "下载次数上限不合法")
        share.max_downloads = body.max_downloads

    is_active = (
        share.banned_at is None
        and (share.expires_at is None or share.expires_at > now)
        and (share.max_downloads == 0 or share.download_count < share.max_downloads)
    )
    if not was_active and is_active:
        active_count = await db.scalar(
            select(func.count())
            .select_from(Share)
            .where(
                Share.owner_id == user.id,
                Share.id != share.id,
                Share.revoked_at.is_(None),
                Share.banned_at.is_(None),
                or_(Share.expires_at.is_(None), Share.expires_at > now),
                or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
            )
        ) or 0
        if active_count >= policy.max_active_shares:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "活跃分享数量已达创建时策略上限")

    await db.commit()
    return MessageResponse(message="修改成功")
