"""结构化日志。

简化版：开发环境彩色控制台，生产环境 JSON。绑定 request_id / user_id 由中间件按需注入。
"""

from __future__ import annotations

import logging
import sys

import structlog

from .config import get_settings


def configure_logging() -> None:
    settings = get_settings()
    level = getattr(logging, settings.app_log_level.upper(), logging.INFO)

    timestamper = structlog.processors.TimeStamper(fmt="iso", utc=True)

    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        timestamper,
    ]

    if settings.is_dev:
        renderer: structlog.types.Processor = structlog.dev.ConsoleRenderer()
    else:
        renderer = structlog.processors.JSONRenderer()

    structlog.configure(
        processors=shared_processors + [renderer],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )

    logging.basicConfig(level=level, format="%(message)s", stream=sys.stdout)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    return structlog.get_logger(name)
