"""partition operational events

该迁移会重建并复制事件表，不是在线迁移。已有数据时必须在维护窗口显式设置
``NYY_ALLOW_OFFLINE_PARTITION_MIGRATION=1``；大表会直接拒绝自动执行。

Revision ID: 20260721_1800
Revises: 20260721_1200
Create Date: 2026-07-21 18:00:00.000000
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260721_1800"
down_revision = "20260721_1200"
branch_labels = None
depends_on = None

_MAX_AUTOMATIC_ROWS = 100_000
_MAX_AUTOMATIC_BYTES = 512 * 1024 * 1024


def _table_exists(table_name: str) -> bool:
    return table_name in sa.inspect(op.get_bind()).get_table_names()


def _is_partitioned(table_name: str) -> bool:
    value = op.get_bind().execute(
        sa.text(
            "SELECT c.relkind = 'p' FROM pg_class c "
            "JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname = current_schema() AND c.relname = :table_name"
        ),
        {"table_name": table_name},
    ).scalar()
    return bool(value)


def _assert_offline_partitioning_allowed() -> None:
    bind = op.get_bind()
    populated_tables: list[str] = []
    for table_name in ("share_access_events", "download_logs"):
        if not _table_exists(table_name) or _is_partitioned(table_name):
            continue
        has_rows = bind.execute(
            sa.text(f"SELECT EXISTS (SELECT 1 FROM {table_name} LIMIT 1)")
        ).scalar()
        if not has_rows:
            continue
        estimated_rows, relation_bytes = bind.execute(
            sa.text(
                "SELECT greatest(c.reltuples, 0)::bigint, pg_total_relation_size(c.oid) "
                "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
                "WHERE n.nspname = current_schema() AND c.relname = :table_name"
            ),
            {"table_name": table_name},
        ).one()
        if estimated_rows > _MAX_AUTOMATIC_ROWS or relation_bytes > _MAX_AUTOMATIC_BYTES:
            raise RuntimeError(
                f"拒绝自动分区大表 {table_name}: estimated_rows={estimated_rows}, "
                f"bytes={relation_bytes}；请制定在线迁移或停机迁移方案"
            )
        populated_tables.append(table_name)
    if populated_tables and os.getenv("NYY_ALLOW_OFFLINE_PARTITION_MIGRATION") != "1":
        raise RuntimeError(
            "分区迁移会锁表并复制数据；请在维护窗口设置 "
            "NYY_ALLOW_OFFLINE_PARTITION_MIGRATION=1 后重试。涉及表: "
            + ", ".join(populated_tables)
        )


def _month_start(value: datetime) -> datetime:
    return datetime(value.year, value.month, 1, tzinfo=UTC)


def _add_month(value: datetime, count: int = 1) -> datetime:
    month_index = value.year * 12 + value.month - 1 + count
    return datetime(month_index // 12, month_index % 12 + 1, 1, tzinfo=UTC)


def _create_month_partitions(parent: str, timestamp_column: str) -> None:
    bind = op.get_bind()
    minimum, maximum = bind.execute(
        sa.text(
            f"SELECT min({timestamp_column}), max({timestamp_column}) "
            f"FROM {parent}_unpartitioned"
        )
    ).one()
    now = datetime.now(UTC)
    first = _month_start(minimum or _add_month(now, -6))
    last = _month_start(max(maximum or now, _add_month(now, 3)))
    current = first
    while current <= last:
        following = _add_month(current)
        partition_name = f"{parent}_{current:%Y%m}"
        bind.execute(
            sa.text(
                f"CREATE TABLE IF NOT EXISTS {partition_name} PARTITION OF {parent} "
                f"FOR VALUES FROM ('{current.isoformat()}') TO ('{following.isoformat()}')"
            )
        )
        current = following
    bind.execute(
        sa.text(
            f"CREATE TABLE IF NOT EXISTS {parent}_default PARTITION OF {parent} DEFAULT"
        )
    )


def _create_idempotency_tables() -> None:
    if not _table_exists("download_sessions"):
        op.create_table(
            "download_sessions",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("request_id", sa.String(length=128), nullable=False),
            sa.Column("response_payload", postgresql.JSONB(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "share_id",
                "request_id",
                name="uq_download_sessions_share_request",
            ),
        )
        op.create_index(
            "ix_download_sessions_created",
            "download_sessions",
            ["created_at"],
        )
    if not _table_exists("share_event_idempotency_keys"):
        op.create_table(
            "share_event_idempotency_keys",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("event_type", sa.String(length=32), nullable=False),
            sa.Column("request_id", sa.String(length=128), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint(
                "share_id",
                "event_type",
                "request_id",
                name="uq_share_event_idempotency",
            ),
        )
        op.create_index(
            "ix_share_event_idempotency_created",
            "share_event_idempotency_keys",
            ["created_at"],
        )


def _partition_share_access_events() -> None:
    if _is_partitioned("share_access_events"):
        return
    op.rename_table("share_access_events", "share_access_events_unpartitioned")
    op.create_table(
        "share_access_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True)),
        sa.Column("event_type", sa.String(length=32), nullable=False),
        sa.Column("ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(length=512)),
        sa.Column("guest_id", sa.String(length=64)),
        sa.Column("referer_host", sa.String(length=255)),
        sa.Column("client_kind", sa.String(length=32), server_default="unknown", nullable=False),
        sa.Column("confidence", sa.String(length=16), server_default="low", nullable=False),
        sa.Column("detector", sa.String(length=64)),
        sa.Column("request_id", sa.String(length=128)),
        sa.Column("http_status", sa.Integer()),
        sa.Column("request_time_ms", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", "created_at", name="pk_share_access_events_partitioned"),
        postgresql_partition_by="RANGE (created_at)",
    )
    _create_month_partitions("share_access_events", "created_at")
    op.execute(
        """
        INSERT INTO share_access_events (
            id, share_id, user_id, event_type, ip, user_agent, guest_id,
            referer_host, client_kind, confidence, detector, request_id,
            http_status, request_time_ms, created_at
        )
        SELECT id, share_id, user_id, event_type, ip, user_agent, guest_id,
            referer_host, client_kind, confidence, detector, request_id,
            http_status, request_time_ms, created_at
        FROM share_access_events_unpartitioned
        """
    )
    op.drop_table("share_access_events_unpartitioned")
    for index_name, columns in [
        ("ix_share_access_events_share_id", ["share_id"]),
        ("ix_share_access_events_user_id", ["user_id"]),
        ("ix_share_access_events_event_type", ["event_type"]),
        ("ix_share_access_events_guest_id", ["guest_id"]),
        ("ix_share_access_events_created_at", ["created_at"]),
        ("ix_share_access_events_share_created", ["share_id", "created_at"]),
        ("ix_share_access_events_share_type_created", ["share_id", "event_type", "created_at"]),
        ("ix_share_access_events_ip_created", ["ip", "created_at"]),
        ("ix_share_access_events_user_created", ["user_id", "created_at"]),
        ("ix_share_access_events_type_created", ["event_type", "created_at"]),
        ("ix_share_access_events_request", ["share_id", "event_type", "request_id"]),
    ]:
        op.create_index(index_name, "share_access_events", columns)


def _partition_download_logs() -> None:
    if _is_partitioned("download_logs"):
        return
    op.rename_table("download_logs", "download_logs_unpartitioned")
    op.create_table(
        "download_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ip", postgresql.INET()),
        sa.Column("ua", sa.String(length=512)),
        sa.Column("request_id", sa.String(length=128)),
        sa.Column("response_payload", postgresql.JSONB()),
        sa.Column("downloaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", "downloaded_at", name="pk_download_logs_partitioned"),
        postgresql_partition_by="RANGE (downloaded_at)",
    )
    _create_month_partitions("download_logs", "downloaded_at")
    op.execute(
        """
        INSERT INTO download_logs (
            id, share_id, ip, ua, request_id, response_payload, downloaded_at
        )
        SELECT id, share_id, ip, ua, request_id, response_payload, downloaded_at
        FROM download_logs_unpartitioned
        """
    )
    op.drop_table("download_logs_unpartitioned")
    for index_name, columns in [
        ("ix_download_logs_share_id", ["share_id"]),
        ("ix_download_logs_downloaded_at", ["downloaded_at"]),
        ("ix_download_logs_ip_downloaded", ["ip", "downloaded_at"]),
        ("ix_download_logs_share_request", ["share_id", "request_id"]),
    ]:
        op.create_index(index_name, "download_logs", columns)


def upgrade() -> None:
    _assert_offline_partitioning_allowed()
    _create_idempotency_tables()
    op.execute(
        """
        INSERT INTO download_sessions (id, share_id, request_id, response_payload, created_at)
        SELECT DISTINCT ON (share_id, request_id)
            id, share_id, request_id, '{}'::jsonb, downloaded_at
        FROM download_logs
        WHERE request_id IS NOT NULL AND response_payload IS NOT NULL
        ORDER BY share_id, request_id, downloaded_at DESC
        ON CONFLICT ON CONSTRAINT uq_download_sessions_share_request DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO share_event_idempotency_keys (
            id, share_id, event_type, request_id, created_at
        )
        SELECT DISTINCT ON (share_id, event_type, request_id)
            id, share_id, event_type, request_id, created_at
        FROM share_access_events
        WHERE request_id IS NOT NULL
        ORDER BY share_id, event_type, request_id, created_at DESC
        ON CONFLICT ON CONSTRAINT uq_share_event_idempotency DO NOTHING
        """
    )
    _partition_share_access_events()
    _partition_download_logs()


def _restore_unpartitioned_share_access_events() -> None:
    if not _is_partitioned("share_access_events"):
        return
    op.rename_table("share_access_events", "share_access_events_partitioned")
    op.create_table(
        "share_access_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True)),
        sa.Column("event_type", sa.String(length=32), nullable=False),
        sa.Column("ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(length=512)),
        sa.Column("guest_id", sa.String(length=64)),
        sa.Column("referer_host", sa.String(length=255)),
        sa.Column("client_kind", sa.String(length=32), nullable=False),
        sa.Column("confidence", sa.String(length=16), nullable=False),
        sa.Column("detector", sa.String(length=64)),
        sa.Column("request_id", sa.String(length=128)),
        sa.Column("http_status", sa.Integer()),
        sa.Column("request_time_ms", sa.Integer()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute("INSERT INTO share_access_events SELECT * FROM share_access_events_partitioned")
    op.execute("DROP TABLE share_access_events_partitioned CASCADE")
    op.create_index("ix_share_access_events_share_id", "share_access_events", ["share_id"])
    op.create_index("ix_share_access_events_user_id", "share_access_events", ["user_id"])
    op.create_index("ix_share_access_events_event_type", "share_access_events", ["event_type"])
    op.create_index("ix_share_access_events_guest_id", "share_access_events", ["guest_id"])
    op.create_index("ix_share_access_events_created_at", "share_access_events", ["created_at"])
    op.create_index("ix_share_access_events_share_created", "share_access_events", ["share_id", "created_at"])
    op.create_index(
        "ix_share_access_events_share_type_created",
        "share_access_events",
        ["share_id", "event_type", "created_at"],
    )
    op.create_index("ix_share_access_events_ip_created", "share_access_events", ["ip", "created_at"])
    op.create_index("ix_share_access_events_user_created", "share_access_events", ["user_id", "created_at"])
    op.create_index("ix_share_access_events_type_created", "share_access_events", ["event_type", "created_at"])
    op.create_index(
        "uq_share_access_events_request",
        "share_access_events",
        ["share_id", "event_type", "request_id"],
        unique=True,
        postgresql_where=sa.text("request_id IS NOT NULL"),
    )


def _restore_unpartitioned_download_logs() -> None:
    if not _is_partitioned("download_logs"):
        return
    op.rename_table("download_logs", "download_logs_partitioned")
    op.create_table(
        "download_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ip", postgresql.INET()),
        sa.Column("ua", sa.String(length=512)),
        sa.Column("request_id", sa.String(length=128)),
        sa.Column("response_payload", postgresql.JSONB()),
        sa.Column("downloaded_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.execute("INSERT INTO download_logs SELECT * FROM download_logs_partitioned")
    op.execute("DROP TABLE download_logs_partitioned CASCADE")
    op.create_index("ix_download_logs_share_id", "download_logs", ["share_id"])
    op.create_index("ix_download_logs_downloaded_at", "download_logs", ["downloaded_at"])
    op.create_index("ix_download_logs_ip_downloaded", "download_logs", ["ip", "downloaded_at"])
    op.create_index(
        "uq_download_logs_share_request",
        "download_logs",
        ["share_id", "request_id"],
        unique=True,
        postgresql_where=sa.text("request_id IS NOT NULL"),
    )


def _assert_downgrade_unique_compatible() -> None:
    bind = op.get_bind()
    checks = {
        "share_access_events": "share_id, event_type, request_id",
        "download_logs": "share_id, request_id",
    }
    for table_name, columns in checks.items():
        if not _table_exists(table_name):
            continue
        has_duplicates = bind.execute(
            sa.text(
                f"SELECT EXISTS (SELECT 1 FROM {table_name} "
                f"WHERE request_id IS NOT NULL GROUP BY {columns} HAVING count(*) > 1)"
            )
        ).scalar()
        if has_duplicates:
            raise RuntimeError(
                f"{table_name} 已包含可复用 request_id 的重复事件，旧版唯一约束无法表示，拒绝 downgrade"
            )


def downgrade() -> None:
    _assert_downgrade_unique_compatible()
    _restore_unpartitioned_share_access_events()
    _restore_unpartitioned_download_logs()
    if _table_exists("share_event_idempotency_keys"):
        op.drop_table("share_event_idempotency_keys")
    if _table_exists("download_sessions"):
        op.drop_table("download_sessions")
