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
)
from sqlalchemy.dialects.postgresql import INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base, TimestampMixin


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
    revoke_token: Mapped[str | None] = mapped_column(String(64))
    # 上传时计算好的总字节，方便列表页展示
    total_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    # 仅保存空目录路径，目录项在 ZIP 打包时恢复
    empty_dirs: Mapped[list[str]] = mapped_column(JSONB, default=list, nullable=False)
    # 客户端上传批次幂等键；commit 重试时返回同一分享，避免重复创建
    upload_batch_id: Mapped[str | None] = mapped_column(String(64))

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
        Index("ix_shares_upload_batch_id", "upload_batch_id", unique=True),
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
    sort_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    original_name: Mapped[str] = mapped_column(String(512), nullable=False)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(127))
    chunk_total: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    media_metadata: Mapped[dict | None] = mapped_column(JSONB)

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
    downloaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
