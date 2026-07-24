"""Nginx JSON 访问日志中的链接预解析识别与入库。"""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from urllib.parse import urlparse

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.db.session import get_session_factory
from app.models.share import Share, ShareAccessEvent, ShareEventIdempotencyKey
from app.services.geoip import lookup_ip_source
from app.services.share_access import classify_share_client

_RESERVED_PATHS = {
    "admin",
    "api",
    "auth",
    "favicon.ico",
    "robots.txt",
    "sitemap.xml",
}
_CLOUD_MARKERS = (
    "alibaba",
    "aliyun",
    "amazon",
    "azure",
    "cloudflare",
    "digitalocean",
    "google cloud",
    "microsoft",
    "oracle",
    "tencent",
    "腾讯云",
)


def extract_share_code(uri: str) -> str | None:
    path = (uri or "").split("?", 1)[0]
    parts = [part for part in path.split("/") if part]
    if len(parts) != 1:
        return None
    code = parts[0]
    if code.lower() in _RESERVED_PATHS or code.startswith("_"):
        return None
    if not 1 <= len(code) <= 16 or not all(char.isalnum() or char in "-_." for char in code):
        return None
    return code


def classify_nginx_preview(record: dict) -> tuple[str, str, str] | None:
    user_agent = str(record.get("user_agent") or "")[:512]
    client_kind, confidence, detector = classify_share_client("preview_fetch", user_agent)
    if client_kind == "preview_bot":
        return client_kind, confidence, detector

    lowered = user_agent.lower()
    if "t7/" in lowered or "micromessenger" in lowered:
        return None
    ip_value = str(record.get("client_ip") or "")
    isp = lookup_ip_source(ip_value).get("isp", "").lower()
    sec_fetch_dest = str(record.get("sec_fetch_dest") or "").lower()
    sec_fetch_mode = str(record.get("sec_fetch_mode") or "").lower()
    sec_fetch_user = str(record.get("sec_fetch_user") or "").lower()
    method = str(record.get("method") or "GET").upper()
    cloud_document_fetch = (
        method in {"GET", "HEAD"}
        and any(marker in isp for marker in _CLOUD_MARKERS)
        and sec_fetch_dest in {"", "document"}
        and sec_fetch_mode in {"", "navigate", "no-cors"}
        and sec_fetch_user not in {"?1", "1"}
    )
    if cloud_document_fetch:
        return "suspected_preview", "medium", "cloud_document_fetch"
    return None


def _occurred_at(value: object) -> datetime:
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
        except ValueError:
            pass
    return datetime.now(UTC)


def _referer_host(value: object) -> str | None:
    try:
        return (urlparse(str(value or "")).hostname or "")[:255] or None
    except ValueError:
        return None


def _request_id(record: dict) -> str:
    request_id = str(record.get("request_id") or "").strip()
    if request_id:
        return request_id[:128]
    canonical = json.dumps(record, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return f"nginx-{hashlib.sha256(canonical.encode()).hexdigest()}"[:128]


async def import_nginx_records(records: list[dict]) -> int:
    candidates: list[tuple[dict, str, tuple[str, str, str]]] = []
    for record in records:
        code = extract_share_code(str(record.get("uri") or ""))
        classification = classify_nginx_preview(record)
        if code and classification:
            candidates.append((record, code, classification))
    if not candidates:
        return 0

    factory = get_session_factory()
    async with factory() as db:
        codes = {code for _record, code, _classification in candidates}
        rows = await db.execute(select(Share.code, Share.id).where(Share.code.in_(codes)))
        share_ids = dict(rows.all())
        imported = 0
        for record, code, (client_kind, confidence, detector) in candidates:
            share_id = share_ids.get(code)
            if not share_id:
                continue
            request_id = _request_id(record)
            occurred_at = _occurred_at(record.get("time"))
            inserted_key = await db.scalar(
                pg_insert(ShareEventIdempotencyKey)
                .values(
                    share_id=share_id,
                    event_type="preview_fetch",
                    request_id=request_id,
                    created_at=occurred_at,
                )
                .on_conflict_do_nothing(constraint="uq_share_event_idempotency")
                .returning(ShareEventIdempotencyKey.id)
            )
            if inserted_key is None:
                continue
            request_time = record.get("request_time")
            try:
                request_time_ms = round(float(request_time) * 1000)
            except (TypeError, ValueError):
                request_time_ms = None
            try:
                http_status = int(record.get("status"))
            except (TypeError, ValueError):
                http_status = None
            db.add(
                ShareAccessEvent(
                    share_id=share_id,
                    event_type="preview_fetch",
                    ip=str(record.get("client_ip") or "") or None,
                    user_agent=str(record.get("user_agent") or "")[:512] or None,
                    referer_host=_referer_host(record.get("referer")),
                    client_kind=client_kind,
                    confidence=confidence,
                    detector=detector,
                    request_id=request_id,
                    http_status=http_status,
                    request_time_ms=request_time_ms,
                    created_at=occurred_at,
                )
            )
            imported += 1
        await db.commit()
        return imported
