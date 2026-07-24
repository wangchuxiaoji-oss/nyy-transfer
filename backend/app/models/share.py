"""Share / ShareFile / DownloadLog 模型。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin, utcnow


class Share(Base, TimestampMixin):
    """一次分享：一个短码 + 1..N 个文件。"""

    __tablename__ = "shares"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    code: Mapped[str] = mapped_column(String(16), unique=True, nullable=False, index=True)
    owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str | None] = mapped_column(String(255))
    # argon2 哈希；NULL 表示未设提取码
    password_hash: Mapped[str | None] = mapped_column(String(255))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    max_downloads: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    download_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    banned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    banned_reason: Mapped[str | None] = mapped_column(String(255))
    ip_created_from: Mapped[str | None] = mapped_column(INET)
    guest_id: Mapped[str | None] = mapped_column(String(64), index=True)
    revoke_token: Mapped[str | None] = mapped_column(String(64))
    # 上传时计算好的总字节，方便列表页展示
    total_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    # 仅保存空目录路径，目录项在 ZIP 打包时恢复
    empty_dirs: Mapped[list[str]] = mapped_column(
        JSONB,
        default=list,
        server_default=text("'[]'::jsonb"),
        nullable=False,
    )
    # 客户端上传批次幂等键；commit 重试时返回同一分享，避免重复创建
    upload_batch_id: Mapped[str | None] = mapped_column(String(64))
    logical_file_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0", nullable=False
    )
    stored_object_count: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0", nullable=False
    )
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    files: Mapped[list[ShareFile]] = relationship(
        "ShareFile",
        back_populates="share",
        cascade="all, delete-orphan",
        order_by="ShareFile.chunk_index",
    )
    logical_files: Mapped[list[ShareLogicalFile]] = relationship(
        "ShareLogicalFile",
        back_populates="share",
        cascade="all, delete-orphan",
        order_by="ShareLogicalFile.sort_index",
    )

    __table_args__ = (
        Index("ix_shares_owner_created", "owner_id", "created_at"),
        Index("ix_shares_guest_created", "guest_id", "created_at"),
        Index("ix_shares_upload_batch_id", "upload_batch_id", unique=True),
        Index("ix_shares_created_id", "created_at", "id"),
        Index("ix_shares_total_bytes_id", "total_bytes", "id"),
        Index("ix_shares_download_count_id", "download_count", "id"),
        Index("ix_shares_ip_created_from", "ip_created_from"),
        Index("ix_shares_last_activity_id", "last_activity_at", "id"),
        Index(
            "ix_shares_title_trgm",
            "title",
            postgresql_using="gin",
            postgresql_ops={"title": "gin_trgm_ops"},
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Share code={self.code} files={len(self.files) if self.files else 0}>"


class ShareLogicalFile(Base, TimestampMixin):
    """分享中的逻辑文件：单 chunk 小文件和多 chunk 大文件都对应 1 行。"""

    __tablename__ = "share_logical_files"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    sort_index: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0", nullable=False
    )
    original_name: Mapped[str] = mapped_column(String(512), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(127))
    chunk_total: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1", nullable=False
    )
    media_metadata: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )

    share: Mapped[Share] = relationship("Share", back_populates="logical_files")
    files: Mapped[list[ShareFile]] = relationship(
        "ShareFile",
        back_populates="logical_file",
        cascade="all, delete-orphan",
        order_by="ShareFile.chunk_index",
    )

    __table_args__ = (
        Index("ix_share_logical_files_share_sort", "share_id", "sort_index"),
    )


class ShareFile(Base, TimestampMixin):
    """分享下的单个文件（v1 单文件 = 1 行；v2 大文件分片 = N 行同一 logical_file_id）。"""

    __tablename__ = "share_files"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    original_name: Mapped[str] = mapped_column(String(512), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(127))
    tos_uri: Mapped[str] = mapped_column(String(512), nullable=False)
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    # 多分片时使用；普通文件 chunk_index=0 chunk_total=1
    chunk_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_total: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # 实际存储对象所属的逻辑文件；单 chunk 小文件也有对应 logical file。
    logical_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("share_logical_files.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    share: Mapped[Share] = relationship("Share", back_populates="files")
    logical_file: Mapped[ShareLogicalFile] = relationship("ShareLogicalFile", back_populates="files")

    __table_args__ = (
        Index("ix_share_files_logical_file", "share_id", "logical_file_id"),
        Index("ix_share_files_share_logical_chunk", "share_id", "logical_file_id", "chunk_index"),
    )


class DownloadLog(Base):
    """下载日志，用于配额 / 审计 / 反爆破。"""

    __tablename__ = "download_logs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    ip: Mapped[str | None] = mapped_column(INET)
    ua: Mapped[str | None] = mapped_column(String(512))
    request_id: Mapped[str | None] = mapped_column(String(128))
    response_payload: Mapped[dict | None] = mapped_column(JSONB)
    downloaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), primary_key=True, nullable=False, index=True
    )

    __table_args__ = (
        Index("ix_download_logs_ip_downloaded", "ip", "downloaded_at"),
        Index("ix_download_logs_share_request", "share_id", "request_id"),
    )


class DownloadSession(Base):
    """公开取链的短期幂等记录，仅保存不含签名 URL 的安全元数据。"""

    __tablename__ = "download_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
    )
    request_id: Mapped[str] = mapped_column(String(128), nullable=False)
    response_payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        UniqueConstraint("share_id", "request_id", name="uq_download_sessions_share_request"),
        Index("ix_download_sessions_created", "created_at"),
        Index("ix_download_sessions_expires", "expires_at"),
    )


class ShareAccessEvent(Base):
    """分享页面访问与下载链接签发事件。"""

    __tablename__ = "share_access_events"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="SET NULL"),
        index=True,
    )
    event_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    ip: Mapped[str | None] = mapped_column(INET)
    user_agent: Mapped[str | None] = mapped_column(String(512))
    guest_id: Mapped[str | None] = mapped_column(String(64), index=True)
    referer_host: Mapped[str | None] = mapped_column(String(255))
    client_kind: Mapped[str] = mapped_column(
        String(32), default="unknown", server_default="unknown", nullable=False
    )
    confidence: Mapped[str] = mapped_column(
        String(16), default="low", server_default="low", nullable=False
    )
    detector: Mapped[str | None] = mapped_column(String(64))
    request_id: Mapped[str | None] = mapped_column(String(128))
    http_status: Mapped[int | None] = mapped_column(Integer)
    request_time_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), primary_key=True, nullable=False, index=True
    )

    __table_args__ = (
        Index("ix_share_access_events_share_created", "share_id", "created_at"),
        Index("ix_share_access_events_share_type_created", "share_id", "event_type", "created_at"),
        Index("ix_share_access_events_ip_created", "ip", "created_at"),
        Index("ix_share_access_events_user_created", "user_id", "created_at"),
        Index("ix_share_access_events_type_created", "event_type", "created_at"),
        Index("ix_share_access_events_request", "share_id", "event_type", "request_id"),
    )


class ShareEventIdempotencyKey(Base):
    """访问埋点和边缘日志导入的跨分区幂等键。"""

    __tablename__ = "share_event_idempotency_keys"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    share_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("shares.id", ondelete="CASCADE"),
        nullable=False,
    )
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    request_id: Mapped[str] = mapped_column(String(128), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        UniqueConstraint(
            "share_id",
            "event_type",
            "request_id",
            name="uq_share_event_idempotency",
        ),
        Index("ix_share_event_idempotency_created", "created_at"),
    )
