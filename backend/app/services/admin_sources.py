"""管理员来源摘要查询。"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.auth import AuthEvent
from app.models.share import ShareAccessEvent
from app.schemas.admin import AdminIpGeo, AdminIpSource
from app.services.geoip import lookup_ip_source


def build_ip_source(ip_value: object) -> AdminIpSource | None:
    if ip_value is None:
        return None
    value = str(ip_value)
    if not value:
        return None
    return AdminIpSource(ip=value, geo=AdminIpGeo(**lookup_ip_source(value)))


async def load_user_source_summaries(
    db: AsyncSession,
    user_ids: list[UUID],
) -> tuple[dict[UUID, AdminIpSource], dict[UUID, AdminIpSource]]:
    registrations: dict[UUID, AdminIpSource] = {}
    logins: dict[UUID, AdminIpSource] = {}
    if not user_ids:
        return registrations, logins
    registration_rows = await db.execute(
        select(AuthEvent)
        .where(
            AuthEvent.user_id.in_(user_ids),
            AuthEvent.success.is_(True),
            AuthEvent.event_type == "register_success",
        )
        .order_by(AuthEvent.user_id, AuthEvent.created_at.asc(), AuthEvent.id.asc())
        .distinct(AuthEvent.user_id)
    )
    for event in registration_rows.scalars():
        source = build_ip_source(event.ip)
        if event.user_id is not None and source is not None:
            registrations[event.user_id] = source

    login_rows = await db.execute(
        select(AuthEvent)
        .where(
            AuthEvent.user_id.in_(user_ids),
            AuthEvent.success.is_(True),
            AuthEvent.event_type == "login_success",
        )
        .order_by(AuthEvent.user_id, AuthEvent.created_at.desc(), AuthEvent.id.desc())
        .distinct(AuthEvent.user_id)
    )
    for event in login_rows.scalars():
        source = build_ip_source(event.ip)
        if event.user_id is not None and source is not None:
            logins[event.user_id] = source
    return registrations, logins


async def load_share_access_summaries(
    db: AsyncSession,
    share_ids: list[UUID],
) -> dict[UUID, tuple[int, int]]:
    if not share_ids:
        return {}
    rows = await db.execute(
        select(
            ShareAccessEvent.share_id,
            func.count(ShareAccessEvent.id),
            func.count(func.distinct(ShareAccessEvent.ip)),
        )
        .where(ShareAccessEvent.share_id.in_(share_ids))
        .group_by(ShareAccessEvent.share_id)
    )
    return {share_id: (int(count), int(unique_ips)) for share_id, count, unique_ips in rows.all()}


async def load_share_event_summaries(
    db: AsyncSession,
    share_ids: list[UUID],
) -> dict[UUID, dict[str, int]]:
    if not share_ids:
        return {}
    rows = await db.execute(
        select(
            ShareAccessEvent.share_id,
            func.count(ShareAccessEvent.id),
            func.count(func.distinct(ShareAccessEvent.ip)),
            func.count(ShareAccessEvent.id).filter(
                ShareAccessEvent.event_type.in_(["view", "page_rendered"])
            ),
            func.count(ShareAccessEvent.id).filter(
                ShareAccessEvent.event_type == "human_interaction"
            ),
            func.count(ShareAccessEvent.id).filter(
                ShareAccessEvent.event_type == "preview_fetch"
            ),
            func.count(ShareAccessEvent.id).filter(
                ShareAccessEvent.event_type == "admin_review"
            ),
        )
        .where(ShareAccessEvent.share_id.in_(share_ids))
        .group_by(ShareAccessEvent.share_id)
    )
    return {
        share_id: {
            "total": int(total),
            "unique_ips": int(unique_ips),
            "page_rendered": int(page_rendered),
            "human_interaction": int(human_interaction),
            "preview_fetch": int(preview_fetch),
            "admin_review": int(admin_review),
        }
        for (
            share_id,
            total,
            unique_ips,
            page_rendered,
            human_interaction,
            preview_fetch,
            admin_review,
        ) in rows.all()
    }
