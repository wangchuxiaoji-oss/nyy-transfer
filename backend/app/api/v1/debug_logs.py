"""前端调试日志落盘接口。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request, status

from app.core.config import get_settings
from app.schemas.debug_log import DebugLogBatch
from app.services.debug_log_store import append_debug_log_batch
from app.utils.short_code import is_valid_code

router = APIRouter(prefix="/debug", tags=["debug"])


@router.post("/logs", status_code=status.HTTP_202_ACCEPTED)
async def ingest_debug_logs(payload: DebugLogBatch, request: Request) -> dict[str, Any]:
    """Append client debug events to a local NDJSON file."""

    settings = get_settings()
    if not (settings.is_dev or settings.debug_log_ingest_enabled):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "debug log ingestion disabled")
    if not is_valid_code(payload.share_code, settings.short_code_length):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid share code")

    client_host = request.client.host if request.client else None
    return append_debug_log_batch(settings, payload, client_host)
