"""公开只读产品策略。"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.schemas.quota_policy import QuotaPolicyPublicResponse
from app.services.quota_policy import get_effective_policy, technical_ceilings

router = APIRouter(prefix="/policy", tags=["policy"])


@router.get("/current", response_model=QuotaPolicyPublicResponse)
async def get_current_policy(db: AsyncSession = Depends(get_db)):
    policy = await get_effective_policy(db)
    return QuotaPolicyPublicResponse(
        version=policy.version,
        effective_at=policy.effective_at,
        config=policy.config,
        technical=technical_ceilings(),
    )
