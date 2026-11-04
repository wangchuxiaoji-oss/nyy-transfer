"""Upload init/commit API 测试。"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.api.v1.uploads import _validate_share_expiry, _validate_upload_file_size
from app.main import create_app
from app.models.media import MediaProcessingJob
from app.models.share import DownloadLog, DownloadSession, Share, ShareFile, ShareLogicalFile
from app.models.system import EmailDelivery, FileRequest, FileRequestFile
from app.models.user import User
from app.services.doubao_client import CommitResult, DownloadUrlResult, UploadInitResult
from app.services.quota_policy import EffectiveQuotaPolicy, default_policy_config


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
    """固定成功路径配额，避免依赖测试库历史数据。"""
    with patch(
        "app.api.v1.uploads._count_active_shares",
        new_callable=AsyncMock,
        return_value=0,
    ):
        yield


def _effective_policy(*, guest_limit: int | None = None, guest_active: int | None = None) -> EffectiveQuotaPolicy:
    config = default_policy_config()
    guest = config.guest.model_copy(update={
        "period_limit_bytes": guest_limit or config.guest.period_limit_bytes,
        "max_file_bytes": min(guest_limit or config.guest.max_file_bytes, config.guest.max_file_bytes),
        "max_share_bytes": min(guest_limit or config.guest.max_share_bytes, config.guest.max_share_bytes),
        "max_active_shares": guest_active or config.guest.max_active_shares,
    })
    return EffectiveQuotaPolicy(None, 1, datetime.now(UTC), config.model_copy(update={"guest": guest}))


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def _mock_init_result(*, raw_result: dict | None = None) -> UploadInitResult:
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
        current_time="2026-01-01T00:00:00Z",
        expired_time="2026-01-01T01:00:00Z",
        raw_result=raw_result,
    )


def test_upload_file_size_limits_follow_identity():
    gib = 1024 ** 3

    _validate_upload_file_size(2 * gib, max_file_size=2 * gib, is_guest=True)
    _validate_upload_file_size(10 * gib, max_file_size=10 * gib, is_guest=False)

    with pytest.raises(HTTPException) as guest_error:
        _validate_upload_file_size(2 * gib + 1, max_file_size=2 * gib, is_guest=True)
    assert guest_error.value.status_code == 403
    assert "游客单文件上限为 2GB" in guest_error.value.detail

    with pytest.raises(HTTPException) as request_error:
        _validate_upload_file_size(10 * gib + 1, max_file_size=10 * gib, is_guest=False)
    assert request_error.value.status_code == 400
    assert "10GB" in request_error.value.detail


def test_share_expiry_limits_follow_identity():
    _validate_share_expiry(72, options=[1, 6, 24, 72], role="游客")
    _validate_share_expiry(720, options=[1, 6, 24, 72, 168, 360, 720], role="登录用户")

    with pytest.raises(HTTPException) as guest_error:
        _validate_share_expiry(73, options=[1, 6, 24, 72], role="游客")
    assert guest_error.value.status_code == 400
    assert guest_error.value.detail == "游客分享有效期不在允许选项中"

    with pytest.raises(HTTPException) as user_error:
        _validate_share_expiry(721, options=[1, 6, 24, 72, 168, 360, 720], role="登录用户")
    assert user_error.value.status_code == 400
    assert user_error.value.detail == "登录用户分享有效期不在允许选项中"


@pytest.mark.asyncio
async def test_upload_init_success(client, redis, _raise_share_limit):
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
async def test_upload_init_tt_returns_console_apply_result(client, redis, _raise_share_limit):
    logical_file_id = str(uuid.uuid4())
    raw_result = {
        "UploadAddress": {
            "StoreInfos": [{"StoreUri": "tos-cn-i-test/abc123.bin", "Auth": "SpaceKey/auth"}],
            "UploadHosts": ["tos-test.example.com"],
            "SessionKey": "eyJ0ZXN0Ijp0cnVlfQ==",
        },
    }
    mock_result = _mock_init_result(raw_result=raw_result)
    with patch("app.api.v1.uploads.get_doubao_client", new_callable=AsyncMock) as mock_get:
        mock_client = AsyncMock()
        mock_client.init_upload.return_value = mock_result
        mock_get.return_value = mock_client
        response = await client.post("/api/v1/uploads/init-tt", json={
            "file_name": "console.bin",
            "file_size": 16,
            "file_ext": "bin",
            "logical_file_id": logical_file_id,
            "upload_batch_id": "console-batch",
        })

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["apply_result"] == raw_result
    assert body["store_uri"] == mock_result.store_uri
    assert body["store_key"].endswith(".bin")
    assert body["current_time"] == mock_result.current_time
    call = mock_client.init_upload.await_args.kwargs
    assert call["file_size"] == 16
    assert call["file_ext"] == "bin"
    assert call["store_key"] == body["store_key"]
    stored = json.loads(await redis.get(f"nyy:commit:{body['commit_token']}"))
    assert stored["logical_file_id"] == logical_file_id
    assert stored["tt_uploader"] is True
    assert stored["tt_committed"] is False


@pytest.mark.asyncio
async def test_tt_commit_must_finish_before_share_commit(client, redis, _raise_share_limit):
    token = "tt-console-token"
    logical_file_id = str(uuid.uuid4())
    store_uri = "tos-cn-i-test/console.txt"
    await redis.setex(f"nyy:commit:{token}", 1800, json.dumps({
        "ip": "127.0.0.1",
        "guest_id": "guest-tt-console",
        "file_name": "console.txt",
        "file_size": 16,
        "file_ext": "txt",
        "content_type": "text/plain",
        "logical_file_id": logical_file_id,
        "store_uri": store_uri,
        "session_key": "tt-session-key",
        "service_id": "tt-service",
        "access_key": "tt-ak",
        "secret_key": "tt-sk",
        "session_token": "tt-sts",
        "tt_uploader": True,
        "tt_committed": False,
        "chunk_index": 0,
        "chunk_total": 1,
        "logical_file_size": 16,
        "upload_batch_id": "tt-console-batch",
    }))
    share_body = {
        "upload_batch_id": "tt-console-batch",
        "files": [{
            "commit_token": token,
            "store_uri": store_uri,
            "logical_file_id": logical_file_id,
        }],
        "logical_files": [{
            "logical_file_id": logical_file_id,
            "file_name": "console.txt",
            "file_size": 16,
            "content_type": "text/plain",
            "chunk_total": 1,
        }],
    }

    blocked = await client.post("/api/v1/uploads/commit", json=share_body)
    assert blocked.status_code == 400
    assert blocked.json()["detail"] == "SDK 尚未完成上传确认"

    with patch("app.api.v1.uploads.get_doubao_client", new_callable=AsyncMock) as mock_get:
        mock_client = AsyncMock()
        mock_client.commit_upload.return_value = CommitResult(
            store_uri=store_uri,
            success=True,
            uri_status=2000,
        )
        mock_get.return_value = mock_client
        sdk_commit = await client.post("/api/v1/uploads/tt-commit", json={
            "commit_token": token,
            "session_key": "tt-session-key",
            "success_oids": [store_uri],
        })
        created = await client.post("/api/v1/uploads/commit", json=share_body)

    assert sdk_commit.status_code == 200, sdk_commit.text
    assert sdk_commit.json()["result"]["Results"] == [{"Uri": store_uri, "UriStatus": 2000}]
    assert created.status_code == 201, created.text
    mock_client.commit_upload.assert_awaited_once_with(
        service_id="tt-service",
        session_key="tt-session-key",
        access_key="tt-ak",
        secret_key="tt-sk",
        session_token="tt-sts",
        success_oids=[store_uri],
    )


@pytest.mark.asyncio
async def test_upload_init_succeeds_in_production_without_legacy_captcha(
    client, redis, _raise_share_limit
):
    """生产环境上传不应依赖已移除且从未校验的 hCaptcha 字段。"""
    from app.core.config import get_settings

    settings = get_settings()
    original_app_env = settings.app_env
    settings.app_env = "production"
    try:
        with patch(
            "app.api.v1.uploads.get_doubao_client",
            new_callable=AsyncMock,
        ) as mock_get:
            mock_client = AsyncMock()
            mock_client.init_upload.return_value = _mock_init_result()
            mock_get.return_value = mock_client

            response = await client.post(
                "/api/v1/uploads/init",
                json={
                    "file_name": "production.txt",
                    "file_size": 32,
                    "file_ext": "txt",
                },
            )
    finally:
        settings.app_env = original_app_env

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_multipart_init_succeeds_in_production_without_legacy_captcha(
    client, redis, _raise_share_limit
):
    """生产环境 multipart 初始化与普通上传使用相同的无伪验证码契约。"""
    from app.core.config import get_settings

    settings = get_settings()
    original_app_env = settings.app_env
    settings.app_env = "production"
    try:
        with patch(
            "app.api.v1.uploads.get_doubao_client",
            new_callable=AsyncMock,
        ) as mock_get:
            mock_client = AsyncMock()
            mock_client.init_upload.return_value = _mock_init_result()
            mock_client.init_multipart.return_value = "upload-id"
            mock_get.return_value = mock_client

            response = await client.post(
                "/api/v1/uploads/multipart-init",
                json={
                    "file_name": "production.bin",
                    "file_size": 512 * 1024 * 1024 + 1,
                    "file_ext": "bin",
                    "content_type": "application/octet-stream",
                    "logical_file_id": str(uuid.uuid4()),
                },
            )
    finally:
        settings.app_env = original_app_env

    assert response.status_code == 200
    assert response.json()["upload_id"] == "upload-id"


@pytest.mark.asyncio
async def test_upload_init_quota_exceeded(client, redis):
    """配额超限时返回 429。

    注意：固定 mock 配额配置，避免依赖 DB 中运营可调整的 AppConfig
    （生产 DB 的 guest 上限已被调高，若读真实配置该用例会失真）。
    """
    # 预设当前浏览器游客已用 199 MB
    await redis.set("nyy:quota:guest:guest-quota-full:bytes", str(199 * 1024 * 1024))

    with patch(
        "app.api.v1.uploads.get_effective_policy",
        new_callable=AsyncMock,
        return_value=_effective_policy(guest_limit=200 * 1024 * 1024),
    ), patch(
        "app.api.v1.uploads._count_active_shares",
        new_callable=AsyncMock,
        return_value=0,
    ):
        resp = await client.post("/api/v1/uploads/init", json={
            "file_name": "big.bin",
            "file_size": 2 * 1024 * 1024,  # 2 MB，超过剩余 1 MB
            "file_ext": "bin",
        }, headers={"x-nyy-guest-id": "guest-quota-full"})
    assert resp.status_code == 429


@pytest.mark.asyncio
async def test_guest_ip_quota_blocks_rotated_guest_identity(client, redis):
    """轮换游客 ID 不能绕过同一网络的周期上传总额度。"""
    from app.core.config import get_settings
    from app.services.quota import QuotaService

    limit = 200 * 1024 * 1024
    effective = _effective_policy(guest_limit=limit)
    settings = get_settings()
    original_multiplier = settings.guest_ip_quota_multiplier
    settings.guest_ip_quota_multiplier = 1
    try:
        await QuotaService(redis).consume_unreserved(
            scope="guest_ip",
            identity="127.0.0.1",
            policy=effective.config.guest,
            size=199 * 1024 * 1024,
        )
        with patch(
            "app.api.v1.uploads.get_effective_policy",
            new_callable=AsyncMock,
            return_value=effective,
        ), patch(
            "app.api.v1.uploads._count_active_shares",
            new_callable=AsyncMock,
            return_value=0,
        ):
            response = await client.post(
                "/api/v1/uploads/init",
                json={
                    "file_name": "rotated.bin",
                    "file_size": 2 * 1024 * 1024,
                    "file_ext": "bin",
                },
                headers={"x-nyy-guest-id": "rotated-quota-device"},
            )
    finally:
        settings.guest_ip_quota_multiplier = original_multiplier

    assert response.status_code == 429
    assert response.json()["detail"] == "当前网络的游客上传总额度已达上限，请登录后继续"


@pytest.mark.asyncio
async def test_guest_quota_isolated_by_guest_id(client, redis):
    """同一 IP 下不同浏览器游客不共享上传额度。"""
    await redis.set("nyy:quota:guest:guest-phone-device:bytes", str(199 * 1024 * 1024))

    phone_resp = await client.get("/api/v1/uploads/quota", headers={"x-nyy-guest-id": "guest-phone-device"})
    laptop_resp = await client.get("/api/v1/uploads/quota", headers={"x-nyy-guest-id": "guest-laptop-device"})

    assert phone_resp.status_code == 200
    assert laptop_resp.status_code == 200
    assert phone_resp.json()["used_bytes"] == 199 * 1024 * 1024
    assert laptop_resp.json()["used_bytes"] == 0


@pytest.mark.asyncio
async def test_guest_active_share_limit_isolated_by_guest_id(client, redis):
    """同一 IP 下不同浏览器游客不共享活跃分享数量。"""
    phone_guest_id = f"guest-phone-{uuid.uuid4().hex[:8]}"
    laptop_guest_id = f"guest-laptop-{uuid.uuid4().hex[:8]}"
    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        db.add(Share(
            code=f"as{uuid.uuid4().hex[:6]}",
            owner_id=None,
            guest_id=phone_guest_id,
            ip_created_from="127.0.0.1",
            total_bytes=128,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            revoke_token="token-active-limit",
        ))
        await db.commit()

    with patch(
        "app.api.v1.uploads.get_effective_policy",
        new_callable=AsyncMock,
        return_value=_effective_policy(guest_active=1),
    ), patch(
        "app.api.v1.uploads.get_doubao_client",
        new_callable=AsyncMock,
    ) as mock_get:
        mock_client = AsyncMock()
        mock_client.init_upload.return_value = _mock_init_result()
        mock_get.return_value = mock_client
        phone_resp = await client.post("/api/v1/uploads/init", json={
            "file_name": "phone.txt",
            "file_size": 16,
            "file_ext": "txt",
        }, headers={"x-nyy-guest-id": phone_guest_id})
        laptop_resp = await client.post("/api/v1/uploads/init", json={
            "file_name": "laptop.txt",
            "file_size": 16,
            "file_ext": "txt",
        }, headers={"x-nyy-guest-id": laptop_guest_id})

    assert phone_resp.status_code == 429
    assert laptop_resp.status_code == 200


@pytest.mark.asyncio
async def test_guest_active_share_limit_also_applies_to_shared_ip(client, redis):
    """轮换浏览器身份不能绕过同一网络的宽松活跃分享上限。"""
    from app.core.config import get_settings
    from app.db.session import get_session_factory

    settings = get_settings()
    original_multiplier = settings.guest_ip_active_share_multiplier
    settings.guest_ip_active_share_multiplier = 1
    try:
        factory = get_session_factory()
        async with factory() as db:
            db.add(Share(
                code=f"ip{uuid.uuid4().hex[:6]}",
                owner_id=None,
                guest_id=f"other-browser-{uuid.uuid4().hex[:8]}",
                ip_created_from="127.0.0.1",
                total_bytes=128,
                expires_at=datetime.now(UTC) + timedelta(hours=1),
                revoke_token="token-ip-active-limit",
            ))
            await db.commit()

        with patch(
            "app.api.v1.uploads.get_effective_policy",
            new_callable=AsyncMock,
            return_value=_effective_policy(guest_active=1),
        ):
            response = await client.post(
                "/api/v1/uploads/init",
                json={
                    "file_name": "rotated.txt",
                    "file_size": 16,
                    "file_ext": "txt",
                },
                headers={"x-nyy-guest-id": f"rotated-browser-{uuid.uuid4().hex[:8]}"},
            )
    finally:
        settings.guest_ip_active_share_multiplier = original_multiplier

    assert response.status_code == 429
    assert "当前网络的游客活跃分享数量已达上限" in response.json()["detail"]


@pytest.mark.asyncio
async def test_upload_commit_success(client, redis, _raise_share_limit):
    """commit 正常流程：返回 share_code。"""
    # 先手动写入 commit_token
    token = "test-commit-token-abc"
    token_data = {
        "ip": "127.0.0.1",
        "guest_id": "guest-commit-device",
        "file_name": "hello.jpg",
        "file_size": 512,
        "file_ext": "jpg",
        "store_uri": "tos-cn-i-test/hello.jpg",
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
            store_uri="tos-cn-i-test/hello.jpg", success=True
        )
        mock_get.return_value = mock_client

        resp = await client.post("/api/v1/uploads/commit", json={
            "files": [{"commit_token": token, "store_uri": "tos-cn-i-test/hello.jpg"}],
        })

    assert resp.status_code == 201
    data = resp.json()
    assert len(data["share_code"]) == 6
    assert data["share_code"] in data["share_url"]
    assert data["file_count"] == 1

    # commit_token 应已删除
    assert await redis.get(f"nyy:commit:{token}") is None

    # 配额应已扣减
    quota_response = await client.get("/api/v1/uploads/quota", headers={"x-nyy-guest-id": "guest-commit-device"})
    assert quota_response.json()["used_bytes"] == 512

    from app.db.session import get_session_factory
    async with get_session_factory()() as db:
        media_job_count = await db.scalar(select(func.count()).select_from(MediaProcessingJob))
    assert media_job_count == 0


@pytest.mark.asyncio
async def test_upload_commit_persists_email_outbox_before_dispatch(client, redis, _raise_share_limit):
    token = "email-outbox-token"
    token_data = {
        "ip": "127.0.0.1",
        "guest_id": "guest-email-outbox",
        "file_name": "email.txt",
        "file_size": 512,
        "file_ext": "txt",
        "store_uri": "tos-cn-i-test/email.txt",
        "session_key": "sk",
        "service_id": "svc",
        "access_key": "ak",
        "secret_key": "sk",
        "session_token": "st",
    }
    await redis.setex(f"nyy:commit:{token}", 1800, json.dumps(token_data))

    with patch("app.api.v1.uploads.get_doubao_client", new_callable=AsyncMock) as mock_get, patch(
        "app.services.email.dispatch_share_email",
        new=AsyncMock(side_effect=RuntimeError("worker stopped")),
    ):
        mock_client = AsyncMock()
        mock_client.commit_upload.return_value = CommitResult(
            store_uri="tos-cn-i-test/email.txt",
            success=True,
        )
        mock_get.return_value = mock_client
        response = await client.post("/api/v1/uploads/commit", json={
            "files": [{"commit_token": token, "store_uri": "tos-cn-i-test/email.txt"}],
            "recipients": ["Receiver@Example.com", "receiver@example.com"],
        })

    assert response.status_code == 201
    quota_response = await client.get("/api/v1/uploads/quota", headers={"x-nyy-guest-id": "guest-email-outbox"})
    assert quota_response.json()["used_bytes"] == 512
    from app.db.session import get_session_factory

    async with get_session_factory()() as db:
        deliveries = list((await db.scalars(select(EmailDelivery))).all())
        assert len(deliveries) == 1
        assert deliveries[0].status == "pending"
        assert deliveries[0].recipient == "receiver@example.com"
        assert deliveries[0].idempotency_key.startswith("share:")

    from app.services.email import dispatch_pending_share_email_outbox

    with patch("app.services.email.send_email", new=AsyncMock(return_value=True)) as mock_send:
        attempted, sent = await dispatch_pending_share_email_outbox()
    assert (attempted, sent) == (1, 1)
    mock_send.assert_awaited_once()
    async with get_session_factory()() as db:
        delivery = await db.scalar(select(EmailDelivery))
        assert delivery.status == "sent"


@pytest.mark.asyncio
async def test_upload_commit_rejects_legacy_download_limit(client, redis, _raise_share_limit):
    """创建分享时下载次数必须使用固定选项。"""
    await redis.setex("nyy:commit:unused", 1800, json.dumps({
        "ip": "127.0.0.1",
        "guest_id": "guest-download-limit",
        "file_name": "hello.txt",
        "file_size": 1,
        "file_ext": "txt",
        "store_uri": "tos-cn-i-test/hello.txt",
        "session_key": "sk",
        "service_id": "svc",
        "access_key": "ak",
        "secret_key": "sk",
        "session_token": "st",
    }))
    resp = await client.post("/api/v1/uploads/commit", json={
        "files": [{"commit_token": "unused", "store_uri": "tos-cn-i-test/hello.txt"}],
        "max_downloads": 5,
    })
    assert resp.status_code == 400
    assert resp.json()["detail"] == "下载次数上限不在允许选项中"


@pytest.mark.parametrize("password", ["1", "123", "abcd", "12345"])
def test_share_password_schemas_require_exactly_four_digits(password):
    from pydantic import ValidationError

    from app.api.v1.my_shares import ShareEditRequest
    from app.schemas.file_request import FileRequestCommit, FileRequestVerify
    from app.schemas.share import ShareDownloadSessionRequest, ShareVerifyRequest
    from app.schemas.upload import MultipartInitRequest, UploadCommitRequest, UploadInitRequest

    with pytest.raises(ValidationError):
        UploadCommitRequest(password=password)
    with pytest.raises(ValidationError):
        ShareEditRequest(password=password)
    with pytest.raises(ValidationError):
        ShareVerifyRequest(password=password)
    with pytest.raises(ValidationError):
        ShareDownloadSessionRequest(password=password)
    with pytest.raises(ValidationError):
        FileRequestVerify(password=password)
    with pytest.raises(ValidationError):
        FileRequestCommit(files=[{"commit_token": "token", "store_uri": "tos://file"}], password=password)
    with pytest.raises(ValidationError):
        UploadInitRequest(file_name="file.txt", file_size=1, request_password=password)
    with pytest.raises(ValidationError):
        MultipartInitRequest(file_name="file.bin", file_size=1, logical_file_id="logical", request_password=password)


@pytest.mark.asyncio
async def test_playback_assets_include_backup_url_only_after_authorization():
    from app.api.v1.shares import _metadata_with_signed_assets, _public_media_metadata

    metadata = {"playback_assets": [{"kind": "mp4_faststart_init", "store_uri": "tos://sidecar"}]}
    resolver = AsyncMock()
    resolver.get_download_urls.return_value = DownloadUrlResult(
        main_url="https://download.test/sidecar",
        backup_url="https://backup.test/sidecar",
    )

    signed = await _metadata_with_signed_assets(metadata, resolver, asyncio.Semaphore(1))
    asset = signed["playback_assets"][0]
    assert asset["download_url"] == "https://download.test/sidecar"
    assert asset["backup_download_url"] == "https://backup.test/sidecar"
    assert "store_uri" not in asset
    public_asset = _public_media_metadata(signed)["playback_assets"][0]
    assert "download_url" not in public_asset
    assert "backup_download_url" not in public_asset


@pytest.mark.asyncio
async def test_share_download_writes_download_log(client, redis, _raise_share_limit):
    """发放下载链接时同步写入最近取链日志。"""
    token = "download-log-token"
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

    with patch("app.api.v1.uploads.get_doubao_client", new_callable=AsyncMock) as mock_get:
        mock_client = AsyncMock()
        mock_client.commit_upload.return_value = CommitResult(
            store_uri="tos-cn-i-test/hello.txt", success=True
        )
        mock_get.return_value = mock_client
        commit_resp = await client.post("/api/v1/uploads/commit", json={
            "files": [{"commit_token": token, "store_uri": "tos-cn-i-test/hello.txt"}],
        })

    assert commit_resp.status_code == 201
    code = commit_resp.json()["share_code"]

    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as mock_resolver_cls:
        mock_resolver = AsyncMock()
        mock_resolver.get_download_urls.return_value = DownloadUrlResult(
            main_url="https://download.test/hello.txt",
            backup_url="https://backup.test/hello.txt",
        )
        mock_resolver_cls.return_value = mock_resolver
        download_resp = await client.get(f"/api/v1/shares/{code}/download")

    assert download_resp.status_code == 200
    assert download_resp.json()["files"][0]["backup_download_url"] == "https://backup.test/hello.txt"

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        assert share is not None
        assert share.download_count == 1
        log = await db.scalar(select(DownloadLog).where(DownloadLog.share_id == share.id))
        assert log is not None
        assert log.ua is not None


@pytest.mark.asyncio
async def test_share_download_limit_is_reserved_atomically(client, redis, _raise_share_limit):
    """并发取链时，max_downloads=1 只能成功发放一次。"""
    token = "download-limit-token"
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

    with patch("app.api.v1.uploads.get_doubao_client", new_callable=AsyncMock) as mock_get:
        mock_client = AsyncMock()
        mock_client.commit_upload.return_value = CommitResult(
            store_uri="tos-cn-i-test/hello.txt", success=True
        )
        mock_get.return_value = mock_client
        commit_resp = await client.post("/api/v1/uploads/commit", json={
            "files": [{"commit_token": token, "store_uri": "tos-cn-i-test/hello.txt"}],
            "max_downloads": 1,
        })
    assert commit_resp.status_code == 201
    code = commit_resp.json()["share_code"]

    async def slow_download_urls(_logical_files):
        await asyncio.sleep(0.05)
        return []

    with patch("app.api.v1.shares._get_download_urls", side_effect=slow_download_urls):
        first, second = await asyncio.gather(
            client.get(f"/api/v1/shares/{code}/download"),
            client.get(f"/api/v1/shares/{code}/download"),
        )

    assert sorted([first.status_code, second.status_code]) == [200, 410]

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        assert share is not None
        assert share.download_count == 1
        log_count = await db.scalar(select(func.count()).select_from(DownloadLog).where(DownloadLog.share_id == share.id))
        assert log_count == 1


@pytest.mark.asyncio
async def test_download_session_rechecks_authorization_and_stores_no_signed_url(client):
    from app.db.session import get_session_factory
    from app.utils.security import hash_secret

    code = f"ds{uuid.uuid4().hex[:8]}"
    share = Share(
        code=code,
        password_hash=hash_secret("1234"),
        total_bytes=64,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    logical = ShareLogicalFile(
        share=share,
        original_name="secure.txt",
        size=64,
        content_type="text/plain",
        chunk_total=1,
        sort_index=0,
    )
    share_file = ShareFile(
        share=share,
        logical_file=logical,
        original_name="secure.txt",
        size=64,
        content_type="text/plain",
        tos_uri="tos-cn-i-test/secure.txt",
        chunk_index=0,
        chunk_total=1,
    )
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, logical, share_file])
        await db.commit()

    public_info = await client.get(f"/api/v1/shares/{code}")
    assert public_info.status_code == 200
    assert public_info.json()["has_password"] is True
    assert public_info.json()["files"] == []
    assert public_info.json()["empty_dirs"] == []
    assert public_info.json()["total_bytes"] == 0

    request_headers = {"X-NYY-Link-Request-ID": f"session-{uuid.uuid4().hex}"}
    preview_headers = {"X-NYY-Link-Request-ID": f"preview-{uuid.uuid4().hex}"}
    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls.side_effect = [
            DownloadUrlResult(main_url="https://download.test/preview", backup_url=""),
            DownloadUrlResult(main_url="https://download.test/first", backup_url=""),
            DownloadUrlResult(main_url="https://download.test/fresh", backup_url=""),
        ]
        resolver_class.return_value = resolver
        preview = await client.post(
            f"/api/v1/shares/{code}/download-session",
            headers=preview_headers,
            json={"password": "1234", "intent": "preview"},
        )
        assert preview.status_code == 200
        assert preview.json()["files"][0]["download_url"].endswith("/preview")
        async with factory() as db:
            preview_share = await db.scalar(select(Share).where(Share.code == code))
            preview_session = await db.scalar(select(DownloadSession).where(
                DownloadSession.share_id == preview_share.id,
                DownloadSession.request_id == preview_headers["X-NYY-Link-Request-ID"],
            ))
            assert preview_share.download_count == 0
            assert preview_session is None

        first = await client.post(
            f"/api/v1/shares/{code}/download-session",
            headers={**request_headers, "User-Agent": "Mozilla/5.0 MicroMessenger/8.0.75"},
            json={"password": "1234", "delivery": "same_origin"},
        )
        replay = await client.post(
            f"/api/v1/shares/{code}/download-session",
            headers=request_headers,
            json={"password": "1234"},
        )
        wrong_password = await client.post(
            f"/api/v1/shares/{code}/download-session",
            headers=request_headers,
            json={"password": "9999"},
        )

    assert first.status_code == 200
    assert replay.status_code == 200
    assert first.json()["files"][0]["download_url"].endswith("/first")
    assert first.json()["files"][0]["proxy_download_url"].startswith(
        f"/api/v1/shares/{code}/download-proxy/"
    )
    assert replay.json()["files"][0]["download_url"].endswith("/fresh")
    assert wrong_password.status_code == 403

    async with factory() as db:
        persisted_share = await db.scalar(select(Share).where(Share.code == code))
        session = await db.scalar(select(DownloadSession).where(DownloadSession.share_id == persisted_share.id))
        assert persisted_share.download_count == 1
        assert session.response_payload == {"file_count": 1, "empty_dir_count": 0}
        assert "https://" not in json.dumps(session.response_payload)
        assert session.expires_at - session.created_at == timedelta(minutes=5)
        persisted_share.expires_at = datetime.now(UTC) - timedelta(seconds=1)
        await db.commit()

    expired = await client.post(
        f"/api/v1/shares/{code}/download-session",
        headers=request_headers,
        json={"password": "1234"},
    )
    assert expired.status_code == 410, expired.text

    async with factory() as db:
        persisted_share = await db.scalar(select(Share).where(Share.code == code))
        persisted_share.expires_at = datetime.now(UTC) + timedelta(hours=1)
        persisted_share.max_downloads = 1
        await db.commit()
    exhausted = await client.post(
        f"/api/v1/shares/{code}/download-session",
        headers=request_headers,
        json={"password": "1234"},
    )
    assert exhausted.status_code == 410, exhausted.text


@pytest.mark.asyncio
async def test_same_origin_proxy_requires_download_session_and_serves_cached_file(client):
    from app.db.session import get_session_factory

    code = f"wp{uuid.uuid4().hex[:8]}"
    request_id = f"mvp-{uuid.uuid4().hex}"
    share = Share(
        code=code,
        total_bytes=64,
        download_count=1,
        expires_at=datetime.now(UTC) + timedelta(hours=1),
    )
    logical = ShareLogicalFile(
        share=share,
        original_name="年度述职.pptx",
        size=64,
        content_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
        chunk_total=1,
        sort_index=0,
    )
    share_file = ShareFile(
        share=share,
        logical_file=logical,
        original_name="年度述职.pptx",
        size=64,
        content_type=logical.content_type,
        tos_uri="tos-cn-i-test/annual-review.pptx",
        chunk_index=0,
        chunk_total=1,
    )
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, logical, share_file])
        await db.flush()
        db.add(DownloadSession(
            share_id=share.id,
            request_id=request_id,
            response_payload={"file_count": 1, "empty_dir_count": 0},
            created_at=datetime.now(UTC),
            expires_at=datetime.now(UTC) + timedelta(minutes=5),
        ))
        await db.commit()
        logical_id = logical.id

    cached_file = Path(f"/data/nyy-runtime/download-proxy-cache/{logical_id}.pptx")
    with patch("app.api.v1.shares._ensure_proxy_cache_file", new_callable=AsyncMock, return_value=cached_file):
        head_response = await client.head(
            f"/api/v1/shares/{code}/download-proxy/{logical_id}",
            params={"session": request_id},
        )
    assert head_response.status_code == 200
    assert head_response.content == b""
    assert head_response.headers["cache-control"] == "private, no-store"
    assert head_response.headers["content-type"] == logical.content_type
    assert "filename*=UTF-8''" in head_response.headers["content-disposition"]
    assert head_response.headers["x-accel-redirect"] == f"/_internal-download-cache/{logical_id}.pptx"

    with patch("app.api.v1.shares._ensure_proxy_cache_file", new_callable=AsyncMock, return_value=cached_file):
        response = await client.get(
            f"/api/v1/shares/{code}/download-proxy/{logical_id}",
            params={"session": request_id},
            headers={"Range": "bytes=0-3"},
        )

    assert response.status_code == 200
    assert response.content == b""
    assert "filename*=UTF-8''" in response.headers["content-disposition"]
    assert response.headers["x-accel-redirect"] == f"/_internal-download-cache/{logical_id}.pptx"

    invalid = await client.get(
        f"/api/v1/shares/{code}/download-proxy/{logical_id}",
        params={"session": f"missing-{uuid.uuid4().hex}"},
    )
    assert invalid.status_code == 403


def test_wechat_user_agent_detection_is_case_insensitive_and_non_authoritative():
    from app.api.v1.shares import _is_wechat_user_agent

    assert _is_wechat_user_agent("Mozilla/5.0 MicroMessenger/8.0.75") is True
    assert _is_wechat_user_agent("Mozilla/5.0 wxwork/4.1.36") is True
    assert _is_wechat_user_agent("mozilla/5.0 micromessenger/8.0.60") is True
    assert _is_wechat_user_agent("Mozilla/5.0 Mobile Safari/604.1") is False


def test_proxy_cache_prunes_expired_and_oldest_files(tmp_path):
    from app.api.v1.shares import _prune_proxy_cache

    expired = tmp_path / "expired.bin"
    oldest = tmp_path / "oldest.bin"
    newest = tmp_path / "newest.bin"
    expired.write_bytes(b"x" * 2)
    oldest.write_bytes(b"x" * 6)
    newest.write_bytes(b"x" * 3)
    now = datetime.now(UTC).timestamp()
    os.utime(expired, (now - 30, now - 30))
    os.utime(oldest, (now - 8, now - 8))
    os.utime(newest, (now - 2, now - 2))

    with (
        patch("app.api.v1.shares._WECHAT_PROXY_CACHE_DIR", tmp_path),
        patch("app.api.v1.shares._WECHAT_PROXY_CACHE_TTL_SECONDS", 10),
        patch("app.api.v1.shares._WECHAT_PROXY_CACHE_MAX_BYTES", 10),
    ):
        _prune_proxy_cache(required_bytes=5)

    assert expired.exists() is False
    assert oldest.exists() is False
    assert newest.exists() is True


@pytest.mark.asyncio
async def test_guest_mine_requires_local_revoke_tokens(client):
    """游客列表只能返回本机持有撤销令牌的分享。"""
    suffix = uuid.uuid4().hex[:6]
    code_a = f"ga{suffix}"
    code_b = f"gb{suffix}"

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        share_a = Share(
            code=code_a,
            owner_id=None,
            ip_created_from="127.0.0.1",
            total_bytes=128,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            revoke_token="token-a",
        )
        share_a.logical_files = [ShareLogicalFile(
            original_name="guest-a.txt",
            size=128,
            content_type="text/plain",
            sort_index=0,
            chunk_total=1,
        )]
        db.add_all([
            share_a,
            Share(
                code=code_b,
                owner_id=None,
                ip_created_from="127.0.0.1",
                total_bytes=256,
                expires_at=datetime.now(UTC) + timedelta(hours=1),
                revoke_token="token-b",
            ),
        ])
        await db.commit()

    legacy_resp = await client.get("/api/v1/shares/guest-mine")
    assert legacy_resp.status_code in {404, 405}

    resp = await client.post("/api/v1/shares/guest-mine", json={
        "shares": [
            {"code": code_a, "revoke_token": "token-a"},
            {"code": code_b, "revoke_token": "wrong-token"},
        ],
    })

    assert resp.status_code == 200
    body = resp.json()
    assert [item["code"] for item in body] == [code_a]
    assert body[0]["preview_files"] == ["guest-a.txt"]
    assert body[0]["file_count"] == 1
    assert body[0]["empty_dir_count"] == 0
    assert body[0]["has_password"] is False
    assert body[0]["status"] in {"active", "expiring"}


@pytest.mark.asyncio
async def test_guest_revoke_uses_revoke_token(client):
    """游客持有撤销令牌时可以撤销自己的分享。"""
    code = f"gr{uuid.uuid4().hex[:6]}"

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        db.add(Share(
            code=code,
            owner_id=None,
            ip_created_from="127.0.0.1",
            total_bytes=128,
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            revoke_token="token-revoke",
        ))
        await db.commit()

    bad_resp = await client.request(
        "DELETE",
        f"/api/v1/shares/{code}/guest-revoke",
        json={"revoke_token": "wrong-token"},
    )
    assert bad_resp.status_code == 404

    resp = await client.request(
        "DELETE",
        f"/api/v1/shares/{code}/guest-revoke",
        json={"revoke_token": "token-revoke"},
    )
    assert resp.status_code == 200

    info_resp = await client.get(f"/api/v1/shares/{code}")
    assert info_resp.status_code == 404


@pytest.mark.asyncio
async def test_file_request_commit_rejects_token_for_other_request(client, redis):
    """收件提交不能复用其它收件链接初始化得到的 token。"""
    token = "request-token"
    token_data = {
        "ip": "127.0.0.1",
        "request_code": "right-code",
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

    resp = await client.post("/api/v1/file-requests/wrong-code/commit", json={
        "files": [{"commit_token": token, "store_uri": "tos-cn-i-test/hello.txt"}],
    })
    assert resp.status_code == 404
    assert resp.json()["detail"] == "请求链接不存在"


@pytest.mark.asyncio
async def test_file_request_commit_limit_is_checked_under_commit_lock(client, redis):
    """并发提交收件文件时，文件数量限制只能被消费一次。"""
    request_code = f"req-{uuid.uuid4().hex[:8]}"
    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        user = User(email=f"request-owner-{uuid.uuid4().hex}@example.com", password_hash="hash")
        db.add(user)
        await db.flush()
        db.add(FileRequest(
            code=request_code,
            owner_id=user.id,
            title="并发收件测试",
            expires_at=datetime.now(UTC) + timedelta(hours=1),
            max_files=1,
            max_bytes=10_000,
        ))
        await db.commit()

    for idx in range(2):
        token = f"request-lock-token-{idx}"
        await redis.setex(f"nyy:commit:{token}", 1800, json.dumps({
            "ip": "127.0.0.1",
            "user_id": str(user.id),
            "request_code": request_code,
            "file_name": f"hello-{idx}.txt",
            "file_size": 512,
            "file_ext": "txt",
            "store_uri": f"tos-cn-i-test/hello-{idx}.txt",
            "session_key": "sk",
            "service_id": "svc",
            "access_key": "ak",
            "secret_key": "sk",
            "session_token": "st",
        }))

    async def slow_commit_upload(**_kwargs):
        await asyncio.sleep(0.05)
        return CommitResult(store_uri="tos-cn-i-test/unused.txt", success=True)

    with patch("app.api.v1.file_requests.get_doubao_client", new_callable=AsyncMock) as mock_get:
        mock_client = AsyncMock()
        mock_client.commit_upload.side_effect = slow_commit_upload
        mock_get.return_value = mock_client
        first, second = await asyncio.gather(
            client.post(f"/api/v1/file-requests/{request_code}/commit", json={
                "files": [{"commit_token": "request-lock-token-0", "store_uri": "tos-cn-i-test/hello-0.txt"}],
            }),
            client.post(f"/api/v1/file-requests/{request_code}/commit", json={
                "files": [{"commit_token": "request-lock-token-1", "store_uri": "tos-cn-i-test/hello-1.txt"}],
            }),
        )

    assert sorted([first.status_code, second.status_code]) == [200, 429]
    async with factory() as db:
        count = await db.scalar(
            select(func.count())
            .select_from(FileRequestFile)
            .join(FileRequest, FileRequest.id == FileRequestFile.request_id)
            .where(FileRequest.code == request_code)
        )
        assert count == 1


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
