"use client";

import { useEffect, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
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

export function MediaPlayer({ file, className = "" }: MediaPlayerProps) {
  const mediaType = getMediaType(file.file_name);
  if (!mediaType) return null;

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
