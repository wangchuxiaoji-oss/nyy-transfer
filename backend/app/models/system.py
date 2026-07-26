"""配额 / 黑名单 / 举报 / 审计。"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    PrimaryKeyConstraint,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin, utcnow


class IpQuota(Base):
    """每个 IP 每天的上传计数 / 字节数。主键 (ip, date)。"""

    __tablename__ = "ip_quotas"

    ip: Mapped[str] = mapped_column(INET, nullable=False)
    date: Mapped[date] = mapped_column(Date, nullable=False)
    upload_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    upload_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)

    __table_args__ = (PrimaryKeyConstraint("ip", "date", name="pk_ip_quotas"),)


class HashBlacklist(Base, TimestampMixin):
    """SHA256 黑名单。"""

    __tablename__ = "hash_blacklist"

    sha256: Mapped[str] = mapped_column(String(64), primary_key=True)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    note: Mapped[str | None] = mapped_column(String(255))


class AppConfig(Base, TimestampMixin):
    """可由 Admin 持久化管理的运行配置。"""

    __tablename__ = "app_configs"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONB, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )


class SystemAnnouncement(Base, TimestampMixin):
    """面向用户的版本更新、维护进度与事故公告。"""

    __tablename__ = "system_announcements"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    version: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    category: Mapped[str] = mapped_column(String(16), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False)
    priority: Mapped[str] = mapped_column(String(16), nullable=False)
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    summary: Mapped[str] = mapped_column(String(500), nullable=False)
    details: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), default="draft", server_default="draft", nullable=False
    )
    revision: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0", nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    visible_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )

    __table_args__ = (
        CheckConstraint(
            "category IN ('release', 'maintenance', 'incident')",
            name="system_announcement_category",
        ),
        CheckConstraint(
            "priority IN ('normal', 'important', 'critical')",
            name="system_announcement_priority",
        ),
        CheckConstraint(
            "status IN ('draft', 'published', 'archived')",
            name="system_announcement_status",
        ),
        CheckConstraint(
            "state IN ('released', 'scheduled', 'in_progress', 'completed', "
            "'investigating', 'monitoring', 'resolved', 'cancelled')",
            name="system_announcement_state",
        ),
        Index(
            "ix_system_announcements_status_published_id",
            "status",
            "published_at",
            "id",
        ),
        Index(
            "ix_system_announcements_category_state_published",
            "category",
            "state",
            "published_at",
        ),
    )


class Report(Base, TimestampMixin):
    """用户举报。"""

    __tablename__ = "reports"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    reporter_ip: Mapped[str | None] = mapped_column(INET)
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(2000))
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    resolution_note: Mapped[str | None] = mapped_column(String(1000))
    handled_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    handled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        Index("ix_reports_status_created_id", "status", "created_at", "id"),
    )


class FileRequest(Base, TimestampMixin):
    """反向分享：用户创建请求链接，访客向该用户上传文件。"""

    __tablename__ = "file_requests"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), default="文件请求", nullable=False)
    password_hash: Mapped[str | None] = mapped_column(String(255))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    max_files: Mapped[int] = mapped_column(Integer, default=20, nullable=False)
    max_bytes: Mapped[int] = mapped_column(BigInteger, default=1024 * 1024 * 1024, nullable=False)
    max_file_bytes: Mapped[int] = mapped_column(
        BigInteger, default=10 * 1024 * 1024 * 1024, server_default=str(10 * 1024 * 1024 * 1024), nullable=False
    )
    policy_version: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class FileRequestFile(Base, TimestampMixin):
    """文件请求收到的文件，仅请求创建者可见。"""

    __tablename__ = "file_request_files"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    request_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("file_requests.id", ondelete="CASCADE"), nullable=False, index=True
    )
    original_name: Mapped[str] = mapped_column(String(512), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(127))
    tos_uri: Mapped[str] = mapped_column(String(512), nullable=False)
    uploader_ip: Mapped[str | None] = mapped_column(INET)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)


class FileRequestUpload(Base, TimestampMixin):
    """收件上传批次与配额结算状态。"""

    __tablename__ = "file_request_uploads"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    request_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("file_requests.id", ondelete="CASCADE"), nullable=False
    )
    upload_batch_id: Mapped[str] = mapped_column(String(128), nullable=False)
    quota_reservation_ids: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb"), nullable=False
    )
    quota_batch_ids: Mapped[list[str]] = mapped_column(
        JSONB, default=list, server_default=text("'[]'::jsonb"), nullable=False
    )
    quota_legacy_bytes: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0", nullable=False)
    quota_settled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("request_id", "upload_batch_id", name="uq_file_request_upload_batch"),
    )


class EmailDelivery(Base, TimestampMixin):
    """分享链接邮件 outbox 与发送尝试记录。"""

    __tablename__ = "email_deliveries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("shares.id", ondelete="CASCADE"), nullable=False, index=True
    )
    recipient: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False, index=True)
    error: Mapped[str | None] = mapped_column(String(512))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delivery_type: Mapped[str] = mapped_column(
        String(32), default="share_link", server_default="share_link", nullable=False
    )
    attempt_number: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1", nullable=False
    )
    parent_delivery_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("email_deliveries.id", ondelete="SET NULL")
    )
    last_attempt_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    idempotency_key: Mapped[str | None] = mapped_column(String(384))

    __table_args__ = (
        UniqueConstraint("idempotency_key", name="uq_email_deliveries_idempotency_key"),
        UniqueConstraint(
            "parent_delivery_id",
            "attempt_number",
            name="uq_email_deliveries_parent_attempt",
        ),
        Index("ix_email_deliveries_status_created_id", "status", "created_at", "id"),
        Index("ix_email_deliveries_recipient_created", "recipient", "created_at"),
    )


class AuditLog(Base):
    """审计日志（管理员操作 / 关键状态变更）。"""

    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    actor_email: Mapped[str | None] = mapped_column(String(255))
    request_id: Mapped[str | None] = mapped_column(String(128), index=True)
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target: Mapped[str | None] = mapped_column(String(128))
    payload: Mapped[dict | None] = mapped_column(JSONB)
    target_type: Mapped[str | None] = mapped_column(String(64))
    target_id: Mapped[str | None] = mapped_column(String(128))
    before_value: Mapped[dict | None] = mapped_column(JSONB)
    after_value: Mapped[dict | None] = mapped_column(JSONB)
    reason: Mapped[str | None] = mapped_column(String(1000))
    note: Mapped[str | None] = mapped_column(String(2000))
    batch_id: Mapped[str | None] = mapped_column(String(128))
    success: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true", nullable=False)
    error_summary: Mapped[str | None] = mapped_column(String(1000))
    ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )

    __table_args__ = (
        Index("ix_audit_logs_created_id", "created_at", "id"),
        Index("ix_audit_logs_target", "target_type", "target_id", "created_at"),
        Index("ix_audit_logs_batch_action", "batch_id", "action"),
    )


class ArchiveBatch(Base):
    """分享归档执行批次；dry-run 不写批次。"""

    __tablename__ = "archive_batches"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False)
    candidate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    archived_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_summary: Mapped[str | None] = mapped_column(String(1000))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ArchivedShare(Base):
    """终态分享的只读归档摘要。"""

    __tablename__ = "archived_shares"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    original_share_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, nullable=False)
    archive_batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("archive_batches.id", ondelete="RESTRICT"), nullable=False
    )
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    code: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    title: Mapped[str | None] = mapped_column(String(255))
    terminal_status: Mapped[str] = mapped_column(String(32), nullable=False)
    metadata_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    file_summary: Mapped[list] = mapped_column(JSONB, nullable=False)
    total_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    logical_file_count: Mapped[int] = mapped_column(Integer, nullable=False)
    stored_object_count: Mapped[int] = mapped_column(Integer, nullable=False)
    original_created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("ix_archived_shares_archived_id", "archived_at", "id"),
    )
