"""认证依赖注入：提取当前用户（可选/必须）。"""

from __future__ import annotations

import uuid

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.user import User
from app.services.auth import decode_token


ADMIN_EMAIL = "admin@nyy.app"


async def _load_user_from_request(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return None

    token = auth_header[7:]
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        return None

    user_id = payload.get("sub")
    try:
        uid = uuid.UUID(user_id)
    except (ValueError, TypeError):
        return None

    result = await db.execute(select(User).where(User.id == uid))
    return result.scalar_one_or_none()


def _unavailable_message(user: User) -> str | None:
    if user.deleted_at is not None:
        return "账号已删除"
    if user.disabled_at is not None:
        return "账号已禁用"
    return None


async def get_current_user_optional(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """从 Authorization header 解析用户，未登录返回 None。"""
    user = await _load_user_from_request(request, db)
    if not user:
        return None
    unavailable = _unavailable_message(user)
    if unavailable:
        raise HTTPException(403, unavailable)
    return user


async def get_current_user_required(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    """必须登录，否则 401。"""
    user = await _load_user_from_request(request, db)
    if not user:
        raise HTTPException(401, "未登录")
    unavailable = _unavailable_message(user)
    if unavailable:
        raise HTTPException(403, unavailable)
    return user


async def get_current_admin_user(
    user: User = Depends(get_current_user_required),
) -> User:
    """必须是管理员，否则 403。"""
    if not user.is_admin or user.email.lower().strip() != ADMIN_EMAIL:
        raise HTTPException(403, "需要管理员权限")
    return user
