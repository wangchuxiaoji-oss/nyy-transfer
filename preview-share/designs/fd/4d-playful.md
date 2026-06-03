# DESIGN.md — Plan 4D · Playful Toy

> 一份装在气球盒里的取件单 — 圆润、有弹性、橙色是奶油橙,谁看了都想按一下。

## 1. Visual Theme & Atmosphere

**Style**: Playful / Toy-like
**Keywords**: rounded, bouncy, confetti, spring, friendly, optimistic, candy, soft-shadow
**Tone**: 像拆开一个礼物盒 — 圆角、彩屑、橙色"啵"地弹出来。NOT serious, NOT corporate, NOT dark
**Feel**: 取件码是一颗大橘子,放在奶油泡芙卡片里

**Interaction Tier**: L2 (流畅交互)
**Dependencies**: CSS only (cubic-bezier 弹性曲线)

## 2. Color Palette & Roles

```css
:root {
  /* Backgrounds — 奶油黄 + 软白 */
  --bg: #FFFBF2;                         /* 奶油色 */
  --surface: #FFFFFF;
  --surface-alt: #FFF4EB;                /* 橙奶油 */
  --surface-hover: #FFF8EE;

  /* Borders */
  --border: #FFE5D0;                     /* 浅橙边 */
  --border-hover: var(--accent);
  --border-strong: var(--accent);

  /* Text */
  --text: #2D2520;                       /* 暖深棕,不是纯黑 */
  --text-secondary: #6B5C50;
  --text-tertiary: #A89888;
  --text-inverse: #FFFFFF;

  /* Accent — 糖果橙 + 朋友色 */
  --accent: #FF8A3D;                     /* 主橙 */
  --accent-hover: #FF7020;
  --accent-2: #FFD93D;                   /* 香蕉黄 */
  --accent-3: #6BCB77;                   /* 薄荷绿 */
  --accent-4: #FF6B9D;                   /* 草莓粉 */
  --accent-soft: #FFE5D0;

  /* Soft Shadows */
  --shadow-card: 0 8px 24px rgba(255, 138, 61, 0.12);
  --shadow-hover: 0 12px 32px rgba(255, 138, 61, 0.24);
  --shadow-button: 0 4px 0 0 #E8762E;    /* 实体下边 */

  /* Semantic */
  --success: #6BCB77;
  --error: #FF6B6B;
  --warning: #FFD93D;
}
```

**Color Rules:**
1. 暖底色(奶油/橙奶油) + 糖果橙主色 + 3 个朋友色(黄/绿/粉)
2. 文字用暖深棕,不用纯黑(纯黑 = 严肃,违反调性)
3. 阴影带橙色 tint(不是黑灰)
4. 不用实色硬阴影,统一用柔光

## 3. Typography Rules

**Font Stack:**
```css
@import url('https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700;800&family=Nunito:wght@400;600;700&display=swap');
```

| Role | Font | Size | Weight | Line Height | Letter Spacing |
|------|------|------|--------|-------------|----------------|
| Display H1 | Sora | 56px | 800 | 1.05 | -0.02em |
| Section H2 | Sora | 28px | 700 | 1.15 | -0.01em |
| H3 | Sora | 18px | 700 | 1.3 | 0 |
| Body | Nunito | 15px | 400 | 1.6 | 0 |
| Label | Sora | 11px | 700 | 1.0 | 0.05em (uppercase) |
| Code/Key | Sora | 32px | 800 | 1.0 | 0.05em |
| Emoji Decoration | Apple Color Emoji / Segoe UI Emoji | 16px | — | 1.0 | 0 |

**Typography Rules:**
- Sora 800 用作大数字(文件大小、提取码)
- Nunito 400 用作正文(圆润友好)
- **NEVER use**: Inter, Roboto, Arial, system-ui, serif
- Emoji 装饰允许: 🎁📁⬇️⏱️(playful 调性唯一例外)

**Text Decoration:**
- H1: 无渐变、无投影(留白 = 趣味)
- 数字: 不用 text-shadow(用 800 字重 + 橙背景衬托)

## 4. Component Stylings

### Buttons
```css
.btn {
  font-family: 'Sora', sans-serif;
  font-weight: 700;
  font-size: 14px;
  padding: 16px 32px;
  background: var(--accent);
  color: var(--text);
  border: none;
  border-radius: 100px;                   /* 药丸形 */
  box-shadow: var(--shadow-button);
  cursor: pointer;
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1),
              box-shadow 0.2s ease;
}
.btn:hover {
  transform: translateY(-3px) scale(1.02);
  box-shadow: 0 8px 0 0 #E8762E, 0 12px 24px rgba(255, 138, 61, 0.3);
}
.btn:active {
  transform: translateY(2px) scale(0.98);
  box-shadow: 0 0 0 0 #E8762E;
}
.btn:focus-visible {
  outline: 3px solid var(--accent-2);
  outline-offset: 3px;
}
.btn:disabled {
  background: var(--accent-soft);
  color: var(--text-tertiary);
  box-shadow: 0 4px 0 0 #FFD0A8;
  cursor: not-allowed;
}
```

### Cards
```css
.card {
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: 20px;
  box-shadow: var(--shadow-card);
  padding: 24px;
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1),
              box-shadow 0.3s ease,
              border-color 0.3s ease;
}
.card:hover {
  transform: translateY(-4px) rotate(-0.5deg);
  box-shadow: var(--shadow-hover);
  border-color: var(--accent);
}
.card.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
  border-width: 3px;
}
```

### Navigation
```css
.topbar {
  background: var(--surface);
  border-bottom: 2px solid var(--border);
  padding: 16px 32px;
  border-radius: 0 0 24px 24px;
}
.brand {
  font-family: 'Sora', sans-serif;
  font-weight: 800;
  font-size: 22px;
  color: var(--text);
  display: flex; align-items: center; gap: 8px;
}
.brand::before {
  content: '🎁';
  font-size: 24px;
}
```

### Links
```css
.link {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 2px dashed var(--accent);
  padding-bottom: 1px;
  transition: color 0.2s, border-color 0.2s;
}
.link:hover {
  color: var(--accent-hover);
  border-bottom-style: solid;
}
```

### Tags / Badges
```css
.badge {
  font-family: 'Sora', sans-serif;
  font-size: 11px;
  font-weight: 700;
  padding: 4px 12px;
  background: var(--accent-soft);
  color: var(--accent);
  border-radius: 100px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge.accent { background: var(--accent); color: var(--text); }
.badge.green { background: #D4F4DD; color: #2D8049; }
.badge.yellow { background: #FFF3C4; color: #8B6914; }
.badge.pink { background: #FFD9E5; color: #B33B5C; }
```

### File Row
```css
.file-row {
  display: grid;
  grid-template-columns: 56px 1fr 120px 80px 40px;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
  background: var(--surface);
  border: 2px solid var(--border);
  border-radius: 16px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.file-row:hover {
  transform: translateX(4px) scale(1.01);
  border-color: var(--accent);
  box-shadow: var(--shadow-card);
}
.file-row.selected {
  background: var(--accent-soft);
  border-color: var(--accent);
  border-width: 3px;
  padding: 15px 19px; /* 抵消 border 增厚 */
}
```

### Modal
```css
.modal {
  position: fixed; inset: 24px;
  background: var(--bg);
  border: 3px solid var(--border);
  border-radius: 32px;
  z-index: 100;
  overflow: hidden;
  animation: pop-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}
@keyframes pop-in {
  from { opacity: 0; transform: scale(0.8) translateY(40px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(45, 37, 32, 0.5);
  backdrop-filter: blur(8px);
}
```

## 5. Layout Principles

**Container:**
- Max width: 1200px
- Padding: 32px

**Spacing Scale:**
- Section gap: 32px
- Component gap: 12-16px
- Card padding: 24px

**Grid:**
- L0: 居中 720px 卡片,圆角 32px
- L1: 2 列 50/50(stacked 不规则)
- L2: 左侧 320px 列表 + 右侧 1fr
- L3: 缩略图 grid(2-3-4 列响应式)

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Soft | `0 8px 24px rgba(orange, 0.12)` | 默认卡片 |
| Bouncy | `0 12px 32px rgba(orange, 0.24)` | hover 卡片 |
| Solid | `0 4px 0 0 #E8762E` | 按钮(实体下边) |
| Pop | `0 0 0 0` (active 状态) | 按钮按压 |
| Modal | `0 24px 60px rgba(orange, 0.2)` | 模态框 |

**核心:阴影是橙色 tint,不是灰黑。按钮有"实体下边"暗示物理感**

## 7. Animation & Interaction

**Motion Philosophy**: cubic-bezier(0.34, 1.56, 0.64, 1) 弹性曲线,所有 hover "啵"地一下,active "噗"地按回去
**Tier**: L2

### Entrance Animation
```css
@keyframes spring-in {
  0% { opacity: 0; transform: translateY(20px) scale(0.95); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
.reveal { animation: spring-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.reveal:nth-child(2) { animation-delay: 0.08s; }
.reveal:nth-child(3) { animation-delay: 0.16s; }
```

### Stagger Confetti
```css
@keyframes confetti {
  0% { opacity: 0; transform: translateY(0) rotate(0); }
  100% { opacity: 1; transform: translateY(-20px) rotate(360deg); }
}
.confetti { animation: confetti 0.6s ease-out both; }
```

### Reduced Motion
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

## 8. Do's and Don'ts

### Do
- 所有圆角 ≥ 12px,主卡片 16-20px,模态 32px
- 按钮用 100px 药丸形 + 实体下边
- 阴影用 `rgba(orange, alpha)` 不用黑色
- 配色允许 4 个糖果色: 橙/黄/绿/粉
- hover 用 cubic-bezier(0.34, 1.56, 0.64, 1) 弹性
- 数字大字号(32-56px)+ 800 字重
- Emoji 装饰可以用(playful 调性唯一)

### Don't
- ❌ 不用直角(永远 ≥ 8px 圆角)
- ❌ 不用纯黑文字(用暖深棕 #2D2520)
- ❌ 不用灰黑色阴影
- ❌ 不用 linear 缓动(必须有弹性)
- ❌ 不用 serif 字体
- ❌ 不用 muted/desaturated 颜色
- ❌ 不用 Inter/Roboto
- ❌ 不用半透明(0.5-0.8)边框

## 9. Responsive Behavior

**Breakpoints:**

| Name | Width | Key Changes |
|------|-------|-------------|
| Desktop | ≥ 1024 | padding 32px, grid 3 列 |
| Tablet | 640-1023 | padding 24px, grid 2 列 |
| Mobile | < 640 | padding 16px, 单列,圆角减半 |

**Touch Targets:** minimum 48×48px
**Collapsing Strategy:** 移动端取消 cubic-bezier 弹性(改 ease),减少 confetti 动画

```css
@media (max-width: 1023px) {
  .topbar { padding: 12px 20px; border-radius: 0 0 16px 16px; }
  .file-row { grid-template-columns: 40px 1fr 80px 32px; }
}
@media (max-width: 639px) {
  .modal { inset: 12px; border-radius: 20px; }
  .card { border-radius: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .reveal { animation: none; }
  .btn:hover { transform: none; }
}
```

**Dark Theme Variant:**
```css
.dark {
  --bg: #1A1410;
  --surface: #2A201A;
  --surface-alt: #3A2D24;
  --border: #4A3D34;
  --text: #FFF4EB;
  --text-secondary: #D4C5B5;
  --text-tertiary: #A89888;
  --shadow-card: 0 8px 24px rgba(0, 0, 0, 0.4);
  --shadow-button: 0 4px 0 0 #B85A1A;
}
```
