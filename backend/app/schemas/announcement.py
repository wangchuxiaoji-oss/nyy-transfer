"""系统更新公告的公共与后台契约。"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

AnnouncementCategory = Literal["release", "maintenance", "incident"]
AnnouncementPriority = Literal["normal", "important", "critical"]
AnnouncementState = Literal[
    "released",
    "scheduled",
    "in_progress",
    "completed",
    "investigating",
    "monitoring",
    "resolved",
    "cancelled",
]
AnnouncementStatus = Literal["draft", "published", "archived"]
AnnouncementDetail = Annotated[str, Field(min_length=1, max_length=300)]

_CATEGORY_STATES: dict[str, set[str]] = {
    "release": {"released"},
    "maintenance": {"scheduled", "in_progress", "completed", "cancelled"},
    "incident": {"investigating", "monitoring", "resolved"},
}


def validate_announcement_values(
    *,
    category: str,
    state: str,
    started_at: datetime | None,
    completed_at: datetime | None,
) -> None:
    if state not in _CATEGORY_STATES.get(category, set()):
        raise ValueError("公告事件状态与公告类型不匹配")
    if completed_at and started_at and completed_at < started_at:
        raise ValueError("完成时间不能早于开始时间")
    if state in {"completed", "resolved"} and not completed_at:
        raise ValueError("已完成或已解决的公告必须填写完成时间")


class AnnouncementCreate(BaseModel):
    version: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    )
    category: AnnouncementCategory
    state: AnnouncementState
    priority: AnnouncementPriority = "normal"
    title: str = Field(min_length=1, max_length=160)
    summary: str = Field(min_length=1, max_length=500)
    details: list[AnnouncementDetail] = Field(default_factory=list, max_length=12)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    visible_until: datetime | None = None

    @model_validator(mode="after")
    def validate_values(self) -> AnnouncementCreate:
        validate_announcement_values(
            category=self.category,
            state=self.state,
            started_at=self.started_at,
            completed_at=self.completed_at,
        )
        return self


class AnnouncementUpdate(BaseModel):
    version: str | None = Field(
        default=None,
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$",
    )
    category: AnnouncementCategory | None = None
    state: AnnouncementState | None = None
    priority: AnnouncementPriority | None = None
    title: str | None = Field(default=None, min_length=1, max_length=160)
    summary: str | None = Field(default=None, min_length=1, max_length=500)
    details: list[AnnouncementDetail] | None = Field(default=None, max_length=12)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    visible_until: datetime | None = None


class AnnouncementResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: str
    category: AnnouncementCategory
    state: AnnouncementState
    priority: AnnouncementPriority
    title: str
    summary: str
    details: list[str]
    status: AnnouncementStatus
    revision: int
    started_at: datetime | None
    completed_at: datetime | None
    visible_until: datetime | None
    published_at: datetime | None
    archived_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AdminAnnouncementListResponse(BaseModel):
    items: list[AnnouncementResponse]
    total: int
    page: int
    page_size: int
    pages: int


class PublicAnnouncementItem(BaseModel):
    id: uuid.UUID
    notice_id: str
    version: str
    category: AnnouncementCategory
    state: AnnouncementState
    priority: AnnouncementPriority
    title: str
    summary: str
    details: list[str]
    revision: int
    started_at: datetime | None
    completed_at: datetime | None
    visible_until: datetime | None
    published_at: datetime


class PublicAnnouncementListResponse(BaseModel):
    items: list[PublicAnnouncementItem]
    has_more: bool
    next_offset: int | None
