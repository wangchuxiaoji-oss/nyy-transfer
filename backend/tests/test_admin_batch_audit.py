"""管理后台批量操作幂等、部分失败与审计闭环测试。"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.db.session import get_session_factory
from app.main import create_app
from app.models.share import Share
from app.models.system import AuditLog, EmailDelivery, Report
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


async def create_share(code: str | None = None) -> str:
    code = code or f"ba{uuid.uuid4().hex[:10]}"
    factory = get_session_factory()
    async with factory() as db:
        db.add(Share(code=code, total_bytes=0))
        await db.commit()
    return code


async def audit_rows(**filters) -> list[AuditLog]:
    factory = get_session_factory()
    async with factory() as db:
        stmt = select(AuditLog)
        for key, value in filters.items():
            stmt = stmt.where(getattr(AuditLog, key) == value)
        return list((await db.scalars(stmt.order_by(AuditLog.created_at))).all())


@pytest.mark.asyncio
async def test_batch_ban_partial_failure_and_audit(client, admin_headers):
    ok_code = await create_share()
    missing_code = "not-exist-1"
    batch_id = f"batch-{uuid.uuid4().hex[:16]}"

    response = await client.post(
        "/api/v1/admin/shares/batch-ban",
        headers=admin_headers,
        json={"codes": [ok_code, missing_code, ok_code], "reason": "垃圾内容", "batch_id": batch_id},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["processed"] == 2  # 重复 code 只处理一次
    assert body["succeeded"] == 1
    assert body["failed"] == 1
    assert body["idempotent_replay"] is False

    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == ok_code))
        assert share.banned_at is not None
        assert share.banned_reason == "垃圾内容"

    per_target = await audit_rows(action="share.ban", batch_id=batch_id)
    batch_rows = await audit_rows(action="share.batch_ban", batch_id=batch_id)
    assert len(per_target) == 1
    assert per_target[0].target_id == ok_code
    assert per_target[0].reason == "垃圾内容"
    assert per_target[0].before_value == {"banned_at": None, "banned_reason": None}
    assert per_target[0].after_value["banned_reason"] == "垃圾内容"
    assert per_target[0].ip is not None
    assert per_target[0].user_agent is not None
    assert len(batch_rows) == 1
    assert batch_rows[0].success is False  # 有失败项
    assert batch_rows[0].after_value["succeeded"] == 1


@pytest.mark.asyncio
async def test_batch_ban_same_batch_id_replays_idempotently(client, admin_headers):
    code = await create_share()
    batch_id = f"batch-{uuid.uuid4().hex[:16]}"
    payload = {"codes": [code], "reason": "首次封禁", "batch_id": batch_id}

    first = await client.post("/api/v1/admin/shares/batch-ban", headers=admin_headers, json=payload)
    assert first.status_code == 200

    # 重放时即便传入不同 reason，也返回首次结果且不再改动数据
    replay_payload = {"codes": [code], "reason": "篡改原因", "batch_id": batch_id}
    replay = await client.post("/api/v1/admin/shares/batch-ban", headers=admin_headers, json=replay_payload)
    assert replay.status_code == 200
    assert replay.json()["idempotent_replay"] is True
    assert replay.json()["results"] == first.json()["results"]

    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        assert share.banned_reason == "首次封禁"
        ban_audits = await db.scalar(
            select(func.count()).select_from(AuditLog).where(
                AuditLog.action == "share.batch_ban",
                AuditLog.batch_id == batch_id,
            )
        )
        assert ban_audits == 1


@pytest.mark.asyncio
async def test_concurrent_batch_ban_executes_once(client, admin_headers):
    codes = [await create_share() for _ in range(10)]
    batch_id = f"batch-{uuid.uuid4().hex[:16]}"
    payload = {"codes": codes, "reason": "并发封禁", "batch_id": batch_id}

    first, second = await asyncio.gather(
        client.post("/api/v1/admin/shares/batch-ban", headers=admin_headers, json=payload),
        client.post("/api/v1/admin/shares/batch-ban", headers=admin_headers, json=payload),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert sorted([first.json()["idempotent_replay"], second.json()["idempotent_replay"]]) == [False, True]
    assert len(await audit_rows(action="share.batch_ban", batch_id=batch_id)) == 1
    assert len(await audit_rows(action="share.ban", batch_id=batch_id)) == len(codes)


@pytest.mark.asyncio
async def test_batch_unban_and_single_ban_unban_audit(client, admin_headers):
    code = await create_share()
    single = await client.post(
        f"/api/v1/admin/shares/{code}/ban",
        headers=admin_headers,
        json={"reason": "人工复核"},
    )
    assert single.status_code == 200
    unban = await client.delete(f"/api/v1/admin/shares/{code}/ban", headers=admin_headers)
    assert unban.status_code == 200

    ban_rows = await audit_rows(action="share.ban", target_id=code)
    unban_rows = await audit_rows(action="share.unban", target_id=code)
    assert len(ban_rows) == 1
    assert len(unban_rows) == 1
    assert unban_rows[0].before_value["banned_reason"] == "人工复核"

    batch_id = f"batch-{uuid.uuid4().hex[:16]}"
    await client.post(f"/api/v1/admin/shares/{code}/ban", headers=admin_headers, json={"reason": "二次封禁"})
    response = await client.post(
        "/api/v1/admin/shares/batch-unban",
        headers=admin_headers,
        json={"codes": [code], "reason": "误封恢复", "batch_id": batch_id},
    )
    assert response.status_code == 200
    assert response.json()["succeeded"] == 1
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        assert share.banned_at is None
        assert share.banned_reason is None


@pytest.mark.asyncio
async def test_batch_report_status_idempotent_replay(client, admin_headers):
    factory = get_session_factory()
    async with factory() as db:
        share = Share(code=f"br{uuid.uuid4().hex[:10]}", total_bytes=0)
        db.add(share)
        await db.flush()
        report = Report(share_id=share.id, reason="spam", status="pending")
        db.add(report)
        await db.flush()
        report_id = str(report.id)
        await db.commit()

    batch_id = f"batch-{uuid.uuid4().hex[:16]}"
    payload = {"report_ids": [report_id], "status": "resolved", "note": "已处理", "batch_id": batch_id}
    first = await client.post("/api/v1/admin/reports/batch-status", headers=admin_headers, json=payload)
    assert first.status_code == 200
    assert first.json()["succeeded"] == 1

    replay = await client.post("/api/v1/admin/reports/batch-status", headers=admin_headers, json=payload)
    assert replay.json()["idempotent_replay"] is True

    status_audits = await audit_rows(action="report.status_update", batch_id=batch_id)
    assert len(status_audits) == 1
    assert status_audits[0].note == "已处理"


@pytest.mark.asyncio
async def test_concurrent_batch_report_status_executes_once(client, admin_headers):
    factory = get_session_factory()
    async with factory() as db:
        share = Share(code=f"bc{uuid.uuid4().hex[:10]}", total_bytes=0)
        db.add(share)
        await db.flush()
        reports = [Report(share_id=share.id, reason="spam", status="pending") for _ in range(10)]
        db.add_all(reports)
        await db.flush()
        report_ids = [str(report.id) for report in reports]
        await db.commit()

    batch_id = f"batch-{uuid.uuid4().hex[:16]}"
    payload = {
        "report_ids": report_ids,
        "status": "resolved",
        "note": "并发处理",
        "batch_id": batch_id,
    }
    first, second = await asyncio.gather(
        client.post("/api/v1/admin/reports/batch-status", headers=admin_headers, json=payload),
        client.post("/api/v1/admin/reports/batch-status", headers=admin_headers, json=payload),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert sorted([first.json()["idempotent_replay"], second.json()["idempotent_replay"]]) == [False, True]
    assert len(await audit_rows(action="report.batch_status", batch_id=batch_id)) == 1
    assert len(await audit_rows(action="report.status_update", batch_id=batch_id)) == len(reports)


@pytest.mark.asyncio
async def test_batch_email_retry_creates_new_attempt_and_audit(client, admin_headers):
    factory = get_session_factory()
    async with factory() as db:
        share = Share(code=f"em{uuid.uuid4().hex[:10]}", total_bytes=0)
        db.add(share)
        await db.flush()
        failed = EmailDelivery(
            share_id=share.id,
            recipient="retry@example.com",
            status="failed",
            error="smtp down",
            delivery_type="share_link",
            attempt_number=1,
        )
        sent = EmailDelivery(
            share_id=share.id,
            recipient="skip@example.com",
            status="sent",
            delivery_type="share_link",
            attempt_number=1,
        )
        db.add_all([failed, sent])
        await db.flush()
        failed_id, sent_id = str(failed.id), str(sent.id)
        await db.commit()

    batch_id = f"batch-{uuid.uuid4().hex[:16]}"
    with patch("app.services.email.send_email", new=AsyncMock(return_value=True)) as mock_send:
        response = await client.post(
            "/api/v1/admin/emails/batch-retry",
            headers=admin_headers,
            json={"delivery_ids": [failed_id, sent_id], "batch_id": batch_id},
        )
    assert response.status_code == 200
    body = response.json()
    assert body["succeeded"] == 1
    assert body["failed"] == 1  # sent 状态不可重试
    mock_send.assert_awaited_once()

    factory = get_session_factory()
    async with factory() as db:
        original = await db.scalar(select(EmailDelivery).where(EmailDelivery.id == uuid.UUID(failed_id)))
        assert original.status == "failed"  # 原记录不被覆盖
        retries = list((await db.scalars(
            select(EmailDelivery).where(EmailDelivery.parent_delivery_id == uuid.UUID(failed_id))
        )).all())
        assert len(retries) == 1
        assert retries[0].attempt_number == 2
        assert retries[0].status == "sent"
        assert retries[0].last_attempt_at is not None

    retry_audits = await audit_rows(action="email.retry", batch_id=batch_id)
    batch_audits = await audit_rows(action="email.batch_retry", batch_id=batch_id)
    assert len(retry_audits) == 1
    assert retry_audits[0].success is True
    assert len(batch_audits) == 1

    with patch("app.services.email.send_email", new=AsyncMock(return_value=True)) as mock_send:
        replay = await client.post(
            "/api/v1/admin/emails/batch-retry",
            headers=admin_headers,
            json={"delivery_ids": [failed_id, sent_id], "batch_id": batch_id},
        )
    assert replay.json()["idempotent_replay"] is True
    mock_send.assert_not_awaited()


@pytest.mark.asyncio
async def test_concurrent_email_retry_sends_once(client, admin_headers):
    factory = get_session_factory()
    async with factory() as db:
        share = Share(code=f"ec{uuid.uuid4().hex[:10]}", total_bytes=0)
        db.add(share)
        await db.flush()
        failed = EmailDelivery(
            share_id=share.id,
            recipient="concurrent@example.com",
            status="failed",
            error="smtp down",
            delivery_type="share_link",
            attempt_number=1,
        )
        db.add(failed)
        await db.flush()
        failed_id = str(failed.id)
        await db.commit()

    async def slow_send(*_args, **_kwargs):
        await asyncio.sleep(0.05)
        return True

    batch_id = f"batch-{uuid.uuid4().hex[:16]}"
    payload = {"delivery_ids": [failed_id], "batch_id": batch_id}
    with patch("app.services.email.send_email", new=AsyncMock(side_effect=slow_send)) as mock_send:
        first, second = await asyncio.gather(
            client.post("/api/v1/admin/emails/batch-retry", headers=admin_headers, json=payload),
            client.post("/api/v1/admin/emails/batch-retry", headers=admin_headers, json=payload),
        )

    assert first.status_code == 200
    assert second.status_code == 200
    assert sorted([first.json()["idempotent_replay"], second.json()["idempotent_replay"]]) == [False, True]
    assert mock_send.await_count == 1
    async with factory() as db:
        retries = list((await db.scalars(
            select(EmailDelivery).where(EmailDelivery.parent_delivery_id == uuid.UUID(failed_id))
        )).all())
        assert len(retries) == 1
        assert retries[0].status == "sent"


@pytest.mark.asyncio
async def test_config_and_user_updates_write_audit(client, admin_headers):
    quota_payload = {
        "guest_max_file_bytes": 1024,
        "guest_max_active_shares": 2,
        "guest_ttl_hours": 24,
        "user_max_file_bytes": 2048,
        "user_max_active_shares": 20,
        "user_ttl_hours": 72,
    }
    quota = await client.put("/api/v1/admin/config/quota", headers=admin_headers, json=quota_payload)
    assert quota.status_code == 200
    quota_audits = await audit_rows(action="config.quota_update", target_id="quota")
    assert len(quota_audits) == 1
    assert quota_audits[0].after_value["guest_max_file_bytes"] == 1024

    factory = get_session_factory()
    async with factory() as db:
        user = User(
            email="audit-target@example.com",
            password_hash=hash_password("88888888"),
            email_verified_at=datetime.now(UTC),
        )
        db.add(user)
        await db.flush()
        user_id = str(user.id)
        await db.commit()

    update = await client.patch(
        f"/api/v1/admin/users/{user_id}",
        headers=admin_headers,
        json={"disabled": True},
    )
    assert update.status_code == 200
    user_audits = await audit_rows(action="user.status_update", target_id=user_id)
    assert len(user_audits) == 1
    assert user_audits[0].before_value["disabled_at"] is None
    assert user_audits[0].after_value["disabled_at"] is not None


@pytest.mark.asyncio
async def test_audit_log_query_filters_and_cursor(client, admin_headers):
    code = await create_share()
    await client.post(f"/api/v1/admin/shares/{code}/ban", headers=admin_headers, json={"reason": "甲"})
    await client.delete(f"/api/v1/admin/shares/{code}/ban", headers=admin_headers)

    by_action = await client.get(
        "/api/v1/admin/audit-logs",
        headers=admin_headers,
        params={"action": "share.ban"},
    )
    assert by_action.status_code == 200
    body = by_action.json()
    assert body["pagination_mode"] == "cursor"
    assert len(body["items"]) == 1
    assert body["items"][0]["action"] == "share.ban"
    assert body["items"][0]["target_id"] == code
    assert body["items"][0]["actor_email"] == "admin@nyy.app"
    assert body["items"][0]["request_id"]
    assert body["items"][0]["ip"]
    assert body["items"][0]["before"] == {"banned_at": None, "banned_reason": None}

    by_target = await client.get(
        "/api/v1/admin/audit-logs",
        headers=admin_headers,
        params={"target_type": "share", "target_id": code, "limit": 1},
    )
    assert by_target.status_code == 200
    assert len(by_target.json()["items"]) == 1
    assert by_target.json()["has_more"] is True
    second = await client.get(
        "/api/v1/admin/audit-logs",
        headers=admin_headers,
        params={"target_type": "share", "target_id": code, "limit": 1, "after": by_target.json()["next_cursor"]},
    )
    assert len(second.json()["items"]) == 1
    assert second.json()["items"][0]["id"] != by_target.json()["items"][0]["id"]


@pytest.mark.asyncio
async def test_audit_log_not_writable_via_api(client, admin_headers):
    for method in ("post", "patch", "put", "delete"):
        response = await getattr(client, method)("/api/v1/admin/audit-logs", headers=admin_headers)
        assert response.status_code == 405
