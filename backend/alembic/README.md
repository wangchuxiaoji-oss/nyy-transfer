# Alembic 迁移

```powershell
# 创建初始迁移（仅首次）
alembic revision --autogenerate -m "init schema"
# 应用
alembic upgrade head
```

注意：`env.py` 走的是同步驱动 `psycopg`（来自 `DATABASE_SYNC_URL`），与运行时的 async 引擎分离；这是 SQLAlchemy 官方推荐的做法。
