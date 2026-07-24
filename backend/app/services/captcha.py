"""ALTCHA 验证码服务：challenge 生成、校验、captcha_token 签发。"""

from __future__ import annotations

import hashlib
import hmac as hmac_mod
import logging
import secrets
from datetime import UTC, datetime, timedelta

from altcha import create_challenge, verify_solution

from app.core.config import get_settings

log = logging.getLogger(__name__)

# ─── Redis key ──────────────────────────────────────────────────

def _challenge_key(challenge_id: str) -> str:
    return f"nyy:captcha:challenge:{challenge_id}"


def _token_key(token_hash: str) -> str:
    return f"nyy:captcha:token:{token_hash}"


def _hmac_token(token: str) -> str:
    settings = get_settings()
    return hmac_mod.new(
        settings.captcha_hmac_secret.encode(),
        token.encode(),
        hashlib.sha256,
    ).hexdigest()


# ─── Challenge ──────────────────────────────────────────────────

async def create_altcha_challenge(
    redis,
    purpose: str,
    ip: str | None = None,
    ua: str | None = None,
) -> dict:
    """创建 ALTCHA challenge 并存入 Redis。"""
    settings = get_settings()
    challenge_id = secrets.token_hex(16)
    now = datetime.now(UTC)
    expires_at = now + timedelta(seconds=settings.captcha_challenge_ttl_seconds)

    challenge = create_challenge(
        algorithm=settings.altcha_algorithm,
        cost=settings.altcha_cost,
        hmac_secret=settings.captcha_hmac_secret,
        expires_at=expires_at,
    )

    ip_h = hashlib.sha256((ip or "").encode()).hexdigest()[:16] if ip else ""
    ua_h = hashlib.sha256((ua or "").encode()).hexdigest()[:16] if ua else ""

    key = _challenge_key(challenge_id)
    await redis.set(
        key,
        f"{purpose}:{now.isoformat()}:{ip_h}:{ua_h}",
        ex=settings.captcha_challenge_ttl_seconds,
    )

    return {
        "challenge_id": challenge_id,
        "challenge": challenge.to_dict(),
        "expires_in": settings.captcha_challenge_ttl_seconds,
    }


# ─── 校验 ────────────────────────────────────────────────────────

async def verify_altcha_payload(
    redis,
    challenge_id: str,
    purpose: str,
    payload: str,
    ip: str | None = None,
    ua: str | None = None,
) -> tuple[bool, str]:
    """校验 ALTCHA payload，成功后签发 captcha_token。

    返回 (success, captcha_token_or_error)。
    """
    settings = get_settings()

    # 1. 检查 challenge 是否存在
    key = _challenge_key(challenge_id)
    stored = await redis.get(key)
    if not stored:
        return False, "验证码已过期或不存在"

    # 2. 解析 challenge 元数据
    parts = stored.split(":", 3)
    if len(parts) < 2:
        return False, "验证码数据格式错误"

    stored_purpose = parts[0]

    # 3. 校验 purpose
    if stored_purpose != purpose:
        return False, "验证码用途不匹配"

    # 4. 删除 challenge（一次性）
    await redis.delete(key)

    # 5. 校验 ALTCHA payload
    try:
        result = verify_solution(payload, settings.captcha_hmac_secret)
    except Exception:
        log.exception("altcha verify_solution error")
        return False, "验证码校验失败"

    if not result.verified:
        if result.expired:
            return False, "验证码已过期"
        if result.invalid_signature:
            return False, "验证码签名无效"
        if result.invalid_solution:
            return False, "验证码解答错误"
        return False, "验证码校验失败"

    # 6. 签发 captcha_token
    captcha_token = secrets.token_hex(32)
    token_h = _hmac_token(captcha_token)
    now = datetime.now(UTC)

    ip_h = hashlib.sha256((ip or "").encode()).hexdigest()[:16] if ip else ""
    ua_h = hashlib.sha256((ua or "").encode()).hexdigest()[:16] if ua else ""

    token_key = _token_key(token_h)
    await redis.set(
        token_key,
        f"{purpose}:{now.isoformat()}:{ip_h}:{ua_h}",
        ex=settings.captcha_token_ttl_seconds,
    )

    return True, captcha_token


# ─── 消费 captcha_token ──────────────────────────────────────────

async def consume_captcha_token(
    redis,
    captcha_token: str,
    purpose: str,
) -> bool:
    """消费一次性 captcha_token。成功返回 True。"""
    token_h = _hmac_token(captcha_token)
    key = _token_key(token_h)
    stored = await redis.get(key)
    if not stored:
        return False

    parts = stored.split(":", 1)
    if not parts:
        await redis.delete(key)
        return False

    stored_purpose = parts[0]
    await redis.delete(key)
    if stored_purpose != purpose:
        return False

    return True
