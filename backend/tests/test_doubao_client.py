"""豆包客户端行为测试。"""

from __future__ import annotations

from urllib.parse import parse_qs

import httpx
import pytest

from app.services.doubao_client import CommitResult, DoubaoUploadClient


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
