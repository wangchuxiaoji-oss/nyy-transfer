"""Admin 豆包 Session 管理：状态探测、扫码刷新与独立 B 账号诊断。

扫码流程要点：
- Web 层等待一律使用 asyncio.sleep，不阻塞事件循环；
- 扫码状态优先落 Redis（多 worker 共享），进程内字典仅作回退；
- 分布式锁防止多 worker 同时发起扫码；
- Session 文件由 doubao_login.run.save_session 以临时文件 + 原子替换写入。
"""

from __future__ import annotations

import asyncio
import secrets
import threading
import time as _time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import unquote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from app.api.v1.admin.common import _request_ua
from app.core.deps import get_current_admin_user
from app.models.user import User
from app.schemas.admin import MessageResponse
from app.services.admin_audit import request_id_from_request, write_admin_audit
from app.utils.client_ip import get_client_ip

router = APIRouter()

# 进程内回退状态：Redis 不可用时仍能完成单 worker 扫码流程
_qr_login_state: dict = {"status": "idle", "qr_base64": "", "error": ""}
_qr_login_lock = threading.Lock()
_qr_instance = None
_qr_lock_token: str | None = None
_qr_test_b_state: dict = {"status": "idle", "qr_base64": "", "error": ""}
_qr_test_b_lock = threading.Lock()
_qr_test_b_instance = None
_qr_test_b_lock_token: str | None = None

_RELEASE_LOCK_SCRIPT = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
end
return 0
"""


async def _acquire_qr_distributed_lock(
    request: Request,
    name: str,
    actor_id: UUID,
) -> tuple[object | None, str | None]:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return None, None
    owner_token = f"{actor_id}:{secrets.token_urlsafe(24)}"
    acquired = await redis.set(
        f"nyy:admin:doubao:{name}:lock",
        owner_token,
        ex=180,
        nx=True,
    )
    if not acquired:
        raise HTTPException(409, "扫码流程已在其他 worker 中进行")
    return redis, owner_token


async def _release_qr_distributed_lock(redis, name: str, owner_token: str | None) -> bool:
    if redis is None or owner_token is None:
        return False
    try:
        deleted = await redis.eval(
            _RELEASE_LOCK_SCRIPT,
            1,
            f"nyy:admin:doubao:{name}:lock",
            owner_token,
        )
    except Exception:
        return False
    return bool(deleted)


async def _persist_qr_state(
    redis,
    name: str,
    status_value: str,
    *,
    error: str = "",
    release_lock: bool = False,
    owner_token: str | None = None,
) -> None:
    if redis is None:
        return
    state_key = f"nyy:admin:doubao:{name}:state"
    await redis.hset(state_key, mapping={"status": status_value, "error": error})
    await redis.expire(state_key, 300)
    if release_lock:
        await _release_qr_distributed_lock(redis, name, owner_token)


async def _redis_qr_state(request: Request, name: str) -> tuple[str, str] | None:
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        return None
    data = await redis.hgetall(f"nyy:admin:doubao:{name}:state")
    if not data:
        return None
    return data.get("status", "idle"), data.get("error", "")


def _ensure_doubao_login_import_path() -> None:
    """确保可以导入仓库根目录下的 doubao_login 工具。"""
    import sys

    login_dir = Path(__file__).resolve().parents[4] / "doubao_login"
    if not login_dir.exists():
        raise HTTPException(500, "豆包扫码登录模块不存在")
    login_dir_str = str(login_dir)
    if login_dir_str not in sys.path:
        sys.path.insert(0, login_dir_str)


def _test_b_session_file() -> str:
    return str(Path(__file__).resolve().parents[4] / ".doubao_session_test_b.json")


class DoubaoSessionStatus(BaseModel):
    has_session: bool
    sessionid_prefix: str = ""
    last_refresh: str = ""
    age_hours: float = 0
    sid_guard_login_at: str = ""
    sid_guard_expires_at: str = ""
    sid_guard_expires_in_hours: float | None = None
    sid_guard_status: str = "unknown"
    last_probe_at: str = ""
    last_probe_success_at: str = ""
    last_probe_error: str = ""
    last_heartbeat_at: str = ""
    last_heartbeat_success_at: str = ""
    last_heartbeat_error: str = ""
    verified: bool = False
    usable: bool = False
    check_message: str = ""


async def _probe_doubao_session(session_file: str) -> tuple[bool, str]:
    """实际调用豆包授权接口验证 session 是否可用，不上传文件。"""
    from app.services.doubao_client import (
        DoubaoClientError,
        create_doubao_client_from_session,
        record_doubao_session_status,
    )

    client = create_doubao_client_from_session(session_file)
    probe_started_at = _time.time()
    await client.start()
    try:
        await client._prepare_upload_auth()
        record_doubao_session_status(
            session_file,
            last_probe_at=probe_started_at,
            last_probe_success_at=_time.time(),
            last_probe_error="",
        )
        try:
            heartbeat_started_at = _time.time()
            await client.refresh_login_heartbeat(force=True)
            record_doubao_session_status(
                session_file,
                last_heartbeat_at=heartbeat_started_at,
                last_heartbeat_success_at=_time.time(),
                last_heartbeat_error="",
            )
            return True, "豆包授权验证通过；登录心跳通过"
        except Exception as exc:
            record_doubao_session_status(
                session_file,
                last_heartbeat_at=heartbeat_started_at,
                last_heartbeat_error=str(exc)[:300],
            )
            return True, f"豆包授权验证通过；登录心跳失败：{exc}"
    except DoubaoClientError as exc:
        record_doubao_session_status(
            session_file,
            last_probe_at=probe_started_at,
            last_probe_error=str(exc)[:300],
        )
        return False, str(exc)
    except Exception as exc:
        record_doubao_session_status(
            session_file,
            last_probe_at=probe_started_at,
            last_probe_error=str(exc)[:300],
        )
        return False, f"验证失败：{exc}"
    finally:
        await client.close()


def _format_utc(dt: datetime | None) -> str:
    if not dt:
        return ""
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M UTC")


def _format_unix_ts(value: object) -> str:
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        return ""
    if timestamp <= 0:
        return ""
    return _format_utc(datetime.fromtimestamp(timestamp, tz=UTC))


def _parse_sid_guard_times(sid_guard: str) -> tuple[datetime | None, datetime | None]:
    """解析 sid_guard 的客户端标称登录/到期时间。"""
    if not sid_guard:
        return None, None
    try:
        parts = unquote(sid_guard).split("|")
        login_at = datetime.fromtimestamp(int(parts[1]), tz=UTC) if len(parts) > 1 and parts[1] else None
        expires_raw = parts[3].replace("+", " ") if len(parts) > 3 else ""
        expires_at = parsedate_to_datetime(expires_raw) if expires_raw else None
        if expires_at and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=UTC)
        return login_at, expires_at
    except Exception:
        return None, None


async def _build_doubao_session_status(session_file: str | None, probe: bool = False) -> DoubaoSessionStatus:
    if not session_file or not Path(session_file).exists():
        return DoubaoSessionStatus(has_session=False)

    try:
        from app.services.doubao_client import load_doubao_session_data

        data = load_doubao_session_data(session_file)
        cookies = data.get("cookies", {})
        status_data = data.get("nyy_status", {})
        if not isinstance(status_data, dict):
            status_data = {}
        sid = data.get("sessionid", cookies.get("sessionid", ""))
        sid_guard_login_at, sid_guard_expires_at = _parse_sid_guard_times(cookies.get("sid_guard", ""))
        ts = data.get("timestamp", 0)
        age_hours = (_time.time() - ts) / 3600 if ts else 0
        last_refresh = _format_utc(datetime.fromtimestamp(ts, tz=UTC)) if ts else ""
        expires_in_hours = None
        sid_guard_status = "unknown"
        if sid_guard_expires_at:
            expires_in_hours = round((sid_guard_expires_at - datetime.now(UTC)).total_seconds() / 3600, 1)
            if expires_in_hours <= 0:
                sid_guard_status = "expired"
            elif expires_in_hours <= 72:
                sid_guard_status = "warning"
            else:
                sid_guard_status = "ok"
        verified = False
        usable = False
        check_message = ""
        if sid and probe:
            verified = True
            usable, check_message = await _probe_doubao_session(session_file)
            try:
                refreshed_data = load_doubao_session_data(session_file)
                refreshed_status = refreshed_data.get("nyy_status", {})
                if isinstance(refreshed_status, dict):
                    status_data = refreshed_status
            except Exception:
                pass
        return DoubaoSessionStatus(
            has_session=bool(sid),
            sessionid_prefix=sid[:16] + "..." if sid else "",
            last_refresh=last_refresh,
            age_hours=round(age_hours, 1),
            sid_guard_login_at=_format_utc(sid_guard_login_at),
            sid_guard_expires_at=_format_utc(sid_guard_expires_at),
            sid_guard_expires_in_hours=expires_in_hours,
            sid_guard_status=sid_guard_status,
            last_probe_at=_format_unix_ts(status_data.get("last_probe_at")),
            last_probe_success_at=_format_unix_ts(status_data.get("last_probe_success_at")),
            last_probe_error=str(status_data.get("last_probe_error") or ""),
            last_heartbeat_at=_format_unix_ts(status_data.get("last_heartbeat_at")),
            last_heartbeat_success_at=_format_unix_ts(status_data.get("last_heartbeat_success_at")),
            last_heartbeat_error=str(status_data.get("last_heartbeat_error") or ""),
            verified=verified,
            usable=usable,
            check_message=check_message,
        )
    except Exception:
        return DoubaoSessionStatus(has_session=False)


def _doubao_qr_message(status: str, error: str = "") -> str:
    messages = {
        "idle": "空闲",
        "fetching_qr": "正在获取二维码...",
        "waiting_scan": "等待扫码",
        "scanned": "已扫码，请在手机上确认",
        "confirmed": "登录成功，Session 已更新",
        "expired": "二维码已过期",
        "error": f"错误：{error}",
    }
    return messages.get(status, status)


class DoubaoQRStartResponse(BaseModel):
    qr_base64: str
    message: str = ""


class DoubaoQRStatusResponse(BaseModel):
    status: str  # idle, fetching_qr, waiting_scan, scanned, confirmed, expired, error
    message: str = ""


@router.get("/doubao/session-status", response_model=DoubaoSessionStatus)
async def doubao_session_status(
    _admin=Depends(get_current_admin_user),
    probe: bool = Query(False),
):
    """获取当前豆包 session 状态。"""
    from app.core.config import get_settings
    settings = get_settings()
    return await _build_doubao_session_status(settings.doubao_session_file, probe)


@router.post("/doubao/qr-start", response_model=DoubaoQRStartResponse)
async def doubao_qr_start(
    request: Request,
    admin: User = Depends(get_current_admin_user),
):
    """启动豆包 QR 扫码登录流程。"""
    global _qr_instance, _qr_lock_token
    from app.core.config import get_settings

    settings = get_settings()
    if not settings.doubao_session_file:
        raise HTTPException(500, "DOUBAO_SESSION_FILE 未配置")

    event_loop = asyncio.get_running_loop()
    _ensure_doubao_login_import_path()
    from qr_login import QRLogin, QRResult, QRStatus
    from run import save_session

    with _qr_login_lock:
        if _qr_instance and _qr_instance.is_running:
            # Already running, return current QR if available
            if _qr_instance.qrcode_data:
                import base64
                qr_b64 = base64.b64encode(_qr_instance.qrcode_data).decode()
                return DoubaoQRStartResponse(qr_base64=qr_b64, message="已有进行中的扫码流程")
            raise HTTPException(409, "扫码流程已在进行中，请稍候")

    redis, owner_token = await _acquire_qr_distributed_lock(request, "production", admin.id)
    with _qr_login_lock:
        _qr_lock_token = owner_token
        _qr_login_state["status"] = "fetching_qr"
        _qr_login_state["qr_base64"] = ""
        _qr_login_state["error"] = ""
    await _persist_qr_state(redis, "production", "fetching_qr")

    audit_request_id = request_id_from_request(request)
    audit_ip = get_client_ip(request)
    audit_ua = _request_ua(request)

    def on_status(status: QRStatus, msg: str):
        with _qr_login_lock:
            if _qr_lock_token != owner_token:
                return
            _qr_login_state["status"] = status.value
            if msg == "qr_ready":
                return
        asyncio.run_coroutine_threadsafe(
            _persist_qr_state(redis, "production", status.value),
            event_loop,
        )

    def on_done(result: QRResult):
        global _qr_instance, _qr_lock_token
        with _qr_login_lock:
            is_current_owner = _qr_lock_token == owner_token
            if is_current_owner:
                _qr_login_state["status"] = result.status.value
                if result.status == QRStatus.CONFIRMED:
                    try:
                        save_session(result, settings.doubao_session_file)
                        # 让后续上传重新读取新写入的 session 文件。
                        from app.services.doubao_client import shutdown_doubao_client
                        asyncio.run_coroutine_threadsafe(shutdown_doubao_client(), event_loop)
                    except Exception as exc:
                        _qr_login_state["status"] = "error"
                        _qr_login_state["error"] = f"保存 Session 失败：{exc}"
                else:
                    _qr_login_state["error"] = result.error or ""
                _qr_instance = None
                _qr_lock_token = None
                final_status = _qr_login_state["status"]
                final_error = _qr_login_state.get("error", "")
            else:
                final_status = result.status.value
                final_error = result.error or ""

        async def finalize() -> None:
            if is_current_owner:
                await _persist_qr_state(
                    redis,
                    "production",
                    final_status,
                    error=final_error,
                    release_lock=True,
                    owner_token=owner_token,
                )
            else:
                await _release_qr_distributed_lock(redis, "production", owner_token)
            await write_admin_audit(
                actor_id=admin.id,
                actor_email=admin.email,
                request_id=audit_request_id,
                ip=audit_ip,
                user_agent=audit_ua,
                action="doubao.session_update",
                target_type="doubao_session",
                target_id="production",
                after={"status": final_status},
                success=final_status == "confirmed",
                error_summary=final_error or None,
            )

        asyncio.run_coroutine_threadsafe(finalize(), event_loop)

    qr = QRLogin()
    _qr_instance = qr
    qr.start(on_status=on_status, on_done=on_done)

    # Wait briefly for QR code to generate
    for _ in range(40):
        await asyncio.sleep(0.1)
        if qr.qrcode_data:
            break

    if not qr.qrcode_data:
        with _qr_login_lock:
            qr.cancel()
            _qr_login_state["status"] = "error"
            _qr_login_state["error"] = "QR code generation failed"
            _qr_instance = None
            if _qr_lock_token == owner_token:
                _qr_lock_token = None
        await _persist_qr_state(
            redis,
            "production",
            "error",
            error="QR code generation failed",
            release_lock=True,
            owner_token=owner_token,
        )
        raise HTTPException(500, "QR 码生成失败")

    import base64
    qr_b64 = base64.b64encode(qr.qrcode_data).decode()
    with _qr_login_lock:
        _qr_login_state["qr_base64"] = qr_b64
        if _qr_login_state["status"] == "fetching_qr":
            _qr_login_state["status"] = "waiting_scan"
    await _persist_qr_state(redis, "production", _qr_login_state["status"])

    return DoubaoQRStartResponse(qr_base64=qr_b64)


@router.get("/doubao/qr-status", response_model=DoubaoQRStatusResponse)
async def doubao_qr_status(
    request: Request,
    _admin=Depends(get_current_admin_user),
):
    """轮询 QR 扫码状态。"""
    with _qr_login_lock:
        status = _qr_login_state["status"]
        error = _qr_login_state.get("error", "")
    redis_state = await _redis_qr_state(request, "production")
    if redis_state:
        status, error = redis_state
    return DoubaoQRStatusResponse(status=status, message=_doubao_qr_message(status, error))


@router.post("/doubao/qr-cancel")
async def doubao_qr_cancel(
    request: Request,
    _admin=Depends(get_current_admin_user),
):
    """取消进行中的 QR 扫码流程。"""
    global _qr_instance, _qr_lock_token
    with _qr_login_lock:
        owner_token = _qr_lock_token
        if _qr_instance and _qr_instance.is_running:
            _qr_instance.cancel()
        _qr_login_state["status"] = "idle"
        _qr_instance = None
        _qr_lock_token = None
    if owner_token is not None:
        await _persist_qr_state(
            getattr(request.app.state, "redis", None),
            "production",
            "idle",
            release_lock=True,
            owner_token=owner_token,
        )
    return MessageResponse(message="已取消")


@router.get("/doubao/test-b/session-status", response_model=DoubaoSessionStatus)
async def doubao_test_b_session_status(
    _admin=Depends(get_current_admin_user),
    probe: bool = Query(False),
):
    """获取独立 B 账号测试 Session 状态。"""
    return await _build_doubao_session_status(_test_b_session_file(), probe)


@router.post("/doubao/test-b/qr-start", response_model=DoubaoQRStartResponse)
async def doubao_test_b_qr_start(
    request: Request,
    admin: User = Depends(get_current_admin_user),
):
    """启动独立 B 账号 QR 扫码流程，不覆盖当前生产 Session。"""
    global _qr_test_b_instance, _qr_test_b_lock_token
    _ensure_doubao_login_import_path()
    from qr_login import QRLogin, QRResult, QRStatus
    from run import save_session

    output_file = _test_b_session_file()
    event_loop = asyncio.get_running_loop()
    with _qr_test_b_lock:
        if _qr_test_b_instance and _qr_test_b_instance.is_running:
            if _qr_test_b_instance.qrcode_data:
                import base64
                qr_b64 = base64.b64encode(_qr_test_b_instance.qrcode_data).decode()
                return DoubaoQRStartResponse(qr_base64=qr_b64, message="已有进行中的 B 账号扫码流程")
            raise HTTPException(409, "B 账号扫码流程已在进行中，请稍候")

    redis, owner_token = await _acquire_qr_distributed_lock(request, "test-b", admin.id)
    with _qr_test_b_lock:
        _qr_test_b_lock_token = owner_token
        _qr_test_b_state["status"] = "fetching_qr"
        _qr_test_b_state["qr_base64"] = ""
        _qr_test_b_state["error"] = ""
    await _persist_qr_state(redis, "test-b", "fetching_qr")

    audit_request_id = request_id_from_request(request)
    audit_ip = get_client_ip(request)
    audit_ua = _request_ua(request)

    def on_status(status: QRStatus, msg: str):
        with _qr_test_b_lock:
            if _qr_test_b_lock_token != owner_token:
                return
            _qr_test_b_state["status"] = status.value
            if msg == "qr_ready":
                return
        asyncio.run_coroutine_threadsafe(
            _persist_qr_state(redis, "test-b", status.value),
            event_loop,
        )

    def on_done(result: QRResult):
        global _qr_test_b_instance, _qr_test_b_lock_token
        with _qr_test_b_lock:
            is_current_owner = _qr_test_b_lock_token == owner_token
            if is_current_owner:
                _qr_test_b_state["status"] = result.status.value
                if result.status == QRStatus.CONFIRMED:
                    try:
                        save_session(result, output_file)
                    except Exception as exc:
                        _qr_test_b_state["status"] = "error"
                        _qr_test_b_state["error"] = f"保存 B 账号测试 Session 失败：{exc}"
                else:
                    _qr_test_b_state["error"] = result.error or ""
                _qr_test_b_instance = None
                _qr_test_b_lock_token = None
                final_status = _qr_test_b_state["status"]
                final_error = _qr_test_b_state.get("error", "")
            else:
                final_status = result.status.value
                final_error = result.error or ""

        async def finalize() -> None:
            if is_current_owner:
                await _persist_qr_state(
                    redis,
                    "test-b",
                    final_status,
                    error=final_error,
                    release_lock=True,
                    owner_token=owner_token,
                )
            else:
                await _release_qr_distributed_lock(redis, "test-b", owner_token)
            await write_admin_audit(
                actor_id=admin.id,
                actor_email=admin.email,
                request_id=audit_request_id,
                ip=audit_ip,
                user_agent=audit_ua,
                action="doubao.session_update",
                target_type="doubao_session",
                target_id="test-b",
                after={"status": final_status},
                success=final_status == "confirmed",
                error_summary=final_error or None,
            )

        asyncio.run_coroutine_threadsafe(finalize(), event_loop)

    qr = QRLogin()
    _qr_test_b_instance = qr
    qr.start(on_status=on_status, on_done=on_done)

    for _ in range(40):
        await asyncio.sleep(0.1)
        if qr.qrcode_data:
            break

    if not qr.qrcode_data:
        with _qr_test_b_lock:
            qr.cancel()
            _qr_test_b_state["status"] = "error"
            _qr_test_b_state["error"] = "QR code generation failed"
            _qr_test_b_instance = None
            if _qr_test_b_lock_token == owner_token:
                _qr_test_b_lock_token = None
        await _persist_qr_state(
            redis,
            "test-b",
            "error",
            error="QR code generation failed",
            release_lock=True,
            owner_token=owner_token,
        )
        raise HTTPException(500, "B 账号 QR 码生成失败")

    import base64
    qr_b64 = base64.b64encode(qr.qrcode_data).decode()
    with _qr_test_b_lock:
        _qr_test_b_state["qr_base64"] = qr_b64
        if _qr_test_b_state["status"] == "fetching_qr":
            _qr_test_b_state["status"] = "waiting_scan"
    await _persist_qr_state(redis, "test-b", _qr_test_b_state["status"])
    return DoubaoQRStartResponse(qr_base64=qr_b64)


@router.get("/doubao/test-b/qr-status", response_model=DoubaoQRStatusResponse)
async def doubao_test_b_qr_status(
    request: Request,
    _admin=Depends(get_current_admin_user),
):
    """轮询独立 B 账号 QR 扫码状态。"""
    with _qr_test_b_lock:
        status = _qr_test_b_state["status"]
        error = _qr_test_b_state.get("error", "")
    redis_state = await _redis_qr_state(request, "test-b")
    if redis_state:
        status, error = redis_state
    return DoubaoQRStatusResponse(status=status, message=_doubao_qr_message(status, error))


@router.post("/doubao/test-b/qr-cancel")
async def doubao_test_b_qr_cancel(
    request: Request,
    _admin=Depends(get_current_admin_user),
):
    """取消独立 B 账号 QR 扫码流程。"""
    global _qr_test_b_instance, _qr_test_b_lock_token
    with _qr_test_b_lock:
        owner_token = _qr_test_b_lock_token
        if _qr_test_b_instance and _qr_test_b_instance.is_running:
            _qr_test_b_instance.cancel()
        _qr_test_b_state["status"] = "idle"
        _qr_test_b_instance = None
        _qr_test_b_lock_token = None
    if owner_token is not None:
        await _persist_qr_state(
            getattr(request.app.state, "redis", None),
            "test-b",
            "idle",
            release_lock=True,
            owner_token=owner_token,
        )
    return MessageResponse(message="已取消")
