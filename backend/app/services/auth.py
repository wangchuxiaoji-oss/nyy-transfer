"""认证服务：密码哈希、JWT token、验证码管理。"""

from __future__ import annotations

import logging
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.core.config import get_settings

log = logging.getLogger(__name__)

# ─── 密码哈希 ────────────────────────────────────────────────────

_ph = PasswordHasher()


def hash_password(password: str) -> str:
    """Argon2id 哈希密码。"""
    return _ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    """验证密码。"""
    try:
        return _ph.verify(hashed, password)
    except VerifyMismatchError:
        return False


# ─── JWT Token ───────────────────────────────────────────────────

def create_access_token(user_id: str, email: str) -> str:
    """生成 access token。"""
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(
        minutes=settings.jwt_access_token_expire_minutes
    )
    payload = {
        "sub": user_id,
        "email": email,
        "exp": expire,
        "type": "access",
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_refresh_token(user_id: str) -> str:
    """生成 refresh token。"""
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(
        days=settings.jwt_refresh_token_expire_days
    )
    payload = {
        "sub": user_id,
        "exp": expire,
        "type": "refresh",
        "jti": secrets.token_hex(16),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str) -> dict | None:
    """解码并验证 token，失败返回 None。"""
    settings = get_settings()
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        return payload
    except jwt.PyJWTError:
        return None


# ─── 验证码管理（Redis） ─────────────────────────────────────────

def _code_key(email: str, purpose: str) -> str:
    return f"nyy:auth:code:{purpose}:{email}"


def _rate_key(email: str) -> str:
    return f"nyy:auth:rate:{email}"


def generate_code() -> str:
    """生成 6 位数字验证码。"""
    return f"{secrets.randbelow(1000000):06d}"


async def store_code(redis, email: str, code: str, purpose: str = "register") -> None:
    """存储验证码到 Redis，带 TTL。"""
    settings = get_settings()
    key = _code_key(email, purpose)
    ttl = settings.auth_code_ttl_minutes * 60
    # 存储格式：code:attempts
    await redis.set(key, f"{code}:0", ex=ttl)


async def verify_code(redis, email: str, code: str, purpose: str = "register") -> bool:
    """验证码校验。成功后删除，失败累加尝试次数。"""
    settings = get_settings()
    key = _code_key(email, purpose)
    stored = await redis.get(key)
    if not stored:
        return False

    parts = stored.split(":")
    if len(parts) != 2:
        return False

    stored_code, attempts = parts[0], int(parts[1])

    # 超过最大尝试次数
    if attempts >= settings.auth_code_max_attempts:
        await redis.delete(key)
        return False

    if code == stored_code:
        await redis.delete(key)
        return True

    # 错误，累加次数
    ttl = await redis.ttl(key)
    if ttl > 0:
        await redis.set(key, f"{stored_code}:{attempts + 1}", ex=ttl)
    return False


async def check_rate_limit(redis, email: str) -> bool:
    """检查发送频率限制。返回 True 表示允许发送。"""
    settings = get_settings()
    key = _rate_key(email)
    count = await redis.get(key)
    if count and int(count) >= settings.auth_code_rate_limit:
        return False
    # 递增计数，1 小时过期
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, 3600)
    await pipe.execute()
    return True
