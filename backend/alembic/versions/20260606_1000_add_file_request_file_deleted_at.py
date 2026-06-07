"""add soft delete marker to received request files

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-06-06 10:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa

from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("file_request_files", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f("ix_file_request_files_deleted_at"), "file_request_files", ["deleted_at"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_file_request_files_deleted_at"), table_name="file_request_files")
    op.drop_column("file_request_files", "deleted_at")
