"""配额 / 黑名单 / 举报 / 审计。"""

from __future__ import annotations

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    PrimaryKeyConstraint,
    String,
)
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


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


class EmailDelivery(Base, TimestampMixin):
    """分享链接邮件发送记录。"""

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


class AuditLog(Base):
    """审计日志（管理员操作 / 关键状态变更）。"""

    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL")
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target: Mapped[str | None] = mapped_column(String(128))
    payload: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
