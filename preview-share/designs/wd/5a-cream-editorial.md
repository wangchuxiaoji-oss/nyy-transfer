# DESIGN.md — Plan 5A · Cream Editorial

> 一份"像翻一本 200 页纸质杂志"的取件单 — 奶油底、Playfair 大字、橙色是"段落高亮笔"。

## 1. Visual Theme & Atmosphere

**Style**: 奶油编辑(Seed #1) + nyy 橙主色
**Keywords**: 温暖、编辑感、杂志、克制、纸质感、衬线、高亮笔
**Tone**: 排版精良的杂志在屏幕上展开。NOT 数字冷漠, NOT 纯白, NOT 几何精确
**Feel**: 像翻到 124 页那篇特稿,大标题用 Playfair 900,正文用 DM Sans,橙色像编辑用荧光笔画过关键句

**Interaction Tier**: L1 (精致静态)
**Dependencies**: CSS only

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 奶油米 */
  --bg: #ECE7DE;                          /* 暖奶油(主) */
  --surface: #FFFFFF;                     /* 卡片白 */
  --surface-alt: #F5F0E5;                 /* 浅奶油 */
  --surface-hover: #F8F2E5;

  /* Borders */
  --border: #D5D0C7;                      /* 暖灰 */
  --border-hover: var(--accent);
  --border-strong: #2A2A2A;

  /* Text */
  --text: #1A1A1A;
  --text-secondary: #6B6560;
  --text-tertiary: #9A8E80;
  --text-inverse: #ECE7DE;

  /* Accent — nyy 橙作为"高亮笔" */
  --accent: #FF8A3D;                      /* 主橙 */
  --accent-hover: #E8762E;
  --accent-soft: rgba(255, 138, 61, 0.12);
  --accent-highlight: rgba(255, 138, 61, 0.35);

  /* Editorial */
  --rule: #2A2A2A;                        /* 1px 实线 */

  /* Semantic */
  --success: #2D5F4E;
  --error: #8B2C1A;
  --warning: #B8860B;
}
```

**Color Rules:**
1. 奶油米为底,卡片白为表面,形成"印刷品"质感
2. 橙色仅用于: 提取码、关键数据、CTA、当前选中(像荧光笔)
3. 不用阴影,只用 1px 暖灰 border + 偶尔 1px 黑色实线
4. 文字"高亮笔"效果: `linear-gradient(transparent 60%, var(--accent-highlight) 60%)`

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;700&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Playfair Display | 72px | 900 | 1.0 | -0.03em |
| Section H2 | Playfair Display | 32px | 700 | 1.1 | -0.02em |
| H3 | Playfair Display (italic) | 22px | 700 italic | 1.2 | -0.01em |
| Body | DM Sans | 16px | 400 | 1.7 | 0 |
| Label | DM Sans | 11px | 700 | 1.0 | 0.15em (uppercase) |
| Mono/Key | JetBrains Mono | 28px | 700 | 1.0 | 0.05em |

**Typography Rules:**
- Playfair Display 900 用作 H1 数字(杂志头条)
- 提取码用 Playfair Display italic 32px + 橙色高亮笔
- Body 用 DM Sans 16px / 1.7(阅读舒适)
- **NEVER use**: Inter, Roboto, Arial, system-ui, sans-serif display
- 中文混排: Noto Serif SC + Noto Sans SC

**Text Decoration:**
- H1: 无渐变、无投影
- 提取码: linear-gradient 高亮笔效果
- 关键术语: italic + 高亮笔

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'DM Sans', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 16px 32px;
  background: #1A1A1A;
  color: #FFFFFF;
  border: 1px solid #1A1A1A;
  border-radius: 0;
  cursor: pointer;
  transition: background 0.3s ease, color 0.3s ease;
}
.btn:hover {
  background: var(--accent);
  color: #1A1A1A;
  border-color: var(--accent);
}
.btn-primary {
  background: var(--accent);
  color: #1A1A1A;
  border-color: var(--accent);
}
.btn-primary:hover {
  background: #1A1A1A;
  color: var(--accent);
  border-color: #1A1A1A;
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
  border: 1px solid var(--border);
  padding: 28px;
  transition: border-color 0.3s ease, transform 0.3s ease;
}
.card:hover {
  border-color: #2A2A2A;
  transform: translateY(-2px);
}
.card.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
}
```

### Navigation
```css
.topbar {
  background: var(--bg);
  border-bottom: 1px solid #2A2A2A;
  padding: 24px 48px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.brand {
  font-family: 'Playfair Display', serif;
  font-weight: 900;
  font-size: 32px;
  letter-spacing: -0.02em;
  color: var(--text);
}
```

### Links
```css
.link {
  color: var(--text);
  text-decoration: none;
  background: linear-gradient(transparent 60%, var(--accent-highlight) 60%);
  padding: 0 2px;
  transition: background-size 0.3s ease;
}
.link:hover {
  background: linear-gradient(transparent 30%, var(--accent-highlight) 30%);
}
```

### Tags / Badges
```css
.badge {
  font-family: 'DM Sans', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 4px 8px;
  background: var(--accent-soft);
  color: var(--text);
  border-radius: 0;
}
.badge.accent {
  background: var(--accent);
}
```

### File Row
```css
.file-row {
  display: grid;
  grid-template-columns: 48px 1fr 160px 100px 40px;
  align-items: center;
  gap: 24px;
  padding: 24px 0;
  border-bottom: 1px solid #2A2A2A;
  cursor: pointer;
  transition: background 0.3s ease, padding 0.3s ease;
}
.file-row:hover {
  padding-left: 12px;
  background: var(--surface-alt);
}
.file-row .file-name {
  font-family: 'Playfair Display', serif;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.2;
}
.file-row .file-size {
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  font-weight: 700;
  text-align: right;
  color: var(--accent);
}
.file-row.selected {
  background: var(--accent-soft);
  border-bottom-color: var(--accent);
  border-bottom-width: 2px;
}
```

### Modal
```css
.modal {
  position: fixed; inset: 32px;
  background: var(--bg);
  border: 1px solid #2A2A2A;
  z-index: 100;
  display: flex;
  flex-direction: column;
  animation: fade-in 0.4s ease;
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
```

## 5. Layout Principles

**Container:**
- Max width: 1200px
- Padding: 48px(桌面)

**Spacing Scale:**
- Section gap: 64px
- Component gap: 24px
- Card padding: 28-32px

**Grid:**
- L0: 居中 720px,头部 hero 80%,摘要 60%(留白多)
- L1: 2 列 60/40
- L2: 列表 320px + 主区 1fr
- L3: 缩略图 grid 3-4 列

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | 无 | 99% 场景 |
| Hairline | `1px solid #D5D0C7` | 默认分隔 |
| Rule | `1px solid #2A2A2A` | 主要分隔(像杂志规则线) |
| Highlight | `linear-gradient(transparent 60%, orange 60%)` | 关键文字 |

**核心:印刷品质感,不用阴影,只用 1px 规则线 + 高亮笔**

## 7. Animation & Interaction

**Motion Philosophy**: 0.3-0.4s ease,慢节奏,"翻页"的感觉。L1 档。
**Tier**: L1

### Entrance Animation
```css
@keyframes editorial-fade {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
.reveal { animation: editorial-fade 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.1s; }
.reveal:nth-child(3) { animation-delay: 0.2s; }
```

### Hover State
- 文件行 hover: 左 padding 12px(像翻页偏移)
- 链接 hover: 高亮笔高度从 60% 变 30%
- 按钮 hover: 颜色反转(0.3s)

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- Playfair Display 900 / 700 italic 用于 H1 / 提取码
- DM Sans 400 用于正文(行高 1.7)
- 1px 暖灰 border 默认,1px 黑色实线重要分隔
- 橙色作"高亮笔"效果,不用作填色
- 大量留白,padding ≥ 48px
- 文件名 Playfair Display 20px

### Don't
- ❌ 不用 Inter / Roboto / Arial
- ❌ 不用 border-radius > 0
- ❌ 不用 box-shadow
- ❌ 不用粗体 > 700
- ❌ 不用 sans-serif display
- ❌ 不用渐变(包括按钮)
- ❌ 不用蓝色/绿色
- ❌ 不用 emoji
- ❌ 不用彩色 background

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | padding 48px, 60/40 双列 |
| Tablet | 640-1023 | padding 32px, 单列堆叠 |
| Mobile | < 640 | padding 20px, 文件行简化 |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端字号 -20%,padding 减半

```css
@media (max-width: 1023px) {
  .topbar { padding: 20px 32px; }
  .file-row { grid-template-columns: 32px 1fr 100px 32px; }
  .display-h1 { font-size: 48px; }
}
@media (max-width: 639px) {
  .topbar { padding: 16px 20px; }
  .file-row { grid-template-columns: 24px 1fr 32px; padding: 16px 0; }
  .display-h1 { font-size: 36px; }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: #1A1814;
  --surface: #2A2722;
  --surface-alt: #3A3631;
  --border: rgba(236, 231, 222, 0.2);
  --border-strong: #ECE7DE;
  --text: #ECE7DE;
  --text-secondary: #B8B0A0;
  --text-tertiary: #7A7268;
  --text-inverse: #1A1814;
  --rule: #ECE7DE;
  --accent: #FF8A3D;
  --accent-soft: rgba(255, 138, 61, 0.15);
  --accent-highlight: rgba(255, 138, 61, 0.3);
}
```
