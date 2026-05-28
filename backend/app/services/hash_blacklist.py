"""Hash 黑名单检查服务。

预留框架：将来可对接 abuse.ch / MalwareBazaar 等数据源。
当前实现：Redis Set 存储已知恶意 hash，commit 时检查。
管理后台可通过 API 添加/删除 hash。
"""

from __future__ import annotations

import logging
from redis.asyncio import Redis

log = logging.getLogger(__name__)

HASH_BLACKLIST_KEY = "nyy:hash_blacklist"


class HashBlacklistService:
    """基于 Redis Set 的文件 hash 黑名单。"""

    def __init__(self, redis: Redis):
        self._redis = redis

    async def is_blocked(self, file_hash: str) -> bool:
        """检查 hash 是否在黑名单中。hash 格式: sha256 hex。"""
        if not file_hash:
            return False
        return await self._redis.sismember(HASH_BLACKLIST_KEY, file_hash.lower())

    async def add(self, file_hash: str, reason: str = "") -> None:
        """添加 hash 到黑名单。"""
        await self._redis.sadd(HASH_BLACKLIST_KEY, file_hash.lower())
        if reason:
            await self._redis.hset(
                f"{HASH_BLACKLIST_KEY}:reasons",
                file_hash.lower(),
                reason,
            )
        log.info("hash blacklisted: %s reason=%s", file_hash[:16], reason)

    async def remove(self, file_hash: str) -> None:
        """从黑名单移除 hash。"""
        await self._redis.srem(HASH_BLACKLIST_KEY, file_hash.lower())
        await self._redis.hdel(f"{HASH_BLACKLIST_KEY}:reasons", file_hash.lower())

    async def count(self) -> int:
        """黑名单中的 hash 数量。"""
        return await self._redis.scard(HASH_BLACKLIST_KEY)
