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
  const decodeDoneRef = useRef(false);
  const renderedRef = useRef(0);
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
    audioScheduledEndRef.current = 0;
    audioStartOffsetUsRef.current = 0;
    setQueuedBlocks(0);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const handleStop = useCallback(() => {
    cleanup();
    setState("idle");
    setStatus("已停止 MKV WebCodecs 预览");
    debugLog?.("sdp-mkv", "user:stop", { renderedFrames: renderedRef.current });
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

      while ((accumulatedBytes < sessionMaxBytes || pendingBlocks.length > 0) && !abort.signal.aborted) {
        if (pendingBlocks.length === 0 && accumulatedBytes < sessionMaxBytes) {
          const readSize = accumulatedBytes === 0 ? INITIAL_READ_BYTES : INCREMENTAL_READ_BYTES;
          const nextEnd = Math.min(sessionMaxBytes, accumulatedBytes + readSize);
          const rangeStartedAt = performance.now();
          setStatus(`MKV 增量读取：${formatSize(accumulatedBytes)} → ${formatSize(nextEnd)}`);
          debugLog?.("sdp-mkv", "range:start", { start: accumulatedBytes, end: nextEnd, fileSize: sessionMaxBytes, carryBytes: clusterCarry.byteLength });
          const partBuffer = await reader.read(accumulatedBytes, nextEnd, abort.signal);
          if (abort.signal.aborted) return;
          const partBytes = new Uint8Array(partBuffer);
          accumulatedBytes += partBuffer.byteLength;
          debugLog?.("sdp-mkv", "range:done", { bytesRead: partBuffer.byteLength, totalBytesRead: accumulatedBytes, elapsedMs: Math.round(performance.now() - rangeStartedAt) });

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
            setPlan(nextPlan);
            debugLog?.("sdp-mkv", "plan:ready", {
              codec: nextPlan.config.codec,
              blocks: nextPlan.blocks.length,
              width: nextPlan.videoTrack.width || null,
              height: nextPlan.videoTrack.height || null,
              durationSeconds: nextPlan.durationSeconds || null,
              totalBytesRead: accumulatedBytes,
              carryBytes: clusterCarry.byteLength,
            });

            const support = await VideoDecoderCtor.isConfigSupported?.(nextPlan.config);
            if (support && !support.supported) throw new Error(`WebCodecs 不支持 ${nextPlan.config.codec}`);

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
            if (latestPlan.audioTrack) {
              pendingAudioBlocks = parseMkvAudioBlocksFromBuffer(parseBuffer, latestPlan.audioTrack, latestPlan.timecodeScaleNs);
            }
            setPlan({ ...latestPlan, bytesRead: accumulatedBytes, blocks: parsed.blocks });
            debugLog?.("sdp-mkv", "cluster:parsed", {
              blocks: parsed.blocks.length,
              newBlocks: newBlocks.length,
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
          pendingBlocks = newBlocks;
          debugLog?.("sdp-mkv", "decoder:backlog", { pendingBlocks: pendingBlocks.length, totalBytesRead: accumulatedBytes });
        }

        if (pendingBlocks.length === 0 && accumulatedBytes >= sessionMaxBytes) break;

        if (!renderStarted) {
          setState("decoding");
          setStatus(`MKV WebCodecs 解码启动：${latestPlan?.config.codec || "unknown"}`);
          startRenderLoop();
          renderStarted = true;
        }

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
        setStatus(`MKV WebCodecs 播放中：读取 ${formatSize(accumulatedBytes)}，已入队 ${totalQueuedBlocks} 块`);
        debugLog?.("sdp-mkv", "decoder:queued", { queuedThisBatch: queueResult.queued, pendingBlocks: pendingBlocks.length, totalQueuedBlocks, totalBytesRead: accumulatedBytes, decodeQueueSize: decoder.decodeQueueSize });

        if (audioDecoder && EncodedAudioChunkCtor && pendingAudioBlocks.length > 0) {
          for (const aBlock of pendingAudioBlocks) {
            if (abort.signal.aborted) break;
            const aKey = `${Math.round(aBlock.timestampUs)}:${aBlock.data.byteLength}`;
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

        await waitForPlaybackDrain(abort.signal, () => Math.max(totalQueuedBlocks - renderedRef.current, framesRef.current.length));
      }

      if (!decoder || !latestPlan) throw new Error("MKV 增量读取结束但没有可解码视频块");
      debugLog?.("sdp-mkv", "stream:eof", { bytesRead: accumulatedBytes, fileSize: sessionMaxBytes, queuedBlocks: totalQueuedBlocks, renderedFrames: renderedRef.current });
      await decoder.flush();
      if (audioDecoder) await audioDecoder.flush().catch(() => {});
      decodeDoneRef.current = true;
      debugLog?.("sdp-mkv", "decoder:flush", { queuedFrames: framesRef.current.length, renderedFrames: renderedRef.current, queuedBlocks: totalQueuedBlocks, bytesRead: accumulatedBytes });
    } catch (err) {
      if (abort.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setState("error");
      setError(message);
      setStatus("MKV WebCodecs 预览失败");
      debugLog?.("sdp-mkv", "error", { error: message });
    }
  }, [cleanup, debugLog, file, startRenderLoop]);

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
    if (getBufferedBlocks() + queued >= BLOCK_BUFFER_HIGH_WATER && queued > 0) return { queued, remainingBlocks: blocks.slice(index) };
    while (!signal.aborted && getBufferedBlocks() + queued >= BLOCK_BUFFER_HIGH_WATER) {
      await sleep(100);
    }
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
