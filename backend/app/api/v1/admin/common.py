"""Admin 各模块共享的状态表达式、列表项构造与分页工具。"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException, Request
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.share import Share, ShareLogicalFile
from app.models.system import EmailDelivery, Report
from app.models.user import User
from app.schemas.admin import AdminEmailItem, AdminReportItem, AdminUserItem
from app.utils.client_ip import get_client_ip

# 页码模式的最大扫描窗口；超出后提示收窄筛选，避免深页拖垮数据库
MAX_PAGE_WINDOW_ROWS = 10_000


def _share_status_filters(status_filter: str, now: datetime):
    if status_filter == "revoked":
        return [Share.revoked_at.is_not(None)]
    if status_filter == "banned":
        return [Share.banned_at.is_not(None)]
    if status_filter == "expired":
        return [Share.revoked_at.is_(None), Share.banned_at.is_(None), Share.expires_at.is_not(None), Share.expires_at <= now]
    if status_filter == "download_exhausted":
        return [
            Share.revoked_at.is_(None),
            Share.banned_at.is_(None),
            or_(Share.expires_at.is_(None), Share.expires_at > now),
            Share.max_downloads > 0,
            Share.download_count >= Share.max_downloads,
        ]
    if status_filter == "active":
        return [
            Share.revoked_at.is_(None),
            Share.banned_at.is_(None),
            or_(Share.expires_at.is_(None), Share.expires_at > now),
            or_(Share.max_downloads == 0, Share.download_count < Share.max_downloads),
        ]
    return []


def _share_status(share: Share, now: datetime) -> str:
    if share.banned_at is not None:
        return "banned"
    if share.revoked_at is not None:
        return "revoked"
    if share.expires_at is not None and share.expires_at <= now:
        return "expired"
    if share.max_downloads > 0 and share.download_count >= share.max_downloads:
        return "download_exhausted"
    return "active"


async def _get_admin_share(code: str, db: AsyncSession, *, with_content: bool = False) -> Share:
    options = [selectinload(Share.logical_files)]
    if with_content:
        options = [
            selectinload(Share.files),
            selectinload(Share.logical_files).selectinload(ShareLogicalFile.files),
        ]
    result = await db.execute(
        select(Share)
        .options(*options)
        .where(Share.code == code)
    )
    share = result.scalar_one_or_none()
    if share is None:
        raise HTTPException(404, "分享不存在")
    return share


def _user_plan_filters(plan: str) -> list:
    if plan == "admin":
        return [User.is_admin.is_(True)]
    if plan == "free":
        return [User.plan == "free"]
    if plan == "pro":
        return [User.plan == "pro"]
    return []


def _user_status_filters(status_filter: str) -> list:
    if status_filter == "active":
        return [User.disabled_at.is_(None), User.deleted_at.is_(None)]
    if status_filter == "disabled":
        return [User.disabled_at.is_not(None), User.deleted_at.is_(None)]
    if status_filter == "deleted":
        return [User.deleted_at.is_not(None)]
    if status_filter == "verified":
        return [User.email_verified_at.is_not(None), User.deleted_at.is_(None)]
    if status_filter == "unverified":
        return [User.email_verified_at.is_(None), User.deleted_at.is_(None)]
    return []


def _admin_user_item(
    user: User,
    registration_source=None,
    last_login_source=None,
) -> AdminUserItem:
    return AdminUserItem(
        id=str(user.id),
        email=user.email,
        plan=user.plan,
        is_admin=user.is_admin,
        email_verified=user.email_verified_at is not None,
        disabled=user.disabled_at is not None,
        deleted=user.deleted_at is not None,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
        disabled_at=user.disabled_at,
        deleted_at=user.deleted_at,
        registration_source=registration_source,
        last_login_source=last_login_source,
    )


def _request_ip(request: Request) -> str:
    return get_client_ip(request)


def _request_ua(request: Request) -> str:
    return request.headers.get("user-agent", "")


def _admin_report_item(report: Report, share: Share, report_count: int = 1) -> AdminReportItem:
    return AdminReportItem(
        id=str(report.id),
        share_code=share.code,
        reason=report.reason,
        detail=report.detail,
        status=report.status,
        created_at=report.created_at,
        reporter_ip=str(report.reporter_ip) if report.reporter_ip else None,
        resolution_note=report.resolution_note,
        handled_at=report.handled_at,
        report_count=report_count,
        share_status=_share_status(share, datetime.now(UTC)),
    )


def _admin_email_item(delivery: EmailDelivery, share_code: str) -> AdminEmailItem:
    return AdminEmailItem(
        id=str(delivery.id),
        recipient=delivery.recipient,
        share_code=share_code,
        status=delivery.status,
        error=delivery.error,
        created_at=delivery.created_at,
        sent_at=delivery.sent_at,
        delivery_type=delivery.delivery_type,
        attempt_number=delivery.attempt_number,
        last_attempt_at=delivery.last_attempt_at,
        parent_delivery_id=str(delivery.parent_delivery_id) if delivery.parent_delivery_id else None,
    )


def _validate_cursor_args(after: str | None, before: str | None) -> None:
    if after and before:
        raise HTTPException(400, "after 与 before 不能同时使用")


def _validate_page_window(page: int | None, page_size: int) -> None:
    """页码模式深页保护：超出最大窗口后提示收窄筛选条件。"""

    if page is not None and page * page_size > MAX_PAGE_WINDOW_ROWS:
        raise HTTPException(400, "分页范围过大，请收窄日期或搜索条件")
