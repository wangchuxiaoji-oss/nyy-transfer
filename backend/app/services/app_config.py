"""持久化应用配置。"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.system import AppConfig

QUOTA_CONFIG_KEY = "quota"
DOWNLOAD_CONFIG_KEY = "download"


def default_quota_config() -> dict[str, int]:
    settings = get_settings()
    return {
        "guest_max_file_bytes": settings.guest_max_file_bytes,
        "guest_max_active_shares": settings.guest_max_active_shares,
        "guest_ttl_hours": settings.guest_ttl_hours,
        "user_max_file_bytes": settings.user_max_file_bytes,
        "user_max_active_shares": settings.user_max_active_shares,
        "user_ttl_hours": 30 * 24,
    }


async def get_quota_config(db: AsyncSession) -> dict[str, int]:
    result = await db.execute(select(AppConfig).where(AppConfig.key == QUOTA_CONFIG_KEY))
    row = result.scalar_one_or_none()
    config = default_quota_config()
    if row:
        config.update(row.value)
    return config


async def set_quota_config(
    db: AsyncSession,
    value: dict[str, int],
    updated_by,
    *,
    commit: bool = True,
) -> dict[str, int]:
    config = default_quota_config()
    config.update(value)
    result = await db.execute(select(AppConfig).where(AppConfig.key == QUOTA_CONFIG_KEY))
    row = result.scalar_one_or_none()
    if row:
        row.value = config
        row.updated_by = updated_by
    else:
        row = AppConfig(key=QUOTA_CONFIG_KEY, value=config, updated_by=updated_by)
        db.add(row)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return config


def default_download_config() -> dict[str, bool | int | str]:
    return {
        "smart_download_enabled": True,
        "target_video": True,
        "target_audio": True,
        "target_pdf": True,
        "target_image": True,
        "target_other": True,
        "filesystem_access_enabled": True,
        "leave_warning_enabled": True,
    }


async def get_download_config(db: AsyncSession) -> dict[str, bool | int | str]:
    result = await db.execute(select(AppConfig).where(AppConfig.key == DOWNLOAD_CONFIG_KEY))
    row = result.scalar_one_or_none()
    config = default_download_config()
    if row:
        config.update(row.value)
    return config


async def set_download_config(
    db: AsyncSession,
    value: dict[str, bool | int | str],
    updated_by,
    *,
    commit: bool = True,
) -> dict[str, bool | int | str]:
    config = default_download_config()
    config.update(value)
    result = await db.execute(select(AppConfig).where(AppConfig.key == DOWNLOAD_CONFIG_KEY))
    row = result.scalar_one_or_none()
    if row:
        row.value = config
        row.updated_by = updated_by
    else:
        row = AppConfig(key=DOWNLOAD_CONFIG_KEY, value=config, updated_by=updated_by)
        db.add(row)
    if commit:
        await db.commit()
    else:
        await db.flush()
    return config
