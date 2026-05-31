"""视频分析 API：扫描文件夹并分析视频文件。

POST /api/v1/video-inspect/analyze   — 分析单个视频文件
POST /api/v1/video-inspect/save      — 保存分析报告
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse

from app.services.video_analyzer import (
    ALL_VIDEO_EXTS,
    AUDIO_EXTS,
    PLAYABLE_VIDEO_EXTS,
    UNPLAYABLE_VIDEO_EXTS,
    AnalysisResult,
    analyze_video_file,
    classify_file,
    get_file_extension,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/video-inspect", tags=["video-inspect"])

# 分析结果保存目录
INSPECT_RESULTS_DIR = "/data/nyy/video-inspect-results"

# 临时文件目录
TEMP_DIR = "/tmp/opencode/video-inspect"


def _ensure_dir(path: str) -> None:
    """确保目录存在。"""
    os.makedirs(path, exist_ok=True)


def _get_timestamp_dir() -> str:
    """生成时间戳目录名。"""
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%d_%H-%M-%S")


@router.post("/analyze")
async def analyze_video(
    file: UploadFile = File(...),
    relative_path: str = Form(...),
) -> dict[str, Any]:
    """分析单个视频文件。

    Args:
        file: 上传的视频文件
        relative_path: 文件在文件夹中的相对路径

    Returns:
        分析结果 JSON
    """
    # 确保临时目录存在
    _ensure_dir(TEMP_DIR)

    # 获取文件信息
    file_name = file.filename or "unknown"
    ext = get_file_extension(file_name)

    # 检查是否为音频文件
    if ext in AUDIO_EXTS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"音频文件 {ext} 不在分析范围内",
        )

    # 保存临时文件
    temp_file_path = os.path.join(TEMP_DIR, f"{datetime.now().timestamp()}_{file_name}")
    try:
        # 写入临时文件
        file_size = 0
        with open(temp_file_path, "wb") as temp_file:
            while True:
                chunk = await file.read(8192)
                if not chunk:
                    break
                temp_file.write(chunk)
                file_size += len(chunk)

        # 分析文件
        result = await analyze_video_file(
            file_path=temp_file_path,
            file_name=file_name,
            relative_path=relative_path,
            file_size=file_size,
        )

        return result.to_dict()

    finally:
        # 清理临时文件
        try:
            if os.path.exists(temp_file_path):
                os.remove(temp_file_path)
        except Exception as e:
            log.warning("Failed to remove temp file %s: %s", temp_file_path, e)


@router.post("/save")
async def save_report(report: dict[str, Any]) -> dict[str, str]:
    """保存完整的分析报告。

    Args:
        report: 完整的分析报告 JSON

    Returns:
        保存路径
    """
    # 创建保存目录
    timestamp_dir = _get_timestamp_dir()
    save_dir = os.path.join(INSPECT_RESULTS_DIR, timestamp_dir)
    _ensure_dir(save_dir)
    _ensure_dir(os.path.join(save_dir, "analyzed"))
    _ensure_dir(os.path.join(save_dir, "unsupported"))

    # 保存完整报告
    report_path = os.path.join(save_dir, "report.json")
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    # 保存各个分析结果
    analyzed = report.get("analyzed", [])
    for item in analyzed:
        file_name = item.get("file_name", "unknown")
        safe_name = file_name.replace("/", "_").replace("\\", "_")
        item_path = os.path.join(save_dir, "analyzed", f"{safe_name}.json")
        with open(item_path, "w", encoding="utf-8") as f:
            json.dump(item, f, ensure_ascii=False, indent=2)

    # 保存不支持格式的目录
    unsupported = report.get("unsupported", [])
    if unsupported:
        unsupported_path = os.path.join(save_dir, "unsupported", "catalog.json")
        with open(unsupported_path, "w", encoding="utf-8") as f:
            json.dump(unsupported, f, ensure_ascii=False, indent=2)

    log.info("Video inspect report saved to %s", save_dir)

    return {
        "saved_path": save_dir,
        "report_path": report_path,
    }


@router.get("/formats")
async def get_supported_formats() -> dict[str, Any]:
    """获取支持的格式列表。

    Returns:
        格式分类信息
    """
    return {
        "playable_video": sorted(PLAYABLE_VIDEO_EXTS),
        "unplayable_video": sorted(UNPLAYABLE_VIDEO_EXTS),
        "audio": sorted(AUDIO_EXTS),
        "all_video": sorted(ALL_VIDEO_EXTS),
    }
