# DESIGN.md — Plan 5D · Glassmorphism

> 一份"阳光穿过磨砂玻璃"的取件单 — 渐变背景、半透明玻璃面板、橙色是光斑。

## 1. Visual Theme & Atmosphere

**Style**: 玻璃拟态(Seed #10) + nyy 橙主色
**Keywords**: 透明、模糊、光影、层叠、梦幻、光斑、悬浮
**Tone**: 阳光穿过磨砂玻璃落在桌面上。NOT 平面、NOT 硬边、NOT 单色
**Feel**: 提取码是橙色光斑在毛玻璃面板上浮动,文件大小是右下角的小字标记

**Interaction Tier**: L2 (流畅交互)
**Dependencies**: CSS only (含 backdrop-filter / 多重渐变)

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 渐变底 */
  --bg: linear-gradient(135deg, #FFE5D5 0%, #FFC5A0 50%, #FF8A3D 100%);
  --bg-overlay: linear-gradient(135deg, rgba(255, 229, 213, 0.3), rgba(255, 138, 61, 0.3));
  --surface: rgba(255, 255, 255, 0.35);
  --surface-strong: rgba(255, 255, 255, 0.55);
  --surface-hover: rgba(255, 255, 255, 0.45);

  /* Borders — 半透明白 */
  --border: rgba(255, 255, 255, 0.4);
  --border-strong: rgba(255, 255, 255, 0.7);
  --border-hover: var(--accent);

  /* Text */
  --text: #1A0F08;                       /* 深棕黑,搭配橙色渐变底 */
  --text-secondary: rgba(26, 15, 8, 0.75);
  --text-tertiary: rgba(26, 15, 8, 0.55);
  --text-inverse: #FFFFFF;

  /* Accent — nyy 橙作为"光斑" */
  --accent: #FF8A3D;
  --accent-hover: #FFA260;
  --accent-glow: 0 0 24px rgba(255, 138, 61, 0.6);
  --accent-soft: rgba(255, 138, 61, 0.2);
  --accent-deep: #D4601D;                /* 深橙用于文字对比 */

  /* Glass */
  --blur: 24px;

  /* Semantic */
  --success: #2D7A2D;
  --error: #C73E1D;
  --warning: #FF8A3D;
}
```

**Color Rules:**
1. 渐变背景(暖橙到深橙) + 半透明玻璃面板(35-55% 白)
2. 文字深棕黑(不是纯黑,与暖底色协调)
3. 边框是半透明白 (0.4-0.7 alpha)
4. 阴影是橙色 tint, 不用纯黑阴影

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Outfit | 64px | 800 | 1.0 | -0.03em |
| Section H2 | Outfit | 28px | 700 | 1.1 | -0.02em |
| H3 | Outfit | 18px | 600 | 1.3 | -0.01em |
| Body | Inter | 14px | 400 | 1.6 | 0 |
| Label | Outfit | 10px | 700 | 1.0 | 0.2em (uppercase) |
| Mono/Key | Outfit | 32px | 800 | 1.0 | -0.02em |
| Big Key | Outfit | 56px | 800 | 1.0 | -0.03em |

**Typography Rules:**
- Outfit 800 用作大数字(文件大小、提取码)
- Inter 400 用作正文
- 数字字体 Outfit(圆润几何)
- **NEVER use**: Roboto, Arial, system-ui, serif
- 中文混排: Noto Sans SC, weight 500

**Text Decoration:**
- H1: 无装饰,字重说话
- 提取码: text-shadow: 0 2px 8px rgba(255, 138, 61, 0.4)
- 关键数字: 56px Outfit 800

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Outfit', sans-serif;
  font-weight: 700;
  font-size: 14px;
  letter-spacing: 0.05em;
  padding: 16px 32px;
  background: rgba(255, 255, 255, 0.5);
  color: var(--text);
  border: 1px solid var(--border-strong);
  border-radius: 16px;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 8px 24px rgba(255, 138, 61, 0.2);
  cursor: pointer;
  transition: background 0.3s ease, transform 0.2s ease, box-shadow 0.3s ease;
}
.btn:hover {
  background: rgba(255, 255, 255, 0.7);
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(255, 138, 61, 0.4);
}
.btn-primary {
  background: var(--accent);
  color: var(--text);
  border-color: transparent;
}
.btn-primary:hover {
  background: var(--accent-hover);
  box-shadow: var(--accent-glow);
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
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  box-shadow: 0 8px 32px rgba(255, 138, 61, 0.15);
  padding: 24px;
  position: relative;
  overflow: hidden;
  transition: background 0.3s ease, border-color 0.3s ease, transform 0.3s ease;
}
.card::before {
  content: '';
  position: absolute; top: 0; left: 0; right: 0; height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.8), transparent);
}
.card:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
  transform: translateY(-2px);
  box-shadow: 0 16px 40px rgba(255, 138, 61, 0.25);
}
.card.selected {
  background: var(--surface-strong);
  border-color: var(--accent);
  box-shadow: var(--accent-glow);
}
```

### Background Aurora
```css
body {
  background:
    radial-gradient(circle at 20% 30%, #FFE5D5 0%, transparent 50%),
    radial-gradient(circle at 80% 70%, #FF8A3D 0%, transparent 60%),
    radial-gradient(circle at 50% 90%, #FFB87A 0%, transparent 50%),
    #FFF4EB;
  min-height: 100vh;
}
```

### Navigation
```css
.topbar {
  background: rgba(255, 255, 255, 0.4);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
  padding: 16px 32px;
  position: sticky; top: 0;
  z-index: 50;
  border-radius: 0 0 20px 20px;
}
.brand {
  font-family: 'Outfit', sans-serif;
  font-weight: 800;
  font-size: 22px;
  letter-spacing: -0.02em;
  color: var(--text);
}
```

### Links
```css
.link {
  color: var(--accent-deep);
  text-decoration: none;
  font-weight: 500;
  border-bottom: 1px solid var(--accent);
  text-shadow: 0 1px 2px rgba(255, 138, 61, 0.2);
  transition: color 0.2s ease, border-color 0.2s ease;
}
.link:hover {
  color: var(--accent);
  border-color: var(--accent-deep);
}
```

### Tags / Badges
```css
.badge {
  font-family: 'Outfit', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 4px 12px;
  background: rgba(255, 255, 255, 0.5);
  border: 1px solid var(--border);
  border-radius: 100px;
  color: var(--text);
}
.badge.accent {
  background: var(--accent);
  color: var(--text);
  border-color: transparent;
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
  border-radius: 16px;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  margin-bottom: 8px;
  cursor: pointer;
  transition: background 0.3s ease, border-color 0.3s ease;
}
.file-row:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}
.file-row .file-size {
  font-family: 'Outfit', sans-serif;
  font-weight: 800;
  font-size: 14px;
  text-align: right;
  color: var(--accent-deep);
}
.file-row.selected {
  background: var(--surface-strong);
  border-color: var(--accent);
  box-shadow: 0 0 20px rgba(255, 138, 61, 0.3);
}
```

### Modal
```css
.modal {
  position: fixed; inset: 24px;
  background: rgba(255, 255, 255, 0.4);
  backdrop-filter: blur(40px);
  -webkit-backdrop-filter: blur(40px);
  border: 1px solid var(--border-strong);
  border-radius: 28px;
  box-shadow: 0 24px 60px rgba(255, 138, 61, 0.3);
  z-index: 100;
  display: flex;
  flex-direction: column;
  animation: float-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes float-in {
  from { opacity: 0; transform: translateY(20px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(26, 15, 8, 0.2);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
```

## 5. Layout Principles

**Container:**
- Max width: 1200px
- Padding: 32px

**Spacing Scale:**
- Section gap: 32px
- Component gap: 16px
- Card padding: 24px

**Grid:**
- L0: 居中 720px 玻璃面板
- L1: 2 列 60/40
- L2/L3: 320px 列表 + 1fr 主区

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Glass | `rgba(255,255,255,0.35) + blur(20px)` | 默认卡片 |
| Strong Glass | `rgba(255,255,255,0.55) + blur(20px)` | 选中/激活 |
| Glow | `0 0 24px rgba(orange, 0.4)` | hover、按钮、提取码 |
| Top Highlight | `linear-gradient(white transparent) 1px` | 卡片顶部 1px 反光 |

**核心:半透明玻璃 + 橙色光晕 + 顶部反光线 = 阳光穿过玻璃**

## 7. Animation & Interaction

**Motion Philosophy**: 0.3-0.4s ease,柔和,像玻璃被光影追逐。L2 档。
**Tier**: L2

### Entrance Animation
```css
@keyframes float-up {
  from { opacity: 0; transform: translateY(20px); }
  to { opacity: 1; transform: translateY(0); }
}
.reveal { animation: float-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.08s; }
.reveal:nth-child(3) { animation-delay: 0.16s; }
```

### Hover Float
- 卡片 hover: translateY(-2px) + 阴影加深
- 按钮 hover: translateY(-2px) + glow 增强

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- 圆角 16-20px(玻璃需要圆润)
- 半透明白色 35-55% alpha
- 顶部 1px 反光线 (`linear-gradient(white transparent)`)
- 阴影用橙色 tint,不用纯黑
- backdrop-filter blur 20-40px
- 渐变背景(暖橙到深橙)

### Don't
- ❌ 不用纯白实色
- ❌ 不用纯黑实色
- ❌ 不用 box-shadow 黑色
- ❌ 不用 Inter / Roboto
- ❌ 不用锐角(圆角 ≥ 16px)
- ❌ 不用 muted color
- ❌ 不用硬边框
- ❌ 不用 emoji

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | padding 32px, blur 24px |
| Tablet | 640-1023 | padding 24px, blur 16px |
| Mobile | < 640 | padding 16px, blur 12px |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端减少 blur 值(性能),圆角减半

```css
@media (max-width: 1023px) {
  .topbar { padding: 12px 24px; }
  .file-row { grid-template-columns: 32px 1fr 80px 32px; }
  .card, .btn, .file-row { backdrop-filter: blur(16px); }
}
@media (max-width: 639px) {
  .topbar { padding: 12px 16px; }
  .modal { inset: 12px; border-radius: 20px; }
  .card, .btn, .file-row { backdrop-filter: blur(12px); }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: linear-gradient(135deg, #1A0F08 0%, #3A1A0A 50%, #1A0F08 100%);
  --bg-overlay: linear-gradient(135deg, rgba(26, 15, 8, 0.3), rgba(58, 26, 10, 0.3));
  --surface: rgba(255, 255, 255, 0.08);
  --surface-strong: rgba(255, 255, 255, 0.14);
  --border: rgba(255, 255, 255, 0.15);
  --border-strong: rgba(255, 255, 255, 0.3);
  --text: #FFF4EB;
  --text-secondary: rgba(255, 244, 235, 0.75);
  --text-tertiary: rgba(255, 244, 235, 0.5);
  --text-inverse: #1A0F08;
  --accent: #FF8A3D;
  --accent-deep: #FFA260;
}
```
