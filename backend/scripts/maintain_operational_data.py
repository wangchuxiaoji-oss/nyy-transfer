#!/usr/bin/env python3
"""创建未来事件分区、移除过期分区并执行隐私保留期清理。"""

from __future__ import annotations

import asyncio
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core.config import get_settings
from app.db.session import get_engine, get_session_factory
from app.services.growth import scrub_growth_personal_data
from app.services.share_access import cleanup_ip_history

_PARTITION_LOCK_KEY = 0x4E595950415254
_PARTITION_PATTERN = re.compile(r"^(share_access_events|download_logs)_(\d{6})$")
_MAX_DEFAULT_ROWS_PER_RUN = 10_000


def _month_start(value: datetime) -> datetime:
    return datetime(value.year, value.month, 1, tzinfo=UTC)


def _add_month(value: datetime, count: int = 1) -> datetime:
    month_index = value.year * 12 + value.month - 1 + count
    return datetime(month_index // 12, month_index % 12 + 1, 1, tzinfo=UTC)


async def _create_month_partition(
    connection: AsyncConnection,
    *,
    parent: str,
    timestamp_column: str,
    start: datetime,
    end: datetime,
) -> bool:
    partition = f"{parent}_{start:%Y%m}"
    exists = await connection.scalar(text("SELECT to_regclass(:name)"), {"name": partition})
    if exists:
        return False

    default_partition = f"{parent}_default"
    default_exists = await connection.scalar(
        text("SELECT to_regclass(:name)"),
        {"name": default_partition},
    )
    if not default_exists:
        await connection.execute(
            text(
                f"CREATE TABLE {partition} PARTITION OF {parent} "
                f"FOR VALUES FROM ('{start.isoformat()}') TO ('{end.isoformat()}')"
            )
        )
        return True

    pending_rows = await connection.scalar(
        text(
            f"SELECT count(*) FROM {default_partition} "
            f"WHERE {timestamp_column} >= :start AND {timestamp_column} < :end"
        ),
        {"start": start, "end": end},
    ) or 0
    if pending_rows > _MAX_DEFAULT_ROWS_PER_RUN:
        raise RuntimeError(
            f"{default_partition} 中有 {pending_rows} 行落入 {partition}；"
            "拒绝由定时任务搬迁，请在维护窗口手工处理"
        )

    await connection.execute(text(f"LOCK TABLE {default_partition} IN ACCESS EXCLUSIVE MODE"))
    locked_pending_rows = await connection.scalar(
        text(
            f"SELECT count(*) FROM {default_partition} "
            f"WHERE {timestamp_column} >= :start AND {timestamp_column} < :end"
        ),
        {"start": start, "end": end},
    ) or 0
    if locked_pending_rows > _MAX_DEFAULT_ROWS_PER_RUN:
        raise RuntimeError(
            f"锁定后 {default_partition} 中有 {locked_pending_rows} 行待搬迁；"
            "拒绝由定时任务执行"
        )
    await connection.execute(
        text(f"CREATE TABLE {partition} (LIKE {parent} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)")
    )
    if locked_pending_rows:
        await connection.execute(
            text(
                f"WITH moved AS (DELETE FROM {default_partition} "
                f"WHERE {timestamp_column} >= :start AND {timestamp_column} < :end RETURNING *) "
                f"INSERT INTO {partition} SELECT * FROM moved"
            ),
            {"start": start, "end": end},
        )
    await connection.execute(
        text(
            f"ALTER TABLE {parent} ATTACH PARTITION {partition} "
            f"FOR VALUES FROM ('{start.isoformat()}') TO ('{end.isoformat()}')"
        )
    )
    return True


async def maintain_partitions() -> tuple[int, int]:
    now = datetime.now(UTC)
    cutoff = now - timedelta(days=max(1, get_settings().share_access_retention_days))
    created = 0
    dropped = 0
    engine = get_engine()
    async with engine.connect() as connection:
        acquired = await connection.scalar(text(f"SELECT pg_try_advisory_lock({_PARTITION_LOCK_KEY})"))
        if not acquired:
            return created, dropped
        try:
            for parent, timestamp_column in (
                ("share_access_events", "created_at"),
                ("download_logs", "downloaded_at"),
            ):
                is_partitioned = await connection.scalar(
                    text(
                        "SELECT c.relkind = 'p' FROM pg_class c "
                        "JOIN pg_namespace n ON n.oid = c.relnamespace "
                        "WHERE n.nspname = current_schema() AND c.relname = :parent"
                    ),
                    {"parent": parent},
                )
                if not is_partitioned:
                    continue
                current = _month_start(now)
                for month_offset in range(0, 4):
                    start = _add_month(current, month_offset)
                    end = _add_month(start)
                    if await _create_month_partition(
                        connection,
                        parent=parent,
                        timestamp_column=timestamp_column,
                        start=start,
                        end=end,
                    ):
                        created += 1
                    await connection.commit()

                names = await connection.scalars(
                    text(
                        "SELECT child.relname FROM pg_inherits "
                        "JOIN pg_class parent ON pg_inherits.inhparent = parent.oid "
                        "JOIN pg_class child ON pg_inherits.inhrelid = child.oid "
                        "WHERE parent.relname = :parent"
                    ),
                    {"parent": parent},
                )
                for partition in names:
                    match = _PARTITION_PATTERN.fullmatch(partition)
                    if not match:
                        continue
                    partition_start = datetime.strptime(match.group(2), "%Y%m").replace(tzinfo=UTC)
                    if _add_month(partition_start) > cutoff:
                        continue
                    await connection.execute(text(f"DROP TABLE {partition}"))
                    await connection.commit()
                    dropped += 1
        finally:
            if connection.in_transaction():
                await connection.rollback()
            await connection.execute(text(f"SELECT pg_advisory_unlock({_PARTITION_LOCK_KEY})"))
            await connection.commit()
    factory = get_session_factory()
    async with factory() as db:
        await scrub_growth_personal_data(db, now=now)
        await db.commit()
    await cleanup_ip_history()
    return created, dropped


def main() -> None:
    created, dropped = asyncio.run(maintain_partitions())
    print(f"创建 {created} 个未来分区，移除 {dropped} 个过期分区，并完成隐私清理")


if __name__ == "__main__":
    main()
