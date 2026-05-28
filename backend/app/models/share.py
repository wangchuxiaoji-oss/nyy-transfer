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

    files: Mapped[list[ShareFile]] = relationship(
        "ShareFile",
        back_populates="share",
        cascade="all, delete-orphan",
        order_by="ShareFile.chunk_index",
    )

    __table_args__ = (
        Index("ix_shares_owner_created", "owner_id", "created_at"),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Share code={self.code} files={len(self.files) if self.files else 0}>"


class ShareFile(Base, TimestampMixin):
    """分享下的单个文件（v1 单文件 = 1 行；v1.5 多分片 = N 行同一 share_id）。"""

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
    # 多分片时使用；v1 单分片 chunk_index=0 chunk_total=1
    chunk_index: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunk_total: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    share: Mapped[Share] = relationship("Share", back_populates="files")


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
