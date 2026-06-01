# SDP v2 — 音频主时钟重构设计

## 目标

把 A/V 同步从「独立 wall-clock + 事后 drift 纠正」改成「音频为主时钟,视频追随音频」。
彻底消除慢网络区段 seek 后出现的大幅漂移(实测 5.7s)与回跳。

## 背景:为什么现在会漂移

`docs/player/sdp-rewrite-plan.md` 原定方案就是「AudioContext.currentTime 主时钟 + perf.now
fallback」。但实现时 `clock.ts` 退化为**纯 wall-clock**(`performance.now()`),理由是
「AudioContext 在标签页隐藏时仍走时,导致跳变」。这个退化引入了三个独立时间源:

1. wall-clock(`PlaybackClock`)
2. 音频硬件时钟(`AudioContext.currentTime`)
3. 视频帧 PTS

三者互相追赶。慢区段的故障链:

1. CDN 慢节点,`source:read` 跌到 ~5000 kbps,30s 缓冲来不及填(实测 `videoBufferSec`
   一度只剩 5.17,`queueLen:0` 真饿)。
2. 但 wall-clock 不知道网络饿了,seek 后 `clock.play(clamped)` 立刻起跑,照走不误。
3. 视频/音频跟不上,漂移累积。
4. drift supervisor 每 300 包才查一次,饿时包稀疏,纠正来太晚 → 一次性硬拽 5.7s。

根因:**缓冲枯竭时 wall-clock 不会停**。打 stall 补丁只是治标。

## 核心思路:音频即时钟

成熟播放器(ffplay/mpv/ExoPlayer/Chromium)的默认做法 = audio master clock。

- **音频**:解码后灌进 AudioContext 排队播放。音频恒定速率,硬件时钟天然稳定。
  当前播放位置 = `getCurrentAudioTimeSec()`(已存在)。
- **视频**:每帧只问「音频播到哪了」:
  - 帧 PTS ≈ 音频时钟 → 现在画
  - 帧 PTS > 音频时钟 → 等
  - 帧 PTS < 音频时钟(迟到) → 丢帧追上
- **网络饿了**:音频 buffer 空 → 没有新音频排程 → 音频时钟(钳到已排程末尾,见下
  「命门」)**停止推进** → 视频跟着停。无 wall-clock 空跑 → **不产生漂移**,无需事后
  纠正。stall 成为自然行为。

一句话:「缓冲枯竭时时钟该不该 stall」这个纠结,在 audio-master 下不存在——音频就是
时钟,音频停时钟就停。

## 决策:有音频强制 audio-master,无音频禁用 SDP

MKV 音频格式五花八门(用户反馈:几乎所有见过的格式都出现过)。与其做「音频/wall 双模
仲裁」这种复杂切换,直接二分:

- **有可解码音频轨**(`audioInfo` 存在且 `AudioDecoder.isConfigSupported()` 通过)
  → SDP audio-master(本文档主体)。
- **无可用音频时钟**(无音频轨 / AC-3 等需 sidecar 未接 / `canDecode` 为 false)
  → **禁用 SDP 播放并给出不支持提示**。不要用 wall-clock 兜底;是否再尝试原生
  `MediaPlayer` 属于外层 UI 策略,不属于 SDP audio-master。

好处:消灭 WALL 模式、offset 锚定、主时钟仲裁、双源切换全部复杂度。`clock.ts` 退化成
音频时钟的薄包装。判定在 `init()` 一次性完成,运行期不再切换时钟源。

AC-3 现状未接 sidecar = 无可用音频时钟 = 禁用 SDP。未来接了 sidecar 再纳入
audio-master。

## 命门:音频时钟必须钳到「已排程末尾」

⚠️ 这是整个方案能否自动 stall 的关键,务必正确实现。

`AudioContext.currentTime` 是**自由运行的硬件钟**,只要 ctx 处于 running 就一直走,
与是否有音频排进 buffer 无关。当前实现:

```
audio-renderer.ts:187
return this.mediaStartSec + Math.max(0, ctx.currentTime - this.ctxStartTime);
```

网络饿了、没有新 source 排进去,听到的是静音,但 `ctx.currentTime` 照涨 →
`getCurrentAudioTimeSec()` 照涨 → 视频照样往前 → **漂移依旧**。这极可能就是当前
drift-correct 数值巨大(5712ms)的同一根因:饿时这个「假音频钟」也在飞。

**解法:钳到已排程音频末尾。** `audio-renderer.ts` 已维护 `scheduledEnd`(已排程音频在
ctx 时间轴的末尾):

```
freeRun           = mediaStartSec + (ctx.currentTime - ctxStartTime)
scheduledEndMedia = mediaStartSec + (scheduledEnd   - ctxStartTime)
audioTimeSec      = min(freeRun, scheduledEndMedia)
```

饿时没有新 source → `scheduledEndMedia` 不增长 → `audioTimeSec` 被钳住 → 视频自然停在
最后一段有声画面。`min()` 这一钳位是「音频停→视频停」真正成立的命门。
(`getBufferedAheadSec()` 已经在用 `scheduledEnd`,数据现成。)

## warmup:音频时钟未就绪时画面冻在 bootstrap 帧

首播 / seek 后音频要重新解码、重建 baseline(`reset()` 把 `ctxStartTime`/`mediaStartSec`
置 -1),这期间 `getCurrentAudioTimeSec()` 返回 -1。

对策(不引入 wall 引导钟):
- 时钟返回 -1 期间,视频渲染**冻在已解出的 bootstrap 关键帧**(seek 预览帧),不推进。
- 音频时钟一变有效(≥0 且在推进)→ 视频 time-gate 自然开始跟随。
- 现状 seek 后的 drift-correct(541ms / 1018ms / 5712ms)本质就是缺这个 warmup gate:
  音频没就绪时视频已经被 wall-clock 带跑了。

## stall(缓冲枯竭)语义

audio-master + 钳位下 stall 是自然结果:音频钟被钳住 → 视频 time-gate 不再满足 → 自动停。
但需**显式化**给 UI(转圈),而非静默卡住:

- 检测:音频钟连续 ~300ms 不推进,且 `audioBufferedSec` < 阈值 → 进入 `stalled`,
  发 `playback:stall`,UI 显示缓冲中。
- 恢复:音频钟重新推进 → 回 `playing`,发 `playback:resume`。

## visibility:隐藏时主动 suspend

当初放弃 audio-master 的顾虑是「AudioContext 隐藏时仍走时导致跳变」。在「钳到
scheduledEnd」+「隐藏时主动 `ctx.suspend()`」下消除:

- 隐藏:`player-engine.ts` 已有 `visibilitychange` → 调 `audioRenderer.pause()`
  (`ctx.suspend()`)→ `ctx.currentTime` 冻结 → 音频钟冻结 → 视频冻结,一致。
- 恢复:`ctx.resume()`,ctx 时间轴连续(`resume()` 注释已说明无需调整 baseline)。
- **阶段 0 PoC 必须实测**:Chrome 隐藏时 `suspend()` 是否真的冻结 `currentTime`,
  以及 resume 后时间轴是否连续。不能假设。

## 改动清单

| 文件 | 改动 |
|------|------|
| `audio-renderer.ts` | **核心**:`getCurrentAudioTimeSec()` 改为 `min(freeRun, scheduledEndMedia)` 钳位;增加「是否在推进」判定;保留并改名 starvation re-anchor 为 `stall-resume re-anchor`,用于饿后把迟到音频重新排到 `ctx.currentTime` |
| `clock.ts` | 退化为音频时钟薄包装:`getCurrentTimeSec()` 直接取钳位后的音频钟;音频钟 -1 时返回冻结值(warmup);删除 wall-clock 推算逻辑 |
| `player-engine.ts` | 删除 drift supervisor(Fix B / `av:drift-correct`);seek 后加 warmup gate(音频钟 -1 时视频冻 bootstrap 帧);stall 检测 + 事件透传;审计 `schedulePlaybackEnd()` 这类 fixed wall-time timer |
| `video-renderer.ts` | time-gate 已读 clock,无需大改;确认音频钟被钳住时丢帧逻辑不误丢 |
| `self-develop-player.tsx` / `player-engine.ts` | 切纯音频时钟前先建立 audio-required invariant:无可用音频时钟 → 不进入 ready,显示不支持/禁用提示 |
| `sdp-player.tsx` | 订阅 `playback:stall`/`resume` 显示缓冲 UI |

drift supervisor(`av:drift-correct`)删除——它是 wall-clock 漂移的补丁,钳位后不再需要。

## 实施步骤

| 阶段 | 内容 | 验证 |
|------|------|------|
| 0 | PoC:`ctx.suspend()` 是否冻结 currentTime + resume 连续性 | 控制台打印 |
| 1 | `audio-renderer.ts` 钳位 `min(freeRun, scheduledEndMedia)` + stall-resume re-anchor + 纯函数仿真 | tsc + diagnostic harness |
| 2 | audio-required invariant + `clock.ts` 退化为音频薄包装(删 wall-clock) | tsc |
| 3 | `player-engine.ts` 删 drift supervisor + seek warmup gate + fixed timer 审计 | tsc |
| 4 | stall 显式化 + UI;不支持提示打磨 | tsc |
| 5 | 真机:有音频正常区段 | A/V drift 全程 <50ms |
| 6 | 真机:慢区段 seek(复现 6306s) | 无 >1s 回跳,只 stall 转圈 |
| 7 | 真机:无音频轨 / 不可解码音频 MKV | 禁用 SDP,显示不支持提示 |
| 8 | 真机:标签页切换 | 恢复后音画同步,无累积漂移 |

## 验收标准

- 正常区段:`avDriftMs` 全程 < 50ms(当前已达到,不能退化)。
- 慢区段 seek:无 >1s 画面回跳;缓冲不足时 UI 显示 stall 而非画面飞走。
- 无音频轨 / 不可解码音频:不进 SDP,显示清晰不支持提示。
- 标签页切换:恢复后音画同步,无累积漂移。

## 风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| `suspend()` 不冻结 currentTime(隐藏跳变复发) | 中 | 阶段 0 PoC 先验证;不行则 resume 后按 scheduledEnd 重锚 |
| 钳位导致正常播放被误停(scheduledEnd 计算偏差) | 中 | 阶段 1 纯函数仿真 + 阶段 5 真机 drift 监控 |
| 误删饿后 re-anchor,恢复时音频一直被判定为过期并丢弃 | 中 | 阶段 1 保留为 stall-resume re-anchor;仿真覆盖饿 5s 后恢复 |
| fixed `setTimeout` 仍按 wall-time 结束播放 | 中 | 阶段 3 审计 `schedulePlaybackEnd()`;结束条件改看音频钟/真实 EOF |
| 音频本身慢区段顿挫带动视频顿挫 | 低 | 可接受(音画一起卡优于画面飞走);`scheduledSources` 已防爆音 |
| seek warmup 竞态(epoch) | 中 | 阶段 3 单独验证;epoch 守卫已有 |

## 回滚

每阶段独立提交。`audio-renderer.ts`/`clock.ts` 改动前打 tag。钳位若在某类文件误停,
可临时保留旧 free-run 行为作 `?clock=freerun` 回退开关。
