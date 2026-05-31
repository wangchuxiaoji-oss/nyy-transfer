/**
 * SDP v2 — Demuxer
 *
 * Wraps mediabunny's Input + CustomSource + EncodedPacketSink to provide
 * a clean interface for the player engine. Adapts our multi-chunk CDN
 * file hosting (RangeFileReader) to mediabunny's CustomSource.
 */

import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import type { VideoTrackInfo, AudioTrackInfo } from "./types";
import { RangeFileReader } from "@/lib/range-file-reader";

// Lazy-loaded mediabunny types (to avoid SSR issues)
type MbInput = InstanceType<typeof import("mediabunny").Input>;
type MbEncodedPacketSink = InstanceType<
  typeof import("mediabunny").EncodedPacketSink
>;
type MbEncodedPacket = InstanceType<typeof import("mediabunny").EncodedPacket>;

export interface SourceReadStats {
  seq: number;
  start: number;
  end: number;
  bytes: number;
  durationMs: number;
  throughputKbps: number | null;
  slow: boolean;
}

/** Prefetch behavior for the mediabunny CustomSource. */
export type SourcePrefetchProfile = "none" | "fileSystem" | "network";

export class SdpDemuxer {
  private input: MbInput | null = null;
  private reader: RangeFileReader;
  private abortController = new AbortController();
  private activeReadControllers = new Set<AbortController>();
  private videoSink: MbEncodedPacketSink | null = null;
  private audioSink: MbEncodedPacketSink | null = null;
  private sourceReadSeq = 0;

  videoInfo: VideoTrackInfo | null = null;
  audioInfo: AudioTrackInfo | null = null;
  duration = 0;

  constructor(
    private file: ShareFileDownload,
    private debugLog?: DebugLogFn,
    private onSourceRead?: (stats: SourceReadStats) => void,
    private prefetchProfile: SourcePrefetchProfile = "fileSystem",
  ) {
    this.reader = new RangeFileReader(file);
  }

  get prefetchProfileName(): SourcePrefetchProfile {
    return this.prefetchProfile;
  }

  /**
   * Enable/disable parallel splitting of large reads on the underlying reader.
   * Used to accelerate cluster downloads during seek. `parts <= 1` disables.
   */
  setParallelMode(parts: number, thresholdBytes?: number): void {
    this.reader.setParallelMode(parts, thresholdBytes);
  }

  /** Initialize: parse file header, extract track info */
  async init(): Promise<void> {
    const { Input, MATROSKA, CustomSource, EncodedPacketSink } =
      await import("mediabunny");

    const reader = this.reader;

    const source = new CustomSource({
      getSize: () => reader.totalSize,
      read: async (start: number, end: number) => {
        const seq = ++this.sourceReadSeq;
        const startedAt = performance.now();
        const readAbortController = new AbortController();
        const onDisposeAbort = () => readAbortController.abort(this.abortController.signal.reason ?? new Error("source disposed"));
        if (this.abortController.signal.aborted) {
          onDisposeAbort();
        } else {
          this.abortController.signal.addEventListener("abort", onDisposeAbort, { once: true });
        }
        this.activeReadControllers.add(readAbortController);
        try {
          const buf = await reader.read(start, end, readAbortController.signal, (info) => {
            // Only surface noteworthy attempts (retries, timeouts, failures);
            // a clean first-try success stays quiet to avoid log spam.
            if (info.attempt > 1 || info.willRetry || info.timedOut || !info.ok) {
              this.debugLog?.("sdp-v2", "source:read:attempt", { seq, ...info });
            }
          });
          const durationMs = performance.now() - startedAt;
          const bytes = buf.byteLength;
          const stats: SourceReadStats = {
            seq,
            start,
            end,
            bytes,
            durationMs: Math.round(durationMs),
            throughputKbps: durationMs > 0 ? Math.round((bytes * 8) / durationMs) : null,
            slow: durationMs >= 250,
          };
          if (shouldLogSourceRead(stats)) {
            this.debugLog?.("sdp-v2", "source:read", { ...stats });
          }
          this.onSourceRead?.(stats);
          return new Uint8Array(buf);
        } catch (err) {
          const durationMs = performance.now() - startedAt;
          if (!readAbortController.signal.aborted) {
            this.debugLog?.("sdp-v2", "source:read:error", {
              seq,
              start,
              end,
              durationMs: Math.round(durationMs),
              aborted: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          throw err;
        } finally {
          this.activeReadControllers.delete(readAbortController);
          this.abortController.signal.removeEventListener("abort", onDisposeAbort);
        }
      },
      dispose: () => this.abortController.abort(),
      prefetchProfile: this.prefetchProfile,
      maxCacheSize: 16 * 1024 * 1024,
    });

    this.input = new Input({ source, formats: [MATROSKA] });

    // Extract video track
    const videoTrack = await this.input.getPrimaryVideoTrack();
    if (videoTrack) {
      const cfg = await videoTrack.getDecoderConfig();
      if (cfg) {
        this.videoInfo = {
          codec: cfg.codec,
          codedWidth: cfg.codedWidth ?? 0,
          codedHeight: cfg.codedHeight ?? 0,
          duration: 0,
          decoderConfig: cfg as VideoDecoderConfig,
        };
        this.videoSink = new EncodedPacketSink(videoTrack);
      }
    }

    // Extract audio track
    const audioTrack = await this.input.getPrimaryAudioTrack();
    if (audioTrack) {
      const cfg = await audioTrack.getDecoderConfig();
      if (cfg) {
        this.audioInfo = {
          codec: cfg.codec,
          sampleRate: cfg.sampleRate ?? 0,
          numberOfChannels: cfg.numberOfChannels ?? 0,
          decoderConfig: cfg as AudioDecoderConfig,
        };
        this.audioSink = new EncodedPacketSink(audioTrack);
      }
    }

    // Duration
    const dur = await this.input.getDurationFromMetadata();
    this.duration = dur ?? 0;
    if (this.videoInfo) this.videoInfo.duration = this.duration;
  }

  /** Get the video packet sink for iteration */
  getVideoSink(): MbEncodedPacketSink | null {
    return this.videoSink;
  }

  /** Get the audio packet sink for iteration */
  getAudioSink(): MbEncodedPacketSink | null {
    return this.audioSink;
  }

  /**
   * Find the nearest video key packet at or before the given time.
   * Returns null if no sink or no key packet found.
   */
  async getVideoKeyPacket(timeSec: number, options?: { metadataOnly?: boolean }): Promise<MbEncodedPacket | null> {
    if (!this.videoSink) return null;
    return this.videoSink.getKeyPacket(timeSec, { metadataOnly: options?.metadataOnly ?? false });
  }

  /**
   * Find the nearest audio packet at or before the given time.
   * Audio packets are typically all "key" so getPacket works.
   */
  async getAudioPacket(timeSec: number): Promise<MbEncodedPacket | null> {
    if (!this.audioSink) return null;
    return this.audioSink.getPacket(timeSec, { metadataOnly: false });
  }

  abortActiveReads() {
    for (const controller of Array.from(this.activeReadControllers)) {
      controller.abort(new Error("seek cancelled"));
    }
  }

  /**
   * Read-only validation probe: read a few bytes at an absolute file offset
   * (logical-file coordinate space, same as RangeFileReader) and parse the
   * leading EBML element ID. Used to verify that an MKV seek-index byte offset
   * lands exactly on a Cluster element. Does NOT touch mediabunny state.
   */
  async probeElementAt(
    absOffset: number,
    signal?: AbortSignal,
  ): Promise<{ elementId: number; isCluster: boolean; bytes: number; durationMs: number }> {
    const startedAt = performance.now();
    // 12 bytes covers the longest EBML ID (4) + a generous size vint.
    const buf = await this.reader.read(absOffset, absOffset + 12, signal);
    const view = new Uint8Array(buf);
    const elementId = readEbmlElementId(view);
    return {
      elementId,
      isCluster: elementId === MKV_CLUSTER_ID,
      bytes: view.byteLength,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  /** Dispose all resources */
  dispose() {
    this.abortController.abort();
    this.abortActiveReads();
    try { this.input?.dispose(); } catch {}
    this.input = null;
    this.videoSink = null;
    this.audioSink = null;
  }
}

function shouldLogSourceRead(stats: SourceReadStats): boolean {
  return stats.seq <= 3 || stats.seq % 25 === 0 || stats.durationMs >= 3000;
}

/** Matroska Cluster element ID, including the length-descriptor marker bits. */
const MKV_CLUSTER_ID = 0x1f43b675;

/**
 * Read a Matroska/EBML element ID from the start of a buffer, preserving the
 * length-descriptor marker bits (so the value matches the spec's element IDs).
 * Returns -1 if the buffer is too short to contain a complete ID.
 */
function readEbmlElementId(buf: Uint8Array): number {
  if (buf.byteLength === 0) return -1;
  const first = buf[0];
  let mask = 0x80;
  let length = 1;
  while (length <= 4 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || buf.byteLength < length) return -1;
  let value = 0;
  for (let i = 0; i < length; i += 1) {
    value = value * 256 + buf[i];
  }
  return value;
}
