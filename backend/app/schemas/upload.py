"""上传相关的 Pydantic schemas。"""

from __future__ import annotations

from pydantic import BaseModel, Field


class UploadInitRequest(BaseModel):
    """POST /api/v1/uploads/init 请求体（每个文件/chunk 调一次）。"""
    file_name: str = Field(..., min_length=1, max_length=255)
    # max 10 GiB（单个 chunk 最大 512MB，但这里填的是 chunk 大小）
    file_size: int = Field(..., ge=0, le=10 * 1024 * 1024 * 1024)
    file_ext: str = Field(default="", max_length=16)
    content_type: str = Field(default="", max_length=127)
    captcha_token: str = Field(default="", max_length=4096)
    # 大文件分片字段（普通文件不传或传默认值）
    chunk_index: int = Field(default=0, ge=0)
    chunk_total: int = Field(default=1, ge=1, le=50)  # 10GB / 512MB ≈ 20, 留余量
    logical_file_id: str = Field(default="", max_length=36)  # 前端生成的 UUID
    logical_file_size: int = Field(default=0, ge=0)  # 逻辑文件总大小（用于配额预检）
    # 文件请求上传场景：访客上传到请求链接，占创建者配额
    request_code: str = Field(default="", max_length=16)
    request_password: str = Field(default="", max_length=4)


class UploadInitResponse(BaseModel):
    """POST /api/v1/uploads/init 响应体。"""
    upload_url: str
    authorization: str
    store_uri: str
    commit_token: str  # 前端 commit 时回传


class CommitFileItem(BaseModel):
    """commit 请求中的单个文件/chunk。"""
    commit_token: str = Field(..., min_length=1, max_length=512)
    store_uri: str = Field(..., min_length=1, max_length=512)
    # 大文件分片字段
    logical_file_id: str = Field(default="", max_length=36)
    chunk_index: int = Field(default=0, ge=0)
    chunk_total: int = Field(default=1, ge=1, le=50)


class UploadCommitRequest(BaseModel):
    """POST /api/v1/uploads/commit 请求体。

    支持单文件、多文件、大文件分片：
    - 普通单文件：files 数组长度为 1，logical_file_id 为空
    - 普通多文件：files 数组长度 > 1，各自 logical_file_id 为空
    - 大文件分片：files 数组包含同一 logical_file_id 的多个 chunk
    - 混合：普通文件 + 大文件 chunk 混合
    """
    files: list[CommitFileItem] = Field(default_factory=list, max_length=500)
    # 空目录路径（例如 "folder/empty/"），用于下载 ZIP 时恢复目录结构
    empty_dirs: list[str] = Field(default_factory=list, max_length=500)
    # 可选：提取码（4位数字）
    password: str = Field(default="", max_length=4, pattern=r"^[0-9]{0,4}$")
    # 可选：过期时间（小时），0 = 不过期
    expires_hours: int = Field(default=0, ge=0, le=720)  # max 30 days
    # 可选：最大下载次数，0 = 不限制
    max_downloads: int = Field(default=0, ge=0, le=1000)
    # 可选：邮件收件人，最多 5 个
    recipients: list[str] = Field(default_factory=list, max_length=5)


class UploadCommitResponse(BaseModel):
    """POST /api/v1/uploads/commit 响应体。"""
    share_code: str
    share_url: str
    file_count: int = 1
    revoke_token: str | None = None


class ErrorResponse(BaseModel):
    """通用错误响应。"""
    detail: str
