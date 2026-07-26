"""持久化应用配置。"""

from __future__ import annotations

from datetime import UTC, datetime

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
    from app.services.quota_policy import get_effective_policy

    policy = (await get_effective_policy(db)).config
    return {
        "guest_max_file_bytes": policy.guest.period_limit_bytes,
        "guest_max_active_shares": policy.guest.max_active_shares,
        "guest_ttl_hours": max(policy.guest.retention_options_hours),
        "user_max_file_bytes": policy.user.period_limit_bytes,
        "user_max_active_shares": policy.user.max_active_shares,
        "user_ttl_hours": max(policy.user.retention_options_hours),
    }


async def set_quota_config(
    db: AsyncSession,
    value: dict[str, int],
    updated_by,
    *,
    commit: bool = True,
) -> dict[str, int]:
    from app.models.quota import QuotaPolicyVersion
    from app.schemas.quota_policy import QuotaPolicyConfig
    from app.services.quota_policy import (
        get_effective_policy,
        next_policy_version,
        policy_validation_errors,
    )

    current = await get_effective_policy(db)
    config = current.config.model_dump()
    for audience, prefix in (("guest", "guest"), ("user", "user")):
        period_limit = int(value[f"{prefix}_max_file_bytes"])
        policy = config[audience]
        policy["period_limit_bytes"] = period_limit
        policy["max_file_bytes"] = min(int(policy["max_file_bytes"]), period_limit)
        policy["max_share_bytes"] = min(int(policy["max_share_bytes"]), period_limit)
        policy["max_active_shares"] = int(value[f"{prefix}_max_active_shares"])
        ttl = int(value[f"{prefix}_ttl_hours"])
        retention_options = [int(item) for item in policy["retention_options_hours"] if int(item) <= ttl]
        if ttl not in retention_options:
            retention_options.append(ttl)
        policy["retention_options_hours"] = sorted(set(retention_options))
        if int(policy["default_retention_hours"]) > ttl:
            policy["default_retention_hours"] = max(policy["retention_options_hours"])

    validated = QuotaPolicyConfig.model_validate(config)
    errors = policy_validation_errors(validated)
    if errors:
        raise ValueError("；".join(errors))
    now = datetime.now(UTC)
    db.add(QuotaPolicyVersion(
        version=await next_policy_version(db),
        status="published",
        config=validated.model_dump(),
        note="由旧版配额配置接口立即发布",
        effective_at=now,
        published_at=now,
        created_by=updated_by,
        published_by=updated_by,
    ))
    if commit:
        await db.commit()
    else:
        await db.flush()
    return await get_quota_config(db)


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
