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
  private gainNode: GainNode | null = null;
  private disposed = false;
  private volume = 1;
  private muted = false;

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
    // 创建 gainNode 用于音量控制（必须在 AudioDecoder 之前，确保 scheduleAudioData 能用）
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.muted ? 0 : this.volume;
    this.gainNode.connect(this.audioCtx.destination);

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

  /**
   * Configure only AudioContext (no AudioDecoder). Used when the codec is
   * not supported by browser's AudioDecoder (AC-3 path — decoded samples
   * come via scheduleDecodedSample instead).
   */
  async configureAlternate(sampleRate: number): Promise<AudioContext> {
    this.audioCtx = new AudioContext({ sampleRate });
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.muted ? 0 : this.volume;
    this.gainNode.connect(this.audioCtx.destination);
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

  /**
   * Override the media start time anchor. Used when the codec's decoded
   * samples don't carry meaningful timestamps (e.g. AC-3 via custom decoder).
   */
  setMediaStartSec(sec: number) {
    if (sec >= 0) this.mediaStartSec = sec;
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

  /**
   * Schedule a pre-decoded audio sample directly, bypassing AudioDecoder.
   * Used when the codec is not supported by the browser's AudioDecoder
   * (e.g. AC-3 decoded by mediabunny's registered custom decoder).
   */
  scheduleDecodedSample(sample: {
    numberOfChannels: number;
    numberOfFrames: number;
    sampleRate: number;
    timestamp: number;
    duration: number;
    copyTo: (destination: AllowSharedBufferSource, options: { planeIndex: number; format: "f32-planar" }) => void;
    close: () => void;
  }) {
    const ctx = this.audioCtx;
    if (!ctx || this.disposed || sample.numberOfFrames === 0) {
      sample.close();
      return;
    }

    // Use the same media time baseline logic as scheduleAudioData,
    // but skip AudioData.close() since the caller owns the sample.
    this.scheduleDecodedSampleInternal(ctx, sample);
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

    // Stall-resume recovery: if computed schedule time fell far behind the
    // AudioContext timeline, the pipeline starved. Re-anchor this packet to
    // play now; otherwise resumed audio would be considered late and dropped.
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
    source.connect(this.gainNode ?? ctx.destination);
    source.onended = () => {
      this.scheduledSources.delete(source);
      try { source.disconnect(); } catch {}
    };
    this.scheduledSources.add(source);
    source.start(scheduleAt);
    this.scheduledEnd = scheduleAt + numberOfFrames / sampleRate;
  }

  /**
   * Same scheduling logic as scheduleAudioData, but works on any sample
   * implementing the Web Audio / mediabunny copyTo interface (f32-planar).
   */
  private scheduleDecodedSampleInternal(
    ctx: AudioContext,
    sample: {
      numberOfChannels: number;
      numberOfFrames: number;
      sampleRate: number;
      timestamp: number;
      duration: number;
      copyTo: (destination: AllowSharedBufferSource, options: { planeIndex: number; format: "f32-planar" }) => void;
      close: () => void;
    },
  ) {
    const { sampleRate, numberOfChannels, numberOfFrames, timestamp } = sample;

    const mediaTimeSec = timestamp / 1_000_000;
    // AC-3 samples carry near-zero timestamps (e.g. 300μs); mediaStartSec
    // is set externally via setMediaStartSec. Use sequential scheduling.
    const isSequential = mediaTimeSec < 0.01 && this.mediaStartSec >= 0;

    if (this.mediaStartSec < 0) {
      this.mediaStartSec = mediaTimeSec;
    }

    if (this.ctxStartTime < 0) {
      sample.close();
      return;
    }

    const buffer = ctx.createBuffer(numberOfChannels, numberOfFrames, sampleRate);
    const tempBuf = new Float32Array(numberOfFrames);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      sample.copyTo(tempBuf.buffer, { planeIndex: ch, format: "f32-planar" });
      buffer.copyToChannel(tempBuf, ch);
    }
    sample.close();

    let scheduleAt: number;
    if (isSequential) {
      scheduleAt = this.scheduledEnd;
    } else {
      const relativeMediaTime = mediaTimeSec - this.mediaStartSec;
      scheduleAt = Math.max(
        this.ctxStartTime + relativeMediaTime,
        this.scheduledEnd,
      );
    }

    const lagBehindNow = ctx.currentTime - scheduleAt;
    if (lagBehindNow > 0.15) {
      const scheduledEndMediaSec = this.mediaStartSec + Math.max(0, this.scheduledEnd - this.ctxStartTime);
      this.ctxStartTime = ctx.currentTime;
      if (!isSequential) this.mediaStartSec = mediaTimeSec;
      else this.mediaStartSec = scheduledEndMediaSec;
      this.scheduledEnd = ctx.currentTime;
      scheduleAt = ctx.currentTime;
    }

    if (scheduleAt < ctx.currentTime - 0.1) {
      sample.close();
      return;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gainNode ?? ctx.destination);
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
   * This represents the clamped media position the audio pipeline can
   * actually sustain right now.
   */
  getCurrentAudioTimeSec(): number {
    return this.getClockSnapshot()?.currentTimeSec ?? -1;
  }

  /** Current audio-clock diagnostics for sync/stall logging */
  getClockSnapshot(): AudioClockSnapshot | null {
    const ctx = this.audioCtx;
    if (!ctx) return null;
    return computeAudioClockSnapshot({
      ctxCurrentTime: ctx.currentTime,
      ctxStartTime: this.ctxStartTime,
      mediaStartSec: this.mediaStartSec,
      scheduledEnd: this.scheduledEnd,
    });
  }

  /** Get how far ahead audio is scheduled (buffer depth in seconds) */
  getBufferedAheadSec(): number {
    const ctx = this.audioCtx;
    if (!ctx) return 0;
    return Math.max(0, this.scheduledEnd - ctx.currentTime);
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    this.applyGain();
  }

  getVolume(): number {
    return this.volume;
  }

  isMuted(): boolean {
    return this.muted;
  }

  private applyGain() {
    const gain = this.gainNode;
    if (!gain) return;
    gain.gain.value = this.muted ? 0 : this.volume;
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
    this.gainNode = null;
  }
}

export interface AudioClockSnapshot {
  currentTimeSec: number;
  freeRunSec: number;
  scheduledEndSec: number;
  bufferedAheadSec: number;
  clamped: boolean;
}

export function computeAudioClockSnapshot(input: {
  ctxCurrentTime: number;
  ctxStartTime: number;
  mediaStartSec: number;
  scheduledEnd: number;
}): AudioClockSnapshot | null {
  const { ctxCurrentTime, ctxStartTime, mediaStartSec, scheduledEnd } = input;
  if (ctxStartTime < 0 || mediaStartSec < 0) return null;
  if (scheduledEnd <= ctxStartTime) return null;

  const freeRunSec = mediaStartSec + Math.max(0, ctxCurrentTime - ctxStartTime);
  const scheduledEndSec = mediaStartSec + Math.max(0, scheduledEnd - ctxStartTime);
  const currentTimeSec = Math.min(freeRunSec, scheduledEndSec);
  return {
    currentTimeSec,
    freeRunSec,
    scheduledEndSec,
    bufferedAheadSec: Math.max(0, scheduledEnd - ctxCurrentTime),
    clamped: freeRunSec > scheduledEndSec + 0.001,
  };
}
