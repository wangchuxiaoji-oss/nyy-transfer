# 拿呀呀前端 · nyy.app

这是 `nyy.app`（拿呀呀）文件中转站的 Next.js 前端开发目录。

主项目 README 位于：`../backend/README.md`

## 技术栈

- Next.js 14 App Router
- React 18
- TypeScript
- Tailwind CSS
- Framer Motion
- lucide-react
- client-zip
- qrcode

## 本地启动

```bash
cd /data/nyy/frontend
npm install
npm run dev
```

默认监听：

- `http://127.0.0.1:3000`
- `http://192.168.68.102:3000`（局域网访问）

API 地址由 `NEXT_PUBLIC_API_URL` 控制，默认：

```text
http://127.0.0.1:8000
```

## 常用命令

```powershell
npx tsc --noEmit
npm run dev
npm run build
```

开发中优先用 `npx tsc --noEmit` 做类型检查。历史上 `next build` 曾污染 `.next` dev 缓存导致开发服务器异常，必要时可删除 `.next` 后重启。

## 主要路由

| 路由 | 文件 | 说明 |
|---|---|---|
| `/` | `src/app/page.tsx` | 首页，上传 / 收文件选项卡，游客分享管理 |
| `/{code}` | `src/app/[code]/page.tsx` | 分享落地页 / 下载页 |
| `/r/{code}` | `src/app/r/[code]/page.tsx` | 文件请求上传页 |
| `/my` | `src/app/my/page.tsx` | 我的工作台 |
| `/nyy-console` | `src/app/nyy-console/page.tsx` | 管理后台 |

## 关键组件

| 文件 | 说明 |
|---|---|
| `src/components/file-uploader.tsx` | 上传主组件，多文件、文件夹、进度、重试、完成态 |
| `src/components/file-request-creator.tsx` | 创建收文件链接 |
| `src/components/auth-modal.tsx` | 登录 / 注册 Modal |
| `src/components/share-detail-modal.tsx` | 游客分享详情 Modal |
| `src/components/toast-provider.tsx` | Toast 系统 |
| `src/components/theme-provider.tsx` | 暗色模式状态 |
| `src/components/theme-toggle.tsx` | 暗色模式按钮 |
| `src/components/brand-logo.tsx` | 品牌 Logo |

## 字体字号

详见：`../docs/ui/TYPOGRAPHY_AUDIT.md`

当前原则：

- 主要可读内容（文件名、URL、正文）至少 `text-sm`，优先 `text-base`。
- `text-xs` 只用于辅助说明、大小、时间、状态标签。
- 后续建议在 `globals.css` 中补充语义类，如 `.type-body`、`.type-caption`。

## 已知注意事项

- LAN IP HTTP 环境下 `navigator.clipboard` 不可用，需要 fallback。
- LAN IP HTTP 环境下不要使用 `crypto.randomUUID()`，上传组件已使用兼容 ID 方案。
- 上传完成勾勾动效是 one-take 单元素动画，不要改回 `layoutId` 方案。
- 打包下载使用 `client-zip` 时，必须传 resolved `Response`，不能传 `Promise<Response>`。
