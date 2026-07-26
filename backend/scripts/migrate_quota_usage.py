#!/usr/bin/env python3
"""将旧滚动周期 Redis 用量迁移到当前北京时间日/月周期。"""

from __future__ import annotations

import argparse
import asyncio
import re

import redis.asyncio as aioredis

from app.core.config import get_settings
from app.db.session import dispose_engine, get_session_factory
from app.services.quota import QuotaService
from app.services.quota_policy import get_effective_policy

LEGACY_KEY = re.compile(r"^nyy:quota:(guest|user):(.+):bytes$")


async def migrate(*, dry_run: bool) -> tuple[int, int]:
    settings = get_settings()
    redis = aioredis.from_url(settings.redis_url, decode_responses=True)
    scanned = 0
    migrated = 0
    try:
        async with get_session_factory()() as db:
            effective = await get_effective_policy(db)
        service = QuotaService(redis)
        async for key in redis.scan_iter(match="nyy:quota:*:bytes", count=200):
            match = LEGACY_KEY.fullmatch(str(key))
            if not match:
                continue
            scanned += 1
            scope, identity = match.groups()
            if dry_run:
                continue
            policy = effective.config.user if scope == "user" else effective.config.guest
            await service.snapshot(
                scope=scope,
                identity=identity,
                policy=policy,
                policy_version=effective.version,
            )
            migrated += 1
    finally:
        await redis.aclose()
        await dispose_engine()
    return scanned, migrated


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    scanned, migrated = asyncio.run(migrate(dry_run=args.dry_run))
    if args.dry_run:
        print(f"发现 {scanned} 个旧配额用量键，未执行写入")
    else:
        print(f"扫描 {scanned} 个旧配额用量键，成功迁移 {migrated} 个")


if __name__ == "__main__":
    main()
