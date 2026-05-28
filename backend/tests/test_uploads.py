"""Upload init/commit API 测试。"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import create_app
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
    """配额超限时返回 429。"""
    # 预设已用 199 MB
    await redis.set("nyy:quota:ip:127.0.0.1:bytes", str(199 * 1024 * 1024))

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