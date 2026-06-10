"""豆包 Session 自动验证与 Bark 告警。"""

from __future__ import annotations

import asyncio
import logging
import time
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote

import httpx

from app.core.config import Settings, get_settings
from app.services.doubao_client import create_doubao_client_from_session

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class DoubaoVerifyTarget:
    """一个需要自动验证的豆包 Session 文件。"""

    label: str
    session_file: str

    @property
    def key(self) -> str:
        try:
            return str(Path(self.session_file).expanduser().resolve())
        except Exception:
            return self.session_file


@dataclass
class _TargetState:
    next_heartbeat_at: float = 0.0
    next_probe_at: float = 0.0
    failed_checks: set[str] = field(default_factory=set)
    failure_notified_at: dict[str, float] = field(default_factory=dict)


class BarkNotifier:
    """Bark 推送客户端，使用完整 BARK_PUSH_URL 拼接标题和正文。"""

    def __init__(self, push_url: str) -> None:
        self.push_url = push_url.rstrip("/")

    async def send(self, title: str, body: str) -> bool:
        if not self.push_url:
            log.warning("BARK_PUSH_URL 未配置，跳过 Bark 推送: %s %s", title, body)
            return False
        safe_title = quote(title[:120], safe="")
        safe_body = quote(body[:1500], safe="")
        url = f"{self.push_url}/{safe_title}/{safe_body}"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, params={"group": "nyy"})
            if response.status_code >= 400:
                log.warning("Bark 推送失败: status=%s body=%s", response.status_code, response.text[:200])
                return False
            return True
        except Exception as exc:  # noqa: BLE001
            log.warning("Bark 推送异常: %s", exc)
            return False


def _test_b_session_file(settings: Settings) -> str:
    return str(settings.project_root / ".doubao_session_test_b.json")


class DoubaoAutoVerifier:
    """按固定间隔自动验证生产 A 和测试 B 豆包 Session。"""

    def __init__(self, settings: Settings, notifier: BarkNotifier | None = None) -> None:
        self.settings = settings
        self.notifier = notifier or BarkNotifier(settings.bark_push_url)
        self._states: dict[str, _TargetState] = {}
        self._stop_event = asyncio.Event()
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="doubao-auto-verify")
        log.info(
            "doubao auto verifier started: heartbeat=%ss probe=%ss",
            self.settings.doubao_auto_verify_heartbeat_interval_seconds,
            self.settings.doubao_auto_verify_probe_interval_seconds,
        )

    async def stop(self) -> None:
        self._stop_event.set()
        if not self._task:
            return
        self._task.cancel()
        with suppress(asyncio.CancelledError):
            await self._task
        self._task = None

    async def _run(self) -> None:
        try:
            await self._wait_or_stop(max(0, self.settings.doubao_auto_verify_startup_delay_seconds))
            while not self._stop_event.is_set():
                try:
                    await self.run_due_checks()
                except Exception as exc:  # noqa: BLE001
                    log.exception("doubao auto verify loop failed: %s", exc)
                await self._wait_or_stop(30)
        except asyncio.CancelledError:
            raise

    async def _wait_or_stop(self, seconds: int | float) -> None:
        if seconds <= 0:
            return
        with suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._stop_event.wait(), timeout=seconds)

    def _targets(self) -> list[DoubaoVerifyTarget]:
        targets: list[DoubaoVerifyTarget] = []
        seen: set[str] = set()

        def add(label: str, session_file: str | None) -> None:
            if not session_file:
                return
            path = Path(session_file).expanduser()
            if not path.exists():
                return
            try:
                key = str(path.resolve())
            except Exception:
                key = str(path)
            if key in seen:
                return
            seen.add(key)
            targets.append(DoubaoVerifyTarget(label=label, session_file=str(path)))

        add("生产 A", self.settings.doubao_session_file)
        add("测试 B", _test_b_session_file(self.settings))
        return targets

    async def run_due_checks(self, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        heartbeat_interval = max(1, self.settings.doubao_auto_verify_heartbeat_interval_seconds)
        probe_interval = max(1, self.settings.doubao_auto_verify_probe_interval_seconds)

        for target in self._targets():
            state = self._states.setdefault(target.key, _TargetState())
            heartbeat_due = now >= state.next_heartbeat_at
            probe_due = now >= state.next_probe_at
            if not heartbeat_due and not probe_due:
                continue
            if heartbeat_due or probe_due:
                state.next_heartbeat_at = now + heartbeat_interval
            if probe_due:
                state.next_probe_at = now + probe_interval
            await self._run_target_checks(
                target,
                state,
                heartbeat_due=heartbeat_due or probe_due,
                probe_due=probe_due,
                now=now,
            )

    async def _run_target_checks(
        self,
        target: DoubaoVerifyTarget,
        state: _TargetState,
        *,
        heartbeat_due: bool,
        probe_due: bool,
        now: float,
    ) -> None:
        client = None
        try:
            client = create_doubao_client_from_session(target.session_file)
            await client.start()
        except Exception as exc:  # noqa: BLE001
            if heartbeat_due:
                await self._mark_failure(target, state, "登录心跳", exc, now)
            if probe_due:
                await self._mark_failure(target, state, "上传探活", exc, now)
            if client is not None:
                with suppress(Exception):
                    await client.close()
            return

        try:
            if heartbeat_due:
                try:
                    await client.refresh_login_heartbeat(force=True)
                    await self._mark_success(target, state, "登录心跳")
                except Exception as exc:  # noqa: BLE001
                    await self._mark_failure(target, state, "登录心跳", exc, now)

            if probe_due:
                try:
                    await client._prepare_upload_auth()
                    await self._mark_success(target, state, "上传探活")
                except Exception as exc:  # noqa: BLE001
                    await self._mark_failure(target, state, "上传探活", exc, now)
        finally:
            await client.close()

    async def _mark_failure(
        self,
        target: DoubaoVerifyTarget,
        state: _TargetState,
        check_name: str,
        exc: Exception,
        now: float,
    ) -> None:
        error = str(exc)[:300]
        log.warning("doubao auto verify failed: target=%s check=%s error=%s", target.label, check_name, error)
        notify_interval = max(1, self.settings.doubao_auto_verify_failure_notify_interval_seconds)
        last_notified_at = state.failure_notified_at.get(check_name, 0.0)
        should_notify = check_name not in state.failed_checks or now - last_notified_at >= notify_interval
        state.failed_checks.add(check_name)
        if not should_notify:
            return
        state.failure_notified_at[check_name] = now
        await self.notifier.send(
            f"拿呀² 豆包告警｜{target.label} {check_name}失败",
            f"{target.label} {check_name}失败：{error}",
        )

    async def _mark_success(self, target: DoubaoVerifyTarget, state: _TargetState, check_name: str) -> None:
        if check_name not in state.failed_checks:
            return
        state.failed_checks.remove(check_name)
        await self.notifier.send(
            f"拿呀² 豆包恢复｜{target.label} {check_name}正常",
            f"{target.label} {check_name}已恢复正常。",
        )


_auto_verifier: DoubaoAutoVerifier | None = None


def start_doubao_auto_verifier() -> DoubaoAutoVerifier | None:
    """在 FastAPI 生命周期里启动豆包自动验证任务。"""
    settings = get_settings()
    if not settings.doubao_auto_verify_enabled:
        log.info("doubao auto verifier disabled")
        return None
    global _auto_verifier
    if _auto_verifier is None:
        _auto_verifier = DoubaoAutoVerifier(settings)
        _auto_verifier.start()
    return _auto_verifier


async def shutdown_doubao_auto_verifier() -> None:
    """关闭豆包自动验证任务。"""
    global _auto_verifier
    if _auto_verifier is not None:
        await _auto_verifier.stop()
        _auto_verifier = None
