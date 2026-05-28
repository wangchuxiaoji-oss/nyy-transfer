# 拿呀呀 UI 与移动端修复方案

## 目标

- 保留当前“单主操作卡 + 暖橘品牌 + 轻量工具”的产品方向，不重做视觉框架。
- 将界面质量补齐到可上线标准：可访问对比度、移动触控、表单语义、弹窗可访问性、SEO/Agentic 基础文件、移动端完整流程验收。
- 使用 Chrome MCP 做移动端模拟评审与移动端 E2E 验收，不新增 Playwright/Cypress 依赖。

## 已确认决策

- 文档位置：`D:\nyy-frontend\docs\UI_MOBILE_REPAIR_PLAN.md`。
- 主按钮策略：保留品牌暖橘，主交互按钮改用更深橘，优先满足白字对比度。
- 移动端 E2E：使用 Chrome MCP 完整验收，不新增前端测试框架。
- Admin 文案：统一为中文运营风格。

## 修复范围

### P0 必修

- 修复 Lighthouse `color-contrast` 失败项：低对比灰字、橘底白字、小字号浅色文案。
- 补齐 `robots.txt` 和 `llms.txt`，修复 SEO 与 Agentic Browsing 基础失败。
- 登录弹窗补 `role="dialog"`、`aria-modal`、标题关联、Esc 关闭、焦点管理、无障碍按钮名称。
- 错误提示统一补 `role="alert"` 或 `aria-live`，确保登录、上传、提取码、收件错误可被读屏感知。
- 表单控件补显式 label 关联，不再依赖 placeholder 作为唯一标签。

### P1 应修

- 所有移动端可点目标最小命中区调整到 44px，包括顶部登录、上传按钮、更多选项、列表图标按钮、Admin 操作按钮。
- 首页 `传文件 / 收文件` 切换补选中态语义，避免只靠颜色表达状态。
- `framer-motion` 动画尊重 `prefers-reduced-motion`，全局提供 reduced-motion 降级。
- 分享页二维码改用 `next/image`，修复 Next build warning。
- 修复 `/my` 页面 `useEffect` 依赖 warning。

### P2 优化

- Admin 控制台英文文案中文化：登录提示、控制台标签、密码 placeholder、用户状态、文件/访客标识。
- 统一使用语义化颜色 token，减少组件内随意使用浅灰/浅橘。
- 深页图标按钮补 `aria-label`，并扩大命中区域。

## 移动端适配标准

- 视口覆盖：`320x568`、`375x667`、`375x812`、`390x844`、`414x896`、`768x1024`、`812x375` 横屏。
- 每个关键页不得出现横向滚动。
- 主要按钮、输入、切换、图标操作命中区不低于 `44x44px`。
- 登录弹窗在小屏内可滚动，不遮挡提交按钮。
- 上传更多选项在移动端纵向舒展，输入框和下拉框高度不低于 `44px`。
- Admin 窄屏采用卡片堆叠，列表操作不挤压主要信息。

## Chrome MCP 移动端评审清单

- 页面：`/`、登录弹窗、上传更多选项、`/:code` 分享页、`/r/:code` 收件页、`/my`、`/nyy-console`。
- 自动检查：横向滚动、触控尺寸、未命名按钮、未关联 label 的表单控件、dialog 语义、alert/live region。
- Lighthouse：移动端 Accessibility 目标无失败项，SEO 基础文件通过，Agentic Browsing 基础文件通过。
- 记录移动端 snapshot 和关键流程结果。

## 移动端 E2E 流程

- 游客首页：切换传/收模式，确认游客收文件显示登录引导，登录弹窗可打开关闭。
- 登录流程：移动端登录 `test@nyy.app`，确认账号状态和 `/my` 入口可用。
- 上传分享：上传小文件，设置提取码/过期时间，生成链接，确认复制反馈。
- 分享下载：打开分享页，验证提取码错误/正确反馈，确认下载、二维码、举报入口可触控。
- 收文件：登录用户创建收件链接，访客上下文打开 `/r/:code` 上传小文件，创建者在 `/my` 查看收到文件。
- Admin：移动端登录 `/nyy-console`，检查统计卡、举报队列、邮件记录、配额表单、封禁列表。
- 清理：记录本轮分享码和收件码，测试后清理或复用后端 E2E cleanup 逻辑。

## 验证命令

- 前端构建：`npm run build`
- 后端 API E2E：`uv run --with-requirements requirements.txt python tests/e2e_acceptance.py`
- Chrome MCP：按移动端视口执行 UI 评审和完整移动端 E2E。

## 执行顺序

1. 修颜色 token、对比度、触控尺寸。
2. 修 modal、label、alert、aria、keyboard。
3. 修移动布局、reduced-motion、Admin 中文化。
4. 补 `robots.txt`、`llms.txt`、Next warnings。
5. 运行构建和后端 API E2E。
6. 使用 Chrome MCP 做移动端 UI 评审与移动端 E2E。

## 已完成修复记录

- 移动 Lighthouse 已达到 Accessibility 100、Best Practices 100、SEO 100、Agentic Browsing 100。
- 首页、登录弹窗、上传器、分享页、收文件页、我的页面、Admin 均已补足基础移动端触控、label、alert、dialog、reduced-motion 和对比度问题。
- `robots.txt`、`llms.txt`、二维码 `next/image`、`/my` hook warning 已修。
- 后端 API E2E 已通过 `E2E_ACCEPTANCE_PASS`。

## 最终改进方案

### 最终目标

- 在不推翻当前暖橘品牌和单主操作卡方向的前提下，把产品从“可用”提升到“可长期维护、可增长、可运营”。
- 重点收口信息架构、反馈系统、列表管理、移动端触达和后台效率。
- 默认符合 `ui-ux-pro-max` 的核心要求：可访问性、触控尺寸、移动优先、表单反馈、深链状态、渐进披露、低动效、无横向滚动、统一图标体系。

### 已确认决策

- `/my`：桌面和移动都做成 `tab + search + pagination`。
- `/nyy-console`：桌面端 `table-first`，移动端 `card-first`。
- 文件请求高级参数开放：`max_files` 和 `max_bytes` 放进“高级设置”，默认折叠。
- 全局统一 toast。
- 继续只用 Chrome MCP + 后端 E2E，不新增 Playwright。
- 不做全站 dark mode，保留 Admin 独立深色后台。
- 分享页和收文件页移动端加固定底部 action bar。

### 实施总览

| 区域 | 最终方案 |
| --- | --- |
| 首页 `/` | 保持单主卡，不扩成多入口；保留传/收切换，继续强调主 CTA、当前配额、登录状态。 |
| 我的页面 `/my` | 变成“个人工作台”：顶部 tab、搜索、筛选、分页、URL 同步状态；下面分“分享 / 文件请求 / 收到的文件”。 |
| 分享页 `/[code]` | 移动端加固定底部 action bar；主动作突出下载，复制和举报保持次级；保留二维码和文件摘要。 |
| 收文件页 `/r/[code]` | 维持三步式流程：验证访问码、选择文件、提交完成；高级设置保持折叠；成功后给明确下一步。 |
| Admin `/nyy-console` | 桌面端表格优先，支持搜索、筛选、排序、分页；移动端改卡片堆叠，保持可操作性。 |
| 全局 | 统一 toast、skeleton、错误恢复、确认对话框、空状态、reduced-motion。 |

### 页面级方案

#### 首页 `/`

- 保持当前布局，不做全站重构。
- 强化切换态的语义和视觉层级，继续让“传文件”成为默认主路径。
- 游客不可创建收文件链接的限制继续保留，但提示文案更明确。
- 首页只做轻量优化，不扩展成多卡导航。

#### 我的页面 `/my`

- 桌面端和移动端都采用 tab 结构，但信息密度分层更清楚。
- 顶部增加搜索和筛选，默认状态通过 URL 维护，支持深链分享。
- 支持分页，避免列表一长就压成“后台堆叠页”。
- 空状态要有恢复路径，例如“去上传文件”“去创建收件链接”。
- 三个区块分别处理：我的分享、文件请求、收到的文件。
- 主要操作只保留复制、编辑、撤销、下载，其余动作放入次级区。

#### 分享页 `/[code]`

- 移动端底部固定 action bar，主按钮是“下载文件/获取下载链接”。
- 次级按钮是“复制链接”“举报”。
- 文件列表保持简洁，展示名称、大小、下载状态。
- 多文件时保留 QR 和打包下载，但不让页面信息过载。
- 举报和下载都保留明确反馈，不让用户猜结果。

#### 收文件页 `/r/[code]`

- 默认只显示最必要的输入和主操作。
- “高级设置”折叠，符合 progressive disclosure。
- 访问码错误要在原字段附近提示，验证成功后自动清除错误状态。
- 成功提交后要清楚说明“文件已提交”，并给下一步路径。
- 这页的移动端必须保证提交按钮始终可见，不被键盘或小屏挤掉。

#### Admin `/nyy-console`

- 桌面端改成表格优先。
- 表格列建议：
- 用户：邮箱、计划、验证状态、创建时间、最近登录、动作。
- 分享：短码、所有者、文件数、大小、下载数、状态、动作。
- 举报：短码、原因、状态、时间、动作。
- 邮件：收件人、短码、状态、时间、错误、动作。
- 表格必须支持搜索、筛选、排序、分页。
- 移动端不硬塞表格，改卡片堆叠，但保留相同的筛选条件和状态。
- 运营文案继续中文化，不保留英文黑话。

### 共享组件方案

- 全局 toast：成功、失败、警告、信息统一一套，3 到 5 秒自动消失，不抢焦点，`aria-live` 可读。
- Skeleton：列表页、后台页、分享页都用统一骨架屏，不再只显示“加载中...”。
- 空状态：必须给动作建议，不允许空白页。
- 确认弹窗：撤销、封禁、删除、清理类动作必须二次确认。
- 错误展示：靠近出错字段，带恢复路径，不做单纯红字提示。

### 文件请求高级设置

- 默认折叠，避免首屏信息太多。
- 暴露两个参数：
- 最大文件数 `max_files`。
- 最大容量 `max_bytes`。
- 保持当前默认值不变，前端显示中文单位和 helper text。
- 其他基础字段继续保留在主表单里：标题、访问码、有效期。
- 这部分完全符合 `ui-ux-pro-max` 的渐进披露规则。

### 后端/API 同步内容

- `/api/v1/my/shares` 增加搜索、筛选、排序、分页参数。
- `/api/v1/admin/users` 增加搜索、筛选、排序、分页参数。
- `/api/v1/admin/shares` 增加搜索、筛选、排序、分页参数。
- `/api/v1/admin/reports` 和 `/api/v1/admin/emails` 增加基础筛选和分页。
- 若前端要做“桌面表格优先”，后台列表接口必须先支持这些状态查询。
- 文件请求创建接口保留现有行为，但前端可传 `max_files` 和 `max_bytes`。

### 移动端标准

- 所有关键交互目标不小于 `44x44px`。
- 不出现横向滚动。
- 不依赖 hover 完成关键操作。
- 输入和按钮在 320px 宽度下必须能完整显示。
- 固定底部 action bar 必须考虑 safe area。
- 所有状态切换都要有明显反馈，不允许“点了但没反应”。

### ui-ux-pro-max 符合性确认

- Accessibility：符合，前提是继续保持对比度、标签、`role="dialog"`、`role="alert"`、焦点管理、按钮命名。
- Touch & Interaction：符合，前提是所有触控命中区维持 44px 以上。
- Layout & Responsive：符合，前提是坚持 mobile-first、无横向滚动、URL 状态同步。
- Forms & Feedback：符合，前提是所有错误在字段附近、成功/失败有反馈、复杂表单用渐进披露。
- Navigation：符合，前提是深链状态保留、tab 和筛选都写进 URL。
- Style Selection：符合，前提是保持 flat/minimal、Lucide 图标、无 emoji、不引入全站 dark mode。
- Animation：符合，前提是继续尊重 reduced-motion，避免大面积动效。
- Chart/Data：当前项目暂无核心图表，不构成问题。
- 结论：这套方案整体是 `ui-ux-pro-max` 合规的，且比继续扩散页面更适合当前产品阶段。

### 验收标准

- `npm run build` 无 warning。
- 后端 API E2E 通过。
- Chrome MCP 在 320px、375px、390px、414px、768px、横屏下无横向滚动。
- 没有小于 44px 的关键控件。
- 没有无 label 的表单控件。
- 没有无名按钮。
- Lighthouse mobile 达到：
- Accessibility `100`。
- Best Practices `100`。
- SEO `100`。
- Agentic Browsing `100`。

### 范围边界

- 不做全站 dark mode。
- 不引入 Playwright。
- 不重做品牌。
- 不重构成另一个产品。
- 不把后台做成重型系统，只做足够高效的运营后台。

## 文件级执行清单

### 共享组件与工具

- 新增 `src/components/toast-provider.tsx`：全局 toast provider、`useToast()`、`aria-live="polite"`、3 到 5 秒自动消失。
- 新增 `src/components/empty-state.tsx`：统一空状态标题、描述、主动作。
- 新增 `src/components/skeleton.tsx`：统一骨架屏。
- 新增 `src/components/confirm-dialog.tsx`：替换原生 `confirm()`，用于撤销、封禁等危险动作。
- 视需要新增 `src/lib/url-state.ts`：读取和写入 tab/search/filter/page/sort URL 状态。

### 后端 API

- 更新 `E:\dev\nyy\app\api\v1\my.py`：我的分享支持 `q`、`status`、`sort`、`page`、`page_size`。
- 更新 `E:\dev\nyy\app\api\v1\file_requests.py`：我的文件请求和收到文件支持分页；如需撤销请求，新增 owner-only revoke API。
- 更新 `E:\dev\nyy\app\api\v1\admin.py`：用户、分享、举报、邮件支持搜索、筛选、排序、分页。
- 更新相关 schemas：保证响应携带 `total`、`page`、`page_size`。
- 更新 `tests/e2e_acceptance.py`：覆盖新增分页/筛选参数，并保持 cleanup。

### 前端 API Client

- 更新 `src/lib/auth.ts`：`getMyShares()`、`getMyFileRequests()`、`getMyRequestFiles()` 支持 query 参数。
- 更新 `src/lib/admin.ts`：Admin users/shares/reports/emails 支持 page/search/filter/sort。
- 更新 `src/lib/api.ts`：如分享页 action bar 需要复制链接状态，保持现有能力即可。

### 页面

- 更新 `src/app/my/page.tsx`：重构为个人工作台，tab/search/filter/pagination/empty state/toast/confirm dialog。
- 更新 `src/app/nyy-console/page.tsx`：桌面表格优先、移动卡片优先、搜索筛选排序分页、toast、confirm dialog。
- 更新 `src/components/file-request-creator.tsx`：高级设置开放 `max_files` 和 `max_bytes`，默认折叠。
- 更新 `src/app/[code]/page.tsx`：移动端底部 action bar，复制/下载/举报反馈统一走 toast。
- 更新 `src/app/r/[code]/page.tsx`：移动端底部提交 action bar，成功后提供继续上传/返回首页路径。

### 验证

- 前端：`npm run build`。
- 后端：`uv run --with-requirements requirements.txt python tests/e2e_acceptance.py`。
- Chrome MCP：移动 Lighthouse、移动扫描、关键流程 E2E。
