"""add upload_batch_id to shares for idempotent commits

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-05-29 11:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("shares", sa.Column("upload_batch_id", sa.String(length=64), nullable=True))
    op.create_index("ix_shares_upload_batch_id", "shares", ["upload_batch_id"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_shares_upload_batch_id", table_name="shares")
    op.drop_column("shares", "upload_batch_id")
