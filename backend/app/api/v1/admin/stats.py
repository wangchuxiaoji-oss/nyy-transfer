"""Admin 总览统计。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.config import get_settings
from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.share import DownloadLog, Share, ShareAccessEvent
from app.models.system import EmailDelivery, Report
from app.models.user import User
from app.schemas.admin import (
    AdminDashboardResponse,
    AdminDashboardTasks,
    AdminDashboardToday,
    AdminStatsResponse,
)

router = APIRouter()


async def _load_stats(db: AsyncSession) -> AdminStatsResponse:
    since = datetime.now(UTC) - timedelta(hours=24)
    users_total = await db.scalar(select(func.count()).select_from(User)) or 0
    shares_total = await db.scalar(select(func.count()).select_from(Share)) or 0
    now = datetime.now(UTC)
    shares_active = await db.scalar(
        select(func.count()).select_from(Share).where(
            Share.revoked_at.is_(None),
            Share.banned_at.is_(None),
            or_(Share.expires_at.is_(None), Share.expires_at > now),
            or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
        )
    ) or 0
    shares_banned = await db.scalar(
        select(func.count()).select_from(Share).where(Share.banned_at.is_not(None))
    ) or 0
    uploaded_bytes_total = await db.scalar(select(func.coalesce(func.sum(Share.total_bytes), 0))) or 0
    uploaded_bytes_24h = await db.scalar(
        select(func.coalesce(func.sum(Share.total_bytes), 0)).where(Share.created_at >= since)
    ) or 0
    reports_pending = await db.scalar(select(func.count()).select_from(Report).where(Report.status == "pending")) or 0
    emails_failed = await db.scalar(select(func.count()).select_from(EmailDelivery).where(EmailDelivery.status == "failed")) or 0
    return AdminStatsResponse(
        users_total=users_total,
        shares_total=shares_total,
        shares_active=shares_active,
        shares_banned=shares_banned,
        uploaded_bytes_total=uploaded_bytes_total,
        uploaded_bytes_24h=uploaded_bytes_24h,
        reports_pending=reports_pending,
        emails_failed=emails_failed,
    )


@router.get("/stats", response_model=AdminStatsResponse)
async def get_stats(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    return await _load_stats(db)


@router.get("/dashboard", response_model=AdminDashboardResponse)
async def get_dashboard(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """返回日常待办和最近 24 小时运营信号。"""

    since = datetime.now(UTC) - timedelta(hours=24)
    human_event = aliased(ShareAccessEvent)
    suspicious_access = await db.scalar(
        select(func.count(func.distinct(ShareAccessEvent.share_id))).where(
            ShareAccessEvent.event_type == "preview_fetch",
            ShareAccessEvent.created_at >= since,
            ~exists(
                select(human_event.id).where(
                    human_event.share_id == ShareAccessEvent.share_id,
                    human_event.event_type.in_(["human_interaction", "link_issued"]),
                    human_event.created_at >= since,
                )
            ),
        )
    ) or 0
    shares_created = await db.scalar(
        select(func.count()).select_from(Share).where(Share.created_at >= since)
    ) or 0
    uploaded_bytes = await db.scalar(
        select(func.coalesce(func.sum(Share.total_bytes), 0)).where(Share.created_at >= since)
    ) or 0
    links_issued = await db.scalar(
        select(func.count()).select_from(DownloadLog).where(DownloadLog.downloaded_at >= since)
    ) or 0
    human_interactions = await db.scalar(
        select(func.count()).select_from(ShareAccessEvent).where(
            ShareAccessEvent.event_type == "human_interaction",
            ShareAccessEvent.created_at >= since,
        )
    ) or 0
    preview_fetches = await db.scalar(
        select(func.count()).select_from(ShareAccessEvent).where(
            ShareAccessEvent.event_type == "preview_fetch",
            ShareAccessEvent.created_at >= since,
        )
    ) or 0
    totals = await _load_stats(db)
    session_file = get_settings().doubao_session_file
    doubao_unavailable = int(not session_file or not Path(session_file).is_file())
    return AdminDashboardResponse(
        tasks=AdminDashboardTasks(
            reports_pending=totals.reports_pending,
            emails_failed=totals.emails_failed,
            suspicious_access=int(suspicious_access),
            doubao_unavailable=doubao_unavailable,
        ),
        today=AdminDashboardToday(
            shares_created=int(shares_created),
            links_issued=int(links_issued),
            human_interactions=int(human_interactions),
            preview_fetches=int(preview_fetches),
            uploaded_bytes=int(uploaded_bytes),
        ),
        totals=totals,
    )
