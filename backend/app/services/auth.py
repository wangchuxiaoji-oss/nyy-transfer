"""认证服务：密码哈希和 JWT access token。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.core.config import get_settings

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
    expire = datetime.now(UTC) + timedelta(
        minutes=settings.auth_access_token_expire_minutes
    )
    payload = {
        "sub": user_id,
        "email": email,
        "exp": expire,
        "type": "access",
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
