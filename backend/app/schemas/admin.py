"""Admin API schemas。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.share import ShareInfoResponse


class AdminIpGeo(BaseModel):
    country: str = ""
    region: str = ""
    city: str = ""
    isp: str = ""


class AdminIpSource(BaseModel):
    ip: str
    geo: AdminIpGeo = Field(default_factory=AdminIpGeo)


class AdminStatsResponse(BaseModel):
    users_total: int
    shares_total: int
    shares_active: int
    shares_banned: int
    uploaded_bytes_total: int
    uploaded_bytes_24h: int
    reports_pending: int
    emails_failed: int


class AdminDashboardTasks(BaseModel):
    reports_pending: int
    emails_failed: int
    suspicious_access: int
    doubao_unavailable: int


class AdminDashboardToday(BaseModel):
    shares_created: int
    links_issued: int
    human_interactions: int
    preview_fetches: int
    uploaded_bytes: int


class AdminDashboardResponse(BaseModel):
    tasks: AdminDashboardTasks
    today: AdminDashboardToday
    totals: AdminStatsResponse


class AdminUserItem(BaseModel):
    id: str
    email: str
    plan: str
    is_admin: bool
    email_verified: bool
    disabled: bool = False
    deleted: bool = False
    created_at: datetime
    last_login_at: datetime | None = None
    disabled_at: datetime | None = None
    deleted_at: datetime | None = None
    registration_source: AdminIpSource | None = None
    last_login_source: AdminIpSource | None = None


class AdminUsersResponse(BaseModel):
    users: list[AdminUserItem]
    items: list[AdminUserItem] = Field(default_factory=list)
    pagination_mode: Literal["cursor", "page"] = "page"
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool = False
    total: int | None = None
    total_is_estimated: bool = False
    page: int | None = None
    page_size: int | None = None


class AdminUserUpdate(BaseModel):
    plan: str | None = Field(default=None, pattern="^(free|pro)$")
    disabled: bool | None = None
    deleted: bool | None = None
    email_verified: bool | None = None


class AdminShareItem(BaseModel):
    code: str
    title: str | None = None
    owner_email: str | None = None
    file_count: int
    total_bytes: int
    download_count: int
    max_downloads: int
    created_at: datetime
    expires_at: datetime | None = None
    revoked: bool
    banned: bool
    banned_reason: str | None = None
    source: AdminIpSource | None = None
    guest_label: str = ""
    access_event_count: int = 0
    unique_access_ips: int = 0
    status: Literal["active", "revoked", "expired", "banned", "download_exhausted"] = "active"
    page_rendered_count: int = 0
    human_interaction_count: int = 0
    preview_fetch_count: int = 0
    admin_review_count: int = 0


class AdminSharesResponse(BaseModel):
    shares: list[AdminShareItem]
    items: list[AdminShareItem] = Field(default_factory=list)
    pagination_mode: Literal["cursor", "page"] = "page"
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool = False
    total: int | None = None
    total_is_estimated: bool = False
    page: int | None = None
    page_size: int | None = None


class AdminShareViewResponse(ShareInfoResponse):
    status: Literal["active", "revoked", "expired", "banned", "download_exhausted"]


class AdminShareDetailResponse(BaseModel):
    """分享详情摘要：元数据与计数，不加载文件关系。"""

    item: AdminShareItem
    owner_id: str | None = None
    guest_id: str | None = None
    ip_created_from: str | None = None
    created_at: datetime
    last_activity_at: datetime | None = None
    logical_file_count: int = 0
    stored_object_count: int = 0
    empty_dir_count: int = 0
    has_password: bool = False


class AdminSourceEvent(BaseModel):
    id: str = ""
    event_type: Literal[
        "view",
        "preview_fetch",
        "page_rendered",
        "human_interaction",
        "link_issued",
        "admin_review",
        "register",
        "login",
        "active_session",
    ]
    occurred_at: datetime
    source: AdminIpSource
    user_agent: str = ""
    actor_label: str = ""
    client_kind: str = "unknown"
    confidence: str = "low"
    detector: str = ""
    request_id: str = ""
    http_status: int | None = None
    request_time_ms: int | None = None


class AdminShareSourcesResponse(BaseModel):
    code: str
    identity_type: Literal["guest", "user"]
    identity_label: str
    creation_source: AdminIpSource | None = None
    created_at: datetime
    event_count: int
    unique_ip_count: int
    events: list[AdminSourceEvent]
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool = False
    event_type_counts: dict[str, int] = Field(default_factory=dict)


class AdminUserSourcesResponse(BaseModel):
    user_id: str
    email: str
    registration_source: AdminIpSource | None = None
    last_login_source: AdminIpSource | None = None
    event_count: int
    unique_ip_count: int
    active_session_count: int
    events: list[AdminSourceEvent]
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool = False


class AdminIpRelatedUser(BaseModel):
    id: str
    email: str
    relation_types: list[str]


class AdminIpRelatedShare(BaseModel):
    code: str
    owner_email: str | None = None
    relation_types: list[str]


class AdminIpRelationsResponse(BaseModel):
    source: AdminIpSource
    users: list[AdminIpRelatedUser]
    shares: list[AdminIpRelatedShare]
    guest_labels: list[str]
    next_cursor: str | None = None
    has_more: bool = False
    truncated_reason: str | None = None


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


class DownloadConfigResponse(BaseModel):
    smart_download_enabled: bool
    target_video: bool
    target_audio: bool
    target_pdf: bool
    target_image: bool
    target_other: bool
    filesystem_access_enabled: bool
    leave_warning_enabled: bool


class DownloadConfigUpdate(BaseModel):
    smart_download_enabled: bool
    target_video: bool
    target_audio: bool
    target_pdf: bool
    target_image: bool
    target_other: bool
    filesystem_access_enabled: bool
    leave_warning_enabled: bool


class BanShareRequest(BaseModel):
    reason: str | None = Field(default=None, min_length=1, max_length=255)


class MessageResponse(BaseModel):
    message: str


class AdminReportItem(BaseModel):
    id: str
    share_code: str
    reason: str
    detail: str | None = None
    status: str
    created_at: datetime
    reporter_ip: str | None = None
    resolution_note: str | None = None
    handled_at: datetime | None = None
    report_count: int = 1
    share_status: str = "active"


class AdminReportsResponse(BaseModel):
    reports: list[AdminReportItem]
    items: list[AdminReportItem] = Field(default_factory=list)
    pagination_mode: Literal["cursor", "page"] = "page"
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool = False
    total: int | None = None
    total_is_estimated: bool = False
    page: int | None = None
    page_size: int | None = None


class ReportStatusUpdate(BaseModel):
    status: str = Field(..., pattern="^(pending|resolved|dismissed)$")
    note: str | None = Field(default=None, max_length=1000)


class AdminEmailItem(BaseModel):
    id: str
    recipient: str
    share_code: str
    status: str
    error: str | None = None
    created_at: datetime
    sent_at: datetime | None = None
    delivery_type: str = "share_link"
    attempt_number: int = 1
    last_attempt_at: datetime | None = None
    parent_delivery_id: str | None = None


class AdminEmailsResponse(BaseModel):
    emails: list[AdminEmailItem]
    items: list[AdminEmailItem] = Field(default_factory=list)
    pagination_mode: Literal["cursor", "page"] = "page"
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool = False
    total: int | None = None
    total_is_estimated: bool = False
    page: int | None = None
    page_size: int | None = None


class AdminShareFileItem(BaseModel):
    id: str
    file_name: str
    file_size: int
    content_type: str = ""
    sort_index: int
    chunk_count: int
    media_metadata: dict | None = None


class AdminShareFilesResponse(BaseModel):
    items: list[AdminShareFileItem]
    page: int
    page_size: int
    total: int


class BatchShareActionRequest(BaseModel):
    codes: list[str] = Field(..., min_length=1, max_length=100)
    reason: str = Field(..., min_length=1, max_length=255)
    batch_id: str = Field(..., min_length=8, max_length=128)


class BatchReportStatusRequest(BaseModel):
    report_ids: list[str] = Field(..., min_length=1, max_length=100)
    status: str = Field(..., pattern="^(resolved|dismissed)$")
    note: str | None = Field(default=None, max_length=1000)
    batch_id: str = Field(..., min_length=8, max_length=128)


class BatchEmailRetryRequest(BaseModel):
    delivery_ids: list[str] = Field(..., min_length=1, max_length=100)
    batch_id: str = Field(..., min_length=8, max_length=128)


class BatchActionResponse(BaseModel):
    batch_id: str
    processed: int
    succeeded: int
    failed: int
    results: list[dict] = Field(default_factory=list)
    idempotent_replay: bool = False


class AdminAuditItem(BaseModel):
    id: str
    created_at: datetime
    request_id: str | None = None
    actor_id: str | None = None
    actor_email: str | None = None
    action: str
    target_type: str | None = None
    target_id: str | None = None
    before: dict | None = None
    after: dict | None = None
    reason: str | None = None
    note: str | None = None
    batch_id: str | None = None
    success: bool
    error_summary: str | None = None
    ip: str | None = None
    user_agent: str | None = None


class AdminAuditResponse(BaseModel):
    items: list[AdminAuditItem]
    pagination_mode: Literal["cursor"] = "cursor"
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more: bool = False
    page: None = None
    page_size: None = None
    total: None = None
    total_is_estimated: bool = False


class ArchiveRequest(BaseModel):
    batch_size: int = Field(default=100, ge=1, le=500)


class ArchiveResponse(BaseModel):
    dry_run: bool
    locked: bool = False
    batch_id: str | None = None
    candidate_count: int
    archived_count: int = 0
    cutoff: datetime | None = None
    samples: list[dict] = Field(default_factory=list)
