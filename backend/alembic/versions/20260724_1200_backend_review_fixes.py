"""backend review transaction and retention fixes

Revision ID: 20260724_1200
Revises: 20260722_1200
Create Date: 2026-07-24 12:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260724_1200"
down_revision = "20260722_1200"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "email_deliveries",
        sa.Column("idempotency_key", sa.String(length=384)),
    )
    op.create_unique_constraint(
        "uq_email_deliveries_idempotency_key",
        "email_deliveries",
        ["idempotency_key"],
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT id, row_number() OVER (
                PARTITION BY parent_delivery_id ORDER BY created_at, id
            ) + 1 AS normalized_attempt
            FROM email_deliveries
            WHERE parent_delivery_id IS NOT NULL
        )
        UPDATE email_deliveries AS delivery
        SET attempt_number = ranked.normalized_attempt
        FROM ranked
        WHERE delivery.id = ranked.id
        """
    )
    op.create_unique_constraint(
        "uq_email_deliveries_parent_attempt",
        "email_deliveries",
        ["parent_delivery_id", "attempt_number"],
    )

    op.create_table(
        "mailbox_import_tombstones",
        sa.Column("maildir_key", sa.String(length=512), nullable=False),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("maildir_key"),
    )

    op.add_column(
        "download_sessions",
        sa.Column("expires_at", sa.DateTime(timezone=True)),
    )
    op.execute(
        "UPDATE download_sessions "
        "SET response_payload = '{}'::jsonb, expires_at = created_at + interval '5 minutes'"
    )
    op.alter_column("download_sessions", "expires_at", nullable=False)
    op.create_index(
        "ix_download_sessions_expires",
        "download_sessions",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_download_sessions_expires", table_name="download_sessions")
    op.drop_column("download_sessions", "expires_at")
    op.drop_table("mailbox_import_tombstones")
    op.drop_constraint(
        "uq_email_deliveries_parent_attempt",
        "email_deliveries",
        type_="unique",
    )
    op.drop_constraint(
        "uq_email_deliveries_idempotency_key",
        "email_deliveries",
        type_="unique",
    )
    op.drop_column("email_deliveries", "idempotency_key")
