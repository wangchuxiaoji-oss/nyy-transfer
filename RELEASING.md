# 发布流程

`v1.0.0` 是正式版本基线，后续版本统一遵循语义化版本 `主版本.次版本.修订号`：

- 主版本：包含不兼容的接口、数据或产品行为变更。
- 次版本：新增向后兼容的产品能力。
- 修订号：向后兼容的问题修复和安全更新。

## 版本来源

根目录 `VERSION` 是产品版本基准。以下文件必须与其保持一致：

- `backend/app/__init__.py`
- `backend/pyproject.toml`
- `frontend/package.json`
- `frontend/package-lock.json`

数据库迁移版本和配额策略版本独立递增，不复用产品版本号。

## 迭代规则

1. 日常改动记录在 `CHANGELOG.md` 的 `Unreleased` 下。
2. 发布时确定下一个语义化版本，并同步所有版本文件。
3. 运行 `python3 scripts/check-version.py`、后端测试和前端检查。
4. 将 `Unreleased` 内容归入带日期的正式版本。
5. 创建发布提交 `chore: 发布 vX.Y.Z`。
6. 在发布提交上创建带说明的标签 `git tag -a vX.Y.Z -m "发布 vX.Y.Z"`。
7. 推送提交和标签后再执行生产部署，已发布标签不得移动或复用。
