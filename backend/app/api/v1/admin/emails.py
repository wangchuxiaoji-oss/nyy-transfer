"""Admin 邮件处理队列与失败重试。"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.admin.common import (
    _admin_email_item,
    _validate_cursor_args,
    _validate_page_window,
)
from app.core.config import get_settings
from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.share import Share
from app.models.system import AuditLog, EmailDelivery
from app.models.user import User
from app.schemas.admin import (
    AdminEmailsResponse,
    BatchActionResponse,
    BatchEmailRetryRequest,
)
from app.services.admin_audit import add_admin_audit
from app.services.email import dispatch_share_email
from app.services.pagination import (
    created_cursor_filter,
    decode_created_cursor,
    encode_created_cursor,
)

router = APIRouter()


@router.get("/emails", response_model=AdminEmailsResponse)
async def list_emails(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int | None = Query(None, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    limit: int = Query(50, ge=1, le=100),
    after: str | None = Query(None, max_length=512),
    before: str | None = Query(None, max_length=512),
    include_total: bool = Query(False),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|pending|sent|failed)$"),
    delivery_type: str = Query("", max_length=32),
):
    _validate_cursor_args(after, before)
    _validate_page_window(page, page_size)
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(or_(Share.code.ilike(like), EmailDelivery.recipient.ilike(like), EmailDelivery.error.ilike(like)))
    if status_filter != "all":
        filters.append(EmailDelivery.status == status_filter)
    if delivery_type:
        filters.append(EmailDelivery.delivery_type == delivery_type)

    page_mode = page is not None
    total = None
    if page_mode or (include_total and bool(filters)):
        total = await db.scalar(
            select(func.count()).select_from(EmailDelivery).join(Share, Share.id == EmailDelivery.share_id).where(*filters)
        ) or 0
    stmt = (
        select(EmailDelivery, Share.code)
        .join(Share, Share.id == EmailDelivery.share_id)
        .where(*filters)
    )
    reverse_page = False
    if page_mode:
        stmt = stmt.order_by(EmailDelivery.created_at.desc(), EmailDelivery.id.desc()).offset(
            (page - 1) * page_size
        ).limit(page_size)
    else:
        cursor = decode_created_cursor(after or before)
        reverse_page = bool(before)
        if cursor:
            stmt = stmt.where(
                created_cursor_filter(
                    EmailDelivery.created_at,
                    EmailDelivery.id,
                    cursor,
                    after=bool(after),
                )
            )
        stmt = stmt.order_by(
            EmailDelivery.created_at.asc() if reverse_page else EmailDelivery.created_at.desc(),
            EmailDelivery.id.asc() if reverse_page else EmailDelivery.id.desc(),
        ).limit(limit + 1)
    rows = (await db.execute(stmt)).all()
    has_more = not page_mode and len(rows) > limit
    if has_more:
        rows = rows[:limit]
    if reverse_page:
        rows.reverse()
    items = [_admin_email_item(delivery, share_code) for delivery, share_code in rows]
    return AdminEmailsResponse(
        emails=items,
        items=items,
        pagination_mode="page" if page_mode else "cursor",
        next_cursor=(
            encode_created_cursor(rows[-1][0].created_at, rows[-1][0].id)
            if rows and has_more
            else None
        ),
        prev_cursor=(
            encode_created_cursor(rows[0][0].created_at, rows[0][0].id)
            if rows and not page_mode and (after or before)
            else None
        ),
        has_more=has_more,
        total=total,
        page=page if page_mode else None,
        page_size=page_size if page_mode else None,
    )


@router.post("/emails/batch-retry", response_model=BatchActionResponse)
async def retry_failed_emails(
    body: BatchEmailRetryRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    await db.scalar(
        select(func.pg_advisory_xact_lock(func.hashtext(f"email.batch_retry:{body.batch_id}")))
    )
    previous = await db.scalar(
        select(AuditLog).where(
            AuditLog.batch_id == body.batch_id,
            AuditLog.action == "email.batch_retry",
        )
    )
    if previous and previous.after_value:
        return BatchActionResponse(
            **previous.after_value,
            idempotent_replay=True,
        )

    results: list[dict] = []
    for raw_id in dict.fromkeys(body.delivery_ids):
        try:
            delivery_id = UUID(raw_id)
        except ValueError:
            results.append({"id": raw_id, "success": False, "error": "投递 ID 无效"})
            continue
        row = await db.execute(
            select(EmailDelivery, Share)
            .join(Share, Share.id == EmailDelivery.share_id)
            .where(EmailDelivery.id == delivery_id)
            .with_for_update(of=EmailDelivery)
        )
        found = row.one_or_none()
        if found is None:
            results.append({"id": raw_id, "success": False, "error": "投递记录不存在"})
            continue
        delivery, _share = found
        if delivery.status not in {"pending", "failed"}:
            results.append({"id": raw_id, "success": False, "error": "仅待发送或失败邮件可重试"})
            continue

        before_status = delivery.status
        root_delivery_id = delivery.parent_delivery_id or delivery.id
        if root_delivery_id != delivery.id:
            await db.scalar(
                select(EmailDelivery.id)
                .where(EmailDelivery.id == root_delivery_id)
                .with_for_update()
            )
        if delivery.status == "pending":
            retry = delivery
        else:
            latest_retry = await db.scalar(
                select(EmailDelivery)
                .where(EmailDelivery.parent_delivery_id == root_delivery_id)
                .order_by(EmailDelivery.attempt_number.desc(), EmailDelivery.created_at.desc())
                .limit(1)
            )
            if latest_retry is not None and latest_retry.status == "sent":
                results.append({"id": raw_id, "success": False, "error": "该邮件已成功重试"})
                continue
            if latest_retry is not None and latest_retry.status == "pending":
                retry = latest_retry
            else:
                next_attempt = max(
                    delivery.attempt_number,
                    latest_retry.attempt_number if latest_retry is not None else 0,
                ) + 1
                retry = EmailDelivery(
                    share_id=delivery.share_id,
                    recipient=delivery.recipient,
                    status="pending",
                    delivery_type=delivery.delivery_type,
                    attempt_number=next_attempt,
                    parent_delivery_id=root_delivery_id,
                    idempotency_key=f"admin-retry:{body.batch_id}:{root_delivery_id}",
                )
                db.add(retry)
                await db.flush()

        sent = await dispatch_share_email(
            db,
            delivery_id=retry.id,
            app_base_url=get_settings().app_base_url,
        )
        result_item = {
            "id": raw_id,
            "retry_id": str(retry.id),
            "success": sent,
            "error": None if sent else "邮件发送失败",
        }
        results.append(result_item)
        add_admin_audit(
            db,
            request=request,
            actor=admin,
            action="email.retry",
            target_type="email_delivery",
            target_id=raw_id,
            before={"status": before_status, "attempt_number": delivery.attempt_number},
            after={"retry_id": str(retry.id), "status": retry.status},
            batch_id=body.batch_id,
            success=sent,
            error_summary=None if sent else "邮件发送失败",
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
        action="email.batch_retry",
        target_type="email_delivery_batch",
        target_id=body.batch_id,
        after=response_data,
        batch_id=body.batch_id,
        success=response_data["failed"] == 0,
    )
    await db.commit()
    return BatchActionResponse(**response_data)
