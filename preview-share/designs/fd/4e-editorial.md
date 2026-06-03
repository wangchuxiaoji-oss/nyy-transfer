# DESIGN.md — Plan 4E · Editorial Magazine

> 一份像《纽约客》跨页的取件单 — 大字号标题、衬线、不对称布局、橙色是一段斜体引言。

## 1. Visual Theme & Atmosphere

**Style**: Editorial / Magazine
**Keywords**: serif, asymmetric, drop-cap, large-quote, dramatic, magazine-spread, journalistic
**Tone**: 像翻一本 200 页的纸质杂志 — 信息分级清晰,主图很大,文字有节奏。NOT sterile, NOT generic, NOT minimal
**Feel**: 提取码是杂志封面的斜体大字,文件大小是 3pt 的小标注在角落

**Interaction Tier**: L1 (精致静态)
**Dependencies**: CSS only

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 米白纸 */
  --bg: #F5F1E8;                         /* 米色纸张 */
  --surface: #FFFFFF;
  --surface-alt: #FAF5E9;
  --surface-hover: #FBF5E6;
  --surface-dark: #1A1814;                /* 反色色块 */

  /* Borders */
  --border: rgba(26, 24, 20, 0.15);
  --border-strong: #1A1814;
  --border-hover: var(--accent);

  /* Text — 暖深棕黑, 不是纯黑 */
  --text: #1A1814;
  --text-secondary: #4A4540;
  --text-tertiary: #8A857F;
  --text-inverse: #F5F1E8;

  /* Accent — 标题橙(像杂志高亮笔) */
  --accent: #FF8A3D;
  --accent-hover: #E8762E;
  --accent-soft: rgba(255, 138, 61, 0.15);
  --accent-highlight: rgba(255, 138, 61, 0.3);  /* 高亮笔效果 */

  /* Editorial details */
  --rule: #1A1814;                        /* 1px 实线分隔 */

  /* Semantic */
  --success: #2D5F4E;
  --error: #8B2C1A;
  --warning: #B8860B;
}
```

**Color Rules:**
1. 米白纸色为底,文字暖深棕黑(不是纯黑)
2. 橙色 1% 出现率,只在标题、引言、关键数据
3. 黑色实线 (`1px solid #1A1814`) 用作分隔规则
4. 不用阴影,用 hairline border + 反色块制造层次

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,700;0,9..144,900;1,9..144,400;1,9..144,500&family=Inter:wght@300;400;500;600&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 (Headline) | Fraunces (italic) | 88px | 700 italic | 0.95 | -0.03em |
| Section H2 | Fraunces | 36px | 500 | 1.1 | -0.02em |
| H3 | Fraunces (italic) | 22px | 500 italic | 1.2 | -0.01em |
| Body | Inter | 16px | 400 | 1.7 | 0 |
| Lead (大段引言) | Fraunces (italic) | 20px | 400 italic | 1.5 | 0 |
| Label | Inter | 10px | 600 | 1.0 | 0.2em (uppercase) |
| Drop Cap | Fraunces (italic) | 96px | 900 italic | 0.85 | -0.04em |
| File Name | Fraunces | 18px | 500 | 1.3 | 0 |
| Big Key | Fraunces (italic) | 56px | 700 italic | 1.0 | -0.02em |

**Typography Rules:**
- Display H1 用 Fraunces italic 700(衬线斜体 = 杂志头条)
- 第一段首字用 drop cap (96px italic)
- 提取码用 Fraunces italic 56px(当作 hero 处理)
- Body 用 Inter 16px / line-height 1.7(阅读舒适)
- **NEVER use**: Roboto, Arial, system-ui, sans-serif display

**Text Decoration:**
- H1: 无渐变、无投影(克制)
- 关键引用: `linear-gradient(transparent 60%, var(--accent-highlight) 60%)` 做高亮笔

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Inter', sans-serif;
  font-weight: 500;
  font-size: 14px;
  letter-spacing: 0.05em;
  padding: 16px 32px;
  background: var(--text);
  color: var(--text-inverse);
  border: 1px solid var(--text);
  border-radius: 0;
  cursor: pointer;
  position: relative;
  transition: background 0.3s ease, color 0.3s ease;
}
.btn::before {
  content: '→';
  margin-right: 12px;
  font-family: 'Fraunces', serif;
  font-style: italic;
}
.btn:hover {
  background: var(--accent);
  color: var(--text);
  border-color: var(--accent);
}
.btn-primary {
  background: var(--accent);
  color: var(--text);
  border-color: var(--accent);
}
.btn-primary:hover {
  background: var(--text);
  color: var(--text-inverse);
  border-color: var(--text);
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
  padding: 32px;
  position: relative;
  transition: border-color 0.3s ease;
}
.card::before {
  content: '';
  position: absolute; top: 0; left: 0;
  width: 0; height: 100%;
  background: var(--accent-soft);
  z-index: 0;
  transition: width 0.4s ease;
}
.card > * { position: relative; z-index: 1; }
.card:hover { border-color: var(--text); }
.card:hover::before { width: 100%; }
```

### Navigation
```css
.topbar {
  background: var(--bg);
  border-bottom: 1px solid var(--rule);
  padding: 24px 48px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
}
.brand {
  font-family: 'Fraunces', serif;
  font-weight: 700;
  font-style: italic;
  font-size: 32px;
  letter-spacing: -0.02em;
  color: var(--text);
}
.brand::before {
  content: '— ';
  color: var(--accent);
}
```

### Links
```css
.link {
  color: var(--text);
  text-decoration: none;
  font-style: italic;
  font-family: 'Fraunces', serif;
  border-bottom: 1px solid currentColor;
}
.link:hover { color: var(--accent); }
```

### Tags / Badges
```css
.badge {
  font-family: 'Inter', sans-serif;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 4px 0;
  background: transparent;
  color: var(--text-tertiary);
  border-bottom: 1px solid var(--text-tertiary);
}
.badge.accent {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
```

### File Row (Editorial Style)
```css
.file-row {
  display: grid;
  grid-template-columns: 1fr 200px 80px;
  align-items: baseline;
  gap: 32px;
  padding: 32px 0;
  border-bottom: 1px solid var(--rule);
  cursor: pointer;
  transition: padding 0.3s ease, border-color 0.3s ease;
}
.file-row:hover {
  padding-left: 16px;
  border-bottom-color: var(--text);
}
.file-row .file-name {
  font-family: 'Fraunces', serif;
  font-size: 22px;
  font-weight: 500;
  font-style: italic;
  line-height: 1.2;
}
.file-row .file-meta {
  font-family: 'Inter', sans-serif;
  font-size: 11px;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-tertiary);
}
.file-row .file-size {
  font-family: 'Fraunces', serif;
  font-size: 18px;
  font-weight: 500;
  text-align: right;
  color: var(--accent);
}
.file-row.selected {
  background: var(--surface-dark);
  border-bottom-color: var(--surface-dark);
  padding: 32px 24px;
  margin: 0 -24px;
}
.file-row.selected .file-name { color: var(--text-inverse); }
.file-row.selected .file-meta { color: rgba(245, 241, 232, 0.6); }
```

### Modal
```css
.modal {
  position: fixed; inset: 0;
  background: var(--bg);
  z-index: 100;
  display: flex;
  flex-direction: column;
  animation: fade 0.5s ease;
}
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
```

## 5. Layout Principles

**Container:**
- Max width: 1320px
- Padding: 48-80px(留白敢给)

**Spacing Scale:**
- Section gap: 64-96px
- Component gap: 24-32px
- Card padding: 32-48px

**Grid (Asymmetric):**
- L0: 居中 760px,头部 80% / 摘要 60%(不对齐)
- L1: 2 列 65/35(不是 50/50)
- L2: 3 列 50/25/25
- L3: 缩略图 grid 4-5 列,带数字标签

**Baseline Grid:** 8px baseline,所有 margin/padding 8 的倍数

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | 无 | 99% 场景 |
| Hairline | `1px solid #1A1814` | 分隔规则 |
| Reverse | `background: #1A1814` | 选中文件、CTA 反色 |
| Highlight | `linear-gradient(transparent 60%, rgba(orange, 0.3) 60%)` | 关键文字 |
| Overlap | 元素故意溢出/叠加 | hero 区"大标题压图" |

**核心:不用阴影。用 hairline + 反色块 + 元素叠加 制造层次**

## 7. Animation & Interaction

**Motion Philosophy**: 0.4-0.6s ease,慢节奏,文字 "letter-spacing" 收紧入场,0.4s ease。
**Tier**: L1

### Entrance Animation
```css
@keyframes editorial-in {
  from { opacity: 0; transform: translateY(24px); }
  to { opacity: 1; transform: translateY(0); }
}
.reveal { animation: editorial-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.1s; }
.reveal:nth-child(3) { animation-delay: 0.2s; }
.reveal:nth-child(4) { animation-delay: 0.3s; }
```

### Hover State
- 列表项 hover: 左 padding 16px(0.3s)
- 链接 hover: 颜色 0.3s 渐变
- 卡片 hover: 橙色高亮背景从左滑入(0.4s)

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

## 8. Do's and Don'ts

### Do
- Display 字号 ≥ 64px,衬线 italic
- 大量留白,padding 48-80px
- 不对称布局(60/40 而非 50/50)
- 1px 实线作分隔(不用卡片阴影)
- 关键文字用高亮笔效果
- 文件名 Fraunces italic 22px
- 提取码 Fraunces italic 56px(hero 级别)

### Don't
- ❌ 不用 Inter/Roboto/system-ui 做标题
- ❌ 不用纯白实色
- ❌ 不用 box-shadow
- ❌ 不用纯黑文字(用 #1A1814 暖深棕黑)
- ❌ 不用 border-radius > 0(直角编辑感)
- ❌ 不用粗体 > 700
- ❌ 不用 emoji/icon 装饰
- ❌ 不用彩色背景
- ❌ 不用 transition < 0.3s

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | 1300px, 不对称双列, padding 48px |
| Tablet | 640-1023 | 720px, 单列, padding 32px |
| Mobile | < 640 | 100% - 32px, 单列, 字号 -20% |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端取消 display 88px → 48px,取消 drop cap,改单列

```css
@media (max-width: 1023px) {
  .topbar { padding: 16px 24px; grid-template-columns: 1fr 1fr; }
  .file-row { grid-template-columns: 1fr 100px; gap: 16px; }
  .display-h1 { font-size: 56px; }
}
@media (max-width: 639px) {
  .topbar { padding: 12px 16px; }
  .file-row { grid-template-columns: 1fr; gap: 8px; padding: 24px 0; }
  .file-row .file-size { text-align: left; }
  .display-h1 { font-size: 40px; }
  .drop-cap { display: none; }
  .lead { font-size: 18px; }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: #1A1814;
  --surface: #2A2722;
  --surface-alt: #3A3631;
  --border: rgba(245, 241, 232, 0.15);
  --rule: #F5F1E8;
  --text: #F5F1E8;
  --text-secondary: #C8C0B0;
  --text-tertiary: #8A857F;
  --text-inverse: #1A1814;
  --surface-dark: #F5F1E8;
  --accent: #FF8A3D;
}
```
