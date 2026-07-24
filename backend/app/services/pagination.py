"""管理员列表使用的稳定游标。"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from datetime import datetime
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import and_, or_


@dataclass(frozen=True)
class CreatedCursor:
    created_at: datetime
    row_id: UUID


def encode_created_cursor(created_at: datetime, row_id: UUID) -> str:
    payload = json.dumps(
        {"created_at": created_at.isoformat(), "id": str(row_id)},
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def decode_created_cursor(value: str | None) -> CreatedCursor | None:
    if not value:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
        return CreatedCursor(
            created_at=datetime.fromisoformat(payload["created_at"]),
            row_id=UUID(payload["id"]),
        )
    except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(400, "分页游标无效") from exc


def created_cursor_filter(created_column, id_column, cursor: CreatedCursor, *, after: bool):
    if after:
        return or_(
            created_column < cursor.created_at,
            and_(created_column == cursor.created_at, id_column < cursor.row_id),
        )
    return or_(
        created_column > cursor.created_at,
        and_(created_column == cursor.created_at, id_column > cursor.row_id),
    )
