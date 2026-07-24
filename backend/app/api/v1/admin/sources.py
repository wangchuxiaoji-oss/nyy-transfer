"""管理员 IP 来源详情与关联分析。"""

from __future__ import annotations

import base64
import binascii
import json
from datetime import UTC, datetime
from ipaddress import ip_address
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import String, and_, cast, exists, func, or_, select, union
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.auth import AuthEvent, AuthSession
from app.models.share import DownloadLog, Share, ShareAccessEvent
from app.models.user import User
from app.schemas.admin import (
    AdminIpRelatedShare,
    AdminIpRelatedUser,
    AdminIpRelationsResponse,
    AdminShareSourcesResponse,
    AdminSourceEvent,
    AdminUserSourcesResponse,
)
from app.services.admin_sources import build_ip_source
from app.services.pagination import (
    created_cursor_filter,
    decode_created_cursor,
    encode_created_cursor,
)
from app.services.share_access import guest_label

router = APIRouter()


def _encode_ip_relations_cursor(
    *,
    user_after: UUID | None,
    users_done: bool,
    share_after: UUID | None,
    shares_done: bool,
    guest_after: str | None,
    guests_done: bool,
) -> str:
    payload = json.dumps(
        {
            "u": str(user_after) if user_after else None,
            "ud": users_done,
            "s": str(share_after) if share_after else None,
            "sd": shares_done,
            "g": guest_after,
            "gd": guests_done,
        },
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")


def _decode_ip_relations_cursor(
    value: str | None,
) -> tuple[UUID | None, bool, UUID | None, bool, str | None, bool]:
    if not value:
        return None, False, None, False, None, False
    try:
        padding = "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(value + padding))
        if not isinstance(payload, dict):
            raise ValueError
        user_after = UUID(payload["u"]) if payload.get("u") else None
        share_after = UUID(payload["s"]) if payload.get("s") else None
        guest_after = payload.get("g")
        if guest_after is not None and not isinstance(guest_after, str):
            raise ValueError
        return (
            user_after,
            payload.get("ud") is True,
            share_after,
            payload.get("sd") is True,
            guest_after,
            payload.get("gd") is True,
        )
    except (AttributeError, binascii.Error, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "IP 关联游标无效") from exc


def _unique_legacy_download_filter():
    access_event = aliased(ShareAccessEvent)
    duplicate_event = exists(
        select(access_event.id).where(
            access_event.share_id == DownloadLog.share_id,
            access_event.event_type == "link_issued",
            or_(
                and_(
                    DownloadLog.request_id.is_not(None),
                    access_event.request_id == DownloadLog.request_id,
                ),
                and_(
                    access_event.ip == DownloadLog.ip,
                    access_event.user_agent == DownloadLog.ua,
                    func.abs(
                        func.extract(
                            "epoch",
                            access_event.created_at - DownloadLog.downloaded_at,
                        )
                    )
                    <= 5,
                ),
            ),
        )
    )
    return ~duplicate_event


def _source_event(
    event_type: str,
    occurred_at: datetime,
    ip_value: object,
    *,
    user_agent: str | None = None,
    actor_label: str = "",
    event_id: UUID | None = None,
    client_kind: str = "unknown",
    confidence: str = "low",
    detector: str | None = None,
    request_id: str | None = None,
    http_status: int | None = None,
    request_time_ms: int | None = None,
) -> AdminSourceEvent | None:
    source = build_ip_source(ip_value)
    if source is None:
        return None
    return AdminSourceEvent(
        id=str(event_id) if event_id else "",
        event_type=event_type,
        occurred_at=occurred_at,
        source=source,
        user_agent=user_agent or "",
        actor_label=actor_label,
        client_kind=client_kind,
        confidence=confidence,
        detector=detector or "",
        request_id=request_id or "",
        http_status=http_status,
        request_time_ms=request_time_ms,
    )


@router.get("/shares/{code}/sources", response_model=AdminShareSourcesResponse)
async def get_share_sources(
    code: str,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(100, ge=1, le=200),
    after: str | None = Query(None, max_length=512),
    before: str | None = Query(None, max_length=512),
):
    if after and before:
        raise HTTPException(400, "after 与 before 不能同时使用")
    share = await db.scalar(select(Share).where(Share.code == code))
    if share is None:
        raise HTTPException(404, "分享不存在")
    owner = await db.scalar(select(User).where(User.id == share.owner_id)) if share.owner_id else None

    cursor = decode_created_cursor(after or before)
    access_stmt = select(ShareAccessEvent).where(ShareAccessEvent.share_id == share.id)
    if cursor:
        access_stmt = access_stmt.where(
            created_cursor_filter(
                ShareAccessEvent.created_at,
                ShareAccessEvent.id,
                cursor,
                after=bool(after),
            )
        )
    reverse_page = bool(before)
    access_stmt = access_stmt.order_by(
        ShareAccessEvent.created_at.asc() if reverse_page else ShareAccessEvent.created_at.desc(),
        ShareAccessEvent.id.asc() if reverse_page else ShareAccessEvent.id.desc(),
    ).limit(limit + 1)
    access_rows = await db.execute(access_stmt)
    access_events = access_rows.scalars().all()
    user_ids = {event.user_id for event in access_events if event.user_id}
    user_email_by_id: dict[UUID, str] = {}
    if user_ids:
        users = await db.execute(select(User).where(User.id.in_(user_ids)))
        user_email_by_id = {user.id: user.email for user in users.scalars()}

    events: list[AdminSourceEvent] = []
    for event in access_events:
        actor = user_email_by_id.get(event.user_id, "") if event.user_id else guest_label(event.guest_id)
        item = _source_event(
            event.event_type,
            event.created_at,
            event.ip,
            user_agent=event.user_agent,
            actor_label=actor,
            event_id=event.id,
            client_kind=event.client_kind,
            confidence=event.confidence,
            detector=event.detector,
            request_id=event.request_id,
            http_status=event.http_status,
            request_time_ms=event.request_time_ms,
        )
        if item:
            events.append(item)

    unique_legacy_download = _unique_legacy_download_filter()
    legacy_stmt = select(DownloadLog).where(
        DownloadLog.share_id == share.id,
        unique_legacy_download,
    )
    if cursor:
        legacy_stmt = legacy_stmt.where(
            created_cursor_filter(
                DownloadLog.downloaded_at,
                DownloadLog.id,
                cursor,
                after=bool(after),
            )
        )
    legacy_stmt = legacy_stmt.order_by(
        DownloadLog.downloaded_at.asc() if reverse_page else DownloadLog.downloaded_at.desc(),
        DownloadLog.id.asc() if reverse_page else DownloadLog.id.desc(),
    ).limit(limit + 1)
    legacy_rows = await db.execute(legacy_stmt)
    for legacy in legacy_rows.scalars():
        item = _source_event(
            "link_issued",
            legacy.downloaded_at,
            legacy.ip,
            user_agent=legacy.ua,
            event_id=legacy.id,
            client_kind="unknown",
            confidence="low",
            detector="legacy_download_log",
            request_id=legacy.request_id,
        )
        if item:
            events.append(item)

    events.sort(key=lambda item: (item.occurred_at, item.id), reverse=True)
    has_more = len(events) > limit
    events = events[:limit]
    if reverse_page:
        events.reverse()

    access_count = await db.scalar(
        select(func.count()).select_from(ShareAccessEvent).where(ShareAccessEvent.share_id == share.id)
    ) or 0
    download_count = await db.scalar(
        select(func.count()).select_from(DownloadLog).where(
            DownloadLog.share_id == share.id,
            unique_legacy_download,
        )
    ) or 0
    ip_union = union(
        select(cast(ShareAccessEvent.ip, String).label("ip")).where(
            ShareAccessEvent.share_id == share.id,
            ShareAccessEvent.ip.is_not(None),
        ),
        select(cast(DownloadLog.ip, String).label("ip")).where(
            DownloadLog.share_id == share.id,
            DownloadLog.ip.is_not(None),
            unique_legacy_download,
        ),
    ).subquery()
    unique_ip_count = await db.scalar(select(func.count()).select_from(ip_union)) or 0
    type_rows = await db.execute(
        select(ShareAccessEvent.event_type, func.count())
        .where(ShareAccessEvent.share_id == share.id)
        .group_by(ShareAccessEvent.event_type)
    )
    event_type_counts = {event_type: int(count) for event_type, count in type_rows.all()}
    event_type_counts["link_issued"] = event_type_counts.get("link_issued", 0) + int(download_count)
    identity_label = owner.email if owner else guest_label(share.guest_id) or "游客"
    return AdminShareSourcesResponse(
        code=share.code,
        identity_type="user" if owner else "guest",
        identity_label=identity_label,
        creation_source=build_ip_source(share.ip_created_from),
        created_at=share.created_at,
        event_count=int(access_count) + int(download_count),
        unique_ip_count=int(unique_ip_count),
        events=events,
        next_cursor=(
            encode_created_cursor(events[-1].occurred_at, UUID(events[-1].id))
            if events and has_more
            else None
        ),
        prev_cursor=(
            encode_created_cursor(events[0].occurred_at, UUID(events[0].id))
            if events and (after or before)
            else None
        ),
        has_more=has_more,
        event_type_counts=event_type_counts,
    )


@router.get("/users/{user_id}/sources", response_model=AdminUserSourcesResponse)
async def get_user_sources(
    user_id: UUID,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(100, ge=1, le=200),
    after: str | None = Query(None, max_length=512),
    before: str | None = Query(None, max_length=512),
):
    if after and before:
        raise HTTPException(400, "after 与 before 不能同时使用")
    user = await db.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(404, "用户不存在")

    cursor = decode_created_cursor(after or before)
    reverse_page = bool(before)
    auth_filters = [
        AuthEvent.user_id == user.id,
        AuthEvent.success.is_(True),
        AuthEvent.event_type.in_(["register_success", "login_success"]),
    ]
    auth_stmt = select(AuthEvent).where(*auth_filters)
    if cursor:
        auth_stmt = auth_stmt.where(
            created_cursor_filter(
                AuthEvent.created_at,
                AuthEvent.id,
                cursor,
                after=bool(after),
            )
        )
    auth_rows = await db.execute(
        auth_stmt.order_by(
            AuthEvent.created_at.asc() if reverse_page else AuthEvent.created_at.desc(),
            AuthEvent.id.asc() if reverse_page else AuthEvent.id.desc(),
        ).limit(limit + 1)
    )
    auth_events = auth_rows.scalars().all()
    events: list[AdminSourceEvent] = []
    registration_ip = await db.scalar(
        select(AuthEvent.ip)
        .where(
            AuthEvent.user_id == user.id,
            AuthEvent.success.is_(True),
            AuthEvent.event_type == "register_success",
        )
        .order_by(AuthEvent.created_at.asc(), AuthEvent.id.asc())
        .limit(1)
    )
    last_login_ip = await db.scalar(
        select(AuthEvent.ip)
        .where(
            AuthEvent.user_id == user.id,
            AuthEvent.success.is_(True),
            AuthEvent.event_type == "login_success",
        )
        .order_by(AuthEvent.created_at.desc(), AuthEvent.id.desc())
        .limit(1)
    )
    registration_source = build_ip_source(registration_ip)
    last_login_source = build_ip_source(last_login_ip)
    for event in auth_events:
        event_type = "register" if event.event_type == "register_success" else "login"
        item = _source_event(
            event_type,
            event.created_at,
            event.ip,
            user_agent=event.user_agent,
            actor_label=user.email,
            event_id=event.id,
            detector="auth_event",
            confidence="high",
        )
        if item is None:
            continue
        events.append(item)
    access_stmt = select(ShareAccessEvent).where(ShareAccessEvent.user_id == user.id)
    if cursor:
        access_stmt = access_stmt.where(
            created_cursor_filter(
                ShareAccessEvent.created_at,
                ShareAccessEvent.id,
                cursor,
                after=bool(after),
            )
        )
    access_rows = await db.execute(
        access_stmt.order_by(
            ShareAccessEvent.created_at.asc() if reverse_page else ShareAccessEvent.created_at.desc(),
            ShareAccessEvent.id.asc() if reverse_page else ShareAccessEvent.id.desc(),
        ).limit(limit + 1)
    )
    for event in access_rows.scalars():
        item = _source_event(
            event.event_type,
            event.created_at,
            event.ip,
            user_agent=event.user_agent,
            actor_label=user.email,
            event_id=event.id,
            client_kind=event.client_kind,
            confidence=event.confidence,
            detector=event.detector,
            request_id=event.request_id,
            http_status=event.http_status,
            request_time_ms=event.request_time_ms,
        )
        if item:
            events.append(item)

    now = datetime.now(UTC)
    session_filters = [
        AuthSession.user_id == user.id,
        AuthSession.revoked_at.is_(None),
        AuthSession.expires_at > now,
    ]
    session_stmt = select(AuthSession).where(*session_filters)
    if cursor:
        session_stmt = session_stmt.where(
            created_cursor_filter(
                func.coalesce(AuthSession.last_used_at, AuthSession.created_at),
                AuthSession.id,
                cursor,
                after=bool(after),
            )
        )
    session_rows = await db.execute(
        session_stmt.order_by(
            func.coalesce(AuthSession.last_used_at, AuthSession.created_at).asc()
            if reverse_page
            else func.coalesce(AuthSession.last_used_at, AuthSession.created_at).desc(),
            AuthSession.id.asc() if reverse_page else AuthSession.id.desc(),
        ).limit(limit + 1)
    )
    active_sessions = session_rows.scalars().all()
    for session in active_sessions:
        item = _source_event(
            "active_session",
            session.last_used_at or session.created_at,
            session.ip,
            user_agent=session.user_agent,
            actor_label=user.email,
            event_id=session.id,
            detector="active_auth_session",
            confidence="high",
        )
        if item:
            events.append(item)

    events.sort(key=lambda item: (item.occurred_at, item.id), reverse=True)
    has_more = len(events) > limit
    events = events[:limit]
    if reverse_page:
        events.reverse()
    auth_count = await db.scalar(select(func.count()).select_from(AuthEvent).where(*auth_filters)) or 0
    access_count = await db.scalar(
        select(func.count()).select_from(ShareAccessEvent).where(ShareAccessEvent.user_id == user.id)
    ) or 0
    active_session_count = await db.scalar(
        select(func.count()).select_from(AuthSession).where(*session_filters)
    ) or 0
    ip_union = union(
        select(AuthEvent.ip.label("ip")).where(*auth_filters, AuthEvent.ip.is_not(None)),
        select(AuthSession.ip.label("ip")).where(*session_filters, AuthSession.ip.is_not(None)),
        select(cast(ShareAccessEvent.ip, String).label("ip")).where(
            ShareAccessEvent.user_id == user.id,
            ShareAccessEvent.ip.is_not(None),
        ),
    ).subquery()
    unique_ip_count = await db.scalar(select(func.count()).select_from(ip_union)) or 0
    return AdminUserSourcesResponse(
        user_id=str(user.id),
        email=user.email,
        registration_source=registration_source,
        last_login_source=last_login_source,
        event_count=int(auth_count) + int(access_count) + int(active_session_count),
        unique_ip_count=int(unique_ip_count),
        active_session_count=int(active_session_count),
        events=events,
        next_cursor=(
            encode_created_cursor(events[-1].occurred_at, UUID(events[-1].id))
            if events and has_more
            else None
        ),
        prev_cursor=(
            encode_created_cursor(events[0].occurred_at, UUID(events[0].id))
            if events and (after or before)
            else None
        ),
        has_more=has_more,
    )


@router.get("/ip-relations", response_model=AdminIpRelationsResponse)
async def get_ip_relations(
    ip: str = Query(..., min_length=2, max_length=64),
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(100, ge=1, le=200),
    after: str | None = Query(None, max_length=1024),
):
    try:
        normalized_ip = ip_address(ip).compressed
    except ValueError as exc:
        raise HTTPException(400, "IP 地址无效") from exc

    user_after, users_done, share_after, shares_done, guest_after, guests_done = (
        _decode_ip_relations_cursor(after)
    )
    inet_ip = cast(normalized_ip, INET)

    relation_user_ids: list[UUID] = []
    users_has_more = False
    if not users_done:
        user_union = union(
            select(AuthEvent.user_id.label("id")).where(
                AuthEvent.ip == normalized_ip,
                AuthEvent.user_id.is_not(None),
            ),
            select(AuthSession.user_id.label("id")).where(AuthSession.ip == normalized_ip),
            select(ShareAccessEvent.user_id.label("id")).where(
                ShareAccessEvent.ip == inet_ip,
                ShareAccessEvent.user_id.is_not(None),
            ),
        ).subquery()
        user_page_stmt = select(user_union.c.id)
        if user_after:
            user_page_stmt = user_page_stmt.where(user_union.c.id > user_after)
        user_page = list(
            (
                await db.scalars(
                    user_page_stmt.order_by(user_union.c.id).limit(limit + 1)
                )
            ).all()
        )
        users_has_more = len(user_page) > limit
        relation_user_ids = user_page[:limit]

    user_relations: dict[UUID, set[str]] = {user_id: set() for user_id in relation_user_ids}
    if relation_user_ids:
        for user_id in await db.scalars(
            select(AuthEvent.user_id).where(
                AuthEvent.ip == normalized_ip,
                AuthEvent.user_id.in_(relation_user_ids),
            ).distinct()
        ):
            user_relations[user_id].add("认证记录")
        for user_id in await db.scalars(
            select(AuthSession.user_id).where(
                AuthSession.ip == normalized_ip,
                AuthSession.user_id.in_(relation_user_ids),
            ).distinct()
        ):
            user_relations[user_id].add("登录会话")
        for user_id in await db.scalars(
            select(ShareAccessEvent.user_id).where(
                ShareAccessEvent.ip == inet_ip,
                ShareAccessEvent.user_id.in_(relation_user_ids),
            ).distinct()
        ):
            user_relations[user_id].add("分享访问")

    users: list[AdminIpRelatedUser] = []
    if relation_user_ids:
        user_rows = await db.execute(
            select(User).where(User.id.in_(relation_user_ids)).order_by(User.id)
        )
        users = [
            AdminIpRelatedUser(id=str(user.id), email=user.email, relation_types=sorted(user_relations[user.id]))
            for user in user_rows.scalars()
        ]

    relation_share_ids: list[UUID] = []
    shares_has_more = False
    if not shares_done:
        share_union = union(
            select(Share.id.label("id")).where(Share.ip_created_from == inet_ip),
            select(ShareAccessEvent.share_id.label("id")).where(ShareAccessEvent.ip == inet_ip),
            select(DownloadLog.share_id.label("id")).where(
                DownloadLog.ip == inet_ip,
                _unique_legacy_download_filter(),
            ),
        ).subquery()
        share_page_stmt = select(share_union.c.id)
        if share_after:
            share_page_stmt = share_page_stmt.where(share_union.c.id > share_after)
        share_page = list(
            (
                await db.scalars(
                    share_page_stmt.order_by(share_union.c.id).limit(limit + 1)
                )
            ).all()
        )
        shares_has_more = len(share_page) > limit
        relation_share_ids = share_page[:limit]

    share_relations: dict[UUID, set[str]] = {share_id: set() for share_id in relation_share_ids}
    if relation_share_ids:
        for share_id in await db.scalars(
            select(Share.id).where(
                Share.ip_created_from == inet_ip,
                Share.id.in_(relation_share_ids),
            )
        ):
            share_relations[share_id].add("创建分享")
        for share_id in await db.scalars(
            select(ShareAccessEvent.share_id).where(
                ShareAccessEvent.ip == inet_ip,
                ShareAccessEvent.share_id.in_(relation_share_ids),
            ).distinct()
        ):
            share_relations[share_id].add("访问分享")
        for share_id in await db.scalars(
            select(DownloadLog.share_id).where(
                DownloadLog.ip == inet_ip,
                DownloadLog.share_id.in_(relation_share_ids),
                _unique_legacy_download_filter(),
            ).distinct()
        ):
            share_relations[share_id].add("获取链接")

    shares: list[AdminIpRelatedShare] = []
    if relation_share_ids:
        share_rows = await db.execute(
            select(Share).where(Share.id.in_(relation_share_ids)).order_by(Share.id)
        )
        related_shares = share_rows.scalars().all()
        owner_ids = {share.owner_id for share in related_shares if share.owner_id}
        owner_email_by_id: dict[UUID, str] = {}
        if owner_ids:
            owner_rows = await db.execute(select(User).where(User.id.in_(owner_ids)))
            owner_email_by_id = {user.id: user.email for user in owner_rows.scalars()}
        for share in related_shares:
            shares.append(AdminIpRelatedShare(
                code=share.code,
                owner_email=owner_email_by_id.get(share.owner_id),
                relation_types=sorted(share_relations[share.id]),
            ))

    relation_guest_ids: list[str] = []
    guests_has_more = False
    if not guests_done:
        guest_union = union(
            select(Share.guest_id.label("id")).where(
                Share.ip_created_from == inet_ip,
                Share.owner_id.is_(None),
                Share.guest_id.is_not(None),
            ),
            select(ShareAccessEvent.guest_id.label("id")).where(
                ShareAccessEvent.ip == inet_ip,
                ShareAccessEvent.guest_id.is_not(None),
            ),
        ).subquery()
        guest_page_stmt = select(guest_union.c.id)
        if guest_after:
            guest_page_stmt = guest_page_stmt.where(guest_union.c.id > guest_after)
        guest_page = list(
            (
                await db.scalars(
                    guest_page_stmt.order_by(guest_union.c.id).limit(limit + 1)
                )
            ).all()
        )
        guests_has_more = len(guest_page) > limit
        relation_guest_ids = guest_page[:limit]

    has_more = users_has_more or shares_has_more or guests_has_more
    next_cursor = None
    if has_more:
        next_cursor = _encode_ip_relations_cursor(
            user_after=relation_user_ids[-1] if relation_user_ids else user_after,
            users_done=users_done or not users_has_more,
            share_after=relation_share_ids[-1] if relation_share_ids else share_after,
            shares_done=shares_done or not shares_has_more,
            guest_after=relation_guest_ids[-1] if relation_guest_ids else guest_after,
            guests_done=guests_done or not guests_has_more,
        )
    return AdminIpRelationsResponse(
        source=build_ip_source(normalized_ip),
        users=users,
        shares=shares,
        guest_labels=[guest_label(value) for value in relation_guest_ids],
        next_cursor=next_cursor,
        has_more=has_more,
        truncated_reason="达到关联结果上限" if has_more else None,
    )
