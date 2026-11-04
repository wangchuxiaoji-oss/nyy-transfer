"""分享媒体派生资产与持久化处理任务模型。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, utcnow


class ShareMediaAsset(Base):
    """逻辑文件对应的媒体派生资产。"""

    __tablename__ = "share_media_assets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    logical_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("share_logical_files.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    format: Mapped[str] = mapped_column(String(16), nullable=False)
    content_type: Mapped[str] = mapped_column(String(127), nullable=False)
    store_uri: Mapped[str] = mapped_column(String(512), nullable=False)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    byte_size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    checksum: Mapped[str] = mapped_column(String(64), nullable=False)
    processing_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )

    __table_args__ = (
        CheckConstraint(
            "kind IN ('thumbnail_480', 'thumbnail_960', 'preview_2048', 'exif_json')",
            name="share_media_asset_kind",
        ),
        UniqueConstraint(
            "logical_file_id",
            "kind",
            "format",
            "processing_version",
            name="uq_share_media_assets_logical_kind_format_version",
        ),
    )


class MediaProcessingJob(Base):
    """可持久化、可重试的媒体处理任务。"""

    __tablename__ = "media_processing_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    logical_file_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("share_logical_files.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    job_type: Mapped[str] = mapped_column(
        String(32), default="image_derivatives", server_default="image_derivatives", nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(16), default="pending", server_default="pending", nullable=False
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    max_attempts: Mapped[int] = mapped_column(
        Integer, default=3, server_default="3", nullable=False
    )
    priority: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    locked_by: Mapped[str | None] = mapped_column(String(128))
    last_error: Mapped[str | None] = mapped_column(String(2000))
    processing_version: Mapped[int] = mapped_column(
        Integer, default=1, server_default="1", nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint(
            "job_type = 'image_derivatives'",
            name="media_processing_job_type",
        ),
        CheckConstraint(
            "status IN ('pending', 'running', 'succeeded', 'failed', 'unsupported')",
            name="media_processing_job_status",
        ),
        CheckConstraint("attempts >= 0", name="media_processing_job_attempts"),
        CheckConstraint("max_attempts > 0", name="media_processing_job_max_attempts"),
        UniqueConstraint(
            "logical_file_id",
            "job_type",
            "processing_version",
            name="uq_media_processing_jobs_logical_type_version",
        ),
        Index(
            "ix_media_processing_jobs_status_available_priority",
            "status",
            "available_at",
            "priority",
        ),
    )


class MediaObjectCleanupJob(Base):
    """需要从对象存储重试删除的孤儿媒体对象。"""

    __tablename__ = "media_object_cleanup_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    store_uri: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    reason: Mapped[str] = mapped_column(String(128), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0", nullable=False)
    available_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )
    last_error: Mapped[str | None] = mapped_column(String(2000))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, server_default=text("now()"), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=utcnow,
        onupdate=utcnow,
        server_default=text("now()"),
        nullable=False,
    )

    __table_args__ = (
        CheckConstraint("attempts >= 0", name="media_object_cleanup_job_attempts"),
        Index("ix_media_object_cleanup_jobs_available_at", "available_at"),
    )
