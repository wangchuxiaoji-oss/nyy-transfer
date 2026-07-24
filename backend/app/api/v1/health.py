"""健康检查 + 版本。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
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
async def readyz(request: Request, db: AsyncSession = Depends(get_db)) -> dict[str, str]:
    """就绪检查：数据库和 Redis 均可用才接收生产流量。"""

    await db.execute(text("SELECT 1"))
    redis_client = getattr(request.app.state, "redis", None)
    if redis_client is None:
        raise HTTPException(status_code=503, detail="redis unavailable")
    try:
        await redis_client.ping()
    except Exception as exc:
        raise HTTPException(status_code=503, detail="redis unavailable") from exc
    return {"status": "ready", "db": "ok", "redis": "ok"}
