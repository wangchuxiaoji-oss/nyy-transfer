"""Admin 配额与下载行为配置。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_admin_user
from app.db.session import get_db
from app.models.user import User
from app.schemas.admin import (
    DownloadConfigResponse,
    DownloadConfigUpdate,
    QuotaConfigResponse,
    QuotaConfigUpdate,
)
from app.services.admin_audit import add_admin_audit
from app.services.app_config import (
    get_download_config,
    get_quota_config,
    set_download_config,
    set_quota_config,
)

router = APIRouter()


@router.get("/config/quota", response_model=QuotaConfigResponse)
async def get_quota(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    return QuotaConfigResponse(**await get_quota_config(db))


@router.put("/config/quota", response_model=QuotaConfigResponse)
async def update_quota(
    body: QuotaConfigUpdate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    before = await get_quota_config(db)
    config = await set_quota_config(db, body.model_dump(), admin.id, commit=False)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="config.quota_update",
        target_type="app_config",
        target_id="quota",
        before=before,
        after=config,
    )
    await db.commit()
    return QuotaConfigResponse(**config)


@router.get("/config/download", response_model=DownloadConfigResponse)
async def get_download_behavior_config(
    _: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    return DownloadConfigResponse(**await get_download_config(db))


@router.put("/config/download", response_model=DownloadConfigResponse)
async def update_download_behavior_config(
    body: DownloadConfigUpdate,
    request: Request,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
):
    before = await get_download_config(db)
    config = await set_download_config(db, body.model_dump(), admin.id, commit=False)
    add_admin_audit(
        db,
        request=request,
        actor=admin,
        action="config.download_update",
        target_type="app_config",
        target_id="download",
        before=before,
        after=config,
    )
    await db.commit()
    return DownloadConfigResponse(**config)
