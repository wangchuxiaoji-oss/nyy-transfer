"""服务端游客身份 Cookie 回归测试。"""

from __future__ import annotations

import fakeredis.aioredis
import pytest
from fastapi import Request
from httpx import ASGITransport, AsyncClient

from app.main import create_app
from app.services.visitor_identity import (
    _visitor_signature,
    decode_guest_cookie,
)
from app.utils.client_ip import get_guest_id


def _identity_app():
    app = create_app()
    app.state.redis = fakeredis.aioredis.FakeRedis(decode_responses=True)

    @app.get("/api/v1/test-guest-identity")
    async def guest_identity(request: Request):
        return {"guest_id": get_guest_id(request)}

    return app


@pytest.mark.asyncio
async def test_server_issues_secure_signed_guest_cookie_and_reuses_it():
    app = _identity_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="https://test") as client:
        first = await client.get("/api/v1/test-guest-identity")
        guest_id = first.json()["guest_id"]
        cookie = first.cookies.get("__Host-nyy_guest")
        second = await client.get(
            "/api/v1/test-guest-identity",
            headers={"x-nyy-guest-id": "forged-guest-device"},
        )

    assert guest_id.startswith("visitor:")
    assert cookie and decode_guest_cookie(cookie) == guest_id
    assert second.json()["guest_id"] == guest_id
    set_cookie = first.headers["set-cookie"]
    assert "HttpOnly" in set_cookie
    assert "Secure" in set_cookie
    assert "SameSite=lax" in set_cookie
    assert "Path=/" in set_cookie


@pytest.mark.asyncio
async def test_legacy_header_is_migrated_once_then_cookie_is_authoritative():
    app = _identity_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="https://test") as client:
        first = await client.get(
            "/api/v1/test-guest-identity",
            headers={"x-nyy-guest-id": "legacy-browser-device"},
        )
        second = await client.get(
            "/api/v1/test-guest-identity",
            headers={"x-nyy-guest-id": "different-browser-device"},
        )

    assert first.json()["guest_id"] == "legacy-browser-device"
    assert decode_guest_cookie(first.cookies.get("__Host-nyy_guest")) == "legacy-browser-device"
    assert first.headers["X-NYY-Guest-Migrated"] == "1"
    assert second.json()["guest_id"] == "legacy-browser-device"
    assert "X-NYY-Guest-Migrated" not in second.headers


@pytest.mark.asyncio
async def test_legacy_visitor_cookie_is_migrated_and_tampering_is_rejected():
    app = _identity_app()
    transport = ASGITransport(app=app)
    raw_visitor_id = "A" * 32
    legacy_cookie = f"{raw_visitor_id}.{_visitor_signature(raw_visitor_id)}"
    async with AsyncClient(transport=transport, base_url="https://test") as client:
        migrated = await client.get(
            "/api/v1/test-guest-identity",
            headers={"cookie": f"nyy_visitor={legacy_cookie}"},
        )

    migrated_guest_id = migrated.json()["guest_id"]
    assert migrated_guest_id == f"visitor:{raw_visitor_id}"
    assert decode_guest_cookie(migrated.cookies.get("__Host-nyy_guest")) == migrated_guest_id

    tampered = migrated.cookies["__Host-nyy_guest"] + "tampered"
    async with AsyncClient(transport=transport, base_url="https://test") as client:
        rejected = await client.get(
            "/api/v1/test-guest-identity",
            headers={"cookie": f"__Host-nyy_guest={tampered}"},
        )
    assert rejected.json()["guest_id"] != migrated_guest_id
