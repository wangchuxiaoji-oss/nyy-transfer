"""数据库连接 / 会话工厂（异步）。

设计要点：
- engine / sessionmaker 惰性创建：import 此模块不会立刻连数据库或要求驱动可用，
  方便单元测试 / 工具脚本 import 应用模块。
- 真正需要 DB 的代码通过 ``get_db`` 依赖注入获取 ``AsyncSession``。
"""

from __future__ import annotations

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import get_settings

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.database_url,
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=10,
            future=True,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            bind=get_engine(),
            expire_on_commit=False,
            autoflush=False,
            class_=AsyncSession,
        )
    return _session_factory


async def get_db() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖：注入一个 AsyncSession，按 contextual scope 关闭。"""

    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
        except Exception:  # noqa: BLE001 - 让上层捕获，这里只负责回滚
            await session.rollback()
            raise


async def dispose_engine() -> None:
    """便于测试 / shutdown 钩子调用。"""

    global _engine, _session_factory
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _session_factory = None
