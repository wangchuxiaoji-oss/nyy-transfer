"""Admin 举报处理队列。"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.admin.common import (
    _admin_report_item,
    _validate_cursor_args,
    _validate_page_window,
)
from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.share import Share
from app.models.system import AuditLog, Report
from app.models.user import User
from app.schemas.admin import (
    AdminReportItem,
    AdminReportsResponse,
    BatchActionResponse,
    BatchReportStatusRequest,
    ReportStatusUpdate,
)
from app.services.admin_audit import add_admin_audit
from app.services.pagination import (
    created_cursor_filter,
    decode_created_cursor,
    encode_created_cursor,
)

router = APIRouter()


@router.get("/reports", response_model=AdminReportsResponse)
async def list_reports(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int | None = Query(None, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    limit: int = Query(50, ge=1, le=100),
    after: str | None = Query(None, max_length=512),
    before: str | None = Query(None, max_length=512),
    include_total: bool = Query(False),
    q: str = Query("", max_length=128),
    status_filter: str = Query("all", alias="status", pattern="^(all|pending|resolved|dismissed)$"),
):
    _validate_cursor_args(after, before)
    _validate_page_window(page, page_size)
    filters = []
    if q:
        like = f"%{q}%"
        filters.append(or_(Share.code.ilike(like), Report.reason.ilike(like), Report.detail.ilike(like)))
    if status_filter != "all":
        filters.append(Report.status == status_filter)

    page_mode = page is not None
    total = None
    if page_mode or (include_total and bool(filters)):
        total = await db.scalar(
            select(func.count()).select_from(Report).join(Share, Share.id == Report.share_id).where(*filters)
        ) or 0

    stmt = (
        select(Report, Share)
        .join(Share, Share.id == Report.share_id)
        .where(*filters)
    )
    reverse_page = False
    if page_mode:
        stmt = stmt.order_by(Report.created_at.desc(), Report.id.desc()).offset(
            (page - 1) * page_size
        ).limit(page_size)
    else:
        cursor = decode_created_cursor(after or before)
        reverse_page = bool(before)
        if cursor:
            stmt = stmt.where(
                created_cursor_filter(
                    Report.created_at,
                    Report.id,
                    cursor,
                    after=bool(after),
                )
            )
        stmt = stmt.order_by(
            Report.created_at.asc() if reverse_page else Report.created_at.desc(),
            Report.id.asc() if reverse_page else Report.id.desc(),
        ).limit(limit + 1)

    rows = (await db.execute(stmt)).all()
    has_more = not page_mode and len(rows) > limit
    if has_more:
        rows = rows[:limit]
    if reverse_page:
        rows.reverse()
    share_ids = [report.share_id for report, _share in rows]
    report_counts: dict[UUID, int] = {}
    if share_ids:
        count_rows = await db.execute(
            select(Report.share_id, func.count(Report.id))
            .where(Report.share_id.in_(share_ids))
            .group_by(Report.share_id)
        )
        report_counts = {share_id: int(count) for share_id, count in count_rows.all()}
    items = [
        _admin_report_item(report, share, report_counts.get(report.share_id, 1))
        for report, share in rows
    ]
    return AdminReportsResponse(
        reports=items,
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


@router.patch("/reports/{report_id}/status", response_model=AdminReportItem)
async def update_report_status(
    report_id: UUID,
    body: ReportStatusUpdate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Report, Share)
        .join(Share, Share.id == Report.share_id)
        .where(Report.id == report_id)
    )
    row = result.one_or_none()
    if row is None:
        raise HTTPException(404, "举报不存在")
    report, share = row
    before = {
        "status": report.status,
        "resolution_note": report.resolution_note,
        "handled_at": report.handled_at,
    }
    report.status = body.status
    report.resolution_note = body.note
    report.handled_by = admin.id if body.status != "pending" else None
    report.handled_at = datetime.now(UTC) if body.status != "pending" else None
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="report.status_update",
        target_type="report",
        target_id=str(report.id),
        before=before,
        after={
            "status": report.status,
            "resolution_note": report.resolution_note,
            "handled_at": report.handled_at,
        },
        note=body.note,
    )
    await db.commit()
    return _admin_report_item(report, share)


@router.post("/reports/batch-status", response_model=BatchActionResponse)
async def batch_report_status(
    body: BatchReportStatusRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    await db.scalar(
        select(func.pg_advisory_xact_lock(func.hashtext(f"report.batch_status:{body.batch_id}")))
    )
    previous = await db.scalar(
        select(AuditLog).where(
            AuditLog.batch_id == body.batch_id,
            AuditLog.action == "report.batch_status",
        )
    )
    if previous and previous.after_value:
        return BatchActionResponse(**previous.after_value, idempotent_replay=True)

    results: list[dict] = []
    now = datetime.now(UTC)
    for raw_id in dict.fromkeys(body.report_ids):
        try:
            report_id = UUID(raw_id)
        except ValueError:
            results.append({"id": raw_id, "success": False, "error": "举报 ID 无效"})
            continue
        report = await db.scalar(select(Report).where(Report.id == report_id))
        if report is None:
            results.append({"id": raw_id, "success": False, "error": "举报不存在"})
            continue
        before = {"status": report.status, "resolution_note": report.resolution_note}
        report.status = body.status
        report.resolution_note = body.note
        report.handled_by = admin.id
        report.handled_at = now
        results.append({"id": raw_id, "success": True, "error": None})
        add_admin_audit(
            db,
            request=request,
            actor=admin,
            action="report.status_update",
            target_type="report",
            target_id=raw_id,
            before=before,
            after={"status": report.status, "resolution_note": report.resolution_note},
            note=body.note,
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
        action="report.batch_status",
        target_type="report_batch",
        target_id=body.batch_id,
        after=response_data,
        note=body.note,
        batch_id=body.batch_id,
        success=response_data["failed"] == 0,
    )
    await db.commit()
    return BatchActionResponse(**response_data)
