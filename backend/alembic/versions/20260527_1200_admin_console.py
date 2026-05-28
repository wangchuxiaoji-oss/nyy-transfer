"""admin console

Revision ID: 9f8a1c2b3d4e
Revises: 45e930d4e7dc
Create Date: 2026-05-27 12:00:00.000000
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "9f8a1c2b3d4e"
down_revision: Union[str, None] = "45e930d4e7dc"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("shares", sa.Column("banned_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("shares", sa.Column("banned_reason", sa.String(length=255), nullable=True))
    op.create_table(
        "app_configs",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("updated_by", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["updated_by"], ["users.id"], name=op.f("fk_app_configs_updated_by_users"), ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_app_configs")),
    )


def downgrade() -> None:
    op.drop_table("app_configs")
    op.drop_column("shares", "banned_reason")
    op.drop_column("shares", "banned_at")
