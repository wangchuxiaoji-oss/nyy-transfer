"""FastAPI 应用入口。"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from app import __version__
from app.api.v1 import api_v1_router
from app.api.v1.health import router as health_router
from app.core.config import get_settings
from app.core.logging import configure_logging, get_logger

log = logging.getLogger(__name__)


async def _restore_redis(app: FastAPI, client: Redis, url: str, retry_interval: float = 5) -> None:
    while True:
        await asyncio.sleep(retry_interval)
        try:
            await client.ping()
        except Exception:
            continue
        app.state.redis = client
        get_logger("nyy.startup").info("redis reconnected", url=url)
        return


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
    redis_client = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.redis = None
    reconnect_task = None
    try:
        await redis_client.ping()
        app.state.redis = redis_client
        slog.info("redis connected", url=settings.redis_url)
    except Exception as exc:
        slog.warning("redis unavailable, retrying in background", error=str(exc))
        reconnect_task = asyncio.create_task(_restore_redis(app, redis_client, settings.redis_url))

    async def reconcile_loop() -> None:
        from app.services.quota_reconciliation import reconcile_quota_settlements

        while True:
            if app.state.redis is not None:
                try:
                    settled = await reconcile_quota_settlements(redis_client)
                    if settled:
                        slog.info("quota settlements reconciled", count=settled)
                except Exception as exc:
                    slog.warning("quota settlement reconciliation failed", error=str(exc))
            await asyncio.sleep(60)

    reconciliation_task = asyncio.create_task(reconcile_loop())

    # --- Doubao client / auto verify ---
    from app.services.doubao_auto_verify import (
        shutdown_doubao_auto_verifier,
        start_doubao_auto_verifier,
    )
    from app.services.doubao_client import shutdown_doubao_client

    start_doubao_auto_verifier()

    yield

    # --- Shutdown ---
    for task in (reconnect_task, reconciliation_task):
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
    await redis_client.aclose()
    await shutdown_doubao_auto_verifier()
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

    @app.middleware("http")
    async def guest_identity_middleware(request: Request, call_next):
        from app.services.visitor_identity import (
            resolve_request_guest_identity,
            set_guest_cookie,
        )

        if not request.url.path.startswith("/api/v1/"):
            return await call_next(request)
        guest_id, should_set_cookie, migrated_legacy_header = resolve_request_guest_identity(request)
        request.state.guest_id = guest_id
        response = await call_next(request)
        if should_set_cookie:
            set_guest_cookie(response, guest_id)
        if migrated_legacy_header:
            response.headers["X-NYY-Guest-Migrated"] = "1"
        return response

    if settings.is_dev:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.68.102:3000"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
            expose_headers=["X-NYY-Guest-Migrated"],
        )

    return app


app = create_app()
