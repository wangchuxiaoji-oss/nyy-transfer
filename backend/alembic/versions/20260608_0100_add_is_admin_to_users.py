"""add is_admin to users

Revision ID: 20260608_0100
Revises: 20260607_1300
Create Date: 2026-06-08 01:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260608_0100"
down_revision = "20260607_1300"
branch_labels = None
depends_on = None


def _column_exists(table_name: str, column_name: str) -> bool:
    return any(column["name"] == column_name for column in sa.inspect(op.get_bind()).get_columns(table_name))


def _constraint_exists(table_name: str, constraint_name: str) -> bool:
    return any(
        constraint["name"] == constraint_name
        for constraint in sa.inspect(op.get_bind()).get_check_constraints(table_name)
    )


def _index_exists(table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in sa.inspect(op.get_bind()).get_indexes(table_name))


def upgrade() -> None:
    if not _column_exists("users", "is_admin"):
        op.add_column(
            "users",
            sa.Column("is_admin", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        )
    op.execute("UPDATE users SET is_admin = true WHERE lower(email) = 'admin@nyy.app'")
    if not _constraint_exists("users", "ck_users_admin_email"):
        op.create_check_constraint(
            "ck_users_admin_email",
            "users",
            "is_admin IS FALSE OR lower(email) = 'admin@nyy.app'",
        )
    if not _index_exists("users", "uq_users_single_admin"):
        op.create_index(
            "uq_users_single_admin",
            "users",
            ["is_admin"],
            unique=True,
            postgresql_where=sa.text("is_admin IS TRUE"),
        )


def downgrade() -> None:
    op.drop_index("uq_users_single_admin", table_name="users")
    op.drop_constraint("ck_users_admin_email", "users", type_="check")
    op.drop_column("users", "is_admin")
