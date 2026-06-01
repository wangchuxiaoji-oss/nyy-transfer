"""测试共享 fixture。

修复 event loop 污染：模块级 DB 引擎/会话工厂是单例，会绑定到首次
创建它的 event loop。pytest-asyncio 的 function 级 loop 会导致后续测试
在旧 loop 上清理 asyncpg 连接，抛 "Event loop is closed"。

下面的 autouse fixture 在每个测试结束后重置并 dispose 引擎单例，
保证每个测试用例的 DB 引擎与自身 event loop 绑定。
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
async def _reset_db_engine_singletons():
    """每个测试后 dispose 并清空模块级引擎/会话工厂单例。"""
    yield
    import app.db.session as db_session

    engine = db_session._engine
    if engine is not None:
        await engine.dispose()
    db_session._engine = None
    db_session._session_factory = None
