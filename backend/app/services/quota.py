"""IP 配额服务 — Redis 滑动窗口。

游客（未登录）：200 MB / 24h / 1 个活跃分享
注册用户：1 GiB / 30d / 20 个活跃分享
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.config import get_settings

log = logging.getLogger(__name__)


@dataclass
class QuotaCheckResult:
    allowed: bool
    reason: str = ""
    used_bytes: int = 0
    limit_bytes: int = 0


class QuotaService:
    """基于 Redis 的配额检查。

    key 格式：
      nyy:quota:ip:{ip}:bytes   — 24h 滑动窗口已用字节
      nyy:quota:ip:{ip}:count   — 24h 活跃分享数
      nyy:quota:user:{uid}:bytes
      nyy:quota:user:{uid}:count
    """

    def __init__(self, redis) -> None:  # redis: redis.asyncio.Redis
        self.redis = redis

    async def check_guest(self, ip: str, file_size: int) -> QuotaCheckResult:
        """检查游客 IP 是否允许上传 file_size 字节。"""
        settings = get_settings()
        limit = settings.guest_max_file_bytes
        ttl = settings.guest_ttl_hours * 3600

        key = f"nyy:quota:ip:{ip}:bytes"
        used = int(await self.redis.get(key) or 0)

        if used + file_size > limit:
            return QuotaCheckResult(
                allowed=False,
                reason=f"游客上传额度不足：已用 {used} / 上限 {limit} 字节",
                used_bytes=used,
                limit_bytes=limit,
            )
        return QuotaCheckResult(allowed=True, used_bytes=used, limit_bytes=limit)

    async def consume_guest(self, ip: str, file_size: int) -> None:
        """上传成功后扣减配额。"""
        settings = get_settings()
        ttl = settings.guest_ttl_hours * 3600
        key = f"nyy:quota:ip:{ip}:bytes"
        pipe = self.redis.pipeline()
        pipe.incrby(key, file_size)
        pipe.expire(key, ttl)
        await pipe.execute()
        log.info("quota consumed: ip=%s +%d bytes", ip, file_size)

    async def check_guest_with_config(
        self, ip: str, file_size: int, quota_config: dict[str, int]
    ) -> QuotaCheckResult:
        limit = quota_config["guest_max_file_bytes"]
        key = f"nyy:quota:ip:{ip}:bytes"
        used = int(await self.redis.get(key) or 0)
        if used + file_size > limit:
            return QuotaCheckResult(
                allowed=False,
                reason=f"游客上传额度不足：已用 {used} / 上限 {limit} 字节",
                used_bytes=used,
                limit_bytes=limit,
            )
        return QuotaCheckResult(allowed=True, used_bytes=used, limit_bytes=limit)

    async def consume_guest_with_config(
        self, ip: str, file_size: int, quota_config: dict[str, int]
    ) -> None:
        ttl = quota_config["guest_ttl_hours"] * 3600
        key = f"nyy:quota:ip:{ip}:bytes"
        pipe = self.redis.pipeline()
        pipe.incrby(key, file_size)
        pipe.expire(key, ttl)
        await pipe.execute()

    async def check_user(self, user_id: str, file_size: int) -> QuotaCheckResult:
        """检查注册用户配额。"""
        settings = get_settings()
        limit = settings.user_max_file_bytes
        key = f"nyy:quota:user:{user_id}:bytes"
        used = int(await self.redis.get(key) or 0)

        if used + file_size > limit:
            return QuotaCheckResult(
                allowed=False,
                reason=f"账号上传额度不足：已用 {used} / 上限 {limit} 字节",
                used_bytes=used,
                limit_bytes=limit,
            )
        return QuotaCheckResult(allowed=True, used_bytes=used, limit_bytes=limit)

    async def consume_user(self, user_id: str, file_size: int) -> None:
        """注册用户上传成功后扣减配额。"""
        ttl = 30 * 24 * 3600  # 30 days
        key = f"nyy:quota:user:{user_id}:bytes"
        pipe = self.redis.pipeline()
        pipe.incrby(key, file_size)
        pipe.expire(key, ttl)
        await pipe.execute()

    async def check_user_with_config(
        self, user_id: str, file_size: int, quota_config: dict[str, int]
    ) -> QuotaCheckResult:
        limit = quota_config["user_max_file_bytes"]
        key = f"nyy:quota:user:{user_id}:bytes"
        used = int(await self.redis.get(key) or 0)
        if used + file_size > limit:
            return QuotaCheckResult(
                allowed=False,
                reason=f"账号上传额度不足：已用 {used} / 上限 {limit} 字节",
                used_bytes=used,
                limit_bytes=limit,
            )
        return QuotaCheckResult(allowed=True, used_bytes=used, limit_bytes=limit)

    async def consume_user_with_config(
        self, user_id: str, file_size: int, quota_config: dict[str, int]
    ) -> None:
        ttl = quota_config["user_ttl_hours"] * 3600
        key = f"nyy:quota:user:{user_id}:bytes"
        pipe = self.redis.pipeline()
        pipe.incrby(key, file_size)
        pipe.expire(key, ttl)
        await pipe.execute()
