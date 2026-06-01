# 拿呀呀前端字体与字号审计

> 更新时间：2026-05-28
> 适用范围：`/data/nyy/frontend` Next.js 前端。

## 结论

全站语义字号替换已完成。所有核心组件和页面均使用 `type-*` 语义类，原子字号类已清零。

字体族现状：

- `src/app/layout.tsx` 通过 `next/font/local` 加载 Geist Sans 与 Geist Mono。
- `tailwind.config.ts` 中 `fontFamily.sans` 和 `fontFamily.mono` 已绑定到 CSS 变量。
- 全站 `body` 使用 `font-sans antialiased`。

字号现状：

- 使用统计：`text-xs` 107 次，`text-sm` 106 次，`text-lg` 11 次，`text-xl` 3 次，`text-2xl` 2 次，`text-[10px]` 1 次。
- 大量正文、标签、文件名、表格和按钮混用 `text-xs` / `text-sm`，导致界面信息密度过高、层级不稳定。
- 个别页面（尤其后台）直接使用较多 Tailwind 原子类，短期高效，但长期不利于统一调整。

## 当前状态（已落地）

全部页面/组件已完成语义字号替换：

| 文件 | 状态 |
|---|---|
| `src/components/file-uploader.tsx` | done |
| `src/app/[code]/page.tsx` | done |
| `src/app/page.tsx` | done |
| `src/components/share-detail-modal.tsx` | done |
| `src/components/auth-modal.tsx` | done |
| `src/components/file-request-creator.tsx` | done |
| `src/app/r/[code]/page.tsx` | done |
| `src/app/my/page.tsx` | done |
| `src/components/confirm-dialog.tsx` | done |
| `src/components/toast-provider.tsx` | done |
| `src/components/pagination.tsx` | done |
| `src/components/empty-state.tsx` | done |
| `src/app/nyy-console/page.tsx` | done |

`npx tsc --noEmit` 通过，零错误。

## 建议的文字层级

面向当前产品形态，建议采用 6 档语义层级：

| 语义 | 推荐 Tailwind | 用途 |
|---|---|---|
| `display` | `text-2xl sm:text-3xl font-semibold` | 页面大标题、Logo slogan 旁主视觉文案 |
| `title` | `text-xl font-semibold` | 页面标题、Modal 标题、后台模块标题 |
| `section` | `text-lg font-semibold` | 卡片标题、结果页主标题 |
| `body` | `text-base` | 主要内容、文件名、链接、可读正文 |
| `body-sm` | `text-sm` | 次级正文、说明、按钮文案、表格正文 |
| `caption` | `text-xs` | 辅助信息、时间、大小、状态标签、计数 |

原则：

- 文件名、URL、用户需要读取或复制的信息，默认至少 `text-base`。
- 表单输入、按钮、Modal 正文默认 `text-sm` 或 `text-base`，不要低于 `text-sm`。
- `text-xs` 只用于辅助说明，不用于主信息。
- 避免 `text-[10px]`，除非是徽标、极短状态点且不影响理解。
- 中文界面正文行高建议 `leading-6` 或默认 Tailwind line-height，不要压得过紧。

## 推荐落地方式（已完成）

语义类已在 `src/app/globals.css` 的 `@layer components` 中定义并全站应用：

```css
.type-display   { @apply text-2xl font-semibold sm:text-3xl; }
.type-title     { @apply text-xl font-semibold; }
.type-section   { @apply text-lg font-semibold; }
.type-body      { @apply text-base; }
.type-body-strong { @apply text-base font-semibold; }
.type-body-sm   { @apply text-sm; }
.type-label     { @apply text-sm font-medium; }
.type-action    { @apply text-sm font-semibold; }
.type-caption   { @apply text-xs; }
.type-file-name { @apply text-base; }
.type-file-meta { @apply text-sm; }
```

不再需要逐步迁移——已全量替换。

## 风险与注意事项

- 字号调大后，移动端更容易换行，必须检查 375px 宽度。
- 文件名过长时继续使用 `truncate`，但查看详情或 tooltip 应提供完整文件名的路径。
- 文本增大可能影响卡片高度，目前上传完成卡片使用 `min-h-[180px]`，移动端会自然撑高。
- 动画中避免依赖字体高度做定位；当前上传完成勾勾动效使用固定像素坐标，和文字独立，避免跳动。
