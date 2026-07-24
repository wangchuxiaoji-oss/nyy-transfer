"""add growth attribution and admin mailbox

Revision ID: 20260722_1200
Revises: 20260721_1800
Create Date: 2026-07-22 12:00:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "20260722_1200"
down_revision = "20260721_1800"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "viral_click_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("share_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("share_code", sa.String(length=16), nullable=False),
        sa.Column("request_id", sa.String(length=128), nullable=False),
        sa.Column("visitor_id", sa.String(length=64)),
        sa.Column("guest_id", sa.String(length=64), nullable=False),
        sa.Column("ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(length=512)),
        sa.Column("utm_source", sa.String(length=128)),
        sa.Column("utm_medium", sa.String(length=128)),
        sa.Column("utm_campaign", sa.String(length=128)),
        sa.Column("utm_term", sa.String(length=128)),
        sa.Column("utm_content", sa.String(length=128)),
        sa.Column("referrer", sa.Text()),
        sa.Column("personal_data_cleared_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["share_id"], ["shares.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("share_id", "request_id", name="uq_viral_click_events_share_request"),
    )
    op.create_index("ix_viral_click_events_share_id", "viral_click_events", ["share_id"])
    op.create_index("ix_viral_click_events_visitor_id", "viral_click_events", ["visitor_id"])
    op.create_index("ix_viral_click_events_guest_id", "viral_click_events", ["guest_id"])
    op.create_index("ix_viral_click_events_created_at", "viral_click_events", ["created_at"])
    op.create_index("ix_viral_click_events_created_id", "viral_click_events", ["created_at", "id"])

    op.create_table(
        "growth_landing_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("request_id", sa.String(length=128), nullable=False),
        sa.Column("visitor_id", sa.String(length=64), nullable=False),
        sa.Column("guest_id", sa.String(length=64), nullable=False),
        sa.Column("ip", postgresql.INET()),
        sa.Column("user_agent", sa.String(length=512)),
        sa.Column("utm_source", sa.String(length=128)),
        sa.Column("utm_medium", sa.String(length=128)),
        sa.Column("utm_campaign", sa.String(length=128)),
        sa.Column("utm_term", sa.String(length=128)),
        sa.Column("utm_content", sa.String(length=128)),
        sa.Column("landing_path", sa.String(length=1024), nullable=False),
        sa.Column("referrer", sa.Text()),
        sa.Column("personal_data_cleared_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("visitor_id", "request_id", name="uq_growth_landing_events_visitor_request"),
    )
    op.create_index("ix_growth_landing_events_visitor_id", "growth_landing_events", ["visitor_id"])
    op.create_index("ix_growth_landing_events_guest_id", "growth_landing_events", ["guest_id"])
    op.create_index("ix_growth_landing_events_created_at", "growth_landing_events", ["created_at"])
    op.create_index("ix_growth_landing_events_created_id", "growth_landing_events", ["created_at", "id"])

    op.create_table(
        "referral_attributions",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("referrer_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("referred_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_share_id", postgresql.UUID(as_uuid=True)),
        sa.Column("source_share_code", sa.String(length=16), nullable=False),
        sa.Column("registration_guest_id", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("status_reason", sa.String(length=64)),
        sa.Column("first_share_id", postgresql.UUID(as_uuid=True)),
        sa.Column("human_interaction_event_id", postgresql.UUID(as_uuid=True)),
        sa.Column("link_issued_event_id", postgresql.UUID(as_uuid=True)),
        sa.Column("qualifying_user_id", postgresql.UUID(as_uuid=True)),
        sa.Column("qualifying_guest_id", sa.String(length=64)),
        sa.Column("qualified_at", sa.DateTime(timezone=True)),
        sa.Column("closed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("referrer_user_id <> referred_user_id", name="referral_distinct_users"),
        sa.CheckConstraint("status IN ('pending', 'qualified', 'expired', 'rejected')", name="referral_status"),
        sa.ForeignKeyConstraint(["referrer_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["referred_user_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["source_share_id"], ["shares.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["first_share_id"], ["shares.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["qualifying_user_id"], ["users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("referred_user_id"),
    )
    op.create_index("ix_referral_attributions_referrer_user_id", "referral_attributions", ["referrer_user_id"])
    op.create_index("ix_referral_attributions_referred_user_id", "referral_attributions", ["referred_user_id"])
    op.create_index("ix_referral_attributions_source_share_id", "referral_attributions", ["source_share_id"])
    op.create_index("ix_referral_attributions_status", "referral_attributions", ["status"])
    op.create_index("ix_referral_attributions_first_share_id", "referral_attributions", ["first_share_id"])
    op.create_index("ix_referral_attributions_qualified_at", "referral_attributions", ["qualified_at"])
    op.create_index("ix_referral_attributions_referrer_status_created", "referral_attributions", ["referrer_user_id", "status", "created_at"])

    op.create_table(
        "retention_coupons",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("referral_attribution_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("beneficiary_role", sa.String(length=16), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("status_reason", sa.String(length=64)),
        sa.Column("target_ttl_days", sa.Integer(), server_default="90", nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True)),
        sa.Column("expires_at", sa.DateTime(timezone=True)),
        sa.Column("consumed_at", sa.DateTime(timezone=True)),
        sa.Column("consumed_by_share_id", postgresql.UUID(as_uuid=True)),
        sa.Column("skipped_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("beneficiary_role IN ('referrer', 'referred')", name="retention_coupon_beneficiary_role"),
        sa.CheckConstraint("status IN ('available', 'consumed', 'expired', 'skipped')", name="retention_coupon_status"),
        sa.CheckConstraint("target_ttl_days = 90", name="retention_coupon_target_ttl"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["referral_attribution_id"], ["referral_attributions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["consumed_by_share_id"], ["shares.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("referral_attribution_id", "beneficiary_role", name="uq_retention_coupons_attribution_role"),
    )
    op.create_index("ix_retention_coupons_owner_id", "retention_coupons", ["owner_id"])
    op.create_index("ix_retention_coupons_referral_attribution_id", "retention_coupons", ["referral_attribution_id"])
    op.create_index("ix_retention_coupons_status", "retention_coupons", ["status"])
    op.create_index("ix_retention_coupons_expires_at", "retention_coupons", ["expires_at"])
    op.create_index("ix_retention_coupons_consumed_by_share_id", "retention_coupons", ["consumed_by_share_id"])
    op.create_index("ix_retention_coupons_owner_status_expires", "retention_coupons", ["owner_id", "status", "expires_at"])

    op.create_table(
        "mailbox_messages",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("thread_id", sa.String(length=64), nullable=False),
        sa.Column("message_id", sa.String(length=998)),
        sa.Column("in_reply_to", sa.String(length=998)),
        sa.Column("references", postgresql.JSONB(), nullable=False),
        sa.Column("direction", sa.String(length=16), server_default="inbound", nullable=False),
        sa.Column("delivery_status", sa.String(length=16), server_default="received", nullable=False),
        sa.Column("from_addresses", postgresql.JSONB(), nullable=False),
        sa.Column("to_addresses", postgresql.JSONB(), nullable=False),
        sa.Column("cc_addresses", postgresql.JSONB(), nullable=False),
        sa.Column("reply_to_addresses", postgresql.JSONB(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("text_body", sa.Text(), nullable=False),
        sa.Column("html_body", sa.Text(), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_read", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_starred", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_archived", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_spam", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("is_trashed", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("headers_summary", postgresql.JSONB(), nullable=False),
        sa.Column("raw_sha256", sa.String(length=64), nullable=False),
        sa.Column("raw_path", sa.String(length=1024), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("direction IN ('inbound', 'outbound')", name="mailbox_messages_direction"),
        sa.CheckConstraint("delivery_status IN ('received', 'sent', 'failed')", name="mailbox_messages_delivery_status"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("message_id"),
        sa.UniqueConstraint("raw_sha256"),
    )
    op.create_index("ix_mailbox_messages_thread_id", "mailbox_messages", ["thread_id"])
    op.create_index("ix_mailbox_messages_message_id", "mailbox_messages", ["message_id"])
    op.create_index("ix_mailbox_messages_in_reply_to", "mailbox_messages", ["in_reply_to"])
    op.create_index("ix_mailbox_messages_sent_at", "mailbox_messages", ["sent_at"])
    op.create_index("ix_mailbox_messages_received_at", "mailbox_messages", ["received_at"])
    op.create_index("ix_mailbox_messages_raw_sha256", "mailbox_messages", ["raw_sha256"])
    op.create_index("ix_mailbox_messages_folder_received_id", "mailbox_messages", ["is_trashed", "is_spam", "is_archived", "received_at", "id"])
    op.create_index("ix_mailbox_messages_thread_received_id", "mailbox_messages", ["thread_id", "received_at", "id"])

    op.create_table(
        "mailbox_attachments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("mailbox_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("filename", sa.String(length=512), nullable=False),
        sa.Column("content_type", sa.String(length=255), nullable=False),
        sa.Column("content_disposition", sa.String(length=32), nullable=False),
        sa.Column("content_id", sa.String(length=998)),
        sa.Column("is_inline", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("storage_path", sa.String(length=1024), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["mailbox_message_id"], ["mailbox_messages.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("storage_path"),
    )
    op.create_index("ix_mailbox_attachments_mailbox_message_id", "mailbox_attachments", ["mailbox_message_id"])
    op.create_index("ix_mailbox_attachments_sha256", "mailbox_attachments", ["sha256"])

    op.create_table(
        "mailbox_import_sources",
        sa.Column("maildir_key", sa.String(length=512), nullable=False),
        sa.Column("mailbox_message_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("source_path", sa.String(length=1024), nullable=False),
        sa.Column("raw_sha256", sa.String(length=64), nullable=False),
        sa.Column("raw_path", sa.String(length=1024), nullable=False),
        sa.Column("size", sa.BigInteger(), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["mailbox_message_id"], ["mailbox_messages.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("maildir_key"),
    )
    op.create_index("ix_mailbox_import_sources_mailbox_message_id", "mailbox_import_sources", ["mailbox_message_id"])
    op.create_index("ix_mailbox_import_sources_raw_sha256", "mailbox_import_sources", ["raw_sha256"])


def downgrade() -> None:
    op.drop_table("mailbox_import_sources")
    op.drop_table("mailbox_attachments")
    op.drop_table("mailbox_messages")
    op.drop_table("retention_coupons")
    op.drop_table("referral_attributions")
    op.drop_table("growth_landing_events")
    op.drop_table("viral_click_events")
