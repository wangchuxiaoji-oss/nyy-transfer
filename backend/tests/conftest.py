"""测试共享 fixture。

修复 event loop 污染：模块级 DB 引擎/会话工厂是单例，会绑定到首次
创建它的 event loop。pytest-asyncio 的 function 级 loop 会导致后续测试
在旧 loop 上清理 asyncpg 连接，抛 "Event loop is closed"。

下面的 autouse fixture 在每个测试结束后重置并 dispose 引擎单例，
保证每个测试用例的 DB 引擎与自身 event loop 绑定。
"""

from __future__ import annotations

import pytest
import sqlalchemy as sa


@pytest.fixture(autouse=True)
async def _reset_db_engine_singletons():
    """每个测试后 dispose 并清空模块级引擎/会话工厂单例。"""
    # 确保所有模型被导入以注册到 metadata
    import app.models  # noqa: F401
    from app.db.base import Base
    import app.db.session as db_session
    from app.models.share import Share
    from app.models.system import Report
    from app.models.user import User

    def ensure_user_admin_columns(sync_conn):
        inspector = sa.inspect(sync_conn)
        if "users" not in inspector.get_table_names():
            return
        columns = {column["name"] for column in inspector.get_columns("users")}
        if "is_admin" not in columns:
            default = "false" if sync_conn.dialect.name == "postgresql" else "0"
            sync_conn.execute(sa.text(f"ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT {default}"))
        if "disabled_at" not in columns:
            sync_conn.execute(sa.text("ALTER TABLE users ADD COLUMN disabled_at TIMESTAMP WITH TIME ZONE"))
        if "deleted_at" not in columns:
            sync_conn.execute(sa.text("ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE"))

    engine = db_session.get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(ensure_user_admin_columns)

    yield

    async with engine.begin() as conn:
        test_share_ids = sa.select(Share.id).where(Share.title == "__test_admin_report__")
        await conn.execute(sa.delete(Report).where(Report.share_id.in_(test_share_ids)))
        await conn.execute(sa.delete(Share).where(Share.title == "__test_admin_report__"))
        await conn.execute(sa.delete(User).where(User.email.ilike("%@example.com")))

    if db_session._engine is not None:
        await db_session._engine.dispose()
    db_session._engine = None
    db_session._session_factory = None
