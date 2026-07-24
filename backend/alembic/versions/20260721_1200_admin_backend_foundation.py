"""admin backend foundation

Revision ID: 20260721_1200
Revises: 20260718_1600
Create Date: 2026-07-21 12:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260721_1200"
down_revision = "20260718_1600"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    return column_name in {
        column["name"] for column in sa.inspect(op.get_bind()).get_columns(table_name)
    }


def _index_exists(table_name: str, index_name: str) -> bool:
    return any(
        item["name"] == index_name
        for item in sa.inspect(op.get_bind()).get_indexes(table_name)
    )


def _add_column(table_name: str, column: sa.Column) -> None:
    if not _column_exists(table_name, column.name):
        op.add_column(table_name, column)


def _create_index(
    index_name: str,
    table_name: str,
    columns: list[str],
    *,
    unique: bool = False,
    where: str | None = None,
) -> None:
    if _index_exists(table_name, index_name):
        return
    op.create_index(
        index_name,
        table_name,
        columns,
        unique=unique,
        postgresql_where=sa.text(where) if where else None,
    )


def upgrade() -> None:
    _add_column(
        "shares",
        sa.Column("logical_file_count", sa.Integer(), server_default="0", nullable=False),
    )
    _add_column(
        "shares",
        sa.Column("stored_object_count", sa.Integer(), server_default="0", nullable=False),
    )
    _add_column("shares", sa.Column("last_activity_at", sa.DateTime(timezone=True)))

    _add_column("download_logs", sa.Column("request_id", sa.String(length=128)))
    _add_column("download_logs", sa.Column("response_payload", postgresql.JSONB()))

    _add_column(
        "share_access_events",
        sa.Column("client_kind", sa.String(length=32), server_default="unknown", nullable=False),
    )
    _add_column(
        "share_access_events",
        sa.Column("confidence", sa.String(length=16), server_default="low", nullable=False),
    )
    _add_column("share_access_events", sa.Column("detector", sa.String(length=64)))
    _add_column("share_access_events", sa.Column("request_id", sa.String(length=128)))
    _add_column("share_access_events", sa.Column("http_status", sa.Integer()))
    _add_column("share_access_events", sa.Column("request_time_ms", sa.Integer()))

    _add_column("reports", sa.Column("resolution_note", sa.String(length=1000)))
    _add_column(
        "reports",
        sa.Column(
            "handled_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
        ),
    )
    _add_column("reports", sa.Column("handled_at", sa.DateTime(timezone=True)))

    _add_column(
        "email_deliveries",
        sa.Column("delivery_type", sa.String(length=32), server_default="share_link", nullable=False),
    )
    _add_column(
        "email_deliveries",
        sa.Column("attempt_number", sa.Integer(), server_default="1", nullable=False),
    )
    _add_column(
        "email_deliveries",
        sa.Column(
            "parent_delivery_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("email_deliveries.id", ondelete="SET NULL"),
        ),
    )
    _add_column("email_deliveries", sa.Column("last_attempt_at", sa.DateTime(timezone=True)))

    audit_columns = [
        sa.Column("actor_email", sa.String(length=255)),
        sa.Column("request_id", sa.String(length=128)),
        sa.Column("target_type", sa.String(length=64)),
        sa.Column("target_id", sa.String(length=128)),
        sa.Column("before_value", postgresql.JSONB()),
        sa.Column("after_value", postgresql.JSONB()),
        sa.Column("reason", sa.String(length=1000)),
        sa.Column("note", sa.String(length=2000)),
        sa.Column("batch_id", sa.String(length=128)),
        sa.Column("success", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("error_summary", sa.String(length=1000)),
        sa.Column("ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(length=512)),
    ]
    for column in audit_columns:
        _add_column("audit_logs", column)

    if "archive_batches" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "archive_batches",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("actor_id", postgresql.UUID(as_uuid=True)),
            sa.Column("status", sa.String(length=16), nullable=False),
            sa.Column("candidate_count", sa.Integer(), nullable=False),
            sa.Column("archived_count", sa.Integer(), nullable=False),
            sa.Column("error_summary", sa.String(length=1000)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("completed_at", sa.DateTime(timezone=True)),
            sa.ForeignKeyConstraint(["actor_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )

    if "archived_shares" not in sa.inspect(op.get_bind()).get_table_names():
        op.create_table(
            "archived_shares",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("original_share_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("archive_batch_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("owner_id", postgresql.UUID(as_uuid=True)),
            sa.Column("code", sa.String(length=16), nullable=False),
            sa.Column("title", sa.String(length=255)),
            sa.Column("terminal_status", sa.String(length=32), nullable=False),
            sa.Column("metadata_snapshot", postgresql.JSONB(), nullable=False),
            sa.Column("file_summary", postgresql.JSONB(), nullable=False),
            sa.Column("total_bytes", sa.BigInteger(), nullable=False),
            sa.Column("logical_file_count", sa.Integer(), nullable=False),
            sa.Column("stored_object_count", sa.Integer(), nullable=False),
            sa.Column("original_created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_activity_at", sa.DateTime(timezone=True)),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["archive_batch_id"], ["archive_batches.id"], ondelete="RESTRICT"),
            sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("original_share_id"),
        )
        op.create_index("ix_archived_shares_code", "archived_shares", ["code"])
        op.create_index(
            "ix_archived_shares_archived_id",
            "archived_shares",
            ["archived_at", "id"],
        )

    indexes = [
        ("ix_shares_created_id", "shares", ["created_at", "id"], False, None),
        ("ix_shares_total_bytes_id", "shares", ["total_bytes", "id"], False, None),
        ("ix_shares_download_count_id", "shares", ["download_count", "id"], False, None),
        ("ix_shares_ip_created_from", "shares", ["ip_created_from"], False, None),
        ("ix_shares_last_activity_id", "shares", ["last_activity_at", "id"], False, None),
        ("ix_download_logs_ip_downloaded", "download_logs", ["ip", "downloaded_at"], False, None),
        ("uq_download_logs_share_request", "download_logs", ["share_id", "request_id"], True, "request_id IS NOT NULL"),
        ("ix_share_access_events_type_created", "share_access_events", ["event_type", "created_at"], False, None),
        ("uq_share_access_events_request", "share_access_events", ["share_id", "event_type", "request_id"], True, "request_id IS NOT NULL"),
        ("ix_auth_events_user_type_success_created", "auth_events", ["user_id", "event_type", "success", "created_at"], False, None),
        ("ix_reports_status_created_id", "reports", ["status", "created_at", "id"], False, None),
        ("ix_email_deliveries_status_created_id", "email_deliveries", ["status", "created_at", "id"], False, None),
        ("ix_email_deliveries_recipient_created", "email_deliveries", ["recipient", "created_at"], False, None),
        ("ix_audit_logs_request_id", "audit_logs", ["request_id"], False, None),
        ("ix_audit_logs_created_id", "audit_logs", ["created_at", "id"], False, None),
        ("ix_audit_logs_target", "audit_logs", ["target_type", "target_id", "created_at"], False, None),
        ("ix_audit_logs_batch_action", "audit_logs", ["batch_id", "action"], False, None),
    ]
    for index_name, table_name, columns, unique, where in indexes:
        _create_index(index_name, table_name, columns, unique=unique, where=where)

    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    if not _index_exists("shares", "ix_shares_title_trgm"):
        op.execute(
            "CREATE INDEX ix_shares_title_trgm ON shares USING gin (title gin_trgm_ops)"
        )
    if not _index_exists("users", "ix_users_email_trgm"):
        op.execute(
            "CREATE INDEX ix_users_email_trgm ON users USING gin (email gin_trgm_ops)"
        )


def downgrade() -> None:
    for index_name, table_name in [
        ("ix_users_email_trgm", "users"),
        ("ix_shares_title_trgm", "shares"),
        ("ix_audit_logs_batch_action", "audit_logs"),
        ("ix_audit_logs_target", "audit_logs"),
        ("ix_audit_logs_created_id", "audit_logs"),
        ("ix_audit_logs_request_id", "audit_logs"),
        ("ix_email_deliveries_recipient_created", "email_deliveries"),
        ("ix_email_deliveries_status_created_id", "email_deliveries"),
        ("ix_reports_status_created_id", "reports"),
        ("ix_auth_events_user_type_success_created", "auth_events"),
        ("uq_share_access_events_request", "share_access_events"),
        ("ix_share_access_events_type_created", "share_access_events"),
        ("uq_download_logs_share_request", "download_logs"),
        ("ix_download_logs_ip_downloaded", "download_logs"),
        ("ix_shares_last_activity_id", "shares"),
        ("ix_shares_ip_created_from", "shares"),
        ("ix_shares_download_count_id", "shares"),
        ("ix_shares_total_bytes_id", "shares"),
        ("ix_shares_created_id", "shares"),
    ]:
        if _index_exists(table_name, index_name):
            op.drop_index(index_name, table_name=table_name)

    if "archived_shares" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("archived_shares")
    if "archive_batches" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_table("archive_batches")

    for table_name, column_names in [
        (
            "audit_logs",
            [
                "user_agent",
                "ip",
                "error_summary",
                "success",
                "batch_id",
                "note",
                "reason",
                "after_value",
                "before_value",
                "target_id",
                "target_type",
                "request_id",
                "actor_email",
            ],
        ),
        ("email_deliveries", ["last_attempt_at", "parent_delivery_id", "attempt_number", "delivery_type"]),
        ("reports", ["handled_at", "handled_by", "resolution_note"]),
        (
            "share_access_events",
            ["request_time_ms", "http_status", "request_id", "detector", "confidence", "client_kind"],
        ),
        ("download_logs", ["response_payload", "request_id"]),
        ("shares", ["last_activity_at", "stored_object_count", "logical_file_count"]),
    ]:
        for column_name in column_names:
            if _column_exists(table_name, column_name):
                op.drop_column(table_name, column_name)
