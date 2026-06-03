# DESIGN.md — Plan 5B · Dark Tech

> 一份"深空站控制台"的取件单 — 漆黑底、Space Grotesk 标题、橙色在黑暗中发光。

## 1. Visual Theme & Atmosphere

**Style**: 暗黑科技(Seed #2) + nyy 橙主色
**Keywords**: 深邃、霓虹、未来、科技、glow、玻璃、信息在黑暗中发光
**Tone**: 深空站控制台,数据悬浮发光。NOT 亮、NOT 暖、NOT 装饰
**Feel**: 提取码是橙色光带在玻璃面板上跳动,文件大小是右上角的 monospace 数字

**Interaction Tier**: L2 (流畅交互)
**Dependencies**: CSS only (含 backdrop-filter / glow)

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 深空 */
  --bg: #0B0B0F;
  --bg-mesh: #1A1A24;
  --surface: rgba(255, 255, 255, 0.03);
  --surface-strong: rgba(255, 255, 255, 0.06);
  --surface-hover: rgba(255, 138, 61, 0.08);

  /* Borders */
  --border: rgba(255, 255, 255, 0.08);
  --border-hover: var(--accent);
  --border-glow: 1px solid rgba(255, 138, 61, 0.4);

  /* Text */
  --text: #F0F0F0;
  --text-secondary: #8B8B8B;
  --text-tertiary: #5A5A5A;
  --text-inverse: #0B0B0F;

  /* Accent — 镭射橙 + 青色补色 */
  --accent: #FF8A3D;                      /* 替代 cyan */
  --accent-hover: #FFA260;
  --accent-glow: 0 0 24px rgba(255, 138, 61, 0.5);
  --accent-strong-glow: 0 0 40px rgba(255, 138, 61, 0.8);
  --accent-2: #8B5CF6;                    /* 紫色补色(不抢主) */
  --accent-soft: rgba(255, 138, 61, 0.1);

  /* Semantic */
  --success: #00FF88;
  --error: #FF3366;
  --warning: #FFD700;
}
```

**Color Rules:**
1. 90% 深空 + 半透明玻璃,10% 橙色光带作为信息
2. 玻璃表面 (`rgba(255,255,255,0.03-0.06)`) 代替实色
3. 文字基本是白 / 半透明白
4. 边框默认是白色 8% 半透明
5. 橙色永远带 glow shadow

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=Inter:wght@300;400;500;600&family=Fira+Code:wght@400;500&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Space Grotesk | 56px | 700 | 1.0 | -0.02em |
| Section H2 | Space Grotesk | 24px | 700 | 1.1 | -0.01em |
| H3 | Space Grotesk | 18px | 500 | 1.3 | 0 |
| Body | Inter | 14px | 300 | 1.6 | 0 |
| Label | Space Grotesk | 10px | 500 | 1.0 | 0.2em (uppercase) |
| Mono/Key | Fira Code | 28px | 500 | 1.0 | 0.05em |
| File Name | Inter | 15px | 500 | 1.3 | 0 |

**Typography Rules:**
- Space Grotesk 700 用作大数字(文件大小、提取码)
- Inter 300 用作正文(轻盈)
- Label / Mono 用 Space Grotesk + UPPERCASE
- **NEVER use**: Roboto, Arial, system-ui, serif
- 中文混排: Noto Sans SC, weight 400

**Text Decoration:**
- H1: 无渐变,有 text-shadow glow(橙色)
- 提取码: text-shadow: 0 0 16px var(--accent)
- 关键数字: Fira Code 28px + glow

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 500;
  font-size: 13px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 14px 28px;
  background: var(--accent);
  color: var(--text-inverse);
  border: 1px solid var(--accent);
  border-radius: 0;
  cursor: pointer;
  box-shadow: var(--accent-glow);
  transition: background 0.3s ease, box-shadow 0.3s ease, transform 0.2s ease;
}
.btn:hover {
  background: var(--accent-hover);
  box-shadow: var(--accent-strong-glow);
  transform: translateY(-1px);
}
.btn-primary {
  background: var(--accent);
  color: var(--text-inverse);
}
.btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}
```

### Cards
```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  padding: 24px;
  position: relative;
  transition: border-color 0.3s ease, background 0.3s ease;
}
.card:hover {
  border-color: var(--accent);
  background: var(--surface-hover);
}
.card.selected {
  border-color: var(--accent);
  background: var(--surface-hover);
  box-shadow: var(--accent-glow);
}
```

### Background Grid
```css
body {
  background:
    radial-gradient(circle at 20% 0%, var(--bg-mesh) 0%, transparent 40%),
    radial-gradient(circle at 80% 100%, var(--bg-mesh) 0%, transparent 40%),
    var(--bg);
  min-height: 100vh;
}
```

### Navigation
```css
.topbar {
  background: rgba(11, 11, 15, 0.8);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
  padding: 16px 32px;
  position: sticky; top: 0;
  z-index: 50;
}
.brand {
  font-family: 'Space Grotesk', sans-serif;
  font-weight: 700;
  font-size: 20px;
  letter-spacing: -0.01em;
  color: var(--text);
  text-shadow: var(--accent-glow);
}
```

### Links
```css
.link {
  color: var(--accent);
  text-decoration: none;
  text-shadow: 0 0 8px var(--accent);
  border-bottom: 1px solid var(--accent);
}
.link:hover {
  color: var(--accent-hover);
  text-shadow: 0 0 12px var(--accent-hover);
}
```

### Tags / Badges
```css
.badge {
  font-family: 'Space Grotesk', sans-serif;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 4px 10px;
  background: var(--surface-strong);
  border: 1px solid var(--border);
  color: var(--text);
}
.badge.accent {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  text-shadow: 0 0 8px var(--accent);
}
```

### File Row
```css
.file-row {
  display: grid;
  grid-template-columns: 48px 1fr 140px 80px 40px;
  align-items: center;
  gap: 20px;
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.3s, background 0.3s, box-shadow 0.3s;
}
.file-row:hover {
  border-color: var(--accent);
  background: var(--surface-hover);
}
.file-row .file-size {
  font-family: 'Fira Code', monospace;
  font-size: 14px;
  color: var(--accent);
  text-shadow: 0 0 6px var(--accent);
  text-align: right;
}
.file-row.selected {
  border-color: var(--accent);
  background: var(--surface-hover);
  box-shadow: var(--accent-glow);
}
```

### Modal
```css
.modal {
  position: fixed; inset: 0;
  background: rgba(11, 11, 15, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  z-index: 100;
  display: flex;
  animation: fade-in 0.3s ease;
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
```

## 5. Layout Principles

**Container:**
- Max width: 1280px
- Padding: 32px

**Spacing Scale:**
- Section gap: 32px
- Component gap: 16px
- Card padding: 24px

**Grid:**
- L0: 居中 800px 播放器
- L1: 2 列 60/40
- L2/L3: 320px 列表 + 1fr 主区

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Glass | `rgba(255,255,255,0.03) + blur(20px)` | 默认卡片 |
| Strong | `rgba(255,255,255,0.06) + blur(20px)` | 选中/激活 |
| Glow | `0 0 24px var(--accent)` | hover、按钮、提取码 |
| Strong Glow | `0 0 40px var(--accent)` | 重要交互 |

**核心:用 glassmorphism + glow 制造"悬浮在能量场"感**

## 7. Animation & Interaction

**Motion Philosophy**: 0.2-0.3s ease,锐利、有"啪"感,配合 glow 闪烁。L2 档。
**Tier**: L2

### Entrance Animation
```css
@keyframes fade-up {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}
.reveal { animation: fade-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.08s; }
.reveal:nth-child(3) { animation-delay: 0.16s; }
```

### Glow Pulse
```css
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 16px rgba(255, 138, 61, 0.3); }
  50% { box-shadow: 0 0 32px rgba(255, 138, 61, 0.6); }
}
.glow-pulse { animation: glow-pulse 2s ease infinite; }
```

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- 背景用 radial-gradient 制造星云
- 卡片用 backdrop-filter blur 制造玻璃
- 文字 / 边框 / 按钮都加 glow
- Inter 300 / 400 用作正文(轻盈科技感)
- 数字用 Fira Code(终端感)
- border-radius 0(几何感)
- Label 用 UPPERCASE + 0.2em letter-spacing

### Don't
- ❌ 不用纯白/纯黑实色
- ❌ 不用 Inter 做 display(用 Space Grotesk)
- ❌ 不用暖色 / 米色
- ❌ 不用 serif
- ❌ 不用 border-radius > 0
- ❌ 不用浅色文字
- ❌ 不用无 glow 的实色按钮
- ❌ 不用 emoji / icon 装饰

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | padding 32px, 双列 |
| Tablet | 640-1023 | padding 24px, 单列 |
| Mobile | < 640 | padding 16px, glow 减半 |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端减少 glow intensity(性能),blur 减半

```css
@media (max-width: 1023px) {
  .topbar { padding: 12px 24px; }
  .file-row { grid-template-columns: 32px 1fr 80px 32px; }
}
@media (max-width: 639px) {
  .card { backdrop-filter: blur(10px); }
  .btn { box-shadow: 0 0 12px rgba(255, 138, 61, 0.4); }
}
```

**Light Theme (inverted "inverted tech"):**
```css
.light {
  --bg: #FAFAFA;
  --bg-mesh: #FFE5D5;
  --surface: rgba(255, 255, 255, 0.7);
  --surface-strong: rgba(255, 255, 255, 0.9);
  --border: rgba(10, 10, 10, 0.12);
  --text: #0B0B0F;
  --text-secondary: #5A5A5A;
  --text-tertiary: #8B8B8B;
  --text-inverse: #FFFFFF;
  --accent: #E8762E;
  --accent-glow: 0 0 16px rgba(232, 118, 46, 0.3);
}
```
