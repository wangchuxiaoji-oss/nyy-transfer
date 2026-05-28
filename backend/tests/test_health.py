"""不依赖数据库的健康检查测试。覆盖 /healthz。

/readyz 依赖真实 DB，测试在 Week 1 暂不覆盖。
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app


def test_healthz() -> None:
    with TestClient(app) as client:
        resp = client.get("/healthz")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert "version" in body
