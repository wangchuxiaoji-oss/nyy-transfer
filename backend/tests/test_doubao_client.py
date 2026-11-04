"""豆包客户端行为测试。"""

from __future__ import annotations

import json
import os
import stat
from urllib.parse import parse_qs

import httpx
import pytest

from app.services.doubao_client import (
    CommitResult,
    DoubaoClientError,
    DoubaoUploadClient,
    DownloadUrlResult,
    _write_session_data,
    create_doubao_client_from_session,
    get_doubao_download_url,
)


@pytest.mark.asyncio
async def test_download_urls_include_backup_url():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={
            "code": 0,
            "data": {
                "file_urls": [{
                    "main_url": "https://main.test/file.mkv?signature=main",
                    "back_url": "https://backup.test/file.mkv?signature=backup",
                }],
            },
        })

    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        urls = await client.get_download_urls("tos-cn-i-test/file.mkv", expire_seconds=86400)
    finally:
        await client.close()

    assert urls == DownloadUrlResult(
        main_url="https://main.test/file.mkv?signature=main",
        backup_url="https://backup.test/file.mkv?signature=backup",
    )


@pytest.mark.asyncio
async def test_download_urls_batch_preserves_uri_mapping():
    request_bodies: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        request_bodies.append(json.loads(request.content))
        return httpx.Response(200, json={
            "code": 0,
            "data": {
                "file_urls": [
                    {"main_url": f"https://main.test/{index}", "back_url": ""}
                    for index, _ in enumerate(request_bodies[-1]["uris"])
                ],
            },
        })

    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    uris = ["tos-cn-i-test/first.webp", "tos-cn-i-test/second.webp"]
    try:
        urls = await client.get_download_urls_batch(uris, expire_seconds=3600)
    finally:
        await client.close()

    assert request_bodies == [{
        "uris": uris,
        "type": "file",
        "format": "webp",
        "expire_second": 3600,
    }]
    assert urls[uris[0]].main_url == "https://main.test/0"
    assert urls[uris[1]].main_url == "https://main.test/1"


@pytest.mark.asyncio
async def test_init_upload_preserves_console_apply_parameters():
    seen_query: dict[str, list[str]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/passport/token/beat/web/":
            return httpx.Response(200, json={"data": {"error_code": 0}})
        if request.url.path == "/alice/resource/prepare_upload":
            return httpx.Response(200, json={
                "code": 0,
                "data": {
                    "service_id": "test-service",
                    "upload_auth_token": {
                        "access_key": "AK_TEST",
                        "secret_key": "SK_TEST",
                        "session_token": "STS_TEST",
                        "current_time": "2026-01-01T00:00:00Z",
                        "expired_time": "2026-01-01T01:00:00Z",
                    },
                },
            })
        if request.url.path == "/top/v1":
            seen_query.update(parse_qs(request.url.query.decode()))
            return httpx.Response(200, json={
                "Result": {
                    "UploadAddress": {
                        "StoreInfos": [{
                            "StoreUri": "tos-cn-i-test/console.bin",
                            "Auth": "SpaceKey/test/auth",
                        }],
                        "UploadHosts": ["tos-test.example.com"],
                        "SessionKey": "console-session",
                    },
                },
            })
        return httpx.Response(404)

    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await client.init_upload(
            file_size=16,
            file_ext="bin",
            store_key="console.bin",
        )
    finally:
        await client.close()

    assert seen_query["NeedFallback"] == ["true"]
    assert seen_query["s"] == ["jdnfglwfkl"]
    assert seen_query["StoreKeys"] == ["console.bin"]
    assert seen_query["FileExtension"] == [".bin"]
    assert result.current_time == "2026-01-01T00:00:00Z"
    assert result.expired_time == "2026-01-01T01:00:00Z"
    assert result.raw_result["UploadAddress"]["SessionKey"] == "console-session"


@pytest.mark.asyncio
async def test_commit_upload_refreshes_sts_before_signing():
    """CommitImageUpload 应刷新 STS, 避免复用 Redis 里的过期签名凭证。"""
    seen_commit_headers: list[httpx.Headers] = []
    seen_commit_service_ids: list[str] = []
    seen_commit_bodies: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/alice/resource/prepare_upload":
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "data": {
                        "service_id": "fresh-service",
                        "upload_auth_token": {
                            "access_key": "FRESH_AK",
                            "secret_key": "FRESH_SK",
                            "session_token": "FRESH_TOKEN",
                            "current_time": "2026-01-01T00:00:00Z",
                            "expired_time": "2026-01-01T01:00:00Z",
                        },
                    },
                },
            )

        if request.url.path == "/top/v1":
            seen_commit_headers.append(request.headers)
            seen_commit_service_ids.append(parse_qs(request.url.query.decode()).get("ServiceId", [""])[0])
            seen_commit_bodies.append(json.loads(request.content))
            return httpx.Response(
                200,
                json={
                    "Result": {
                        "Results": [
                            {"Uri": "tos-cn-i-test/file.mp4", "UriStatus": 2000},
                        ],
                    },
                },
            )

        return httpx.Response(404)

    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await client.commit_upload(
            service_id="old-service",
            session_key="old-session-key",
            access_key="OLD_AK",
            secret_key="OLD_SK",
            session_token="OLD_TOKEN",
            success_oids=["tos-cn-i-test/file.mp4"],
        )
    finally:
        await client.close()

    assert result == CommitResult(store_uri="tos-cn-i-test/file.mp4", success=True)
    assert seen_commit_service_ids == ["fresh-service"]
    assert seen_commit_bodies == [{
        "SessionKey": "old-session-key",
        "SuccessOids": ["tos-cn-i-test/file.mp4"],
    }]
    assert seen_commit_headers[0]["X-Amz-Security-Token"] == "FRESH_TOKEN"
    assert "Credential=FRESH_AK/" in seen_commit_headers[0]["Authorization"]
    assert "OLD_AK" not in seen_commit_headers[0]["Authorization"]


@pytest.mark.asyncio
async def test_delete_upload_files_uses_doubao_resource_api():
    seen_body: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/alice/resource/delete_files":
            seen_body.update(json.loads(request.content))
            return httpx.Response(200, json={
                "code": 0,
                "msg": "success",
            })
        return httpx.Response(404)

    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        confirmed = await client.delete_upload_files(["tos/first.jpg", "tos/missing.jpg"])
    finally:
        await client.close()

    assert seen_body == {
        "uris": [
            {"uri": "tos/first.jpg", "data_type": "image"},
            {"uri": "tos/missing.jpg", "data_type": "image"},
        ]
    }
    assert confirmed == {"tos/first.jpg", "tos/missing.jpg"}


@pytest.mark.asyncio
async def test_delete_upload_files_falls_back_to_management_api(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/alice/resource/delete_files":
            return httpx.Response(200, json={"code": 710010202, "msg": "系统错误"})
        assert request.url.host == "imagex.volcengineapi.com"
        assert parse_qs(request.url.query.decode())["Action"] == ["DeleteImageUploadFiles"]
        return httpx.Response(200, json={
            "ResponseMetadata": {"RequestId": "request"},
            "Result": {"DeletedFiles": ["tos/first.jpg", "tos/second.jpg"]},
        })

    monkeypatch.setattr(
        "app.services.doubao_client.get_settings",
        lambda: type("Settings", (), {
            "imagex_access_key": "AK",
            "imagex_secret_key": "SK",
            "imagex_session_token": "",
            "imagex_service_id": "service",
        })(),
    )
    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        confirmed = await client.delete_upload_files(["tos/first.jpg", "tos/second.jpg"])
    finally:
        await client.close()

    assert confirmed == {"tos/first.jpg", "tos/second.jpg"}


@pytest.mark.asyncio
async def test_management_delete_rejects_unconfirmed_objects(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/alice/resource/delete_files":
            return httpx.Response(200, json={"code": 710010202, "msg": "系统错误"})
        return httpx.Response(200, json={
            "ResponseMetadata": {"RequestId": "request"},
            "Result": {"DeletedFiles": ["tos/first.jpg"]},
        })

    monkeypatch.setattr(
        "app.services.doubao_client.get_settings",
        lambda: type("Settings", (), {
            "imagex_access_key": "AK",
            "imagex_secret_key": "SK",
            "imagex_session_token": "",
            "imagex_service_id": "service",
        })(),
    )
    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(DoubaoClientError, match="未确认"):
            await client.delete_upload_files(["tos/first.jpg", "tos/second.jpg"])
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_delete_upload_files_requires_management_credentials(monkeypatch):
    monkeypatch.setattr(
        "app.services.doubao_client.get_settings",
        lambda: type("Settings", (), {
            "imagex_access_key": "",
            "imagex_secret_key": "",
            "imagex_session_token": "",
            "imagex_service_id": "",
        })(),
    )
    client = DoubaoUploadClient(cookies={})
    client._http = httpx.AsyncClient(transport=httpx.MockTransport(
        lambda request: httpx.Response(
            200,
            json={"code": 710010202, "msg": "系统错误"},
        )
    ))
    with pytest.raises(DoubaoClientError, match="IMAGEX_ACCESS_KEY"):
        await client.delete_upload_files(["tos/first.jpg"])
    await client.close()


@pytest.mark.asyncio
async def test_download_url_uses_fallback_session_when_primary_fails(monkeypatch, tmp_path):
    from app.core.config import get_settings
    from app.services import doubao_client

    primary_file = tmp_path / "primary.json"
    fallback_file = tmp_path / "fallback.json"
    session_data = {"cookies": {"sessionid": "session"}, "sessionid": "session", "params": {}}
    primary_file.write_text(json.dumps(session_data), encoding="utf-8")
    fallback_file.write_text(json.dumps(session_data), encoding="utf-8")

    settings = get_settings()
    original_session_file = settings.doubao_session_file
    original_fallback_files = settings.doubao_download_fallback_session_files
    settings.doubao_session_file = str(primary_file)
    settings.doubao_download_fallback_session_files = str(fallback_file)

    calls: list[str] = []
    closed: list[str] = []

    class FakeClient:
        def __init__(self, label: str, fail: bool = False) -> None:
            self.label = label
            self.fail = fail

        async def start(self) -> None:
            return None

        async def close(self) -> None:
            closed.append(self.label)

        async def get_download_url(self, uri: str, expire_seconds: int = 3600) -> str:
            calls.append(self.label)
            if self.fail:
                raise DoubaoClientError("primary broken")
            return f"https://download.test/{uri}?expire={expire_seconds}"

    async def fake_get_primary() -> FakeClient:
        return FakeClient("primary", fail=True)

    def fake_create_from_session(session_file: str) -> FakeClient:
        return FakeClient("fallback" if session_file == str(fallback_file) else session_file)

    monkeypatch.setattr(doubao_client, "get_doubao_client", fake_get_primary)
    monkeypatch.setattr(doubao_client, "create_doubao_client_from_session", fake_create_from_session)
    try:
        url = await get_doubao_download_url("tos-cn-i-test/file.txt", expire_seconds=86400)
    finally:
        settings.doubao_session_file = original_session_file
        settings.doubao_download_fallback_session_files = original_fallback_files

    assert url == "https://download.test/tos-cn-i-test/file.txt?expire=86400"
    assert calls == ["primary", "fallback"]
    assert closed == ["fallback"]


def test_session_loader_repairs_trailing_closing_brace(tmp_path):
    session_file = tmp_path / "session.json"
    session_data = {
        "cookies": {"sessionid": "session"},
        "sessionid": "session",
        "params": {},
    }
    session_file.write_text(json.dumps(session_data) + "}", encoding="utf-8")

    client = create_doubao_client_from_session(str(session_file))

    assert client.cookies["sessionid"] == "session"
    assert json.loads(session_file.read_text("utf-8")) == session_data


def test_session_atomic_write_uses_private_directory_and_file_modes(tmp_path, monkeypatch):
    session_directory = tmp_path / "sessions"
    session_directory.mkdir(mode=0o755)
    session_file = session_directory / "session.json"
    session_file.write_text("{}", encoding="utf-8")
    session_file.chmod(0o644)

    temporary_modes: list[int] = []
    real_replace = os.replace

    def capture_replace(source, destination):
        temporary_modes.append(stat.S_IMODE(os.stat(source).st_mode))
        real_replace(source, destination)

    monkeypatch.setattr("app.services.doubao_client.os.replace", capture_replace)
    _write_session_data(session_file, {"cookies": {"sessionid": "secret"}})

    assert temporary_modes == [0o600]
    assert stat.S_IMODE(session_directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(session_file.stat().st_mode) == 0o600
    assert list(session_directory.glob("*.tmp")) == []


def test_qr_login_save_session_uses_private_permissions(tmp_path):
    from doubao_login.run import QRResult, QRStatus, save_session

    session_directory = tmp_path / "qr-sessions"
    session_file = session_directory / "session.json"
    save_session(
        QRResult(
            status=QRStatus.CONFIRMED,
            cookies={"sessionid": "secret"},
            sessionid="secret",
            device_params={"device_id": "device"},
        ),
        str(session_file),
    )

    assert stat.S_IMODE(session_directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(session_file.stat().st_mode) == 0o600
