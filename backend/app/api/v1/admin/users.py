"""Admin 用户管理。"""

from __future__ import annotations

from datetime import UTC, datetime
from ipaddress import ip_address
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.admin.common import (
    _admin_user_item,
    _request_ip,
    _request_ua,
    _user_plan_filters,
    _user_status_filters,
    _validate_cursor_args,
    _validate_page_window,
)
from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.auth import AuthEvent
from app.models.user import User
from app.schemas.admin import (
    AdminUserItem,
    AdminUsersResponse,
    AdminUserUpdate,
    MessageResponse,
)
from app.services.admin_audit import add_admin_audit
from app.services.admin_sources import load_user_source_summaries
from app.services.auth_audit import log_auth_event
from app.services.auth_session import revoke_user_sessions
from app.services.email_code import (
    _code_key,
    generate_email_code,
    send_email_code,
    store_email_code,
)
from app.services.pagination import (
    created_cursor_filter,
    decode_created_cursor,
    encode_created_cursor,
)

router = APIRouter()


@router.get("/users", response_model=AdminUsersResponse)
async def list_users(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
    page: int | None = Query(None, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    limit: int = Query(50, ge=1, le=100),
    after: str | None = Query(None, max_length=512),
    before: str | None = Query(None, max_length=512),
    include_total: bool = Query(False),
    q: str = Query("", max_length=128),
    plan: str = Query("all", pattern="^(all|free|pro|admin)$"),
    status_filter: str = Query("all", alias="status", pattern="^(all|active|disabled|deleted|verified|unverified)$"),
    sort: str = Query("created_desc", pattern="^(created_desc|created_asc|email_asc|email_desc|last_login_desc|last_login_asc)$"),
):
    _validate_cursor_args(after, before)
    _validate_page_window(page, page_size)
    filters = []
    if q:
        like = f"%{q}%"
        search_filters = [User.email.ilike(like), User.plan.ilike(like)]
        try:
            normalized_ip = ip_address(q).compressed
            search_filters.append(User.id.in_(select(AuthEvent.user_id).where(AuthEvent.ip == normalized_ip)))
        except ValueError:
            pass
        filters.append(or_(*search_filters))
    filters.extend(_user_plan_filters(plan))
    filters.extend(_user_status_filters(status_filter))

    order_by = {
        "created_desc": (User.created_at.desc(), User.id.desc()),
        "created_asc": (User.created_at.asc(), User.id.asc()),
        "email_asc": (User.email.asc(), User.id.asc()),
        "email_desc": (User.email.desc(), User.id.desc()),
        "last_login_desc": (User.last_login_at.desc().nullslast(), User.id.desc()),
        "last_login_asc": (User.last_login_at.asc().nullsfirst(), User.id.asc()),
    }[sort]

    page_mode = page is not None or sort not in {"created_desc"}
    effective_page = page or 1
    total = None
    if page_mode or (include_total and bool(filters)):
        total = await db.scalar(select(func.count()).select_from(User).where(*filters)) or 0
    stmt = select(User).where(*filters)
    reverse_page = False
    if page_mode:
        stmt = stmt.order_by(*order_by).offset((effective_page - 1) * page_size).limit(page_size)
    else:
        cursor = decode_created_cursor(after or before)
        reverse_page = bool(before)
        if cursor:
            stmt = stmt.where(
                created_cursor_filter(User.created_at, User.id, cursor, after=bool(after))
            )
        stmt = stmt.order_by(
            User.created_at.asc() if reverse_page else User.created_at.desc(),
            User.id.asc() if reverse_page else User.id.desc(),
        ).limit(limit + 1)
    result = await db.execute(stmt)
    users = result.scalars().all()
    has_more = not page_mode and len(users) > limit
    if has_more:
        users = users[:limit]
    if reverse_page:
        users.reverse()
    registrations, logins = await load_user_source_summaries(db, [user.id for user in users])
    items = [_admin_user_item(u, registrations.get(u.id), logins.get(u.id)) for u in users]
    return AdminUsersResponse(
        users=items,
        items=items,
        pagination_mode="page" if page_mode else "cursor",
        next_cursor=(
            encode_created_cursor(users[-1].created_at, users[-1].id)
            if users and has_more
            else None
        ),
        prev_cursor=(
            encode_created_cursor(users[0].created_at, users[0].id)
            if users and not page_mode and (after or before)
            else None
        ),
        has_more=has_more,
        total=total,
        page=effective_page if page_mode else None,
        page_size=page_size if page_mode else None,
    )


@router.patch("/users/{user_id}", response_model=AdminUserItem)
async def update_user(
    user_id: UUID,
    body: AdminUserUpdate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    user = await db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(404, "用户不存在")
    if user.is_admin:
        raise HTTPException(400, "管理员账号不可在此修改")

    now = datetime.now(UTC)
    revoke_sessions = False
    before = {
        "plan": user.plan,
        "disabled_at": user.disabled_at,
        "deleted_at": user.deleted_at,
        "email_verified_at": user.email_verified_at,
    }

    if body.plan is not None:
        user.plan = body.plan
    if body.disabled is not None:
        user.disabled_at = now if body.disabled else None
        if body.disabled:
            revoke_sessions = True
    if body.deleted is not None:
        user.deleted_at = now if body.deleted else None
        if body.deleted:
            revoke_sessions = True
    if body.email_verified is not None:
        user.email_verified_at = now if body.email_verified else None
        if not body.email_verified:
            revoke_sessions = True

    if revoke_sessions:
        await revoke_user_sessions(db, user.id)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="user.status_update",
        target_type="user",
        target_id=str(user.id),
        before=before,
        after={
            "plan": user.plan,
            "disabled_at": user.disabled_at,
            "deleted_at": user.deleted_at,
            "email_verified_at": user.email_verified_at,
        },
    )
    await db.commit()
    return _admin_user_item(user)


@router.post("/users/{user_id}/password-reset", response_model=MessageResponse)
async def send_user_password_reset(
    user_id: UUID,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    redis = request.app.state.redis
    if redis is None:
        raise HTTPException(503, "缓存服务暂时不可用")

    user = await db.scalar(select(User).where(User.id == user_id))
    if not user:
        raise HTTPException(404, "用户不存在")
    if user.is_admin:
        raise HTTPException(400, "管理员账号不可在此重置")
    if user.deleted_at is not None:
        raise HTTPException(400, "已删除用户不可发送重置邮件")

    code = generate_email_code()
    ip = _request_ip(request)
    ua = _request_ua(request)
    await store_email_code(redis, user.email, code, "reset_password", ip, ua)
    sent = await send_email_code(user.email, code, "reset_password")
    if not sent:
        await redis.delete(_code_key("reset_password", user.email))
        await log_auth_event(
            db, event_type="password_reset_failed", success=False,
            user_id=user.id, email=user.email, ip=ip, user_agent=ua,
            reason="admin_reset_email_failed",
        )
        add_admin_audit(
            db,
            request=request,
            actor=admin,
            action="user.password_reset_email",
            target_type="user",
            target_id=str(user.id),
            success=False,
            error_summary="重置邮件发送失败",
        )
        await db.commit()
        raise HTTPException(500, "重置邮件发送失败")

    await log_auth_event(
        db, event_type="password_reset_requested", success=True,
        user_id=user.id, email=user.email, ip=ip, user_agent=ua,
        reason=f"admin_triggered:{admin.id}",
    )
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="user.password_reset_email",
        target_type="user",
        target_id=str(user.id),
        after={"recipient": user.email},
    )
    await db.commit()
    return MessageResponse(message="重置邮件已发送")
