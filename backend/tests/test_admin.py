"""管理后台权限回归测试。"""

from __future__ import annotations

import uuid
import asyncio
import base64
import json
import sys
import threading
import types
from datetime import UTC, datetime, timedelta
from dataclasses import dataclass, field
from enum import Enum

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.db.session import get_session_factory
from app.main import create_app
from app.models.share import Share
from app.models.system import AppConfig, Report
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
    import app.api.v1.admin as admin_api
    from app.services import doubao_client

    admin_api._qr_instance = None
    admin_api._qr_login_state.update({"status": "idle", "qr_base64": "", "error": ""})
    admin_api._qr_test_b_instance = None
    admin_api._qr_test_b_state.update({"status": "idle", "qr_base64": "", "error": ""})

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
async def test_doubao_test_b_qr_uses_independent_session_file(client, monkeypatch, tmp_path):
    await create_verified_user("admin@nyy.app", is_admin=True)
    headers = await login_headers(client, "admin@nyy.app")
    saved_sessions, _shutdown_calls = install_fake_doubao_qr(monkeypatch, auto_confirm=True)

    import app.api.v1.admin as admin_api

    test_b_file = tmp_path / ".doubao_session_test_b.json"
    monkeypatch.setattr(admin_api, "_test_b_session_file", lambda: str(test_b_file))

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
