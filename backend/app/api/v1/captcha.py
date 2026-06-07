"""验证码 API：ALTCHA challenge 创建和校验。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.db.session import get_db
from app.services.auth_audit import log_auth_event
from app.services.captcha import create_altcha_challenge, verify_altcha_payload

router = APIRouter(prefix="/captcha", tags=["captcha"])


def _get_redis(request: Request):
    redis = request.app.state.redis
    if not redis:
        raise HTTPException(503, "服务暂时不可用")
    return redis


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# ─── 请求/响应模型 ──────────────────────────────────────────────

class ChallengeResponse(BaseModel):
    challenge_id: str
    challenge: dict
    expires_in: int


class VerifyRequest(BaseModel):
    challenge_id: str
    purpose: str = Field(pattern=r"^(email_send|login)$")
    payload: str


class VerifyResponse(BaseModel):
    captcha_token: str
    expires_in: int


# ─── 端点 ───────────────────────────────────────────────────────

@router.get("/challenge", response_model=ChallengeResponse)
async def get_challenge(
    request: Request,
    purpose: str = "email_send",
    db: AsyncSession = Depends(get_db),
):
    """获取 ALTCHA challenge。"""
    if purpose not in ("email_send", "login"):
        raise HTTPException(400, "无效的 purpose")

    redis = _get_redis(request)
    ip = _get_client_ip(request)
    ua = request.headers.get("user-agent", "")

    result = await create_altcha_challenge(redis, purpose, ip, ua)
    await log_auth_event(
        db,
        event_type="captcha_challenge_created",
        success=True,
        ip=ip,
        user_agent=ua,
        metadata={"purpose": purpose},
    )
    return ChallengeResponse(
        challenge_id=result["challenge_id"],
        challenge=result["challenge"],
        expires_in=result["expires_in"],
    )


@router.post("/verify", response_model=VerifyResponse)
async def verify_challenge(
    body: VerifyRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """校验 ALTCHA payload，返回一次性 captcha_token。"""
    redis = _get_redis(request)
    ip = _get_client_ip(request)
    ua = request.headers.get("user-agent", "")

    ok, result = await verify_altcha_payload(
        redis,
        body.challenge_id,
        body.purpose,
        body.payload,
        ip,
        ua,
    )
    if not ok:
        await log_auth_event(
            db,
            event_type="captcha_failed",
            success=False,
            ip=ip,
            user_agent=ua,
            reason=result,
            metadata={"purpose": body.purpose},
        )
        raise HTTPException(400, result)

    await log_auth_event(
        db,
        event_type="captcha_verified",
        success=True,
        ip=ip,
        user_agent=ua,
        metadata={"purpose": body.purpose},
    )
    return VerifyResponse(
        captcha_token=result,
        expires_in=get_settings().captcha_token_ttl_seconds,
    )
