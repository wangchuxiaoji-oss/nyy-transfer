/**
 * SDP v2 — Video Renderer
 *
 * Manages VideoDecoder + frame queue + canvas rendering.
 * Follows W3C WebCodecs audio-video-player pattern:
 * - Small frame buffer (max 5 decoded frames)
 * - Back-pressure via decodeQueueSize + frame queue size
 * - Frame selection: pick the closest frame <= current media time
 * - One frame rendered per rAF tick
 */

import type { PlaybackClock } from "./clock";

const FRAME_QUEUE_MAX = 5;
const DECODE_QUEUE_MAX = 5;

export class VideoRenderer {
  private decoder: VideoDecoder | null = null;
  private frameQueue: VideoFrame[] = [];
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private clock: PlaybackClock;
  private rafId: number | null = null;
  private disposed = false;
  private displaySuppressed = false;
  private seekTargetUs: number | null = null;
  renderedFrames = 0;

  /** Called when decoder has space for more chunks */
  onNeedMoreData: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, clock: PlaybackClock) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Cannot get canvas 2d context");
    this.ctx = ctx;
    this.clock = clock;
  }

  /** Configure and start the decoder */
  configure(config: VideoDecoderConfig) {
    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.insertFrame(frame);
      },
      error: (err) => {
        console.error("[VideoRenderer] decode error:", err.message);
      },
    });
    this.decoder.configure(config);
  }

  /** Decode an encoded video chunk */
  decode(chunk: EncodedVideoChunk) {
    if (!this.decoder || this.decoder.state !== "configured") return;
    this.decoder.decode(chunk);
  }

  /** Whether the decoder can accept more chunks */
  canAcceptMore(): boolean {
    if (!this.decoder || this.decoder.state !== "configured") return false;
    return (
      this.decoder.decodeQueueSize < DECODE_QUEUE_MAX &&
      this.frameQueue.length < FRAME_QUEUE_MAX
    );
  }

  /** Wait until decoder can accept more data (or shouldStop returns true) */
  waitForSpace(shouldStop?: () => boolean): Promise<void> {
    if (this.canAcceptMore()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => {
        if (this.disposed || this.canAcceptMore() || shouldStop?.()) {
          resolve();
          return;
        }
        setTimeout(check, 8);
      };
      check();
    });
  }

  /** Start the render loop */
  startRenderLoop() {
    if (this.rafId !== null) return;
    const tick = () => {
      if (this.disposed) return;
      this.renderFrame();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stop the render loop */
  stopRenderLoop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Render one frame based on current clock time */
  private renderFrame() {
    if (this.frameQueue.length === 0) return;
    if (this.displaySuppressed) return;

    const mediaTimeUs = this.clock.getCurrentTimeUs();

    // Find the best frame: last frame with timestamp <= mediaTime
    let bestIndex = -1;
    for (let i = 0; i < this.frameQueue.length; i++) {
      if (this.frameQueue[i].timestamp <= mediaTimeUs) {
        bestIndex = i;
      } else {
        break; // frames are sorted by timestamp
      }
    }

    if (bestIndex < 0) return; // no frame is due yet

    // Close all frames older than the best (they're late, drop them)
    for (let i = 0; i < bestIndex; i++) {
      this.frameQueue[i].close();
    }
    this.frameQueue.splice(0, bestIndex);

    // Render the best frame
    const frame = this.frameQueue.shift()!;
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
    this.renderedFrames++;

    // Signal that we may have space for more data
    if (this.frameQueue.length < FRAME_QUEUE_MAX && this.onNeedMoreData) {
      this.onNeedMoreData();
    }
  }

  /** Enter hidden seek mode: frames are decoded but not presented. */
  beginSeekSuppression() {
    this.displaySuppressed = true;
    this.seekTargetUs = null;
  }

  /** Exit hidden seek mode. */
  endSeekSuppression() {
    this.displaySuppressed = false;
    this.seekTargetUs = null;
  }

  setSeekTargetUs(targetUs: number) {
    this.seekTargetUs = targetUs;
  }

  /**
   * Draw the best available frame at or before targetUs, used to commit seek.
   * Returns true if a frame was drawn.
   */
  commitSeekFrame(targetUs: number): boolean {
    if (this.frameQueue.length === 0) return false;

    let bestIndex = -1;
    for (let i = 0; i < this.frameQueue.length; i++) {
      if (this.frameQueue[i].timestamp <= targetUs) {
        bestIndex = i;
      } else {
        break;
      }
    }

    if (bestIndex < 0) return false;

    for (let i = 0; i < bestIndex; i++) {
      this.frameQueue[i].close();
    }
    this.frameQueue.splice(0, bestIndex);

    const frame = this.frameQueue.shift()!;
    const w = frame.displayWidth || frame.codedWidth;
    const h = frame.displayHeight || frame.codedHeight;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
    this.renderedFrames++;
    this.displaySuppressed = false;
    this.seekTargetUs = null;
    return true;
  }

  hasFrameAtOrBefore(targetUs: number): boolean {
    return this.frameQueue.some((frame) => frame.timestamp <= targetUs);
  }

  /** Insert a decoded frame into the queue (sorted by timestamp) */
  private insertFrame(frame: VideoFrame) {
    if (this.displaySuppressed && this.seekTargetUs !== null) {
      if (frame.timestamp <= this.seekTargetUs) {
        this.clearFrameQueue();
        this.frameQueue.push(frame);
      } else if (this.frameQueue.length === 0) {
        // Keep the first post-target frame around only if nothing else exists yet.
        this.frameQueue.push(frame);
      } else {
        frame.close();
      }
      return;
    }

    // Insert in timestamp order
    let idx = this.frameQueue.length;
    while (idx > 0 && this.frameQueue[idx - 1].timestamp > frame.timestamp) {
      idx--;
    }
    this.frameQueue.splice(idx, 0, frame);
  }

  /** Clear all queued frames */
  clearFrameQueue() {
    for (const f of this.frameQueue) {
      try { f.close(); } catch {}
    }
    this.frameQueue = [];
  }

  /** Flush the decoder (wait for all pending decodes) */
  async flush(): Promise<void> {
    if (this.decoder && this.decoder.state === "configured") {
      await this.decoder.flush();
    }
  }

  /** Reset decoder (for seek) */
  async reset(config: VideoDecoderConfig) {
    this.clearFrameQueue();
    if (this.decoder) {
      try { this.decoder.reset(); } catch {}
      this.decoder.configure(config);
    }
  }

  /** Total number of frames in queue */
  get queueLength(): number {
    return this.frameQueue.length;
  }

  /** Dispose all resources */
  dispose() {
    this.disposed = true;
    this.stopRenderLoop();
    this.clearFrameQueue();
    if (this.decoder) {
      try { this.decoder.close(); } catch {}
      this.decoder = null;
    }
  }
}
