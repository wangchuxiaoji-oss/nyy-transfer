/**
 * SDP v2 — PacketBuffer
 *
 * A run-ahead buffer that sits between the demuxer (network) and the feed
 * loops (decode). It continuously pulls packets from a mediabunny
 * EncodedPacketSink and stores them in memory, decoupling network latency
 * from decode timing.
 *
 * Design:
 * - Capacity: up to BUFFER_DURATION_SEC queued, or MAX_BUFFER_BYTES total
 *   memory, whichever is hit first.
 * - Consumers call `take()` which resolves instantly if data is available,
 *   or waits (via a deferred promise) until the run-ahead loop fills more.
 * - The run-ahead loop pauses (back-pressure) when the buffer is full.
 * - On seek, `reset()` clears the buffer and restarts the run-ahead from
 *   a new start packet.
 */

import type { DebugLogFn } from "@/lib/debug";

type MbEncodedPacket = InstanceType<typeof import("mediabunny").EncodedPacket>;
type MbEncodedPacketSink = InstanceType<
  typeof import("mediabunny").EncodedPacketSink
>;
type MbPacketIterator = AsyncGenerator<MbEncodedPacket, void, unknown>;

export interface PacketBufferOptions {
  /** Label for debug logs (e.g. "video" or "audio") */
  label: string;
  /** Max seconds to keep queued */
  maxAheadSec?: number;
  /** Max bytes to hold in buffer */
  maxBytes?: number;
  debugLog?: DebugLogFn;
}

const DEFAULT_MAX_AHEAD_SEC = 30;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024; // 128 MB
const STATUS_LOG_PACKET_INTERVAL = 1000;

export class PacketBuffer {
  private queue: MbEncodedPacket[] = [];
  private totalBytes = 0;
  private lastConsumedTimestamp = -Infinity;
  private filling = false;
  private disposed = false;
  private epoch = 0;
  /** Edge-trigger guard so the "full" log fires once per full→drain cycle */
  private loggedFull = false;
  private iterator: MbPacketIterator | null = null;

  // Consumer waiting for data
  private waiter: { resolve: () => void } | null = null;
  // Producer waiting for space
  private spaceWaiter: { resolve: () => void } | null = null;

  private label: string;
  private maxAheadSec: number;
  private maxBytes: number;
  private debugLog?: DebugLogFn;

  /** Whether the source stream has ended (all packets consumed) */
  ended = false;

  constructor(options: PacketBufferOptions) {
    this.label = options.label;
    this.maxAheadSec = options.maxAheadSec ?? DEFAULT_MAX_AHEAD_SEC;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.debugLog = options.debugLog;
  }

  /** Start the run-ahead loop pulling from the given sink */
  startFilling(sink: MbEncodedPacketSink, startPacket?: MbEncodedPacket): void {
    this.epoch++;
    const currentEpoch = this.epoch;
    this.stopFilling();
    this.ended = false;
    this.filling = true;
    this.iterator = sink.packets(startPacket);
    this.runAhead(currentEpoch);
  }

  /** Stop the run-ahead loop (e.g. on seek or dispose) */
  stopFilling(): void {
    this.filling = false;
    this.iterator = null;
    // Wake producer if blocked
    if (this.spaceWaiter) {
      this.spaceWaiter.resolve();
      this.spaceWaiter = null;
    }
    // Wake consumer if blocked (so it can re-check abortFn)
    if (this.waiter) {
      this.waiter.resolve();
      this.waiter = null;
    }
  }

  /** Clear all buffered packets (on seek) */
  clear(): void {
    this.queue = [];
    this.totalBytes = 0;
    this.lastConsumedTimestamp = -Infinity;
    this.ended = false;
    this.loggedFull = false;
  }

  /** Reset for seek: stop, clear, optionally restart */
  reset(sink?: MbEncodedPacketSink, startPacket?: MbEncodedPacket): void {
    this.stopFilling();
    this.clear();
    if (sink) {
      this.startFilling(sink, startPacket);
    }
  }

  /**
   * Take the next packet from the buffer.
   * Returns null only when the source has ended AND the buffer is empty.
   * Otherwise waits until data is available.
   */
  async take(abortFn?: () => boolean): Promise<MbEncodedPacket | null> {
    while (true) {
      if (this.disposed || abortFn?.()) return null;

      if (this.queue.length > 0) {
        const packet = this.queue.shift()!;
        const size = estimatePacketBytes(packet);
        this.totalBytes -= size;
        this.lastConsumedTimestamp = packet.timestamp;
        // Wake producer if it was waiting for space
        if (this.spaceWaiter) {
          this.spaceWaiter.resolve();
          this.spaceWaiter = null;
        }
        return packet;
      }

      // Buffer empty
      if (this.ended) return null;
      // Not filling and empty — no more data will arrive
      if (!this.filling) return null;

      // Wait for producer to add data
      await new Promise<void>((resolve) => {
        this.waiter = { resolve };
      });
    }
  }

  /** Number of packets currently buffered */
  get length(): number {
    return this.queue.length;
  }

  /** Buffered duration in seconds (from first to last packet in queue) */
  get bufferedDurationSec(): number {
    if (this.queue.length < 2) return 0;
    return this.queue[this.queue.length - 1].timestamp - this.queue[0].timestamp;
  }

  /** Total bytes currently held */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Dispose */
  dispose(): void {
    this.disposed = true;
    this.stopFilling();
    this.clear();
    // Wake any blocked consumer
    if (this.waiter) {
      this.waiter.resolve();
      this.waiter = null;
    }
  }

  // --- Private ---

  private async runAhead(epoch: number): Promise<void> {
    const iter = this.iterator;
    if (!iter) return;
    let fillCount = 0;

    try {
      while (this.filling && !this.disposed && epoch === this.epoch) {
        // Back-pressure: wait if buffer is full
        if (this.isFull()) {
          if (!this.loggedFull) {
            this.loggedFull = true;
            this.debugLog?.("sdp-v2", `buffer:${this.label}:full`, {
              packets: this.queue.length,
              bytes: this.totalBytes,
              durationSec: +this.bufferedDurationSec.toFixed(2),
            });
          }
          await new Promise<void>((resolve) => {
            this.spaceWaiter = { resolve };
          });
          if (!this.filling || this.disposed || epoch !== this.epoch) break;
        } else if (this.loggedFull && this.isBelowRearmThreshold()) {
          // Dropped well below the full threshold (hysteresis) — re-arm the
          // edge-triggered log so a genuine refill is reported once. Avoids
          // spam during single-packet oscillation at the exact boundary.
          this.loggedFull = false;
        }

        const result = await iter.next();
        if (!this.filling || this.disposed || epoch !== this.epoch) break;
        if (result.done) {
          this.ended = true;
          // Wake consumer waiting for data
          if (this.waiter) {
            this.waiter.resolve();
            this.waiter = null;
          }
          this.debugLog?.("sdp-v2", `buffer:${this.label}:eof`, {
            totalFilled: fillCount,
          });
          break;
        }

        const packet = result.value;
        const size = estimatePacketBytes(packet);
        this.queue.push(packet);
        this.totalBytes += size;
        fillCount++;

        // Wake consumer if it was waiting
        if (this.waiter) {
          this.waiter.resolve();
          this.waiter = null;
        }

        // Periodic status log
        if (fillCount % STATUS_LOG_PACKET_INTERVAL === 0) {
          this.debugLog?.("sdp-v2", `buffer:${this.label}:status`, {
            filled: fillCount,
            queued: this.queue.length,
            bytes: this.totalBytes,
            durationSec: +this.bufferedDurationSec.toFixed(2),
          });
        }
      }
    } catch (err) {
      if (!this.disposed && this.filling && epoch === this.epoch) {
        this.debugLog?.("sdp-v2", `buffer:${this.label}:error`, {
          error: err instanceof Error ? err.message : String(err),
        });
        // Treat as end-of-stream so consumer doesn't hang
        this.ended = true;
        if (this.waiter) {
          this.waiter.resolve();
          this.waiter = null;
        }
      }
    }
  }

  private isFull(): boolean {
    if (this.totalBytes >= this.maxBytes) return true;
    if (this.queue.length === 0) return false;
    return this.bufferedDurationSec >= this.maxAheadSec;
  }

  /**
   * Hysteresis check for re-arming the "full" log. Returns true only when the
   * buffer has drained to below 80% of either capacity limit, so a single
   * packet consumed-then-refilled at the exact boundary does not re-arm.
   */
  private isBelowRearmThreshold(): boolean {
    if (this.totalBytes >= this.maxBytes * 0.8) return false;
    return this.bufferedDurationSec < this.maxAheadSec * 0.8;
  }
}

/** Estimate byte size of an encoded packet (data + overhead) */
function estimatePacketBytes(packet: MbEncodedPacket): number {
  // mediabunny EncodedPacket exposes .byteLength or .data.byteLength
  return (packet as any).byteLength ?? (packet as any).data?.byteLength ?? 4096;
}
