#!/usr/bin/env python3
"""按 inode + offset 增量导入 nyy.app Nginx JSON 日志。"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path

from app.core.config import get_settings
from app.services.nginx_access_import import import_nginx_records


def _load_state(path: Path) -> dict[str, int]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return {
            "device": int(value.get("device", 0)),
            "inode": int(value.get("inode", 0)),
            "offset": int(value.get("offset", 0)),
            "rotation_eof": int(value.get("rotation_eof", 0)),
        }
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return {"device": 0, "inode": 0, "offset": 0, "rotation_eof": 0}


def _save_state(path: Path, state: dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f"{path.suffix}.tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def _read_file(log_path: Path, offset: int, batch_size: int) -> tuple[list[dict], int, bool]:
    records: list[dict] = []
    committed_offset = offset
    with log_path.open("rb") as stream:
        stream.seek(offset)
        while len(records) < batch_size:
            line_start = stream.tell()
            line = stream.readline()
            if not line:
                return records, committed_offset, True
            if not line.endswith(b"\n"):
                committed_offset = line_start
                break
            committed_offset = stream.tell()
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
    return records, committed_offset, False


def _read_batch(log_path: Path, state_path: Path, batch_size: int) -> tuple[list[dict], dict[str, int]]:
    stat = log_path.stat()
    state = _load_state(state_path)
    same_file = state["device"] == stat.st_dev and state["inode"] == stat.st_ino
    if same_file:
        offset = state["offset"] if state["offset"] <= stat.st_size else 0
        records, committed_offset, _ = _read_file(log_path, offset, batch_size)
        return records, {
            "device": stat.st_dev,
            "inode": stat.st_ino,
            "offset": committed_offset,
            "rotation_eof": 0,
        }

    rotated_path = log_path.with_name(f"{log_path.name}.1")
    if rotated_path.is_file():
        rotated_stat = rotated_path.stat()
        same_rotated_file = state["device"] == rotated_stat.st_dev and state["inode"] == rotated_stat.st_ino
        if same_rotated_file and state["offset"] <= rotated_stat.st_size:
            records, committed_offset, exhausted = _read_file(rotated_path, state["offset"], batch_size)
            if records or len(records) >= batch_size or not exhausted or not state["rotation_eof"]:
                return records, {
                    "device": rotated_stat.st_dev,
                    "inode": rotated_stat.st_ino,
                    "offset": committed_offset,
                    "rotation_eof": int(exhausted and not records),
                }
            current_records, current_offset, _ = _read_file(log_path, 0, batch_size - len(records))
            return records + current_records, {
                "device": stat.st_dev,
                "inode": stat.st_ino,
                "offset": current_offset,
                "rotation_eof": 0,
            }

    records, committed_offset, _ = _read_file(log_path, 0, batch_size)
    return records, {
        "device": stat.st_dev,
        "inode": stat.st_ino,
        "offset": committed_offset,
        "rotation_eof": 0,
    }


async def run(*, dry_run: bool = False) -> tuple[int, int]:
    settings = get_settings()
    log_path = Path(settings.nginx_access_log_path)
    state_path = Path(settings.nginx_access_state_path)
    if not state_path.is_absolute():
        state_path = settings.project_root / state_path
    if not log_path.is_file():
        return 0, 0
    records, next_state = _read_batch(
        log_path,
        state_path,
        max(1, min(settings.nginx_access_import_batch_size, 10_000)),
    )
    imported = 0 if dry_run else await import_nginx_records(records)
    if not dry_run:
        _save_state(state_path, next_state)
    return len(records), imported


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    scanned, imported = asyncio.run(run(dry_run=args.dry_run))
    print(f"扫描 {scanned} 条 Nginx 日志，导入 {imported} 条预解析事件")


if __name__ == "__main__":
    main()
