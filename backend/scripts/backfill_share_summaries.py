#!/usr/bin/env python3
"""分批回填分享文件摘要与最近活动时间。"""

from __future__ import annotations

import argparse
import asyncio
from uuid import UUID

from sqlalchemy import func, select, update

from app.db.session import get_session_factory
from app.models.share import DownloadLog, Share, ShareAccessEvent, ShareFile, ShareLogicalFile


async def backfill(batch_size: int, start_after: UUID | None = None) -> int:
    factory = get_session_factory()
    processed = 0
    last_id = start_after
    while True:
        async with factory() as db:
            stmt = select(Share.id).order_by(Share.id).limit(batch_size)
            if last_id is not None:
                stmt = stmt.where(Share.id > last_id)
            share_ids = list((await db.scalars(stmt)).all())
            if not share_ids:
                return processed

            logical_count = (
                select(func.count(ShareLogicalFile.id))
                .where(ShareLogicalFile.share_id == Share.id)
                .correlate(Share)
                .scalar_subquery()
            )
            object_count = (
                select(func.count(ShareFile.id))
                .where(ShareFile.share_id == Share.id)
                .correlate(Share)
                .scalar_subquery()
            )
            access_activity = (
                select(func.max(ShareAccessEvent.created_at))
                .where(ShareAccessEvent.share_id == Share.id)
                .correlate(Share)
                .scalar_subquery()
            )
            download_activity = (
                select(func.max(DownloadLog.downloaded_at))
                .where(DownloadLog.share_id == Share.id)
                .correlate(Share)
                .scalar_subquery()
            )
            await db.execute(
                update(Share)
                .where(Share.id.in_(share_ids))
                .values(
                    logical_file_count=logical_count,
                    stored_object_count=object_count,
                    last_activity_at=func.greatest(
                        Share.created_at,
                        func.coalesce(access_activity, Share.created_at),
                        func.coalesce(download_activity, Share.created_at),
                    ),
                )
            )
            await db.commit()
            processed += len(share_ids)
            last_id = share_ids[-1]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--start-after", type=UUID)
    args = parser.parse_args()
    count = asyncio.run(backfill(max(1, min(args.batch_size, 5000)), args.start_after))
    print(f"已回填 {count} 条分享摘要")


if __name__ == "__main__":
    main()
