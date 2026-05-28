"""健康检查 + 版本。"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app import __version__
from app.db.session import get_db

router = APIRouter(tags=["meta"])


@router.get("/healthz")
async def healthz() -> dict[str, str]:
    """轻量健康检查：进程存活即可。"""

    return {"status": "ok", "version": __version__}


@router.get("/readyz")
async def readyz(db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """就绪检查：探测一下数据库连通性。"""

    await db.execute(text("SELECT 1"))
    return {"status": "ready", "db": "ok"}
