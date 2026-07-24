"""客户端播放 sidecar 生成与回填服务。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import zlib
from dataclasses import dataclass
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import flag_modified

from app.db.session import get_session_factory
from app.models.share import Share, ShareLogicalFile
from app.services.doubao_client import get_doubao_client

log = logging.getLogger(__name__)

HEADER_READ_BYTES = 1024 * 1024
RANGE_TIMEOUT_SECONDS = 45
RANGE_FETCH_ATTEMPTS = 3
RANGE_FETCH_CHUNK_BYTES = 2 * 1024 * 1024


@dataclass
class Box:
    type: str
    offset: int
    size: int
    header_size: int


@dataclass
class SingleObjectMedia:
    original_name: str
    size: int
    tos_uri: str
    media_metadata: dict[str, Any] | None


def read_u32(data: bytes | bytearray, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 4], "big")


def write_u32(data: bytearray, offset: int, value: int) -> None:
    data[offset:offset + 4] = value.to_bytes(4, "big")


def read_u64(data: bytes | bytearray, offset: int) -> int:
    return int.from_bytes(data[offset:offset + 8], "big")


def write_u64(data: bytearray, offset: int, value: int) -> None:
    data[offset:offset + 8] = value.to_bytes(8, "big")


def read_type(data: bytes | bytearray, offset: int) -> str:
    return bytes(data[offset:offset + 4]).decode("ascii", errors="replace")


def parse_box(data: bytes | bytearray, offset: int, limit: int, *, require_complete: bool = True) -> Box | None:
    if offset + 8 > min(len(data), limit):
        return None
    size32 = read_u32(data, offset)
    box_type = read_type(data, offset + 4)
    header_size = 8
    if size32 == 1:
        if offset + 16 > min(len(data), limit):
            return None
        size = read_u64(data, offset + 8)
        header_size = 16
    elif size32 == 0:
        size = limit - offset
    else:
        size = size32
    if size < header_size:
        return None
    if require_complete and offset + size > limit:
        return None
    return Box(box_type, offset, size, header_size)


def parse_top_level_boxes(head: bytes, file_size: int) -> list[Box]:
    boxes: list[Box] = []
    offset = 0
    for _ in range(256):
        box = parse_box(head, offset, file_size, require_complete=False)
        if not box:
            break
        boxes.append(box)
        offset += box.size
        if box.type == "mdat" or offset >= len(head):
            break
    return boxes


CONTAINER_BOXES = {"moov", "trak", "mdia", "minf", "stbl", "edts", "dinf"}


def patch_chunk_offsets(
    moov: bytes,
    *,
    delta: int,
    media_source_start: int,
    media_source_end: int,
) -> tuple[bytes, dict[str, int]]:
    data = bytearray(moov)
    stats = {"stco_boxes": 0, "co64_boxes": 0, "entries": 0}

    def patch_stco(box: Box) -> None:
        content = box.offset + box.header_size
        if content + 8 > box.offset + box.size:
            return
        entry_count = read_u32(data, content + 4)
        table_start = content + 8
        if table_start + entry_count * 4 > box.offset + box.size:
            raise ValueError("stco entry table exceeds box size")
        stats["stco_boxes"] += 1
        for i in range(entry_count):
            pos = table_start + i * 4
            value = read_u32(data, pos)
            if media_source_start <= value < media_source_end:
                patched = value + delta
                if patched > 0xFFFFFFFF:
                    raise ValueError("patched stco offset overflows 32-bit; co64 conversion required")
                write_u32(data, pos, patched)
                stats["entries"] += 1

    def patch_co64(box: Box) -> None:
        content = box.offset + box.header_size
        if content + 8 > box.offset + box.size:
            return
        entry_count = read_u32(data, content + 4)
        table_start = content + 8
        if table_start + entry_count * 8 > box.offset + box.size:
            raise ValueError("co64 entry table exceeds box size")
        stats["co64_boxes"] += 1
        for i in range(entry_count):
            pos = table_start + i * 8
            value = read_u64(data, pos)
            if media_source_start <= value < media_source_end:
                write_u64(data, pos, value + delta)
                stats["entries"] += 1

    def walk(start: int, end: int) -> None:
        offset = start
        guard = 0
        while offset + 8 <= end and guard < 100000:
            guard += 1
            box = parse_box(data, offset, end)
            if not box:
                break
            if box.type == "stco":
                patch_stco(box)
            elif box.type == "co64":
                patch_co64(box)
            elif box.type in CONTAINER_BOXES:
                walk(box.offset + box.header_size, box.offset + box.size)
            offset += box.size

    root = parse_box(data, 0, len(data))
    if not root or root.type != "moov":
        raise ValueError("moov sidecar source is not a moov box")
    walk(root.header_size, root.size)
    if stats["entries"] == 0:
        raise ValueError("no chunk offsets patched in moov")
    return bytes(data), stats


def list_child_boxes(data: bytes | bytearray, parent: Box) -> list[Box]:
    boxes: list[Box] = []
    offset = parent.offset + parent.header_size
    limit = parent.offset + parent.size
    guard = 0
    while offset + 8 <= limit and guard < 100000:
        guard += 1
        box = parse_box(data, offset, limit)
        if not box:
            break
        boxes.append(box)
        offset += box.size
    return boxes


def find_child_box(data: bytes | bytearray, parent: Box, box_type: str) -> Box | None:
    for child in list_child_boxes(data, parent):
        if child.type == box_type:
            return child
    return None


def parse_trak_handler_type(moov: bytes, trak: Box) -> str | None:
    mdia = find_child_box(moov, trak, "mdia")
    if not mdia:
        return None
    hdlr = find_child_box(moov, mdia, "hdlr")
    if not hdlr:
        return None
    content = hdlr.offset + hdlr.header_size
    if content + 12 > len(moov):
        return None
    return read_type(moov, content + 8)


def rewrite_box_size(header: bytearray, size: int) -> bytearray:
    if len(header) < 8:
        raise ValueError("box header too short")
    size32 = read_u32(header, 0)
    if size32 == 1:
        if len(header) < 16:
            raise ValueError("extended-size box header too short")
        write_u64(header, 8, size)
    else:
        if size > 0xFFFFFFFF:
            raise ValueError("box size exceeds 32-bit but source box is not extended")
        write_u32(header, 0, size)
    return header


def build_video_only_moov(moov: bytes) -> bytes:
    root = parse_box(moov, 0, len(moov))
    if not root or root.type != "moov":
        raise ValueError("video-only sidecar source is not a moov box")

    parts: list[bytes] = []
    video_traks = 0
    for child in list_child_boxes(moov, root):
        if child.type != "trak":
            parts.append(moov[child.offset:child.offset + child.size])
            continue
        handler_type = parse_trak_handler_type(moov, child)
        if handler_type == "vide":
            parts.append(moov[child.offset:child.offset + child.size])
            video_traks += 1
    if video_traks == 0:
        raise ValueError("no video trak found in moov")

    header = rewrite_box_size(bytearray(moov[:root.header_size]), root.header_size + sum(len(part) for part in parts))
    return bytes(header) + b"".join(parts)


async def fetch_range(url: str, start: int, end_exclusive: int) -> bytes:
    if start >= end_exclusive:
        return b""
    if end_exclusive - start > RANGE_FETCH_CHUNK_BYTES:
        parts: list[bytes] = []
        offset = start
        while offset < end_exclusive:
            next_end = min(end_exclusive, offset + RANGE_FETCH_CHUNK_BYTES)
            parts.append(await fetch_range(url, offset, next_end))
            offset = next_end
        return b"".join(parts)
    headers = {"Range": f"bytes={start}-{end_exclusive - 1}"}
    last_error: Exception | None = None
    for attempt in range(1, RANGE_FETCH_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=RANGE_TIMEOUT_SECONDS, follow_redirects=True) as client:
                resp = await client.get(url, headers=headers)
                if resp.status_code not in (200, 206):
                    raise RuntimeError(f"Range fetch failed: HTTP {resp.status_code}")
                return resp.content
        except Exception as exc:
            last_error = exc
            log.warning(
                "range fetch attempt %d/%d failed bytes=%d-%d: %s",
                attempt,
                RANGE_FETCH_ATTEMPTS,
                start,
                end_exclusive - 1,
                repr(exc),
            )
            if attempt < RANGE_FETCH_ATTEMPTS:
                await asyncio.sleep(1.5 * attempt)
    raise RuntimeError(f"Range fetch failed after {RANGE_FETCH_ATTEMPTS} attempts: {last_error!r}")


async def upload_sidecar(data: bytes, *, file_ext: str = "mp4", client: Any | None = None) -> tuple[str, str]:
    active_client = client or await get_doubao_client()
    init = await active_client.init_upload(len(data), file_ext=file_ext)
    crc32 = f"{zlib.crc32(data) & 0xffffffff:08x}"
    async with httpx.AsyncClient(timeout=RANGE_TIMEOUT_SECONDS) as http:
        resp = await http.post(
            init.upload_url,
            content=data,
            headers={"Authorization": init.authorization, "Content-CRC32": crc32},
        )
        if resp.status_code < 200 or resp.status_code >= 300:
            raise RuntimeError(f"sidecar upload failed: HTTP {resp.status_code} {resp.text[:200]}")
    commit = await active_client.commit_upload(
        init.service_id,
        init.session_key,
        init.access_key,
        init.secret_key,
        init.session_token,
    )
    return commit.store_uri or init.store_uri, crc32


def existing_asset(metadata: dict[str, Any], kind: str) -> dict[str, Any] | None:
    assets = metadata.get("playback_assets")
    if not isinstance(assets, list):
        return None
    for asset in assets:
        if isinstance(asset, dict) and asset.get("kind") == kind:
            return asset
    return None


def upsert_asset(metadata: dict[str, Any], asset: dict[str, Any]) -> None:
    assets = metadata.get("playback_assets")
    if not isinstance(assets, list):
        assets = []
        metadata["playback_assets"] = assets
    kind = asset.get("kind")
    assets[:] = [item for item in assets if not (isinstance(item, dict) and item.get("kind") == kind)]
    assets.append(asset)


def has_ac3_audio(metadata: dict[str, Any]) -> bool:
    tracks = metadata.get("audio_tracks") or []
    return any(
        str(track.get("codec") or track.get("codec_tag") or "").lower() in {"ac-3", "ac3"}
        for track in tracks
        if isinstance(track, dict)
    )


def parse_box_header_at(data: bytes, file_offset: int, file_size: int) -> Box | None:
    if len(data) < 8:
        return None
    size32 = read_u32(data, 0)
    box_type = read_type(data, 4)
    header_size = 8
    if size32 == 1:
        if len(data) < 16:
            return None
        size = read_u64(data, 8)
        header_size = 16
    elif size32 == 0:
        size = file_size - file_offset
    else:
        size = size32
    if size < header_size or file_offset + size > file_size:
        return None
    return Box(box_type, file_offset, size, header_size)


async def find_top_level_box_after(url: str, *, start: int, file_size: int, box_type: str) -> Box | None:
    offset = start
    for _ in range(32):
        if offset + 8 > file_size:
            return None
        header = await fetch_range(url, offset, min(file_size, offset + 16))
        box = parse_box_header_at(header, offset, file_size)
        if not box:
            return None
        if box.type == box_type:
            return box
        offset += box.size
    return None


async def ensure_mp4_layout_metadata(
    metadata: dict[str, Any],
    media: SingleObjectMedia,
    *,
    client: Any | None = None,
) -> tuple[dict[str, Any], bool]:
    if metadata.get("container") != "mp4" or metadata.get("probe_status") != "ok":
        return metadata, False
    if int(metadata.get("moov_offset") or 0) > 0 and int(metadata.get("moov_size") or 0) > 0:
        return metadata, False

    active_client = client or await get_doubao_client()
    url = await active_client.get_download_url(media.tos_uri, expire_seconds=86400)
    head = await fetch_range(url, 0, min(HEADER_READ_BYTES, media.size))
    top_boxes = parse_top_level_boxes(head, media.size)
    moov = next((box for box in top_boxes if box.type == "moov"), None)
    mdat = next((box for box in top_boxes if box.type == "mdat"), None)
    if not moov and mdat:
        moov = await find_top_level_box_after(url, start=mdat.offset + mdat.size, file_size=media.size, box_type="moov")
    if not moov:
        return metadata, False

    next_metadata = dict(metadata)
    next_metadata["moov_offset"] = moov.offset
    next_metadata["moov_size"] = moov.size
    if mdat:
        next_metadata["is_faststart"] = moov.offset < mdat.offset
    return next_metadata, True


async def build_faststart_asset_for_media(
    media: SingleObjectMedia,
    *,
    dry_run: bool,
    force: bool,
    client: Any | None = None,
) -> dict[str, Any] | None:
    metadata = dict(media.media_metadata or {})
    if metadata.get("container") != "mp4" or metadata.get("probe_status") != "ok":
        return None
    if metadata.get("is_faststart") is not False:
        return None
    if existing_asset(metadata, "mp4_faststart_init") and not force:
        log.info("skip existing faststart sidecar: %s", media.original_name)
        return None

    moov_offset = int(metadata.get("moov_offset") or 0)
    moov_size = int(metadata.get("moov_size") or 0)
    if moov_offset <= 0 or moov_size <= 0:
        log.warning("skip missing moov info: %s", media.original_name)
        return None

    active_client = client or await get_doubao_client()
    url = await active_client.get_download_url(media.tos_uri, expire_seconds=86400)

    head = await fetch_range(url, 0, min(HEADER_READ_BYTES, media.size))
    top_boxes = parse_top_level_boxes(head, media.size)
    ftyp = next((box for box in top_boxes if box.type == "ftyp"), None)
    first_mdat = next((box for box in top_boxes if box.type == "mdat"), None)
    if not ftyp or not first_mdat:
        raise RuntimeError(f"ftyp/mdat not found in head: {media.original_name}")

    ftyp_bytes = head[ftyp.offset:ftyp.offset + ftyp.size]
    moov_bytes = await fetch_range(url, moov_offset, moov_offset + moov_size)
    sidecar_size = len(ftyp_bytes) + len(moov_bytes)
    source_media_start = first_mdat.offset
    source_media_end = moov_offset
    delta = sidecar_size - source_media_start
    patched_moov, patch_stats = patch_chunk_offsets(
        moov_bytes,
        delta=delta,
        media_source_start=source_media_start,
        media_source_end=source_media_end,
    )
    sidecar = ftyp_bytes + patched_moov
    sha256 = hashlib.sha256(sidecar).hexdigest()

    asset = {
        "kind": "mp4_faststart_init",
        "version": 1,
        "size": len(sidecar),
        "content_type": "video/mp4",
        "sha256": sha256,
        "virtual_size": len(sidecar) + (source_media_end - source_media_start),
        "sidecar_size": len(sidecar),
        "source_media_start": source_media_start,
        "source_media_end": source_media_end,
        "offset_delta": delta,
        "patch_stats": patch_stats,
    }
    if dry_run:
        log.info("dry-run sidecar %s: %s", media.original_name, json.dumps(asset, ensure_ascii=False))
        return asset

    store_uri, crc32 = await upload_sidecar(sidecar, file_ext="mp4", client=active_client)
    asset["store_uri"] = store_uri
    asset["crc32"] = crc32
    log.info("uploaded sidecar %s -> %s (%d bytes)", media.original_name, store_uri, len(sidecar))
    return asset


async def build_video_only_asset_for_media(
    media: SingleObjectMedia,
    *,
    dry_run: bool,
    force: bool,
    client: Any | None = None,
) -> dict[str, Any] | None:
    metadata = dict(media.media_metadata or {})
    if metadata.get("container") != "mp4" or metadata.get("probe_status") != "ok":
        return None
    if not has_ac3_audio(metadata):
        return None
    if existing_asset(metadata, "mp4_video_only_init") and not force:
        log.info("skip existing video-only sidecar: %s", media.original_name)
        return None

    moov_offset = int(metadata.get("moov_offset") or 0)
    moov_size = int(metadata.get("moov_size") or 0)
    if moov_size <= 0:
        log.warning("skip missing moov info: %s", media.original_name)
        return None

    active_client = client or await get_doubao_client()
    url = await active_client.get_download_url(media.tos_uri, expire_seconds=86400)

    head = await fetch_range(url, 0, min(HEADER_READ_BYTES, media.size))
    top_boxes = parse_top_level_boxes(head, media.size)
    ftyp = next((box for box in top_boxes if box.type == "ftyp"), None)
    if not ftyp:
        raise RuntimeError(f"ftyp not found in head: {media.original_name}")

    ftyp_bytes = head[ftyp.offset:ftyp.offset + ftyp.size]
    moov_bytes = await fetch_range(url, moov_offset, moov_offset + moov_size)
    video_only_moov = build_video_only_moov(moov_bytes)
    sidecar_size = len(ftyp_bytes) + len(video_only_moov)
    source_media_start = moov_offset + moov_size if metadata.get("is_faststart") else next((box.offset for box in top_boxes if box.type == "mdat"), None)
    if source_media_start is None:
        raise RuntimeError(f"mdat start not found: {media.original_name}")
    source_media_end = moov_offset if metadata.get("is_faststart") is False else media.size
    delta = sidecar_size - source_media_start
    patched_moov, patch_stats = patch_chunk_offsets(
        video_only_moov,
        delta=delta,
        media_source_start=source_media_start,
        media_source_end=source_media_end,
    )
    sidecar = ftyp_bytes + patched_moov
    sha256 = hashlib.sha256(sidecar).hexdigest()

    asset = {
        "kind": "mp4_video_only_init",
        "version": 1,
        "size": len(sidecar),
        "content_type": "video/mp4",
        "sha256": sha256,
        "virtual_size": len(sidecar) + (source_media_end - source_media_start),
        "sidecar_size": len(sidecar),
        "source_media_start": source_media_start,
        "source_media_end": source_media_end,
        "offset_delta": delta,
        "patch_stats": patch_stats,
    }
    if dry_run:
        log.info("dry-run video-only sidecar %s: %s", media.original_name, json.dumps(asset, ensure_ascii=False))
        return asset

    store_uri, crc32 = await upload_sidecar(sidecar, file_ext="mp4", client=active_client)
    asset["store_uri"] = store_uri
    asset["crc32"] = crc32
    log.info("uploaded video-only sidecar %s -> %s (%d bytes)", media.original_name, store_uri, len(sidecar))
    return asset


async def attach_playback_assets_for_single_object(
    *,
    metadata: dict[str, Any] | None,
    original_name: str,
    size: int,
    tos_uri: str,
    client: Any | None = None,
    force: bool = False,
) -> dict[str, Any] | None:
    """为单对象 MP4 自动补充播放 sidecar；失败不抛给上传主流程。"""

    if not metadata:
        return metadata
    next_metadata = dict(metadata)
    media = SingleObjectMedia(original_name=original_name, size=size, tos_uri=tos_uri, media_metadata=next_metadata)
    try:
        next_metadata, changed = await ensure_mp4_layout_metadata(next_metadata, media, client=client)
    except Exception as exc:
        log.warning("failed to recover mp4 layout for %s: %s", original_name, exc)
        changed = False
    media = SingleObjectMedia(original_name=original_name, size=size, tos_uri=tos_uri, media_metadata=next_metadata)

    try:
        asset = await build_faststart_asset_for_media(media, dry_run=False, force=force, client=client)
    except Exception as exc:
        log.warning("failed to build faststart sidecar for %s: %s", original_name, exc)
        asset = None
    if asset:
        hints = dict(next_metadata.get("playback_hints") or {})
        hints["needs_virtual_faststart"] = True
        next_metadata["playback_hints"] = hints
        upsert_asset(next_metadata, asset)
        changed = True

    media.media_metadata = next_metadata
    try:
        video_only_asset = await build_video_only_asset_for_media(media, dry_run=False, force=force, client=client)
    except Exception as exc:
        log.warning("failed to build video-only sidecar for %s: %s", original_name, exc)
        video_only_asset = None
    if video_only_asset:
        hints = dict(next_metadata.get("playback_hints") or {})
        hints["has_video_only_virtual"] = True
        next_metadata["playback_hints"] = hints
        upsert_asset(next_metadata, video_only_asset)
        changed = True

    return next_metadata if changed else metadata


async def build_faststart_asset(logical_file: ShareLogicalFile, *, dry_run: bool, force: bool) -> dict[str, Any] | None:
    if len(logical_file.files) != 1:
        log.warning("skip non-single-object mp4 for now: %s", logical_file.original_name)
        return None
    share_file = logical_file.files[0]
    media = SingleObjectMedia(
        original_name=logical_file.original_name,
        size=logical_file.size,
        tos_uri=share_file.tos_uri,
        media_metadata=logical_file.media_metadata,
    )
    return await build_faststart_asset_for_media(media, dry_run=dry_run, force=force)


async def build_video_only_asset(logical_file: ShareLogicalFile, *, dry_run: bool, force: bool) -> dict[str, Any] | None:
    if len(logical_file.files) != 1:
        log.warning("skip non-single-object AC-3 mp4 for now: %s", logical_file.original_name)
        return None
    share_file = logical_file.files[0]
    media = SingleObjectMedia(
        original_name=logical_file.original_name,
        size=logical_file.size,
        tos_uri=share_file.tos_uri,
        media_metadata=logical_file.media_metadata,
    )
    return await build_video_only_asset_for_media(media, dry_run=dry_run, force=force)


async def backfill_share_playback_assets(code: str, *, dry_run: bool, force: bool) -> int:
    factory = get_session_factory()
    async with factory() as db:
        share = await db.scalar(
            select(Share)
            .options(selectinload(Share.logical_files).selectinload(ShareLogicalFile.files))
            .where(Share.code == code)
        )
        if not share:
            raise ValueError(f"share not found: {code}")

        changed = 0
        for logical_file in sorted(share.logical_files, key=lambda item: item.sort_index):
            metadata = dict(logical_file.media_metadata or {})
            layout_changed = False
            if len(logical_file.files) == 1:
                share_file = logical_file.files[0]
                media = SingleObjectMedia(
                    original_name=logical_file.original_name,
                    size=logical_file.size,
                    tos_uri=share_file.tos_uri,
                    media_metadata=metadata,
                )
                try:
                    metadata, layout_changed = await ensure_mp4_layout_metadata(metadata, media)
                except Exception as exc:
                    log.error("failed layout recovery %s: %s", logical_file.original_name, exc)
                    layout_changed = False
                if layout_changed:
                    logical_file.media_metadata = metadata
            asset = None
            try:
                asset = await build_faststart_asset(logical_file, dry_run=dry_run, force=force)
            except Exception as exc:
                log.error("failed %s: %s", logical_file.original_name, exc)
            if asset:
                hints = dict(metadata.get("playback_hints") or {})
                hints["needs_virtual_faststart"] = True
                metadata["playback_hints"] = hints
                if not dry_run:
                    upsert_asset(metadata, asset)
                changed += 1

            video_only_asset = None
            try:
                video_only_asset = await build_video_only_asset(logical_file, dry_run=dry_run, force=force)
            except Exception as exc:
                log.error("failed video-only %s: %s", logical_file.original_name, exc)
            if video_only_asset:
                hints = dict(metadata.get("playback_hints") or {})
                hints["has_video_only_virtual"] = True
                metadata["playback_hints"] = hints
                if not dry_run:
                    upsert_asset(metadata, video_only_asset)
                changed += 1

            if not dry_run and (asset or video_only_asset or layout_changed):
                logical_file.media_metadata = metadata
                flag_modified(logical_file, "media_metadata")

        if dry_run:
            log.info("dry-run complete: %d asset(s) would be updated", changed)
        else:
            await db.commit()
            log.info("backfill complete: %d asset(s) updated", changed)
        return changed
