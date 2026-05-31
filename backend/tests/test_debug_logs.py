"""调试日志落盘接口测试。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.config import get_settings
from app.main import create_app


@pytest.fixture
def debug_log_settings(tmp_path):
    settings = get_settings()
    original_enabled = settings.debug_log_ingest_enabled
    original_dir = settings.debug_log_dir
    settings.debug_log_ingest_enabled = True
    settings.debug_log_dir = str(tmp_path / "debug-logs")
    yield Path(settings.debug_log_dir)
    settings.debug_log_ingest_enabled = original_enabled
    settings.debug_log_dir = original_dir


@pytest.fixture
async def client(debug_log_settings):
    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client


@pytest.mark.asyncio
async def test_debug_logs_are_persisted(client, debug_log_settings):
    payload = {
        "shareCode": "bpJpXZ",
        "sessionId": "session-1234",
        "pageUrl": "https://dev.nyy.app/bpJpXZ?sdp=1&debug=1",
        "userAgent": "pytest",
        "reason": "interval",
        "entries": [
            {
                "ts": 1717050000000,
                "elapsedMs": 12.3,
                "scope": "page",
                "event": "debug:on",
                "data": {"url": "https://dev.nyy.app/bpJpXZ?sdp=1&debug=1"},
                "line": "[+000012ms][page] debug:on",
            },
            {
                "ts": 1717050001000,
                "elapsedMs": 1012.8,
                "scope": "sdp-mkv",
                "event": "range:done",
                "data": {"totalBytesRead": 1024, "throughputEwmaKbps": 5120},
                "line": "[+001012ms][sdp-mkv] range:done",
            },
        ],
    }

    response = await client.post("/api/v1/debug/logs", json=payload)

    assert response.status_code == 202
    body = response.json()
    log_path = Path(body["path"])
    summary_path = Path(body["summary_path"])
    assert log_path.exists()
    assert summary_path.exists()
    assert log_path.parent == debug_log_settings / "bpJpXZ" / "session-1234"

    lines = log_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 2
    first = json.loads(lines[0])
    assert first["shareCode"] == "bpJpXZ"
    assert first["sessionId"] == "session-1234"
    assert first["scope"] == "page"
    assert first["event"] == "debug:on"

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    assert summary["shareCode"] == "bpJpXZ"
    assert summary["lastBatchSize"] == 2
    assert summary["logPath"] == str(log_path)
