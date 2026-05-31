"use client";

import { useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { PlayerEngine, type PlayerState } from "@/lib/sdp";
import { PrefetchProbe } from "@/lib/sdp/prefetch-probe";

const SEEK_PREWARM_DEBOUNCE_MS = 700;

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
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    const engine = new PlayerEngine({ file, canvas, debugLog });
    engineRef.current = engine;

    engine.onStateChange = (s) => { if (!disposed) setState(s); };
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

  const handleScrubStart = () => {
    setScrubbing(true);
    setScrubValue(currentTime);
    prewarmTokenRef.current++;
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
    void engineRef.current?.seek(target);
  };

  const sliderValue = scrubbing ? scrubValue : currentTime;
  const canSeek = duration > 0 && state !== "loading" && state !== "idle";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-purple-100 px-2 py-0.5 text-xs font-medium text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
          SDP v2
        </span>
        <span className="text-xs text-gray-500">{getStateLabel(state)}</span>
      </div>

      <canvas
        ref={canvasRef}
        className="block w-full rounded-xl bg-black"
        style={{ aspectRatio: "16/9" }}
      />

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
