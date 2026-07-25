"""系统更新公告的发布、首次通知版本与公共可见性测试。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.session import get_session_factory
from app.main import create_app
from app.models.system import AuditLog
from app.models.user import User
from app.services.auth import hash_password


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
def app(redis):
    application = create_app()
    application.state.redis = redis
    return application


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def _admin_headers(client: AsyncClient) -> dict[str, str]:
    factory = get_session_factory()
    async with factory() as db:
        db.add(
            User(
                email="admin@nyy.app",
                password_hash=hash_password("88888888"),
                is_admin=True,
                email_verified_at=datetime.now(UTC),
            )
        )
        await db.commit()
    login = await client.post(
        "/api/v1/auth/login",
        json={"email": "admin@nyy.app", "password": "88888888"},
    )
    assert login.status_code == 200
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def _maintenance_payload(version: str = "2026.07.25-test") -> dict:
    now = datetime.now(UTC)
    return {
        "version": version,
        "category": "maintenance",
        "state": "completed",
        "priority": "important",
        "title": "系统维护完成",
        "summary": "上传与预览服务已恢复正常。",
        "details": ["数据库迁移完成", "上传链路验收通过"],
        "started_at": (now - timedelta(hours=1)).isoformat(),
        "completed_at": now.isoformat(),
    }


@pytest.mark.asyncio
async def test_announcement_admin_lifecycle_and_public_revision(client: AsyncClient):
    assert (await client.get("/api/v1/admin/announcements")).status_code == 401
    headers = await _admin_headers(client)

    created = await client.post(
        "/api/v1/admin/announcements",
        headers=headers,
        json=_maintenance_payload(),
    )
    assert created.status_code == 201
    item = created.json()
    assert item["status"] == "draft"
    assert item["revision"] == 0

    public_before = await client.get("/api/v1/system/announcements")
    assert public_before.status_code == 200
    assert public_before.json()["items"] == []

    updated = await client.patch(
        f"/api/v1/admin/announcements/{item['id']}",
        headers=headers,
        json={"summary": "生产维护完成，上传、预览与邮件服务均已恢复。"},
    )
    assert updated.status_code == 200

    published = await client.post(
        f"/api/v1/admin/announcements/{item['id']}/publish",
        headers=headers,
    )
    assert published.status_code == 200
    assert published.json()["revision"] == 1

    public_first = await client.get(
        "/api/v1/system/announcements", params={"active_only": True}
    )
    public_item = public_first.json()["items"][0]
    assert public_item["notice_id"] == f"{item['id']}:1"
    assert public_item["summary"].startswith("生产维护完成")

    republished = await client.post(
        f"/api/v1/admin/announcements/{item['id']}/publish",
        headers=headers,
    )
    assert republished.status_code == 200
    assert republished.json()["revision"] == 2
    public_second = await client.get("/api/v1/system/announcements")
    assert public_second.json()["items"][0]["notice_id"] == f"{item['id']}:2"

    archived = await client.post(
        f"/api/v1/admin/announcements/{item['id']}/archive",
        headers=headers,
    )
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"
    assert (await client.get("/api/v1/system/announcements")).json()["items"] == []

    factory = get_session_factory()
    async with factory() as db:
        actions = list(
            await db.scalars(
                select(AuditLog.action)
                .where(AuditLog.target_id == item["id"])
                .order_by(AuditLog.created_at)
            )
        )
    assert actions == [
        "announcement.create",
        "announcement.update",
        "announcement.publish",
        "announcement.publish",
        "announcement.archive",
    ]


@pytest.mark.asyncio
async def test_announcement_validation_duplicate_and_visibility_window(
    client: AsyncClient,
):
    headers = await _admin_headers(client)
    invalid = _maintenance_payload("invalid-state")
    invalid["category"] = "release"
    response = await client.post(
        "/api/v1/admin/announcements", headers=headers, json=invalid
    )
    assert response.status_code == 422

    payload = _maintenance_payload("visibility-test")
    payload["visible_until"] = (datetime.now(UTC) - timedelta(minutes=1)).isoformat()
    created = await client.post(
        "/api/v1/admin/announcements", headers=headers, json=payload
    )
    assert created.status_code == 201
    announcement_id = created.json()["id"]
    duplicate = await client.post(
        "/api/v1/admin/announcements", headers=headers, json=payload
    )
    assert duplicate.status_code == 409
    assert (
        await client.post(
            f"/api/v1/admin/announcements/{announcement_id}/publish",
            headers=headers,
        )
    ).status_code == 200

    history = await client.get("/api/v1/system/announcements")
    active = await client.get(
        "/api/v1/system/announcements", params={"active_only": True}
    )
    assert len(history.json()["items"]) == 1
    assert active.json()["items"] == []
