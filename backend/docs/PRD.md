# 拿呀呀 · nyy.app — PRD v1.0

> 状态：已确认  
> 最后更新：2026-05-27

## 1. 产品定位

| 项 | 值 |
| --- | --- |
| 品牌名 | 拿呀呀 |
| 域名 | nyy.app |
| Slogan | 想传文件？拿呀呀。 |
| 视觉 | 类奶牛快传，暖橘色主调 + 叠字吉祥物路线 |
| 商业化 | v1 不开收费；v2 启动收费（爱发电赞助 + 手动激活 → Lemon Squeezy → Stripe） |
| 语言 | 中英双语（next-intl，zh-CN 默认） |
| 目标用户 | 临时大文件分享：自由职业、设计师、二手交易、跨平台用户、博客/播客主 |

## 2. 上传体验

- 入口：拖拽 / 粘贴 / 移动端拍照选相册 / CLI / API
- 多文件 / 文件夹拖拽：前端 client-zip 流式打包成单个分享，不落 VPS 盘
- 单文件硬限制：v1 = 1 GiB（实测 TOS 单 PUT 上限），超出友好提示
- v1.5：前端 `File.slice` 切片成 ≤1 GiB 子分片，多 TOS URI 并行直传，下载用 StreamSaver 流式拼接，全程不走 VPS
- 进度 / 速度 / 剩余时间显示
- 断点续传：IndexedDB 缓存进度，刷新页面续传
- 失败重试：单片指数退避，最多 5 次
- 客户端 hash：上传前算 SHA256 用于黑名单快速命中

## 3. 分享与下载

- 短码格式：`https://nyy.app/abc123`，**直接根路径**，6 位 base62 ≈ 568 亿组合
- 系统保留路由：`/api/* /admin/* /auth/* /pricing /terms /privacy /dmca /healthz` 不与 6 位短码冲突
- 提取码：可选，4 位数字，默认关
- 有效期：1h / 1d / 7d / 30d / 长期（"长期"标注"依赖上游存储不保证绝对永久"）
- 下载次数按档位：

| 档位 | 次数上限 |
| --- | --- |
| 1h | 10 |
| 1d | 50 |
| 7d | 200 |
| 30d | 500 |
| 长期 | 1000（注册用户面板可续期） |

- 落地页：标题 / 文件名 / 大小 / 上传时间 / 剩余次数 / 剩余天数 / 提取码校验 / 在线预览 / 下载按钮 / 多文件流式 zip
- 预览：图片 / PDF / 文本 / 视频（HTML5 `<video>` 直吃 CDN，不转码；不支持的格式提示下载）

## 4. 文件生命周期

- 软过期：DB 标记 `expires_at`；过期不再签发 CDN URL，TOS 文件保持不动
- 元信息：PostgreSQL 16
- 不本地缓存文件本体（VPS 仅 100 GB）
- URI 健康巡检：每周抽 100 条 HEAD 请求豆包 CDN，统计失效率，告警阈值 1%

## 5. 用户体系

- 注册：邮箱 + 邮箱验证（Resend）
- 游客：24h 有效期 / 单文件 200 MB / 同时 1 个活跃 / 无历史
- 注册免费：单文件 1 GiB / 30d 上限 / 同时 20 个 / 50 次/日上传
- Pro（v2）：单文件 5 GiB（多分片）/ 长期 / 无限活跃链接 / 200 次/日 / 自定义短码 / 去广告

## 6. 配额（v1）

| 角色 | 上传 | 下载 | 同时活跃链接 |
| --- | --- | --- | --- |
| 游客 | 5 次/日/IP，单文件 ≤200 MB，总量 1 GB/日/IP | 30 次/分/IP | 1 |
| 注册免费 | 50 次/日，单文件 ≤1 GiB，总量 20 GB/日 | 60 次/分/IP | 20 |

## 7. 风控

- SHA256 黑名单：abuse.ch MalwareBazaar 每日 feed + 自维护（举报命中入库）
- Captcha：hCaptcha 免费档
- 链接不可枚举：6 位 base62 + 提取码错误指数退避封禁
- IP 日志：保留 90 天后硬删
- 文件名：上传者可选公开/隐藏，默认公开
- 第三方内容审核 API：v1 不接，靠举报入口；v2 视风险情况评估

## 8. 前端

- 栈：Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui + Framer Motion
- i18n：next-intl
- 关键库：StreamSaver.js（流式下载）/ client-zip（流式打包）/ hCaptcha
- 管理后台：Next.js 自建，路由 `/admin/*`，仅管理员账号可见

## 9. 后端 / 架构

- API 风格：
  - 新 `/api/v1/*` 给 Web 前端（session cookie + CSRF）
  - 旧 `/v1/files` `/v1/images/upload` 仍由 doubao-file-station 提供，作 SDK / OpenAI 兼容层
- 栈：FastAPI + SQLAlchemy 2.0 async + Alembic + Pydantic v2 + Redis 7
- 进程：v1 单进程 FastAPI，Caddy 反代，Next.js 静态导出
- 后台任务：APScheduler 内嵌（v1）→ Celery + Redis（v2 量大后）
  - 每 5 分钟扫描软过期
  - 每天凌晨 pg_dump 备份
  - 每小时清理临时上传缓冲
  - 每周 URI 健康巡检
  - 邮件发送走 Redis queue

## 10. 部署 & 运维

- VPS：Ubuntu 22.04 / 24.04
- Caddy 2 + 自动 Let's Encrypt
- 监控：Prometheus + Grafana + Loki
- 错误追踪：Sentry（自托管或 sentry.io 免费档）
- 备份：
  - PG 是唯一不可替换资产（URI、用户、分享映射、提取码）
  - 每日 pg_dump GPG 加密 → Cloudflare R2
  - 保留：日 7、周 4、月 6
  - 每月 1 次本地恢复演练

## 11. 合规

- 完整版：用户协议 / 隐私政策 / Cookie 政策 / DMCA 投诉
- 起草：Termly 模板 + 人工修订，上线前过律师
- 不在大陆暴露，不备案
- 明确条款：禁止违法 / 版权 / CSAM / 恶意软件 / 营销垃圾；保留 IP 90 天；豆包 TOS 第三方告知；服务可用性免责

## 12. 商业化（v2）

| 档位 | 价格 | 配额 |
| --- | --- | --- |
| 游客 | 0 | 见 §6 |
| 注册免费 | 0 | 见 §6 |
| Pro 月付 | ¥9.9/月 | 单文件 5 GiB / 长期 / 无限活跃 / 200 次/日 / 自定义短码 / 去广告 |
| Pro 年付 | ¥78/年（≈¥6.5/月） | 同上 |
| Pro 永久限量 | ¥198/一次（前 100 名启动期定价） | 同上 + 终身 |

支付通道：v1 爱发电（手动激活）→ v1.5 Lemon Squeezy → v2 注册海外公司接 Stripe。

## 13. 里程碑（一把梭，6–8 周）

- **Week 1 地基（进行中）**：仓库、DB schema、Alembic、FastAPI 骨架、Caddyfile、Next.js 占位、品牌 Logo mock
- **Week 2 上传/下载核心**：`/api/v1/uploads/init` `/commit` 单文件 ≤1 GiB；前端拖拽上传；短链生成；落地页直接 302；提取码
- **Week 3 分享生命周期**：有效期 / 下载次数 / 落地页元信息 / 在线预览 / 视频直播 / client-zip 打包
- **Week 4 用户体系**：邮箱注册 / 验证 / 游客 vs 注册 / 个人面板 / hCaptcha / slowapi 限流
- **Week 5 风控+运维**：abuse.ch hash 黑名单 / 举报入口 / IP 日志 / Prometheus + Grafana + Loki + Sentry / pg_dump / URI 健康巡检
- **Week 6 前端打磨+i18n**：暖橘色品牌视觉收口 / 中英双语 / 移动端 / 管理后台 / 协议文案 / Logo 终稿
- **Week 7 商业化+灰度**：爱发电跳转 + 手动激活 / Pro 配额逻辑 / 自定义短码 / 内测 10–20 人
- **Week 8 v1.5 多分片+上线**：File.slice 切片 / 多 URI 并行直传 / StreamSaver 流式拼接 / 失败续传 IndexedDB / 公开上线 / V2EX、少数派、X、小红书冷启动

### 13.1 版本路线图补充

#### v1.0：分享安全与反馈闭环

- 下载次数限制：分享可设置最大下载次数；达到上限后不再签发下载链接。
- 下载计数规则：以“签发下载链接”为准计数；不等待 CDN 实际下载完成，避免 VPS 中转或依赖对象存储下载日志。
- 多文件计数规则：按分享计数；一次获取该分享的下载链接 / 打包下载链接计 1 次，不按单个文件分别计数。
- 一次性下载：下载次数限制的快捷模式，分享签发 1 次下载链接后立即达到上限。
- 举报按钮：分享落地页提供举报入口，举报只进入 Admin 后台处理，不自动隐藏分享，避免恶意举报误伤。
- 举报频率：同一 IP 对同一分享的重复举报需要限流，具体阈值由实现时按风控配置项落库。

#### v1.1：反向分享 / 文件请求链接

- 仅注册用户可创建“文件请求链接”。
- 外部访客打开请求链接后，可向链接创建者上传文件。
- 请求链接上传的文件只对创建者可见，不生成公开下载分享。
- 配额归属：访客上传到请求链接的文件，占用请求链接创建者的账号配额；访客侧只做 IP 频率限制。
- 访问保护：文件请求链接支持可选 4 位访问码，默认关闭，交互与普通分享提取码保持一致。
- 生命周期：文件请求链接支持设置有效期；过期后不再允许访客上传。
- 适用场景：收素材、收合同、收作业、客户提交资料。

#### v1.2：分发增强

- 邮件发送给收件人：上传完成后可填写收件人邮箱，由系统发送分享链接；单次最多 5 个收件人。
- 发送给自己备份：上传者可选择把分享链接发送到自己的邮箱。
- 邮件状态：记录邮件发送状态，至少包含 pending / sent / failed，便于后台排查。
- 二维码分享：上传成功页和分享页都显示二维码，支持下载为 PNG 图片。

## 14. 数据库 ER

```
users            id, email, password_hash, plan, email_verified_at, created_at
shares           id, code(unique 6 base62), owner_id(nullable for guest),
                 title, password_hash(nullable, argon2),
                 expires_at, max_downloads, download_count,
                 created_at, revoked_at, ip_created_from
share_files      id, share_id, original_name, size, content_type,
                 tos_uri, chunk_index, chunk_total, sha256
download_logs    id, share_id, ip, ua, downloaded_at
ip_quotas        ip, date, upload_count, upload_bytes, primary key (ip, date)
hash_blacklist   sha256, source(abuse.ch / report / manual), added_at
reports          id, share_id, reporter_ip, reason, status, created_at
audit_logs       id, actor_id, action, target, payload(jsonb), created_at
```

## 15. API（v1 核心）

```
POST   /api/v1/uploads/init           申请 TOS upload URL（每片）
POST   /api/v1/uploads/commit         提交分片合并为分享
GET    /api/v1/shares/:code           落地页元信息
POST   /api/v1/shares/:code/verify    校验提取码
GET    /api/v1/shares/:code/download  签发 CDN URL（计数+1）
POST   /api/v1/shares/:code/zip       多文件签发（前端 client-zip）
PATCH  /api/v1/shares/:id             改提取码 / 续期（owner）
DELETE /api/v1/shares/:id             撤销（owner）
POST   /api/v1/shares/:code/report    举报
POST   /api/v1/auth/register
POST   /api/v1/auth/verify-email
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/me
GET    /api/v1/me/shares
GET    /admin/...                     管理后台
GET    /healthz                       健康检查
```
