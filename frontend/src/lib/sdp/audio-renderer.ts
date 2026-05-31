/**
 * SDP v2 — Audio Renderer
 *
 * Manages AudioDecoder + AudioContext scheduling.
 * Decoded audio data is scheduled using createBufferSource().start(when),
 * where `when` is on the AudioContext timeline.
 *
 * Key insight: AudioContext.currentTime is an ever-increasing hardware clock.
 * We record the AudioContext.currentTime at the moment playback starts as
 * `ctxStartTime`, and the media timestamp of the first audio packet as
 * `mediaStartSec`. Then for any packet with media timestamp T:
 *   scheduleAt = ctxStartTime + (T - mediaStartSec)
 */

export class AudioRenderer {
  private decoder: AudioDecoder | null = null;
  private audioCtx: AudioContext | null = null;
  private disposed = false;

  // Mapping: media time -> AudioContext time
  private ctxStartTime = -1; // AudioContext.currentTime when play() is called
  private mediaStartSec = -1; // media timestamp (sec) of first audio packet
  private scheduledEnd = 0;
  // All currently-scheduled (started, not-yet-ended) source nodes. We MUST be
  // able to stop these on seek/reset, otherwise audio buffered ahead of the
  // seek point keeps playing and overlaps the new position's audio.
  private scheduledSources = new Set<AudioBufferSourceNode>();

  /** Configure audio decoder and create AudioContext */
  async configure(config: AudioDecoderConfig): Promise<AudioContext> {
    this.audioCtx = new AudioContext({ sampleRate: config.sampleRate });
    // Suspend immediately — we'll resume on play()
    // (Chrome auto-suspends anyway until user gesture)

    this.decoder = new AudioDecoder({
      output: (audioData) => {
        this.scheduleAudioData(audioData);
      },
      error: (err) => {
        console.error("[AudioRenderer] decode error:", err.message);
      },
    });
    this.decoder.configure(config);
    return this.audioCtx;
  }

  /** Call when playback starts — records the AudioContext baseline */
  async play() {
    const ctx = this.audioCtx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    this.ctxStartTime = ctx.currentTime;
  }

  /** Whether a valid playback baseline is set (false after reset) */
  hasBaseline(): boolean {
    return this.ctxStartTime >= 0;
  }

  /** Pause audio output */
  async pause() {
    if (this.audioCtx && this.audioCtx.state === "running") {
      await this.audioCtx.suspend();
    }
  }

  /** Resume audio output after pause */
  async resume() {
    const ctx = this.audioCtx;
    if (!ctx) return;
    if (ctx.state === "suspended") {
      await ctx.resume();
    }
    // Adjust ctxStartTime to account for the pause gap
    // After resume, ctx.currentTime picks up where it left off
    // so no adjustment needed — the timeline is continuous
  }

  /** Decode an encoded audio chunk */
  decode(chunk: EncodedAudioChunk) {
    if (!this.decoder || this.decoder.state !== "configured") return;
    this.decoder.decode(chunk);
  }

  /** Schedule decoded audio data for playback */
  private scheduleAudioData(audioData: AudioData) {
    const ctx = this.audioCtx;
    if (!ctx || this.disposed) {
      audioData.close();
      return;
    }

    const { sampleRate, numberOfChannels, numberOfFrames, timestamp } = audioData;
    if (numberOfFrames === 0) { audioData.close(); return; }

    const mediaTimeSec = timestamp / 1_000_000;

    // Record the first packet's media time as baseline
    if (this.mediaStartSec < 0) {
      this.mediaStartSec = mediaTimeSec;
    }

    // If ctxStartTime not set yet (play() not called), just buffer
    if (this.ctxStartTime < 0) {
      audioData.close();
      return;
    }

    const buffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
    const tempBuf = new Float32Array(numberOfFrames);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      audioData.copyTo(tempBuf.buffer, { planeIndex: ch, format: "f32-planar" });
      buffer.copyToChannel(tempBuf, ch);
    }
    audioData.close();

    // Map media time to AudioContext timeline
    const relativeMediaTime = mediaTimeSec - this.mediaStartSec;
    let scheduleAt = Math.max(
      this.ctxStartTime + relativeMediaTime,
      this.scheduledEnd,
    );

    // Starvation recovery: if the computed schedule time has fallen far behind
    // ctx.currentTime, it means the audio pipeline was starved (no data arrived
    // for a while). Instead of scheduling in the past (which would be dropped)
    // or accumulating a permanent lag, re-anchor the baseline so that this
    // sample plays "now". This causes a small audible skip but immediately
    // restores A/V sync instead of drifting forever.
    const lagBehindNow = ctx.currentTime - scheduleAt;
    if (lagBehindNow > 0.15) {
      // Re-anchor: pretend playback started now at this media time.
      this.ctxStartTime = ctx.currentTime;
      this.mediaStartSec = mediaTimeSec;
      this.scheduledEnd = ctx.currentTime;
      scheduleAt = ctx.currentTime;
    }

    // Don't schedule if too far in the past (small jitter tolerance)
    if (scheduleAt < ctx.currentTime - 0.1) {
      return; // drop late audio
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      this.scheduledSources.delete(source);
      try { source.disconnect(); } catch {}
    };
    this.scheduledSources.add(source);
    source.start(scheduleAt);
    this.scheduledEnd = scheduleAt + numberOfFrames / sampleRate;
  }

  /**
   * Stop and discard every scheduled source node immediately. Called on seek
   * so that audio buffered ahead of the old position cannot leak into the new
   * one. `onended` fires for stopped nodes, but we also clear eagerly so a
   * subsequent reset starts from a clean slate.
   */
  private stopAllScheduledSources() {
    this.scheduledSources.forEach((source) => {
      source.onended = null;
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    });
    this.scheduledSources.clear();
  }

  /** Flush the decoder */
  async flush(): Promise<void> {
    if (this.decoder && this.decoder.state === "configured") {
      await this.decoder.flush().catch(() => {});
    }
  }

  /**
   * Get the current audio playback position in media time (seconds).
   * This represents what the audio hardware is currently outputting.
   */
  getCurrentAudioTimeSec(): number {
    const ctx = this.audioCtx;
    if (!ctx || this.ctxStartTime < 0 || this.mediaStartSec < 0) return -1;
    const elapsed = ctx.currentTime - this.ctxStartTime;
    return this.mediaStartSec + Math.max(0, elapsed);
  }

  /** Get how far ahead audio is scheduled (buffer depth in seconds) */
  getBufferedAheadSec(): number {
    const ctx = this.audioCtx;
    if (!ctx) return 0;
    return Math.max(0, this.scheduledEnd - ctx.currentTime);
  }

  /** Reset for seek */
  async reset(config: AudioDecoderConfig) {
    // Kill any audio already scheduled on the AudioContext timeline first —
    // otherwise the ~3s of look-ahead audio from the old position keeps
    // playing and overlaps the post-seek audio.
    this.stopAllScheduledSources();
    this.scheduledEnd = 0;
    this.ctxStartTime = -1;
    this.mediaStartSec = -1;
    if (this.decoder) {
      try { this.decoder.reset(); } catch {}
      this.decoder.configure(config);
    }
  }

  /** Dispose all resources */
  dispose() {
    this.disposed = true;
    this.stopAllScheduledSources();
    if (this.decoder) {
      try { this.decoder.close(); } catch {}
      this.decoder = null;
    }
    if (this.audioCtx) {
      try { this.audioCtx.close(); } catch {}
      this.audioCtx = null;
    }
  }
}
