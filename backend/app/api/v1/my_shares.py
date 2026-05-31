"""我的分享 API：列表 / 撤销 / 编辑。

GET    /api/v1/my/shares          — 列表（分页）
DELETE /api/v1/my/shares/:code    — 撤销
PATCH  /api/v1/my/shares/:code    — 编辑（密码/过期时间）
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import get_current_user_required
from app.db.session import get_db
from app.models.share import Share, ShareFile
from app.models.user import User

log = logging.getLogger(__name__)
router = APIRouter(prefix="/my", tags=["my-shares"])


# ─── Schemas ─────────────────────────────────────────────────────

class MyShareItem(BaseModel):
    code: str
    title: str | None = None
    file_count: int
    total_bytes: int
    has_password: bool
    download_count: int
    max_downloads: int
    created_at: str
    expires_at: str | None
    revoked: bool


class MySharesListResponse(BaseModel):
    shares: list[MyShareItem]
    total: int
    page: int
    page_size: int


class ShareEditRequest(BaseModel):
    password: str | None = Field(default=None, description="新密码，空字符串表示清除密码")
    expires_hours: int | None = Field(default=None, ge=0, description="从现在起的过期小时数，0=永不过期")


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

    now = datetime.now(timezone.utc)
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

    items = [
        MyShareItem(
            code=s.code,
            title=s.title,
            file_count=len(s.logical_files),
            total_bytes=s.total_bytes,
            has_password=s.password_hash is not None,
            download_count=s.download_count,
            max_downloads=s.max_downloads,
            created_at=s.created_at.isoformat() if s.created_at else "",
            expires_at=s.expires_at.isoformat() if s.expires_at else None,
            revoked=s.revoked_at is not None,
        )
        for s in shares
    ]

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

    share.revoked_at = datetime.now(timezone.utc)
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

    if body.password is not None:
        if body.password == "":
            share.password_hash = None
        else:
            from app.utils.security import hash_secret
            share.password_hash = hash_secret(body.password)

    if body.expires_hours is not None:
        if body.expires_hours == 0:
            share.expires_at = None
        else:
            share.expires_at = datetime.now(timezone.utc) + timedelta(hours=body.expires_hours)

    await db.commit()
    return MessageResponse(message="修改成功")
