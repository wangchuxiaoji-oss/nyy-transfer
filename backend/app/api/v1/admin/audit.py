"""Admin 操作审计查询（只读）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.admin.common import _validate_cursor_args
from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.system import AuditLog
from app.models.user import User
from app.schemas.admin import AdminAuditItem, AdminAuditResponse
from app.services.pagination import (
    created_cursor_filter,
    decode_created_cursor,
    encode_created_cursor,
)

router = APIRouter()


@router.get("/audit-logs", response_model=AdminAuditResponse)
async def list_audit_logs(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(50, ge=1, le=200),
    after: str | None = Query(None, max_length=512),
    before: str | None = Query(None, max_length=512),
    action: str = Query("", max_length=64),
    target_type: str = Query("", max_length=64),
    target_id: str = Query("", max_length=128),
):
    _validate_cursor_args(after, before)
    filters = []
    if action:
        filters.append(AuditLog.action == action)
    if target_type:
        filters.append(AuditLog.target_type == target_type)
    if target_id:
        filters.append(AuditLog.target_id == target_id)
    stmt = select(AuditLog).where(*filters)
    cursor = decode_created_cursor(after or before)
    reverse_page = bool(before)
    if cursor:
        stmt = stmt.where(
            created_cursor_filter(AuditLog.created_at, AuditLog.id, cursor, after=bool(after))
        )
    stmt = stmt.order_by(
        AuditLog.created_at.asc() if reverse_page else AuditLog.created_at.desc(),
        AuditLog.id.asc() if reverse_page else AuditLog.id.desc(),
    ).limit(limit + 1)
    rows = list((await db.scalars(stmt)).all())
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]
    if reverse_page:
        rows.reverse()
    items = [
        AdminAuditItem(
            id=str(row.id),
            created_at=row.created_at,
            request_id=row.request_id,
            actor_id=str(row.actor_id) if row.actor_id else None,
            actor_email=row.actor_email,
            action=row.action,
            target_type=row.target_type,
            target_id=row.target_id,
            before=row.before_value,
            after=row.after_value,
            reason=row.reason,
            note=row.note,
            batch_id=row.batch_id,
            success=row.success,
            error_summary=row.error_summary,
            ip=str(row.ip) if row.ip else None,
            user_agent=row.user_agent,
        )
        for row in rows
    ]
    return AdminAuditResponse(
        items=items,
        next_cursor=(
            encode_created_cursor(rows[-1].created_at, rows[-1].id)
            if rows and has_more
            else None
        ),
        prev_cursor=(
            encode_created_cursor(rows[0].created_at, rows[0].id)
            if rows and (after or before)
            else None
        ),
        has_more=has_more,
    )
