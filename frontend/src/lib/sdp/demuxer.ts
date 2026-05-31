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

export class SdpDemuxer {
  private input: MbInput | null = null;
  private reader: RangeFileReader;
  private abortController = new AbortController();
  private videoSink: MbEncodedPacketSink | null = null;
  private audioSink: MbEncodedPacketSink | null = null;
  private sourceReadSeq = 0;

  videoInfo: VideoTrackInfo | null = null;
  audioInfo: AudioTrackInfo | null = null;
  duration = 0;

  constructor(private file: ShareFileDownload, private debugLog?: DebugLogFn) {
    this.reader = new RangeFileReader(file);
  }

  /** Initialize: parse file header, extract track info */
  async init(): Promise<void> {
    const { Input, MATROSKA, CustomSource, EncodedPacketSink } =
      await import("mediabunny");

    const signal = this.abortController.signal;
    const reader = this.reader;

    const source = new CustomSource({
      getSize: () => reader.totalSize,
      read: async (start: number, end: number) => {
        const seq = ++this.sourceReadSeq;
        const startedAt = performance.now();
        try {
          const buf = await reader.read(start, end, signal);
          const durationMs = performance.now() - startedAt;
          const bytes = buf.byteLength;
          this.debugLog?.("sdp-v2", "source:read", {
            seq,
            start,
            end,
            bytes,
            durationMs: Math.round(durationMs),
            throughputKbps: durationMs > 0 ? Math.round((bytes * 8) / durationMs) : null,
            slow: durationMs >= 250,
          });
          return new Uint8Array(buf);
        } catch (err) {
          const durationMs = performance.now() - startedAt;
          this.debugLog?.("sdp-v2", "source:read:error", {
            seq,
            start,
            end,
            durationMs: Math.round(durationMs),
            aborted: signal.aborted,
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        }
      },
      dispose: () => this.abortController.abort(),
      prefetchProfile: "network",
      maxCacheSize: 64 * 1024 * 1024,
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
  async getVideoKeyPacket(timeSec: number): Promise<MbEncodedPacket | null> {
    if (!this.videoSink) return null;
    return this.videoSink.getKeyPacket(timeSec, { metadataOnly: false });
  }

  /**
   * Find the nearest audio packet at or before the given time.
   * Audio packets are typically all "key" so getPacket works.
   */
  async getAudioPacket(timeSec: number): Promise<MbEncodedPacket | null> {
    if (!this.audioSink) return null;
    return this.audioSink.getPacket(timeSec, { metadataOnly: false });
  }

  /** Dispose all resources */
  dispose() {
    this.abortController.abort();
    try { this.input?.dispose(); } catch {}
    this.input = null;
    this.videoSink = null;
    this.audioSink = null;
  }
}
