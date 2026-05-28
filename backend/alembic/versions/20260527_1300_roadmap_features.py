"""roadmap features

Revision ID: a1b2c3d4e5f6
Revises: 9f8a1c2b3d4e
Create Date: 2026-05-27 13:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, None] = "9f8a1c2b3d4e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "file_requests",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("code", sa.String(length=16), nullable=False),
        sa.Column("owner_id", sa.UUID(), nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("password_hash", sa.String(length=255), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_files", sa.Integer(), nullable=False),
        sa.Column("max_bytes", sa.BigInteger(), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], name=op.f("fk_file_requests_owner_id_users"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_file_requests")),
    )
    op.create_index(op.f("ix_file_requests_code"), "file_requests", ["code"], unique=True)
    op.create_index(op.f("ix_file_requests_expires_at"), "file_requests", ["expires_at"], unique=False)
    op.create_index(op.f("ix_file_requests_owner_id"), "file_requests", ["owner_id"], unique=False)

    op.create_table(
        "file_request_files",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("request_id", sa.UUID(), nullable=False),
        sa.Column("original_name", sa.String(length=512), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("content_type", sa.String(length=127), nullable=True),
        sa.Column("tos_uri", sa.String(length=512), nullable=False),
        sa.Column("uploader_ip", postgresql.INET(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["request_id"], ["file_requests.id"], name=op.f("fk_file_request_files_request_id_file_requests"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_file_request_files")),
    )
    op.create_index(op.f("ix_file_request_files_request_id"), "file_request_files", ["request_id"], unique=False)

    op.create_table(
        "email_deliveries",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("share_id", sa.UUID(), nullable=False),
        sa.Column("recipient", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("error", sa.String(length=512), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["share_id"], ["shares.id"], name=op.f("fk_email_deliveries_share_id_shares"), ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_deliveries")),
    )
    op.create_index(op.f("ix_email_deliveries_share_id"), "email_deliveries", ["share_id"], unique=False)
    op.create_index(op.f("ix_email_deliveries_status"), "email_deliveries", ["status"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_email_deliveries_status"), table_name="email_deliveries")
    op.drop_index(op.f("ix_email_deliveries_share_id"), table_name="email_deliveries")
    op.drop_table("email_deliveries")
    op.drop_index(op.f("ix_file_request_files_request_id"), table_name="file_request_files")
    op.drop_table("file_request_files")
    op.drop_index(op.f("ix_file_requests_owner_id"), table_name="file_requests")
    op.drop_index(op.f("ix_file_requests_expires_at"), table_name="file_requests")
    op.drop_index(op.f("ix_file_requests_code"), table_name="file_requests")
    op.drop_table("file_requests")
