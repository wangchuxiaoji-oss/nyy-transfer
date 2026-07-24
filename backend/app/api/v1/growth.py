"""增长推荐、第一方落地事件与留存券 API。"""

from __future__ import annotations

from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_current_user_required
from app.db.session import get_db
from app.models.user import User
from app.schemas.growth import (
    GrowthMeResponse,
    LandingEventRequest,
    LandingEventResponse,
    ReferralStatsResponse,
    RetentionCouponResponse,
    ViralClickRequest,
    ViralClickResponse,
)
from app.services.growth import (
    GrowthServiceError,
    get_growth_summary,
    record_landing_event,
    record_viral_click,
)
from app.services.visitor_identity import (
    LANDING_RATE_LIMIT,
    VIRAL_CLICK_RATE_LIMIT,
    check_public_event_rate_limit,
    resolve_visitor_identity,
)
from app.utils.client_ip import get_client_ip

router = APIRouter(prefix="/growth", tags=["growth"])


def _referrer(body_referrer: str | None, request: Request) -> str | None:
    return body_referrer or (request.headers.get("referer") or "")[:2048] or None


def _redis(request: Request):
    redis = getattr(request.app.state, "redis", None)
    if redis is None:
        raise HTTPException(503, "服务暂时不可用")
    return redis


async def _enforce_public_rate_limit(
    request: Request,
    *,
    scope: str,
    limit: int,
) -> None:
    allowed = await check_public_event_rate_limit(
        _redis(request),
        scope=scope,
        client_ip=get_client_ip(request),
        limit=limit,
    )
    if not allowed:
        raise HTTPException(429, "请求过于频繁，请稍后再试")


@router.post("/viral-click", response_model=ViralClickResponse)
async def viral_click(
    body: ViralClickRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """记录分享 CTA 点击；无 owner 的分享同样记录。"""

    client_ip = get_client_ip(request)
    await _enforce_public_rate_limit(
        request,
        scope="viral-click",
        limit=VIRAL_CLICK_RATE_LIMIT,
    )
    visitor_id = await resolve_visitor_identity(
        request,
        response=response,
        redis=_redis(request),
        issue=True,
    )
    try:
        recorded = await record_viral_click(
            db,
            share_code=body.share_code,
            request_id=body.request_id,
            visitor_id=visitor_id,
            guest_id=visitor_id,
            ip=client_ip,
            user_agent=request.headers.get("user-agent") or "",
            utm_source=body.utm_source,
            utm_medium=body.utm_medium,
            utm_campaign=body.utm_campaign,
            utm_term=body.utm_term,
            utm_content=body.utm_content,
            referrer=_referrer(body.referrer, request),
        )
    except GrowthServiceError as exc:
        raise HTTPException(404, exc.message) from exc
    await db.commit()

    code = body.share_code.strip()
    base_url = get_settings().app_base_url.rstrip("/")
    cta_url = f"{base_url}/?{urlencode({'ref_share': code})}"
    return ViralClickResponse(
        recorded=recorded,
        share_code=code,
        cta_url=cta_url,
    )


@router.post("/landing", response_model=LandingEventResponse)
async def landing(
    body: LandingEventRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """记录第一方匿名落地访问。"""

    client_ip = get_client_ip(request)
    await _enforce_public_rate_limit(
        request,
        scope="landing",
        limit=LANDING_RATE_LIMIT,
    )
    visitor_id = await resolve_visitor_identity(
        request,
        response=response,
        redis=_redis(request),
        issue=True,
    )
    recorded = await record_landing_event(
        db,
        request_id=body.request_id,
        visitor_id=visitor_id,
        guest_id=visitor_id,
        ip=client_ip,
        user_agent=request.headers.get("user-agent") or "",
        landing_path=body.landing_path,
        utm_source=body.utm_source,
        utm_medium=body.utm_medium,
        utm_campaign=body.utm_campaign,
        utm_term=body.utm_term,
        utm_content=body.utm_content,
        referrer=_referrer(body.referrer, request),
    )
    await db.commit()
    return LandingEventResponse(recorded=recorded)


@router.get("/me", response_model=GrowthMeResponse)
async def growth_me(
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    """返回当前用户可用券与其发出的邀请统计。"""

    summary = await get_growth_summary(db, user_id=user.id)
    await db.commit()
    return GrowthMeResponse(
        available_coupons=[
            RetentionCouponResponse(
                id=coupon.id,
                status=coupon.status,
                target_ttl_days=coupon.target_ttl_days,
                issued_at=coupon.issued_at,
                expires_at=coupon.expires_at,
            )
            for coupon in summary["available_coupons"]
        ],
        referrals=ReferralStatsResponse(
            pending=summary["pending"],
            qualified=summary["qualified"],
        ),
    )
