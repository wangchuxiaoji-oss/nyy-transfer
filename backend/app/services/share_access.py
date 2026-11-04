"""分享访问事件记录与保留期清理。"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from urllib.parse import urlparse
from uuid import UUID

from fastapi import Request
from sqlalchemy import cast, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError

from app.core.config import get_settings
from app.db.session import get_session_factory
from app.models.auth import AuthEvent, AuthSession
from app.models.share import (
    DownloadLog,
    DownloadSession,
    Share,
    ShareAccessEvent,
    ShareEventIdempotencyKey,
)
from app.models.system import AuditLog, Report
from app.utils.client_ip import get_client_ip, get_guest_id

log = logging.getLogger(__name__)
_cleanup_task: asyncio.Task[None] | None = None
_CLEANUP_LOCK_KEY = 0x4E5959434C4541
_KNOWN_PREVIEW_UAS = (
    "qqurlrichservice",
    "telegrambot",
    "discordbot",
    "slackbot",
    "facebookexternalhit",
    "twitterbot",
    "linkedinbot",
)


def guest_label(guest_id: str | None) -> str:
    if not guest_id:
        return ""
    digest = hashlib.sha256(guest_id.encode("utf-8")).hexdigest()[:8].upper()
    return f"访客 #{digest}"


def _referer_host(request: Request) -> str | None:
    referer = request.headers.get("referer") or ""
    if not referer:
        return None
    try:
        return (urlparse(referer).hostname or "")[:255] or None
    except ValueError:
        return None


async def record_share_access(
    share_id: UUID,
    event_type: str,
    request: Request,
    *,
    user_id: UUID | None = None,
    request_id: str | None = None,
    client_kind: str | None = None,
    confidence: str | None = None,
    detector: str | None = None,
    http_status: int | None = None,
    request_time_ms: int | None = None,
    trusted_visitor_id: str | None = None,
) -> bool:
    """独立事务记录访问事件，失败不影响主请求。"""

    try:
        now = datetime.now(UTC)
        client_ip = get_client_ip(request)
        user_agent = (request.headers.get("user-agent") or "")[:512]
        if user_id:
            guest_id = None
        elif event_type in {"human_interaction", "link_issued"}:
            guest_id = trusted_visitor_id
        else:
            guest_id = trusted_visitor_id or get_guest_id(request, client_ip)
        request_id = (request_id or request.headers.get("x-request-id") or "").strip()[:128] or None
        detected_kind, detected_confidence, detected_rule = classify_share_client(
            event_type,
            user_agent,
        )
        factory = get_session_factory()
        async with factory() as db:
            if request_id:
                inserted_key = await db.scalar(
                    pg_insert(ShareEventIdempotencyKey)
                    .values(
                        share_id=share_id,
                        event_type=event_type,
                        request_id=request_id,
                        created_at=now,
                    )
                    .on_conflict_do_nothing(constraint="uq_share_event_idempotency")
                    .returning(ShareEventIdempotencyKey.id)
                )
                if inserted_key is None:
                    return False
            elif event_type in {"view", "page_rendered"}:
                cutoff = now - timedelta(minutes=max(1, get_settings().share_view_dedupe_minutes))
                identity_filter = (
                    ShareAccessEvent.user_id == user_id
                    if user_id
                    else ShareAccessEvent.guest_id == guest_id
                )
                duplicate = await db.scalar(
                    select(ShareAccessEvent.id).where(
                        ShareAccessEvent.share_id == share_id,
                        ShareAccessEvent.event_type.in_(["view", "page_rendered"]),
                        identity_filter,
                        ShareAccessEvent.ip == cast(client_ip, INET),
                        ShareAccessEvent.user_agent == user_agent,
                        ShareAccessEvent.created_at >= cutoff,
                    ).limit(1)
                )
                if duplicate:
                    return False
            db.add(ShareAccessEvent(
                share_id=share_id,
                user_id=user_id,
                event_type=event_type,
                ip=client_ip,
                user_agent=user_agent,
                guest_id=guest_id,
                referer_host=_referer_host(request),
                client_kind=client_kind or detected_kind,
                confidence=confidence or detected_confidence,
                detector=detector or detected_rule,
                request_id=request_id,
                http_status=http_status,
                request_time_ms=request_time_ms,
                created_at=now,
            ))
            if event_type != "admin_review":
                await db.execute(
                    update(Share)
                    .where(Share.id == share_id)
                    .values(last_activity_at=now)
                )
            try:
                await db.commit()
            except IntegrityError:
                await db.rollback()
                return False
            return True
    except Exception:
        log.warning("failed to record share access event", exc_info=True)
        return False


def classify_share_client(event_type: str, user_agent: str) -> tuple[str, str, str]:
    """按事件强度和 UA 弱信号分类，T7/微信不会单独判为机器人。"""

    lowered = user_agent.lower()
    if event_type == "admin_review":
        return "admin", "high", "admin_authenticated"
    if event_type in {"human_interaction", "link_issued"}:
        return "human", "high", event_type
    for marker in _KNOWN_PREVIEW_UAS:
        if marker in lowered:
            detector = "qq_preview" if marker == "qqurlrichservice" else f"known_preview:{marker}"
            return "preview_bot", "high", detector
    if "t7/" in lowered or "micromessenger" in lowered:
        return "unknown", "low", "weak_embedded_browser_ua"
    if event_type == "preview_fetch":
        return "suspected_preview", "medium", "preview_fetch"
    if event_type == "page_rendered":
        return "unknown", "medium", "js_page_rendered"
    return "unknown", "low", "legacy_or_unclassified"


async def cleanup_ip_history() -> None:
    now = datetime.now(UTC)
    cutoff = now - timedelta(days=max(1, get_settings().share_access_retention_days))
    factory = get_session_factory()
    async with factory() as db:
        lock_acquired = await db.scalar(select(func.pg_try_advisory_xact_lock(_CLEANUP_LOCK_KEY)))
        if not lock_acquired:
            return
        await db.execute(delete(ShareAccessEvent).where(ShareAccessEvent.created_at < cutoff))
        await db.execute(delete(DownloadLog).where(DownloadLog.downloaded_at < cutoff))
        await db.execute(delete(DownloadSession).where(DownloadSession.expires_at < now))
        await db.execute(
            delete(ShareEventIdempotencyKey).where(
                ShareEventIdempotencyKey.created_at < cutoff
            )
        )
        await db.execute(
            update(AuthEvent)
            .where(
                AuthEvent.created_at < cutoff,
                or_(AuthEvent.ip.is_not(None), AuthEvent.user_agent.is_not(None)),
            )
            .values(ip=None, user_agent=None)
        )
        await db.execute(
            update(AuthSession)
            .where(
                AuthSession.created_at < cutoff,
                or_(AuthSession.ip.is_not(None), AuthSession.user_agent.is_not(None)),
            )
            .values(ip=None, user_agent=None)
        )
        await db.execute(
            update(AuditLog)
            .where(
                AuditLog.created_at < cutoff,
                or_(AuditLog.ip.is_not(None), AuditLog.user_agent.is_not(None)),
            )
            .values(ip=None, user_agent=None)
        )
        await db.execute(
            update(Report)
            .where(Report.created_at < cutoff, Report.reporter_ip.is_not(None))
            .values(reporter_ip=None)
        )
        await db.commit()


async def _cleanup_loop() -> None:
    while True:
        try:
            await cleanup_ip_history()
        except Exception:
            log.warning("failed to clean IP history", exc_info=True)
        await asyncio.sleep(24 * 60 * 60)


def start_share_access_cleanup() -> None:
    global _cleanup_task
    if _cleanup_task is None or _cleanup_task.done():
        _cleanup_task = asyncio.create_task(_cleanup_loop(), name="share-access-cleanup")


async def stop_share_access_cleanup() -> None:
    global _cleanup_task
    if _cleanup_task is None:
        return
    _cleanup_task.cancel()
    with suppress(asyncio.CancelledError):
        await _cleanup_task
    _cleanup_task = None
