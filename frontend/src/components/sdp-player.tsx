"use client";

import { useEffect, useRef, useState } from "react";
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
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    const prefetchProfile = readPrefetchProfileOverride();
    const seekParallelParts = readSeekParallelParts();
    const engine = new PlayerEngine({ file, canvas, debugLog, prefetchProfile, seekParallelParts });
    engineRef.current = engine;

    // 抑制 seek cancelled 导致的 unhandled rejection（mediabunny 内部 prefetch 不一定 catch abort 错误）
    const suppressSeekAbort = (e: PromiseRejectionEvent) => {
      const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "");
      if (msg.includes("seek cancelled") || msg.includes("source disposed") || msg.includes("Range fetch aborted")) {
        e.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", suppressSeekAbort);

    engine.onStateChange = (s) => { if (!disposed) setState(s); };
    engine.onBufferingChange = (nextBuffering) => { if (!disposed) setBuffering(nextBuffering); };
    engine.onTimeUpdate = (t) => {
      if (disposed) return;
      playheadRef.current = t;
      setCurrentTime(t);
    };
    engine.onError = (msg) => { if (!disposed) setError(msg); };

    const debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
    if (debugEnabled) {
      (window as SdpDebugWindow).__nyySdpSeek = (seconds) => {
        const activeEngine = engineRef.current;
        if (!activeEngine) return false;
        void activeEngine.seek(seconds);
        return true;
      };
    }

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
      window.removeEventListener("unhandledrejection", suppressSeekAbort);
      probeRef.current?.stop();
      probeRef.current = null;
      engine.dispose();
      engineRef.current = null;
      if (debugEnabled && (window as SdpDebugWindow).__nyySdpSeek) {
        delete (window as SdpDebugWindow).__nyySdpSeek;
      }
    };
  }, [file, debugLog]);

  const handlePlay = () => engineRef.current?.play();
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
    <div className="space-y-2">
      <PlayerChrome
        view={viewState}
        actions={{
          play: handlePlay,
          pause: handlePause,
          seek: (seconds) => {
            // prewarmSeek 仅用于拖动预热，commitSeek 时直接 seek 即可
            void engineRef.current?.seek(seconds);
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
          className="block w-full bg-black"
          style={{ aspectRatio: "16/9" }}
        />
      </PlayerChrome>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </div>
  );
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
