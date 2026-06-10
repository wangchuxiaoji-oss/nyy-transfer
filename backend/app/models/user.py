"""User 模型。"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, Index, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, TimestampMixin


class UserPlan:
    GUEST = "guest"  # 不会写到数据库，只在内存里用
    FREE = "free"
    PRO = "pro"
    ADMIN = "admin"


class User(Base, TimestampMixin):
    __tablename__ = "users"
    __table_args__ = (
        CheckConstraint(
            "is_admin IS FALSE OR lower(email) = 'admin@nyy.app'",
            name="ck_users_admin_email",
        ),
        Index(
            "uq_users_single_admin",
            "is_admin",
            unique=True,
            postgresql_where=text("is_admin IS TRUE"),
            sqlite_where=text("is_admin IS TRUE"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    plan: Mapped[str] = mapped_column(String(16), default=UserPlan.FREE, nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false", nullable=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.email} plan={self.plan}>"
