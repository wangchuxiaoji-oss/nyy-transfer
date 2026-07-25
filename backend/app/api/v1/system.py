"""公开系统更新与维护状态。"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.system import SystemAnnouncement
from app.schemas.announcement import (
    PublicAnnouncementItem,
    PublicAnnouncementListResponse,
)

router = APIRouter(prefix="/system", tags=["system"])


def _public_item(row: SystemAnnouncement) -> PublicAnnouncementItem:
    if row.published_at is None:
        raise ValueError("已发布公告缺少 published_at")
    return PublicAnnouncementItem(
        id=row.id,
        notice_id=f"{row.id}:{row.revision}",
        version=row.version,
        category=row.category,
        state=row.state,
        priority=row.priority,
        title=row.title,
        summary=row.summary,
        details=row.details,
        revision=row.revision,
        started_at=row.started_at,
        completed_at=row.completed_at,
        visible_until=row.visible_until,
        published_at=row.published_at,
    )


@router.get("/announcements", response_model=PublicAnnouncementListResponse)
async def list_public_announcements(
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0, le=10_000),
    active_only: bool = False,
    db: AsyncSession = Depends(get_db),
):
    filters = [SystemAnnouncement.status == "published"]
    if active_only:
        now = datetime.now(UTC)
        filters.append(
            or_(
                SystemAnnouncement.visible_until.is_(None),
                SystemAnnouncement.visible_until > now,
            )
        )
    rows = (
        await db.scalars(
            select(SystemAnnouncement)
            .where(*filters)
            .order_by(
                SystemAnnouncement.published_at.desc(),
                SystemAnnouncement.id.desc(),
            )
            .offset(offset)
            .limit(limit + 1)
        )
    ).all()
    has_more = len(rows) > limit
    visible_rows = rows[:limit]
    return PublicAnnouncementListResponse(
        items=[_public_item(row) for row in visible_rows],
        has_more=has_more,
        next_offset=offset + limit if has_more else None,
    )
