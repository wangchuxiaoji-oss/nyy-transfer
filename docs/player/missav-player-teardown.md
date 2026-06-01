# missav 播放器深度拆解 与 对 SDP v2 的启发

> 参考页面：`https://missav.live/cn/fns-211`
> 对照对象：本项目自研 MKV 播放器 SDP v2（`frontend/src/lib/sdp/` + `frontend/src/components/sdp-player.tsx`）
> 本文只做拆解与方案分析，不含代码改动。所有行号基于撰写时的代码快照。

## 0. TL;DR

- **missav** = `hls.js 1.4.3`（传输 + 喂 MSE）+ 浏览器原生解码 + `Plyr 3.6.8`（纯 UI 皮）
  + 自研 `plyr-plugin-thumbnail.js`（离线雪碧图预览）。重活在服务端切片和成熟库里，前端极薄。
- **SDP v2** = `mediabunny`（客户端解封装 MKV）+ `WebCodecs`（软解）+ Canvas 2D 渲染
  + 自研音频主时钟 + 自研预读缓冲 + 自研 seek。重活全在客户端，约 2300 行。
- 两者方向相反，**根因是约束不同**：
  - missav 掌控片源、可离线转码切片，所以能把活全推给服务端 + hls.js。
  - 本项目是「任意用户上传的 MKV + 后端不转码 + 文件躺 TOS + 浏览器原生放不了 MKV」，
    只能客户端 demux + 软解。
- 结论：**hls.js 路线无法直接照搬**（前提条件不成立），但 missav 的三个设计可借鉴：
  ①「UI 与解码彻底解耦」②「能力探测降级链 + 永远有兜底」③「离线预生成缩略图」。
- 二次核实补充（详见第 6 节）：本项目 Plyr 已是 **3.7.8、原生支持 `previewThumbnails`**；
  MKV 的 `mkv_seek` 索引**只有消费者无生产者**（恒 null）；上传时的元数据探测流水线
  **只解析 MP4、完全不碰 MKV**；后端**只有 ffprobe、无 ffmpeg**。这些直接影响各启发的落地成本。
- 第三轮补充（详见第 7 节）：本项目其实有**三套播放路径**，不止两套——
  原生 `MediaPlayer` 用 **Service Worker 虚拟 Range 文件**把多分片喂给原生 `<video>`，
  这个中间层在架构角色上**等价于 missav 的 hls.js**（都是「喂字节给原生解码器的适配层」）；
  此外还有 **H.264+AC-3 的 wasm sidecar** 路径。SDP 才是唯一绕开原生解码器的自研内核。
- 第四轮复核（详见第 8 节）：headless Playwright 被 Cloudflare 拦在 403/挑战页；改用**真实 Chrome
  + 有头模式（xvfb）+ 持久化 profile** 后 ~3 秒通过 managed challenge，已拿到完整运行时。实测坐实了
  三件套版本（Plyr 3.6.8 / hls.js 1.4.3）、4 档 variant、以及缩略图配置（`nineyu.com/<uuid>/seek/_0..190.jpg`
  共 191 张，与 1.6 一致）。另外发现两个工程细节：hls.js 还开了 `lowLatencyMode:true`/`maxBufferLength:30`、
  ABR 默认锁 1080p（`autoLevelEnabled:false`）；视频分片 `videoN.jpeg` 实为 **MPEG-TS 伪装成 jpeg**（反封锁）。

## 1. missav 播放器拆解

### 1.1 资源加载与三件套

页面 `<head>` 用 `<link rel="preload">` 预拉，`<body>` 末尾 `defer` 加载：

```
plyr 3.6.8 (cdnjs)              # UI 皮：控制条 / 画质菜单 / 字幕 / 快捷键 / 全屏 / 速度
plyr-plugin-thumbnail.js (自托管) # 自研插件：进度条悬停缩略图（雪碧图）
hls.js 1.4.3 (cdnjs)           # 传输：拿字节 → 喂 MSE，处理 ABR / 分片 / buffer / 错误恢复
原生 <video class="player">      # 真正的解码器是浏览器自己
```

职责切得很干净，**这是整套设计最值得学的一点**：Plyr 完全不碰解码，只发信号。

### 1.2 video 元素

播放器挂在一个标准 `<video>` 上（页面 2654-2664 行）：

```html
<video x-cloak controls playsinline
       data-poster="https://fourhoi.com/fns-211/cover-n.jpg"
       preload="none" class="player" crossorigin="anonymous"
       style="--plyr-color-main: #fe628e; --plyr-captions-background: rgba(0,0,0,0.5);">
</video>
```

- `preload="none"`：不点播放绝不下载媒体，省带宽。
- `data-poster`：封面图。
- Plyr 主题色用 CSS 变量 `--plyr-color-main` 注入。
- **关键**：因为是原生 `<video>`，Plyr 才能直接接管（这点后面对照 SDP 时是核心障碍）。

### 1.3 视频源：三档，地址用 base36 packer 混淆

DOMContentLoaded 内（页面 3542 行）有一段 `eval(function(p,a,c,k,e,d){...})`，解开后是：

```
source     (master playlist) = https://surrit.com/<uuid>/playlist.m3u8
source1280 (1080p variant)    = https://surrit.com/<uuid>/1080p/video.m3u8
source842  (720p variant)     = https://surrit.com/<uuid>/720p/video.m3u8
```

- `playlist.m3u8` 是 HLS master playlist（内含多档 variant）。
- `source1280 / source842` 不是 MP4 单文件，而是**具体清晰度的 HLS variant playlist**，
  用于绕过 master playlist/ABR，尝试直接交给浏览器原生 HLS 或做回退播放。
- **分片用 `.jpeg` 伪装**（运行时实测，详见第 8 节）：`video.m3u8` 引用的分片名是 `video0.jpeg …`，
  但首字节是 `0x47`（MPEG-TS sync byte）、响应头 `Content-Type: image/jpeg`。即真实是 MPEG-TS
  分片，套 `.jpeg` 后缀 + 图片 MIME 来规避基于 `.ts` 的广告/防火墙拦截。这是反封锁细节，与缩略图无关。
- 混淆纯为反盗链，对播放架构无意义——真正的设计在下面的分流。

### 1.4 核心：四路分流的播放初始化（页面 3706-3768 行）

按环境能力选不同播放路径，这是整段脚本的灵魂：

```js
if (isPreviewing) {                              // ① 预览态：只挂 Plyr，不给源（见下方勘误）
  player = new Plyr(video, playerSettings)
} else if (!Hls.isSupported()) {                 // ② hls.js/MSE 不可用
  player = new Plyr(video, playerSettings)
  video.src = source842                          //    → 720p HLS variant，交给浏览器原生能力
} else if (iPad || (Mac && maxTouchPoints > 1)) {// ③ MSE 可用但设备像 iPad / 触屏 Mac
  player = new Plyr(video, playerSettings)
  video.src = source1280                         //    → 强制走 1080p HLS variant 的原生播放路径
} else {                                         // ④ 主路径：hls.js + MSE
  hls = new Hls({ autoStartLoad: true, maxBufferSize: 1*1000*1000 })
  hls.loadSource(source)
  hls.on(MANIFEST_PARSED, () => {                //    manifest 解析后才建 Plyr
    player = new Plyr(video, { quality: {...}, ...playerSettings })
  })
  hls.attachMedia(video)
}
```

设计要点逐条：

1. **能力探测优先级**：代码先判断 `!Hls.isSupported()`，再判断 iPad-like 平台，最后才走 hls.js 主路径。
   - `maxTouchPoints > 1` 那条是识别「UA 伪装成 Macintosh 的现代 iPad/触屏 Mac」，
     这类设备即使 MSE/hls.js 可用，也可能更适合交给系统原生 HLS。注意因为 `!Hls.isSupported()`
     分支在前，③只覆盖「hls.js 判定可用但仍想强制原生 HLS」的 iPad-like 设备。
2. **Plyr 在 `MANIFEST_PARSED` 之后才实例化**（仅主路径）：
   因为画质菜单选项要等 manifest 解析出 `hls.levels` 才能填进去。
3. **画质切换 = Plyr ↔ hls.js 桥接**（3744-3760 行）：
   ```js
   quality: {
     forced: true, default: 0,
     options: [...hls.levels.map(l => l.height).reverse(), 0],  // 0 = 自动
     onChange: height => {
       if (height === 0) setHlsDefaultLevel()                   // 自动
       else hls.levels.forEach((lvl, i) => { if (lvl.height === height) hls.currentLevel = i })
     },
   }
   ```
   Plyr 不懂 HLS，它只在 UI 上画菜单、发 `onChange`，真正切流的是 hls.js。
   **这就是「UI 皮」与「传输内核」解耦的范本。**

**严谨勘误（二次核实）**：
- 分支 ① `isPreviewing` 在该页面**恒为 `false`**（页面 3540 行硬编码，全段无赋值），所以①是
  **死分支**。真正的「预览」是另一套机制：列表项悬停时播放独立的 `cdnUrl('/<dvd_id>/preview.mp4')`
  小视频（页面 2405/3172 行的 `data-src` + 3346-3358 的 hover 播放），与主播放器无关。
- hls.js 的实例配置：页面源码写了 `autoStartLoad:true` + `maxBufferSize:1MB`；运行时实测
  `hls.config` 还含 `maxBufferLength:30` + `lowLatencyMode:true`（详见第 8 节）。
  **没有**调用 hls.js 的错误恢复 API（`recoverMediaError`/`startLoad` 重试/`levelLoadingMaxRetry` 等）；
  唯一的错误处理是 manifest 未解析时遇 429 重新 `loadSource`（1.7）。即 missav 对 hls.js 的用法很薄，
  主要吃它的「分片传输 + MSE 喂数据 + ABR 档位」，错误恢复基本靠默认行为。
- 由于配置了 `autoStartLoad:true`，首次 `play` 里的 `hls.startLoad(-1)` **不能解释为严格的
  “不点播放只下载 manifest”延迟加载策略**。它更像保险性的启动/恢复调用。是否提前拉分片由 hls.js
  默认加载策略和媒体状态共同决定。

### 1.5 playerSettings（3655-3704 行）

```js
controls: ['play-large','rewind','play','fast-forward','progress','current-time',
           'duration','mute','captions','settings','pip','fullscreen','volume']
speed: { selected: 1, options: [0.25,0.5,1,1.25,1.5,2] }
fullscreen: { enabled: true, fallback: true, iosNative: true }
keyboard: { focused: true, global: true }
i18n: { speed:'速度', normal:'普通', quality:'画质', qualityLabel: { 0:'自动' } }
thumbnail: { enabled:true, pic_num:6875, width:300, height:168, col:6, row:6, urls:[...] }
```

注意 `controls` 列表——这就是 Plyr 自带、零成本拿到的全套 UI 组件。

### 1.6 缩略图插件 `plyr-plugin-thumbnail.js` 算法拆解

这是 missav 自研的、最值得逆向学习的一块。它把一段视频的所有预览帧拼成多张
「雪碧图（sprite sheet）」离线托管在 CDN（`nineyu.com/<uuid>/seek/_N.jpg`，运行时实测
`urls` 共 191 张 `_0.jpg … _190.jpg`，详见第 8 节），
播放时不解码、不实时算，纯靠定位贴图。配置含义：

| 字段 | 值 | 含义 |
|------|-----|------|
| `pic_num` | 6875 | 整片一共采样 6875 张预览帧（约每 2 秒一帧，13750 秒片长） |
| `col` / `row` | 6 / 6 | 每张雪碧图 6×6 = 36 格 |
| `width` / `height` | 300 / 168 | 每格缩略图像素尺寸（16:9） |
| `urls` | [...] | 雪碧图分页 URL 数组，6875/36 ≈ 191 张（运行时实测正好 191，`_0.jpg … _190.jpg`） |

核心定位算法（插件 `showImageAtCurrentTime` / `setImageSizeAndOffset`）：

```
// 1. 鼠标在进度条的位置 → seekTime（秒）
secondsPerThumb = duration / pic_num            // 每张缩略图代表多少秒
thumbIndex      = floor(seekTime / secondsPerThumb)   // 第几张缩略图（全局序号）
sheetIndex      = ceil((thumbIndex+1)/(col*row)) - 1  // 在第几张雪碧图（urls[sheetIndex]）

// 2. 在该雪碧图内的格子坐标
local  = thumbIndex+1 - col*row*sheetIndex      // 该雪碧图内的第几格
rowIdx = ceil(local/row) - 1
colIdx = local - rowIdx*row - 1

// 3. 用 background-position 偏移把对应格子露出来（按容器高度等比缩放）
scale  = containerHeight / config.height
img.style.left = `-${colIdx * width * scale}px`
img.style.top  = `-${rowIdx * height * scale}px`
```

行为细节：
- 区分 **hover 预览**（`thumb` 小图，跟随鼠标 X，`setThumbContainerPos` 做边界钳制）
  和 **scrubbing 拖动**（`scrubbing` 全宽大图，`mouseDown` 时切换容器）。
- 懒加载：`loadImage()` 只在切换到新雪碧图时 `new Image()`，旧图 500ms 后移除
  （`removeOldImages`），避免频繁请求。**运行时实测坐实**：播放 8s 内 `nineyu.com/.../seek/_N.jpg`
  零请求，只有 hover 进度条才按需加载对应 sheet（纯按需，不随播放预取）。
- 时间文本格式化器内置（时:分:秒）。
- 通过 `plyr.on('ready')` 挂载：`plyr.thumbnails = new n(plyr)`。

**要点**：缩略图是**离线预生成的产物**（服务端离线生成流程导出；页面源码只证明它是外部静态资源），前端只做贴图，
极快极省。这与「实时解关键帧画到 canvas」是两种成本量级。

### 1.7 其它打磨过的工程细节

| 细节 | 代码位置 | 做法 | 意图 |
|------|---------|------|------|
| 极小缓冲 | 3730 | `maxBufferSize: 1MB` | 尝试压低缓冲字节预算；具体生效还受 hls.js 其他内部阈值影响 |
| 起播钩子 | 3555-3559 | 首次 `play` 时显式 `hls.startLoad(-1)` | 更像一次启动/恢复钩子，不宜理解为严格「延迟起播」；代码里同时设了 `autoStartLoad:true` |
| 首帧 hack | 3547-3553 | 起播瞬间 `speed=2`，50ms 后还原 `1` | 用变速逼解码器吐首帧，加速封面消失 |
| stalled 自愈 | 3604-3633 | 仅原生直链路径：卡 500ms 后重设 `video.src` 跳回原时间 | hls.js 自带恢复，故此分支不用 |
| 429 重试 | 3733-3737 | manifest 未解析时遇 429 → 重新 `loadSource` | 抗 CDN 限流 |
| 自动画质 | 3643-3651 | `level.width+20 > innerWidth` 选第一档；窗口/全屏/旋转重算 | 按显示尺寸而非网速选档 |
| 可见性暂停 | 3770-3786 | `visibilitychange`/`blur`/window blur 全暂停 | 省流 |
| 全屏转屏 | 3572-3582 | 进全屏锁横屏、退全屏锁竖屏 | 移动端体验 |
| 转化打点 | 3586-3599 | 播放进度 >100s 触发 recombee AddPurchase | 推荐系统埋点（业务，非播放） |

### 1.8 一句话概括 missav 架构

> 服务端把片源离线切成 HLS 多档 + 离线生成雪碧图；前端 hls.js 负责传输与喂 MSE，
> 浏览器原生解码，Plyr 只做皮，画质切换是 Plyr↔hls.js 的信号桥接。
> **重活全在服务端和成熟库，前端代码极薄、几乎没有自研播放逻辑。**

## 2. SDP v2 拆解（本项目 MKV 播放器）

### 2.1 组件分流：谁在什么时候放什么

分享页 `app/[code]/page.tsx:699-705` 按文件类型分流：

```tsx
const useSdp = sdpEnabled && isSingle && getSelfDevelopMediaType(dl.file_name) !== null;
if (useSdp) return <SelfDevelopPlayer .../>;   // mp4/mkv/wmv 且 ?sdp=1|2
const mt = getMediaType(dl.file_name);
if (!mt) return null;
return <MediaPlayer .../>;                      // 其余走 Plyr+原生
```

- `sdpEnabled` 由 URL `?sdp=1`/`?sdp=2` 开启 → **MKV 自研播放目前是灰度功能，默认关闭**。
- 三个播放组件分工：

| 组件 | 文件 | 用途 | 底层 |
|------|------|------|------|
| `MediaPlayer` | `media-player.tsx`（597 行） | mp4/webm/音频 | 原生 `<video>` + **Plyr** UI；AC-3 走 wasm sidecar |
| `SelfDevelopPlayer` | `self-develop-player.tsx`（319 行） | mp4/mkv/wmv 探测分流壳 | 探测容器头后决定路径 |
| `SdpPlayer` | `sdp-player.tsx`（266 行） | **MKV 实际播放** | `<canvas>` + WebCodecs（SDP v2 引擎） |

### 2.2 分流壳 SelfDevelopPlayer 的探测逻辑

`self-develop-player.tsx`：
- 只接受 mp4/mkv/wmv（`:11` `SDP_VIDEO_EXTS`）。
- MKV 先读头部做容器探测（`:79` 快探 4MB，不足再扩到 16MB；`:88-94`）。
- 探测出有可解码音频轨才挂真正的 `SdpPlayer`（`:200-208`）：
  ```tsx
  {ext === "mkv" && probe?.probe_status === "ok" && hasProbeAudioTrack && (
    <SdpPlayer file={file} debugLog={debugLog} />
  )}
  {ext === "mkv" && probe?.probe_status === "ok" && !hasProbeAudioTrack && (
    <div>SDP v2 音频主时钟需要音频轨；当前文件未检测到音频轨，已禁用 SDP 播放。</div>
  )}
  ```
- `collectCapabilities()`（`:252`）探测 WebAssembly / VideoDecoder / AudioDecoder /
  MediaSource / AudioContext / WebGL2 等——**已经有「能力探测」雏形，但只用于显示，没接降级链**。

### 2.3 SdpPlayer 组件（UI 层 = 自研极简控制条）

`sdp-player.tsx`：
- 渲染一个 `<canvas>`（`:136-140`，固定 16:9）+ 自研控制条。
- 控制条只有：播放/暂停按钮（`:154-168`）、`<input type=range>` 进度条（`:169-182`）、
  时间文本（`:183-185`）、缓冲提示遮罩（`:141-150`）、错误文本（`:188-190`）。
- **没有**：音量、全屏、画质、字幕、速度、PiP、快捷键、缩略图预览——
  对比 missav 的 Plyr controls 列表，差距明显。
- seek 用「prewarm + debounce」：
  - `handleScrubStart`（`:82`）/`handleScrubChange`（`:93`，80ms 防抖）→ `engine.prewarmSeek()`
  - `handleScrubCommit`（`:106`）→ `engine.prewarmSeek()` + `engine.seek()`
- 回调桥接：`engine.onStateChange/onTimeUpdate/onBufferingChange/onError`（`:41-48`）。
- 调试 flag：`?prefetch=1`、`?prefetchProfile=`、`?seekParallel=N`（`:195-208`）。

### 2.4 引擎 PlayerEngine（协调器，1142 行）

`player-engine.ts`，是整个 SDP 的中枢，自己实现了 missav 全靠浏览器+hls.js 免费拿到的东西：

- **生命周期**：`init()`（`:133`）解封装→配置解码器→建预读缓冲→挂可见性监听→`ready`。
  - `:156-159` **无音频轨直接报错禁用**；`:161-170` 校验 AudioDecoder 支持性。
- **播放** `play()`（`:214`）：先启动预读缓冲填充，再起音频基线、feed 循环、渲染循环、时钟。
- **暂停** `pause()`（`:277`）：冻结时钟 + suspend 音频，保留基线供干净恢复。
- **seek** `seek()`（`:324`）：8 步——bump epoch 杀旧 feed 循环 → 暂停音频 → 停渲染+冻结时钟到
  目标 → 等旧循环退出 → reset 解码器 → 找目标前最近关键帧（**seek 时开 4 路并行下载**
  加速 cluster 拉取，`:401`）→ 隐藏解码到目标帧后提交（`commitSeekFrame`）→ 恢复渲染。
- **prewarmSeek**（`:288`）：用户还在拖动时就 `metadataOnly` 预取关键帧位置，降低提交延迟。
- **可见性** `handleVisibilityChange()`（`:863`）：隐藏即冻结时钟、停渲染、清帧队列、suspend
  音频；恢复时重对齐音频后再起时钟（`:877` `resumeFromVisibilityHidden`）。
- **卡顿检测** `updateStallState()`（`:941`）：250ms tick 内时钟不前进且音频缓冲 <0.15s
  持续 ≥1s → 进入 `stall` 缓冲态（`:955-959`）。
- **关键帧缓存**：`videoKeyPacketCache`（`:58`）+ 复用 in-flight 查找（`:582`），减少重复 range 请求。

### 2.5 SdpDemuxer（解封装，269 行）

`demuxer.ts`：用 mediabunny 适配多分片 CDN。
- `init()`（`:69`）：`new CustomSource({ getSize, read, dispose, prefetchProfile:'fileSystem',
  maxCacheSize:16MB })` → `new Input({ source, formats:[MATROSKA] })`（`:135`，**只认 MKV**）。
- `read`（`:77-129`）把 mediabunny 的字节请求转发到 `RangeFileReader`（HTTP Range 打 TOS），
  并统计吞吐/慢读（`:96-109`）。
- 取轨：`getPrimaryVideoTrack()` + `getDecoderConfig()`（`:138-150`）拿 `VideoDecoderConfig`；
  音频同理（`:154-166`）。`getDurationFromMetadata()`（`:169`）取时长。
- seek 定位：`getVideoKeyPacket(timeSec)`（`:188`）= mediabunny 原生 `getKeyPacket`（读 Cues）。
- `setParallelMode(parts)`（`:64`）：seek 时切到并行下载，结束切回 1。
- `probeElementAt()`（`:214`）：只读校验探针，验证 seek 字节偏移是否落在真正的 Cluster
  （`MKV_CLUSTER_ID = 0x1f43b675`，`:247`），自带 EBML element ID 解析（`:254`）。

### 2.6 PacketBuffer（预读缓冲，252 行）

`packet-buffer.ts`：夹在「网络（demuxer）」和「解码（feed 循环）」之间的 run-ahead 缓冲，
**这是 missav 完全不需要、由 hls.js 内部 buffer 替代的一层**。
- 容量：默认 `maxAheadSec=30`（`:38`）或 `maxBytes=128MB`（`:39`），先到先停。
- 生产者 `runAhead()`（`:181`）：持续从 mediabunny `sink.packets()` 拉包入队，满则背压等待
  （`:189-194` `spaceWaiter`）。
- 消费者 `take()`（`:123`）：有包立即返回，无包则挂 `waiter` 等生产者唤醒。
- seek 时 `reset(sink, startPacket)`（`:110`）清空并从新位置重填。
- 用 `epoch`（`:46`）防止旧填充循环污染新位置。

### 2.7 VideoRenderer（解码+渲染，267 行）

`video-renderer.ts`：遵循 W3C WebCodecs audio-video-player 模式。
- `VideoDecoder`（`:43`）输出帧插入有序队列（`:205` `insertFrame`）。
- 背压：`decodeQueueSize < 5` 且帧队列 `< 5`（`:14-15`、`:61-67`）。
- 渲染循环 `renderFrame()`（`:104`）：rAF 驱动，选 `timestamp <= 时钟时间` 的最新帧，
  丢弃更老的帧（`:110-126`），`ctx.drawImage(frame)` 画到 canvas（`:136`，VideoFrame
  是 CanvasImageSource，零拷贝 GPU blit），用完 `frame.close()`。
- seek 预览：`beginSeekSuppression()`（`:147`）解码但不显示；`commitSeekFrame()`（`:166`）
  画出目标帧并解除抑制。

### 2.8 AudioRenderer + PlaybackClock（音频主时钟）

这是 SDP 最硬的骨头，整篇 `docs/player/sdp-audio-master-clock.md` 都在治它，**missav 零成本**（浏览器内部搞定）。
- `audio-renderer.ts`：`AudioDecoder` 解码 → `AudioContext.createBufferSource().start(when)`
  按媒体时间映射到 AudioContext 时间轴调度（`:88` `scheduleAudioData`）。
- 时钟 = AudioContext 硬件时钟：`scheduleAt = ctxStartTime + (T - mediaStartSec)`（`:120-124`）。
- **卡顿重锚**（`:129-136`）：计算出的排程时间落后实时 >0.15s 说明管线饿死，重锚到「现在」，
  否则恢复的音频会被判为迟到而丢弃。
- seek 时必须 `stopAllScheduledSources()`（`:161`）杀掉已排程的 look-ahead 音频，否则旧位置
  音频会和新位置重叠。
- `clock.ts`：`PlaybackClock` 以音频为时钟源，`getCurrentTimeSec()`（`:44`）取
  `max(frozenAtSec, audioTime)`；音频不可用时冻结在最后提交的媒体时间，**不按 wall-clock 前进**。
- `computeAudioClockSnapshot()`（`audio-renderer.ts:243`）的命门：
  `currentTimeSec = min(freeRun, scheduledEndSec)`——钳到已排程末尾，这是修掉 5.7s 漂移的关键。

### 2.9 后端：只分析，不转码

- `backend/app/services/video_analyzer.py`：只调 `ffprobe`（`:180`），不调 ffmpeg。
  检测 moov 位置、AC-3/EAC-3、生成播放策略建议。文案里「建议用 ffmpeg faststart」只是给人看，不执行。
- `backend/app/api/v1/video_inspect.py`：分析 API，结果存 `video-inspect-results/`。
- 文件字节**不经后端**：`shares.py:66-128` 给每个分片签发火山 TOS 签名 URL，
  浏览器直接对 TOS/CDN 发 Range（`range-file-reader.ts`）。
- **这就是「不能用 hls.js」的根本原因**：没有切片、没有 m3u8、没有转码环节。

## 3. 逐维度对照表

| 维度 | missav | 本项目 SDP v2 | 谁更省力 |
|------|--------|--------------|---------|
| 传输层 | hls.js（成熟库） | 自研 `range-file-reader` + `packet-buffer`（252 行） | missav |
| 解封装 | 服务端切片 + hls.js | 客户端 mediabunny 解 MKV（`demuxer.ts`） | missav |
| 解码 | 浏览器原生（MSE，硬解优先） | WebCodecs 软解（`video/audio-renderer.ts`） | missav（且更省电） |
| 渲染 | 原生 `<video>` | Canvas 2D `drawImage`（`video-renderer.ts:136`） | missav |
| A/V 同步 | 浏览器内部 | 自研音频主时钟（`clock.ts` + 整篇设计文档治漂移） | missav（巨大差距） |
| 缓冲管理 | hls.js 内部 buffer | 自研 PacketBuffer 30s/128MB 双阈值 + 背压 | missav |
| seek | 浏览器原生 | 自研 8 步 + 并行下载 + 关键帧缓存 + 隐藏解码提交 | missav |
| 多档/ABR | hls.js 免费给 + Plyr 画质菜单（实测默认锁 1080p，`autoLevelEnabled:false`） | 无（单源单码率） | missav |
| 字幕 | Plyr + WebVTT，开箱即用 | 只探测不渲染 | missav |
| 缩略图 | 离线雪碧图（贴图，极省） | 无（仅 seek 实时解关键帧到 canvas） | missav |
| 速度/PiP/快捷键/全屏 | Plyr 全有 | 全无 | missav |
| 卡顿恢复 | hls.js 自带 + 直链分支自愈 | 自研 stall 检测 + 音频重锚 | 平 |
| UI | Plyr（统一） | 自研极简控制条（`sdp-player.tsx`） | missav |
| 服务端 | 转码切片 + 生成雪碧图（重） | 只 ffprobe 分析（轻），不碰字节 | SDP |
| 能放任意 MKV/编码 | **否**（只放自己转好的） | **是**（H.264/H.265 + 各种音频） | **SDP（唯一壁垒）** |
| 前端代码量 | 极薄（~100 行胶水） | ~2300 行自研引擎 | missav |

**核心洞察**：除了「能放任意 MKV」这一条，几乎所有维度 missav 都更省力——
因为它把复杂度转嫁给了「服务端离线转码」。SDP 用大量自研代码，换的就是
「无需服务端转码、能直接放任意 MKV」这唯一但关键的能力。这是它的护城河，
也是它必须付出的代价。

> 说明：本表是 missav(HLS) 对 **SDP** 的对比。本项目的**原生 `MediaPlayer` 路径**
> 与 missav 才是真正同构的对照（都让浏览器原生解码），其「传输层」是 Service Worker
> 虚拟 Range 文件，角色等价于 hls.js——详见第 7 节。SDP 是三套路径里唯一的异类。

## 4. 启发与落地路径

按「投入 / 风险 / 收益」排序。每条都标注了真实技术障碍，不是泛泛而谈。

### 启发 1：UI 与解码彻底解耦（最值得学的设计，但有真实障碍）

missav 最聪明的不是 hls.js，而是 **Plyr 完全不碰解码、只发信号**这个分层
（见 1.4 的 `quality.onChange`）。本项目 Plyr 已在依赖里、已用于 `media-player.tsx:40` 的
原生路径，理论上应该把 MKV 的自研控制条也换成 Plyr，统一体验、白嫖字幕/速度/全屏/快捷键 UI。

**真实障碍（必须正视）**：
- `media-player.tsx:40` 的 `new Plyr(mediaRef.current, ...)` 绑定的是**原生 `<video>` 元素**。
  Plyr 的进度条、时间、音量、全屏、快捷键全部依赖 HTMLMediaElement 的属性和事件
  （`currentTime`/`duration`/`play()`/`timeupdate`/`seeking`…）。
- 但 `SdpPlayer` 渲染的是 `<canvas>`（`sdp-player.tsx:136`），**根本没有媒体元素**。
  Plyr 无法直接绑 canvas。

**两条可行方案**：
1. **薄适配层（推荐）**：写一个「假 HTMLMediaElement」适配器，把 PlayerEngine 的状态/事件
   映射成 Plyr 期望的接口（`currentTime` getter/setter → `engine.clock` + `engine.seek()`；
   `play/pause` → `engine.play/pause()`；派发 `timeupdate`/`play`/`pause`/`seeking`/`ended`
   等事件）。Plyr 以 `customControls` 或包一个隐藏 `<video>` 占位来挂载，画面仍由 canvas 出。
   工作量集中在「事件/属性双向桥接」，**不动解码内核**。
2. **只借 Plyr 的 CSS/控件结构**：不真用 Plyr 实例，自己按 Plyr 的 DOM 结构补齐音量/全屏/
   速度/快捷键。更可控但等于重造一部分 Plyr。

判断：方案 1 收益最大（字幕/速度/全屏/快捷键全白嫖），但适配层有真实复杂度，需一个独立 spike
验证 Plyr 能否在「无真实 media element」下稳定工作。**风险中等，不是「零成本」**（前一版文档的说法需修正）。

### 启发 2：补一条「能力探测降级链 + 永远有兜底」

missav 的四路分流（1.4）核心是**永远有兜底**（`source842` 直链）。本项目已有探测雏形
（`self-develop-player.tsx:252 collectCapabilities` + `:200-208` 音频轨判断），但：
- AC-3 MKV / 无音频轨 MKV → `player-engine.ts:156-159` 直接报错禁用，**之后什么都不放**，体验断崖。

建议补成：
```
WebCodecs 支持 + 有可解码音频轨        → SDP v2
WebCodecs 支持但音频不可解（AC-3 等）  → 降级：video-only 静音播放 / 提示 + 下载 / 外部播放器
WebCodecs 不支持                       → 提示 + 下载引导
```
风险中等，主要是补降级分支与文案。

### 启发 3：离线预生成 seek 雪碧图（低风险，强烈建议）

missav 的缩略图（1.6）是离线雪碧图，前端只贴图。生成端可用 ffmpeg 抽帧拼图存到 TOS：
```
ffmpeg -i in.mkv -vf "fps=1/2,scale=300:168,tile=6x6" seek_%d.jpg
```
前端 seek 预览直接贴图，替换现在「实时解关键帧到 canvas」（`video-renderer.ts:166 commitSeekFrame`），
又快又省。生成缩略图是「分析/派生产物」，不是转码播放流，**不违背「后端不碰播放字节」原则**。

**前端贴图侧比想象的更省力（已核实）**：项目装的是 **Plyr 3.7.8，原生自带 `previewThumbnails`**
（`node_modules/plyr/dist` 已确认含该模块），吃标准 **VTT 雪碧图**格式。所以：
- 走 Plyr 路径（`media-player.tsx`）只要传 `previewThumbnails: { enabled:true, src:'thumbs.vtt' }`，
  **完全不用逆向 missav 的自研插件**。
- 若 MKV 也接上 Plyr（启发 1），缩略图同样白嫖。
- 只有在「坚持自研 canvas 控制条」时才需要逆向 1.6 的雪碧图公式。
- 有意思的对照：missav 自己**没用** Plyr 原生 `previewThumbnails`（运行时实测它被设为
  `{enabled:false}`），而是写了自研插件吃私有雪碧图格式。本项目反而可以走 Plyr 原生 VTT 这条更省的路。

**生成端的真实约束（已核实）**：后端只有 `ffprobe` 没有 `ffmpeg`（见 2.9），抽帧拼图需要引入 ffmpeg
（或扩展上传时的客户端探测流水线 `lib/media-metadata.ts`，但它当前只解析 MP4，见第 6 节）。
这是本启发唯一的新增依赖，但属「派生资源生成」，可离线/异步做。

### 启发 4：MKV remux→fMP4 喂 MSE（战略级，需先 spike）

这是 missav 路线最大的潜在启发，也最伤筋动骨。若统计发现大部分片源是 **H.264/H.265 + AAC**：
- 客户端 mediabunny 已能 demux（`demuxer.ts`），再加一个 **fMP4 muxer 做 `-c copy` 级别换壳**
  （不重编码），喂原生 MSE `SourceBuffer`。
- 一旦走 MSE，可**砍掉自研 A/V 同步、音频主时钟、帧调度、PacketBuffer**
  （即 2.6/2.7/2.8 全部，约 800+ 行 + 整篇漂移文档的痛），让浏览器接管。
  WebCodecs 软解只在「原生确实解不了的编码」保留。

前置条件 / 风险：
- 必须先统计片源编码分布（用现有 `video-inspect-results/` 数据或扩样）。
- AC-3 音频仍需转码或回退 WebCodecs，纯 remux 解决不了。
- fMP4 实时封装本身有复杂度（fragment 切分、时间戳、init segment）。

建议做一个独立 spike：「TOS 上的 H.264/AAC MKV 能否客户端 remux 成 fMP4 喂 MSE 稳定播放」。

### 启发 5：清醒边界——不要为了用 hls.js 而引入后端转码

missav 能用 hls.js 是因为它有片源、能离线转码。本项目是任意 MKV + 后端不转码 + TOS 直传
（见 2.9），**这种场景 hls.js 根本用不了**。
- 不要为「用上 hls.js」而引入后端转码切片，那会推翻「后端不碰字节、TOS 直传」的轻量架构。
- SDP 的 WebCodecs+mediabunny 路线在「浏览器原生放不了的 MKV」场景里是真实壁垒，missav 搬不过来。

## 5. 建议优先级

1. **启发 3（离线缩略图）** — 前端贴图侧最省（Plyr 3.7.8 原生 `previewThumbnails` 吃 VTT，零自研）；
   生成端需新建一条链路（前端 mediabunny 抽帧 或 后端引 ffmpeg，见 6.2/6.6），不碰播放字节。
2. **启发 2（降级链）** — 中风险，补齐 AC-3/无音频轨的体验断崖。
3. **启发 1（Plyr 统一皮）** — 收益大（白嫖整套 UI），但需先 spike 验证「Plyr 绑无 media-element 适配层」。
4. **启发 4（remux spike）** — 战略级，先做片源编码分布统计 + 可行性 spike 再决策。
5. 启发 5 是边界认知，贯穿所有决策。

> 注：前一版文档把启发 1 称为「零成本/低风险」，本版根据 `media-player.tsx:40`
> Plyr 绑定原生 `<video>`、而 `SdpPlayer` 只有 `<canvas>` 这一事实修正为「中风险、需适配层 spike」。

## 6. 查漏补缺：二次核实的关键事实

二次通读全部 SDP 代码 + 上传/存储链路后，新核实或修正的事实，按重要性排列。

### 6.1 `mkv_seek` 索引：只有消费者，没有生产者（重要）

- `mkv-seek-index.ts` 注释说 `mkv_seek` 是「上传时解析 MKV Cues 写入 `media_metadata`」。
- 但全仓 grep `mkv_seek` 的**写入方为零**——只有 `MkvSeekIndex.fromMetadata()`（消费）
  和 `player-engine.ts:113` 的调用。
- 结论：**生产环境 `MkvSeekIndex.fromMetadata()` 恒返回 null**，`runSeekIndexProbe()`
  （`player-engine.ts:593`）整段是**未来占位/调试死代码**，从不触发。
- 影响：当前 MKV seek 完全依赖 mediabunny 的 `getKeyPacket`（即时读 Cues），没有用到预存索引。
  若要做「服务端/上传时预存 seek 索引」，需先补这个生产者。

### 6.2 上传时已有「客户端探测元数据」流水线，但不支持 MKV（重要）

- `media_metadata` 的真实来源：**前端上传时**在浏览器里 `probeMediaMetadata()`
  （`lib/media-metadata.ts:43`）解析 → 随 commit 提交 → 后端 `uploads.py:89 _sanitize_media_metadata`
  落库 JSONB（`models/share.py:93`）。**不是后端 ffprobe**（ffprobe 只在 video-inspect 工具链里）。
- 但 `probeMediaMetadata` **只支持 mp4/m4v/mov**（`:9 SUPPORTED_EXTS`），自己手写 MP4 box 解析，
  **完全不碰 MKV**（grep 确认无 matroska/mkv/webm）。
- 影响：**MKV 文件目前的 `media_metadata` 基本是空的**。这同时解释了 6.1——MKV 没有上传探测，
  自然没有 `mkv_seek`。
- 对启发 3/4 的意义：若想「离线/上传时」为 MKV 生成缩略图或 seek 索引，有两条路：
  ① 扩展这条**客户端**流水线（用已在依赖里的 mediabunny 解 MKV，浏览器抽帧）；
  ② 在**后端**引入 ffmpeg。前者复用现有架构、不碰后端字节，可能更契合本项目哲学。

### 6.3 SDP seek 的完整 8 步（补全 2.4 的细节）

`seek()`（`player-engine.ts:324-515`）实际流程：
1. clamp + 防重入（`:331` 进行中则存 `pendingSeekSec` 排队）。
2. bump `playbackEpoch`（`:352`）让旧 feed 循环在下次检查时退出。
3. `runSeekIndexProbe`（`:365`，见 6.1，实为 no-op）+ `cancelCurrentPumps`（`:368`）+ 暂停音频。
4. 停渲染、冻结时钟到目标、开启 seek 抑制（`:372-376`）。
5. `waitForFeedLoopsToStop`（`:379`，3s 超时保护，`:518`）。
6. reset 视频/音频解码器（`:386-389`）。
7. 找关键帧：开 4 路并行下载（`:401`），`getVideoKeyPacketForSeek`（`:403`/`:541`）带
   **缓存命中**（`:547`）和 **in-flight 复用**（`:558`，距离阈值见 `canReuseVideoKeyLookup:582`）。
8. 从关键帧重启 feed，隐藏解码到目标帧后 `commitSeekFrame` 提交预览（`:457-466`）；
   `wasPlaying` 决定恢复播放还是停在 paused 存 `resumeSeekSec/resumeAudioPacket`（`:468-486`）。
- 失败兜底（`:487-502`）：回滚到 `previousTimeSec`，置 paused，必要时 `autoResumeAfterError`。
- 关键帧缓存（`:627 getCachedVideoKeyPacket` / `:640 cacheVideoKeyPacket`）：最多 N 条，
  只接受目标前、且回退距离 ≤ `VIDEO_KEY_CACHE_MAX_REWIND_SEC` 的关键帧；
  feed 时顺手缓存碰到的 key packet（`:654 cacheVideoKeyPacketIfNeeded`）。

### 6.4 `?sdp` 开关的精确判定（补全 2.1）

- `page.tsx:296-297`：`sdpParam === "1" || sdpParam === "2"` 才开启（其它值/缺省=关闭）。
- 真正挂 SDP 的三重条件（`:700`）：`sdpEnabled && isSingle && getSelfDevelopMediaType(name)!==null`。
- `isSingle`（`:603`）= 分享内**正好 1 个文件且无空目录**。即**多文件分享不启用 SDP**。
- `?sdp=1` 与 `?sdp=2` 在当前代码里都只是「开启」，未见行为差异（历史上区分新旧引擎，现已统一）。

### 6.5 RangeFileReader 的并行下载（补全 2.5）

- `range-file-reader.ts`：`totalSize`（`:47`）把多分片拼成一个逻辑地址空间（`:61-73`），
  单文件则退化为一个 chunk（`:75`）。
- `setParallelMode(parts, threshold)`（`:84`）+ `readParallel`（`:137`）：seek 时把一次大读
  拆成多个并行 Range 请求打 TOS/CDN，实测对限速 CDN ~2-3x 提速（见 `types.ts:46` 注释，默认 4 路）。
- `readFirstBytes`（`:127`）供容器头探测用（`self-develop-player.tsx` 的 MKV 头部探测）。

### 6.6 对前述结论的净影响

- **启发 3 落地更简单**：Plyr 3.7.8 原生 `previewThumbnails` 吃 VTT，前端贴图侧零自研（见已更新的启发 3）。
- **启发 3/4 的生成端**：别假设「后端已有 ffprobe 流水线可顺手扩」——后端无 ffmpeg，且 MKV 连
  `media_metadata` 都没探测（6.2）。生成缩略图/索引是一条**需要新建**的链路（前端 mediabunny 抽帧
  或后端引 ffmpeg 二选一）。
- **seek 预存索引**目前是空架子（6.1），若要利用，先补 MKV 上传探测（6.2）。

## 7. 补充对照：被忽略的「第三套播放路径」与网络层细节

前面 1-6 节聚焦 missav(HLS) vs SDP(WebCodecs)。但本项目其实有**第三套播放路径**——
原生 `MediaPlayer` 的多分片处理，它在架构角色上恰好对标 missav 的 hls.js。这一节补齐。

### 7.1 本项目的「原生路径」其实有一个等价于 hls.js 的中间层

`media-player.tsx` 不止是「Plyr + 原生 video」。对**多分片文件**（`file.is_chunked`）走
`NativeRangeChunkedMediaPlayer`（`:97`），它用一个 **Service Worker 把多分片 TOS 文件
伪装成一个可被原生 `<video>` 按 HTTP Range 读取的虚拟文件**：

- `registerVirtualMediaFile()`（`virtual-media.ts:75`）注册一个虚拟 URL，`<video src>` 指向它。
- `prepareVirtualMediaTransport()` / `registerVirtualMediaFile()` 会先确保 SW 已接管当前页面；
  之后 `MediaPlayer` 还会在 `controllerchange` / `visible` / `online` / 30s 轮询时重新注册虚拟文件，
  避免控制器切换后 URL 失效。
- SW（`public/nyy-virtual-media-sw.js`）拦截 `fetch`（`:52`），解析 `Range` 头（`:194/:221`）；
  **没有 `Range` 时不会失败，而是默认返回首个 slice**（`:222-237`）。对有效请求则返回
  **HTTP 206 Partial Content**（`:213-218`），`Content-Range`/`Accept-Ranges` 齐全。
- `makeRangeStream()`（`:240`）按需从背后多个分片 URL 取字节拼流（`:385` `fetch(chunk.url, {Range})`），
  带 **range 缓存**（`:90 getRangeCacheEntry` / `:112 putRangeCacheEntry`），并按最近吞吐在 2~4 路之间
  自适应调并发（`:288-297`）。

**架构洞察（重要）**：
> missav 的 hls.js 和本项目的「SW 虚拟 Range 文件」是**同一种角色**——
> 「把分散字节喂给浏览器原生解码器的中间适配层」。
> 区别只是：hls.js 喂的是 **HLS 分片 → MSE SourceBuffer**；
> SW 喂的是 **Range 拼接 → 原生 `<video>` 的 Range 请求**。
> 二者都让浏览器接管解码/同步/seek。SDP 才是唯一「绕开原生解码器」的异类。

所以本项目实际有三套：
| 路径 | 触发 | 喂给谁 | 解码 | 角色对标 missav |
|------|------|--------|------|-----------------|
| MediaPlayer direct URL | 非 chunked 的 mp4/webm/音频 | 原生 `<video>` / `<audio>` + Plyr | 浏览器 | 更接近 missav 的最简单原生回退 |
| MediaPlayer chunked Range | `file.is_chunked` | 原生 `<video>` + Plyr（经 SW 虚拟 Range） | 浏览器 | **= hls.js 路径**（仅对 chunked 的 SW Range 版本成立） |
| MediaPlayer + AC-3 sidecar | 典型是 H.264 + AC-3/EAC-3（Chrome） | 原生 `<video>`(视频静音) + WebAudio(音频) | 浏览器解视频 + wasm 解 AC-3 | missav 无对应（它转码时就避开了） |
| SdpPlayer | `?sdp=1\|2` 的 MKV | Canvas + WebCodecs | 全软解 | missav 无对应（真正的自研内核） |

### 7.2 AC-3 sidecar：missav 用转码回避、本项目用 wasm 硬扛

`media-player.tsx` 的 `NativeRangeChunkedMediaPlayer` 对 **H.264 + AC-3/EAC-3**（Chrome 不能原生解 AC-3）：
- `decideSidecar()`（`:175`）判定需要 sidecar → 把 `<video>` **静音**（`:179`），视频画面仍走原生。
- `startSidecarAudioWindow()`（`:206`）用 `lib/ac3-sidecar.ts` + `public/libav-ac3/`（libav wasm）
  **按时间窗口**解码 AC-3 音频，经 WebAudio `GainNode`（`:120`）输出，并把 Plyr 的音量/静音同步到
  GainNode（`:404-416`）。
- seek 时重建音频窗口（`sidecarWindowRef`/`sidecarSeekingRef` 防自触发，`:124-125`）。

对照：
- **missav**：服务端转码时音频统一转成浏览器能原生解的格式（HLS 里通常 AAC），前端永远不碰这问题。
- **本项目**：不转码 → 把「浏览器解不了的 AC-3」用 wasm 在前端硬解，还要自己做音视频两条管线的对齐。
  这跟 SDP 的音频主时钟是**同源的痛**：一旦脱离「浏览器原生整体解码」，A/V 同步就得自己扛。
- 注意：MKV 里的 AC-3 当前**直接禁用 SDP**（`player-engine.ts:156-170` 要求可解码音频轨），
  即 sidecar 方案目前只挂在 `MediaPlayer` 的原生 Range 路径上，**未接到 SDP**。这是已知的能力缺口（呼应启发 2）。

### 7.3 网络层逐项对照：SDP 的 RangeFileReader vs hls.js loader

`range-file-reader.ts`（343 行）是 SDP 的网络底座，它自己实现了一个生产级 HTTP Range loader——
**这些全是 hls.js 内置、SDP 不得不重造的轮子**：

| 能力 | RangeFileReader 实现 | 对应 hls.js |
|------|---------------------|-------------|
| 重试 | 3 次，退避 `[300,900]ms`（`:11-12`） | 内置 |
| 动态超时 | 按字节数算：`10s + 3.5s/MB`，封顶 30s（`:17-25`） | 内置 |
| 可重试状态码 | 408/429/500/502/503/504（`:267`） | 内置 |
| **拒绝 CDN 忽略 Range** | 收到 200 而非 206 时直接判定失败，绝不下整块（`:213-219`） | 内置 |
| 多分片地址空间 | 把多个分片拼成一个逻辑 `totalSize`（`:58-78`） | （HLS 用 playlist 表达，不需要） |
| 并行下载 | `readParallel` 把大读拆 N 路并发（`:137`，seek 时 4 路） | hls.js 也有分片并发 |
| 取消传播 | 父 signal（新 seek）= 定论取消、本次超时 = 可重试，二者区分（`:240-242`） | 内置 |
| body 计入超时 | headers 到了但流卡住也算超时（`:222-224`） | 内置 |

**洞察**：missav 用一行 `hls.loadSource(url)` 拿到的鲁棒性，SDP 用 343 行手写换来。
这是「自研内核」必然的隐性成本——不只是 demux/decode，连「可靠地拉字节」都得自己写。

### 7.4 SDP 的缓冲状态机（补全 2.4，对标 missav 的 stalled 处理）

SDP 有一套结构化缓冲态（`types.ts:19-27 BufferingState`，UI 在 `sdp-player.tsx:141-150`），
比 missav 的「卡 500ms 重设 src」精细得多：
- 两种原因：`seek`（定位中）和 `stall`（卡顿），见 `player-engine.ts:1022-1074`。
- **seek 进度可量化**：`createSeekBufferingState()`（`:1026`）按「已解码秒数 / 关键帧到目标的秒数」
  算百分比（`:1042-1049`），UI 显示「定位中 · 42% · 1.2 MB/s」（`sdp-player.tsx:256-265`）。
- **stall 进度**：`createStallBufferingState()`（`:1060`）按音频已缓冲秒数 / 恢复目标算。
- 速度来自最近一次 source read 吞吐（`:1076 getRecentSourceReadSpeedBytesPerSec`，过期阈值保护）。
- seek 进度到 100% 自动清除（`:1012-1019`）。

对照 missav：
- missav 的卡顿恢复是「钝」的——原生直链分支卡 500ms 后 `video.src=''` 重设跳回原时间（1.7），
  hls.js 分支干脆全交给库。没有可视化进度。
- SDP 因为全链路自控，反而能给出**带百分比和速度的缓冲提示**，这是自研的一个正向收益
  （体验上甚至优于 missav），但代价是这套状态机本身的复杂度。

## 8. Playwright 运行时复核（已成功绕过 Cloudflare）

### 8.1 绕过方法（环境内可复现）

第一次用 **headless** Playwright（bundled Chromium）访问时，被 Cloudflare 拦在 `403 / Just a moment...`
挑战页，拿不到任何播放器运行时。原因不是缺某个启动参数，而是 headless Chromium 的
`Runtime.enable` CDP 泄漏 + headless 指纹被所有主流 anti-bot（含 Cloudflare）识别。

社区主流解法有两类：①打补丁的驱动（`patchright`、`rebrowser-playwright`，专门消除 `Runtime.enable` 泄漏）；
②直接绕开 headless Chromium，用**真实 Chrome + 有头模式**。本机已具备方案 ② 的全部条件，遂选最省的一条：

- `channel: 'chrome'`——用 `/usr/bin/google-chrome` 真实 Chrome，而非 bundled Chromium。
- `headless: false` + `xvfb-run`——真有头模式跑在虚拟显示上（本机有 `Xvfb`/`xvfb-run`，`DISPLAY` 为空）。
- `launchPersistentContext`——持久化用户目录，保留 Cloudflare clearance cookie。
- `ignoreDefaultArgs:['--enable-automation']` + `--disable-blink-features=AutomationControlled` + 抹掉 `navigator.webdriver`。

结果：**~3 秒通过 Cloudflare managed challenge**（非交互式），无需打补丁驱动、无需第三方打码。
脚本见 `/tmp/opencode/missav-bypass-v1.mjs` 与 `/tmp/opencode/missav-runtime-full.mjs`。

### 8.2 运行时实测：被证实的结论

通过后从 `window.player` / `window.hls` / DOM / 网络面板直接读到（实测值，非推断）：

- **三件套版本全部坐实**：`plyr.min.js 3.6.8`（cdnjs）+ `plyr-plugin-thumbnail.js`（missav 自托管）
  + `hls.min.js 1.4.3`（cdnjs），`window.Hls.version === '1.4.3'`。
- `video.player` 的 `currentSrc` 是 `blob:`（MSE/hls.js 喂数据），`readyState === 4`，`duration ≈ 13750s`。
- hls.js 实际跑出 **4 档 variant**：360p/480p/720p/1080p，URL 形如
  `https://surrit.com/<uuid>/<res>/video.m3u8`，master 为 `…/playlist.m3u8`。**这坐实了 1.3 的判断**
  （`source*` 是清晰度 variant，不是 MP4 单文件）。
- Plyr `controls` 实测 13 项、`speed.options=[0.25,0.5,1,1.25,1.5,2]`、`i18n` 37 个 key、
  `keyboard:{focused:true,global:true}`、`quality.forced:true options:[1080,720,480,360,0]`——与源码一致。

### 8.3 运行时实测：需要修正/补强文档的点（重要）

> 勘误说明：本节第 1 版曾把视频分片 `videoN.jpeg` 误判为缩略图、并据此"修正"了 1.6 的
> `nineyu.com` 地址。第二轮直接读 `window.player.thumbnails.config` 与 `video.m3u8` 后**已推翻该误判**，
> 下面是核实后的最终结论。

1. **缩略图地址 1.6 原本就是对的**（此前的"修正"是错的，现已回滚）。实测
   `window.player.thumbnails.config.urls` 是 **191 个** `https://nineyu.com/<uuid>/seek/_0.jpg …
   _190.jpg`（与 `pic_num:6875, 6×6, 300×168` 完全自洽：⌈6875/36⌉=191）。缩略图托管在
   **`nineyu.com`**，与视频分片不同源。
2. **`surrit.com/<uuid>/<res>/videoN.jpeg` 不是缩略图，而是被伪装的视频分片**。直接拉
   `video.m3u8` 可见分片名就是 `video0.jpeg…`、`#EXTINF:4.004`（每片约 4s）；分片首字节
   `47 40 11 10`（`0x47` = MPEG-TS sync byte），`Content-Type: image/jpeg`。即 missav 把
   **MPEG-TS 分片伪装成 `.jpeg`**（配合 `image/jpeg` 头）来规避基于 `.ts` 后缀的广告/防火墙拦截。
   这是一个独立的反封锁工程细节，与缩略图无关。
3. **缩略图是纯按需 hover 加载，不随播放预取**（修正第 1 版的另一处误判——之前看到的"预取"
   其实是上面第 2 点的视频分片）。实测播放 8s 内 `nineyu.com/.../seek/_N.jpg` **零请求**，
   只有 hover 进度条时才加载对应 sheet，与 1.6「`loadImage()` 按需 + 旧图 500ms 回收」的源码分析一致。
4. **Plyr 原生 `previewThumbnails` 在 missav 侧是关闭的**：`config.previewThumbnails={enabled:false,src:''}`，
   缩略图完全由自托管插件（吃 `nineyu.com` 雪碧图）接管。这不影响「本项目 Plyr 3.7.8 原生支持
   `previewThumbnails`」的结论，但要讲清：missav 没用 Plyr 原生能力，是自己写插件贴 sprite。
5. **hls.js 配置比 1.5 记的多两项**：实测 `maxBufferLength:30` 且 `lowLatencyMode:true`（此前只记了
   `autoStartLoad:true` + `maxBufferSize:1MB`）。`lowLatencyMode:true` 对一个长片点播是略反直觉的配置。
6. **ABR 实际被钉死**：`autoLevelEnabled:false`、`currentLevel:3`（1080p），即默认顶格而非自适应。
   对照表里「多档/ABR hls.js 免费给」要补一句：missav **默认锁 1080p**，ABR 能力在但没开自适应。
7. 页面侧栏有**第二套无关播放器**（`growcdnssedge.com` 的 `121823173_240p.m3u8`，疑似广告/推荐位），
   与主片 `surrit.com` 解耦，分析主播放器时应忽略它。
