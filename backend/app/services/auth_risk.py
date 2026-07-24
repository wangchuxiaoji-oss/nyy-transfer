"""认证风控服务：登录失败计数、风险判断。"""

from __future__ import annotations

import hashlib
import logging

from app.core.config import get_settings

log = logging.getLogger(__name__)


def _email_fail_key(email: str) -> str:
    return f"nyy:auth:login_fail:email:{email.lower().strip()}"


def _ip_fail_key(ip: str) -> str:
    ip_h = hashlib.sha256(ip.encode()).hexdigest()[:16]
    return f"nyy:auth:login_fail:ip:{ip_h}"


async def record_login_failure(
    redis,
    email: str,
    ip: str | None,
) -> None:
    """记录登录失败。"""
    pipe = redis.pipeline()

    ek = _email_fail_key(email)
    pipe.incr(ek)
    pipe.expire(ek, 900)  # 15 分钟

    if ip:
        ik = _ip_fail_key(ip)
        pipe.incr(ik)
        pipe.expire(ik, 900)

    await pipe.execute()


async def clear_login_failures(redis, email: str, ip: str | None) -> None:
    """登录成功后清除失败计数。"""
    pipe = redis.pipeline()
    pipe.delete(_email_fail_key(email))
    if ip:
        pipe.delete(_ip_fail_key(ip))
    await pipe.execute()


async def check_login_risk(
    redis,
    email: str,
    ip: str | None,
) -> tuple[bool, str]:
    """检查登录风险。返回 (needs_captcha, reason)。"""
    settings = get_settings()

    # 同邮箱失败次数
    ek = _email_fail_key(email)
    email_count = await redis.get(ek)
    if email_count and int(email_count) >= settings.login_email_failure_captcha_threshold:
        return True, "该邮箱登录失败次数过多，请完成人机验证"

    # 同 IP 失败次数
    if ip:
        ik = _ip_fail_key(ip)
        ip_count = await redis.get(ik)
        if ip_count and int(ip_count) >= settings.login_ip_failure_captcha_threshold:
            return True, "当前网络登录失败次数过多，请完成人机验证"

    return False, ""


async def check_login_ip_rate_limit(
    redis,
    ip: str,
) -> bool:
    """检查 IP 级别登录失败限流。返回 True 表示允许继续。"""
    settings = get_settings()
    key = f"nyy:auth:login_rate:ip:{hashlib.sha256(ip.encode()).hexdigest()[:16]}"
    count = await redis.get(key)
    if count and int(count) >= settings.login_ip_failure_rate_limit:
        return False
    return True


async def increment_login_ip_rate(redis, ip: str) -> None:
    """递增 IP 登录失败速率计数。"""
    key = f"nyy:auth:login_rate:ip:{hashlib.sha256(ip.encode()).hexdigest()[:16]}"
    pipe = redis.pipeline()
    pipe.incr(key)
    pipe.expire(key, 3600)
    await pipe.execute()
