"""增长归因、邀请资格与留存券模型。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import INET, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class ViralClickEvent(Base):
    """分享页增长 CTA 点击事件。"""

    __tablename__ = "viral_click_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    share_code: Mapped[str] = mapped_column(String(16), nullable=False)
    request_id: Mapped[str] = mapped_column(String(128), nullable=False)
    visitor_id: Mapped[str | None] = mapped_column(String(64), index=True)
    guest_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(512))
    utm_source: Mapped[str | None] = mapped_column(String(128))
    utm_medium: Mapped[str | None] = mapped_column(String(128))
    utm_campaign: Mapped[str | None] = mapped_column(String(128))
    utm_term: Mapped[str | None] = mapped_column(String(128))
    utm_content: Mapped[str | None] = mapped_column(String(128))
    referrer: Mapped[str | None] = mapped_column(Text)
    personal_data_cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )

    __table_args__ = (
        UniqueConstraint(
            "share_id",
            "request_id",
            name="uq_viral_click_events_share_request",
        ),
        Index("ix_viral_click_events_created_id", "created_at", "id"),
    )


class GrowthLandingEvent(Base):
    """第一方落地页访问事件。"""

    __tablename__ = "growth_landing_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    request_id: Mapped[str] = mapped_column(String(128), nullable=False)
    visitor_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    guest_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(512))
    utm_source: Mapped[str | None] = mapped_column(String(128))
    utm_medium: Mapped[str | None] = mapped_column(String(128))
    utm_campaign: Mapped[str | None] = mapped_column(String(128))
    utm_term: Mapped[str | None] = mapped_column(String(128))
    utm_content: Mapped[str | None] = mapped_column(String(128))
    landing_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    referrer: Mapped[str | None] = mapped_column(Text)
    personal_data_cleared_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )

    __table_args__ = (
        UniqueConstraint(
            "visitor_id",
            "request_id",
            name="uq_growth_landing_events_visitor_request",
        ),
        Index("ix_growth_landing_events_created_id", "created_at", "id"),
    )


class ReferralAttribution(Base, TimestampMixin):
    """新用户唯一的第一方分享推荐归因。"""

    __tablename__ = "referral_attributions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    referrer_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    referred_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    source_share_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("shares.id", ondelete="SET NULL"), index=True
    )
    source_share_code: Mapped[str] = mapped_column(String(16), nullable=False)
    registration_guest_id: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending", nullable=False, index=True
    )
    status_reason: Mapped[str | None] = mapped_column(String(64))
    first_share_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("shares.id", ondelete="SET NULL"), index=True
    )
    human_interaction_event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
    )
    link_issued_event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
    )
    qualifying_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    qualifying_guest_id: Mapped[str | None] = mapped_column(String(64))
    qualified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint(
            "referred_user_id",
            name="uq_referral_attributions_referred_user_id",
        ),
        Index("ix_referral_attributions_referred_user_id", "referred_user_id"),
        CheckConstraint(
            "referrer_user_id <> referred_user_id",
            name="referral_distinct_users",
        ),
        CheckConstraint(
            "status IN ('pending', 'qualified', 'expired', 'rejected')",
            name="referral_status",
        ),
        Index(
            "ix_referral_attributions_referrer_status_created",
            "referrer_user_id",
            "status",
            "created_at",
        ),
    )


class RetentionCoupon(Base, TimestampMixin):
    """邀请合格后生成的 90 天分享留存券及跳过审计。"""

    __tablename__ = "retention_coupons"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    referral_attribution_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("referral_attributions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    beneficiary_role: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    status_reason: Mapped[str | None] = mapped_column(String(64))
    target_ttl_days: Mapped[int] = mapped_column(
        Integer, default=90, server_default="90", nullable=False
    )
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_by_share_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("shares.id", ondelete="SET NULL"), index=True
    )
    skipped_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint(
            "referral_attribution_id",
            "beneficiary_role",
            name="uq_retention_coupons_attribution_role",
        ),
        CheckConstraint(
            "beneficiary_role IN ('referrer', 'referred')",
            name="retention_coupon_beneficiary_role",
        ),
        CheckConstraint(
            "status IN ('available', 'consumed', 'expired', 'skipped')",
            name="retention_coupon_status",
        ),
        CheckConstraint("target_ttl_days = 90", name="retention_coupon_target_ttl"),
        Index(
            "ix_retention_coupons_owner_status_expires",
            "owner_id",
            "status",
            "expires_at",
        ),
    )
