"""删除历史 JPEG 媒体派生对象及对应数据库记录。"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import and_, delete, func, or_, select

from app.db.session import dispose_engine, get_session_factory
from app.models.media import MediaObjectCleanupJob, MediaProcessingJob, ShareMediaAsset
from app.models.share import ShareLogicalFile
from app.services.doubao_client import get_doubao_client, shutdown_doubao_client


def _single_object_jpeg_filter():
    normalized_name = func.lower(ShareLogicalFile.original_name)
    return and_(
        ShareLogicalFile.chunk_total == 1,
        or_(normalized_name.like("%.jpg"), normalized_name.like("%.jpeg")),
    )


def _jpeg_derivative_filter():
    jpeg_file_ids = select(ShareLogicalFile.id).where(_single_object_jpeg_filter())
    return or_(
        ShareMediaAsset.format == "jpeg",
        ShareMediaAsset.logical_file_id.in_(jpeg_file_ids),
    )


async def cleanup_jpeg_assets(*, execute: bool, batch_size: int) -> tuple[int, int]:
    factory = get_session_factory()
    async with factory() as db:
        count, byte_size = (
            await db.execute(
                select(func.count(), func.coalesce(func.sum(ShareMediaAsset.byte_size), 0)).where(
                    _jpeg_derivative_filter()
                )
            )
        ).one()
        job_count = await db.scalar(
            select(func.count()).select_from(MediaProcessingJob).where(
                MediaProcessingJob.logical_file_id.in_(
                    select(ShareLogicalFile.id).where(_single_object_jpeg_filter())
                )
            )
        )
    print(f"JPEG 源文件派生资产: {count} 条，{byte_size} bytes；历史任务: {job_count} 条")
    if not execute:
        return int(count), 0

    client = await get_doubao_client() if count else None
    deleted_rows = 0
    try:
        while True:
            async with factory() as db:
                assets = list((await db.scalars(
                    select(ShareMediaAsset)
                    .where(_jpeg_derivative_filter())
                    .order_by(ShareMediaAsset.id)
                    .limit(batch_size)
                )).all())
                if not assets:
                    break
                if client is None:
                    raise RuntimeError("对象存储客户端不可用")
                confirmed = await client.delete_upload_files([asset.store_uri for asset in assets])
                confirmed_ids = [asset.id for asset in assets if asset.store_uri in confirmed]
                if len(confirmed_ids) != len(assets):
                    raise RuntimeError("对象存储未确认全部 JPEG 删除，数据库未修改")
                confirmed_uris = [asset.store_uri for asset in assets if asset.store_uri in confirmed]
                await db.execute(
                    delete(ShareMediaAsset).where(ShareMediaAsset.id.in_(confirmed_ids))
                )
                await db.execute(
                    delete(MediaObjectCleanupJob).where(
                        MediaObjectCleanupJob.store_uri.in_(confirmed_uris)
                    )
                )
                await db.commit()
                deleted_rows += len(confirmed_ids)
                print(f"已删除 {deleted_rows}/{count} 条 JPEG 派生资产")
    finally:
        if client is not None:
            await shutdown_doubao_client()

    async with factory() as db:
        jpeg_files = list((await db.scalars(
            select(ShareLogicalFile).where(_single_object_jpeg_filter())
        )).all())
        jpeg_file_ids = [logical_file.id for logical_file in jpeg_files]
        if jpeg_file_ids:
            await db.execute(
                delete(MediaProcessingJob).where(
                    MediaProcessingJob.logical_file_id.in_(jpeg_file_ids)
                )
            )
        for logical_file in jpeg_files:
            metadata = dict(logical_file.media_metadata or {})
            image = metadata.get("image")
            if not isinstance(image, dict) or "exif_summary" not in image:
                continue
            sanitized_image = dict(image)
            sanitized_image.pop("exif_summary", None)
            metadata["image"] = sanitized_image
            logical_file.media_metadata = metadata or None
        await db.commit()

    async with factory() as db:
        remaining = await db.scalar(
            select(func.count()).select_from(ShareMediaAsset).where(
                _jpeg_derivative_filter()
            )
        )
    if remaining:
        raise RuntimeError(f"清理后仍有 {remaining} 条 JPEG 派生资产")
    return int(count), deleted_rows


def main() -> None:
    parser = argparse.ArgumentParser(description="清理历史 JPEG 媒体派生资产")
    parser.add_argument("--execute", action="store_true", help="实际删除对象和数据库记录")
    parser.add_argument("--batch-size", type=int, default=500)
    args = parser.parse_args()
    async def run() -> None:
        try:
            await cleanup_jpeg_assets(
                execute=args.execute,
                batch_size=max(1, min(args.batch_size, 1000)),
            )
        finally:
            await dispose_engine()

    asyncio.run(run())


if __name__ == "__main__":
    main()
