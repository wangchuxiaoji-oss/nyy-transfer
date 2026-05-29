"""上传 API：init + commit 两步流程。

POST /api/v1/uploads/init   — 鉴权 + 配额 + 签发 TOS 上传凭证
POST /api/v1/uploads/commit — 浏览器上传完成后确认，创建 Share
"""

from __future__ import annotations

import json
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status

from app.core.config import get_settings
from app.core.deps import get_current_user_optional
from app.models.user import User
from app.schemas.upload import (
    UploadCommitRequest,
    UploadCommitResponse,
    UploadInitRequest,
    UploadInitResponse,
)
from app.services.doubao_client import (
    DoubaoClientError,
    get_doubao_client,
)
from app.services.app_config import get_quota_config
from app.utils.short_code import gen_short_code

log = logging.getLogger(__name__)
router = APIRouter(prefix="/uploads", tags=["uploads"])

# commit_token TTL (Redis)
# 大文件（5GB+）在慢速网络下可能需要数小时上传完毕，
# 早期分片的 token 必须存活到整个文件 commit 为止。
_COMMIT_TOKEN_TTL = timedelta(hours=24)
_EMPTY_URI_PREFIX = "nyy-empty://"
_MAX_EMPTY_DIRS = 500
_MAX_EMPTY_DIR_PATH_LEN = 512


def _get_client_ip(request: Request) -> str:
    """从 X-Forwarded-For 或 client.host 获取真实 IP。"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


def _active_share_limit_message(active_count: int, max_shares: int) -> str:
    return f"活跃分享数量已达上限（{active_count}/{max_shares}），请先撤销已有分享"


def _normalize_empty_dirs(paths: list[str]) -> list[str]:
    """校验并规范化空目录路径，避免 ZIP Slip 和异常路径。"""
    normalized: list[str] = []
    seen: set[str] = set()

    for raw in paths:
        path = raw.strip()
        if not path:
            continue
        if "\x00" in path or "\\" in path or path.startswith("/"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "空文件夹路径无效")

        parts = [part for part in path.split("/") if part and part != "."]
        if not parts or any(part == ".." for part in parts):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "空文件夹路径无效")
        if len(parts[0]) == 2 and parts[0][1] == ":":
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "空文件夹路径无效")

        item = "/".join(parts) + "/"
        if len(item) > _MAX_EMPTY_DIR_PATH_LEN:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "空文件夹路径过长")
        if item not in seen:
            seen.add(item)
            normalized.append(item)

    if len(normalized) > _MAX_EMPTY_DIRS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"空文件夹数量超过上限（最多 {_MAX_EMPTY_DIRS} 个）")
    return normalized


async def _count_active_shares(db, *, user_id: str | None, ip: str) -> int:
    from app.models.share import Share
    from sqlalchemy import cast, func, or_, select
    from sqlalchemy.dialects.postgresql import INET

    now = datetime.now(timezone.utc)
    active_filters = (
        Share.revoked_at.is_(None),
        Share.banned_at.is_(None),
        or_(Share.expires_at.is_(None), Share.expires_at > now),
        or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
    )
    if user_id:
        stmt = select(func.count()).select_from(Share).where(
            Share.owner_id == user_id,
            *active_filters,
        )
    else:
        stmt = select(func.count()).select_from(Share).where(
            Share.ip_created_from == cast(ip, INET),
            *active_filters,
        )

    result = await db.execute(stmt)
    return result.scalar() or 0


@router.get("/quota", summary="查询当前配额")
async def get_quota(
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    """返回当前用户/IP 的剩余配额信息。"""
    ip = _get_client_ip(request)
    redis = request.app.state.redis
    used = 0

    from app.db.session import get_session_factory
    async with get_session_factory()() as db:
        quota_config = await get_quota_config(db)

    if user and redis:
        key = f"nyy:quota:user:{user.id}:bytes"
        used = int(await redis.get(key) or 0)
        limit = quota_config["user_max_file_bytes"]
        ttl_hours = quota_config["user_ttl_hours"]
    else:
        if redis:
            used = int(await redis.get(f"nyy:quota:ip:{ip}:bytes") or 0)
        limit = quota_config["guest_max_file_bytes"]
        ttl_hours = quota_config["guest_ttl_hours"]

    return {
        "used_bytes": used,
        "limit_bytes": limit,
        "remaining_bytes": max(0, limit - used),
        "ttl_hours": ttl_hours,
    }


@router.post(
    "/init",
    response_model=UploadInitResponse,
    status_code=status.HTTP_200_OK,
    summary="初始化上传",
)
async def upload_init(
    body: UploadInitRequest,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    """Step 1: 校验配额 + hCaptcha，调豆包 prepare/apply，返回 TOS 上传凭证。"""
    settings = get_settings()
    ip = _get_client_ip(request)

    # --- 大文件权限检查：>1GB 需要登录 ---
    _ONE_GB = 1024 * 1024 * 1024
    is_large_file = body.logical_file_size > _ONE_GB or body.file_size > _ONE_GB
    if is_large_file and not user:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "上传超过 1GB 的文件需要登录")

    # 单个 chunk 不能超过 1GB（TOS 限制）
    if body.file_size > _ONE_GB:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "单个分片不能超过 1GB")

    # --- hCaptcha 校验（dev 环境跳过） ---
    if not settings.is_dev and settings.hcaptcha_secret:
        if not body.captcha_token:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "请先完成人机验证")

    # --- 配额检查 ---
    redis = request.app.state.redis
    request_owner_id = None
    if redis is not None:
        from app.services.quota import QuotaService
        quota_svc = QuotaService(redis)
        from app.db.session import get_session_factory
        async with get_session_factory()() as db:
            quota_config = await get_quota_config(db)
            if body.request_code:
                from sqlalchemy import select
                from app.models.system import FileRequest
                from app.utils.security import verify_secret
                req = await db.scalar(select(FileRequest).where(FileRequest.code == body.request_code, FileRequest.revoked_at.is_(None)))
                if not req:
                    raise HTTPException(status.HTTP_404_NOT_FOUND, "请求链接不存在")
                if req.expires_at and req.expires_at < datetime.now(timezone.utc):
                    raise HTTPException(status.HTTP_410_GONE, "请求链接已过期")
                if req.password_hash and not verify_secret(body.request_password, req.password_hash):
                    raise HTTPException(status.HTTP_403_FORBIDDEN, "访问码错误")
                request_owner_id = str(req.owner_id)
            else:
                active_user_id = str(user.id) if user else None
                active_count = await _count_active_shares(db, user_id=active_user_id, ip=ip)
                max_shares = quota_config[
                    "user_max_active_shares" if active_user_id else "guest_max_active_shares"
                ]
                if active_count >= max_shares:
                    raise HTTPException(
                        status.HTTP_429_TOO_MANY_REQUESTS,
                        _active_share_limit_message(active_count, max_shares),
                    )
        if request_owner_id:
            # 大文件：仅第一个 chunk 做配额预检（按逻辑文件总大小）
            quota_size = body.logical_file_size if body.logical_file_size > 0 and body.chunk_index == 0 else body.file_size
            # 非第一个 chunk 跳过配额检查（commit 时统一扣减）
            if body.chunk_index == 0:
                result = await quota_svc.check_user_with_config(request_owner_id, quota_size, quota_config)
            else:
                result = None
        elif user:
            quota_size = body.logical_file_size if body.logical_file_size > 0 and body.chunk_index == 0 else body.file_size
            if body.chunk_index == 0:
                result = await quota_svc.check_user_with_config(str(user.id), quota_size, quota_config)
            else:
                result = None
        else:
            result = await quota_svc.check_guest_with_config(ip, body.file_size, quota_config)
        if result is not None and not result.allowed:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, result.reason)

    if body.file_size == 0:
        store_uri = f"{_EMPTY_URI_PREFIX}{secrets.token_urlsafe(16)}"
        upload_url = ""
        authorization = ""
        token_data = {
            "ip": ip,
            "user_id": request_owner_id or (str(user.id) if user else None),
            "request_code": body.request_code or None,
            "file_name": body.file_name,
            "file_size": body.file_size,
            "file_ext": body.file_ext,
            "content_type": body.content_type,
            "store_uri": store_uri,
            "session_key": None,
            "service_id": None,
            "access_key": None,
            "secret_key": None,
            "session_token": None,
            "is_empty": True,
            "chunk_index": body.chunk_index,
            "chunk_total": body.chunk_total,
            "logical_file_id": body.logical_file_id or None,
            "logical_file_size": body.logical_file_size,
        }
    else:
        # --- 调豆包 init_upload ---
        try:
            client = await get_doubao_client()
            init_result = await client.init_upload(
                file_size=body.file_size,
                file_ext=body.file_ext or body.file_name.rsplit(".", 1)[-1] if "." in body.file_name else "",
            )
        except DoubaoClientError as e:
            log.error("doubao init_upload failed: %s", e)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "上传服务暂时不可用，请稍后重试")

        store_uri = init_result.store_uri
        upload_url = init_result.upload_url
        authorization = init_result.authorization
        token_data = {
            "ip": ip,
            "user_id": request_owner_id or (str(user.id) if user else None),
            "request_code": body.request_code or None,
            "file_name": body.file_name,
            "file_size": body.file_size,
            "file_ext": body.file_ext,
            "content_type": body.content_type,
            "store_uri": init_result.store_uri,
            "session_key": init_result.session_key,
            "service_id": init_result.service_id,
            "access_key": init_result.access_key,
            "secret_key": init_result.secret_key,
            "session_token": init_result.session_token,
            "is_empty": False,
            "chunk_index": body.chunk_index,
            "chunk_total": body.chunk_total,
            "logical_file_id": body.logical_file_id or None,
            "logical_file_size": body.logical_file_size,
        }

    # --- 生成 commit_token，存 Redis ---
    commit_token = secrets.token_urlsafe(32)
    if redis is not None:
        await redis.setex(
            f"nyy:commit:{commit_token}",
            int(_COMMIT_TOKEN_TTL.total_seconds()),
            json.dumps(token_data),
        )

    return UploadInitResponse(
        upload_url=upload_url,
        authorization=authorization,
        store_uri=store_uri,
        commit_token=commit_token,
    )


@router.post(
    "/commit",
    response_model=UploadCommitResponse,
    status_code=status.HTTP_201_CREATED,
    summary="确认上传完成（支持多文件）",
)
async def upload_commit(
    body: UploadCommitRequest,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    """验证所有 commit_token，调豆包 commit，创建 Share + N 个 ShareFile。"""
    settings = get_settings()
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")

    empty_dirs = _normalize_empty_dirs(body.empty_dirs)
    if not body.files and not empty_dirs:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "请至少选择一个文件或空文件夹")

    # --- 验证所有 commit_token，收集文件信息 ---
    file_infos: list[dict] = []
    for item in body.files:
        token_key = f"nyy:commit:{item.commit_token}"
        raw = await redis.get(token_key)
        if not raw:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传会话已过期，请重新选择文件上传")
        token_data = json.loads(raw)
        if token_data["store_uri"] != item.store_uri:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件校验失败，请重新上传")
        # 合并 commit 请求中的 chunk 信息（优先使用请求中的值）
        token_data["_logical_file_id"] = item.logical_file_id or token_data.get("logical_file_id")
        token_data["_chunk_index"] = item.chunk_index
        token_data["_chunk_total"] = item.chunk_total
        file_infos.append(token_data)

    # 取第一个文件的信息；纯空目录分享则取当前请求身份/IP
    ip = file_infos[0]["ip"] if file_infos else _get_client_ip(request)
    user_id = file_infos[0].get("user_id") if file_infos else (str(user.id) if user else None)
    total_bytes = sum(f["file_size"] for f in file_infos)

    # --- 活跃分享数限制 ---
    from app.db.session import get_session_factory
    from app.models.share import Share, ShareFile

    factory = get_session_factory()
    async with factory() as db:
        quota_config = await get_quota_config(db)
        active_count = await _count_active_shares(db, user_id=user_id, ip=ip)
        if user_id:
            max_shares = quota_config["user_max_active_shares"]
        else:
            max_shares = quota_config["guest_max_active_shares"]

    if active_count >= max_shares:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            _active_share_limit_message(active_count, max_shares),
        )

    # --- 调豆包 CommitImageUpload（每个文件） ---
    client = None
    for info in file_infos:
        if info.get("is_empty"):
            continue
        if client is None:
            client = await get_doubao_client()
        try:
            await client.commit_upload(
                service_id=info["service_id"],
                session_key=info["session_key"],
                access_key=info["access_key"],
                secret_key=info["secret_key"],
                session_token=info["session_token"],
            )
        except DoubaoClientError as e:
            log.error("doubao commit_upload failed for %s: %s", info["store_uri"], e)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "上传确认失败，请稍后重试")

    # --- 创建 Share + ShareFiles ---
    share_code = gen_short_code()

    password_hash = None
    if body.password:
        from app.utils.security import hash_secret
        password_hash = hash_secret(body.password)

    expires_at = None
    if body.expires_hours > 0:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=body.expires_hours)

    # 游客生成 revoke_token，登录用户不需要（可通过 /my 管理）
    import secrets
    revoke_token = secrets.token_urlsafe(24) if not user_id else None

    async with factory() as db:
        share = Share(
            code=share_code,
            owner_id=user_id,
            ip_created_from=ip,
            total_bytes=total_bytes,
            empty_dirs=empty_dirs,
            password_hash=password_hash,
            expires_at=expires_at,
            max_downloads=body.max_downloads,
            revoke_token=revoke_token,
        )
        for idx, info in enumerate(file_infos):
            import uuid as _uuid
            logical_fid = info.get("_logical_file_id")
            logical_file_uuid = _uuid.UUID(logical_fid) if logical_fid else None
            chunk_idx = info.get("_chunk_index", idx)
            chunk_tot = info.get("_chunk_total", 1)

            sf = ShareFile(
                share=share,
                original_name=info["file_name"],
                size=info["file_size"],
                tos_uri=info["store_uri"],
                content_type=info.get("content_type") or None,
                chunk_index=chunk_idx,
                chunk_total=chunk_tot,
                logical_file_id=logical_file_uuid,
            )
            db.add(sf)
        db.add(share)
        await db.commit()
        await db.refresh(share)

    # --- 扣减配额 ---
    from app.services.quota import QuotaService
    quota_svc = QuotaService(redis)
    async with factory() as db:
        quota_config = await get_quota_config(db)
    if user_id:
        await quota_svc.consume_user_with_config(user_id, total_bytes, quota_config)
    else:
        await quota_svc.consume_guest_with_config(ip, total_bytes, quota_config)

    # --- 删除所有 commit_token ---
    for item in body.files:
        await redis.delete(f"nyy:commit:{item.commit_token}")

    share_url = f"{settings.app_base_url}/{share_code}"
    # 计算逻辑文件数（按 logical_file_id 分组，无 ID 的各算一个）
    logical_ids = set()
    standalone_count = 0
    for info in file_infos:
        lfid = info.get("_logical_file_id")
        if lfid:
            logical_ids.add(lfid)
        else:
            standalone_count += 1
    logical_file_count = len(logical_ids) + standalone_count
    log.info("share created: code=%s logical_files=%d chunks=%d size=%d", share_code, logical_file_count, len(file_infos), total_bytes)

    return UploadCommitResponse(share_code=share_code, share_url=share_url, file_count=logical_file_count, revoke_token=revoke_token)
