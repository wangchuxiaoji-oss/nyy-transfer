"""邮件发送服务。

部署环境：同机 Postfix (localhost:25)，无需认证。
开发环境：可配置外部 SMTP 或跳过发送。
"""

from __future__ import annotations

import logging
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import aiosmtplib

from app.core.config import get_settings

log = logging.getLogger(__name__)

# ─── HTML 邮件模板 ───────────────────────────────────────────────

VERIFY_CODE_HTML = """\
<!DOCTYPE html>
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 40px; background: #f9f9f9;">
<div style="max-width: 400px; margin: 0 auto; background: #fff; border-radius: 16px; padding: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
  <h2 style="color: #FF8A3D; margin: 0 0 24px; text-align: center;">拿呀呀</h2>
  <p style="color: #333; text-align: center; margin: 0 0 8px;">{title}</p>
  <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; padding: 20px; background: #FFF5EE; border-radius: 12px; margin: 20px 0; text-align: center; color: #333;">{code}</div>
  <p style="color: #999; font-size: 12px; text-align: center; margin: 0;">验证码 {ttl_minutes} 分钟内有效，请勿泄露给他人。</p>
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="color: #ccc; font-size: 11px; text-align: center; margin: 0;">nyy.app · 想传文件？拿呀呀</p>
</div>
</body>
</html>"""

VERIFY_CODE_TEXT = """\
{title}

你的验证码是：{code}

验证码 {ttl_minutes} 分钟内有效，请勿泄露给他人。

—— nyy.app · 想传文件？拿呀呀"""


# ─── 发送函数 ────────────────────────────────────────────────────

async def send_email(to: str, subject: str, html: str, text: str) -> bool:
    """发送邮件。成功返回 True，失败返回 False（不抛异常）。"""
    settings = get_settings()

    msg = MIMEMultipart("alternative")
    msg["From"] = f"拿呀呀 <{settings.email_from}>"
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    try:
        await aiosmtplib.send(
            msg,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            use_tls=False,
            start_tls=False,
        )
        log.info("email sent to=%s subject=%s", to, subject)
        return True
    except Exception as e:
        log.error("email send failed to=%s error=%s", to, str(e))
        return False


async def send_verification_code(
    to: str, code: str, *, purpose: str = "register"
) -> bool:
    """发送验证码邮件。"""
    settings = get_settings()
    ttl = settings.auth_code_ttl_minutes

    titles = {
        "register": "注册验证码",
        "reset_password": "重置密码验证码",
        "login": "登录验证码",
    }
    title = titles.get(purpose, "验证码")
    subject = f"拿呀呀 {title}"

    html = VERIFY_CODE_HTML.format(title=title, code=code, ttl_minutes=ttl)
    text = VERIFY_CODE_TEXT.format(title=title, code=code, ttl_minutes=ttl)

    return await send_email(to, subject, html, text)
