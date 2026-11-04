"""为所有仍有效的图片画廊创建当前版本媒体处理任务。"""

from __future__ import annotations

import argparse
import asyncio
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import or_, select
from sqlalchemy.orm import selectinload

from app.db.session import dispose_engine, get_session_factory
from app.models.share import Share
from app.services.media_jobs import (
    MEDIA_PROCESSING_VERSION,
    ensure_gallery_jobs,
    is_gallery_eligible,
    is_supported_image,
    uses_original_jpeg_preview,
)


async def backfill(*, execute: bool, batch_size: int) -> tuple[int, int]:
    factory = get_session_factory()
    last_id: UUID | None = None
    gallery_count = 0
    image_count = 0
    now = datetime.now(UTC)
    while True:
        async with factory() as db:
            statement = (
                select(Share)
                .options(selectinload(Share.logical_files))
                .where(
                    Share.revoked_at.is_(None),
                    Share.banned_at.is_(None),
                    or_(Share.expires_at.is_(None), Share.expires_at > now),
                )
                .order_by(Share.id)
                .limit(batch_size)
            )
            if last_id is not None:
                statement = statement.where(Share.id > last_id)
            shares = list((await db.scalars(statement)).all())
            if not shares:
                break
            for share in shares:
                if not is_gallery_eligible(share.logical_files):
                    continue
                gallery_files = [
                    logical_file
                    for logical_file in share.logical_files
                    if is_supported_image(logical_file.original_name)
                    and not uses_original_jpeg_preview(logical_file)
                ]
                gallery_count += 1
                image_count += len(gallery_files)
                if execute:
                    await ensure_gallery_jobs(
                        db,
                        gallery_files,
                        processing_version=MEDIA_PROCESSING_VERSION,
                    )
            if execute:
                await db.commit()
            last_id = shares[-1].id
    print(
        f"媒体 v{MEDIA_PROCESSING_VERSION} 回填: "
        f"{gallery_count} 个有效画廊，{image_count} 张图片"
    )
    return gallery_count, image_count


def main() -> None:
    parser = argparse.ArgumentParser(description="创建媒体 v2 全量回填任务")
    parser.add_argument("--execute", action="store_true", help="实际创建处理任务")
    parser.add_argument("--batch-size", type=int, default=100)
    args = parser.parse_args()
    async def run() -> None:
        try:
            await backfill(
                execute=args.execute,
                batch_size=max(1, min(args.batch_size, 1000)),
            )
        finally:
            await dispose_engine()

    asyncio.run(run())


if __name__ == "__main__":
    main()
