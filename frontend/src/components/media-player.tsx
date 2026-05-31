"use client";

import { useEffect, useRef, useState, useCallback, useLayoutEffect } from "react";
import type { ShareFileDownload } from "@/lib/api";
import { createVirtualMediaFileId, registerVirtualMediaFile } from "@/lib/virtual-media";
import { canNativePlayAc3, decodeAc3Window } from "@/lib/ac3-sidecar";
import type { DebugLogFn } from "@/lib/debug";

const VIDEO_EXTS = ["mp4", "webm", "ogg", "mov"];
const AUDIO_EXTS = ["mp3", "aac", "ogg", "wav", "flac", "m4a"];
const usePlyrEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function getMediaType(fileName: string): "video" | "audio" | null {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  return null;
}

interface MediaPlayerProps {
  file: ShareFileDownload;
  className?: string;
  debugLog?: DebugLogFn;
}

export function MediaPlayer({ file, className = "", debugLog }: MediaPlayerProps) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plyrRef = useRef<any>(null);
  const [error, setError] = useState("");

  const mediaType = getMediaType(file.file_name);

  usePlyrEffect(() => {
    if (!mediaRef.current || !mediaType) return;
    let cancelled = false;

    import("plyr").then(({ default: Plyr }) => {
      if (cancelled || !mediaRef.current) return;
      plyrRef.current = new Plyr(mediaRef.current, {
        controls: [
          "play-large", "play", "progress", "current-time",
          "duration", "mute", "volume",
          ...(mediaType === "video" ? ["fullscreen" as const] : []),
        ],
        tooltips: { controls: false, seek: true },
      });
    });

    return () => {
      cancelled = true;
      try { plyrRef.current?.destroy(); } catch {}
      plyrRef.current = null;
    };
  }, [mediaType]);

  if (!mediaType) return null;

  if (file.is_chunked && file.chunks?.length > 0) {
    return <NativeRangeChunkedMediaPlayer file={file} mediaType={mediaType} className={className} debugLog={debugLog} />;
  }

  // Small file — direct URL playback
  if (mediaType === "video") {
    return (
      <div className={className}>
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={file.download_url}
          crossOrigin="anonymous"
          preload="metadata"
          playsInline
          className="w-full rounded-2xl overflow-hidden"
          onError={() => setError("视频加载失败")}
        />
        {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <div className={className}>
      <audio
        ref={mediaRef as React.RefObject<HTMLAudioElement>}
        src={file.download_url}
        crossOrigin="anonymous"
        preload="metadata"
        className="w-full"
        onError={() => setError("音频加载失败")}
      />
      {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
    </div>
  );
}


function NativeRangeChunkedMediaPlayer({
  file,
  mediaType,
  className = "",
  debugLog,
}: {
  file: ShareFileDownload;
  mediaType: "video" | "audio";
  className?: string;
  debugLog?: DebugLogFn;
}) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plyrRef = useRef<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [sourceUrl, setSourceUrl] = useState("");
  const [fallbackToMse, setFallbackToMse] = useState(false);
  const [modeLabel, setModeLabel] = useState("native-range");
  const [sidecarStatus, setSidecarStatus] = useState("");
  const [needsSidecarAc3, setNeedsSidecarAc3] = useState(false);
  const ac3AbortRef = useRef<AbortController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioGainRef = useRef<GainNode | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const sidecarTimerRef = useRef<number | null>(null);
  const sidecarStartingRef = useRef(false);
  const sidecarWindowRef = useRef<{ start: number; end: number } | null>(null);
  const sidecarSeekingRef = useRef(false); // guards against our own seeking event
  const seekStartRef = useRef<{ at: number; target: number } | null>(null);
  const initKeyRef = useRef("");
  const virtualFileIdRef = useRef("");
  const virtualFileIdentityRef = useRef("");
  const reregisteringRef = useRef(false);
  const downloadUrlKey = file.chunks.map((chunk) => chunk.download_url).join("|");

  const getVirtualFileIdentity = useCallback(() => (
    `${mediaType}:${file.file_name}:${file.file_size}:${file.chunks.length}`
  ), [file.chunks.length, file.file_name, file.file_size, mediaType]);

  const getOrCreateVirtualFileId = useCallback(() => {
    const identity = getVirtualFileIdentity();
    if (virtualFileIdentityRef.current !== identity) {
      virtualFileIdentityRef.current = identity;
      virtualFileIdRef.current = createVirtualMediaFileId(`range-${file.file_name}`);
    }
    if (!virtualFileIdRef.current) {
      virtualFileIdRef.current = createVirtualMediaFileId(`range-${file.file_name}`);
    }
    return virtualFileIdRef.current;
  }, [file.file_name, getVirtualFileIdentity]);

  const reregisterVirtualFile = useCallback(async (reason: string) => {
    const id = virtualFileIdRef.current;
    if (!id || reregisteringRef.current) return;
    reregisteringRef.current = true;
    debugLog?.("sw", "reregister:start", { id, reason, fileName: file.file_name });
    try {
      await registerVirtualMediaFile(file, `range-${file.file_name}`, debugLog, id);
      debugLog?.("sw", "reregister:ack", { id, reason });
    } catch (err) {
      debugLog?.("sw", "reregister:error", { id, reason, error: err instanceof Error ? err.message : String(err) });
    } finally {
      reregisteringRef.current = false;
    }
  }, [debugLog, file]);

  const initPlayer = useCallback(async () => {
    const el = mediaRef.current;
    if (!el) return;
    setLoading(true);
    setError("");

    try {
      debugLog?.("player", "init:start", { fileName: file.file_name, fileSize: file.file_size, chunks: file.chunks.length, mediaType });
      const virtualFileId = getOrCreateVirtualFileId();
      const url = await registerVirtualMediaFile(file, `range-${file.file_name}`, debugLog, virtualFileId);
      setSourceUrl(url);
      const sidecarDecision = decideSidecar(file, mediaType);
      const needsSidecar = sidecarDecision.needsSidecar;
      setNeedsSidecarAc3(needsSidecar);
      if (needsSidecar) {
        (el as HTMLVideoElement).muted = true;
        setModeLabel("native-video + wasm-ac3");
      } else {
        setModeLabel("native-muxed");
      }
      debugLog?.("player", "sidecar:decision", sidecarDecision.debugData);
      debugLog?.("player", "init:done", { sourceUrl: url, needsSidecar });
      setLoading(false);
    } catch (err) {
      console.warn("[MediaPlayer] native range registration failed", err);
      debugLog?.("player", "init:error", { error: err instanceof Error ? err.message : String(err) });
      setFallbackToMse(true);
      setError(err instanceof Error ? err.message : "原生 Range 播放失败");
      setLoading(false);
    }
  }, [debugLog, file, getOrCreateVirtualFileId, mediaType]);

  const stopSidecarAudio = useCallback(() => {
    ac3AbortRef.current?.abort();
    ac3AbortRef.current = null;
    if (sidecarTimerRef.current) clearTimeout(sidecarTimerRef.current);
    sidecarTimerRef.current = null;
    sidecarWindowRef.current = null;
    try { audioSourceRef.current?.stop(); } catch {}
    audioSourceRef.current = null;
  }, []);

  const startSidecarAudioWindow = useCallback(async (force = false) => {
    if (mediaType !== "video" || !needsSidecarAc3) return;
    const video = mediaRef.current as HTMLVideoElement | null;
    if (!video || (!force && video.paused) || !sourceUrl || sidecarStartingRef.current) return;

    const existingWindow = sidecarWindowRef.current;
    if (existingWindow && video.currentTime >= existingWindow.start && video.currentTime < existingWindow.end - 2 && audioSourceRef.current) {
      return;
    }

    sidecarStartingRef.current = true;
    stopSidecarAudio();
    const abort = new AbortController();
    ac3AbortRef.current = abort;
    const startSec = Math.max(0, Math.floor(video.currentTime || 0));
    console.debug("[MediaPlayer] sidecar start", { startSec });
    debugLog?.("sidecar", "decode:start", { startSec, windowSec: 24 });
    video.pause();
    const windowSec = 24;
    setSidecarStatus(`解码 AC-3 音频窗口：${formatTime(startSec)} → ${formatTime(startSec + windowSec)}`);

    try {
      const decodeStartedAt = performance.now();
      const decoded = await decodeAc3Window(file, startSec, windowSec, abort.signal);
      if (abort.signal.aborted || !mediaRef.current) return;
      const windowDuration = decoded.totalSamples / decoded.sampleRate;
      console.debug("[MediaPlayer] sidecar decoded", { startSec, duration: windowDuration });
      debugLog?.("sidecar", "decode:done", {
        startSec,
        duration: windowDuration,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        decodeMs: Math.round(performance.now() - decodeStartedAt),
      });
      const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) throw new Error("当前浏览器不支持 AudioContext");
      if (!audioContextRef.current) audioContextRef.current = new AudioContextCtor();
      const ctx = audioContextRef.current;
      if (ctx.state === "suspended") await ctx.resume();
      const audioBuffer = ctx.createBuffer(decoded.channels, decoded.totalSamples, decoded.sampleRate);
      for (let ch = 0; ch < decoded.channels; ch++) {
        audioBuffer.copyToChannel(new Float32Array(decoded.planar[ch]), ch, 0);
      }
      const src = ctx.createBufferSource();
      src.buffer = audioBuffer;
      if (!audioGainRef.current) {
        audioGainRef.current = ctx.createGain();
        audioGainRef.current.connect(ctx.destination);
        // Sync initial gain with Plyr's current volume
        const plyr = plyrRef.current;
        if (plyr) {
          audioGainRef.current.gain.value = plyr.muted ? 0 : plyr.volume;
        }
      }
      src.connect(audioGainRef.current);
      audioSourceRef.current = src;
      sidecarWindowRef.current = { start: startSec, end: startSec + windowDuration };

      if (Math.abs(video.currentTime - startSec) > 0.35) {
        sidecarSeekingRef.current = true;
        video.currentTime = startSec;
        sidecarSeekingRef.current = false;
      }
      try {
        await video.play();
      } catch (playErr) {
        if ((playErr as DOMException)?.name === "NotAllowedError") {
          throw new Error("浏览器阻止了自动播放，请手动点击播放");
        }
        throw playErr;
      }
      src.start(0);
      console.debug("[MediaPlayer] sidecar playback started", { startSec });
      debugLog?.("sidecar", "playback:start", { startSec, windowDuration });
      setSidecarStatus(`AC-3 wasm 音频播放中：${formatTime(startSec)}`);

      const refreshMs = Math.max(2000, (windowDuration - 2) * 1000);
      sidecarTimerRef.current = window.setTimeout(() => {
        if (!abort.signal.aborted) void startSidecarAudioWindow(true);
      }, refreshMs);
    } catch (err) {
      console.warn("[MediaPlayer] sidecar error", err);
      debugLog?.("sidecar", "error", { error: err instanceof Error ? err.message : String(err), aborted: abort.signal.aborted });
      if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "AC-3 音频解码失败");
    } finally {
      sidecarStartingRef.current = false;
    }
  }, [debugLog, file, mediaType, needsSidecarAc3, sourceUrl, stopSidecarAudio]);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el || mediaType !== "video") return;
    const video = el as HTMLVideoElement;

    const onPlay = () => {
      const seek = seekStartRef.current;
      if (seek && video.currentTime > seek.target + 0.05) {
        debugLog?.("player", "seek:play", {
          target: seek.target,
          currentTime: Number(video.currentTime.toFixed(3)),
          latencyMs: Math.round(performance.now() - seek.at),
          readyState: video.readyState,
          buffered: describeBuffered(video),
        });
        seekStartRef.current = null;
      }
      if (needsSidecarAc3 && !audioSourceRef.current && !sidecarStartingRef.current) void startSidecarAudioWindow(true);
    };
    const onPause = () => {
      debugLog?.("player", "pause", { currentTime: Number(video.currentTime.toFixed(3)), readyState: video.readyState });
      if (!sidecarStartingRef.current) stopSidecarAudio();
    };
    const onSeeking = () => {
      if (!sidecarSeekingRef.current) {
        seekStartRef.current = { at: performance.now(), target: video.currentTime };
        debugLog?.("player", "seek:start", {
          target: Number(video.currentTime.toFixed(3)),
          readyState: video.readyState,
          paused: video.paused,
          buffered: describeBuffered(video),
        });
        stopSidecarAudio();
      }
    };
    const onSeeked = () => {
      const seek = seekStartRef.current;
      debugLog?.("player", "seek:seeked", {
        target: seek ? Number(seek.target.toFixed(3)) : null,
        currentTime: Number(video.currentTime.toFixed(3)),
        seekedMs: seek ? Math.round(performance.now() - seek.at) : null,
        readyState: video.readyState,
        paused: video.paused,
        buffered: describeBuffered(video),
      });
      if (!video.paused) void startSidecarAudioWindow(true);
    };
    const onTimeUpdate = () => {
      const seek = seekStartRef.current;
      if (seek && !video.paused && video.currentTime > seek.target + 0.1) {
        debugLog?.("player", "seek:advance", {
          target: Number(seek.target.toFixed(3)),
          currentTime: Number(video.currentTime.toFixed(3)),
          latencyMs: Math.round(performance.now() - seek.at),
          readyState: video.readyState,
          buffered: describeBuffered(video),
        });
        seekStartRef.current = null;
      }
      const activeWindow = sidecarWindowRef.current;
      const needsRefresh = !activeWindow || video.currentTime >= activeWindow.end - 2;
      if (needsSidecarAc3 && !video.paused && needsRefresh && !audioSourceRef.current && !sidecarStartingRef.current) {
        void startSidecarAudioWindow(true);
      }
    };
    const onWaiting = () => debugLog?.("player", "waiting", { currentTime: Number(video.currentTime.toFixed(3)), readyState: video.readyState, buffered: describeBuffered(video) });
    const onCanPlay = () => debugLog?.("player", "canplay", { currentTime: Number(video.currentTime.toFixed(3)), readyState: video.readyState, buffered: describeBuffered(video) });

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("canplay", onCanPlay);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("canplay", onCanPlay);
    };
  }, [debugLog, mediaType, needsSidecarAc3, startSidecarAudioWindow, stopSidecarAudio]);

  usePlyrEffect(() => {
    if (!mediaRef.current || !mediaType || loading || fallbackToMse || !sourceUrl) return;
    let cancelled = false;
    import("plyr").then(({ default: Plyr }) => {
      if (cancelled || !mediaRef.current) return;
      plyrRef.current = new Plyr(mediaRef.current, {
        controls: [
          "play-large", "play", "progress", "current-time",
          "duration", "mute", "volume",
          ...(mediaType === "video" ? ["fullscreen" as const] : []),
        ],
        tooltips: { controls: false, seek: true },
      });
    });

    return () => {
      cancelled = true;
      try { plyrRef.current?.destroy(); } catch {}
      plyrRef.current = null;
    };
  }, [fallbackToMse, loading, mediaType, sourceUrl]);

  // Sync Plyr volume/mute to sidecar WebAudio GainNode
  // The <video> stays muted (Chrome can't decode AC-3 natively), but Plyr's
  // volume slider controls the sidecar audio via GainNode.
  useEffect(() => {
    if (!needsSidecarAc3) return;
    const el = mediaRef.current as HTMLVideoElement | null;
    if (!el) return;
    const syncGain = () => {
      const gain = audioGainRef.current;
      if (!gain) return;
      const plyr = plyrRef.current;
      if (plyr) {
        gain.gain.value = plyr.muted ? 0 : plyr.volume;
        // Force video muted to prevent garbled AC-3 output
        if (!el.muted) el.muted = true;
      }
    };
    el.addEventListener("volumechange", syncGain);
    return () => el.removeEventListener("volumechange", syncGain);
  }, [needsSidecarAc3]);

  useEffect(() => {
    const initKey = `${mediaType}:${file.file_name}:${file.file_size}:${file.chunks.length}:${file.download_url}:${downloadUrlKey}`;
    if (initKeyRef.current === initKey) return;
    initKeyRef.current = initKey;
    void initPlayer();
  }, [downloadUrlKey, file.chunks.length, file.download_url, file.file_name, file.file_size, initPlayer, mediaType]);

  useEffect(() => {
    if (!sourceUrl) return;

    const onControllerChange = () => void reregisterVirtualFile("controllerchange");
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void reregisterVirtualFile("visible");
    };
    const onOnline = () => void reregisterVirtualFile("online");
    const timer = window.setInterval(() => void reregisterVirtualFile("interval"), 30000);

    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", onOnline);

    return () => {
      window.clearInterval(timer);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onOnline);
    };
  }, [reregisterVirtualFile, sourceUrl]);

  // Master cleanup on unmount: abort sidecar, close AudioContext
  useEffect(() => {
    return () => {
      ac3AbortRef.current?.abort();
      ac3AbortRef.current = null;
      if (sidecarTimerRef.current) clearTimeout(sidecarTimerRef.current);
      sidecarTimerRef.current = null;
      try { audioSourceRef.current?.stop(); } catch {}
      audioSourceRef.current = null;
      audioGainRef.current?.disconnect();
      audioGainRef.current = null;
      audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (mediaType !== "video" || !needsSidecarAc3 || loading) return;
    const timer = window.setInterval(() => {
      const video = mediaRef.current as HTMLVideoElement | null;
      if (!video || video.paused || audioSourceRef.current || sidecarStartingRef.current) return;
      void startSidecarAudioWindow(true);
    }, 500);
    return () => clearInterval(timer);
  }, [loading, mediaType, needsSidecarAc3, startSidecarAudioWindow]);

  if (fallbackToMse) {
    return (
      <div className={className}>
        <p className="text-sm text-red-500">当前浏览器不支持此文件的在线播放，请下载后使用本地播放器观看。</p>
      </div>
    );
  }

  if (mediaType === "video") {
    return (
      <div className={`relative min-h-48 ${className}`}>
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-black/5 text-gray-400 animate-pulse dark:bg-white/[0.03]">
            原生 Range 加载中...
          </div>
        )}
        <video
          ref={mediaRef as React.RefObject<HTMLVideoElement>}
          src={sourceUrl || undefined}
          crossOrigin="anonymous"
          preload="metadata"
          playsInline
          className="block w-full rounded-2xl overflow-hidden bg-black"
          style={{ opacity: loading ? 0 : 1 }}
          onError={() => { if (sourceUrl) setError("视频加载失败"); }}
        />
        {!loading && <p className="type-caption mt-2 text-gray-500 dark:text-gray-400">播放模式：{modeLabel}</p>}
        {sidecarStatus && <p className="type-caption mt-1 text-gray-500 dark:text-gray-400">音频：{sidecarStatus}</p>}
        {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
      </div>
    );
  }

  return (
    <div className={className}>
      {loading && (
        <div className="flex items-center justify-center h-12 text-gray-400 animate-pulse">
          原生 Range 加载中...
        </div>
      )}
      <audio
        ref={mediaRef as React.RefObject<HTMLAudioElement>}
        src={sourceUrl || undefined}
        crossOrigin="anonymous"
        preload="metadata"
        className="w-full"
        style={{ opacity: loading ? 0 : 1 }}
        onError={() => setError("音频加载失败")}
      />
      {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
    </div>
  );
}

// ─── Helpers ───

function decideSidecar(file: ShareFileDownload, mediaType: "video" | "audio"): {
  needsSidecar: boolean;
  debugData: Record<string, unknown>;
} {
  const metadata = file.media_metadata;
  const audioCodecs = (metadata?.audio_tracks || [])
    .map((track) => (track.codec || track.codec_tag || "").toLowerCase())
    .filter(Boolean);
  const hasBrowserFriendlyAudio = audioCodecs.some((codec) => /^(mp4a|aac|mp3|opus|vorbis|flac|alac)/.test(codec));
  const hasAc3Audio = audioCodecs.some((codec) => /^(ac-3|ec-3)$/.test(codec));
  let sidecarDecision = "native-muxed";
  let reason = "default-native";

  if (mediaType === "video" && metadata?.probe_status === "ok") {
    if (hasBrowserFriendlyAudio) {
      reason = "browser-friendly-audio-track";
    } else if (hasAc3Audio && !canNativePlayAc3()) {
      sidecarDecision = "native-video + wasm-ac3";
      reason = "ac3-without-native-support";
    } else if (hasAc3Audio) {
      reason = "native-ac3-supported";
    } else if (audioCodecs.length > 0) {
      reason = "unsupported-audio-no-sidecar";
    } else {
      reason = "no-audio-metadata";
    }
  } else if (metadata?.probe_status === "failed") {
    reason = "metadata-failed-native-fallback";
  }

  return {
    needsSidecar: sidecarDecision === "native-video + wasm-ac3",
    debugData: {
      metadataSource: metadata?.probe_source || null,
      probeStatus: metadata?.probe_status || null,
      moovOffset: metadata?.moov_offset ?? null,
      moovSize: metadata?.moov_size ?? null,
      isFastStart: metadata?.is_faststart ?? null,
      audioCodecs,
      sidecarDecision,
      reason,
    },
  };
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function describeBuffered(media: HTMLMediaElement): string {
  const ranges: string[] = [];
  for (let i = 0; i < media.buffered.length; i++) {
    ranges.push(`${media.buffered.start(i).toFixed(1)}-${media.buffered.end(i).toFixed(1)}`);
  }
  return ranges.join(",");
}

export { getMediaType };
