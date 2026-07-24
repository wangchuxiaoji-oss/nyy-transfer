"""运营分区维护的 DEFAULT 分区安全回归测试。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from app.db.session import get_engine
from scripts.maintain_operational_data import _create_month_partition


@pytest.mark.asyncio
async def test_default_partition_refuses_large_automatic_move():
    connection = AsyncMock()
    connection.scalar.side_effect = [None, "download_logs_default", 10_001]

    with pytest.raises(RuntimeError, match="拒绝由定时任务搬迁"):
        await _create_month_partition(
            connection,
            parent="download_logs",
            timestamp_column="downloaded_at",
            start=datetime(2026, 8, 1, tzinfo=UTC),
            end=datetime(2026, 9, 1, tzinfo=UTC),
        )

    connection.execute.assert_not_awaited()


@pytest.mark.asyncio
async def test_default_partition_moves_small_range_before_attach():
    connection = AsyncMock()
    connection.scalar.side_effect = [None, "download_logs_default", 1, 1]

    created = await _create_month_partition(
        connection,
        parent="download_logs",
        timestamp_column="downloaded_at",
        start=datetime(2026, 8, 1, tzinfo=UTC),
        end=datetime(2026, 9, 1, tzinfo=UTC),
    )

    assert created is True
    statements = [str(call.args[0]) for call in connection.execute.await_args_list]
    assert any("LOCK TABLE download_logs_default" in statement for statement in statements)
    assert any("DELETE FROM download_logs_default" in statement for statement in statements)
    assert any("ATTACH PARTITION download_logs_202608" in statement for statement in statements)


@pytest.mark.asyncio
async def test_default_partition_move_works_against_postgresql():
    parent = f"partition_test_{uuid.uuid4().hex[:12]}"
    default_partition = f"{parent}_default"
    target_partition = f"{parent}_202608"
    engine = get_engine()
    try:
        async with engine.begin() as connection:
            await connection.execute(text(
                f"CREATE TABLE {parent} ("
                "id uuid NOT NULL, created_at timestamptz NOT NULL, "
                "PRIMARY KEY (id, created_at)) PARTITION BY RANGE (created_at)"
            ))
            await connection.execute(
                text(f"CREATE TABLE {default_partition} PARTITION OF {parent} DEFAULT")
            )
            await connection.execute(
                text(f"INSERT INTO {parent} VALUES (:id, :created_at)"),
                {
                    "id": uuid.uuid4(),
                    "created_at": datetime(2026, 8, 15, tzinfo=UTC),
                },
            )

        async with engine.connect() as connection:
            created = await _create_month_partition(
                connection,
                parent=parent,
                timestamp_column="created_at",
                start=datetime(2026, 8, 1, tzinfo=UTC),
                end=datetime(2026, 9, 1, tzinfo=UTC),
            )
            await connection.commit()
            assert created is True
            assert await connection.scalar(text(f"SELECT count(*) FROM {target_partition}")) == 1
            assert await connection.scalar(text(f"SELECT count(*) FROM {default_partition}")) == 0
    finally:
        async with engine.begin() as connection:
            await connection.execute(text(f"DROP TABLE IF EXISTS {parent} CASCADE"))
