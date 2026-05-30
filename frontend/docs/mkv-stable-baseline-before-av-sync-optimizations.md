# MKV Stable Baseline Before A/V Sync Optimizations

This document records the MKV self-developed player baseline that existed before the later #1-#7 optimization attempts. It is intended as a recovery guide because that baseline was not committed.

## Scope

Baseline target:

- Client-side MKV playback through `?sdp=1` and `?debug=1`.
- No server-side remux, transcode, faststart, or video-byte processing.
- MKV demux happens in browser code.
- H.264 video decode uses WebCodecs `VideoDecoder` on the main thread.
- AAC audio decode uses WebCodecs `AudioDecoder` and schedules audio through `AudioContext`.
- Debug metrics flow through existing `sdp-mkv` debug events.

Primary files:

- `frontend/src/components/mkv-webcodecs-preview.tsx`
- `frontend/src/lib/mkv-webcodecs.ts`
- `frontend/src/components/self-develop-player.tsx`
- `frontend/src/app/[code]/page.tsx`
- `frontend/src/lib/range-file-reader.ts`

## Known Good Verification Result

Baseline was verified on the same server environment using Playwright/Chromium + Xvfb against:

- URL: `https://dev.nyy.app/bpJpXZ?sdp=1&debug=1`
- Test file: `TEAM-053.mkv`, 3.32 GB, H.264 + AAC, 1920x1080
- Frontend: `next dev -H 0.0.0.0`

Observed baseline results:

- 10-minute playback: about `260 MB` read, `16200` frames rendered.
- Page errors: `0`.
- Audio errors: `0`.
- Debug entries: about `289`, under the 400-entry limit.
- Drift measurement: average about `7.5 ms`, max about `19.6 ms`, range about `19.4 ms`.

Important caveat: the baseline was verified with temporary Playwright scripts, not the later `frontend/scripts/mkv-drift-regression.mjs` script.

## Baseline Architecture

### Video Path

- Main-thread `VideoDecoder` only.
- No Worker renderer.
- No `OffscreenCanvas` transfer.
- Decoded frames are pushed into `framesRef.current` from the decoder output callback.
- Frame queue is sorted by timestamp in the render loop before choosing a frame.
- The render loop drops stale decoded frames by closing frames before the latest eligible frame.
- Rendering uses `CanvasRenderingContext2D.drawImage(frame, 0, 0, canvas.width, canvas.height)`.

### Audio Path

- `AudioDecoder` decodes AAC into `AudioData`.
- First decoded audio timestamp initializes `audioStartOffsetUsRef.current`.
- Audio scheduling uses a 3-second lookahead.
- `AudioBufferSourceNode` is used for output.
- No `AudioWorklet`.
- No `SharedArrayBuffer`.
- No COOP/COEP requirement.

### Clock Path

- Audio is the master clock when `AudioContext.currentTime` advances.
- Fallback clock is `performance.now()` when the audio clock stalls.
- The baseline did not subtract `outputLatency + baseLatency`.
- The baseline did not interpolate between audio quantum updates.
- The baseline did not use `latencyHint: "playback"`.

## Critical Baseline Code Shape

### Constants

In `frontend/src/components/mkv-webcodecs-preview.tsx`:

```ts
const INITIAL_READ_BYTES = 4 * 1024 * 1024;
const INCREMENTAL_READ_BYTES = 8 * 1024 * 1024;
const BLOCK_BUFFER_HIGH_WATER = 360;
const BLOCK_BUFFER_LOW_WATER = 180;
const FRAME_BUFFER_HIGH_WATER = 180;
```

The baseline did not use a hard 3-frame decoded-frame cap.

### Refs

Baseline refs included:

```ts
const decoderRef = useRef<VideoDecoderLike | null>(null);
const audioDecoderRef = useRef<AudioDecoderLike | null>(null);
const audioCtxRef = useRef<AudioContext | null>(null);
const framesRef = useRef<VideoFrameLike[]>([]);
const audioQueueRef = useRef<AudioDataLike[]>([]);
const animationRef = useRef<number | null>(null);
const abortRef = useRef<AbortController | null>(null);
const decodeDoneRef = useRef(false);
const renderedRef = useRef(0);
const audioScheduledEndRef = useRef(0);
const audioStartOffsetUsRef = useRef(0);
```

Baseline did not require:

- `workerRef`
- `ENABLE_MKV_WORKER_RENDERER`
- `consumedVideoFramesRef`
- `audioMediaStartTimeRef`

### Cleanup

Baseline cleanup closes:

- Abort controller.
- Animation frame.
- `VideoDecoder`.
- `AudioDecoder`.
- `AudioContext`.
- Any queued `VideoFrame`.
- Any queued `AudioData`.

It resets:

```ts
framesRef.current = [];
audioQueueRef.current = [];
decodeDoneRef.current = false;
renderedRef.current = 0;
audioScheduledEndRef.current = 0;
audioStartOffsetUsRef.current = 0;
setQueuedBlocks(0);
```

### Baseline Audio Clock

The known baseline clock logic:

```ts
let renderStartPerf = performance.now();
let firstTimestampUs: number | null = null;
let lastAudioTime = 0;
let audioClockStalled = false;
let audioCheckCount = 0;

const getElapsedUs = (): number => {
  const audioCtx = audioCtxRef.current;
  if (audioCtx && audioCtx.state === "running" && audioStartOffsetUsRef.current > 0 && !audioClockStalled) {
    const ct = audioCtx.currentTime;
    if (ct > 0 && ct > lastAudioTime) {
      lastAudioTime = ct;
      audioCheckCount = 0;
      return ct * 1_000_000;
    }
    audioCheckCount++;
    if (audioCheckCount > 60) audioClockStalled = true;
  }
  return (performance.now() - renderStartPerf) * 1000;
};
```

Do not include in the baseline:

```ts
outputLatency + audioCtx.baseLatency
lastAudioTimePerf
interpSec
```

### Baseline Render Loop

The known baseline render-loop shape:

```ts
const tick = () => {
  const queue = framesRef.current;
  if (queue.length > 0) {
    queue.sort((a, b) => a.timestamp - b.timestamp);
    if (firstTimestampUs === null) {
      firstTimestampUs = queue[0].timestamp;
      renderStartPerf = performance.now();
    }
    const elapsedUs = getElapsedUs();
    const baseUs = audioStartOffsetUsRef.current > 0 ? audioStartOffsetUsRef.current : firstTimestampUs;
    while (queue.length > 1 && queue[1].timestamp - baseUs <= elapsedUs) {
      const skipped = queue.shift();
      try { skipped?.close(); } catch {}
    }
    const frame = queue[0];
    if (frame && frame.timestamp - baseUs <= elapsedUs) {
      const driftMs = (elapsedUs - (frame.timestamp - baseUs)) / 1000;
      (window as unknown as Record<string, unknown>).__sdpDrift = {
        driftMs: Math.round(driftMs * 10) / 10,
        audioClockActive: !audioClockStalled && lastAudioTime > 0,
        audioCtxTime: audioCtxRef.current?.currentTime ?? 0,
        frameTimestampUs: frame.timestamp,
        elapsedUs: Math.round(elapsedUs),
        rendered: renderedRef.current,
      };
      const width = frame.displayWidth || frame.codedWidth || canvas.width;
      const height = frame.displayHeight || frame.codedHeight || canvas.height;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      ctx.drawImage(frame as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
      queue.shift();
      try { frame.close(); } catch {}
      renderedRef.current += 1;
      if (renderedRef.current % 30 === 0) {
        setStatus(`MKV WebCodecs 播放中：已渲染 ${renderedRef.current} 帧`);
      }
      if (renderedRef.current % 300 === 0) {
        debugLog?.("sdp-mkv", "render:progress", { renderedFrames: renderedRef.current });
      }
    }
  }

  // audio scheduling follows here
  animationRef.current = requestAnimationFrame(tick);
};
```

### Baseline Audio Scheduling In Render Loop

```ts
const audioCtx = audioCtxRef.current;
if (audioCtx && audioQueueRef.current.length > 0) {
  const scheduleAheadSec = 3;
  const currentTime = audioCtx.currentTime;
  while (audioQueueRef.current.length > 0) {
    const ad = audioQueueRef.current[0];
    const adTimeSec = (ad.timestamp - audioStartOffsetUsRef.current) / 1_000_000;
    if (adTimeSec > currentTime + scheduleAheadSec) break;
    audioQueueRef.current.shift();
    scheduleAudioData(audioCtx, ad, audioStartOffsetUsRef.current, audioScheduledEndRef);
  }
}
```

### Baseline Video Decoder Setup

```ts
decoder = new VideoDecoderCtor({
  output(frame) {
    framesRef.current.push(frame);
  },
  error(decoderError) {
    const message = decoderError.message || String(decoderError);
    setState("error");
    setError(message);
    debugLog?.("sdp-mkv", "decoder:error", { error: message });
  },
});
decoderRef.current = decoder;
decoder.configure(support?.config || nextPlan.config);
```

Do not include in baseline decoder output:

- 3-frame cap.
- 60-frame cap.
- sorted insertion helper.
- `consumedVideoFramesRef` accounting.

### Baseline Audio Context Setup

```ts
audioCtx = new AudioContext({ sampleRate: nextPlan.audioConfig.sampleRate });
audioCtxRef.current = audioCtx;
if (audioCtx.state === "suspended") await audioCtx.resume();
```

Do not include in baseline:

```ts
latencyHint: "playback"
```

### Baseline Audio Decoder Output

```ts
output(audioData) {
  if (!audioCtx) { audioData.close(); return; }
  if (audioStartOffsetUsRef.current === 0) {
    audioStartOffsetUsRef.current = audioData.timestamp;
  }
  audioQueueRef.current.push(audioData);
}
```

### Baseline `scheduleAudioData`

```ts
function scheduleAudioData(
  audioCtx: AudioContext,
  audioData: AudioDataLike,
  audioStartOffsetUs: number,
  scheduledEndRef: { current: number },
): void {
  const sampleRate = audioData.sampleRate;
  const numberOfChannels = audioData.numberOfChannels;
  const numberOfFrames = audioData.numberOfFrames;
  const timestamp = audioData.timestamp;
  if (numberOfFrames === 0) { audioData.close(); return; }

  const buffer = audioCtx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
  const tempBuf = new Float32Array(numberOfFrames);
  for (let ch = 0; ch < numberOfChannels; ch++) {
    audioData.copyTo(tempBuf.buffer, { planeIndex: ch, format: "f32-planar" });
    buffer.copyToChannel(tempBuf, ch);
  }
  audioData.close();

  const startTimeUs = timestamp - audioStartOffsetUs;
  const startTimeSec = Math.max(startTimeUs / 1_000_000, scheduledEndRef.current);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  source.start(startTimeSec);
  scheduledEndRef.current = startTimeSec + numberOfFrames / sampleRate;
}
```

Do not include in baseline:

- `mediaStartTimeRef`.
- `audioCtx.currentTime + 0.05` anchor.
- Nominal-start correction.

### Baseline Queue/Backpressure

`queueVideoBlocks` should use rendered frame count and frame queue length:

```ts
() => Math.max(totalQueuedBlocks - renderedRef.current, framesRef.current.length)
```

`waitForPlaybackDrain` should use the same logic:

```ts
await waitForPlaybackDrain(abort.signal, () => Math.max(totalQueuedBlocks - renderedRef.current, framesRef.current.length));
```

Do not include in baseline:

```ts
consumedVideoFramesRef.current
```

## Parser/Demux Baseline

`frontend/src/lib/mkv-webcodecs.ts` baseline should retain:

- Incremental parsing by read window.
- `getMkvClusterCarry` to keep only cluster carry bytes.
- `parseMkvVideoBlocksFromBuffer`.
- `parseMkvAudioBlocksFromBuffer`.
- No artificial 128 MB or 3000-block playback limit.
- No bug that discards delta frames after the first keyframe in later windows.
- Audio lacing support:
  - Xiph lacing.
  - Fixed-size lacing.
  - EBML lacing.
- AAC support through `mp4a.40.2`.

## Debug Baseline

Baseline debug events:

- `range:start`
- `range:done`
- `plan:ready`
- `cluster:parsed`
- `decoder:backlog`
- `decoder:queued`
- `render:progress` every 300 rendered frames
- `stream:eof`
- `decoder:flush`
- `render:done`
- `audio:configured`
- `audio:error`

The share page debug panel should still show:

- Total bytes read and percentage.
- Rendered frames.
- Queued blocks.
- Pending blocks.
- Carry bytes.
- Decode queue size.

## Features Not In Baseline

These were attempted after the baseline and should not be part of a baseline restore unless explicitly revalidated:

- `outputLatency + baseLatency` subtraction.
- Audio time interpolation with `performance.now()`.
- `latencyHint: "playback"`.
- 3-frame hard cap.
- 60-frame decoded-frame cap.
- `consumedVideoFramesRef` accounting.
- Worker + OffscreenCanvas renderer as default.
- `frontend/public/mkv-decode-worker.js` as active runtime path.
- `AudioWorklet`.
- `SharedArrayBuffer`.
- `crossOriginIsolated` / COOP / COEP changes.

## Manual Restore Checklist

If restoring the baseline manually:

1. In `frontend/src/components/mkv-webcodecs-preview.tsx`, remove Worker renderer activation and ensure all video decode/render is main-thread.
2. Restore `audioStartOffsetUsRef` sentinel to `0` and remove `audioMediaStartTimeRef`.
3. Restore raw audio clock use: `return audioCtx.currentTime * 1_000_000` when advancing.
4. Remove output-latency subtraction and interpolation variables.
5. Restore per-tick timestamp sort before render selection.
6. Restore stale-frame skip using `queue[1].timestamp - baseUs <= elapsedUs`.
7. Restore decoder output to `framesRef.current.push(frame)`.
8. Remove decoded-frame caps and consumed-frame accounting.
9. Restore `AudioContext({ sampleRate })` with no `latencyHint`.
10. Restore `scheduleAudioData` to schedule by media offset directly.
11. Run `cd /data/nyy/frontend && npx tsc --noEmit`.
12. Verify with Playwright/Xvfb on `https://dev.nyy.app/bpJpXZ?sdp=1&debug=1`.

## Better Backup Recommendation

Markdown is useful for human recovery, but a safer non-commit backup is to also save a patch snapshot:

```bash
git diff -- frontend/src/components/mkv-webcodecs-preview.tsx frontend/src/lib/mkv-webcodecs.ts frontend/src/components/self-develop-player.tsx frontend/src/app/[code]/page.tsx frontend/src/lib/range-file-reader.ts > /tmp/mkv-current-work.patch
```

This does not commit anything. It only preserves the current working tree diff in a file that can be inspected or applied later.

If the baseline is restored successfully, the safest long-term step is to make a real git commit at that point.
