/**
 * SDP v2 — Shared type definitions
 */

import type { DebugLogFn } from "@/lib/debug";
import type { ShareFileDownload } from "@/lib/api";

/** Player lifecycle states */
export type PlayerState =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "seeking"
  | "ended"
  | "error";

/** Events emitted by PlayerEngine */
export interface PlayerEvents {
  stateChange: (state: PlayerState) => void;
  timeUpdate: (currentTimeSec: number) => void;
  error: (message: string) => void;
  ended: () => void;
}

/** Configuration for creating a player */
export interface PlayerConfig {
  file: ShareFileDownload;
  canvas: HTMLCanvasElement;
  debugLog?: DebugLogFn;
}

/** Video track info extracted from demuxer */
export interface VideoTrackInfo {
  codec: string;
  codedWidth: number;
  codedHeight: number;
  duration: number;
  decoderConfig: VideoDecoderConfig;
}

/** Audio track info extracted from demuxer */
export interface AudioTrackInfo {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  decoderConfig: AudioDecoderConfig;
}
