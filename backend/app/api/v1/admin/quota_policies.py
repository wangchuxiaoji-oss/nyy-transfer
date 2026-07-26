"""Admin 版本化配额策略管理。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.quota import QuotaPolicyVersion
from app.models.user import User
from app.schemas.quota_policy import (
    QuotaPolicyDraftCreate,
    QuotaPolicyDraftUpdate,
    QuotaPolicyImpactResponse,
    QuotaPolicyListResponse,
    QuotaPolicyPublishRequest,
    QuotaPolicyRollbackRequest,
    QuotaPolicyVersionResponse,
)
from app.services.admin_audit import add_admin_audit
from app.services.quota_policy import (
    clone_policy_config,
    get_effective_policy,
    next_policy_version,
    policy_config_hash,
    policy_validation_errors,
    preview_policy_impact,
    technical_ceilings,
)

router = APIRouter(prefix="/quota-policies")


def _response(row: QuotaPolicyVersion) -> QuotaPolicyVersionResponse:
    return QuotaPolicyVersionResponse.model_validate(row)


async def _row_or_404(db: AsyncSession, policy_id: uuid.UUID) -> QuotaPolicyVersion:
    row = await db.get(QuotaPolicyVersion, policy_id)
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "配额策略不存在")
    return row


def _effective_at(value: datetime | None) -> tuple[datetime, str]:
    now = datetime.now(UTC)
    target = value or now
    if target.tzinfo is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "生效时间必须包含时区")
    target = target.astimezone(UTC)
    if value is not None and target <= now:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "预约生效时间必须晚于当前时间")
    return target, "scheduled" if target > now else "published"


@router.get("", response_model=QuotaPolicyListResponse)
async def list_policies(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    rows = (
        await db.scalars(
            select(QuotaPolicyVersion).order_by(
                QuotaPolicyVersion.version.desc(), QuotaPolicyVersion.created_at.desc()
            )
        )
    ).all()
    current = await get_effective_policy(db)
    return QuotaPolicyListResponse(
        items=[_response(row) for row in rows],
        current_id=current.id,
    )


@router.post("", response_model=QuotaPolicyVersionResponse, status_code=status.HTTP_201_CREATED)
async def create_draft(
    body: QuotaPolicyDraftCreate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    current = await get_effective_policy(db)
    config = body.config or clone_policy_config(current.config)
    errors = policy_validation_errors(config)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, errors)
    row = QuotaPolicyVersion(
        version=await next_policy_version(db),
        status="draft",
        config=config.model_dump(),
        note=body.note,
        created_by=admin.id,
    )
    db.add(row)
    await db.flush()
    after = _response(row)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="quota_policy.create",
        target_type="quota_policy",
        target_id=str(row.id),
        after=after,
    )
    await db.commit()
    await db.refresh(row)
    return _response(row)


@router.put("/{policy_id}", response_model=QuotaPolicyVersionResponse)
async def update_draft(
    policy_id: uuid.UUID,
    body: QuotaPolicyDraftUpdate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _row_or_404(db, policy_id)
    if row.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "只有草稿可以编辑")
    errors = policy_validation_errors(body.config)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, errors)
    before = _response(row)
    row.config = body.config.model_dump()
    row.note = body.note
    row.updated_at = datetime.now(UTC)
    await db.flush()
    after = _response(row)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="quota_policy.update",
        target_type="quota_policy",
        target_id=str(row.id),
        before=before,
        after=after,
    )
    await db.commit()
    await db.refresh(row)
    return _response(row)


@router.post("/{policy_id}/preview", response_model=QuotaPolicyImpactResponse)
async def preview_policy(
    policy_id: uuid.UUID,
    request: Request,
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = await _row_or_404(db, policy_id)
    config = clone_policy_config(_response(row).config)
    errors, warnings, changed, over_limit = await preview_policy_impact(
        db, request.app.state.redis, config
    )
    return QuotaPolicyImpactResponse(
        valid=not errors,
        errors=errors,
        warnings=warnings,
        changed_fields=changed,
        over_limit_identities=over_limit,
        technical=technical_ceilings(),
        config_hash=policy_config_hash(config),
        updated_at=row.updated_at,
    )


@router.post("/{policy_id}/publish", response_model=QuotaPolicyVersionResponse)
async def publish_policy(
    policy_id: uuid.UUID,
    body: QuotaPolicyPublishRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    row = await db.scalar(
        select(QuotaPolicyVersion).where(QuotaPolicyVersion.id == policy_id).with_for_update()
    )
    if not row:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "配额策略不存在")
    if row.status != "draft":
        raise HTTPException(status.HTTP_409_CONFLICT, "只有草稿可以发布")
    config = clone_policy_config(_response(row).config)
    if policy_config_hash(config) != body.expected_config_hash:
        raise HTTPException(status.HTTP_409_CONFLICT, "草稿已被其他管理员修改，请重新预览")
    errors = policy_validation_errors(config)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, errors)
    effective_at, next_status = _effective_at(body.effective_at)
    before = _response(row)
    now = datetime.now(UTC)
    row.status = next_status
    row.effective_at = effective_at
    row.published_at = now
    row.published_by = admin.id
    row.note = body.note or row.note
    row.updated_at = now
    await db.flush()
    after = _response(row)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="quota_policy.publish" if next_status == "published" else "quota_policy.schedule",
        target_type="quota_policy",
        target_id=str(row.id),
        before=before,
        after=after,
        note=row.note,
    )
    await db.commit()
    await db.refresh(row)
    return _response(row)


@router.post("/{policy_id}/rollback", response_model=QuotaPolicyVersionResponse)
async def rollback_policy(
    policy_id: uuid.UUID,
    body: QuotaPolicyRollbackRequest,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    source = await _row_or_404(db, policy_id)
    if source.status not in {"published", "scheduled"}:
        raise HTTPException(status.HTTP_409_CONFLICT, "只能回滚到已发布或已预约的策略")
    config = clone_policy_config(_response(source).config)
    errors = policy_validation_errors(config)
    if errors:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, errors)
    effective_at, next_status = _effective_at(body.effective_at)
    now = datetime.now(UTC)
    row = QuotaPolicyVersion(
        version=await next_policy_version(db),
        status=next_status,
        config=config.model_dump(),
        note=body.note,
        effective_at=effective_at,
        published_at=now,
        created_by=admin.id,
        published_by=admin.id,
        rollback_from_id=source.id,
    )
    db.add(row)
    await db.flush()
    after = _response(row)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="quota_policy.rollback",
        target_type="quota_policy",
        target_id=str(row.id),
        after=after,
        note=f"回滚自版本 {source.version}：{body.note}",
    )
    await db.commit()
    await db.refresh(row)
    return _response(row)
