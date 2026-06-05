"""Upload init/commit API 测试。"""

from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.main import create_app
from app.models.share import Share, ShareLogicalFile
from app.services.doubao_client import CommitResult, UploadInitResult


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
def app(redis):
    application = create_app()
    application.state.redis = redis
    return application


@pytest.fixture
def _raise_share_limit():
    """Temporarily raise guest_max_active_shares so commit tests pass."""
    from app.core.config import get_settings
    settings = get_settings()
    original = settings.guest_max_active_shares
    settings.guest_max_active_shares = 9999
    yield
    settings.guest_max_active_shares = original


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _mock_init_result() -> UploadInitResult:
    return UploadInitResult(
        upload_url="https://tos-test.example.com/upload/v1/test-uri.bin",
        authorization="SpaceKey/test/auth",
        store_uri="tos-cn-i-test/abc123.bin",
        session_key="eyJ0ZXN0Ijp0cnVlfQ==",
        tos_host="tos-test.example.com",
        service_id="testservice",
        access_key="AK_TEST",
        secret_key="SK_TEST",
        session_token="STS_TEST",
    )


@pytest.mark.asyncio
async def test_upload_init_success(client, redis):
    """init 正常流程：返回 upload_url + commit_token。"""
    mock_result = _mock_init_result()
    with patch(
        "app.api.v1.uploads.get_doubao_client",
        new_callable=AsyncMock,
    ) as mock_get:
        mock_client = AsyncMock()
        mock_client.init_upload.return_value = mock_result
        mock_get.return_value = mock_client

        resp = await client.post("/api/v1/uploads/init", json={
            "file_name": "test.bin",
            "file_size": 1024,
            "file_ext": "bin",
        })

    assert resp.status_code == 200
    data = resp.json()
    assert data["upload_url"] == mock_result.upload_url
    assert data["authorization"] == mock_result.authorization
    assert data["store_uri"] == mock_result.store_uri
    assert len(data["commit_token"]) > 20

    # commit_token 应存入 Redis
    stored = await redis.get(f"nyy:commit:{data['commit_token']}")
    assert stored is not None
    token_data = json.loads(stored)
    assert token_data["file_name"] == "test.bin"
    assert token_data["file_size"] == 1024


@pytest.mark.asyncio
async def test_upload_init_quota_exceeded(client, redis):
    """配额超限时返回 429。

    注意：固定 mock 配额配置，避免依赖 DB 中运营可调整的 AppConfig
    （生产 DB 的 guest 上限已被调高，若读真实配置该用例会失真）。
    """
    fixed_quota = {
        "guest_max_file_bytes": 200 * 1024 * 1024,
        "guest_max_active_shares": 9999,
        "guest_ttl_hours": 24,
        "user_max_file_bytes": 1024 * 1024 * 1024,
        "user_max_active_shares": 9999,
        "user_ttl_hours": 720,
    }
    # 预设已用 199 MB
    await redis.set("nyy:quota:ip:127.0.0.1:bytes", str(199 * 1024 * 1024))

    with patch(
        "app.api.v1.uploads.get_quota_config",
        new_callable=AsyncMock,
        return_value=fixed_quota,
    ), patch(
        "app.api.v1.uploads._count_active_shares",
        new_callable=AsyncMock,
        return_value=0,
    ):
        resp = await client.post("/api/v1/uploads/init", json={
            "file_name": "big.bin",
            "file_size": 2 * 1024 * 1024,  # 2 MB，超过剩余 1 MB
            "file_ext": "bin",
        })
    assert resp.status_code == 429


@pytest.mark.asyncio
async def test_upload_commit_success(client, redis, _raise_share_limit):
    """commit 正常流程：返回 share_code。"""
    # 先手动写入 commit_token
    token = "test-commit-token-abc"
    token_data = {
        "ip": "127.0.0.1",
        "file_name": "hello.txt",
        "file_size": 512,
        "file_ext": "txt",
        "store_uri": "tos-cn-i-test/hello.txt",
        "session_key": "sk",
        "service_id": "svc",
        "access_key": "ak",
        "secret_key": "sk",
        "session_token": "st",
    }
    await redis.setex(f"nyy:commit:{token}", 1800, json.dumps(token_data))

    with patch(
        "app.api.v1.uploads.get_doubao_client",
        new_callable=AsyncMock,
    ) as mock_get:
        mock_client = AsyncMock()
        mock_client.commit_upload.return_value = CommitResult(
            store_uri="tos-cn-i-test/hello.txt", success=True
        )
        mock_get.return_value = mock_client

        resp = await client.post("/api/v1/uploads/commit", json={
            "files": [{"commit_token": token, "store_uri": "tos-cn-i-test/hello.txt"}],
        })

    assert resp.status_code == 201
    data = resp.json()
    assert len(data["share_code"]) == 6
    assert data["share_code"] in data["share_url"]
    assert data["file_count"] == 1

    # commit_token 应已删除
    assert await redis.get(f"nyy:commit:{token}") is None

    # 配额应已扣减
    used = int(await redis.get("nyy:quota:ip:127.0.0.1:bytes") or 0)
    assert used == 512


@pytest.mark.asyncio
async def test_upload_commit_attaches_playback_assets(client, redis, _raise_share_limit):
    """commit 时为单对象 MP4 写入自动生成的 playback_assets。"""
    logical_file_id = str(uuid.uuid4())
    token = "video-commit-token-abc"
    token_data = {
        "ip": "127.0.0.1",
        "file_name": "movie.mp4",
        "file_size": 1024,
        "file_ext": "mp4",
        "content_type": "video/mp4",
        "store_uri": "tos-cn-i-test/movie.mp4",
        "session_key": "sk",
        "service_id": "svc",
        "access_key": "ak",
        "secret_key": "sk",
        "session_token": "st",
    }
    metadata = {
        "probe_status": "ok",
        "container": "mp4",
        "is_faststart": False,
        "moov_offset": 4096,
        "moov_size": 2048,
        "audio_tracks": [{"codec": "mp4a.40.2", "codec_tag": "mp4a"}],
    }
    enriched_metadata = {
        **metadata,
        "playback_hints": {"needs_virtual_faststart": True},
        "playback_assets": [{
            "kind": "mp4_faststart_init",
            "store_uri": "tos-cn-i-test/movie-init.mp4",
            "sidecar_size": 2048,
            "virtual_size": 1024,
            "source_media_start": 32,
            "source_media_end": 4096,
        }],
    }
    await redis.setex(f"nyy:commit:{token}", 1800, json.dumps(token_data))

    with patch(
        "app.api.v1.uploads.get_doubao_client",
        new_callable=AsyncMock,
    ) as mock_get, patch(
        "app.api.v1.uploads.attach_playback_assets_for_single_object",
        new_callable=AsyncMock,
        return_value=enriched_metadata,
    ) as mock_attach:
        mock_client = AsyncMock()
        mock_client.commit_upload.return_value = CommitResult(
            store_uri="tos-cn-i-test/movie.mp4", success=True
        )
        mock_get.return_value = mock_client

        resp = await client.post("/api/v1/uploads/commit", json={
            "files": [{
                "commit_token": token,
                "store_uri": "tos-cn-i-test/movie.mp4",
                "logical_file_id": logical_file_id,
            }],
            "logical_files": [{
                "logical_file_id": logical_file_id,
                "file_name": "movie.mp4",
                "file_size": 1024,
                "content_type": "video/mp4",
                "chunk_total": 1,
                "media_metadata": metadata,
            }],
        })

    assert resp.status_code == 201
    mock_attach.assert_awaited_once()
    attach_kwargs = mock_attach.await_args.kwargs
    assert attach_kwargs["metadata"] == metadata
    assert attach_kwargs["original_name"] == "movie.mp4"
    assert attach_kwargs["size"] == 1024
    assert attach_kwargs["tos_uri"] == "tos-cn-i-test/movie.mp4"

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        logical_file = await db.scalar(
            select(ShareLogicalFile)
            .join(Share, Share.id == ShareLogicalFile.share_id)
            .where(Share.code == resp.json()["share_code"])
        )
    assert logical_file is not None
    assert logical_file.media_metadata["playback_hints"]["needs_virtual_faststart"] is True
    assert logical_file.media_metadata["playback_assets"][0]["kind"] == "mp4_faststart_init"


@pytest.mark.asyncio
async def test_upload_commit_invalid_token(client, redis):
    """无效 commit_token 返回 400。"""
    resp = await client.post("/api/v1/uploads/commit", json={
        "files": [{"commit_token": "nonexistent", "store_uri": "whatever"}],
    })
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_upload_commit_uri_mismatch(client, redis):
    """store_uri 不匹配返回 400。"""
    token = "mismatch-token"
    token_data = {
        "ip": "127.0.0.1",
        "file_name": "a.bin",
        "file_size": 100,
        "file_ext": "bin",
        "store_uri": "tos-cn-i-test/real.bin",
        "session_key": "sk",
        "service_id": "svc",
        "access_key": "ak",
        "secret_key": "sk",
        "session_token": "st",
    }
    await redis.setex(f"nyy:commit:{token}", 1800, json.dumps(token_data))

    resp = await client.post("/api/v1/uploads/commit", json={
        "files": [{"commit_token": token, "store_uri": "tos-cn-i-test/WRONG.bin"}],
    })
    assert resp.status_code == 400
