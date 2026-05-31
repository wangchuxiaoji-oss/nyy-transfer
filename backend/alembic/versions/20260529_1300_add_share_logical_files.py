"""add logical file table with media metadata

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-05-29 13:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "share_logical_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sort_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("original_name", sa.String(length=512), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("content_type", sa.String(length=127), nullable=True),
        sa.Column("chunk_total", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("media_metadata", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["share_id"], ["shares.id"], name=op.f("fk_share_logical_files_share_id_shares"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_share_logical_files")),
    )
    op.create_index(op.f("ix_share_logical_files_share_id"), "share_logical_files", ["share_id"], unique=False)
    op.create_index("ix_share_logical_files_share_sort", "share_logical_files", ["share_id", "sort_index"], unique=False)

    op.execute(
        """
        WITH grouped AS (
            SELECT
                COALESCE(logical_file_id, id) AS logical_id,
                share_id,
                (array_agg(original_name ORDER BY chunk_index, created_at, id))[1] AS original_name,
                SUM(size)::bigint AS size,
                (array_agg(content_type ORDER BY chunk_index, created_at, id))[1] AS content_type,
                GREATEST(MAX(chunk_total), COUNT(*))::integer AS chunk_total,
                MIN(chunk_index) AS first_chunk_index,
                MIN(created_at) AS first_created_at
            FROM share_files
            GROUP BY share_id, COALESCE(logical_file_id, id)
        ), numbered AS (
            SELECT
                logical_id,
                share_id,
                ROW_NUMBER() OVER (PARTITION BY share_id ORDER BY first_created_at, first_chunk_index, logical_id)::integer - 1 AS sort_index,
                original_name,
                size,
                content_type,
                chunk_total,
                first_created_at
            FROM grouped
        )
        INSERT INTO share_logical_files (
            id, share_id, sort_index, original_name, size, content_type, chunk_total, media_metadata, created_at
        )
        SELECT logical_id, share_id, sort_index, original_name, size, content_type, chunk_total, NULL, first_created_at
        FROM numbered
        """
    )
    op.execute("UPDATE share_files SET logical_file_id = id WHERE logical_file_id IS NULL")

    op.alter_column(
        "share_files",
        "logical_file_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.create_foreign_key(
        op.f("fk_share_files_logical_file_id_share_logical_files"),
        "share_files",
        "share_logical_files",
        ["logical_file_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(op.f("ix_share_files_logical_file_id"), "share_files", ["logical_file_id"], unique=False)
    op.create_index("ix_share_files_share_logical_chunk", "share_files", ["share_id", "logical_file_id", "chunk_index"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_share_files_share_logical_chunk", table_name="share_files")
    op.drop_index(op.f("ix_share_files_logical_file_id"), table_name="share_files")
    op.drop_constraint(op.f("fk_share_files_logical_file_id_share_logical_files"), "share_files", type_="foreignkey")
    op.alter_column(
        "share_files",
        "logical_file_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )
    op.drop_index("ix_share_logical_files_share_sort", table_name="share_logical_files")
    op.drop_index(op.f("ix_share_logical_files_share_id"), table_name="share_logical_files")
    op.drop_table("share_logical_files")
