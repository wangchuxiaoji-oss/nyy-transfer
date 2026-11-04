"""公开分享图片画廊与选择下载测试。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.api.v1.shares import _sign_gallery_assets
from app.db.session import get_session_factory
from app.main import create_app
from app.models.media import MediaProcessingJob, ShareMediaAsset
from app.models.share import DownloadSession, Share, ShareFile, ShareLogicalFile
from app.services.doubao_client import DoubaoClientError, DownloadUrlResult
from app.utils.security import hash_secret


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
def app(redis):
    application = create_app()
    application.state.redis = redis
    return application


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client


def _image_share(
    code: str,
    count: int,
    *,
    extension: str = "png",
) -> tuple[Share, list[ShareLogicalFile], list[ShareFile]]:
    content_type = "image/jpeg" if extension in {"jpg", "jpeg"} else f"image/{extension}"
    share = Share(
        code=code,
        total_bytes=count * 128,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    logical_files: list[ShareLogicalFile] = []
    stored_files: list[ShareFile] = []
    for index in range(count):
        logical_file = ShareLogicalFile(
            id=uuid.uuid4(),
            share=share,
            original_name=f"相册/photo-{index + 1}.{extension}",
            size=128,
            content_type=content_type,
            chunk_total=1,
            sort_index=index,
        )
        stored_file = ShareFile(
            share=share,
            logical_file=logical_file,
            original_name=logical_file.original_name,
            size=128,
            content_type=content_type,
            tos_uri=f"tos-cn-i-test/photo-{index + 1}.{extension}",
            chunk_index=0,
            chunk_total=1,
        )
        logical_files.append(logical_file)
        stored_files.append(stored_file)
    return share, logical_files, stored_files


@pytest.mark.asyncio
async def test_single_object_jpeg_uses_original_preview_without_jobs_or_server_exif(client):
    code = f"gj{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6, extension="jpg")
    logical_files[0].media_metadata = {
        "image": {
            "width": 1600,
            "height": 1067,
            "exif_summary": {"Make": "不应返回"},
        }
    }
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.commit()

    signed = {
        stored_file.tos_uri: DownloadUrlResult(
            f"https://original.test/{index}.jpg",
            f"https://backup.test/{index}.jpg",
        )
        for index, stored_file in enumerate(stored_files)
    }
    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls_batch.return_value = signed
        resolver_class.return_value = resolver
        response = await client.post(f"/api/v1/shares/{code}/gallery-session", json={})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["ready_count"] == 6
    assert payload["pending_count"] == 0
    assert payload["failed_count"] == 0
    assert payload["files"][0]["exif_summary"] is None
    assert payload["files"][0]["width"] == 1600
    assert payload["files"][0]["assets"] == [{
        "kind": "original_preview",
        "format": "jpeg",
        "content_type": "image/jpeg",
        "width": 1600,
        "height": 1067,
        "byte_size": 128,
        "download_url": "https://original.test/0.jpg",
        "backup_download_url": "https://backup.test/0.jpg",
    }]
    assert set(resolver.get_download_urls_batch.await_args.args[0]) == {
        stored_file.tos_uri for stored_file in stored_files
    }
    async with factory() as db:
        assert await db.scalar(select(func.count()).select_from(MediaProcessingJob)) == 0


@pytest.mark.asyncio
async def test_gallery_session_lazily_enqueues_and_batches_asset_signing(client):
    code = f"ga{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    logical_files[0].media_metadata = {
        "image": {
            "status": "succeeded",
            "width": 1600,
            "height": 1067,
            "error_code": None,
            "exif_summary": {"Make": "NYY", "GPSLatitude": 31.2304},
        },
    }
    thumbnail_uri = "tos-cn-i-test/gallery-thumb.webp"
    preview_uri = "tos-cn-i-test/gallery-preview.webp"
    assets = [
        ShareMediaAsset(
            logical_file_id=logical_files[0].id,
            kind="thumbnail_480",
            format="webp",
            content_type="image/webp",
            store_uri="tos-cn-i-test/gallery-thumb-480.webp",
            width=480,
            height=320,
            byte_size=32,
            checksum="c" * 64,
            processing_version=1,
        ),
        ShareMediaAsset(
            logical_file_id=logical_files[0].id,
            kind="thumbnail_960",
            format="webp",
            content_type="image/webp",
            store_uri=thumbnail_uri,
            width=960,
            height=640,
            byte_size=64,
            checksum="a" * 64,
            processing_version=1,
        ),
        ShareMediaAsset(
            logical_file_id=logical_files[0].id,
            kind="preview_2048",
            format="webp",
            content_type="image/webp",
            store_uri=preview_uri,
            width=1600,
            height=1067,
            byte_size=96,
            checksum="b" * 64,
            processing_version=1,
        ),
    ]
    existing_job = MediaProcessingJob(
        logical_file_id=logical_files[0].id,
        status="succeeded",
        processing_version=1,
    )
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.flush()
        db.add_all([existing_job, *assets])
        await db.commit()

    info = await client.get(f"/api/v1/shares/{code}")
    assert info.status_code == 200
    assert info.json()["gallery_eligible"] is True

    signed = {
        "tos-cn-i-test/gallery-thumb-480.webp": DownloadUrlResult("https://gallery.test/thumb-480.webp", ""),
        thumbnail_uri: DownloadUrlResult("https://gallery.test/thumb.webp", ""),
        preview_uri: DownloadUrlResult("https://gallery.test/preview.webp", "https://backup.test/preview.webp"),
    }
    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls_batch.return_value = signed
        resolver_class.return_value = resolver
        response = await client.post(f"/api/v1/shares/{code}/gallery-session", json={})

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["eligible"] is True
    assert payload["ready_count"] == 1
    assert payload["pending_count"] == 5
    assert payload["files"][0]["status"] == "ready"
    assert payload["files"][0]["assets"][0]["kind"] == "preview_2048"
    assert {asset["kind"] for asset in payload["files"][0]["assets"]} == {
        "thumbnail_480",
        "thumbnail_960",
        "preview_2048",
    }
    assert "original_download_url" not in payload["files"][0]
    assert "original_backup_download_url" not in payload["files"][0]
    resolver.get_download_urls_batch.assert_awaited_once()
    assert set(resolver.get_download_urls_batch.await_args.args[0]) == {
        "tos-cn-i-test/gallery-thumb-480.webp",
        preview_uri,
        thumbnail_uri,
    }
    assert resolver.get_download_urls_batch.await_args.kwargs == {"expire_seconds": 3600}

    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as incremental_resolver_class:
        incremental = await client.post(
            f"/api/v1/shares/{code}/gallery-session",
            json={"known_ready_indices": [0]},
        )
    assert incremental.status_code == 200
    assert incremental.json()["files"][0]["status"] == "ready"
    assert incremental.json()["files"][0]["assets"] == []
    incremental_resolver_class.assert_not_called()

    async with factory() as db:
        job_count = await db.scalar(select(func.count()).select_from(MediaProcessingJob))
        persisted_share = await db.scalar(select(Share).where(Share.code == code))
    assert job_count == 7
    assert persisted_share.download_count == 0


@pytest.mark.asyncio
async def test_gallery_never_signs_original_when_download_limit_is_exhausted(client):
    code = f"gl{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    share.max_downloads = 1
    share.download_count = 1
    logical_files[0].media_metadata = {
        "image": {"status": "succeeded", "width": 1200, "height": 800}
    }
    preview_uri = "tos-cn-i-test/limited-preview.webp"
    thumbnail_uri = "tos-cn-i-test/limited-thumb.webp"
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.flush()
        db.add_all([
            ShareMediaAsset(
                logical_file_id=logical_files[0].id,
                kind=kind,
                format="webp",
                content_type="image/webp",
                store_uri=uri,
                width=width,
                height=height,
                byte_size=64,
                checksum=checksum * 64,
                processing_version=1,
            )
            for kind, uri, width, height, checksum in (
                ("thumbnail_480", "tos-cn-i-test/limited-thumb-480.webp", 480, 320, "c"),
                ("thumbnail_960", thumbnail_uri, 960, 640, "a"),
                ("preview_2048", preview_uri, 1200, 800, "b"),
            )
        ])
        await db.commit()

    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls_batch.return_value = {
            preview_uri: DownloadUrlResult("https://gallery.test/preview.webp"),
            thumbnail_uri: DownloadUrlResult("https://gallery.test/thumb.webp"),
            "tos-cn-i-test/limited-thumb-480.webp": DownloadUrlResult("https://gallery.test/thumb-480.webp"),
        }
        resolver_class.return_value = resolver
        gallery = await client.post(f"/api/v1/shares/{code}/gallery-session", json={})

    assert gallery.status_code == 200
    assert gallery.json()["files"][0]["status"] == "ready"
    signed_uris = resolver.get_download_urls_batch.await_args.args[0]
    assert set(signed_uris) == {
        preview_uri,
        thumbnail_uri,
        "tos-cn-i-test/limited-thumb-480.webp",
    }
    assert stored_files[0].tos_uri not in signed_uris

    download = await client.post(
        f"/api/v1/shares/{code}/download-session",
        headers={"X-NYY-Link-Request-ID": f"limited-{uuid.uuid4().hex}"},
        json={"intent": "download", "file_indices": [0]},
    )
    assert download.status_code == 410

    preview = await client.post(
        f"/api/v1/shares/{code}/download-session",
        headers={"X-NYY-Link-Request-ID": f"preview-{uuid.uuid4().hex}"},
        json={"intent": "preview", "file_indices": [0]},
    )
    assert preview.status_code == 400


@pytest.mark.asyncio
async def test_password_gallery_unlock_returns_only_metadata(client):
    code = f"gu{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    share.password_hash = hash_secret("1234")
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.commit()

    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        response = await client.post(
            f"/api/v1/shares/{code}/unlock",
            json={"password": "1234"},
        )

    assert response.status_code == 200
    assert response.json()["gallery_eligible"] is True
    assert len(response.json()["files"]) == 6
    assert all("download_url" not in file for file in response.json()["files"])
    resolver_class.assert_not_called()

    blocked_preview = await client.post(
        f"/api/v1/shares/{code}/download-session",
        headers={"X-NYY-Link-Request-ID": f"unlock-{uuid.uuid4().hex}"},
        json={"password": "1234", "intent": "preview"},
    )
    assert blocked_preview.status_code == 400


@pytest.mark.asyncio
async def test_password_attempt_limit_is_shared_by_all_password_endpoints(client):
    code = f"gr{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    share.password_hash = hash_secret("1234")
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.commit()

    with patch("app.api.v1.shares.verify_secret", return_value=False):
        for _ in range(10):
            response = await client.post(
                f"/api/v1/shares/{code}/unlock",
                json={"password": "9999"},
            )
            assert response.status_code == 403
        limited = await client.post(
            f"/api/v1/shares/{code}/download-session",
            headers={"X-NYY-Link-Request-ID": f"limited-{uuid.uuid4().hex}"},
            json={"password": "9999", "intent": "download"},
        )

    assert limited.status_code == 429


@pytest.mark.asyncio
async def test_correct_password_requests_do_not_consume_failure_limit(client):
    code = f"gc{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    share.password_hash = hash_secret("1234")
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.commit()

    with patch("app.api.v1.shares.verify_secret", return_value=True):
        responses = [
            await client.post(f"/api/v1/shares/{code}/unlock", json={"password": "1234"})
            for _ in range(12)
        ]

    assert all(response.status_code == 200 for response in responses)


@pytest.mark.asyncio
async def test_download_session_filters_indices_and_records_scope(client):
    code = f"ds{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 3)
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.commit()

    async def sign_uri(uri: str, *, expire_seconds: int) -> DownloadUrlResult:
        assert expire_seconds == 86400
        return DownloadUrlResult(main_url=f"https://download.test/{uri.rsplit('/', 1)[-1]}")

    request_id = f"selected-{uuid.uuid4().hex}"
    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls.side_effect = sign_uri
        resolver_class.return_value = resolver
        response = await client.post(
            f"/api/v1/shares/{code}/download-session",
            headers={"X-NYY-Link-Request-ID": request_id},
            json={"intent": "download", "file_indices": [2, 0, 2]},
        )

    assert response.status_code == 200, response.text
    assert [item["file_name"] for item in response.json()["files"]] == [
        "相册/photo-1.png",
        "相册/photo-3.png",
    ]
    assert response.json()["empty_dirs"] == []

    async with factory() as db:
        session = await db.scalar(select(DownloadSession).where(DownloadSession.request_id == request_id))
        persisted_share = await db.scalar(select(Share).where(Share.code == code))
    assert session is not None
    assert session.response_payload["file_count"] == 2
    assert session.response_payload["logical_file_ids"] == [
        str(logical_files[0].id),
        str(logical_files[2].id),
    ]
    assert persisted_share.download_count == 1

    invalid = await client.post(
        f"/api/v1/shares/{code}/download-session",
        headers={"X-NYY-Link-Request-ID": f"invalid-{uuid.uuid4().hex}"},
        json={"intent": "preview", "file_indices": [99]},
    )
    assert invalid.status_code == 400


@pytest.mark.asyncio
async def test_gallery_asset_signing_skips_only_damaged_object():
    logical_file_id = uuid.uuid4()
    good_uri = "tos-cn-i-test/good.webp"
    damaged_uri = "tos-cn-i-test/damaged.webp"
    assets = [
        ShareMediaAsset(
            logical_file_id=logical_file_id,
            kind="thumbnail_960",
            format="webp",
            content_type="image/webp",
            store_uri=uri,
            width=960,
            height=640,
            byte_size=64,
            checksum=checksum * 64,
            processing_version=1,
        )
        for uri, checksum in ((good_uri, "a"), (damaged_uri, "b"))
    ]

    async def sign_batch(batch: list[str], *, expire_seconds: int):
        assert expire_seconds == 3600
        if damaged_uri in batch:
            raise DoubaoClientError(f"get_file_url returned no URL for {damaged_uri}")
        return {good_uri: DownloadUrlResult("https://gallery.test/good.webp")}

    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls_batch.side_effect = sign_batch
        resolver_class.return_value = resolver
        signed = await _sign_gallery_assets(assets)

    assert signed == {good_uri: DownloadUrlResult("https://gallery.test/good.webp")}


@pytest.mark.asyncio
async def test_gallery_prefers_latest_complete_asset_version(client):
    code = f"gv{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    logical_files[0].media_metadata = {
        "image": {
            "status": "succeeded",
            "width": 1600,
            "height": 1000,
            "is_animated": True,
            "frame_count": 8,
        }
    }
    factory = get_session_factory()
    assets: list[ShareMediaAsset] = []
    for version in (1, 2):
        for kind in ("thumbnail_480", "thumbnail_960", "preview_2048"):
            assets.append(ShareMediaAsset(
                logical_file_id=logical_files[0].id,
                kind=kind,
                format="webp",
                content_type="image/webp",
                store_uri=f"tos/v{version}-{kind}.webp",
                width=480 if kind == "thumbnail_480" else 960 if kind == "thumbnail_960" else 1600,
                height=300 if kind == "thumbnail_480" else 600 if kind == "thumbnail_960" else 1000,
                byte_size=64,
                checksum=str(version) * 64,
                processing_version=version,
            ))
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.flush()
        db.add_all(assets)
        await db.commit()

    v2_uris = {asset.store_uri for asset in assets if asset.processing_version == 2}
    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls_batch.return_value = {
            uri: DownloadUrlResult(f"https://gallery.test/{uri.rsplit('/', 1)[-1]}")
            for uri in v2_uris
        }
        resolver_class.return_value = resolver
        response = await client.post(f"/api/v1/shares/{code}/gallery-session", json={})

    assert response.status_code == 200
    file = response.json()["files"][0]
    assert file["status"] == "ready"
    assert file["is_animated"] is True
    assert file["frame_count"] == 8
    assert set(resolver.get_download_urls_batch.await_args.args[0]) == v2_uris


@pytest.mark.asyncio
async def test_gallery_falls_back_when_latest_asset_version_cannot_be_signed(client):
    code = f"gf{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    assets = [
        ShareMediaAsset(
            logical_file_id=logical_files[0].id,
            kind=kind,
            format="webp",
            content_type="image/webp",
            store_uri=f"tos/v{version}-{kind}.webp",
            width=480,
            height=320,
            byte_size=64,
            checksum=str(version) * 64,
            processing_version=version,
        )
        for version in (1, 2)
        for kind in ("thumbnail_480", "thumbnail_960", "preview_2048")
    ]
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.flush()
        db.add_all(assets)
        await db.commit()

    v1_uris = {asset.store_uri for asset in assets if asset.processing_version == 1}
    v2_uris = {asset.store_uri for asset in assets if asset.processing_version == 2}
    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls_batch.side_effect = [
            {
                uri: DownloadUrlResult(f"https://gallery.test/{uri.rsplit('/', 1)[-1]}")
                for uri in v2_uris
                if "preview_2048" not in uri
            },
            {
                uri: DownloadUrlResult(f"https://gallery.test/{uri.rsplit('/', 1)[-1]}")
                for uri in v1_uris
            },
        ]
        resolver_class.return_value = resolver
        response = await client.post(f"/api/v1/shares/{code}/gallery-session", json={})

    assert response.status_code == 200
    file = response.json()["files"][0]
    assert file["status"] == "ready"
    assert all("v1-" in asset["download_url"] for asset in file["assets"])
    assert resolver.get_download_urls_batch.await_count == 2


@pytest.mark.asyncio
async def test_gallery_accepts_legacy_v1_with_one_thumbnail(client):
    code = f"go{uuid.uuid4().hex[:8]}"
    share, logical_files, stored_files = _image_share(code, 6)
    assets = [
        ShareMediaAsset(
            logical_file_id=logical_files[0].id,
            kind=kind,
            format="webp",
            content_type="image/webp",
            store_uri=f"tos/legacy-{kind}.webp",
            width=960,
            height=640,
            byte_size=64,
            checksum="a" * 64,
            processing_version=1,
        )
        for kind in ("thumbnail_960", "preview_2048")
    ]
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, *logical_files, *stored_files])
        await db.flush()
        db.add_all(assets)
        await db.commit()

    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls_batch.return_value = {
            asset.store_uri: DownloadUrlResult(f"https://gallery.test/{asset.kind}.webp")
            for asset in assets
        }
        resolver_class.return_value = resolver
        response = await client.post(f"/api/v1/shares/{code}/gallery-session", json={})

    assert response.status_code == 200
    assert response.json()["files"][0]["status"] == "ready"
    assert {asset["kind"] for asset in response.json()["files"][0]["assets"]} == {
        "thumbnail_960",
        "preview_2048",
    }
