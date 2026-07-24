"""add auth sessions and auth events tables

Revision ID: c1d2e3f4a5b6
Revises: a7b8c9d0e1f2
Create Date: 2026-06-07 12:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "c1d2e3f4a5b6"
down_revision: str | None = "a7b8c9d0e1f2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _table_exists(table_name: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table_name)


def _index_exists(table_name: str, index_name: str) -> bool:
    return any(index["name"] == index_name for index in sa.inspect(op.get_bind()).get_indexes(table_name))


def _create_index_if_missing(index_name: str, table_name: str, columns: list[str], *, unique: bool = False) -> None:
    if not _index_exists(table_name, index_name):
        op.create_index(index_name, table_name, columns, unique=unique)


def upgrade() -> None:
    # ── auth_sessions ──
    if not _table_exists("auth_sessions"):
        op.create_table(
            "auth_sessions",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "user_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("users.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("token_hash", sa.String(64), unique=True, nullable=False),
            sa.Column("family_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column(
                "rotated_from_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("auth_sessions.id", ondelete="SET NULL"),
            ),
            sa.Column("ip", sa.String(45)),
            sa.Column("user_agent", sa.String(512)),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("last_used_at", sa.DateTime(timezone=True)),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("revoked_at", sa.DateTime(timezone=True)),
            sa.Column("revoked_reason", sa.String(64)),
        )
    _create_index_if_missing("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    _create_index_if_missing("ix_auth_sessions_token_hash", "auth_sessions", ["token_hash"], unique=True)
    _create_index_if_missing("ix_auth_sessions_family_id", "auth_sessions", ["family_id"])
    _create_index_if_missing("ix_auth_sessions_expires_at", "auth_sessions", ["expires_at"])

    # ── auth_events ──
    if not _table_exists("auth_events"):
        op.create_table(
            "auth_events",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "user_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("users.id", ondelete="SET NULL"),
            ),
            sa.Column("email_hash", sa.String(64)),
            sa.Column("event_type", sa.String(64), nullable=False),
            sa.Column("success", sa.Boolean(), nullable=False, server_default="true"),
            sa.Column("ip", sa.String(45)),
            sa.Column("user_agent", sa.String(512)),
            sa.Column("reason", sa.Text()),
            sa.Column("extra_data", postgresql.JSONB()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
    _create_index_if_missing("ix_auth_events_user_id", "auth_events", ["user_id"])
    _create_index_if_missing("ix_auth_events_event_type", "auth_events", ["event_type"])
    _create_index_if_missing("ix_auth_events_created_at", "auth_events", ["created_at"])

    # ── 确保 admin@nyy.app 已验证 ──
    op.execute(
        "UPDATE users SET email_verified_at = NOW() "
        "WHERE email = 'admin@nyy.app' AND email_verified_at IS NULL"
    )


def downgrade() -> None:
    op.drop_table("auth_events")
    op.drop_table("auth_sessions")
