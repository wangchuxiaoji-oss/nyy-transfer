"""Admin API：仪表盘、用户、分享封禁、配额配置。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import unquote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.share import Share
from app.models.system import EmailDelivery, Report
from app.models.user import User
from app.schemas.admin import (
    AdminShareItem,
    AdminSharesResponse,
    AdminStatsResponse,
    AdminUserItem,
    AdminUserUpdate,
    AdminUsersResponse,
    BanShareRequest,
    MessageResponse,
    AdminEmailItem,
    AdminEmailsResponse,
    AdminReportItem,
    AdminReportsResponse,
    QuotaConfigResponse,
    QuotaConfigUpdate,
    DownloadConfigResponse,
    DownloadConfigUpdate,
    ReportStatusUpdate,
)
from app.services.app_config import get_download_config, get_quota_config, set_download_config, set_quota_config
from app.services.auth_audit import log_auth_event
from app.services.auth_session import revoke_user_sessions
from app.services.email_code import _code_key, generate_email_code, send_email_code, store_email_code

router = APIRouter(prefix="/admin", tags=["admin"])


def _share_status_filters(status_filter: str, now: datetime):
    if status_filter == "revoked":
        return [Share.revoked_at.is_not(None)]
    if status_filter == "banned":
        return [Share.banned_at.is_not(None)]
    if status_filter == "expired":
        return [Share.revoked_at.is_(None), Share.banned_at.is_(None), Share.expires_at.is_not(None), Share.expires_at <= now]
    if status_filter == "download_exhausted":
        return [
            Share.revoked_at.is_(None),
            Share.banned_at.is_(None),
            or_(Share.expires_at.is_(None), Share.expires_at > now),
            Share.max_downloads > 0,
            Share.download_count >= Share.max_downloads,
        ]
    if status_filter == "active":
        return [
            Share.revoked_at.is_(None),
            Share.banned_at.is_(None),
            or_(Share.expires_at.is_(None), Share.expires_at > now),
            or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
        ]
    return []


def _user_plan_filters(plan: str) -> list:
    if plan == "admin":
        return [User.is_admin.is_(True)]
    if plan == "free":
        return [User.plan == "free"]
    if plan == "pro":
        return [User.plan == "pro"]
    return []


def _user_status_filters(status_filter: str) -> list:
    if status_filter == "active":
        return [User.disabled_at.is_(None), User.deleted_at.is_(None)]
    if status_filter == "disabled":
        return [User.disabled_at.is_not(None), User.deleted_at.is_(None)]
    if status_filter == "deleted":
        return [User.deleted_at.is_not(None)]
    if status_filter == "verified":
        return [User.email_verified_at.is_not(None), User.deleted_at.is_(None)]
    if status_filter == "unverified":
        return [User.email_verified_at.is_(None), User.deleted_at.is_(None)]
    return []


def _admin_user_item(user: User) -> AdminUserItem:
    return AdminUserItem(
        id=str(user.id),
        email=user.email,
        plan=user.plan,
        is_admin=user.is_admin,
        email_verified=user.email_verified_at is not None,
        disabled=user.disabled_at is not None,
        deleted=user.deleted_at is not None,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
        disabled_at=user.disabled_at,
        deleted_at=user.deleted_at,
    )


def _request_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _request_ua(request: Request) -> str:
    return request.headers.get("user-agent", "")


@router.get("/stats", response_model=AdminStatsResponse)
async def get_stats(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    users_total = await db.scalar(select(func.count()).select_from(User)) or 0
    shares_total = await db.scalar(select(func.count()).select_from(Share)) or 0
    now = datetime.now(timezone.utc)
    shares_active = await db.scalar(
        select(func.count()).select_from(Share).where(
            Share.revoked_at.is_(None),
            Share.banned_at.is_(None),
            or_(Share.expires_at.is_(None), Share.expires_at > now),
            or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
        )
    ) or 0
    shares_banned = await db.scalar(
        select(func.count()).select_from(Share).where(Share.banned_at.is_not(None))
    ) or 0
    uploaded_bytes_total = await db.scalar(select(func.coalesce(func.sum(Share.total_bytes), 0))) or 0
    uploaded_bytes_24h = await db.scalar(
        select(func.coalesce(func.sum(Share.total_bytes), 0)).where(Share.created_at >= since)
    ) or 0
    reports_pending = await db.scalar(select(func.count()).select_from(Report).where(Report.status == "pending")) or 0
    emails_failed = await db.scalar(select(func.count()).select_from(EmailDelivery).where(EmailDelivery.status == "failed")) or 0
    return AdminStatsResponse(
        users_total=users_total,
        shares_total=shares_total,
        shares_active=shares_active,
        shares_banned=shares_banned,
        uploaded_bytes_total=uploaded_bytes_total,
        uploaded_bytes_24h=uploaded_bytes_24h,
        reports_pending=reports_pending,
        emails_failed=emails_failed,
    )


@router.get("/reports", response_model=AdminReportsResponse)
async def list_reports(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|pending|resolved|dismissed)$"),
):
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(or_(Share.code.ilike(like), Report.reason.ilike(like), Report.detail.ilike(like)))
    if status_filter != "all":
        filters.append(Report.status == status_filter)

    total = await db.scalar(
        select(func.count()).select_from(Report).join(Share, Share.id == Report.share_id).where(*filters)
    ) or 0
    result = await db.execute(
        select(Report, Share.code)
        .join(Share, Share.id == Report.share_id)
        .where(*filters)
        .order_by(Report.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return AdminReportsResponse(reports=[
        AdminReportItem(
            id=str(r.id),
            share_code=code,
            reason=r.reason,
            detail=r.detail,
            status=r.status,
            created_at=r.created_at,
        )
        for r, code in result.all()
    ], total=total, page=page, page_size=page_size)


@router.patch("/reports/{report_id}/status", response_model=AdminReportItem)
async def update_report_status(
    report_id: UUID,
    body: ReportStatusUpdate,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Report, Share.code)
        .join(Share, Share.id == Report.share_id)
        .where(Report.id == report_id)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(404, "举报不存在")
    report, share_code = row
    report.status = body.status
    await db.commit()
    return AdminReportItem(
        id=str(report.id),
        share_code=share_code,
        reason=report.reason,
        detail=report.detail,
        status=report.status,
        created_at=report.created_at,
    )


@router.get("/emails", response_model=AdminEmailsResponse)
async def list_emails(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|pending|sent|failed)$"),
):
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(or_(Share.code.ilike(like), EmailDelivery.recipient.ilike(like), EmailDelivery.error.ilike(like)))
    if status_filter != "all":
        filters.append(EmailDelivery.status == status_filter)

    total = await db.scalar(
        select(func.count()).select_from(EmailDelivery).join(Share, Share.id == EmailDelivery.share_id).where(*filters)
    ) or 0
    result = await db.execute(
        select(EmailDelivery, Share.code)
        .join(Share, Share.id == EmailDelivery.share_id)
        .where(*filters)
        .order_by(EmailDelivery.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return AdminEmailsResponse(emails=[
        AdminEmailItem(
            recipient=e.recipient,
            share_code=code,
            status=e.status,
            error=e.error,
            created_at=e.created_at,
            sent_at=e.sent_at,
        )
        for e, code in result.all()
    ], total=total, page=page, page_size=page_size)


@router.get("/users", response_model=AdminUsersResponse)
async def list_users(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    plan: str = Query("all", pattern="^(all|free|pro|admin)$"),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|disabled|deleted|verified|unverified)$"),
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|email_asc|email_desc|last_login_desc|last_login_asc)$"),
):
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(or_(User.email.ilike(like), User.plan.ilike(like)))
    filters.extend(_user_plan_filters(plan))
    filters.extend(_user_status_filters(status_filter))

    order_by = {
        "created_desc": User.created_at.desc(),
        "created_asc": User.created_at.asc(),
        "email_asc": User.email.asc(),
        "email_desc": User.email.desc(),
        "last_login_desc": User.last_login_at.desc().nullslast(),
        "last_login_asc": User.last_login_at.asc().nullsfirst(),
    }[sort]

    total = await db.scalar(select(func.count()).select_from(User).where(*filters)) or 0
    result = await db.execute(
        select(User).where(*filters).order_by(order_by).offset((page - 1) * page_size).limit(page_size)
    )
    users = result.scalars().all()
    return AdminUsersResponse(
        users=[_admin_user_item(u) for u in users],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.patch("/users/{user_id}", response_model=AdminUserItem)
async def update_user(
    user_id: UUID,
    body: AdminUserUpdate,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    user = await db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(404, "用户不存在")
    if user.is_admin:
        raise HTTPException(400, "管理员账号不可在此修改")

    now = datetime.now(timezone.utc)
    revoke_sessions = False

    if body.plan is not None:
        user.plan = body.plan
    if body.disabled is not None:
        user.disabled_at = now if body.disabled else None
        if body.disabled:
            revoke_sessions = True
    if body.deleted is not None:
        user.deleted_at = now if body.deleted else None
        if body.deleted:
            revoke_sessions = True
    if body.email_verified is not None:
        user.email_verified_at = now if body.email_verified else None
        if not body.email_verified:
            revoke_sessions = True

    if revoke_sessions:
        await revoke_user_sessions(db, user.id)
    await db.commit()
    return _admin_user_item(user)


@router.post("/users/{user_id}/password-reset", response_model=MessageResponse)
async def send_user_password_reset(
    user_id: UUID,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(503, "缓存服务暂时不可用")

    user = await db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(404, "用户不存在")
    if user.is_admin:
        raise HTTPException(400, "管理员账号不可在此重置")
    if user.deleted_at is not None:
        raise HTTPException(400, "已删除用户不可发送重置邮件")

    code = generate_email_code()
    ip = _request_ip(request)
    ua = _request_ua(request)
    await store_email_code(redis, user.email, code, "reset_password", ip, ua)
    sent = await send_email_code(user.email, code, "reset_password")
    if not sent:
        await redis.delete(_code_key("reset_password", user.email))
        await log_auth_event(
            db, event_type="password_reset_failed", success=False,
            user_id=user.id, email=user.email, ip=ip, user_agent=ua,
            reason="admin_reset_email_failed",
        )
        raise HTTPException(500, "重置邮件发送失败")

    await log_auth_event(
        db, event_type="password_reset_requested", success=True,
        user_id=user.id, email=user.email, ip=ip, user_agent=ua,
        reason=f"admin_triggered:{admin.id}",
    )
    await db.commit()
    return MessageResponse(message="重置邮件已发送")


@router.get("/shares", response_model=AdminSharesResponse)
async def list_shares(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|revoked|expired|banned|download_exhausted)$"),
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|size_desc|downloads_desc|expires_asc)$"),
):
    now = datetime.now(timezone.utc)
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(or_(Share.code.ilike(like), Share.title.ilike(like), Share.banned_reason.ilike(like), User.email.ilike(like)))
    filters.extend(_share_status_filters(status_filter, now))

    order_by = {
        "created_desc": Share.created_at.desc(),
        "created_asc": Share.created_at.asc(),
        "size_desc": Share.total_bytes.desc(),
        "downloads_desc": Share.download_count.desc(),
        "expires_asc": Share.expires_at.asc().nullslast(),
    }[sort]

    total = await db.scalar(
        select(func.count()).select_from(Share).outerjoin(User, User.id == Share.owner_id).where(*filters)
    ) or 0
    result = await db.execute(
        select(Share)
        .options(selectinload(Share.files), selectinload(Share.logical_files))
        .outerjoin(User, User.id == Share.owner_id)
        .where(*filters)
        .order_by(order_by)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    shares = result.scalars().all()
    owner_ids = [s.owner_id for s in shares if s.owner_id]
    owner_email_by_id = {}
    if owner_ids:
        owners = await db.execute(select(User).where(User.id.in_(owner_ids)))
        owner_email_by_id = {u.id: u.email for u in owners.scalars().all()}
    return AdminSharesResponse(
        shares=[
            AdminShareItem(
                code=s.code,
                title=s.title,
                owner_email=owner_email_by_id.get(s.owner_id),
                file_count=len(s.logical_files or s.files),
                total_bytes=s.total_bytes,
                download_count=s.download_count,
                max_downloads=s.max_downloads,
                created_at=s.created_at,
                expires_at=s.expires_at,
                revoked=s.revoked_at is not None,
                banned=s.banned_at is not None,
                banned_reason=s.banned_reason,
            )
            for s in shares
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/config/quota", response_model=QuotaConfigResponse)
async def get_quota(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    return QuotaConfigResponse(**await get_quota_config(db))


@router.put("/config/quota", response_model=QuotaConfigResponse)
async def update_quota(
    body: QuotaConfigUpdate,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    config = await set_quota_config(db, body.model_dump(), admin.id)
    return QuotaConfigResponse(**config)


@router.get("/config/download", response_model=DownloadConfigResponse)
async def get_download_behavior_config(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    return DownloadConfigResponse(**await get_download_config(db))


@router.put("/config/download", response_model=DownloadConfigResponse)
async def update_download_behavior_config(
    body: DownloadConfigUpdate,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    config = await set_download_config(db, body.model_dump(), admin.id)
    return DownloadConfigResponse(**config)


@router.post("/shares/{code}/ban", response_model=MessageResponse)
async def ban_share(
    code: str,
    body: BanShareRequest,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    share = await db.scalar(select(Share).where(Share.code == code))
    if not share:
        raise HTTPException(404, "分享不存在")
    share.banned_at = datetime.now(timezone.utc)
    share.banned_reason = body.reason
    await db.commit()
    return MessageResponse(message="分享已封禁")


@router.delete("/shares/{code}/ban", response_model=MessageResponse)
async def unban_share(
    code: str,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    share = await db.scalar(select(Share).where(Share.code == code))
    if not share:
        raise HTTPException(404, "分享不存在")
    share.banned_at = None
    share.banned_reason = None
    await db.commit()
    return MessageResponse(message="分享已解封")


# ─── 豆包 Session 管理 ─────────────────────────────────────────────

import json as _json
import threading
import time as _time
from pathlib import Path
from pydantic import BaseModel

# Global state for QR login flow
_qr_login_state: dict = {"status": "idle", "qr_base64": "", "error": ""}
_qr_login_lock = threading.Lock()
_qr_instance = None
_qr_test_b_state: dict = {"status": "idle", "qr_base64": "", "error": ""}
_qr_test_b_lock = threading.Lock()
_qr_test_b_instance = None


def _ensure_doubao_login_import_path() -> None:
    """确保可以导入仓库根目录下的 doubao_login 工具。"""
    import sys

    login_dir = Path(__file__).resolve().parents[3] / "doubao_login"
    if not login_dir.exists():
        raise HTTPException(500, "豆包扫码登录模块不存在")
    login_dir_str = str(login_dir)
    if login_dir_str not in sys.path:
        sys.path.insert(0, login_dir_str)


def _test_b_session_file() -> str:
    return str(Path(__file__).resolve().parents[3] / ".doubao_session_test_b.json")


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
    from app.services.doubao_client import DoubaoClientError, create_doubao_client_from_session, record_doubao_session_status

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
        except Exception as exc:  # noqa: BLE001
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
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _format_unix_ts(value: object) -> str:
    try:
        timestamp = float(value)
    except (TypeError, ValueError):
        return ""
    if timestamp <= 0:
        return ""
    return _format_utc(datetime.fromtimestamp(timestamp, tz=timezone.utc))


def _parse_sid_guard_times(sid_guard: str) -> tuple[datetime | None, datetime | None]:
    """解析 sid_guard 的客户端标称登录/到期时间。"""
    if not sid_guard:
        return None, None
    try:
        parts = unquote(sid_guard).split("|")
        login_at = datetime.fromtimestamp(int(parts[1]), tz=timezone.utc) if len(parts) > 1 and parts[1] else None
        expires_raw = parts[3].replace("+", " ") if len(parts) > 3 else ""
        expires_at = parsedate_to_datetime(expires_raw) if expires_raw else None
        if expires_at and expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        return login_at, expires_at
    except Exception:
        return None, None


async def _build_doubao_session_status(session_file: str | None, probe: bool = False) -> DoubaoSessionStatus:
    if not session_file or not Path(session_file).exists():
        return DoubaoSessionStatus(has_session=False)

    try:
        data = _json.loads(Path(session_file).read_text("utf-8"))
        cookies = data.get("cookies", {})
        status_data = data.get("nyy_status", {})
        if not isinstance(status_data, dict):
            status_data = {}
        sid = data.get("sessionid", cookies.get("sessionid", ""))
        sid_guard_login_at, sid_guard_expires_at = _parse_sid_guard_times(cookies.get("sid_guard", ""))
        ts = data.get("timestamp", 0)
        age_hours = (_time.time() - ts) / 3600 if ts else 0
        last_refresh = _format_utc(datetime.fromtimestamp(ts, tz=timezone.utc)) if ts else ""
        expires_in_hours = None
        sid_guard_status = "unknown"
        if sid_guard_expires_at:
            expires_in_hours = round((sid_guard_expires_at - datetime.now(timezone.utc)).total_seconds() / 3600, 1)
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
                refreshed_data = _json.loads(Path(session_file).read_text("utf-8"))
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
    _admin=Depends(get_current_admin_user),
):
    """启动豆包 QR 扫码登录流程。"""
    global _qr_instance
    import asyncio

    from app.core.config import get_settings

    settings = get_settings()
    if not settings.doubao_session_file:
        raise HTTPException(500, "DOUBAO_SESSION_FILE 未配置")

    event_loop = asyncio.get_running_loop()
    _ensure_doubao_login_import_path()
    from qr_login import QRLogin, QRStatus, QRResult
    from run import save_session

    with _qr_login_lock:
        if _qr_instance and _qr_instance.is_running:
            # Already running, return current QR if available
            if _qr_instance.qrcode_data:
                import base64
                qr_b64 = base64.b64encode(_qr_instance.qrcode_data).decode()
                return DoubaoQRStartResponse(qr_base64=qr_b64, message="已有进行中的扫码流程")
            raise HTTPException(409, "扫码流程已在进行中，请稍候")

        _qr_login_state["status"] = "fetching_qr"
        _qr_login_state["qr_base64"] = ""
        _qr_login_state["error"] = ""

    def on_status(status: QRStatus, msg: str):
        with _qr_login_lock:
            _qr_login_state["status"] = status.value
            if msg == "qr_ready":
                return

    def on_done(result: QRResult):
        global _qr_instance
        with _qr_login_lock:
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

    qr = QRLogin()
    _qr_instance = qr
    qr.start(on_status=on_status, on_done=on_done)

    # Wait briefly for QR code to generate
    for _ in range(40):
        _time.sleep(0.1)
        if qr.qrcode_data:
            break

    if not qr.qrcode_data:
        with _qr_login_lock:
            qr.cancel()
            _qr_login_state["status"] = "error"
            _qr_login_state["error"] = "QR code generation failed"
            _qr_instance = None
        raise HTTPException(500, "QR 码生成失败")

    import base64
    qr_b64 = base64.b64encode(qr.qrcode_data).decode()
    with _qr_login_lock:
        _qr_login_state["qr_base64"] = qr_b64
        if _qr_login_state["status"] == "fetching_qr":
            _qr_login_state["status"] = "waiting_scan"

    return DoubaoQRStartResponse(qr_base64=qr_b64)


@router.get("/doubao/qr-status", response_model=DoubaoQRStatusResponse)
async def doubao_qr_status(
    _admin=Depends(get_current_admin_user),
):
    """轮询 QR 扫码状态。"""
    with _qr_login_lock:
        status = _qr_login_state["status"]
        error = _qr_login_state.get("error", "")
    return DoubaoQRStatusResponse(status=status, message=_doubao_qr_message(status, error))


@router.post("/doubao/qr-cancel")
async def doubao_qr_cancel(
    _admin=Depends(get_current_admin_user),
):
    """取消进行中的 QR 扫码流程。"""
    global _qr_instance
    with _qr_login_lock:
        if _qr_instance and _qr_instance.is_running:
            _qr_instance.cancel()
        _qr_login_state["status"] = "idle"
        _qr_instance = None
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
    _admin=Depends(get_current_admin_user),
):
    """启动独立 B 账号 QR 扫码流程，不覆盖当前生产 Session。"""
    global _qr_test_b_instance
    _ensure_doubao_login_import_path()
    from qr_login import QRLogin, QRStatus, QRResult
    from run import save_session

    output_file = _test_b_session_file()
    with _qr_test_b_lock:
        if _qr_test_b_instance and _qr_test_b_instance.is_running:
            if _qr_test_b_instance.qrcode_data:
                import base64
                qr_b64 = base64.b64encode(_qr_test_b_instance.qrcode_data).decode()
                return DoubaoQRStartResponse(qr_base64=qr_b64, message="已有进行中的 B 账号扫码流程")
            raise HTTPException(409, "B 账号扫码流程已在进行中，请稍候")

        _qr_test_b_state["status"] = "fetching_qr"
        _qr_test_b_state["qr_base64"] = ""
        _qr_test_b_state["error"] = ""

    def on_status(status: QRStatus, msg: str):
        with _qr_test_b_lock:
            _qr_test_b_state["status"] = status.value
            if msg == "qr_ready":
                return

    def on_done(result: QRResult):
        global _qr_test_b_instance
        with _qr_test_b_lock:
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

    qr = QRLogin()
    _qr_test_b_instance = qr
    qr.start(on_status=on_status, on_done=on_done)

    for _ in range(40):
        _time.sleep(0.1)
        if qr.qrcode_data:
            break

    if not qr.qrcode_data:
        with _qr_test_b_lock:
            qr.cancel()
            _qr_test_b_state["status"] = "error"
            _qr_test_b_state["error"] = "QR code generation failed"
            _qr_test_b_instance = None
        raise HTTPException(500, "B 账号 QR 码生成失败")

    import base64
    qr_b64 = base64.b64encode(qr.qrcode_data).decode()
    with _qr_test_b_lock:
        _qr_test_b_state["qr_base64"] = qr_b64
        if _qr_test_b_state["status"] == "fetching_qr":
            _qr_test_b_state["status"] = "waiting_scan"
    return DoubaoQRStartResponse(qr_base64=qr_b64)


@router.get("/doubao/test-b/qr-status", response_model=DoubaoQRStatusResponse)
async def doubao_test_b_qr_status(
    _admin=Depends(get_current_admin_user),
):
    """轮询独立 B 账号 QR 扫码状态。"""
    with _qr_test_b_lock:
        status = _qr_test_b_state["status"]
        error = _qr_test_b_state.get("error", "")
    return DoubaoQRStatusResponse(status=status, message=_doubao_qr_message(status, error))


@router.post("/doubao/test-b/qr-cancel")
async def doubao_test_b_qr_cancel(
    _admin=Depends(get_current_admin_user),
):
    """取消独立 B 账号 QR 扫码流程。"""
    global _qr_test_b_instance
    with _qr_test_b_lock:
        if _qr_test_b_instance and _qr_test_b_instance.is_running:
            _qr_test_b_instance.cancel()
        _qr_test_b_state["status"] = "idle"
        _qr_test_b_instance = None
    return MessageResponse(message="已取消")
