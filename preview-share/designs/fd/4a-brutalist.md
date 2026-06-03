# DESIGN.md — Plan 4A · Brutalist Industrial

> 一份"打印出来贴在工地"的取件单 — 粗野、诚实、零修饰,把"这是什么"喊到最大声。

## 1. Visual Theme & Atmosphere

**Style**: Brutalist Industrial
**Keywords**: raw, honest, loud, grid-locked, mono, exposed, structural, no-decoration
**Tone**: 一座工业厂房里的取件看板 — 信息密度大、字号反差强、橙是工地警戒色。NOT pretty, NOT soft, NOT polite
**Feel**: 拿到取件码 → 知道文件大小 → 拿 → 走。无废话

**Interaction Tier**: L1 (精致静态)
**Dependencies**: CSS only (no JS framework, no animation library)

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — pure + off-white */
  --bg: #F4F1EC;                          /* 牛皮纸色工地背景 */
  --surface: #FFFFFF;                     /* 卡片白 */
  --surface-alt: #000000;                 /* 反色: 信息块用黑底 */
  --surface-hover: #FFFAF2;

  /* Borders — 粗实线, 黑色 */
  --border: #000000;
  --border-hover: #FF8A3D;
  --border-soft: rgba(0,0,0,0.15);

  /* Text */
  --text: #0A0A0A;
  --text-secondary: #3A3A3A;
  --text-tertiary: #707070;
  --text-inverse: #FFFFFF;

  /* Accent — 唯一: 警戒橙 */
  --accent: #FF8A3D;
  --accent-hover: #E8762E;
  --accent-on-light: #FF8A3D;
  --accent-on-dark: #FF8A3D;

  /* Semantic */
  --success: #2D7A2D;
  --error: #C73E1D;
  --warning: #FF8A3D;
}
```

**Color Rules:**
1. 黑白橙三色 — 没有第四种颜色。灰阶只用于次要文字
2. 强边框 (`2-3px solid black`) 是核心视觉语言,代替阴影
3. 橙色 ONLY 用于: 提取码、CTA、文件大小数字、当前选中状态

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700;800&family=Space+Grotesk:wght@500;700&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Page Title | Space Grotesk | 48px | 700 | 1.0 | -0.03em |
| Section H2 | Space Grotesk | 24px | 700 | 1.0 | -0.02em |
| File Name | JetBrains Mono | 16px | 500 | 1.3 | -0.01em |
| Code/Key | JetBrains Mono | 14px | 700 | 1.0 | 0.05em (uppercase) |
| Body | Space Grotesk | 14px | 500 | 1.5 | 0 |
| Label | JetBrains Mono | 11px | 700 | 1.0 | 0.1em (uppercase) |
| Big Number | Space Grotesk | 72px | 800 | 1.0 | -0.04em |

**Typography Rules:**
- Heading weight ≥ 700
- 所有"标签"用 JetBrains Mono + UPPERCASE + 0.1em letter-spacing
- 文件大小、提取码等数字 → 用 Space Grotesk 800,大字号
- **NEVER use**: Inter, Roboto, Arial, system-ui, serif

**Text Decoration:**
- H1: 无渐变、无投影(粗野风不装饰)
- 数字: 无 (用字重 + 字号说话)

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  padding: 16px 28px;
  background: var(--accent);
  color: var(--text);
  border: 2px solid var(--border);
  border-radius: 0;
  box-shadow: 4px 4px 0 0 var(--border);
  transition: transform 0.1s, box-shadow 0.1s;
  cursor: pointer;
}
.btn:hover {
  background: var(--accent-hover);
  transform: translate(-2px, -2px);
  box-shadow: 6px 6px 0 0 var(--border);
}
.btn:active {
  transform: translate(2px, 2px);
  box-shadow: 0 0 0 0 var(--border);
}
.btn:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}
.btn:disabled {
  background: var(--text-tertiary);
  border-color: var(--text-tertiary);
  color: var(--bg);
  cursor: not-allowed;
  box-shadow: 4px 4px 0 0 var(--text-tertiary);
}
```

### Cards
```css
.card {
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: 0;
  box-shadow: 6px 6px 0 0 var(--border);
  padding: 24px;
  transition: transform 0.1s, box-shadow 0.1s;
}
.card:hover {
  transform: translate(-2px, -2px);
  box-shadow: 8px 8px 0 0 var(--border);
}
.card.selected {
  background: var(--accent);
}
```

### Navigation (Top Bar)
```css
.topbar {
  background: var(--surface);
  border-bottom: 3px solid var(--border);
  padding: 16px 32px;
  display: flex;
  align-items: center;
  gap: 24px;
}
```

### Links
```css
.link {
  color: var(--text);
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 4px;
  text-decoration-color: var(--accent);
}
.link:hover {
  text-decoration-color: var(--border);
}
```

### Tags / Badges
```css
.badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.15em;
  padding: 4px 8px;
  background: var(--text);
  color: var(--text-inverse);
  border-radius: 0;
}
.badge.accent { background: var(--accent); color: var(--text); }
```

### File Row (List)
```css
.file-row {
  display: grid;
  grid-template-columns: 56px 1fr 120px 80px 40px;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  border: 2px solid var(--border);
  background: var(--surface);
  margin-bottom: -2px; /* 共享边框 */
  cursor: pointer;
}
.file-row:hover {
  background: var(--surface-hover);
}
.file-row.selected {
  background: var(--accent);
}
.file-row.selected .file-name { font-weight: 800; }
```

### Modal
```css
.modal {
  position: fixed; inset: 0;
  background: var(--bg);
  border: 4px solid var(--border);
  z-index: 100;
  display: flex;
}
.modal-content { flex: 1; padding: 0; }
```

## 5. Layout Principles

**Container:**
- Max width: 1280px
- Padding: 32px
- 桌面留白 64px(左右)

**Spacing Scale:**
- Section gap: 0px(用 border 分隔,不用 margin)
- Component gap: 0px(用 stacked borders)
- Card internal padding: 24px

**Grid:**
- 桌面: 左 320px(文件列表)/ 右 1fr(主区) — 直角分割
- L0(单文件):全宽播放器,无侧栏
- L3(16+):grid 4 列,无 padding

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | 无阴影 | 默认 |
| Subtle | `4px 4px 0 0 black` | 默认卡片 |
| Elevated | `6px 6px 0 0 black` | hover 卡片 |
| Modal | `inset 0 0 0 4px black` 边框 | 模态框 |

**核心:用硬阴影(0 模糊)代替软阴影,阴影是结构,不是装饰**

## 7. Animation & Interaction

**Motion Philosophy**: 0 缓动,直接反应 — 200ms 内完成,无 ease-out。L1 档。
**Tier**: L1

### Entrance Animation
```css
@keyframes hard-in {
  from { opacity: 0; transform: translate(-8px, -8px); }
  to { opacity: 1; transform: translate(0, 0); }
}
.reveal { animation: hard-in 0.3s steps(6) both; }
```

### Hover & Focus States
- 所有 hover: 同步移动 +2/-2 像素 + 阴影变大(0.1s)
- 所有 active: 反向移动 +2/+2 像素 + 阴影消失(0.1s)
- 不用 transition timing function,默认 `ease` 就够

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- 所有卡片有 2px 黑色实线边框
- 数字一律用 Space Grotesk 800
- CTA 用橙色 + 4px 黑色硬阴影
- 列表项用 stacked borders 共享分隔
- 文字 label 全用 UPPERCASE JetBrains Mono
- 间距用 4 的倍数: 8/12/16/24/32/48/64

### Don't
- ❌ 不用 border-radius(全 0)
- ❌ 不用 box-shadow 的模糊值
- ❌ 不用渐变(包括 hero/背景/按钮)
- ❌ 不用 serif 字体
- ❌ 不用 emoji
- ❌ 不用柔和色、莫兰迪色、马卡龙色
- ❌ 不用 transition 缓动函数(linear/ease 默认就行)
- ❌ 不用任何装饰性元素(icon 装饰、ribbon、星光)

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | 320+1fr 左右分栏,横向并列 |
| Tablet | 640-1023 | 单列堆叠,文件列表收缩 |
| Mobile | < 640 | 全宽,4px 边框变 2px,字号 -2px |

**Touch Targets:** minimum 48×48px(工业标准)
**Collapsing Strategy:** 移动端去除阴影(用粗边框),padding 减半

```css
@media (max-width: 1023px) {
  .topbar { padding: 12px 16px; }
  .file-row { grid-template-columns: 40px 1fr 80px 32px; }
  .card { box-shadow: 4px 4px 0 0 black; }
}
@media (max-width: 639px) {
  .card { box-shadow: none; }
  .btn { box-shadow: 2px 2px 0 0 black; }
  .page-title { font-size: 36px; }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: #0A0A0A;
  --surface: #1A1A1A;
  --border: #FFFFFF;
  --text: #FFFFFF;
  --text-inverse: #000000;
  --accent: #FF8A3D;
}
```
