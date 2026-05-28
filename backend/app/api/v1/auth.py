"""认证 API：注册、验证邮箱、登录、刷新 token、重置密码。"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.user import User
from app.schemas.auth import (
    LoginRequest,
    MessageResponse,
    RefreshRequest,
    RegisterRequest,
    ResetPasswordRequest,
    SendCodeRequest,
    TokenResponse,
    UserInfoResponse,
    VerifyEmailRequest,
)
from app.services.auth import (
    check_rate_limit,
    create_access_token,
    create_refresh_token,
    decode_token,
    generate_code,
    hash_password,
    store_code,
    verify_code,
    verify_password,
)
from app.services.email import send_verification_code

router = APIRouter(prefix="/auth", tags=["auth"])


def _get_redis(request: Request):
    redis = request.app.state.redis
    if not redis:
        raise HTTPException(503, "服务暂时不可用")
    return redis


# ─── 发送验证码 ──────────────────────────────────────────────────

@router.post("/send-code", response_model=MessageResponse)
async def send_code(
    body: SendCodeRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """发送验证码到邮箱（注册/重置密码通用）。"""
    redis = _get_redis(request)

    # 频率限制
    allowed = await check_rate_limit(redis, body.email)
    if not allowed:
        raise HTTPException(429, "发送过于频繁，请稍后再试")

    # 注册场景：检查邮箱是否已存在
    if body.purpose == "register":
        existing = await db.execute(
            select(User).where(User.email == body.email)
        )
        if existing.scalar_one_or_none():
            raise HTTPException(409, "该邮箱已注册")

    # 重置密码场景：检查邮箱是否存在
    if body.purpose == "reset_password":
        existing = await db.execute(
            select(User).where(User.email == body.email)
        )
        if not existing.scalar_one_or_none():
            # 安全考虑：不暴露邮箱是否存在，静默返回成功
            return MessageResponse(message="验证码已发送")

    # 生成并存储验证码
    code = generate_code()
    await store_code(redis, body.email, code, body.purpose)

    # 发送邮件
    sent = await send_verification_code(body.email, code, purpose=body.purpose)
    if not sent:
        raise HTTPException(500, "邮件发送失败，请稍后重试")

    return MessageResponse(message="验证码已发送")


# ─── 注册 ────────────────────────────────────────────────────────

@router.post("/register", response_model=MessageResponse)
async def register(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """注册新用户（需先发送验证码）。"""
    redis = _get_redis(request)

    # 检查邮箱是否已存在
    existing = await db.execute(
        select(User).where(User.email == body.email)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(409, "该邮箱已注册")

    # 创建用户（未验证状态）
    user = User(
        email=body.email,
        password_hash=hash_password(body.password),
    )
    db.add(user)
    await db.commit()

    return MessageResponse(message="注册成功，请验证邮箱")


# ─── 验证邮箱 ────────────────────────────────────────────────────

@router.post("/verify-email", response_model=MessageResponse)
async def verify_email(
    body: VerifyEmailRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """验证邮箱验证码。"""
    redis = _get_redis(request)

    # 校验验证码
    valid = await verify_code(redis, body.email, body.code, "register")
    if not valid:
        raise HTTPException(400, "验证码错误或已过期")

    # 更新用户验证状态
    result = await db.execute(
        select(User).where(User.email == body.email)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "用户不存在")

    user.email_verified_at = datetime.now(timezone.utc)
    await db.commit()

    return MessageResponse(message="邮箱验证成功")


# ─── 登录 ────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    """邮箱+密码登录，返回 JWT token。"""
    from app.core.config import get_settings
    settings = get_settings()

    result = await db.execute(
        select(User).where(User.email == body.email)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(401, "邮箱或密码错误")

    if not user.email_verified_at:
        raise HTTPException(403, "请先验证邮箱")

    # 更新最后登录时间
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    # 生成 token
    user_id = str(user.id)
    access_token = create_access_token(user_id, user.email)
    refresh_token = create_refresh_token(user_id)

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.jwt_access_token_expire_minutes * 60,
    )


# ─── 刷新 Token ─────────────────────────────────────────────────

@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(
    body: RefreshRequest,
    db: AsyncSession = Depends(get_db),
):
    """用 refresh token 换取新的 access token。"""
    from app.core.config import get_settings
    settings = get_settings()

    payload = decode_token(body.refresh_token)
    if not payload or payload.get("type") != "refresh":
        raise HTTPException(401, "无效的 refresh token")

    user_id = payload.get("sub")
    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(401, "用户不存在")

    access_token = create_access_token(str(user.id), user.email)
    refresh = create_refresh_token(str(user.id))

    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh,
        expires_in=settings.jwt_access_token_expire_minutes * 60,
    )


# ─── 重置密码 ────────────────────────────────────────────────────

@router.post("/reset-password", response_model=MessageResponse)
async def reset_password(
    body: ResetPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """验证码 + 新密码重置。"""
    redis = _get_redis(request)

    # 校验验证码
    valid = await verify_code(redis, body.email, body.code, "reset_password")
    if not valid:
        raise HTTPException(400, "验证码错误或已过期")

    # 更新密码
    result = await db.execute(
        select(User).where(User.email == body.email)
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(404, "用户不存在")

    user.password_hash = hash_password(body.new_password)
    await db.commit()

    return MessageResponse(message="密码重置成功")


# ─── 获取当前用户信息 ────────────────────────────────────────────

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

    return UserInfoResponse(
        id=str(user.id),
        email=user.email,
        plan=user.plan,
        email_verified=user.email_verified_at is not None,
    )
