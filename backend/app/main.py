"""FastAPI 应用入口。"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.v1 import api_v1_router
from app.api.v1.health import router as health_router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    configure_logging()
    slog = get_logger("nyy.startup")
    settings = get_settings()
    slog.info(
        "nyy starting",
        env=settings.app_env,
        base_url=settings.app_base_url,
        version=__version__,
    )

    # --- Redis ---
    redis_client = None
    try:
        import redis.asyncio as aioredis
        redis_client = aioredis.from_url(
            settings.redis_url, decode_responses=True
        )
        await redis_client.ping()
        slog.info("redis connected", url=settings.redis_url)
    except Exception as e:
        slog.warning("redis unavailable, quota/token disabled", error=str(e))
        redis_client = None
    app.state.redis = redis_client

    # --- Doubao client ---
    from app.services.doubao_client import shutdown_doubao_client

    yield

    # --- Shutdown ---
    if redis_client:
        await redis_client.aclose()
    await shutdown_doubao_client()
    slog.info("nyy stopped")


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="拿呀呀 nyy.app",
        version=__version__,
        docs_url="/api/docs" if settings.is_dev else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.is_dev else None,
        lifespan=lifespan,
    )

    # 顶层健康检查（不带 /api/v1 前缀）
    app.include_router(health_router)
    # 版本化 API
    app.include_router(api_v1_router, prefix="/api/v1")

    if settings.is_dev:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.68.102:3000"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    return app


app = create_app()
