"""Admin API schemas。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class AdminStatsResponse(BaseModel):
    users_total: int
    shares_total: int
    shares_active: int
    shares_banned: int
    uploaded_bytes_total: int
    uploaded_bytes_24h: int
    reports_pending: int
    emails_failed: int


class AdminUserItem(BaseModel):
    id: str
    email: str
    plan: str
    email_verified: bool
    created_at: datetime
    last_login_at: datetime | None = None


class AdminUsersResponse(BaseModel):
    users: list[AdminUserItem]
    total: int
    page: int
    page_size: int


class AdminShareItem(BaseModel):
    code: str
    title: str | None = None
    owner_email: str | None = None
    file_count: int
    total_bytes: int
    download_count: int
    created_at: datetime
    expires_at: datetime | None = None
    revoked: bool
    banned: bool
    banned_reason: str | None = None


class AdminSharesResponse(BaseModel):
    shares: list[AdminShareItem]
    total: int
    page: int
    page_size: int


class QuotaConfigResponse(BaseModel):
    guest_max_file_bytes: int
    guest_max_active_shares: int
    guest_ttl_hours: int
    user_max_file_bytes: int
    user_max_active_shares: int
    user_ttl_hours: int


class QuotaConfigUpdate(BaseModel):
    guest_max_file_bytes: int = Field(..., ge=1)
    guest_max_active_shares: int = Field(..., ge=1)
    guest_ttl_hours: int = Field(..., ge=1)
    user_max_file_bytes: int = Field(..., ge=1)
    user_max_active_shares: int = Field(..., ge=1)
    user_ttl_hours: int = Field(..., ge=1)


class BanShareRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=255)


class MessageResponse(BaseModel):
    message: str


class AdminReportItem(BaseModel):
    id: str
    share_code: str
    reason: str
    detail: str | None = None
    status: str
    created_at: datetime


class AdminReportsResponse(BaseModel):
    reports: list[AdminReportItem]
    total: int = 0
    page: int = 1
    page_size: int = 20


class AdminEmailItem(BaseModel):
    recipient: str
    share_code: str
    status: str
    error: str | None = None
    created_at: datetime
    sent_at: datetime | None = None


class AdminEmailsResponse(BaseModel):
    emails: list[AdminEmailItem]
    total: int = 0
    page: int = 1
    page_size: int = 20
