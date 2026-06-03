# DESIGN.md — Plan 4B · Luxury Refined

> 一份装在丝绒盒子里的取件单 — 留白、衬线、橙色是那颗"宝石头",不滥用。

## 1. Visual Theme & Atmosphere

**Style**: Luxury / Refined
**Keywords**: serif, generous-spacing, deep-blacks, single-accent, slow, breathing, jewelry-box
**Tone**: 像走进一家只卖 5 款产品的精品店 — 安静、自信、克制。NOT busy, NOT dense, NOT playful
**Feel**: 提取码是一颗 1.5 克拉的宝石,放在黑色丝绒上,旁边是文件大小

**Interaction Tier**: L1 (精致静态)
**Dependencies**: CSS only

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 深黑 + 米白 */
  --bg: #FAF8F4;                         /* 暖米白 */
  --surface: #FFFFFF;
  --surface-alt: #0A0A0A;                /* 深黑, 极重要信息块用 */
  --surface-hover: #F5F0E8;

  /* Borders */
  --border: rgba(10, 10, 10, 0.12);
  --border-hover: var(--accent);
  --border-strong: #0A0A0A;

  /* Text — 深炭色而非纯黑 */
  --text: #1A1A1A;
  --text-secondary: #4A4A4A;
  --text-tertiary: #8A8A8A;
  --text-inverse: #FAF8F4;

  /* Accent — 唯一宝石橙 */
  --accent: #FF8A3D;
  --accent-hover: #E8762E;
  --accent-soft: rgba(255, 138, 61, 0.08);

  /* Semantic */
  --success: #2D5F4E;
  --error: #8B2C1A;
  --warning: #B8860B;
}
```

**Color Rules:**
1. 99% 黑白米 + 1% 橙。橙只用于: 提取码、CTA、当前选中态、文件大小数字
2. 黑色 `#0A0A0A` 仅用于 hero 数字 / 反色卡片 / logo mark
3. 不用阴影,只用 hairline border(`1px solid rgba(10,10,10,0.12)`)建立层次

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400&family=Inter:wght@300;400;500&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Cormorant Garamond (italic) | 64px | 500 italic | 1.05 | -0.02em |
| Section H2 | Cormorant Garamond | 32px | 500 | 1.15 | -0.01em |
| H3 | Cormorant Garamond | 20px | 500 | 1.3 | 0 |
| Body | Inter | 15px | 300 | 1.7 | 0 |
| Label | Inter | 11px | 500 | 1.0 | 0.25em (uppercase) |
| Mono/Code | Cormorant Garamond italic | 18px | 500 italic | 1.2 | 0 |
| Big Key | Cormorant Garamond (italic) | 48px | 500 italic | 1.0 | 0.05em |

**Typography Rules:**
- Display 字号用 italic 变体(衬线斜体 = 高级感)
- Body weight 用 300(轻盈)
- 提取码/文件大小 用 italic Cormorant 48px(当成"标题"处理)
- **NEVER use**: Inter (除 body), Roboto, Arial, system-ui, sans-serif heading
- 中英混排: 标题用 Cormorant(英), 中文用 Noto Serif SC

**Text Decoration:**
- H1: 无渐变、无投影(克制)
- 提取码数字: italic Cormorant 强调

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Inter', sans-serif;
  font-weight: 400;
  font-size: 14px;
  letter-spacing: 0.05em;
  padding: 18px 40px;
  background: var(--text);
  color: var(--text-inverse);
  border: 1px solid var(--text);
  border-radius: 0;
  cursor: pointer;
  transition: background 0.4s ease, color 0.4s ease, border-color 0.4s ease;
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
  color: var(--accent);
  border-color: var(--text);
}
.btn:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 4px;
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
  transition: border-color 0.4s ease, transform 0.4s ease;
}
.card:hover {
  border-color: var(--text);
  transform: translateY(-1px);
}
```

### Navigation
```css
.topbar {
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  padding: 28px 64px;
  display: flex;
  align-items: center;
  gap: 32px;
}
.brand {
  font-family: 'Cormorant Garamond', serif;
  font-size: 24px;
  font-style: italic;
  font-weight: 500;
  letter-spacing: -0.01em;
}
```

### Links
```css
.link {
  color: var(--text);
  text-decoration: none;
  position: relative;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--text);
  transition: color 0.3s ease, border-color 0.3s ease;
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
  font-weight: 500;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  padding: 6px 12px;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  background: transparent;
}
.badge.accent {
  border-color: var(--accent);
  color: var(--accent);
}
```

### File Row
```css
.file-row {
  display: grid;
  grid-template-columns: 48px 1fr 140px 100px 40px;
  align-items: center;
  gap: 24px;
  padding: 28px 0;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: padding 0.4s ease, border-color 0.4s ease;
}
.file-row:hover {
  padding-left: 8px;
  border-bottom-color: var(--text);
}
.file-row.selected {
  border-bottom-color: var(--accent);
  border-bottom-width: 1px;
}
.file-row.selected .file-name {
  font-style: italic;
  color: var(--accent);
}
```

### Modal
```css
.modal {
  position: fixed; inset: 0;
  background: var(--bg);
  z-index: 100;
  display: flex;
  flex-direction: column;
  animation: fade-in 0.5s ease;
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
```

## 5. Layout Principles

**Container:**
- Max width: 1200px
- Padding: 64px (桌面)
- 中心对齐,左右大量留白(丝绒盒子感)

**Spacing Scale:**
- Section gap: 80px
- Component gap: 32px
- Card internal padding: 32-48px

**Grid:**
- L0: 单文件 → 720px 居中,巨量留白
- L1: 2 列 60/40
- L2: 50/50
- L3: 1 行 6 个缩略图(gallery 感)

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | 无 | 99% 场景 |
| Hairline | `1px solid rgba(10,10,10,0.12)` | 默认卡片、列表 |
| Strong | `1px solid #0A0A0A` | hover 态、选中态 |
| Reverse | `background: #0A0A0A` | 提取码区、CTA hero |

**核心:不用阴影。深度由留白 + hairline border + 颜色反转 制造**

## 7. Animation & Interaction

**Motion Philosophy**: 0.4-0.5s ease,慢节奏,有"仪式感"。所有交互 0.4s ease。
**Tier**: L1

### Entrance Animation
```css
@keyframes reveal-up {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
.reveal { animation: reveal-up 0.7s cubic-bezier(0.16, 1, 0.3, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.1s; }
.reveal:nth-child(3) { animation-delay: 0.2s; }
```

### Hover & Focus States
- 所有 hover: 0.4s ease, 慢节奏
- 文件行 hover: 左 padding 8px + border 加粗(不是阴影)
- 按钮 hover: 颜色反转(0.4s 渐变)

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
```

## 8. Do's and Don'ts

### Do
- 留白要"敢" — 桌面 padding 64px,标题上下各 80px
- italic Cormorant 用作"数字"和"提取码"(不是普通文本)
- 颜色反转 (`bg: black; color: cream`) 用作"重要强调"
- 1px hairline border 是唯一分隔线
- 动效 0.4s ease,慢且稳

### Don't
- ❌ 不用粗边框(>1px)
- ❌ 不用阴影
- ❌ 不用 border-radius > 0
- ❌ 不用渐变
- ❌ 不用 sans-serif 做标题
- ❌ 不用 emoji、icon 装饰
- ❌ 不用彩色 background
- ❌ 不用粗体(>500)
- ❌ 不用 transition < 0.3s(快=廉价)

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | padding 64px, 双列 60/40 |
| Tablet | 640-1023 | padding 40px, 单列堆叠 |
| Mobile | < 640 | padding 20px, 文件行简化 3 列 |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端取消 italic display H1(用常规 H1),padding 减半

```css
@media (max-width: 1023px) {
  .topbar { padding: 20px 32px; }
  .file-row { grid-template-columns: 32px 1fr 80px 32px; }
}
@media (max-width: 639px) {
  .topbar { padding: 16px 20px; }
  .container { padding: 20px; }
  .display-h1 { font-size: 40px; }
  .big-key { font-size: 32px; }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: #0A0A0A;
  --surface: #141414;
  --border: rgba(250, 248, 244, 0.12);
  --border-strong: #FAF8F4;
  --text: #FAF8F4;
  --text-secondary: #A8A8A8;
  --text-tertiary: #707070;
  --text-inverse: #0A0A0A;
  --accent: #FF8A3D;
}
```
