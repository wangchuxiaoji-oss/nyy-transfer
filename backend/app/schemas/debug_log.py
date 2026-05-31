"""调试日志上报 schemas。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class DebugLogEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    ts: int = Field(..., ge=0)
    elapsed_ms: float = Field(..., alias="elapsedMs", ge=0)
    scope: str = Field(..., min_length=1, max_length=64)
    event: str = Field(..., min_length=1, max_length=128)
    data: dict[str, Any] | None = None
    line: str = Field(..., min_length=1, max_length=8192)


class DebugLogBatch(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    share_code: str = Field(..., alias="shareCode", min_length=4, max_length=32, pattern=r"^[A-Za-z0-9]+$")
    session_id: str = Field(..., alias="sessionId", min_length=8, max_length=80, pattern=r"^[A-Za-z0-9._-]+$")
    page_url: str | None = Field(default=None, alias="pageUrl", max_length=2048)
    user_agent: str | None = Field(default=None, alias="userAgent", max_length=1024)
    reason: str | None = Field(default=None, max_length=64)
    entries: list[DebugLogEntry] = Field(..., min_length=1, max_length=200)
