"""工作台 API 回归测试。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.main import create_app
from app.models.share import DownloadLog, Share, ShareFile, ShareLogicalFile
from app.models.system import FileRequest, FileRequestFile
from app.models.user import User
from app.services.auth import create_access_token
from app.utils.security import hash_secret


@pytest.fixture
def redis():
    return fakeredis.aioredis.FakeRedis(decode_responses=True)


@pytest.fixture
def app(redis):
    application = create_app()
    application.state.redis = redis
    return application


@pytest.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def create_user(email_prefix: str) -> tuple[User, dict[str, str]]:
    from app.db.session import get_session_factory

    email = f"{email_prefix}-{uuid.uuid4().hex}@example.com"
    factory = get_session_factory()
    async with factory() as db:
        user = User(email=email, password_hash="hash", email_verified_at=datetime.now(UTC))
        db.add(user)
        await db.commit()
        await db.refresh(user)
        token = create_access_token(str(user.id), user.email)
        return user, {"Authorization": f"Bearer {token}"}


async def create_share_for_user(
    user: User,
    *,
    code_prefix: str = "sh",
    file_name: str = "report.txt",
    password_hash: str | None = None,
    max_downloads: int = 0,
    download_count: int = 0,
    expires_at: datetime | None = None,
    revoked_at: datetime | None = None,
    with_log: bool = False,
) -> str:
    from app.db.session import get_session_factory

    code = f"{code_prefix}{uuid.uuid4().hex[:8]}"
    factory = get_session_factory()
    async with factory() as db:
        share = Share(
            code=code,
            owner_id=user.id,
            password_hash=password_hash,
            max_downloads=max_downloads,
            download_count=download_count,
            expires_at=expires_at,
            revoked_at=revoked_at,
            total_bytes=1234,
            empty_dirs=["empty/"] if file_name == "folder/readme.txt" else [],
        )
        logical = ShareLogicalFile(
            share=share,
            sort_index=0,
            original_name=file_name,
            size=1234,
            content_type="text/plain",
            chunk_total=1,
        )
        db.add(ShareFile(
            share=share,
            logical_file=logical,
            original_name=file_name,
            size=1234,
            content_type="text/plain",
            tos_uri=f"tos-cn-i-test/{code}.txt",
            chunk_index=0,
            chunk_total=1,
        ))
        db.add(share)
        await db.flush()
        if with_log:
            db.add(DownloadLog(
                share_id=share.id,
                ip="127.0.0.1",
                ua="pytest",
                downloaded_at=datetime.now(UTC),
            ))
        await db.commit()
    return code


async def create_file_request_for_user(
    user: User,
    *,
    code_prefix: str = "rq",
    title: str = "收件测试",
    file_name: str | None = "design.pdf",
    file_names: list[str] | None = None,
    password_hash: str | None = None,
    expires_at: datetime | None = None,
    max_files: int = 5,
    max_bytes: int = 10_000,
    revoked_at: datetime | None = None,
) -> str:
    from app.db.session import get_session_factory

    code = f"{code_prefix}{uuid.uuid4().hex[:8]}"
    factory = get_session_factory()
    async with factory() as db:
        req = FileRequest(
            code=code,
            owner_id=user.id,
            title=title,
            password_hash=password_hash,
            expires_at=expires_at or datetime.now(UTC) + timedelta(hours=1),
            max_files=max_files,
            max_bytes=max_bytes,
            revoked_at=revoked_at,
        )
        db.add(req)
        await db.flush()
        names = file_names if file_names is not None else ([file_name] if file_name else [])
        for name in names:
            db.add(FileRequestFile(
                request_id=req.id,
                original_name=name,
                size=2048,
                content_type="application/octet-stream",
                tos_uri=f"tos-cn-i-test/{code}.bin",
                uploader_ip="127.0.0.1",
            ))
        await db.commit()
    return code


@pytest.mark.asyncio
async def test_my_shares_requires_auth(client):
    resp = await client.get("/api/v1/my/shares")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_my_shares_lists_only_owner_and_supports_filters(client):
    owner, headers = await create_user("shares-owner")
    other, _ = await create_user("shares-other")
    active_code = await create_share_for_user(owner, code_prefix="a", file_name="alpha.txt", with_log=True)
    await create_share_for_user(owner, code_prefix="b", file_name="beta.txt", revoked_at=datetime.now(UTC))
    await create_share_for_user(other, code_prefix="o", file_name="alpha.txt")

    resp = await client.get("/api/v1/my/shares", headers=headers, params={"q": "alpha", "status": "active"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    item = body["shares"][0]
    assert item["code"] == active_code
    assert item["preview_files"] == ["alpha.txt"]
    assert item["file_count"] == 1
    assert item["empty_dir_count"] == 0
    assert item["last_downloaded_at"] is not None


@pytest.mark.asyncio
async def test_edit_share_updates_limits_and_can_clear_password(client):
    owner, headers = await create_user("edit-owner")
    code = await create_share_for_user(owner, code_prefix="ed", password_hash=hash_secret("1234"), max_downloads=10)

    resp = await client.patch(
        f"/api/v1/my/shares/{code}",
        headers=headers,
        json={"password": "", "expires_hours": 0, "max_downloads": 200},
    )
    assert resp.status_code == 200

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(select(Share).where(Share.code == code))
        assert share is not None
        assert share.password_hash is None
        assert share.expires_at is None
        assert share.max_downloads == 200

    invalid = await client.patch(
        f"/api/v1/my/shares/{code}",
        headers=headers,
        json={"max_downloads": 5},
    )
    assert invalid.status_code == 400


@pytest.mark.asyncio
async def test_my_inbox_groups_only_owner_and_searches_files(client):
    owner, headers = await create_user("inbox-owner")
    other, _ = await create_user("inbox-other")
    code = await create_file_request_for_user(owner, title="设计交付", file_name="final-design.pdf")
    await create_file_request_for_user(owner, title="其它收件", file_name="notes.txt")
    await create_file_request_for_user(other, title="设计交付", file_name="final-design.pdf")

    resp = await client.get("/api/v1/file-requests/my/inbox", headers=headers, params={"q": "final-design"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    group = body["groups"][0]
    assert group["code"] == code
    assert group["title"] == "设计交付"
    assert group["file_count"] == 1
    assert group["total_bytes"] == 2048
    assert group["files"][0]["file_name"] == "final-design.pdf"


@pytest.mark.asyncio
async def test_my_inbox_status_filters_and_file_download_permission(client):
    owner, headers = await create_user("inbox-status-owner")
    _other, other_headers = await create_user("inbox-status-other")
    expired_code = await create_file_request_for_user(
        owner,
        title="过期收件",
        file_name="expired.txt",
        expires_at=datetime.now(UTC) - timedelta(hours=1),
    )
    await create_file_request_for_user(owner, title="有效收件", file_name="active.txt")

    resp = await client.get("/api/v1/file-requests/my/inbox", headers=headers, params={"status": "expired"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["groups"][0]["code"] == expired_code

    file_id = body["groups"][0]["files"][0]["id"]
    denied = await client.get(f"/api/v1/file-requests/my/files/{file_id}/download", headers=other_headers)
    assert denied.status_code == 404

    with patch("app.api.v1.file_requests.get_doubao_download_url", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = "https://download.test/inbox-file"
        allowed = await client.get(f"/api/v1/file-requests/my/files/{file_id}/download", headers=headers)

    assert allowed.status_code == 200
    assert allowed.json()["download_url"] == "https://download.test/inbox-file"


@pytest.mark.asyncio
async def test_edit_file_request_updates_active_link_and_rejects_invalid_limits(client):
    owner, headers = await create_user("request-edit-owner")
    code = await create_file_request_for_user(
        owner,
        title="旧标题",
        file_names=["a.txt", "b.txt"],
        password_hash=hash_secret("1234"),
        max_files=5,
        max_bytes=10_000,
    )

    too_few_files = await client.patch(
        f"/api/v1/file-requests/my/{code}",
        headers=headers,
        json={"max_files": 1},
    )
    assert too_few_files.status_code == 400

    too_small_bytes = await client.patch(
        f"/api/v1/file-requests/my/{code}",
        headers=headers,
        json={"max_bytes": 2047},
    )
    assert too_small_bytes.status_code == 400

    resp = await client.patch(
        f"/api/v1/file-requests/my/{code}",
        headers=headers,
        json={"title": "新标题", "password": "", "extend_hours": 24, "max_files": 2, "max_bytes": 4096},
    )
    assert resp.status_code == 200

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        req = await db.scalar(select(FileRequest).where(FileRequest.code == code))
        assert req is not None
        assert req.title == "新标题"
        assert req.password_hash is None
        assert req.max_files == 2
        assert req.max_bytes == 4096
        assert req.expires_at is not None
        assert req.expires_at > datetime.now(UTC)


@pytest.mark.asyncio
async def test_edit_file_request_does_not_restore_expired_link(client):
    owner, headers = await create_user("request-expired-owner")
    code = await create_file_request_for_user(
        owner,
        title="过期收件",
        expires_at=datetime.now(UTC) - timedelta(hours=1),
    )

    resp = await client.patch(
        f"/api/v1/file-requests/my/{code}",
        headers=headers,
        json={"extend_hours": 24},
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_revoke_file_request_soft_deletes_received_files(client):
    owner, headers = await create_user("request-revoke-owner")
    code = await create_file_request_for_user(owner, title="待撤销", file_name="remove-me.txt")

    before = await client.get("/api/v1/file-requests/my/inbox", headers=headers, params={"q": "remove-me"})
    assert before.status_code == 200
    file_id = before.json()["groups"][0]["files"][0]["id"]

    resp = await client.delete(f"/api/v1/file-requests/my/{code}", headers=headers)
    assert resp.status_code == 200

    from app.db.session import get_session_factory
    factory = get_session_factory()
    async with factory() as db:
        req = await db.scalar(select(FileRequest).where(FileRequest.code == code))
        file = await db.scalar(select(FileRequestFile).where(FileRequestFile.id == file_id))
        assert req is not None
        assert req.revoked_at is not None
        assert file is not None
        assert file.deleted_at is not None

    download = await client.get(f"/api/v1/file-requests/my/files/{file_id}/download", headers=headers)
    assert download.status_code == 404

    revoked = await client.get("/api/v1/file-requests/my/inbox", headers=headers, params={"status": "revoked"})
    assert revoked.status_code == 200
    group = revoked.json()["groups"][0]
    assert group["code"] == code
    assert group["file_count"] == 0
    assert group["files"] == []
