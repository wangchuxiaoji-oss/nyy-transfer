"""邮件发送服务。

部署环境：同机 Postfix (localhost:25)，无需认证。
开发环境：可配置外部 SMTP 或跳过发送。
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from email.header import Header
from email.message import Message
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr
from uuid import UUID

import aiosmtplib
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_session_factory
from app.models.share import Share
from app.models.system import EmailDelivery

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

async def send_message(message: Message) -> bool:
    """通过现有 SMTP 配置发送已构造的消息。"""

    settings = get_settings()
    try:
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            use_tls=False,
            start_tls=False,
        )
        log.info(
            "email sent to=%s subject=%s",
            message.get("To", ""),
            message.get("Subject", ""),
        )
        return True
    except Exception as e:
        log.error("email send failed to=%s error=%s", message.get("To", ""), str(e))
        return False


async def send_email(to: str, subject: str, html: str, text: str) -> bool:
    """发送邮件。成功返回 True，失败返回 False（不抛异常）。"""
    settings = get_settings()

    try:
        if any(character in to or character in subject for character in ("\r", "\n", "\x00")):
            raise ValueError("邮件头包含非法换行")
        msg = MIMEMultipart("alternative")
        msg["From"] = formataddr((str(Header("拿呀呀", "utf-8")), settings.email_from))
        msg["To"] = to
        msg["Subject"] = str(Header(subject, "utf-8"))
        msg.attach(MIMEText(text, "plain", "utf-8"))
        msg.attach(MIMEText(html, "html", "utf-8"))
    except (TypeError, ValueError) as error:
        log.error("email build failed to=%s error=%s", to, str(error))
        return False
    return await send_message(msg)


async def enqueue_share_emails(
    db: AsyncSession,
    *,
    share_id: UUID,
    recipients: list[str],
) -> list[UUID]:
    """在分享事务内写入待发送行，确保提交后邮件不会静默丢失。"""

    deliveries: list[EmailDelivery] = []
    normalized_recipients = dict.fromkeys(value.strip().casefold() for value in recipients)
    for recipient in normalized_recipients:
        delivery = EmailDelivery(
            share_id=share_id,
            recipient=recipient,
            status="pending",
            delivery_type="share_link",
            attempt_number=1,
            idempotency_key=f"share:{share_id}:{recipient}",
        )
        db.add(delivery)
        deliveries.append(delivery)
    await db.flush()
    return [delivery.id for delivery in deliveries]


async def dispatch_share_email(
    db: AsyncSession,
    *,
    delivery_id: UUID,
    app_base_url: str,
) -> bool:
    """持有投递行锁发送一次；并发 worker 或管理员不会重复发送同一尝试。"""

    row = await db.execute(
        select(EmailDelivery, Share)
        .join(Share, Share.id == EmailDelivery.share_id)
        .where(EmailDelivery.id == delivery_id)
        .with_for_update(of=EmailDelivery)
    )
    found = row.one_or_none()
    if found is None:
        return False
    delivery, share = found
    if delivery.status == "sent":
        return True
    if delivery.status not in {"pending", "failed"}:
        return False

    attempted_at = datetime.now(UTC)
    delivery.status = "processing"
    delivery.error = None
    delivery.last_attempt_at = attempted_at
    await db.flush()

    share_url = f"{app_base_url.rstrip('/')}/{share.code}"
    sent = await send_email(
        delivery.recipient,
        "拿呀呀分享链接",
        f'<p>分享链接：<a href="{share_url}">{share_url}</a></p>',
        f"分享链接：{share_url}",
    )
    delivery.status = "sent" if sent else "failed"
    delivery.error = None if sent else "send_failed"
    delivery.sent_at = attempted_at if sent else None
    return sent


async def dispatch_share_email_outbox(
    delivery_ids: list[UUID],
    *,
    app_base_url: str,
) -> None:
    """尽力即时投递；pending 可由定时任务补发，failed 可由管理员重试。"""

    factory = get_session_factory()
    for delivery_id in delivery_ids:
        try:
            async with factory() as db:
                await dispatch_share_email(
                    db,
                    delivery_id=delivery_id,
                    app_base_url=app_base_url,
                )
                await db.commit()
        except Exception:
            log.exception("share email outbox dispatch failed delivery_id=%s", delivery_id)


async def dispatch_pending_share_email_outbox(*, limit: int = 100) -> tuple[int, int]:
    """扫描并投递待发送邮件，行锁确保与请求内投递不会重复发送。"""

    factory = get_session_factory()
    async with factory() as db:
        delivery_ids = list(
            (
                await db.scalars(
                    select(EmailDelivery.id)
                    .where(EmailDelivery.status == "pending")
                    .order_by(EmailDelivery.created_at, EmailDelivery.id)
                    .limit(max(1, min(limit, 1_000)))
                )
            ).all()
        )

    sent = 0
    app_base_url = get_settings().app_base_url
    for delivery_id in delivery_ids:
        try:
            async with factory() as db:
                if await dispatch_share_email(
                    db,
                    delivery_id=delivery_id,
                    app_base_url=app_base_url,
                ):
                    sent += 1
                await db.commit()
        except Exception:
            log.exception("pending share email dispatch failed delivery_id=%s", delivery_id)
    return len(delivery_ids), sent


async def send_verification_code(
    to: str, code: str, *, purpose: str = "register"
) -> bool:
    """发送验证码邮件。"""
    settings = get_settings()
    ttl = settings.email_code_ttl_minutes

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
