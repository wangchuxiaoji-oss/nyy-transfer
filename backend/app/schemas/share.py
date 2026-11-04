"""分享相关的 Pydantic schemas。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ShareFileInfo(BaseModel):
    """单个逻辑文件信息（公开，不含下载 URL）。"""
    file_name: str
    file_size: int          # 逻辑文件总大小（所有 chunk 之和）
    file_ext: str
    content_type: str = ""
    index: int = 0          # 文件在分享中的序号
    is_chunked: bool = False  # 是否为分片大文件
    chunk_count: int = 1      # chunk 数量
    media_metadata: dict[str, Any] | None = None


class ChunkDownloadInfo(BaseModel):
    """分片文件中单个 chunk 的下载信息。"""
    index: int
    size: int
    download_url: str
    backup_download_url: str = ""


class ShareFileDownload(BaseModel):
    """单个逻辑文件的下载信息。"""
    file_name: str
    file_size: int          # 逻辑文件总大小
    content_type: str = ""
    is_chunked: bool = False
    # 普通文件：download_url 为 TOS 签名 URL
    # 分片文件：download_url 为空，chunks 包含所有 chunk URL
    download_url: str = ""
    backup_download_url: str = ""
    proxy_download_url: str = ""
    chunks: list[ChunkDownloadInfo] = Field(default_factory=list)
    media_metadata: dict[str, Any] | None = None


class ShareInfoResponse(BaseModel):
    """GET /api/v1/shares/:code 响应体。"""
    code: str
    files: list[ShareFileInfo]
    empty_dirs: list[str] = Field(default_factory=list)
    total_bytes: int = 0
    created_at: datetime
    expires_at: datetime | None = None
    download_count: int = 0
    max_downloads: int = 0
    has_password: bool = False
    gallery_eligible: bool = False


class GallerySessionRequest(BaseModel):
    """创建图片画廊会话；受保护分享需同时验证提取码。"""

    password: str = Field(default="", max_length=4, pattern=r"^(?:[0-9]{4})?$")
    known_ready_indices: list[int] = Field(default_factory=list, max_length=500)


class GalleryAssetInfo(BaseModel):
    """画廊派生资源及其临时访问地址。"""

    kind: str
    format: str
    content_type: str
    width: int = 0
    height: int = 0
    byte_size: int
    download_url: str
    backup_download_url: str = ""


class GalleryFileInfo(BaseModel):
    """画廊中的单张图片及处理状态。"""

    index: int
    file_name: str
    file_size: int
    content_type: str = ""
    status: str
    width: int = 0
    height: int = 0
    error_code: str | None = None
    exif_summary: dict[str, Any] | None = None
    is_animated: bool = False
    frame_count: int = 1
    assets: list[GalleryAssetInfo] = Field(default_factory=list)


class GallerySessionResponse(BaseModel):
    """图片画廊状态、派生资源和轮询提示。"""

    eligible: bool
    files: list[GalleryFileInfo] = Field(default_factory=list)
    ready_count: int = 0
    pending_count: int = 0
    failed_count: int = 0
    retry_after_seconds: float = 0
    expires_in: int = 3600


class ShareVerifyRequest(BaseModel):
    """POST /api/v1/shares/:code/verify 请求体。"""
    password: str = Field(..., min_length=4, max_length=4, pattern=r"^[0-9]{4}$")


class ShareVerifyResponse(BaseModel):
    """POST /api/v1/shares/:code/verify 响应体。返回所有文件的下载 URL。"""
    files: list[ShareFileDownload]
    empty_dirs: list[str] = Field(default_factory=list)
    expires_in: int = 86400  # 24 hours


class ShareDownloadResponse(BaseModel):
    """GET /api/v1/shares/:code/download 响应体。返回所有文件的下载 URL。"""
    files: list[ShareFileDownload]
    empty_dirs: list[str] = Field(default_factory=list)
    expires_in: int = 86400  # 24 hours


class ShareDownloadSessionRequest(BaseModel):
    """幂等取链请求；有提取码的分享在这里一并验证。"""

    password: str = Field(default="", max_length=4, pattern=r"^(?:[0-9]{4})?$")
    intent: str = Field(default="download", pattern="^(preview|download)$")
    delivery: str = Field(default="direct", pattern="^(direct|same_origin)$")
    file_indices: list[int] | None = Field(default=None, min_length=1, max_length=500)


class ShareInteractionRequest(BaseModel):
    event_type: str = Field(
        default="human_interaction",
        pattern="^(page_rendered|human_interaction)$",
    )
    request_id: str = Field(
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9._:-]+$",
    )
    request_time_ms: int | None = Field(default=None, ge=0, le=600000)
