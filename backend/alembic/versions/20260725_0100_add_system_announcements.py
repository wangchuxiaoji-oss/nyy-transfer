"""add system announcements

Revision ID: 20260725_0100
Revises: 20260724_1200
Create Date: 2026-07-25 01:00:00.000000
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260725_0100"
down_revision = "20260724_1200"
branch_labels = None
depends_on = None

_INITIAL_ANNOUNCEMENT_ID = uuid.UUID("89c8f084-86fa-4fa8-a771-69d585297b1e")


def upgrade() -> None:
    published_at = datetime.now(UTC)
    table = op.create_table(
        "system_announcements",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("version", sa.String(length=64), nullable=False),
        sa.Column("category", sa.String(length=16), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("priority", sa.String(length=16), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("summary", sa.String(length=500), nullable=False),
        sa.Column(
            "details",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=16), server_default="draft", nullable=False),
        sa.Column("revision", sa.Integer(), server_default="0", nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        sa.Column("visible_until", sa.DateTime(timezone=True)),
        sa.Column("published_at", sa.DateTime(timezone=True)),
        sa.Column("archived_at", sa.DateTime(timezone=True)),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", postgresql.UUID(as_uuid=True)),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "category IN ('release', 'maintenance', 'incident')",
            name=op.f("ck_system_announcements_system_announcement_category"),
        ),
        sa.CheckConstraint(
            "priority IN ('normal', 'important', 'critical')",
            name=op.f("ck_system_announcements_system_announcement_priority"),
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'archived')",
            name=op.f("ck_system_announcements_system_announcement_status"),
        ),
        sa.CheckConstraint(
            "state IN ('released', 'scheduled', 'in_progress', 'completed', "
            "'investigating', 'monitoring', 'resolved', 'cancelled')",
            name=op.f("ck_system_announcements_system_announcement_state"),
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"], ["users.id"], ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_system_announcements")),
        sa.UniqueConstraint(
            "version", name=op.f("uq_system_announcements_version")
        ),
    )
    op.create_index(
        "ix_system_announcements_status_published_id",
        "system_announcements",
        ["status", "published_at", "id"],
    )
    op.create_index(
        "ix_system_announcements_category_state_published",
        "system_announcements",
        ["category", "state", "published_at"],
    )

    op.bulk_insert(
        table,
        [
            {
                "id": _INITIAL_ANNOUNCEMENT_ID,
                "version": "2026.07.25",
                "category": "maintenance",
                "state": "completed",
                "priority": "important",
                "title": "维护完成，上传和预览更稳定了",
                "summary": "本次维护已经完成。现在可以正常上传文件，常见 Office 文档和 PDF 也能直接在浏览器里预览。",
                "details": [
                    "修复了上传时提示“请先完成人机验证”而无法继续的问题。",
                    "Word、Excel、PPT 和 PDF 文件现在可以直接预览，无法预览时仍可下载。",
                    "优化了大文件上传、下载和分享链接的稳定性。",
                    "邮件通知和收件功能已经恢复，并完成了检查。",
                    "新增“最近更新”页面，以后可以随时查看新功能和维护结果。",
                ],
                "status": "published",
                "revision": 1,
                "started_at": datetime(2026, 7, 24, 15, 34, tzinfo=UTC),
                "completed_at": published_at,
                "visible_until": published_at + timedelta(days=90),
                "published_at": published_at,
                "archived_at": None,
                "updated_at": published_at,
                "created_by": None,
                "updated_by": None,
                "created_at": published_at,
            }
        ],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_system_announcements_category_state_published",
        table_name="system_announcements",
    )
    op.drop_index(
        "ix_system_announcements_status_published_id",
        table_name="system_announcements",
    )
    op.drop_table("system_announcements")
