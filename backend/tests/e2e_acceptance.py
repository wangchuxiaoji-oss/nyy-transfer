"""完整验收 E2E：真实上传到豆包 TOS，并覆盖核心 API/管理后台。

运行前需要本地前后端、Postgres、Redis 均已启动：
  uv run --with-requirements requirements.txt python tests/e2e_acceptance.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import zlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

API = os.getenv("NYY_API", "http://127.0.0.1:8000")
FRONTEND = os.getenv("NYY_FRONTEND", "http://127.0.0.1:3000")
TEST_EMAIL = os.getenv("NYY_TEST_EMAIL", "test@nyy.app")
TEST_PASSWORD = os.getenv("NYY_TEST_PASSWORD", "123456")
ADMIN_EMAIL = os.getenv("NYY_ADMIN_EMAIL", "admin@nyy.app")
ADMIN_PASSWORD = os.getenv("NYY_ADMIN_PASSWORD", "Admin@nyy2026!")


class SuiteState:
    def __init__(self) -> None:
        self.share_codes: list[str] = []
        self.file_request_codes: list[str] = []
        self.test_user_id = ""
        self.admin_headers: dict[str, str] = {}
        self.user_headers: dict[str, str] = {}
        self.original_quota_config: dict[str, int] | None = None
        self.quota_config_existed = False
        self.redis_snapshots: dict[str, tuple[str | None, int]] = {}
        self.created_guest_share = ""


def crc32_hex(data: bytes) -> str:
    return f"{zlib.crc32(data) & 0xFFFFFFFF:08x}"


def file_ext(name: str) -> str:
    tail = name.rsplit(".", 1)
    return tail[1] if len(tail) == 2 else ""


def expect(response: httpx.Response, status: int | range, label: str) -> None:
    ok = response.status_code in status if isinstance(status, range) else response.status_code == status
    assert ok, f"{label} failed: {response.status_code} {response.text[:500]}"


async def login(client: httpx.AsyncClient, email: str, password: str) -> tuple[dict[str, str], dict[str, Any]]:
    response = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    expect(response, 200, f"login {email}")
    token = response.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    me = await client.get("/api/v1/auth/me", headers=headers)
    expect(me, 200, f"me {email}")
    return headers, me.json()


async def upload_to_tos(init: dict[str, Any], data: bytes, external: httpx.AsyncClient) -> None:
    response = await external.post(
        init["upload_url"],
        content=data,
        headers={"Authorization": init["authorization"], "Content-CRC32": crc32_hex(data)},
    )
    expect(response, range(200, 300), "TOS upload")


async def init_and_upload(
    client: httpx.AsyncClient,
    external: httpx.AsyncClient,
    name: str,
    data: bytes,
    *,
    headers: dict[str, str] | None = None,
    request_code: str = "",
    request_password: str = "",
) -> dict[str, str]:
    response = await client.post(
        "/api/v1/uploads/init",
        headers=headers,
        json={
            "file_name": name,
            "file_size": len(data),
            "file_ext": file_ext(name),
            "request_code": request_code,
            "request_password": request_password,
        },
    )
    expect(response, 200, f"init {name}")
    init = response.json()
    await upload_to_tos(init, data, external)
    return {"commit_token": init["commit_token"], "store_uri": init["store_uri"]}


async def create_share(
    client: httpx.AsyncClient,
    external: httpx.AsyncClient,
    state: SuiteState,
    files: dict[str, bytes],
    *,
    headers: dict[str, str] | None = None,
    password: str = "",
    expires_hours: int = 0,
    max_downloads: int = 0,
    recipients: list[str] | None = None,
) -> str:
    commit_files = []
    for name, data in files.items():
        commit_files.append(await init_and_upload(client, external, name, data, headers=headers))

    response = await client.post(
        "/api/v1/uploads/commit",
        headers=headers,
        json={
            "files": commit_files,
            "password": password,
            "expires_hours": expires_hours,
            "max_downloads": max_downloads,
            "recipients": recipients or [],
        },
    )
    expect(response, 201, "commit share")
    code = response.json()["share_code"]
    state.share_codes.append(code)
    return code


async def verify_share_download(
    client: httpx.AsyncClient,
    external: httpx.AsyncClient,
    code: str,
    expected_files: dict[str, bytes],
    *,
    password: str = "",
) -> None:
    info = await client.get(f"/api/v1/shares/{code}")
    expect(info, 200, f"share info {code}")
    body = info.json()
    assert body["code"] == code
    assert body["total_bytes"] == sum(len(data) for data in expected_files.values())
    assert sorted(file["file_name"] for file in body["files"]) == sorted(expected_files)

    if password:
        wrong = await client.post(f"/api/v1/shares/{code}/verify", json={"password": "0000"})
        expect(wrong, 403, "wrong password")
        download_response = await client.post(f"/api/v1/shares/{code}/verify", json={"password": password})
    else:
        download_response = await client.get(f"/api/v1/shares/{code}/download")
    expect(download_response, 200, f"download urls {code}")

    downloads = download_response.json()["files"]
    assert sorted(file["file_name"] for file in downloads) == sorted(expected_files)
    for file in downloads:
        response = await external.get(file["download_url"])
        expect(response, 200, f"download file {file['file_name']}")
        assert response.content == expected_files[file["file_name"]], file["file_name"]


async def snapshot_redis_key(state: SuiteState, redis, key: str) -> None:
    value = await redis.get(key)
    ttl = await redis.ttl(key)
    state.redis_snapshots[key] = (value, ttl)


async def restore_redis(redis, state: SuiteState) -> None:
    for key, (value, ttl) in state.redis_snapshots.items():
        if value is None:
            await redis.delete(key)
        elif ttl and ttl > 0:
            await redis.setex(key, ttl, value)
        else:
            await redis.set(key, value)


async def cleanup_database(state: SuiteState) -> None:
    from sqlalchemy import delete, or_, select

    from app.db.session import get_session_factory
    from app.models.share import Share
    from app.models.system import AppConfig, EmailDelivery, FileRequest, FileRequestFile, Report
    from app.services.app_config import QUOTA_CONFIG_KEY

    factory = get_session_factory()
    async with factory() as db:
        if state.share_codes:
            share_rows = await db.execute(select(Share.id).where(Share.code.in_(state.share_codes)))
            share_ids = [row[0] for row in share_rows.all()]
            if share_ids:
                await db.execute(delete(Report).where(Report.share_id.in_(share_ids)))
                await db.execute(delete(EmailDelivery).where(EmailDelivery.share_id.in_(share_ids)))
                await db.execute(delete(Share).where(Share.id.in_(share_ids)))

        request_filter = FileRequest.title == "E2E 收文件"
        if state.file_request_codes:
            request_filter = or_(FileRequest.code.in_(state.file_request_codes), request_filter)
        request_rows = await db.execute(select(FileRequest.id).where(request_filter))
        request_ids = [row[0] for row in request_rows.all()]
        if request_ids:
            await db.execute(delete(FileRequestFile).where(FileRequestFile.request_id.in_(request_ids)))
        await db.execute(delete(FileRequest).where(request_filter))

        if state.original_quota_config is not None:
            if state.quota_config_existed:
                row = await db.scalar(select(AppConfig).where(AppConfig.key == QUOTA_CONFIG_KEY))
                if row:
                    row.value = state.original_quota_config
            else:
                await db.execute(delete(AppConfig).where(AppConfig.key == QUOTA_CONFIG_KEY))

        await db.commit()


async def config_row_exists() -> bool:
    from sqlalchemy import select

    from app.db.session import get_session_factory
    from app.models.system import AppConfig
    from app.services.app_config import QUOTA_CONFIG_KEY

    async with get_session_factory()() as db:
        return await db.scalar(select(AppConfig).where(AppConfig.key == QUOTA_CONFIG_KEY)) is not None


async def ensure_guest_active_share(
    client: httpx.AsyncClient,
    external: httpx.AsyncClient,
    state: SuiteState,
) -> None:
    from sqlalchemy import cast, func, or_, select
    from sqlalchemy.dialects.postgresql import INET

    from app.db.session import get_session_factory
    from app.models.share import Share

    now = datetime.now(timezone.utc)
    async with get_session_factory()() as db:
        active_count = await db.scalar(
            select(func.count()).select_from(Share).where(
                Share.ip_created_from == cast("127.0.0.1", INET),
                Share.revoked_at.is_(None),
                Share.banned_at.is_(None),
                or_(Share.expires_at.is_(None), Share.expires_at > now),
                or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
            )
        ) or 0

    if active_count == 0:
        code = await create_share(client, external, state, {"e2e-guest-active.txt": b"guest active"})
        state.created_guest_share = code


async def run_suite() -> None:
    state = SuiteState()
    redis = None
    async with httpx.AsyncClient(base_url=API, timeout=60) as client, httpx.AsyncClient(
        timeout=60,
        follow_redirects=True,
    ) as external:
        try:
            import redis.asyncio as redis_async

            redis = redis_async.from_url("redis://127.0.0.1:6379/0", decode_responses=True)

            print("[0] 登录测试账号和管理员")
            state.user_headers, user = await login(client, TEST_EMAIL, TEST_PASSWORD)
            state.admin_headers, admin = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
            assert user["email"] == TEST_EMAIL
            assert admin["plan"] == "admin"
            state.test_user_id = user["id"]
            await snapshot_redis_key(state, redis, f"nyy:quota:user:{state.test_user_id}:bytes")
            await snapshot_redis_key(state, redis, "nyy:quota:ip:127.0.0.1:bytes")

            print("[1] Admin 配额读取、更新、列表接口")
            state.quota_config_existed = await config_row_exists()
            quota_response = await client.get("/api/v1/admin/config/quota", headers=state.admin_headers)
            expect(quota_response, 200, "admin quota get")
            state.original_quota_config = quota_response.json()
            test_quota = dict(state.original_quota_config)
            test_quota["user_max_active_shares"] = max(test_quota["user_max_active_shares"], 100)
            update_response = await client.put(
                "/api/v1/admin/config/quota",
                headers=state.admin_headers,
                json=test_quota,
            )
            expect(update_response, 200, "admin quota update")
            for path in ("stats", "users?page_size=100", "shares?page_size=100", "reports", "emails"):
                response = await client.get(f"/api/v1/admin/{path}", headers=state.admin_headers)
                expect(response, 200, f"admin {path}")

            print("[2] 游客活跃分享限制：init 阶段返回中文 429")
            await ensure_guest_active_share(client, external, state)
            guest_block = await client.post(
                "/api/v1/uploads/init",
                json={"file_name": "e2e-blocked.txt", "file_size": 12, "file_ext": "txt"},
            )
            expect(guest_block, 429, "guest active share limit")
            assert "活跃分享数量已达上限" in guest_block.json()["detail"]

            print("[3] 单文件上传、分享详情、下载内容校验")
            single_files = {"e2e-single.txt": b"single file payload\n"}
            single_code = await create_share(client, external, state, single_files, headers=state.user_headers)
            await verify_share_download(client, external, single_code, single_files)

            print("[4] 我的分享列表、编辑、撤销接口")
            my_list = await client.get("/api/v1/my/shares", headers=state.user_headers)
            expect(my_list, 200, "my shares list")
            assert any(item["code"] == single_code for item in my_list.json()["shares"])
            edit_response = await client.patch(
                f"/api/v1/my/shares/{single_code}",
                headers=state.user_headers,
                json={"password": "2468", "expires_hours": 2},
            )
            expect(edit_response, 200, "my share edit")
            await verify_share_download(client, external, single_code, single_files, password="2468")

            print("[5] 多文件上传、提取码下载、下载内容校验")
            multi_files = {
                "e2e-photo.jpg": b"JPEG-DATA" * 64,
                "e2e-doc.pdf": b"PDF-DATA" * 48,
            }
            multi_code = await create_share(
                client,
                external,
                state,
                multi_files,
                headers=state.user_headers,
                password="6789",
                expires_hours=24,
            )
            await verify_share_download(client, external, multi_code, multi_files, password="6789")

            print("[6] 文件夹上传：保留相对路径并逐个下载校验")
            folder_files = {
                "e2e-folder/readme.txt": b"folder readme",
                "e2e-folder/nested/data.json": b'{"ok":true,"source":"folder"}',
            }
            folder_code = await create_share(client, external, state, folder_files, headers=state.user_headers)
            await verify_share_download(client, external, folder_code, folder_files)

            print("[7] 邮件记录和举报队列")
            email_code = await create_share(
                client,
                external,
                state,
                {"e2e-email.txt": b"email share"},
                headers=state.user_headers,
                recipients=["receiver@example.com"],
            )
            emails = await client.get("/api/v1/admin/emails", headers=state.admin_headers)
            expect(emails, 200, "admin emails")
            assert any(item["share_code"] == email_code for item in emails.json()["emails"])
            report = await client.post(
                f"/api/v1/shares/{email_code}/report",
                json={"reason": "e2e-test", "detail": "acceptance test"},
            )
            expect(report, 200, "report share")
            reports = await client.get("/api/v1/admin/reports", headers=state.admin_headers)
            expect(reports, 200, "admin reports")
            assert any(item["share_code"] == email_code for item in reports.json()["reports"])

            print("[8] Admin 封禁/解封分享")
            ban = await client.post(
                f"/api/v1/admin/shares/{email_code}/ban",
                headers=state.admin_headers,
                json={"reason": "e2e ban"},
            )
            expect(ban, 200, "admin ban")
            banned_info = await client.get(f"/api/v1/shares/{email_code}")
            expect(banned_info, 404, "banned share hidden")
            unban = await client.delete(f"/api/v1/admin/shares/{email_code}/ban", headers=state.admin_headers)
            expect(unban, 200, "admin unban")
            unbanned_info = await client.get(f"/api/v1/shares/{email_code}")
            expect(unbanned_info, 200, "unbanned share visible")

            print("[9] 收文件：创建、访问码、访客上传、我的收到文件下载")
            create_request = await client.post(
                "/api/v1/file-requests",
                headers=state.user_headers,
                json={
                    "title": "E2E 收文件",
                    "password": "1357",
                    "expires_hours": 24,
                    "max_files": 5,
                    "max_bytes": 1024 * 1024,
                },
            )
            expect(create_request, 200, "create file request")
            request_code = create_request.json()["code"]
            state.file_request_codes.append(request_code)
            request_info = await client.get(f"/api/v1/file-requests/{request_code}")
            expect(request_info, 200, "file request info")
            wrong_request_pw = await client.post(
                f"/api/v1/file-requests/{request_code}/verify",
                json={"password": "0000"},
            )
            expect(wrong_request_pw, 403, "wrong request password")
            ok_request_pw = await client.post(
                f"/api/v1/file-requests/{request_code}/verify",
                json={"password": "1357"},
            )
            expect(ok_request_pw, 200, "correct request password")
            request_files = {
                "e2e-request-a.txt": b"request file A",
                "e2e-request-b.txt": b"request file B",
            }
            request_commit_files = []
            for name, data in request_files.items():
                request_commit_files.append(
                    await init_and_upload(
                        client,
                        external,
                        name,
                        data,
                        request_code=request_code,
                        request_password="1357",
                    )
                )
            commit_request = await client.post(
                f"/api/v1/file-requests/{request_code}/commit",
                json={"files": request_commit_files, "password": "1357"},
            )
            expect(commit_request, 200, "commit file request")
            request_list = await client.get("/api/v1/file-requests/my/list", headers=state.user_headers)
            expect(request_list, 200, "my file request list")
            assert any(item["code"] == request_code for item in request_list.json()["requests"])
            received = await client.get("/api/v1/file-requests/my/files", headers=state.user_headers)
            expect(received, 200, "my request files")
            received_files = [item for item in received.json()["files"] if item["request_code"] == request_code]
            assert len(received_files) == 2
            for item in received_files:
                download = await client.get(
                    f"/api/v1/file-requests/my/files/{item['id']}/download",
                    headers=state.user_headers,
                )
                expect(download, 200, "request file download url")
                response = await external.get(download.json()["download_url"])
                expect(response, 200, f"download request file {item['file_name']}")
                assert response.content == request_files[item["file_name"]]

            print("[10] 前端页面路由健康检查")
            for url in ("/", f"/{multi_code}", f"/r/{request_code}", "/my", "/nyy-console"):
                response = await external.get(f"{FRONTEND}{url}")
                expect(response, 200, f"frontend {url}")

            print("[11] 撤销测试分享后确认不可访问")
            revoke = await client.delete(f"/api/v1/my/shares/{single_code}", headers=state.user_headers)
            expect(revoke, 200, "my share revoke")
            revoked_info = await client.get(f"/api/v1/shares/{single_code}")
            expect(revoked_info, 404, "revoked share hidden")

            print("\nE2E_ACCEPTANCE_PASS")
        finally:
            print("\n[cleanup] 还原配额配置、Redis 配额和测试数据")
            await cleanup_database(state)
            if redis is not None:
                await restore_redis(redis, state)
                await redis.aclose()


if __name__ == "__main__":
    asyncio.run(run_suite())
