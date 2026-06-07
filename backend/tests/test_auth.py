"""认证 API 回归测试。"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import fakeredis.aioredis
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.main import create_app
from app.models.auth import AuthEvent, AuthSession
from app.models.user import User
from app.services.auth import hash_password


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


async def get_user(email: str) -> User | None:
    from app.db.session import get_session_factory

    factory = get_session_factory()
    async with factory() as db:
        result = await db.execute(select(User).where(User.email == email))
        return result.scalar_one_or_none()


async def get_user_sessions(email: str) -> list[AuthSession]:
    from app.db.session import get_session_factory

    factory = get_session_factory()
    async with factory() as db:
        user_result = await db.execute(select(User).where(User.email == email))
        user = user_result.scalar_one_or_none()
        if not user:
            return []
        result = await db.execute(select(AuthSession).where(AuthSession.user_id == user.id))
        return list(result.scalars().all())


async def get_auth_events(*event_types: str) -> list[AuthEvent]:
    from app.db.session import get_session_factory

    factory = get_session_factory()
    async with factory() as db:
        stmt = select(AuthEvent)
        if event_types:
            stmt = stmt.where(AuthEvent.event_type.in_(event_types))
        result = await db.execute(stmt.order_by(AuthEvent.created_at))
        return list(result.scalars().all())


async def create_verified_user(email: str, password: str) -> None:
    from datetime import datetime, timezone

    from app.db.session import get_session_factory

    factory = get_session_factory()
    async with factory() as db:
        db.add(User(
            email=email,
            password_hash=hash_password(password),
            email_verified_at=datetime.now(timezone.utc),
        ))
        await db.commit()


async def create_unverified_user(email: str, password: str) -> None:
    from app.db.session import get_session_factory

    factory = get_session_factory()
    async with factory() as db:
        db.add(User(email=email, password_hash=hash_password(password)))
        await db.commit()


# ─── 验证码辅助 ─────────────────────────────────────────────────

async def get_captcha_token(client: AsyncClient, redis, purpose: str = "email_send") -> str:
    """获取有效的 captcha_token。"""
    import secrets

    from app.services.captcha import _hmac_token

    token = secrets.token_hex(32)
    token_h = _hmac_token(token)
    await redis.set(f"nyy:captcha:token:{token_h}", f"{purpose}:2026-01-01T00:00:00:::", ex=300)
    return token


async def inject_email_code(redis, email: str, code: str, purpose: str = "register") -> None:
    """直接在 Redis 里注入验证码。"""
    from app.services.email_code import _code_hash, _code_key

    key = _code_key(purpose, email)
    code_h = _code_hash(email, purpose, code)
    await redis.set(key, f"{code_h}:0:2026-01-01T00:00:00:::", ex=600)


# ─── 测试 ───────────────────────────────────────────────────────

async def test_send_code_requires_captcha(client, redis):
    """发送验证码必须携带 captcha_token。"""
    response = await client.post(
        "/api/v1/auth/send-code",
        json={"email": "test@example.com", "purpose": "register", "captcha_token": "invalid"},
    )
    assert response.status_code == 400


async def test_send_code_with_valid_captcha(client, redis):
    """有效 captcha_token 可以发送验证码。"""
    captcha_token = await get_captcha_token(client, redis)
    with patch("app.api.v1.auth.send_email_code", new=AsyncMock(return_value=True)):
        response = await client.post(
            "/api/v1/auth/send-code",
            json={
                "email": "test@example.com",
                "purpose": "register",
                "captcha_token": captcha_token,
            },
        )
    assert response.status_code == 200


async def test_captcha_token_is_single_use(client, redis):
    """captcha_token 只能使用一次。"""
    captcha_token = await get_captcha_token(client, redis)
    with patch("app.api.v1.auth.send_email_code", new=AsyncMock(return_value=True)):
        resp1 = await client.post(
            "/api/v1/auth/send-code",
            json={
                "email": "a@example.com",
                "purpose": "register",
                "captcha_token": captcha_token,
            },
        )
        assert resp1.status_code == 200

        resp2 = await client.post(
            "/api/v1/auth/send-code",
            json={
                "email": "b@example.com",
                "purpose": "register",
                "captcha_token": captcha_token,
            },
        )
        assert resp2.status_code == 400


async def test_captcha_token_wrong_purpose_is_consumed(client, redis):
    """错误 purpose 的 captcha_token 失败后也必须被消费。"""
    from app.services.captcha import _hmac_token

    captcha_token = await get_captcha_token(client, redis, purpose="login")
    token_h = _hmac_token(captcha_token)

    response = await client.post(
        "/api/v1/auth/send-code",
        json={
            "email": "wrong-purpose@example.com",
            "purpose": "register",
            "captcha_token": captcha_token,
        },
    )

    assert response.status_code == 400
    assert await redis.exists(f"nyy:captcha:token:{token_h}") == 0


async def test_send_code_email_hourly_limit(client, redis):
    """同邮箱每小时第 6 次发送验证码返回限流。"""
    from app.services.email_code import _cooldown_key

    email = f"limit-{uuid.uuid4().hex}@example.com"
    with patch("app.api.v1.auth.send_email_code", new=AsyncMock(return_value=True)):
        for _ in range(5):
            captcha_token = await get_captcha_token(client, redis)
            response = await client.post(
                "/api/v1/auth/send-code",
                json={"email": email, "purpose": "register", "captcha_token": captcha_token},
            )
            assert response.status_code == 200
            await redis.delete(_cooldown_key("register", email))

        captcha_token = await get_captcha_token(client, redis)
        response = await client.post(
            "/api/v1/auth/send-code",
            json={"email": email, "purpose": "register", "captcha_token": captcha_token},
        )

    assert response.status_code == 429


async def test_send_code_ip_hourly_limit(client, redis):
    """同 IP 每小时第 21 次发送验证码返回限流。"""
    with patch("app.api.v1.auth.send_email_code", new=AsyncMock(return_value=True)):
        for idx in range(20):
            captcha_token = await get_captcha_token(client, redis)
            response = await client.post(
                "/api/v1/auth/send-code",
                json={
                    "email": f"ip-hour-{idx}-{uuid.uuid4().hex}@example.com",
                    "purpose": "register",
                    "captcha_token": captcha_token,
                },
            )
            assert response.status_code == 200

        captcha_token = await get_captcha_token(client, redis)
        response = await client.post(
            "/api/v1/auth/send-code",
            json={
                "email": f"ip-hour-final-{uuid.uuid4().hex}@example.com",
                "purpose": "register",
                "captcha_token": captcha_token,
            },
        )

    assert response.status_code == 429


async def test_send_code_ip_daily_limit(client, redis):
    """同 IP 每日第 101 次发送验证码返回限流。"""
    from app.core.config import get_settings

    settings = get_settings()
    original_hourly = settings.email_code_ip_hourly_limit
    settings.email_code_ip_hourly_limit = 200
    try:
        with patch("app.api.v1.auth.send_email_code", new=AsyncMock(return_value=True)):
            for idx in range(100):
                captcha_token = await get_captcha_token(client, redis)
                response = await client.post(
                    "/api/v1/auth/send-code",
                    json={
                        "email": f"ip-day-{idx}-{uuid.uuid4().hex}@example.com",
                        "purpose": "register",
                        "captcha_token": captcha_token,
                    },
                )
                assert response.status_code == 200

            captcha_token = await get_captcha_token(client, redis)
            response = await client.post(
                "/api/v1/auth/send-code",
                json={
                    "email": f"ip-day-final-{uuid.uuid4().hex}@example.com",
                    "purpose": "register",
                    "captcha_token": captcha_token,
                },
            )
    finally:
        settings.email_code_ip_hourly_limit = original_hourly

    assert response.status_code == 429


async def test_register_requires_valid_email_code(client, redis):
    """注册必须携带有效邮箱验证码。"""
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": "new@example.com", "password": "password123", "code": "000000"},
    )
    assert response.status_code == 400
    assert await get_user("new@example.com") is None


async def test_email_code_is_deleted_after_max_attempts(client, redis):
    """邮箱验证码错误达到 5 次后立即删除。"""
    from app.services.email_code import _code_key

    email = f"attempts-{uuid.uuid4().hex}@example.com"
    await inject_email_code(redis, email, "123456", "register")

    for _ in range(5):
        assert await redis.exists(_code_key("register", email)) == 1
        response = await client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": "Str0ngP@ss!", "code": "000000"},
        )
        assert response.status_code == 400

    assert await redis.exists(_code_key("register", email)) == 0


async def test_register_with_valid_code(client, redis):
    """有效邮箱验证码可以注册。"""
    email = f"reg-{uuid.uuid4().hex}@example.com"
    code = "123456"
    await inject_email_code(redis, email, code, "register")

    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Str0ngP@ss!", "code": code},
    )
    assert response.status_code == 200

    user = await get_user(email)
    assert user is not None
    assert user.email_verified_at is not None


async def test_register_rejects_weak_password(client, redis):
    """弱密码被拒绝。"""
    email = f"weak-{uuid.uuid4().hex}@example.com"
    code = "123456"
    await inject_email_code(redis, email, code, "register")

    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "12345678", "code": code},
    )
    assert response.status_code == 400
    assert "常见" in response.json()["detail"]


async def test_register_rejects_duplicate_verified_email(client, redis):
    """已验证邮箱再次注册被拒绝。"""
    email = f"dup-{uuid.uuid4().hex}@example.com"
    await create_verified_user(email, "password123")
    code = "123456"
    await inject_email_code(redis, email, code, "register")

    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "newpass123", "code": code},
    )
    assert response.status_code == 409


async def test_login_success(client, redis):
    """登录成功返回 access token 和设置 cookie。"""
    email = f"login-{uuid.uuid4().hex}@example.com"
    password = "Str0ngP@ss!"
    await create_verified_user(email, password)

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    assert data["expires_in"] > 0
    assert data["user"]["email"] == email
    # 检查 refresh cookie
    cookies = {c.name: c.value for c in response.cookies.jar}
    assert "nyy_refresh_token" in cookies


async def test_login_fails_with_wrong_password(client, redis):
    """错误密码登录失败。"""
    email = f"wrong-{uuid.uuid4().hex}@example.com"
    await create_verified_user(email, "password123")

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "wrongpassword"},
    )
    assert response.status_code == 401


async def test_login_requires_captcha_after_failures(client, redis):
    """登录失败 3 次后需要人机验证。"""
    email = f"risk-{uuid.uuid4().hex}@example.com"
    await create_verified_user(email, "password123")

    for _ in range(3):
        await client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "wrong"},
        )

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "password123"},
    )
    assert response.status_code == 428


async def test_risk_login_with_valid_captcha_succeeds(client, redis):
    """风险登录携带 login purpose captcha_token 且密码正确时成功。"""
    email = f"risk-ok-{uuid.uuid4().hex}@example.com"
    password = "Str0ngP@ss!"
    await create_verified_user(email, password)

    for _ in range(3):
        await client.post(
            "/api/v1/auth/login",
            json={"email": email, "password": "wrong"},
        )

    captcha_token = await get_captcha_token(client, redis, purpose="login")
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password, "captcha_token": captcha_token},
    )

    assert response.status_code == 200


async def test_refresh_token_rotation(client, redis):
    """refresh 成功后旧 token 被撤销，新 token 被创建。"""
    email = f"refresh-{uuid.uuid4().hex}@example.com"
    password = "Str0ngP@ss!"
    await create_verified_user(email, password)

    # 登录获取 refresh cookie
    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert login_resp.status_code == 200
    old_token = login_resp.cookies.get("nyy_refresh_token")
    assert old_token is not None

    # 刷新
    refresh_resp = await client.post(
        "/api/v1/auth/refresh",
        cookies={"nyy_refresh_token": old_token},
        headers={"Origin": "http://test"},
    )
    assert refresh_resp.status_code == 200
    new_token = refresh_resp.cookies.get("nyy_refresh_token")
    assert new_token is not None
    assert new_token != old_token


async def test_refresh_rejects_missing_origin(client, redis):
    """refresh 使用 Cookie 凭证时必须校验 Origin 或 Referer。"""
    email = f"csrf-{uuid.uuid4().hex}@example.com"
    password = "Str0ngP@ss!"
    await create_verified_user(email, password)

    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    token = login_resp.cookies.get("nyy_refresh_token")

    response = await client.post(
        "/api/v1/auth/refresh",
        cookies={"nyy_refresh_token": token},
    )

    assert response.status_code == 403


async def test_refresh_token_reuse_revokes_family(client, redis):
    """复用旧 refresh token 触发同 family 全部撤销。"""
    email = f"reuse-{uuid.uuid4().hex}@example.com"
    password = "Str0ngP@ss!"
    await create_verified_user(email, password)

    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    old_token = login_resp.cookies.get("nyy_refresh_token")

    refresh_resp = await client.post(
        "/api/v1/auth/refresh",
        cookies={"nyy_refresh_token": old_token},
        headers={"Origin": "http://test"},
    )
    assert refresh_resp.status_code == 200

    reuse_resp = await client.post(
        "/api/v1/auth/refresh",
        cookies={"nyy_refresh_token": old_token},
        headers={"Origin": "http://test"},
    )

    assert reuse_resp.status_code == 401
    sessions = await get_user_sessions(email)
    assert sessions
    assert all(session.revoked_at is not None for session in sessions)


async def test_logout_revokes_session(client, redis):
    """登出撤销 session 并清除 cookie。"""
    email = f"logout-{uuid.uuid4().hex}@example.com"
    password = "Str0ngP@ss!"
    await create_verified_user(email, password)

    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    token = login_resp.cookies.get("nyy_refresh_token")

    logout_resp = await client.post(
        "/api/v1/auth/logout",
        cookies={"nyy_refresh_token": token},
        headers={"Origin": "http://test"},
    )
    assert logout_resp.status_code == 200

    # 旧 token 应该失效
    refresh_resp = await client.post(
        "/api/v1/auth/refresh",
        cookies={"nyy_refresh_token": token},
        headers={"Origin": "http://test"},
    )
    assert refresh_resp.status_code == 401


async def test_reset_password_revokes_sessions_and_sends_notification(client, redis):
    """重置密码成功后撤销全部 session 并发送通知邮件。"""
    email = f"reset-{uuid.uuid4().hex}@example.com"
    old_password = "Str0ngP@ss!"
    new_password = "An0therP@ss!"
    code = "654321"
    await create_verified_user(email, old_password)
    await inject_email_code(redis, email, code, "reset_password")

    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": old_password},
    )
    token = login_resp.cookies.get("nyy_refresh_token")

    with patch(
        "app.api.v1.auth.send_password_reset_notify",
        new=AsyncMock(return_value=True),
    ) as notify:
        response = await client.post(
            "/api/v1/auth/reset-password",
            json={"email": email, "code": code, "new_password": new_password},
        )

    assert response.status_code == 200
    notify.assert_awaited_once_with(email)
    sessions = await get_user_sessions(email)
    assert sessions
    assert all(session.revoked_at is not None for session in sessions)

    refresh_resp = await client.post(
        "/api/v1/auth/refresh",
        cookies={"nyy_refresh_token": token},
        headers={"Origin": "http://test"},
    )
    assert refresh_resp.status_code == 401


async def test_verify_email_route_removed(client, redis):
    """旧 /auth/verify-email 路由不再存在。"""
    response = await client.post("/api/v1/auth/verify-email", json={})
    assert response.status_code == 404


async def test_auth_events_are_persisted_without_plain_secrets(client, redis):
    """关键认证事件必须落库且不包含明文密码/token/验证码。"""
    email = f"audit-{uuid.uuid4().hex}@example.com"
    password = "Str0ngP@ss!"
    await create_verified_user(email, password)

    await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "wrong-secret"},
    )
    await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )

    events = await get_auth_events("login_failed", "login_success")
    assert any(event.event_type == "login_failed" for event in events)
    assert any(event.event_type == "login_success" for event in events)
    serialized = "\n".join(
        f"{event.event_type} {event.email_hash} {event.reason} {event.extra_data}"
        for event in events
    )
    assert email not in serialized
    assert password not in serialized
    assert "wrong-secret" not in serialized


async def test_captcha_events_are_persisted(client, redis):
    """CAPTCHA challenge 创建和失败事件必须落库。"""
    challenge_resp = await client.get("/api/v1/captcha/challenge?purpose=email_send")
    assert challenge_resp.status_code == 200
    challenge_id = challenge_resp.json()["challenge_id"]

    verify_resp = await client.post(
        "/api/v1/captcha/verify",
        json={"challenge_id": challenge_id, "purpose": "email_send", "payload": "invalid"},
    )
    assert verify_resp.status_code == 400

    events = await get_auth_events("captcha_challenge_created", "captcha_failed")
    assert any(event.event_type == "captcha_challenge_created" for event in events)
    assert any(event.event_type == "captcha_failed" for event in events)
