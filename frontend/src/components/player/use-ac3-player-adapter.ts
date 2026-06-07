"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import { decodeAc3Window, prewarmAc3Window } from "@/lib/ac3-sidecar";
import { getErrorMessage } from "@/lib/errors";
import {
  createVideoOnlyMp4BlobUrl,
  createVirtualMediaFileId,
  getVideoOnlyBlobFallbackSize,
  prepareVirtualMediaTransport,
  registerVirtualMediaFile,
} from "@/lib/virtual-media";
import type { PlayerActions, PlayerCapabilities, PlayerViewState, UnifiedPlayerState } from "./player-types";
import { makeCapabilities } from "./player-types";

const AUDIO_WINDOW_SEC = 4;
const AUDIO_LOOKAHEAD_SEC = 12;
const AUDIO_SCHEDULER_INTERVAL_MS = 500;
const PREVIEW_PREWARM_DEBOUNCE_MS = 90;

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
    audioSession: number;
    activeSources: number;
  };
};

function getAc3PlaybackSessionKey(file: ShareFileDownload): string {
  const chunksKey = file.chunks.map((chunk) => `${chunk.index}:${chunk.size}`).join(",");
  const assetsKey = (file.media_metadata?.playback_assets || [])
    .map((asset) => [
      asset.kind,
      asset.version || "",
      asset.virtual_size || "",
      asset.sidecar_size || "",
      asset.source_media_start || "",
      asset.source_media_end || "",
    ].join(":"))
    .sort()
    .join("|");
  const audioKey = (file.media_metadata?.audio_tracks || [])
    .map((track) => `${track.codec || ""}:${track.codec_tag || ""}`)
    .sort()
    .join("|");
  const hints = file.media_metadata?.playback_hints;
  return [
    file.file_name,
    file.file_size,
    file.content_type || "",
    file.is_chunked ? "chunked" : "single",
    chunksKey,
    file.media_metadata?.probe_status || "",
    file.media_metadata?.container || "",
    hints?.has_video_only_virtual === true ? "video-only" : "",
    assetsKey,
    audioKey,
  ].join("#");
}

function isTransientFetchError(error: unknown): boolean {
  return error instanceof TypeError && /failed to fetch/i.test(error.message || "");
}

function getAudioWindowStartSec(seconds: number): number {
  return Math.floor(Math.max(0, seconds) / AUDIO_WINDOW_SEC) * AUDIO_WINDOW_SEC;
}

interface Ac3AdapterResult {
  viewState: PlayerViewState;
  actions: PlayerActions;
  src: string;
}

export function useAc3PlayerAdapter(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  file: ShareFileDownload,
): Ac3AdapterResult {
  const audioContextRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const scheduledWindowsRef = useRef(new Set<number>());
  const scheduledWindowCountRef = useRef(0);
  const scheduledSourcesRef = useRef(new Map<number, AudioBufferSourceNode>());
  const decodeControllersRef = useRef(new Map<number, AbortController>());
  const schedulerTimerRef = useRef<number | null>(null);
  const lastPrewarmedWindowStartRef = useRef<number | null>(null);
  const lastPreviewWindowStartRef = useRef<number | null>(null);
  const previewPrewarmTimerRef = useRef<number | null>(null);
  const previewPrewarmRef = useRef<{ windowStartSec: number; controller: AbortController } | null>(null);
  const blobFallbackRequestIdRef = useRef(0);
  const blobUrlRef = useRef("");
  const fallbackAttemptedRef = useRef(false);
  const pendingBlobAutoplayRef = useRef(false);
  const pendingPlayRef = useRef(false);
  const lastPlayIntentAtRef = useRef(0);
  const mountedRef = useRef(false);
  const sessionRef = useRef(0);
  const virtualMediaIdRef = useRef<string | null>(null);
  const swRecoveryInFlightRef = useRef(false);
  const swRecoveryAttemptsRef = useRef(0);
  const pendingSwResumeRef = useRef<{ time: number; play: boolean } | null>(null);
  const srcRef = useRef("");
  const errorRef = useRef("");
  const transportRef = useRef<"sw" | "blob">("sw");
  const fileRef = useRef(file);
  fileRef.current = file;
  const playbackSessionKey = getAc3PlaybackSessionKey(file);
  const blobFallbackAvailable = getVideoOnlyBlobFallbackSize(file) !== null;
  if (!virtualMediaIdRef.current) virtualMediaIdRef.current = createVirtualMediaFileId("share-video");

  const [src, setSrc] = useState("");
  const [state, setState] = useState<UnifiedPlayerState>("loading");
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [transport, setTransport] = useState<"sw" | "blob">("sw");
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  volumeRef.current = volume;
  mutedRef.current = muted;

  const updateDebugState = useCallback(() => {
    if (typeof window === "undefined" || !mountedRef.current) return;
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
      audioSession: sessionRef.current,
      activeSources: scheduledSourcesRef.current.size,
    };
  }, [videoRef]);

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
    const AudioContextCtor =
      window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
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

  const resetAudioOutputGraph = useCallback(() => {
    const ctx = audioContextRef.current;
    const currentGain = gainNodeRef.current;
    if (!ctx || !currentGain) return;
    try { currentGain.disconnect(); } catch {}
    const nextGain = ctx.createGain();
    nextGain.gain.value = mutedRef.current ? 0 : volumeRef.current;
    nextGain.connect(ctx.destination);
    gainNodeRef.current = nextGain;
  }, []);

  const stopScheduledAudio = useCallback(() => {
    sessionRef.current += 1;
    if (schedulerTimerRef.current !== null) {
      window.clearInterval(schedulerTimerRef.current);
      schedulerTimerRef.current = null;
    }
    resetAudioOutputGraph();
    Array.from(decodeControllersRef.current.values()).forEach((c) => c.abort());
    decodeControllersRef.current.clear();
    Array.from(scheduledSourcesRef.current.values()).forEach((s) => {
      try { s.stop(); } catch {}
    });
    scheduledSourcesRef.current.clear();
    scheduledWindowsRef.current.clear();
    updateDebugState();
    return sessionRef.current;
  }, [resetAudioOutputGraph, updateDebugState]);

  const revokeBlobUrl = useCallback(() => {
    if (!blobUrlRef.current) return;
    URL.revokeObjectURL(blobUrlRef.current);
    blobUrlRef.current = "";
  }, []);

  const cancelPreviewPrewarm = useCallback((keepWindowStartSec?: number) => {
    if (previewPrewarmTimerRef.current !== null) {
      window.clearTimeout(previewPrewarmTimerRef.current);
      previewPrewarmTimerRef.current = null;
    }
    const active = previewPrewarmRef.current;
    if (active && active.windowStartSec !== keepWindowStartSec) {
      active.controller.abort();
      previewPrewarmRef.current = null;
    }
    if (keepWindowStartSec === undefined) lastPreviewWindowStartRef.current = null;
  }, []);

  const prewarmAudioWindowAtTime = useCallback((seconds: number) => {
    const windowStartSec = getAudioWindowStartSec(seconds);
    cancelPreviewPrewarm(windowStartSec);
    if (lastPrewarmedWindowStartRef.current === windowStartSec) return;
    lastPrewarmedWindowStartRef.current = windowStartSec;
    void prewarmAc3Window(fileRef.current, windowStartSec, AUDIO_WINDOW_SEC).catch(() => {
      if (lastPrewarmedWindowStartRef.current === windowStartSec) lastPrewarmedWindowStartRef.current = null;
    });
  }, [cancelPreviewPrewarm, playbackSessionKey]);

  const previewAudioWindowAtTime = useCallback((seconds: number) => {
    const windowStartSec = getAudioWindowStartSec(seconds);
    if (lastPreviewWindowStartRef.current === windowStartSec) return;
    lastPreviewWindowStartRef.current = windowStartSec;

    const active = previewPrewarmRef.current;
    if (active && active.windowStartSec !== windowStartSec) {
      active.controller.abort();
      previewPrewarmRef.current = null;
    }
    if (previewPrewarmTimerRef.current !== null) window.clearTimeout(previewPrewarmTimerRef.current);

    previewPrewarmTimerRef.current = window.setTimeout(() => {
      previewPrewarmTimerRef.current = null;
      if (previewPrewarmRef.current?.windowStartSec === windowStartSec) return;
      const controller = new AbortController();
      previewPrewarmRef.current = { windowStartSec, controller };
      void prewarmAc3Window(fileRef.current, windowStartSec, AUDIO_WINDOW_SEC, controller.signal)
        .catch((err) => {
          if (!(err instanceof DOMException && err.name === "AbortError") && lastPreviewWindowStartRef.current === windowStartSec) {
            lastPreviewWindowStartRef.current = null;
          }
        })
        .finally(() => {
          if (previewPrewarmRef.current?.controller === controller) previewPrewarmRef.current = null;
        });
    }, PREVIEW_PREWARM_DEBOUNCE_MS);
  }, [playbackSessionKey]);

  const registerSwSource = useCallback(async () => {
    const currentFile = fileRef.current;
    await prepareVirtualMediaTransport();
    return registerVirtualMediaFile(currentFile, "share-video", undefined, virtualMediaIdRef.current || undefined);
  }, [playbackSessionKey]);

  const reloadSwSource = useCallback((url: string) => {
    setSrc("");
    window.setTimeout(() => {
      if (!mountedRef.current) return;
      transportRef.current = "sw";
      setTransport("sw");
      setSrc(url);
    }, 0);
  }, []);

  const activateBlobFallback = useCallback(
    async (reason: unknown, resumeAfterReady = false) => {
      if (!blobFallbackAvailable) {
        throw reason instanceof Error ? reason : new Error(getErrorMessage(reason, "AC-3 视频通道失败"));
      }
      if (fallbackAttemptedRef.current) {
        throw reason instanceof Error ? reason : new Error(getErrorMessage(reason, "AC-3 视频通道失败"));
      }
      fallbackAttemptedRef.current = true;
      pendingBlobAutoplayRef.current = resumeAfterReady;
      stopScheduledAudio();
      const requestId = ++blobFallbackRequestIdRef.current;
      setState("loading");
      setError("");
      const blobUrl = await createVideoOnlyMp4BlobUrl(fileRef.current);
      if (!mountedRef.current || requestId !== blobFallbackRequestIdRef.current) {
        URL.revokeObjectURL(blobUrl);
        return;
      }
      revokeBlobUrl();
      blobUrlRef.current = blobUrl;
      transportRef.current = "blob";
      setTransport("blob");
      setSrc(blobUrl);
    },
    [blobFallbackAvailable, revokeBlobUrl, stopScheduledAudio],
  );

  const createAudioBuffer = useCallback((decoded: Awaited<ReturnType<typeof decodeAc3Window>>) => {
    const ctx = audioContextRef.current;
    if (!ctx) return null;
    const buffer = ctx.createBuffer(decoded.channels, decoded.totalSamples, decoded.sampleRate);
    for (let ch = 0; ch < decoded.channels; ch += 1) {
      buffer.copyToChannel(new Float32Array(decoded.planar[ch]), ch, 0);
    }
    return buffer;
  }, []);

  const decodeAudioWindowBuffer = useCallback(
    async (windowStartSec: number, sessionId: number) => {
      const controller = new AbortController();
      decodeControllersRef.current.set(windowStartSec, controller);
      updateDebugState();
      try {
        const decoded = await decodeAc3Window(fileRef.current, windowStartSec, AUDIO_WINDOW_SEC, controller.signal);
        decodeControllersRef.current.delete(windowStartSec);
        if (!mountedRef.current || sessionId !== sessionRef.current) return null;
        return createAudioBuffer(decoded);
      } catch (err) {
        decodeControllersRef.current.delete(windowStartSec);
        if (sessionId !== sessionRef.current) {
          updateDebugState();
          return null;
        }
        if (!(err instanceof DOMException && err.name === "AbortError") && !isTransientFetchError(err)) {
          setError(getErrorMessage(err, "AC-3 音频解码失败"));
        }
        updateDebugState();
        return null;
      }
    },
    [createAudioBuffer, updateDebugState],
  );

  const connectAudioWindow = useCallback(
    (windowStartSec: number, buffer: AudioBuffer, sessionId: number, anchorVideoTime: number) => {
      const activeVideo = videoRef.current;
      const ctx = audioContextRef.current;
      const gain = gainNodeRef.current;
      if (!mountedRef.current || !activeVideo || !ctx || !gain) return false;
      if (sessionId !== sessionRef.current) return false;

      const audioOffsetSec = Math.max(0, anchorVideoTime - windowStartSec);
      if (audioOffsetSec >= buffer.duration - 0.05) return false;
      const when = ctx.currentTime + Math.max(0, windowStartSec - anchorVideoTime);
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
      return true;
    },
    [updateDebugState, videoRef],
  );

  const scheduleWindow = useCallback(
    async (windowStartSec: number, sessionId: number) => {
      if (scheduledWindowsRef.current.has(windowStartSec) || decodeControllersRef.current.has(windowStartSec)) return;
      const video = videoRef.current;
      if (!video || video.paused) return;
      const buffer = await decodeAudioWindowBuffer(windowStartSec, sessionId);
      const activeVideo = videoRef.current;
      if (!buffer || !activeVideo || activeVideo.paused || sessionId !== sessionRef.current) return;
      connectAudioWindow(windowStartSec, buffer, sessionId, activeVideo.currentTime || 0);
    },
    [connectAudioWindow, decodeAudioWindowBuffer, videoRef],
  );

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
  }, [scheduleWindow, updateDebugState, videoRef]);

  const restartAudioFromCurrentTime = useCallback(async () => {
    stopScheduledAudio();
    await ensureAudioContext();
    startAudioScheduler();
  }, [ensureAudioContext, startAudioScheduler, stopScheduledAudio]);

  const recoverSwTransport = useCallback(
    async (reason: unknown, resumeAfterReady = false) => {
      if (transportRef.current !== "sw") {
        throw reason instanceof Error ? reason : new Error(getErrorMessage(reason, "AC-3 虚拟视频通道失败"));
      }
      if (swRecoveryInFlightRef.current || swRecoveryAttemptsRef.current >= 2) {
        throw reason instanceof Error ? reason : new Error(getErrorMessage(reason, "AC-3 虚拟视频通道失败"));
      }
      const video = videoRef.current;
      pendingSwResumeRef.current = {
        time: Math.max(0, video?.currentTime || 0),
        play: resumeAfterReady || pendingPlayRef.current || Boolean(video && !video.paused),
      };
      swRecoveryInFlightRef.current = true;
      swRecoveryAttemptsRef.current += 1;
      stopScheduledAudio();
      setError("");
      setState("loading");
      try {
        const nextSrc = await registerSwSource();
        if (!mountedRef.current) return;
        reloadSwSource(nextSrc);
      } finally {
        swRecoveryInFlightRef.current = false;
      }
    },
    [registerSwSource, reloadSwSource, stopScheduledAudio, videoRef],
  );

  const startAudioIfVideoIsPlaying = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.paused || schedulerTimerRef.current !== null) return;
    void restartAudioFromCurrentTime().catch((err) => {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(getErrorMessage(err, "AC-3 音频解码失败"));
      }
    });
  }, [restartAudioFromCurrentTime, videoRef]);

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
  }, [ensureAudioContext, restartAudioFromCurrentTime, videoRef]);

  useEffect(() => {
    if (transport !== "blob" || !src || !pendingBlobAutoplayRef.current) return;
    void resumeBlobAutoplay().catch((err) => {
      setError(getErrorMessage(err, "AC-3 Blob 兜底播放失败"));
      setState("error");
    });
  }, [resumeBlobAutoplay, src, transport]);

  useEffect(() => {
    void prewarmAc3Window(fileRef.current, 0, AUDIO_WINDOW_SEC).catch(() => {});
  }, [playbackSessionKey]);

  // 主初始化
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
    lastPrewarmedWindowStartRef.current = null;
    cancelPreviewPrewarm();
    swRecoveryAttemptsRef.current = 0;
    pendingSwResumeRef.current = null;
    transportRef.current = "sw";
    setTransport("sw");
    setSrc("");
    setError("");
    setState("loading");
    setCurrentTime(0);
    setDuration(0);

    const prepareSwTransport = async () => {
      return registerSwSource();
    };

    const prepare = async () => {
      if (blobFallbackAvailable) {
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
      cancelPreviewPrewarm();
      stopScheduledAudio();
      revokeBlobUrl();
      clearDebugState();
    };
  }, [activateBlobFallback, blobFallbackAvailable, cancelPreviewPrewarm, clearDebugState, playbackSessionKey, registerSwSource, revokeBlobUrl, stopScheduledAudio]);

  useEffect(() => {
    const refreshRegistration = () => {
      if (document.visibilityState !== "visible" || transportRef.current !== "sw" || !srcRef.current) return;
      void registerSwSource().catch(() => {});
    };
    document.addEventListener("visibilitychange", refreshRegistration);
    window.addEventListener("focus", refreshRegistration);
    return () => {
      document.removeEventListener("visibilitychange", refreshRegistration);
      window.removeEventListener("focus", refreshRegistration);
    };
  }, [registerSwSource]);

  // volume effect
  useEffect(() => {
    applyVolume();
    updateDebugState();
  }, [applyVolume, updateDebugState]);

  // debug sync
  useEffect(() => {
    srcRef.current = src;
    errorRef.current = error;
    transportRef.current = transport;
    updateDebugState();
  }, [currentTime, error, src, state, transport, updateDebugState]);

  // video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoaded = () => {
      if (!video.error) setError("");
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setCurrentTime(video.currentTime || 0);
      setState(video.paused ? "ready" : "playing");
      const pending = pendingSwResumeRef.current;
      if (pending) {
        pendingSwResumeRef.current = null;
        if (pending.time > 0 && Number.isFinite(pending.time)) {
          video.currentTime = Math.max(0, Math.min(video.duration || pending.time, pending.time));
        }
        if (pending.play) {
          void ensureAudioContext()
            .then(() => video.play())
            .then(() => restartAudioFromCurrentTime())
            .catch((err) => {
              setError(getErrorMessage(err, "AC-3 虚拟视频通道恢复失败"));
              setState("error");
            });
        }
      }
    };
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime || 0);
      startAudioIfVideoIsPlaying();
    };
    const onPlay = () => setState("playing");
    const onPlaying = () => {
      setState("playing");
      startAudioIfVideoIsPlaying();
    };
    const onPause = () => {
      stopScheduledAudio();
      setState(video.ended ? "ended" : "paused");
    };
    const onSeeking = () => {
      stopScheduledAudio();
      prewarmAudioWindowAtTime(video.currentTime || 0);
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
      if (video.paused) {
        setState("ready");
      } else {
        setState("playing");
        startAudioIfVideoIsPlaying();
      }
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
      if (transportRef.current === "sw") {
        const shouldResume = pendingPlayRef.current || !video.paused || Date.now() - lastPlayIntentAtRef.current < 5000;
        void recoverSwTransport(
          new Error(mediaError.message || "AC-3 虚拟视频通道播放失败"),
          shouldResume,
        ).catch((err) => {
          if (blobFallbackAvailable && !fallbackAttemptedRef.current) {
            void activateBlobFallback(err, shouldResume).catch((fallbackErr) => {
              setError(getErrorMessage(fallbackErr, "视频无法播放，请刷新页面后重试。若仍失败，可先下载文件后本地查看。"));
              setState("error");
            });
            return;
          }
          setError(getErrorMessage(err, "视频无法播放，请刷新页面后重试。若仍失败，可先下载文件后本地查看。"));
          setState("error");
        });
        return;
      }
      setError("视频无法播放，请刷新页面后重试。若仍失败，可先下载文件后本地查看。");
      setState("error");
    };

    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("ended", onEnded);
    video.addEventListener("error", onError);
    video.muted = true;

    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("error", onError);
    };
  }, [activateBlobFallback, blobFallbackAvailable, duration, ensureAudioContext, prewarmAudioWindowAtTime, recoverSwTransport, restartAudioFromCurrentTime, startAudioIfVideoIsPlaying, stopScheduledAudio, videoRef]);

  const capabilities: PlayerCapabilities = makeCapabilities({
    seek: { enabled: duration > 0 && state !== "loading" && state !== "error" },
    pictureInPicture: { enabled: false, reason: "AC-3 客户端链路暂不支持画中画" },
    speed: { enabled: false, reason: "AC-3 客户端链路当前仅支持 1x 播放" },
    subtitles: { enabled: false, reason: "AC-3 客户端链路暂不支持字幕" },
    quality: { enabled: false, reason: "单源文件无可切换画质" },
  });

  const viewState: PlayerViewState = {
    state: error ? "error" : state,
    currentTime,
    duration,
    bufferedPct: 0,
    buffering: null,
    error,
    title: file.file_name,
    modeLabel: transport === "blob" ? "AC-3 Blob" : "AC-3 客户端",
    isMuted: muted,
    volume,
    playbackRate: 1,
    capabilities,
  };

  const actions: PlayerActions = {
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
        if (transportRef.current === "sw") {
          await recoverSwTransport(err, true).catch(async (recoverErr) => {
            if (blobFallbackAvailable && !fallbackAttemptedRef.current) {
              await activateBlobFallback(recoverErr, true).catch((fallbackErr) => {
                setError(getErrorMessage(fallbackErr, "AC-3 播放启动失败"));
                setState("error");
              });
              return;
            }
            setError(getErrorMessage(recoverErr, "AC-3 播放启动失败"));
            setState("error");
          });
          return;
        }
        if (transportRef.current === "blob" && pendingBlobAutoplayRef.current) return;
        setError(getErrorMessage(err, "AC-3 播放启动失败"));
        setState("error");
      } finally {
        pendingPlayRef.current = false;
      }
    },
    pause: () => {
      lastPlayIntentAtRef.current = 0;
      pendingBlobAutoplayRef.current = false;
      cancelPreviewPrewarm();
      videoRef.current?.pause();
    },
    previewSeek: (seconds) => {
      if (!duration || duration <= 0) return;
      previewAudioWindowAtTime(Math.max(0, Math.min(duration, seconds)));
    },
    seek: (seconds) => {
      const video = videoRef.current;
      if (!video) return;
      const nextTime = Math.max(0, seconds);
      stopScheduledAudio();
      prewarmAudioWindowAtTime(nextTime);
      setState(video.paused ? "paused" : "seeking");
      video.currentTime = nextTime;
    },
    seekBy: (delta) => {
      const video = videoRef.current;
      if (!video || !duration || duration <= 0) return;
      const nextTime = Math.max(0, Math.min(duration, (video.currentTime || 0) + delta));
      stopScheduledAudio();
      prewarmAudioWindowAtTime(nextTime);
      setState(video.paused ? "paused" : "seeking");
      video.currentTime = nextTime;
    },
    setVolume: (next) => {
      setVolume(Math.max(0, Math.min(1, next)));
    },
    setMuted: (next) => {
      setMuted(next);
    },
    enterFullscreen: async (root) => {
      await root.requestFullscreen?.().catch(() => {});
    },
    exitFullscreen: async () => {
      await document.exitFullscreen?.().catch(() => {});
    },
  };

  return { viewState, actions, src };
}
