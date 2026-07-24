"""测试共享 fixture。

修复 event loop 污染：模块级 DB 引擎/会话工厂是单例，会绑定到首次
创建它的 event loop。pytest-asyncio 的 function 级 loop 会导致后续测试
在旧 loop 上清理 asyncpg 连接，抛 "Event loop is closed"。

下面的 autouse fixture 在每个测试结束后重置并 dispose 引擎单例，
保证每个测试用例的 DB 引擎与自身 event loop 绑定。
"""

from __future__ import annotations

import os

import pytest
import sqlalchemy as sa
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateColumn

from app.core.config import get_settings


def _configure_test_database() -> None:
    settings = get_settings()
    if not settings.test_database_url:
        raise RuntimeError("运行测试前必须配置 TEST_DATABASE_URL")
    if not settings.test_database_sync_url:
        raise RuntimeError("运行测试前必须配置 TEST_DATABASE_SYNC_URL")
    database_urls = {
        "TEST_DATABASE_URL": settings.test_database_url,
        "TEST_DATABASE_SYNC_URL": settings.test_database_sync_url,
    }
    for variable_name, database_url in database_urls.items():
        if not database_url:
            continue
        database_name = make_url(database_url).database or ""
        if "test" not in database_name.lower():
            raise RuntimeError(f"{variable_name} 的数据库名必须包含 test")
    os.environ["DATABASE_URL"] = settings.test_database_url
    os.environ["DATABASE_SYNC_URL"] = settings.test_database_sync_url
    get_settings.cache_clear()


_configure_test_database()


@pytest.fixture(autouse=True)
async def _reset_db_engine_singletons():
    """每个测试后 dispose 并清空模块级引擎/会话工厂单例。"""
    # 确保所有模型被导入以注册到 metadata
    import app.db.session as db_session
    import app.models  # noqa: F401
    from app.db.base import Base

    def ensure_user_admin_columns(sync_conn):
        inspector = sa.inspect(sync_conn)
        table_names = set(inspector.get_table_names())
        for table in Base.metadata.sorted_tables:
            if table.name not in table_names:
                continue
            existing_columns = {
                column["name"] for column in inspector.get_columns(table.name)
            }
            for column in table.columns:
                if column.name in existing_columns:
                    continue
                column_sql = str(CreateColumn(column).compile(dialect=sync_conn.dialect))
                sync_conn.execute(
                    sa.text(f'ALTER TABLE "{table.name}" ADD COLUMN {column_sql}')
                )

        inspector = sa.inspect(sync_conn)
        for table in Base.metadata.sorted_tables:
            if table.name not in table_names:
                continue
            existing_indexes = {
                item["name"] for item in inspector.get_indexes(table.name)
            }
            for index in table.indexes:
                if index.name not in existing_indexes:
                    index.create(sync_conn, checkfirst=True)

    engine = db_session.get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(ensure_user_admin_columns)
        table_names = ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
        await conn.execute(sa.text(f"TRUNCATE TABLE {table_names} RESTART IDENTITY CASCADE"))

    yield

    if db_session._engine is not None:
        await db_session._engine.dispose()
    db_session._engine = None
    db_session._session_factory = None
