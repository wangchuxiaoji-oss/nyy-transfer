"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayerActions, PlayerCapabilities, PlayerViewState, UnifiedPlayerState } from "./player-types";
import { makeCapabilities } from "./player-types";

const VOLUME_STORAGE_KEY = "nyy-native-video-volume";
const MUTED_STORAGE_KEY = "nyy-native-video-muted";

interface NativeAdapterOptions {
  src: string;
  type: string;
  onError: (message: string, info: NativeVideoErrorInfo) => void;
  onLoadedMetadata?: () => void;
}

export interface NativeVideoErrorInfo {
  code: number | null;
  currentTime: number;
  paused: boolean;
  playRequested: boolean;
  src: string;
}

export function useNativePlayerAdapter(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  options: NativeAdapterOptions,
) {
  const { src, onError, onLoadedMetadata } = options;
  const [state, setState] = useState<UnifiedPlayerState>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [isWaiting, setIsWaiting] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const notifiedMetadataSrcRef = useRef("");
  const playRequestedRef = useRef(false);

  // 加载持久化的音量/静音
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
      if (Number.isFinite(saved) && saved >= 0 && saved <= 1) setVolumeState(saved);
      setIsMuted(localStorage.getItem(MUTED_STORAGE_KEY) === "true");
    } catch {}
  }, []);

  // src 变化时重置
  useEffect(() => {
    setState("idle");
    setIsWaiting(false);
    setCurrentTime(0);
    setDuration(0);
    setBufferedPct(0);
    notifiedMetadataSrcRef.current = "";
  }, [src]);

  // 应用音量到 <video>
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = isMuted;
  }, [src, volume, isMuted, videoRef]);

  const persistVolume = useCallback((vol: number, muted: boolean) => {
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(vol));
      localStorage.setItem(MUTED_STORAGE_KEY, String(muted));
    } catch {}
  }, []);

  const syncBuffered = useCallback(() => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || video.buffered.length === 0) {
      setBufferedPct(0);
      return;
    }
    const end = video.buffered.end(video.buffered.length - 1);
    setBufferedPct(Math.max(0, Math.min(100, (end / video.duration) * 100)));
  }, [videoRef]);

  // 视频事件绑定
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoaded = () => {
      if (!video.error) setState(video.paused ? "ready" : "playing");
      setDuration(Number.isFinite(video.duration) ? video.duration : 0);
      setCurrentTime(video.currentTime || 0);
      setPlaybackRate(video.playbackRate || 1);
      syncBuffered();
      if (notifiedMetadataSrcRef.current !== src) {
        notifiedMetadataSrcRef.current = src;
        onLoadedMetadata?.();
      }
    };

    const onTimeUpdate = () => setCurrentTime(video.currentTime || 0);
    const onProgress = () => syncBuffered();
    const onPlay = () => { setState("playing"); setIsWaiting(false); };
    const onPause = () => { playRequestedRef.current = false; setState(video.ended ? "ended" : "paused"); setIsWaiting(false); };
    const onEnded = () => { setState("ended"); setIsWaiting(false); };
    const onWaiting = () => setIsWaiting(true);
    const onPlaying = () => { playRequestedRef.current = false; setIsWaiting(false); setState("playing"); };
    const onCanPlay = () => { setIsWaiting(false); if (video.paused) setState("ready"); };
    const onRateChange = () => setPlaybackRate(video.playbackRate || 1);
    const onVolumeChange = () => {
      setIsMuted(video.muted);
      setVolumeState(video.volume);
      persistVolume(video.volume, video.muted);
    };
    const onVideoError = () => {
      const err = video.error;
      const playRequested = playRequestedRef.current || !video.paused;
      playRequestedRef.current = false;
      onError(getVideoErrorMessage(err), {
        code: err?.code ?? null,
        currentTime: video.currentTime || 0,
        paused: video.paused,
        playRequested,
        src,
      });
      setState("error");
    };

    video.addEventListener("loadedmetadata", onLoaded);
    video.addEventListener("durationchange", onLoaded);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("progress", onProgress);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("canplay", onCanPlay);
    video.addEventListener("ratechange", onRateChange);
    video.addEventListener("volumechange", onVolumeChange);
    video.addEventListener("error", onVideoError);

    if (video.error) onVideoError();
    else if (video.readyState >= HTMLMediaElement.HAVE_METADATA) onLoaded();
    else syncBuffered();

    return () => {
      video.removeEventListener("loadedmetadata", onLoaded);
      video.removeEventListener("durationchange", onLoaded);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("ratechange", onRateChange);
      video.removeEventListener("volumechange", onVolumeChange);
      video.removeEventListener("error", onVideoError);
    };
  }, [onError, onLoadedMetadata, persistVolume, src, syncBuffered, videoRef]);

  const capabilities: PlayerCapabilities = makeCapabilities({
    pictureInPicture: { enabled: true },
    speed: { enabled: true },
    subtitles: { enabled: false, reason: "当前未接入字幕轨" },
    quality: { enabled: false, reason: "当前播放源为单轨，不支持手动切画质" },
  });

  const viewState: PlayerViewState = {
    state,
    currentTime,
    duration,
    bufferedPct,
    buffering: isWaiting ? { reason: "stall", progressPct: null, speedBytesPerSec: null, message: "缓冲中..." } : null,
    error: "",
    title: undefined,
    modeLabel: undefined,
    isMuted,
    volume,
    playbackRate,
    capabilities,
  };

  const actions: PlayerActions = {
    play: async () => {
      const video = videoRef.current;
      if (!video) return;
      playRequestedRef.current = true;
      setState("loading");
      setIsWaiting(true);
      await video.play().then(() => {
        if (!video.paused) {
          setState("playing");
          setIsWaiting(false);
        }
      }).catch(() => {
        if (video.error) return;
        playRequestedRef.current = false;
        setIsWaiting(false);
        setState(video.readyState >= HTMLMediaElement.HAVE_METADATA ? "ready" : "idle");
      });
    },
    pause: () => {
      videoRef.current?.pause();
    },
    seek: (seconds) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = Math.max(0, seconds);
    },
    seekBy: (delta) => {
      const video = videoRef.current;
      if (!video) return;
      const safe = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
      video.currentTime = Math.max(0, Math.min(safe, (video.currentTime || 0) + delta));
    },
    setVolume: (next) => {
      const safe = Math.max(0, Math.min(1, next));
      setVolumeState(safe);
      const muted = safe === 0;
      setIsMuted(muted);
      persistVolume(safe, muted);
      const video = videoRef.current;
      if (!video) return;
      video.volume = safe;
      video.muted = muted;
    },
    setMuted: (muted) => {
      const video = videoRef.current;
      if (!video) return;
      video.muted = muted;
      setIsMuted(muted);
      persistVolume(video.volume || volume, muted);
    },
    setPlaybackRate: (rate) => {
      const safeRate = Math.max(0.25, Math.min(4, rate));
      setPlaybackRate(safeRate);
      const video = videoRef.current;
      if (!video) return;
      video.playbackRate = safeRate;
    },
    enterFullscreen: async (root) => {
      const video = videoRef.current;
      if (root.requestFullscreen) {
        await root.requestFullscreen().catch(() => {});
        return;
      }
      // iOS fallback
      (video as HTMLVideoElement & { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.();
    },
    exitFullscreen: async () => {
      await document.exitFullscreen?.().catch(() => {});
    },
    togglePictureInPicture: async () => {
      const video = videoRef.current;
      if (!video || !video.requestPictureInPicture) return;
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture?.().catch(() => {});
        return;
      }
      await video.requestPictureInPicture().catch(() => {});
    },
  };

  return { viewState, actions };
}

function getVideoErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "视频加载已取消，请重新播放。";
    case MediaError.MEDIA_ERR_NETWORK:
      return "视频网络加载失败，请刷新页面或重新获取下载链接。";
    case MediaError.MEDIA_ERR_DECODE:
      return "浏览器解码失败，可能是不支持当前视频编码。";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "浏览器不支持此视频格式或下载链接不可用。";
    default:
      return "视频无法播放，请下载后本地查看。";
  }
}
