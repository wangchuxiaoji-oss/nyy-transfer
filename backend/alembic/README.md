# Alembic 迁移

```powershell
# 创建初始迁移（仅首次）
alembic revision --autogenerate -m "init schema"
# 应用
alembic upgrade head
```

注意：`env.py` 走的是同步驱动 `psycopg`（来自 `DATABASE_SYNC_URL`），与运行时的 async 引擎分离；这是 SQLAlchemy 官方推荐的做法。

## 事件分区迁移门禁

`20260721_1800` 会重建并复制 `share_access_events`、`download_logs`，不是在线迁移：

- 空表可直接迁移。
- 非空小表必须先安排维护窗口，再显式设置 `NYY_ALLOW_OFFLINE_PARTITION_MIGRATION=1`。
- 估算超过 10 万行或 512 MiB 时迁移会拒绝执行，必须另行制定双写/回填/切换方案。
- 定时维护只会从 DEFAULT 分区自动搬迁最多 1 万行；超过上限会中止，避免线上长事务。

## Schema 漂移检查

发布前在已升级到 head 的一次性数据库执行 `alembic check`。`env.py` 会排除由迁移和维护任务管理的月度/DEFAULT 物理分区子表，但父表、普通表、约束和索引仍全部参与比较。
