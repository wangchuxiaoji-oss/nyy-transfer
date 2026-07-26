"""版本化配额策略 Schema。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class SendQuotaPolicy(BaseModel):
    period_kind: Literal["daily", "monthly"]
    period_limit_bytes: int = Field(..., ge=1)
    max_file_bytes: int = Field(..., ge=1)
    max_share_bytes: int = Field(..., ge=1)
    max_files_per_share: int = Field(..., ge=1)
    max_empty_dirs_per_share: int = Field(..., ge=0)
    max_active_shares: int = Field(..., ge=1)
    max_concurrent_upload_batches: int = Field(..., ge=1)
    default_retention_hours: int = Field(..., ge=1)
    retention_options_hours: list[int] = Field(..., min_length=1)
    default_max_downloads: int = Field(..., ge=0)
    download_options: list[int] = Field(..., min_length=1)

    @model_validator(mode="after")
    def validate_options(self) -> SendQuotaPolicy:
        if self.max_file_bytes > self.max_share_bytes:
            raise ValueError("单文件上限不能超过单分享总容量")
        if self.max_share_bytes > self.period_limit_bytes:
            raise ValueError("单分享总容量不能超过周期额度")
        if self.default_retention_hours not in self.retention_options_hours:
            raise ValueError("默认有效期必须包含在有效期选项中")
        if self.default_max_downloads not in self.download_options:
            raise ValueError("默认下载次数必须包含在下载次数选项中")
        if any(value < 1 for value in self.retention_options_hours):
            raise ValueError("有效期选项必须为正数")
        if any(value < 0 for value in self.download_options):
            raise ValueError("下载次数选项不能为负数")
        if len(set(self.retention_options_hours)) != len(self.retention_options_hours):
            raise ValueError("有效期选项不能重复")
        if len(set(self.download_options)) != len(self.download_options):
            raise ValueError("下载次数选项不能重复")
        return self


class ReceiveQuotaPolicy(BaseModel):
    enabled: bool = True
    max_active_requests: int = Field(..., ge=1)
    max_request_bytes: int = Field(..., ge=1)
    max_file_bytes: int = Field(..., ge=1)
    max_files_per_request: int = Field(..., ge=1)
    default_retention_hours: int = Field(..., ge=1)
    retention_options_hours: list[int] = Field(..., min_length=1)

    @model_validator(mode="after")
    def validate_options(self) -> ReceiveQuotaPolicy:
        if self.max_file_bytes > self.max_request_bytes:
            raise ValueError("收件单文件上限不能超过单条收件容量")
        if self.default_retention_hours not in self.retention_options_hours:
            raise ValueError("收件默认有效期必须包含在有效期选项中")
        if any(value < 1 for value in self.retention_options_hours):
            raise ValueError("收件有效期选项必须为正数")
        if len(set(self.retention_options_hours)) != len(self.retention_options_hours):
            raise ValueError("收件有效期选项不能重复")
        return self


class QuotaPolicyConfig(BaseModel):
    timezone: Literal["Asia/Shanghai"] = "Asia/Shanghai"
    guest: SendQuotaPolicy
    user: SendQuotaPolicy
    receive: ReceiveQuotaPolicy
    retention_coupon_hours: int = Field(default=2160, ge=1)


class TechnicalQuotaCeilings(BaseModel):
    max_file_bytes: int
    max_share_bytes: int
    max_files_per_share: int
    max_empty_dirs_per_share: int
    max_retention_hours: int
    max_active_links: int
    max_concurrent_upload_batches: int
    max_request_bytes: int
    max_request_files: int


class QuotaPolicyVersionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    status: Literal["draft", "published", "scheduled"]
    config: QuotaPolicyConfig
    note: str
    effective_at: datetime | None
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime
    created_by: uuid.UUID | None
    published_by: uuid.UUID | None
    rollback_from_id: uuid.UUID | None


class QuotaPolicyPublicResponse(BaseModel):
    version: int
    effective_at: datetime
    config: QuotaPolicyConfig
    technical: TechnicalQuotaCeilings


class QuotaPolicyListResponse(BaseModel):
    items: list[QuotaPolicyVersionResponse]
    current_id: uuid.UUID | None


class QuotaPolicyDraftCreate(BaseModel):
    config: QuotaPolicyConfig | None = None
    note: str = Field(default="", max_length=500)


class QuotaPolicyDraftUpdate(BaseModel):
    config: QuotaPolicyConfig
    note: str = Field(default="", max_length=500)


class QuotaPolicyPublishRequest(BaseModel):
    effective_at: datetime | None = None
    note: str = Field(default="", max_length=500)
    expected_config_hash: str = Field(..., min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")


class QuotaPolicyRollbackRequest(BaseModel):
    effective_at: datetime | None = None
    note: str = Field(default="回滚配额策略", max_length=500)


class QuotaPolicyImpactResponse(BaseModel):
    valid: bool
    errors: list[str]
    warnings: list[str]
    changed_fields: list[str]
    over_limit_identities: int
    technical: TechnicalQuotaCeilings
    config_hash: str
    updated_at: datetime
