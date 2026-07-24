"""管理员本机邮件工作台的导入、安全与 API 回归测试。"""

from __future__ import annotations

from datetime import UTC, datetime
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from fastapi import HTTPException, Request
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

import app.db.session as db_session
from app.api.v1.admin.mailbox import router as mailbox_router
from app.core.deps import get_current_admin_user
from app.db.base import Base
from app.db.session import get_session_factory
from app.main import create_app
from app.models.auth import AuthEvent, AuthSession
from app.models.mailbox import (
    MailboxAttachment as MailboxAttachmentModel,
)
from app.models.mailbox import (
    MailboxImportSource,
    MailboxImportTombstone,
    MailboxMessage,
)
from app.models.system import AuditLog
from app.models.user import User
from app.services.auth import hash_password
from app.services.mailbox import (
    MAX_MESSAGE_BYTES,
    build_outbound_message,
    import_maildir,
    parse_mailbox_message,
    resolve_storage_file,
    sanitize_mail_html,
)
from scripts.import_admin_mailbox import exclusive_import_lock


@pytest.fixture(autouse=True)
async def _reset_db_engine_singletons():
    """仅创建本模块依赖表，隔离工作树中其他未完成模型。"""

    tables = [
        User.__table__,
        AuthSession.__table__,
        AuthEvent.__table__,
        AuditLog.__table__,
        MailboxMessage.__table__,
        MailboxAttachmentModel.__table__,
        MailboxImportSource.__table__,
        MailboxImportTombstone.__table__,
    ]
    engine = db_session.get_engine()
    async with engine.begin() as connection:
        await connection.run_sync(lambda sync_connection: Base.metadata.create_all(sync_connection, tables=tables))
        table_names = ", ".join(f'"{table.name}"' for table in tables)
        await connection.exec_driver_sql(f"TRUNCATE TABLE {table_names} RESTART IDENTITY CASCADE")
    yield
    if db_session._engine is not None:
        await db_session._engine.dispose()
    db_session._engine = None
    db_session._session_factory = None


def build_raw_message(*, message_id: str = "<mailbox-1@example.com>") -> bytes:
    message = EmailMessage()
    message["From"] = "Sender <sender@example.com>"
    message["To"] = "admin@nyy.app"
    message["Reply-To"] = "reply@example.com"
    message["Subject"] = "Mailbox test"
    message["Date"] = "Tue, 21 Jul 2026 12:00:00 +0000"
    message["Message-ID"] = message_id
    message.set_content("plain body")
    message.add_alternative(
        '<p>safe</p><script>alert(1)</script><img src="https://track.example/p.gif">',
        subtype="html",
    )
    message.add_attachment(
        b"attachment-content",
        maintype="application",
        subtype="octet-stream",
        filename="../../private.txt",
    )
    return message.as_bytes()


def make_maildir(root: Path) -> Path:
    (root / "new").mkdir(parents=True)
    (root / "cur").mkdir()
    return root


async def import_test_message(maildir: Path, storage: Path) -> MailboxMessage:
    (maildir / "new" / "mailbox-key-1").write_bytes(build_raw_message())
    factory = get_session_factory()
    async with factory() as db:
        result = await import_maildir(db, maildir, storage_root=storage)
        assert result.imported == 1
        return await db.scalar(
            select(MailboxMessage).options(selectinload(MailboxMessage.attachments))
        )


@pytest.fixture
def app():
    application = create_app()
    application.state.redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    application.include_router(mailbox_router, prefix="/api/v1/admin")
    return application


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client


@pytest.fixture
async def admin_headers(app):
    factory = get_session_factory()
    async with factory() as db:
        admin = User(
            email="admin@nyy.app",
            password_hash=hash_password("88888888"),
            is_admin=True,
            email_verified_at=datetime.now(UTC),
        )
        db.add(admin)
        await db.commit()

    async def current_admin(request: Request) -> User:
        if request.headers.get("x-test-admin") != "1":
            raise HTTPException(401, "未登录")
        return admin

    app.dependency_overrides[get_current_admin_user] = current_admin
    return {"X-Test-Admin": "1"}


def test_mime_parser_sanitizes_html_and_attachment_names():
    parsed = parse_mailbox_message(build_raw_message())

    assert parsed.message_id == "<mailbox-1@example.com>"
    assert parsed.from_addresses == [{"name": "Sender", "address": "sender@example.com"}]
    assert parsed.reply_to_addresses[0]["address"] == "reply@example.com"
    assert "<script" not in parsed.html_body
    assert "<img" not in parsed.html_body
    assert "https://track.example" not in parsed.html_body
    assert parsed.attachments[0].filename == "private.txt"
    assert sanitize_mail_html('<style>x</style><form><input></form><p>ok</p>').endswith("<p>ok</p>")

    with pytest.raises(ValueError, match="收件"):
        build_outbound_message(
            to=["victim@example.com\r\nBcc: attacker@example.com"],
            cc=[],
            subject="safe",
            text_body="safe",
            html_body="<p>safe</p>",
            message_id="<safe@nyy.app>",
            in_reply_to=None,
            references=[],
            attachments=[],
        )


@pytest.mark.asyncio
async def test_maildir_import_is_incremental_idempotent_and_retains_raw(tmp_path):
    maildir = make_maildir(tmp_path / "maildir")
    storage = tmp_path / "storage"
    raw = build_raw_message()
    (maildir / "new" / "first-key").write_bytes(raw)

    factory = get_session_factory()
    async with factory() as db:
        first = await import_maildir(db, maildir, storage_root=storage)
        assert first.imported == 1
        message = await db.scalar(
            select(MailboxMessage).options(selectinload(MailboxMessage.attachments))
        )
        assert message is not None
        assert resolve_storage_file(message.raw_path, storage).read_bytes() == raw
        assert message.html_body == sanitize_mail_html(message.html_body)
        assert len(message.attachments) == 1
        attachment = message.attachments[0]
        attachment_path = resolve_storage_file(attachment.storage_path, storage)
        assert attachment_path.read_bytes() == b"attachment-content"
        assert attachment_path.name == str(attachment.id)

    async with factory() as db:
        second = await import_maildir(db, maildir, storage_root=storage)
        assert second.skipped_known == 1
        assert second.imported == 0

    (maildir / "cur" / "second-key:2,SF").write_bytes(raw)
    async with factory() as db:
        third = await import_maildir(db, maildir, storage_root=storage)
        assert third.linked_duplicates == 1
        assert await db.scalar(select(func.count()).select_from(MailboxMessage)) == 1
        assert await db.scalar(select(func.count()).select_from(MailboxImportSource)) == 2
        assert await db.scalar(
            select(func.count()).select_from(AuditLog).where(
                AuditLog.action.in_(["mailbox.import", "mailbox.import_source"])
            )
        ) == 2


@pytest.mark.asyncio
async def test_import_rejects_oversized_messages_without_reading_them(tmp_path, monkeypatch):
    maildir = make_maildir(tmp_path / "maildir")
    storage = tmp_path / "storage"
    monkeypatch.setattr("app.services.mailbox.MAX_MESSAGE_BYTES", 128)
    (maildir / "new" / "too-large").write_bytes(b"x" * 129)

    factory = get_session_factory()
    async with factory() as db:
        result = await import_maildir(db, maildir, storage_root=storage)

    assert result.skipped_oversized == 1
    assert result.imported == 0
    assert MAX_MESSAGE_BYTES == 25 * 1024 * 1024


def test_storage_path_and_import_lock_reject_unsafe_or_concurrent_access(tmp_path):
    storage = tmp_path / "storage"
    with pytest.raises(ValueError):
        resolve_storage_file("../../etc/passwd", storage)
    with pytest.raises(ValueError):
        resolve_storage_file("/etc/passwd", storage)

    with exclusive_import_lock(storage) as first:
        assert first is True
        with exclusive_import_lock(storage) as second:
            assert second is False


@pytest.mark.asyncio
async def test_mailbox_api_lists_threads_updates_state_and_downloads_admin_only(
    client,
    admin_headers,
    tmp_path,
    monkeypatch,
):
    maildir = make_maildir(tmp_path / "maildir")
    storage = tmp_path / "storage"
    monkeypatch.setenv("MAILBOX_STORAGE_PATH", str(storage))
    message = await import_test_message(maildir, storage)
    assert message is not None

    unauthenticated = await client.get("/api/v1/admin/mailbox/messages")
    assert unauthenticated.status_code == 401

    listed = await client.get(
        "/api/v1/admin/mailbox/messages",
        headers=admin_headers,
        params={"folder": "inbox", "q": "Sender", "page": 1, "page_size": 10},
    )
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["items"][0]["attachment_count"] == 1

    thread = await client.get(
        f"/api/v1/admin/mailbox/threads/{message.thread_id}",
        headers=admin_headers,
    )
    assert thread.status_code == 200
    assert thread.json()["messages"][0]["html_body"].find("<script") == -1

    changed = await client.patch(
        f"/api/v1/admin/mailbox/messages/{message.id}/state",
        headers=admin_headers,
        json={"is_read": True, "is_trashed": True},
    )
    assert changed.status_code == 200
    assert changed.json()["is_read"] is True
    assert changed.json()["is_trashed"] is True
    assert changed.json()["is_archived"] is False

    trash = await client.get(
        "/api/v1/admin/mailbox/messages",
        headers=admin_headers,
        params={"folder": "trash"},
    )
    assert trash.json()["total"] == 1

    attachment_id = thread.json()["messages"][0]["attachments"][0]["id"]
    raw_path = resolve_storage_file(message.raw_path, storage)
    attachment_path = resolve_storage_file(message.attachments[0].storage_path, storage)
    downloaded = await client.get(
        f"/api/v1/admin/mailbox/messages/{message.id}/attachments/{attachment_id}",
        headers=admin_headers,
    )
    assert downloaded.status_code == 200
    assert downloaded.content == b"attachment-content"
    assert "private.txt" in downloaded.headers["content-disposition"]

    no_delete = await client.delete(
        f"/api/v1/admin/mailbox/messages/{message.id}",
        headers=admin_headers,
    )
    assert no_delete.status_code in {404, 405}

    permanently_deleted = await client.delete(
        f"/api/v1/admin/mailbox/messages/{message.id}/permanent",
        headers=admin_headers,
    )
    assert permanently_deleted.status_code == 204
    assert not raw_path.exists()
    assert not attachment_path.exists()

    factory = get_session_factory()
    async with factory() as db:
        audit = await db.scalar(
            select(AuditLog).where(
                AuditLog.action == "mailbox.state_update",
                AuditLog.target_id == str(message.id),
            )
        )
        assert audit is not None
        assert audit.actor_email == "admin@nyy.app"
        assert audit.before_value["is_trashed"] is False
        assert audit.after_value["is_trashed"] is True
        assert await db.scalar(select(func.count()).select_from(MailboxMessage)) == 0
        assert await db.scalar(select(func.count()).select_from(MailboxAttachmentModel)) == 0
        assert await db.scalar(select(func.count()).select_from(MailboxImportSource)) == 0
        assert await db.scalar(select(func.count()).select_from(MailboxImportTombstone)) == 1
        delete_audit = await db.scalar(
            select(AuditLog).where(AuditLog.action == "mailbox.permanent_delete")
        )
        cleanup_audit = await db.scalar(
            select(AuditLog).where(AuditLog.action == "mailbox.permanent_delete_cleanup")
        )
        assert delete_audit is not None
        assert cleanup_audit is not None
        assert cleanup_audit.success is True

    async with get_session_factory()() as db:
        reimported = await import_maildir(db, maildir, storage_root=storage)
        await db.commit()
    assert reimported.imported == 0
    assert reimported.skipped_known == 1


@pytest.mark.asyncio
async def test_permanent_delete_keeps_record_when_storage_cleanup_fails(
    client,
    admin_headers,
    tmp_path,
    monkeypatch,
):
    maildir = make_maildir(tmp_path / "maildir")
    storage = tmp_path / "storage"
    monkeypatch.setenv("MAILBOX_STORAGE_PATH", str(storage))
    message = await import_test_message(maildir, storage)
    await client.patch(
        f"/api/v1/admin/mailbox/messages/{message.id}/state",
        headers=admin_headers,
        json={"is_trashed": True},
    )

    with patch(
        "app.api.v1.admin.mailbox.delete_mailbox_storage_files",
        return_value=[message.raw_path],
    ):
        response = await client.delete(
            f"/api/v1/admin/mailbox/messages/{message.id}/permanent",
            headers=admin_headers,
        )

    assert response.status_code == 500
    async with get_session_factory()() as db:
        assert await db.get(MailboxMessage, message.id) is not None
        assert await db.scalar(select(func.count()).select_from(MailboxImportSource)) == 1
        assert await db.scalar(select(func.count()).select_from(MailboxImportTombstone)) == 0


@pytest.mark.asyncio
async def test_reply_and_forward_use_thread_headers_postfix_and_audit(
    client,
    admin_headers,
    tmp_path,
    monkeypatch,
):
    maildir = make_maildir(tmp_path / "maildir")
    storage = tmp_path / "storage"
    monkeypatch.setenv("MAILBOX_STORAGE_PATH", str(storage))
    original = await import_test_message(maildir, storage)

    smtp = AsyncMock(return_value=True)
    with patch("app.services.mailbox.send_message", new=smtp):
        reply = await client.post(
            f"/api/v1/admin/mailbox/messages/{original.id}/reply",
            headers=admin_headers,
            json={"text": "reply text", "html": '<p>reply</p><img src="https://tracker/x">'},
        )
        forwarded = await client.post(
            f"/api/v1/admin/mailbox/messages/{original.id}/forward",
            headers=admin_headers,
            json={"to": ["forward@example.com"], "text": "FYI"},
        )

    assert reply.status_code == 200
    assert forwarded.status_code == 200
    assert smtp.await_count == 2
    reply_message = smtp.await_args_list[0].args[0]
    forward_message = smtp.await_args_list[1].args[0]
    assert reply_message["From"].addresses[0].addr_spec == "admin@nyy.app"
    assert reply_message["To"].addresses[0].addr_spec == "reply@example.com"
    assert reply_message["Message-ID"].endswith("@nyy.app>")
    assert reply_message["In-Reply-To"] == "<mailbox-1@example.com>"
    assert "<mailbox-1@example.com>" in str(reply_message["References"])
    assert forward_message["In-Reply-To"] is None
    assert "<mailbox-1@example.com>" in str(forward_message["References"])
    assert len(list(forward_message.iter_attachments())) == 1
    assert "https://tracker" not in reply.json()["message"]["html_body"]

    factory = get_session_factory()
    async with factory() as db:
        outbound = list(
            (
                await db.scalars(
                    select(MailboxMessage).where(MailboxMessage.direction == "outbound")
                )
            ).all()
        )
        assert len(outbound) == 2
        assert all(item.delivery_status == "sent" for item in outbound)
        assert all(item.thread_id == original.thread_id for item in outbound)
        actions = set(
            (
                await db.scalars(
                    select(AuditLog.action).where(
                        AuditLog.action.in_(["mailbox.reply", "mailbox.forward"])
                    )
                )
            ).all()
        )
        assert actions == {"mailbox.reply", "mailbox.forward"}


@pytest.mark.asyncio
async def test_failed_postfix_attempt_is_retained_and_audited(
    client,
    admin_headers,
    tmp_path,
    monkeypatch,
):
    maildir = make_maildir(tmp_path / "maildir")
    storage = tmp_path / "storage"
    monkeypatch.setenv("MAILBOX_STORAGE_PATH", str(storage))
    original = await import_test_message(maildir, storage)

    with patch("app.services.mailbox.send_message", new=AsyncMock(return_value=False)):
        response = await client.post(
            f"/api/v1/admin/mailbox/messages/{original.id}/reply",
            headers=admin_headers,
            json={"text": "will fail"},
        )
    assert response.status_code == 502

    factory = get_session_factory()
    async with factory() as db:
        failed = await db.scalar(
            select(MailboxMessage).where(MailboxMessage.delivery_status == "failed")
        )
        assert failed is not None
        assert resolve_storage_file(failed.raw_path, storage).is_file()
        audit = await db.scalar(
            select(AuditLog).where(
                AuditLog.action == "mailbox.reply",
                AuditLog.success.is_(False),
            )
        )
        assert audit is not None
