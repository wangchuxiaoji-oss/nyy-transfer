// 播放器 UI 统一重构 —— 此文件保留为 re-export，避免大面积改 import
// 新实现位于 ./player/ 目录

export { PlayerChrome, formatTime } from "./player/player-chrome";
export type {
  UnifiedPlayerState,
  UnifiedBufferingState,
  PlayerCapability,
  PlayerCapabilities,
  PlayerViewState,
  PlayerActions,
} from "./player/player-types";
