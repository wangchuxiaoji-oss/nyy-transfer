"""媒体处理任务和资产持久化测试。"""

from __future__ import annotations

import asyncio
import io
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app.db.session import get_session_factory
from app.models.media import MediaObjectCleanupJob, MediaProcessingJob, ShareMediaAsset
from app.models.share import Share, ShareLogicalFile
from app.services.media_jobs import (
    MEDIA_PROCESSING_VERSION,
    claim_next_job,
    enqueue_image_job,
    ensure_gallery_jobs,
    is_gallery_eligible,
    is_supported_image,
    mark_job_failed,
    queue_media_object_cleanup,
    upsert_media_asset,
    uses_original_jpeg_preview,
)
from app.workers.media_worker import (
    MAX_ANIMATION_FRAMES,
    UnsupportedMediaError,
    _render_animated_derivatives,
    _render_derivatives_isolated,
    _render_raw_derivatives,
    _renew_job_lease,
    _run_object_cleanup_batch,
    _upload_assets,
    _validate_animation_limits,
    build_exif_summary,
)
from scripts import backfill_media_v2, cleanup_jpeg_media_assets


async def _create_logical_file(name: str = "photo.jpg") -> ShareLogicalFile:
    share = Share(code=f"media-{name.replace('.', '-')}", total_bytes=1024)
    logical_file = ShareLogicalFile(
        share=share,
        original_name=name,
        size=1024,
        content_type="image/jpeg",
        chunk_total=1,
    )
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, logical_file])
        await db.commit()
    return logical_file


@pytest.mark.parametrize(
    "filename",
    [
        "a.jpg",
        "a.JPEG",
        "a.png",
        "a.webp",
        "a.gif",
        "a.avif",
        "a.heic",
        "a.heif",
        "a.dng",
        "a.cr3",
        "a.cr2",
        "a.nef",
        "a.arw",
        "a.raf",
        "a.rw2",
        "a.orf",
        "a.pef",
    ],
)
def test_supported_image_extensions(filename: str):
    assert is_supported_image(filename)


@pytest.mark.parametrize("filename", ["a.svg", "a.txt", "jpg", "a.jpg.exe"])
def test_unsupported_image_extensions(filename: str):
    assert not is_supported_image(filename)


def test_gallery_eligibility_uses_image_count():
    images = [ShareLogicalFile(original_name=f"{index}.jpg", size=1) for index in range(6)]
    assert is_gallery_eligible(images)
    assert not is_gallery_eligible(images[:5])
    assert is_gallery_eligible([*images, ShareLogicalFile(original_name="a.txt", size=1), ShareLogicalFile(original_name="b.txt", size=1)])


def test_single_object_jpeg_uses_original_preview():
    assert uses_original_jpeg_preview(ShareLogicalFile(original_name="a.jpg", size=1, chunk_total=1))
    assert uses_original_jpeg_preview(ShareLogicalFile(original_name="a.JPEG", size=1, chunk_total=1))
    assert not uses_original_jpeg_preview(ShareLogicalFile(original_name="a.jpg", size=1, chunk_total=2))
    assert not uses_original_jpeg_preview(ShareLogicalFile(original_name="a.png", size=1, chunk_total=1))


@pytest.mark.asyncio
async def test_enqueue_image_job_is_idempotent():
    logical_file = await _create_logical_file("photo.png")
    factory = get_session_factory()
    async with factory() as db:
        first = await enqueue_image_job(db, logical_file.id)
        second = await enqueue_image_job(db, logical_file.id)
        gallery_jobs = await ensure_gallery_jobs(db, [logical_file], priority=10)
        await db.commit()
        count = await db.scalar(
            select(func.count())
            .select_from(MediaProcessingJob)
            .where(MediaProcessingJob.logical_file_id == logical_file.id)
        )
    assert first.id == second.id
    assert gallery_jobs[0].id == first.id
    assert gallery_jobs[0].priority == 10
    assert count == 1


@pytest.mark.asyncio
async def test_gallery_jobs_skip_direct_jpeg_but_keep_chunked_jpeg():
    direct_file = await _create_logical_file("direct.jpg")
    chunked_file = await _create_logical_file("multi.jpg")
    chunked_file.chunk_total = 2
    factory = get_session_factory()
    async with factory() as db:
        jobs = await ensure_gallery_jobs(db, [direct_file, chunked_file])
        await db.commit()
    assert [job.logical_file_id for job in jobs] == [chunked_file.id]


@pytest.mark.asyncio
async def test_claim_and_retry_reaches_final_failure():
    logical_file = await _create_logical_file("retry.jpg")
    factory = get_session_factory()
    now = datetime(2026, 7, 27, 8, 0, tzinfo=UTC)
    async with factory() as db:
        await enqueue_image_job(db, logical_file.id, max_attempts=2, available_at=now)
        await db.commit()

    async with factory() as db:
        first = await claim_next_job(db, worker_id="worker-a", now=now)
        assert first is not None
        assert first.status == "running"
        assert first.attempts == 1
        status = await mark_job_failed(
            db,
            first,
            "temporary",
            now=now,
            retry_delay=timedelta(0),
        )
        await db.commit()
    assert status == "pending"

    async with factory() as db:
        second = await claim_next_job(db, worker_id="worker-b", now=now)
        assert second is not None
        assert second.attempts == 2
        status = await mark_job_failed(db, second, "permanent", now=now)
        await db.commit()
    assert status == "failed"


@pytest.mark.asyncio
async def test_claim_recovers_stale_running_job():
    logical_file = await _create_logical_file("stale.jpg")
    factory = get_session_factory()
    now = datetime(2026, 7, 27, 9, 0, tzinfo=UTC)
    async with factory() as db:
        await enqueue_image_job(db, logical_file.id, max_attempts=3, available_at=now)
        await db.commit()
    async with factory() as db:
        first = await claim_next_job(db, worker_id="worker-a", now=now)
        assert first is not None
        await db.commit()
    async with factory() as db:
        unavailable = await claim_next_job(
            db,
            worker_id="worker-b",
            now=now + timedelta(minutes=14),
        )
        await db.commit()
    assert unavailable is None
    async with factory() as db:
        recovered = await claim_next_job(
            db,
            worker_id="worker-b",
            now=now + timedelta(minutes=16),
        )
        await db.commit()
    assert recovered is not None
    assert recovered.id == first.id
    assert recovered.attempts == 2
    assert recovered.locked_by == "worker-b"


@pytest.mark.asyncio
async def test_worker_renews_active_job_lease():
    logical_file = await _create_logical_file("lease.jpg")
    factory = get_session_factory()
    claimed_at = datetime(2026, 7, 27, 9, 0, tzinfo=UTC)
    async with factory() as db:
        await enqueue_image_job(db, logical_file.id, available_at=claimed_at)
        await db.commit()
    async with factory() as db:
        job = await claim_next_job(db, worker_id="worker-lease", now=claimed_at)
        assert job is not None
        job_id = job.id
        await db.commit()

    assert await _renew_job_lease(job_id, "worker-lease") is True
    async with factory() as db:
        renewed = await db.get(MediaProcessingJob, job_id)
    assert renewed is not None
    assert renewed.locked_at is not None
    assert renewed.locked_at > claimed_at


@pytest.mark.asyncio
async def test_worker_does_not_claim_other_processing_versions():
    logical_file = await _create_logical_file("future.jpg")
    factory = get_session_factory()
    async with factory() as db:
        await enqueue_image_job(db, logical_file.id, processing_version=MEDIA_PROCESSING_VERSION + 1)
        await db.commit()
    async with factory() as db:
        claimed = await claim_next_job(db, worker_id="worker-current")
        await db.commit()
    assert claimed is None


def test_build_exif_summary_reads_grouped_tags():
    summary = build_exif_summary(
        {
            "IFD0:Main:Make": "FUJIFILM",
            "IFD0:Main:Model": "X-T5",
            "ExifIFD:Main:LensModel": "XF33mmF1.4 R LM WR",
            "ExifIFD:Main:ExposureTime": 0.004,
            "ExifIFD:Main:FNumber": 2.0,
            "ExifIFD:Main:ISO": 125,
            "ExifIFD:Main:FocalLength": 33.0,
            "ExifIFD:Main:DateTimeOriginal": "2026:07:27 12:34:56",
            "GPS:Main:GPSLatitude": 0.0,
            "GPS:Main:GPSLongitude": 120.123,
        }
    )
    assert summary == {
        "Make": "FUJIFILM",
        "Model": "X-T5",
        "Lens": "XF33mmF1.4 R LM WR",
        "ExposureTime": 0.004,
        "FNumber": 2.0,
        "ISO": 125,
        "FocalLength": 33.0,
        "DateTimeOriginal": "2026:07:27 12:34:56",
        "GPSLatitude": 0.0,
        "GPSLongitude": 120.123,
    }


def test_isolated_renderer_reads_child_result(monkeypatch, tmp_path):
    source = tmp_path / "source.cr2"
    source.write_bytes(b"raw")

    def fake_run(command, **kwargs):
        output = Path(command[command.index("--render-output") + 1])
        (output / "derivative-0.bin").write_bytes(b"webp")
        (output / "result.json").write_text(
            json.dumps(
                {
                    "width": 1200,
                    "height": 800,
                    "format": "cr2",
                    "derivatives": [
                        {
                            "kind": "thumbnail_480",
                            "format": "webp",
                            "content_type": "image/webp",
                            "path": "derivative-0.bin",
                            "width": 480,
                            "height": 320,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, b"", b"")

    monkeypatch.setattr(subprocess, "run", fake_run)
    processed = _render_derivatives_isolated(
        source,
        "cr2",
        {"File:FileType": "CR2"},
    )

    assert processed.width == 1200
    assert processed.height == 800
    assert processed.format == "cr2"
    assert processed.is_animated is False
    assert processed.frame_count == 1
    assert processed.derivatives[0].data == b"webp"


def test_isolated_renderer_contains_native_crash(monkeypatch, tmp_path):
    source = tmp_path / "source.cr2"
    source.write_bytes(b"raw")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda command, **kwargs: subprocess.CompletedProcess(command, -11, b"", b"segfault"),
    )

    with pytest.raises(UnsupportedMediaError, match="异常退出") as error:
        _render_derivatives_isolated(source, "cr2", {})

    assert error.value.code == "decoder_crashed"


def test_raw_renderer_falls_back_to_embedded_preview(monkeypatch, tmp_path):
    image_module = pytest.importorskip("PIL.Image")
    preview_output = io.BytesIO()
    image_module.new("RGB", (4000, 2252), "red").save(preview_output, format="JPEG")

    class FakeRaw:
        sizes = SimpleNamespace(width=4000, height=2252)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return None

        def postprocess(self, **kwargs):
            raise RuntimeError("损坏的 RAW 像素流")

        def extract_thumb(self):
            return SimpleNamespace(format="jpeg", data=preview_output.getvalue())

    fake_rawpy = SimpleNamespace(
        ColorSpace=SimpleNamespace(sRGB="srgb"),
        ThumbFormat=SimpleNamespace(JPEG="jpeg", BITMAP="bitmap"),
        imread=lambda path: FakeRaw(),
    )
    monkeypatch.setitem(sys.modules, "rawpy", fake_rawpy)

    processed = _render_raw_derivatives(tmp_path / "source.dng", "dng", {})

    assert (processed.width, processed.height) == (4000, 2252)
    assert len(processed.derivatives) == 3
    assert {derivative.format for derivative in processed.derivatives} == {"webp"}
    assert max(derivative.width for derivative in processed.derivatives) == 2048


@pytest.mark.asyncio
async def test_upsert_media_asset_is_unique_within_processing_version():
    logical_file = await _create_logical_file("asset.jpg")
    factory = get_session_factory()
    values = {
        "logical_file_id": logical_file.id,
        "kind": "thumbnail_480",
        "format": "webp",
        "content_type": "image/webp",
        "width": 480,
        "height": 320,
        "byte_size": 100,
        "checksum": "a" * 64,
        "processing_version": 1,
    }
    async with factory() as db:
        first = await upsert_media_asset(db, store_uri="tos/first.webp", **values)
        second = await upsert_media_asset(
            db,
            store_uri="tos/second.webp",
            **{**values, "byte_size": 120, "checksum": "b" * 64},
        )
        third = await upsert_media_asset(
            db,
            store_uri="tos/third.webp",
            **{**values, "processing_version": 2},
        )
        await db.commit()
        assets = (
            await db.scalars(
                select(ShareMediaAsset).where(ShareMediaAsset.logical_file_id == logical_file.id)
            )
        ).all()
    assert first.id == second.id
    assert third.id != first.id
    assert len(assets) == 2
    assets_by_version = {asset.processing_version: asset for asset in assets}
    assert assets_by_version[1].store_uri == "tos/second.webp"
    assert assets_by_version[1].byte_size == 120
    assert assets_by_version[2].store_uri == "tos/third.webp"


def test_animated_renderer_creates_only_animated_webp_previews(tmp_path):
    image_module = pytest.importorskip("PIL.Image")
    source = tmp_path / "animated.webp"
    frames = [
        image_module.new("RGBA", (64, 48), color)
        for color in ((255, 0, 0, 255), (0, 0, 255, 255))
    ]
    frames[0].save(
        source,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=[80, 120],
        loop=0,
    )

    processed = _render_animated_derivatives(source, "webp", {"File:FileType": "WEBP"})

    assert processed is not None
    assert processed.is_animated is True
    assert processed.frame_count == 2
    assert len(processed.derivatives) == 3
    assert {derivative.format for derivative in processed.derivatives} == {"webp"}
    for derivative in processed.derivatives:
        with image_module.open(io.BytesIO(derivative.data)) as preview:
            assert preview.n_frames == 2


def test_animation_limits_reject_excessive_frames_and_pixels():
    with pytest.raises(UnsupportedMediaError) as frame_error:
        _validate_animation_limits(64, 64, MAX_ANIMATION_FRAMES + 1)
    assert frame_error.value.code == "animation_too_large"

    with pytest.raises(UnsupportedMediaError) as pixel_error:
        _validate_animation_limits(2048, 2048, 100)
    assert pixel_error.value.code == "animation_too_large"


@pytest.mark.asyncio
async def test_media_assets_upload_concurrently(monkeypatch):
    active_uploads = 0
    max_active_uploads = 0

    async def fake_upload_sidecar(data, *, file_ext, client):
        nonlocal active_uploads, max_active_uploads
        active_uploads += 1
        max_active_uploads = max(max_active_uploads, active_uploads)
        await asyncio.sleep(0.01)
        active_uploads -= 1
        return f"tos/{file_ext}/{len(data)}", "crc"

    async def fake_get_client():
        return object()

    processed = SimpleNamespace(derivatives=tuple(
        SimpleNamespace(
            kind=kind,
            format="webp",
            content_type="image/webp",
            data=kind.encode(),
            width=edge,
            height=edge,
        )
        for kind, edge in (
            ("thumbnail_480", 480),
            ("thumbnail_960", 960),
            ("preview_2048", 2048),
        )
    ))
    monkeypatch.setattr("app.workers.media_worker.upload_sidecar", fake_upload_sidecar)
    monkeypatch.setattr("app.workers.media_worker.get_doubao_client", fake_get_client)

    assets = await _upload_assets(b"exif", processed)

    assert max_active_uploads == 4
    assert [asset.kind for asset in assets] == [
        "exif_json",
        "thumbnail_480",
        "thumbnail_960",
        "preview_2048",
    ]


@pytest.mark.asyncio
async def test_concurrent_asset_upload_cleans_up_partial_success(monkeypatch):
    deleted_uris: list[str] = []

    class FakeClient:
        async def delete_upload_files(self, store_uris):
            deleted_uris.extend(store_uris)
            return set(store_uris)

    async def fake_upload_sidecar(data, *, file_ext, client):
        await asyncio.sleep(0)
        if data == b"bad":
            raise RuntimeError("upload failed")
        return f"tos/{file_ext}/{data.decode()}", "crc"

    client = FakeClient()

    async def fake_get_client():
        return client

    processed = SimpleNamespace(derivatives=(
        SimpleNamespace(
            kind="thumbnail_480",
            format="webp",
            content_type="image/webp",
            data=b"good",
            width=480,
            height=320,
        ),
        SimpleNamespace(
            kind="preview_2048",
            format="webp",
            content_type="image/webp",
            data=b"bad",
            width=2048,
            height=1365,
        ),
    ))
    monkeypatch.setattr("app.workers.media_worker.upload_sidecar", fake_upload_sidecar)
    monkeypatch.setattr("app.workers.media_worker.get_doubao_client", fake_get_client)

    with pytest.raises(RuntimeError, match="upload failed"):
        await _upload_assets(b"exif", processed)

    assert set(deleted_uris) == {"tos/json/exif", "tos/webp/good"}


@pytest.mark.asyncio
async def test_jpeg_cleanup_deletes_database_rows_only_after_object_confirmation(monkeypatch):
    logical_file = await _create_logical_file("clean.jpg")
    factory = get_session_factory()
    async with factory() as db:
        persisted_file = await db.get(ShareLogicalFile, logical_file.id)
        assert persisted_file is not None
        persisted_file.media_metadata = {
            "image": {"width": 1200, "height": 800, "exif_summary": {"Make": "NYY"}}
        }
        db.add_all([
            ShareMediaAsset(
                logical_file_id=logical_file.id,
                kind="preview_2048",
                format="jpeg",
                content_type="image/jpeg",
                store_uri="tos/cleanup.jpg",
                width=1200,
                height=800,
                byte_size=321,
                checksum="c" * 64,
                processing_version=1,
            ),
            ShareMediaAsset(
                logical_file_id=logical_file.id,
                kind="thumbnail_960",
                format="webp",
                content_type="image/webp",
                store_uri="tos/cleanup.webp",
                width=960,
                height=640,
                byte_size=123,
                checksum="w" * 64,
                processing_version=2,
            ),
            MediaProcessingJob(
                logical_file_id=logical_file.id,
                status="succeeded",
                processing_version=2,
            ),
        ])
        await db.commit()

    class FakeClient:
        async def delete_upload_files(self, store_uris: list[str]) -> set[str]:
            assert set(store_uris) == {"tos/cleanup.jpg", "tos/cleanup.webp"}
            return set(store_uris)

    async def fake_get_client() -> FakeClient:
        return FakeClient()

    async def fake_shutdown() -> None:
        return None

    monkeypatch.setattr(cleanup_jpeg_media_assets, "get_doubao_client", fake_get_client)
    monkeypatch.setattr(cleanup_jpeg_media_assets, "shutdown_doubao_client", fake_shutdown)

    assert await cleanup_jpeg_media_assets.cleanup_jpeg_assets(
        execute=False, batch_size=10
    ) == (2, 0)
    async with factory() as db:
        assert await db.scalar(
            select(func.count()).select_from(ShareMediaAsset).where(
                ShareMediaAsset.logical_file_id == logical_file.id
            )
        ) == 2

    assert await cleanup_jpeg_media_assets.cleanup_jpeg_assets(
        execute=True, batch_size=10
    ) == (2, 2)
    async with factory() as db:
        assert await db.scalar(
            select(func.count()).select_from(ShareMediaAsset).where(
                ShareMediaAsset.logical_file_id == logical_file.id
            )
        ) == 0
        assert await db.scalar(
            select(func.count()).select_from(MediaProcessingJob).where(
                MediaProcessingJob.logical_file_id == logical_file.id
            )
        ) == 0
        persisted_file = await db.get(ShareLogicalFile, logical_file.id)
        assert persisted_file is not None
        assert persisted_file.media_metadata["image"] == {"width": 1200, "height": 800}


@pytest.mark.asyncio
async def test_media_v2_backfill_skips_single_object_jpegs():
    share = Share(code="media-backfill", total_bytes=6)
    logical_files = [
        ShareLogicalFile(
            share=share,
            original_name=f"gallery/{index}.jpg",
            size=1,
            content_type="image/jpeg",
            chunk_total=1,
            sort_index=index,
        )
        for index in range(6)
    ]
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files])
        await db.commit()

    assert await backfill_media_v2.backfill(execute=False, batch_size=10) == (1, 0)
    assert await backfill_media_v2.backfill(execute=True, batch_size=10) == (1, 0)
    async with factory() as db:
        jobs = list((await db.scalars(
            select(MediaProcessingJob).where(
                MediaProcessingJob.processing_version == MEDIA_PROCESSING_VERSION
            )
        )).all())
    assert len(jobs) == 0


@pytest.mark.asyncio
async def test_orphan_object_cleanup_queue_is_idempotent_and_retried(monkeypatch):
    await queue_media_object_cleanup(
        ["tos/orphan.webp", "tos/orphan.webp"],
        reason="test_failure",
    )
    await queue_media_object_cleanup(["tos/orphan.webp"], reason="duplicate")

    class FakeClient:
        async def delete_upload_files(self, store_uris: list[str]) -> set[str]:
            assert store_uris == ["tos/orphan.webp"]
            return set(store_uris)

    async def fake_get_client() -> FakeClient:
        return FakeClient()

    monkeypatch.setattr("app.workers.media_worker.get_doubao_client", fake_get_client)
    factory = get_session_factory()
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(MediaObjectCleanupJob)) == 1

    assert await _run_object_cleanup_batch() is True
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(MediaObjectCleanupJob)) == 0

    logical_file = await _create_logical_file("ref.jpg")
    async with factory() as db:
        db.add(ShareMediaAsset(
            logical_file_id=logical_file.id,
            kind="preview_2048",
            format="webp",
            content_type="image/webp",
            store_uri="tos/referenced.webp",
            width=1200,
            height=800,
            byte_size=100,
            checksum="d" * 64,
            processing_version=2,
        ))
        await db.commit()
    await queue_media_object_cleanup(["tos/referenced.webp"], reason="uncertain_commit")

    class UnexpectedDeleteClient:
        async def delete_upload_files(self, store_uris: list[str]) -> set[str]:
            raise AssertionError(f"不应删除已引用对象: {store_uris}")

    async def unexpected_get_client() -> UnexpectedDeleteClient:
        return UnexpectedDeleteClient()

    monkeypatch.setattr("app.workers.media_worker.get_doubao_client", unexpected_get_client)
    assert await _run_object_cleanup_batch() is True
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(MediaObjectCleanupJob)) == 0
