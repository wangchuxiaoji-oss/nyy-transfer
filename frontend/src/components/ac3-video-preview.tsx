"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import { PlayerChrome, type PlayerViewState } from "@/components/player-chrome";
import { decodeAc3Window } from "@/lib/ac3-sidecar";
import { getErrorMessage } from "@/lib/errors";
import { createVideoOnlyMp4BlobUrl, getVideoOnlyBlobFallbackSize, prepareVirtualMediaTransport, registerVirtualMediaFile } from "@/lib/virtual-media";

const AUDIO_WINDOW_SEC = 12;
const AUDIO_LOOKAHEAD_SEC = 18;
const AUDIO_SCHEDULER_INTERVAL_MS = 750;

type Ac3DebugWindow = Window & {
  __nyyAc3Debug?: {
      scheduledWindows: number;
      scheduledWindowCount: number;
      inFlightWindows: number;
    playing: boolean;
      currentTime: number;
      src: string;
      error: string;
      transport: "sw" | "blob";
      videoErrorCode: number | null;
      videoErrorMessage: string;
    };
};

interface Ac3VideoPreviewProps {
  file: ShareFileDownload;
  onDownload?: () => void;
}

export function Ac3VideoPreview({ file }: Ac3VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const scheduledWindowsRef = useRef(new Set<number>());
  const scheduledWindowCountRef = useRef(0);
  const scheduledSourcesRef = useRef(new Map<number, AudioBufferSourceNode>());
  const decodeControllersRef = useRef(new Map<number, AbortController>());
  const schedulerTimerRef = useRef<number | null>(null);
  const blobFallbackRequestIdRef = useRef(0);
  const blobUrlRef = useRef("");
  const fallbackAttemptedRef = useRef(false);
  const pendingBlobAutoplayRef = useRef(false);
  const pendingPlayRef = useRef(false);
  const lastPlayIntentAtRef = useRef(0);
  const mountedRef = useRef(false);
  const sessionRef = useRef(0);
  const srcRef = useRef("");
  const errorRef = useRef("");
  const transportRef = useRef<"sw" | "blob">("sw");
  const [src, setSrc] = useState("");
  const [state, setState] = useState<PlayerViewState["state"]>("loading");
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [transport, setTransport] = useState<"sw" | "blob">("sw");
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  const updateDebugState = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!mountedRef.current) return;
    const video = videoRef.current;
    (window as Ac3DebugWindow).__nyyAc3Debug = {
      scheduledWindows: scheduledWindowsRef.current.size,
      scheduledWindowCount: scheduledWindowCountRef.current,
      inFlightWindows: decodeControllersRef.current.size,
      playing: !video?.paused,
      currentTime: video?.currentTime || 0,
      src: srcRef.current,
      error: errorRef.current,
      transport: transportRef.current,
      videoErrorCode: video?.error?.code ?? null,
      videoErrorMessage: video?.error?.message || "",
    };
  }, []);

  const clearDebugState = useCallback(() => {
    if (typeof window === "undefined") return;
    delete (window as Ac3DebugWindow).__nyyAc3Debug;
  }, []);

  const applyVolume = useCallback(() => {
    const gain = gainNodeRef.current;
    if (!gain) return;
    gain.gain.value = muted ? 0 : volume;
  }, [muted, volume]);

  const ensureAudioContext = useCallback(async () => {
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error("当前浏览器不支持 AudioContext");
    if (!audioContextRef.current) {
      const ctx = new AudioContextCtor();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      audioContextRef.current = ctx;
      gainNodeRef.current = gain;
      applyVolume();
    }
    if (audioContextRef.current.state === "suspended") await audioContextRef.current.resume();
    return audioContextRef.current;
  }, [applyVolume]);

  const stopScheduledAudio = useCallback(() => {
    if (schedulerTimerRef.current !== null) {
      window.clearInterval(schedulerTimerRef.current);
      schedulerTimerRef.current = null;
    }
    Array.from(decodeControllersRef.current.values()).forEach((controller) => controller.abort());
    decodeControllersRef.current.clear();
    Array.from(scheduledSourcesRef.current.values()).forEach((source) => {
      try { source.stop(); } catch {}
    });
    scheduledSourcesRef.current.clear();
    scheduledWindowsRef.current.clear();
    updateDebugState();
  }, [updateDebugState]);

  const revokeBlobUrl = useCallback(() => {
    if (!blobUrlRef.current) return;
    URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = "";
  }, []);

  const activateBlobFallback = useCallback(async (reason: unknown, resumeAfterReady = false) => {
    if (fallbackAttemptedRef.current) {
      throw reason instanceof Error ? reason : new Error(getErrorMessage(reason, "AC-3 视频通道失败"));
    }
    fallbackAttemptedRef.current = true;
    pendingBlobAutoplayRef.current = resumeAfterReady;
    stopScheduledAudio();
    const requestId = ++blobFallbackRequestIdRef.current;
    setState("loading");
    setError("");
    const blobUrl = await createVideoOnlyMp4BlobUrl(file);
    if (!mountedRef.current || requestId !== blobFallbackRequestIdRef.current) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    revokeBlobUrl();
    blobUrlRef.current = blobUrl;
    transportRef.current = "blob";
    setTransport("blob");
    setSrc(blobUrl);
  }, [file, revokeBlobUrl, stopScheduledAudio]);

  const scheduleWindow = useCallback(async (windowStartSec: number, sessionId: number) => {
    if (scheduledWindowsRef.current.has(windowStartSec) || decodeControllersRef.current.has(windowStartSec)) return;
    const video = videoRef.current;
    if (!video || video.paused) return;
    const controller = new AbortController();
    decodeControllersRef.current.set(windowStartSec, controller);
    updateDebugState();
    try {
      const decoded = await decodeAc3Window(file, windowStartSec, AUDIO_WINDOW_SEC, controller.signal);
      decodeControllersRef.current.delete(windowStartSec);
      const activeVideo = videoRef.current;
      const ctx = audioContextRef.current;
      const gain = gainNodeRef.current;
      if (!mountedRef.current) return;
      if (!activeVideo || !ctx || !gain) return;
      if (sessionId !== sessionRef.current || activeVideo.paused) return;

      const buffer = ctx.createBuffer(decoded.channels, decoded.totalSamples, decoded.sampleRate);
      for (let ch = 0; ch < decoded.channels; ch += 1) {
        buffer.copyToChannel(new Float32Array(decoded.planar[ch]), ch, 0);
      }

      const audioOffsetSec = Math.max(0, activeVideo.currentTime - windowStartSec);
      if (audioOffsetSec >= buffer.duration - 0.05) return;
      const when = ctx.currentTime + Math.max(0, windowStartSec - activeVideo.currentTime);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => {
        scheduledSourcesRef.current.delete(windowStartSec);
        updateDebugState();
      };
      scheduledWindowsRef.current.add(windowStartSec);
      scheduledWindowCountRef.current += 1;
      scheduledSourcesRef.current.set(windowStartSec, source);
      source.start(when, audioOffsetSec);
      updateDebugState();
    } catch (err) {
      decodeControllersRef.current.delete(windowStartSec);
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(getErrorMessage(err, "AC-3 音频解码失败"));
      }
      updateDebugState();
    }
  }, [file, updateDebugState]);

  const startAudioScheduler = useCallback(() => {
    if (schedulerTimerRef.current !== null) return;
    const tick = () => {
      const video = videoRef.current;
      if (!video || video.paused || !Number.isFinite(video.currentTime)) return;
      const current = video.currentTime;
      const horizon = current + AUDIO_LOOKAHEAD_SEC;
      const base = Math.floor(current / AUDIO_WINDOW_SEC) * AUDIO_WINDOW_SEC;
      for (let start = base; start < horizon; start += AUDIO_WINDOW_SEC) {
        void scheduleWindow(start, sessionRef.current);
      }
      updateDebugState();
    };
    tick();
    schedulerTimerRef.current = window.setInterval(tick, AUDIO_SCHEDULER_INTERVAL_MS);
  }, [scheduleWindow, updateDebugState]);

  const restartAudioFromCurrentTime = useCallback(async () => {
    sessionRef.current += 1;
    stopScheduledAudio();
    await ensureAudioContext();
    startAudioScheduler();
  }, [ensureAudioContext, startAudioScheduler, stopScheduledAudio]);

  const resumeBlobAutoplay = useCallback(async () => {
    const video = videoRef.current;
    if (!video || transportRef.current !== "blob" || !pendingBlobAutoplayRef.current) return;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer = 0;
        const cleanup = () => {
          window.clearTimeout(timer);
          video.removeEventListener("canplay", onReady);
          video.removeEventListener("loadeddata", onReady);
          video.removeEventListener("error", onError);
        };
        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onReady = () => finish(resolve);
        const onError = () => finish(() => reject(new Error(video.error?.message || "AC-3 Blob 视频无法播放")));
        timer = window.setTimeout(() => finish(() => reject(new Error("AC-3 Blob 视频准备超时"))), 8000);
        video.addEventListener("canplay", onReady, { once: true });
        video.addEventListener("loadeddata", onReady, { once: true });
        video.addEventListener("error", onError, { once: true });
      });
    }
    if (!mountedRef.current || transportRef.current !== "blob" || !pendingBlobAutoplayRef.current) return;
    pendingBlobAutoplayRef.current = false;
    await ensureAudioContext();
    await video.play();
    await restartAudioFromCurrentTime();
  }, [ensureAudioContext, restartAudioFromCurrentTime]);

  useEffect(() => {
    if (transport !== "blob" || !src || !pendingBlobAutoplayRef.current) return;
    void resumeBlobAutoplay().catch((err) => {
      setError(getErrorMessage(err, "AC-3 Blob 兜底播放失败"));
      setState("error");
    });
  }, [resumeBlobAutoplay, src, transport]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    blobFallbackRequestIdRef.current += 1;
    revokeBlobUrl();
    fallbackAttemptedRef.current = false;
    pendingBlobAutoplayRef.current = false;
    pendingPlayRef.current = false;
    lastPlayIntentAtRef.current = 0;
    scheduledWindowCountRef.current = 0;
    transportRef.current = "sw";
    setTransport("sw");
    setSrc("");
    setError("");
    setState("loading");
    setCurrentTime(0);
    setDuration(0);
    const prepareSwTransport = async () => {
      await prepareVirtualMediaTransport();
      return registerVirtualMediaFile(file, "share-video");
    };
    const prepare = async () => {
      const useBlobFirst = getVideoOnlyBlobFallbackSize(file) !== null;
      if (useBlobFirst) {
        try {
          await activateBlobFallback(new Error("AC-3 小文件优先使用 Blob 视频通道"));
          return;
        } catch {
          fallbackAttemptedRef.current = false;
          const nextSrc = await prepareSwTransport();
          if (!cancelled) setSrc(nextSrc);
          return;
        }
      }

      try {
        const nextSrc = await prepareSwTransport();
        if (!cancelled) setSrc(nextSrc);
      } catch (err) {
        if (!cancelled) await activateBlobFallback(err);
      }
    };

    void prepare().catch((err) => {
        if (cancelled) return;
        setError(getErrorMessage(err, "AC-3 视频通道初始化失败"));
        setState("error");
      });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      blobFallbackRequestIdRef.current += 1;
      stopScheduledAudio();
      revokeBlobUrl();
      clearDebugState();
    };
  }, [activateBlobFallback, clearDebugState, file, revokeBlobUrl, stopScheduledAudio]);

  useEffect(() => {
    applyVolume();
    updateDebugState();
  }, [applyVolume, updateDebugState]);

  useEffect(() => {
    srcRef.current = src;
    errorRef.current = error;
    transportRef.current = transport;
    updateDebugState();
  }, [currentTime, error, src, state, transport, updateDebugState]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoadedMetadata = () => {
      if (!video.error) setError("");
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setCurrentTime(video.currentTime || 0);
      setState(video.paused ? "ready" : "playing");
    };
    const onTimeUpdate = () => setCurrentTime(video.currentTime || 0);
    const onPlay = () => setState("playing");
    const onPause = () => {
      stopScheduledAudio();
      setState(video.ended ? "ended" : "paused");
    };
    const onSeeking = () => {
      stopScheduledAudio();
      setState("seeking");
    };
    const onSeeked = () => {
      setCurrentTime(video.currentTime || 0);
      if (video.paused) {
        setState("paused");
      } else {
        void restartAudioFromCurrentTime();
        setState("playing");
      }
    };
    const onWaiting = () => {
      if (video.paused && video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        setState("ready");
        return;
      }
      setState("loading");
    };
    const onCanPlay = () => {
      if (!video.error) setError("");
      if (video.paused) setState("ready");
      else setState("playing");
    };
    const onEnded = () => {
      lastPlayIntentAtRef.current = 0;
      stopScheduledAudio();
      setState("ended");
      setCurrentTime(duration || video.currentTime || 0);
    };
    const onError = () => {
      const mediaError = video.error;
      if (!mediaError || mediaError.code === MediaError.MEDIA_ERR_ABORTED) return;
      if (transportRef.current === "sw" && !fallbackAttemptedRef.current) {
        const shouldResume = pendingPlayRef.current || !video.paused || Date.now() - lastPlayIntentAtRef.current < 5000;
        void activateBlobFallback(new Error(mediaError.message || "AC-3 虚拟视频通道播放失败"), shouldResume).catch((err) => {
          setError(getErrorMessage(err, "视频无法播放，请刷新页面后重试。若仍失败，可先下载文件后本地查看。"));
          setState("error");
        });
        return;
      }
      setError("视频无法播放，请刷新页面后重试。若仍失败，可先下载文件后本地查看。");
      setState("error");
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.muted = true;

    return () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
  }, [activateBlobFallback, duration, restartAudioFromCurrentTime, stopScheduledAudio]);

  const view: PlayerViewState = {
    state: error ? "error" : state,
    currentTime,
    duration,
    buffering: null,
    error,
    title: file.file_name,
    modeLabel: transport === "blob" ? "AC-3 Blob" : "AC-3 客户端",
    isMuted: muted,
    volume,
    playbackRate: 1,
    canSeek: duration > 0 && state !== "loading" && state !== "error",
    canFullscreen: true,
    canPictureInPicture: false,
    canVolume: true,
    canSpeed: false,
    canSubtitles: false,
    canQuality: false,
    unsupportedReasons: {
      speed: "AC-3 客户端链路当前仅支持 1x 播放",
      pip: "AC-3 客户端链路暂不支持画中画",
    },
  };

  return (
    <PlayerChrome
      view={view}
      actions={{
        play: async () => {
          const video = videoRef.current;
          if (!video) return;
          pendingPlayRef.current = true;
          lastPlayIntentAtRef.current = Date.now();
          try {
            await ensureAudioContext();
            await video.play();
            if (transportRef.current === "blob" && pendingBlobAutoplayRef.current) return;
            if (video.paused) return;
            await restartAudioFromCurrentTime();
          } catch (err) {
            if (transportRef.current === "sw" && !fallbackAttemptedRef.current) {
              await activateBlobFallback(err, true);
              return;
            }
            if (transportRef.current === "blob" && pendingBlobAutoplayRef.current) return;
            throw err;
          } finally {
            pendingPlayRef.current = false;
          }
        },
        pause: () => {
          lastPlayIntentAtRef.current = 0;
          pendingBlobAutoplayRef.current = false;
          videoRef.current?.pause();
        },
        seek: (seconds) => {
          const video = videoRef.current;
          if (!video) return;
          video.currentTime = Math.max(0, seconds);
        },
        setVolume: (nextVolume) => {
          setVolume(Math.max(0, Math.min(1, nextVolume)));
        },
        setMuted: (nextMuted) => {
          setMuted(nextMuted);
        },
        enterFullscreen: async () => {
          await videoRef.current?.parentElement?.requestFullscreen?.();
        },
      }}
    >
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
        className="absolute inset-0 h-full w-full bg-black object-contain"
        data-testid="ac3-video-preview"
      />
    </PlayerChrome>
  );
}
