"""管理后台权限回归测试。"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import sys
import threading
import types
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import Enum
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

from app.db.session import get_session_factory
from app.main import create_app
from app.models.auth import AuthEvent
from app.models.share import DownloadLog, Share, ShareAccessEvent, ShareFile, ShareLogicalFile
from app.models.system import AppConfig, ArchiveBatch, ArchivedShare, Report
from app.models.user import User
from app.services.auth import hash_password
from app.services.doubao_client import DownloadUrlResult


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


async def create_verified_user(email: str, *, is_admin: bool = False) -> None:
    factory = get_session_factory()
    async with factory() as db:
        result = await db.execute(select(User).where(User.email == email))
        user = result.scalar_one_or_none()
        if user:
            user.password_hash = hash_password("88888888")
            user.is_admin = is_admin
            user.email_verified_at = datetime.now(UTC)
            user.disabled_at = None
            user.deleted_at = None
        else:
            db.add(User(
                email=email,
                password_hash=hash_password("88888888"),
                is_admin=is_admin,
                email_verified_at=datetime.now(UTC),
            ))
        await db.commit()


async def get_user_id(email: str) -> str:
    factory = get_session_factory()
    async with factory() as db:
        user = await db.scalar(select(User).where(User.email == email))
        assert user is not None
        return str(user.id)


async def login_headers(client: AsyncClient, email: str) -> dict[str, str]:
    response = await client.post("/api/v1/auth/login", json={"email": email, "password": "88888888"})
    assert response.status_code == 200
    token = response.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


async def create_admin_preview_share(status: str) -> tuple[str, int]:
    now = datetime.now(UTC)
    code = f"ap{uuid.uuid4().hex[:10]}"
    share = Share(
        code=code,
        title="__test_admin_report__",
        password_hash=hash_password("1234"),
        total_bytes=1234,
        max_downloads=1 if status == "download_exhausted" else 0,
        download_count=1 if status == "download_exhausted" else 0,
        expires_at=now - timedelta(hours=1) if status == "expired" else now + timedelta(days=1),
        revoked_at=now if status == "revoked" else None,
        banned_at=now if status == "banned" else None,
        banned_reason="测试封禁" if status == "banned" else None,
        ip_created_from="8.8.8.8",
        guest_id=f"guest-{code}",
    )
    logical = ShareLogicalFile(
        share=share,
        sort_index=0,
        original_name="admin-preview.txt",
        size=1234,
        content_type="text/plain",
        chunk_total=1,
    )
    share_file = ShareFile(
        share=share,
        logical_file=logical,
        original_name="admin-preview.txt",
        size=1234,
        content_type="text/plain",
        tos_uri=f"tos-cn-i-test/{code}.txt",
        chunk_index=0,
        chunk_total=1,
    )
    factory = get_session_factory()
    async with factory() as db:
        db.add_all([share, logical, share_file])
        await db.commit()
    return code, share.download_count


@pytest.mark.asyncio
async def test_admin_dashboard_returns_operational_signals(client: AsyncClient):
    email = "admin@nyy.app"
    await create_verified_user(email, is_admin=True)
    headers = await login_headers(client, email)

    response = await client.get("/api/v1/admin/dashboard", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"tasks", "today", "totals"}
    assert body["tasks"]["reports_pending"] >= 0
    assert body["today"]["shares_created"] >= 0
    assert body["totals"]["users_total"] >= 1


async def restore_app_config(key: str, value: dict | None, updated_by=None) -> None:
    factory = get_session_factory()
    async with factory() as db:
        row = await db.scalar(select(AppConfig).where(AppConfig.key == key))
        if value is None:
            if row:
                await db.delete(row)
        elif row:
            row.value = value
            row.updated_by = updated_by
        else:
            db.add(AppConfig(key=key, value=value, updated_by=updated_by))
        await db.commit()


def install_fake_doubao_qr(monkeypatch, *, auto_confirm: bool = False):
    import app.api.v1.admin.doubao as doubao_api
    from app.services import doubao_client

    doubao_api._qr_instance = None
    doubao_api._qr_lock_token = None
    doubao_api._qr_login_state.update({"status": "idle", "qr_base64": "", "error": ""})
    doubao_api._qr_test_b_instance = None
    doubao_api._qr_test_b_lock_token = None
    doubao_api._qr_test_b_state.update({"status": "idle", "qr_base64": "", "error": ""})

    class FakeQRStatus(Enum):
        IDLE = "idle"
        FETCHING_QR = "fetching_qr"
        WAITING_SCAN = "waiting_scan"
        SCANNED = "scanned"
        CONFIRMED = "confirmed"
        EXPIRED = "expired"
        ERROR = "error"

    @dataclass
    class FakeQRResult:
        status: FakeQRStatus = FakeQRStatus.IDLE
        qrcode_data: bytes = b""
        cookies: dict[str, str] = field(default_factory=dict)
        sessionid: str = ""
        device_params: dict[str, str] = field(default_factory=dict)
        error: str = ""

    class FakeQRLogin:
        def __init__(self) -> None:
            self._running = False
            self.qrcode_data = b""

        @property
        def is_running(self) -> bool:
            return self._running

        def start(self, on_status=None, on_done=None) -> None:
            self._running = True
            self.qrcode_data = b"fake-qr-png"
            if on_status:
                on_status(FakeQRStatus.WAITING_SCAN, "Waiting for scan")
            if auto_confirm:
                def finish() -> None:
                    self._running = False
                    if on_done:
                        on_done(FakeQRResult(
                            status=FakeQRStatus.CONFIRMED,
                            qrcode_data=self.qrcode_data,
                            cookies={"sessionid": "new-session-id"},
                            sessionid="new-session-id",
                            device_params={"device_id": "fake-device"},
                        ))

                threading.Timer(0.02, finish).start()

        def cancel(self) -> None:
            self._running = False

    qr_module = types.ModuleType("qr_login")
    qr_module.QRLogin = FakeQRLogin
    qr_module.QRStatus = FakeQRStatus
    qr_module.QRResult = FakeQRResult

    saved_sessions = []
    run_module = types.ModuleType("run")
    run_module.save_session = lambda result, output_path: saved_sessions.append((result, output_path))

    shutdown_calls = []

    async def fake_shutdown_doubao_client() -> None:
        shutdown_calls.append(True)

    monkeypatch.setitem(sys.modules, "qr_login", qr_module)
    monkeypatch.setitem(sys.modules, "run", run_module)
    monkeypatch.setattr(doubao_client, "shutdown_doubao_client", fake_shutdown_doubao_client)
    return saved_sessions, shutdown_calls


@pytest.mark.asyncio
async def test_admin_api_requires_login(client):
    response = await client.get("/api/v1/admin/stats")
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_admin_api_rejects_regular_user(client):
    await create_verified_user("user-admin-check@example.com")
    headers = await login_headers(client, "user-admin-check@example.com")

    response = await client.get("/api/v1/admin/stats", headers=headers)

    assert response.status_code == 403


@pytest.mark.asyncio
async def test_admin_api_allows_admin_email_with_admin_flag(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")

    me_response = await client.get("/api/v1/auth/me", headers=headers)
    stats_response = await client.get("/api/v1/admin/stats", headers=headers)

    assert me_response.status_code == 200
    assert me_response.json()["is_admin"] is True
    assert stats_response.status_code == 200


@pytest.mark.asyncio
async def test_archive_execute_is_rejected_when_feature_is_disabled(client):
    from app.core.config import get_settings

    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    code, _ = await create_admin_preview_share("expired")
    settings = get_settings()
    original_enabled = settings.share_archive_enabled
    settings.share_archive_enabled = False
    try:
        dry_run = await client.post(
            "/api/v1/admin/archive/shares/dry-run",
            headers=headers,
        )
        with patch("app.api.v1.admin.archive.archive_terminal_shares", new=AsyncMock()) as archive:
            response = await client.post(
                "/api/v1/admin/archive/shares/execute",
                headers=headers,
                json={"batch_size": 10},
            )
    finally:
        settings.share_archive_enabled = original_enabled

    assert dry_run.status_code == 200
    assert dry_run.json()["dry_run"] is True
    assert response.status_code == 409
    assert response.json()["detail"] == "分享归档功能未启用；仅允许 dry-run"
    archive.assert_not_awaited()
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        assert share is not None
        assert await db.scalar(select(ShareFile.tos_uri).where(ShareFile.share_id == share.id))
        assert await db.scalar(select(func.count()).select_from(ArchivedShare)) == 0


@pytest.mark.asyncio
async def test_archive_service_does_not_commit_caller_transaction():
    from app.services.share_archive import archive_terminal_shares

    now = datetime.now(UTC)
    code = f"tx{uuid.uuid4().hex[:10]}"
    factory = get_session_factory()
    async with factory() as db:
        db.add(Share(
            code=code,
            total_bytes=0,
            created_at=now - timedelta(days=220),
            last_activity_at=now - timedelta(days=220),
            expires_at=now - timedelta(days=200),
        ))
        await db.commit()

    async with factory() as db:
        result = await archive_terminal_shares(
            db,
            actor_id=None,
            retention_days=180,
            batch_size=10,
        )
        assert result["archived_count"] == 1
        await db.rollback()

    async with factory() as db:
        assert await db.scalar(select(Share).where(Share.code == code)) is not None
        assert await db.scalar(select(func.count()).select_from(ArchiveBatch)) == 0
        assert await db.scalar(select(func.count()).select_from(ArchivedShare)) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("share_status", ["active", "revoked", "expired", "banned", "download_exhausted"])
async def test_admin_can_preview_and_download_share_in_any_status(client, share_status):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    code, original_download_count = await create_admin_preview_share(share_status)

    view_response = await client.get(f"/api/v1/admin/shares/{code}/view", headers=headers)
    list_response = await client.get("/api/v1/admin/shares", headers=headers)
    assert view_response.status_code == 200
    assert list_response.status_code == 200
    assert any(item["code"] == code for item in list_response.json()["shares"])
    assert view_response.json()["status"] == share_status
    assert view_response.json()["has_password"] is True
    assert view_response.json()["files"][0]["file_name"] == "admin-preview.txt"

    with patch("app.api.v1.shares.DoubaoDownloadUrlResolver") as resolver_class:
        resolver = AsyncMock()
        resolver.get_download_urls.return_value = DownloadUrlResult(
            main_url="https://download.test/admin-preview.txt",
            backup_url="https://backup.test/admin-preview.txt",
        )
        resolver_class.return_value = resolver
        content_response = await client.post(f"/api/v1/admin/shares/{code}/content", headers=headers)

    assert content_response.status_code == 200
    assert content_response.json()["expires_in"] == 86400
    assert content_response.json()["files"][0]["download_url"] == "https://download.test/admin-preview.txt"
    assert content_response.json()["files"][0]["backup_download_url"] == "https://backup.test/admin-preview.txt"
    resolver.get_download_urls.assert_awaited_once_with(
        f"tos-cn-i-test/{code}.txt",
        expire_seconds=86400,
    )

    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        assert share is not None
        assert share.download_count == original_download_count
        log = await db.scalar(select(DownloadLog).where(DownloadLog.share_id == share.id))
        assert log is None


@pytest.mark.asyncio
async def test_admin_share_preview_rejects_non_admin(client):
    await create_verified_user("preview-user@example.com")
    headers = await login_headers(client, "preview-user@example.com")
    code, _ = await create_admin_preview_share("revoked")

    unauthenticated = await client.get(f"/api/v1/admin/shares/{code}/view")
    forbidden_view = await client.get(f"/api/v1/admin/shares/{code}/view", headers=headers)
    forbidden_content = await client.post(f"/api/v1/admin/shares/{code}/content", headers=headers)

    assert unauthenticated.status_code == 401
    assert forbidden_view.status_code == 403
    assert forbidden_content.status_code == 403


@pytest.mark.asyncio
async def test_admin_share_content_reports_file_service_failure(client):
    from app.services.doubao_client import DoubaoClientError

    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    code, _ = await create_admin_preview_share("expired")

    with patch(
        "app.api.v1.admin.shares._get_download_urls",
        new=AsyncMock(side_effect=DoubaoClientError("session broken")),
    ):
        response = await client.post(f"/api/v1/admin/shares/{code}/content", headers=headers)

    assert response.status_code == 503
    assert response.json()["detail"] == "文件服务暂时不可用，请稍后重试"


@pytest.mark.asyncio
async def test_share_view_access_is_recorded_and_deduplicated(client):
    code = f"sv{uuid.uuid4().hex[:10]}"
    factory = get_session_factory()
    async with factory() as db:
        db.add(Share(
            code=code,
            title="__test_admin_report__",
            total_bytes=0,
            expires_at=datetime.now(UTC) + timedelta(days=1),
        ))
        await db.commit()

    headers = {"User-Agent": "pytest-browser", "X-NYY-Guest-ID": "guest-source-test"}
    first = await client.post(f"/api/v1/shares/{code}/access", headers=headers)
    second = await client.post(f"/api/v1/shares/{code}/access", headers=headers)
    other_guest = await client.post(
        f"/api/v1/shares/{code}/access",
        headers={"User-Agent": "pytest-browser", "X-NYY-Guest-ID": "guest-source-other"},
    )

    assert first.status_code == 204
    assert second.status_code == 204
    assert other_guest.status_code == 204
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        events = await db.scalars(select(ShareAccessEvent).where(ShareAccessEvent.share_id == share.id))
        rows = events.all()
    assert len(rows) == 2
    assert {row.event_type for row in rows} == {"view"}
    assert {row.guest_id for row in rows} == {"guest-source-test", "guest-source-other"}


@pytest.mark.asyncio
async def test_admin_share_sources_and_ip_relations(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    code, _ = await create_admin_preview_share("expired")
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        db.add(ShareAccessEvent(
            share_id=share.id,
            event_type="view",
            ip="8.8.8.8",
            user_agent="pytest-browser",
            guest_id="guest-source-test",
            created_at=datetime.now(UTC),
        ))
        await db.commit()

    list_response = await client.get("/api/v1/admin/shares", headers=headers)
    sources_response = await client.get(f"/api/v1/admin/shares/{code}/sources", headers=headers)
    relations_response = await client.get("/api/v1/admin/ip-relations?ip=8.8.8.8", headers=headers)

    assert list_response.status_code == 200
    item = next(item for item in list_response.json()["shares"] if item["code"] == code)
    assert item["source"]["ip"] == "8.8.8.8"
    assert re.fullmatch(r"访客 #[A-F0-9]{8}", item["guest_label"])
    assert item["access_event_count"] == 1
    assert sources_response.status_code == 200
    assert sources_response.json()["events"][0]["event_type"] == "view"
    assert relations_response.status_code == 200
    assert any(item["code"] == code for item in relations_response.json()["shares"])


@pytest.mark.asyncio
async def test_admin_ip_relations_composite_cursor_keeps_independent_streams(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    factory = get_session_factory()
    user_ids = [
        uuid.UUID("00000000-0000-0000-0000-000000000010"),
        uuid.UUID("00000000-0000-0000-0000-000000000020"),
    ]
    share_ids = [
        uuid.UUID("f0000000-0000-0000-0000-000000000010"),
        uuid.UUID("f0000000-0000-0000-0000-000000000020"),
    ]
    async with factory() as db:
        users = [
            User(
                id=user_id,
                email=f"cursor-{index}@example.com",
                password_hash=hash_password("88888888"),
                email_verified_at=datetime.now(UTC),
            )
            for index, user_id in enumerate(user_ids)
        ]
        shares = [
            Share(
                id=share_id,
                code=f"cu{index:04d}",
                guest_id=f"cursor-guest-{index}",
                ip_created_from="7.7.7.7",
                total_bytes=0,
            )
            for index, share_id in enumerate(share_ids)
        ]
        db.add_all([*users, *shares])
        await db.flush()
        db.add_all(
            AuthEvent(
                user_id=user_id,
                event_type="login_success",
                success=True,
                ip="7.7.7.7",
                created_at=datetime.now(UTC),
            )
            for user_id in user_ids
        )
        await db.commit()

    first = await client.get(
        "/api/v1/admin/ip-relations?ip=7.7.7.7&limit=1",
        headers=headers,
    )
    assert first.status_code == 200
    assert first.json()["has_more"] is True
    second = await client.get(
        "/api/v1/admin/ip-relations",
        headers=headers,
        params={"ip": "7.7.7.7", "limit": 1, "after": first.json()["next_cursor"]},
    )

    assert second.status_code == 200
    assert [item["id"] for item in second.json()["users"]] == [str(user_ids[1])]
    assert [item["code"] for item in second.json()["shares"]] == ["cu0001"]
    assert len(second.json()["guest_labels"]) == 1


@pytest.mark.asyncio
async def test_admin_share_sources_do_not_double_count_link_issue(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    code, _ = await create_admin_preview_share("expired")
    occurred_at = datetime.now(UTC)
    request_id = f"link-{uuid.uuid4().hex}"
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        db.add_all([
            ShareAccessEvent(
                share_id=share.id,
                event_type="link_issued",
                ip="9.9.9.9",
                user_agent="pytest-download",
                request_id=request_id,
                created_at=occurred_at,
            ),
            DownloadLog(
                share_id=share.id,
                ip="9.9.9.9",
                ua="pytest-download",
                request_id=request_id,
                downloaded_at=occurred_at,
            ),
        ])
        await db.commit()

    response = await client.get(f"/api/v1/admin/shares/{code}/sources", headers=headers)

    assert response.status_code == 200
    body = response.json()
    assert body["event_count"] == 1
    assert body["event_type_counts"]["link_issued"] == 1
    assert len(body["events"]) == 1


@pytest.mark.asyncio
async def test_admin_user_sources_include_registration_and_login(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    await create_verified_user("source-user@example.com")
    admin_headers = await login_headers(client, "admin@nyy.app")
    await login_headers(client, "source-user@example.com")
    user_id = await get_user_id("source-user@example.com")
    factory = get_session_factory()
    async with factory() as db:
        db.add(AuthEvent(
            user_id=uuid.UUID(user_id),
            event_type="register_success",
            success=True,
            ip="1.1.1.1",
            user_agent="pytest-register",
            created_at=datetime.now(UTC) - timedelta(hours=1),
        ))
        await db.commit()

    list_response = await client.get("/api/v1/admin/users?q=source-user@example.com", headers=admin_headers)
    sources_response = await client.get(f"/api/v1/admin/users/{user_id}/sources", headers=admin_headers)
    relations_response = await client.get("/api/v1/admin/ip-relations?ip=1.1.1.1", headers=admin_headers)

    assert list_response.status_code == 200
    assert list_response.json()["users"][0]["registration_source"]["ip"] == "1.1.1.1"
    assert sources_response.status_code == 200
    assert sources_response.json()["registration_source"]["ip"] == "1.1.1.1"
    assert any(event["event_type"] == "login" for event in sources_response.json()["events"])
    assert relations_response.status_code == 200
    assert any(user["email"] == "source-user@example.com" for user in relations_response.json()["users"])


@pytest.mark.asyncio
async def test_admin_can_update_user_state(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    await create_verified_user("managed-user@example.com")
    headers = await login_headers(client, "admin@nyy.app")
    user_id = await get_user_id("managed-user@example.com")

    update_response = await client.patch(
        f"/api/v1/admin/users/{user_id}",
        headers=headers,
        json={"plan": "pro", "disabled": True, "email_verified": False},
    )
    assert update_response.status_code == 200
    body = update_response.json()
    assert body["plan"] == "pro"
    assert body["disabled"] is True
    assert body["email_verified"] is False

    disabled_login = await client.post(
        "/api/v1/auth/login",
        json={"email": "managed-user@example.com", "password": "88888888"},
    )
    assert disabled_login.status_code == 403

    restore_response = await client.patch(
        f"/api/v1/admin/users/{user_id}",
        headers=headers,
        json={"disabled": False, "email_verified": True, "deleted": True},
    )
    assert restore_response.status_code == 200
    assert restore_response.json()["deleted"] is True


@pytest.mark.asyncio
async def test_admin_can_update_report_status(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    factory = get_session_factory()
    async with factory() as db:
        share = Share(code=f"ar{uuid.uuid4().hex[:12]}", title="__test_admin_report__", total_bytes=0)
        db.add(share)
        await db.flush()
        report = Report(share_id=share.id, reason="spam", detail="test")
        db.add(report)
        await db.flush()
        report_id = str(report.id)
        await db.commit()

    response = await client.patch(
        f"/api/v1/admin/reports/{report_id}/status",
        headers=headers,
        json={"status": "resolved"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "resolved"


@pytest.mark.asyncio
async def test_download_config_defaults_to_smart_enabled(client):
    from app.services.app_config import DOWNLOAD_CONFIG_KEY

    factory = get_session_factory()
    async with factory() as db:
        row = await db.scalar(select(AppConfig).where(AppConfig.key == DOWNLOAD_CONFIG_KEY))
        original_value = dict(row.value) if row else None
        original_updated_by = row.updated_by if row else None

    try:
        await restore_app_config(DOWNLOAD_CONFIG_KEY, None)
        response = await client.get("/api/v1/shares/download-config")
    finally:
        await restore_app_config(DOWNLOAD_CONFIG_KEY, original_value, original_updated_by)

    assert response.status_code == 200
    assert response.json()["smart_download_enabled"] is True
    assert response.json()["target_image"] is True
    assert response.json()["target_other"] is True
    assert response.json()["filesystem_access_enabled"] is True


@pytest.mark.asyncio
async def test_admin_can_update_download_config(client):
    from app.services.app_config import DOWNLOAD_CONFIG_KEY

    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    factory = get_session_factory()
    async with factory() as db:
        row = await db.scalar(select(AppConfig).where(AppConfig.key == DOWNLOAD_CONFIG_KEY))
        original_value = dict(row.value) if row else None
        original_updated_by = row.updated_by if row else None

    payload = {
        "smart_download_enabled": False,
        "target_video": True,
        "target_audio": True,
        "target_pdf": True,
        "target_image": True,
        "target_other": True,
        "filesystem_access_enabled": True,
        "leave_warning_enabled": True,
    }

    try:
        update_response = await client.put("/api/v1/admin/config/download", headers=headers, json=payload)
        read_response = await client.get("/api/v1/admin/config/download", headers=headers)
        public_response = await client.get("/api/v1/shares/download-config")
    finally:
        await restore_app_config(DOWNLOAD_CONFIG_KEY, original_value, original_updated_by)

    assert update_response.status_code == 200
    assert update_response.json()["smart_download_enabled"] is False
    assert read_response.status_code == 200
    assert read_response.json()["target_image"] is True
    assert read_response.json()["target_other"] is True
    assert public_response.status_code == 200
    assert public_response.json()["smart_download_enabled"] is False


@pytest.mark.asyncio
async def test_download_config_accepts_simplified_payload(client):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")

    payload = {
        "smart_download_enabled": True,
        "target_video": True,
        "target_audio": True,
        "target_pdf": True,
        "target_image": True,
        "target_other": True,
        "filesystem_access_enabled": True,
        "leave_warning_enabled": True,
    }

    response = await client.put("/api/v1/admin/config/download", headers=headers, json=payload)

    assert response.status_code == 200


@pytest.mark.asyncio
async def test_doubao_qr_start_returns_qr_and_can_cancel(client, monkeypatch):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    install_fake_doubao_qr(monkeypatch)

    response = await client.post("/api/v1/admin/doubao/qr-start", headers=headers)
    assert response.status_code == 200
    assert response.json()["qr_base64"] == base64.b64encode(b"fake-qr-png").decode()

    status_response = await client.get("/api/v1/admin/doubao/qr-status", headers=headers)
    assert status_response.status_code == 200
    assert status_response.json()["status"] == "waiting_scan"

    cancel_response = await client.post("/api/v1/admin/doubao/qr-cancel", headers=headers)
    assert cancel_response.status_code == 200


@pytest.mark.asyncio
async def test_doubao_lock_release_requires_current_owner_token():
    from app.api.v1.admin.doubao import (
        _RELEASE_LOCK_SCRIPT,
        _acquire_qr_distributed_lock,
        _release_qr_distributed_lock,
    )

    class OwnershipRedis:
        def __init__(self) -> None:
            self.values: dict[str, str] = {}
            self.scripts: list[str] = []

        async def set(self, key, value, *, ex=None, nx=False):
            if nx and key in self.values:
                return False
            self.values[key] = value
            return True

        async def eval(self, script, key_count, key, owner_token):
            self.scripts.append(script)
            assert key_count == 1
            if self.values.get(key) != owner_token:
                return 0
            del self.values[key]
            return 1

    redis = OwnershipRedis()
    request = types.SimpleNamespace(
        app=types.SimpleNamespace(state=types.SimpleNamespace(redis=redis))
    )
    lock_key = "nyy:admin:doubao:production:lock"
    _, old_owner = await _acquire_qr_distributed_lock(
        request,
        "production",
        uuid.uuid4(),
    )
    assert old_owner

    del redis.values[lock_key]
    _, new_owner = await _acquire_qr_distributed_lock(
        request,
        "production",
        uuid.uuid4(),
    )
    assert new_owner and new_owner != old_owner
    stale_release = await _release_qr_distributed_lock(redis, "production", old_owner)
    current_release = await _release_qr_distributed_lock(
        redis,
        "production",
        new_owner,
    )

    assert stale_release is False
    assert current_release is True
    assert lock_key not in redis.values
    assert redis.scripts == [_RELEASE_LOCK_SCRIPT, _RELEASE_LOCK_SCRIPT]
    assert "redis.call('get', KEYS[1]) == ARGV[1]" in _RELEASE_LOCK_SCRIPT


@pytest.mark.asyncio
async def test_doubao_test_b_qr_uses_independent_session_file(client, monkeypatch, tmp_path):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    saved_sessions, _shutdown_calls = install_fake_doubao_qr(monkeypatch, auto_confirm=True)

    import app.api.v1.admin.doubao as doubao_api

    test_b_file = tmp_path / ".doubao_session_test_b.json"
    monkeypatch.setattr(doubao_api, "_test_b_session_file", lambda: str(test_b_file))

    response = await client.post("/api/v1/admin/doubao/test-b/qr-start", headers=headers)
    assert response.status_code == 200

    await asyncio.sleep(0.1)
    status_response = await client.get("/api/v1/admin/doubao/test-b/qr-status", headers=headers)

    assert status_response.status_code == 200
    assert status_response.json()["status"] == "confirmed"
    assert saved_sessions[0][0].sessionid == "new-session-id"
    assert saved_sessions[0][1] == str(test_b_file)


@pytest.mark.asyncio
async def test_doubao_qr_confirm_saves_session_and_resets_client(client, monkeypatch):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    saved_sessions, shutdown_calls = install_fake_doubao_qr(monkeypatch, auto_confirm=True)

    response = await client.post("/api/v1/admin/doubao/qr-start", headers=headers)
    assert response.status_code == 200

    await asyncio.sleep(0.1)
    status_response = await client.get("/api/v1/admin/doubao/qr-status", headers=headers)

    assert status_response.status_code == 200
    assert status_response.json()["status"] == "confirmed"
    assert saved_sessions[0][0].sessionid == "new-session-id"
    assert shutdown_calls == [True]


@pytest.mark.asyncio
async def test_doubao_session_status_probe_reports_real_usability(client, monkeypatch, tmp_path):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    session_file = tmp_path / ".doubao_session.json"
    login_ts = int(datetime.now(UTC).timestamp())
    expires_at = datetime.now(UTC) + timedelta(days=30)
    sid_guard = f"probe-session|{login_ts}|2592000|{expires_at.strftime('%a, %d-%b-%Y %H:%M:%S GMT')}"
    session_file.write_text(
        json.dumps({
            "cookies": {"sessionid": "probe-session", "sid_guard": sid_guard},
            "sessionid": "probe-session",
            "timestamp": 1,
        }),
        encoding="utf-8",
    )

    from app.core.config import get_settings
    from app.services import doubao_client

    settings = get_settings()
    original_session_file = settings.doubao_session_file
    settings.doubao_session_file = str(session_file)

    class FakeClient:
        async def start(self) -> None:
            return None

        async def _prepare_upload_auth(self) -> None:
            return None

        async def refresh_login_heartbeat(self, *, force: bool = False) -> None:
            return None

        async def close(self) -> None:
            return None

    monkeypatch.setattr(doubao_client, "create_doubao_client_from_session", lambda _: FakeClient())
    try:
        response = await client.get("/api/v1/admin/doubao/session-status?probe=true", headers=headers)
    finally:
        settings.doubao_session_file = original_session_file

    assert response.status_code == 200
    body = response.json()
    assert body["has_session"] is True
    assert body["verified"] is True
    assert body["usable"] is True
    assert body["check_message"] == "豆包授权验证通过；登录心跳通过"
    assert body["sid_guard_status"] == "ok"
    assert body["sid_guard_expires_at"]
    assert body["sid_guard_expires_in_hours"] > 700
    assert body["last_probe_success_at"]
    assert body["last_probe_error"] == ""
    assert body["last_heartbeat_success_at"]
    assert body["last_heartbeat_error"] == ""

    saved_session = json.loads(session_file.read_text("utf-8"))
    assert saved_session["nyy_status"]["last_probe_success_at"] > 0
    assert saved_session["nyy_status"]["last_heartbeat_success_at"] > 0
