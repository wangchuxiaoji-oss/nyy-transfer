"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { ShareFileDownload } from "@/lib/api";
import { createVirtualMediaFileId, registerVirtualMediaFile } from "@/lib/virtual-media";
import { canNativePlayAc3, decodeAc3Window } from "@/lib/ac3-sidecar";
import type { DebugLogFn } from "@/lib/debug";
import { PlayerChrome, type PlayerViewState } from "@/components/player-chrome";

const VIDEO_EXTS = ["mp4", "webm", "ogg", "mov"];
const AUDIO_EXTS = ["mp3", "aac", "ogg", "wav", "flac", "m4a"];

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
  const mediaType = getMediaType(file.file_name);
  if (!mediaType) return null;

  if (file.is_chunked && file.chunks?.length > 0) {
    return <NativeRangeChunkedMediaPlayer file={file} mediaType={mediaType} className={className} debugLog={debugLog} />;
  }

  return <NativeDirectMediaPlayer file={file} mediaType={mediaType} className={className} />;
}

function NativeDirectMediaPlayer({ file, mediaType, className = "" }: { file: ShareFileDownload; mediaType: "video" | "audio"; className?: string }) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null);
  const [error, setError] = useState("");
  const { view, actions } = useNativeMediaChrome({
    mediaRef,
    mediaType,
    title: file.file_name,
    modeLabel: mediaType === "video" ? "native-direct" : "native-audio",
    loading: false,
    error,
  });

  return (
    <div className={className}>
      <PlayerChrome view={view} actions={actions}>
        {mediaType === "video" ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={file.download_url}
            crossOrigin="anonymous"
            preload="metadata"
            playsInline
            className="block w-full bg-black"
            onError={() => setError("视频加载失败")}
          />
        ) : (
          <AudioSurface mediaRef={mediaRef as React.RefObject<HTMLAudioElement>} src={file.download_url} loading={false} onError={() => setError("音频加载失败")} />
        )}
      </PlayerChrome>
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
  const sidecarUiVolumeRef = useRef(1);
  const sidecarUiMutedRef = useRef(false);
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
    const windowSec = 24;
    setSidecarStatus(`解码 AC-3 音频窗口：${formatTime(startSec)} → ${formatTime(startSec + windowSec)}`);

    try {
      const decodeStartedAt = performance.now();
      const decoded = await decodeAc3Window(file, startSec, windowSec, abort.signal);
      if (abort.signal.aborted || !mediaRef.current) return;
      const windowDuration = decoded.totalSamples / decoded.sampleRate;
      const decodeMs = Math.round(performance.now() - decodeStartedAt);
      console.debug("[MediaPlayer] sidecar decoded", { startSec, duration: windowDuration, decodeMs });
      debugLog?.("sidecar", "decode:done", {
        startSec,
        duration: windowDuration,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
        decodeMs,
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
        audioGainRef.current.gain.value = sidecarUiMutedRef.current ? 0 : sidecarUiVolumeRef.current;
      }
      src.connect(audioGainRef.current);
      audioSourceRef.current = src;
      sidecarWindowRef.current = { start: startSec, end: startSec + windowDuration };
      src.onended = () => {
        if (audioSourceRef.current === src) audioSourceRef.current = null;
      };

      // Sync audio to where the video is NOW (it kept playing during decode).
      // If the video advanced past the start, offset into the decoded buffer.
      const videoNow = video.currentTime;
      const offsetSec = Math.max(0, videoNow - startSec);
      if (offsetSec >= windowDuration) {
        // Video already past this entire window; discard and let the next refresh handle it.
        console.debug("[MediaPlayer] sidecar skip (video past window)", { startSec, videoNow, windowDuration });
        debugLog?.("sidecar", "decode:skip", { startSec, videoNow, windowDuration });
        return;
      }
      src.start(0, offsetSec);
      console.debug("[MediaPlayer] sidecar playback started", { startSec, offsetSec, videoNow, windowDuration });
      debugLog?.("sidecar", "playback:start", { startSec, offsetSec, videoNow, windowDuration });
      setSidecarStatus(`AC-3 wasm 音频播放中：${formatTime(startSec)}`);

      const remainingSec = windowDuration - offsetSec;
      const refreshMs = Math.max(2000, (remainingSec - 2) * 1000);
      sidecarTimerRef.current = window.setTimeout(() => {
        if (!abort.signal.aborted) void startSidecarAudioWindow(true);
      }, refreshMs);
    } catch (err) {
      sidecarSeekingRef.current = false;
      console.warn("[MediaPlayer] sidecar error", err);
      debugLog?.("sidecar", "error", { error: err instanceof Error ? err.message : String(err), aborted: abort.signal.aborted });
      if (!abort.signal.aborted) {
        setSidecarStatus(err instanceof Error ? `AC-3 音频暂不可用：${err.message}` : "AC-3 音频暂不可用");
      }
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

  // Keep the native video muted while syncing UI volume/mute to sidecar WebAudio.
  useEffect(() => {
    if (!needsSidecarAc3) return;
    const el = mediaRef.current as HTMLVideoElement | null;
    if (!el) return;
    const syncGain = () => {
      const gain = audioGainRef.current;
      if (!gain) return;
      gain.gain.value = sidecarUiMutedRef.current ? 0 : sidecarUiVolumeRef.current;
      el.muted = true;
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

  const { view, actions } = useNativeMediaChrome({
    mediaRef,
    mediaType,
    title: file.file_name,
    modeLabel,
    loading,
    error,
    forcedNativeMuted: needsSidecarAc3,
    onUiVolumeChange: (nextVolume, nextMuted) => {
      sidecarUiVolumeRef.current = nextVolume;
      sidecarUiMutedRef.current = nextMuted;
      if (audioGainRef.current) {
        audioGainRef.current.gain.value = nextMuted ? 0 : nextVolume;
      }
    },
  });

  if (fallbackToMse) {
    return (
      <div className={className}>
        <p className="text-sm text-red-500">当前浏览器不支持此文件的在线播放，请下载后使用本地播放器观看。</p>
      </div>
    );
  }

  return (
    <div className={className}>
      <PlayerChrome view={view} actions={actions}>
        {mediaType === "video" ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={sourceUrl || undefined}
            crossOrigin="anonymous"
            preload="metadata"
            playsInline
            className="block w-full bg-black"
            style={{ opacity: loading ? 0 : 1 }}
            onError={() => { if (sourceUrl) setError("视频加载失败"); }}
          />
        ) : (
          <AudioSurface
            mediaRef={mediaRef as React.RefObject<HTMLAudioElement>}
            src={sourceUrl || undefined}
            loading={loading}
            onError={() => setError("音频加载失败")}
          />
        )}
      </PlayerChrome>
      {!loading && <p className="type-caption mt-2 text-gray-500 dark:text-gray-400">播放模式：{modeLabel}</p>}
      {sidecarStatus && <p className="type-caption mt-1 text-gray-500 dark:text-gray-400">音频：{sidecarStatus}</p>}
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

function useNativeMediaChrome({
  mediaRef,
  mediaType,
  title,
  modeLabel,
  loading,
  error,
  forcedNativeMuted = false,
  onUiVolumeChange,
}: {
  mediaRef: React.RefObject<HTMLVideoElement | HTMLAudioElement>;
  mediaType: "video" | "audio";
  title: string;
  modeLabel: string;
  loading: boolean;
  error: string;
  forcedNativeMuted?: boolean;
  onUiVolumeChange?: (volume: number, muted: boolean) => void;
}) {
  const [state, setState] = useState<PlayerViewState["state"]>(loading ? "loading" : "idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [uiMuted, setUiMuted] = useState(false);
  const [uiVolume, setUiVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;

    const syncFromMedia = () => {
      setCurrentTime(media.currentTime || 0);
      setDuration(Number.isFinite(media.duration) ? media.duration : 0);
      if (!forcedNativeMuted) {
        setIsMuted(media.muted);
        setVolume(media.volume);
      }
      setPlaybackRate(media.playbackRate || 1);
    };

    const updateState = () => {
      if (media.ended) setState("ended");
      else if (media.paused) setState(loading ? "loading" : "paused");
      else setState("playing");
      syncFromMedia();
    };

    const onLoadedMetadata = () => {
      setDuration(Number.isFinite(media.duration) ? media.duration : 0);
      syncFromMedia();
      if (!loading) setState(media.paused ? "ready" : "playing");
    };

    const onError = () => setState("error");
    const onPlay = () => updateState();
    const onPause = () => updateState();
    const onSeeking = () => setState("seeking");
    const onSeeked = () => updateState();
    const onTimeUpdate = () => setCurrentTime(media.currentTime || 0);
    const onVolumeChange = () => syncFromMedia();
    const onRateChange = () => setPlaybackRate(media.playbackRate || 1);
    const onWaiting = () => setState("loading");
    const onCanPlay = () => {
      syncFromMedia();
      if (media.paused) setState("ready");
    };

    media.addEventListener("loadedmetadata", onLoadedMetadata);
    media.addEventListener("error", onError);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("seeking", onSeeking);
    media.addEventListener("seeked", onSeeked);
    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("volumechange", onVolumeChange);
    media.addEventListener("ratechange", onRateChange);
    media.addEventListener("waiting", onWaiting);
    media.addEventListener("canplay", onCanPlay);

    if (forcedNativeMuted) media.muted = true;
    syncFromMedia();
    setState(loading ? "loading" : media.paused ? "ready" : "playing");

    return () => {
      media.removeEventListener("loadedmetadata", onLoadedMetadata);
      media.removeEventListener("error", onError);
      media.removeEventListener("play", onPlay);
      media.removeEventListener("pause", onPause);
      media.removeEventListener("seeking", onSeeking);
      media.removeEventListener("seeked", onSeeked);
      media.removeEventListener("timeupdate", onTimeUpdate);
      media.removeEventListener("volumechange", onVolumeChange);
      media.removeEventListener("ratechange", onRateChange);
      media.removeEventListener("waiting", onWaiting);
      media.removeEventListener("canplay", onCanPlay);
    };
  }, [forcedNativeMuted, loading, mediaRef]);

  const view: PlayerViewState = {
    state: error ? "error" : state,
    currentTime,
    duration,
    buffering: null,
    error,
    title,
    modeLabel,
    isMuted: forcedNativeMuted ? uiMuted : isMuted,
    volume: forcedNativeMuted ? uiVolume : volume,
    playbackRate,
    canSeek: duration > 0 && state !== "loading" && state !== "idle" && state !== "error",
    canFullscreen: mediaType === "video",
    canPictureInPicture: mediaType === "video",
    canVolume: true,
    canSpeed: true,
    canSubtitles: false,
    canQuality: false,
    unsupportedReasons: {
      subtitles: "当前未接入字幕轨",
      quality: "当前播放源为单轨，不支持手动切画质",
      pip: mediaType !== "video" ? "音频不支持画中画" : undefined,
      fullscreen: mediaType !== "video" ? "音频不支持全屏" : undefined,
    },
  };

  const actions = {
    play: () => {
      void mediaRef.current?.play();
    },
    pause: () => mediaRef.current?.pause(),
    seek: (seconds: number) => {
      const media = mediaRef.current;
      if (!media) return;
      media.currentTime = Math.max(0, seconds);
    },
    setVolume: (nextVolume: number) => {
      const media = mediaRef.current;
      if (!media) return;
      const safeVolume = Math.max(0, Math.min(1, nextVolume));
      media.volume = safeVolume;
      if (forcedNativeMuted) {
        media.muted = true;
        setUiVolume(safeVolume);
        onUiVolumeChange?.(safeVolume, uiMuted);
      }
    },
    setMuted: (nextMuted: boolean) => {
      const media = mediaRef.current;
      if (!media) return;
      if (forcedNativeMuted) {
        media.muted = true;
        setUiMuted(nextMuted);
        onUiVolumeChange?.(uiVolume, nextMuted);
        return;
      }
      media.muted = nextMuted;
    },
    setPlaybackRate: (nextRate: number) => {
      const media = mediaRef.current;
      if (!media) return;
      media.playbackRate = nextRate;
    },
    enterFullscreen: async () => {
      const media = mediaRef.current;
      const host = media?.parentElement;
      if (!host?.requestFullscreen) return;
      await host.requestFullscreen();
    },
    togglePictureInPicture: async () => {
      const media = mediaRef.current as HTMLVideoElement | null;
      if (!media || mediaType !== "video") return;
      if (document.pictureInPictureElement === media) {
        await document.exitPictureInPicture();
      } else if (media.requestPictureInPicture) {
        await media.requestPictureInPicture();
      }
    },
  };

  return { view, actions };
}

function AudioSurface({
  mediaRef,
  src,
  loading,
  onError,
}: {
  mediaRef: React.RefObject<HTMLAudioElement>;
  src?: string;
  loading: boolean;
  onError: () => void;
}) {
  return (
    <div className="flex min-h-48 items-center justify-center bg-gradient-to-br from-black via-neutral-950 to-neutral-800 text-white/70">
      <div className="text-center">
        <div className="text-4xl">♪</div>
        <div className="mt-2 text-xs uppercase tracking-[0.3em] text-white/40">audio</div>
      </div>
      <audio
        ref={mediaRef}
        src={src}
        crossOrigin="anonymous"
        preload="metadata"
        className="hidden"
        style={{ opacity: loading ? 0 : 1 }}
        onError={onError}
      />
    </div>
  );
}

export { getMediaType };
