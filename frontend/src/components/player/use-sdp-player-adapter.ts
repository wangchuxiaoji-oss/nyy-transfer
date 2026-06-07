"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { PlayerEngine, type BufferingState, type PlayerState } from "@/lib/sdp";
import { PrefetchProbe } from "@/lib/sdp/prefetch-probe";
import type { PlayerActions, PlayerCapabilities, PlayerViewState } from "./player-types";
import { makeCapabilities } from "./player-types";

// —— debug window ——

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

// —— adapter ——

interface SdpAdapterResult {
  viewState: PlayerViewState;
  actions: PlayerActions;
  engineRef: React.MutableRefObject<PlayerEngine | null>;
}

export function useSdpPlayerAdapter(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  file: ShareFileDownload,
  debugLog: DebugLogFn | undefined,
): SdpAdapterResult {
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

  // debug window
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

  const reportRuntimeError = useCallback(
    (reason: unknown) => {
      if (isIgnorablePlayerAbort(reason)) return;
      const message = reason instanceof Error ? reason.message : String(reason ?? "播放器发生未知错误");
      debugLog?.("sdp-v2", "runtime:error", { error: message });
      setError(formatPlayerError(message));
    },
    [debugLog],
  );

  // engine 初始化和 dispose
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;

    const prefetchProfile = readPrefetchProfileOverride();
    const seekParallelParts = readSeekParallelParts();
    const engine = new PlayerEngine({ file, canvas, debugLog, prefetchProfile, seekParallelParts });
    engineRef.current = engine;

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
    engine.onBufferingChange = (next) => { if (!disposed) setBuffering(next); };
    engine.onTimeUpdate = (t) => {
      if (disposed) return;
      playheadRef.current = t;
      setCurrentTime(t);
    };
    engine.onError = (msg) => {
      if (!disposed && !isIgnorablePlayerAbort(msg)) setError(formatPlayerError(msg));
    };

    const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
    if (debugEnabled) {
      (window as SdpDebugWindow).__nyySdpSeek = (seconds) => {
        const activeEngine = engineRef.current;
        if (!activeEngine) return false;
        activeEngine.seek(seconds).catch(reportRuntimeError);
        return true;
      };
    }

    engine
      .init()
      .then(() => {
        if (!disposed && engine.state === "ready") {
          setDuration(engine.duration);
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
  }, [canvasRef, file, debugLog, reportRuntimeError]);

  const capabilities: PlayerCapabilities = makeCapabilities({
    seek: { enabled: duration > 0 && state !== "loading" && state !== "idle" },
    pictureInPicture: { enabled: false, reason: "Canvas 播放路径暂不支持 PiP" },
    speed: { enabled: false, reason: "SDP v2 当前未暴露倍速控制" },
    subtitles: { enabled: false, reason: "SDP v2 当前只探测字幕，尚未渲染" },
    quality: { enabled: false, reason: "SDP v2 当前是单源单码率" },
  });

  const viewState: PlayerViewState = {
    state: mapSdpState(state),
    currentTime,
    duration,
    bufferedPct: 0,
    buffering,
    error,
    title: file.file_name,
    modeLabel: "SDP v2",
    isMuted,
    volume,
    playbackRate: 1,
    capabilities,
  };

  const actions: PlayerActions = {
    play: async () => {
      try {
        await engineRef.current?.play();
      } catch (err) {
        reportRuntimeError(err);
      }
    },
    pause: () => engineRef.current?.pause(),
    seek: (seconds) => {
      engineRef.current?.seek(seconds).catch(reportRuntimeError);
    },
    seekBy: (delta) => {
      const engine = engineRef.current;
      if (!engine || !duration || duration <= 0) return;
      const next = Math.max(0, Math.min(duration, currentTime + delta));
      engine.seek(next).catch(reportRuntimeError);
    },
    setVolume: (next) => {
      const safe = Math.max(0, Math.min(1, next));
      setVolume(safe);
      engineRef.current?.setVolume(safe);
    },
    setMuted: (muted) => {
      setIsMuted(muted);
      engineRef.current?.setMuted(muted);
    },
    enterFullscreen: async (root) => {
      await root.requestFullscreen?.().catch(() => {});
    },
    exitFullscreen: async () => {
      await document.exitFullscreen?.().catch(() => {});
    },
  };

  return { viewState, actions, engineRef };
}

// —— helpers ——

function mapSdpState(state: PlayerState): PlayerViewState["state"] {
  return state;
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
