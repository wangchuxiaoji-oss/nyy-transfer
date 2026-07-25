"""Admin API 包：按运营域拆分的路由集合。

模块划分：
- stats：总览统计
- shares：分享列表/详情/预览/封禁/批量操作
- users：用户管理
- reports：举报处理队列
- emails：邮件处理队列
- config：配额与下载行为配置
- audit：管理员操作审计查询
- archive：终态分享归档
- doubao：豆包 Session 与扫码流程
- sources：IP 来源与关联调查
"""

from fastapi import APIRouter

from app.api.v1.admin import (
    announcements,
    archive,
    audit,
    config,
    doubao,
    emails,
    mailbox,
    reports,
    shares,
    sources,
    stats,
    users,
)

router = APIRouter(prefix="/admin", tags=["admin"])
router.include_router(stats.router)
router.include_router(announcements.router)
router.include_router(shares.router)
router.include_router(users.router)
router.include_router(reports.router)
router.include_router(emails.router)
router.include_router(mailbox.router)
router.include_router(config.router)
router.include_router(audit.router)
router.include_router(archive.router)
router.include_router(doubao.router)
router.include_router(sources.router, tags=["admin-sources"])

__all__ = ["router"]
