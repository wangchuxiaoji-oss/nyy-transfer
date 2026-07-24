"""文件请求链接 API。"""

from __future__ import annotations

import asyncio
import json
import secrets
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.deps import get_current_user_required
from app.db.session import get_db, get_session_factory
from app.models.system import FileRequest, FileRequestFile
from app.models.user import User
from app.schemas.file_request import (
    FileRequestCommit,
    FileRequestCreate,
    FileRequestCreateResponse,
    FileRequestEdit,
    FileRequestFileDownloadResponse,
    FileRequestFileItem,
    FileRequestFilesResponse,
    FileRequestInboxGroup,
    FileRequestInboxResponse,
    FileRequestInfoResponse,
    FileRequestItem,
    FileRequestListResponse,
    FileRequestVerify,
    MessageResponse,
)
from app.services.app_config import get_quota_config
from app.services.doubao_client import DoubaoClientError, get_doubao_client, get_doubao_download_url
from app.services.quota import QuotaService
from app.utils.client_ip import get_client_ip as _get_client_ip
from app.utils.security import hash_secret, verify_secret
from app.utils.short_code import gen_short_code

router = APIRouter(prefix="/file-requests", tags=["file-requests"])
_REQUEST_COMMIT_LOCK_TTL_SECONDS = 60
_REQUEST_COMMIT_LOCK_WAIT_SECONDS = 5
_REQUEST_COMMIT_LOCK_RETRY_SECONDS = 0.05


async def _acquire_request_commit_lock(redis, code: str) -> tuple[str, str]:
    key = f"nyy:lock:file-request:{code}"
    token = secrets.token_urlsafe(16)
    deadline = asyncio.get_running_loop().time() + _REQUEST_COMMIT_LOCK_WAIT_SECONDS
    while True:
        acquired = await redis.set(key, token, ex=_REQUEST_COMMIT_LOCK_TTL_SECONDS, nx=True)
        if acquired:
            return key, token
        if asyncio.get_running_loop().time() >= deadline:
            raise HTTPException(status.HTTP_409_CONFLICT, "请求链接正在提交文件，请稍后重试")
        await asyncio.sleep(_REQUEST_COMMIT_LOCK_RETRY_SECONDS)


async def _release_request_commit_lock(redis, key: str, token: str) -> None:
    current = await redis.get(key)
    if current == token or current == token.encode():
        await redis.delete(key)


async def _get_request_or_404(code: str, db: AsyncSession) -> FileRequest:
    req = await db.scalar(select(FileRequest).where(FileRequest.code == code, FileRequest.revoked_at.is_(None)))
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "请求链接不存在")
    if req.expires_at and req.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "请求链接已过期")
    return req


async def _get_request_for_update_or_404(code: str, db: AsyncSession) -> FileRequest:
    req = await db.scalar(
        select(FileRequest)
        .where(FileRequest.code == code, FileRequest.revoked_at.is_(None))
        .with_for_update()
    )
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "请求链接不存在")
    if req.expires_at and req.expires_at < datetime.now(UTC):
        raise HTTPException(status.HTTP_410_GONE, "请求链接已过期")
    return req


async def _request_usage(db: AsyncSession, request_id) -> tuple[int, int]:
    result = await db.execute(
        select(func.count(FileRequestFile.id), func.coalesce(func.sum(FileRequestFile.size), 0))
        .where(FileRequestFile.request_id == request_id, FileRequestFile.deleted_at.is_(None))
    )
    count, total = result.one()
    return count or 0, total or 0


@router.post("", response_model=FileRequestCreateResponse)
async def create_file_request(
    body: FileRequestCreate,
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    code = gen_short_code()
    req = FileRequest(
        code=code,
        owner_id=user.id,
        title=body.title,
        password_hash=hash_secret(body.password) if body.password else None,
        expires_at=datetime.now(UTC) + timedelta(hours=body.expires_hours),
        max_files=body.max_files,
        max_bytes=body.max_bytes,
    )
    db.add(req)
    await db.commit()
    return FileRequestCreateResponse(code=code, url=f"{get_settings().app_base_url}/r/{code}")


@router.get("/{code}", response_model=FileRequestInfoResponse)
async def get_file_request(code: str):
    async with get_session_factory()() as db:
        req = await _get_request_for_update_or_404(code, db)
        count, total = await _request_usage(db, req.id)
        return FileRequestInfoResponse(
            code=req.code,
            title=req.title,
            has_password=req.password_hash is not None,
            expires_at=req.expires_at,
            max_files=req.max_files,
            max_bytes=req.max_bytes,
            received_files=count,
            received_bytes=total,
        )


@router.post("/{code}/verify", response_model=MessageResponse)
async def verify_file_request(code: str, body: FileRequestVerify):
    async with get_session_factory()() as db:
        req = await _get_request_or_404(code, db)
        if not req.password_hash:
            return MessageResponse(message="ok")
        if not verify_secret(body.password, req.password_hash):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "访问码错误")
        return MessageResponse(message="ok")


@router.patch("/my/{code}", response_model=MessageResponse)
async def edit_my_file_request(
    code: str,
    body: FileRequestEdit,
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    req = await db.scalar(select(FileRequest).where(FileRequest.code == code, FileRequest.owner_id == user.id))
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "收件链接不存在")
    if req.revoked_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "已撤销的收件链接不可编辑")

    now = datetime.now(UTC)
    if req.expires_at and req.expires_at <= now:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "已过期的收件链接不可编辑")

    received_files, received_bytes = await _request_usage(db, req.id)
    if body.max_files is not None and body.max_files < received_files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "文件数上限不能低于已收到文件数")
    if body.max_bytes is not None and body.max_bytes < received_bytes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "容量上限不能低于已收到容量")

    if body.title is not None:
        req.title = body.title
    if body.password is not None:
        req.password_hash = None if body.password == "" else hash_secret(body.password)
    if body.extend_hours is not None:
        base_time = req.expires_at if req.expires_at and req.expires_at > now else now
        req.expires_at = base_time + timedelta(hours=body.extend_hours)
    if body.max_files is not None:
        req.max_files = body.max_files
    if body.max_bytes is not None:
        req.max_bytes = body.max_bytes

    await db.commit()
    return MessageResponse(message="修改成功")


@router.delete("/my/{code}", response_model=MessageResponse)
async def revoke_my_file_request(
    code: str,
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    req = await db.scalar(select(FileRequest).where(FileRequest.code == code, FileRequest.owner_id == user.id))
    if not req:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "收件链接不存在")
    if req.revoked_at:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "收件链接已撤销")

    now = datetime.now(UTC)
    req.revoked_at = now
    await db.execute(
        update(FileRequestFile)
        .where(FileRequestFile.request_id == req.id, FileRequestFile.deleted_at.is_(None))
        .values(deleted_at=now)
    )
    await db.commit()
    return MessageResponse(message="收件链接已撤销")


@router.post("/{code}/commit", response_model=MessageResponse)
async def commit_file_request_upload(code: str, body: FileRequestCommit, request: Request):
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")
    file_infos: list[dict] = []
    for item in body.files:
        raw = await redis.get(f"nyy:commit:{item.commit_token}")
        if not raw:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传会话已过期，请重新选择文件上传")
        token_data = json.loads(raw)
        if token_data["store_uri"] != item.store_uri:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件校验失败，请重新上传")
        if token_data.get("request_code") != code:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件不属于当前请求链接")
        file_infos.append(token_data)

    lock_key, lock_token = await _acquire_request_commit_lock(redis, code)
    try:
        async with get_session_factory()() as db:
            req = await _get_request_for_update_or_404(code, db)
            if req.password_hash and not verify_secret(body.password, req.password_hash):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "访问码错误")
            count, total = await _request_usage(db, req.id)
            next_bytes = sum(f["file_size"] for f in file_infos)
            if count + len(file_infos) > req.max_files:
                raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "文件数量超过请求限制")
            if total + next_bytes > req.max_bytes:
                raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "文件大小超过请求限制")

            quota_config = await get_quota_config(db)
            quota_svc = QuotaService(redis)
            quota = await quota_svc.check_user_with_config(str(req.owner_id), next_bytes, quota_config)
            if not quota.allowed:
                raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, quota.reason)

            client = await get_doubao_client()
            for info in file_infos:
                try:
                    await client.commit_upload(
                        service_id=info["service_id"],
                        session_key=info["session_key"],
                        access_key=info["access_key"],
                        secret_key=info["secret_key"],
                        session_token=info["session_token"],
                    )
                except DoubaoClientError as exc:
                    raise HTTPException(status.HTTP_502_BAD_GATEWAY, "上传确认失败，请稍后重试") from exc
                db.add(FileRequestFile(
                    request_id=req.id,
                    original_name=info["file_name"],
                    size=info["file_size"],
                    tos_uri=info["store_uri"],
                    uploader_ip=_get_client_ip(request),
                ))
            await quota_svc.consume_user_with_config(str(req.owner_id), next_bytes, quota_config)
            await db.commit()

        for item in body.files:
            await redis.delete(f"nyy:commit:{item.commit_token}")
    finally:
        await _release_request_commit_lock(redis, lock_key, lock_token)
    return MessageResponse(message="上传成功")


@router.get("/my/list", response_model=FileRequestListResponse)
async def list_my_file_requests(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|revoked|expired)$"),
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|size_desc|files_desc|expires_asc)$"),
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(UTC)
    filters = [FileRequest.owner_id == user.id]
    if q:
      filters.append(or_(FileRequest.code.ilike(f"%{q}%"), FileRequest.title.ilike(f"%{q}%")))
    if status_filter == "revoked":
        filters.append(FileRequest.revoked_at.is_not(None))
    elif status_filter == "expired":
        filters.append(FileRequest.revoked_at.is_(None))
        filters.append(FileRequest.expires_at.is_not(None))
        filters.append(FileRequest.expires_at <= now)
    elif status_filter == "active":
        filters.append(FileRequest.revoked_at.is_(None))
        filters.append(or_(FileRequest.expires_at.is_(None), FileRequest.expires_at > now))

    total_count = await db.scalar(select(func.count()).select_from(FileRequest).where(*filters)) or 0
    order_by = {
        "created_desc": FileRequest.created_at.desc(),
        "created_asc": FileRequest.created_at.asc(),
        "size_desc": FileRequest.max_bytes.desc(),
        "files_desc": FileRequest.max_files.desc(),
        "expires_asc": FileRequest.expires_at.asc().nullslast(),
    }[sort]
    result = await db.execute(
        select(FileRequest)
        .where(*filters)
        .order_by(order_by)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    requests = result.scalars().all()
    items = []
    for req in requests:
        count, req_total_bytes = await _request_usage(db, req.id)
        items.append(FileRequestItem(
            code=req.code,
            title=req.title,
            created_at=req.created_at,
            expires_at=req.expires_at,
            file_count=count,
            total_bytes=req_total_bytes,
            revoked=req.revoked_at is not None,
        ))
    return FileRequestListResponse(requests=items, total=total_count, page=page, page_size=page_size)


@router.get("/my/inbox", response_model=FileRequestInboxResponse)
async def list_my_inbox(
    page: int = Query(1, ge=1),
    page_size: int = Query(10, ge=1, le=50),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|revoked|expired)$"),
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    now = datetime.now(UTC)
    filters = [FileRequest.owner_id == user.id]
    if q:
        like = f"%{q}%"
        matched_request_ids = select(FileRequestFile.request_id).where(
            FileRequestFile.original_name.ilike(like),
            FileRequestFile.deleted_at.is_(None),
        )
        filters.append(or_(FileRequest.code.ilike(like), FileRequest.title.ilike(like), FileRequest.id.in_(matched_request_ids)))
    if status_filter == "revoked":
        filters.append(FileRequest.revoked_at.is_not(None))
    elif status_filter == "expired":
        filters.append(FileRequest.revoked_at.is_(None))
        filters.append(FileRequest.expires_at.is_not(None))
        filters.append(FileRequest.expires_at <= now)
    elif status_filter == "active":
        filters.append(FileRequest.revoked_at.is_(None))
        filters.append(or_(FileRequest.expires_at.is_(None), FileRequest.expires_at > now))

    total_count = await db.scalar(select(func.count()).select_from(FileRequest).where(*filters)) or 0
    result = await db.execute(
        select(FileRequest)
        .where(*filters)
        .order_by(FileRequest.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    requests = result.scalars().all()
    request_ids = [req.id for req in requests]
    files_by_request = {req.id: [] for req in requests}
    if request_ids:
        files_result = await db.execute(
            select(FileRequestFile)
            .where(FileRequestFile.request_id.in_(request_ids), FileRequestFile.deleted_at.is_(None))
            .order_by(FileRequestFile.created_at.desc())
        )
        for file in files_result.scalars().all():
            files_by_request.setdefault(file.request_id, []).append(file)

    groups: list[FileRequestInboxGroup] = []
    for req in requests:
        files = files_by_request.get(req.id, [])
        groups.append(FileRequestInboxGroup(
            code=req.code,
            title=req.title,
            created_at=req.created_at,
            expires_at=req.expires_at,
            file_count=len(files),
            total_bytes=sum(file.size for file in files),
            max_files=req.max_files,
            max_bytes=req.max_bytes,
            has_password=req.password_hash is not None,
            revoked=req.revoked_at is not None,
            files=[FileRequestFileItem(
                id=str(file.id),
                request_code=req.code,
                file_name=file.original_name,
                file_size=file.size,
                created_at=file.created_at,
            ) for file in files],
        ))

    return FileRequestInboxResponse(groups=groups, total=total_count, page=page, page_size=page_size)


@router.get("/my/files", response_model=FileRequestFilesResponse)
async def list_request_files(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=128),
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    filters = [FileRequest.owner_id == user.id, FileRequestFile.deleted_at.is_(None)]
    if q:
        like = f"%{q}%"
        filters.append(or_(FileRequest.code.ilike(like), FileRequestFile.original_name.ilike(like)))

    total = await db.scalar(
        select(func.count())
        .select_from(FileRequestFile)
        .join(FileRequest, FileRequest.id == FileRequestFile.request_id)
        .where(*filters)
    ) or 0
    result = await db.execute(
        select(FileRequestFile, FileRequest.code)
        .join(FileRequest, FileRequest.id == FileRequestFile.request_id)
        .where(*filters)
        .order_by(FileRequestFile.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    files = [
        FileRequestFileItem(
            id=str(row[0].id),
            request_code=row[1],
            file_name=row[0].original_name,
            file_size=row[0].size,
            created_at=row[0].created_at,
        )
        for row in result.all()
    ]
    return FileRequestFilesResponse(files=files, total=total, page=page, page_size=page_size)


@router.get("/my/files/{file_id}/download", response_model=FileRequestFileDownloadResponse)
async def download_request_file(
    file_id: str,
    user: User = Depends(get_current_user_required),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(FileRequestFile)
        .join(FileRequest, FileRequest.id == FileRequestFile.request_id)
        .where(
            FileRequestFile.id == file_id,
            FileRequest.owner_id == user.id,
            FileRequestFile.deleted_at.is_(None),
        )
    )
    file = result.scalar_one_or_none()
    if not file:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "文件不存在")
    return FileRequestFileDownloadResponse(download_url=await get_doubao_download_url(file.tos_uri))
