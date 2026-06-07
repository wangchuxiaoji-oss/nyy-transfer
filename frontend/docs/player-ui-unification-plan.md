# 播放器 UI 统一改造方案

## 结论

- 可以而且应该彻底统一：`Native + SDP + AC3` 三条播放链路共享同一套 `PlayerChrome` UI。
- 正确架构是：播放内核各自保留，控制 UI 完全统一；每个内核只实现同一份 `PlayerAdapter` 合约。
- 不建议引入 Media Chrome / Video.js / Shaka UI 直接替换现有 UI；应借鉴它们"UI 与播放 tech 分离"的架构思想，继续用你现在已有的定制皮肤。

## 目标

- 以当前 `NativeVideoPlayer` UI 和交互为唯一蓝本。
- `NativeVideoPlayer`、`SdpPlayer`、`Ac3VideoPreview` 都只负责各自 media surface 和播放能力适配。
- `PlayerChrome` 负责所有可见 UI、所有通用交互、所有禁用态提示。
- **禁止**三套播放器各自绘制按钮、进度条、音量、全屏、快捷键、触控逻辑。

## 当前问题

- 原生播放器自己完整绘制 UI：`frontend/src/components/native-video-player.tsx:370`。
- SDP 和 AC3 使用 `PlayerChrome`，但这套 UI 不是原生播放器皮肤：`frontend/src/components/sdp-player.tsx:177`、`frontend/src/components/ac3-video-preview.tsx:445`。
- `PlayerChrome` 缺少 Native 现有关键交互：进度 hover 时间气泡、buffered 背景、全屏自动隐藏、触控单击/双击、桌面双击全屏、键盘快捷键、等待呼吸点。
- 当前结构已经有 `viewState + actions` 的雏形，是正确方向，但 `PlayerChrome` 合约还不够表达 Native 的 UI 行为。

## 开源实践

- **Media Chrome**：核心理念是 UI 与 media playback 分离，底层 media element 可替换，UI 不变。这个理念与你的 `Native <video>`、`SDP canvas`、`AC3 video-only + WebAudio` 完全匹配。
- **Video.js**：以 `Player + Component Tree + ControlBar` 组织 UI，播放能力和控制组件解耦。
- **Shaka UI**：用配置描述控制栏元素、禁用/隐藏能力、overflow menu、画质/倍速/字幕等，而不是每种播放 tech 自己画 UI。
- 适用于你项目的最佳实践：自研一套 `PlayerChrome`，三套 playback adapter 只接入统一 contract。

---

# 实施细节

## 目标架构

```
PlayerChrome (唯一 UI Shell)
├── 中心大播放按钮
├── 底部控制栏
│   ├── 播放/暂停按钮
│   ├── 进度条 + buffered + 时间气泡
│   ├── 时间显示
│   ├── 音量按钮 + slider
│   ├── 设置按钮 (画质/速度子菜单)
│   └── 全屏按钮
├── Loading 呼吸点
├── Error 态覆盖
├── 键盘快捷键接管
├── 鼠标/触控交互
└── 全屏自动隐藏

NativeVideoPlayer        SdpPlayer                Ac3VideoPreview
├── <video> surface      ├── <canvas> surface      ├── <video> surface (muted)
└── useNativeAdapter     └── useSdpAdapter         └── useAc3Adapter
```

## 核心合约

### PlayerCapabilities

```ts
export interface PlayerCapability {
  enabled: boolean;
  reason?: string; // 禁用时显示原因 tooltip
}

export interface PlayerCapabilities {
  seek: PlayerCapability;
  volume: PlayerCapability;
  fullscreen: PlayerCapability;
  pictureInPicture: PlayerCapability;
  speed: PlayerCapability;
  subtitles: PlayerCapability;
  quality: PlayerCapability;
}
```

### PlayerViewState

```ts
export type UnifiedPlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "seeking"
  | "ended"
  | "error";

export interface PlayerViewState {
  state: UnifiedPlayerState;
  currentTime: number;
  duration: number;
  bufferedPct: number;             // 0-100，新增
  buffering: UnifiedBufferingState | null;
  error: string;
  title?: string;
  modeLabel?: string;
  isMuted: boolean;
  volume: number;
  playbackRate: number;
  capabilities: PlayerCapabilities; // 替代旧 canSeek/canVolume/...
}
```

### PlayerActions

```ts
export interface PlayerActions {
  play(): void | Promise<void>;
  pause(): void | Promise<void>;
  seek(seconds: number): void | Promise<void>;
  seekBy(deltaSeconds: number): void | Promise<void>;       // 新增
  setVolume(volume: number): void | Promise<void>;
  setMuted(muted: boolean): void | Promise<void>;
  setPlaybackRate(rate: number): void | Promise<void>;
  enterFullscreen(target: HTMLElement): void | Promise<void>; // 新增 target 参数
  exitFullscreen?(): void | Promise<void>;                    // 新增
  togglePictureInPicture?(): void | Promise<void>;
}
```

## PlayerChrome 职责

必须完整复刻当前 `NativeVideoPlayer` 交互：

| 功能 | 行为 |
|------|------|
| 大播放按钮 | 非播放态显示，样式复刻 Native 橙色圆形按钮 |
| Loading | 复刻 Native 橙色呼吸点，不用纯文字 |
| 错误态 | 覆盖画面上，控制栏保持 |
| 底部控制栏 | 复刻 Native 渐变、透明度、按钮、字体、间距 |
| 进度条 | played / buffered / unbuffered 三段背景 |
| 进度 hover | 显示时间气泡，拖动时持续显示 |
| 全屏自动隐藏 | 播放中 3 秒无交互自动隐藏 |
| 触控单击 | 播放中切换控制栏显示 |
| 桌面单击 | 延迟 180ms 切换播放 |
| 桌面双击 | 进入/退出全屏 |
| 触控双击 | 左半区后退 5s，右半区前进 5s |
| 键盘 Space | 播放/暂停 |
| 键盘 ←→ | seekBy ±5s（range 焦点上不劫持）|
| 键盘 f/m | 全屏/静音 |
| 禁用态 | 可见、置灰、title 显示 reason |

## 组件拆分

```
frontend/src/components/player/
├── player-types.ts              # 所有统一类型
├── player-chrome.tsx            # 外层 shell
├── use-player-chrome-interactions.ts  # 交互 hooks
├── player-control-bar.tsx       # 底部控制栏
├── player-progress.tsx          # 进度条 + buffered + 气泡
├── player-volume.tsx            # 音量
├── player-disabled-control.tsx  # 统一置灰
├── use-native-player-adapter.ts # Native adapter
├── use-sdp-player-adapter.ts    # SDP adapter
└── use-ac3-player-adapter.ts    # AC3 adapter
```

`frontend/src/components/player-chrome.tsx` 保留为 re-export。

---

## 各播放器改造要点

### NativeVideoPlayer

**必须保留:**
- `preload="metadata"`, `playsInline`, `<source src type>`
- `onLoadedMetadata` 回调
- `onError` 错误文案映射
- buffered 百分比计算
- volume/muted localStorage
- iOS `webkitEnterFullscreen()` fallback
- `MediaError.MEDIA_ERR_*` 错误映射

**不允许保留:**
- 自己绘制中心播放按钮、底部控制栏
- 自己注册 keyboard shortcut
- 自己处理 stage click/double click/touch
- 自己维护 chrome hidden 状态

### SdpPlayer

**必须保留:**
- `PlayerEngine` 初始化和 dispose
- `window.__nyySdpDebug`, `window.__nyySdpSeek`
- `unhandledrejection/error` 接管
- `PrefetchProbe` 逻辑
- `readSeekParallelParts()`, `readPrefetchProfileOverride()`

**Capabilities:**
- seek: `duration > 0 && state !== "loading" && state !== "idle"`
- volume: true
- fullscreen: true
- PiP: false, reason="Canvas 播放路径暂不支持 PiP"
- speed: false, reason="SDP v2 当前未暴露倍速控制"
- subtitles: false, reason="SDP v2 当前只探测字幕，尚未渲染"
- quality: false, reason="SDP v2 当前是单源单码率"

**特别注意:**
- 拖动 `onChange` 只更新 UI scrub，不触发 engine seek
- 只在 `mouseUp/touchEnd` commit seek

### Ac3VideoPreview

**必须保留:**
- Blob-first 小文件策略、SW fallback
- `window.__nyyAc3Debug`
- `decodeAc3Window()` 调度
- `AudioContext + GainNode`
- `pendingBlobAutoplayRef` 等语义
- `video.muted = true`

**Capabilities:**
- seek: `duration > 0 && state !== "loading" && state !== "error"`
- volume: true (控制 GainNode)
- fullscreen: true
- PiP: false, reason="AC-3 客户端链路暂不支持画中画"
- speed: false, reason="AC-3 客户端链路当前仅支持 1x 播放"
- subtitles: false, reason="AC-3 客户端链路暂不支持字幕"
- quality: false, reason="单源文件无可切换画质"

**特别注意:**
- `setVolume()` 控制 GainNode 而非 video.volume
- `seek()` 后停止旧 audio windows
- `pause()` 停止已调度 audio
- `ended` 清理 scheduled audio

---

## 实施步骤

1. **新建统一类型** `player-types.ts`
2. **重写 PlayerChrome** 以 Native 为蓝本，拆分子组件
3. **提取 Native adapter** `use-native-player-adapter.ts`
4. **提取 SDP adapter** `use-sdp-player-adapter.ts`
5. **提取 AC3 adapter** `use-ac3-player-adapter.ts`
6. **重构三个播放器组件** 只渲染 surface
7. **统一禁用态**
8. **更新测试与 smoke**

---

## 明确不能做

- ❌ 不能引入 Video.js、Media Chrome、Shaka UI 替换当前 UI
- ❌ 不能在 `PlayerChrome` 里访问 `videoRef.current` 或 `engineRef.current`
- ❌ 不能让 `PlayerChrome` 知道 SDP/AC3/native 的分支逻辑
- ❌ 不能在拖动进度条时连续调用 `seek()`
- ❌ 不能删除 `__nyySdpDebug` / `__nyyAc3Debug`
- ❌ 不能把 disabled 控件隐藏
- ❌ 不能把原生播放器现有交互降级
- ❌ 不能只改外观不改架构

---

## 必须保持不变

- ✅ 播放路由策略不变（MP4 AC-3→AC3, MP4 E-AC-3→SDP, MKV AAC native-first, MKV AC-3/E-AC-3→SDP, tail-moov→virtual faststart）
- ✅ 媒体数据路径不变：浏览器直连 TOS/CDN
- ✅ 不允许服务端转码、不允许生成可播放副本
- ✅ sidecar 策略不变
- ✅ Service Worker 只在需要虚拟媒体时注册
- ✅ 不允许把 SDP/AC3 的不支持能力伪装成支持
- ✅ 不允许为了统一 UI 牺牲 iOS Safari 的可播放性

---

## 验证命令

```bash
# 类型检查
./node_modules/.bin/tsc --noEmit

# 定向 e2e
npx playwright test e2e/share-page.spec.ts -g "原生播放器皮肤|AC-3 MP4|E-AC-3 MP4|MKV"

# 真实 codec matrix smoke
npm --prefix /data/nyy/frontend run smoke:share-codec-matrix

# 完整验证
npm --prefix /data/nyy/frontend run test:e2e
npm --prefix /data/nyy/frontend run build
```

## 人工真机验收

在 `https://dev.nyy.app/U5qDU8` 验证：

| 样本 | 预期 |
|------|------|
| `mp4_h264_aac_faststart.mp4` | Native UI 与旧 Native 一致，音量/全屏/快捷键正常 |
| `mp4_h264_ac3_faststart.mp4` | AC3 统一 UI，有声，音量控制 WebAudio |
| `mp4_h264_eac3_faststart.mp4` | SDP 统一 UI，播放推进，禁用项置灰 |
| `mkv_h264_ac3.mkv` | SDP 统一 UI，不走原生无声 |
| `mkv_h264_eac3.mkv` | SDP 统一 UI，无 AbortError fetch 噪声 |
| `mkv_h264_aac.mkv` | Native-first，不被错误切 SDP |
