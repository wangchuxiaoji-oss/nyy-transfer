"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { PlayerEngine, type BufferingState, type PlayerState } from "@/lib/sdp";
import { PrefetchProbe } from "@/lib/sdp/prefetch-probe";
import { PlayerChrome, type PlayerViewState } from "@/components/player-chrome";

interface SdpPlayerProps {
  file: ShareFileDownload;
  debugLog?: DebugLogFn;
}

type SdpDebugWindow = Window & {
  __nyySdpSeek?: (seconds: number) => boolean;
  __nyySdpDebug?: {
    fileName: string;
    state: PlayerState;
    currentTime: number;
    duration: number;
    error: string;
  };
};

export function SdpPlayer({ file, debugLog }: SdpPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PlayerEngine | null>(null);
  const playheadRef = useRef(0);
  const probeRef = useRef<PrefetchProbe | null>(null);
  const [state, setState] = useState<PlayerState>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const [buffering, setBuffering] = useState<BufferingState | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as SdpDebugWindow).__nyySdpDebug = {
      fileName: file.file_name,
      state,
      currentTime,
      duration,
      error,
    };
  }, [currentTime, duration, error, file.file_name, state]);

  const reportRuntimeError = useCallback((reason: unknown) => {
    if (isIgnorablePlayerAbort(reason)) return;
    const message = reason instanceof Error ? reason.message : String(reason ?? "播放器发生未知错误");
    debugLog?.("sdp-v2", "runtime:error", { error: message });
    setError(formatPlayerError(message));
  }, [debugLog]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    const prefetchProfile = readPrefetchProfileOverride();
    const seekParallelParts = readSeekParallelParts();
    const engine = new PlayerEngine({ file, canvas, debugLog, prefetchProfile, seekParallelParts });
    engineRef.current = engine;

    // 抑制播放器 Range 读取链路的已接管错误，避免 Next dev overlay 把它当成全局运行时错误。
    const suppressHandledPlayerRejection = (e: PromiseRejectionEvent) => {
      if (isHandledPlayerReadFailure(e.reason)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        reportRuntimeError(e.reason);
      }
    };
    const suppressHandledPlayerError = (e: ErrorEvent) => {
      const reason = e.error ?? e.message;
      if (isHandledPlayerReadFailure(reason)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        reportRuntimeError(reason);
      }
    };
    window.addEventListener("unhandledrejection", suppressHandledPlayerRejection, true);
    window.addEventListener("error", suppressHandledPlayerError, true);

    engine.onStateChange = (s) => { if (!disposed) setState(s); };
    engine.onBufferingChange = (nextBuffering) => { if (!disposed) setBuffering(nextBuffering); };
    engine.onTimeUpdate = (t) => {
      if (disposed) return;
      playheadRef.current = t;
      setCurrentTime(t);
    };
    engine.onError = (msg) => { if (!disposed && !isIgnorablePlayerAbort(msg)) setError(formatPlayerError(msg)); };

    const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
    if (debugEnabled) {
      (window as SdpDebugWindow).__nyySdpSeek = (seconds) => {
        const activeEngine = engineRef.current;
        if (!activeEngine) return false;
        const promise = activeEngine.seek(seconds);
        promise.catch(reportRuntimeError);
        return true;
      };
    }

    engine.init()
      .then(() => {
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
      })
      .catch((err) => {
        if (!disposed) reportRuntimeError(err);
      });

    return () => {
      disposed = true;
      window.removeEventListener("unhandledrejection", suppressHandledPlayerRejection, true);
      window.removeEventListener("error", suppressHandledPlayerError, true);
      probeRef.current?.stop();
      probeRef.current = null;
      engine.dispose();
      engineRef.current = null;
      if (debugEnabled && (window as SdpDebugWindow).__nyySdpSeek) {
        delete (window as SdpDebugWindow).__nyySdpSeek;
      }
      if ((window as SdpDebugWindow).__nyySdpDebug?.fileName === file.file_name) {
        delete (window as SdpDebugWindow).__nyySdpDebug;
      }
    };
  }, [file, debugLog, reportRuntimeError]);

  const handlePlay = async () => {
    try {
      await engineRef.current?.play();
    } catch (err) {
      reportRuntimeError(err);
    }
  };
  const handlePause = () => engineRef.current?.pause();
  const canSeek = duration > 0 && state !== "loading" && state !== "idle";
  const viewState: PlayerViewState = {
    state: mapSdpState(state),
    currentTime,
    duration,
    buffering,
    error,
    title: file.file_name,
    modeLabel: "SDP v2",
    isMuted,
    volume,
    playbackRate: 1,
    canSeek,
    canFullscreen: true,
    canPictureInPicture: false,
    canVolume: true,
    canSpeed: false,
    canSubtitles: false,
    canQuality: false,
    unsupportedReasons: {
      speed: "SDP v2 当前未暴露倍速控制",
      subtitles: "SDP v2 当前只探测字幕，尚未渲染",
      quality: "SDP v2 当前是单源单码率",
      pip: "Canvas 播放路径暂不支持 PiP",
    },
  };

  return (
    <div data-testid="sdp-player" className="h-full w-full min-w-0 space-y-2">
      <PlayerChrome
        className="min-h-0"
        view={viewState}
        actions={{
          play: handlePlay,
          pause: handlePause,
          seek: (seconds) => {
            // prewarmSeek 仅用于拖动预热，commitSeek 时直接 seek 即可
            const promise = engineRef.current?.seek(seconds);
            promise?.catch(reportRuntimeError);
          },
          setVolume: (nextVolume) => {
            const safeVolume = Math.max(0, Math.min(1, nextVolume));
            setVolume(safeVolume);
            engineRef.current?.setVolume(safeVolume);
          },
          setMuted: (nextMuted) => {
            setIsMuted(nextMuted);
            engineRef.current?.setMuted(nextMuted);
          },
          enterFullscreen: async () => {
            await canvasRef.current?.parentElement?.requestFullscreen?.();
          },
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full min-w-0 max-w-full bg-black object-contain"
        />
      </PlayerChrome>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
}

function isIgnorablePlayerAbort(reason: unknown): boolean {
  const error = reason instanceof Error ? reason : null;
  const message = error?.message ?? String(reason ?? "");
  return error?.name === "AbortError"
    || message.includes("seek cancelled")
    || message.includes("source disposed")
    || message.includes("Range fetch aborted");
}

function isHandledPlayerReadFailure(reason: unknown): boolean {
  if (isIgnorablePlayerAbort(reason)) return true;
  const error = reason instanceof Error ? reason : null;
  const message = error?.message ?? String(reason ?? "");
  const stack = error?.stack ?? "";
  return message.includes("Range read timeout")
    || message.includes("Range fetch failed")
    || message.includes("Failed to fetch")
    || stack.includes("range-file-reader")
    || stack.includes("fetchChunkRange");
}

function formatPlayerError(message: string): string {
  if (message.includes("Range read timeout") || message.includes("Range fetch failed") || message.includes("Failed to fetch")) {
    return "远端视频读取超时，请稍后重试；如果仍失败，可以先下载文件后本地查看。";
  }
  if (message.startsWith("Demuxer init failed:")) {
    return "视频初始化失败，请重试或下载文件查看。";
  }
  return message;
}

function mapSdpState(state: PlayerState): PlayerViewState["state"] {
  return state;
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
