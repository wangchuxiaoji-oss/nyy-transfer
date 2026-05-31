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


class ShareFileDownload(BaseModel):
    """单个逻辑文件的下载信息。"""
    file_name: str
    file_size: int          # 逻辑文件总大小
    content_type: str = ""
    is_chunked: bool = False
    # 普通文件：download_url 为 TOS 签名 URL
    # 分片文件：download_url 为空，chunks 包含所有 chunk URL
    download_url: str = ""
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


class ShareVerifyRequest(BaseModel):
    """POST /api/v1/shares/:code/verify 请求体。"""
    password: str = Field(..., min_length=4, max_length=4)


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
