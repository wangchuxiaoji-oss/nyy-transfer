"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Maximize2, Minimize2, Pause, Play, Settings2, Volume2, VolumeX } from "lucide-react";
import type { PlayerActions, PlayerViewState } from "./player-types";

// —— 常量 ——

const SEEK_STEP_SECONDS = 5;
const CONTROLS_IDLE_HIDE_MS = 3000;
const SINGLE_CLICK_DELAY_MS = 180;
const DOUBLE_TAP_DELAY_MS = 280;
const CONTROL_BUTTON_CLASS =
  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/8 text-white/86 backdrop-blur-xl transition hover:border-[#FF8A3D]/70 hover:bg-[#FF8A3D]/20 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF8A3D]";

// —— Props ——

interface PlayerChromeProps {
  view: PlayerViewState;
  actions: PlayerActions;
  children: ReactNode;
  className?: string;
  /** 根级 data-testid，用于 e2e 选择器向后兼容 */
  rootTestId?: string;
}

// —— 类型 ——

type SliderStyle = CSSProperties & { "--nyy-thumb-opacity": string };

// —— 组件 ——

export function PlayerChrome({ view, actions, children, className = "", rootTestId }: PlayerChromeProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // ——— 播放/UI 状态 ———
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenChromeVisible, setFullscreenChromeVisible] = useState(true);
  const [inlineChromeVisible, setInlineChromeVisible] = useState(true);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [progressHover, setProgressHover] = useState(false);
  const [hoverPct, setHoverPct] = useState(0);
  const [hoverTime, setHoverTime] = useState(0);
  const [isPointerInside, setIsPointerInside] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const isPlaying = view.state === "playing";
  const autoHideControls = view.capabilities.fullscreen.enabled;
  const playable = view.duration > 0 && Number.isFinite(view.duration);
  const isWaiting = view.state === "loading" || view.buffering !== null;
  const showCenterPlay = ["idle", "ready", "paused", "ended"].includes(view.state);

  // ——— refs ———
  const hideTimerRef = useRef<number | null>(null);
  const clickTimerRef = useRef<number | null>(null);
  const tapTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ at: number; x: number } | null>(null);
  const ignoreNextClickRef = useRef(false);
  const isPlayingRef = useRef(false);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // ===== 全屏状态同步 =====
  useEffect(() => {
    const sync = () => {
      const root = rootRef.current;
      const next = Boolean(root && document.fullscreenElement === root);
      setIsFullscreen(next);
      setFullscreenChromeVisible(true);
    };
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  // ===== 控制栏自动隐藏 =====
  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleControlsHide = useCallback(() => {
    clearHideTimer();
    if (!autoHideControls || !isPlayingRef.current || isScrubbing || settingsOpen) return;
    hideTimerRef.current = window.setTimeout(() => {
      setFullscreenChromeVisible(false);
      setInlineChromeVisible(false);
    }, CONTROLS_IDLE_HIDE_MS);
  }, [autoHideControls, clearHideTimer, isScrubbing, settingsOpen]);

  const revealControls = useCallback(() => {
    setFullscreenChromeVisible(true);
    setInlineChromeVisible(true);
    scheduleControlsHide();
  }, [scheduleControlsHide]);

  useEffect(() => {
    if (!isPlaying || isScrubbing || settingsOpen || !autoHideControls) {
      clearHideTimer();
      setFullscreenChromeVisible(true);
      setInlineChromeVisible(true);
      return;
    }
    scheduleControlsHide();
    return clearHideTimer;
  }, [autoHideControls, clearHideTimer, isPlaying, isScrubbing, settingsOpen, isFullscreen, scheduleControlsHide]);

  const handleActivity = useCallback(() => {
    revealControls();
  }, [revealControls]);

  const toggleFullscreen = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => {});
      return;
    }
    await actions.enterFullscreen(root);
    root.focus({ preventScroll: true });
  }, [actions]);

  // ===== 进度条 =====
  const sliderTime = isScrubbing ? scrubValue : view.currentTime;
  const progressPct = playable ? Math.max(0, Math.min(100, (sliderTime / view.duration) * 100)) : 0;
  const bufferEndPct = Math.max(progressPct, view.bufferedPct);
  const rangeBg = `linear-gradient(90deg, #FF8A3D 0%, #FF8A3D ${progressPct}%, rgba(255,255,255,0.34) ${progressPct}%, rgba(255,255,255,0.34) ${bufferEndPct}%, rgba(255,255,255,0.14) ${bufferEndPct}%, rgba(255,255,255,0.14) 100%)`;

  const commitSeek = useCallback(() => {
    if (!view.capabilities.seek.enabled) return;
    setIsScrubbing(false);
    void actions.seek(scrubValue);
  }, [actions, scrubValue, view.capabilities.seek.enabled]);

  const handleProgressPointer = useCallback(
    (event: React.PointerEvent<HTMLInputElement>) => {
      if (!playable) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
      const nextTime = pct * view.duration;
      setHoverPct(pct * 100);
      setHoverTime(nextTime);
      if (isScrubbing) void actions.previewSeek?.(nextTime);
      handleActivity();
    },
    [actions, isScrubbing, playable, view.duration, handleActivity],
  );

  const fullscreenChromeHidden = isFullscreen && autoHideControls && isPlaying && !fullscreenChromeVisible && !isScrubbing && !settingsOpen;
  const inlineChromeHidden = !isFullscreen && autoHideControls && isPlaying && !inlineChromeVisible && !isScrubbing && !settingsOpen;
  const chromeHidden = fullscreenChromeHidden || inlineChromeHidden;
  const thumbVisible = isScrubbing || progressHover || (isPointerInside && !chromeHidden);
  const bubbleVisible = playable && (progressHover || isScrubbing) && !chromeHidden;
  const bubblePct = isScrubbing ? progressPct : hoverPct;
  const bubbleTime = isScrubbing ? scrubValue : hoverTime;
  const sliderStyle: SliderStyle = {
    background: chromeHidden ? "rgba(255,255,255,0.14)" : rangeBg,
    "--nyy-thumb-opacity": thumbVisible ? "1" : "0",
  };

  // ===== 键盘快捷键 =====
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const target = event.target;
      if (isTextInputTarget(target)) return;
      const onRange = isRangeTarget(target);
      const key = event.key.toLowerCase();

      if (key === " " || key === "spacebar") {
        event.preventDefault();
        if (isPlaying) void actions.pause();
        else void actions.play();
      } else if (key === "arrowleft") {
        if (onRange) return;
        event.preventDefault();
        void actions.seekBy(-SEEK_STEP_SECONDS);
      } else if (key === "arrowright") {
        if (onRange) return;
        event.preventDefault();
        void actions.seekBy(SEEK_STEP_SECONDS);
      } else if (key === "f") {
        event.preventDefault();
        void toggleFullscreen();
      } else if (key === "m") {
        event.preventDefault();
        const nextMuted = !view.isMuted;
        void actions.setMuted(nextMuted);
      }
      handleActivity();
    },
    [actions, handleActivity, isPlaying, toggleFullscreen, view.isMuted],
  );

  // ===== 舞台交互 =====
  const handleStageClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (ignoreNextClickRef.current || isControlTarget(event.target) || event.detail > 1) return;
      rootRef.current?.focus({ preventScroll: true });
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
        if (isPlaying) void actions.pause();
        else void actions.play();
      }, SINGLE_CLICK_DELAY_MS);
    },
    [actions, isPlaying],
  );

  const handleStageDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (isControlTarget(event.target)) return;
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    void toggleFullscreen();
  }, [toggleFullscreen]);

  const handleStagePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch" || isControlTarget(event.target)) return;
      ignoreNextClickRef.current = true;
      window.setTimeout(() => {
        ignoreNextClickRef.current = false;
      }, 320);
      rootRef.current?.focus({ preventScroll: true });
      revealControls();
      const now = Date.now();
      const previous = lastTapRef.current;
      const rect = event.currentTarget.getBoundingClientRect();
      const isDoubleTap =
        previous &&
        now - previous.at <= DOUBLE_TAP_DELAY_MS &&
        Math.abs(previous.x - event.clientX) < 80;
      if (isDoubleTap) {
        if (tapTimerRef.current !== null) {
          window.clearTimeout(tapTimerRef.current);
          tapTimerRef.current = null;
        }
        lastTapRef.current = null;
        const delta = event.clientX < rect.left + rect.width / 2 ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
        void actions.seekBy(delta);
        setInlineChromeVisible(true);
        return;
      }
      lastTapRef.current = { at: now, x: event.clientX };
      if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
      tapTimerRef.current = window.setTimeout(() => {
        tapTimerRef.current = null;
        setInlineChromeVisible(true);
      }, DOUBLE_TAP_DELAY_MS);
    },
    [actions, revealControls],
  );

  // ===== 清理 =====
  useEffect(() => () => {
    clearHideTimer();
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
  }, [clearHideTimer]);

  // ===== 禁用工具 =====
  const disabledTitle = (cap: { enabled: boolean; reason?: string }) =>
    cap.enabled ? undefined : cap.reason || "当前播放路径不支持";

  // ===== 渲染 =====
  return (
    <div
      ref={rootRef}
      data-testid={rootTestId || "player-chrome"}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={handleStageClick}
      onDoubleClick={handleStageDoubleClick}
      onPointerUp={handleStagePointerUp}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") handleActivity();
      }}
      onMouseEnter={() => {
        setIsPointerInside(true);
        handleActivity();
      }}
      onMouseLeave={() => {
        setIsPointerInside(false);
        setProgressHover(false);
      }}
      className={`group absolute inset-0 overflow-hidden bg-black text-white outline-none ${fullscreenChromeHidden ? "cursor-none" : "cursor-default"} ${className}`}
    >
      {/* —— 媒体 surface —— */}
      <div className="relative h-full w-full bg-black">{children}</div>

      {/* —— 中心大播放按钮 —— */}
      {showCenterPlay && (
        <button
          type="button"
          data-video-control
          data-testid="native-video-center-toggle"
          onClick={(event) => {
            event.stopPropagation();
            void actions.play();
          }}
          aria-label="播放"
          className="absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-200"
        >
          <span className="flex h-16 w-16 items-center justify-center rounded-full border border-white/35 bg-[#FF8A3D] text-white shadow-[0_0_34px_rgba(255,138,61,0.55),0_16px_44px_rgba(0,0,0,0.45)] backdrop-blur-xl transition-transform hover:scale-105">
            <Play className="ml-1 h-8 w-8 fill-current stroke-[1.5]" />
          </span>
        </button>
      )}

      {/* —— 等待呼吸点 —— */}
      {isWaiting && (
        <div data-testid="native-video-buffering" className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
          <span className="relative flex items-center justify-center">
            <span className="absolute h-9 w-9 animate-ping rounded-full bg-[#FF8A3D]/45" />
            <span className="absolute h-6 w-6 animate-ping rounded-full bg-[#FFB169]/55 [animation-delay:160ms]" />
            <span className="h-3.5 w-3.5 animate-pulse rounded-full bg-[#FFA24D] shadow-[0_0_16px_rgba(255,138,61,0.95),0_0_36px_rgba(255,162,77,0.65)]" />
          </span>
        </div>
      )}

      {/* —— 错误态 —— */}
      {view.error && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 px-4 text-center text-sm text-red-100">
          {view.error}
        </div>
      )}

      {/* —— 底部控制栏 —— */}
      <div
        data-video-control
        data-testid="native-video-controls"
        inert={chromeHidden}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/55 to-transparent px-3 pb-3 pt-12 transition-opacity duration-300 ${chromeHidden ? "pointer-events-none opacity-0" : "opacity-100 sm:opacity-85 sm:group-hover:opacity-100"}`}
      >
        {/* 进度条区 */}
        <div className="relative mb-2 pt-5">
          {bubbleVisible && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border border-white/12 bg-black/80 px-2 py-1 font-tech text-[10px] tabular-nums text-white/86 shadow-[0_8px_24px_rgba(0,0,0,0.35)] backdrop-blur-xl"
              style={{ left: `${bubblePct}%` }}
            >
              {formatTime(bubbleTime)}
            </span>
          )}
          <input
            type="range"
            data-testid="native-video-progress"
            min={0}
            max={view.duration || 0}
            step={0.1}
            value={Number.isFinite(sliderTime) ? sliderTime : 0}
            disabled={!view.capabilities.seek.enabled}
            title={disabledTitle(view.capabilities.seek)}
            aria-label="播放进度"
            onPointerEnter={(event) => {
              setProgressHover(true);
              handleProgressPointer(event);
            }}
            onPointerMove={handleProgressPointer}
            onPointerLeave={() => setProgressHover(false)}
            onMouseDown={() => {
              setIsScrubbing(true);
              setScrubValue(view.currentTime);
              setProgressHover(true);
              revealControls();
            }}
            onTouchStart={() => {
              setIsScrubbing(true);
              setScrubValue(view.currentTime);
              setProgressHover(true);
              revealControls();
            }}
            onChange={(event) => {
              const next = Number(event.target.value);
              setScrubValue(next);
              void actions.previewSeek?.(next);
              if (playable) {
                setHoverPct((next / view.duration) * 100);
                setHoverTime(next);
              }
            }}
            onMouseUp={commitSeek}
            onTouchEnd={commitSeek}
            className="nyy-player__range h-1.5 w-full cursor-pointer appearance-none rounded-full accent-[#FF8A3D] disabled:cursor-not-allowed disabled:opacity-50"
            style={sliderStyle}
          />
        </div>

        {/* 控制按钮区 */}
        <div className="mt-2 flex items-center gap-2">
          {/* 播放/暂停 */}
          <button
            type="button"
            data-video-control
            onClick={() => void (isPlaying ? actions.pause() : actions.play())}
            disabled={view.state === "loading" && !isPlaying}
            className={CONTROL_BUTTON_CLASS}
            aria-label={isPlaying ? "暂停" : "播放"}
          >
            {isPlaying ? (
              <Pause className="h-4 w-4 fill-current stroke-[1.5]" />
            ) : (
              <Play className="ml-0.5 h-4 w-4 fill-current stroke-[1.5]" />
            )}
          </button>

          {/* 时间显示 */}
          <span className="min-w-[5.8rem] font-tech text-[11px] tabular-nums text-white/78">
            {formatTime(sliderTime)} / {formatTime(view.duration)}
          </span>

          <div className="ml-auto flex items-center gap-1.5">
            {/* 静音 */}
            <button
              type="button"
              data-video-control
              onClick={() => void actions.setMuted(!view.isMuted)}
              disabled={!view.capabilities.volume.enabled}
              title={disabledTitle(view.capabilities.volume)}
              className={CONTROL_BUTTON_CLASS}
              aria-label={view.isMuted || view.volume === 0 ? "取消静音" : "静音"}
            >
              {view.isMuted || view.volume === 0 ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>

            {/* 音量 slider */}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={view.isMuted ? 0 : view.volume}
              disabled={!view.capabilities.volume.enabled}
              title={disabledTitle(view.capabilities.volume)}
              onChange={(event) => void actions.setVolume(Number(event.target.value))}
              className="hidden h-1 w-16 cursor-pointer appearance-none rounded-full bg-white/18 accent-[#FF8A3D] sm:block disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="音量"
            />

            {/* 设置：统一露出禁用能力和原因 */}
            <div className="relative">
              <button
                type="button"
                data-video-control
                onClick={() => setSettingsOpen((open) => !open)}
                className={`${CONTROL_BUTTON_CLASS} ${settingsOpen ? "border-[#FF8A3D]/70 bg-[#FF8A3D]/20" : ""}`}
                aria-label="设置"
              >
                <Settings2 className="h-4 w-4" />
              </button>
              {settingsOpen && (
                <div
                  data-video-control
                  className="absolute bottom-full right-0 z-40 mb-2 min-w-44 overflow-hidden rounded-lg border border-white/10 bg-black/88 py-1 text-[13px] text-white/86 shadow-[0_14px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl"
                >
                  <SettingsRow
                    label="画质"
                    value="单源"
                    capability={view.capabilities.quality}
                  />
                  <SpeedRow
                    view={view}
                    onPick={(rate) => {
                      void actions.setPlaybackRate?.(rate);
                      setSettingsOpen(false);
                    }}
                  />
                  <SettingsRow
                    label="字幕"
                    value="关闭"
                    capability={view.capabilities.subtitles}
                  />
                  <SettingsRow
                    label="画中画"
                    value="PiP"
                    capability={view.capabilities.pictureInPicture}
                    onClick={() => {
                      void actions.togglePictureInPicture?.();
                      setSettingsOpen(false);
                    }}
                  />
                </div>
              )}
            </div>

            {/* 全屏 */}
            <button
              type="button"
              data-video-control
              onClick={() => void toggleFullscreen()}
              disabled={!view.capabilities.fullscreen.enabled}
              title={disabledTitle(view.capabilities.fullscreen)}
              className={CONTROL_BUTTON_CLASS}
              aria-label={isFullscreen ? "退出全屏" : "全屏"}
            >
              {isFullscreen ? (
                <Minimize2 className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* —— range slider 样式 —— */}
      <style>{`
        .nyy-player__range::-webkit-slider-thumb {
          height: 0.875rem;
          width: 0.875rem;
          appearance: none;
          border-radius: var(--radius-pill);
          background: #fff;
          box-shadow: 0 0 0 3px rgba(255, 138, 61, 0.35);
          opacity: var(--nyy-thumb-opacity, 0);
          transition: opacity 180ms ease;
        }
        .nyy-player__range::-moz-range-thumb {
          height: 0.875rem;
          width: 0.875rem;
          border: 0;
          border-radius: var(--radius-pill);
          background: #fff;
          box-shadow: 0 0 0 3px rgba(255, 138, 61, 0.35);
          opacity: var(--nyy-thumb-opacity, 0);
          transition: opacity 180ms ease;
        }
      `}</style>
    </div>
  );
}

function SettingsRow({
  label,
  value,
  capability,
  onClick,
}: {
  label: string;
  value: string;
  capability: { enabled: boolean; reason?: string };
  onClick?: () => void;
}) {
  const disabled = !capability.enabled || !onClick;
  return (
    <button
      type="button"
      data-video-control
      disabled={disabled}
      title={disabled ? capability.reason || "当前播放路径不支持" : undefined}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-4 px-3 py-2 text-left transition ${
        disabled ? "cursor-not-allowed text-white/38" : "text-white/88 hover:bg-[#FF8A3D]/24 hover:text-white"
      }`}
    >
      <span>{label}</span>
      <span className="text-xs text-white/55">{disabled ? capability.reason || value : value}</span>
    </button>
  );
}

function SpeedRow({
  view,
  onPick,
}: {
  view: PlayerViewState;
  onPick: (rate: number) => void;
}) {
  if (!view.capabilities.speed.enabled) {
    return (
      <SettingsRow
        label="速度"
        value="普通"
        capability={view.capabilities.speed}
      />
    );
  }
  const rates = [0.5, 1, 1.25, 1.5, 2];
  return (
    <div className="border-y border-white/8 px-3 py-2">
      <div className="mb-2 flex items-center justify-between text-white/88">
        <span>速度</span>
        <span className="text-xs text-white/55">{view.playbackRate === 1 ? "普通" : `${view.playbackRate}x`}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {rates.map((rate) => {
          const selected = Math.abs(view.playbackRate - rate) < 0.01;
          return (
            <button
              key={rate}
              type="button"
              data-video-control
              onClick={() => onPick(rate)}
              className={`rounded-md px-2 py-1 text-xs transition ${
                selected ? "bg-[#FF8A3D] text-white" : "bg-white/8 text-white/72 hover:bg-[#FF8A3D]/24 hover:text-white"
              }`}
            >
              {rate === 1 ? "普通" : `${rate}x`}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ===== 通用工具 =====

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function isControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-video-control]"));
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLInputElement) {
    return target.type !== "range" && target.type !== "button";
  }
  return Boolean(
    target.closest("textarea,select,[contenteditable='true']"),
  );
}

function isRangeTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement && target.type === "range";
}
