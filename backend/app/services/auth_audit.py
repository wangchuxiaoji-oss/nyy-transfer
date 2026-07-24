"""认证审计事件服务。"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session_factory
from app.models.auth import AuthEvent

log = logging.getLogger(__name__)


def _hash_email(email: str) -> str:
    """邮箱脱敏哈希，用于审计存储。"""
    return hashlib.sha256(email.lower().strip().encode()).hexdigest()[:16]


async def log_auth_event(
    db: AsyncSession,
    *,
    event_type: str,
    success: bool = True,
    user_id: uuid.UUID | None = None,
    email: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    reason: str | None = None,
    metadata: dict | None = None,
) -> None:
    """记录认证审计事件。使用独立会话提交，失败不影响主事务。"""
    _ = db
    try:
        factory = get_session_factory()
        async with factory() as audit_db:
            event = AuthEvent(
                user_id=user_id,
                email_hash=_hash_email(email) if email else None,
                event_type=event_type,
                success=success,
                ip=ip,
                user_agent=(user_agent or "")[:512],
                reason=reason,
                extra_data=metadata,
                created_at=datetime.now(UTC),
            )
            audit_db.add(event)
            await audit_db.commit()
    except Exception:
        log.warning("failed to log auth event %s, skipping", event_type, exc_info=True)
