"""前端调试日志落盘工具。"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import Settings
from app.schemas.debug_log import DebugLogBatch

SAFE_SEGMENT_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_segment(value: str, fallback: str = "unknown") -> str:
    cleaned = SAFE_SEGMENT_RE.sub("_", value).strip("._-")
    if not cleaned:
        return fallback
    return cleaned[:128]


def get_debug_log_root(settings: Settings) -> Path:
    if settings.debug_log_dir:
        return Path(settings.debug_log_dir).expanduser()
    return settings.project_root / "runtime" / "debug-logs"


def append_debug_log_batch(
    settings: Settings,
    payload: DebugLogBatch,
    client_host: str | None,
) -> dict[str, Any]:
    root_dir = get_debug_log_root(settings)
    session_dir = root_dir / _safe_segment(payload.share_code) / _safe_segment(payload.session_id)
    session_dir.mkdir(parents=True, exist_ok=True)

    log_path = session_dir / "events.ndjson"
    summary_path = session_dir / "summary.json"
    received_at = datetime.now(timezone.utc).isoformat()

    with log_path.open("a", encoding="utf-8") as file:
        for entry in payload.entries:
            record = {
                "receivedAt": received_at,
                "shareCode": payload.share_code,
                "sessionId": payload.session_id,
                "pageUrl": payload.page_url,
                "userAgent": payload.user_agent,
                "reason": payload.reason,
                "clientHost": client_host,
                **entry.model_dump(by_alias=True),
            }
            file.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    summary = {
        "shareCode": payload.share_code,
        "sessionId": payload.session_id,
        "lastReceivedAt": received_at,
        "lastReason": payload.reason,
        "lastBatchSize": len(payload.entries),
        "pageUrl": payload.page_url,
        "userAgent": payload.user_agent,
        "clientHost": client_host,
        "logPath": str(log_path),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")

    return {"ok": True, "entries": len(payload.entries), "path": str(log_path), "summary_path": str(summary_path)}
