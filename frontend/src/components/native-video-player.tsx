"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Maximize2, Minimize2, Pause, Play, Volume2, VolumeX } from "lucide-react";

interface NativeVideoPlayerProps {
  src: string;
  type: string;
  onError: (message: string) => void;
  onLoadedMetadata?: () => void;
}

type WebkitVideoElement = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
};

type SliderStyle = CSSProperties & {
  "--nyy-thumb-opacity": string;
};

const FULLSCREEN_IDLE_HIDE_MS = 3000;
const SEEK_STEP_SECONDS = 5;
const SINGLE_CLICK_DELAY_MS = 180;
const DOUBLE_TAP_DELAY_MS = 280;
const VOLUME_STORAGE_KEY = "nyy-native-video-volume";
const MUTED_STORAGE_KEY = "nyy-native-video-muted";

export function NativeVideoPlayer({ src, type, onError, onLoadedMetadata }: NativeVideoPlayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const progressRef = useRef<HTMLInputElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const tapTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ at: number; x: number } | null>(null);
  const ignoreNextClickRef = useRef(false);
  const isPlayingRef = useRef(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolumeState] = useState(1);
  const [scrubValue, setScrubValue] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [isPointerInside, setIsPointerInside] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenChromeVisible, setFullscreenChromeVisible] = useState(true);
  const [touchChromeVisible, setTouchChromeVisible] = useState(true);
  const [progressHover, setProgressHover] = useState(false);
  const [hoverTime, setHoverTime] = useState(0);
  const [hoverPct, setHoverPct] = useState(0);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    try {
      const savedVolume = Number(localStorage.getItem(VOLUME_STORAGE_KEY));
      if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) {
        setVolumeState(savedVolume);
      }
      setIsMuted(localStorage.getItem(MUTED_STORAGE_KEY) === "true");
    } catch {}
  }, []);

  useEffect(() => {
    setIsPlaying(false);
    setIsWaiting(false);
    setCurrentTime(0);
    setDuration(0);
    setBufferedPct(0);
    setScrubValue(0);
    setIsScrubbing(false);
    setProgressHover(false);
    setHoverTime(0);
    setHoverPct(0);
    setTouchChromeVisible(true);
    setFullscreenChromeVisible(true);
  }, [src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = isMuted;
  }, [src, volume, isMuted]);

  useEffect(() => {
    const syncFullscreen = () => {
      const root = rootRef.current;
      const nextFullscreen = Boolean(root && document.fullscreenElement === root);
      setIsFullscreen(nextFullscreen);
      setFullscreenChromeVisible(true);
    };
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleFullscreenHide = useCallback(() => {
    clearHideTimer();
    if (!isFullscreen || !isPlayingRef.current || isScrubbing) return;
    hideTimerRef.current = window.setTimeout(() => {
      setFullscreenChromeVisible(false);
    }, FULLSCREEN_IDLE_HIDE_MS);
  }, [clearHideTimer, isFullscreen, isScrubbing]);

  const revealFullscreenChrome = useCallback(() => {
    setFullscreenChromeVisible(true);
    scheduleFullscreenHide();
  }, [scheduleFullscreenHide]);

  useEffect(() => {
    if (!isPlaying || isScrubbing) {
      clearHideTimer();
      setFullscreenChromeVisible(true);
      setTouchChromeVisible(true);
      return;
    }
    scheduleFullscreenHide();
    return clearHideTimer;
  }, [clearHideTimer, isPlaying, isScrubbing, scheduleFullscreenHide]);

  const persistVolumeState = (nextVolume: number, nextMuted: boolean) => {
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, String(nextVolume));
      localStorage.setItem(MUTED_STORAGE_KEY, String(nextMuted));
    } catch {}
  };

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
    onLoadedMetadata?.();
  };

  const togglePlay = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) {
      await video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, []);

  const seekBy = useCallback((deltaSeconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    const safeDuration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : duration;
    const nextTime = Math.max(0, Math.min(safeDuration || 0, (video.currentTime || 0) + deltaSeconds));
    video.currentTime = nextTime;
    setCurrentTime(nextTime);
    setScrubValue(nextTime);
  }, [duration]);

  const commitSeek = () => {
    const video = videoRef.current;
    setIsScrubbing(false);
    if (!video || !Number.isFinite(duration) || duration <= 0) return;
    video.currentTime = scrubValue;
    setCurrentTime(scrubValue);
    revealFullscreenChrome();
  };

  const toggleMute = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !video.muted;
    video.muted = nextMuted;
    setIsMuted(nextMuted);
    persistVolumeState(video.volume, nextMuted);
    revealFullscreenChrome();
  }, [revealFullscreenChrome]);

  const setVolume = (nextVolume: number) => {
    const video = videoRef.current;
    const safeVolume = Math.max(0, Math.min(1, nextVolume));
    const nextMuted = safeVolume === 0;
    setVolumeState(safeVolume);
    setIsMuted(nextMuted);
    persistVolumeState(safeVolume, nextMuted);
    revealFullscreenChrome();
    if (!video) return;
    video.volume = safeVolume;
    video.muted = nextMuted;
  };

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    const video = videoRef.current as WebkitVideoElement | null;
    if (document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => undefined);
      return;
    }
    if (root?.requestFullscreen) {
      await root.requestFullscreen().catch(() => undefined);
      root.focus({ preventScroll: true });
      return;
    }
    video?.webkitEnterFullscreen?.();
  }, []);

  const handleVideoError = () => {
    onError(getVideoErrorMessage(videoRef.current?.error ?? null));
  };

  const handleActivity = useCallback(() => {
    if (isFullscreen) revealFullscreenChrome();
  }, [isFullscreen, revealFullscreenChrome]);

  const handleProgressPointer = (event: ReactPointerEvent<HTMLInputElement>) => {
    if (!Number.isFinite(duration) || duration <= 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
    setHoverPct(pct * 100);
    setHoverTime(pct * duration);
    handleActivity();
  };

  const handleKeyboardShortcut = useCallback((event: KeyboardEvent) => {
    const target = event.target;
    // 文本输入框内不抢按键
    if (isTextInputTarget(target)) return;
    const onSlider = isRangeTarget(target);
    const key = event.key.toLowerCase();
    if (key === " " || key === "spacebar") {
      event.preventDefault();
      void togglePlay();
    } else if (key === "arrowleft") {
      // 焦点在滑块上时保留原生方向键行为（进度/音量微调）
      if (onSlider) return;
      event.preventDefault();
      seekBy(-SEEK_STEP_SECONDS);
    } else if (key === "arrowright") {
      if (onSlider) return;
      event.preventDefault();
      seekBy(SEEK_STEP_SECONDS);
    } else if (key === "f") {
      event.preventDefault();
      void toggleFullscreen();
    } else if (key === "m") {
      event.preventDefault();
      toggleMute();
    } else {
      return;
    }
    handleActivity();
  }, [handleActivity, seekBy, toggleFullscreen, toggleMute, togglePlay]);

  useEffect(() => {
    // 仅注册一个全局监听器，避免与 root 的 React onKeyDown 重复触发（重复会让空格 play→pause 互相抵消）
    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const active = document.activeElement;
      const withinPlayer =
        document.fullscreenElement === root || root === active || root.contains(active);
      if (!withinPlayer) return;
      handleKeyboardShortcut(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleKeyboardShortcut]);

  const handleStageClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (ignoreNextClickRef.current || isControlTarget(event.target) || event.detail > 1) return;
    rootRef.current?.focus({ preventScroll: true });
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      void togglePlay();
    }, SINGLE_CLICK_DELAY_MS);
  };

  const handleStageDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (isControlTarget(event.target)) return;
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    void toggleFullscreen();
  };

  const handleStagePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || isControlTarget(event.target)) return;
    ignoreNextClickRef.current = true;
    window.setTimeout(() => { ignoreNextClickRef.current = false; }, 320);
    rootRef.current?.focus({ preventScroll: true });
    revealFullscreenChrome();
    const now = Date.now();
    const previous = lastTapRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const isDoubleTap = previous && now - previous.at <= DOUBLE_TAP_DELAY_MS && Math.abs(previous.x - event.clientX) < 80;
    if (isDoubleTap) {
      if (tapTimerRef.current !== null) {
        window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      lastTapRef.current = null;
      seekBy(event.clientX < rect.left + rect.width / 2 ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS);
      setTouchChromeVisible(true);
      return;
    }

    lastTapRef.current = { at: now, x: event.clientX };
    if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
    tapTimerRef.current = window.setTimeout(() => {
      tapTimerRef.current = null;
      if (isPlayingRef.current) setTouchChromeVisible((visible) => !visible);
      else setTouchChromeVisible(true);
    }, DOUBLE_TAP_DELAY_MS);
  };

  useEffect(() => () => {
    clearHideTimer();
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
  }, [clearHideTimer]);

  const sliderTime = isScrubbing ? scrubValue : currentTime;
  const playable = duration > 0 && Number.isFinite(duration);
  const progressPct = playable ? Math.max(0, Math.min(100, (sliderTime / duration) * 100)) : 0;
  const bufferEndPct = Math.max(progressPct, bufferedPct);
  const rangeBackground = `linear-gradient(90deg, #FF8A3D 0%, #FF8A3D ${progressPct}%, rgba(255,255,255,0.34) ${progressPct}%, rgba(255,255,255,0.34) ${bufferEndPct}%, rgba(255,255,255,0.14) ${bufferEndPct}%, rgba(255,255,255,0.14) 100%)`;
  const fullscreenChromeHidden = isFullscreen && isPlaying && !fullscreenChromeVisible && !isScrubbing;
  const touchChromeHidden = !isFullscreen && isPlaying && !touchChromeVisible && !isScrubbing;
  const chromeHidden = fullscreenChromeHidden || touchChromeHidden;
  const thumbVisible = isScrubbing || progressHover || (isPointerInside && !chromeHidden);
  const bubbleVisible = playable && (progressHover || isScrubbing) && !chromeHidden;
  const bubblePct = isScrubbing ? progressPct : hoverPct;
  const bubbleTime = isScrubbing ? scrubValue : hoverTime;
  const sliderStyle: SliderStyle = {
    background: rangeBackground,
    "--nyy-thumb-opacity": thumbVisible ? "1" : "0",
  };

  return (
    <div
      ref={rootRef}
      data-testid="native-video-preview"
      tabIndex={0}
      onClick={handleStageClick}
      onDoubleClick={handleStageDoubleClick}
      onPointerUp={handleStagePointerUp}
      onPointerMove={handleActivity}
      onMouseEnter={() => { setIsPointerInside(true); handleActivity(); }}
      onMouseLeave={() => { setIsPointerInside(false); setProgressHover(false); }}
      className={`group absolute inset-0 overflow-hidden bg-black text-white outline-none ${fullscreenChromeHidden ? "cursor-none" : "cursor-default"}`}
    >
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
        onPlay={() => { setIsPlaying(true); setIsWaiting(false); setTouchChromeVisible(true); }}
        onPause={() => { setIsPlaying(false); setTouchChromeVisible(true); }}
        onEnded={() => { setIsPlaying(false); setTouchChromeVisible(true); }}
        onWaiting={() => setIsWaiting(true)}
        onPlaying={() => { setIsWaiting(false); setIsPlaying(true); }}
        onCanPlay={() => setIsWaiting(false)}
        onVolumeChange={() => {
          const video = videoRef.current;
          if (!video) return;
          setIsMuted(video.muted);
          setVolumeState(video.volume);
          persistVolumeState(video.volume, video.muted);
        }}
        onError={handleVideoError}
        className="absolute inset-0 h-full w-full bg-black object-contain"
      >
        <source src={src} type={type} />
      </video>

      {!isPlaying && (
        <button
          type="button"
          data-video-control
          data-testid="native-video-center-toggle"
          onClick={(event) => { event.stopPropagation(); void togglePlay(); }}
          aria-label="播放"
          className="absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-200"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-white/35 bg-[#FF8A3D] text-white shadow-[0_0_34px_rgba(255,138,61,0.55),0_16px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-transform hover:scale-105">
            <Play className="ml-1 h-8 w-8 fill-current stroke-[1.5]" />
          </span>
        </button>
      )}

      {isWaiting && (
        <div data-testid="native-video-buffering" className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <span className="relative flex items-center justify-center">
            <span className="absolute h-9 w-9 animate-ping rounded-full bg-[#FF8A3D]/45" />
            <span className="absolute h-6 w-6 animate-ping rounded-full bg-[#FFB169]/55 [animation-delay:160ms]" />
            <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-[#FFA24D] shadow-[0_0_16px_rgba(255,138,61,0.95),0_0_36px_rgba(255,162,77,0.65)]" />
          </span>
        </div>
      )}

      <div
        data-video-control
        data-testid="native-video-controls"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-3 pt-12 transition-opacity duration-300 ${chromeHidden ? "pointer-events-none opacity-0" : "opacity-100 sm:opacity-85 sm:group-hover:opacity-100"}`}
      >
        <div className="relative mb-2 pt-5">
          {bubbleVisible && (
            <span
              aria-hidden="true"
              data-testid="native-video-progress-bubble"
              className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border border-white/12 bg-black/80 px-2 py-1 font-tech text-[10px] tabular-nums text-white/86 shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-xl"
              style={{ left: `${bubblePct}%` }}
            >
              {formatVideoTime(bubbleTime)}
            </span>
          )}
          <input
            ref={progressRef}
            data-testid="native-video-progress"
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={Number.isFinite(sliderTime) ? sliderTime : 0}
            disabled={!playable}
            aria-label="播放进度"
            onPointerEnter={(event) => { setProgressHover(true); handleProgressPointer(event); }}
            onPointerMove={handleProgressPointer}
            onPointerLeave={() => setProgressHover(false)}
            onMouseDown={() => { setIsScrubbing(true); setScrubValue(currentTime); setProgressHover(true); revealFullscreenChrome(); }}
            onTouchStart={() => { setIsScrubbing(true); setScrubValue(currentTime); setProgressHover(true); revealFullscreenChrome(); }}
            onChange={(event) => {
              const next = Number(event.target.value);
              setScrubValue(next);
              if (playable) {
                setHoverPct((next / duration) * 100);
                setHoverTime(next);
              }
            }}
            onMouseUp={commitSeek}
            onTouchEnd={commitSeek}
            className="native-video-player__range h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[#FF8A3D] disabled:cursor-not-allowed disabled:opacity-50"
            style={sliderStyle}
          />
        </div>

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
            <button type="button" onClick={() => void toggleFullscreen()} className={controlButtonClass} aria-label={isFullscreen ? "退出全屏" : "全屏"}>
              {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .native-video-player__range::-webkit-slider-thumb {
          height: 0.875rem;
          width: 0.875rem;
          appearance: none;
          border-radius: 9999px;
          background: #fff;
          box-shadow: 0 0 0 3px rgba(255, 138, 61, 0.35);
          opacity: var(--nyy-thumb-opacity, 0);
          transition: opacity 180ms ease;
        }
        .native-video-player__range::-moz-range-thumb {
          height: 0.875rem;
          width: 0.875rem;
          border: 0;
          border-radius: 9999px;
          background: #fff;
          box-shadow: 0 0 0 3px rgba(255, 138, 61, 0.35);
          opacity: var(--nyy-thumb-opacity, 0);
          transition: opacity 180ms ease;
        }
      `}</style>
    </div>
  );
}

const controlButtonClass = "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/8 text-white/86 backdrop-blur-xl transition hover:border-[#FF8A3D]/70 hover:bg-[#FF8A3D]/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF8A3D]";

function isControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-video-control]"));
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    return target.type !== "range" && target.type !== "button";
  }
  return Boolean(target.closest("textarea,select,[contenteditable='true']"));
}

function isRangeTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type === "range";
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

function formatVideoTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
