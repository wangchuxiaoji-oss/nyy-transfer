"""媒体处理任务的入队、领取和状态流转服务。"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.base import utcnow
from app.models.media import MediaObjectCleanupJob, MediaProcessingJob, ShareMediaAsset
from app.models.share import ShareLogicalFile

IMAGE_JOB_TYPE = "image_derivatives"
MEDIA_PROCESSING_VERSION = 2
REQUIRED_GALLERY_ASSET_KINDS = frozenset({
    "thumbnail_480",
    "thumbnail_960",
    "preview_2048",
})
SUPPORTED_IMAGE_EXTENSIONS = frozenset(
    {
        "jpg",
        "jpeg",
        "png",
        "webp",
        "gif",
        "avif",
        "heic",
        "heif",
        "dng",
        "cr3",
        "cr2",
        "nef",
        "arw",
        "raf",
        "rw2",
        "orf",
        "pef",
    }
)


def is_supported_image(filename: str) -> bool:
    """仅按允许列表判断文件扩展名，实际格式由 Worker 解码验证。"""

    basename = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    if "." not in basename:
        return False
    return basename.rsplit(".", 1)[-1].lower() in SUPPORTED_IMAGE_EXTENSIONS


def uses_original_jpeg_preview(logical_file: ShareLogicalFile) -> bool:
    """单对象 JPEG 由浏览器直接预览，不创建服务端派生。"""

    basename = logical_file.original_name.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    extension = basename.rsplit(".", 1)[-1].lower() if "." in basename else ""
    return extension in {"jpg", "jpeg"} and logical_file.chunk_total == 1


def is_gallery_eligible(logical_files: Iterable[ShareLogicalFile]) -> bool:
    """支持的图片不少于 6 张时启用画廊。"""

    files = list(logical_files)
    image_count = sum(is_supported_image(item.original_name) for item in files)
    return image_count >= 6


async def enqueue_image_job(
    db: AsyncSession,
    logical_file_id: uuid.UUID,
    *,
    processing_version: int = MEDIA_PROCESSING_VERSION,
    priority: int = 0,
    max_attempts: int = 3,
    available_at: datetime | None = None,
) -> MediaProcessingJob:
    """幂等创建图片派生任务，并返回新建或已存在的任务。"""

    now = utcnow()
    statement = (
        pg_insert(MediaProcessingJob)
        .values(
            id=uuid.uuid4(),
            logical_file_id=logical_file_id,
            job_type=IMAGE_JOB_TYPE,
            status="pending",
            attempts=0,
            max_attempts=max(1, max_attempts),
            priority=priority,
            available_at=available_at or now,
            processing_version=processing_version,
            created_at=now,
            updated_at=now,
        )
        .on_conflict_do_nothing(constraint="uq_media_processing_jobs_logical_type_version")
        .returning(MediaProcessingJob.id)
    )
    job_id = (await db.execute(statement)).scalar_one_or_none()
    if job_id is None:
        job_id = await db.scalar(
            select(MediaProcessingJob.id).where(
                MediaProcessingJob.logical_file_id == logical_file_id,
                MediaProcessingJob.job_type == IMAGE_JOB_TYPE,
                MediaProcessingJob.processing_version == processing_version,
            )
        )
    if job_id is None:
        raise RuntimeError("媒体处理任务入队后无法读取")
    job = await db.get(MediaProcessingJob, job_id)
    if job is None:
        raise RuntimeError("媒体处理任务不存在")
    return job


async def ensure_gallery_jobs(
    db: AsyncSession,
    logical_files: Iterable[ShareLogicalFile],
    *,
    processing_version: int = MEDIA_PROCESSING_VERSION,
    priority: int = 0,
) -> list[MediaProcessingJob]:
    """为历史分享中受支持的图片按需补建任务。"""

    logical_file_ids = [
        logical_file.id
        for logical_file in logical_files
        if is_supported_image(logical_file.original_name)
        and not uses_original_jpeg_preview(logical_file)
    ]
    if not logical_file_ids:
        return []

    now = utcnow()
    insert_statement = pg_insert(MediaProcessingJob).values([
            {
                "id": uuid.uuid4(),
                "logical_file_id": logical_file_id,
                "job_type": IMAGE_JOB_TYPE,
                "status": "pending",
                "attempts": 0,
                "max_attempts": 3,
                "priority": priority,
                "available_at": now,
                "processing_version": processing_version,
                "created_at": now,
                "updated_at": now,
            }
            for logical_file_id in logical_file_ids
        ])
    if priority > 0:
        insert_statement = insert_statement.on_conflict_do_update(
            constraint="uq_media_processing_jobs_logical_type_version",
            set_={
                "priority": func.greatest(
                    MediaProcessingJob.priority,
                    insert_statement.excluded.priority,
                ),
            },
            where=and_(
                MediaProcessingJob.status == "pending",
                MediaProcessingJob.priority < insert_statement.excluded.priority,
            ),
        )
    else:
        insert_statement = insert_statement.on_conflict_do_nothing(
            constraint="uq_media_processing_jobs_logical_type_version"
        )
    await db.execute(insert_statement)
    result = await db.scalars(
        select(MediaProcessingJob)
        .where(
            MediaProcessingJob.logical_file_id.in_(logical_file_ids),
            MediaProcessingJob.job_type == IMAGE_JOB_TYPE,
            MediaProcessingJob.processing_version == processing_version,
        )
        .execution_options(populate_existing=True)
    )
    return list(result.all())


async def enqueue_media_object_cleanup(
    db: AsyncSession,
    store_uris: Iterable[str],
    *,
    reason: str,
    available_at: datetime | None = None,
) -> int:
    """幂等记录需要重试删除的对象。"""
    unique_uris = list(dict.fromkeys(uri for uri in store_uris if uri))
    if not unique_uris:
        return 0
    now = utcnow()
    statement = (
        pg_insert(MediaObjectCleanupJob)
        .values([
            {
                "id": uuid.uuid4(),
                "store_uri": store_uri,
                "reason": reason[:128],
                "attempts": 0,
                "available_at": available_at or now,
                "created_at": now,
                "updated_at": now,
            }
            for store_uri in unique_uris
        ])
        .on_conflict_do_nothing(index_elements=[MediaObjectCleanupJob.store_uri])
    )
    result = await db.execute(statement)
    return result.rowcount or 0


async def queue_media_object_cleanup(
    store_uris: Iterable[str],
    *,
    reason: str,
    delay: timedelta | None = None,
) -> None:
    """使用独立事务持久化对象清理任务。"""
    from app.db.session import get_session_factory

    factory = get_session_factory()
    async with factory() as db, db.begin():
        await enqueue_media_object_cleanup(
            db,
            store_uris,
            reason=reason,
            available_at=utcnow() + delay if delay else None,
        )


async def dequeue_media_object_cleanup(store_uris: Iterable[str]) -> None:
    """移除已确认由数据库引用的对象清理任务。"""
    from app.db.session import get_session_factory

    unique_uris = list(dict.fromkeys(uri for uri in store_uris if uri))
    if not unique_uris:
        return
    factory = get_session_factory()
    async with factory() as db, db.begin():
        await db.execute(
            delete(MediaObjectCleanupJob).where(MediaObjectCleanupJob.store_uri.in_(unique_uris))
        )


async def claim_next_job(
    db: AsyncSession,
    *,
    worker_id: str,
    now: datetime | None = None,
    lock_timeout: timedelta = timedelta(minutes=15),
) -> MediaProcessingJob | None:
    """使用行锁领取任务，并回收租约超时的运行中任务。"""

    claimed_at = now or utcnow()
    stale_before = claimed_at - lock_timeout
    await db.execute(
        update(MediaProcessingJob)
        .where(
            MediaProcessingJob.status == "running",
            MediaProcessingJob.locked_at < stale_before,
            MediaProcessingJob.attempts >= MediaProcessingJob.max_attempts,
        )
        .values(
            status="failed",
            locked_at=None,
            locked_by=None,
            last_error=func.coalesce(
                MediaProcessingJob.last_error,
                "Worker 租约超时且已达到最大尝试次数",
            ),
            updated_at=claimed_at,
        )
    )
    candidate = await db.scalar(
        select(MediaProcessingJob)
        .where(
            MediaProcessingJob.job_type == IMAGE_JOB_TYPE,
            MediaProcessingJob.processing_version == MEDIA_PROCESSING_VERSION,
            MediaProcessingJob.attempts < MediaProcessingJob.max_attempts,
            or_(
                and_(
                    MediaProcessingJob.status == "pending",
                    MediaProcessingJob.available_at <= claimed_at,
                ),
                and_(
                    MediaProcessingJob.status == "running",
                    MediaProcessingJob.locked_at < stale_before,
                ),
            ),
        )
        .order_by(
            MediaProcessingJob.priority.desc(),
            MediaProcessingJob.available_at.asc(),
            MediaProcessingJob.created_at.asc(),
            MediaProcessingJob.id.asc(),
        )
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if candidate is None:
        return None
    candidate.status = "running"
    candidate.attempts += 1
    candidate.locked_at = claimed_at
    candidate.locked_by = worker_id[:128]
    candidate.updated_at = claimed_at
    await db.flush()
    return candidate


async def mark_job_succeeded(
    db: AsyncSession,
    job: MediaProcessingJob,
    *,
    now: datetime | None = None,
) -> None:
    succeeded_at = now or utcnow()
    job.status = "succeeded"
    job.available_at = succeeded_at
    job.locked_at = None
    job.locked_by = None
    job.last_error = None
    job.updated_at = succeeded_at
    await db.flush()


async def mark_job_unsupported(
    db: AsyncSession,
    job: MediaProcessingJob,
    error: str,
    *,
    now: datetime | None = None,
) -> None:
    job.status = "unsupported"
    job.locked_at = None
    job.locked_by = None
    job.last_error = error[:2000]
    job.updated_at = now or utcnow()
    await db.flush()


async def mark_job_failed(
    db: AsyncSession,
    job: MediaProcessingJob,
    error: str,
    *,
    now: datetime | None = None,
    retry_delay: timedelta | None = None,
) -> str:
    """记录失败；未耗尽次数时重新排队，否则进入最终失败态。"""

    failed_at = now or utcnow()
    job.last_error = error[:2000]
    job.locked_at = None
    job.locked_by = None
    job.updated_at = failed_at
    if job.attempts < job.max_attempts:
        if retry_delay is None:
            retry_delay = timedelta(seconds=min(300, 5 * 2 ** max(0, job.attempts - 1)))
        job.status = "pending"
        job.available_at = failed_at + retry_delay
    else:
        job.status = "failed"
    await db.flush()
    return job.status


async def upsert_media_asset(
    db: AsyncSession,
    *,
    logical_file_id: uuid.UUID,
    kind: str,
    format: str,
    content_type: str,
    store_uri: str,
    width: int | None,
    height: int | None,
    byte_size: int,
    checksum: str,
    processing_version: int,
) -> ShareMediaAsset:
    """按逻辑文件、资产类型、格式和处理版本幂等写入资产。"""

    statement = (
        pg_insert(ShareMediaAsset)
        .values(
            id=uuid.uuid4(),
            logical_file_id=logical_file_id,
            kind=kind,
            format=format,
            content_type=content_type,
            store_uri=store_uri,
            width=width,
            height=height,
            byte_size=byte_size,
            checksum=checksum,
            processing_version=processing_version,
            created_at=utcnow(),
        )
        .on_conflict_do_update(
            constraint="uq_share_media_assets_logical_kind_format_version",
            set_={
                "content_type": content_type,
                "store_uri": store_uri,
                "width": width,
                "height": height,
                "byte_size": byte_size,
                "checksum": checksum,
            },
        )
        .returning(ShareMediaAsset)
    )
    return (
        await db.execute(
            statement,
            execution_options={"populate_existing": True},
        )
    ).scalar_one()
