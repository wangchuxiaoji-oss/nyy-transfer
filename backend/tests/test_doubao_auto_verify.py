"""豆包自动验证服务测试。"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.services import doubao_auto_verify
from app.services.doubao_client import DoubaoClientError


def make_settings(tmp_path, primary_file):
    return SimpleNamespace(
        doubao_session_file=str(primary_file),
        project_root=tmp_path,
        bark_push_url="",
        doubao_auto_verify_startup_delay_seconds=0,
        doubao_auto_verify_heartbeat_interval_seconds=600,
        doubao_auto_verify_probe_interval_seconds=1800,
        doubao_auto_verify_failure_notify_interval_seconds=21600,
    )


def write_session(path):
    path.write_text(json.dumps({"cookies": {"sessionid": "session"}, "sessionid": "session"}), encoding="utf-8")


@pytest.mark.asyncio
async def test_auto_verify_checks_primary_and_test_b(monkeypatch, tmp_path):
    primary_file = tmp_path / ".doubao_session.json"
    test_b_file = tmp_path / ".doubao_session_test_b.json"
    write_session(primary_file)
    write_session(test_b_file)
    settings = make_settings(tmp_path, primary_file)
    calls: list[tuple[str, str]] = []

    class FakeClient:
        def __init__(self, session_file: str) -> None:
            self.session_file = session_file

        async def start(self) -> None:
            calls.append((self.session_file, "start"))

        async def refresh_login_heartbeat(self, *, force: bool = False) -> None:
            assert force is True
            calls.append((self.session_file, "heartbeat"))

        async def _prepare_upload_auth(self) -> None:
            calls.append((self.session_file, "probe"))

        async def close(self) -> None:
            calls.append((self.session_file, "close"))

    monkeypatch.setattr(doubao_auto_verify, "create_doubao_client_from_session", lambda path: FakeClient(path))

    verifier = doubao_auto_verify.DoubaoAutoVerifier(settings)
    await verifier.run_due_checks(now=0)

    assert (str(primary_file), "heartbeat") in calls
    assert (str(primary_file), "probe") in calls
    assert (str(test_b_file), "heartbeat") in calls
    assert (str(test_b_file), "probe") in calls


@pytest.mark.asyncio
async def test_auto_verify_bark_failure_repeat_and_recovery(monkeypatch, tmp_path):
    primary_file = tmp_path / ".doubao_session.json"
    write_session(primary_file)
    settings = make_settings(tmp_path, primary_file)
    sent: list[tuple[str, str]] = []
    fail_heartbeat = True

    class FakeNotifier:
        async def send(self, title: str, body: str) -> bool:
            sent.append((title, body))
            return True

    class FakeClient:
        async def start(self) -> None:
            return None

        async def refresh_login_heartbeat(self, *, force: bool = False) -> None:
            if fail_heartbeat:
                raise DoubaoClientError("beat broken")

        async def _prepare_upload_auth(self) -> None:
            return None

        async def close(self) -> None:
            return None

    monkeypatch.setattr(doubao_auto_verify, "create_doubao_client_from_session", lambda _: FakeClient())

    verifier = doubao_auto_verify.DoubaoAutoVerifier(settings, notifier=FakeNotifier())
    await verifier.run_due_checks(now=0)
    await verifier.run_due_checks(now=600)
    await verifier.run_due_checks(now=21600)

    assert len(sent) == 2
    assert sent[0][0] == "拿呀² 豆包告警｜生产 A 登录心跳失败"
    assert "生产 A 登录心跳失败" in sent[0][1]
    assert sent[1][0] == "拿呀² 豆包告警｜生产 A 登录心跳失败"

    fail_heartbeat = False
    await verifier.run_due_checks(now=22200)

    assert len(sent) == 3
    assert sent[2][0] == "拿呀² 豆包恢复｜生产 A 登录心跳正常"
    assert "生产 A 登录心跳已恢复正常" in sent[2][1]
