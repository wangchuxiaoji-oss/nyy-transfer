/**
 * SDP v2 — Prefetch Feasibility Probe (MEASUREMENT ONLY)
 *
 * Gated behind ?prefetch=1. Does NOT feed the decoder or change playback.
 * It runs an independent RangeFileReader and sequentially reads bytes ahead
 * of the current playhead, discarding the data, purely to measure whether the
 * network can sustain a read throughput above the file's average bitrate —
 * i.e. whether a YouTube-style "buffer ahead of playhead" is achievable on
 * this link. Delete this file once the question is answered.
 */

import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { RangeFileReader } from "@/lib/range-file-reader";

const TARGET_LEAD_SEC = 30; // how far ahead we try to buffer (media seconds)
const READ_CHUNK_BYTES = 2 * 1024 * 1024; // per prefetch read
const EWMA_ALPHA = 0.3;
const IDLE_POLL_MS = 250; // when lead target reached, poll playhead

export class PrefetchProbe {
  private reader: RangeFileReader;
  private abort = new AbortController();
  private running = false;
  private avgBytesPerSec: number;
  private ewmaKbps = 0;
  private maxLeadSec = -Infinity;
  private minLeadSec = Infinity;
  private starvedTicks = 0;

  constructor(
    private file: ShareFileDownload,
    private durationSec: number,
    private debugLog?: DebugLogFn,
  ) {
    this.reader = new RangeFileReader(file);
    const size = this.reader.totalSize;
    this.avgBytesPerSec = durationSec > 0 ? size / durationSec : 0;
  }

  private bytePosForSec(sec: number): number {
    const total = this.reader.totalSize;
    if (this.durationSec <= 0) return 0;
    const clampedSec = Math.max(0, Math.min(sec, this.durationSec));
    return Math.floor((clampedSec / this.durationSec) * total);
  }

  private secForBytes(bytes: number): number {
    if (this.avgBytesPerSec <= 0) return 0;
    return bytes / this.avgBytesPerSec;
  }

  /**
   * Start the probe. `getPlayheadSec` returns the current playback position so
   * the probe can keep its prefetch cursor a target lead ahead of it and
   * detect when playback overtakes the buffer (starvation).
   */
  start(getPlayheadSec: () => number) {
    if (this.running) return;
    this.running = true;
    this.debugLog?.("sdp-prefetch", "probe:start", {
      fileSize: this.reader.totalSize,
      durationSec: +this.durationSec.toFixed(1),
      avgKbps: Math.round((this.avgBytesPerSec * 8) / 1000),
      targetLeadSec: TARGET_LEAD_SEC,
    });
    void this.loop(getPlayheadSec);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.abort.abort();
    this.debugLog?.("sdp-prefetch", "probe:summary", {
      maxLeadSec: this.maxLeadSec === -Infinity ? null : +this.maxLeadSec.toFixed(1),
      minLeadSec: this.minLeadSec === Infinity ? null : +this.minLeadSec.toFixed(1),
      finalEwmaKbps: Math.round(this.ewmaKbps),
      avgKbps: Math.round((this.avgBytesPerSec * 8) / 1000),
      starvedTicks: this.starvedTicks,
      verdict: this.ewmaKbps > (this.avgBytesPerSec * 8) / 1000 ? "sustainable" : "insufficient",
    });
  }

  private async loop(getPlayheadSec: () => number) {
    // Prefetch cursor in bytes. Starts at the current playhead.
    let cursor = this.bytePosForSec(getPlayheadSec());
    let lastResyncPlayheadSec = getPlayheadSec();
    let tick = 0;

    while (this.running && !this.abort.signal.aborted) {
      const playheadSec = getPlayheadSec();

      // If the playhead jumped (seek), resync the cursor to it.
      if (Math.abs(playheadSec - lastResyncPlayheadSec) > 5) {
        cursor = this.bytePosForSec(playheadSec);
        this.debugLog?.("sdp-prefetch", "probe:resync", {
          playheadSec: +playheadSec.toFixed(1),
          jumpedFromSec: +lastResyncPlayheadSec.toFixed(1),
        });
      }
      lastResyncPlayheadSec = playheadSec;

      const playheadByte = this.bytePosForSec(playheadSec);
      const leadBytes = cursor - playheadByte;
      const leadSec = this.secForBytes(leadBytes);
      this.maxLeadSec = Math.max(this.maxLeadSec, leadSec);
      this.minLeadSec = Math.min(this.minLeadSec, leadSec);
      if (leadSec < 0) this.starvedTicks++;

      // Lead target reached: idle until playback consumes some buffer.
      if (leadSec >= TARGET_LEAD_SEC) {
        await sleep(IDLE_POLL_MS);
        continue;
      }

      // Read the next chunk ahead and measure throughput.
      const start = cursor;
      const end = Math.min(cursor + READ_CHUNK_BYTES, this.reader.totalSize);
      if (start >= end) {
        // Reached EOF for prefetch; wait for playback to advance/seek.
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const startedAt = performance.now();
      try {
        const buf = await this.reader.read(start, end, this.abort.signal);
        const durationMs = performance.now() - startedAt;
        const bytes = buf.byteLength;
        cursor += bytes;
        const kbps = durationMs > 0 ? (bytes * 8) / durationMs : 0;
        this.ewmaKbps = this.ewmaKbps === 0 ? kbps : EWMA_ALPHA * kbps + (1 - EWMA_ALPHA) * this.ewmaKbps;

        if (tick % 4 === 0) {
          this.debugLog?.("sdp-prefetch", "probe:progress", {
            playheadSec: +playheadSec.toFixed(1),
            leadSec: +leadSec.toFixed(1),
            chunkKbps: Math.round(kbps),
            ewmaKbps: Math.round(this.ewmaKbps),
            avgKbps: Math.round((this.avgBytesPerSec * 8) / 1000),
            ratio: this.avgBytesPerSec > 0 ? +(this.ewmaKbps / ((this.avgBytesPerSec * 8) / 1000)).toFixed(2) : null,
            readMs: Math.round(durationMs),
          });
        }
        tick++;
      } catch (err) {
        if (this.abort.signal.aborted) break;
        this.debugLog?.("sdp-prefetch", "probe:read-error", {
          start,
          end,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(IDLE_POLL_MS);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

