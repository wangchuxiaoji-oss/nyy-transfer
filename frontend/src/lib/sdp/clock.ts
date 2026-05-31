/**
 * SDP v2 — Playback clock
 *
 * Pure wall-clock based. AudioContext.currentTime is NOT used as clock source
 * because it keeps ticking when tab is hidden, causing time jumps.
 * Instead we use performance.now() with explicit pause/resume tracking.
 */

export class PlaybackClock {
  private startWallTime = 0;
  private startMediaTimeSec = 0;
  private paused = true;
  private pausedAtSec = 0;

  /** Start or resume the clock from a given media time */
  play(fromSec?: number) {
    if (fromSec !== undefined) {
      this.startMediaTimeSec = fromSec;
    } else if (this.paused) {
      this.startMediaTimeSec = this.pausedAtSec;
    }
    this.startWallTime = performance.now();
    this.paused = false;
  }

  /** Pause the clock, freezing current time */
  pause() {
    if (!this.paused) {
      this.pausedAtSec = this.getCurrentTimeSec();
      this.paused = true;
    }
  }

  /** Seek to a specific time (works whether paused or playing) */
  seekTo(timeSec: number) {
    if (this.paused) {
      this.pausedAtSec = timeSec;
    } else {
      this.startMediaTimeSec = timeSec;
      this.startWallTime = performance.now();
    }
  }

  /** Get current media time in seconds */
  getCurrentTimeSec(): number {
    if (this.paused) return this.pausedAtSec;
    const elapsedMs = performance.now() - this.startWallTime;
    return this.startMediaTimeSec + elapsedMs / 1000;
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
    this.pausedAtSec = 0;
    this.startWallTime = 0;
    this.startMediaTimeSec = 0;
  }
}
