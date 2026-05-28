# 拿呀呀 下一阶段 UI / 产品改进方案

本文记录的是 `UI_MOBILE_REPAIR_PLAN.md` 之后的下一阶段方案。当前阶段不重做品牌和视觉框架，继续保留「暖橘品牌 + 单主操作卡 + 轻量工具」方向，只做信息架构、反馈系统、列表效率和移动端触达的收口。

## 目标

- 保持当前产品气质，不改成重型后台或通用模板风格。
- 把 `/my`、`/nyy-console`、分享页、收文件页做成更清晰、更可运营、更适合深链访问的工作流。
- 继续满足 `ui-ux-pro-max` 的核心要求：可访问性、44px 触控、渐进披露、深链状态、reduced-motion、无横向滚动、统一图标体系。
- 继续只用 Chrome MCP + 后端 E2E 做验证，不新增 Playwright 或 Cypress。

## 已确认决策

| 项目 | 决策 |
| --- | --- |
| `/my` | 桌面和移动都做成 `tab + search + pagination` 的个人工作台。 |
| `/nyy-console` | 桌面端 `table-first`，移动端 `card-first`。 |
| 文件请求高级设置 | 暴露 `max_files` 和 `max_bytes`，默认折叠。 |
| 全局反馈 | 统一 toast、empty state、skeleton、confirm dialog。 |
| 测试方式 | 继续使用 Chrome MCP + 后端 E2E，不引入新前端测试框架。 |
| 主题策略 | 不做全站 dark mode，保留 Admin 独立深色控制台。 |
| 移动端动作区 | 分享页和收文件页都加固定底部 action bar。 |

## 页面总览

| 页面 | 方案 |
| --- | --- |
| 首页 `/` | 保持单主卡，不扩成多入口导航；继续强调主 CTA、当前配额、登录状态。 |
| 我的页面 `/my` | 变成个人工作台：顶部 tab、搜索、筛选、分页、URL 同步状态。 |
| 分享页 `/[code]` | 移动端加固定底部 action bar，下载为主，复制和举报为次级。 |
| 收文件页 `/r/[code]` | 保持三步式流程，访问码、选择文件、提交完成；高级设置折叠。 |
| Admin `/nyy-console` | 桌面表格优先，移动卡片优先，支持搜索、筛选、排序、分页。 |

## 页面级方案

### 首页 `/`

- 保持当前布局，不做多卡导航扩张。
- 继续让“传文件”成为默认主路径。
- “收文件”维持为次级能力，游客只看到登录引导。
- 只做轻量文案和状态反馈优化，不改变整体信息架构。

### 我的页面 `/my`

- 采用清晰的 tab 结构，区分我的分享、文件请求、收到的文件。
- 顶部增加搜索和筛选，支持 URL 深链，刷新后状态可恢复。
- 列表分页化，避免长列表压成单页堆叠。
- 空状态必须带动作，例如“去上传文件”“去创建收件链接”。
- 常用操作只保留复制、编辑、撤销、下载，其余动作放到次级区。

### 分享页 `/[code]`

- 移动端固定底部 action bar，主按钮是下载。
- 复制链接、举报保持次级位置，不抢主操作。
- 文件列表只展示必要信息：名称、大小、状态。
- 多文件分享保留二维码和打包下载，但不让页面信息过载。
- 所有成功和失败结果都要有明确反馈。

### 收文件页 `/r/[code]`

- 默认只显示最必要的输入和主操作。
- “高级设置”默认折叠，符合 progressive disclosure。
- 访问码错误提示要靠近输入字段；验证成功后清理错误状态。
- 提交成功后要明确告知已完成，并提供下一步路径。
- 移动端提交按钮必须始终可见，不能被键盘或小屏挤掉。

### Admin `/nyy-console`

- 桌面端以表格为主，保证密度和效率。
- 表格支持搜索、筛选、排序、分页。
- 移动端不硬塞表格，改为卡片堆叠，但保留同样的过滤和状态能力。
- 运营文案继续中文化，减少英文黑话和内部术语。

## 共享组件

- `src/components/toast-provider.tsx`：全局 toast，3 到 5 秒自动消失，不抢焦点，`aria-live="polite"`。
- `src/components/empty-state.tsx`：统一空状态标题、描述和动作。
- `src/components/skeleton.tsx`：统一骨架屏，列表和后台页面复用。
- `src/components/confirm-dialog.tsx`：替换危险操作的原生确认弹窗。
- `src/lib/url-state.ts`：统一处理 tab、search、filter、page、sort 的 URL 同步。

## 后端与 API

- `E:\dev\nyy\app\api\v1\my.py`：补充搜索、筛选、排序、分页。
- `E:\dev\nyy\app\api\v1\file_requests.py`：补充分页；如需要撤销请求，增加 owner-only revoke API。
- `E:\dev\nyy\app\api\v1\admin.py`：用户、分享、举报、邮件支持搜索、筛选、排序、分页。
- 相关 schema 需要返回 `total`、`page`、`page_size` 等分页信息。
- `src/lib/auth.ts` 和 `src/lib/admin.ts` 需要同步支持 query 参数。
- `tests/e2e_acceptance.py` 需要补充分页、筛选和清理覆盖。

## 文件级执行清单

### 前端页面

- `src/app/my/page.tsx`：重构为个人工作台。
- `src/app/nyy-console/page.tsx`：桌面表格优先、移动卡片优先。
- `src/components/file-request-creator.tsx`：开放 `max_files` 和 `max_bytes` 高级设置。
- `src/app/[code]/page.tsx`：移动端底部 action bar，复制、下载、举报统一反馈。
- `src/app/r/[code]/page.tsx`：移动端底部提交 action bar，成功后给继续上传或返回首页路径。

### 前端工具与客户端

- `src/lib/auth.ts`：支持我的分享、文件请求、收到文件的查询参数。
- `src/lib/admin.ts`：支持 admin 用户、分享、举报、邮件列表查询参数。
- `src/lib/api.ts`：保持现有上传和分享能力，配合页面动作反馈即可。

### 后端接口

- `E:\dev\nyy\app\api\v1\my.py`
- `E:\dev\nyy\app\api\v1\file_requests.py`
- `E:\dev\nyy\app\api\v1\admin.py`
- `E:\dev\nyy\app\schemas\admin.py`
- `E:\dev\nyy\app\schemas\file_request.py`

## 移动端标准

- 所有关键交互目标不小于 `44x44px`。
- 不出现横向滚动。
- 不依赖 hover 完成关键操作。
- 输入和按钮在 320px 宽度下必须完整可用。
- 固定底部 action bar 必须考虑 safe area。
- 所有状态切换都要有明显反馈，不允许“点了但没反应”。

## ui-ux-pro-max 符合性

- Accessibility：保持对比度、标签、`role="dialog"`、`role="alert"`、焦点管理和按钮命名。
- Touch & Interaction：保持 44px 以上触控命中区。
- Layout & Responsive：坚持 mobile-first、无横向滚动、URL 状态同步。
- Forms & Feedback：错误靠近字段，成功和失败都有反馈，复杂表单用渐进披露。
- Navigation：保持深链状态，tab 和筛选都写进 URL。
- Style Selection：继续使用 flat/minimal、Lucide 图标，不引入全站 dark mode。
- Animation：继续尊重 reduced-motion，避免大面积动效。

## 验收标准

- `npm run build` 无 warning。
- 后端 API E2E 通过。
- Chrome MCP 在 320px、375px、390px、414px、768px 和横屏下无横向滚动。
- 没有小于 44px 的关键控件。
- 没有无 label 的表单控件。
- 没有无名按钮。
- Lighthouse mobile 达到 Accessibility `100`、Best Practices `100`、SEO `100`、Agentic Browsing `100`。

## 执行顺序

1. 先补 API 的搜索、筛选、排序、分页能力。
2. 再落共享组件：toast、empty state、skeleton、confirm dialog。
3. 重构 `/my` 为个人工作台。
4. 重构 Admin 为桌面表格优先、移动卡片优先。
5. 补分享页和收文件页的移动端 action bar。
6. 做完整构建、后端 E2E 和 Chrome MCP 验证。

## 范围边界

- 不做全站 dark mode。
- 不引入 Playwright。
- 不重做品牌。
- 不把后台做成重型系统。
- 不推翻现有首页主操作卡结构。

## 参考文档

- 已完成的修复记录见 `UI_MOBILE_REPAIR_PLAN.md`。
