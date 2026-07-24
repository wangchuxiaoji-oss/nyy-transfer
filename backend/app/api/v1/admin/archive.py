"""Admin 终态分享归档：dry-run、显式执行与归档查询。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.system import ArchivedShare
from app.models.user import User
from app.schemas.admin import ArchiveRequest, ArchiveResponse
from app.services.admin_audit import add_admin_audit
from app.services.pagination import (
    created_cursor_filter,
    decode_created_cursor,
    encode_created_cursor,
)
from app.services.share_archive import archive_dry_run, archive_terminal_shares

router = APIRouter()


@router.post("/archive/shares/dry-run", response_model=ArchiveResponse)
async def dry_run_share_archive(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    from app.core.config import get_settings

    result = await archive_dry_run(
        db,
        retention_days=get_settings().share_archive_retention_days,
    )
    return ArchiveResponse(**result)


@router.post("/archive/shares/execute", response_model=ArchiveResponse)
async def execute_share_archive(
    body: ArchiveRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    from app.core.config import get_settings

    settings = get_settings()
    if not settings.share_archive_enabled:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "分享归档功能未启用；仅允许 dry-run",
        )
    result = await archive_terminal_shares(
        db,
        actor_id=admin.id,
        retention_days=settings.share_archive_retention_days,
        batch_size=body.batch_size,
    )
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="share.archive_execute",
        target_type="archive_batch",
        target_id=result.get("batch_id") or "locked",
        after=result,
        success=not result.get("locked", False),
        error_summary="归档任务已由其他 worker 执行" if result.get("locked") else None,
    )
    await db.commit()
    return ArchiveResponse(**result)


@router.get("/archived-shares")
async def list_archived_shares(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(50, ge=1, le=200),
    after: str | None = Query(None, max_length=512),
):
    stmt = select(ArchivedShare)
    cursor = decode_created_cursor(after)
    if cursor:
        stmt = stmt.where(
            created_cursor_filter(
                ArchivedShare.archived_at,
                ArchivedShare.id,
                cursor,
                after=True,
            )
        )
    rows = list(
        (
            await db.scalars(
                stmt.order_by(ArchivedShare.archived_at.desc(), ArchivedShare.id.desc()).limit(limit + 1)
            )
        ).all()
    )
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]
    return {
        "pagination_mode": "cursor",
        "items": [
            {
                "id": str(row.id),
                "code": row.code,
                "title": row.title,
                "terminal_status": row.terminal_status,
                "total_bytes": row.total_bytes,
                "logical_file_count": row.logical_file_count,
                "stored_object_count": row.stored_object_count,
                "created_at": row.original_created_at,
                "last_activity_at": row.last_activity_at,
                "archived_at": row.archived_at,
                "file_summary": row.file_summary,
            }
            for row in rows
        ],
        "next_cursor": (
            encode_created_cursor(rows[-1].archived_at, rows[-1].id)
            if rows and has_more
            else None
        ),
        "prev_cursor": None,
        "has_more": has_more,
        "page": None,
        "page_size": None,
        "total": None,
        "total_is_estimated": False,
    }
