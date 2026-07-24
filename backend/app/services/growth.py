"""增长事件、推荐资格与留存券服务。"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session_factory
from app.models.growth import (
    GrowthLandingEvent,
    ReferralAttribution,
    RetentionCoupon,
    ViralClickEvent,
)
from app.models.share import Share, ShareAccessEvent
from app.models.user import User

log = logging.getLogger(__name__)

REFERRAL_FIRST_SHARE_WINDOW = timedelta(days=7)
REFERRAL_ENGAGEMENT_WINDOW = timedelta(days=7)
REFERRAL_ROLLING_WINDOW = timedelta(days=30)
REFERRAL_ROLLING_LIMIT = 5
COUPON_AVAILABLE_LIMIT = 3
COUPON_TARGET_TTL = timedelta(days=90)
COUPON_EXPIRY = timedelta(days=180)
GROWTH_PERSONAL_DATA_RETENTION = timedelta(days=180)


class GrowthServiceError(Exception):
    """增长域错误，由 API 层映射为 HTTP 状态。"""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


async def record_viral_click(
    db: AsyncSession,
    *,
    share_code: str,
    request_id: str,
    visitor_id: str | None,
    guest_id: str,
    ip: str,
    user_agent: str,
    utm_source: str | None = None,
    utm_medium: str | None = None,
    utm_campaign: str | None = None,
    utm_term: str | None = None,
    utm_content: str | None = None,
    referrer: str | None = None,
    now: datetime | None = None,
) -> bool:
    """记录任意现存分享的 CTA 点击，重复请求 ID 返回 False。"""

    normalized_code = share_code.strip()
    share = await db.scalar(select(Share).where(Share.code == normalized_code))
    if not share:
        raise GrowthServiceError("share_not_found", "分享不存在")

    inserted_id = await db.scalar(
        pg_insert(ViralClickEvent)
        .values(
            share_id=share.id,
            share_code=share.code,
            request_id=request_id.strip(),
            visitor_id=visitor_id,
            guest_id=guest_id,
            ip=ip,
            user_agent=user_agent[:512] or None,
            utm_source=utm_source,
            utm_medium=utm_medium,
            utm_campaign=utm_campaign,
            utm_term=utm_term,
            utm_content=utm_content,
            referrer=referrer,
            created_at=now or datetime.now(UTC),
        )
        .on_conflict_do_nothing(constraint="uq_viral_click_events_share_request")
        .returning(ViralClickEvent.id)
    )
    return inserted_id is not None


async def record_landing_event(
    db: AsyncSession,
    *,
    request_id: str,
    visitor_id: str,
    guest_id: str,
    ip: str,
    user_agent: str,
    landing_path: str,
    utm_source: str | None = None,
    utm_medium: str | None = None,
    utm_campaign: str | None = None,
    utm_term: str | None = None,
    utm_content: str | None = None,
    referrer: str | None = None,
    now: datetime | None = None,
) -> bool:
    """幂等记录第一方落地事件。"""

    inserted_id = await db.scalar(
        pg_insert(GrowthLandingEvent)
        .values(
            request_id=request_id.strip(),
            visitor_id=visitor_id,
            guest_id=guest_id,
            ip=ip,
            user_agent=user_agent[:512] or None,
            landing_path=landing_path,
            utm_source=utm_source,
            utm_medium=utm_medium,
            utm_campaign=utm_campaign,
            utm_term=utm_term,
            utm_content=utm_content,
            referrer=referrer,
            created_at=now or datetime.now(UTC),
        )
        .on_conflict_do_nothing(
            constraint="uq_growth_landing_events_visitor_request"
        )
        .returning(GrowthLandingEvent.id)
    )
    return inserted_id is not None


async def create_referral_attribution(
    db: AsyncSession,
    *,
    referred_user: User,
    referral_share_code: str | None,
    registration_guest_id: str,
) -> ReferralAttribution | None:
    """注册事务内建立一次性分享推荐归因；无有效 owner 时静默忽略。"""

    normalized_code = (referral_share_code or "").strip()
    if not normalized_code:
        return None

    existing = await db.scalar(
        select(ReferralAttribution).where(
            ReferralAttribution.referred_user_id == referred_user.id
        )
    )
    if existing:
        return existing

    source = await db.execute(
        select(Share, User)
        .join(User, User.id == Share.owner_id)
        .where(
            Share.code == normalized_code,
            User.email_verified_at.is_not(None),
        )
    )
    row = source.one_or_none()
    if not row:
        return None
    source_share, referrer = row
    if referrer.id == referred_user.id:
        return None

    attribution = ReferralAttribution(
        referrer_user_id=referrer.id,
        referred_user_id=referred_user.id,
        source_share_id=source_share.id,
        source_share_code=source_share.code,
        registration_guest_id=registration_guest_id,
        status="pending",
    )
    db.add(attribution)
    await db.flush()
    return attribution


async def _first_share_for_user(
    db: AsyncSession,
    user_id: uuid.UUID,
) -> Share | None:
    return await db.scalar(
        select(Share)
        .where(Share.owner_id == user_id)
        .order_by(Share.created_at, Share.id)
        .limit(1)
    )


def _close_attribution(
    attribution: ReferralAttribution,
    *,
    status: str,
    reason: str,
    now: datetime,
) -> None:
    attribution.status = status
    attribution.status_reason = reason
    attribution.closed_at = now


async def _refresh_pending_attribution(
    db: AsyncSession,
    attribution: ReferralAttribution,
    *,
    now: datetime,
    close_engagement_expired: bool = True,
) -> Share | None:
    first_share = await _first_share_for_user(db, attribution.referred_user_id)
    if first_share:
        attribution.first_share_id = first_share.id
        registration_deadline = attribution.created_at + REFERRAL_FIRST_SHARE_WINDOW
        if first_share.created_at < attribution.created_at:
            _close_attribution(
                attribution,
                status="rejected",
                reason="share_before_attribution",
                now=now,
            )
        elif first_share.created_at > registration_deadline:
            _close_attribution(
                attribution,
                status="expired",
                reason="first_share_too_late",
                now=now,
            )
        elif (
            close_engagement_expired
            and now > first_share.created_at + REFERRAL_ENGAGEMENT_WINDOW
        ):
            _close_attribution(
                attribution,
                status="expired",
                reason="engagement_window_expired",
                now=now,
            )
    elif now > attribution.created_at + REFERRAL_FIRST_SHARE_WINDOW:
        _close_attribution(
            attribution,
            status="expired",
            reason="first_share_missing",
            now=now,
        )
    return first_share


async def _find_qualifying_sequence(
    db: AsyncSession,
    *,
    attribution: ReferralAttribution,
    share: Share,
) -> tuple[ShareAccessEvent, ShareAccessEvent] | None:
    deadline = share.created_at + REFERRAL_ENGAGEMENT_WINDOW
    events = list(
        (
            await db.scalars(
                select(ShareAccessEvent)
                .where(
                    ShareAccessEvent.share_id == share.id,
                    ShareAccessEvent.event_type.in_(
                        ["human_interaction", "link_issued"]
                    ),
                    ShareAccessEvent.created_at >= share.created_at,
                    ShareAccessEvent.created_at <= deadline,
                )
                .order_by(ShareAccessEvent.created_at, ShareAccessEvent.id)
            )
        ).all()
    )
    actor_user_ids = {event.user_id for event in events if event.user_id}
    actor_users: dict[uuid.UUID, User] = {}
    if actor_user_ids:
        actor_users = {
            user.id: user
            for user in (
                await db.scalars(select(User).where(User.id.in_(actor_user_ids)))
            ).all()
        }

    def identity(event: ShareAccessEvent) -> tuple[str, str] | None:
        if event.user_id:
            actor = actor_users.get(event.user_id)
            if (
                not actor
                or actor.is_admin
                or actor.id
                in {attribution.referrer_user_id, attribution.referred_user_id}
            ):
                return None
            return "user", str(actor.id)
        if (
            not event.guest_id
            or not event.guest_id.startswith("visitor:")
            or event.guest_id == attribution.registration_guest_id
        ):
            return None
        return "guest", event.guest_id

    human_events: dict[tuple[str, str], ShareAccessEvent] = {}
    for event in events:
        actor_identity = identity(event)
        if not actor_identity:
            continue
        if event.event_type == "human_interaction":
            human_events.setdefault(actor_identity, event)
            continue
        human_event = human_events.get(actor_identity)
        if human_event and human_event.created_at < event.created_at:
            return human_event, event
    return None


async def _lock_participants(
    db: AsyncSession,
    attribution: ReferralAttribution,
) -> dict[uuid.UUID, User]:
    participant_ids = sorted(
        [attribution.referrer_user_id, attribution.referred_user_id],
        key=str,
    )
    users = (
        await db.scalars(
            select(User)
            .where(User.id.in_(participant_ids))
            .order_by(User.id)
            .with_for_update()
        )
    ).all()
    return {user.id: user for user in users}


async def _expire_available_coupons(
    db: AsyncSession,
    *,
    owner_id: uuid.UUID,
    now: datetime,
) -> None:
    await db.execute(
        update(RetentionCoupon)
        .where(
            RetentionCoupon.owner_id == owner_id,
            RetentionCoupon.status == "available",
            RetentionCoupon.expires_at <= now,
        )
        .values(status="expired", status_reason="expired")
    )


async def _issue_coupon_attempt(
    db: AsyncSession,
    *,
    attribution: ReferralAttribution,
    owner_id: uuid.UUID,
    beneficiary_role: str,
    now: datetime,
) -> RetentionCoupon:
    await _expire_available_coupons(db, owner_id=owner_id, now=now)
    available_count = await db.scalar(
        select(func.count())
        .select_from(RetentionCoupon)
        .where(
            RetentionCoupon.owner_id == owner_id,
            RetentionCoupon.status == "available",
            RetentionCoupon.expires_at > now,
        )
    )
    if (available_count or 0) >= COUPON_AVAILABLE_LIMIT:
        coupon = RetentionCoupon(
            owner_id=owner_id,
            referral_attribution_id=attribution.id,
            beneficiary_role=beneficiary_role,
            status="skipped",
            status_reason="available_limit",
            skipped_at=now,
        )
    else:
        coupon = RetentionCoupon(
            owner_id=owner_id,
            referral_attribution_id=attribution.id,
            beneficiary_role=beneficiary_role,
            status="available",
            target_ttl_days=int(COUPON_TARGET_TTL.days),
            issued_at=now,
            expires_at=now + COUPON_EXPIRY,
        )
    db.add(coupon)
    return coupon


async def evaluate_referral_qualification(
    db: AsyncSession,
    share_id: uuid.UUID,
    *,
    now: datetime | None = None,
) -> bool:
    """在调用方事务中幂等判定指定分享是否完成邀请资格。"""

    checked_at = now or datetime.now(UTC)
    share = await db.scalar(select(Share).where(Share.id == share_id))
    if not share or not share.owner_id:
        return False

    attribution = await db.scalar(
        select(ReferralAttribution)
        .where(ReferralAttribution.referred_user_id == share.owner_id)
        .with_for_update()
    )
    if not attribution or attribution.status != "pending":
        return False

    first_share = await _refresh_pending_attribution(
        db,
        attribution,
        now=checked_at,
        close_engagement_expired=False,
    )
    if attribution.status != "pending" or not first_share or first_share.id != share.id:
        return False

    sequence = await _find_qualifying_sequence(
        db,
        attribution=attribution,
        share=share,
    )
    if not sequence:
        if checked_at > share.created_at + REFERRAL_ENGAGEMENT_WINDOW:
            _close_attribution(
                attribution,
                status="expired",
                reason="engagement_window_expired",
                now=checked_at,
            )
        return False
    human_event, link_event = sequence

    participants = await _lock_participants(db, attribution)
    if len(participants) != 2 or any(user.is_admin for user in participants.values()):
        _close_attribution(
            attribution,
            status="rejected",
            reason="admin_or_missing_participant",
            now=checked_at,
        )
        return False

    qualified_count = await db.scalar(
        select(func.count())
        .select_from(ReferralAttribution)
        .where(
            ReferralAttribution.referrer_user_id == attribution.referrer_user_id,
            ReferralAttribution.status == "qualified",
            ReferralAttribution.qualified_at
            >= checked_at - REFERRAL_ROLLING_WINDOW,
        )
    )
    if (qualified_count or 0) >= REFERRAL_ROLLING_LIMIT:
        _close_attribution(
            attribution,
            status="rejected",
            reason="referrer_rolling_limit",
            now=checked_at,
        )
        return False

    attribution.status = "qualified"
    attribution.status_reason = "third_party_engagement"
    attribution.human_interaction_event_id = human_event.id
    attribution.link_issued_event_id = link_event.id
    attribution.qualified_at = checked_at
    attribution.closed_at = checked_at
    attribution.qualifying_user_id = link_event.user_id
    attribution.qualifying_guest_id = (
        None if link_event.user_id else link_event.guest_id
    )

    await _issue_coupon_attempt(
        db,
        attribution=attribution,
        owner_id=attribution.referrer_user_id,
        beneficiary_role="referrer",
        now=checked_at,
    )
    await _issue_coupon_attempt(
        db,
        attribution=attribution,
        owner_id=attribution.referred_user_id,
        beneficiary_role="referred",
        now=checked_at,
    )
    await db.flush()
    return True


async def trigger_referral_qualification(share_id: uuid.UUID) -> bool:
    """在 link_issued 落库后独立触发资格判定，失败不影响取链。"""

    try:
        factory = get_session_factory()
        async with factory() as db:
            qualified = await evaluate_referral_qualification(db, share_id)
            await db.commit()
            return qualified
    except Exception:
        log.warning(
            "failed to evaluate referral qualification for share %s",
            share_id,
            exc_info=True,
        )
        return False


async def consume_retention_coupon(
    db: AsyncSession,
    *,
    coupon_id: uuid.UUID,
    owner_id: uuid.UUID,
    share_id: uuid.UUID,
    now: datetime | None = None,
) -> RetentionCoupon:
    """事务内锁定并消费券；调用方回滚时消费状态一并回滚。"""

    consumed_at = now or datetime.now(UTC)
    coupon = await db.scalar(
        select(RetentionCoupon)
        .where(RetentionCoupon.id == coupon_id)
        .with_for_update()
    )
    if not coupon or coupon.owner_id != owner_id:
        raise GrowthServiceError("coupon_not_found", "留存券不存在")
    if coupon.status != "available":
        raise GrowthServiceError("coupon_unavailable", "留存券不可用或已被消费")
    if not coupon.expires_at or coupon.expires_at <= consumed_at:
        raise GrowthServiceError("coupon_expired", "留存券已过期")

    coupon.status = "consumed"
    coupon.status_reason = "share_created"
    coupon.consumed_at = consumed_at
    coupon.consumed_by_share_id = share_id
    return coupon


async def assert_coupon_consumed_by_share(
    db: AsyncSession,
    *,
    coupon_id: uuid.UUID,
    owner_id: uuid.UUID,
    share_id: uuid.UUID,
) -> None:
    coupon = await db.scalar(
        select(RetentionCoupon).where(
            RetentionCoupon.id == coupon_id,
            RetentionCoupon.owner_id == owner_id,
        )
    )
    if not coupon:
        raise GrowthServiceError("coupon_not_found", "留存券不存在")
    if coupon.status != "consumed" or coupon.consumed_by_share_id != share_id:
        raise GrowthServiceError("coupon_mismatch", "留存券与幂等分享不匹配")


async def get_growth_summary(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    now: datetime | None = None,
) -> dict:
    """返回可用券及当前用户发出的邀请统计，并刷新过期状态。"""

    checked_at = now or datetime.now(UTC)
    pending_attributions = list(
        (
            await db.scalars(
                select(ReferralAttribution)
                .where(
                    ReferralAttribution.referrer_user_id == user_id,
                    ReferralAttribution.status == "pending",
                )
                .with_for_update()
            )
        ).all()
    )
    for attribution in pending_attributions:
        await _refresh_pending_attribution(db, attribution, now=checked_at)

    await _expire_available_coupons(db, owner_id=user_id, now=checked_at)
    coupons = list(
        (
            await db.scalars(
                select(RetentionCoupon)
                .where(
                    RetentionCoupon.owner_id == user_id,
                    RetentionCoupon.status == "available",
                    RetentionCoupon.expires_at > checked_at,
                )
                .order_by(RetentionCoupon.expires_at, RetentionCoupon.id)
            )
        ).all()
    )
    pending_count = await db.scalar(
        select(func.count())
        .select_from(ReferralAttribution)
        .where(
            ReferralAttribution.referrer_user_id == user_id,
            ReferralAttribution.status == "pending",
        )
    )
    qualified_count = await db.scalar(
        select(func.count())
        .select_from(ReferralAttribution)
        .where(
            ReferralAttribution.referrer_user_id == user_id,
            ReferralAttribution.status == "qualified",
        )
    )
    return {
        "available_coupons": coupons,
        "pending": pending_count or 0,
        "qualified": qualified_count or 0,
    }


async def scrub_growth_personal_data(
    db: AsyncSession,
    *,
    now: datetime | None = None,
) -> tuple[int, int]:
    """清空超过 180 天增长事件的 IP/UA，保留非个人归因审计。"""

    cleared_at = now or datetime.now(UTC)
    cutoff = cleared_at - GROWTH_PERSONAL_DATA_RETENTION
    viral_result = await db.execute(
        update(ViralClickEvent)
        .where(
            ViralClickEvent.created_at < cutoff,
            ViralClickEvent.personal_data_cleared_at.is_(None),
        )
        .values(
            ip=None,
            user_agent=None,
            personal_data_cleared_at=cleared_at,
        )
    )
    landing_result = await db.execute(
        update(GrowthLandingEvent)
        .where(
            GrowthLandingEvent.created_at < cutoff,
            GrowthLandingEvent.personal_data_cleared_at.is_(None),
        )
        .values(
            ip=None,
            user_agent=None,
            personal_data_cleared_at=cleared_at,
        )
    )
    return viral_result.rowcount or 0, landing_result.rowcount or 0
