"use client";

// 统一播放器类型 —— Native / SDP / AC3 三套后端共享同一套 UI 外壳

export type UnifiedPlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "seeking"
  | "ended"
  | "error";

export interface UnifiedBufferingState {
  reason: "seek" | "stall";
  progressPct: number | null;
  speedBytesPerSec: number | null;
  message?: string;
}

export interface PlayerCapability {
  enabled: boolean;
  reason?: string; // 禁用时的 tooltip / title 文案
}

export interface PlayerCapabilities {
  seek: PlayerCapability;
  volume: PlayerCapability;
  fullscreen: PlayerCapability;
  pictureInPicture: PlayerCapability;
  speed: PlayerCapability;
  subtitles: PlayerCapability;
  quality: PlayerCapability;
}

export interface PlayerViewState {
  state: UnifiedPlayerState;
  currentTime: number;
  duration: number;
  bufferedPct: number; // 0–100
  buffering: UnifiedBufferingState | null;
  error: string;
  title?: string;
  modeLabel?: string;
  isMuted: boolean;
  volume: number;
  playbackRate: number;
  capabilities: PlayerCapabilities;
}

export interface PlayerActions {
  play(): void | Promise<void>;
  pause(): void | Promise<void>;
  previewSeek?(seconds: number): void | Promise<void>;
  seek(seconds: number): void | Promise<void>;
  seekBy(deltaSeconds: number): void | Promise<void>;
  setVolume(volume: number): void | Promise<void>;
  setMuted(muted: boolean): void | Promise<void>;
  setPlaybackRate?(rate: number): void | Promise<void>;
  enterFullscreen(target: HTMLElement): void | Promise<void>;
  exitFullscreen?(): void | Promise<void>;
  togglePictureInPicture?(): void | Promise<void>;
}

/** 工厂：构造统一 capability 字典 */
export function makeCapabilities(overrides?: Partial<PlayerCapabilities>): PlayerCapabilities {
  return {
    seek: { enabled: true },
    volume: { enabled: true },
    fullscreen: { enabled: true },
    pictureInPicture: { enabled: false, reason: "暂不支持" },
    speed: { enabled: false, reason: "暂不支持" },
    subtitles: { enabled: false, reason: "暂不支持" },
    quality: { enabled: false, reason: "暂不支持" },
    ...overrides,
  };
}

/** 空白 state，adapter 初始化前使用 */
export const EMPTY_PLAYER_STATE: PlayerViewState = {
  state: "idle",
  currentTime: 0,
  duration: 0,
  bufferedPct: 0,
  buffering: null,
  error: "",
  isMuted: false,
  volume: 1,
  playbackRate: 1,
  capabilities: makeCapabilities(),
};

/** 空 actions stub，避免 render 时判空 */
export const EMPTY_PLAYER_ACTIONS: PlayerActions = {
  play: () => {},
  pause: () => {},
  seek: () => {},
  seekBy: () => {},
  setVolume: () => {},
  setMuted: () => {},
  enterFullscreen: () => {},
};
