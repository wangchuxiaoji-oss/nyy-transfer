"""管理员邮件工作台 API 数据契约。"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, model_validator


class MailboxAddress(BaseModel):
    name: str = ""
    address: str


class MailboxAttachmentItem(BaseModel):
    id: str
    filename: str
    content_type: str
    content_disposition: str
    content_id: str | None = None
    is_inline: bool
    size: int
    sha256: str


class MailboxMessageSummary(BaseModel):
    id: str
    thread_id: str
    message_id: str | None = None
    direction: Literal["inbound", "outbound"]
    delivery_status: Literal["received", "sent", "failed"]
    from_addresses: list[MailboxAddress]
    to_addresses: list[MailboxAddress]
    cc_addresses: list[MailboxAddress]
    subject: str
    body_preview: str
    date: datetime | None = None
    received_at: datetime
    is_read: bool
    is_starred: bool
    is_archived: bool
    is_spam: bool
    is_trashed: bool
    attachment_count: int
    size: int


class MailboxMessageDetail(MailboxMessageSummary):
    in_reply_to: str | None = None
    references: list[str] = Field(default_factory=list)
    reply_to_addresses: list[MailboxAddress]
    text_body: str
    html_body: str
    headers_summary: dict = Field(default_factory=dict)
    attachments: list[MailboxAttachmentItem] = Field(default_factory=list)


class MailboxListResponse(BaseModel):
    items: list[MailboxMessageSummary]
    total: int
    page: int
    page_size: int
    pages: int


class MailboxThreadResponse(BaseModel):
    thread_id: str
    subject: str
    messages: list[MailboxMessageDetail]


class MailboxStateUpdate(BaseModel):
    is_read: bool | None = None
    is_starred: bool | None = None
    is_archived: bool | None = None
    is_spam: bool | None = None
    is_trashed: bool | None = None

    @model_validator(mode="after")
    def validate_changes(self):
        values = self.model_dump(exclude_unset=True)
        if not values:
            raise ValueError("至少提供一个状态字段")
        folder_targets = [
            self.is_archived is True,
            self.is_spam is True,
            self.is_trashed is True,
        ]
        if sum(folder_targets) > 1:
            raise ValueError("归档、垃圾邮件和垃圾箱不能同时设为 true")
        return self


class MailboxReplyRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2_000_000)
    html: str = Field(default="", max_length=2_000_000)
    reply_all: bool = False


class MailboxForwardRequest(BaseModel):
    to: list[EmailStr] = Field(min_length=1, max_length=50)
    cc: list[EmailStr] = Field(default_factory=list, max_length=50)
    text: str = Field(default="", max_length=2_000_000)
    html: str = Field(default="", max_length=2_000_000)
    include_attachments: bool = True


class MailboxSendResponse(BaseModel):
    sent: bool
    message: MailboxMessageDetail
