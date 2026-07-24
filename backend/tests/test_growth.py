"""增长推荐、第一方归因和留存券测试。"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.api.v1.growth import router as growth_router
from app.main import create_app
from app.models.growth import (
    GrowthLandingEvent,
    ReferralAttribution,
    RetentionCoupon,
    ViralClickEvent,
)
from app.models.share import Share, ShareAccessEvent
from app.models.user import User
from app.services.auth import create_access_token, hash_password
from app.services.doubao_client import CommitResult
from app.services.growth import (
    consume_retention_coupon,
    create_referral_attribution,
    evaluate_referral_qualification,
    scrub_growth_personal_data,
    trigger_referral_qualification,
)
from app.services.visitor_identity import (
    INTERACTION_RATE_LIMIT,
    LANDING_RATE_LIMIT,
    public_event_rate_limit_key,
)


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
def app(redis):
    application = create_app()
    application.include_router(growth_router, prefix="/api/v1")
    application.state.redis = redis
    return application


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client


async def _create_user(
    email: str,
    *,
    verified: bool = True,
    is_admin: bool = False,
) -> User:
    from app.db.session import get_session_factory

    user = User(
        email=email,
        password_hash=hash_password("Str0ngP@ss!"),
        email_verified_at=datetime.now(UTC) if verified else None,
        is_admin=is_admin,
    )
    async with get_session_factory()() as db:
        db.add(user)
        await db.commit()
    return user


async def _create_share(
    code: str,
    *,
    owner_id: uuid.UUID | None = None,
    guest_id: str | None = None,
    created_at: datetime | None = None,
) -> Share:
    from app.db.session import get_session_factory

    share = Share(
        code=code,
        owner_id=owner_id,
        guest_id=guest_id,
        ip_created_from="127.0.0.1",
        total_bytes=0,
        empty_dirs=["empty/"],
        created_at=created_at or datetime.now(UTC),
    )
    async with get_session_factory()() as db:
        db.add(share)
        await db.commit()
    return share


async def _create_referral_scenario(
    *,
    registration_guest_id: str = "visitor:registration-guest",
    attribution_created_at: datetime | None = None,
    first_share_created_at: datetime | None = None,
) -> tuple[User, User, ReferralAttribution, Share]:
    from app.db.session import get_session_factory

    now = datetime.now(UTC)
    attributed_at = attribution_created_at or now - timedelta(hours=2)
    referrer = await _create_user(f"referrer-{uuid.uuid4().hex}@example.com")
    referred = await _create_user(f"referred-{uuid.uuid4().hex}@example.com")
    source_share = await _create_share(
        f"src{uuid.uuid4().hex[:8]}",
        owner_id=referrer.id,
        created_at=attributed_at - timedelta(hours=1),
    )
    first_share = await _create_share(
        f"new{uuid.uuid4().hex[:8]}",
        owner_id=referred.id,
        created_at=first_share_created_at or attributed_at + timedelta(hours=1),
    )
    attribution = ReferralAttribution(
        referrer_user_id=referrer.id,
        referred_user_id=referred.id,
        source_share_id=source_share.id,
        source_share_code=source_share.code,
        registration_guest_id=registration_guest_id,
        status="pending",
        created_at=attributed_at,
    )
    async with get_session_factory()() as db:
        db.add(attribution)
        await db.commit()
    return referrer, referred, attribution, first_share


async def _add_access_sequence(
    share_id: uuid.UUID,
    *,
    guest_id: str | None = None,
    user_id: uuid.UUID | None = None,
    human_at: datetime | None = None,
    link_at: datetime | None = None,
) -> None:
    from app.db.session import get_session_factory

    now = datetime.now(UTC)
    if guest_id and not guest_id.startswith("visitor:"):
        guest_id = f"visitor:{guest_id}"
    async with get_session_factory()() as db:
        db.add_all(
            [
                ShareAccessEvent(
                    share_id=share_id,
                    user_id=user_id,
                    event_type="human_interaction",
                    ip="127.0.0.1",
                    user_agent="growth-test",
                    guest_id=guest_id,
                    client_kind="human",
                    confidence="high",
                    created_at=human_at or now - timedelta(minutes=2),
                ),
                ShareAccessEvent(
                    share_id=share_id,
                    user_id=user_id,
                    event_type="link_issued",
                    ip="127.0.0.1",
                    user_agent="growth-test",
                    guest_id=guest_id,
                    client_kind="human",
                    confidence="high",
                    created_at=link_at or now - timedelta(minutes=1),
                ),
            ]
        )
        await db.commit()


async def _inject_email_code(redis, email: str, code: str) -> None:
    from app.services.email_code import _code_hash, _code_key

    await redis.set(
        _code_key("register", email),
        f"{_code_hash(email, 'register', code)}:0:2026-01-01T00:00:00:::",
        ex=600,
    )


async def test_public_growth_events_are_first_party_and_idempotent(client):
    share = await _create_share(f"guest{uuid.uuid4().hex[:6]}", guest_id="ownerless-guest")
    payload = {
        "share_code": share.code,
        "request_id": "viral-request-001",
        "visitor_id": "visitor-device-001",
        "utm_source": "wechat",
        "utm_campaign": "invite",
        "referrer": "https://example.com/source",
    }
    headers = {
        "x-nyy-guest-id": "clicking-guest-001",
        "user-agent": "growth-browser",
    }

    first = await client.post("/api/v1/growth/viral-click", json=payload, headers=headers)
    visitor_cookie = first.cookies["nyy_visitor"]
    browser_headers = {**headers, "cookie": f"nyy_visitor={visitor_cookie}"}
    second = await client.post("/api/v1/growth/viral-click", json=payload, headers=browser_headers)
    landing = await client.post(
        "/api/v1/growth/landing",
        json={
            "request_id": "landing-request-001",
            "visitor_id": "visitor-device-001",
            "landing_path": "/?ref_share=test",
            "utm_source": "wechat",
        },
        headers=browser_headers,
    )

    assert first.status_code == 200
    assert first.json()["recorded"] is True
    assert first.json()["cta_url"].endswith(f"/?ref_share={share.code}")
    assert second.status_code == 200
    assert second.json()["recorded"] is False
    assert landing.status_code == 200
    assert landing.json()["recorded"] is True

    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        click = await db.scalar(select(ViralClickEvent))
        landing_event = await db.scalar(select(GrowthLandingEvent))
        click_count = await db.scalar(select(func.count()).select_from(ViralClickEvent))
    assert click_count == 1
    assert click.share_id == share.id
    assert click.guest_id.startswith("visitor:")
    assert click.user_agent == "growth-browser"
    assert click.utm_source == "wechat"
    assert landing_event.guest_id == click.guest_id
    assert "HttpOnly" in first.headers["set-cookie"]


async def test_browsers_behind_same_ip_receive_distinct_visitor_ids(app):
    transport = ASGITransport(app=app)
    async with (
        AsyncClient(transport=transport, base_url="http://test") as first_client,
        AsyncClient(transport=transport, base_url="http://test") as second_client,
    ):
        first = await first_client.post(
            "/api/v1/growth/landing",
            json={
                "request_id": "same-ip-browser-one",
                "visitor_id": "ignored-client-one",
                "landing_path": "/",
            },
        )
        second = await second_client.post(
            "/api/v1/growth/landing",
            json={
                "request_id": "same-ip-browser-two",
                "visitor_id": "ignored-client-two",
                "landing_path": "/",
            },
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.cookies["nyy_visitor"] != second.cookies["nyy_visitor"]

    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        visitor_ids = set((await db.scalars(select(GrowthLandingEvent.visitor_id))).all())
    assert len(visitor_ids) == 2


async def test_growth_event_personal_data_is_scrubbed_after_180_days():
    from app.db.session import get_session_factory

    old_at = datetime.now(UTC) - timedelta(days=181)
    share = await _create_share(f"old{uuid.uuid4().hex[:8]}")
    async with get_session_factory()() as db:
        db.add_all(
            [
                ViralClickEvent(
                    share_id=share.id,
                    share_code=share.code,
                    request_id="old-viral-request",
                    guest_id="old-growth-guest",
                    ip="127.0.0.1",
                    user_agent="old-browser",
                    created_at=old_at,
                ),
                GrowthLandingEvent(
                    request_id="old-landing-request",
                    visitor_id="old-visitor-device",
                    guest_id="old-growth-guest",
                    ip="127.0.0.1",
                    user_agent="old-browser",
                    landing_path="/old",
                    created_at=old_at,
                ),
            ]
        )
        await db.commit()

    async with get_session_factory()() as db:
        counts = await scrub_growth_personal_data(db)
        await db.commit()
    assert counts == (1, 1)

    async with get_session_factory()() as db:
        click = await db.scalar(select(ViralClickEvent))
        landing = await db.scalar(select(GrowthLandingEvent))
    assert click.ip is None and click.user_agent is None
    assert landing.ip is None and landing.user_agent is None
    assert click.personal_data_cleared_at is not None
    assert landing.personal_data_cleared_at is not None


async def test_registration_creates_only_valid_owner_attribution(client, redis):
    owner = await _create_user(f"owner-{uuid.uuid4().hex}@example.com")
    source = await _create_share(f"reg{uuid.uuid4().hex[:8]}", owner_id=owner.id)
    email = f"new-{uuid.uuid4().hex}@example.com"
    await _inject_email_code(redis, email, "123456")

    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "An0therP@ss!",
            "code": "123456",
            "referral_share_code": source.code,
        },
        headers={"x-nyy-guest-id": "registration-device-001"},
    )
    assert response.status_code == 200

    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        attribution = await db.scalar(select(ReferralAttribution))
        registered_user = await db.scalar(select(User).where(User.email == email))
    assert attribution.referrer_user_id == owner.id
    assert attribution.referred_user_id == registered_user.id
    assert attribution.source_share_id == source.id
    assert attribution.registration_guest_id.startswith("visitor:")
    assert attribution.registration_guest_id != "registration-device-001"

    self_share = await _create_share(
        f"self{uuid.uuid4().hex[:6]}", owner_id=registered_user.id
    )
    async with get_session_factory()() as db:
        same_user = await db.get(User, registered_user.id)
        existing = await create_referral_attribution(
            db,
            referred_user=same_user,
            referral_share_code=self_share.code,
            registration_guest_id="other-device",
        )
    assert existing.id == attribution.id
    assert existing.source_share_id == source.id


async def test_self_referral_source_is_not_attributed():
    from app.db.session import get_session_factory

    user = await _create_user(f"self-owner-{uuid.uuid4().hex}@example.com")
    share = await _create_share(f"mine{uuid.uuid4().hex[:8]}", owner_id=user.id)
    async with get_session_factory()() as db:
        same_user = await db.get(User, user.id)
        attribution = await create_referral_attribution(
            db,
            referred_user=same_user,
            referral_share_code=share.code,
            registration_guest_id="self-registration-device",
        )
        await db.commit()
    assert attribution is None


async def test_qualification_excludes_participants_admin_and_registration_guest():
    referrer, referred, attribution, first_share = await _create_referral_scenario()
    admin = await _create_user("admin@nyy.app", is_admin=True)
    await _add_access_sequence(first_share.id, user_id=referrer.id)
    await _add_access_sequence(first_share.id, user_id=referred.id)
    await _add_access_sequence(first_share.id, user_id=admin.id)
    await _add_access_sequence(first_share.id, guest_id=attribution.registration_guest_id)

    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        qualified = await evaluate_referral_qualification(db, first_share.id)
        await db.commit()
    assert qualified is False

    async with get_session_factory()() as db:
        current = await db.get(ReferralAttribution, attribution.id)
        coupon_count = await db.scalar(select(func.count()).select_from(RetentionCoupon))
    assert current.status == "pending"
    assert coupon_count == 0

    await _add_access_sequence(first_share.id, guest_id="third-party-device")
    async with get_session_factory()() as db:
        qualified = await evaluate_referral_qualification(db, first_share.id)
        await db.commit()
    assert qualified is True


async def test_forged_guest_header_cannot_create_third_party_qualification(client):
    landing_response = await client.post(
        "/api/v1/growth/landing",
        json={
            "request_id": "landing-forged-registration",
            "visitor_id": "client-controlled-visitor",
            "landing_path": "/?ref_share=forged",
        },
        headers={"x-nyy-guest-id": "forged-registration-guest"},
    )
    assert landing_response.status_code == 200
    visitor_cookie = landing_response.cookies.get("nyy_visitor")
    assert visitor_cookie

    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        registration_event = await db.scalar(select(GrowthLandingEvent))
    registration_visitor_id = registration_event.guest_id
    _, _, attribution, first_share = await _create_referral_scenario(
        registration_guest_id=registration_visitor_id,
    )

    interaction_response = await client.post(
        f"/api/v1/shares/{first_share.code}/interaction",
        json={
            "event_type": "human_interaction",
            "request_id": "forged-human-interaction",
        },
        headers={"x-nyy-guest-id": "forged-third-party-one"},
        cookies={"nyy_visitor": visitor_cookie},
    )
    link_response = await client.post(
        f"/api/v1/shares/{first_share.code}/download-session",
        json={"request_id": "forged-link-request"},
        headers={
            "x-nyy-guest-id": "forged-third-party-two",
            "x-nyy-link-request-id": "forged-link-request",
        },
        cookies={"nyy_visitor": visitor_cookie},
    )

    assert interaction_response.status_code == 204
    assert link_response.status_code == 200
    async with get_session_factory()() as db:
        current = await db.get(ReferralAttribution, attribution.id)
        events = list(
            (
                await db.scalars(
                    select(ShareAccessEvent).where(
                        ShareAccessEvent.share_id == first_share.id,
                        ShareAccessEvent.event_type.in_(["human_interaction", "link_issued"]),
                    )
                )
            ).all()
        )
    assert current.status == "pending"
    assert {event.guest_id for event in events} == {registration_visitor_id}
    assert all("forged-third-party" not in (event.guest_id or "") for event in events)


async def test_anonymous_landing_and_interaction_are_rate_limited(
    client,
    redis,
    monkeypatch,
):
    from app.services import visitor_identity

    monkeypatch.setattr(visitor_identity.time, "time", lambda: 1_234_567.0)
    client_ip = "127.0.0.1"
    await redis.set(
        public_event_rate_limit_key("landing", client_ip),
        LANDING_RATE_LIMIT,
    )
    landing_response = await client.post(
        "/api/v1/growth/landing",
        json={
            "request_id": "rate-limited-landing",
            "landing_path": "/rate-limited",
        },
    )

    share = await _create_share(f"rate{uuid.uuid4().hex[:8]}")
    await redis.set(
        public_event_rate_limit_key("share-interaction", client_ip),
        INTERACTION_RATE_LIMIT,
    )
    interaction_response = await client.post(
        f"/api/v1/shares/{share.code}/interaction",
        json={
            "event_type": "human_interaction",
            "request_id": "rate-limited-interaction",
        },
    )

    assert landing_response.status_code == 429
    assert interaction_response.status_code == 429


async def test_anonymous_interaction_requires_bounded_idempotency_id(client):
    share = await _create_share(f"valid{uuid.uuid4().hex[:8]}")

    missing = await client.post(
        f"/api/v1/shares/{share.code}/interaction",
        json={"event_type": "human_interaction"},
    )
    oversized = await client.post(
        f"/api/v1/shares/{share.code}/interaction",
        json={"event_type": "human_interaction", "request_id": "x" * 129},
    )

    assert missing.status_code == 422
    assert oversized.status_code == 422


async def test_qualification_requires_first_share_and_both_seven_day_windows():
    from app.db.session import get_session_factory

    attributed_at = datetime.now(UTC) - timedelta(days=9)
    _, _, attribution, late_share = await _create_referral_scenario(
        attribution_created_at=attributed_at,
        first_share_created_at=attributed_at + timedelta(days=8),
    )
    await _add_access_sequence(late_share.id, guest_id="late-third-party")
    async with get_session_factory()() as db:
        qualified = await evaluate_referral_qualification(db, late_share.id)
        await db.commit()
    assert qualified is False
    async with get_session_factory()() as db:
        current = await db.get(ReferralAttribution, attribution.id)
    assert current.status == "expired"
    assert current.status_reason == "first_share_too_late"


async def test_link_before_human_interaction_does_not_qualify():
    from app.db.session import get_session_factory

    _, _, attribution, first_share = await _create_referral_scenario()
    now = datetime.now(UTC)
    await _add_access_sequence(
        first_share.id,
        guest_id="reverse-order-third-party",
        human_at=now - timedelta(minutes=1),
        link_at=now - timedelta(minutes=2),
    )
    async with get_session_factory()() as db:
        qualified = await evaluate_referral_qualification(db, first_share.id, now=now)
        await db.commit()
    assert qualified is False
    async with get_session_factory()() as db:
        current = await db.get(ReferralAttribution, attribution.id)
    assert current.status == "pending"


async def test_delayed_idempotent_retry_honors_events_inside_window():
    from app.db.session import get_session_factory

    attributed_at = datetime.now(UTC) - timedelta(days=20)
    referrer, referred, attribution, first_share = await _create_referral_scenario(
        attribution_created_at=attributed_at,
        first_share_created_at=attributed_at + timedelta(days=1),
    )
    await _add_access_sequence(
        first_share.id,
        guest_id="delayed-retry-third-party",
        human_at=first_share.created_at + timedelta(days=1),
        link_at=first_share.created_at + timedelta(days=2),
    )
    async with get_session_factory()() as db:
        qualified = await evaluate_referral_qualification(
            db,
            first_share.id,
            now=datetime.now(UTC),
        )
        await db.commit()
    assert qualified is True
    async with get_session_factory()() as db:
        current = await db.get(ReferralAttribution, attribution.id)
    assert current.status == "qualified"
    assert current.referrer_user_id == referrer.id
    assert current.referred_user_id == referred.id


async def test_qualification_is_concurrency_safe_and_growth_me_reports_it(client):
    referrer, _, attribution, first_share = await _create_referral_scenario()
    await _add_access_sequence(first_share.id, guest_id="qualified-third-party")

    results = await asyncio.gather(
        trigger_referral_qualification(first_share.id),
        trigger_referral_qualification(first_share.id),
    )
    assert sorted(results) == [False, True]

    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        current = await db.get(ReferralAttribution, attribution.id)
        coupons = list(
            (
                await db.scalars(
                    select(RetentionCoupon).where(
                        RetentionCoupon.referral_attribution_id == attribution.id
                    )
                )
            ).all()
        )
    assert current.status == "qualified"
    assert len(coupons) == 2
    assert {coupon.beneficiary_role for coupon in coupons} == {"referrer", "referred"}
    assert all(coupon.status == "available" for coupon in coupons)
    assert all(coupon.expires_at - coupon.issued_at == timedelta(days=180) for coupon in coupons)

    token = create_access_token(str(referrer.id), referrer.email)
    response = await client.get(
        "/api/v1/growth/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["referrals"] == {"pending": 0, "qualified": 1}
    assert len(body["available_coupons"]) == 1
    assert body["available_coupons"][0]["target_ttl_days"] == 90


async def test_referrer_rolling_limit_rejects_sixth_qualification():
    from app.db.session import get_session_factory

    referrer, _, current, first_share = await _create_referral_scenario()
    now = datetime.now(UTC)
    async with get_session_factory()() as db:
        source_share = await db.get(Share, current.source_share_id)
        for index in range(5):
            referred = User(
                email=f"rolling-{index}-{uuid.uuid4().hex}@example.com",
                password_hash="hash",
                email_verified_at=now,
            )
            db.add(referred)
            await db.flush()
            db.add(
                ReferralAttribution(
                    referrer_user_id=referrer.id,
                    referred_user_id=referred.id,
                    source_share_id=source_share.id,
                    source_share_code=source_share.code,
                    registration_guest_id=f"rolling-guest-{index}",
                    status="qualified",
                    qualified_at=now - timedelta(days=1),
                    closed_at=now - timedelta(days=1),
                )
            )
        await db.commit()
    await _add_access_sequence(first_share.id, guest_id="sixth-third-party")

    async with get_session_factory()() as db:
        qualified = await evaluate_referral_qualification(db, first_share.id, now=now)
        await db.commit()
    assert qualified is False
    async with get_session_factory()() as db:
        attribution = await db.get(ReferralAttribution, current.id)
    assert attribution.status == "rejected"
    assert attribution.status_reason == "referrer_rolling_limit"


async def test_available_coupon_cap_records_skipped_attempt():
    from app.db.session import get_session_factory

    referrer, _, current, first_share = await _create_referral_scenario()
    now = datetime.now(UTC)
    async with get_session_factory()() as db:
        source_share = await db.get(Share, current.source_share_id)
        for index in range(3):
            referred = User(
                email=f"coupon-cap-{index}-{uuid.uuid4().hex}@example.com",
                password_hash="hash",
                email_verified_at=now,
            )
            db.add(referred)
            await db.flush()
            old_attribution = ReferralAttribution(
                referrer_user_id=referrer.id,
                referred_user_id=referred.id,
                source_share_id=source_share.id,
                source_share_code=source_share.code,
                registration_guest_id=f"coupon-cap-guest-{index}",
                status="qualified",
                qualified_at=now - timedelta(days=31),
                closed_at=now - timedelta(days=31),
            )
            db.add(old_attribution)
            await db.flush()
            db.add(
                RetentionCoupon(
                    owner_id=referrer.id,
                    referral_attribution_id=old_attribution.id,
                    beneficiary_role="referrer",
                    status="available",
                    issued_at=now - timedelta(days=31),
                    expires_at=now + timedelta(days=100),
                )
            )
        await db.commit()
    await _add_access_sequence(first_share.id, guest_id="coupon-cap-third-party")

    async with get_session_factory()() as db:
        qualified = await evaluate_referral_qualification(db, first_share.id, now=now)
        await db.commit()
    assert qualified is True
    async with get_session_factory()() as db:
        attempts = list(
            (
                await db.scalars(
                    select(RetentionCoupon).where(
                        RetentionCoupon.referral_attribution_id == current.id
                    )
                )
            ).all()
        )
    referrer_attempt = next(item for item in attempts if item.owner_id == referrer.id)
    referred_attempt = next(item for item in attempts if item.owner_id != referrer.id)
    assert referrer_attempt.status == "skipped"
    assert referrer_attempt.status_reason == "available_limit"
    assert referred_attempt.status == "available"


async def test_coupon_consumption_is_atomic_concurrent_and_forces_90_days(client, redis):
    from app.db.session import get_session_factory

    referrer, referred, attribution, _ = await _create_referral_scenario()
    now = datetime.now(UTC)
    coupon = RetentionCoupon(
        owner_id=referred.id,
        referral_attribution_id=attribution.id,
        beneficiary_role="referred",
        status="available",
        issued_at=now,
        expires_at=now + timedelta(days=180),
    )
    async with get_session_factory()() as db:
        db.add(coupon)
        await db.commit()

    token_names = ["coupon-upload-token-a", "coupon-upload-token-b"]
    store_uris = ["tos-cn-i-test/coupon-a.txt", "tos-cn-i-test/coupon-b.txt"]
    for token_name, store_uri in zip(token_names, store_uris, strict=True):
        await redis.setex(
            f"nyy:commit:{token_name}",
            1800,
            json.dumps(
                {
                    "ip": "127.0.0.1",
                    "guest_id": "coupon-upload-device",
                    "user_id": str(referred.id),
                    "file_name": "coupon.txt",
                    "file_size": 128,
                    "file_ext": "txt",
                    "store_uri": store_uri,
                    "session_key": "sk",
                    "service_id": "svc",
                    "access_key": "ak",
                    "secret_key": "sk",
                    "session_token": "st",
                }
            ),
        )

    fixed_quota = {
        "guest_max_file_bytes": 1024 * 1024 * 1024,
        "guest_max_active_shares": 9999,
        "guest_ttl_hours": 24,
        "user_max_file_bytes": 1024 * 1024 * 1024,
        "user_max_active_shares": 9999,
        "user_ttl_hours": 720,
    }
    auth_headers = {
        "Authorization": f"Bearer {create_access_token(str(referred.id), referred.email)}"
    }
    mock_client = AsyncMock()
    mock_client.commit_upload.return_value = CommitResult(
        store_uri="tos-cn-i-test/coupon.txt",
        success=True,
    )
    with patch(
        "app.api.v1.uploads.get_quota_config",
        new_callable=AsyncMock,
        return_value=fixed_quota,
    ), patch(
        "app.api.v1.uploads._count_active_shares",
        new_callable=AsyncMock,
        return_value=0,
    ), patch(
        "app.api.v1.uploads.get_doubao_client",
        new_callable=AsyncMock,
        return_value=mock_client,
    ):
        responses = await asyncio.gather(
            *[
                client.post(
                    "/api/v1/uploads/commit",
                    json={
                        "upload_batch_id": f"coupon-batch-{index}",
                        "files": [
                            {
                                "commit_token": token_name,
                                "store_uri": store_uri,
                            }
                        ],
                        "expires_hours": 1,
                        "retention_coupon_id": str(coupon.id),
                    },
                    headers=auth_headers,
                )
                for index, (token_name, store_uri) in enumerate(
                    zip(token_names, store_uris, strict=True)
                )
            ]
        )

    assert sorted(response.status_code for response in responses) == [201, 409]
    async with get_session_factory()() as db:
        consumed = await db.get(RetentionCoupon, coupon.id)
        created_share = await db.get(Share, consumed.consumed_by_share_id)
        generated_share_count = await db.scalar(
            select(func.count())
            .select_from(Share)
            .where(Share.upload_batch_id.like("coupon-batch-%"))
        )
    assert consumed.status == "consumed"
    assert generated_share_count == 1
    assert timedelta(days=90) - timedelta(seconds=2) <= (
        created_share.expires_at - created_share.created_at
    ) <= timedelta(days=90) + timedelta(seconds=2)
    assert created_share.owner_id == referred.id
    assert referrer.id != referred.id


async def test_coupon_consumption_rolls_back_with_share_failure():
    from app.db.session import get_session_factory

    _, referred, attribution, _ = await _create_referral_scenario()
    now = datetime.now(UTC)
    coupon = RetentionCoupon(
        owner_id=referred.id,
        referral_attribution_id=attribution.id,
        beneficiary_role="referred",
        status="available",
        issued_at=now,
        expires_at=now + timedelta(days=180),
    )
    async with get_session_factory()() as db:
        db.add(coupon)
        await db.commit()

    failed_share_id: uuid.UUID
    async with get_session_factory()() as db:
        failed_share = Share(
            code=f"fail{uuid.uuid4().hex[:8]}",
            owner_id=referred.id,
            ip_created_from="127.0.0.1",
            total_bytes=0,
            empty_dirs=["empty/"],
            expires_at=now + timedelta(days=90),
        )
        db.add(failed_share)
        await db.flush()
        failed_share_id = failed_share.id
        await consume_retention_coupon(
            db,
            coupon_id=coupon.id,
            owner_id=referred.id,
            share_id=failed_share.id,
            now=now,
        )
        await db.rollback()

    async with get_session_factory()() as db:
        current_coupon = await db.get(RetentionCoupon, coupon.id)
        failed_share = await db.get(Share, failed_share_id)
    assert current_coupon.status == "available"
    assert current_coupon.consumed_by_share_id is None
    assert failed_share is None
