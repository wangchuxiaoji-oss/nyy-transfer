"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play, Settings2, Volume2 } from "lucide-react";

export type UnifiedPlayerState = "idle" | "loading" | "ready" | "playing" | "paused" | "seeking" | "ended" | "error";

export interface UnifiedBufferingState {
  reason: "seek" | "stall";
  progressPct: number | null;
  speedBytesPerSec: number | null;
  message?: string;
}

export interface PlayerViewState {
  state: UnifiedPlayerState;
  currentTime: number;
  duration: number;
  buffering: UnifiedBufferingState | null;
  error: string;
  title?: string;
  modeLabel?: string;
  isMuted: boolean;
  volume: number;
  playbackRate: number;
  canSeek: boolean;
  canFullscreen: boolean;
  canPictureInPicture: boolean;
  canVolume: boolean;
  canSpeed: boolean;
  canSubtitles: boolean;
  canQuality: boolean;
  qualities?: Array<{ label: string; value: number | "auto"; selected: boolean; badge?: string }>;
  unsupportedReasons?: Partial<Record<"volume" | "speed" | "subtitles" | "quality" | "pip" | "fullscreen", string>>;
}

export interface PlayerActions {
  play(): void | Promise<void>;
  pause(): void | Promise<void>;
  seek(seconds: number): void | Promise<void>;
  setVolume?(volume: number): void;
  setMuted?(muted: boolean): void;
  setPlaybackRate?(rate: number): void;
  enterFullscreen?(): void | Promise<void>;
  togglePictureInPicture?(): void | Promise<void>;
}

interface PlayerChromeProps {
  view: PlayerViewState;
  actions: PlayerActions;
  children: ReactNode;
  className?: string;
}

export function PlayerChrome({ view, actions, children, className = "" }: PlayerChromeProps) {
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState<"root" | "quality" | "speed">("root");
  const [volumeOpen, setVolumeOpen] = useState(false);
  const isPlaying = view.state === "playing";
  const sliderValue = scrubbing ? scrubValue : view.currentTime;
  const bufferingMessage = getBufferingMessage(view.buffering);

  const commitSeek = () => {
    if (!view.canSeek) return;
    setScrubbing(false);
    void actions.seek(scrubValue);
  };

  const toggleSettings = () => {
    setSettingsOpen((next) => {
      const opened = !next;
      if (opened) setSettingsPane("root");
      return opened;
    });
    setVolumeOpen(false);
  };

  const toggleVolume = () => {
    setVolumeOpen((next) => !next);
    setSettingsOpen(false);
    setSettingsPane("root");
  };

  return (
    <div className={`relative w-full min-w-0 overflow-hidden bg-black text-white ${className}`}>
      <div className="relative bg-black">
        {children}
        {view.state !== "playing" && view.state !== "error" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <button
              type="button"
              onClick={() => void actions.play()}
              disabled={view.state === "loading"}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-[#FF8A3D] text-white shadow-[0_8px_24px_rgba(255,138,61,0.35)] transition-transform hover:scale-105 disabled:cursor-not-allowed disabled:opacity-50"
              aria-label="播放"
            >
              <Play className="ml-1 h-8 w-8 fill-current stroke-[1.5]" />
            </button>
          </div>
        )}

        {(view.state === "loading" || view.buffering) && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 px-4 text-center text-sm text-white">
            {bufferingMessage || "加载中..."}
          </div>
        )}
        {view.error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 px-4 text-center text-sm text-red-100">
            {view.error}
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-2.5 pb-2.5 pt-9">
          <div className="flex items-center gap-2 text-white">
            <button
              type="button"
              onClick={() => void (isPlaying ? actions.pause() : actions.play())}
              disabled={view.state === "loading" || view.state === "error"}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={isPlaying ? "暂停" : "播放"}
            >
              {isPlaying ? <Pause className="h-5 w-5 fill-current stroke-[1.5]" /> : <Play className="ml-0.5 h-5 w-5 fill-current stroke-[1.5]" />}
            </button>

            <input
              type="range"
              min={0}
              max={view.duration || 0}
              step={0.1}
              value={Number.isFinite(sliderValue) ? sliderValue : 0}
              disabled={!view.canSeek}
              aria-label="播放进度"
              onMouseDown={() => { setScrubbing(true); setScrubValue(view.currentTime); }}
              onTouchStart={() => { setScrubbing(true); setScrubValue(view.currentTime); }}
              onChange={(event) => setScrubValue(Number(event.target.value))}
              onMouseUp={commitSeek}
              onTouchEnd={commitSeek}
              className="min-w-0 flex-1 accent-[#FF8A3D] disabled:opacity-40"
            />

            <span className="shrink-0 whitespace-nowrap text-[14px] font-medium tabular-nums text-white/90">
              {formatTime(sliderValue)} / {formatTime(view.duration)}
            </span>

            <div className="relative flex items-center justify-center">
              <button
                type="button"
                onClick={toggleVolume}
                disabled={!view.canVolume}
                title={reason(view, "volume")}
                className={`${iconButtonClass(view.canVolume)} ${volumeOpen ? "bg-[#FF8A3D] text-white" : ""}`}
                aria-label={view.isMuted ? "取消静音" : "音量"}
              >
                <Volume2 className="h-5 w-5 stroke-[1.8]" />
              </button>
              {volumeOpen && view.canVolume && (
                <div className="absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 rounded-xl bg-[#f5f5f3] px-3 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.28)] ring-1 ring-black/10">
                  <div className="flex h-32 w-8 items-center justify-center">
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={view.volume}
                      onChange={(event) => actions.setVolume?.(Number(event.target.value))}
                      className="h-28 w-2 accent-[#FF8A3D] [writing-mode:vertical-lr]"
                      aria-label="音量"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="relative">
              <button
                type="button"
                onClick={toggleSettings}
                className={`${iconButtonClass(true)} ${settingsOpen ? "bg-[#FF8A3D] text-white" : ""}`}
                aria-label="设置"
              >
                <Settings2 className="h-5 w-5 stroke-[1.8]" />
              </button>
              {settingsOpen && (
                <div className="absolute bottom-full right-0 z-20 mb-2 min-w-44 overflow-hidden rounded-lg bg-[#f5f5f3] py-1.5 text-[13px] text-[#5d6577] shadow-[0_10px_30px_rgba(0,0,0,0.28)] ring-1 ring-black/10">
                  {settingsPane === "root" && (
                    <>
                      <SettingsRootRow label="画质" enabled={view.canQuality} activeText={getCurrentQualityLabel(view)} onClick={() => setSettingsPane("quality")} />
                      <SettingsRootRow label="速度" enabled={view.canSpeed} activeText={getCurrentSpeedLabel(view)} onClick={() => setSettingsPane("speed")} />
                    </>
                  )}
                  {settingsPane === "quality" && (
                    <SubMenu title="画质" onBack={() => setSettingsPane("root")}>
                      <QualityList view={view} onPick={() => undefined} />
                    </SubMenu>
                  )}
                  {settingsPane === "speed" && (
                    <SubMenu title="速度" onBack={() => setSettingsPane("root")}>
                      <SpeedList view={view} onPick={(rate) => actions.setPlaybackRate?.(rate)} />
                    </SubMenu>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => void actions.enterFullscreen?.()}
              disabled={!view.canFullscreen}
              title={reason(view, "fullscreen")}
              className={iconButtonClass(view.canFullscreen)}
              aria-label="全屏"
            >
              <Maximize2 className="h-5 w-5 stroke-[1.8]" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsRootRow({
  label,
  enabled,
  activeText,
  onClick,
}: {
  label: string;
  enabled: boolean;
  activeText: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      className={`flex w-full items-center justify-between px-3 py-2 text-left ${enabled ? "hover:bg-[#FF8A3D] hover:text-white" : "cursor-not-allowed opacity-45"}`}
    >
      <span className="text-[15px]">{label}</span>
      <span className="flex items-center gap-2 text-[15px]">
        <span>{activeText}</span>
        <ChevronRight className="h-4 w-4" />
      </span>
    </button>
  );
}

function SubMenu({ title, onBack, children }: { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div>
      <button type="button" onClick={onBack} className="flex w-full items-center gap-2 px-3 py-3 text-[15px] text-[#5d6577] hover:bg-[#f0f0ed]">
        <ChevronLeft className="h-4 w-4" />
        <span>{title}</span>
      </button>
      <div className="border-t border-[#e3e4df] py-1">{children}</div>
    </div>
  );
}

function QualityList({ view, onPick }: { view: PlayerViewState; onPick: (value: number | "auto") => void }) {
  const options = view.qualities ?? [
    { label: "1080p", value: 1080, selected: false, badge: "HD" },
    { label: "720p", value: 720, selected: false, badge: "HD" },
    { label: "480p", value: 480, selected: false, badge: "SD" },
    { label: "360p", value: 360, selected: false },
    { label: "自动", value: "auto", selected: true },
  ];

  return (
    <div>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          onClick={() => onPick(option.value)}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] ${option.selected ? "bg-[#FF8A3D] text-white" : "text-[#5d6577] hover:bg-[#f0f0ed]"}`}
        >
          <span className={`h-3 w-3 rounded-full border ${option.selected ? "border-white bg-white" : "border-[#c8cad1] bg-transparent"}`} />
          <span className="flex-1">{option.label}</span>
          {option.badge && <span className={`rounded px-1.5 py-0.5 text-[11px] ${option.selected ? "bg-white/20 text-white" : "bg-[#5d6577] text-white"}`}>{option.badge}</span>}
        </button>
      ))}
    </div>
  );
}

function SpeedList({ view, onPick }: { view: PlayerViewState; onPick: (rate: number) => void }) {
  const options = [0.25, 0.5, 1, 1.25, 1.5, 2];
  return (
    <div>
      {options.map((rate) => {
        const selected = Math.abs(view.playbackRate - rate) < 0.01;
        return (
          <button
            key={rate}
            type="button"
            onClick={() => onPick(rate)}
            className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] ${selected ? "bg-[#FF8A3D] text-white" : "text-[#5d6577] hover:bg-[#f0f0ed]"}`}
          >
            <span className={`h-3 w-3 rounded-full border ${selected ? "border-white bg-white" : "border-[#c8cad1] bg-transparent"}`} />
            <span className="flex-1">{rate === 1 ? "普通" : `${rate}x`}</span>
          </button>
        );
      })}
    </div>
  );
}

function getCurrentQualityLabel(view: PlayerViewState) {
  const active = view.qualities?.find((item) => item.selected);
  return active?.label || "自动";
}

function getCurrentSpeedLabel(view: PlayerViewState) {
  return view.playbackRate === 1 ? "普通" : `${view.playbackRate}x`;
}

function iconButtonClass(enabled: boolean) {
  return `flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] ${enabled ? "text-white hover:bg-white/10" : "cursor-not-allowed text-white/35"}`;
}

function reason(view: PlayerViewState, key: keyof NonNullable<PlayerViewState["unsupportedReasons"]>) {
  return view.unsupportedReasons?.[key];
}

function getBufferingMessage(buffering: UnifiedBufferingState | null) {
  if (!buffering) return "";
  const label = buffering.reason === "seek" ? "定位中" : "缓冲中";
  const progress = buffering.progressPct === null ? null : `${buffering.progressPct}%`;
  const speed = formatSpeed(buffering.speedBytesPerSec);
  return [label, progress, speed].filter(Boolean).join(" · ");
}

function formatSpeed(bytesPerSec: number | null) {
  if (!bytesPerSec || !Number.isFinite(bytesPerSec)) return "";
  const kbPerSec = bytesPerSec / 1024;
  return kbPerSec >= 1024 ? `${(kbPerSec / 1024).toFixed(1)} MB/s` : `${Math.round(kbPerSec)} KB/s`;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`
    : `${minutes}:${String(wholeSeconds).padStart(2, "0")}`;
}
