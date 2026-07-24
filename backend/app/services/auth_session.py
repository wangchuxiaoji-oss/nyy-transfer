"""认证 Session 服务：refresh token 落库、轮换、撤销、复用检测。"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.auth import AuthSession


def _hash_token(token: str) -> str:
    """SHA-256 哈希 refresh token。"""
    return hashlib.sha256(token.encode()).hexdigest()


def _generate_token() -> str:
    """生成高熵 refresh token。"""
    return secrets.token_urlsafe(48)


async def create_session(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    ip: str | None = None,
    ua: str | None = None,
    family_id: uuid.UUID | None = None,
    rotated_from_id: uuid.UUID | None = None,
) -> tuple[AuthSession, str]:
    """创建新的 refresh session，返回 (session, raw_token)。"""
    settings = get_settings()
    token = _generate_token()
    token_h = _hash_token(token)
    now = datetime.now(UTC)

    session = AuthSession(
        user_id=user_id,
        token_hash=token_h,
        family_id=family_id or uuid.uuid4(),
        rotated_from_id=rotated_from_id,
        ip=ip,
        user_agent=(ua or "")[:512],
        last_used_at=now,
        expires_at=now + timedelta(days=settings.auth_refresh_token_expire_days),
    )
    db.add(session)
    await db.flush()
    return session, token


async def rotate_session(
    db: AsyncSession,
    raw_token: str,
    *,
    ip: str | None = None,
    ua: str | None = None,
) -> tuple[AuthSession | None, str | None]:
    """轮换 refresh token。旧 token 立即撤销，新 token 返回。

    如果旧 token 被复用（已被撤销），返回 (None, family_id_hex) 以触发 family 撤销。
    """
    token_h = _hash_token(raw_token)
    now = datetime.now(UTC)

    result = await db.execute(
        select(AuthSession).where(AuthSession.token_hash == token_h).with_for_update()
    )
    old_session = result.scalar_one_or_none()

    if not old_session:
        return None, None

    # 已撤销的 token 被复用
    if old_session.revoked_at:
        return None, str(old_session.family_id)

    # 过期
    if old_session.expires_at < now:
        return None, None

    # 撤销旧 session
    old_session.revoked_at = now
    old_session.revoked_reason = "rotated"

    # 创建新 session，沿用 family_id
    new_session, new_token = await create_session(
        db,
        user_id=old_session.user_id,
        ip=ip,
        ua=ua,
        family_id=old_session.family_id,
        rotated_from_id=old_session.id,
    )
    return new_session, new_token


async def get_active_session_by_token(db: AsyncSession, raw_token: str) -> AuthSession | None:
    """只读校验 refresh token，不做轮换，适合首屏 bootstrap。"""
    token_h = _hash_token(raw_token)
    now = datetime.now(UTC)
    result = await db.execute(select(AuthSession).where(AuthSession.token_hash == token_h))
    session = result.scalar_one_or_none()
    if not session or session.revoked_at or session.expires_at < now:
        return None
    return session


async def revoke_family(db: AsyncSession, family_id: uuid.UUID) -> int:
    """撤销同一 family 下所有未撤销 session。"""
    now = datetime.now(UTC)
    result = await db.execute(
        update(AuthSession)
        .where(
            AuthSession.family_id == family_id,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=now, revoked_reason="family_reuse_detected")
    )
    return result.rowcount


async def revoke_user_sessions(db: AsyncSession, user_id: uuid.UUID) -> int:
    """撤销用户所有 session。"""
    now = datetime.now(UTC)
    result = await db.execute(
        update(AuthSession)
        .where(
            AuthSession.user_id == user_id,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=now, revoked_reason="user_action")
    )
    return result.rowcount


async def revoke_session_by_token(db: AsyncSession, raw_token: str) -> bool:
    """通过 raw token 撤销单个 session。"""
    token_h = _hash_token(raw_token)
    now = datetime.now(UTC)
    result = await db.execute(
        update(AuthSession)
        .where(
            AuthSession.token_hash == token_h,
            AuthSession.revoked_at.is_(None),
        )
        .values(revoked_at=now, revoked_reason="logout")
    )
    return result.rowcount > 0
