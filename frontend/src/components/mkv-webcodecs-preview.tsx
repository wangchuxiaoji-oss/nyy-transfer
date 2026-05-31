"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import {
  getMkvClusterCarry,
  parseMkvAudioBlocksFromBuffer,
  parseMkvVideoBlocksFromBuffer,
  parseMkvWebCodecsPlanFromBuffer,
  type AudioDecoderConfigLike,
  type MkvAudioBlock,
  type MkvVideoBlock,
  type MkvWebCodecsPlan,
  type VideoDecoderConfigLike,
} from "@/lib/mkv-webcodecs";
import { RangeFileReader } from "@/lib/range-file-reader";

const INITIAL_READ_BYTES = 4 * 1024 * 1024;
const INCREMENTAL_READ_BYTES = 8 * 1024 * 1024;
const BLOCK_BUFFER_HIGH_WATER = 360;
const BLOCK_BUFFER_LOW_WATER = 180;
const FRAME_BUFFER_HIGH_WATER = 180;
const ENCODED_PREFETCH_TARGET_SECONDS = 45;
const ENCODED_PREFETCH_MAX_BYTES = 48 * 1024 * 1024;
const DEFAULT_VIDEO_FRAME_DURATION_US = 33_333;
const THROUGHPUT_EWMA_ALPHA = 0.25;

type PreviewState = "idle" | "loading" | "decoding" | "playing" | "done" | "error";

interface VideoFrameLike {
  timestamp: number;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  close(): void;
}

type EncodedVideoChunkLike = object;

interface VideoDecoderLike {
  readonly decodeQueueSize: number;
  readonly state: string;
  configure(config: VideoDecoderConfigLike): void;
  decode(chunk: EncodedVideoChunkLike): void;
  flush(): Promise<void>;
  close(): void;
}

interface VideoDecoderConstructorLike {
  new(init: { output(frame: VideoFrameLike): void; error(error: Error): void }): VideoDecoderLike;
  isConfigSupported?(config: VideoDecoderConfigLike): Promise<{ supported: boolean; config?: VideoDecoderConfigLike }>;
}

interface EncodedVideoChunkConstructorLike {
  new(init: { type: "key" | "delta"; timestamp: number; duration?: number; data: BufferSource }): EncodedVideoChunkLike;
}

interface AudioDataLike {
  timestamp: number;
  numberOfFrames: number;
  numberOfChannels: number;
  sampleRate: number;
  format: string;
  duration: number;
  copyTo(dest: BufferSource, options: { planeIndex: number; format?: string }): void;
  close(): void;
}

type EncodedAudioChunkLike = object;

interface AudioDecoderLike {
  readonly decodeQueueSize: number;
  readonly state: string;
  configure(config: AudioDecoderConfigLike): void;
  decode(chunk: EncodedAudioChunkLike): void;
  flush(): Promise<void>;
  close(): void;
}

interface AudioDecoderConstructorLike {
  new(init: { output(data: AudioDataLike): void; error(error: Error): void }): AudioDecoderLike;
  isConfigSupported?(config: AudioDecoderConfigLike): Promise<{ supported: boolean; config?: AudioDecoderConfigLike }>;
}

interface EncodedAudioChunkConstructorLike {
  new(init: { type: "key" | "delta"; timestamp: number; duration?: number; data: BufferSource }): EncodedAudioChunkLike;
}

interface RangeReadResult {
  start: number;
  end: number;
  partBuffer: ArrayBuffer;
  elapsedMs: number;
}

interface MkvWebCodecsPreviewProps {
  file: ShareFileDownload;
  debugLog?: DebugLogFn;
}

export function MkvWebCodecsPreview({ file, debugLog }: MkvWebCodecsPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const decoderRef = useRef<VideoDecoderLike | null>(null);
  const audioDecoderRef = useRef<AudioDecoderLike | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const framesRef = useRef<VideoFrameLike[]>([]);
  const audioQueueRef = useRef<AudioDataLike[]>([]);
  const animationRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const decodeDoneRef = useRef(false);
  const renderedRef = useRef(0);
  const consumedVideoFramesRef = useRef(0);
  const audioScheduledEndRef = useRef(0);
  const audioStartOffsetUsRef = useRef(0);
  const [state, setState] = useState<PreviewState>("idle");
  const [status, setStatus] = useState("等待启动 MKV WebCodecs 预览");
  const [error, setError] = useState("");
  const [plan, setPlan] = useState<MkvWebCodecsPlan | null>(null);
  const [queuedBlocks, setQueuedBlocks] = useState(0);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    if (workerRef.current) {
      try { workerRef.current.postMessage({ type: "stop" }); } catch {}
      workerRef.current.terminate();
      workerRef.current = null;
    }
    try { decoderRef.current?.close(); } catch {}
    decoderRef.current = null;
    try { audioDecoderRef.current?.close(); } catch {}
    audioDecoderRef.current = null;
    try { audioCtxRef.current?.close(); } catch {}
    audioCtxRef.current = null;
    for (const frame of framesRef.current) {
      try { frame.close(); } catch {}
    }
    for (const ad of audioQueueRef.current) {
      try { ad.close(); } catch {}
    }
    framesRef.current = [];
    audioQueueRef.current = [];
    decodeDoneRef.current = false;
    renderedRef.current = 0;
    consumedVideoFramesRef.current = 0;
    audioScheduledEndRef.current = 0;
    audioStartOffsetUsRef.current = 0;
    setQueuedBlocks(0);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const handleStop = useCallback(() => {
    const renderedFrames = renderedRef.current;
    cleanup();
    setState("idle");
    setStatus("已停止 MKV WebCodecs 预览");
    debugLog?.("sdp-mkv", "user:stop", { renderedFrames });
  }, [cleanup, debugLog]);

  const startRenderLoop = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) throw new Error("Canvas 2D 不可用");

    let renderStartPerf = performance.now();
    let firstTimestampUs: number | null = null;

    let lastAudioTime = 0;
    let audioClockStalled = false;
    let audioCheckCount = 0;
    // Visibility-aware clock
    let lastTickPerf = performance.now();
    let pausedDurationMs = 0;
    const HIDDEN_THRESHOLD_MS = 500;
    const MAX_SKIP_PER_TICK = 2;

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
      return (performance.now() - renderStartPerf - pausedDurationMs) * 1000;
    };

    const tick = () => {
      const now = performance.now();
      const tickGapMs = now - lastTickPerf;
      if (tickGapMs > HIDDEN_THRESHOLD_MS) {
        pausedDurationMs += tickGapMs - 16;
      }
      lastTickPerf = now;

      const queue = framesRef.current;
      if (queue.length > 0) {
        queue.sort((a, b) => a.timestamp - b.timestamp);
        if (firstTimestampUs === null) {
          firstTimestampUs = queue[0].timestamp;
          renderStartPerf = performance.now();
          pausedDurationMs = 0;
          lastTickPerf = renderStartPerf;
        }
        const elapsedUs = getElapsedUs();
        const baseUs = audioStartOffsetUsRef.current > 0 ? audioStartOffsetUsRef.current : firstTimestampUs;

        // Cap frame skipping to avoid bulk-close causing visual jumps
        let skipped = 0;
        while (queue.length > 1 && queue[1].timestamp - baseUs <= elapsedUs && skipped < MAX_SKIP_PER_TICK) {
          const s = queue.shift();
          try { s?.close(); } catch {}
          skipped++;
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

      if (decodeDoneRef.current && queue.length === 0) {
        setState("done");
        setStatus(`MKV WebCodecs 播放完成：已渲染 ${renderedRef.current} 帧`);
        debugLog?.("sdp-mkv", "render:done", { renderedFrames: renderedRef.current });
        return;
      }

      animationRef.current = requestAnimationFrame(tick);
    };

    setState("playing");
    animationRef.current = requestAnimationFrame(tick);
  }, [debugLog]);

  const startWorkerAudioLoop = useCallback(() => {
    let renderStartPerf = performance.now();
    let firstTimestampUs: number | null = null;
    let lastAudioTime = 0;
    let audioClockStalled = false;
    let audioCheckCount = 0;
    // Visibility-aware clock: track accumulated pause time so performance.now()
    // gaps from page-hidden don't cause a time jump.
    let lastTickPerf = performance.now();
    let pausedDurationMs = 0;
    const HIDDEN_THRESHOLD_MS = 500; // gap > 500ms means page was hidden

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
      return (performance.now() - renderStartPerf - pausedDurationMs) * 1000;
    };

    const tick = () => {
      const now = performance.now();
      const tickGapMs = now - lastTickPerf;
      // If rAF gap is large, the page was hidden — accumulate the gap as paused time
      if (tickGapMs > HIDDEN_THRESHOLD_MS) {
        pausedDurationMs += tickGapMs - 16; // subtract one normal frame interval
      }
      lastTickPerf = now;

      if (firstTimestampUs === null && audioStartOffsetUsRef.current > 0) {
        firstTimestampUs = audioStartOffsetUsRef.current;
        renderStartPerf = performance.now();
        pausedDurationMs = 0;
        lastTickPerf = renderStartPerf;
      }
      const elapsedUs = getElapsedUs();
      const baseUs = audioStartOffsetUsRef.current > 0 ? audioStartOffsetUsRef.current : (firstTimestampUs ?? 0);
      workerRef.current?.postMessage({ type: "time", mediaTimeUs: baseUs + elapsedUs });

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

      if (decodeDoneRef.current) return;
      animationRef.current = requestAnimationFrame(tick);
    };

    setState("playing");
    animationRef.current = requestAnimationFrame(tick);
  }, []);

  const startPreview = useCallback(async () => {
    cleanup();
    setError("");
    setPlan(null);
    setQueuedBlocks(0);
    setState("loading");
    setStatus("增量读取 MKV 头部和首段 Cluster...");
    const abort = new AbortController();
    abortRef.current = abort;

    const VideoDecoderCtor = (window as unknown as { VideoDecoder?: VideoDecoderConstructorLike }).VideoDecoder;
    const EncodedVideoChunkCtor = (window as unknown as { EncodedVideoChunk?: EncodedVideoChunkConstructorLike }).EncodedVideoChunk;
    const AudioDecoderCtor = (window as unknown as { AudioDecoder?: AudioDecoderConstructorLike }).AudioDecoder;
    const EncodedAudioChunkCtor = (window as unknown as { EncodedAudioChunk?: EncodedAudioChunkConstructorLike }).EncodedAudioChunk;
    if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
      setState("error");
      setError("当前浏览器不支持 WebCodecs VideoDecoder，MKV 自研预览需要 WebCodecs");
      return;
    }

    try {
      const reader = new RangeFileReader(file);
      const sessionMaxBytes = reader.totalSize;
      const initParts: Uint8Array[] = [];
      const seenBlocks = new Set<string>();
      const seenAudioKeys = new Set<string>();
      let accumulatedBytes = 0;
      let decoder: VideoDecoderLike | null = null;
      let audioDecoder: AudioDecoderLike | null = null;
      let audioCtx: AudioContext | null = null;
      let renderStarted = false;
      let foundFirstKeyframe = false;
      let latestPlan: MkvWebCodecsPlan | null = null;
      let totalQueuedBlocks = 0;
      let pendingBlocks: MkvVideoBlock[] = [];
      let pendingAudioBlocks: MkvAudioBlock[] = [];
      let initBytes = 0;
      let clusterCarry = new Uint8Array(0);
      let workerMode = false;
      let estimatedVideoFrameDurationUs = DEFAULT_VIDEO_FRAME_DURATION_US;
      let mediaBitrateBps: number | null = null;
      let rangeThroughputBpsEwma: number | null = null;
      let prefetchedRange: RangeReadResult | null = null;
      let prefetchInFlight: Promise<void> | null = null;
      let prefetchError: unknown = null;

      const getBufferedBlockCount = () => workerMode
        ? Math.max(totalQueuedBlocks - consumedVideoFramesRef.current, 0)
        : Math.max(totalQueuedBlocks - renderedRef.current, framesRef.current.length);
      const getPendingVideoSeconds = () => sumVideoBlockDurationsUs(pendingBlocks, estimatedVideoFrameDurationUs) / 1_000_000;
      const getBufferedVideoSeconds = () => getPendingVideoSeconds() + (getBufferedBlockCount() * estimatedVideoFrameDurationUs) / 1_000_000;
      const getPendingVideoBytes = () => sumBlockBytes(pendingBlocks);
      const shouldPrefetchMore = () => accumulatedBytes < sessionMaxBytes
        && getBufferedVideoSeconds() < ENCODED_PREFETCH_TARGET_SECONDS
        && getPendingVideoBytes() < ENCODED_PREFETCH_MAX_BYTES;

      const startRangePrefetch = (reason: string) => {
        if (prefetchError || prefetchInFlight || prefetchedRange || accumulatedBytes >= sessionMaxBytes || abort.signal.aborted) return;
        const start = accumulatedBytes;
        const nextEnd = Math.min(sessionMaxBytes, start + INCREMENTAL_READ_BYTES);
        const rangeStartedAt = performance.now();
        debugLog?.("sdp-mkv", "range:start", {
          start,
          end: nextEnd,
          fileSize: sessionMaxBytes,
          carryBytes: clusterCarry.byteLength,
          reason,
          background: true,
          bufferedSeconds: roundMetric(getBufferedVideoSeconds()),
          pendingSeconds: roundMetric(getPendingVideoSeconds()),
        });
        prefetchError = null;
        prefetchInFlight = reader.read(start, nextEnd, abort.signal)
          .then((partBuffer) => {
            prefetchedRange = {
              start,
              end: nextEnd,
              partBuffer,
              elapsedMs: Math.round(performance.now() - rangeStartedAt),
            };
          })
          .catch((readError) => {
            prefetchError = readError;
          })
          .finally(() => {
            prefetchInFlight = null;
          });
      };

      const readNextRange = async (): Promise<RangeReadResult> => {
        if (prefetchError) throw prefetchError;
        if (prefetchedRange) {
          const result = prefetchedRange;
          prefetchedRange = null;
          return result;
        }
        if (prefetchInFlight) {
          await prefetchInFlight;
          if (prefetchError) throw prefetchError;
          if (prefetchedRange) {
            const result = prefetchedRange;
            prefetchedRange = null;
            return result;
          }
        }

        const readSize = accumulatedBytes === 0 ? INITIAL_READ_BYTES : INCREMENTAL_READ_BYTES;
        const start = accumulatedBytes;
        const nextEnd = Math.min(sessionMaxBytes, start + readSize);
        const rangeStartedAt = performance.now();
        setStatus(`MKV 增量读取：${formatSize(start)} → ${formatSize(nextEnd)}`);
        debugLog?.("sdp-mkv", "range:start", {
          start,
          end: nextEnd,
          fileSize: sessionMaxBytes,
          carryBytes: clusterCarry.byteLength,
          reason: "foreground",
          background: false,
          bufferedSeconds: roundMetric(getBufferedVideoSeconds()),
          pendingSeconds: roundMetric(getPendingVideoSeconds()),
        });
        const partBuffer = await reader.read(start, nextEnd, abort.signal);
        return {
          start,
          end: nextEnd,
          partBuffer,
          elapsedMs: Math.round(performance.now() - rangeStartedAt),
        };
      };

      while ((accumulatedBytes < sessionMaxBytes || pendingBlocks.length > 0) && !abort.signal.aborted) {
        if (pendingBlocks.length === 0 && accumulatedBytes < sessionMaxBytes) {
          const rangeResult = await readNextRange();
          if (abort.signal.aborted) return;
          if (rangeResult.start !== accumulatedBytes) {
            throw new Error("MKV 预读范围错位");
          }
          const partBytes = new Uint8Array(rangeResult.partBuffer);
          accumulatedBytes += rangeResult.partBuffer.byteLength;
          const sampleThroughputBps = rangeResult.elapsedMs > 0 ? (rangeResult.partBuffer.byteLength * 8 * 1000) / rangeResult.elapsedMs : 0;
          rangeThroughputBpsEwma = rangeThroughputBpsEwma === null
            ? sampleThroughputBps
            : rangeThroughputBpsEwma * (1 - THROUGHPUT_EWMA_ALPHA) + sampleThroughputBps * THROUGHPUT_EWMA_ALPHA;
          debugLog?.("sdp-mkv", "range:done", {
            bytesRead: rangeResult.partBuffer.byteLength,
            totalBytesRead: accumulatedBytes,
            elapsedMs: rangeResult.elapsedMs,
            throughputKbps: Math.round(sampleThroughputBps / 1000),
            throughputEwmaKbps: Math.round(rangeThroughputBpsEwma / 1000),
            mediaBitrateKbps: mediaBitrateBps ? Math.round(mediaBitrateBps / 1000) : null,
            throughputRatio: mediaBitrateBps ? roundMetric(rangeThroughputBpsEwma / mediaBitrateBps) : null,
            bufferedSeconds: roundMetric(getBufferedVideoSeconds()),
            pendingSeconds: roundMetric(getPendingVideoSeconds()),
          });

          let newBlocks: MkvVideoBlock[];
          if (!latestPlan) {
            initParts.push(partBytes);
            initBytes += partBytes.byteLength;
            const initBuffer = joinBytes(initParts, initBytes);
            let nextPlan: MkvWebCodecsPlan;
            try {
              nextPlan = parseMkvWebCodecsPlanFromBuffer(initBuffer);
            } catch (planError) {
              const message = planError instanceof Error ? planError.message : String(planError);
              debugLog?.("sdp-mkv", "plan:need-more", { totalBytesRead: accumulatedBytes, initBytes, error: message });
              if (accumulatedBytes < sessionMaxBytes && /继续增量读取|没有找到可解析 Cluster|没有找到可解码视频块/.test(message)) continue;
              throw planError;
            }

            latestPlan = nextPlan;
            clusterCarry = getMkvClusterCarry(initBuffer);
            mediaBitrateBps = nextPlan.durationSeconds && nextPlan.durationSeconds > 0 ? (sessionMaxBytes * 8) / nextPlan.durationSeconds : null;
            estimatedVideoFrameDurationUs = estimateVideoFrameDurationUs(nextPlan.blocks, nextPlan.videoTrack.defaultDurationUs, estimatedVideoFrameDurationUs);
            setPlan(nextPlan);
            debugLog?.("sdp-mkv", "plan:ready", {
              codec: nextPlan.config.codec,
              blocks: nextPlan.blocks.length,
              keyframes: countVideoKeyframes(nextPlan.blocks),
              width: nextPlan.videoTrack.width || null,
              height: nextPlan.videoTrack.height || null,
              durationSeconds: nextPlan.durationSeconds || null,
              estimatedFrameDurationUs: Math.round(estimatedVideoFrameDurationUs),
              mediaBitrateKbps: mediaBitrateBps ? Math.round(mediaBitrateBps / 1000) : null,
              totalBytesRead: accumulatedBytes,
              carryBytes: clusterCarry.byteLength,
            });

            const support = await VideoDecoderCtor.isConfigSupported?.(nextPlan.config);
            if (support && !support.supported) throw new Error(`WebCodecs 不支持 ${nextPlan.config.codec}`);

            const decoderConfig = support?.config || nextPlan.config;
            const canvasEl = canvasRef.current;
            const canUseWorker = canvasEl
              && typeof Worker !== "undefined"
              && typeof (canvasEl as unknown as { transferControlToOffscreen?: unknown }).transferControlToOffscreen === "function";
            if (canUseWorker) {
              const worker = new Worker("/mkv-decode-worker.js");
              const supportedInWorker = await requestMkvWorkerSupport(worker);
              if (supportedInWorker && !abort.signal.aborted) {
                const offscreen = (canvasEl as unknown as { transferControlToOffscreen(): OffscreenCanvas }).transferControlToOffscreen();
                workerRef.current = worker;
                workerMode = true;
                worker.onmessage = (ev) => {
                  const msg = ev.data as Record<string, unknown>;
                  if (msg.type === "rendered") {
                    const renderedFrames = typeof msg.renderedFrames === "number" ? msg.renderedFrames : renderedRef.current;
                    const consumedFrames = typeof msg.consumedFrames === "number" ? msg.consumedFrames : consumedVideoFramesRef.current;
                    renderedRef.current = renderedFrames;
                    consumedVideoFramesRef.current = consumedFrames;
                    if (typeof msg.driftMs === "number") {
                      (window as unknown as Record<string, unknown>).__sdpDrift = {
                        driftMs: Math.round(msg.driftMs * 10) / 10,
                        audioClockActive: audioCtxRef.current?.state === "running",
                        audioCtxTime: audioCtxRef.current?.currentTime ?? 0,
                        frameTimestampUs: msg.frameTimestampUs,
                        elapsedUs: Math.round((typeof msg.mediaTimeUs === "number" ? msg.mediaTimeUs : 0) - (audioStartOffsetUsRef.current || 0)),
                        rendered: renderedFrames,
                        bufferedSeconds: roundMetric(getBufferedVideoSeconds()),
                        worker: true,
                      };
                    }
                    if (renderedFrames % 30 === 0) setStatus(`MKV WebCodecs 播放中：已渲染 ${renderedFrames} 帧，缓冲 ${formatSeconds(getBufferedVideoSeconds())}`);
                    if (renderedFrames % 300 === 0) debugLog?.("sdp-mkv", "render:progress", {
                      renderedFrames,
                      consumedFrames,
                      queuedFrames: typeof msg.queuedFrames === "number" ? msg.queuedFrames : null,
                      decodeQueueSize: typeof msg.decodeQueueSize === "number" ? msg.decodeQueueSize : null,
                      bufferedSeconds: roundMetric(getBufferedVideoSeconds()),
                    });
                  } else if (msg.type === "progress") {
                    if (typeof msg.consumedFrames === "number") consumedVideoFramesRef.current = msg.consumedFrames;
                  } else if (msg.type === "ready") {
                    debugLog?.("sdp-mkv", "worker:ready", { hasRAF: Boolean(msg.hasRAF) });
                  } else if (msg.type === "done") {
                    const renderedFrames = typeof msg.renderedFrames === "number" ? msg.renderedFrames : renderedRef.current;
                    renderedRef.current = renderedFrames;
                    if (typeof msg.consumedFrames === "number") consumedVideoFramesRef.current = msg.consumedFrames;
                    decodeDoneRef.current = true;
                    setState("done");
                    setStatus(`MKV WebCodecs 播放完成：已渲染 ${renderedFrames} 帧`);
                    debugLog?.("sdp-mkv", "render:done", { renderedFrames });
                  } else if (msg.type === "error") {
                    const message = typeof msg.error === "string" ? msg.error : "Worker 渲染失败";
                    setState("error");
                    setError(message);
                    debugLog?.("sdp-mkv", "worker:error", { error: message });
                  }
                };
                worker.postMessage({ type: "init", canvas: offscreen, config: decoderConfig }, [offscreen]);
                debugLog?.("sdp-mkv", "worker:init", { codec: decoderConfig.codec });
              } else {
                worker.terminate();
              }
            }

            if (!workerMode) {
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
              decoder.configure(decoderConfig);
            }

            if (nextPlan.audioConfig && AudioDecoderCtor && EncodedAudioChunkCtor) {
              audioCtx = new AudioContext({ sampleRate: nextPlan.audioConfig.sampleRate });
              audioCtxRef.current = audioCtx;
              if (audioCtx.state === "suspended") await audioCtx.resume();
              audioDecoder = new AudioDecoderCtor({
                output(audioData) {
                  if (!audioCtx) { audioData.close(); return; }
                  if (audioStartOffsetUsRef.current === 0) {
                    audioStartOffsetUsRef.current = audioData.timestamp;
                  }
                  audioQueueRef.current.push(audioData);
                },
                error(audioError) {
                  debugLog?.("sdp-mkv", "audio:error", { error: audioError.message || String(audioError) });
                },
              });
              audioDecoderRef.current = audioDecoder;
              const audioSupport = await AudioDecoderCtor.isConfigSupported?.(nextPlan.audioConfig);
              if (audioSupport && !audioSupport.supported) {
                debugLog?.("sdp-mkv", "audio:unsupported", { codec: nextPlan.audioConfig.codec });
                audioDecoder = null;
                audioDecoderRef.current = null;
              } else {
                audioDecoder.configure(audioSupport?.config || nextPlan.audioConfig);
                debugLog?.("sdp-mkv", "audio:configured", { codec: nextPlan.audioConfig.codec, sampleRate: nextPlan.audioConfig.sampleRate, channels: nextPlan.audioConfig.numberOfChannels });
              }
            }

            newBlocks = nextPlan.blocks.filter((block) => !seenBlocks.has(getBlockKey(block)));
            pendingAudioBlocks = nextPlan.audioBlocks;
          } else {
            const parseBuffer = joinBytes([clusterCarry, partBytes], clusterCarry.byteLength + partBytes.byteLength);
            clusterCarry = getMkvClusterCarry(parseBuffer);
            const parsed = parseMkvVideoBlocksFromBuffer(parseBuffer, latestPlan.videoTrack, latestPlan.timecodeScaleNs);
            newBlocks = parsed.blocks.filter((block) => !seenBlocks.has(getBlockKey(block)));
            estimatedVideoFrameDurationUs = estimateVideoFrameDurationUs(newBlocks, latestPlan.videoTrack.defaultDurationUs, estimatedVideoFrameDurationUs);
            if (latestPlan.audioTrack) {
              pendingAudioBlocks = parseMkvAudioBlocksFromBuffer(parseBuffer, latestPlan.audioTrack, latestPlan.timecodeScaleNs);
            }
            setPlan({ ...latestPlan, bytesRead: accumulatedBytes, blocks: parsed.blocks });
            debugLog?.("sdp-mkv", "cluster:parsed", {
              blocks: parsed.blocks.length,
              newBlocks: newBlocks.length,
              keyframes: countVideoKeyframes(newBlocks),
              audioBlocks: pendingAudioBlocks.length,
              totalBytesRead: accumulatedBytes,
              carryBytes: clusterCarry.byteLength,
            });
          }

          if (!foundFirstKeyframe) {
            const firstKeyIndex = newBlocks.findIndex((block) => block.keyframe);
            if (firstKeyIndex < 0) {
              debugLog?.("sdp-mkv", "decoder:wait-keyframe", { totalBytesRead: accumulatedBytes, newBlocks: newBlocks.length });
              continue;
            }
            newBlocks = newBlocks.slice(firstKeyIndex);
            foundFirstKeyframe = true;
          }
          pendingBlocks = appendUniqueSorted([], newBlocks, seenBlocks, getBlockKey, (block) => block.timestampUs);
          pendingAudioBlocks = appendUniqueSorted([], pendingAudioBlocks, seenAudioKeys, getAudioBlockKey, (block) => block.timestampUs);
          debugLog?.("sdp-mkv", "decoder:backlog", {
            pendingBlocks: pendingBlocks.length,
            pendingSeconds: roundMetric(getPendingVideoSeconds()),
            pendingBytes: getPendingVideoBytes(),
            bufferedSeconds: roundMetric(getBufferedVideoSeconds()),
            totalBytesRead: accumulatedBytes,
          });
          if (shouldPrefetchMore()) startRangePrefetch("after-parse");
        }

        if (pendingBlocks.length === 0 && accumulatedBytes >= sessionMaxBytes) break;

        if (!renderStarted) {
          setState("decoding");
          setStatus(`MKV WebCodecs 解码启动：${latestPlan?.config.codec || "unknown"}${workerMode ? " (Worker)" : ""}`);
          if (workerMode) startWorkerAudioLoop();
          else startRenderLoop();
          renderStarted = true;
        }

        if (workerMode) {
          const queueResult = await queueVideoBlocksToWorker(
            workerRef.current,
            pendingBlocks,
            seenBlocks,
            abort.signal,
            () => Math.max(totalQueuedBlocks - consumedVideoFramesRef.current, 0),
          );
          pendingBlocks = queueResult.remainingBlocks;
          totalQueuedBlocks += queueResult.queued;
          setQueuedBlocks(totalQueuedBlocks);
          if (queueResult.queued > 0) {
            const bufferedSeconds = getBufferedVideoSeconds();
            const throughputText = rangeThroughputBpsEwma ? `，吞吐 ${formatBitrate(rangeThroughputBpsEwma)}` : "";
            setStatus(`MKV WebCodecs 播放中：读取 ${formatSize(accumulatedBytes)}，已入队 ${totalQueuedBlocks} 块，缓冲 ${formatSeconds(bufferedSeconds)}${throughputText}`);
            debugLog?.("sdp-mkv", "decoder:queued", { queuedThisBatch: queueResult.queued, pendingBlocks: pendingBlocks.length, pendingSeconds: roundMetric(getPendingVideoSeconds()), bufferedSeconds: roundMetric(bufferedSeconds), totalQueuedBlocks, totalBytesRead: accumulatedBytes, decodeQueueSize: null, worker: true });
          }
        } else {
          if (!decoder) throw new Error("VideoDecoder 尚未初始化");

          const queueResult = await queueVideoBlocks(
            decoder,
            EncodedVideoChunkCtor,
            pendingBlocks,
            seenBlocks,
            abort.signal,
            () => Math.max(totalQueuedBlocks - renderedRef.current, framesRef.current.length),
          );
          pendingBlocks = queueResult.remainingBlocks;
          totalQueuedBlocks += queueResult.queued;
          setQueuedBlocks(totalQueuedBlocks);
          if (queueResult.queued > 0) {
            const bufferedSeconds = getBufferedVideoSeconds();
            const throughputText = rangeThroughputBpsEwma ? `，吞吐 ${formatBitrate(rangeThroughputBpsEwma)}` : "";
            setStatus(`MKV WebCodecs 播放中：读取 ${formatSize(accumulatedBytes)}，已入队 ${totalQueuedBlocks} 块，缓冲 ${formatSeconds(bufferedSeconds)}${throughputText}`);
            debugLog?.("sdp-mkv", "decoder:queued", { queuedThisBatch: queueResult.queued, pendingBlocks: pendingBlocks.length, pendingSeconds: roundMetric(getPendingVideoSeconds()), bufferedSeconds: roundMetric(bufferedSeconds), totalQueuedBlocks, totalBytesRead: accumulatedBytes, decodeQueueSize: decoder.decodeQueueSize });
          }
        }

        if (audioDecoder && EncodedAudioChunkCtor && pendingAudioBlocks.length > 0) {
          for (const aBlock of pendingAudioBlocks) {
            if (abort.signal.aborted) break;
            const aKey = getAudioBlockKey(aBlock);
            if (seenAudioKeys.has(aKey)) continue;
            seenAudioKeys.add(aKey);
            const aChunk = new EncodedAudioChunkCtor({
              type: "key",
              timestamp: Math.round(aBlock.timestampUs),
              data: copyBytesToArrayBuffer(aBlock.data),
            });
            audioDecoder.decode(aChunk);
          }
          pendingAudioBlocks = [];
        }

        if (shouldPrefetchMore()) startRangePrefetch("after-queue");

        await waitForPlaybackDrain(abort.signal, () => workerMode
          ? Math.max(totalQueuedBlocks - consumedVideoFramesRef.current, 0)
          : Math.max(totalQueuedBlocks - renderedRef.current, framesRef.current.length));
      }

      if (abort.signal.aborted) return;
      if (!latestPlan || (!workerMode && !decoder)) throw new Error("MKV 增量读取结束但没有可解码视频块");
      debugLog?.("sdp-mkv", "stream:eof", { bytesRead: accumulatedBytes, fileSize: sessionMaxBytes, queuedBlocks: totalQueuedBlocks, renderedFrames: renderedRef.current, bufferedSeconds: roundMetric(getBufferedVideoSeconds()) });
      if (workerMode) workerRef.current?.postMessage({ type: "flush" });
      else await decoder?.flush();
      if (audioDecoder) await audioDecoder.flush().catch(() => {});
      if (!workerMode) decodeDoneRef.current = true;
      debugLog?.("sdp-mkv", "decoder:flush", { queuedFrames: framesRef.current.length, renderedFrames: renderedRef.current, queuedBlocks: totalQueuedBlocks, bytesRead: accumulatedBytes });
    } catch (err) {
      if (abort.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setState("error");
      setError(message);
      setStatus("MKV WebCodecs 预览失败");
      debugLog?.("sdp-mkv", "error", { error: message });
    }
  }, [cleanup, debugLog, file, startRenderLoop, startWorkerAudioLoop]);

  return (
    <div className="space-y-3 rounded-xl border border-nyy-200 bg-warm-50 p-3 dark:border-nyy-800 dark:bg-white/5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="type-caption font-semibold text-gray-900 dark:text-gray-100">MKV · WebCodecs video-only 预览</p>
          <p className="type-caption text-gray-500 dark:text-gray-400">先验证 Matroska demux + 视频解码，音频下一阶段接入。</p>
        </div>
        <button
          type="button"
          onClick={state === "loading" || state === "decoding" || state === "playing" ? handleStop : startPreview}
          className="type-caption rounded-lg border border-nyy-300 px-3 py-1.5 text-nyy-800 dark:border-nyy-700 dark:text-nyy-300"
        >
          {state === "idle" || state === "done" || state === "error" ? "启动 MKV 预览" : "停止"}
        </button>
      </div>

      <canvas ref={canvasRef} className="aspect-video w-full rounded-xl bg-black" />
      <p className="type-caption text-gray-600 dark:text-gray-400">{status}</p>

      {plan && (
        <div className="grid grid-cols-1 gap-1 text-xs text-gray-700 dark:text-gray-300 sm:grid-cols-2">
          <span>codec: {plan.config.codec}</span>
          <span>blocks: {plan.blocks.length}</span>
          <span>queued: {queuedBlocks}</span>
          <span>size: {plan.videoTrack.width || "?"}x{plan.videoTrack.height || "?"}</span>
          <span>read: {formatSize(plan.bytesRead)}</span>
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function requestMkvWorkerSupport(worker: Worker): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      worker.removeEventListener("message", onMessage);
      resolve(false);
    }, 2000);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      if (data.type !== "support") return;
      window.clearTimeout(timeout);
      worker.removeEventListener("message", onMessage);
      resolve(Boolean(data.supported));
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ type: "support" });
  });
}

async function queueVideoBlocksToWorker(
  worker: Worker | null,
  blocks: MkvVideoBlock[],
  seenBlocks: Set<string>,
  signal: AbortSignal,
  getBufferedBlocks: () => number,
): Promise<{ queued: number; remainingBlocks: MkvVideoBlock[] }> {
  if (!worker) throw new Error("Worker 尚未初始化");
  let queued = 0;
  let index = 0;
  for (; index < blocks.length; index++) {
    if (signal.aborted) return { queued, remainingBlocks: blocks.slice(index) };
    if (getBufferedBlocks() + queued >= BLOCK_BUFFER_HIGH_WATER) return { queued, remainingBlocks: blocks.slice(index) };
    const block = blocks[index];
    const key = getBlockKey(block);
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);
    const data = copyBytesToArrayBuffer(block.data);
    worker.postMessage({
      type: "decode",
      keyframe: block.keyframe,
      timestamp: Math.round(block.timestampUs),
      duration: block.durationUs ? Math.round(block.durationUs) : undefined,
      data,
    }, [data]);
    queued += 1;
    if (getBufferedBlocks() >= FRAME_BUFFER_HIGH_WATER) await sleep(0);
  }
  return { queued, remainingBlocks: [] };
}

async function queueVideoBlocks(
  decoder: VideoDecoderLike,
  EncodedVideoChunkCtor: EncodedVideoChunkConstructorLike,
  blocks: MkvVideoBlock[],
  seenBlocks: Set<string>,
  signal: AbortSignal,
  getBufferedBlocks: () => number,
): Promise<{ queued: number; remainingBlocks: MkvVideoBlock[] }> {
  let queued = 0;
  let index = 0;
  for (; index < blocks.length; index++) {
    if (signal.aborted) return { queued, remainingBlocks: blocks.slice(index) };
    if (getBufferedBlocks() + queued >= BLOCK_BUFFER_HIGH_WATER) return { queued, remainingBlocks: blocks.slice(index) };
    const block = blocks[index];
    const key = getBlockKey(block);
    if (seenBlocks.has(key)) continue;
    seenBlocks.add(key);
    const chunk = new EncodedVideoChunkCtor({
      type: block.keyframe ? "key" : "delta",
      timestamp: Math.round(block.timestampUs),
      duration: block.durationUs ? Math.round(block.durationUs) : undefined,
      data: copyBytesToArrayBuffer(block.data),
    });
    decoder.decode(chunk);
    queued += 1;
    if (decoder.decodeQueueSize > 24 || getBufferedBlocks() >= FRAME_BUFFER_HIGH_WATER) await sleep(0);
  }
  return { queued, remainingBlocks: [] };
}

async function waitForPlaybackDrain(signal: AbortSignal, getBufferedBlocks: () => number): Promise<void> {
  while (!signal.aborted && getBufferedBlocks() > BLOCK_BUFFER_LOW_WATER) {
    await sleep(200);
  }
}

function getBlockKey(block: MkvVideoBlock): string {
  return `${Math.round(block.timestampUs)}:${block.data.byteLength}:${block.keyframe ? 1 : 0}`;
}

function joinBytes(parts: Uint8Array[], totalBytes: number): ArrayBuffer {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined.buffer;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function estimateVideoFrameDurationUs(blocks: MkvVideoBlock[], fallbackDurationUs: number | undefined, previousEstimateUs: number): number {
  const knownDurations = blocks
    .map((block) => block.durationUs)
    .filter((duration): duration is number => typeof duration === "number" && duration > 0);
  if (knownDurations.length > 0) {
    const averageDurationUs = knownDurations.reduce((sum, duration) => sum + duration, 0) / knownDurations.length;
    return Math.max(1, averageDurationUs);
  }
  if (fallbackDurationUs && fallbackDurationUs > 0) return fallbackDurationUs;
  return previousEstimateUs;
}

function sumVideoBlockDurationsUs(blocks: MkvVideoBlock[], fallbackDurationUs: number): number {
  let total = 0;
  for (const block of blocks) {
    total += block.durationUs && block.durationUs > 0 ? block.durationUs : fallbackDurationUs;
  }
  return total;
}

function sumBlockBytes<T extends { data: Uint8Array }>(blocks: T[]): number {
  let total = 0;
  for (const block of blocks) total += block.data.byteLength;
  return total;
}

function countVideoKeyframes(blocks: MkvVideoBlock[]): number {
  let total = 0;
  for (const block of blocks) {
    if (block.keyframe) total += 1;
  }
  return total;
}

function appendUniqueSorted<T>(
  existing: T[],
  incoming: T[],
  seenKeys: Set<string>,
  getKey: (block: T) => string,
  getTimestamp: (block: T) => number,
): T[] {
  if (incoming.length === 0) return existing;
  const merged = existing.slice();
  const existingKeys = new Set(existing.map(getKey));
  for (const block of incoming) {
    const key = getKey(block);
    if (seenKeys.has(key) || existingKeys.has(key)) continue;
    existingKeys.add(key);
    merged.push(block);
  }
  merged.sort((left, right) => getTimestamp(left) - getTimestamp(right));
  return merged;
}

function getAudioBlockKey(block: MkvAudioBlock): string {
  return `${Math.round(block.timestampUs)}:${block.data.byteLength}`;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0.0s";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds - minutes * 60);
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function formatBitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 kbps";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

function roundMetric(value: number): number {
  return Math.round(value * 10) / 10;
}

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
