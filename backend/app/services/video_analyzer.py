"""视频文件分析服务：使用 ffprobe 提取视频元数据。"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

# 可播放的视频格式
PLAYABLE_VIDEO_EXTS = {"mp4", "m4v", "mov", "webm", "ogg"}

# 不可播放但可识别的视频格式
UNPLAYABLE_VIDEO_EXTS = {
    "mkv", "avi", "flv", "wmv", "rmvb", "3gp", "asf", "f4v",
    "vob", "mpg", "mpeg", "m2ts", "mts", "divx", "xvid", "rm",
}

# 音频格式（跳过）
AUDIO_EXTS = {"mp3", "aac", "wav", "flac", "m4a", "wma", "opus", "ape"}

# 所有视频格式
ALL_VIDEO_EXTS = PLAYABLE_VIDEO_EXTS | UNPLAYABLE_VIDEO_EXTS

# 最大文件大小：10GB
MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024

# moov 检测：读取头部和尾部的大小
MOOV_HEADER_READ_SIZE = 2 * 1024 * 1024  # 2MB
MOOV_TAIL_READ_SIZE = 2 * 1024 * 1024    # 2MB


@dataclass
class StreamInfo:
    """流信息。"""
    index: int | None = None
    codec_name: str | None = None
    codec_type: str | None = None  # video / audio / subtitle
    codec_tag_string: str | None = None
    profile: str | None = None
    level: int | None = None
    width: int | None = None
    height: int | None = None
    r_frame_rate: str | None = None
    avg_frame_rate: str | None = None
    bit_rate: int | None = None
    duration: float | None = None
    sample_rate: int | None = None
    channels: int | None = None
    channel_layout: str | None = None
    pix_fmt: str | None = None
    color_space: str | None = None
    color_transfer: str | None = None
    color_primaries: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class FormatInfo:
    """容器格式信息。"""
    filename: str | None = None
    nb_streams: int | None = None
    format_name: str | None = None
    format_long_name: str | None = None
    duration: float | None = None
    size: int | None = None
    bit_rate: int | None = None
    tags: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        result = {k: v for k, v in self.__dict__.items() if v is not None and v != {}}
        return result


@dataclass
class MoovInfo:
    """moov atom 信息。"""
    position: str | None = None  # head / tail / unknown
    offset: int | None = None
    size: int | None = None
    is_fast_start: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class DiagnosisIssue:
    """诊断问题。"""
    severity: str  # high / medium / low
    issue_type: str
    message: str
    recommendation: str | None = None

    def to_dict(self) -> dict[str, Any]:
        result = {
            "severity": self.severity,
            "type": self.issue_type,
            "message": self.message,
        }
        if self.recommendation:
            result["recommendation"] = self.recommendation
        return result


@dataclass
class AnalysisResult:
    """完整分析结果。"""
    file_name: str
    relative_path: str
    file_size: int
    status: str  # analyzed / unsupported / skipped_too_large / error
    error_message: str | None = None

    # 分析结果
    format_info: FormatInfo | None = None
    streams: list[StreamInfo] = field(default_factory=list)
    moov_info: MoovInfo | None = None
    diagnosis: list[DiagnosisIssue] = field(default_factory=list)

    # 播放策略建议
    playback_strategy: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        result = {
            "file_name": self.file_name,
            "relative_path": self.relative_path,
            "file_size": self.file_size,
            "status": self.status,
        }
        if self.error_message:
            result["error_message"] = self.error_message
        if self.format_info:
            result["format"] = self.format_info.to_dict()
        if self.streams:
            video_streams = [s.to_dict() for s in self.streams if s.codec_type == "video"]
            audio_streams = [s.to_dict() for s in self.streams if s.codec_type == "audio"]
            subtitle_streams = [s.to_dict() for s in self.streams if s.codec_type == "subtitle"]
            if video_streams:
                result["video_streams"] = video_streams
            if audio_streams:
                result["audio_streams"] = audio_streams
            if subtitle_streams:
                result["subtitle_streams"] = subtitle_streams
        if self.moov_info:
            result["moov"] = self.moov_info.to_dict()
        if self.diagnosis:
            result["diagnosis"] = [d.to_dict() for d in self.diagnosis]
        if self.playback_strategy:
            result["playback_strategy"] = self.playback_strategy
        return result


def get_file_extension(file_name: str) -> str:
    """获取文件扩展名（小写）。"""
    return Path(file_name).suffix.lstrip(".").lower()


def classify_file(file_name: str) -> str:
    """分类文件：playable_video / unplayable_video / audio / unknown。"""
    ext = get_file_extension(file_name)
    if ext in PLAYABLE_VIDEO_EXTS:
        return "playable_video"
    if ext in UNPLAYABLE_VIDEO_EXTS:
        return "unplayable_video"
    if ext in AUDIO_EXTS:
        return "audio"
    # 没有扩展名或未知扩展名，归入不可播放视频
    return "unplayable_video"


async def run_ffprobe(file_path: str) -> dict[str, Any]:
    """运行 ffprobe 并返回 JSON 结果。"""
    cmd = [
        "ffprobe",
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        "-show_entries", (
            "stream=index,codec_name,codec_type,codec_tag_string,"
            "width,height,r_frame_rate,avg_frame_rate,bit_rate,duration,"
            "sample_rate,channels,channel_layout,profile,level,"
            "pix_fmt,color_space,color_transfer,color_primaries"
        ),
        "-show_entries", (
            "format=filename,nb_streams,format_name,format_long_name,"
            "duration,size,bit_rate"
        ),
        file_path,
    ]

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    if proc.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {stderr.decode('utf-8', errors='replace')}")

    try:
        return json.loads(stdout.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise RuntimeError(f"ffprobe output is not valid JSON: {e}") from e


def detect_moov_position(file_path: str) -> MoovInfo:
    """检测 moov atom 的位置。"""
    moov_info = MoovInfo()
    file_size = os.path.getsize(file_path)

    try:
        with open(file_path, "rb") as f:
            # 读取头部
            header = f.read(MOOV_HEADER_READ_SIZE)
            # 检查头部是否有 moov
            moov_pos = header.find(b"moov")
            if moov_pos >= 0:
                moov_info.position = "head"
                moov_info.offset = moov_pos
                moov_info.is_fast_start = True
                # 尝试读取 moov 大小（前4字节是大小）
                if moov_pos >= 4:
                    moov_size = int.from_bytes(header[moov_pos - 4:moov_pos], "big")
                    if 0 < moov_size < file_size:
                        moov_info.size = moov_size
                return moov_info

            # 读取尾部
            if file_size > MOOV_TAIL_READ_SIZE:
                f.seek(-MOOV_TAIL_READ_SIZE, 2)
                tail = f.read()
                moov_pos = tail.find(b"moov")
                if moov_pos >= 0:
                    moov_info.position = "tail"
                    moov_info.offset = file_size - MOOV_TAIL_READ_SIZE + moov_pos
                    moov_info.is_fast_start = False
                    # 尝试读取 moov 大小
                    if moov_pos >= 4:
                        moov_size = int.from_bytes(tail[moov_pos - 4:moov_pos], "big")
                        if 0 < moov_size < file_size:
                            moov_info.size = moov_size
                    return moov_info

            moov_info.position = "unknown"
            return moov_info

    except Exception as e:
        log.warning("Failed to detect moov position: %s", e)
        moov_info.position = "unknown"
        return moov_info


def parse_streams(ffprobe_data: dict[str, Any]) -> list[StreamInfo]:
    """解析 ffprobe 输出中的流信息。"""
    streams = []
    for stream_data in ffprobe_data.get("streams", []):
        stream = StreamInfo()
        for key in stream.__dataclass_fields__:
            if key in stream_data:
                value = stream_data[key]
                # 处理特殊类型
                if key == "bit_rate" and value:
                    try:
                        value = int(value)
                    except (ValueError, TypeError):
                        value = None
                elif key == "duration" and value:
                    try:
                        value = float(value)
                    except (ValueError, TypeError):
                        value = None
                elif key == "level" and value:
                    try:
                        value = int(value)
                    except (ValueError, TypeError):
                        value = None
                elif key in ("width", "height", "sample_rate", "channels") and value:
                    try:
                        value = int(value)
                    except (ValueError, TypeError):
                        value = None
                setattr(stream, key, value)
        streams.append(stream)
    return streams


def parse_format(ffprobe_data: dict[str, Any]) -> FormatInfo:
    """解析 ffprobe 输出中的格式信息。"""
    format_data = ffprobe_data.get("format", {})
    fmt = FormatInfo()
    for key in fmt.__dataclass_fields__:
        if key == "tags":
            fmt.tags = format_data.get("tags", {})
        elif key in format_data:
            value = format_data[key]
            if key in ("duration", "bit_rate") and value:
                try:
                    value = float(value) if key == "duration" else int(value)
                except (ValueError, TypeError):
                    value = None
            elif key == "size" and value:
                try:
                    value = int(value)
                except (ValueError, TypeError):
                    value = None
            elif key == "nb_streams" and value:
                try:
                    value = int(value)
                except (ValueError, TypeError):
                    value = None
            setattr(fmt, key, value)
    return fmt


def generate_diagnosis(
    format_info: FormatInfo,
    streams: list[StreamInfo],
    moov_info: MoovInfo,
    file_size: int,
) -> list[DiagnosisIssue]:
    """生成诊断问题。"""
    issues = []

    # 检查 moov 位置
    if moov_info.position == "tail":
        issues.append(DiagnosisIssue(
            severity="high",
            issue_type="moov_position",
            message=f"moov 在文件尾部，首次播放需预读 {moov_info.size or '未知大小'} 字节",
            recommendation="建议使用 ffmpeg -movflags faststart 转换",
        ))
    elif moov_info.position == "unknown":
        issues.append(DiagnosisIssue(
            severity="medium",
            issue_type="moov_position",
            message="未检测到 moov atom，文件可能损坏或格式不标准",
        ))

    # 检查视频流
    video_streams = [s for s in streams if s.codec_type == "video"]
    for vs in video_streams:
        # 检查编码 Profile/Level
        if vs.profile and vs.level:
            if vs.level > 41:  # H.264 Level 4.1
                issues.append(DiagnosisIssue(
                    severity="medium",
                    issue_type="codec_level",
                    message=f"视频编码 Level 较高 ({vs.profile}@L{vs.level})，部分移动设备可能不支持",
                ))

        # 检查分辨率
        if vs.width and vs.height:
            if vs.width > 3840 or vs.height > 2160:
                issues.append(DiagnosisIssue(
                    severity="medium",
                    issue_type="resolution",
                    message=f"超高分辨率 ({vs.width}x{vs.height})，解码性能要求高",
                ))

        # 检查帧率
        if vs.avg_frame_rate:
            try:
                parts = vs.avg_frame_rate.split("/")
                if len(parts) == 2 and int(parts[1]) > 0:
                    fps = int(parts[0]) / int(parts[1])
                    if fps > 60:
                        issues.append(DiagnosisIssue(
                            severity="low",
                            issue_type="frame_rate",
                            message=f"高帧率 ({fps:.2f} fps)，部分设备可能不支持",
                        ))
            except (ValueError, ZeroDivisionError):
                pass

    # 检查音频流
    audio_streams = [s for s in streams if s.codec_type == "audio"]
    for audio in audio_streams:
        # 检查 AC-3/E-AC-3
        if audio.codec_name in ("ac3", "eac3"):
            issues.append(DiagnosisIssue(
                severity="medium",
                issue_type="audio_codec",
                message=f"音频编码为 {audio.codec_name.upper()}，部分浏览器可能不支持",
                recommendation="可能需要使用 AC-3 sidecar 解码器",
            ))

        # 检查采样率
        if audio.sample_rate and audio.sample_rate > 48000:
            issues.append(DiagnosisIssue(
                severity="low",
                issue_type="sample_rate",
                message=f"高采样率 ({audio.sample_rate} Hz)，部分设备可能降采样",
            ))

    # 检查文件大小
    if file_size > 5 * 1024 * 1024 * 1024:  # 5GB
        issues.append(DiagnosisIssue(
            severity="low",
            issue_type="file_size",
            message=f"文件较大 ({file_size / (1024**3):.2f} GB)，建议使用分片上传",
        ))

    return issues


def generate_playback_strategy(
    format_info: FormatInfo,
    streams: list[StreamInfo],
    moov_info: MoovInfo,
    diagnosis: list[DiagnosisIssue],
) -> dict[str, Any]:
    """生成播放策略建议。"""
    strategy = {
        "moov_preload": False,
        "moov_preload_size": 0,
        "buffer_strategy": "normal",  # normal / aggressive / conservative
        "seek_method": "nearest_keyframe",
        "needs_ac3_sidecar": False,
    }

    # moov 预读策略
    if moov_info.position == "tail" and moov_info.size:
        strategy["moov_preload"] = True
        strategy["moov_preload_size"] = moov_info.size + 1024 * 1024  # 多预读 1MB
        strategy["buffer_strategy"] = "aggressive"

    # 检查是否需要 AC-3 sidecar
    for issue in diagnosis:
        if issue.issue_type == "audio_codec" and "AC-3" in issue.message:
            strategy["needs_ac3_sidecar"] = True

    # 高码率视频需要更积极的缓冲
    video_streams = [s for s in streams if s.codec_type == "video"]
    for vs in video_streams:
        if vs.bit_rate and vs.bit_rate > 10_000_000:  # 10Mbps
            strategy["buffer_strategy"] = "aggressive"

    return strategy


async def analyze_video_file(
    file_path: str,
    file_name: str,
    relative_path: str,
    file_size: int,
) -> AnalysisResult:
    """分析单个视频文件。"""
    ext = get_file_extension(file_name)
    classification = classify_file(file_name)

    # 检查文件大小
    if file_size > MAX_FILE_SIZE:
        return AnalysisResult(
            file_name=file_name,
            relative_path=relative_path,
            file_size=file_size,
            status="skipped_too_large",
            error_message=f"文件大小 {file_size / (1024**3):.2f} GB 超过 10GB 限制",
        )

    # 不可播放格式只记录元数据
    if classification == "unplayable_video":
        return AnalysisResult(
            file_name=file_name,
            relative_path=relative_path,
            file_size=file_size,
            status="unsupported",
            error_message=f"格式 {ext} 不支持在线播放",
        )

    # 可播放格式进行深度分析
    try:
        # 运行 ffprobe
        ffprobe_data = await run_ffprobe(file_path)

        # 解析结果
        format_info = parse_format(ffprobe_data)
        streams = parse_streams(ffprobe_data)

        # 检测 moov 位置
        moov_info = detect_moov_position(file_path)

        # 生成诊断
        diagnosis = generate_diagnosis(format_info, streams, moov_info, file_size)

        # 生成播放策略
        playback_strategy = generate_playback_strategy(format_info, streams, moov_info, diagnosis)

        return AnalysisResult(
            file_name=file_name,
            relative_path=relative_path,
            file_size=file_size,
            status="analyzed",
            format_info=format_info,
            streams=streams,
            moov_info=moov_info,
            diagnosis=diagnosis,
            playback_strategy=playback_strategy,
        )

    except Exception as e:
        log.error("Failed to analyze %s: %s", file_name, e)
        return AnalysisResult(
            file_name=file_name,
            relative_path=relative_path,
            file_size=file_size,
            status="error",
            error_message=str(e),
        )
