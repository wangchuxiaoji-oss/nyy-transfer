# 拿呀呀 · nyy.app

> 想传文件？拿呀呀。
>
> `nyy.app` 是一个轻量文件中转站，产品体验参考奶牛快传，品牌名「拿呀呀」。文件本体直传豆包 TOS / 火山 CDN，VPS 只保存元信息、分享关系、权限与审计数据。

## 1. 项目状态

当前状态：v1 核心功能已基本完成，UI 体验打磨接近尾声，管理后台功能完善中。

最近重点：

- 首页 slogan 改为"文件中转，就用 [logo-sm]"，Logo 重建为纯矢量 + CSS drop-shadow glow。
- Tab 切换动画优化为 translateX GPU 合成，消除 Chrome layout 重排丢帧。
- 分享设置面板重设计：有效期/下载上限改为按钮组，直接展开不隐藏。
- 游客锁定机制：受限选项视觉变淡 + 右上角小锁图标，点击弹登录弹窗。
- 邮件通知功能已移除，仅保留注册验证码和重置密码邮件。
- 管理后台新增"豆包"tab：session 状态展示 + QR 扫码登录刷新 session。

已知未完成 / 待继续：

- 生产部署未完成。
- 邮件系统 PTR 反向解析仍需 VPS 服务商配置。
- 字体字号尚未系统性重构为语义组件，只完成审计和局部修正。
- 部分 PRD 高级能力仍未实现：断点续传、分片拼接、i18n、Captcha、Sentry/监控、Pro 商业化。
- 游客旧分享如果没有 `revoke_token`，前端只能提示等待过期，无法自助删除。

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 后端 | FastAPI, SQLAlchemy 2.0 async, Alembic, Pydantic v2, asyncpg |
| 前端 | Next.js 14 App Router, React 18, TypeScript, Tailwind CSS, Framer Motion |
| 数据库 | PostgreSQL 16 |
| 缓存 | Redis 7 |
| 文件存储 | 豆包 TOS / 火山 CDN，浏览器直传 |
| 邮件 | Postfix send-only + OpenDKIM |
| 打包下载 | `client-zip` 浏览器端流式打包 |
| 二维码 | `qrcode` |
| 图标 | `lucide-react` |

## 3. 本地目录

本项目当前分成两个实际开发目录：

| 路径 | 说明 |
|---|---|
| `E:\dev\nyy` | 后端主仓库，包含 FastAPI、Alembic、测试、主 README |
| `D:\nyy-frontend` | 前端开发目录，放在 NTFS 盘，避免 `node_modules` 在 exFAT 上出问题 |

重要背景：E 盘为 exFAT，`node_modules` / symlink 支持不稳定，因此前端实际开发放在 D 盘。

## 4. 快速启动

### 4.1 启动 Postgres / Redis

```powershell
cd E:\dev\nyy
docker compose -f docker-compose.dev.yml up -d
```

默认端口：

- PostgreSQL: `127.0.0.1:5432`
- Redis: `127.0.0.1:6379`

### 4.2 启动后端

```powershell
cd E:\dev\nyy
.\.venv\Scripts\Activate.ps1
alembic upgrade head
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

健康检查：

```text
GET http://127.0.0.1:8000/healthz
GET http://127.0.0.1:8000/api/v1/healthz
GET http://127.0.0.1:8000/api/docs
```

### 4.3 启动前端

```powershell
cd D:\nyy-frontend
npm install
npm run dev
```

访问地址：

- 本机：`http://127.0.0.1:3000`
- 局域网：`http://192.168.68.102:3000`

后端开发 CORS 已允许：

- `http://localhost:3000`
- `http://127.0.0.1:3000`
- `http://192.168.68.102:3000`

### 4.4 常用测试 / 检查

后端：

```powershell
cd E:\dev\nyy
.\.venv\Scripts\python.exe -m pytest
```

前端类型检查：

```powershell
cd D:\nyy-frontend
npx tsc --noEmit
```

注意：当前开发中优先用 `npx tsc --noEmit` 验证前端类型，不建议频繁用 `next build` 验证 dev 状态，因为曾出现 `.next` dev 缓存污染导致 500。

## 5. 环境变量

后端参考：`E:\dev\nyy\.env.example`

关键变量：

| 变量 | 默认 / 示例 | 说明 |
|---|---|---|
| `APP_ENV` | `dev` | dev 时启用 docs 和 CORS |
| `APP_BASE_URL` | `http://127.0.0.1:3000` | 分享 URL 前缀，开发中建议指向前端 |
| `DATABASE_URL` | `postgresql+asyncpg://nyy:nyy@127.0.0.1:5432/nyy` | 后端异步 DB |
| `DATABASE_SYNC_URL` | `postgresql+psycopg://nyy:nyy@127.0.0.1:5432/nyy` | Alembic 同步 DB |
| `REDIS_URL` | `redis://127.0.0.1:6379/0` | Redis |
| `SECRET_KEY` | 至少 32 字节 | 应用密钥 |
| `JWT_SECRET` | 至少 32 字节 | JWT 密钥 |
| `DOUBAO_SESSION_FILE` | `E:\dev\DoubaoChatAPI\.doubao_session.json` | 豆包会话文件 |
| `SMTP_HOST` | `127.0.0.1` | 邮件发送 SMTP |
| `EMAIL_FROM` | `noreply@nyy.app` | 邮件发件人 |

前端关键变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://127.0.0.1:8000` | 前端请求后端 API base |

## 6. 完整功能清单

### 6.1 首页 / 上传

文件：`D:\nyy-frontend\src\app\page.tsx`、`D:\nyy-frontend\src\components\file-uploader.tsx`

能力：

- 文件选择、文件夹选择、拖拽上传。
- 递归读取文件夹（浏览器支持范围内）。
- 多文件上传，最多按后端游客 / 用户规则限制。
- 单文件大小限制，前端默认 1 GiB，后端游客也按配置限制。
- 过滤空文件。
- 客户端 CRC32 计算。
- 3 并发上传队列。
- 单文件失败自动重试，最多 3 次。
- 每文件状态：pending / hashing / uploading / done / error。
- 上传前文件清单超过 5 个截断，支持查看全部 / 收起。
- 可选提取码：4 位数字。
- 可选有效期：1 小时、6 小时、1 天、3 天、7 天（默认）、15 天。游客锁定为 1 小时。
- 可选下载上限：1、5、10、50、100、不限（默认）。游客锁定为 10 次。
- 游客受限选项点击弹出登录弹窗。
- 上传完成后展示分享链接、二维码、文件清单、复制按钮、继续上传。
- 上传完成勾勾动效：SVG 笔画动效后，单一勾勾元素缩放移动到结果卡片标题位置。
- 浏览器剪贴板兼容：HTTPS / localhost 走 Clipboard API，HTTP LAN 回退到 `document.execCommand("copy")`。

### 6.2 游客分享管理

文件：`D:\nyy-frontend\src\app\page.tsx`、`D:\nyy-frontend\src\components\share-detail-modal.tsx`、`E:\dev\nyy\app\api\v1\shares.py`

能力：

- 首页底部展示当前 IP 的游客活跃分享。
- 后端接口：`GET /api/v1/shares/guest-mine`。
- 列表显示 URL、倒计时、查看、删除。
- 查看使用 Modal，不跳转新标签。
- Modal 展示文件名、大小、下载次数、剩余时间、删除按钮。
- 删除使用 revoke token：`DELETE /api/v1/shares/{code}/guest-revoke`。
- 新分享上传成功后会把 `code/url/revokeToken` 写入 localStorage。
- 旧分享若无 revoke token，前端提示无法删除，只能等待过期。

关键注意：`guest-mine` 必须注册在 `/{code}` 路由之前，否则 FastAPI 会把 `guest-mine` 当成短码。

### 6.3 分享落地页 / 下载

文件：`D:\nyy-frontend\src\app\[code]\page.tsx`、`E:\dev\nyy\app\api\v1\shares.py`

能力：

- 根路径短码访问：`/{code}`。
- 展示文件列表、总大小、下载次数。
- 单文件独立下载。
- 多文件获取全部下载 URL 后可打包下载 ZIP。
- 有密码分享需要提取码验证。
- 无密码分享直接获取下载链接。
- 分享不存在、过期、达到下载次数上限时展示状态页。
- 支持举报分享。
- 支持视频预览（HTML5 video 直连 CDN）。
- `client-zip` 打包下载使用已 resolve 的 `Response` 对象，不能传 `Promise<Response>`。

### 6.4 文件请求 / 收文件

文件：`D:\nyy-frontend\src\components\file-request-creator.tsx`、`D:\nyy-frontend\src\app\r\[code]\page.tsx`、`E:\dev\nyy\app\api\v1\file_requests.py`

能力：

- 注册用户创建文件请求链接。
- 请求链接可设置标题、访问码、过期时间、最大文件数、最大字节数。
- 访客打开 `/r/{code}` 上传文件给请求创建者。
- 请求链接上传文件不生成公开分享，只进入创建者工作台。
- 创建者可在我的工作台查看收到的文件并获取下载 URL。

### 6.5 用户体系 / 我的工作台

文件：`E:\dev\nyy\app\api\v1\auth.py`、`D:\nyy-frontend\src\components\auth-modal.tsx`、`D:\nyy-frontend\src\app\my\page.tsx`

能力：

- 邮箱验证码发送。
- 注册、邮箱验证、登录、刷新 token、重置密码。
- 前端 Auth Modal 支持登录 / 注册。
- 登录后首页显示用户邮箱和我的工作台入口。
- 我的工作台包含分享管理、文件请求、收到文件等。
- 注册用户分享可通过 owner 权限管理，不依赖游客 revoke token。

### 6.6 管理后台

文件：`E:\dev\nyy\app\api\v1\admin.py`、`D:\nyy-frontend\src\app\nyy-console\page.tsx`

能力：

- 管理员登录后进入运营后台。
- 统计面板：分享、用户、举报、邮件等概览。
- 分享列表：查看、封禁、解封。
- 用户列表。
- 举报列表。
- 邮件发送记录。
- 配额配置读取与保存。
- 豆包 Session 管理：查看 session 状态（有效/过期、sessionid 前缀、上次刷新时间、已过时长）。
- 豆包 QR 扫码登录：在后台发起扫码流程，前端展示二维码，轮询状态（等待扫码→已扫码待确认→成功/过期/错误），成功后自动保存 session 并重载 TOS 客户端。

开发账号：

- Admin: `admin@nyy.app` / `88888888`
- Test: `test@nyy.app` / `88888888`

### 6.7 邮件

文件：`E:\dev\nyy\app\services\email.py`

能力：

- 注册验证码邮件发送。
- 重置密码邮件发送。
- VPS 邮件系统已配置 Postfix + OpenDKIM。
- 分享通知邮件功能已移除（仅保留验证码和重置密码）。

运维状态：

- SPF / DKIM / DMARC 已配置。
- mail-tester 评分曾达到 8.8/10。
- QQ 邮箱可进入收件箱。
- Gmail 仍可能进垃圾箱，主要原因是 PTR 反向解析未设置。

## 7. API 索引

健康：

- `GET /healthz`
- `GET /readyz`
- `GET /api/v1/healthz`
- `GET /api/v1/readyz`

上传：

- `GET /api/v1/uploads/quota`
- `POST /api/v1/uploads/init`
- `POST /api/v1/uploads/commit`

分享：

- `GET /api/v1/shares/guest-mine`
- `GET /api/v1/shares/{code}`
- `POST /api/v1/shares/{code}/verify`
- `GET /api/v1/shares/{code}/download`
- `POST /api/v1/shares/{code}/report`
- `DELETE /api/v1/shares/{code}/guest-revoke`

认证：

- `POST /api/v1/auth/send-code`
- `POST /api/v1/auth/register`
- `POST /api/v1/auth/verify-email`
- `POST /api/v1/auth/login`
- `POST /api/v1/auth/refresh`
- `POST /api/v1/auth/reset-password`
- `GET /api/v1/auth/me`

我的分享：

- `GET /api/v1/my/shares`
- `DELETE /api/v1/my/shares/{code}`
- `PATCH /api/v1/my/shares/{code}`

文件请求：

- `POST /api/v1/file-requests`
- `GET /api/v1/file-requests/{code}`
- `POST /api/v1/file-requests/{code}/verify`
- `POST /api/v1/file-requests/{code}/commit`
- `GET /api/v1/file-requests/my/list`
- `GET /api/v1/file-requests/my/files`
- `GET /api/v1/file-requests/my/files/{file_id}/download`

后台：

- `GET /api/v1/admin/stats`
- `GET /api/v1/admin/reports`
- `GET /api/v1/admin/emails`
- `GET /api/v1/admin/users`
- `GET /api/v1/admin/shares`
- `GET /api/v1/admin/config/quota`
- `PUT /api/v1/admin/config/quota`
- `POST /api/v1/admin/shares/{code}/ban`
- `DELETE /api/v1/admin/shares/{code}/ban`
- `GET /api/v1/admin/doubao/session-status`
- `POST /api/v1/admin/doubao/qr-start`
- `GET /api/v1/admin/doubao/qr-status`
- `POST /api/v1/admin/doubao/qr-cancel`

## 8. 数据模型

主要表：

- `users`：用户、邮箱、密码哈希、plan、验证时间、登录时间。
- `shares`：分享短码、owner、提取码哈希、过期时间、最大下载次数、下载计数、撤销 / 封禁、创建 IP、revoke token、总字节数。
- `share_files`：分享下的文件，记录原始文件名、大小、content type、TOS URI、hash、chunk 信息。
- `download_logs`：下载日志，预留审计 / 风控。
- `ip_quotas`：IP 日上传配额记录。
- `hash_blacklist`：SHA256 黑名单。
- `app_configs`：后台可持久化配置。
- `reports`：举报记录。
- `file_requests`：反向收文件请求。
- `file_request_files`：文件请求收到的文件。
- `email_deliveries`：邮件发送记录。
- `audit_logs`：审计日志。

迁移文件：

- `alembic/versions/20260526_1709_45e930d4e7dc_init_schema.py`
- `alembic/versions/20260527_1200_admin_console.py`
- `alembic/versions/20260527_1300_roadmap_features.py`
- `alembic/versions/20260528_1000_add_revoke_token.py`

## 9. 关键文件清单

后端：

| 路径 | 说明 |
|---|---|
| `app/main.py` | FastAPI 应用入口、CORS、lifespan |
| `app/core/config.py` | pydantic-settings 配置中心 |
| `app/core/deps.py` | 认证 / DB 依赖 |
| `app/core/logging.py` | 日志配置 |
| `app/db/base.py` | SQLAlchemy Base / TimestampMixin |
| `app/db/session.py` | async session factory |
| `app/models/share.py` | Share / ShareFile / DownloadLog |
| `app/models/user.py` | User / UserPlan |
| `app/models/system.py` | 配额、黑名单、配置、举报、文件请求、邮件、审计 |
| `app/api/v1/__init__.py` | v1 路由聚合 |
| `app/api/v1/health.py` | 健康检查 |
| `app/api/v1/uploads.py` | 上传 init / commit / quota |
| `app/api/v1/shares.py` | 分享详情、验证、下载、举报、游客管理 |
| `app/api/v1/auth.py` | 邮箱验证码、注册、登录、刷新、重置、me |
| `app/api/v1/my_shares.py` | 登录用户分享管理 |
| `app/api/v1/file_requests.py` | 文件请求 / 收文件 |
| `app/api/v1/admin.py` | 管理后台 API |
| `app/schemas/*.py` | Pydantic 请求 / 响应模型 |
| `app/services/doubao_client.py` | 豆包 TOS 客户端，prepare/apply/commit/download URL |
| `app/services/quota.py` | 配额服务 |
| `app/services/email.py` | 邮件发送 |
| `app/services/app_config.py` | 后台配置服务 |
| `app/services/auth.py` | 密码、验证码、JWT 相关服务 |
| `app/services/hash_blacklist.py` | Hash 黑名单 |
| `app/utils/security.py` | 密码 / secret 工具 |
| `app/utils/short_code.py` | 短码生成 |
| `doubao_login/qr_login.py` | 豆包 QR 扫码登录核心逻辑（纯 stdlib，threading 模型） |
| `doubao_login/run.py` | QR 登录 CLI 入口（独立运行或被 admin API 调用） |
| `.doubao_session.json` | 豆包 session 文件（cookies + sessionid + device params） |
| `tests/` | pytest 单元和 e2e 测试 |
| `docker-compose.dev.yml` | 本地 Postgres / Redis |
| `.env.example` | 环境变量模板 |

前端：

| 路径 | 说明 |
|---|---|
| `src/app/layout.tsx` | RootLayout、字体、主题、ToastProvider |
| `src/app/globals.css` | 全局 CSS、主题变量、按钮、玻璃卡片、背景纹理 |
| `src/app/page.tsx` | 首页，上传 / 收文件选项卡，游客分享管理 |
| `src/app/[code]/page.tsx` | 分享落地页 / 下载页 |
| `src/app/r/[code]/page.tsx` | 文件请求访客上传页 |
| `src/app/my/page.tsx` | 我的工作台 |
| `src/app/nyy-console/page.tsx` | 管理后台 |
| `src/components/file-uploader.tsx` | 核心上传组件 |
| `src/components/file-request-creator.tsx` | 文件请求创建组件 |
| `src/components/auth-modal.tsx` | 登录 / 注册 Modal |
| `src/components/share-detail-modal.tsx` | 游客分享详情 Modal |
| `src/components/brand-logo.tsx` | 品牌 Logo |
| `src/components/theme-toggle.tsx` | 暗色模式切换 |
| `src/components/theme-provider.tsx` | 主题持久化 |
| `src/components/toast-provider.tsx` | Toast |
| `src/components/confirm-dialog.tsx` | 确认弹窗 |
| `src/components/pagination.tsx` | 分页 |
| `src/components/empty-state.tsx` | 空状态 |
| `src/components/skeleton.tsx` | 骨架屏 |
| `src/lib/api.ts` | Web API Client |
| `src/lib/auth.ts` | JWT token / 用户信息 |
| `src/lib/admin.ts` | Admin API Client |
| `src/lib/errors.ts` | HTTP / Pydantic 错误解析 |
| `src/lib/crc32.ts` | 浏览器端 CRC32 |
| `src/lib/url-state.ts` | URL 状态工具 |
| `src/lib/utils.ts` | `cn` 等工具 |
| `public/patterns/bg.svg` | 静态背景纹理 |
| `docs/TYPOGRAPHY_AUDIT.md` | 前端字体字号审计 |

## 10. UI / 设计系统现状

品牌：

- 中文名：拿呀呀
- 域名：`nyy.app`
- 主色：暖橘 `#FF8A3D`
- 主要行动色：`action` token，深橘 `#bc4f14`
- 风格：暖橘、玻璃卡片、轻拟物阴影、静态 SVG 背景纹理。

当前实现：

- 暗色模式已完成。
- 背景纹理使用静态 SVG，避免 WebGL / 运行时 pattern 性能损耗。
- `.glass-card` 使用伪元素 + blurred pattern 模拟液态玻璃，避免单纯 `backdrop-filter` 在纯色背景下无效果。
- 首页主卡片使用固定 `pt-[92px]`，避免 tab 高度变化导致页面跳动。
- 全局隐藏浏览器垂直滚动条，但页面仍可滚动。

## 11. 字体 / 字号审计结论

详见前端文档：`D:\nyy-frontend\docs\TYPOGRAPHY_AUDIT.md`

当前统计：

- `text-xs`: 107 次
- `text-sm`: 106 次
- `text-lg`: 11 次
- `text-xl`: 3 次
- `text-2xl`: 2 次
- `text-[10px]`: 1 次

判断：字号系统偏小且过度依赖 `text-xs` / `text-sm`，文件名、URL、主要正文等可读信息应提升到 `text-base` 或至少 `text-sm`。

推荐语义层级：

| 语义 | Tailwind | 用途 |
|---|---|---|
| display | `text-2xl sm:text-3xl font-semibold` | 页面大标题 |
| title | `text-xl font-semibold` | 页面标题 / Modal 标题 |
| section | `text-lg font-semibold` | 卡片标题 |
| body | `text-base` | 文件名、URL、主要正文 |
| body-sm | `text-sm` | 次级正文、按钮、表格正文 |
| caption | `text-xs` | 时间、大小、辅助状态 |

推荐下一步：在 `globals.css` 增加 `.type-title`、`.type-body`、`.type-caption` 等语义类，逐步替换散落原子字号。

## 12. 重要实现细节与坑

### 12.1 `crypto.randomUUID()`

非 HTTPS / LAN IP 场景下 `crypto.randomUUID()` 可能不可用。前端上传组件已改为：

```ts
Math.random().toString(36).slice(2) + Date.now().toString(36)
```

### 12.2 Clipboard API

`navigator.clipboard.writeText` 只在 secure context（HTTPS / localhost）稳定可用。LAN IP HTTP 下需要 fallback：

```ts
if (window.isSecureContext && navigator.clipboard?.writeText) {
  navigator.clipboard.writeText(text);
} else {
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(0, text.length);
  document.execCommand("copy");
  document.body.removeChild(ta);
}
```

### 12.3 FastAPI 路由顺序

静态路由必须放在动态路由之前。例如：

```py
@router.get("/guest-mine")
...

@router.get("/{code}")
...
```

否则 `/guest-mine` 会被当作 `{code}`。

### 12.4 PostgreSQL INET 比较

`ip_created_from` 是 `INET` 类型，不能直接与字符串比较，需要 cast：

```py
Share.ip_created_from == cast(ip, INET)
```

### 12.5 `client-zip`

`downloadZip` 需要 resolved `Response`，不要传 `Promise<Response>`：

```ts
const responses = await Promise.all(files.map(async (f) => ({
  name: f.file_name,
  input: await fetch(f.download_url),
})));
const blob = await downloadZip(responses).blob();
```

### 12.6 上传完成勾勾动效

为避免拼接跳动，当前实现只保留一个勾勾 DOM 元素：

- Check 阶段：`top: 51px; left: 50%; transform: translateX(-50%); width: 48; height: 48`
- Card 阶段：`top: 21px; left: 20px; transform: translateX(0); width: 18; height: 18`
- CSS transition 处理 `top,left,width,height,transform`。

不要改回 `layoutId` / `layout` 方案。此前已验证在该场景下容易产生跳动或看起来像两段拼接。

## 13. 开发进度

已完成：

- 后端基础架构、配置、DB、迁移。
- 上传 / 提交 / 分享 / 下载核心闭环。
- 多文件上传、文件夹上传、失败重试、CRC32。
- 分享落地页、多文件列表、单文件下载、ZIP 打包下载。
- 提取码、过期时间、最大下载次数。
- 游客活跃分享限制、游客删除分享。
- 用户注册 / 登录 / JWT / 我的工作台。
- 文件请求链接。
- 邮件发送（仅验证码和重置密码）。
- Admin 控制台。
- 暗色模式。
- QR 码分享。
- 基础 UI 打磨和上传完成动效。
- 首页 slogan、Logo 优化（纯矢量 + CSS drop-shadow glow）。
- Tab 切换动画优化（translateX GPU 合成）。
- 分享设置面板重设计（按钮组代替 select）。
- 游客锁定机制（视觉变淡 + 小锁图标 + 点击弹登录弹窗）。
- 豆包 Session 管理集成到管理后台（session 状态展示 + QR 扫码登录）。

进行中：

- 前端字号 / 字体系统整理。
- README / 文档体系补全。

待开发：

- 生产部署和 systemd / Caddy 最终化。
- PTR 反向解析。
- Sentry / Prometheus / Grafana / Loki。
- i18n。
- Captcha。
- Abuse hash feed 自动同步。
- 分片上传 / 超大文件拼接 / 断点续传。
- Pro 商业化能力。
- 法务页面：terms / privacy / dmca。

## 14. 生产部署目标

目标：

- Ubuntu 24.04 VPS。
- Caddy 2 反向代理 + 自动 HTTPS。
- FastAPI 后端 systemd service。
- Next.js 前端可使用 Node server 或静态策略，待最终部署方案确认。
- PostgreSQL 定时备份到对象存储。
- Redis 用于 token / quota / 临时提交状态。

邮件：

- VPS IP：`103.237.92.203`
- `mail.nyy.app` A 记录已配置。
- SPF / DKIM / DMARC 已配置。
- PTR 待服务商设置为 `mail.nyy.app`。

## 15. 继任者建议路线

1. 先运行后端测试和前端类型检查，确认环境可用。
2. 浏览 `docs/PRD.md` 和本 README，理解 v1 / v1.1 / v1.2 范围。
3. 优先不要重写上传主流程，当前闭环已经可用。
4. UI 继续改时优先处理字号语义化，不要继续堆 `text-xs`。
5. 动画修改前先保留当前 one-take 勾勾方案，避免重新引入跳动。
6. 生产前必须处理 `.env`、JWT secret、CORS、PTR、备份、日志和监控。
7. 涉及分享路由时，先检查 FastAPI 路由顺序，避免静态路径被 `{code}` 捕获。

## 16. 相关文档

- `docs/PRD.md`：产品需求文档。
- `docs/PROGRESS.md`：早期开发进展记录，部分数据已过时，但保留历史上下文。
- `docs/spike-cors.md`：TOS CORS 验证。
- `docs/brand/brand-guide.md`：品牌指南。
- `deploy/README.md`：部署说明草案。
- `D:\nyy-frontend\docs\TYPOGRAPHY_AUDIT.md`：前端字体字号审计。
