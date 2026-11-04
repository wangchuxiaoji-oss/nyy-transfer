"""ORM 模型，统一在此 import 给 Alembic 发现。"""

from app.models.auth import AuthEvent, AuthSession
from app.models.growth import (
    GrowthLandingEvent,
    ReferralAttribution,
    RetentionCoupon,
    ViralClickEvent,
)
from app.models.mailbox import (
    MailboxAttachment,
    MailboxImportSource,
    MailboxImportTombstone,
    MailboxMessage,
)
from app.models.media import MediaObjectCleanupJob, MediaProcessingJob, ShareMediaAsset
from app.models.quota import QuotaPolicyVersion
from app.models.share import (
    DownloadLog,
    DownloadSession,
    Share,
    ShareAccessEvent,
    ShareEventIdempotencyKey,
    ShareFile,
    ShareLogicalFile,
)
from app.models.system import (
    ArchiveBatch,
    ArchivedShare,
    AuditLog,
    EmailDelivery,
    FileRequest,
    FileRequestFile,
    FileRequestUpload,
    HashBlacklist,
    IpQuota,
    Report,
    SystemAnnouncement,
)
from app.models.user import User

__all__ = [
    "ArchiveBatch",
    "ArchivedShare",
    "AuditLog",
    "AuthEvent",
    "AuthSession",
    "DownloadLog",
    "DownloadSession",
    "EmailDelivery",
    "FileRequest",
    "FileRequestFile",
    "FileRequestUpload",
    "GrowthLandingEvent",
    "HashBlacklist",
    "IpQuota",
    "MailboxAttachment",
    "MailboxImportSource",
    "MailboxImportTombstone",
    "MailboxMessage",
    "MediaObjectCleanupJob",
    "MediaProcessingJob",
    "QuotaPolicyVersion",
    "ReferralAttribution",
    "Report",
    "RetentionCoupon",
    "Share",
    "ShareAccessEvent",
    "ShareEventIdempotencyKey",
    "ShareFile",
    "ShareLogicalFile",
    "ShareMediaAsset",
    "SystemAnnouncement",
    "User",
    "ViralClickEvent",
]
