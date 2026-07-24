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
    HashBlacklist,
    IpQuota,
    Report,
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
    "GrowthLandingEvent",
    "HashBlacklist",
    "IpQuota",
    "MailboxAttachment",
    "MailboxImportSource",
    "MailboxImportTombstone",
    "MailboxMessage",
    "ReferralAttribution",
    "Report",
    "RetentionCoupon",
    "Share",
    "ShareAccessEvent",
    "ShareEventIdempotencyKey",
    "ShareFile",
    "ShareLogicalFile",
    "User",
    "ViralClickEvent",
]
