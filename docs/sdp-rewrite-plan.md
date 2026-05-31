# SDP 重构方案 v2

## 背景

当前 SDP（Self-Develop Player）是一个 1036 行的单体组件，自研 EBML 解析器反复出错，
Worker 双路径维护困难，帧跳过策略导致运动区域马赛克。决定彻底重写。

## 核心决策

| 决策 | 选择 | 理由 |
|------|------|------|
| Demuxer | mediabunny (v1.45+) | 成熟库，MKV 原生支持，自带 seek/Cues，15kB gzip |
| Worker | 不用 | 1080p decode 在 parallel queue 执行，不阻塞主线程 |
| 渲染 | VideoDecoder + ctx.drawImage(VideoFrame) | VideoFrame 是 CanvasImageSource，零拷贝 GPU blit |
| 帧调度 | rAF + 选择最接近当前时间的帧 | W3C audio-video-player 参考模式 |
| 时钟 | AudioContext.currentTime 主时钟 | 最稳定，避免 drift |
| 背压 | decodeQueueSize < 5 + frame queue ≤ 5 | W3C 推荐 |
| 页面隐藏 | visibilitychange 事件 | 暂停 demux + 清空帧队列 |
| Seek | mediabunny getKeyPacket(time) | 原生 Cues 解析 |
| 网络层 | CustomSource 适配 RangeFileReader | 复用多 chunk 签名 URL |
| 音频 | AudioDecoder + BufferSource 调度 | 不需要 AudioWorklet/SAB |

## 架构图

```
page.tsx (?sdp=2)
  └─ SdpPlayer (sdp-player.tsx) — UI 壳
       └─ PlayerEngine (player-engine.ts) — 协调器
            ├─ SdpDemuxer (demuxer.ts) — mediabunny 封装
            ├─ VideoRenderer (video-renderer.ts) — decode + canvas
            ├─ AudioRenderer (audio-renderer.ts) — decode + WebAudio
            └─ PlaybackClock (clock.ts) — A/V 同步时钟
```

## 文件结构

```
frontend/src/lib/sdp/
├── player-engine.ts      # 生命周期、A/V 同步、visibility
├── demuxer.ts            # mediabunny Input + CustomSource + EncodedPacketSink
├── video-renderer.ts     # VideoDecoder + Canvas 2D + 帧队列
├── audio-renderer.ts     # AudioDecoder + AudioContext 调度
├── clock.ts              # AudioContext 主时钟 + perf.now fallback
├── types.ts              # 共享类型
└── index.ts              # 导出

frontend/src/components/
└── sdp-player.tsx        # 新 UI 组件
```

## 关键实现细节

### 1. CustomSource 适配器

```ts
import { CustomSource } from 'mediabunny';
const abortController = new AbortController();
const source = new CustomSource({
  getSize: () => reader.totalSize,
  read: async (start, end) => {
    const buffer = await reader.read(start, end, abortController.signal);
    return new Uint8Array(buffer);
  },
  dispose: () => abortController.abort(),
  prefetchProfile: 'network',
  maxCacheSize: 16 * 1024 * 1024,
});
```

### 2. 帧调度（每个 rAF tick）

```ts
function renderTick() {
  if (frameQueue.length === 0) { scheduleNext(); return; }
  const mediaTime = clock.getCurrentTimeUs();
  // 找到 timestamp <= mediaTime 的最新帧
  let bestIndex = -1;
  for (let i = 0; i < frameQueue.length; i++) {
    if (frameQueue[i].timestamp <= mediaTime) bestIndex = i;
    else break;
  }
  if (bestIndex < 0) { scheduleNext(); return; }
  // 丢弃所有比 best 更老的帧
  for (let i = 0; i < bestIndex; i++) frameQueue[i].close();
  frameQueue.splice(0, bestIndex);
  // 渲染 best
  const frame = frameQueue.shift();
  ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  frame.close();
  scheduleNext();
}
```

### 3. 背压控制

```ts
async function feedDecoder() {
  for await (const packet of videoSink.packets()) {
    if (disposed) break;
    // 等待 decoder 有空间
    while (decoder.decodeQueueSize >= 5) {
      await new Promise(r => decoder.addEventListener('dequeue', r, { once: true }));
    }
    // 等待 frame queue 有空间
    while (frameQueue.length >= 5) {
      await sleep(16);
    }
    decoder.decode(packet.toEncodedVideoChunk());
  }
}
```

### 4. Visibility 处理

```ts
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    engine.pause(); // 暂停 packet 迭代
    videoRenderer.clearFrameQueue(); // close 所有 pending frames
  } else {
    engine.resume(); // 从当前时间 seek 到最近 keyframe 恢复
  }
});
```

### 5. Seek 实现

```ts
async function seek(timeSec: number) {
  clock.pause();
  decoder.reset(); // 清空 decode queue
  videoRenderer.clearFrameQueue();
  const keyPacket = await videoSink.getKeyPacket(timeSec);
  if (!keyPacket) return;
  decoder.configure(decoderConfig); // reset 后需要重新 configure
  // 从 keyPacket 开始重新喂入
  resumeFrom(keyPacket);
  clock.seekTo(timeSec);
  clock.resume();
}
```

## 实施步骤

| 阶段 | 内容 | 验证 |
|------|------|------|
| 0 | npm install mediabunny | import 不报错 |
| 1 | POC: 30 行脚本验证 mediabunny 解析我们的 MKV | 打印 decoderConfig |
| 2 | lib/sdp/types.ts | tsc --noEmit |
| 3 | lib/sdp/clock.ts | tsc --noEmit |
| 4 | lib/sdp/demuxer.ts | tsc --noEmit |
| 5 | lib/sdp/video-renderer.ts | tsc --noEmit |
| 6 | lib/sdp/audio-renderer.ts | tsc --noEmit |
| 7 | lib/sdp/player-engine.ts | tsc --noEmit |
| 8 | components/sdp-player.tsx | tsc --noEmit |
| 9 | self-develop-player.tsx 加 ?sdp=2 开关 | 页面可切换 |
| 10 | 实际播放测试 | 无马赛克、无快进 |
| 11 | 删除旧代码 | tsc --noEmit + 播放正常 |

## 切换策略

- `?sdp=1` → 旧架构（保留到新架构验证通过）
- `?sdp=2` → 新架构
- 验证通过后：`?sdp=1` 指向新架构，删除旧代码

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| mediabunny 解析失败 | 低 | POC 先验证 |
| 低端设备主线程卡顿 | 低 | 预留 Worker 升级路径 |
| CDN URL 过期 | 中 | read 中加 URL 刷新 |
| mediabunny bug | 低 | 库活跃维护，可提 issue |

## 旧文件（验证通过后删除）

- frontend/src/components/mkv-webcodecs-preview.tsx
- frontend/src/lib/mkv-webcodecs.ts
- frontend/public/mkv-decode-worker.js

## 保留文件

- frontend/src/lib/range-file-reader.ts（CustomSource adapter 依赖）
</content>
</invoke>