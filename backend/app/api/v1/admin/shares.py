"""Admin 分享管理：列表、详情、预览、封禁与批量操作。"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from ipaddress import ip_address
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import cast, exists, func, or_, select
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.v1.admin.common import (
    _get_admin_share,
    _share_status,
    _share_status_filters,
    _validate_cursor_args,
    _validate_page_window,
)
from app.api.v1.shares import _aggregate_file_info, _get_download_urls, _public_media_metadata
from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.share import DownloadLog, Share, ShareAccessEvent, ShareLogicalFile
from app.models.system import AuditLog, Report
from app.models.user import User
from app.schemas.admin import (
    AdminShareDetailResponse,
    AdminShareFileItem,
    AdminShareFilesResponse,
    AdminShareItem,
    AdminSharesResponse,
    AdminShareViewResponse,
    BanShareRequest,
    BatchActionResponse,
    BatchShareActionRequest,
    MessageResponse,
)
from app.schemas.share import ShareDownloadResponse
from app.services.admin_audit import add_admin_audit
from app.services.admin_sources import build_ip_source, load_share_event_summaries
from app.services.doubao_client import DoubaoClientError
from app.services.pagination import (
    created_cursor_filter,
    decode_created_cursor,
    encode_created_cursor,
)
from app.services.share_access import guest_label, record_share_access

router = APIRouter()


def _admin_share_item(
    share: Share,
    owner_email: str | None,
    now: datetime,
    event_summary: dict[str, int],
    file_count: int,
) -> AdminShareItem:
    return AdminShareItem(
        code=share.code,
        title=share.title,
        owner_email=owner_email,
        file_count=file_count,
        total_bytes=share.total_bytes,
        download_count=share.download_count,
        max_downloads=share.max_downloads,
        created_at=share.created_at,
        expires_at=share.expires_at,
        revoked=share.revoked_at is not None,
        banned=share.banned_at is not None,
        banned_reason=share.banned_reason,
        source=build_ip_source(share.ip_created_from),
        guest_label=guest_label(share.guest_id) if share.owner_id is None else "",
        access_event_count=event_summary.get("total", 0),
        unique_access_ips=event_summary.get("unique_ips", 0),
        status=_share_status(share, now),
        page_rendered_count=event_summary.get("page_rendered", 0),
        human_interaction_count=event_summary.get("human_interaction", 0),
        preview_fetch_count=event_summary.get("preview_fetch", 0),
        admin_review_count=event_summary.get("admin_review", 0),
    )


@router.get("/shares", response_model=AdminSharesResponse)
async def list_shares(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int | None = Query(None, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    limit: int = Query(50, ge=1, le=100),
    after: str | None = Query(None, max_length=512),
    before: str | None = Query(None, max_length=512),
    include_total: bool = Query(False),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|revoked|expired|banned|download_exhausted)$"),
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|size_desc|downloads_desc|expires_asc)$"),
    created_from: date | None = Query(None),
    created_to: date | None = Query(None),
    expires_from: date | None = Query(None),
    expires_to: date | None = Query(None),
    activity_from: date | None = Query(None),
    activity_to: date | None = Query(None),
    min_files: int | None = Query(None, ge=0),
    max_files: int | None = Query(None, ge=0),
    min_bytes: int | None = Query(None, ge=0),
    max_bytes: int | None = Query(None, ge=0),
    risk: str = Query("all", pattern="^(all|reported|suspicious_ip|preview_only|human_link|no_access)$"),
):
    _validate_cursor_args(after, before)
    _validate_page_window(page, page_size)
    now = datetime.now(UTC)
    filters = []
    if q:
        like = f"%{q}%"
        search_filters = [Share.code.ilike(like), Share.title.ilike(like), Share.banned_reason.ilike(like), User.email.ilike(like)]
        try:
            search_filters.append(Share.ip_created_from == cast(ip_address(q).compressed, INET))
        except ValueError:
            pass
        filters.append(or_(*search_filters))
    filters.extend(_share_status_filters(status_filter, now))
    if created_from:
        filters.append(Share.created_at >= datetime.combine(created_from, time.min, tzinfo=UTC))
    if created_to:
        filters.append(Share.created_at < datetime.combine(created_to + timedelta(days=1), time.min, tzinfo=UTC))
    if expires_from:
        filters.append(Share.expires_at >= datetime.combine(expires_from, time.min, tzinfo=UTC))
    if expires_to:
        filters.append(Share.expires_at < datetime.combine(expires_to + timedelta(days=1), time.min, tzinfo=UTC))
    activity_at = func.coalesce(Share.last_activity_at, Share.created_at)
    if activity_from:
        filters.append(activity_at >= datetime.combine(activity_from, time.min, tzinfo=UTC))
    if activity_to:
        filters.append(activity_at < datetime.combine(activity_to + timedelta(days=1), time.min, tzinfo=UTC))
    if min_files is not None:
        filters.append(Share.logical_file_count >= min_files)
    if max_files is not None:
        filters.append(Share.logical_file_count <= max_files)
    if min_bytes is not None:
        filters.append(Share.total_bytes >= min_bytes)
    if max_bytes is not None:
        filters.append(Share.total_bytes <= max_bytes)
    has_report = exists(select(Report.id).where(Report.share_id == Share.id))
    has_preview = exists(select(ShareAccessEvent.id).where(
        ShareAccessEvent.share_id == Share.id,
        ShareAccessEvent.event_type == "preview_fetch",
    ))
    has_human = exists(select(ShareAccessEvent.id).where(
        ShareAccessEvent.share_id == Share.id,
        ShareAccessEvent.event_type == "human_interaction",
    ))
    has_link = or_(
        exists(select(ShareAccessEvent.id).where(
            ShareAccessEvent.share_id == Share.id,
            ShareAccessEvent.event_type == "link_issued",
        )),
        exists(select(DownloadLog.id).where(DownloadLog.share_id == Share.id)),
    )
    has_access = exists(select(ShareAccessEvent.id).where(ShareAccessEvent.share_id == Share.id))
    if risk == "reported":
        filters.append(has_report)
    elif risk in {"suspicious_ip", "preview_only"}:
        filters.extend([has_preview, ~has_human, ~has_link])
    elif risk == "human_link":
        filters.extend([has_human, has_link])
    elif risk == "no_access":
        filters.extend([~has_access, ~exists(select(DownloadLog.id).where(DownloadLog.share_id == Share.id))])

    for lower, upper, label in [
        (created_from, created_to, "创建时间"),
        (expires_from, expires_to, "到期时间"),
        (activity_from, activity_to, "活动时间"),
        (min_files, max_files, "文件数量"),
        (min_bytes, max_bytes, "容量"),
    ]:
        if lower is not None and upper is not None and lower > upper:
            raise HTTPException(400, f"{label}范围无效")

    order_by = {
        "created_desc": (Share.created_at.desc(), Share.id.desc()),
        "created_asc": (Share.created_at.asc(), Share.id.asc()),
        "size_desc": (Share.total_bytes.desc(), Share.id.desc()),
        "downloads_desc": (Share.download_count.desc(), Share.id.desc()),
        "expires_asc": (Share.expires_at.asc().nullslast(), Share.id.asc()),
    }[sort]

    page_mode = page is not None or sort != "created_desc"
    effective_page = page or 1
    total = None
    if page_mode or (include_total and bool(filters)):
        total = await db.scalar(
            select(func.count()).select_from(Share).outerjoin(User, User.id == Share.owner_id).where(*filters)
        ) or 0
    stmt = (
        select(Share, User.email)
        .outerjoin(User, User.id == Share.owner_id)
        .where(*filters)
    )
    reverse_page = False
    if page_mode:
        stmt = stmt.order_by(*order_by).offset((effective_page - 1) * page_size).limit(page_size)
    else:
        cursor = decode_created_cursor(after or before)
        reverse_page = bool(before)
        if cursor:
            stmt = stmt.where(
                created_cursor_filter(Share.created_at, Share.id, cursor, after=bool(after))
            )
        stmt = stmt.order_by(
            Share.created_at.asc() if reverse_page else Share.created_at.desc(),
            Share.id.asc() if reverse_page else Share.id.desc(),
        ).limit(limit + 1)
    rows = (await db.execute(stmt)).all()
    has_more = not page_mode and len(rows) > limit
    if has_more:
        rows = rows[:limit]
    if reverse_page:
        rows.reverse()
    shares = [share for share, _owner_email in rows]
    event_summaries = await load_share_event_summaries(db, [share.id for share in shares])
    logical_counts: dict[UUID, int] = {}
    zero_summary_ids = [share.id for share in shares if share.logical_file_count == 0]
    if zero_summary_ids:
        count_rows = await db.execute(
            select(ShareLogicalFile.share_id, func.count(ShareLogicalFile.id))
            .where(ShareLogicalFile.share_id.in_(zero_summary_ids))
            .group_by(ShareLogicalFile.share_id)
        )
        logical_counts = {share_id: int(count) for share_id, count in count_rows.all()}
    items = [
        _admin_share_item(
            share,
            owner_email,
            now,
            event_summaries.get(share.id, {}),
            share.logical_file_count or logical_counts.get(share.id, 0),
        )
        for share, owner_email in rows
    ]
    return AdminSharesResponse(
        shares=items,
        items=items,
        pagination_mode="page" if page_mode else "cursor",
        next_cursor=(
            encode_created_cursor(shares[-1].created_at, shares[-1].id)
            if shares and has_more
            else None
        ),
        prev_cursor=(
            encode_created_cursor(shares[0].created_at, shares[0].id)
            if shares and not page_mode and (after or before)
            else None
        ),
        has_more=has_more,
        total=total,
        page=effective_page if page_mode else None,
        page_size=page_size if page_mode else None,
    )


@router.get("/shares/{code}", response_model=AdminShareDetailResponse)
async def get_share_detail(
    code: str,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    """分享详情摘要：元数据、状态与计数摘要，不加载文件关系。"""

    row = await db.execute(
        select(Share, User.email)
        .outerjoin(User, User.id == Share.owner_id)
        .where(Share.code == code)
    )
    found = row.one_or_none()
    if found is None:
        raise HTTPException(404, "分享不存在")
    share, owner_email = found
    now = datetime.now(UTC)
    event_summaries = await load_share_event_summaries(db, [share.id])
    file_count = share.logical_file_count
    if not file_count:
        file_count = await db.scalar(
            select(func.count()).select_from(ShareLogicalFile).where(ShareLogicalFile.share_id == share.id)
        ) or 0
    return AdminShareDetailResponse(
        item=_admin_share_item(share, owner_email, now, event_summaries.get(share.id, {}), file_count),
        owner_id=str(share.owner_id) if share.owner_id else None,
        guest_id=share.guest_id,
        ip_created_from=str(share.ip_created_from) if share.ip_created_from else None,
        created_at=share.created_at,
        last_activity_at=share.last_activity_at,
        logical_file_count=share.logical_file_count,
        stored_object_count=share.stored_object_count,
        empty_dir_count=len(share.empty_dirs or []),
        has_password=share.password_hash is not None,
    )


@router.get("/shares/{code}/view", response_model=AdminShareViewResponse)
async def view_share(
    code: str,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    share = await _get_admin_share(code, db)
    response = AdminShareViewResponse(
        code=share.code,
        files=_aggregate_file_info(share.logical_files),
        empty_dirs=share.empty_dirs or [],
        total_bytes=share.total_bytes,
        created_at=share.created_at,
        expires_at=share.expires_at,
        download_count=share.download_count,
        max_downloads=share.max_downloads,
        has_password=share.password_hash is not None,
        status=_share_status(share, datetime.now(UTC)),
    )
    await record_share_access(
        share.id,
        "admin_review",
        request,
        user_id=admin.id,
        http_status=200,
    )
    return response


@router.get("/shares/{code}/files", response_model=AdminShareFilesResponse)
async def list_share_files(
    code: str,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    share = await db.scalar(select(Share).where(Share.code == code))
    if share is None:
        raise HTTPException(404, "分享不存在")
    total = await db.scalar(
        select(func.count()).select_from(ShareLogicalFile).where(ShareLogicalFile.share_id == share.id)
    ) or 0
    rows = await db.scalars(
        select(ShareLogicalFile)
        .where(ShareLogicalFile.share_id == share.id)
        .order_by(ShareLogicalFile.sort_index.asc(), ShareLogicalFile.id.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items = [
        AdminShareFileItem(
            id=str(item.id),
            file_name=item.original_name,
            file_size=item.size,
            content_type=item.content_type or "",
            sort_index=item.sort_index,
            chunk_count=item.chunk_total,
            media_metadata=_public_media_metadata(item.media_metadata),
        )
        for item in rows
    ]
    return AdminShareFilesResponse(items=items, page=page, page_size=page_size, total=int(total))


@router.post("/shares/{code}/content", response_model=ShareDownloadResponse)
async def view_share_content(
    code: str,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    share = await _get_admin_share(code, db, with_content=True)
    if not share.files and not (share.empty_dirs or []):
        raise HTTPException(404, "分享中没有可下载文件")
    try:
        files = await _get_download_urls(share.logical_files)
    except DoubaoClientError as exc:
        raise HTTPException(503, "文件服务暂时不可用，请稍后重试") from exc
    response = ShareDownloadResponse(
        files=files,
        empty_dirs=share.empty_dirs or [],
    )
    await record_share_access(
        share.id,
        "admin_review",
        request,
        user_id=admin.id,
        http_status=200,
    )
    return response


@router.post("/shares/{code}/files/{file_id}/content", response_model=ShareDownloadResponse)
async def view_share_file_content(
    code: str,
    file_id: UUID,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = await db.execute(
        select(Share, ShareLogicalFile)
        .join(ShareLogicalFile, ShareLogicalFile.share_id == Share.id)
        .options(selectinload(ShareLogicalFile.files))
        .where(Share.code == code, ShareLogicalFile.id == file_id)
    )
    found = row.one_or_none()
    if found is None:
        raise HTTPException(404, "分享文件不存在")
    share, logical_file = found
    try:
        files = await _get_download_urls([logical_file])
    except DoubaoClientError as exc:
        raise HTTPException(503, "文件服务暂时不可用，请稍后重试") from exc
    await record_share_access(
        share.id,
        "admin_review",
        request,
        user_id=admin.id,
        http_status=200,
    )
    return ShareDownloadResponse(files=files, empty_dirs=[])


@router.post("/shares/{code}/ban", response_model=MessageResponse)
async def ban_share(
    code: str,
    body: BanShareRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    if not body.reason:
        raise HTTPException(400, "封禁原因不能为空")
    share = await db.scalar(select(Share).where(Share.code == code))
    if not share:
        raise HTTPException(404, "分享不存在")
    before = {"banned_at": share.banned_at, "banned_reason": share.banned_reason}
    share.banned_at = datetime.now(UTC)
    share.banned_reason = body.reason
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="share.ban",
        target_type="share",
        target_id=share.code,
        before=before,
        after={"banned_at": share.banned_at, "banned_reason": share.banned_reason},
        reason=body.reason,
    )
    await db.commit()
    return MessageResponse(message="分享已封禁")


@router.delete("/shares/{code}/ban", response_model=MessageResponse)
async def unban_share(
    code: str,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    reason: str = Query("管理员解封", min_length=1, max_length=255),
):
    share = await db.scalar(select(Share).where(Share.code == code))
    if not share:
        raise HTTPException(404, "分享不存在")
    before = {"banned_at": share.banned_at, "banned_reason": share.banned_reason}
    share.banned_at = None
    share.banned_reason = None
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="share.unban",
        target_type="share",
        target_id=share.code,
        before=before,
        after={"banned_at": None, "banned_reason": None},
        reason=reason,
    )
    await db.commit()
    return MessageResponse(message="分享已解封")


async def _batch_share_ban_action(
    body: BatchShareActionRequest,
    request: Request,
    admin: User,
    db: AsyncSession,
    *,
    ban: bool,
) -> BatchActionResponse:
    action = "share.batch_ban" if ban else "share.batch_unban"
    await db.scalar(
        select(func.pg_advisory_xact_lock(func.hashtext(f"{action}:{body.batch_id}")))
    )
    previous = await db.scalar(
        select(AuditLog).where(AuditLog.batch_id == body.batch_id, AuditLog.action == action)
    )
    if previous and previous.after_value:
        return BatchActionResponse(**previous.after_value, idempotent_replay=True)

    results: list[dict] = []
    for code in dict.fromkeys(body.codes):
        share = await db.scalar(select(Share).where(Share.code == code))
        if share is None:
            results.append({"code": code, "success": False, "error": "分享不存在"})
            continue
        before = {"banned_at": share.banned_at, "banned_reason": share.banned_reason}
        if ban:
            share.banned_at = share.banned_at or datetime.now(UTC)
            share.banned_reason = body.reason
        else:
            share.banned_at = None
            share.banned_reason = None
        after = {"banned_at": share.banned_at, "banned_reason": share.banned_reason}
        results.append({"code": code, "success": True, "error": None})
        add_admin_audit(
            db,
            request=request,
            actor=admin,
            action="share.ban" if ban else "share.unban",
            target_type="share",
            target_id=code,
            before=before,
            after=after,
            reason=body.reason,
            batch_id=body.batch_id,
        )

    response_data = {
        "batch_id": body.batch_id,
        "processed": len(results),
        "succeeded": sum(1 for item in results if item["success"]),
        "failed": sum(1 for item in results if not item["success"]),
        "results": results,
    }
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action=action,
        target_type="share_batch",
        target_id=body.batch_id,
        after=response_data,
        reason=body.reason,
        batch_id=body.batch_id,
        success=response_data["failed"] == 0,
    )
    await db.commit()
    return BatchActionResponse(**response_data)


@router.post("/shares/batch-ban", response_model=BatchActionResponse)
async def batch_ban_shares(
    body: BatchShareActionRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    return await _batch_share_ban_action(body, request, admin, db, ban=True)


@router.post("/shares/batch-unban", response_model=BatchActionResponse)
async def batch_unban_shares(
    body: BatchShareActionRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    return await _batch_share_ban_action(body, request, admin, db, ban=False)
