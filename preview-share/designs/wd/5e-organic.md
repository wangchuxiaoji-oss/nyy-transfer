# DESIGN.md — Plan 5E · Organic Natural

> 一份"乡间市集手工皂包装"的取件单 — 暖米色底、Fraunces 衬线、橙色 + 陶土色。

## 1. Visual Theme & Atmosphere

**Style**: 自然有机(Seed #8) + nyy 橙主色
**Keywords**: 泥土、手作、柔和、呼吸、可持续、温暖、有质感
**Tone**: 乡间市集上的手工皂包装。NOT 工业、NOT 数字、NOT 冷
**Feel**: 提取码是手写感的 Fraunces italic 数字,卡片像牛皮纸包着的小礼物

**Interaction Tier**: L1 (精致静态)
**Dependencies**: CSS only

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 暖米 / 陶土 */
  --bg: #F5F0EB;                          /* 暖米 */
  --surface: #FEFCF9;                     /* 纸白 */
  --surface-alt: #EFE5D5;                 /* 沙米 */
  --surface-hover: #FAF3E5;
  --surface-dark: #3D3228;                /* 深棕 */

  /* Borders */
  --border: #DDD5CA;                      /* 浅米 */
  --border-strong: #3D3228;                /* 深棕实线 */
  --border-hover: var(--accent);

  /* Text */
  --text: #3D3228;                         /* 深棕,不是纯黑 */
  --text-secondary: #7A6E60;
  --text-tertiary: #A89888;
  --text-inverse: #F5F0EB;

  /* Accent — nyy 橙 + 陶土补色 */
  --accent: #FF8A3D;                       /* 主橙(暖阳) */
  --accent-hover: #E8762E;
  --accent-2: #C4956A;                     /* 陶土(辅助) */
  --accent-3: #5B8C5A;                     /* 苔绿(辅助) */
  --accent-soft: rgba(255, 138, 61, 0.1);

  /* Texture */
  --grain: url("data:image/svg+xml;utf8,<svg .../>");  /* 噪点 */

  /* Semantic */
  --success: #5B8C5A;
  --error: #A03A1A;
  --warning: #C4956A;
}
```

**Color Rules:**
1. 暖米色为底,纸白为卡片,深棕为文字
2. 橙色为主强调(暖阳),陶土色作辅(标签/边框),苔绿作成功/状态
3. 不用纯黑/纯白,深棕黑 + 暖米白
4. 可选噪点纹理背景(0.04 alpha)

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400;1,9..144,500;1,9..144,600&family=Source+Sans+3:wght@300;400;500;600&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Fraunces (italic) | 64px | 600 italic | 1.05 | -0.02em |
| Section H2 | Fraunces | 32px | 600 | 1.15 | -0.01em |
| H3 | Fraunces (italic) | 20px | 500 italic | 1.3 | 0 |
| Body | Source Sans 3 | 15px | 400 | 1.7 | 0 |
| Label | Source Sans 3 | 11px | 600 | 1.0 | 0.2em (uppercase) |
| Mono/Key | Fraunces (italic) | 36px | 600 italic | 1.0 | -0.01em |
| Big Key | Fraunces (italic) | 56px | 600 italic | 1.0 | -0.02em |

**Typography Rules:**
- Fraunces italic 600 用作 H1(衬线斜体 = 手作品牌感)
- 提取码用 Fraunces italic 56px
- Source Sans 3 400 用作正文
- **NEVER use**: Inter, Roboto, Arial, system-ui, sans-serif display
- 中文混排: Noto Serif SC (Fraunces 替代品) + Noto Sans SC

**Text Decoration:**
- H1: 无装饰,纯字重 + 斜体
- 提取码: Fraunces italic 56px + 橙色
- 关键术语: italic Fraunces

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Source Sans 3', sans-serif;
  font-weight: 500;
  font-size: 14px;
  letter-spacing: 0.05em;
  padding: 16px 32px;
  background: var(--text);
  color: var(--text-inverse);
  border: 1px solid var(--text);
  border-radius: 24px;                     /* 偏大圆角 */
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(61, 50, 40, 0.15);
  transition: background 0.3s ease, color 0.3s ease, transform 0.2s ease;
}
.btn:hover {
  background: var(--accent);
  color: var(--text);
  border-color: var(--accent);
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(255, 138, 61, 0.3);
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
  opacity: 0.5;
  cursor: not-allowed;
}
```

### Cards
```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 28px;
  box-shadow: 0 4px 12px rgba(61, 50, 40, 0.06);
  transition: box-shadow 0.3s ease, border-color 0.3s ease, transform 0.3s ease;
}
.card:hover {
  border-color: var(--accent-2);
  box-shadow: 0 8px 20px rgba(196, 149, 106, 0.15);
  transform: translateY(-2px);
}
.card.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
}
```

### Background Texture (Optional)
```css
body {
  background: var(--bg);
  background-image:
    radial-gradient(circle at 1px 1px, rgba(61, 50, 40, 0.04) 1px, transparent 0);
  background-size: 24px 24px;
  min-height: 100vh;
}
```

### Navigation
```css
.topbar {
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 20px 40px;
  border-radius: 0 0 20px 20px;
}
.brand {
  font-family: 'Fraunces', serif;
  font-weight: 600;
  font-style: italic;
  font-size: 26px;
  letter-spacing: -0.02em;
  color: var(--text);
}
```

### Links
```css
.link {
  color: var(--text);
  text-decoration: none;
  font-family: 'Fraunces', serif;
  font-style: italic;
  border-bottom: 1px solid var(--accent-2);
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
  font-family: 'Source Sans 3', sans-serif;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 4px 12px;
  background: var(--surface-alt);
  color: var(--text-secondary);
  border: 1px solid var(--border);
  border-radius: 100px;
}
.badge.accent {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: var(--accent);
}
.badge.terracotta {
  background: rgba(196, 149, 106, 0.15);
  color: var(--accent-2);
  border-color: var(--accent-2);
}
.badge.moss {
  background: rgba(91, 140, 90, 0.15);
  color: var(--accent-3);
  border-color: var(--accent-3);
}
```

### File Row
```css
.file-row {
  display: grid;
  grid-template-columns: 56px 1fr 140px 100px 40px;
  align-items: center;
  gap: 20px;
  padding: 18px 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.3s ease, background 0.3s ease, transform 0.3s ease;
}
.file-row:hover {
  border-color: var(--accent-2);
  background: var(--surface-hover);
  transform: translateX(2px);
}
.file-row .file-name {
  font-family: 'Fraunces', serif;
  font-size: 18px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--text);
}
.file-row .file-size {
  font-family: 'Fraunces', serif;
  font-size: 18px;
  font-weight: 500;
  font-style: italic;
  text-align: right;
  color: var(--accent);
}
.file-row.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
  border-width: 2px;
  padding: 17px 23px; /* 抵消 border 增厚 */
}
```

### Modal
```css
.modal {
  position: fixed; inset: 32px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 24px;
  box-shadow: 0 24px 60px rgba(61, 50, 40, 0.25);
  z-index: 100;
  display: flex;
  flex-direction: column;
  animation: rise-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes rise-in {
  from { opacity: 0; transform: translateY(20px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(61, 50, 40, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}
```

## 5. Layout Principles

**Container:**
- Max width: 1200px
- Padding: 40px(桌面)

**Spacing Scale:**
- Section gap: 48px
- Component gap: 20px
- Card padding: 28px

**Grid:**
- L0: 居中 720px 卡片
- L1: 2 列 55/45(不对称)
- L2: 320px 列表 + 1fr
- L3: 缩略图 grid 3-4 列

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Subtle | `0 4px 12px rgba(brown, 0.06)` | 默认卡片 |
| Warm | `0 8px 20px rgba(terracotta, 0.15)` | hover 卡片 |
| Strong | `0 24px 60px rgba(brown, 0.25)` | 模态框 |
| Border Accent | `1px solid var(--accent-2)` | 陶土色边框 |

**核心:用暖棕色阴影,不用纯黑阴影;陶土色边框增加手工感**

## 7. Animation & Interaction

**Motion Philosophy**: 0.3-0.4s ease,慢节奏,像手工制作。L1 档。
**Tier**: L1

### Entrance Animation
```css
@keyframes gentle-rise {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
.reveal { animation: gentle-rise 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.1s; }
.reveal:nth-child(3) { animation-delay: 0.2s; }
```

### Hover State
- 卡片 hover: translateY(-2px) + 暖色阴影加深
- 文件行 hover: translateX(2px) + 陶土色边框
- 按钮 hover: 颜色 0.3s 渐变

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- 暖米 + 纸白 + 深棕 = 配色基础
- 圆角偏大(16-24px),柔化边缘
- Fraunces italic 用作 display / 数字(手作品牌感)
- 陶土色作辅助(标签、边框)
- 阴影用暖棕色 tint
- 噪点背景可选(0.04 alpha,24px 间距)

### Don't
- ❌ 不用纯白实色(用 #FEFCF9 纸白)
- ❌ 不用纯黑文字(用 #3D3228 深棕)
- ❌ 不用 Inter / Roboto
- ❌ 不用锐角
- ❌ 不用灰黑色阴影
- ❌ 不用 sans-serif display
- ❌ 不用蓝色 / 紫色
- ❌ 不用 emoji
- ❌ 不用渐变(包括按钮)

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | padding 40px, 双列 55/45 |
| Tablet | 640-1023 | padding 28px, 单列 |
| Mobile | < 640 | padding 20px, 文件行简化 |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端取消背景噪点(性能),字号 -20%

```css
@media (max-width: 1023px) {
  .topbar { padding: 16px 24px; }
  .file-row { grid-template-columns: 40px 1fr 100px 32px; }
  .display-h1 { font-size: 48px; }
}
@media (max-width: 639px) {
  .topbar { padding: 12px 16px; border-radius: 0 0 16px 16px; }
  body { background-image: none; }
  .file-row { grid-template-columns: 32px 1fr 80px 32px; }
  .display-h1 { font-size: 36px; }
  .big-key { font-size: 36px; }
  .modal { inset: 12px; border-radius: 16px; }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: #2A211A;
  --surface: #3A2D24;
  --surface-alt: #4A3D34;
  --surface-hover: #4A3D34;
  --border: #5A4D44;
  --border-strong: #C4956A;
  --text: #F5F0EB;
  --text-secondary: #C8B8A8;
  --text-tertiary: #A89888;
  --text-inverse: #3D3228;
  --accent: #FF8A3D;
  --accent-2: #D4A57A;
  --accent-3: #7AAC79;
  --accent-soft: rgba(255, 138, 61, 0.15);
}
```
