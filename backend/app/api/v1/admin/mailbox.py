"""admin@nyy.app 本机邮件工作台 API。"""

from __future__ import annotations

import html
import math
import re
import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import FileResponse
from sqlalchemy import Text, cast, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.mailbox import (
    MailboxAttachment,
    MailboxImportSource,
    MailboxImportTombstone,
    MailboxMessage,
)
from app.models.user import User
from app.schemas.mailbox import (
    MailboxAttachmentItem,
    MailboxForwardRequest,
    MailboxListResponse,
    MailboxMessageDetail,
    MailboxMessageSummary,
    MailboxReplyRequest,
    MailboxSendResponse,
    MailboxStateUpdate,
    MailboxThreadResponse,
)
from app.services.admin_audit import add_admin_audit, write_admin_audit
from app.services.mailbox import (
    MessageTooLargeError,
    delete_mailbox_storage_files,
    forwarded_bodies,
    load_forward_attachments,
    prefixed_subject,
    quoted_reply_bodies,
    reply_recipients,
    reply_references,
    resolve_storage_file,
    send_mailbox_message,
)
from app.utils.client_ip import get_client_ip

router = APIRouter(prefix="/mailbox", tags=["admin-mailbox"])


def _body_preview(message: MailboxMessage) -> str:
    value = message.text_body
    if not value and message.html_body:
        value = html.unescape(re.sub(r"<[^>]+>", " ", message.html_body))
    return " ".join(value.split())[:240]


def _summary(message: MailboxMessage) -> MailboxMessageSummary:
    return MailboxMessageSummary(
        id=str(message.id),
        thread_id=message.thread_id,
        message_id=message.message_id,
        direction=message.direction,
        delivery_status=message.delivery_status,
        from_addresses=message.from_addresses,
        to_addresses=message.to_addresses,
        cc_addresses=message.cc_addresses,
        subject=message.subject,
        body_preview=_body_preview(message),
        date=message.sent_at,
        received_at=message.received_at,
        is_read=message.is_read,
        is_starred=message.is_starred,
        is_archived=message.is_archived,
        is_spam=message.is_spam,
        is_trashed=message.is_trashed,
        attachment_count=len(message.attachments),
        size=message.size,
    )


def _detail(message: MailboxMessage) -> MailboxMessageDetail:
    summary = _summary(message)
    return MailboxMessageDetail(
        **summary.model_dump(),
        in_reply_to=message.in_reply_to,
        references=message.references,
        reply_to_addresses=message.reply_to_addresses,
        text_body=message.text_body,
        html_body=message.html_body,
        headers_summary=message.headers_summary,
        attachments=[
            MailboxAttachmentItem(
                id=str(item.id),
                filename=item.filename,
                content_type=item.content_type,
                content_disposition=item.content_disposition,
                content_id=item.content_id,
                is_inline=item.is_inline,
                size=item.size,
                sha256=item.sha256,
            )
            for item in message.attachments
        ],
    )


async def _get_message(db: AsyncSession, message_id: uuid.UUID) -> MailboxMessage:
    message = await db.scalar(
        select(MailboxMessage)
        .options(selectinload(MailboxMessage.attachments))
        .where(MailboxMessage.id == message_id)
    )
    if message is None:
        raise HTTPException(404, "邮件不存在")
    return message


def _state_snapshot(message: MailboxMessage) -> dict[str, bool]:
    return {
        "is_read": message.is_read,
        "is_starred": message.is_starred,
        "is_archived": message.is_archived,
        "is_spam": message.is_spam,
        "is_trashed": message.is_trashed,
    }


def _folder_filters(folder: str) -> list:
    if folder == "inbox":
        return [
            MailboxMessage.direction == "inbound",
            MailboxMessage.is_archived.is_(False),
            MailboxMessage.is_spam.is_(False),
            MailboxMessage.is_trashed.is_(False),
        ]
    if folder == "sent":
        return [MailboxMessage.direction == "outbound", MailboxMessage.is_trashed.is_(False)]
    if folder == "starred":
        return [MailboxMessage.is_starred.is_(True), MailboxMessage.is_trashed.is_(False)]
    if folder == "archive":
        return [MailboxMessage.is_archived.is_(True), MailboxMessage.is_trashed.is_(False)]
    if folder == "spam":
        return [MailboxMessage.is_spam.is_(True), MailboxMessage.is_trashed.is_(False)]
    if folder == "trash":
        return [MailboxMessage.is_trashed.is_(True)]
    return []


@router.get("/messages", response_model=MailboxListResponse)
async def list_mailbox_messages(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    folder: Literal["inbox", "sent", "starred", "archive", "spam", "trash", "all"] = "inbox",
    q: str = Query("", max_length=256),
    page: int = Query(1, ge=1, le=10_000),
    page_size: int = Query(50, ge=1, le=100),
):
    filters = _folder_filters(folder)
    if q.strip():
        pattern = f"%{q.strip()}%"
        filters.append(
            or_(
                MailboxMessage.subject.ilike(pattern),
                MailboxMessage.text_body.ilike(pattern),
                cast(MailboxMessage.from_addresses, Text).ilike(pattern),
                cast(MailboxMessage.to_addresses, Text).ilike(pattern),
                cast(MailboxMessage.cc_addresses, Text).ilike(pattern),
            )
        )
    total = await db.scalar(select(func.count()).select_from(MailboxMessage).where(*filters)) or 0
    rows = list(
        (
            await db.scalars(
                select(MailboxMessage)
                .options(selectinload(MailboxMessage.attachments))
                .where(*filters)
                .order_by(MailboxMessage.received_at.desc(), MailboxMessage.id.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            )
        ).all()
    )
    return MailboxListResponse(
        items=[_summary(message) for message in rows],
        total=total,
        page=page,
        page_size=page_size,
        pages=math.ceil(total / page_size) if total else 0,
    )


@router.get("/threads/{thread_id}", response_model=MailboxThreadResponse)
async def get_mailbox_thread(
    thread_id: str,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if not re.fullmatch(r"[0-9a-f]{64}", thread_id):
        raise HTTPException(400, "线程 ID 无效")
    messages = list(
        (
            await db.scalars(
                select(MailboxMessage)
                .options(selectinload(MailboxMessage.attachments))
                .where(MailboxMessage.thread_id == thread_id)
                .order_by(MailboxMessage.received_at.asc(), MailboxMessage.id.asc())
            )
        ).all()
    )
    if not messages:
        raise HTTPException(404, "邮件线程不存在")
    return MailboxThreadResponse(
        thread_id=thread_id,
        subject=messages[-1].subject,
        messages=[_detail(message) for message in messages],
    )


@router.get("/messages/{message_id}", response_model=MailboxThreadResponse)
async def get_mailbox_message_thread(
    message_id: uuid.UUID,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    message = await _get_message(db, message_id)
    messages = list(
        (
            await db.scalars(
                select(MailboxMessage)
                .options(selectinload(MailboxMessage.attachments))
                .where(MailboxMessage.thread_id == message.thread_id)
                .order_by(MailboxMessage.received_at.asc(), MailboxMessage.id.asc())
            )
        ).all()
    )
    return MailboxThreadResponse(
        thread_id=message.thread_id,
        subject=messages[-1].subject,
        messages=[_detail(item) for item in messages],
    )


@router.patch("/messages/{message_id}/state", response_model=MailboxMessageDetail)
async def update_mailbox_message_state(
    message_id: uuid.UUID,
    body: MailboxStateUpdate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    message = await _get_message(db, message_id)
    before = _state_snapshot(message)
    changes = body.model_dump(exclude_unset=True)
    for key, value in changes.items():
        setattr(message, key, value)
    if body.is_archived is True:
        message.is_spam = False
        message.is_trashed = False
    elif body.is_spam is True:
        message.is_archived = False
        message.is_trashed = False
        message.is_read = True
    elif body.is_trashed is True:
        message.is_archived = False
        message.is_spam = False
    after = _state_snapshot(message)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="mailbox.state_update",
        target_type="mailbox_message",
        target_id=str(message.id),
        before=before,
        after=after,
    )
    await db.commit()
    return _detail(message)


@router.delete(
    "/messages/{message_id}/permanent",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def permanently_delete_mailbox_message(
    message_id: uuid.UUID,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    message = await db.scalar(
        select(MailboxMessage)
        .options(selectinload(MailboxMessage.attachments))
        .where(MailboxMessage.id == message_id)
        .with_for_update()
    )
    if message is None:
        raise HTTPException(404, "邮件不存在")
    if not message.is_trashed:
        raise HTTPException(409, "邮件必须先移入垃圾箱才能永久删除")

    import_sources = list(
        (
            await db.scalars(
                select(MailboxImportSource).where(
                    MailboxImportSource.mailbox_message_id == message.id
                )
            )
        ).all()
    )
    source_paths = [source.raw_path for source in import_sources]
    storage_paths = [message.raw_path, *source_paths]
    storage_paths.extend(attachment.storage_path for attachment in message.attachments)
    cleanup_failures = delete_mailbox_storage_files(storage_paths)
    if cleanup_failures:
        actor_id = admin.id
        actor_email = admin.email
        await db.rollback()
        await write_admin_audit(
            actor_id=actor_id,
            actor_email=actor_email,
            request_id=str(uuid.uuid4()),
            ip=get_client_ip(request),
            user_agent=request.headers.get("user-agent", ""),
            action="mailbox.permanent_delete_cleanup",
            target_type="mailbox_message",
            target_id=str(message_id),
            after={
                "deleted": False,
                "storage_file_count": len(set(storage_paths)),
                "cleanup_failure_count": len(cleanup_failures),
            },
            success=False,
            error_summary="部分 EML 或附件未能清理，邮件记录已保留",
        )
        raise HTTPException(500, "部分存储文件清理失败，邮件记录已保留")

    audit = add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="mailbox.permanent_delete",
        target_type="mailbox_message",
        target_id=str(message.id),
        before={
            "subject": message.subject,
            "direction": message.direction,
            "is_trashed": message.is_trashed,
            "attachment_count": len(message.attachments),
            "storage_file_count": len(set(storage_paths)),
        },
        after={"deleted": True},
    )
    db.add_all(
        MailboxImportTombstone(maildir_key=source.maildir_key)
        for source in import_sources
    )
    await db.execute(
        delete(MailboxImportSource).where(
            MailboxImportSource.mailbox_message_id == message.id
        )
    )
    await db.execute(
        delete(MailboxAttachment).where(MailboxAttachment.mailbox_message_id == message.id)
    )
    await db.execute(delete(MailboxMessage).where(MailboxMessage.id == message.id))
    await db.commit()

    await write_admin_audit(
        actor_id=admin.id,
        actor_email=admin.email,
        request_id=audit.request_id or str(uuid.uuid4()),
        ip=get_client_ip(request),
        user_agent=request.headers.get("user-agent", ""),
        action="mailbox.permanent_delete_cleanup",
        target_type="mailbox_message",
        target_id=str(message_id),
        after={
            "storage_file_count": len(set(storage_paths)),
            "cleanup_failure_count": len(cleanup_failures),
        },
        success=True,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/messages/{message_id}/attachments/{attachment_id}")
async def download_mailbox_attachment(
    message_id: uuid.UUID,
    attachment_id: uuid.UUID,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    attachment = await db.scalar(
        select(MailboxAttachment).where(
            MailboxAttachment.id == attachment_id,
            MailboxAttachment.mailbox_message_id == message_id,
        )
    )
    if attachment is None:
        raise HTTPException(404, "附件不存在")
    try:
        path = resolve_storage_file(attachment.storage_path)
    except ValueError as error:
        raise HTTPException(404, "附件文件无效") from error
    if not path.is_file() or path.is_symlink():
        raise HTTPException(404, "附件文件不存在")
    return FileResponse(
        path,
        media_type=attachment.content_type,
        filename=attachment.filename,
    )


async def _commit_send_result(
    db: AsyncSession,
    *,
    request: Request,
    admin: User,
    original: MailboxMessage,
    outbound: MailboxMessage,
    sent: bool,
    action: str,
) -> MailboxMessage:
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action=action,
        target_type="mailbox_message",
        target_id=str(original.id),
        after={
            "outbound_message_id": str(outbound.id),
            "message_id": outbound.message_id,
            "delivery_status": outbound.delivery_status,
            "recipients": outbound.to_addresses,
        },
        success=sent,
        error_summary=None if sent else "Postfix 发送失败",
    )
    await db.commit()
    return await _get_message(db, outbound.id)


async def _audit_send_validation_failure(
    db: AsyncSession,
    *,
    request: Request,
    admin: User,
    original: MailboxMessage,
    action: str,
    error: Exception,
) -> None:
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action=action,
        target_type="mailbox_message",
        target_id=str(original.id),
        success=False,
        error_summary=str(error),
    )
    await db.commit()


@router.post("/messages/{message_id}/reply", response_model=MailboxSendResponse)
async def reply_mailbox_message(
    message_id: uuid.UUID,
    body: MailboxReplyRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    original = await _get_message(db, message_id)
    try:
        to, cc = reply_recipients(original, reply_all=body.reply_all)
        references = reply_references(original)
        text_body, html_body = quoted_reply_bodies(original, body.text, body.html)
        outbound, sent = await send_mailbox_message(
            db,
            to=to,
            cc=cc,
            subject=prefixed_subject(original.subject, "Re"),
            text_body=text_body,
            html_body=html_body,
            thread_id=original.thread_id,
            in_reply_to=original.message_id,
            references=references,
        )
    except (ValueError, MessageTooLargeError) as error:
        await _audit_send_validation_failure(
            db,
            request=request,
            admin=admin,
            original=original,
            action="mailbox.reply",
            error=error,
        )
        raise HTTPException(400, str(error)) from error
    outbound = await _commit_send_result(
        db,
        request=request,
        admin=admin,
        original=original,
        outbound=outbound,
        sent=sent,
        action="mailbox.reply",
    )
    if not sent:
        raise HTTPException(502, "Postfix 发送失败，失败发件已归档")
    return MailboxSendResponse(sent=True, message=_detail(outbound))


@router.post("/messages/{message_id}/forward", response_model=MailboxSendResponse)
async def forward_mailbox_message(
    message_id: uuid.UUID,
    body: MailboxForwardRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    original = await _get_message(db, message_id)
    try:
        text_body, html_body = forwarded_bodies(original, body.text, body.html)
        attachments = load_forward_attachments(original) if body.include_attachments else []
        outbound, sent = await send_mailbox_message(
            db,
            to=[str(address) for address in body.to],
            cc=[str(address) for address in body.cc],
            subject=prefixed_subject(original.subject, "Fwd"),
            text_body=text_body,
            html_body=html_body,
            thread_id=original.thread_id,
            references=reply_references(original),
            attachments=attachments,
        )
    except (ValueError, MessageTooLargeError) as error:
        await _audit_send_validation_failure(
            db,
            request=request,
            admin=admin,
            original=original,
            action="mailbox.forward",
            error=error,
        )
        raise HTTPException(400, str(error)) from error
    outbound = await _commit_send_result(
        db,
        request=request,
        admin=admin,
        original=original,
        outbound=outbound,
        sent=sent,
        action="mailbox.forward",
    )
    if not sent:
        raise HTTPException(502, "Postfix 发送失败，失败发件已归档")
    return MailboxSendResponse(sent=True, message=_detail(outbound))
