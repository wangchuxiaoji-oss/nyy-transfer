"""认证 API：发送验证码、注册、登录、刷新、登出、重置密码、当前用户。"""

from __future__ import annotations

import uuid
import re
from datetime import datetime, timezone
from typing import Literal
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_db
from app.models.user import User
from app.services.auth import (
    create_access_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.services.auth_audit import log_auth_event
from app.services.auth_risk import (
    check_login_ip_rate_limit,
    check_login_risk,
    clear_login_failures,
    increment_login_ip_rate,
    record_login_failure,
)
from app.services.auth_session import (
    create_session,
    get_active_session_by_token,
    revoke_family,
    revoke_session_by_token,
    revoke_user_sessions,
    rotate_session,
)
from app.services.quota import get_quota_snapshot
from app.services.captcha import consume_captcha_token
from app.services.email_code import (
    check_send_rate_limit,
    generate_email_code,
    increment_send_counters,
    send_email_code,
    send_password_reset_notify,
    store_email_code,
    verify_email_code,
)
from app.services.weak_passwords import is_weak_password

router = APIRouter(prefix="/auth", tags=["auth"])
_GUEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$")


def _get_redis(request: Request):
    redis = request.app.state.redis
    if not redis:
        raise HTTPException(503, "服务暂时不可用")
    return redis


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _get_guest_id(request: Request, ip: str) -> str:
    """返回当前浏览器游客身份；缺失时退回旧的 IP 归属。"""
    guest_id = (request.headers.get("x-nyy-guest-id") or "").strip()
    if _GUEST_ID_RE.match(guest_id):
        return guest_id
    return f"ip:{ip}"


def _get_ua(request: Request) -> str:
    return request.headers.get("user-agent", "")


def _origin_from_url(value: str) -> str | None:
    parsed = urlparse(value)
    if not parsed.scheme or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def _request_origin(request: Request) -> str:
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("host") or request.url.netloc
    return f"{scheme}://{host}"


def _enforce_cookie_csrf(request: Request) -> None:
    if request.headers.get("x-nyy-csrf") == "1":
        return
    settings = get_settings()
    source = request.headers.get("origin") or request.headers.get("referer")
    if not source:
        raise HTTPException(403, "缺少来源校验")

    source_origin = _origin_from_url(source)
    allowed = {_request_origin(request)}
    app_origin = _origin_from_url(settings.app_base_url)
    if app_origin:
        allowed.add(app_origin)
    if source_origin not in allowed:
        raise HTTPException(403, "来源校验失败")


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=settings.auth_refresh_cookie_name,
        value=raw_token,
        max_age=settings.auth_refresh_token_expire_days * 86400,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite=settings.auth_cookie_samesite,
        path="/api/v1/auth",
        domain=settings.auth_cookie_domain or None,
    )


def _delete_refresh_cookie(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(
        key=settings.auth_refresh_cookie_name,
        path="/api/v1/auth",
        domain=settings.auth_cookie_domain or None,
    )


# ─── 请求/响应模型 ──────────────────────────────────────────────

class MessageResponse(BaseModel):
    message: str


class SendCodeRequest(BaseModel):
    email: EmailStr
    purpose: str = Field(default="register", pattern=r"^(register|reset_password)$")
    captcha_token: str


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)
    captcha_token: str | None = None


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    new_password: str = Field(min_length=8, max_length=128)


class UserInfoResponse(BaseModel):
    id: str
    email: str
    plan: str
    is_admin: bool
    email_verified: bool
    disabled: bool = False
    deleted: bool = False


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserInfoResponse | None = None


class QuotaResponse(BaseModel):
    used_bytes: int
    limit_bytes: int
    remaining_bytes: int
    ttl_hours: int


class BootstrapAuthResponse(BaseModel):
    status: Literal["guest", "user"]
    user: UserInfoResponse | None = None
    token_type: str = "bearer"


class BootstrapResponse(BaseModel):
    auth: BootstrapAuthResponse
    quota: QuotaResponse


def _user_info(user: User) -> UserInfoResponse:
    return UserInfoResponse(
        id=str(user.id),
        email=user.email,
        plan=user.plan,
        is_admin=user.is_admin,
        email_verified=user.email_verified_at is not None,
        disabled=user.disabled_at is not None,
        deleted=user.deleted_at is not None,
    )


async def _guest_bootstrap_response(request: Request, db: AsyncSession) -> BootstrapResponse:
    ip = _get_client_ip(request)
    quota = await get_quota_snapshot(request.app.state.redis, db, user=None, guest_id=_get_guest_id(request, ip))
    return BootstrapResponse(auth=BootstrapAuthResponse(status="guest"), quota=QuotaResponse(**quota))


# ─── 发送验证码 ──────────────────────────────────────────────────

@router.post("/send-code", response_model=MessageResponse)
async def send_code(
    body: SendCodeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """发送邮箱验证码。需要先通过人机验证。"""
    redis = _get_redis(request)
    ip = _get_client_ip(request)
    ua = _get_ua(request)

    # 1. 消费 captcha_token
    captcha_ok = await consume_captcha_token(redis, body.captcha_token, "email_send")
    if not captcha_ok:
        raise HTTPException(400, "人机验证已过期或无效，请重新验证")

    # 2. 检查发送限流
    allowed, reason = await check_send_rate_limit(redis, body.email, body.purpose, ip)
    if not allowed:
        raise HTTPException(429, reason)

    # 3. 注册场景：检查邮箱是否已验证
    if body.purpose == "register":
        existing = await db.execute(
            select(User).where(User.email == body.email.lower().strip())
        )
        user = existing.scalar_one_or_none()
        if user and user.email_verified_at:
            raise HTTPException(409, "该邮箱已注册")

    # 4. 重置密码场景：不暴露邮箱是否存在
    if body.purpose == "reset_password":
        existing = await db.execute(
            select(User).where(User.email == body.email.lower().strip())
        )
        user = existing.scalar_one_or_none()
        if not user or not user.email_verified_at:
            await log_auth_event(
                db, event_type="password_reset_requested", success=True,
                email=body.email, ip=ip, user_agent=ua,
                reason="reset_password_nonexistent_email",
            )
            await log_auth_event(
                db, event_type="email_code_sent", success=True,
                email=body.email, ip=ip, user_agent=ua,
                reason="reset_password_nonexistent_email",
            )
            return MessageResponse(message="验证码已发送")

    # 5. 生成并存储验证码
    code = generate_email_code()
    await store_email_code(redis, body.email, code, body.purpose, ip, ua)

    # 6. 发送邮件
    sent = await send_email_code(body.email, code, body.purpose)
    if not sent:
        # 邮件发送失败，删除验证码
        from app.services.email_code import _code_key
        await redis.delete(_code_key(body.purpose, body.email))
        await log_auth_event(
            db, event_type="email_code_failed", success=False,
            email=body.email, ip=ip, user_agent=ua,
            reason="smtp_send_failed",
        )
        raise HTTPException(500, "邮件发送失败，请稍后重试")

    # 7. 递增限流计数
    await increment_send_counters(redis, body.email, body.purpose, ip)

    # 8. 审计
    await log_auth_event(
        db, event_type="email_code_sent", success=True,
        email=body.email, ip=ip, user_agent=ua,
    )
    if body.purpose == "reset_password":
        await log_auth_event(
            db, event_type="password_reset_requested", success=True,
            email=body.email, ip=ip, user_agent=ua,
        )

    return MessageResponse(message="验证码已发送")


# ─── 注册 ────────────────────────────────────────────────────────

@router.post("/register", response_model=MessageResponse)
async def register(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """注册新用户，需携带邮箱验证码。"""
    redis = _get_redis(request)
    ip = _get_client_ip(request)
    ua = _get_ua(request)
    normalized_email = body.email.lower().strip()

    # 1. 校验邮箱验证码
    code_ok = await verify_email_code(redis, body.email, body.code, "register")
    if not code_ok:
        await log_auth_event(
            db, event_type="register_failed", success=False,
            email=body.email, ip=ip, user_agent=ua,
            reason="invalid_email_code",
        )
        raise HTTPException(400, "验证码错误或已过期")

    # 2. 校验密码强度
    if is_weak_password(body.password, body.email):
        await log_auth_event(
            db, event_type="register_failed", success=False,
            email=body.email, ip=ip, user_agent=ua,
            reason="weak_password",
        )
        raise HTTPException(400, "密码过于常见，请换一个更安全的密码")

    # 3. 检查邮箱
    existing = await db.execute(
        select(User).where(User.email == normalized_email)
    )
    user = existing.scalar_one_or_none()

    if user and user.email_verified_at:
        await log_auth_event(
            db, event_type="register_failed", success=False,
            user_id=user.id, email=body.email, ip=ip, user_agent=ua,
            reason="email_already_registered",
        )
        raise HTTPException(409, "该邮箱已注册")

    now = datetime.now(timezone.utc)
    if user:
        # 存在未验证用户，更新密码并激活
        user.password_hash = hash_password(body.password)
        user.email_verified_at = now
    else:
        # 创建新用户
        user = User(
            email=normalized_email,
            password_hash=hash_password(body.password),
            email_verified_at=now,
        )
        db.add(user)

    await db.commit()

    await log_auth_event(
        db, event_type="register_success", success=True,
        user_id=user.id, email=body.email, ip=ip, user_agent=ua,
    )

    return MessageResponse(message="注册成功")


# ─── 登录 ────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """邮箱 + 密码登录，返回 access token 和 HttpOnly refresh cookie。"""
    redis = _get_redis(request)
    ip = _get_client_ip(request)
    ua = _get_ua(request)
    settings = get_settings()
    normalized_email = body.email.lower().strip()

    # 1. IP 速率限制
    if not await check_login_ip_rate_limit(redis, ip):
        raise HTTPException(429, "当前网络登录请求过多，请稍后再试")

    # 2. 风险检查
    needs_captcha, risk_reason = await check_login_risk(redis, body.email, ip)
    if needs_captcha:
        if not body.captcha_token:
            await log_auth_event(
                db, event_type="login_captcha_required", success=False,
                email=body.email, ip=ip, user_agent=ua,
                reason=risk_reason,
            )
            raise HTTPException(
                428,
                detail={"error": "captcha_required", "message": risk_reason},
            )
        # 消费 captcha_token
        captcha_ok = await consume_captcha_token(redis, body.captcha_token, "login")
        if not captcha_ok:
            raise HTTPException(400, "人机验证已过期或无效，请重新验证")

    # 3. 查找用户
    result = await db.execute(
        select(User).where(User.email == normalized_email)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        await record_login_failure(redis, body.email, ip)
        await increment_login_ip_rate(redis, ip)
        await log_auth_event(
            db, event_type="login_failed", success=False,
            email=body.email, ip=ip, user_agent=ua,
            reason="invalid_credentials",
        )
        raise HTTPException(401, "邮箱或密码错误")

    if user.deleted_at is not None:
        await log_auth_event(
            db, event_type="login_failed", success=False,
            user_id=user.id, email=body.email, ip=ip, user_agent=ua,
            reason="user_deleted",
        )
        raise HTTPException(403, "账号已删除")

    if user.disabled_at is not None:
        await log_auth_event(
            db, event_type="login_failed", success=False,
            user_id=user.id, email=body.email, ip=ip, user_agent=ua,
            reason="user_disabled",
        )
        raise HTTPException(403, "账号已禁用")

    if not user.email_verified_at:
        await record_login_failure(redis, body.email, ip)
        await log_auth_event(
            db, event_type="login_failed", success=False,
            user_id=user.id, email=body.email, ip=ip, user_agent=ua,
            reason="email_not_verified",
        )
        raise HTTPException(403, "请先验证邮箱")

    # 4. 成功：清除失败计数
    await clear_login_failures(redis, body.email, ip)

    # 5. 更新最后登录时间
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    # 6. 创建 refresh session
    _session_obj, raw_token = await create_session(
        db, user_id=user.id, ip=ip, ua=ua
    )
    await db.commit()

    # 7. 签发 access token
    user_id = str(user.id)
    access_token = create_access_token(user_id, user.email)

    # 8. 设置 refresh cookie
    _set_refresh_cookie(response, raw_token)

    # 9. 审计
    await log_auth_event(
        db, event_type="login_success", success=True,
        user_id=user.id, email=body.email, ip=ip, user_agent=ua,
    )

    return TokenResponse(
        access_token=access_token,
        expires_in=settings.auth_access_token_expire_minutes * 60,
        user=_user_info(user),
    )


# ─── 刷新 Token ─────────────────────────────────────────────────

@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """用 refresh cookie 换取新的 access token。"""
    _enforce_cookie_csrf(request)
    settings = get_settings()
    ip = _get_client_ip(request)
    ua = _get_ua(request)

    # 1. 从 cookie 读取 refresh token
    raw_token = request.cookies.get(settings.auth_refresh_cookie_name)
    if not raw_token:
        raise HTTPException(401, "未登录")

    # 2. 轮换 session
    new_session, new_token = await rotate_session(db, raw_token, ip=ip, ua=ua)

    if new_session is None and new_token is None:
        # token 不存在或已过期
        _delete_refresh_cookie(response)
        raise HTTPException(401, "登录状态已过期，请重新登录")

    if new_session is None and new_token is not None:
        # 复用检测：撤销整个 family
        family_id = uuid.UUID(new_token)
        await revoke_family(db, family_id)
        await db.commit()
        _delete_refresh_cookie(response)
        await log_auth_event(
            db, event_type="token_reuse_detected", success=False,
            ip=ip, user_agent=ua,
            reason=f"family {family_id} revoked",
        )
        raise HTTPException(401, "检测到异常登录，请重新登录")

    await db.commit()

    # 3. 签发 access token
    user_id = str(new_session.user_id)
    result = await db.execute(select(User).where(User.id == new_session.user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(401, "用户不存在")
    if user.deleted_at is not None or user.disabled_at is not None:
        await revoke_user_sessions(db, user.id)
        await db.commit()
        _delete_refresh_cookie(response)
        raise HTTPException(403, "账号已删除" if user.deleted_at is not None else "账号已禁用")

    access_token = create_access_token(user_id, user.email)

    # 4. 设置新的 refresh cookie
    _set_refresh_cookie(response, new_token)

    # 5. 审计
    await log_auth_event(
        db, event_type="token_refreshed", success=True,
        user_id=new_session.user_id, ip=ip, user_agent=ua,
    )

    return TokenResponse(
        access_token=access_token,
        expires_in=settings.auth_access_token_expire_minutes * 60,
    )


@router.post("/bootstrap", response_model=BootstrapResponse)
async def bootstrap(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """首屏启动：一次性返回身份和当前配额，避免客户端多路探测。"""
    settings = get_settings()
    raw_token = request.cookies.get(settings.auth_refresh_cookie_name)
    if not raw_token:
        return await _guest_bootstrap_response(request, db)

    session = await get_active_session_by_token(db, raw_token)
    if not session:
        _delete_refresh_cookie(response)
        return await _guest_bootstrap_response(request, db)

    result = await db.execute(select(User).where(User.id == session.user_id))
    user = result.scalar_one_or_none()
    if not user:
        _delete_refresh_cookie(response)
        return await _guest_bootstrap_response(request, db)

    if user.deleted_at is not None or user.disabled_at is not None:
        await revoke_user_sessions(db, user.id)
        await db.commit()
        _delete_refresh_cookie(response)
        return await _guest_bootstrap_response(request, db)

    quota = await get_quota_snapshot(
        request.app.state.redis,
        db,
        user=user,
        guest_id=_get_guest_id(request, _get_client_ip(request)),
    )
    return BootstrapResponse(
        auth=BootstrapAuthResponse(
            status="user",
            user=_user_info(user),
        ),
        quota=QuotaResponse(**quota),
    )


# ─── 登出 ────────────────────────────────────────────────────────

@router.post("/logout", response_model=MessageResponse)
async def logout(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """登出：撤销当前 refresh session 并清除 cookie。"""
    _enforce_cookie_csrf(request)
    settings = get_settings()
    ip = _get_client_ip(request)
    ua = _get_ua(request)

    raw_token = request.cookies.get(settings.auth_refresh_cookie_name)
    if raw_token:
        await revoke_session_by_token(db, raw_token)
        await db.commit()

    _delete_refresh_cookie(response)

    await log_auth_event(
        db, event_type="logout", success=True,
        ip=ip, user_agent=ua,
    )

    return MessageResponse(message="已登出")


# ─── 重置密码 ────────────────────────────────────────────────────

@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(
    body: ResetPasswordRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """验证码 + 新密码重置。"""
    redis = _get_redis(request)
    ip = _get_client_ip(request)
    ua = _get_ua(request)

    # 1. 校验验证码
    code_ok = await verify_email_code(redis, body.email, body.code, "reset_password")
    if not code_ok:
        await log_auth_event(
            db, event_type="password_reset_failed", success=False,
            email=body.email, ip=ip, user_agent=ua,
            reason="invalid_email_code",
        )
        raise HTTPException(400, "验证码错误或已过期")

    # 2. 校验密码强度
    if is_weak_password(body.new_password, body.email):
        await log_auth_event(
            db, event_type="password_reset_failed", success=False,
            email=body.email, ip=ip, user_agent=ua,
            reason="weak_password",
        )
        raise HTTPException(400, "密码过于常见，请换一个更安全的密码")

    # 3. 查找用户
    normalized_email = body.email.lower().strip()
    result = await db.execute(
        select(User).where(User.email == normalized_email)
    )
    user = result.scalar_one_or_none()
    if not user:
        await log_auth_event(
            db, event_type="password_reset_failed", success=False,
            email=body.email, ip=ip, user_agent=ua,
            reason="user_not_found",
        )
        raise HTTPException(400, "验证码错误或已过期")

    # 4. 更新密码
    user.password_hash = hash_password(body.new_password)
    await db.commit()

    # 5. 撤销所有 session
    await revoke_user_sessions(db, user.id)
    await db.commit()

    # 6. 清除 refresh cookie
    _delete_refresh_cookie(response)

    # 7. 发送通知邮件
    notify_sent = await send_password_reset_notify(body.email)
    if not notify_sent:
        await log_auth_event(
            db, event_type="password_reset_failed", success=False,
            user_id=user.id, email=body.email, ip=ip, user_agent=ua,
            reason="reset_notify_failed",
        )
        raise HTTPException(500, "密码重置通知邮件发送失败，请联系管理员")

    # 8. 审计
    await log_auth_event(
        db, event_type="password_reset_success", success=True,
        user_id=user.id, email=body.email, ip=ip, user_agent=ua,
    )

    return MessageResponse(message="密码重置成功")


# ─── 获取当前用户 ────────────────────────────────────────────────

@router.get("/me", response_model=UserInfoResponse)
async def get_me(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """获取当前登录用户信息（需 Authorization header）。"""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(401, "未登录")

    token = auth_header[7:]
    payload = decode_token(token)
    if not payload or payload.get("type") != "access":
        raise HTTPException(401, "token 无效或已过期")

    user_id = payload.get("sub")
    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(401, "用户不存在")
    if user.deleted_at is not None:
        raise HTTPException(403, "账号已删除")
    if user.disabled_at is not None:
        raise HTTPException(403, "账号已禁用")

    return _user_info(user)
