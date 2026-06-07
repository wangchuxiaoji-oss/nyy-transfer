"""邮箱验证码服务：HMAC 存储、限流、发送。"""

from __future__ import annotations

import hashlib
import hmac as hmac_mod
import logging
import secrets
from datetime import datetime, timezone

from app.core.config import get_settings
from app.services.email import send_email

log = logging.getLogger(__name__)

# ─── 验证码模板 ──────────────────────────────────────────────────

_CODE_HTML = """\
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; background: #f9f9f9;">
<div style="max-width: 400px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
  <h2 style="color: #FF8A3D; margin: 0 0 24px; text-align: center;">拿呀呀</h2>
  <p style="color: #333; text-align: center; margin: 0 0 8px;">{title}</p>
  <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 20px; background: #FFF5EE; border-radius: 12px; margin: 20px 0; text-align: center; color: #333;">{code}</div>
  <p style="color: #999; font-size: 12px; text-align: center; margin: 0;">验证码 {ttl} 分钟内有效，请勿泄露给他人。</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #ccc; font-size: 11px; text-align: center; margin: 0;">nyy.app · 想传文件？拿呀呀</p>
</div>
</body>
</html>"""

_CODE_TEXT = """\
{title}

你的验证码是：{code}

验证码 {ttl} 分钟内有效，请勿泄露给他人。

—— nyy.app · 想传文件？拿呀呀"""

_RESET_NOTIFY_HTML = """\
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; background: #f9f9f9;">
<div style="max-width: 400px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
  <h2 style="color: #FF8A3D; margin: 0 0 24px; text-align: center;">拿呀呀</h2>
  <p style="color: #333; text-align: center; margin: 0 0 8px;">你的密码已被重置</p>
  <p style="color: #666; font-size: 14px; text-align: center; margin: 0 0 16px;">如果不是你本人操作，请立即重新重置密码或联系站点管理员。</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #ccc; font-size: 11px; text-align: center; margin: 0;">nyy.app · 想传文件？拿呀呀</p>
</div>
</body>
</html>"""

_RESET_NOTIFY_TEXT = """\
你的密码已被重置

如果不是你本人操作，请立即重新重置密码或联系站点管理员。

—— nyy.app · 想传文件？拿呀呀"""


# ─── HMAC 工具 ──────────────────────────────────────────────────

def _normalize_email(email: str) -> str:
    return email.lower().strip()


def _code_hash(email: str, purpose: str, code: str) -> str:
    """使用 HMAC 计算验证码哈希。"""
    settings = get_settings()
    msg = f"{purpose}:{_normalize_email(email)}:{code}"
    return hmac_mod.new(
        settings.email_code_secret.encode(),
        msg.encode(),
        hashlib.sha256,
    ).hexdigest()


def _email_hash(email: str) -> str:
    return hashlib.sha256(_normalize_email(email).encode()).hexdigest()[:16]


# ─── Redis key 工具 ──────────────────────────────────────────────

def _code_key(purpose: str, email: str) -> str:
    return f"nyy:auth:email_code:{purpose}:{_normalize_email(email)}"


def _cooldown_key(purpose: str, email: str) -> str:
    return f"nyy:auth:email_send:cooldown:{purpose}:{_normalize_email(email)}"


def _email_hour_key(purpose: str, email: str) -> str:
    return f"nyy:auth:email_send:email_hour:{purpose}:{_normalize_email(email)}"


def _ip_hour_key(ip_hash: str) -> str:
    return f"nyy:auth:email_send:ip_hour:{ip_hash}"


def _ip_day_key(ip_hash: str) -> str:
    return f"nyy:auth:email_send:ip_day:{ip_hash}"


# ─── 验证码生成 ─────────────────────────────────────────────────

def generate_email_code() -> str:
    """生成 6 位数字验证码。"""
    return f"{secrets.randbelow(1000000):06d}"


# ─── 存储 ────────────────────────────────────────────────────────

async def store_email_code(
    redis,
    email: str,
    code: str,
    purpose: str,
    ip: str | None = None,
    ua: str | None = None,
) -> None:
    """存储验证码哈希到 Redis。"""
    settings = get_settings()
    key = _code_key(purpose, email)
    ttl = settings.email_code_ttl_minutes * 60
    code_h = _code_hash(email, purpose, code)
    now = datetime.now(timezone.utc).isoformat()
    ip_h = hashlib.sha256((ip or "").encode()).hexdigest()[:16] if ip else ""
    ua_h = hashlib.sha256((ua or "").encode()).hexdigest()[:16] if ua else ""
    await redis.set(key, f"{code_h}:0:{now}:{ip_h}:{ua_h}", ex=ttl)


async def verify_email_code(
    redis,
    email: str,
    code: str,
    purpose: str,
) -> bool:
    """校验邮箱验证码。成功后删除，失败累加尝试次数。"""
    settings = get_settings()
    key = _code_key(purpose, email)
    stored = await redis.get(key)
    if not stored:
        return False

    parts = stored.split(":", maxsplit=4)
    if len(parts) != 5:
        return False

    stored_hash, attempts_str = parts[0], parts[1]
    try:
        attempts = int(attempts_str)
    except ValueError:
        return False

    if attempts >= settings.email_code_max_attempts:
        await redis.delete(key)
        return False

    computed = _code_hash(email, purpose, code)
    if hmac_mod.compare_digest(computed, stored_hash):
        await redis.delete(key)
        return True

    # 错误，累加次数
    ttl = await redis.ttl(key)
    if ttl > 0:
        next_attempts = attempts + 1
        if next_attempts >= settings.email_code_max_attempts:
            await redis.delete(key)
            return False
        parts[1] = str(next_attempts)
        await redis.set(key, ":".join(parts), ex=ttl)
    return False


# ─── 限流 ────────────────────────────────────────────────────────

async def check_send_rate_limit(
    redis,
    email: str,
    purpose: str,
    ip: str | None,
) -> tuple[bool, str]:
    """检查发送限流。返回 (allowed, reason)。"""
    settings = get_settings()
    ip_h = hashlib.sha256((ip or "").encode()).hexdigest()[:16] if ip else "noip"

    # 1. 同邮箱重发冷却
    cd_key = _cooldown_key(purpose, email)
    if await redis.exists(cd_key):
        return False, "发送过于频繁，请稍后再试"

    # 2. 同邮箱每小时
    eh_key = _email_hour_key(purpose, email)
    eh_count = await redis.get(eh_key)
    if eh_count and int(eh_count) >= settings.email_code_email_hourly_limit:
        return False, "该邮箱发送次数已达上限，请稍后再试"

    # 3. 同 IP 每小时
    ih_key = _ip_hour_key(ip_h)
    ih_count = await redis.get(ih_key)
    if ih_count and int(ih_count) >= settings.email_code_ip_hourly_limit:
        return False, "当前网络发送次数已达上限，请稍后再试"

    # 4. 同 IP 每日
    id_key = _ip_day_key(ip_h)
    id_count = await redis.get(id_key)
    if id_count and int(id_count) >= settings.email_code_ip_daily_limit:
        return False, "当前网络今日发送次数已达上限，请稍后再试"

    return True, ""


async def increment_send_counters(
    redis,
    email: str,
    purpose: str,
    ip: str | None,
) -> None:
    """发送成功后递增限流计数器。"""
    settings = get_settings()
    ip_h = hashlib.sha256((ip or "").encode()).hexdigest()[:16] if ip else "noip"

    pipe = redis.pipeline()

    # 冷却
    cd_key = _cooldown_key(purpose, email)
    pipe.set(cd_key, "1", ex=settings.email_code_resend_cooldown_seconds)

    # 邮箱每小时
    eh_key = _email_hour_key(purpose, email)
    pipe.incr(eh_key)
    pipe.expire(eh_key, 3600)

    # IP 每小时
    ih_key = _ip_hour_key(ip_h)
    pipe.incr(ih_key)
    pipe.expire(ih_key, 3600)

    # IP 每日
    id_key = _ip_day_key(ip_h)
    pipe.incr(id_key)
    pipe.expire(id_key, 86400)

    await pipe.execute()


# ─── 发送邮件 ────────────────────────────────────────────────────

_PURPOSE_TITLES = {
    "register": "注册验证码",
    "reset_password": "重置密码验证码",
}


async def send_email_code(
    email: str,
    code: str,
    purpose: str,
) -> bool:
    """发送验证码邮件。"""
    settings = get_settings()
    title = _PURPOSE_TITLES.get(purpose, "验证码")
    subject = f"拿呀呀 {title}"
    ttl = settings.email_code_ttl_minutes

    html = _CODE_HTML.format(title=title, code=code, ttl=ttl)
    text = _CODE_TEXT.format(title=title, code=code, ttl=ttl)

    return await send_email(email, subject, html, text)


async def send_password_reset_notify(email: str) -> bool:
    """发送密码重置成功通知邮件。"""
    return await send_email(
        email,
        "拿呀呀 密码已重置",
        _RESET_NOTIFY_HTML,
        _RESET_NOTIFY_TEXT,
    )
