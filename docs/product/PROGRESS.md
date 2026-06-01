# 拿呀呀 · nyy.app — 开发进展

> 最后更新：2026-05-26

## 项目概述

将豆包 TOS 文件中转能力包装成奶牛快传复刻版，域名 `nyy.app`，中文名「拿呀呀」。
核心理念：文件本体存豆包 TOS，VPS 只存元信息，浏览器直传 CDN。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | FastAPI + SQLAlchemy 2.0 async + Alembic + Pydantic v2 + Redis 7 + asyncpg |
| 前端 | Next.js 14 + TypeScript + Tailwind CSS + Framer Motion + crc-32 + client-zip + lucide-react |
| 数据库 | PostgreSQL 16 (Docker) |
| 缓存 | Redis 7 (Docker) |
| 邮件 | Postfix 3.8.6 (send-only) + OpenDKIM 2048-bit |
| 部署目标 | Ubuntu 24.04 VPS + Caddy 2 |
| 包管理 | pip (后端) / npm (前端，非 pnpm，因 exFAT 限制) |

## 已完成功能

### 后端 (backend/app/)

#### 核心服务
- **doubao_client.py** — httpx 封装豆包 TOS：prepare → apply → commit + get_download_url + AWS SigV4 内联签名
- **quota.py** — Redis 滑动窗口 IP 配额（200MB/24h，key: `nyy:quota:ip:{ip}:bytes`）
- **hash_blacklist.py** — Redis Set 黑名单框架（is_blocked/add/remove/count），预留 abuse.ch 对接

#### API 端点
- `POST /api/v1/uploads/init` — 单文件初始化（调豆包 prepare），返回 upload_url + commit_token
- `POST /api/v1/uploads/commit` — 多文件提交（`files[]` 数组），创建 1 个 Share + N 个 ShareFile
- `GET /api/v1/uploads/quota` — 查询当前 IP 剩余配额
- `GET /api/v1/shares/:code` — 分享信息（文件列表 + total_bytes）
- `POST /api/v1/shares/:code/verify` — 密码验证，返回所有文件下载 URL
- `GET /api/v1/shares/:code/download` — 无密码时返回所有文件 URL，下载计数+1

#### 数据库
- 8 张业务表：users / shares / share_files / download_logs / ip_quotas / hash_blacklist / reports / audit_logs
- Alembic 迁移已就绪

#### 配置系统 (config.py)
- `guest_max_active_shares=1` — 游客最大活跃分享数
- `guest_max_files_per_share=10` — 游客单次最大文件数
- `user_max_active_shares=20` — 注册用户最大活跃分享数
- `user_max_files_per_share=50` — 注册用户单次最大文件数
- `upload_max_retries=3` — 上传重试次数
- 所有限制项为配置化，留给将来 admin 管理后台

### 前端 (frontend/)

#### 上传组件 (file-uploader.tsx)
- 多文件选择 + 文件夹拖拽/选择（webkitGetAsEntry 递归遍历）
- 3 并发上传队列
- 每文件独立进度条
- 失败自动重试（最多 3 次，指数退避）
- 过滤 size=0 文件
- 客户端 CRC32 校验（流式 4MB chunks）

#### 分享页 ([code]/page.tsx)
- 多文件列表展示
- 单文件独立下载按钮
- client-zip 流式打包下载全部
- 密码验证流程
- 视频预览（HTML5 `<video>` 直吃 CDN）
- 过期/不存在状态页

#### API Client (lib/api.ts)
- uploadCommit 接收 `files[]`
- getShareInfo / verifyShare / downloadShare
- Pydantic 422 错误正确解析显示

#### 构建产物
- 首页：7.21kB / 138kB First Load
- 分享页：3.5kB / 135kB First Load

### 测试

- **e2e 测试 15 项全部通过** (tests/e2e_full.py)：
  quota → init → TOS upload → commit → share info → download → active limit 429 → revoke → multi-file+password → verify wrong/correct → frontend pages
- **单元测试 11 项全部通过** (tests/test_uploads.py)：
  commit 测试已更新为 `files[]` 格式，含 `_raise_share_limit` fixture
- **UI 视觉验证通过**：浏览器实际访问首页/分享页/404页/密码错误/密码正确+下载，零 JS 错误

### 自建邮件系统 (VPS: 103.237.92.203)

#### 已完成
- Postfix 3.8.6 (send-only) 安装并 active + enabled
- OpenDKIM 2048-bit 签名配置完成，socket 权限已修复
- DNS 记录全部生效：
  - `mail.nyy.app` A → 103.237.92.203
  - `nyy.app` MX 10 → mail.nyy.app
  - `nyy.app` TXT → `v=spf1 ip4:103.237.92.203 -all`
  - `mail.nyy.app` TXT → `v=spf1 ip4:103.237.92.203 -all`（HELO SPF）
  - `default._domainkey.nyy.app` TXT → DKIM 2048-bit 公钥
  - `_dmarc.nyy.app` TXT → `v=DMARC1; p=quarantine; adkim=s; aspf=s; pct=100`
- mail-tester.com 评分：**8.8/10**
- 认证结果：SPF PASS / DKIM PASS / DMARC PASS
- 黑名单检查：23 个主流 IPv4 黑名单全部未列入（含 Spamhaus）
- 25 端口出站畅通
- 实测投递：QQ 邮箱收件箱 ✅ / Gmail 投递成功（进垃圾箱，因 PTR 缺失）

#### 待修复
- PTR 记录需菠萝云客服设置：`103.237.92.203 → mail.nyy.app`（Gmail 进垃圾箱的决定性因素）

## 关键技术决策

| 决策 | 原因 |
|------|------|
| 浏览器直传豆包 TOS | TOS 返回 `Access-Control-Allow-Origin: *`，无需 VPS 中继 |
| 游客配额用 IP 维度 | Redis key `nyy:quota:ip:{ip}:bytes`，24h TTL；注册体系上线后切 user_id |
| 前端开发在 D 盘 | E 盘 exFAT 不支持 symlinks，node_modules 必须在 NTFS |
| npm 替代 pnpm | pnpm 在 exFAT 有问题 |
| commit_token 存 Redis | 30min TTL，commit 时验证+一次性删除，防重放 |
| commit 改为多文件 | 前端 N 次 init → 一次 commit（`files[]`），创建 1 Share + N ShareFile |
| 邮件自建而非 Resend | 验证 IP 纯净度，Postfix send-only + OpenDKIM |
| 单文件硬限 1 GiB | 实测 TOS 单 PUT：512MB 稳 / 1GB 20/20 成功 / 2GB 0/20 全 503 |
| 6 位 base62 短码 | ≈ 568 亿组合，根路径直接访问（不带 /s/） |
| 不用 next build 验证 dev | 会污染 .next 缓存导致 dev server 500 |

## 基础设施

| 组件 | 详情 |
|------|------|
| VPS | 菠萝云，IP 103.237.92.203，Ubuntu 24.04，上行 20 Mbps |
| Docker | Docker Desktop 安装在 D:\Docker (NTFS) |
| PostgreSQL | nyy-postgres-dev 容器，端口 5432 |
| Redis | nyy-redis-dev 容器，端口 6379 |
| Python | 3.11.15，venv 在 backend/.venv |
| 域名 | nyy.app (GoDaddy)，NS: ns49.domaincontrol.com |

## 商业化规划（v1 不开收费）

| 档位 | 容量 | 有效期 | 活跃分享数 |
|------|------|--------|-----------|
| 游客 | 200 MB/24h | 1 个文件 | 1 个 (IP 维度) |
| 注册免费 | 1 GiB/30d | 20 个文件 | 20 个 |
| Pro | ¥9.9 月 / ¥78 年 / ¥198 永久限量 | — | — |

## 当前阻塞项

1. **PTR 记录** — 需联系菠萝云客服将 `103.237.92.203` 反向解析设为 `mail.nyy.app`（当前值 `SER6516945.local.`）
2. **认证方案未定** — Magic Link（推荐）vs 邮箱+密码，待确认

## 下一步计划

1. ~~CORS spike~~ ✅
2. ~~Docker + DB schema~~ ✅
3. ~~上传/分享 API~~ ✅
4. ~~前端上传+分享页~~ ✅
5. ~~e2e 测试~~ ✅
6. ~~自建邮件系统~~ ✅ (PTR 待设)
7. **确定认证方案并实现注册/登录**
8. 用户配额升级（登录后从 IP 切到 user_id 维度）
9. "我的分享"列表页（查看/管理/撤销）
10. Admin 管理后台（配置限制项、黑名单管理）
11. 生产部署（Caddy + systemd + Sentry）
12. 国际化（next-intl，zh-CN 默认）

## 文件索引

```
backend/
├── app/
│   ├── api/v1/uploads.py        上传 API（init/commit/quota）
│   ├── api/v1/shares.py         分享 API（info/verify/download）
│   ├── core/config.py           可配置限制项
│   ├── models/                  ORM 模型（8 张表）
│   ├── schemas/upload.py        CommitFileItem + UploadCommitRequest
│   ├── schemas/share.py         ShareFileDownload + ShareDownloadResponse
│   ├── services/doubao_client.py  豆包 TOS 客户端 + AWS SigV4
│   ├── services/quota.py        Redis IP 配额
│   ├── services/hash_blacklist.py Redis 黑名单
│   └── main.py                  lifespan 管理 Redis + doubao client
├── tests/
│   ├── e2e_full.py              15 项 e2e 测试
│   └── test_uploads.py          11 项单元测试
└── ...

docs/                            项目文档（已按主题分类，集中在仓库顶层）
├── product/                     PRD.md、PROGRESS.md（本文件）
├── spikes/                      技术可行性验证报告（CORS / multipart / 视频处理）
├── upload/                      上传与 HLS 实施指南、迁移方案
├── player/                      SDP 自研播放器设计与媒体播放文档
├── ui/                          UI 与移动端方案、字体审计
└── brand/                       品牌指南与 logo 资源

frontend/                        前端开发目录（Next.js）
├── src/components/file-uploader.tsx  多文件上传组件
├── src/app/[code]/page.tsx      分享页
├── src/lib/api.ts               API client
└── src/lib/crc32.ts             流式 CRC32
```
