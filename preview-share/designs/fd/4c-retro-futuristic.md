# DESIGN.md — Plan 4C · Retro-Futuristic Y2K

> 一份从 1999 年穿越过来的取件单 — 镀铬、彩虹、立体按钮、橙色在反光里跳。

## 1. Visual Theme & Atmosphere

**Style**: Retro-futuristic / Y2K Chrome
**Keywords**: iridescent, chrome, gradient-mesh, beveled, embossed, glow, sci-fi, optimistic
**Tone**: 像一张 Windows XP 启动壁纸 + 2005 年的 iPod nano 广告。NOT minimal, NOT serious, NOT quiet
**Feel**: 取件码是 holo 卡牌,旁边悬浮着薄荷绿和橙色的等离子光

**Interaction Tier**: L2 (流畅交互)
**Dependencies**: CSS only (含 3D transform / conic-gradient)

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 深空紫到黑色 */
  --bg: #0A0418;                         /* 深紫黑 */
  --bg-mesh-1: #2A0845;
  --bg-mesh-2: #6441A5;
  --bg-mesh-3: #FF8A3D;
  --surface: rgba(255, 255, 255, 0.06);  /* 半透明玻璃 */
  --surface-strong: rgba(255, 255, 255, 0.12);
  --surface-hover: rgba(255, 255, 255, 0.1);

  /* Borders */
  --border: rgba(255, 255, 255, 0.18);
  --border-hover: var(--accent);
  --border-gradient: linear-gradient(135deg, #FF8A3D, #FF3366, #00D4FF);

  /* Text */
  --text: #FFFFFF;
  --text-secondary: rgba(255, 255, 255, 0.7);
  --text-tertiary: rgba(255, 255, 255, 0.45);
  --text-inverse: #0A0418;

  /* Accent — 镭射橙 + 彩虹 */
  --accent: #FF8A3D;
  --accent-2: #00D4FF;                   /* 青色补色 */
  --accent-3: #FF3366;                   /* 品红补色 */
  --accent-glow: 0 0 32px rgba(255, 138, 61, 0.6);

  /* Semantic */
  --success: #00FF88;
  --error: #FF3366;
  --warning: #FFD700;
}
```

**Color Rules:**
1. 主调是深空黑紫 + 镭射橙,但允许出现 3-4 个霓虹色作为反光
2. 玻璃表面 (`rgba(255,255,255,0.06-0.12)`) 代替实色
3. 边框可以是 conic-gradient / linear-gradient 彩虹边
4. 文字基本是白色 / 半透明白

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Orbitron | 56px | 900 | 1.0 | 0.05em (uppercase) |
| Section H2 | Orbitron | 28px | 700 | 1.1 | 0.08em (uppercase) |
| H3 | Inter | 18px | 600 | 1.3 | 0 |
| Body | Inter | 14px | 400 | 1.5 | 0 |
| Label | Orbitron | 10px | 700 | 1.0 | 0.2em (uppercase) |
| Code/Key | Orbitron | 24px | 700 | 1.0 | 0.1em |

**Typography Rules:**
- 所有 H1/H2/Label 用 Orbitron + UPPERCASE + 宽 letter-spacing(科技感)
- 文件名用 Inter 600(可读性)
- 提取码/数字用 Orbitron 700
- **NEVER use**: Roboto, Arial, system-ui, serif

**Text Decoration:**
- H1: linear-gradient(135deg, #FF8A3D, #FF3366) + text-shadow glow
- 提取码: text-shadow: 0 0 20px var(--accent)

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Orbitron', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: 18px 36px;
  background: linear-gradient(135deg, #FF8A3D, #FF3366);
  color: var(--text);
  border: 1px solid rgba(255, 255, 255, 0.4);
  border-radius: 4px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.5),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3),
    0 0 24px rgba(255, 138, 61, 0.5),
    0 4px 16px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  position: relative;
  transition: transform 0.2s, box-shadow 0.2s;
}
.btn:hover {
  transform: translateY(-2px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.6),
    inset 0 -1px 0 rgba(0, 0, 0, 0.3),
    0 0 40px rgba(255, 138, 61, 0.8),
    0 8px 24px rgba(0, 0, 0, 0.5);
}
.btn:active { transform: translateY(0); }
.btn:focus-visible {
  outline: 2px solid var(--accent-2);
  outline-offset: 3px;
}
```

### Cards
```css
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  padding: 24px;
  position: relative;
  overflow: hidden;
  transition: border-color 0.3s, transform 0.3s;
}
.card::before {
  content: '';
  position: absolute; inset: 0;
  background: linear-gradient(135deg, transparent 30%, rgba(255, 138, 61, 0.08));
  pointer-events: none;
}
.card:hover {
  border-color: var(--accent);
  transform: translateY(-2px);
  box-shadow: 0 0 32px rgba(255, 138, 61, 0.3);
}
```

### Background Mesh
```css
body {
  background:
    radial-gradient(circle at 20% 30%, var(--bg-mesh-1) 0%, transparent 50%),
    radial-gradient(circle at 80% 70%, var(--bg-mesh-2) 0%, transparent 50%),
    radial-gradient(circle at 50% 50%, var(--bg-mesh-3) 0%, transparent 30%),
    var(--bg);
  min-height: 100vh;
}
```

### Navigation
```css
.topbar {
  background: var(--surface);
  backdrop-filter: blur(20px);
  border-bottom: 1px solid var(--border);
  padding: 20px 40px;
}
```

### Links
```css
.link {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px solid var(--accent);
  text-shadow: 0 0 8px var(--accent);
}
.link:hover {
  color: var(--accent-2);
  border-color: var(--accent-2);
  text-shadow: 0 0 8px var(--accent-2);
}
```

### Tags / Badges
```css
.badge {
  font-family: 'Orbitron', sans-serif;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  padding: 4px 10px;
  background: var(--surface-strong);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text);
}
.badge.accent {
  background: linear-gradient(135deg, #FF8A3D, #FF3366);
  border-color: transparent;
}
```

### File Row
```css
.file-row {
  display: grid;
  grid-template-columns: 48px 1fr 120px 80px 40px;
  align-items: center;
  gap: 20px;
  padding: 18px 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color 0.3s, background 0.3s;
}
.file-row:hover {
  border-color: var(--accent);
  background: var(--surface-hover);
}
.file-row.selected {
  border-color: var(--accent);
  background: rgba(255, 138, 61, 0.1);
  box-shadow: 0 0 20px rgba(255, 138, 61, 0.3);
}
```

## 5. Layout Principles

**Container:**
- Max width: 1280px
- Padding: 40px

**Spacing Scale:**
- Section gap: 40px
- Component gap: 16px
- Card padding: 24px

**Grid:**
- L0: 居中 800px 播放器,周围发光的背景
- L1: 2 列 60/40
- L2/L3: 左侧 360px 列表 + 右侧 1fr 主区

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Glass | `rgba(255,255,255,0.06) + blur(20px)` | 默认 |
| Glow | `0 0 32px var(--accent)` | hover 卡片、按钮、提取码 |
| Bevel | `inset 0 1px 0 white, inset 0 -1px 0 black` | 按钮(立体感) |
| Mesh | radial-gradient 多层 | 背景 |

**核心:用 glassmorphism + glow + bevel 制造"漂浮在能量场中"的科技感**

## 7. Animation & Interaction

**Motion Philosophy**: 0.2-0.3s,弹性、锐利、有"啪"的感觉。霓虹色发光。
**Tier**: L2

### Entrance Animation
```css
@keyframes glow-in {
  from { opacity: 0; transform: scale(0.95); filter: blur(8px); }
  to { opacity: 1; transform: scale(1); filter: blur(0); }
}
.reveal { animation: glow-in 0.6s cubic-bezier(0.16, 1, 0.3, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.1s; }
```

### Hover Glow Pulse
```css
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 20px rgba(255, 138, 61, 0.5); }
  50% { box-shadow: 0 0 40px rgba(255, 138, 61, 0.8); }
}
.glow-on-hover:hover { animation: glow-pulse 1.5s ease infinite; }
```

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- 背景用 radial-gradient 制造星云感
- 卡片用 backdrop-filter blur 制造玻璃
- 按钮用 box-shadow 多层 inset + 外发光 制造立体感
- 文字加 text-shadow glow(橙色)
- border-radius 8-12px(轻圆角)
- 配色允许 3-4 个霓虹色(橙+青+品红)

### Don't
- ❌ 不用纯白/纯黑实色
- ❌ 不用细 hairline border(用 1px 白色半透明)
- ❌ 不用 Inter/Arial/system-ui
- ❌ 不用扁平按钮(必须有 bevel)
- ❌ 不用慢速 transition(< 0.2s 太慢)
- ❌ 不用横排纯文字 label(必须有 icon/装饰)
- ❌ 不用 serif
- ❌ 不用 muted color(全部饱和)

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | 双列, padding 40px |
| Tablet | 640-1023 | 单列, padding 24px |
| Mobile | < 640 | 全宽, padding 16px, blur 减半 |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端取消部分 glow 效果(性能),border-radius 减半

```css
@media (max-width: 1023px) {
  .topbar { padding: 16px 24px; }
  .file-row { grid-template-columns: 32px 1fr 80px 32px; }
}
@media (max-width: 639px) {
  body::before { backdrop-filter: none; }
  .card { backdrop-filter: blur(8px); }
}
```

**Light Theme (auto/inverse):**
```css
.light {
  --bg: #FFF4EB;
  --bg-mesh-1: #FFE5D5;
  --bg-mesh-2: #FFD4B8;
  --bg-mesh-3: #FF8A3D;
  --surface: rgba(255, 255, 255, 0.6);
  --surface-strong: rgba(255, 255, 255, 0.85);
  --text: #0A0418;
  --text-secondary: rgba(10, 4, 24, 0.7);
  --border: rgba(10, 4, 24, 0.15);
}
```
