"""version media assets

Revision ID: 20260729_1200
Revises: 20260727_1200
Create Date: 2026-07-29 12:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260729_1200"
down_revision = "20260727_1200"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(
        "uq_share_media_assets_logical_kind_format",
        "share_media_assets",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_share_media_assets_logical_kind_format_version",
        "share_media_assets",
        ["logical_file_id", "kind", "format", "processing_version"],
    )
    op.create_table(
        "media_object_cleanup_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("store_uri", sa.String(length=512), nullable=False),
        sa.Column("reason", sa.String(length=128), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("last_error", sa.String(length=2000)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("attempts >= 0", name=op.f("ck_media_object_cleanup_jobs_media_object_cleanup_job_attempts")),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_media_object_cleanup_jobs")),
        sa.UniqueConstraint("store_uri", name=op.f("uq_media_object_cleanup_jobs_store_uri")),
    )
    op.create_index(
        "ix_media_object_cleanup_jobs_available_at",
        "media_object_cleanup_jobs",
        ["available_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_media_object_cleanup_jobs_available_at", table_name="media_object_cleanup_jobs")
    op.drop_table("media_object_cleanup_jobs")
    op.execute(
        """
        DELETE FROM share_media_assets current
        USING share_media_assets newer
        WHERE current.logical_file_id = newer.logical_file_id
          AND current.kind = newer.kind
          AND current.format = newer.format
          AND (
            current.processing_version < newer.processing_version
            OR (
              current.processing_version = newer.processing_version
              AND current.created_at < newer.created_at
            )
          )
        """
    )
    op.drop_constraint(
        "uq_share_media_assets_logical_kind_format_version",
        "share_media_assets",
        type_="unique",
    )
    op.create_unique_constraint(
        "uq_share_media_assets_logical_kind_format",
        "share_media_assets",
        ["logical_file_id", "kind", "format"],
    )
