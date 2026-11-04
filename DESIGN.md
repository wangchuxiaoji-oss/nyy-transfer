# DESIGN.md

> 让界面退后，让文件、任务与信任成为主角。

本文档定义拿呀² `v1.x` 的下一代视觉系统，以及正式页面 Preview 的审阅范围。它不是生产改造授权：所有新方案必须先在 `/design-preview` 中审阅，用户明确确认后才能迁移到正式页面。

## 0. Decision Status

### 已确认

- 覆盖全部正式 UI 页面，排除实验室、Logo/图标实验、视频检查和 SEO 机器路由。
- 使用站内隔离的 `/design-preview` 作为审阅入口，不连接真实业务 API。
- 第一轮同时提供亮色桌面端与移动端 Preview；暗色方案在结构和亮色方向确认后补充。
- 风格采用“温润专业”，界面中性、内容优先，适配教育、影像和商务场景。
- 交互档位采用 L1 精致静态，保留任务反馈，取消持续装饰动画。
- Logo 采用“信封路径抽象”方向，字标为“拿呀²”中文主标加 `nyy.app` 域名副标。
- Logo 首轮覆盖完整品牌套件：符号、横版、竖版、单色、深浅背景、16–512px 图标、导航、首页和 OG 图。
- Preview 按“核心流程”“工作台与后台”“内容页”三批审阅。

### 待 Preview 决策

- Logo 几何构造：折线交付、连接节点、负形 N 路径三套候选中选择一套。
- 首页 Hero：左侧说明加右侧工具，或居中短标题加下方工具，两套结构并列预览。
- 铜橙的最终色相与饱和度，在本文候选值附近通过真实界面确认。
- 深色主题的最终层级与品牌色映射，亮色方案确认后单独审阅。

### 不得自行决定

- 不得在用户未确认前替换生产 Logo、favicon、OG 图或正式页面样式。
- 不得将某个 Preview 候选默认视为最终方案。
- 不得新增未确认的品牌隐喻、吉祥物、英文品牌名或宣传口号。
- 页面结构、功能层级或文案发生实质变化时，必须先说明并取得确认。

## 1. Visual Theme & Atmosphere

**Style**: Warm Professional Utility / 温润专业工具

**Keywords**: 克制、可信、清晰、成熟、内容优先、精确、有温度、跨场景

**Tone**: 安静而可靠，保留轻微的人情味，但不卖萌、不炫技、不模拟游戏界面。

**Feel**: 像一张整理干净的工作台，纸张、照片和合同都能自然放上去，而工具本身不抢内容。

**Interaction Tier**: L1 精致静态

**Dependencies**: CSS only；沿用现有 React、Tailwind 和 Framer Motion，但 Preview 不增加新动效依赖。

### 设计哲学

1. **稳定外壳，内容着色**：导航、表单、列表、权限和状态使用稳定中性色；照片、视频和文件类型可以带出内容自身色彩。
2. **品牌色是信号，不是背景噪声**：铜橙用于品牌识别、焦点、进度与少数关键动作，不再覆盖所有按钮、卡片和装饰。
3. **层级优先于容器**：先用字号、字重、间距和分隔线建立层级，只有确实需要独立分组或点击入口时才使用卡片。
4. **专业不等于冷漠**：保留暖白背景、柔和铜色和友好文案，但取消糖果字形、发光、粒子、扫描线和持续漂浮。
5. **场景不改变产品壳**：教育、影像、商务只改变内容示例、缩略图和语义状态，不为每个行业创建一套皮肤。

### 品牌与 Logo

新品牌系统保留“文件交付”语义，但不保留拟人化抱信封形象和麦芽糖字标。

首轮必须并列提供三套符号候选，用户选择前均不是定稿：

| 候选 | 构造 | 气质 | 风险 |
|------|------|------|------|
| A 折线交付 | 信封折线延伸成向外路径，末端形成轻微方向提示 | 直接、易懂 | 可能接近常见发送图标 |
| B 连接节点 | 信封四角与路径节点构成连接关系 | 数字化、商务 | 小尺寸节点可能损失 |
| C 负形 N 路径 | 信封轮廓内以负形形成 N 或路径 | 品牌独特、克制 | 首次理解成本略高 |

字标规则：

- 主字标固定为“拿呀²”，不得改成“拿呀呀”或仅用 NYY。
- 域名副标固定为 `nyy.app`，只在横版、竖版和营销场景出现。
- 字标采用定制几何无衬线骨架，字面稳定，不倾斜，不描边，不发光。
- 上标 `²` 作为识别细节，不能大于主字高的 42%，不能独立漂浮成装饰。
- 符号和字标必须同时通过 16px、20px、32px、56px、96px 和 512px 检验。
- 所有候选必须包含纯黑、纯白和单色铜橙版本。

## 2. Color Palette & Roles

以下是第一轮亮色 Preview 的候选 Token。色值可在用户审阅后微调，但角色关系不得随意改变。

```css
:root {
  /* Backgrounds */
  --bg: #f7f7f4;
  --surface: #ffffff;
  --surface-alt: #f0f1ee;
  --surface-hover: #f3f4f1;
  --surface-inverse: #17191c;

  /* Borders */
  --border: #e3e5e2;
  --border-subtle: #e3e5e2;
  --border-control: #8a8f96;
  --border-hover: #686e75;

  /* Text */
  --text: #17191c;
  --text-secondary: #62676d;
  --text-tertiary: #6b7178;
  --text-inverse: #ffffff;
  --text-on-accent: #ffffff;

  /* Brand and actions */
  --brand: #c25d34;
  --accent: #9f4528;
  --accent-hover: #7f351f;
  --accent-soft: #f6e7df;
  --primary: #17191c;
  --primary-hover: #2a2d31;
  --primary-active: #0b0c0e;
  --focus: #9f4528;

  /* Semantic */
  --success: #237a57;
  --success-soft: #e6f3ed;
  --error: #b42318;
  --error-soft: #fbe9e7;
  --warning: #825500;
  --warning-soft: #fbf0d8;
  --info: #315c87;
  --info-soft: #e7eef5;

  /* RGB variants */
  --bg-rgb: 247, 247, 244;
  --surface-rgb: 255, 255, 255;
  --text-rgb: 23, 25, 28;
  --accent-rgb: 159, 69, 40;
  --brand-rgb: 194, 93, 52;

  /* Geometry */
  --radius-compact: 6px;
  --radius-control: 10px;
  --radius-card: 12px;
  --radius-panel: 16px;
  --radius-pill: 9999px;

  /* Motion */
  --duration-fast: 90ms;
  --duration-standard: 150ms;
  --duration-enter: 200ms;
  --ease-productive: cubic-bezier(0.2, 0, 0.38, 0.9);
  --ease-enter: cubic-bezier(0, 0, 0.38, 0.9);
  --ease-exit: cubic-bezier(0.2, 0, 1, 0.9);
}

[data-theme="dark"] {
  --bg: #111315;
  --surface: #181b1e;
  --surface-alt: #202428;
  --surface-hover: #252a2f;
  --surface-inverse: #f3f4f2;
  --border: #30353a;
  --border-subtle: #30353a;
  --border-control: #717981;
  --border-hover: #959da5;
  --text: #f3f4f2;
  --text-secondary: #b7bdc3;
  --text-tertiary: #949ba3;
  --text-inverse: #17191c;
  --text-on-accent: #17191c;
  --brand: #e1845e;
  --accent: #e1845e;
  --accent-hover: #f09a75;
  --accent-soft: #33241f;
  --primary: #f3f4f2;
  --primary-hover: #ffffff;
  --primary-active: #d9dcdf;
  --focus: #e1845e;
  --success: #62b58d;
  --success-soft: #17372a;
  --error: #ff8a80;
  --error-soft: #40201d;
  --warning: #e5b454;
  --warning-soft: #382d16;
  --info: #84add3;
  --info-soft: #1e3041;
  --bg-rgb: 17, 19, 21;
  --surface-rgb: 24, 27, 30;
  --text-rgb: 243, 244, 242;
  --accent-rgb: 225, 132, 94;
  --brand-rgb: 225, 132, 94;
}
```

### Color Rules

- 所有正式组件只引用角色 Token，不直接引用品牌色阶或硬编码色值。
- `--brand` 只用于 Logo、大面积非文字品牌图形和装饰；正常字号文字使用 `--accent`。
- 主按钮使用 `--primary`，不使用亮橙背景，确保跨场景稳定与文字对比度。
- 装饰边框使用 `--border-subtle`；需要识别控件边界时使用 `--border-control`。
- 成功、错误、警告和信息状态必须同时包含图标或文字，不得只靠颜色区分。
- 一块界面最多出现一个品牌强调色和一个必要的语义色。
- 文件类型色只能出现在图标、缩略图边缘或小面积标记，不得染色整个列表行。
- 暗色 Token 仅作为规范草案，第一轮不进入审阅结论。

## 3. Typography Rules

### Font Stack

项目继续使用已经本地托管的 Geist，避免新增远程字体依赖。中文采用明确的系统回退链，不从 Google Fonts 远程加载大型 CJK 字库。

```css
:root {
  --font-sans: var(--font-geist-sans), "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  --font-mono: var(--font-geist-mono), "SFMono-Regular", Consolas, monospace;
}
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Hero H1 | Sans | `clamp(2.75rem, 5vw, 4.5rem)` | 620 | 1.08 | `-0.035em` |
| Section H2 | Sans | `clamp(2rem, 3vw, 3rem)` | 600 | 1.18 | `-0.025em` |
| Page H1 | Sans | `clamp(2rem, 4vw, 3.25rem)` | 620 | 1.16 | `-0.025em` |
| H3 | Sans | `1.25rem` | 600 | 1.4 | `-0.012em` |
| Body | Sans | `1rem` | 400 | 1.75 | `0.01em` |
| Body Small | Sans | `0.875rem` | 400 | 1.65 | `0.01em` |
| Label | Sans | `0.8125rem` | 550 | 1.45 | `0.02em` |
| Caption | Sans | `0.75rem` | 450 | 1.5 | `0.02em` |
| Data / Code | Mono | `0.8125rem` | 500 | 1.5 | `0` |

### Typography Rules

- 中文正文默认不小于 15px，正式内容页使用 16px。
- 只设置三级主要字号层级，避免同屏出现过多接近但不一致的字号。
- `font-mono` 仅用于短码、时间、文件大小、进度和技术标识，不用于按钮、标题或普通正文。
- 中文标签不强制全大写，不使用超过 `0.08em` 的宽字距制造“科技感”。
- 数字列和比较数据使用 `font-variant-numeric: tabular-nums`。
- 标题优先使用 `text-wrap: balance`，正文使用 `text-wrap: pretty`。
- 禁止使用糖果字、描边字、倾斜字、手写字体和超黑 `900` 字重作为正式 UI 字体。

### Text Decoration

- Hero H1：无渐变、无投影、无描边。
- Section H2：无渐变、无投影，以留白、字号和字重建立层级。
- Eyebrow：使用普通句式或短标签，不使用高密度英文大写装饰。
- 正文：无任何装饰。
- 链接：默认保留可识别颜色，hover 与 focus 增加下划线，不使用发光。

## 4. Component Stylings

以下 CSS 是 Preview 的基础规范。组件实现可使用 Tailwind，但最终效果必须等价，且包含全部状态。

### Buttons

```css
.ui-button {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  padding: 0.625rem 1rem;
  font: 550 0.875rem/1.25 var(--font-sans);
  cursor: pointer;
  transition:
    background-color var(--duration-fast) var(--ease-productive),
    border-color var(--duration-fast) var(--ease-productive),
    color var(--duration-fast) var(--ease-productive),
    transform var(--duration-fast) var(--ease-productive);
}

.ui-button--primary {
  color: var(--text-inverse);
  background: var(--primary);
  border-color: var(--primary);
}

.ui-button--primary:hover:not(:disabled) {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
}

.ui-button--secondary {
  color: var(--text);
  background: var(--surface);
  border-color: var(--border-control);
}

.ui-button--secondary:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--border-hover);
}

.ui-button--ghost {
  color: var(--text-secondary);
  background: transparent;
}

.ui-button--ghost:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-hover);
}

.ui-button--danger {
  color: var(--text-on-accent);
  background: var(--error);
  border-color: var(--error);
}

.ui-button:active:not(:disabled) {
  transform: translateY(1px);
}

.ui-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.ui-button:disabled {
  cursor: not-allowed;
  opacity: 0.46;
  transform: none;
}
```

### Cards and Panels

```css
.ui-card {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--surface);
  box-shadow: none;
}

.ui-card--interactive {
  cursor: pointer;
  transition:
    border-color var(--duration-standard) var(--ease-productive),
    box-shadow var(--duration-standard) var(--ease-productive),
    transform var(--duration-standard) var(--ease-productive);
}

.ui-card--interactive:hover {
  border-color: var(--border-control);
  box-shadow: 0 10px 28px rgba(var(--text-rgb), 0.06);
  transform: translateY(-1px);
}

.ui-card--interactive:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.ui-panel {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-panel);
  background: var(--surface);
  box-shadow: 0 18px 50px rgba(var(--text-rgb), 0.055);
}
```

卡片只用于异质摘要、可点击入口或需要独立边界的复杂任务。文件列表、设置项、FAQ 和同质数据默认使用列表行与分隔线。

### Navigation

```css
.ui-nav {
  position: sticky;
  top: 0;
  z-index: 50;
  min-height: 64px;
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  background: rgba(var(--surface-rgb), 0.94);
  backdrop-filter: blur(10px);
}

.ui-nav__link {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  color: var(--text-secondary);
  text-decoration: none;
  transition:
    color var(--duration-fast) var(--ease-productive),
    background-color var(--duration-fast) var(--ease-productive);
}

.ui-nav__link:hover,
.ui-nav__link[aria-current="page"] {
  color: var(--text);
}

.ui-nav__link:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: var(--radius-compact);
}
```

### Links

```css
.ui-link {
  color: var(--accent);
  text-decoration-line: underline;
  text-decoration-color: transparent;
  text-underline-offset: 0.2em;
  transition:
    color var(--duration-fast) var(--ease-productive),
    text-decoration-color var(--duration-fast) var(--ease-productive);
}

.ui-link:hover {
  color: var(--accent-hover);
  text-decoration-color: currentColor;
}

.ui-link:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: var(--radius-compact);
}
```

### Tags and Status Badges

```css
.ui-badge {
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  padding: 0.2rem 0.55rem;
  color: var(--text-secondary);
  background: var(--surface-alt);
  font: 550 0.75rem/1.2 var(--font-sans);
}

.ui-badge--success { color: var(--success); background: var(--success-soft); }
.ui-badge--error { color: var(--error); background: var(--error-soft); }
.ui-badge--warning { color: var(--warning); background: var(--warning-soft); }
.ui-badge--info { color: var(--info); background: var(--info-soft); }
```

### Form Controls

```css
.ui-field {
  width: 100%;
  min-height: 44px;
  border: 1px solid var(--border-control);
  border-radius: var(--radius-control);
  padding: 0.625rem 0.75rem;
  color: var(--text);
  background: var(--surface);
  font: 400 1rem/1.5 var(--font-sans);
  transition:
    border-color var(--duration-fast) var(--ease-productive),
    box-shadow var(--duration-fast) var(--ease-productive);
}

.ui-field:hover:not(:disabled) {
  border-color: var(--border-hover);
}

.ui-field:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
  border-color: var(--focus);
}

.ui-field[aria-invalid="true"] {
  border-color: var(--error);
}

.ui-field:disabled {
  cursor: not-allowed;
  color: var(--text-tertiary);
  background: var(--surface-alt);
  opacity: 0.72;
}
```

### Lists and Rows

```css
.ui-list {
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-card);
  background: var(--surface);
}

.ui-list-row {
  min-height: 56px;
  display: grid;
  align-items: center;
  border-bottom: 1px solid var(--border-subtle);
  padding: 0.75rem 1rem;
  transition: background-color var(--duration-fast) var(--ease-productive);
}

.ui-list-row:last-child { border-bottom: 0; }
.ui-list-row:hover { background: var(--surface-hover); }
.ui-list-row:focus-within { box-shadow: inset 3px 0 0 var(--focus); }
```

### Upload Zone

```css
.ui-upload-zone {
  min-height: 220px;
  display: grid;
  place-items: center;
  border: 1px dashed var(--border-control);
  border-radius: var(--radius-panel);
  color: var(--text-secondary);
  background: var(--surface);
  transition:
    border-color var(--duration-standard) var(--ease-productive),
    background-color var(--duration-standard) var(--ease-productive),
    box-shadow var(--duration-standard) var(--ease-productive);
}

.ui-upload-zone:hover,
.ui-upload-zone[data-dragging="true"] {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.ui-upload-zone:focus-within {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
```

### Dialogs and Drawers

```css
.ui-overlay {
  position: fixed;
  inset: 0;
  background: rgba(var(--text-rgb), 0.42);
}

.ui-dialog {
  width: min(32rem, calc(100vw - 2rem));
  max-height: min(44rem, calc(100dvh - 2rem));
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-panel);
  background: var(--surface);
  box-shadow: 0 24px 70px rgba(var(--text-rgb), 0.18);
}
```

### Logo Applications

```css
.brand-lockup {
  display: inline-flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--text);
}

.brand-lockup__symbol {
  width: 2rem;
  height: 2rem;
  color: var(--brand);
}

.brand-lockup__name {
  color: var(--text);
}

.brand-lockup__domain {
  color: var(--text-tertiary);
  font: 500 0.6875rem/1 var(--font-mono);
}
```

Logo 不使用 `filter: drop-shadow()`、渐变填充、描边叠层或发光。

## 5. Layout Principles

### Container

- 标准产品页最大宽度：`1200px`。
- 工作台和后台最大宽度：`1440px`。
- 法律与长文内容宽度：`760px`；含目录布局整体最大宽度 `1120px`。
- 桌面水平 padding：`32px`；平板 `24px`；移动端 `16px`。
- 页面顶部工具栏高度：`64px`。

### Spacing Scale

```css
:root {
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-24: 6rem;
}
```

- 产品功能区 section 间距：`48–64px`。
- 营销内容区 section 间距：桌面 `96px`，移动端 `64px`。
- 卡片内边距：紧凑 `16px`，标准 `24px`，重点面板 `32px`。
- 同组元素优先使用 `8–16px`；跨组元素使用 `24–48px`。

### Grid

```css
.page-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  column-gap: 1.5rem;
}

.product-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-8);
}

@media (min-width: 1024px) {
  .product-layout--sidebar {
    grid-template-columns: minmax(13rem, 0.26fr) minmax(0, 0.74fr);
  }
}
```

### Page-Level Rules

- 首屏首先说明“这里能完成什么”，随后立即提供上传或收件操作，营销内容不得把核心工具推到首屏以下。
- 同质内容使用纵向列表、表格或分区，不使用等大卡片墙。
- 影像预览区域允许深色沉浸背景，但工具栏与元数据仍使用统一产品 Token。
- 管理后台优先密度和可扫描性，不套用营销页的大留白和大标题。
- 法律页和 SEO 内容页共享阅读模板，但每个正式路由都必须在 Preview 中使用真实页面标题与内容结构展示。

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | 无阴影，仅背景与分隔线 | 列表行、表格、内容区、导航 |
| Subtle | `0 10px 28px rgba(var(--text-rgb), 0.06)` | 可点击异质卡片 hover |
| Panel | `0 18px 50px rgba(var(--text-rgb), 0.055)` | 上传器、核心工具面板 |
| Overlay | `0 24px 70px rgba(var(--text-rgb), 0.18)` | Dialog、Drawer、菜单 |

### Elevation Rules

- 阴影不带品牌色，不使用 glow。
- 同一页面常驻阴影层级不超过两级。
- 卡片默认无阴影，只有真正可点击的异质卡片在 hover 时出现轻阴影。
- Dialog 与 Drawer 使用阴影表达覆盖关系，不依赖大模糊玻璃背景。
- 导航主要依赖边框和背景透明度，不使用悬浮胶囊外壳。

## 7. Animation & Interaction

**Motion Philosophy**: 动效只解释状态变化、确认输入或帮助定位，不承担装饰任务。

**Tier**: L1 精致静态

### Dependencies

无新增依赖。Preview 使用 CSS transition；已有 Framer Motion 仅在需要复现真实交互状态时使用。

### Entrance Animation

```css
@keyframes nyy-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.ui-enter {
  animation: nyy-enter var(--duration-enter) var(--ease-enter) both;
}
```

- 页面仅首个主要内容区域使用一次入场动画。
- 列表、卡片墙和正文段落不逐个 stagger 入场。
- 页面切换不使用遮罩、模糊或 3D 转场。

### Productive Motion

| 场景 | 时长 | 属性 | 说明 |
|------|------|------|------|
| Hover / toggle | `90ms` | color, background, border | 立即反馈 |
| 小型展开 | `150ms` | opacity, transform | 菜单、FAQ、筛选 |
| Dialog / Drawer | `200–240ms` | opacity, transform | 进入略慢于退出 |
| 上传成功 | `200ms + 150ms` | opacity, transform | 唯一签名反馈，文件状态变为链接状态 |
| 进度变化 | 数据驱动 | transform scaleX | 只反映真实进度 |

### Hover and Focus

```css
.ui-interactive {
  transition:
    color var(--duration-fast) var(--ease-productive),
    background-color var(--duration-fast) var(--ease-productive),
    border-color var(--duration-fast) var(--ease-productive),
    transform var(--duration-fast) var(--ease-productive);
}

.ui-interactive:active {
  transform: translateY(1px);
}

.ui-interactive:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
```

### Prohibited Motion

- 不使用粒子、光球漂移、极光呼吸、扫描线、循环发光和持续计数动画。
- 不使用弹簧、bounce、elastic、过度 scale 或 rotate。
- 不使用 scroll-jacking、视差、pin section 或自定义光标。
- 不使用 `transition: all`。
- 不让装饰动画持续超过 5 秒；第一轮 Preview 不包含任何持续装饰动画。

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

## 8. Do's and Don'ts

### Do

- 使用角色化 Token 管理颜色、边框、状态、间距和动效。
- 让文件名、大小、有效期、权限和当前进度优先于装饰文案。
- 使用真实教育、影像和商务文件示例验证同一界面的适配能力。
- 用留白、字号、字重和分隔线建立层级，再决定是否需要容器。
- 使用卡片展示异质入口，使用列表或表格展示同质项目。
- 保留 44px 最小操作高度和清晰的键盘焦点。
- 为长文件名、长邮箱、超长说明和空状态提供明确布局策略。
- 让错误信息说明问题和下一步，不只显示红色或错误码。
- 让 Preview 使用固定模拟数据，不连接生产 API，不写入真实状态。
- 每个 Preview 页面同时检查桌面端与 390px 移动端。

### Don't

- 禁止恢复 Y2K、赛博、游戏控制台或糖果视觉语言。
- 禁止同时使用橙、青、粉三种高饱和品牌色。
- 禁止渐变文字、文字发光、按钮发光和带品牌色阴影。
- 禁止大面积玻璃拟态、背景模糊球、粒子和扫描线。
- 禁止将所有内容包进圆角卡片，或出现卡片套卡片。
- 禁止把吉祥物或 Logo 符号作为通用功能图标。
- 禁止使用 `font-tech`、等宽字体或宽字距渲染普通正文和按钮。
- 禁止用颜色作为状态的唯一表达方式。
- 禁止为追求极简而移除表单边界、标签、焦点环或操作说明。
- 禁止把 NexIoT、Apple、Linear 或其他网站的具体组件直接复制进来。
- 禁止在 Preview 审阅通过前修改正式页面和品牌资产。
- 禁止在没有用户确认时从候选方案中自行选定最终 Logo 或 Hero。

## 9. Responsive Behavior

### Breakpoints

| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | `< 640px` | 单列、16px 页面边距、底部关键操作、隐藏非必要辅助列 |
| Tablet | `640–1023px` | 单列或 2 列、24px 边距、工具栏允许换行 |
| Desktop | `1024–1279px` | 12 栏网格、32px 边距、侧栏布局启用 |
| Wide | `>= 1280px` | 内容保持最大宽度，不无限拉伸，后台允许更高信息密度 |

**Touch Targets**: 主要操作和图标按钮最小 `44 × 44px`。

### Collapsing Strategy

- 首页：桌面 Hero 两个候选布局；移动端均收敛为标题、说明、模式切换、工具面板的单列顺序。
- 分享页：桌面文件列表与预览并列；移动端在“文件、预览、概览”之间使用清晰分段导航，主下载操作固定在安全区域上方。
- 收件页：桌面说明与上传区可并列；移动端上传区优先，说明折叠到其后。
- 工作台：桌面表格或紧凑列表；移动端保留主信息，次要字段进入详情或操作菜单。
- 管理后台：桌面侧栏与数据区并列；移动端使用顶部横向标签和单列数据，不把完整桌面表格压缩到窄屏。
- 内容页：桌面目录侧栏；移动端目录折叠为页内导航，不遮挡正文。
- Dialog：桌面居中；移动端小型确认仍居中，复杂表单改为底部或全屏 Sheet。
- 所有固定底部操作必须包含 `env(safe-area-inset-bottom)`。

```css
.responsive-container {
  width: min(100% - 2rem, 75rem);
  margin-inline: auto;
}

@media (min-width: 640px) {
  .responsive-container { width: min(100% - 3rem, 75rem); }
}

@media (min-width: 1024px) {
  .responsive-container { width: min(100% - 4rem, 75rem); }
}

.mobile-safe-action {
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
}
```

## 10. Preview Center Specification

### Isolation Rules

- Preview 根路由固定为 `/design-preview`，必须 `noindex, nofollow`。
- `robots.ts` 必须禁止抓取 `/design-preview`。
- Preview 组件放在独立命名空间，不修改或覆盖生产组件样式。
- Mock 数据放在 `src/lib/design-preview/`，不得调用真实 API、Cookie、管理员会话或上传签名接口。
- Preview 不产生数据库写入、Redis 写入、邮件、上传、下载计数或审计记录。
- Preview 使用独立 CSS Token 容器，避免全局样式泄漏到正式页面。

### Review Shell

预览中心需要提供：

- 页面与状态目录。
- 当前批次、页面、状态和候选方案说明。
- 桌面 `1440 × 900` 与移动 `390 × 844` 两种审阅框架。
- 全屏打开功能，方便真实浏览器响应式检查。
- 候选方案编号，不使用“推荐”视觉偏置影响用户判断。
- 每页明确列出“已确认”和“待确认”项目。
- 审阅备注区域只保存在浏览器本地，不发送到生产后端。

### Route Shape

```text
/design-preview
/design-preview/brand
/design-preview/core/home
/design-preview/core/share
/design-preview/core/request
/design-preview/workspace/my
/design-preview/admin/overview
/design-preview/admin/[module]
/design-preview/admin/share-preview
/design-preview/content/[slug]
/design-preview/content/privacy
/design-preview/content/terms
/design-preview/content/updates
/design-preview/content/not-found
```

状态通过受控查询参数切换，例如 `?state=empty`、`?state=locked`、`?state=error`，参数只能选择本地 Mock 数据。

## 11. Page Inventory and Review Batches

### 第一批：品牌与核心流程

| 正式路由 | Preview | 首轮状态 |
|----------|---------|----------|
| 品牌套件 | `/design-preview/brand` | Logo A/B/C、横版、竖版、单色、尺寸、导航、首页、favicon、OG |
| `/` | `/design-preview/core/home` | Hero A/B、发文件空态、发文件成功、收文件模式、额度错误、移动端 |
| `/[code]` | `/design-preview/core/share` | 加载、锁定、就绪单文件、就绪多文件、下载中、过期、错误、移动端 |
| `/r/[code]` | `/design-preview/core/request` | 加载、锁定、待上传、上传中、完成、错误、移动端 |

第一批全部确认前，不进入第二批正式 Preview 制作，也不改生产页面。

### 第二批：工作台与后台

| 正式路由 | Preview | 首轮状态 |
|----------|---------|----------|
| `/my` | `/design-preview/workspace/my` | 加载、分享空态、收件空态、列表、筛选、分页、编辑、移动端 |
| `/admin` | `/design-preview/admin/overview` | 登录、总览加载、总览就绪、总览错误、移动端 |
| `/admin?tab=shares` | `/design-preview/admin/shares` | 列表、筛选、详情抽屉、空态、错误 |
| `/admin?tab=reports` | `/design-preview/admin/reports` | 待处理、已处理、空态 |
| `/admin?tab=users` | `/design-preview/admin/users` | 列表、封禁 Dialog、空态 |
| `/admin?tab=emails` | `/design-preview/admin/emails` | 队列、失败、空态 |
| `/admin?tab=mailbox` | `/design-preview/admin/mailbox` | 邮件列表、详情、空态 |
| `/admin?tab=announcements` | `/design-preview/admin/announcements` | 列表、编辑、预览、空态 |
| `/admin?tab=quota` | `/design-preview/admin/quota` | 策略表单、影响预览、历史、冲突错误 |
| `/admin?tab=download` | `/design-preview/admin/download` | 下载配置、校验错误、保存成功 |
| `/admin?tab=doubao` | `/design-preview/admin/doubao` | Session 正常、失效、扫码 |
| `/admin?tab=diagnostics` | `/design-preview/admin/diagnostics` | 正常、警告、错误 |
| `/admin/preview/[code]` | `/design-preview/admin/share-preview` | 管理员 Banner、就绪、过期、错误 |

### 第三批：内容页

| 正式路由 | Preview | 模板 |
|----------|---------|------|
| `/about` | `/design-preview/content/about` | 品牌内容模板 |
| `/contact` | `/design-preview/content/contact` | 联系模板 |
| `/security` | `/design-preview/content/security` | 长内容与说明模板 |
| `/how-it-works` | `/design-preview/content/how-it-works` | 步骤内容模板 |
| `/large-file-transfer` | `/design-preview/content/large-file-transfer` | SEO 内容模板 |
| `/no-signup-file-sharing` | `/design-preview/content/no-signup-file-sharing` | SEO 内容模板 |
| `/receive-files` | `/design-preview/content/receive-files` | SEO 内容模板 |
| `/wechat-large-file` | `/design-preview/content/wechat-large-file` | SEO 内容模板 |
| `/privacy` | `/design-preview/content/privacy` | 法律阅读模板 |
| `/terms` | `/design-preview/content/terms` | 法律阅读模板 |
| `/updates` | `/design-preview/content/updates` | 加载、空、时间线、错误、移动端 |
| `404` | `/design-preview/content/not-found` | 错误页模板 |

内容页允许复用模板，但必须让每个正式路由使用自己的真实标题、段落长度和页面结构接受审阅，不能只审阅一个通用占位页。

## 12. Review Gates and Acceptance

### 每批审阅流程

1. 完成该批 Preview，不修改正式页面。
2. 运行桌面和移动端响应式检查、键盘检查和基础可访问性检查。
3. 向用户列出每个页面的待确认项，不替用户选择。
4. 用户可以逐页标记“通过”“修改后再看”“拒绝此方向”。
5. 只有该批所有页面明确通过，才开始下一批。
6. 三批 Preview 全部通过后，再单独确认生产迁移顺序和发布策略。

### 视觉验收

- 5 秒观察时，第一注意点与页面主任务一致。
- 缩小或模糊页面后，仍能区分导航、主任务、次要信息和状态反馈。
- 同一套界面放入作业 PDF、摄影成片和商务合同后均无明显场景冲突。
- 页面不依赖 Logo、品牌色或装饰动画才能形成层级。

### 可访问性验收

- 正常文字对比度不低于 `4.5:1`，大文字和必要图形不低于 `3:1`。
- 控件焦点可见，焦点指示与相邻颜色不低于 `3:1`。
- 状态不只用颜色表达。
- 主要触控目标不小于 `44 × 44px`。
- 支持键盘、200% 缩放、长文本和 `prefers-reduced-motion`。
- 动画仅使用 `opacity` 与 `transform`，没有不可暂停的持续装饰运动。

### Preview 完成不代表生产授权

Preview 获得通过，只代表视觉和交互方向可以进入迁移评估。生产代码修改、Logo 资产替换、数据接口接入和上线仍需用户分别明确授权。
