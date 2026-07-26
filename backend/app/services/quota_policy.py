"""版本化配额策略读取、校验与影响分析。"""

from __future__ import annotations

import hashlib
import json
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models.quota import QuotaPolicyVersion
from app.schemas.quota_policy import (
    QuotaPolicyConfig,
    TechnicalQuotaCeilings,
)


def default_policy_config() -> QuotaPolicyConfig:
    return QuotaPolicyConfig.model_validate({
        "timezone": "Asia/Shanghai",
        "guest": {
            "period_kind": "daily",
            "period_limit_bytes": 2 * 1024**3,
            "max_file_bytes": 2 * 1024**3,
            "max_share_bytes": 2 * 1024**3,
            "max_files_per_share": 100,
            "max_empty_dirs_per_share": 100,
            "max_active_shares": 5,
            "max_concurrent_upload_batches": 1,
            "default_retention_hours": 1,
            "retention_options_hours": [1, 6, 24, 72],
            "default_max_downloads": 10,
            "download_options": [1, 10],
        },
        "user": {
            "period_kind": "monthly",
            "period_limit_bytes": 50 * 1024**3,
            "max_file_bytes": 10 * 1024**3,
            "max_share_bytes": 20 * 1024**3,
            "max_files_per_share": 500,
            "max_empty_dirs_per_share": 500,
            "max_active_shares": 30,
            "max_concurrent_upload_batches": 3,
            "default_retention_hours": 168,
            "retention_options_hours": [1, 6, 24, 72, 168, 360, 720],
            "default_max_downloads": 100,
            "download_options": [1, 10, 50, 100, 200, 0],
        },
        "receive": {
            "enabled": True,
            "max_active_requests": 10,
            "max_request_bytes": 10 * 1024**3,
            "max_file_bytes": 10 * 1024**3,
            "max_files_per_request": 100,
            "default_retention_hours": 168,
            "retention_options_hours": [24, 168, 720],
        },
        "retention_coupon_hours": 2160,
    })


def technical_ceilings() -> TechnicalQuotaCeilings:
    settings = get_settings()
    return TechnicalQuotaCeilings(
        max_file_bytes=settings.platform_max_file_bytes,
        max_share_bytes=settings.platform_max_share_bytes,
        max_files_per_share=settings.platform_max_files_per_share,
        max_empty_dirs_per_share=settings.platform_max_empty_dirs_per_share,
        max_retention_hours=settings.platform_max_retention_hours,
        max_active_links=settings.platform_max_active_links,
        max_concurrent_upload_batches=settings.platform_max_concurrent_upload_batches,
        max_request_bytes=settings.platform_max_request_bytes,
        max_request_files=settings.platform_max_request_files,
    )


def policy_validation_errors(config: QuotaPolicyConfig) -> list[str]:
    limits = technical_ceilings()
    errors: list[str] = []
    for label, policy in (("游客", config.guest), ("注册用户", config.user)):
        if policy.max_file_bytes > limits.max_file_bytes:
            errors.append(f"{label}单文件上限超过平台技术上限")
        if policy.max_share_bytes > limits.max_share_bytes:
            errors.append(f"{label}单分享容量超过平台技术上限")
        if policy.max_files_per_share > limits.max_files_per_share:
            errors.append(f"{label}单分享文件数超过平台技术上限")
        if policy.max_empty_dirs_per_share > limits.max_empty_dirs_per_share:
            errors.append(f"{label}空目录数超过平台技术上限")
        if policy.max_active_shares > limits.max_active_links:
            errors.append(f"{label}活跃分享数超过平台技术上限")
        if policy.max_concurrent_upload_batches > limits.max_concurrent_upload_batches:
            errors.append(f"{label}并发上传批次数超过平台技术上限")
        if max(policy.retention_options_hours) > limits.max_retention_hours:
            errors.append(f"{label}分享有效期超过平台技术上限")
    if config.receive.max_request_bytes > limits.max_request_bytes:
        errors.append("单条收件容量超过平台技术上限")
    if config.receive.max_file_bytes > limits.max_file_bytes:
        errors.append("收件单文件上限超过平台技术上限")
    if config.receive.max_files_per_request > limits.max_request_files:
        errors.append("收件文件数超过平台技术上限")
    if config.receive.max_active_requests > limits.max_active_links:
        errors.append("活跃收件链接数超过平台技术上限")
    if max(config.receive.retention_options_hours) > limits.max_retention_hours:
        errors.append("收件有效期超过平台技术上限")
    if config.retention_coupon_hours > limits.max_retention_hours:
        errors.append("保留券有效期超过平台技术上限")
    return errors


@dataclass
class EffectiveQuotaPolicy:
    id: uuid.UUID | None
    version: int
    effective_at: datetime
    config: QuotaPolicyConfig


async def get_effective_policy(
    db: AsyncSession, *, now: datetime | None = None
) -> EffectiveQuotaPolicy:
    current_time = now or datetime.now(UTC)
    row = await db.scalar(
        select(QuotaPolicyVersion)
        .where(
            QuotaPolicyVersion.status.in_(("published", "scheduled")),
            QuotaPolicyVersion.effective_at.is_not(None),
            QuotaPolicyVersion.effective_at <= current_time,
        )
        .order_by(QuotaPolicyVersion.effective_at.desc(), QuotaPolicyVersion.version.desc())
        .limit(1)
    )
    if not row:
        return EffectiveQuotaPolicy(None, 0, current_time, default_policy_config())
    return EffectiveQuotaPolicy(
        row.id,
        row.version,
        row.effective_at or row.published_at or row.created_at,
        QuotaPolicyConfig.model_validate(row.config),
    )


async def get_policy_config_for_version(db: AsyncSession, version: int) -> QuotaPolicyConfig:
    if version > 0:
        row = await db.scalar(
            select(QuotaPolicyVersion).where(QuotaPolicyVersion.version == version)
        )
        if row:
            return QuotaPolicyConfig.model_validate(row.config)
    return default_policy_config()


async def next_policy_version(db: AsyncSession) -> int:
    await db.scalar(select(func.pg_advisory_xact_lock(func.hashtext("quota-policy-version"))))
    return int(await db.scalar(select(func.coalesce(func.max(QuotaPolicyVersion.version), 0))) or 0) + 1


def flatten_config(value: object, prefix: str = "") -> dict[str, object]:
    if isinstance(value, dict):
        result: dict[str, object] = {}
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else key
            result.update(flatten_config(item, path))
        return result
    return {prefix: value}


async def preview_policy_impact(
    db: AsyncSession,
    redis,
    config: QuotaPolicyConfig,
) -> tuple[list[str], list[str], list[str], int]:
    errors = policy_validation_errors(config)
    current = await get_effective_policy(db)
    before = flatten_config(current.config.model_dump())
    after = flatten_config(config.model_dump())
    changed = sorted(key for key in set(before) | set(after) if before.get(key) != after.get(key))
    warnings: list[str] = []
    over_limit = 0
    if redis:
        async for key in redis.scan_iter(match="nyy:quota:v2:*", count=200):
            if not str(key).endswith(":usage"):
                continue
            used = int(await redis.hget(key, "used") or 0)
            limit = config.user.period_limit_bytes if ":user:" in str(key) else config.guest.period_limit_bytes
            if used > limit:
                over_limit += 1
    if over_limit:
        warnings.append(f"有 {over_limit} 个身份当前已用量高于新上限，发布后将暂停新增上传直到重置")
    if config.guest.period_limit_bytes < current.config.guest.period_limit_bytes:
        warnings.append("游客周期额度将降低")
    if config.user.period_limit_bytes < current.config.user.period_limit_bytes:
        warnings.append("注册用户周期额度将降低")
    return errors, warnings, changed, over_limit


def clone_policy_config(config: QuotaPolicyConfig) -> QuotaPolicyConfig:
    return QuotaPolicyConfig.model_validate(deepcopy(config.model_dump()))


def policy_config_hash(config: QuotaPolicyConfig) -> str:
    payload = json.dumps(config.model_dump(), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()
