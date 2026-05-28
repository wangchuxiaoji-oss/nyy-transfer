"""Admin API：仪表盘、用户、分享封禁、配额配置。"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
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
    AdminUsersResponse,
    BanShareRequest,
    MessageResponse,
    AdminEmailItem,
    AdminEmailsResponse,
    AdminReportItem,
    AdminReportsResponse,
    QuotaConfigResponse,
    QuotaConfigUpdate,
)
from app.services.app_config import get_quota_config, set_quota_config

router = APIRouter(prefix="/admin", tags=["admin"])


def _share_status_filters(status_filter: str, now: datetime):
    if status_filter == "revoked":
        return [Share.revoked_at.is_not(None)]
    if status_filter == "banned":
        return [Share.banned_at.is_not(None)]
    if status_filter == "expired":
        return [Share.revoked_at.is_(None), Share.banned_at.is_(None), Share.expires_at.is_not(None), Share.expires_at <= now]
    if status_filter == "active":
        return [Share.revoked_at.is_(None), Share.banned_at.is_(None), or_(Share.expires_at.is_(None), Share.expires_at > now)]
    return []


def _user_plan_filters(plan: str) -> list:
    if plan == "admin":
        return [User.plan == "admin"]
    if plan == "free":
        return [User.plan == "free"]
    if plan == "pro":
        return [User.plan == "pro"]
    return []


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
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|email_asc|email_desc|last_login_desc|last_login_asc)$"),
):
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(or_(User.email.ilike(like), User.plan.ilike(like)))
    filters.extend(_user_plan_filters(plan))

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
        users=[
            AdminUserItem(
                id=str(u.id),
                email=u.email,
                plan=u.plan,
                email_verified=u.email_verified_at is not None,
                created_at=u.created_at,
                last_login_at=u.last_login_at,
            )
            for u in users
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/shares", response_model=AdminSharesResponse)
async def list_shares(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|revoked|expired|banned)$"),
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
        .options(selectinload(Share.files))
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
                file_count=len(s.files),
                total_bytes=s.total_bytes,
                download_count=s.download_count,
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


class DoubaoSessionStatus(BaseModel):
    has_session: bool
    sessionid_prefix: str = ""
    last_refresh: str = ""
    age_hours: float = 0


class DoubaoQRStartResponse(BaseModel):
    qr_base64: str
    message: str = ""


class DoubaoQRStatusResponse(BaseModel):
    status: str  # idle, fetching_qr, waiting_scan, scanned, confirmed, expired, error
    message: str = ""


@router.get("/doubao/session-status", response_model=DoubaoSessionStatus)
async def doubao_session_status(
    _admin=Depends(get_current_admin_user),
):
    """获取当前豆包 session 状态。"""
    from app.core.config import get_settings
    settings = get_settings()
    session_file = settings.doubao_session_file
    if not session_file or not Path(session_file).exists():
        return DoubaoSessionStatus(has_session=False)

    try:
        data = _json.loads(Path(session_file).read_text("utf-8"))
        sid = data.get("sessionid", data.get("cookies", {}).get("sessionid", ""))
        ts = data.get("timestamp", 0)
        age_hours = (_time.time() - ts) / 3600 if ts else 0
        last_refresh = ""
        if ts:
            from datetime import datetime, timezone
            last_refresh = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        return DoubaoSessionStatus(
            has_session=bool(sid),
            sessionid_prefix=sid[:16] + "..." if sid else "",
            last_refresh=last_refresh,
            age_hours=round(age_hours, 1),
        )
    except Exception:
        return DoubaoSessionStatus(has_session=False)


@router.post("/doubao/qr-start", response_model=DoubaoQRStartResponse)
async def doubao_qr_start(
    _admin=Depends(get_current_admin_user),
):
    """启动豆包 QR 扫码登录流程。"""
    global _qr_instance
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "doubao_login"))
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
                from app.core.config import get_settings
                settings = get_settings()
                save_session(result, settings.doubao_session_file)
                # Reset the global doubao client so it reloads
                import asyncio
                from app.services.doubao_client import shutdown_doubao_client
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        loop.create_task(shutdown_doubao_client())
                    else:
                        asyncio.run(shutdown_doubao_client())
                except Exception:
                    pass
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
            _qr_login_state["status"] = "error"
            _qr_login_state["error"] = "QR code generation failed"
            _qr_instance = None
        raise HTTPException(500, "QR 码生成失败")

    import base64
    qr_b64 = base64.b64encode(qr.qrcode_data).decode()
    with _qr_login_lock:
        _qr_login_state["qr_base64"] = qr_b64
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
    messages = {
        "idle": "空闲",
        "fetching_qr": "正在获取二维码...",
        "waiting_scan": "等待扫码",
        "scanned": "已扫码，请在手机上确认",
        "confirmed": "登录成功，Session 已更新",
        "expired": "二维码已过期",
        "error": f"错误：{error}",
    }
    return DoubaoQRStatusResponse(status=status, message=messages.get(status, status))


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
