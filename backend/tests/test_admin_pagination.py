"""管理后台混合分页与互斥状态筛选测试。

覆盖：
- 游标模式连续翻页无重复无遗漏、before 逆向回翻、并列 created_at 稳定排序
- 页码模式精确总数与稳定排序、深页窗口保护
- 分享状态表达式互斥且与列表状态字段一致
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient

from app.db.session import get_session_factory
from app.main import create_app
from app.models.share import Share
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
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def admin_headers(client):
    factory = get_session_factory()
    async with factory() as db:
        db.add(User(
            email="admin@nyy.app",
            password_hash=hash_password("88888888"),
            is_admin=True,
            email_verified_at=datetime.now(UTC),
        ))
        await db.commit()
    response = await client.post("/api/v1/auth/login", json={"email": "admin@nyy.app", "password": "88888888"})
    assert response.status_code == 200
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def create_shares(count: int, *, same_created_at: datetime | None = None) -> list[str]:
    factory = get_session_factory()
    codes = []
    async with factory() as db:
        for index in range(count):
            code = f"pg{uuid.uuid4().hex[:10]}"
            share = Share(
                code=code,
                title=f"分页样本-{index}",
                total_bytes=index,
                created_at=same_created_at or datetime.now(UTC) - timedelta(minutes=index),
            )
            db.add(share)
            codes.append(code)
        await db.commit()
    return codes


@pytest.mark.asyncio
async def test_cursor_pagination_walks_all_pages_without_duplicates(client, admin_headers):
    codes = await create_shares(5)
    seen: list[str] = []
    after = None
    for _ in range(5):
        params = {"limit": 2}
        if after:
            params["after"] = after
        response = await client.get("/api/v1/admin/shares", headers=admin_headers, params=params)
        assert response.status_code == 200
        body = response.json()
        assert body["pagination_mode"] == "cursor"
        seen.extend(item["code"] for item in body["items"])
        if not body["has_more"]:
            assert body["next_cursor"] is None
            break
        after = body["next_cursor"]
        assert after
    assert sorted(seen) == sorted(codes)
    assert len(seen) == len(set(seen))


@pytest.mark.asyncio
async def test_cursor_before_returns_previous_batch(client, admin_headers):
    codes = await create_shares(4)
    first = await client.get("/api/v1/admin/shares", headers=admin_headers, params={"limit": 2})
    second = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"limit": 2, "after": first.json()["next_cursor"]},
    )
    assert [item["code"] for item in second.json()["items"]] == codes[2:]

    back = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"limit": 2, "before": second.json()["prev_cursor"]},
    )
    assert back.status_code == 200
    assert [item["code"] for item in back.json()["items"]] == codes[:2]


@pytest.mark.asyncio
async def test_cursor_stable_with_identical_created_at(client, admin_headers):
    same_time = datetime.now(UTC) - timedelta(hours=1)
    codes = await create_shares(5, same_created_at=same_time)
    seen: list[str] = []
    after = None
    while True:
        params = {"limit": 2}
        if after:
            params["after"] = after
        response = await client.get("/api/v1/admin/shares", headers=admin_headers, params=params)
        body = response.json()
        seen.extend(item["code"] for item in body["items"])
        if not body["has_more"]:
            break
        after = body["next_cursor"]
    assert sorted(seen) == sorted(codes)


@pytest.mark.asyncio
async def test_invalid_cursor_returns_400(client, admin_headers):
    response = await client.get("/api/v1/admin/shares", headers=admin_headers, params={"after": "not-a-cursor"})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_after_and_before_cannot_combine(client, admin_headers):
    response = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"after": "x", "before": "y"},
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_page_mode_returns_exact_total_and_stable_order(client, admin_headers):
    await create_shares(5)
    first = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"page": 1, "page_size": 2},
    )
    assert first.status_code == 200
    body = first.json()
    assert body["pagination_mode"] == "page"
    assert body["total"] == 5
    assert body["page"] == 1
    assert body["page_size"] == 2
    second = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"page": 2, "page_size": 2},
    )
    third = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"page": 3, "page_size": 2},
    )
    codes = [item["code"] for item in body["items"] + second.json()["items"] + third.json()["items"]]
    assert len(codes) == len(set(codes)) == 5
    # 两次请求第 1 页结果一致，说明排序稳定
    again = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"page": 1, "page_size": 2},
    )
    assert [item["code"] for item in again.json()["items"]] == [item["code"] for item in body["items"]]


@pytest.mark.asyncio
async def test_deep_page_window_is_rejected(client, admin_headers):
    response = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"page": 101, "page_size": 100},
    )
    assert response.status_code == 400
    assert "收窄" in response.json()["detail"]


@pytest.mark.asyncio
async def test_include_total_only_with_filters_in_cursor_mode(client, admin_headers):
    await create_shares(3)
    no_filter = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"limit": 2, "include_total": "true"},
    )
    assert no_filter.json()["total"] is None
    with_filter = await client.get(
        "/api/v1/admin/shares",
        headers=admin_headers,
        params={"limit": 2, "include_total": "true", "q": "分页样本"},
    )
    assert with_filter.json()["total"] == 3


@pytest.mark.asyncio
async def test_share_status_filters_are_mutually_exclusive(client, admin_headers):
    now = datetime.now(UTC)
    samples = {
        "active": Share(code=f"st{uuid.uuid4().hex[:10]}", total_bytes=0),
        "revoked": Share(code=f"st{uuid.uuid4().hex[:10]}", total_bytes=0, revoked_at=now),
        "expired": Share(
            code=f"st{uuid.uuid4().hex[:10]}",
            total_bytes=0,
            expires_at=now - timedelta(hours=1),
        ),
        "banned": Share(
            code=f"st{uuid.uuid4().hex[:10]}",
            total_bytes=0,
            banned_at=now,
            banned_reason="违规",
            expires_at=now - timedelta(hours=1),  # 同时过期，应只归入 banned
        ),
        "download_exhausted": Share(
            code=f"st{uuid.uuid4().hex[:10]}",
            total_bytes=0,
            max_downloads=2,
            download_count=2,
        ),
    }
    factory = get_session_factory()
    async with factory() as db:
        db.add_all(samples.values())
        await db.commit()

    hits: dict[str, set[str]] = {}
    for status_value in samples:
        response = await client.get(
            "/api/v1/admin/shares",
            headers=admin_headers,
            params={"status": status_value, "page": 1, "page_size": 20},
        )
        assert response.status_code == 200
        body = response.json()
        codes = {item["code"] for item in body["items"]}
        assert codes == {samples[status_value].code}
        assert body["total"] == 1
        assert all(item["status"] == status_value for item in body["items"])
        hits[status_value] = codes
    all_codes = [share.code for share in samples.values()]
    assert set().union(*hits.values()) == set(all_codes)


@pytest.mark.asyncio
async def test_users_cursor_and_page_modes(client, admin_headers):
    factory = get_session_factory()
    async with factory() as db:
        for index in range(4):
            db.add(User(
                email=f"pager-{index}@example.com",
                password_hash=hash_password("88888888"),
                email_verified_at=datetime.now(UTC),
            ))
        await db.commit()

    cursor_page = await client.get("/api/v1/admin/users", headers=admin_headers, params={"limit": 2})
    assert cursor_page.status_code == 200
    body = cursor_page.json()
    assert body["pagination_mode"] == "cursor"
    assert body["has_more"] is True

    walked = list(body["items"])
    after = body["next_cursor"]
    while after:
        nxt = await client.get("/api/v1/admin/users", headers=admin_headers, params={"limit": 2, "after": after})
        payload = nxt.json()
        walked.extend(payload["items"])
        after = payload["next_cursor"] if payload["has_more"] else None
    emails = [item["email"] for item in walked]
    assert len(emails) == len(set(emails))
    assert {"admin@nyy.app", *(f"pager-{i}@example.com" for i in range(4))} <= set(emails)

    page_mode = await client.get(
        "/api/v1/admin/users",
        headers=admin_headers,
        params={"page": 1, "page_size": 3, "sort": "email_asc"},
    )
    assert page_mode.status_code == 200
    assert page_mode.json()["pagination_mode"] == "page"
    assert page_mode.json()["total"] == 5
    page_emails = [item["email"] for item in page_mode.json()["items"]]
    assert page_emails == sorted(page_emails)

    deep = await client.get(
        "/api/v1/admin/users",
        headers=admin_headers,
        params={"page": 101, "page_size": 100},
    )
    assert deep.status_code == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/api/v1/admin/reports", "/api/v1/admin/emails"])
async def test_reports_and_emails_share_same_pagination_contract(client, admin_headers, path):
    from app.models.system import EmailDelivery, Report

    factory = get_session_factory()
    async with factory() as db:
        share = Share(code=f"rp{uuid.uuid4().hex[:10]}", total_bytes=0)
        db.add(share)
        await db.flush()
        for index in range(3):
            db.add(Report(share_id=share.id, reason=f"reason-{index}", status="pending"))
            db.add(EmailDelivery(
                share_id=share.id,
                recipient=f"user-{index}@example.com",
                status="failed",
                error="smtp down",
            ))
        await db.commit()

    first = await client.get(path, headers=admin_headers, params={"limit": 2})
    assert first.status_code == 200
    body = first.json()
    assert body["pagination_mode"] == "cursor"
    assert body["has_more"] is True
    assert body["next_cursor"]
    assert body["total"] is None

    second = await client.get(
        path,
        headers=admin_headers,
        params={"limit": 2, "after": body["next_cursor"]},
    )
    walked = body["items"] + second.json()["items"]
    assert len(walked) == 3
    assert len({item["id"] for item in walked}) == 3
    assert second.json()["has_more"] is False

    page_mode = await client.get(path, headers=admin_headers, params={"page": 1, "page_size": 2})
    assert page_mode.json()["pagination_mode"] == "page"
    assert page_mode.json()["total"] == 3

    deep = await client.get(path, headers=admin_headers, params={"page": 101, "page_size": 100})
    assert deep.status_code == 400
