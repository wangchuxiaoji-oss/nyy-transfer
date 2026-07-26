"""固定日历周期与上传预留测试。"""

from __future__ import annotations

from datetime import UTC, datetime

import fakeredis.aioredis
import pytest

from app.services.quota import QuotaService, resolve_period
from app.services.quota_policy import default_policy_config
from app.services.quota_reconciliation import reconcile_quota_settlements


def test_resolve_period_uses_beijing_calendar_boundaries():
    daily = resolve_period("daily", datetime(2026, 7, 26, 15, 59, tzinfo=UTC))
    assert daily.period_id == "2026-07-26"
    assert daily.reset_at == datetime(2026, 7, 26, 16, 0, tzinfo=UTC)

    monthly = resolve_period("monthly", datetime(2026, 7, 31, 15, 59, tzinfo=UTC))
    assert monthly.period_id == "2026-07"
    assert monthly.reset_at == datetime(2026, 7, 31, 16, 0, tzinfo=UTC)


@pytest.mark.asyncio
async def test_reservations_are_isolated_by_identity_and_idempotent():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    service = QuotaService(redis)
    policy = default_policy_config().guest

    first = await service.reserve(
        scope="guest",
        identity="device-a",
        policy=policy,
        policy_version=1,
        batch_id="batch",
        reservation_id="same-id",
        size=1024,
    )
    second_identity = await service.reserve(
        scope="guest",
        identity="device-b",
        policy=policy,
        policy_version=1,
        batch_id="batch",
        reservation_id="same-id",
        size=2048,
    )
    retry = await service.reserve(
        scope="guest",
        identity="device-a",
        policy=policy,
        policy_version=1,
        batch_id="batch",
        reservation_id="same-id",
        size=1024,
    )
    conflict = await service.reserve(
        scope="guest",
        identity="device-a",
        policy=policy,
        policy_version=1,
        batch_id="batch",
        reservation_id="same-id",
        size=4096,
    )

    assert first.allowed and first.created
    assert second_identity.allowed and second_identity.created
    assert retry.allowed and not retry.created
    assert not conflict.allowed

    await service.consume_reservation("guest", "device-a", "same-id")
    await service.consume_reservation("guest", "device-a", "same-id")
    snapshot = await service.snapshot(
        scope="guest",
        identity="device-a",
        policy=policy,
        policy_version=1,
    )
    assert snapshot["used_bytes"] == 1024
    assert snapshot["reserved_bytes"] == 0


@pytest.mark.asyncio
async def test_cancelled_batch_rejects_late_reservations_and_consumption():
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    service = QuotaService(redis)
    policy = default_policy_config().guest
    result = await service.reserve(
        scope="guest",
        identity="cancel-device",
        policy=policy,
        policy_version=1,
        batch_id="cancel-batch",
        reservation_id="file-a",
        size=1024,
    )
    assert result.allowed

    assert await service.cancel_batch("guest", "cancel-device", "cancel-batch") == 1
    late = await service.reserve(
        scope="guest",
        identity="cancel-device",
        policy=policy,
        policy_version=1,
        batch_id="cancel-batch",
        reservation_id="file-b",
        size=1024,
    )
    assert not late.allowed
    with pytest.raises(RuntimeError, match="预留不存在"):
        await service.consume_reservation("guest", "cancel-device", "file-a")


@pytest.mark.asyncio
async def test_reconciliation_settles_committed_share_without_client_retry():
    from app.db.session import get_session_factory
    from app.models.share import Share

    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    service = QuotaService(redis)
    policy = default_policy_config().guest
    reservation = await service.reserve(
        scope="guest",
        identity="reconcile-device",
        policy=policy,
        policy_version=0,
        batch_id="reconcile-batch",
        reservation_id="reconcile-file",
        size=2048,
    )
    assert reservation.allowed

    factory = get_session_factory()
    async with factory() as db:
        share = Share(
            code="qrtest",
            guest_id="reconcile-device",
            total_bytes=2048,
            quota_scope="guest",
            quota_identity="reconcile-device",
            quota_reservation_ids=["reconcile-file"],
            quota_batch_ids=["reconcile-batch"],
            policy_version=0,
        )
        db.add(share)
        await db.commit()
        share_id = share.id

    assert await reconcile_quota_settlements(redis) == 1
    snapshot = await service.snapshot(
        scope="guest",
        identity="reconcile-device",
        policy=policy,
        policy_version=0,
    )
    assert snapshot["used_bytes"] == 2048
    async with factory() as db:
        settled_share = await db.get(Share, share_id)
        assert settled_share is not None
        assert settled_share.quota_settled_at is not None
