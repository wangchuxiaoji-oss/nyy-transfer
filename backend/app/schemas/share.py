"""分享相关的 Pydantic schemas。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class ShareFileInfo(BaseModel):
    """单个文件信息（公开，不含下载 URL）。"""
    file_name: str
    file_size: int
    file_ext: str
    index: int = 0  # 文件在分享中的序号


class ShareFileDownload(BaseModel):
    """单个文件的下载信息。"""
    file_name: str
    file_size: int
    download_url: str


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
    expires_in: int = 3600  # seconds


class ShareDownloadResponse(BaseModel):
    """GET /api/v1/shares/:code/download 响应体。返回所有文件的下载 URL。"""
    files: list[ShareFileDownload]
    empty_dirs: list[str] = Field(default_factory=list)
    expires_in: int = 3600
