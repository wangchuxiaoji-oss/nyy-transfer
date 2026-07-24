"""Maildir 导入、MIME 安全处理与管理员邮箱发件服务。"""

from __future__ import annotations

import hashlib
import html
import logging
import os
import re
import stat
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email import policy
from email.message import EmailMessage, Message
from email.parser import BytesParser
from email.utils import format_datetime, getaddresses, make_msgid, parsedate_to_datetime
from pathlib import Path, PurePath

import bleach
from email_validator import EmailNotValidError, validate_email
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.mailbox import (
    MailboxAttachment,
    MailboxImportSource,
    MailboxImportTombstone,
    MailboxMessage,
)
from app.models.system import AuditLog
from app.services.email import send_message

log = logging.getLogger(__name__)

ADMIN_EMAIL = "admin@nyy.app"
ADMIN_NAME = "拿呀²"
MAX_MESSAGE_BYTES = 25 * 1024 * 1024
MAX_HEADER_VALUE = 8_000
MAX_BODY_CHARS = 8_000_000

_MESSAGE_ID_RE = re.compile(r"<[^<>\s]+>")
_SUBJECT_PREFIX_RE = re.compile(r"^(?:(?:re|fw|fwd)\s*:\s*)+", re.IGNORECASE)
_ALLOWED_HTML_TAGS = [
    "a",
    "b",
    "blockquote",
    "br",
    "code",
    "div",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "hr",
    "i",
    "li",
    "ol",
    "p",
    "pre",
    "span",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "u",
    "ul",
]
_ALLOWED_HTML_ATTRIBUTES = {
    "a": ["href", "title"],
    "td": ["colspan", "rowspan"],
    "th": ["colspan", "rowspan"],
}


class MessageTooLargeError(ValueError):
    pass


@dataclass(slots=True)
class ParsedAttachment:
    filename: str
    content_type: str
    content_disposition: str
    content_id: str | None
    is_inline: bool
    payload: bytes
    sha256: str


@dataclass(slots=True)
class ParsedMailboxMessage:
    message_id: str | None
    in_reply_to: str | None
    references: list[str]
    thread_id: str
    from_addresses: list[dict[str, str]]
    to_addresses: list[dict[str, str]]
    cc_addresses: list[dict[str, str]]
    reply_to_addresses: list[dict[str, str]]
    subject: str
    text_body: str
    html_body: str
    sent_at: datetime | None
    received_at: datetime
    headers_summary: dict
    attachments: list[ParsedAttachment] = field(default_factory=list)


@dataclass(slots=True)
class MaildirImportResult:
    scanned: int = 0
    imported: int = 0
    linked_duplicates: int = 0
    skipped_known: int = 0
    skipped_oversized: int = 0
    failed: int = 0


@dataclass(slots=True)
class OutboundAttachment:
    filename: str
    content_type: str
    payload: bytes


def mailbox_storage_root() -> Path:
    value = os.getenv("MAILBOX_STORAGE_PATH", "/data/nyy-runtime/mailbox")
    root = Path(value).expanduser()
    if not root.is_absolute():
        raise ValueError("MAILBOX_STORAGE_PATH 必须是绝对路径")
    return root.resolve(strict=False)


def sanitize_mail_html(value: str) -> str:
    """移除脚本、样式、表单和所有可自动请求远程资源的标签。"""

    if not value:
        return ""
    return bleach.clean(
        value[:MAX_BODY_CHARS],
        tags=_ALLOWED_HTML_TAGS,
        attributes=_ALLOWED_HTML_ATTRIBUTES,
        protocols=["http", "https", "mailto"],
        strip=True,
        strip_comments=True,
    )


def safe_attachment_name(value: str | None, index: int = 0) -> str:
    candidate = (value or f"attachment-{index + 1}").replace("\\", "/")
    candidate = PurePath(candidate).name
    candidate = "".join(character for character in candidate if ord(character) >= 32)
    candidate = candidate.strip().strip(".")
    if not candidate:
        candidate = f"attachment-{index + 1}"
    return candidate[:255]


def resolve_storage_file(relative_path: str, storage_root: Path | None = None) -> Path:
    root = (storage_root or mailbox_storage_root()).resolve(strict=False)
    candidate = Path(relative_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise ValueError("非法邮箱存储路径")
    resolved = (root / candidate).resolve(strict=False)
    if not resolved.is_relative_to(root):
        raise ValueError("非法邮箱存储路径")
    return resolved


def delete_mailbox_storage_files(
    relative_paths: list[str],
    *,
    storage_root: Path | None = None,
) -> list[str]:
    """删除指定 EML/附件文件，返回未能清理的相对路径。"""

    failures: list[str] = []
    for relative_path in dict.fromkeys(relative_paths):
        try:
            path = resolve_storage_file(relative_path, storage_root)
            if path.is_symlink():
                raise ValueError("邮箱存储文件不能是符号链接")
            path.unlink(missing_ok=True)
            try:
                path.parent.rmdir()
            except OSError:
                pass
        except (OSError, ValueError):
            log.exception("邮箱永久删除清理文件失败: %s", relative_path)
            failures.append(relative_path)
    return failures


def _clean_header(value: object | None, limit: int = MAX_HEADER_VALUE) -> str:
    text = str(value or "")
    text = " ".join(text.replace("\r", " ").replace("\n", " ").split())
    return "".join(character for character in text if ord(character) >= 32)[:limit]


def _validate_outbound_header(value: str, field_name: str) -> str:
    if "\r" in value or "\n" in value or "\x00" in value:
        raise ValueError(f"{field_name} 包含非法换行")
    return value.strip()


def _normalize_message_id(value: object | None) -> str | None:
    cleaned = _clean_header(value, 998)
    if not cleaned:
        return None
    match = _MESSAGE_ID_RE.search(cleaned)
    token = match.group(0) if match else f"<{cleaned.strip('<> ')}>"
    if any(character.isspace() for character in token[1:-1]) or token == "<>":
        return None
    return token.casefold()[:998]


def _parse_references(value: object | None) -> list[str]:
    cleaned = _clean_header(value)
    values = _MESSAGE_ID_RE.findall(cleaned)
    if not values and cleaned:
        values = cleaned.split()
    normalized: list[str] = []
    for item in values:
        message_id = _normalize_message_id(item)
        if message_id and message_id not in normalized:
            normalized.append(message_id)
        if len(normalized) >= 50:
            break
    return normalized


def _parse_addresses(message: Message, header_name: str) -> list[dict[str, str]]:
    raw_values = message.get_all(header_name, [])
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for name, address in getaddresses([str(value) for value in raw_values]):
        clean_address = _clean_header(address, 320).casefold()
        if not clean_address or "@" not in clean_address or clean_address in seen:
            continue
        seen.add(clean_address)
        result.append({"name": _clean_header(name, 255), "address": clean_address})
        if len(result) >= 100:
            break
    return result


def _parse_date(value: object | None) -> datetime | None:
    cleaned = _clean_header(value, 998)
    if not cleaned:
        return None
    try:
        parsed = parsedate_to_datetime(cleaned)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _part_payload(part: Message) -> bytes:
    payload = part.get_payload(decode=True)
    if isinstance(payload, bytes):
        return payload
    value = part.get_payload()
    if isinstance(value, str):
        charset = part.get_content_charset() or "utf-8"
        try:
            return value.encode(charset, errors="replace")
        except LookupError:
            return value.encode("utf-8", errors="replace")
    return part.as_bytes(policy=policy.default)


def _decode_text_part(part: Message) -> str:
    payload = _part_payload(part)
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("utf-8", errors="replace")


def _thread_id(
    message_id: str | None,
    in_reply_to: str | None,
    references: list[str],
    raw_sha256: str,
) -> str:
    root = references[0] if references else in_reply_to or message_id or raw_sha256
    return hashlib.sha256(root.casefold().encode("utf-8")).hexdigest()


def parse_mailbox_message(
    raw: bytes,
    *,
    received_at: datetime | None = None,
) -> ParsedMailboxMessage:
    if len(raw) > MAX_MESSAGE_BYTES:
        raise MessageTooLargeError("单封邮件超过 25MB")
    parsed = BytesParser(policy=policy.default).parsebytes(raw)
    raw_sha256 = hashlib.sha256(raw).hexdigest()
    message_id = _normalize_message_id(parsed.get("Message-ID"))
    in_reply_to = _normalize_message_id(parsed.get("In-Reply-To"))
    references = _parse_references(parsed.get("References"))
    fallback_received_at = received_at or datetime.now(UTC)

    text_parts: list[str] = []
    html_parts: list[str] = []
    attachments: list[ParsedAttachment] = []
    for part in parsed.walk():
        if part.is_multipart():
            continue
        content_type = _clean_header(part.get_content_type(), 255) or "application/octet-stream"
        disposition = _clean_header(part.get_content_disposition(), 32).casefold()
        filename = part.get_filename()
        content_id = _clean_header(part.get("Content-ID"), 998) or None
        is_attachment = bool(filename) or disposition in {"attachment", "inline"}
        if is_attachment:
            payload = _part_payload(part)
            safe_name = safe_attachment_name(filename, len(attachments))
            attachments.append(
                ParsedAttachment(
                    filename=safe_name,
                    content_type=content_type,
                    content_disposition=disposition or "attachment",
                    content_id=content_id,
                    is_inline=disposition == "inline",
                    payload=payload,
                    sha256=hashlib.sha256(payload).hexdigest(),
                )
            )
            continue
        if content_type == "text/plain":
            text_parts.append(_decode_text_part(part))
        elif content_type == "text/html":
            html_parts.append(_decode_text_part(part))

    text_body = "\n\n".join(text_parts)[:MAX_BODY_CHARS]
    html_body = sanitize_mail_html("\n".join(html_parts))
    sent_at = _parse_date(parsed.get("Date"))
    actual_received_at = fallback_received_at.astimezone(UTC)
    headers_summary = {
        "message_id": message_id,
        "in_reply_to": in_reply_to,
        "references": references,
        "list_id": _clean_header(parsed.get("List-ID"), 998) or None,
        "auto_submitted": _clean_header(parsed.get("Auto-Submitted"), 255) or None,
        "x_spam_status": _clean_header(parsed.get("X-Spam-Status"), 512) or None,
        "delivered_to": _clean_header(parsed.get("Delivered-To"), 320) or None,
        "user_agent": _clean_header(parsed.get("User-Agent"), 512) or None,
    }
    headers_summary = {key: value for key, value in headers_summary.items() if value not in (None, [], "")}
    return ParsedMailboxMessage(
        message_id=message_id,
        in_reply_to=in_reply_to,
        references=references,
        thread_id=_thread_id(message_id, in_reply_to, references, raw_sha256),
        from_addresses=_parse_addresses(parsed, "From"),
        to_addresses=_parse_addresses(parsed, "To"),
        cc_addresses=_parse_addresses(parsed, "Cc"),
        reply_to_addresses=_parse_addresses(parsed, "Reply-To"),
        subject=_clean_header(parsed.get("Subject"), 2_000),
        text_body=text_body,
        html_body=html_body,
        sent_at=sent_at,
        received_at=actual_received_at,
        headers_summary=headers_summary,
        attachments=attachments,
    )


def _ensure_storage_root(root: Path) -> Path:
    root = root.resolve(strict=False)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink() or not root.is_dir():
        raise ValueError("邮箱存储根目录无效")
    return root


def _write_immutable(root: Path, relative_path: Path, payload: bytes) -> str:
    destination = resolve_storage_file(relative_path.as_posix(), root)
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(destination, flags, 0o600)
    except FileExistsError:
        return relative_path.as_posix()
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    return relative_path.as_posix()


def _store_raw(root: Path, raw_sha256: str, raw: bytes) -> str:
    return _write_immutable(root, Path("raw") / raw_sha256[:2] / f"{raw_sha256}.eml", raw)


def _store_attachments(
    root: Path,
    message_id: uuid.UUID,
    attachments: list[ParsedAttachment],
) -> list[MailboxAttachment]:
    rows: list[MailboxAttachment] = []
    for parsed in attachments:
        attachment_id = uuid.uuid4()
        relative_path = Path("attachments") / str(message_id) / str(attachment_id)
        storage_path = _write_immutable(root, relative_path, parsed.payload)
        rows.append(
            MailboxAttachment(
                id=attachment_id,
                mailbox_message_id=message_id,
                filename=parsed.filename,
                content_type=parsed.content_type,
                content_disposition=parsed.content_disposition,
                content_id=parsed.content_id,
                is_inline=parsed.is_inline,
                size=len(parsed.payload),
                sha256=parsed.sha256,
                storage_path=storage_path,
            )
        )
    return rows


def _message_from_parsed(
    parsed: ParsedMailboxMessage,
    *,
    raw_sha256: str,
    raw_path: str,
    raw_size: int,
    direction: str,
    delivery_status: str,
    thread_id: str | None = None,
) -> MailboxMessage:
    return MailboxMessage(
        id=uuid.uuid4(),
        thread_id=thread_id or parsed.thread_id,
        message_id=parsed.message_id,
        in_reply_to=parsed.in_reply_to,
        references=parsed.references,
        direction=direction,
        delivery_status=delivery_status,
        from_addresses=parsed.from_addresses,
        to_addresses=parsed.to_addresses,
        cc_addresses=parsed.cc_addresses,
        reply_to_addresses=parsed.reply_to_addresses,
        subject=parsed.subject,
        text_body=parsed.text_body,
        html_body=parsed.html_body,
        sent_at=parsed.sent_at,
        received_at=parsed.received_at,
        is_read=direction == "outbound",
        headers_summary=parsed.headers_summary,
        raw_sha256=raw_sha256,
        raw_path=raw_path,
        size=raw_size,
    )


def _read_maildir_file(path: Path) -> tuple[bytes, datetime]:
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags)
    try:
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode):
            raise ValueError("Maildir 条目不是普通文件")
        if file_stat.st_size > MAX_MESSAGE_BYTES:
            raise MessageTooLargeError("单封邮件超过 25MB")
        chunks: list[bytes] = []
        remaining = MAX_MESSAGE_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > MAX_MESSAGE_BYTES:
            raise MessageTooLargeError("单封邮件超过 25MB")
        received_at = datetime.fromtimestamp(file_stat.st_mtime, tz=UTC)
        return raw, received_at
    finally:
        os.close(descriptor)


def _maildir_entries(maildir_path: Path) -> list[tuple[str, Path, str]]:
    entries: dict[str, tuple[Path, str]] = {}
    for folder in ("new", "cur"):
        directory = maildir_path / folder
        if not directory.is_dir():
            raise ValueError(f"MAILDIR_PATH 缺少 {folder}/ 目录")
        with os.scandir(directory) as iterator:
            for entry in iterator:
                if not entry.is_file(follow_symlinks=False):
                    continue
                maildir_key = entry.name.split(":2,", 1)[0]
                if not maildir_key or len(maildir_key) > 512:
                    continue
                entries[maildir_key] = (Path(entry.path), f"{folder}/{entry.name}"[:1024])
    return [(key, path, source) for key, (path, source) in sorted(entries.items())]


def _initial_maildir_flags(source_path: str) -> dict[str, bool]:
    flags = source_path.split(":2,", 1)[1] if ":2," in source_path else ""
    return {
        "is_read": "S" in flags,
        "is_starred": "F" in flags,
        "is_spam": "J" in flags,
        "is_trashed": "T" in flags,
    }


def _add_import_audit(
    db: AsyncSession,
    message: MailboxMessage,
    *,
    action: str,
    source_path: str,
) -> None:
    now = datetime.now(UTC)
    db.add(
        AuditLog(
            actor_id=None,
            actor_email=None,
            request_id=f"maildir:{uuid.uuid4()}",
            action=action,
            target=f"mailbox_message:{message.id}"[:128],
            payload={"source_path": source_path, "raw_sha256": message.raw_sha256},
            target_type="mailbox_message",
            target_id=str(message.id),
            before_value=None,
            after_value={"source_path": source_path, "raw_sha256": message.raw_sha256},
            success=True,
            created_at=now,
        )
    )


async def import_maildir(
    db: AsyncSession,
    maildir_path: Path,
    *,
    storage_root: Path | None = None,
) -> MaildirImportResult:
    """扫描 Maildir new/cur，仅打开尚未记录的 Maildir 唯一键。"""

    maildir_path = maildir_path.expanduser().resolve(strict=True)
    if not maildir_path.is_dir():
        raise ValueError("MAILDIR_PATH 不是目录")
    root = _ensure_storage_root(storage_root or mailbox_storage_root())
    entries = _maildir_entries(maildir_path)
    result = MaildirImportResult(scanned=len(entries))
    keys = [item[0] for item in entries]
    known: set[str] = set()
    for start in range(0, len(keys), 1_000):
        rows = await db.scalars(
            select(MailboxImportSource.maildir_key).where(
                MailboxImportSource.maildir_key.in_(keys[start : start + 1_000])
            )
        )
        known.update(rows.all())
        tombstones = await db.scalars(
            select(MailboxImportTombstone.maildir_key).where(
                MailboxImportTombstone.maildir_key.in_(keys[start : start + 1_000])
            )
        )
        known.update(tombstones.all())

    for maildir_key, path, source_path in entries:
        if maildir_key in known:
            result.skipped_known += 1
            continue
        try:
            raw, file_received_at = _read_maildir_file(path)
            raw_sha256 = hashlib.sha256(raw).hexdigest()
            parsed = parse_mailbox_message(raw, received_at=file_received_at)
            raw_path = _store_raw(root, raw_sha256, raw)
            identity_filters = [MailboxMessage.raw_sha256 == raw_sha256]
            if parsed.message_id:
                identity_filters.append(MailboxMessage.message_id == parsed.message_id)
            existing = await db.scalar(select(MailboxMessage).where(or_(*identity_filters)))
            async with db.begin_nested():
                if existing is not None:
                    db.add(
                        MailboxImportSource(
                            maildir_key=maildir_key,
                            mailbox_message_id=existing.id,
                            source_path=source_path,
                            raw_sha256=raw_sha256,
                            raw_path=raw_path,
                            size=len(raw),
                        )
                    )
                    _add_import_audit(
                        db,
                        existing,
                        action="mailbox.import_source",
                        source_path=source_path,
                    )
                    await db.flush()
                    result.linked_duplicates += 1
                    continue

                message = _message_from_parsed(
                    parsed,
                    raw_sha256=raw_sha256,
                    raw_path=raw_path,
                    raw_size=len(raw),
                    direction="inbound",
                    delivery_status="received",
                )
                for attribute, value in _initial_maildir_flags(source_path).items():
                    setattr(message, attribute, value)
                db.add(message)
                db.add_all(_store_attachments(root, message.id, parsed.attachments))
                db.add(
                    MailboxImportSource(
                        maildir_key=maildir_key,
                        mailbox_message_id=message.id,
                        source_path=source_path,
                        raw_sha256=raw_sha256,
                        raw_path=raw_path,
                        size=len(raw),
                    )
                )
                _add_import_audit(
                    db,
                    message,
                    action="mailbox.import",
                    source_path=source_path,
                )
                await db.flush()
                result.imported += 1
        except MessageTooLargeError:
            result.skipped_oversized += 1
        except Exception:
            result.failed += 1
            log.exception("Maildir 邮件导入失败: %s", source_path)
    await db.commit()
    return result


def _format_address_list(addresses: list[dict[str, str]]) -> str:
    values = []
    for item in addresses:
        name = item.get("name", "")
        address = item.get("address", "")
        values.append(f"{name} <{address}>" if name else address)
    return ", ".join(values)


def _validated_recipient(value: str) -> str:
    cleaned = _validate_outbound_header(value, "收件人")
    try:
        return validate_email(cleaned, check_deliverability=False).normalized
    except EmailNotValidError as error:
        raise ValueError("收件地址无效") from error


def reply_recipients(message: MailboxMessage, *, reply_all: bool) -> tuple[list[str], list[str]]:
    if message.direction == "outbound":
        primary = message.to_addresses
    else:
        primary = message.reply_to_addresses or message.from_addresses
    to = [item.get("address", "") for item in primary]
    cc: list[str] = []
    if reply_all:
        if message.direction != "outbound":
            cc.extend(item.get("address", "") for item in message.to_addresses)
        cc.extend(item.get("address", "") for item in message.cc_addresses)
    seen: set[str] = {ADMIN_EMAIL}

    def unique(values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            normalized = value.strip().casefold()
            if not normalized or normalized in seen:
                continue
            normalized = _validated_recipient(normalized)
            seen.add(normalized)
            result.append(normalized)
        return result

    return unique(to), unique(cc)


def reply_references(message: MailboxMessage) -> list[str]:
    values = [*_parse_references(" ".join(message.references)), message.message_id]
    result: list[str] = []
    for value in values:
        normalized = _normalize_message_id(value)
        if normalized and normalized not in result:
            result.append(normalized)
    return result[-50:]


def prefixed_subject(subject: str, prefix: str) -> str:
    cleaned = _validate_outbound_header(_clean_header(subject, 1_900), "主题")
    base = _SUBJECT_PREFIX_RE.sub("", cleaned).strip() or "(无主题)"
    return f"{prefix}: {base}"


def quoted_reply_bodies(message: MailboxMessage, text: str, html_body: str) -> tuple[str, str]:
    sender = _format_address_list(message.from_addresses)
    date = message.sent_at or message.received_at
    quote_header = f"\n\nOn {date.isoformat()}, {sender} wrote:\n"
    quoted_text = "\n".join(f"> {line}" for line in message.text_body.splitlines())
    final_text = f"{text.rstrip()}{quote_header}{quoted_text}"[:MAX_BODY_CHARS]
    safe_composed = sanitize_mail_html(html_body) if html_body else html.escape(text).replace("\n", "<br>")
    quoted_html = message.html_body or html.escape(message.text_body).replace("\n", "<br>")
    final_html = sanitize_mail_html(
        f"<div>{safe_composed}</div><br><div>On {html.escape(date.isoformat())}, "
        f"{html.escape(sender)} wrote:</div><blockquote>{quoted_html}</blockquote>"
    )
    return final_text, final_html


def forwarded_bodies(message: MailboxMessage, text: str, html_body: str) -> tuple[str, str]:
    sender = _format_address_list(message.from_addresses)
    recipients = _format_address_list(message.to_addresses)
    date = message.sent_at or message.received_at
    metadata = (
        "---------- Forwarded message ---------\n"
        f"From: {sender}\nDate: {date.isoformat()}\n"
        f"Subject: {message.subject}\nTo: {recipients}\n\n"
    )
    final_text = f"{text.rstrip()}\n\n{metadata}{message.text_body}"[:MAX_BODY_CHARS]
    safe_intro = sanitize_mail_html(html_body) if html_body else html.escape(text).replace("\n", "<br>")
    original_html = message.html_body or html.escape(message.text_body).replace("\n", "<br>")
    final_html = sanitize_mail_html(
        f"<div>{safe_intro}</div><br><hr><div><strong>Forwarded message</strong><br>"
        f"From: {html.escape(sender)}<br>Date: {html.escape(date.isoformat())}<br>"
        f"Subject: {html.escape(message.subject)}<br>To: {html.escape(recipients)}</div>"
        f"<br><div>{original_html}</div>"
    )
    return final_text, final_html


def load_forward_attachments(
    message: MailboxMessage,
    *,
    storage_root: Path | None = None,
) -> list[OutboundAttachment]:
    result: list[OutboundAttachment] = []
    for attachment in message.attachments:
        path = resolve_storage_file(attachment.storage_path, storage_root)
        if not path.is_file() or path.is_symlink():
            raise ValueError(f"附件文件不存在: {attachment.filename}")
        result.append(
            OutboundAttachment(
                filename=attachment.filename,
                content_type=attachment.content_type,
                payload=path.read_bytes(),
            )
        )
    return result


def build_outbound_message(
    *,
    to: list[str],
    cc: list[str],
    subject: str,
    text_body: str,
    html_body: str,
    message_id: str,
    in_reply_to: str | None,
    references: list[str],
    attachments: list[OutboundAttachment],
) -> EmailMessage:
    if not to:
        raise ValueError("没有可用收件人")
    validated_to = [_validated_recipient(item) for item in to]
    validated_cc = [_validated_recipient(item) for item in cc]
    outbound = EmailMessage(policy=policy.SMTP)
    outbound["From"] = f"{ADMIN_NAME} <{ADMIN_EMAIL}>"
    outbound["To"] = ", ".join(validated_to)
    if validated_cc:
        outbound["Cc"] = ", ".join(validated_cc)
    outbound["Subject"] = _validate_outbound_header(subject, "主题")
    outbound["Date"] = format_datetime(datetime.now(UTC))
    outbound["Message-ID"] = _validate_outbound_header(message_id, "Message-ID")
    if in_reply_to:
        outbound["In-Reply-To"] = _validate_outbound_header(in_reply_to, "In-Reply-To")
    if references:
        selected_references: list[str] = []
        current_length = 0
        for value in reversed(references):
            checked = _validate_outbound_header(value, "References")
            added_length = len(checked) + (1 if selected_references else 0)
            if current_length + added_length > MAX_HEADER_VALUE:
                break
            selected_references.insert(0, checked)
            current_length += added_length
        if selected_references:
            outbound["References"] = " ".join(selected_references)
    outbound.set_content(text_body or " ")
    outbound.add_alternative(sanitize_mail_html(html_body), subtype="html")
    for attachment in attachments:
        content_type = attachment.content_type.split(";", 1)[0].strip().casefold()
        maintype, separator, subtype = content_type.partition("/")
        if not separator:
            maintype, subtype = "application", "octet-stream"
        outbound.add_attachment(
            attachment.payload,
            maintype=maintype,
            subtype=subtype,
            filename=safe_attachment_name(attachment.filename),
        )
    return outbound


async def send_mailbox_message(
    db: AsyncSession,
    *,
    to: list[str],
    cc: list[str],
    subject: str,
    text_body: str,
    html_body: str,
    thread_id: str,
    in_reply_to: str | None = None,
    references: list[str] | None = None,
    attachments: list[OutboundAttachment] | None = None,
    storage_root: Path | None = None,
) -> tuple[MailboxMessage, bool]:
    root = _ensure_storage_root(storage_root or mailbox_storage_root())
    generated_message_id = make_msgid(domain="nyy.app").casefold()
    outbound = build_outbound_message(
        to=to,
        cc=cc,
        subject=subject,
        text_body=text_body,
        html_body=html_body,
        message_id=generated_message_id,
        in_reply_to=in_reply_to,
        references=references or [],
        attachments=attachments or [],
    )
    raw = outbound.as_bytes(policy=policy.SMTP)
    if len(raw) > MAX_MESSAGE_BYTES:
        raise MessageTooLargeError("发件超过 25MB")
    raw_sha256 = hashlib.sha256(raw).hexdigest()
    raw_path = _store_raw(root, raw_sha256, raw)
    parsed = parse_mailbox_message(raw, received_at=datetime.now(UTC))
    message = _message_from_parsed(
        parsed,
        raw_sha256=raw_sha256,
        raw_path=raw_path,
        raw_size=len(raw),
        direction="outbound",
        delivery_status="failed",
        thread_id=thread_id,
    )
    db.add(message)
    db.add_all(_store_attachments(root, message.id, parsed.attachments))
    await db.flush()
    sent = await send_message(outbound)
    message.delivery_status = "sent" if sent else "failed"
    return message, sent
