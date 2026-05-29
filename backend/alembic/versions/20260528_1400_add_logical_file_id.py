"""add logical_file_id to share_files for chunked large file support

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-05-28 14:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "share_files",
        sa.Column("logical_file_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_index(
        "ix_share_files_logical_file",
        "share_files",
        ["share_id", "logical_file_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_share_files_logical_file", table_name="share_files")
    op.drop_column("share_files", "logical_file_id")
