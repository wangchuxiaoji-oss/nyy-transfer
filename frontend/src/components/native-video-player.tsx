"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Maximize2, Pause, Play, Volume2, VolumeX } from "lucide-react";

interface NativeVideoPlayerProps {
  src: string;
  type: string;
  fileName: string;
  onError: () => void;
  onDownload: () => void;
}

type WebkitVideoElement = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

export function NativeVideoPlayer({ src, type, fileName, onError, onDownload }: NativeVideoPlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [scrubValue, setScrubValue] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);

  useEffect(() => {
    setIsPlaying(false);
    setIsWaiting(false);
    setCurrentTime(0);
    setDuration(0);
    setBufferedPct(0);
    setIsMuted(false);
    setVolumeState(1);
    setScrubValue(0);
    setIsScrubbing(false);
  }, [src]);

  const syncBuffered = () => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || video.buffered.length === 0) {
      setBufferedPct(0);
      return;
    }
    const bufferedEnd = video.buffered.end(video.buffered.length - 1);
    setBufferedPct(Math.max(0, Math.min(100, (bufferedEnd / video.duration) * 100)));
  };

  const syncMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setCurrentTime(video.currentTime || 0);
    setIsMuted(video.muted);
    setVolumeState(video.volume);
    syncBuffered();
  };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      await video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  };

  const commitSeek = () => {
    const video = videoRef.current;
    setIsScrubbing(false);
    if (!video || !Number.isFinite(duration) || duration <= 0) return;
    video.currentTime = scrubValue;
    setCurrentTime(scrubValue);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const setVolume = (nextVolume: number) => {
    const video = videoRef.current;
    const safeVolume = Math.max(0, Math.min(1, nextVolume));
    setVolumeState(safeVolume);
    if (!video) return;
    video.volume = safeVolume;
    video.muted = safeVolume === 0;
    setIsMuted(video.muted);
  };

  const enterFullscreen = async () => {
    const root = rootRef.current;
    const video = videoRef.current as WebkitVideoElement | null;
    if (root?.requestFullscreen) {
      await root.requestFullscreen().catch(() => undefined);
      return;
    }
    video?.webkitEnterFullscreen?.();
  };

  const sliderTime = isScrubbing ? scrubValue : currentTime;
  const playable = duration > 0 && Number.isFinite(duration);
  const progressPct = playable ? Math.max(0, Math.min(100, (sliderTime / duration) * 100)) : 0;
  const rangeBackground = `linear-gradient(90deg, #FF8A3D 0%, #FF8A3D ${progressPct}%, rgba(255,255,255,0.34) ${progressPct}%, rgba(255,255,255,0.34) ${Math.max(progressPct, bufferedPct)}%, rgba(255,255,255,0.14) ${Math.max(progressPct, bufferedPct)}%, rgba(255,255,255,0.14) 100%)`;

  return (
    <div ref={rootRef} data-testid="native-video-preview" className="group absolute inset-0 overflow-hidden bg-black text-white">
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="metadata"
        onLoadedMetadata={syncMetadata}
        onDurationChange={syncMetadata}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (!video || isScrubbing) return;
          setCurrentTime(video.currentTime || 0);
        }}
        onProgress={syncBuffered}
        onPlay={() => { setIsPlaying(true); setIsWaiting(false); }}
        onPause={() => setIsPlaying(false)}
        onEnded={() => setIsPlaying(false)}
        onWaiting={() => setIsWaiting(true)}
        onPlaying={() => { setIsWaiting(false); setIsPlaying(true); }}
        onCanPlay={() => setIsWaiting(false)}
        onVolumeChange={() => {
          const video = videoRef.current;
          if (!video) return;
          setIsMuted(video.muted);
          setVolumeState(video.volume);
        }}
        onError={onError}
        className="absolute inset-0 h-full w-full bg-black object-contain"
      >
        <source src={src} type={type} />
      </video>

      <button
        type="button"
        onClick={() => void togglePlay()}
        aria-label={isPlaying ? "暂停" : "播放"}
        className={`absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-200 ${isPlaying ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}
      >
        <span className="flex h-16 w-16 items-center justify-center rounded-full border border-white/35 bg-[#FF8A3D] text-white shadow-[0_0_34px_rgba(255,138,61,0.55),0_16px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-transform hover:scale-105">
          {isPlaying ? <Pause className="h-8 w-8 fill-current stroke-[1.5]" /> : <Play className="ml-1 h-8 w-8 fill-current stroke-[1.5]" />}
        </span>
      </button>

      {isWaiting && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/20 text-xs text-white/80">
          <span className="rounded-full border border-white/15 bg-black/45 px-3 py-1.5 font-tech tracking-[0.12em] backdrop-blur-xl">缓冲中</span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-3 pt-12 opacity-100 transition-opacity duration-200 sm:opacity-85 sm:group-hover:opacity-100">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="min-w-0 truncate font-tech text-[10px] tracking-[0.12em] text-white/65">原生预览 · {fileName}</p>
          <button type="button" onClick={onDownload} className="hidden items-center gap-1.5 rounded-full border border-white/15 bg-white/8 px-2.5 py-1 text-[10px] text-white/70 transition hover:border-[#FF8A3D]/80 hover:text-[#FF8A3D] sm:flex" aria-label="下载此文件">
            <Download className="h-3.5 w-3.5" /> 下载
          </button>
        </div>

        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={Number.isFinite(sliderTime) ? sliderTime : 0}
          disabled={!playable}
          aria-label="播放进度"
          onMouseDown={() => { setIsScrubbing(true); setScrubValue(currentTime); }}
          onTouchStart={() => { setIsScrubbing(true); setScrubValue(currentTime); }}
          onChange={(event) => setScrubValue(Number(event.target.value))}
          onMouseUp={commitSeek}
          onTouchEnd={commitSeek}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[#FF8A3D] disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(255,138,61,0.35)]"
          style={{ background: rangeBackground }}
        />

        <div className="mt-2 flex items-center gap-2">
          <button type="button" onClick={() => void togglePlay()} className={controlButtonClass} aria-label={isPlaying ? "暂停" : "播放"}>
            {isPlaying ? <Pause className="h-4 w-4 fill-current stroke-[1.5]" /> : <Play className="ml-0.5 h-4 w-4 fill-current stroke-[1.5]" />}
          </button>
          <span className="min-w-[5.8rem] font-tech text-[11px] tabular-nums text-white/78">{formatVideoTime(sliderTime)} / {formatVideoTime(duration)}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <button type="button" onClick={toggleMute} className={controlButtonClass} aria-label={isMuted ? "取消静音" : "静音"}>
              {isMuted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={(event) => setVolume(Number(event.target.value))}
              className="hidden h-1 w-16 cursor-pointer appearance-none rounded-full bg-white/18 accent-[#FF8A3D] sm:block"
              aria-label="音量"
            />
            <button type="button" onClick={() => void enterFullscreen()} className={controlButtonClass} aria-label="全屏">
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const controlButtonClass = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/8 text-white/86 backdrop-blur-xl transition hover:border-[#FF8A3D]/70 hover:bg-[#FF8A3D]/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF8A3D]";

function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
