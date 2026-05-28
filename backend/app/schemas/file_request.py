"""文件请求链接 schemas。"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class FileRequestCreate(BaseModel):
    title: str = Field(default="文件请求", min_length=1, max_length=255)
    password: str = Field(default="", max_length=4, pattern=r"^[0-9]{0,4}$")
    expires_hours: int = Field(default=168, ge=1, le=720)
    max_files: int = Field(default=20, ge=1, le=50)
    max_bytes: int = Field(default=1024 * 1024 * 1024, ge=1, le=1024 * 1024 * 1024)


class FileRequestCreateResponse(BaseModel):
    code: str
    url: str


class FileRequestInfoResponse(BaseModel):
    code: str
    title: str
    has_password: bool
    expires_at: datetime | None
    max_files: int
    max_bytes: int
    received_files: int
    received_bytes: int


class FileRequestVerify(BaseModel):
    password: str = Field(..., min_length=4, max_length=4)


class FileRequestCommitFile(BaseModel):
    commit_token: str = Field(..., min_length=1, max_length=512)
    store_uri: str = Field(..., min_length=1, max_length=512)


class FileRequestCommit(BaseModel):
    files: list[FileRequestCommitFile] = Field(..., min_length=1, max_length=50)
    password: str = Field(default="", max_length=4)


class FileRequestItem(BaseModel):
    code: str
    title: str
    created_at: datetime
    expires_at: datetime | None
    file_count: int
    total_bytes: int
    revoked: bool


class FileRequestFileItem(BaseModel):
    id: str
    request_code: str
    file_name: str
    file_size: int
    created_at: datetime


class FileRequestListResponse(BaseModel):
    requests: list[FileRequestItem]
    total: int = 0
    page: int = 1
    page_size: int = 20


class FileRequestFilesResponse(BaseModel):
    files: list[FileRequestFileItem]
    total: int = 0
    page: int = 1
    page_size: int = 20


class FileRequestFileDownloadResponse(BaseModel):
    download_url: str


class MessageResponse(BaseModel):
    message: str
