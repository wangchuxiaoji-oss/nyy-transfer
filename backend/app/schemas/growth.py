"""增长推荐、第一方归因和留存券 schemas。"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class GrowthTrackingFields(BaseModel):
    utm_source: str | None = Field(default=None, max_length=128)
    utm_medium: str | None = Field(default=None, max_length=128)
    utm_campaign: str | None = Field(default=None, max_length=128)
    utm_term: str | None = Field(default=None, max_length=128)
    utm_content: str | None = Field(default=None, max_length=128)
    referrer: str | None = Field(default=None, max_length=2048)


class ViralClickRequest(GrowthTrackingFields):
    share_code: str = Field(min_length=1, max_length=16, pattern=r"^[A-Za-z0-9_-]+$")
    request_id: str = Field(
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )


class ViralClickResponse(BaseModel):
    recorded: bool
    share_code: str
    cta_url: str


class LandingEventRequest(GrowthTrackingFields):
    request_id: str = Field(
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    landing_path: str = Field(min_length=1, max_length=1024)


class LandingEventResponse(BaseModel):
    recorded: bool


class RetentionCouponResponse(BaseModel):
    id: uuid.UUID
    status: str
    target_ttl_days: int
    issued_at: datetime
    expires_at: datetime


class ReferralStatsResponse(BaseModel):
    pending: int
    qualified: int


class GrowthMeResponse(BaseModel):
    available_coupons: list[RetentionCouponResponse]
    referrals: ReferralStatsResponse
