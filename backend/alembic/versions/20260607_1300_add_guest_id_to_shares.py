"""add guest_id to shares

Revision ID: 20260607_1300
Revises: c1d2e3f4a5b6
Create Date: 2026-06-07 13:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260607_1300"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("shares", sa.Column("guest_id", sa.String(length=64), nullable=True))
    op.create_index("ix_shares_guest_id", "shares", ["guest_id"])
    op.create_index("ix_shares_guest_created", "shares", ["guest_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_shares_guest_created", table_name="shares")
    op.drop_index("ix_shares_guest_id", table_name="shares")
    op.drop_column("shares", "guest_id")
