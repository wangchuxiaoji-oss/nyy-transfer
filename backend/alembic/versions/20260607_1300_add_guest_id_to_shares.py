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


def _column_exists(table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in sa.inspect(op.get_bind()).get_columns(table_name))


def _index_exists(table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in sa.inspect(op.get_bind()).get_indexes(table_name))


def upgrade() -> None:
    if not _column_exists("shares", "guest_id"):
        op.add_column("shares", sa.Column("guest_id", sa.String(length=64), nullable=True))
    if not _index_exists("shares", "ix_shares_guest_id"):
        op.create_index("ix_shares_guest_id", "shares", ["guest_id"])
    if not _index_exists("shares", "ix_shares_guest_created"):
        op.create_index("ix_shares_guest_created", "shares", ["guest_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_shares_guest_created", table_name="shares")
    op.drop_index("ix_shares_guest_id", table_name="shares")
    op.drop_column("shares", "guest_id")
