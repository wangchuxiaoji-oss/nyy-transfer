"""上传 API：init + commit 两步流程。

POST /api/v1/uploads/init   — 鉴权 + 配额 + 签发 TOS 上传凭证
POST /api/v1/uploads/commit — 浏览器上传完成后确认，创建 Share
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select

from app.core.config import get_settings
from app.core.deps import get_current_user_optional
from app.models.user import User
from app.schemas.upload import (
    MultipartInitRequest,
    MultipartInitResponse,
    MultipartMergeRequest,
    MultipartMergeResponse,
    UploadBatchCancelRequest,
    UploadCommitRequest,
    UploadCommitResponse,
    UploadInitRequest,
    UploadInitResponse,
)
from app.services.doubao_client import (
    DoubaoClientError,
    get_doubao_client,
)
from app.services.growth import (
    GrowthServiceError,
    assert_coupon_consumed_by_share,
    consume_retention_coupon,
)
from app.services.playback_assets import attach_playback_assets_for_single_object
from app.services.quota import QuotaService, get_quota_snapshot, quota_identity
from app.services.quota_policy import get_effective_policy, get_policy_config_for_version
from app.utils.client_ip import get_client_ip as _get_client_ip
from app.utils.client_ip import get_guest_id as _get_guest_id
from app.utils.short_code import gen_short_code

log = logging.getLogger(__name__)
router = APIRouter(prefix="/uploads", tags=["uploads"])

# commit_token TTL (Redis)
# 大文件（10GB）在极慢网络下可能上传超过 24 小时，早期分片的
# commit_token 必须存活到整个批次最终 commit 为止。
_COMMIT_TOKEN_TTL = timedelta(hours=72)
_EMPTY_URI_PREFIX = "nyy-empty://"
_MAX_EMPTY_DIRS = 500
_MAX_EMPTY_DIR_PATH_LEN = 512
_MAX_MEDIA_METADATA_BYTES = 64 * 1024

# multipart 上传参数（经真机实测，见 docs/spike-multipart-upload.md）
_PART_SIZE = 64 * 1024 * 1024            # 64MB 每片
_MULTIPART_THRESHOLD = 20 * 1024 * 1024  # >20MB 走 multipart（后端阈值）
_LARGE_FILE_SIZE = 1024 * 1024 * 1024    # 1GB，isLargeFile 分界

# 真机实测：large file（gateway 模式）下，除最后一片外每个 part 必须 ≥ 5MB，
# 否则 merge 会被服务端拒绝（TLB 500）。_PART_SIZE 远大于此，这里加断言防误改。
_MIN_NON_LAST_PART_SIZE = 5 * 1024 * 1024
assert _PART_SIZE >= _MIN_NON_LAST_PART_SIZE, "_PART_SIZE 必须 ≥ 5MB，否则大文件 merge 会 500"

_CRC32_RE = re.compile(r"^[0-9a-f]{8}$")
def _is_valid_crc32(value: str) -> bool:
    """校验 CRC32 格式（8 位小写 hex）。"""
    return bool(_CRC32_RE.match(value or ""))
def _active_share_limit_message(active_count: int, max_shares: int) -> str:
    return f"活跃分享数量已达上限（{active_count}/{max_shares}），请先撤销已有分享"


def _format_gib(value: int) -> str:
    return f"{value / (1024 ** 3):g}GB"


def _validate_upload_file_size(
    file_size: int,
    *,
    max_file_size: int,
    is_guest: bool,
) -> None:
    if file_size <= max_file_size:
        return
    if is_guest:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"游客单文件上限为 {_format_gib(max_file_size)}，登录后可上传更大文件",
        )
    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        f"单文件大小超过 {_format_gib(max_file_size)} 上限",
    )


def _validate_share_expiry(expires_hours: int, *, options: list[int], role: str) -> None:
    if expires_hours not in options:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{role}分享有效期不在允许选项中")


def _share_logical_file_count(share) -> int:
    logical_files = share.__dict__.get("logical_files")
    if logical_files is not None:
        return len(logical_files)
    files = share.__dict__.get("files") or []
    logical_ids = set()
    standalone_count = 0
    for file in files:
        if file.logical_file_id:
            logical_ids.add(str(file.logical_file_id))
        else:
            standalone_count += 1
    return len(logical_ids) + standalone_count


def _upload_commit_response(settings, share, file_count: int | None = None) -> UploadCommitResponse:
    return UploadCommitResponse(
        share_code=share.code,
        share_url=f"{settings.app_base_url}/{share.code}",
        file_count=file_count if file_count is not None else _share_logical_file_count(share),
        revoke_token=share.revoke_token,
    )


async def _settle_share_quota(share, redis, policy, db) -> None:
    if share.quota_settled_at is not None:
        return
    if share.quota_scope and share.quota_identity:
        service = QuotaService(redis)
        for reservation_id in share.quota_reservation_ids:
            await service.consume_reservation(share.quota_scope, share.quota_identity, reservation_id)
        if share.quota_legacy_bytes:
            await service.consume_unreserved(
                scope=share.quota_scope,
                identity=share.quota_identity,
                policy=policy,
                size=share.quota_legacy_bytes,
                settlement_id=f"share:{share.id}",
            )
        for batch_id in share.quota_batch_ids:
            await service.finalize_batch(share.quota_scope, share.quota_identity, batch_id)
    share.quota_settled_at = datetime.now(UTC)
    await db.commit()


def _parse_uuid(value: str, field_name: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (TypeError, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"{field_name} 无效") from None


def _coupon_http_exception(exc: GrowthServiceError) -> HTTPException:
    if exc.code == "coupon_not_found":
        return HTTPException(status.HTTP_404_NOT_FOUND, exc.message)
    return HTTPException(status.HTTP_409_CONFLICT, exc.message)


def _sanitize_media_metadata(value: dict | None) -> dict | None:
    if not value:
        return None
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return {
            "probe_status": "failed",
            "probe_error": "metadata_not_json_serializable",
        }
    if len(encoded.encode("utf-8")) > _MAX_MEDIA_METADATA_BYTES:
        return {
            "probe_status": "failed",
            "probe_error": "metadata_too_large",
        }
    return value


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


async def _count_active_shares(db, *, user_id: str | None, ip: str, guest_id: str | None = None) -> int:
    from sqlalchemy import and_, cast, func, or_, select
    from sqlalchemy.dialects.postgresql import INET

    from app.models.share import Share

    now = datetime.now(UTC)
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
        legacy_ip_filter = and_(Share.guest_id.is_(None), Share.ip_created_from == cast(ip, INET))
        if guest_id:
            guest_filter = Share.guest_id == guest_id
            if guest_id == f"ip:{ip}":
                guest_filter = or_(guest_filter, legacy_ip_filter)
            stmt = select(func.count()).select_from(Share).where(
                guest_filter,
                *active_filters,
            )
        else:
            stmt = select(func.count()).select_from(Share).where(
                legacy_ip_filter,
                *active_filters,
            )

    result = await db.execute(stmt)
    return result.scalar() or 0


@router.get("/quota", summary="查询当前配额")
async def get_quota(
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    """返回当前用户/游客身份的剩余配额信息。"""
    ip = _get_client_ip(request)
    guest_id = _get_guest_id(request, ip)
    from app.db.session import get_session_factory
    async with get_session_factory()() as db:
        return await get_quota_snapshot(request.app.state.redis, db, user=user, guest_id=guest_id)


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
    """Step 1: 校验配额，调豆包 prepare/apply，返回 TOS 上传凭证。"""
    ip = _get_client_ip(request)
    guest_id = _get_guest_id(request, ip)

    # 单个 chunk 不能超过 1GB（TOS 限制）
    _ONE_GB = 1024 * 1024 * 1024
    if body.file_size > _ONE_GB:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "单个分片不能超过 1GB")

    # --- 配额检查 ---
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")
    quota_svc = QuotaService(redis)
    from app.db.session import get_session_factory
    from app.models.system import FileRequest
    from app.utils.security import verify_secret

    request_owner_id = None
    async with get_session_factory()() as db:
        effective = await get_effective_policy(db)
        if body.request_code:
            req = await db.scalar(select(FileRequest).where(
                FileRequest.code == body.request_code,
                FileRequest.revoked_at.is_(None),
            ))
            if not req:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "请求链接不存在")
            if req.expires_at and req.expires_at < datetime.now(UTC):
                raise HTTPException(status.HTTP_410_GONE, "请求链接已过期")
            if req.password_hash and not verify_secret(body.request_password, req.password_hash):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "访问码错误")
            request_owner_id = str(req.owner_id)
            audience_policy = effective.config.user
            max_file_size = req.max_file_bytes
        else:
            active_user_id = str(user.id) if user else None
            audience_policy = effective.config.user if user else effective.config.guest
            max_file_size = audience_policy.max_file_bytes
            active_count = await _count_active_shares(
                db,
                user_id=active_user_id,
                ip=ip,
                guest_id=None if active_user_id else guest_id,
            )
            if active_count >= audience_policy.max_active_shares:
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    _active_share_limit_message(active_count, audience_policy.max_active_shares),
                )

    if body.chunk_total > 1 and body.logical_file_size <= 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "分片上传必须提供逻辑文件总大小")
    logical_file_size = body.file_size if body.chunk_total == 1 else body.logical_file_size
    _validate_upload_file_size(
        logical_file_size,
        max_file_size=max_file_size,
        is_guest=not user and not request_owner_id,
    )
    scope, identity = quota_identity(
        user_id=request_owner_id or (str(user.id) if user else None),
        guest_id=guest_id,
    )
    batch_id = body.upload_batch_id.strip() or f"legacy-{scope}-{identity}"
    logical_file_id = body.logical_file_id or str(uuid.uuid4())
    quota_reservation_id = f"{batch_id}:{logical_file_id}"
    reservation_created = False
    if body.chunk_index == 0:
        result = await quota_svc.reserve(
            scope=scope,
            identity=identity,
            policy=audience_policy,
            policy_version=effective.version,
            batch_id=batch_id,
            reservation_id=quota_reservation_id,
            size=logical_file_size,
        )
        if not result.allowed:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, result.reason)
        reservation_created = result.created

    if body.file_size == 0:
        store_uri = f"{_EMPTY_URI_PREFIX}{secrets.token_urlsafe(16)}"
        upload_url = ""
        authorization = ""
        token_data = {
            "ip": ip,
            "guest_id": guest_id,
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
            "logical_file_id": logical_file_id,
            "logical_file_size": body.logical_file_size,
            "upload_batch_id": batch_id,
            "quota_scope": scope,
            "quota_identity": identity,
            "quota_reservation_id": quota_reservation_id,
            "quota_policy_version": effective.version,
            "quota_reserved_size": logical_file_size,
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
            if reservation_created:
                await quota_svc.release_reservation(scope, identity, quota_reservation_id)
            log.error("doubao init_upload failed: %s", e)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "上传服务暂时不可用，请稍后重试") from e

        store_uri = init_result.store_uri
        upload_url = init_result.upload_url
        authorization = init_result.authorization
        token_data = {
            "ip": ip,
            "guest_id": guest_id,
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
            "logical_file_id": logical_file_id,
            "logical_file_size": body.logical_file_size,
            "upload_batch_id": batch_id,
            "quota_scope": scope,
            "quota_identity": identity,
            "quota_reservation_id": quota_reservation_id,
            "quota_policy_version": effective.version,
            "quota_reserved_size": logical_file_size,
        }

    # --- 生成 commit_token，存 Redis ---
    commit_token = secrets.token_urlsafe(32)
    commit_token_expires_at = datetime.now(UTC) + _COMMIT_TOKEN_TTL
    try:
        await redis.setex(
            f"nyy:commit:{commit_token}",
            int(_COMMIT_TOKEN_TTL.total_seconds()),
            json.dumps(token_data),
        )
    except Exception:
        if reservation_created:
            await quota_svc.release_reservation(scope, identity, quota_reservation_id)
        raise

    return UploadInitResponse(
        upload_url=upload_url,
        authorization=authorization,
        store_uri=store_uri,
        commit_token=commit_token,
        commit_token_expires_at=commit_token_expires_at,
    )


@router.post("/cancel", summary="取消上传批次并释放预留额度")
async def upload_cancel(
    body: UploadBatchCancelRequest,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")
    ip = _get_client_ip(request)
    guest_id = _get_guest_id(request, ip)
    owner_id = str(user.id) if user else None
    request_id = None
    if body.request_code:
        from app.db.session import get_session_factory
        from app.models.system import FileRequest
        from app.utils.security import verify_secret

        async with get_session_factory()() as db:
            req = await db.scalar(select(FileRequest).where(
                FileRequest.code == body.request_code,
                FileRequest.revoked_at.is_(None),
            ))
            if not req:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "请求链接不存在")
            if req.password_hash and not verify_secret(body.request_password, req.password_hash):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "访问码错误")
            owner_id = str(req.owner_id)
            request_id = req.id
    scope, identity = quota_identity(user_id=owner_id, guest_id=guest_id)
    from app.db.session import get_session_factory
    from app.models.share import Share
    from app.models.system import FileRequestUpload

    async with get_session_factory()() as db:
        committed_share = await db.scalar(select(Share.id).where(
            Share.upload_batch_id == body.upload_batch_id,
            Share.owner_id == owner_id if owner_id else Share.guest_id == guest_id,
        ))
        committed_request = None
        if request_id:
            committed_request = await db.scalar(select(FileRequestUpload.id).where(
                FileRequestUpload.request_id == request_id,
                FileRequestUpload.upload_batch_id == body.upload_batch_id,
            ))
        if committed_share or committed_request:
            raise HTTPException(status.HTTP_409_CONFLICT, "上传批次已提交，不能取消")
    released = await QuotaService(redis).cancel_batch(scope, identity, body.upload_batch_id)
    return {"message": "上传批次已取消", "released_reservations": released}


@router.post(
    "/multipart-init",
    response_model=MultipartInitResponse,
    summary="发起 multipart 上传",
)
async def multipart_init(
    body: MultipartInitRequest,
    request: Request,
    user: User | None = Depends(get_current_user_optional),
):
    """Step 1-alt: 大文件 multipart 上传初始化，返回 uploadID + TOS 凭证。"""
    ip = _get_client_ip(request)
    guest_id = _get_guest_id(request, ip)

    # TOS 在超过 1GB 时切换到 large file 模式。
    is_large_file = body.file_size > _LARGE_FILE_SIZE

    # 配额检查
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")

    request_owner_id = None
    quota_svc = QuotaService(redis)
    from app.db.session import get_session_factory
    from app.models.system import FileRequest
    from app.utils.security import verify_secret

    async with get_session_factory()() as db:
        effective = await get_effective_policy(db)
        if body.request_code:
            req = await db.scalar(select(FileRequest).where(
                FileRequest.code == body.request_code, FileRequest.revoked_at.is_(None)
            ))
            if not req:
                raise HTTPException(status.HTTP_404_NOT_FOUND, "请求链接不存在")
            if req.expires_at and req.expires_at < datetime.now(UTC):
                raise HTTPException(status.HTTP_410_GONE, "请求链接已过期")
            if req.password_hash and not verify_secret(body.request_password, req.password_hash):
                raise HTTPException(status.HTTP_403_FORBIDDEN, "访问码错误")
            request_owner_id = str(req.owner_id)
            audience_policy = effective.config.user
            max_file_size = req.max_file_bytes
        else:
            active_user_id = str(user.id) if user else None
            audience_policy = effective.config.user if user else effective.config.guest
            max_file_size = audience_policy.max_file_bytes
            active_count = await _count_active_shares(
                db,
                user_id=active_user_id,
                ip=ip,
                guest_id=None if active_user_id else guest_id,
            )
            if active_count >= audience_policy.max_active_shares:
                raise HTTPException(
                    status.HTTP_429_TOO_MANY_REQUESTS,
                    _active_share_limit_message(active_count, audience_policy.max_active_shares),
                )

    _validate_upload_file_size(
        body.file_size,
        max_file_size=max_file_size,
        is_guest=not user and not request_owner_id,
    )
    scope, identity = quota_identity(
        user_id=request_owner_id or (str(user.id) if user else None),
        guest_id=guest_id,
    )
    batch_id = body.upload_batch_id.strip() or f"legacy-{scope}-{identity}"
    quota_reservation_id = f"{batch_id}:{body.logical_file_id}"
    result = await quota_svc.reserve(
        scope=scope,
        identity=identity,
        policy=audience_policy,
        policy_version=effective.version,
        batch_id=batch_id,
        reservation_id=quota_reservation_id,
        size=body.file_size,
    )
    if not result.allowed:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, result.reason)

    # 调豆包：prepare/apply 拿 store_uri，再 init_multipart 拿 upload_id
    try:
        client = await get_doubao_client()
        file_ext = body.file_ext or (body.file_name.rsplit(".", 1)[-1] if "." in body.file_name else "")
        init_result = await client.init_upload(file_size=body.file_size, file_ext=file_ext)
        upload_id = await client.init_multipart(
            store_uri=init_result.store_uri,
            tos_auth=init_result.authorization,
            tos_host=init_result.tos_host,
            is_large_file=is_large_file,
        )
    except DoubaoClientError as e:
        if result.created:
            await quota_svc.release_reservation(scope, identity, quota_reservation_id)
        log.error("multipart_init failed: %s", e)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "上传服务暂时不可用，请稍后重试") from e

    # 生成 commit_token + 存 Redis 会话
    part_count = (body.file_size + _PART_SIZE - 1) // _PART_SIZE
    part_number_base = 1 if is_large_file else 0
    commit_token = secrets.token_urlsafe(32)
    commit_token_expires_at = datetime.now(UTC) + _COMMIT_TOKEN_TTL

    session_data = {
        "ip": ip,
        "guest_id": guest_id,
        "user_id": request_owner_id or (str(user.id) if user else None),
        "request_code": body.request_code or None,
        "file_name": body.file_name,
        "file_size": body.file_size,
        "file_ext": body.file_ext,
        "content_type": body.content_type,
        "logical_file_id": body.logical_file_id,
        "store_uri": init_result.store_uri,
        "tos_host": init_result.tos_host,
        "tos_auth": init_result.authorization,
        "upload_id": upload_id,
        "is_large_file": is_large_file,
        "session_key": init_result.session_key,
        "service_id": init_result.service_id,
        "access_key": init_result.access_key,
        "secret_key": init_result.secret_key,
        "session_token": init_result.session_token,
        "merged": False,
        "is_empty": False,
        "chunk_index": 0,
        "chunk_total": 1,
        "logical_file_size": body.file_size,
        "upload_batch_id": batch_id,
        "quota_scope": scope,
        "quota_identity": identity,
        "quota_reservation_id": quota_reservation_id,
        "quota_policy_version": effective.version,
        "quota_reserved_size": body.file_size,
    }
    try:
        await redis.setex(
            f"nyy:mpu:{commit_token}",
            int(_COMMIT_TOKEN_TTL.total_seconds()),
            json.dumps(session_data),
        )
    except Exception:
        if result.created:
            await quota_svc.release_reservation(scope, identity, quota_reservation_id)
        raise

    return MultipartInitResponse(
        multipart_token=commit_token,
        tos_host=init_result.tos_host,
        store_uri=init_result.store_uri,
        tos_auth=init_result.authorization,
        upload_id=upload_id,
        part_size=_PART_SIZE,
        part_number_base=part_number_base,
        part_count=part_count,
        commit_token=commit_token,
        commit_token_expires_at=commit_token_expires_at,
    )


@router.post(
    "/multipart-merge",
    response_model=MultipartMergeResponse,
    summary="合并 multipart 分片",
)
async def multipart_merge(
    body: MultipartMergeRequest,
    request: Request,
):
    """Step 2-alt: 合并所有 part 为单个 TOS 对象。"""
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "缓存服务暂时不可用，请稍后重试")

    raw = await redis.get(f"nyy:mpu:{body.multipart_token}")
    if not raw:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传会话已过期，请重新上传")
    session = json.loads(raw)

    # 幂等：已 merge 直接返回
    if session.get("merged"):
        return MultipartMergeResponse(
            commit_token=body.multipart_token,
            commit_token_expires_at=datetime.now(UTC) + _COMMIT_TOKEN_TTL,
        )

    # 校验 part 数量
    expected = (int(session["file_size"]) + _PART_SIZE - 1) // _PART_SIZE
    if len(body.crc_list) != expected:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"分片数量不匹配，期望 {expected} 实际 {len(body.crc_list)}",
        )
    if any(not _is_valid_crc32(c) for c in body.crc_list):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "分片校验值格式错误")

    try:
        client = await get_doubao_client()
        await client.merge_multipart(
            store_uri=session["store_uri"],
            tos_auth=session["tos_auth"],
            tos_host=session["tos_host"],
            upload_id=session["upload_id"],
            crc_list=body.crc_list,
            is_large_file=bool(session.get("is_large_file")),
        )
    except DoubaoClientError as e:
        # 记录完整诊断上下文，便于定位大文件 merge 500（part 数/大小/模式/对象）
        log.error(
            "multipart_merge failed: %s | file_size=%s parts=%d is_large=%s store_uri=%s upload_id=%s",
            e,
            session.get("file_size"),
            len(body.crc_list),
            bool(session.get("is_large_file")),
            session.get("store_uri"),
            session.get("upload_id"),
        )
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "分片合并失败，请稍后重试") from e

    session["merged"] = True
    await redis.setex(
        f"nyy:mpu:{body.multipart_token}",
        int(_COMMIT_TOKEN_TTL.total_seconds()),
        json.dumps(session),
    )
    return MultipartMergeResponse(
        commit_token=body.multipart_token,
        commit_token_expires_at=datetime.now(UTC) + _COMMIT_TOKEN_TTL,
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
    if body.retention_coupon_id and not user:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "使用留存券需要登录")

    empty_dirs = _normalize_empty_dirs(body.empty_dirs)
    if not body.files and not empty_dirs:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "请至少选择一个文件或空文件夹")
    upload_batch_id = body.upload_batch_id.strip() or None

    from sqlalchemy import select
    from sqlalchemy.exc import IntegrityError
    from sqlalchemy.orm import selectinload

    from app.db.session import get_session_factory
    from app.models.share import Share, ShareFile, ShareLogicalFile

    factory = get_session_factory()
    if upload_batch_id:
        async with factory() as db:
            identity_filter = Share.owner_id == user.id if user else Share.guest_id == _get_guest_id(request, _get_client_ip(request))
            existing_share = await db.scalar(
                select(Share)
                .options(selectinload(Share.files), selectinload(Share.logical_files))
                .where(Share.upload_batch_id == upload_batch_id, identity_filter)
            )
            if existing_share:
                existing_config = await get_policy_config_for_version(db, existing_share.policy_version)
                existing_policy = existing_config.user if existing_share.owner_id else existing_config.guest
                await _settle_share_quota(existing_share, redis, existing_policy, db)
                if body.retention_coupon_id:
                    if not user or existing_share.owner_id != user.id:
                        raise HTTPException(status.HTTP_404_NOT_FOUND, "留存券不存在")
                    try:
                        await assert_coupon_consumed_by_share(
                            db,
                            coupon_id=body.retention_coupon_id,
                            owner_id=user.id,
                            share_id=existing_share.id,
                        )
                    except GrowthServiceError as exc:
                        raise _coupon_http_exception(exc) from exc
                return _upload_commit_response(settings, existing_share)

    logical_file_specs: dict[str, object] = {}
    for item in body.logical_files:
        logical_uuid = str(_parse_uuid(item.logical_file_id, "logical_file_id"))
        if logical_uuid in logical_file_specs:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "逻辑文件重复")
        logical_file_specs[logical_uuid] = item

    # --- 验证所有 commit_token，收集文件信息 ---
    file_infos: list[dict] = []
    for item in body.files:
        raw = await redis.get(f"nyy:commit:{item.commit_token}")
        is_mpu = False
        if not raw:
            raw = await redis.get(f"nyy:mpu:{item.commit_token}")
            is_mpu = True
        if not raw:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传会话已过期，请重新选择文件上传")
        token_data = json.loads(raw)
        if is_mpu and not token_data.get("merged"):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "分片尚未合并，请先调用 merge")
        if token_data["store_uri"] != item.store_uri:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件校验失败，请重新上传")
        token_data["_token_redis_key"] = f"nyy:mpu:{item.commit_token}" if is_mpu else f"nyy:commit:{item.commit_token}"
        token_batch_id = token_data.get("upload_batch_id")
        if upload_batch_id and token_batch_id and upload_batch_id != token_batch_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传批次校验失败，请重新上传")
        # commit 只能确认 init 时签发的分片元数据，不能由客户端改写。
        stored_logical_file_id = token_data.get("logical_file_id")
        if stored_logical_file_id and item.logical_file_id and stored_logical_file_id != item.logical_file_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件校验失败，请重新上传")
        if int(token_data.get("chunk_index", 0)) != item.chunk_index or int(token_data.get("chunk_total", 1)) != item.chunk_total:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传分片元数据校验失败，请重新上传")
        logical_file_id = item.logical_file_id or stored_logical_file_id or str(uuid.uuid4())
        token_data["_logical_file_id"] = str(_parse_uuid(logical_file_id, "logical_file_id"))
        token_data["_chunk_index"] = int(token_data.get("chunk_index", 0))
        token_data["_chunk_total"] = int(token_data.get("chunk_total", 1))
        file_infos.append(token_data)

    # 取第一个文件的信息；纯空目录分享则取当前请求身份/IP
    ip = file_infos[0]["ip"] if file_infos else _get_client_ip(request)
    guest_id = file_infos[0].get("guest_id") if file_infos else _get_guest_id(request, ip)
    if not guest_id:
        guest_id = _get_guest_id(request, ip)
    user_id = file_infos[0].get("user_id") if file_infos else (str(user.id) if user else None)
    if any(str(info.get("user_id") or "") != str(user_id or "") for info in file_infos):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件身份不一致，请重新上传")
    identities = {
        (info.get("quota_scope"), info.get("quota_identity"))
        for info in file_infos
        if info.get("quota_scope") and info.get("quota_identity")
    }
    if len(identities) > 1:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传文件身份不一致，请重新上传")
    quota_scope, quota_identity_value = next(iter(identities)) if identities else quota_identity(user_id=user_id, guest_id=guest_id)
    token_batch_ids = {
        str(info["upload_batch_id"])
        for info in file_infos
        if info.get("upload_batch_id")
    }
    quota_service = QuotaService(redis)
    for token_batch_id in token_batch_ids:
        if await quota_service.is_batch_cancelled(quota_scope, quota_identity_value, token_batch_id):
            raise HTTPException(status.HTTP_409_CONFLICT, "上传批次已取消，请重新选择文件")
    total_bytes = sum(f["file_size"] for f in file_infos)
    if body.retention_coupon_id and (
        not user or not user_id or str(user.id) != str(user_id)
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "留存券只能用于本人创建的分享")

    file_groups: dict[str, list[dict]] = {}
    first_seen_logical_ids: list[str] = []
    for info in file_infos:
        logical_file_id = info["_logical_file_id"]
        if logical_file_id not in file_groups:
            file_groups[logical_file_id] = []
            first_seen_logical_ids.append(logical_file_id)
        file_groups[logical_file_id].append(info)
    missing_logical_files = set(logical_file_specs) - set(file_groups)
    if missing_logical_files:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "逻辑文件与上传分片不匹配")
    for group in file_groups.values():
        reserved = {
            (str(info["quota_reservation_id"]), int(info.get("quota_reserved_size", -1)))
            for info in group
            if info.get("quota_reservation_id")
        }
        if reserved and (len(reserved) != 1 or next(iter(reserved))[1] != sum(int(info["file_size"]) for info in group)):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "上传预留大小与实际文件不一致，请重新上传")

    # --- 活跃分享数限制 ---
    created_logical_file_count = 0
    email_delivery_ids: list[uuid.UUID] = []
    async with factory() as db:
        effective = await get_effective_policy(db)
        audience_policy = effective.config.user if user_id else effective.config.guest
        active_count = await _count_active_shares(db, user_id=user_id, ip=ip, guest_id=None if user_id else guest_id)
        max_shares = audience_policy.max_active_shares

    if len(file_groups) > audience_policy.max_files_per_share:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "文件数量超过单次分享限制")
    if len(empty_dirs) > audience_policy.max_empty_dirs_per_share:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "空目录数量超过单次分享限制")
    if total_bytes > audience_policy.max_share_bytes:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "文件总大小超过单次分享限制")
    max_downloads = body.max_downloads if body.max_downloads is not None else audience_policy.default_max_downloads
    expires_hours = body.expires_hours if body.expires_hours is not None else audience_policy.default_retention_hours
    if max_downloads not in audience_policy.download_options:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "下载次数上限不在允许选项中")
    if not body.retention_coupon_id:
        _validate_share_expiry(
            expires_hours,
            options=audience_policy.retention_options_hours,
            role="登录用户" if user_id else "游客",
        )

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
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, "上传确认失败，请稍后重试") from e

    # --- 创建 Share + ShareFiles ---
    share_code = gen_short_code()
    scope, identity = quota_scope, quota_identity_value
    reservation_ids = sorted({
        str(info["quota_reservation_id"])
        for info in file_infos
        if info.get("quota_reservation_id")
    })
    legacy_bytes = sum(
        int(info["file_size"])
        for info in file_infos
        if not info.get("quota_reservation_id")
    )
    batch_ids = sorted({
        str(info["upload_batch_id"])
        for info in file_infos
        if info.get("upload_batch_id")
    })

    password_hash = None
    if body.password:
        from app.utils.security import hash_secret
        password_hash = hash_secret(body.password)

    expires_at = None
    if body.retention_coupon_id:
        expires_at = datetime.now(UTC) + timedelta(hours=effective.config.retention_coupon_hours)
    elif expires_hours > 0:
        expires_at = datetime.now(UTC) + timedelta(hours=expires_hours)

    # 游客生成 revoke_token，登录用户不需要（可通过 /my 管理）
    import secrets
    revoke_token = secrets.token_urlsafe(24) if not user_id else None

    async with factory() as db:
        from sqlalchemy import func

        lock_identity = user_id or guest_id
        await db.scalar(select(func.pg_advisory_xact_lock(func.hashtext(f"share:{'user' if user_id else 'guest'}:{lock_identity}"))))
        if upload_batch_id:
            await db.scalar(
                select(func.pg_advisory_xact_lock(func.hashtext(upload_batch_id)))
            )
            existing_share = await db.scalar(
                select(Share)
                .options(selectinload(Share.files), selectinload(Share.logical_files))
                .where(
                    Share.upload_batch_id == upload_batch_id,
                    Share.owner_id == user_id if user_id else Share.guest_id == guest_id,
                )
            )
            if existing_share:
                stored_config = await get_policy_config_for_version(db, existing_share.policy_version)
                stored_policy = stored_config.user if existing_share.owner_id else stored_config.guest
                await _settle_share_quota(existing_share, redis, stored_policy, db)
                if body.retention_coupon_id:
                    try:
                        await assert_coupon_consumed_by_share(
                            db,
                            coupon_id=body.retention_coupon_id,
                            owner_id=user.id,
                            share_id=existing_share.id,
                        )
                    except GrowthServiceError as exc:
                        raise _coupon_http_exception(exc) from exc
                return _upload_commit_response(settings, existing_share)

        locked_active_count = await _count_active_shares(
            db,
            user_id=user_id,
            ip=ip,
            guest_id=None if user_id else guest_id,
        )
        if locked_active_count >= audience_policy.max_active_shares:
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                _active_share_limit_message(locked_active_count, audience_policy.max_active_shares),
            )

        share = Share(
            code=share_code,
            owner_id=user_id,
            guest_id=None if user_id else guest_id,
            ip_created_from=ip,
            total_bytes=total_bytes,
            empty_dirs=empty_dirs,
            upload_batch_id=upload_batch_id,
            password_hash=password_hash,
            expires_at=expires_at,
            max_downloads=max_downloads,
            revoke_token=revoke_token,
            logical_file_count=len(file_groups),
            stored_object_count=len(file_infos),
            policy_version=effective.version,
            quota_scope=scope,
            quota_identity=identity,
            quota_reservation_ids=reservation_ids,
            quota_batch_ids=batch_ids,
            quota_legacy_bytes=legacy_bytes,
            last_activity_at=datetime.now(UTC),
        )
        ordered_logical_ids = [
            str(_parse_uuid(item.logical_file_id, "logical_file_id"))
            for item in body.logical_files
            if str(_parse_uuid(item.logical_file_id, "logical_file_id")) in file_groups
        ]
        ordered_logical_ids.extend(
            logical_id for logical_id in first_seen_logical_ids if logical_id not in set(ordered_logical_ids)
        )
        created_logical_file_count = len(ordered_logical_ids)

        for sort_index, logical_id in enumerate(ordered_logical_ids):
            group = sorted(file_groups[logical_id], key=lambda item: item.get("_chunk_index", 0))
            first = group[0]
            chunk_total = int(first.get("_chunk_total") or len(group))
            chunk_indexes = [int(item.get("_chunk_index", 0)) for item in group]
            if chunk_indexes != list(range(chunk_total)):
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "分片不完整，请重新上传")
            declared = logical_file_specs.get(logical_id)
            declared_chunk_total = getattr(declared, "chunk_total", chunk_total)
            if declared_chunk_total != chunk_total:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "逻辑文件与上传分片不匹配")
            logical_size = sum(int(item["file_size"]) for item in group)
            declared_size = getattr(declared, "file_size", logical_size)
            if declared_size != logical_size:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "逻辑文件大小与上传分片不匹配")
            media_metadata = _sanitize_media_metadata(getattr(declared, "media_metadata", None))
            original_name = getattr(declared, "file_name", first["file_name"])
            if len(group) == 1 and media_metadata and not first.get("is_empty"):
                try:
                    media_metadata = await attach_playback_assets_for_single_object(
                        metadata=media_metadata,
                        original_name=original_name,
                        size=logical_size,
                        tos_uri=first["store_uri"],
                        client=client,
                    )
                    media_metadata = _sanitize_media_metadata(media_metadata)
                except Exception as exc:
                    log.warning("playback sidecar auto-generation skipped for %s: %s", original_name, exc)

            logical_file = ShareLogicalFile(
                id=uuid.UUID(logical_id),
                share=share,
                sort_index=sort_index,
                original_name=original_name,
                size=logical_size,
                content_type=(getattr(declared, "content_type", "") or first.get("content_type") or None),
                chunk_total=chunk_total,
                media_metadata=media_metadata,
            )
            db.add(logical_file)
            for info in group:
                sf = ShareFile(
                    share=share,
                    logical_file=logical_file,
                    original_name=info["file_name"],
                    size=info["file_size"],
                    tos_uri=info["store_uri"],
                    content_type=info.get("content_type") or None,
                    chunk_index=info.get("_chunk_index", 0),
                    chunk_total=chunk_total,
                    logical_file_id=logical_file.id,
                )
                db.add(sf)
        db.add(share)
        await db.flush()
        if body.retention_coupon_id:
            try:
                await consume_retention_coupon(
                    db,
                    coupon_id=body.retention_coupon_id,
                    owner_id=user.id,
                    share_id=share.id,
                )
            except GrowthServiceError as exc:
                raise _coupon_http_exception(exc) from exc
        if body.recipients:
            from app.services.email import enqueue_share_emails

            email_delivery_ids = await enqueue_share_emails(
                db,
                share_id=share.id,
                recipients=[str(item) for item in body.recipients],
            )
        try:
            await db.commit()
        except IntegrityError:
            await db.rollback()
            if upload_batch_id:
                existing_share = await db.scalar(
                    select(Share)
                    .options(selectinload(Share.files), selectinload(Share.logical_files))
                    .where(
                        Share.upload_batch_id == upload_batch_id,
                        Share.owner_id == user_id if user_id else Share.guest_id == guest_id,
                    )
                )
                if existing_share:
                    stored_config = await get_policy_config_for_version(db, existing_share.policy_version)
                    stored_policy = stored_config.user if existing_share.owner_id else stored_config.guest
                    await _settle_share_quota(existing_share, redis, stored_policy, db)
                    return _upload_commit_response(settings, existing_share)
            raise
        await db.refresh(share)

    # --- 将上传预留转为已用额度；失败时可通过相同批次安全重试 ---
    async with factory() as db:
        persisted_share = await db.get(Share, share.id)
        if persisted_share:
            await _settle_share_quota(persisted_share, redis, audience_policy, db)

    # --- 删除所有 commit_token ---
    for info in file_infos:
        key = info.get("_token_redis_key")
        if key:
            await redis.delete(key)

    if email_delivery_ids:
        from app.services.email import dispatch_share_email_outbox

        await dispatch_share_email_outbox(
            email_delivery_ids,
            app_base_url=settings.app_base_url,
        )

    logical_file_count = created_logical_file_count
    log.info("share created: code=%s logical_files=%d chunks=%d size=%d", share_code, logical_file_count, len(file_infos), total_bytes)

    return _upload_commit_response(settings, share, file_count=logical_file_count)
