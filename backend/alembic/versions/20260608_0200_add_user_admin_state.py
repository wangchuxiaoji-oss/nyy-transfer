"""add user admin state fields

Revision ID: 20260608_0200
Revises: 20260608_0100
Create Date: 2026-06-08 02:00:00.000000
"""

import sqlalchemy as sa

from alembic import op

revision = "20260608_0200"
down_revision = "20260608_0100"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in sa.inspect(op.get_bind()).get_columns(table_name))


def upgrade() -> None:
    if not _column_exists("users", "disabled_at"):
        op.add_column("users", sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True))
    if not _column_exists("users", "deleted_at"):
        op.add_column("users", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    if _column_exists("users", "deleted_at"):
        op.drop_column("users", "deleted_at")
    if _column_exists("users", "disabled_at"):
        op.drop_column("users", "disabled_at")
