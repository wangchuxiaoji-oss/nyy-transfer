"""终态分享归档的 dry-run 与显式执行服务。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.share import Share, ShareLogicalFile
from app.models.system import ArchiveBatch, ArchivedShare, Report

_ARCHIVE_LOCK_KEY = 0x4E595941524348


def _terminal_status(share: Share, now: datetime) -> str:
    if share.banned_at is not None:
        return "banned"
    if share.revoked_at is not None:
        return "revoked"
    if share.expires_at is not None and share.expires_at <= now:
        return "expired"
    return "active"


def _candidate_filters(cutoff: datetime, now: datetime) -> list:
    return [
        or_(
            Share.banned_at.is_not(None),
            Share.revoked_at.is_not(None),
            Share.expires_at <= now,
        ),
        func.coalesce(Share.last_activity_at, Share.created_at) < cutoff,
        ~exists(
            select(Report.id).where(
                Report.share_id == Share.id,
                Report.status == "pending",
            )
        ),
    ]


async def archive_dry_run(
    db: AsyncSession,
    *,
    retention_days: int = 180,
    sample_size: int = 20,
) -> dict:
    now = datetime.now(UTC)
    cutoff = now - timedelta(days=max(1, retention_days))
    filters = _candidate_filters(cutoff, now)
    count = await db.scalar(select(func.count()).select_from(Share).where(*filters)) or 0
    rows = await db.execute(
        select(Share.code, Share.created_at, Share.last_activity_at)
        .where(*filters)
        .order_by(Share.created_at.asc(), Share.id.asc())
        .limit(max(1, min(sample_size, 100)))
    )
    return {
        "dry_run": True,
        "candidate_count": int(count),
        "cutoff": cutoff,
        "samples": [
            {
                "code": code,
                "created_at": created_at,
                "last_activity_at": last_activity_at,
            }
            for code, created_at, last_activity_at in rows.all()
        ],
    }


async def archive_terminal_shares(
    db: AsyncSession,
    *,
    actor_id: UUID,
    retention_days: int = 180,
    batch_size: int = 100,
) -> dict:
    """显式执行单批归档；不会被应用生命周期自动调用。"""

    lock_acquired = await db.scalar(select(func.pg_try_advisory_xact_lock(_ARCHIVE_LOCK_KEY)))
    if not lock_acquired:
        return {"dry_run": False, "locked": True, "candidate_count": 0, "archived_count": 0}

    now = datetime.now(UTC)
    cutoff = now - timedelta(days=max(1, retention_days))
    filters = _candidate_filters(cutoff, now)
    candidate_count = await db.scalar(select(func.count()).select_from(Share).where(*filters)) or 0
    rows = await db.execute(
        select(Share)
        .where(*filters)
        .order_by(Share.created_at.asc(), Share.id.asc())
        .limit(max(1, min(batch_size, 500)))
        .with_for_update(skip_locked=True)
    )
    shares = rows.scalars().all()
    batch = ArchiveBatch(
        actor_id=actor_id,
        status="running",
        candidate_count=int(candidate_count),
        archived_count=0,
        created_at=now,
    )
    db.add(batch)
    await db.flush()

    share_ids = [share.id for share in shares]
    files_by_share: dict[UUID, list[dict]] = {share_id: [] for share_id in share_ids}
    if share_ids:
        file_rows = await db.execute(
            select(
                ShareLogicalFile.share_id,
                ShareLogicalFile.original_name,
                ShareLogicalFile.size,
                ShareLogicalFile.content_type,
                ShareLogicalFile.chunk_total,
            )
            .where(ShareLogicalFile.share_id.in_(share_ids))
            .order_by(ShareLogicalFile.share_id, ShareLogicalFile.sort_index)
        )
        for share_id, name, size, content_type, chunk_total in file_rows.all():
            files_by_share[share_id].append(
                {
                    "name": name,
                    "size": size,
                    "content_type": content_type,
                    "chunk_total": chunk_total,
                }
            )

    for share in shares:
        db.add(
            ArchivedShare(
                original_share_id=share.id,
                archive_batch_id=batch.id,
                owner_id=share.owner_id,
                code=share.code,
                title=share.title,
                terminal_status=_terminal_status(share, now),
                metadata_snapshot={
                    "expires_at": share.expires_at.isoformat() if share.expires_at else None,
                    "revoked_at": share.revoked_at.isoformat() if share.revoked_at else None,
                    "banned_at": share.banned_at.isoformat() if share.banned_at else None,
                    "banned_reason": share.banned_reason,
                    "download_count": share.download_count,
                    "max_downloads": share.max_downloads,
                    "empty_dirs": share.empty_dirs or [],
                },
                file_summary=files_by_share.get(share.id, []),
                total_bytes=share.total_bytes,
                logical_file_count=share.logical_file_count,
                stored_object_count=share.stored_object_count,
                original_created_at=share.created_at,
                last_activity_at=share.last_activity_at,
                archived_at=now,
            )
        )

    if share_ids:
        await db.execute(delete(Share).where(Share.id.in_(share_ids)))
    batch.archived_count = len(shares)
    batch.status = "completed"
    batch.completed_at = datetime.now(UTC)
    return {
        "dry_run": False,
        "locked": False,
        "batch_id": str(batch.id),
        "candidate_count": int(candidate_count),
        "archived_count": len(shares),
    }
