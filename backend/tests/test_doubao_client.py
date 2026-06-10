"""豆包客户端行为测试。"""

from __future__ import annotations

import json
from urllib.parse import parse_qs

import httpx
import pytest

from app.services.doubao_client import CommitResult, DoubaoClientError, DoubaoUploadClient, get_doubao_download_url


@pytest.mark.asyncio
async def test_commit_upload_refreshes_sts_before_signing():
    """CommitImageUpload 应刷新 STS, 避免复用 Redis 里的过期签名凭证。"""
    seen_commit_headers: list[httpx.Headers] = []
    seen_commit_service_ids: list[str] = []

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
                        },
                    },
                },
            )

        if request.url.path == "/top/v1":
            seen_commit_headers.append(request.headers)
            seen_commit_service_ids.append(parse_qs(request.url.query.decode()).get("ServiceId", [""])[0])
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
        )
    finally:
        await client.close()

    assert result == CommitResult(store_uri="tos-cn-i-test/file.mp4", success=True)
    assert seen_commit_service_ids == ["fresh-service"]
    assert seen_commit_headers[0]["X-Amz-Security-Token"] == "FRESH_TOKEN"
    assert "Credential=FRESH_AK/" in seen_commit_headers[0]["Authorization"]
    assert "OLD_AK" not in seen_commit_headers[0]["Authorization"]


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
