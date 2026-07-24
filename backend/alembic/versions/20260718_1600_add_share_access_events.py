"""add share access events

Revision ID: 20260718_1600
Revises: 20260608_0200
Create Date: 2026-07-18 16:00:00.000000
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260718_1600"
down_revision = "20260608_0200"
branch_labels = None
depends_on = None


def _table_exists(table_name: str) -> bool:
    return table_name in sa.inspect(op.get_bind()).get_table_names()


def _index_exists(table_name: str, index_name: str) -> bool:
    return any(item["name"] == index_name for item in sa.inspect(op.get_bind()).get_indexes(table_name))


def upgrade() -> None:
    if not _table_exists("share_access_events"):
        op.create_table(
            "share_access_events",
            sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("event_type", sa.String(length=32), nullable=False),
            sa.Column("ip", postgresql.INET(), nullable=True),
            sa.Column("user_agent", sa.String(length=512), nullable=True),
            sa.Column("guest_id", sa.String(length=64), nullable=True),
            sa.Column("referer_host", sa.String(length=255), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
        )

    indexes = [
        ("ix_share_access_events_share_id", ["share_id"]),
        ("ix_share_access_events_user_id", ["user_id"]),
        ("ix_share_access_events_event_type", ["event_type"]),
        ("ix_share_access_events_guest_id", ["guest_id"]),
        ("ix_share_access_events_created_at", ["created_at"]),
        ("ix_share_access_events_share_created", ["share_id", "created_at"]),
        ("ix_share_access_events_ip_created", ["ip", "created_at"]),
        ("ix_share_access_events_user_created", ["user_id", "created_at"]),
    ]
    for index_name, columns in indexes:
        if not _index_exists("share_access_events", index_name):
            op.create_index(index_name, "share_access_events", columns, unique=False)

    if not _index_exists("auth_events", "ix_auth_events_ip_created"):
        op.create_index("ix_auth_events_ip_created", "auth_events", ["ip", "created_at"], unique=False)
    if not _index_exists("auth_sessions", "ix_auth_sessions_ip_created"):
        op.create_index("ix_auth_sessions_ip_created", "auth_sessions", ["ip", "created_at"], unique=False)


def downgrade() -> None:
    if _index_exists("auth_sessions", "ix_auth_sessions_ip_created"):
        op.drop_index("ix_auth_sessions_ip_created", table_name="auth_sessions")
    if _index_exists("auth_events", "ix_auth_events_ip_created"):
        op.drop_index("ix_auth_events_ip_created", table_name="auth_events")
    if _table_exists("share_access_events"):
        op.drop_table("share_access_events")
