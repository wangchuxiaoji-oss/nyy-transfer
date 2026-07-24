"""服务端签发的匿名访客身份与公开事件限流。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import time

from fastapi import Request, Response

from app.core.config import get_settings

VISITOR_COOKIE_NAME = "nyy_visitor"
VISITOR_ID_PREFIX = "visitor:"
VISITOR_MAX_AGE_SECONDS = 180 * 24 * 60 * 60
LANDING_RATE_LIMIT = 20
VIRAL_CLICK_RATE_LIMIT = 30
INTERACTION_RATE_LIMIT = 30
PUBLIC_EVENT_RATE_WINDOW_SECONDS = 60

_RAW_VISITOR_ID_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")


def _signature(visitor_id: str) -> str:
    digest = hmac.new(
        get_settings().jwt_secret.encode("utf-8"),
        f"nyy-visitor-v1:{visitor_id}".encode(),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _encode_cookie(visitor_id: str) -> str:
    return f"{visitor_id}.{_signature(visitor_id)}"


def _decode_cookie(value: str | None) -> str | None:
    if not value:
        return None
    visitor_id, separator, signature = value.partition(".")
    if not separator or not _RAW_VISITOR_ID_RE.fullmatch(visitor_id):
        return None
    if not hmac.compare_digest(signature, _signature(visitor_id)):
        return None
    return visitor_id


def _set_visitor_cookie(response: Response, visitor_id: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=VISITOR_COOKIE_NAME,
        value=_encode_cookie(visitor_id),
        max_age=VISITOR_MAX_AGE_SECONDS,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite=settings.auth_cookie_samesite,
        path="/",
        domain=settings.auth_cookie_domain or None,
    )


async def resolve_visitor_identity(
    request: Request,
    *,
    redis,
    response: Response | None = None,
    issue: bool = False,
) -> str | None:
    """解析签名 cookie，并在需要时为当前浏览器签发匿名身份。"""

    cookie_visitor_id = _decode_cookie(request.cookies.get(VISITOR_COOKIE_NAME))
    if redis is None:
        if cookie_visitor_id:
            return f"{VISITOR_ID_PREFIX}{cookie_visitor_id}"
        return None

    visitor_id = cookie_visitor_id
    if visitor_id is None and not issue:
        return None
    if visitor_id is None:
        visitor_id = secrets.token_urlsafe(24)

    if response is not None and cookie_visitor_id != visitor_id:
        _set_visitor_cookie(response, visitor_id)
    return f"{VISITOR_ID_PREFIX}{visitor_id}"


def public_event_rate_limit_key(
    scope: str,
    client_ip: str,
    *,
    now: float | None = None,
) -> str:
    current_time = time.time() if now is None else now
    bucket = int(current_time // PUBLIC_EVENT_RATE_WINDOW_SECONDS)
    digest = hashlib.sha256(f"{scope}\0{client_ip}".encode()).hexdigest()[:32]
    return f"nyy:growth:rate:{scope}:{digest}:{bucket}"


async def check_public_event_rate_limit(
    redis,
    *,
    scope: str,
    client_ip: str,
    limit: int,
) -> bool:
    """按服务端客户端 IP 限制公开事件固定窗口请求数。"""

    key = public_event_rate_limit_key(scope, client_ip)
    pipeline = redis.pipeline()
    pipeline.incr(key)
    pipeline.expire(key, PUBLIC_EVENT_RATE_WINDOW_SECONDS + 1)
    count, _ = await pipeline.execute()
    return int(count) <= limit
