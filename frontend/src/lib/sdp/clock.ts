/**
 * SDP v2 — Playback clock
 *
 * Audio-driven clock with a frozen floor. When audio is unavailable, the
 * clock stays frozen at the last committed media time instead of advancing
 * on wall time.
 */

export type AudioTimeProvider = () => number;

export class PlaybackClock {
  private audioTimeProvider: AudioTimeProvider | null = null;
  private paused = true;
  private frozenAtSec = 0;

  setAudioTimeProvider(provider: AudioTimeProvider) {
    this.audioTimeProvider = provider;
  }

  /** Start or resume the clock from a given media time */
  play(fromSec?: number) {
    if (fromSec !== undefined) {
      this.frozenAtSec = fromSec;
    } else if (this.paused) {
      this.frozenAtSec = this.getCurrentTimeSec();
    }
    this.paused = false;
  }

  /** Pause the clock, freezing current time */
  pause() {
    if (!this.paused) {
      this.frozenAtSec = this.getCurrentTimeSec();
      this.paused = true;
    }
  }

  /** Seek to a specific time (works whether paused or playing) */
  seekTo(timeSec: number) {
    this.frozenAtSec = timeSec;
  }

  /** Get current media time in seconds */
  getCurrentTimeSec(): number {
    if (this.paused) return this.frozenAtSec;
    const audioTimeSec = this.audioTimeProvider?.() ?? -1;
    if (audioTimeSec < 0) return this.frozenAtSec;
    return Math.max(this.frozenAtSec, audioTimeSec);
  }

  /** Get current media time in microseconds */
  getCurrentTimeUs(): number {
    return this.getCurrentTimeSec() * 1_000_000;
  }

  /** Whether the clock is currently paused */
  isPaused(): boolean {
    return this.paused;
  }

  /** Reset clock to initial state */
  reset() {
    this.paused = true;
    this.frozenAtSec = 0;
  }
}
