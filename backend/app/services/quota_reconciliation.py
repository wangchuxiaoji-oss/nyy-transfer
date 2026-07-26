"""补偿数据库已提交但 Redis 配额尚未结算的上传。"""

from __future__ import annotations

import logging

from sqlalchemy import select

from app.db.session import get_session_factory
from app.models.share import Share
from app.models.system import FileRequest, FileRequestUpload
from app.services.quota_policy import get_policy_config_for_version

log = logging.getLogger(__name__)


async def reconcile_quota_settlements(redis, *, limit: int = 100) -> int:
    from app.api.v1.file_requests import _settle_request_upload
    from app.api.v1.uploads import _settle_share_quota

    settled = 0
    factory = get_session_factory()
    async with factory() as db:
        share_ids = list((await db.scalars(
            select(Share.id)
            .where(Share.quota_settled_at.is_(None), Share.quota_scope.is_not(None))
            .order_by(Share.created_at)
            .limit(limit)
        )).all())
    for share_id in share_ids:
        async with factory() as db:
            try:
                share = await db.scalar(
                    select(Share).where(Share.id == share_id).with_for_update(skip_locked=True)
                )
                if not share or share.quota_settled_at is not None:
                    continue
                config = await get_policy_config_for_version(db, share.policy_version)
                policy = config.user if share.owner_id else config.guest
                await _settle_share_quota(share, redis, policy, db)
                settled += 1
            except Exception:
                await db.rollback()
                log.exception("分享配额补结算失败", extra={"share_id": str(share_id)})

    remaining = max(0, limit - settled)
    if not remaining:
        return settled
    async with factory() as db:
        upload_ids = list((await db.scalars(
            select(FileRequestUpload.id)
            .where(FileRequestUpload.quota_settled_at.is_(None))
            .order_by(FileRequestUpload.created_at)
            .limit(remaining)
        )).all())
    for upload_id in upload_ids:
        async with factory() as db:
            try:
                upload = await db.scalar(
                    select(FileRequestUpload)
                    .where(FileRequestUpload.id == upload_id)
                    .with_for_update(skip_locked=True)
                )
                if not upload or upload.quota_settled_at is not None:
                    continue
                req = await db.get(FileRequest, upload.request_id)
                if not req:
                    continue
                config = await get_policy_config_for_version(db, req.policy_version)
                await _settle_request_upload(upload, req, redis, config.user, db)
                settled += 1
            except Exception:
                await db.rollback()
                log.exception("收件配额补结算失败", extra={"upload_id": str(upload_id)})
    return settled
