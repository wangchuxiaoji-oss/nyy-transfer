# DESIGN.md — Plan 5C · Swiss Grid

> 一份"包豪斯走廊海报"的取件单 — 黑白严格网格、Inter 字体、橙色是唯一的红色"色标"。

## 1. Visual Theme & Atmosphere

**Style**: 瑞士设计(Seed #9) + nyy 橙主色
**Keywords**: 网格、规则、理性、黑白、严谨、不对称、信息层级
**Tone**: 包豪斯学校走廊的海报。NOT 装饰、NOT 圆润、NOT 渐变
**Feel**: 提取码是 12px Helvetica Black 数字放在 64px 的 grid 上,旁边是橙色色标

**Interaction Tier**: L1 (精致静态)
**Dependencies**: CSS only

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 纯白 / 纯黑 */
  --bg: #FFFFFF;
  --surface: #F5F5F5;
  --surface-alt: #000000;                /* 反色 */
  --surface-hover: #FAFAFA;

  /* Borders — 粗实线, 黑色 */
  --border: #000000;
  --border-soft: #E0E0E0;
  --border-hover: var(--accent);

  /* Text */
  --text: #000000;
  --text-secondary: #333333;
  --text-tertiary: #777777;
  --text-inverse: #FFFFFF;

  /* Accent — 替代红色: nyy 橙 */
  --accent: #FF8A3D;                      /* 唯一强调色 */
  --accent-hover: #E8762E;
  --accent-block: #FF8A3D;                /* 整块橙用作色标 */

  /* Grid marks */
  --grid-line: rgba(0, 0, 0, 0.04);

  /* Semantic */
  --success: #00A86B;
  --error: #DC143C;
  --warning: #FF8A3D;
}
```

**Color Rules:**
1. 99% 黑 + 白 + 灰,1% 橙色。橙只用于: 提取码、CTA、当前选中、状态指示
2. 黑色用 1px / 2px 实线代替阴影
3. 网格线 4% 黑色(几乎不可见,只在严格 grid 上)
4. 不用任何颜色 background,只有黑/白/灰

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;700&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Inter | 80px | 900 | 0.95 | -0.04em |
| Section H2 | Inter | 32px | 700 | 1.0 | -0.03em |
| H3 | Inter | 18px | 600 | 1.2 | -0.01em |
| Body | Inter | 14px | 400 | 1.5 | 0 |
| Label | Inter | 10px | 700 | 1.0 | 0.15em (uppercase) |
| Mono/Key | JetBrains Mono | 32px | 700 | 1.0 | 0 |
| Big Number | Inter | 120px | 900 | 0.9 | -0.05em |

**Typography Rules:**
- Inter 全家族用作 display / body / label(瑞士设计的字体选择)
- H1 用 900,120px,line-height 0.95(超大字重,字距收紧)
- 提取码用 JetBrains Mono 32px 700
- **NEVER use**: Roboto, Arial, system-ui, serif, decorative
- 中文混排: Noto Sans SC, weight 700

**Text Decoration:**
- H1: 无装饰,纯字重说话
- 数字: 用 120px 巨字 + 极紧字距
- 关键术语: 整段反色 (background: black, color: white)

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Inter', sans-serif;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 18px 32px;
  background: #000000;
  color: #FFFFFF;
  border: 1px solid #000000;
  border-radius: 0;
  cursor: pointer;
  transition: background 0.2s ease, color 0.2s ease;
}
.btn:hover {
  background: var(--accent);
  color: #000000;
  border-color: var(--accent);
}
.btn-primary {
  background: var(--accent);
  color: #000000;
  border-color: var(--accent);
}
.btn-primary:hover {
  background: #000000;
  color: var(--accent);
  border-color: #000000;
}
.btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

### Cards
```css
.card {
  background: var(--surface);
  border: 1px solid #000000;
  padding: 24px;
  transition: background 0.2s ease, border-color 0.2s ease;
}
.card:hover {
  background: #FFFFFF;
  border-width: 2px;
  padding: 23px; /* 抵消 border 增厚 */
}
.card.selected {
  background: var(--accent);
  border-color: #000000;
}
```

### Navigation
```css
.topbar {
  background: #FFFFFF;
  border-bottom: 2px solid #000000;
  padding: 16px 32px;
  display: grid;
  grid-template-columns: 200px 1fr auto;
  gap: 32px;
  align-items: center;
}
.brand {
  font-family: 'Inter', sans-serif;
  font-weight: 900;
  font-size: 20px;
  letter-spacing: -0.02em;
  color: #000000;
  text-transform: uppercase;
}
```

### Links
```css
.link {
  color: #000000;
  text-decoration: none;
  border-bottom: 1px solid #000000;
  padding-bottom: 1px;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.link:hover {
  color: var(--accent);
  border-color: var(--accent);
}
```

### Tags / Badges
```css
.badge {
  font-family: 'Inter', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 4px 8px;
  background: #000000;
  color: #FFFFFF;
  border-radius: 0;
}
.badge.accent {
  background: var(--accent);
  color: #000000;
}
```

### File Row
```css
.file-row {
  display: grid;
  grid-template-columns: 64px 1fr 140px 100px 40px;
  align-items: stretch;     /* 整高对齐 */
  gap: 0;
  background: #FFFFFF;
  border: 1px solid #000000;
  margin-bottom: -1px;       /* 共享边框 */
  cursor: pointer;
  transition: background 0.2s ease;
}
.file-row > * {
  padding: 16px 20px;
  border-right: 1px solid #000000;
  display: flex;
  align-items: center;
}
.file-row > *:last-child { border-right: none; }
.file-row:hover { background: #F5F5F5; }
.file-row .file-size {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 14px;
  justify-content: flex-end;
  color: var(--accent);
}
.file-row.selected { background: var(--accent); }
.file-row.selected > * { color: #000000; }
```

### Modal
```css
.modal {
  position: fixed; inset: 0;
  background: #FFFFFF;
  border: 4px solid #000000;
  z-index: 100;
  display: flex;
  animation: modal-in 0.3s steps(8);
}
@keyframes modal-in { from { opacity: 0; } to { opacity: 1; } }
```

## 5. Layout Principles

**Container:**
- Max width: 1280px
- Padding: 32px

**Spacing Scale (8px baseline):**
- Section gap: 48px
- Component gap: 16px
- Card padding: 24px

**Grid (Strict 12-column):**
- 桌面: 12 列 grid,gutter 16px
- L0: 居中 8 列
- L1: 7/5
- L2: 4/8
- L3: grid 4 列缩略图

**Baseline:** 8px baseline,所有 margin/padding 4 或 8 的倍数

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | 无 | 99% 场景 |
| Hairline | `1px solid #000000` | 默认边框 |
| Heavy | `2px solid #000000` | hover 态、标题下 |
| Reverse | `background: #000000; color: #FFFFFF` | 选中、CTA |

**核心:用 1-2px 黑色实线代替阴影,层次由"线粗"和"反色"制造**

## 7. Animation & Interaction

**Motion Philosophy**: 0.2s linear/ease,极快,无弹性,理性。L1 档。
**Tier**: L1

### Entrance Animation
```css
@keyframes swiss-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.reveal { animation: swiss-in 0.4s ease both; }
.reveal:nth-child(2) { animation-delay: 0.05s; }
.reveal:nth-child(3) { animation-delay: 0.1s; }
```

### Hover State
- 卡片 hover: 边框变 2px(即时 0.2s)
- 文件行 hover: 灰底(0.2s)
- 按钮 hover: 颜色反转(0.2s)

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- 严格 12 列 grid
- Inter 900 用于 H1(80-120px)
- 黑色实线 (1-2px) 代替阴影
- 反色 (bg: black) 用于 CTA
- 橙色 1% 出现,只用 1-2 处
- 8px baseline 间距
- Label 用 UPPERCASE + 0.15em letter-spacing
- 列表项用 1px 实线 + 共享边框

### Don't
- ❌ 不用 border-radius(全 0)
- ❌ 不用 box-shadow
- ❌ 不用渐变
- ❌ 不用 Roboto / Arial / system-ui
- ❌ 不用装饰性元素(icon 装饰、ribbon)
- ❌ 不用 emoji
- ❌ 不用 sans-serif 之外字体
- ❌ 不用半透明
- ❌ 不用 cubic-bezier(用 linear/ease)

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | 12 列 grid, padding 32px |
| Tablet | 640-1023 | 8 列 grid, padding 24px |
| Mobile | < 640 | 4 列 grid, padding 16px |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端列数减半,字号 -25%

```css
@media (max-width: 1023px) {
  .topbar { grid-template-columns: 1fr auto; padding: 12px 24px; }
  .file-row { grid-template-columns: 48px 1fr 80px 32px; }
  .display-h1 { font-size: 56px; }
}
@media (max-width: 639px) {
  .topbar { padding: 12px 16px; }
  .file-row { grid-template-columns: 32px 1fr 32px; }
  .display-h1 { font-size: 36px; }
  .big-number { font-size: 72px; }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: #000000;
  --surface: #0A0A0A;
  --surface-alt: #FFFFFF;
  --border: #FFFFFF;
  --border-soft: #2A2A2A;
  --text: #FFFFFF;
  --text-secondary: #C8C8C8;
  --text-tertiary: #888888;
  --text-inverse: #000000;
  --accent: #FF8A3D;
}
```
