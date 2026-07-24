"""管理员本机邮箱消息、附件与 Maildir 导入来源。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, utcnow


class MailboxMessage(Base, TimestampMixin):
    """已归档的收件或发件；仅允许管理员从垃圾箱手动永久删除。"""

    __tablename__ = "mailbox_messages"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    thread_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    message_id: Mapped[str | None] = mapped_column(
        String(998)
    )
    in_reply_to: Mapped[str | None] = mapped_column(String(998), index=True)
    references: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    direction: Mapped[str] = mapped_column(
        String(16), default="inbound", server_default="inbound", nullable=False
    )
    delivery_status: Mapped[str] = mapped_column(
        String(16), default="received", server_default="received", nullable=False
    )

    from_addresses: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    to_addresses: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    cc_addresses: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    reply_to_addresses: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    subject: Mapped[str] = mapped_column(Text, default="", nullable=False)
    text_body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    html_body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )

    is_read: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    is_starred: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    is_archived: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    is_spam: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    is_trashed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )

    headers_summary: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    raw_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    raw_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    attachments: Mapped[list[MailboxAttachment]] = relationship(
        back_populates="message",
        cascade="save-update, merge",
        lazy="selectin",
    )
    import_sources: Mapped[list[MailboxImportSource]] = relationship(
        back_populates="message",
        cascade="save-update, merge",
        lazy="selectin",
    )

    __table_args__ = (
        UniqueConstraint("message_id", name="uq_mailbox_messages_message_id"),
        UniqueConstraint("raw_sha256", name="uq_mailbox_messages_raw_sha256"),
        Index("ix_mailbox_messages_message_id", "message_id"),
        Index("ix_mailbox_messages_raw_sha256", "raw_sha256"),
        CheckConstraint(
            "direction IN ('inbound', 'outbound')",
            name="mailbox_messages_direction",
        ),
        CheckConstraint(
            "delivery_status IN ('received', 'sent', 'failed')",
            name="mailbox_messages_delivery_status",
        ),
        Index(
            "ix_mailbox_messages_folder_received_id",
            "is_trashed",
            "is_spam",
            "is_archived",
            "received_at",
            "id",
        ),
        Index(
            "ix_mailbox_messages_thread_received_id",
            "thread_id",
            "received_at",
            "id",
        ),
    )


class MailboxAttachment(Base, TimestampMixin):
    """邮件附件元数据；磁盘文件名仅使用服务生成的 UUID。"""

    __tablename__ = "mailbox_attachments"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    mailbox_message_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mailbox_messages.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    filename: Mapped[str] = mapped_column(String(512), nullable=False)
    content_type: Mapped[str] = mapped_column(String(255), nullable=False)
    content_disposition: Mapped[str] = mapped_column(String(32), nullable=False)
    content_id: Mapped[str | None] = mapped_column(String(998))
    is_inline: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    storage_path: Mapped[str] = mapped_column(String(1024), nullable=False, unique=True)

    message: Mapped[MailboxMessage] = relationship(back_populates="attachments")


class MailboxImportSource(Base):
    """Maildir 唯一键到归档消息的映射，避免重复读取历史文件。"""

    __tablename__ = "mailbox_import_sources"

    maildir_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    mailbox_message_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("mailbox_messages.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    source_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    raw_sha256: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    raw_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    imported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    message: Mapped[MailboxMessage] = relationship(back_populates="import_sources")


class MailboxImportTombstone(Base):
    """已永久删除的 Maildir 唯一键，防止只读源中的邮件再次导入。"""

    __tablename__ = "mailbox_import_tombstones"

    maildir_key: Mapped[str] = mapped_column(String(512), primary_key=True)
    deleted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
