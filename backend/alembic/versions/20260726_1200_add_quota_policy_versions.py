"""add versioned quota policies

Revision ID: 20260726_1200
Revises: 20260725_0100
Create Date: 2026-07-26 12:00:00.000000
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260726_1200"
down_revision = "20260725_0100"
branch_labels = None
depends_on = None


def upgrade() -> None:
    now = datetime.now(UTC)
    initial_config = {
        "timezone": "Asia/Shanghai",
        "guest": {"period_kind": "daily", "period_limit_bytes": 2147483648, "max_file_bytes": 2147483648, "max_share_bytes": 2147483648, "max_files_per_share": 100, "max_empty_dirs_per_share": 100, "max_active_shares": 5, "max_concurrent_upload_batches": 1, "default_retention_hours": 1, "retention_options_hours": [1, 6, 24, 72], "default_max_downloads": 10, "download_options": [1, 10]},
        "user": {"period_kind": "monthly", "period_limit_bytes": 53687091200, "max_file_bytes": 10737418240, "max_share_bytes": 21474836480, "max_files_per_share": 500, "max_empty_dirs_per_share": 500, "max_active_shares": 30, "max_concurrent_upload_batches": 3, "default_retention_hours": 168, "retention_options_hours": [1, 6, 24, 72, 168, 360, 720], "default_max_downloads": 100, "download_options": [1, 10, 50, 100, 200, 0]},
        "receive": {"enabled": True, "max_active_requests": 10, "max_request_bytes": 10737418240, "max_file_bytes": 10737418240, "max_files_per_request": 100, "default_retention_hours": 168, "retention_options_hours": [24, 168, 720]},
        "retention_coupon_hours": 2160,
    }
    legacy = op.get_bind().execute(
        sa.text("SELECT value FROM app_configs WHERE key = 'quota'")
    ).scalar_one_or_none()
    if isinstance(legacy, dict):
        for audience in ("guest", "user"):
            period_limit = int(legacy.get(f"{audience}_max_file_bytes", initial_config[audience]["period_limit_bytes"]))
            initial_config[audience]["period_limit_bytes"] = period_limit
            initial_config[audience]["max_file_bytes"] = min(initial_config[audience]["max_file_bytes"], period_limit)
            initial_config[audience]["max_share_bytes"] = min(initial_config[audience]["max_share_bytes"], period_limit)
            initial_config[audience]["max_active_shares"] = int(legacy.get(f"{audience}_max_active_shares", initial_config[audience]["max_active_shares"]))
    op.add_column(
        "shares",
        sa.Column("policy_version", sa.Integer(), server_default="0", nullable=False),
    )
    op.add_column("shares", sa.Column("quota_scope", sa.String(length=16)))
    op.add_column("shares", sa.Column("quota_identity", sa.String(length=128)))
    op.add_column("shares", sa.Column("quota_reservation_ids", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False))
    op.add_column("shares", sa.Column("quota_batch_ids", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False))
    op.add_column("shares", sa.Column("quota_legacy_bytes", sa.BigInteger(), server_default="0", nullable=False))
    op.add_column("shares", sa.Column("quota_settled_at", sa.DateTime(timezone=True)))
    op.drop_index("ix_shares_upload_batch_id", table_name="shares")
    op.create_index(
        "ix_shares_owner_upload_batch_id",
        "shares",
        ["owner_id", "upload_batch_id"],
        unique=True,
        postgresql_where=sa.text("owner_id IS NOT NULL AND upload_batch_id IS NOT NULL"),
    )
    op.create_index(
        "ix_shares_guest_upload_batch_id",
        "shares",
        ["guest_id", "upload_batch_id"],
        unique=True,
        postgresql_where=sa.text("owner_id IS NULL AND guest_id IS NOT NULL AND upload_batch_id IS NOT NULL"),
    )
    op.add_column(
        "file_requests",
        sa.Column("max_file_bytes", sa.BigInteger(), server_default=str(10 * 1024**3), nullable=False),
    )
    op.add_column(
        "file_requests",
        sa.Column("policy_version", sa.Integer(), server_default="0", nullable=False),
    )
    op.create_table(
        "file_request_uploads",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("request_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("upload_batch_id", sa.String(length=128), nullable=False),
        sa.Column("quota_reservation_ids", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("quota_batch_ids", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False),
        sa.Column("quota_legacy_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("quota_settled_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["request_id"], ["file_requests.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_file_request_uploads")),
        sa.UniqueConstraint("request_id", "upload_batch_id", name="uq_file_request_upload_batch"),
    )
    table = op.create_table(
        "quota_policy_versions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True)),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True)),
        sa.Column("published_by", postgresql.UUID(as_uuid=True)),
        sa.Column("rollback_from_id", postgresql.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'scheduled')",
            name=op.f("ck_quota_policy_versions_quota_policy_version_status"),
        ),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["published_by"], ["users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["rollback_from_id"], ["quota_policy_versions.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_quota_policy_versions")),
        sa.UniqueConstraint("version", name=op.f("uq_quota_policy_versions_version")),
    )
    op.create_index(
        "ix_quota_policy_versions_status_effective_version",
        "quota_policy_versions",
        ["status", "effective_at", "version"],
    )
    op.bulk_insert(table, [{
        "id": uuid.uuid4(),
        "version": 1,
        "status": "published",
        "config": initial_config,
        "note": "初始生产配额策略",
        "effective_at": now,
        "published_at": now,
        "updated_at": now,
        "created_by": None,
        "published_by": None,
        "rollback_from_id": None,
        "created_at": now,
    }])
    op.execute("UPDATE shares SET policy_version = 1 WHERE policy_version = 0")
    op.execute("UPDATE file_requests SET policy_version = 1 WHERE policy_version = 0")
    op.execute("UPDATE shares SET quota_settled_at = now() WHERE quota_scope IS NULL")


def downgrade() -> None:
    op.drop_index("ix_quota_policy_versions_status_effective_version", table_name="quota_policy_versions")
    op.drop_table("quota_policy_versions")
    op.drop_table("file_request_uploads")
    op.drop_column("file_requests", "policy_version")
    op.drop_column("file_requests", "max_file_bytes")
    op.drop_column("shares", "quota_settled_at")
    op.drop_column("shares", "quota_legacy_bytes")
    op.drop_column("shares", "quota_batch_ids")
    op.drop_column("shares", "quota_reservation_ids")
    op.drop_column("shares", "quota_identity")
    op.drop_column("shares", "quota_scope")
    op.drop_index("ix_shares_guest_upload_batch_id", table_name="shares")
    op.drop_index("ix_shares_owner_upload_batch_id", table_name="shares")
    op.create_index("ix_shares_upload_batch_id", "shares", ["upload_batch_id"], unique=True)
    op.drop_column("shares", "policy_version")
