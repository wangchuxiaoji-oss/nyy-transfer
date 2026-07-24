"""管理员操作审计服务。"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session_factory
from app.models.system import AuditLog
from app.models.user import User
from app.utils.client_ip import get_client_ip

log = logging.getLogger(__name__)


def request_id_from_request(request: Request) -> str:
    value = (
        request.headers.get("x-request-id")
        or request.headers.get("x-nyy-request-id")
        or str(uuid.uuid4())
    )
    return value.strip()[:128]


def _json_value(value: Any) -> dict | None:
    if value is None:
        return None
    encoded = jsonable_encoder(value)
    return encoded if isinstance(encoded, dict) else {"value": encoded}


def add_admin_audit(
    db: AsyncSession,
    *,
    request: Request,
    actor: User,
    action: str,
    target_type: str,
    target_id: str,
    before: Any = None,
    after: Any = None,
    reason: str | None = None,
    note: str | None = None,
    batch_id: str | None = None,
    success: bool = True,
    error_summary: str | None = None,
    request_id: str | None = None,
) -> AuditLog:
    """把审计行加入当前事务，确保状态变更与审计原子提交。"""

    before_value = _json_value(before)
    after_value = _json_value(after)
    row = AuditLog(
        actor_id=actor.id,
        actor_email=actor.email,
        request_id=(request_id or request_id_from_request(request))[:128],
        action=action[:64],
        target=f"{target_type}:{target_id}"[:128],
        payload={"before": before_value, "after": after_value},
        target_type=target_type[:64],
        target_id=target_id[:128],
        before_value=before_value,
        after_value=after_value,
        reason=(reason or "")[:1000] or None,
        note=(note or "")[:2000] or None,
        batch_id=(batch_id or "")[:128] or None,
        success=success,
        error_summary=(error_summary or "")[:1000] or None,
        ip=get_client_ip(request),
        user_agent=(request.headers.get("user-agent") or "")[:512] or None,
        created_at=datetime.now(UTC),
    )
    db.add(row)
    return row


async def write_admin_audit(
    *,
    actor_id: uuid.UUID,
    actor_email: str,
    request_id: str,
    ip: str,
    user_agent: str,
    action: str,
    target_type: str,
    target_id: str,
    before: Any = None,
    after: Any = None,
    reason: str | None = None,
    note: str | None = None,
    success: bool = True,
    error_summary: str | None = None,
) -> None:
    """线程回调等无法复用请求事务时，用独立会话追加审计。"""

    try:
        factory = get_session_factory()
        async with factory() as db:
            before_value = _json_value(before)
            after_value = _json_value(after)
            db.add(
                AuditLog(
                    actor_id=actor_id,
                    actor_email=actor_email,
                    request_id=request_id[:128],
                    action=action[:64],
                    target=f"{target_type}:{target_id}"[:128],
                    payload={"before": before_value, "after": after_value},
                    target_type=target_type[:64],
                    target_id=target_id[:128],
                    before_value=before_value,
                    after_value=after_value,
                    reason=(reason or "")[:1000] or None,
                    note=(note or "")[:2000] or None,
                    success=success,
                    error_summary=(error_summary or "")[:1000] or None,
                    ip=ip,
                    user_agent=user_agent[:512] or None,
                    created_at=datetime.now(UTC),
                )
            )
            await db.commit()
    except Exception:
        log.exception("管理员审计写入失败: action=%s target=%s", action, target_id)
