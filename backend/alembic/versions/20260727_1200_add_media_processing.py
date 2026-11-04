"""add media assets and processing jobs

Revision ID: 20260727_1200
Revises: 20260726_1200
Create Date: 2026-07-27 12:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260727_1200"
down_revision = "20260726_1200"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "share_media_assets",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("logical_file_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False),
        sa.Column("format", sa.String(length=16), nullable=False),
        sa.Column("content_type", sa.String(length=127), nullable=False),
        sa.Column("store_uri", sa.String(length=512), nullable=False),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("byte_size", sa.BigInteger(), nullable=False),
        sa.Column("checksum", sa.String(length=64), nullable=False),
        sa.Column("processing_version", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "kind IN ('thumbnail_480', 'thumbnail_960', 'preview_2048', 'exif_json')",
            name=op.f("ck_share_media_assets_share_media_asset_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["logical_file_id"],
            ["share_logical_files.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_share_media_assets")),
        sa.UniqueConstraint(
            "logical_file_id",
            "kind",
            "format",
            name="uq_share_media_assets_logical_kind_format",
        ),
    )
    op.create_index(
        op.f("ix_share_media_assets_logical_file_id"),
        "share_media_assets",
        ["logical_file_id"],
    )

    op.create_table(
        "media_processing_jobs",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("logical_file_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "job_type",
            sa.String(length=32),
            server_default="image_derivatives",
            nullable=False,
        ),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("max_attempts", sa.Integer(), server_default="3", nullable=False),
        sa.Column("priority", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "available_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("locked_at", sa.DateTime(timezone=True)),
        sa.Column("locked_by", sa.String(length=128)),
        sa.Column("last_error", sa.String(length=2000)),
        sa.Column("processing_version", sa.Integer(), server_default="1", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "job_type = 'image_derivatives'",
            name=op.f("ck_media_processing_jobs_media_processing_job_type"),
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed', 'unsupported')",
            name=op.f("ck_media_processing_jobs_media_processing_job_status"),
        ),
        sa.CheckConstraint(
            "attempts >= 0",
            name=op.f("ck_media_processing_jobs_media_processing_job_attempts"),
        ),
        sa.CheckConstraint(
            "max_attempts > 0",
            name=op.f("ck_media_processing_jobs_media_processing_job_max_attempts"),
        ),
        sa.ForeignKeyConstraint(
            ["logical_file_id"],
            ["share_logical_files.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_media_processing_jobs")),
        sa.UniqueConstraint(
            "logical_file_id",
            "job_type",
            "processing_version",
            name="uq_media_processing_jobs_logical_type_version",
        ),
    )
    op.create_index(
        op.f("ix_media_processing_jobs_logical_file_id"),
        "media_processing_jobs",
        ["logical_file_id"],
    )
    op.create_index(
        "ix_media_processing_jobs_status_available_priority",
        "media_processing_jobs",
        ["status", "available_at", "priority"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_media_processing_jobs_status_available_priority",
        table_name="media_processing_jobs",
    )
    op.drop_index(
        op.f("ix_media_processing_jobs_logical_file_id"),
        table_name="media_processing_jobs",
    )
    op.drop_table("media_processing_jobs")
    op.drop_index(
        op.f("ix_share_media_assets_logical_file_id"),
        table_name="share_media_assets",
    )
    op.drop_table("share_media_assets")
