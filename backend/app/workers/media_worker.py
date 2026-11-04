"""图片派生资产处理 Worker。"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import io
import json
import logging
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from sqlalchemy import delete, select, update
from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import flag_modified

from app.db.base import utcnow
from app.db.session import dispose_engine, get_session_factory
from app.models.media import MediaObjectCleanupJob, MediaProcessingJob, ShareMediaAsset
from app.models.share import ShareLogicalFile
from app.services.doubao_client import (
    DoubaoDownloadUrlResolver,
    get_doubao_client,
    shutdown_doubao_client,
)
from app.services.media_jobs import (
    MEDIA_PROCESSING_VERSION,
    claim_next_job,
    dequeue_media_object_cleanup,
    is_supported_image,
    mark_job_failed,
    mark_job_succeeded,
    mark_job_unsupported,
    queue_media_object_cleanup,
    upsert_media_asset,
)
from app.services.playback_assets import upload_sidecar

log = logging.getLogger(__name__)

RAW_EXTENSIONS = frozenset({"dng", "cr3", "cr2", "nef", "arw", "raf", "rw2", "orf", "pef"})
DERIVATIVE_SIZES = (
    ("thumbnail_480", 480),
    ("thumbnail_960", 960),
    ("preview_2048", 2048),
)
EXIFTOOL_TIMEOUT_SECONDS = 15
EXIFTOOL_OUTPUT_LIMIT = 16 * 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
RENDER_TIMEOUT_SECONDS = 300
MAX_ANIMATION_FRAMES = 240
MAX_ANIMATION_SOURCE_PIXELS = 500_000_000
MAX_ANIMATION_RENDER_PIXELS = 180_000_000
MAX_ANIMATION_DERIVATIVE_BYTES = 96 * 1024 * 1024
MAX_MEDIA_SOURCE_BYTES = 1024 * 1024 * 1024


class UnsupportedMediaError(Exception):
    """源文件不是当前处理器可解码的受支持图片。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class _LimitedBytesIO(io.BytesIO):
    def __init__(self, limit: int) -> None:
        super().__init__()
        self.limit = limit

    def write(self, data: bytes) -> int:
        if max(len(self.getbuffer()), self.tell() + len(data)) > self.limit:
            raise UnsupportedMediaError("animation_too_large", "动画派生文件超过体积上限")
        return super().write(data)


@dataclass(frozen=True)
class DerivativePayload:
    kind: str
    format: str
    content_type: str
    data: bytes
    width: int
    height: int


@dataclass(frozen=True)
class ProcessedImage:
    width: int
    height: int
    format: str
    is_animated: bool
    frame_count: int
    derivatives: tuple[DerivativePayload, ...]


@dataclass(frozen=True)
class UploadedAsset:
    kind: str
    format: str
    content_type: str
    store_uri: str
    width: int | None
    height: int | None
    byte_size: int
    checksum: str


def _extension(filename: str) -> str:
    basename = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    return basename.rsplit(".", 1)[-1].lower() if "." in basename else ""


def _tag_name(key: object) -> str:
    value = str(key)
    if "]" in value:
        value = value.rsplit("]", 1)[-1]
    return value.rsplit(":", 1)[-1]


def _first_tag(tags: dict[str, Any], names: tuple[str, ...]) -> Any | None:
    wanted = set(names)
    for key, value in tags.items():
        if _tag_name(key) in wanted and value not in (None, ""):
            return value
    return None


def build_exif_summary(tags: dict[str, Any]) -> dict[str, Any]:
    """提取画廊常用且可直接展示的 EXIF 摘要。"""

    fields = (
        ("Make", ("Make",)),
        ("Model", ("Model",)),
        ("Lens", ("Lens", "LensModel", "LensID")),
        ("ExposureTime", ("ExposureTime",)),
        ("FNumber", ("FNumber",)),
        ("ISO", ("ISO", "ISOSetting")),
        ("FocalLength", ("FocalLength",)),
        ("DateTimeOriginal", ("DateTimeOriginal", "CreateDate")),
        ("GPSLatitude", ("GPSLatitude",)),
        ("GPSLongitude", ("GPSLongitude",)),
    )
    summary: dict[str, Any] = {}
    for output_name, source_names in fields:
        value = _first_tag(tags, source_names)
        if value is not None:
            summary[output_name] = value
    return summary


def _read_exif(path: Path) -> tuple[bytes, dict[str, Any]]:
    import resource

    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        process = subprocess.Popen(
            [
                "exiftool",
                "-j",
                "-G1:4",
                "-a",
                "-s",
                "-n",
                "-struct",
                "-u",
                "--binary",
                str(path),
            ],
            stdin=subprocess.DEVNULL,
            stdout=stdout_file,
            stderr=stderr_file,
        )
        resource.prlimit(
            process.pid,
            resource.RLIMIT_FSIZE,
            (EXIFTOOL_OUTPUT_LIMIT, EXIFTOOL_OUTPUT_LIMIT),
        )
        try:
            process.wait(timeout=EXIFTOOL_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            process.wait()
            raise RuntimeError("ExifTool 处理超时") from exc
        stdout_file.seek(0)
        output = stdout_file.read(EXIFTOOL_OUTPUT_LIMIT + 1)
        stderr_file.seek(0)
        error_output = stderr_file.read(4096).decode("utf-8", errors="replace")
    if len(output) >= EXIFTOOL_OUTPUT_LIMIT:
        raise RuntimeError("ExifTool 输出超过上限")
    if process.returncode != 0:
        raise RuntimeError(f"ExifTool 执行失败: {error_output[:1000]}")
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError("ExifTool 返回了无效 JSON") from exc
    if not isinstance(payload, list) or not payload or not isinstance(payload[0], dict):
        raise RuntimeError("ExifTool 未返回图片元数据")
    return output, payload[0]


def _load_image(path: Path, pyvips: Any) -> Any:
    try:
        return pyvips.Image.new_from_file(
            str(path),
            access="random",
            fail_on="error",
        ).autorot()
    except Exception as exc:
        raise UnsupportedMediaError("decode_failed", f"图片无法解码: {exc}") from exc


def _to_srgb_uchar(image: Any) -> Any:
    if image.interpretation != "srgb":
        image = image.colourspace("srgb")
    if image.format == "ushort":
        image = image.cast("uchar", shift=True)
    elif image.format in {"float", "double"}:
        image = (image * 255).cast("uchar")
    elif image.format != "uchar":
        image = image.cast("uchar")
    return image


def _detect_format(tags: dict[str, Any], extension: str) -> str:
    detected = _first_tag(tags, ("FileType",))
    value = str(detected or extension).lower()
    return "jpeg" if value in {"jpg", "jpeg"} else value


def _validate_animation_limits(width: int, height: int, frame_count: int) -> None:
    if frame_count > MAX_ANIMATION_FRAMES:
        raise UnsupportedMediaError(
            "animation_too_large",
            f"动画帧数超过上限: {frame_count}/{MAX_ANIMATION_FRAMES}",
        )
    if width * height * frame_count > MAX_ANIMATION_SOURCE_PIXELS:
        raise UnsupportedMediaError("animation_too_large", "动画源像素总量超过上限")
    scale = min(1.0, 2048 / max(width, height))
    rendered_pixels = max(1, round(width * scale)) * max(1, round(height * scale))
    if rendered_pixels * frame_count > MAX_ANIMATION_RENDER_PIXELS:
        raise UnsupportedMediaError("animation_too_large", "动画预览像素总量超过上限")


def _render_raw_derivatives(
    path: Path,
    extension: str,
    tags: dict[str, Any],
) -> ProcessedImage:
    import rawpy
    from PIL import Image, ImageOps

    with rawpy.imread(str(path)) as raw:
        source_width = int(getattr(raw.sizes, "width", 0) or 0)
        source_height = int(getattr(raw.sizes, "height", 0) or 0)
        try:
            rendered = raw.postprocess(
                half_size=True,
                use_camera_wb=True,
                output_color=rawpy.ColorSpace.sRGB,
                output_bps=8,
            )
            image = Image.fromarray(rendered).convert("RGB")
        except Exception as decode_error:
            try:
                with rawpy.imread(str(path)) as thumbnail_source:
                    thumbnail = thumbnail_source.extract_thumb()
                if thumbnail.format == rawpy.ThumbFormat.JPEG:
                    with Image.open(io.BytesIO(thumbnail.data)) as embedded:
                        image = ImageOps.exif_transpose(embedded).convert("RGB")
                elif thumbnail.format == rawpy.ThumbFormat.BITMAP:
                    image = Image.fromarray(thumbnail.data).convert("RGB")
                else:
                    raise ValueError(f"未知内嵌预览格式: {thumbnail.format}")
            except Exception as thumbnail_error:
                raise UnsupportedMediaError(
                    "decode_failed",
                    f"RAW 图片无法解码: {decode_error}",
                ) from thumbnail_error
    width = source_width or image.width * 2
    height = source_height or image.height * 2
    if (width > height) != (image.width > image.height):
        width, height = height, width
    preview = image.copy()
    preview.thumbnail((2048, 2048), Image.Resampling.LANCZOS)

    derivatives: list[DerivativePayload] = []
    for kind, edge in DERIVATIVE_SIZES:
        target = preview.copy()
        if edge != 2048:
            target.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        webp_output = io.BytesIO()
        target.save(webp_output, format="WEBP", quality=82)
        derivatives.append(
            DerivativePayload(
                kind=kind,
                format="webp",
                content_type="image/webp",
                data=webp_output.getvalue(),
                width=target.width,
                height=target.height,
            )
        )
    return ProcessedImage(
        width=width,
        height=height,
        format=_detect_format(tags, extension),
        is_animated=False,
        frame_count=1,
        derivatives=tuple(derivatives),
    )


def _render_animated_derivatives(
    path: Path,
    extension: str,
    tags: dict[str, Any],
) -> ProcessedImage | None:
    from PIL import Image, ImageOps

    try:
        source = Image.open(path)
    except Exception:
        return None

    with source:
        frame_count = int(getattr(source, "n_frames", 1))
        if frame_count <= 1:
            return None
        source.seek(0)
        first_frame = ImageOps.exif_transpose(source.copy())
        width, height = first_frame.size
        loop = int(source.info.get("loop", 0) or 0)
        _validate_animation_limits(width, height, frame_count)

    derivatives: list[DerivativePayload] = []
    try:
        for kind, edge in DERIVATIVE_SIZES:
            frames = []
            durations: list[int] = []
            with Image.open(path) as animation:
                for frame_index in range(frame_count):
                    animation.seek(frame_index)
                    frame = ImageOps.exif_transpose(animation.copy()).convert("RGBA")
                    frame.thumbnail((edge, edge), Image.Resampling.LANCZOS)
                    frames.append(frame)
                    durations.append(max(10, int(animation.info.get("duration", 100) or 100)))
            output = _LimitedBytesIO(MAX_ANIMATION_DERIVATIVE_BYTES)
            frames[0].save(
                output,
                format="WEBP",
                save_all=True,
                append_images=frames[1:],
                duration=durations,
                loop=loop,
                quality=82,
                method=4,
            )
            derivatives.append(
                DerivativePayload(
                    kind=kind,
                    format="webp",
                    content_type="image/webp",
                    data=output.getvalue(),
                    width=frames[0].width,
                    height=frames[0].height,
                )
            )
    except UnsupportedMediaError:
        raise
    except Exception as exc:
        raise UnsupportedMediaError("decode_failed", f"动画图片无法解码: {exc}") from exc

    return ProcessedImage(
        width=width,
        height=height,
        format=_detect_format(tags, extension),
        is_animated=True,
        frame_count=frame_count,
        derivatives=tuple(derivatives),
    )


def _render_derivatives(path: Path, extension: str, tags: dict[str, Any]) -> ProcessedImage:
    if extension in RAW_EXTENSIONS:
        return _render_raw_derivatives(path, extension, tags)

    animated = _render_animated_derivatives(path, extension, tags)
    if animated is not None:
        return animated

    import pyvips

    image = _to_srgb_uchar(_load_image(path, pyvips))
    width = image.width
    height = image.height
    try:
        preview = image.thumbnail_image(
            2048,
            height=2048,
            size="down",
        ).copy_memory()
    except UnsupportedMediaError:
        raise
    except Exception as exc:
        raise UnsupportedMediaError("decode_failed", f"图片像素无法完整解码: {exc}") from exc

    derivatives: list[DerivativePayload] = []
    for kind, edge in DERIVATIVE_SIZES:
        target = (
            preview
            if edge == 2048
            else preview.thumbnail_image(edge, height=edge, size="down").copy_memory()
        )
        webp = target.write_to_buffer(".webp", Q=82, strip=True)
        derivatives.append(
            DerivativePayload(
                kind=kind,
                format="webp",
                content_type="image/webp",
                data=webp,
                width=target.width,
                height=target.height,
            )
        )
    return ProcessedImage(
        width=width,
        height=height,
        format=_detect_format(tags, extension),
        is_animated=False,
        frame_count=1,
        derivatives=tuple(derivatives),
    )


def _render_derivatives_child(path: Path, extension: str, output_directory: Path) -> int:
    output_directory.mkdir(parents=True, exist_ok=True)
    try:
        processed = _render_derivatives(path, extension, {})
    except UnsupportedMediaError as exc:
        (output_directory / "error.json").write_text(
            json.dumps({"unsupported": True, "code": exc.code, "message": str(exc)}),
            encoding="utf-8",
        )
        return 2
    except Exception as exc:
        (output_directory / "error.json").write_text(
            json.dumps({"unsupported": False, "message": f"{type(exc).__name__}: {exc}"}),
            encoding="utf-8",
        )
        return 1

    derivatives = []
    for index, derivative in enumerate(processed.derivatives):
        payload_name = f"derivative-{index}.bin"
        (output_directory / payload_name).write_bytes(derivative.data)
        derivatives.append(
            {
                "kind": derivative.kind,
                "format": derivative.format,
                "content_type": derivative.content_type,
                "path": payload_name,
                "width": derivative.width,
                "height": derivative.height,
            }
        )
    (output_directory / "result.json").write_text(
        json.dumps(
            {
                "width": processed.width,
                "height": processed.height,
                "format": processed.format,
                "is_animated": processed.is_animated,
                "frame_count": processed.frame_count,
                "derivatives": derivatives,
            }
        ),
        encoding="utf-8",
    )
    return 0


def _render_derivatives_isolated(
    path: Path,
    extension: str,
    tags: dict[str, Any],
) -> ProcessedImage:
    with tempfile.TemporaryDirectory(prefix="nyy-render-") as temporary_directory:
        output_directory = Path(temporary_directory)
        try:
            process = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "app.workers.media_worker",
                    "--render-source",
                    str(path),
                    "--render-extension",
                    extension,
                    "--render-output",
                    str(output_directory),
                ],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=RENDER_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise UnsupportedMediaError("decoder_timeout", "图片解码器处理超时") from exc

        error_path = output_directory / "error.json"
        if process.returncode != 0:
            if error_path.exists():
                error = json.loads(error_path.read_text(encoding="utf-8"))
                if error.get("unsupported"):
                    raise UnsupportedMediaError(
                        str(error.get("code") or "decode_failed"),
                        str(error.get("message") or "图片无法解码"),
                    )
                raise RuntimeError(str(error.get("message") or "图片渲染失败"))
            stderr = process.stderr.decode("utf-8", errors="replace")[-1000:]
            raise UnsupportedMediaError(
                "decoder_crashed",
                f"图片解码器异常退出 ({process.returncode}): {stderr}",
            )

        manifest = json.loads((output_directory / "result.json").read_text(encoding="utf-8"))
        derivatives = tuple(
            DerivativePayload(
                kind=item["kind"],
                format=item["format"],
                content_type=item["content_type"],
                data=(output_directory / item["path"]).read_bytes(),
                width=item["width"],
                height=item["height"],
            )
            for item in manifest["derivatives"]
        )
        return ProcessedImage(
            width=manifest["width"],
            height=manifest["height"],
            format=_detect_format(tags, extension),
            is_animated=bool(manifest.get("is_animated", False)),
            frame_count=max(1, int(manifest.get("frame_count", 1))),
            derivatives=derivatives,
        )


async def _download_source(logical_file: ShareLogicalFile, destination: Path) -> None:
    chunks = sorted(logical_file.files, key=lambda item: item.chunk_index)
    if not chunks or [item.chunk_index for item in chunks] != list(range(len(chunks))):
        raise RuntimeError("源文件分片不完整")
    if logical_file.chunk_total != len(chunks):
        raise RuntimeError("源文件分片数量不匹配")

    resolver = DoubaoDownloadUrlResolver()
    total_bytes = 0
    try:
        timeout = httpx.Timeout(60.0, connect=20.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as http:
            with destination.open("wb") as output:
                for chunk in chunks:
                    url = await resolver.get_download_url(chunk.tos_uri, expire_seconds=3600)
                    chunk_bytes = 0
                    async with http.stream("GET", url) as response:
                        response.raise_for_status()
                        async for data in response.aiter_bytes(DOWNLOAD_CHUNK_BYTES):
                            output.write(data)
                            chunk_bytes += len(data)
                    if chunk_bytes != chunk.size:
                        raise RuntimeError(
                            f"源文件分片大小不匹配: {chunk.chunk_index} {chunk_bytes}/{chunk.size}"
                        )
                    total_bytes += chunk_bytes
    finally:
        await resolver.close()
    if total_bytes != logical_file.size:
        raise RuntimeError(f"源文件大小不匹配: {total_bytes}/{logical_file.size}")


async def _upload_assets(
    exif_json: bytes,
    processed: ProcessedImage,
) -> tuple[UploadedAsset, ...]:
    client = await get_doubao_client()
    payloads = [
        ("exif_json", "json", "application/json", exif_json, None, None),
        *[
            (
                derivative.kind,
                derivative.format,
                derivative.content_type,
                derivative.data,
                derivative.width,
                derivative.height,
            )
            for derivative in processed.derivatives
        ],
    ]

    async def upload_one(payload: tuple) -> UploadedAsset:
        kind, asset_format, content_type, data, width, height = payload
        store_uri, _ = await upload_sidecar(data, file_ext=asset_format, client=client)
        return UploadedAsset(
            kind=kind,
            format=asset_format,
            content_type=content_type,
            store_uri=store_uri,
            width=width,
            height=height,
            byte_size=len(data),
            checksum=hashlib.sha256(data).hexdigest(),
        )

    results = await asyncio.gather(
        *(upload_one(payload) for payload in payloads),
        return_exceptions=True,
    )
    assets = [result for result in results if isinstance(result, UploadedAsset)]
    errors = [result for result in results if isinstance(result, BaseException)]
    if errors:
        if assets:
            try:
                await client.delete_upload_files([asset.store_uri for asset in assets])
            except Exception:
                log.exception("媒体资产上传失败后的对象清理失败")
                try:
                    await queue_media_object_cleanup(
                        [asset.store_uri for asset in assets],
                        reason="media_upload_failed",
                    )
                except Exception:
                    log.exception("无法持久化媒体上传失败对象的清理任务")
        raise errors[0]
    return tuple(assets)


async def _delete_uploaded_assets(assets: tuple[UploadedAsset, ...]) -> None:
    if not assets:
        return
    try:
        client = await get_doubao_client()
        await client.delete_upload_files([asset.store_uri for asset in assets])
    except Exception:
        log.exception("媒体任务持久化失败后的对象清理失败")
        try:
            await queue_media_object_cleanup(
                [asset.store_uri for asset in assets],
                reason="media_persist_failed",
            )
        except Exception:
            log.exception("无法持久化媒体持久化失败对象的清理任务")


async def _run_object_cleanup_batch(limit: int = 100) -> bool:
    factory = get_session_factory()
    now = utcnow()
    async with factory() as db, db.begin():
        jobs = list((await db.scalars(
            select(MediaObjectCleanupJob)
            .where(MediaObjectCleanupJob.available_at <= now)
            .order_by(MediaObjectCleanupJob.available_at, MediaObjectCleanupJob.created_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )).all())
        if not jobs:
            return False
        for job in jobs:
            job.attempts += 1
            job.available_at = now + timedelta(seconds=min(3600, 30 * 2 ** min(job.attempts, 7)))
            job.updated_at = now

    store_uris = [job.store_uri for job in jobs]
    async with factory() as db, db.begin():
        referenced_uris = set((await db.scalars(
            select(ShareMediaAsset.store_uri).where(ShareMediaAsset.store_uri.in_(store_uris))
        )).all())
        if referenced_uris:
            await db.execute(
                delete(MediaObjectCleanupJob).where(
                    MediaObjectCleanupJob.store_uri.in_(referenced_uris)
                )
            )
    jobs = [job for job in jobs if job.store_uri not in referenced_uris]
    if not jobs:
        return True

    try:
        client = await get_doubao_client()
        confirmed = await client.delete_upload_files([job.store_uri for job in jobs])
    except Exception as exc:
        async with factory() as db, db.begin():
            await db.execute(
                update(MediaObjectCleanupJob)
                .where(MediaObjectCleanupJob.id.in_([job.id for job in jobs]))
                .values(last_error=f"{type(exc).__name__}: {exc}"[:2000], updated_at=utcnow())
            )
        log.warning("孤儿媒体对象清理失败，稍后重试: %s", exc)
        return True

    async with factory() as db, db.begin():
        await db.execute(
            delete(MediaObjectCleanupJob).where(
                MediaObjectCleanupJob.id.in_([
                    job.id for job in jobs if job.store_uri in confirmed
                ])
            )
        )
    return True


def _update_image_metadata(logical_file: ShareLogicalFile, **updates: Any) -> None:
    metadata = dict(logical_file.media_metadata or {})
    existing = metadata.get("image")
    image = dict(existing) if isinstance(existing, dict) else {}
    image.setdefault("width", None)
    image.setdefault("height", None)
    image.setdefault("orientation", None)
    image.setdefault("format", _extension(logical_file.original_name) or None)
    image.setdefault("color_space", None)
    image.setdefault("processor_version", MEDIA_PROCESSING_VERSION)
    image.setdefault("error_code", None)
    image.setdefault("exif_summary", {})
    image.update(updates)
    metadata["image"] = image
    logical_file.media_metadata = metadata
    flag_modified(logical_file, "media_metadata")


async def _claim_job(worker_id: str, lock_timeout: timedelta) -> UUID | None:
    factory = get_session_factory()
    async with factory() as db, db.begin():
        job = await claim_next_job(db, worker_id=worker_id, lock_timeout=lock_timeout)
        if job is None:
            return None
        logical_file = await db.get(ShareLogicalFile, job.logical_file_id)
        if logical_file is not None:
            _update_image_metadata(
                logical_file,
                status="running",
                processor_version=job.processing_version,
                error_code=None,
            )
        return job.id


async def _renew_job_lease(job_id: UUID, worker_id: str) -> bool:
    factory = get_session_factory()
    async with factory() as db, db.begin():
        renewed_id = await db.scalar(
            update(MediaProcessingJob)
            .where(
                MediaProcessingJob.id == job_id,
                MediaProcessingJob.status == "running",
                MediaProcessingJob.locked_by == worker_id,
            )
            .values(locked_at=utcnow(), updated_at=utcnow())
            .returning(MediaProcessingJob.id)
        )
        return renewed_id is not None


async def _keep_job_lease(
    job_id: UUID,
    worker_id: str,
    lock_timeout: timedelta,
    stop_event: asyncio.Event,
) -> None:
    interval = max(5.0, min(60.0, lock_timeout.total_seconds() / 3))
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
            return
        except TimeoutError:
            pass
        try:
            if not await _renew_job_lease(job_id, worker_id):
                log.warning("媒体任务租约已失效 job_id=%s", job_id)
                return
        except Exception:
            log.exception("媒体任务续租失败 job_id=%s", job_id)


async def _load_job_source(job_id: UUID) -> tuple[MediaProcessingJob, ShareLogicalFile]:
    factory = get_session_factory()
    async with factory() as db:
        job = await db.get(MediaProcessingJob, job_id)
        if job is None:
            raise RuntimeError("媒体处理任务已不存在")
        logical_file = await db.scalar(
            select(ShareLogicalFile)
            .options(selectinload(ShareLogicalFile.files))
            .where(ShareLogicalFile.id == job.logical_file_id)
        )
        if logical_file is None:
            raise RuntimeError("媒体处理源文件已不存在")
        return job, logical_file


async def _persist_success(
    job_id: UUID,
    worker_id: str,
    processed: ProcessedImage,
    tags: dict[str, Any],
    assets: tuple[UploadedAsset, ...],
) -> bool:
    factory = get_session_factory()
    async with factory() as db, db.begin():
        job = await db.scalar(
            select(MediaProcessingJob).where(MediaProcessingJob.id == job_id).with_for_update()
        )
        if job is None or job.status != "running" or job.locked_by != worker_id:
            return False
        logical_file = await db.get(ShareLogicalFile, job.logical_file_id)
        if logical_file is None:
            return False
        for asset in assets:
            await upsert_media_asset(
                db,
                logical_file_id=logical_file.id,
                kind=asset.kind,
                format=asset.format,
                content_type=asset.content_type,
                store_uri=asset.store_uri,
                width=asset.width,
                height=asset.height,
                byte_size=asset.byte_size,
                checksum=asset.checksum,
                processing_version=job.processing_version,
            )
        orientation = _first_tag(tags, ("Orientation",))
        _update_image_metadata(
            logical_file,
            status="succeeded",
            width=processed.width,
            height=processed.height,
            orientation=orientation,
            format=processed.format,
            is_animated=processed.is_animated,
            frame_count=processed.frame_count,
            color_space="sRGB",
            processor_version=job.processing_version,
            error_code=None,
            exif_summary=build_exif_summary(tags),
        )
        await mark_job_succeeded(db, job)
        return True


async def _finish_error(
    job_id: UUID,
    worker_id: str,
    error: Exception,
) -> None:
    factory = get_session_factory()
    async with factory() as db, db.begin():
        job = await db.scalar(
            select(MediaProcessingJob).where(MediaProcessingJob.id == job_id).with_for_update()
        )
        if job is None or job.status != "running" or job.locked_by != worker_id:
            return
        logical_file = await db.get(ShareLogicalFile, job.logical_file_id)
        if isinstance(error, UnsupportedMediaError):
            await mark_job_unsupported(db, job, str(error))
            status = "unsupported"
            error_code = error.code
        else:
            status = await mark_job_failed(db, job, f"{type(error).__name__}: {error}")
            error_code = "processing_error"
        if logical_file is not None:
            _update_image_metadata(
                logical_file,
                status=status,
                processor_version=job.processing_version,
                error_code=error_code,
            )


async def _process_job(
    job_id: UUID,
    worker_id: str,
    render_semaphore: asyncio.Semaphore | None = None,
) -> None:
    job, logical_file = await _load_job_source(job_id)
    if not is_supported_image(logical_file.original_name):
        raise UnsupportedMediaError("unsupported_extension", "文件扩展名不受支持")
    if logical_file.size > MAX_MEDIA_SOURCE_BYTES:
        raise UnsupportedMediaError("source_too_large", "图片源文件超过处理体积上限")
    extension = _extension(logical_file.original_name)
    suffix = f".{extension}" if extension else ".bin"
    with tempfile.TemporaryDirectory(prefix="nyy-media-") as temporary_directory:
        source_path = Path(temporary_directory) / f"source{suffix}"
        await _download_source(logical_file, source_path)
        exif_json, tags = await asyncio.to_thread(_read_exif, source_path)
        if render_semaphore is None:
            processed = await asyncio.to_thread(
                _render_derivatives_isolated,
                source_path,
                extension,
                tags,
            )
        else:
            async with render_semaphore:
                processed = await asyncio.to_thread(
                    _render_derivatives_isolated,
                    source_path,
                    extension,
                    tags,
                )
        assets = await _upload_assets(exif_json, processed)
    asset_uris = [asset.store_uri for asset in assets]
    try:
        await queue_media_object_cleanup(
            asset_uris,
            reason="media_persist_pending",
            delay=timedelta(minutes=10),
        )
    except Exception:
        await _delete_uploaded_assets(assets)
        raise
    persisted = await _persist_success(job.id, worker_id, processed, tags, assets)
    if persisted:
        try:
            await dequeue_media_object_cleanup(asset_uris)
        except Exception:
            log.exception("无法移除已持久化媒体对象的延迟清理任务")
    if not persisted:
        await _delete_uploaded_assets(assets)
        log.warning("任务租约已失效，放弃写入 job_id=%s", job.id)


async def _run_one(
    worker_id: str,
    lock_timeout: timedelta,
    render_semaphore: asyncio.Semaphore | None = None,
) -> bool:
    job_id = await _claim_job(worker_id, lock_timeout)
    if job_id is None:
        return False
    lease_stop_event = asyncio.Event()
    lease_task = asyncio.create_task(
        _keep_job_lease(job_id, worker_id, lock_timeout, lease_stop_event)
    )
    processing_error: Exception | None = None
    try:
        await _process_job(job_id, worker_id, render_semaphore)
    except Exception as exc:
        processing_error = exc
        log.exception("媒体任务处理失败 job_id=%s", job_id)
    finally:
        lease_stop_event.set()
        await lease_task
    if processing_error is not None:
        await _finish_error(job_id, worker_id, processing_error)
    return True


async def run_worker(
    *,
    worker_id: str,
    poll_interval: float,
    lock_timeout: timedelta,
    once: bool,
    concurrency: int,
) -> None:
    """并发轮询任务，渲染阶段串行以限制峰值内存。"""

    for pattern in ("nyy-media-*", "nyy-render-*"):
        for path in Path(tempfile.gettempdir()).glob(pattern):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(signum, stop_event.set)
    effective_concurrency = 1 if once else max(1, concurrency)
    render_semaphore = asyncio.Semaphore(1)
    await get_doubao_client()
    log.info(
        "媒体 Worker 启动 worker_id=%s concurrency=%d",
        worker_id,
        effective_concurrency,
    )

    async def run_slot(slot_index: int) -> None:
        slot_worker_id = (
            worker_id
            if effective_concurrency == 1
            else f"{worker_id}:{slot_index + 1}"
        )
        while not stop_event.is_set():
            if slot_index == 0 and await _run_object_cleanup_batch():
                continue
            handled = await _run_one(slot_worker_id, lock_timeout, render_semaphore)
            if once:
                return
            if handled:
                continue
            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=max(0.1, poll_interval),
                )
            except TimeoutError:
                pass

    try:
        await asyncio.gather(*(
            run_slot(slot_index)
            for slot_index in range(effective_concurrency)
        ))
    finally:
        await shutdown_doubao_client()
        await dispose_engine()
        log.info("媒体 Worker 已退出 worker_id=%s", worker_id)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="处理分享图片的 EXIF 和画廊派生资产")
    parser.add_argument(
        "--worker-id",
        default=f"{socket.gethostname()}:{os.getpid()}",
        help="任务租约持有者标识",
    )
    parser.add_argument("--poll-interval", type=float, default=2.0, help="空队列轮询间隔秒数")
    parser.add_argument(
        "--lock-timeout",
        type=float,
        default=900.0,
        help="运行中任务租约超时秒数",
    )
    parser.add_argument("--once", action="store_true", help="最多处理一个任务后退出")
    parser.add_argument("--concurrency", type=int, default=2, help="并发任务数")
    parser.add_argument("--log-level", default="INFO", help="Python 日志级别")
    parser.add_argument("--render-source", default="", help=argparse.SUPPRESS)
    parser.add_argument("--render-extension", default="", help=argparse.SUPPRESS)
    parser.add_argument("--render-output", default="", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    if args.render_source:
        raise SystemExit(
            _render_derivatives_child(
                Path(args.render_source),
                args.render_extension,
                Path(args.render_output),
            )
        )
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("pyvips").setLevel(logging.WARNING)
    asyncio.run(
        run_worker(
            worker_id=args.worker_id,
            poll_interval=args.poll_interval,
            lock_timeout=timedelta(seconds=max(1.0, args.lock_timeout)),
            once=args.once,
            concurrency=max(1, min(args.concurrency, 4)),
        )
    )


if __name__ == "__main__":
    main()
