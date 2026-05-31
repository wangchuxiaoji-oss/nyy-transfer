"use client";

import { useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { PlayerEngine, type BufferingState, type PlayerState } from "@/lib/sdp";
import { PrefetchProbe } from "@/lib/sdp/prefetch-probe";

const SEEK_PREWARM_DEBOUNCE_MS = 80;

interface SdpPlayerProps {
  file: ShareFileDownload;
  debugLog?: DebugLogFn;
}

export function SdpPlayer({ file, debugLog }: SdpPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PlayerEngine | null>(null);
  const prewarmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prewarmTokenRef = useRef(0);
  const playheadRef = useRef(0);
  const probeRef = useRef<PrefetchProbe | null>(null);
  const [state, setState] = useState<PlayerState>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const [buffering, setBuffering] = useState<BufferingState | null>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    const prefetchProfile = readPrefetchProfileOverride();
    const seekParallelParts = readSeekParallelParts();
    const engine = new PlayerEngine({ file, canvas, debugLog, prefetchProfile, seekParallelParts });
    engineRef.current = engine;

    engine.onStateChange = (s) => { if (!disposed) setState(s); };
    engine.onBufferingChange = (nextBuffering) => { if (!disposed) setBuffering(nextBuffering); };
    engine.onTimeUpdate = (t) => {
      if (disposed) return;
      playheadRef.current = t;
      setCurrentTime(t);
    };
    engine.onError = (msg) => { if (!disposed) setError(msg); };

    engine.init().then(() => {
      if (!disposed && engine.state === "ready") {
        setDuration(engine.duration);
        // Prefetch feasibility probe (measurement only, gated by ?prefetch=1).
        const prefetchEnabled =
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).get("prefetch") === "1";
        if (prefetchEnabled && engine.duration > 0) {
          const probe = new PrefetchProbe(file, engine.duration, debugLog);
          probeRef.current = probe;
          probe.start(() => playheadRef.current);
        }
      }
    });

    return () => {
      disposed = true;
      if (prewarmTimerRef.current) {
        clearTimeout(prewarmTimerRef.current);
        prewarmTimerRef.current = null;
      }
      prewarmTokenRef.current++;
      probeRef.current?.stop();
      probeRef.current = null;
      engine.dispose();
      engineRef.current = null;
    };
  }, [file, debugLog]);

  const handlePlay = () => engineRef.current?.play();
  const handlePause = () => engineRef.current?.pause();

  const handleScrubStart = (event: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    const target = getPointerRangeValue(event, duration) ?? currentTime;
    setScrubbing(true);
    setScrubValue(target);
    prewarmTokenRef.current++;
    if (prewarmTimerRef.current) {
      clearTimeout(prewarmTimerRef.current);
      prewarmTimerRef.current = null;
    }
    void engineRef.current?.prewarmSeek(target);
  };
  const handleScrubChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = Number(e.target.value);
    setScrubValue(nextValue);
    const token = ++prewarmTokenRef.current;
    if (prewarmTimerRef.current) {
      clearTimeout(prewarmTimerRef.current);
    }
    prewarmTimerRef.current = setTimeout(() => {
      prewarmTimerRef.current = null;
      if (token !== prewarmTokenRef.current) return;
      void engineRef.current?.prewarmSeek(nextValue);
    }, SEEK_PREWARM_DEBOUNCE_MS);
  };
  const handleScrubCommit = () => {
    const target = scrubValue;
    setScrubbing(false);
    prewarmTokenRef.current++;
    if (prewarmTimerRef.current) {
      clearTimeout(prewarmTimerRef.current);
      prewarmTimerRef.current = null;
    }
    void engineRef.current?.prewarmSeek(target);
    void engineRef.current?.seek(target);
  };

  const sliderValue = scrubbing ? scrubValue : currentTime;
  const canSeek = duration > 0 && state !== "loading" && state !== "idle";
  const isBuffering = buffering !== null;
  const statusLabel = isBuffering ? "缓冲中" : getStateLabel(state);
  const bufferingProgress = buffering?.progressPct ?? null;
  const bufferingSpeed = formatSpeed(buffering?.speedBytesPerSec ?? null);
  const bufferingMessage = buildBufferingMessage(buffering, bufferingProgress, bufferingSpeed);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
          SDP v2
        </span>
        <span className="text-xs text-gray-500">{statusLabel}</span>
      </div>

      <div className="relative overflow-hidden rounded-xl bg-black">
        <canvas
          ref={canvasRef}
          className="block w-full bg-black"
          style={{ aspectRatio: "16/9" }}
        />
        {isBuffering && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 px-4 text-center text-white">
            <p
              className="text-sm font-normal drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)] sm:text-base"
              style={{ fontFamily: 'SimSun, "Songti SC", "Noto Serif SC", serif' }}
            >
              {bufferingMessage}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        {state === "ready" || state === "paused" ? (
          <button
            onClick={handlePlay}
            className="rounded-lg bg-nyy-600 px-3 py-1 text-xs text-white hover:bg-nyy-700"
          >
            播放
          </button>
        ) : state === "playing" ? (
          <button
            onClick={handlePause}
            className="rounded-lg bg-nyy-600 px-3 py-1 text-xs text-white hover:bg-nyy-700"
          >
            暂停
          </button>
        ) : null}
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={sliderValue}
          disabled={!canSeek}
          onMouseDown={handleScrubStart}
          onTouchStart={handleScrubStart}
          onChange={handleScrubChange}
          onMouseUp={handleScrubCommit}
          onTouchEnd={handleScrubCommit}
          className="flex-1 accent-nyy-600 disabled:opacity-40"
        />
        <span className="whitespace-nowrap text-xs text-gray-500">
          {formatTime(sliderValue)} / {formatTime(duration)}
        </span>
      </div>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function readPrefetchProfileOverride(): "none" | "fileSystem" | "network" | undefined {
  if (typeof window === "undefined") return undefined;
  const value = new URLSearchParams(window.location.search).get("prefetchProfile");
  if (value === "none" || value === "fileSystem" || value === "network") return value;
  return undefined;
}

function readSeekParallelParts(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = new URLSearchParams(window.location.search).get("seekParallel");
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 16) : undefined;
}

function getStateLabel(state: PlayerState): string {
  switch (state) {
    case "idle": return "初始化";
    case "loading": return "加载中...";
    case "ready": return "就绪";
    case "playing": return "播放中";
    case "paused": return "已暂停";
    case "seeking": return "跳转中";
    case "ended": return "已结束";
    case "error": return "错误";
  }
}

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return "0:00";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSpeed(bytesPerSec: number | null): string | null {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec)) return null;
  const kbPerSec = bytesPerSec / 1024;
  if (kbPerSec >= 1024) return `${(kbPerSec / 1024).toFixed(1)} MB/s`;
  return `${Math.round(kbPerSec)} KB/s`;
}

function getPointerRangeValue(
  event: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>,
  duration: number,
): number | null {
  if (!duration || !Number.isFinite(duration)) return null;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) return null;

  const clientX = "touches" in event
    ? event.touches[0]?.clientX ?? event.changedTouches[0]?.clientX
    : event.clientX;
  if (typeof clientX !== "number") return null;

  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return ratio * duration;
}

function buildBufferingMessage(buffering: BufferingState | null, progressPct: number | null, speed: string | null): string {
  const label = buffering?.reason === "seek" && progressPct === null ? "定位中..." : "缓冲中...";
  const parts: string[] = [label];
  if (progressPct !== null) {
    parts.push(`${progressPct}%`);
  }
  if (speed) {
    parts.push(speed);
  }
  return parts.join(" · ");
}
