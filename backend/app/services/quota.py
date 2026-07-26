"""固定日历周期的游客 / 用户配额与上传预留。"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

from redis.exceptions import WatchError

from app.models.user import User
from app.schemas.quota_policy import QuotaPolicyConfig, SendQuotaPolicy
from app.services.quota_policy import get_effective_policy

log = logging.getLogger(__name__)
BEIJING = ZoneInfo("Asia/Shanghai")
RESERVATION_TTL_SECONDS = 72 * 3600
USAGE_RETENTION_SECONDS = 7 * 24 * 3600
SETTLEMENT_MARKER_TTL_SECONDS = 45 * 24 * 3600


@dataclass
class QuotaCheckResult:
    allowed: bool
    reason: str = ""
    used_bytes: int = 0
    reserved_bytes: int = 0
    limit_bytes: int = 0
    remaining_bytes: int = 0
    reset_at: datetime | None = None
    reservation_id: str = ""
    usage_key: str = ""
    created: bool = False


@dataclass(frozen=True)
class QuotaPeriod:
    period_id: str
    reset_at: datetime


def resolve_period(kind: str, now: datetime | None = None) -> QuotaPeriod:
    current = (now or datetime.now(UTC)).astimezone(BEIJING)
    if kind == "daily":
        boundary = (current + timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        return QuotaPeriod(current.strftime("%Y-%m-%d"), boundary.astimezone(UTC))
    if kind == "monthly":
        if current.month == 12:
            boundary = current.replace(
                year=current.year + 1,
                month=1,
                day=1,
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
        else:
            boundary = current.replace(
                month=current.month + 1,
                day=1,
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            )
        return QuotaPeriod(current.strftime("%Y-%m"), boundary.astimezone(UTC))
    raise ValueError(f"不支持的配额周期：{kind}")


def quota_identity(*, user_id: str | None, guest_id: str) -> tuple[str, str]:
    return ("user", user_id) if user_id else ("guest", guest_id)


def usage_key(scope: str, identity: str, period_id: str) -> str:
    return f"nyy:quota:v2:{scope}:{identity}:{period_id}:usage"


def batches_key(scope: str, identity: str) -> str:
    return f"nyy:quota:v2:{scope}:{identity}:batches"


def reservation_key(scope: str, identity: str, reservation_id: str) -> str:
    return f"nyy:quota:v2:reservation:{scope}:{identity}:{reservation_id}"


def reservations_key(scope: str, identity: str) -> str:
    return f"nyy:quota:v2:{scope}:{identity}:reservations"


def cancelled_batch_key(scope: str, identity: str, batch_id: str) -> str:
    return f"nyy:quota:v2:{scope}:{identity}:cancelled:{batch_id}"


def consumed_reservation_key(scope: str, identity: str, reservation_id: str) -> str:
    return f"nyy:quota:v2:{scope}:{identity}:consumed:{reservation_id}"


def legacy_usage_key(scope: str, identity: str) -> str:
    return f"nyy:quota:{scope}:{identity}:bytes"


async def _usage_values(redis, key: str) -> tuple[int, int]:
    values = await redis.hmget(key, "used", "reserved")
    return int(values[0] or 0), int(values[1] or 0)


async def _lazy_migrate_legacy(redis, scope: str, identity: str, key: str, ttl: int) -> None:
    legacy_key = legacy_usage_key(scope, identity)
    for _ in range(8):
        try:
            async with redis.pipeline(transaction=True) as pipe:
                await pipe.watch(key, legacy_key)
                legacy_value = await pipe.get(legacy_key)
                if legacy_value is None:
                    await pipe.unwatch()
                    return
                pipe.multi()
                pipe.hincrby(key, "used", int(legacy_value))
                pipe.hsetnx(key, "reserved", 0)
                pipe.expire(key, ttl)
                pipe.delete(legacy_key)
                await pipe.execute()
                return
        except WatchError:
            continue
    raise RuntimeError("旧配额用量迁移竞争，请重试")


class QuotaService:
    def __init__(self, redis) -> None:
        self.redis = redis

    async def _cleanup_expired_reservations(self, scope: str, identity: str) -> None:
        index = reservations_key(scope, identity)
        expired = await self.redis.zrangebyscore(index, "-inf", int(datetime.now(UTC).timestamp()))
        for reservation_id in expired:
            await self.release_reservation(scope, identity, str(reservation_id))
        if expired:
            await self.redis.zrem(index, *expired)

    async def snapshot(
        self,
        *,
        scope: str,
        identity: str,
        policy: SendQuotaPolicy,
        policy_version: int,
    ) -> dict:
        period = resolve_period(policy.period_kind)
        key = usage_key(scope, identity, period.period_id)
        ttl = max(1, int((period.reset_at - datetime.now(UTC)).total_seconds())) + USAGE_RETENTION_SECONDS
        await self._cleanup_expired_reservations(scope, identity)
        await _lazy_migrate_legacy(self.redis, scope, identity, key, ttl)
        used, reserved = await _usage_values(self.redis, key)
        return {
            "used_bytes": used,
            "reserved_bytes": reserved,
            "limit_bytes": policy.period_limit_bytes,
            "remaining_bytes": max(0, policy.period_limit_bytes - used - reserved),
            "reset_at": period.reset_at,
            "period_kind": policy.period_kind,
            "policy_version": policy_version,
            "max_file_bytes": policy.max_file_bytes,
            "max_share_bytes": policy.max_share_bytes,
            "max_files_per_share": policy.max_files_per_share,
            "max_empty_dirs_per_share": policy.max_empty_dirs_per_share,
            "max_active_shares": policy.max_active_shares,
            "max_concurrent_upload_batches": policy.max_concurrent_upload_batches,
            "default_retention_hours": policy.default_retention_hours,
            "retention_options_hours": policy.retention_options_hours,
            "default_max_downloads": policy.default_max_downloads,
            "download_options": policy.download_options,
            "ttl_hours": 24 if policy.period_kind == "daily" else 30 * 24,
        }

    async def reserve(
        self,
        *,
        scope: str,
        identity: str,
        policy: SendQuotaPolicy,
        policy_version: int,
        batch_id: str,
        reservation_id: str,
        size: int,
    ) -> QuotaCheckResult:
        period = resolve_period(policy.period_kind)
        key = usage_key(scope, identity, period.period_id)
        reservation = reservation_key(scope, identity, reservation_id)
        active_batches = batches_key(scope, identity)
        reservation_index = reservations_key(scope, identity)
        cancelled_batch = cancelled_batch_key(scope, identity, batch_id)
        now = datetime.now(UTC)
        usage_ttl = max(1, int((period.reset_at - now).total_seconds())) + USAGE_RETENTION_SECONDS
        batch_expires_at = int(now.timestamp()) + RESERVATION_TTL_SECONDS
        await self._cleanup_expired_reservations(scope, identity)
        await _lazy_migrate_legacy(self.redis, scope, identity, key, usage_ttl)

        for _ in range(8):
            try:
                async with self.redis.pipeline(transaction=True) as pipe:
                    await pipe.watch(key, reservation, active_batches, cancelled_batch)
                    if await pipe.exists(cancelled_batch):
                        await pipe.unwatch()
                        return QuotaCheckResult(allowed=False, reason="上传批次已取消，请重新选择文件")
                    existing = await pipe.get(reservation)
                    used, reserved = await _usage_values(pipe, key)
                    if existing:
                        payload = json.loads(existing)
                        await pipe.unwatch()
                        if (
                            payload.get("scope") != scope
                            or payload.get("identity") != identity
                            or payload.get("batch_id") != batch_id
                            or int(payload.get("size", -1)) != size
                        ):
                            return QuotaCheckResult(allowed=False, reason="上传预留标识冲突，请重新上传")
                        return QuotaCheckResult(
                            allowed=True,
                            used_bytes=used,
                            reserved_bytes=reserved,
                            limit_bytes=policy.period_limit_bytes,
                            remaining_bytes=max(0, policy.period_limit_bytes - used - reserved),
                            reset_at=period.reset_at,
                            reservation_id=reservation_id,
                            usage_key=payload["usage_key"],
                        )
                    await pipe.zremrangebyscore(active_batches, "-inf", int(now.timestamp()))
                    batch_exists = await pipe.zscore(active_batches, batch_id)
                    active_count = await pipe.zcard(active_batches)
                    if batch_exists is None and active_count >= policy.max_concurrent_upload_batches:
                        await pipe.unwatch()
                        return QuotaCheckResult(
                            allowed=False,
                            reason=f"并发上传批次已达上限（{active_count}/{policy.max_concurrent_upload_batches}）",
                            used_bytes=used,
                            reserved_bytes=reserved,
                            limit_bytes=policy.period_limit_bytes,
                            remaining_bytes=max(0, policy.period_limit_bytes - used - reserved),
                            reset_at=period.reset_at,
                        )
                    if used + reserved + size > policy.period_limit_bytes:
                        await pipe.unwatch()
                        return QuotaCheckResult(
                            allowed=False,
                            reason=f"上传额度不足：已用 {used}，已预留 {reserved}，上限 {policy.period_limit_bytes} 字节",
                            used_bytes=used,
                            reserved_bytes=reserved,
                            limit_bytes=policy.period_limit_bytes,
                            remaining_bytes=max(0, policy.period_limit_bytes - used - reserved),
                            reset_at=period.reset_at,
                        )
                    payload = json.dumps({
                        "usage_key": key,
                        "size": size,
                        "batch_id": batch_id,
                        "scope": scope,
                        "identity": identity,
                        "policy_version": policy_version,
                        "period_id": period.period_id,
                        "expires_at": batch_expires_at,
                    }, separators=(",", ":"))
                    pipe.multi()
                    pipe.hincrby(key, "reserved", size)
                    pipe.expire(key, usage_ttl)
                    pipe.set(reservation, payload, ex=usage_ttl)
                    pipe.zadd(reservation_index, {reservation_id: batch_expires_at})
                    pipe.expire(reservation_index, usage_ttl)
                    pipe.zadd(active_batches, {batch_id: batch_expires_at})
                    pipe.expire(active_batches, RESERVATION_TTL_SECONDS + 3600)
                    await pipe.execute()
                    return QuotaCheckResult(
                        allowed=True,
                        used_bytes=used,
                        reserved_bytes=reserved + size,
                        limit_bytes=policy.period_limit_bytes,
                        remaining_bytes=max(0, policy.period_limit_bytes - used - reserved - size),
                        reset_at=period.reset_at,
                        reservation_id=reservation_id,
                        usage_key=key,
                        created=True,
                    )
            except WatchError:
                continue
        return QuotaCheckResult(allowed=False, reason="配额状态竞争，请重试")

    async def consume_reservation(self, scope: str, identity: str, reservation_id: str) -> None:
        key = reservation_key(scope, identity, reservation_id)
        consumed_key = consumed_reservation_key(scope, identity, reservation_id)
        for _ in range(8):
            try:
                async with self.redis.pipeline(transaction=True) as pipe:
                    await pipe.watch(key)
                    raw = await pipe.get(key)
                    if not raw:
                        await pipe.unwatch()
                        if await self.redis.exists(consumed_key):
                            return
                        raise RuntimeError("上传预留不存在或已释放")
                    payload = json.loads(raw)
                    usage = payload["usage_key"]
                    size = int(payload["size"])
                    index = reservations_key(payload["scope"], payload["identity"])
                    await pipe.watch(usage)
                    pipe.multi()
                    pipe.hincrby(usage, "reserved", -size)
                    pipe.hincrby(usage, "used", size)
                    pipe.delete(key)
                    pipe.zrem(index, reservation_id)
                    pipe.set(consumed_key, "1", ex=SETTLEMENT_MARKER_TTL_SECONDS)
                    await pipe.execute()
                    return
            except WatchError:
                continue
        raise RuntimeError("配额预留消费竞争，请重试")

    async def release_reservation(self, scope: str, identity: str, reservation_id: str) -> None:
        key = reservation_key(scope, identity, reservation_id)
        for _ in range(8):
            try:
                async with self.redis.pipeline(transaction=True) as pipe:
                    await pipe.watch(key)
                    raw = await pipe.get(key)
                    if not raw:
                        await pipe.unwatch()
                        return
                    payload = json.loads(raw)
                    usage = payload["usage_key"]
                    size = int(payload["size"])
                    index = reservations_key(payload["scope"], payload["identity"])
                    await pipe.watch(usage)
                    pipe.multi()
                    pipe.hincrby(usage, "reserved", -size)
                    pipe.delete(key)
                    pipe.zrem(index, reservation_id)
                    await pipe.execute()
                    return
            except WatchError:
                continue
        raise RuntimeError("配额预留释放竞争，请重试")

    async def finalize_batch(self, scope: str, identity: str, batch_id: str) -> None:
        await self.redis.zrem(batches_key(scope, identity), batch_id)

    async def is_batch_cancelled(self, scope: str, identity: str, batch_id: str) -> bool:
        return bool(await self.redis.exists(cancelled_batch_key(scope, identity, batch_id)))

    async def consume_unreserved(
        self,
        *,
        scope: str,
        identity: str,
        policy: SendQuotaPolicy,
        size: int,
        settlement_id: str | None = None,
    ) -> None:
        period = resolve_period(policy.period_kind)
        key = usage_key(scope, identity, period.period_id)
        ttl = max(1, int((period.reset_at - datetime.now(UTC)).total_seconds())) + USAGE_RETENTION_SECONDS
        await _lazy_migrate_legacy(self.redis, scope, identity, key, ttl)
        settlement_key = f"nyy:quota:v2:settlement:{settlement_id}" if settlement_id else None
        for _ in range(8):
            try:
                async with self.redis.pipeline(transaction=True) as pipe:
                    if settlement_key:
                        await pipe.watch(settlement_key)
                        if await pipe.exists(settlement_key):
                            await pipe.unwatch()
                            return
                    pipe.multi()
                    pipe.hincrby(key, "used", size)
                    pipe.expire(key, ttl)
                    if settlement_key:
                        pipe.set(settlement_key, "1", ex=ttl)
                    await pipe.execute()
                    return
            except WatchError:
                continue
        raise RuntimeError("未预留配额结算竞争，请重试")

    async def cancel_batch(self, scope: str, identity: str, batch_id: str) -> int:
        released = 0
        await self.redis.set(
            cancelled_batch_key(scope, identity, batch_id),
            "1",
            ex=RESERVATION_TTL_SECONDS,
        )
        index = reservations_key(scope, identity)
        for reservation_id in await self.redis.zrange(index, 0, -1):
            raw = await self.redis.get(reservation_key(scope, identity, str(reservation_id)))
            if not raw:
                continue
            payload = json.loads(raw)
            if payload.get("scope") == scope and payload.get("identity") == identity and payload.get("batch_id") == batch_id:
                await self.release_reservation(scope, identity, str(reservation_id))
                released += 1
        await self.finalize_batch(scope, identity, batch_id)
        return released


async def get_quota_snapshot(redis, db, *, user: User | None, guest_id: str) -> dict:
    effective = await get_effective_policy(db)
    scope, identity = quota_identity(
        user_id=str(user.id) if user else None,
        guest_id=guest_id,
    )
    policy = effective.config.user if user else effective.config.guest
    if redis is None:
        period = resolve_period(policy.period_kind)
        return {
            "used_bytes": 0,
            "reserved_bytes": 0,
            "limit_bytes": policy.period_limit_bytes,
            "remaining_bytes": policy.period_limit_bytes,
            "reset_at": period.reset_at,
            "period_kind": policy.period_kind,
            "policy_version": effective.version,
            "max_file_bytes": policy.max_file_bytes,
            "max_share_bytes": policy.max_share_bytes,
            "max_files_per_share": policy.max_files_per_share,
            "max_empty_dirs_per_share": policy.max_empty_dirs_per_share,
            "max_active_shares": policy.max_active_shares,
            "max_concurrent_upload_batches": policy.max_concurrent_upload_batches,
            "default_retention_hours": policy.default_retention_hours,
            "retention_options_hours": policy.retention_options_hours,
            "default_max_downloads": policy.default_max_downloads,
            "download_options": policy.download_options,
            "ttl_hours": 24 if policy.period_kind == "daily" else 30 * 24,
        }
    return await QuotaService(redis).snapshot(
        scope=scope,
        identity=identity,
        policy=policy,
        policy_version=effective.version,
    )


async def resolve_policy_for_identity(
    db,
    *,
    user_id: str | None,
) -> tuple[int, QuotaPolicyConfig, SendQuotaPolicy]:
    effective = await get_effective_policy(db)
    return (
        effective.version,
        effective.config,
        effective.config.user if user_id else effective.config.guest,
    )
