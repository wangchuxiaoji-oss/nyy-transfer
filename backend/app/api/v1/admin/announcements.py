"""Admin 系统更新公告管理。"""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.system import SystemAnnouncement
from app.models.user import User
from app.schemas.announcement import (
    AdminAnnouncementListResponse,
    AnnouncementCreate,
    AnnouncementResponse,
    AnnouncementUpdate,
)
from app.services.admin_audit import add_admin_audit

router = APIRouter()


def _response(row: SystemAnnouncement) -> AnnouncementResponse:
    return AnnouncementResponse.model_validate(row)


async def _get_row(db: AsyncSession, announcement_id: uuid.UUID) -> SystemAnnouncement:
    row = await db.get(SystemAnnouncement, announcement_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "公告不存在")
    return row


def _editable_values(row: SystemAnnouncement) -> dict:
    return {
        "version": row.version,
        "category": row.category,
        "state": row.state,
        "priority": row.priority,
        "title": row.title,
        "summary": row.summary,
        "details": row.details,
        "started_at": row.started_at,
        "completed_at": row.completed_at,
        "visible_until": row.visible_until,
    }


@router.get("/announcements", response_model=AdminAnnouncementListResponse)
async def list_announcements(
    page: int = Query(default=1, ge=1, le=10_000),
    page_size: int = Query(default=20, ge=1, le=100),
    announcement_status: str = Query(
        default="all", alias="status", pattern=r"^(all|draft|published|archived)$"
    ),
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    filters = []
    if announcement_status != "all":
        filters.append(SystemAnnouncement.status == announcement_status)
    total = await db.scalar(
        select(func.count()).select_from(SystemAnnouncement).where(*filters)
    ) or 0
    rows = (
        await db.scalars(
            select(SystemAnnouncement)
            .where(*filters)
            .order_by(SystemAnnouncement.created_at.desc(), SystemAnnouncement.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return AdminAnnouncementListResponse(
        items=[_response(row) for row in rows],
        total=total,
        page=page,
        page_size=page_size,
        pages=max(1, math.ceil(total / page_size)),
    )


@router.post(
    "/announcements",
    response_model=AnnouncementResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_announcement(
    body: AnnouncementCreate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = SystemAnnouncement(
        **body.model_dump(),
        created_by=admin.id,
        updated_by=admin.id,
    )
    db.add(row)
    try:
        await db.flush()
        after = _response(row)
        add_admin_audit(
            db,
            request=request,
            actor=admin,
            action="announcement.create",
            target_type="system_announcement",
            target_id=str(row.id),
            after=after,
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "公告版本标识已存在") from exc
    await db.refresh(row)
    return _response(row)


@router.patch("/announcements/{announcement_id}", response_model=AnnouncementResponse)
async def update_announcement(
    announcement_id: uuid.UUID,
    body: AnnouncementUpdate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_row(db, announcement_id)
    before = _response(row)
    values = _editable_values(row)
    for field_name in body.model_fields_set:
        values[field_name] = getattr(body, field_name)
    validated = AnnouncementCreate.model_validate(values)
    for field_name, value in validated.model_dump().items():
        setattr(row, field_name, value)
    row.updated_by = admin.id
    row.updated_at = datetime.now(UTC)
    try:
        await db.flush()
        after = _response(row)
        add_admin_audit(
            db,
            request=request,
            actor=admin,
            action="announcement.update",
            target_type="system_announcement",
            target_id=str(row.id),
            before=before,
            after=after,
        )
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, "公告版本标识已存在") from exc
    await db.refresh(row)
    return _response(row)


@router.post("/announcements/{announcement_id}/publish", response_model=AnnouncementResponse)
async def publish_announcement(
    announcement_id: uuid.UUID,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_row(db, announcement_id)
    AnnouncementCreate.model_validate(_editable_values(row))
    before = _response(row)
    now = datetime.now(UTC)
    row.status = "published"
    row.revision += 1
    row.published_at = now
    row.archived_at = None
    row.updated_at = now
    row.updated_by = admin.id
    await db.flush()
    after = _response(row)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="announcement.publish",
        target_type="system_announcement",
        target_id=str(row.id),
        before=before,
        after=after,
        note="再次发布会生成新的首次通知 revision",
    )
    await db.commit()
    await db.refresh(row)
    return _response(row)


@router.post("/announcements/{announcement_id}/archive", response_model=AnnouncementResponse)
async def archive_announcement(
    announcement_id: uuid.UUID,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_row(db, announcement_id)
    before = _response(row)
    now = datetime.now(UTC)
    row.status = "archived"
    row.archived_at = now
    row.updated_at = now
    row.updated_by = admin.id
    await db.flush()
    after = _response(row)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="announcement.archive",
        target_type="system_announcement",
        target_id=str(row.id),
        before=before,
        after=after,
    )
    await db.commit()
    await db.refresh(row)
    return _response(row)
