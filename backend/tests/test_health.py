"""不依赖数据库的健康检查测试。覆盖 /healthz。

/readyz 依赖真实 DB，测试在 Week 1 暂不覆盖。
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import main
from app.main import _restore_redis, app


def test_healthz() -> None:
    with TestClient(app) as client:
        resp = client.get("/healthz")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "version" in body


@pytest.mark.asyncio
async def test_redis_reconnects_after_startup_failure() -> None:
    test_app = FastAPI()
    test_app.state.redis = None
    client = AsyncMock()
    client.ping.side_effect = [ConnectionError("unavailable"), True]

    await _restore_redis(test_app, client, "redis://localhost:6379/0", retry_interval=0)

    assert client.ping.await_count == 2
    assert test_app.state.redis is client


@pytest.mark.asyncio
async def test_lifespan_recovers_from_redis_startup_race(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import doubao_auto_verify, doubao_client, quota_reconciliation

    client = AsyncMock()
    client.ping.side_effect = [ConnectionError("not ready"), True]
    monkeypatch.setattr(main.Redis, "from_url", lambda *args, **kwargs: client)
    restore = main._restore_redis

    async def restore_immediately(app: FastAPI, redis: object, url: str) -> None:
        await restore(app, redis, url, retry_interval=0)

    monkeypatch.setattr(main, "_restore_redis", restore_immediately)
    monkeypatch.setattr(doubao_auto_verify, "start_doubao_auto_verifier", lambda: None)
    monkeypatch.setattr(doubao_auto_verify, "shutdown_doubao_auto_verifier", AsyncMock())
    monkeypatch.setattr(doubao_client, "shutdown_doubao_client", AsyncMock())
    monkeypatch.setattr(quota_reconciliation, "reconcile_quota_settlements", AsyncMock(return_value=0))
    test_app = FastAPI()

    async with main.lifespan(test_app):
        assert test_app.state.redis is None
        for _ in range(10):
            if test_app.state.redis is client:
                break
            await asyncio.sleep(0)
        assert test_app.state.redis is client

    client.aclose.assert_awaited_once()
