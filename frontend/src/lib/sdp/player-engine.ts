/**
 * SDP v2 — Player Engine
 *
 * Coordinates demuxer, video renderer, audio renderer, and clock.
 * Handles lifecycle (play/pause/seek/stop), visibility changes,
 * and the packet feeding loop with proper back-pressure.
 */

import type { PlayerConfig, PlayerState, VideoTrackInfo, AudioTrackInfo, BufferingState, BufferingReason } from "./types";
import type { DebugLogFn } from "@/lib/debug";
import { SdpDemuxer, type SourceReadStats } from "./demuxer";
import { VideoRenderer } from "./video-renderer";
import { AudioRenderer } from "./audio-renderer";
import { PlaybackClock } from "./clock";
import { PacketBuffer } from "./packet-buffer";
import { runAudioContextSuspendProbe } from "./audio-context-probe";

type MbEncodedPacket = InstanceType<typeof import("mediabunny").EncodedPacket>;

const VIDEO_KEY_CACHE_MAX_ENTRIES = 24;
const VIDEO_KEY_CACHE_MAX_REWIND_SEC = 15;
const VIDEO_KEY_INFLIGHT_REUSE_DISTANCE_SEC = 0.25;
const RECOVERY_BUFFER_TARGET_SEC = 3;
const SOURCE_READ_SPEED_STALE_MS = 2000;

interface SeekBufferingState {
  startSec: number | null;
  targetSec: number;
  decodedSec: number | null;
  ready: boolean;
}

export class PlayerEngine {
  private demuxer: SdpDemuxer;
  private videoRenderer: VideoRenderer | null = null;
  private audioRenderer: AudioRenderer | null = null;
  private clock = new PlaybackClock();
  private canvas: HTMLCanvasElement;
  private debugLog?: DebugLogFn;
  private disposed = false;
  private feedingVideo = false;
  private feedingAudio = false;
  private visibilityHandler: (() => void) | null = null;
  private playbackEpoch = 0;
  private seeking = false;
  private pendingSeekSec: number | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private visibilityResumeInFlight = false;
  private videoFeedEpoch: number | null = null;
  private audioFeedEpoch: number | null = null;
  private bufferingState: BufferingState | null = null;
  private lastSourceReadSpeedBytesPerSec: number | null = null;
  private lastSourceReadAtMs = 0;
  private stallLastMediaSec = 0;
  private stallLastAdvanceAtMs = 0;
  private seekBuffering: SeekBufferingState | null = null;
  private videoKeyPacketCache: Array<{ targetSec: number; packet: MbEncodedPacket }> = [];
  private videoKeyLookupInFlight: {
    targetSec: number;
    promise: Promise<MbEncodedPacket | null>;
  } | null = null;
  private resumeSeekSec: number | null = null;
  private seekWarmupGeneration = 0;
  /** Audio packet to resume from when play() is called after a paused seek */
  private resumeAudioPacket: MbEncodedPacket | null = null;
  /** Preload buffers — decouple network from decode timing */
  private videoBuffer: PacketBuffer | null = null;
  private audioBuffer: PacketBuffer | null = null;

  state: PlayerState = "idle";
  onStateChange: ((state: PlayerState) => void) | null = null;
  onTimeUpdate: ((sec: number) => void) | null = null;
  onBufferingChange: ((state: BufferingState | null) => void) | null = null;
  onError: ((msg: string) => void) | null = null;

  videoInfo: VideoTrackInfo | null = null;
  audioInfo: AudioTrackInfo | null = null;
  duration = 0;

  constructor(config: PlayerConfig) {
    this.canvas = config.canvas;
    this.debugLog = config.debugLog;
    this.demuxer = new SdpDemuxer(config.file, config.debugLog, (stats) => this.handleSourceRead(stats));
  }

  private handleSourceRead(stats: SourceReadStats) {
    this.lastSourceReadAtMs = performance.now();
    this.lastSourceReadSpeedBytesPerSec = stats.durationMs > 0 ? (stats.bytes * 1000) / stats.durationMs : null;
    this.updateBufferingState();
  }

  /** Initialize: parse file, configure decoders */
  async init(): Promise<void> {
    this.setState("loading");
    try {
      await this.demuxer.init();
    } catch (err) {
      // If disposed during init (e.g. React StrictMode unmount), silently bail
      if (this.disposed) return;
      this.handleError("Demuxer init failed: " + errMsg(err));
      return;
    }

    // Bail if disposed while awaiting
    if (this.disposed) return;

    this.videoInfo = this.demuxer.videoInfo;
    this.audioInfo = this.demuxer.audioInfo;
    this.duration = this.demuxer.duration;

    if (!this.videoInfo) {
      this.handleError("No video track found");
      return;
    }

    if (!this.audioInfo) {
      this.handleError("SDP v2 需要可解码音频轨；当前文件无音频，已禁用 SDP");
      return;
    }

    if (typeof AudioDecoder === "undefined" || typeof AudioDecoder.isConfigSupported !== "function") {
      this.handleError("SDP v2 需要 WebCodecs AudioDecoder；当前浏览器不支持音频主时钟");
      return;
    }

    const audioSupport = await AudioDecoder.isConfigSupported(this.audioInfo.decoderConfig).catch(() => null);
    if (!audioSupport?.supported) {
      this.handleError("SDP v2 需要可解码音频轨；当前音频配置不受支持，已禁用 SDP");
      return;
    }

    // Configure video renderer
    this.videoRenderer = new VideoRenderer(this.canvas, this.clock);
    this.videoRenderer.configure(this.videoInfo.decoderConfig);
    this.videoRenderer.onSeekDecodeProgress = (decodedSec) => this.handleSeekDecodeProgress(decodedSec);

    // Configure audio renderer
    this.audioRenderer = new AudioRenderer();
    await this.audioRenderer.configure(this.audioInfo.decoderConfig);
    this.clock.setAudioTimeProvider(() => this.audioRenderer?.getCurrentAudioTimeSec() ?? -1);

    // Create preload buffers
    this.videoBuffer = new PacketBuffer({
      label: "video",
      maxAheadSec: 30,
      debugLog: this.debugLog,
    });
    this.audioBuffer = new PacketBuffer({
      label: "audio",
      maxAheadSec: 30,
      debugLog: this.debugLog,
    });

    // Listen for visibility changes
    this.visibilityHandler = () => this.handleVisibilityChange();
    document.addEventListener("visibilitychange", this.visibilityHandler);

    this.setState("ready");
    this.debugLog?.("sdp-v2", "init:done", {
      video: this.videoInfo.codec,
      audio: this.audioInfo?.codec ?? null,
      duration: this.duration,
      width: this.videoInfo.codedWidth,
      height: this.videoInfo.codedHeight,
    });
  }

  /** Start playback */
  async play(): Promise<void> {
    if (this.disposed) return;
    this.clearEndTimer();
    if (this.state !== "ready" && this.state !== "paused") return;

    if (this.state === "paused" && !this.feedingVideo && this.resumeSeekSec !== null) {
      this.debugLog?.("sdp-v2", "seek:recover-start", {
        target: +this.resumeSeekSec.toFixed(3),
      });
      await this.seek(this.resumeSeekSec);
      // If the recovery seek also failed, stay paused instead of starting from 0.
      if (this.disposed || !this.feedingVideo) return;
    }

    const epoch = this.playbackEpoch;

    this.debugLog?.("sdp-v2", "play:start", {
      previousState: this.state,
      clockTime: this.clock.getCurrentTimeSec(),
    });

    // Start buffer filling BEFORE starting feed loops. The feed loops consume
    // via buffer.take(), which returns null when the buffer is not yet filling.
    // Starting feed first (especially audio) would also flip feedingAudio=true
    // and bypass the startFilling guards below, leaving the buffer dormant.
    // Skip audio startFilling when resumeAudioPacket is set — feedAudioLoop
    // will reset the buffer to the correct position itself.
    const videoSink = this.demuxer.getVideoSink();
    if (this.videoBuffer && videoSink && !this.videoBuffer.length && !this.feedingVideo) {
      this.videoBuffer.startFilling(videoSink);
    }
    const audioSink = this.demuxer.getAudioSink();
    if (this.audioBuffer && audioSink && !this.audioBuffer.length && !this.feedingAudio && !this.resumeAudioPacket) {
      this.audioBuffer.startFilling(audioSink);
    }

    // Audio: resume if suspended with baseline, else establish baseline + feed
    if (this.audioRenderer) {
      if (this.audioRenderer.hasBaseline()) {
        // Normal resume after pause — resume audio first, then clock
        await this.audioRenderer.resume();
      } else {
        // Fresh start or post-seek — set baseline and start feeding
        await this.audioRenderer.play();
        void this.feedAudioLoop(epoch, this.resumeAudioPacket ?? undefined);
        this.resumeAudioPacket = null;
      }
      runAudioContextSuspendProbe(this.debugLog);
    }

    this.setState("playing");
    this.clock.play();
    this.resetStallTracker();
    this.videoRenderer?.startRenderLoop();

    // Video feed loop parks on the clock gate when paused, so it may
    // already be running. Only start if not active.
    void this.feedVideoLoop(epoch);

    this.startTimeUpdates();
  }

  /** Pause playback */
  pause() {
    if (this.state !== "playing") return;
    this.clock.pause();
    // Feed loops keep running and naturally stop at the frozen clock gate.
    // Audio output is suspended; baseline is preserved for clean resume.
    void this.audioRenderer?.pause();
    this.clearBufferingState();
    this.setState("paused");
  }

  /** Warm keyframe lookup before the user commits a seek. */
  async prewarmSeek(targetSec: number): Promise<void> {
    if (this.disposed || this.seeking || !this.videoInfo || !this.duration) return;
    const clamped = Math.max(0, Math.min(targetSec, this.duration));
    const startedAt = performance.now();
    const generation = ++this.seekWarmupGeneration;
    const epoch = this.playbackEpoch;
    try {
      const result = await this.getVideoKeyPacketForSeek(clamped);
      if (generation !== this.seekWarmupGeneration || epoch !== this.playbackEpoch || this.seeking || this.disposed) return;
      this.debugLog?.("sdp-v2", "seek:warmup", {
        target: +clamped.toFixed(3),
        videoKeyTime: result.packet ? +result.packet.timestamp.toFixed(3) : null,
        cacheHit: result.cacheHit,
        inflightHit: result.inflightHit,
        cacheGapSec: result.cacheGapSec,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (err) {
      if (!this.disposed && generation === this.seekWarmupGeneration && epoch === this.playbackEpoch && !this.seeking) {
        this.debugLog?.("sdp-v2", "seek:warmup:error", {
          target: +clamped.toFixed(3),
          durationMs: Math.round(performance.now() - startedAt),
          error: errMsg(err),
        });
      }
    }
  }

  /**
   * Seek to a target time in seconds.
   * Strategy: bump epoch to kill current feed loops, reset decoders,
   * find nearest keyframe, restart feeding from there. Frames between
   * the keyframe and target are decoded but dropped by the renderer
   * (since clock is set to target, they're "late" and skipped).
   */
  async seek(targetSec: number): Promise<void> {
    if (this.disposed || !this.videoInfo) return;
    this.clearEndTimer();
    const clamped = Math.max(0, Math.min(targetSec, this.duration || targetSec));
    const seekStartPerf = performance.now();

    // Prevent overlapping seeks
    if (this.seeking) {
      this.pendingSeekSec = clamped;
      return;
    }
    this.seeking = true;

    const wasPlaying = this.state === "playing";
    const previousTimeSec = this.clock.getCurrentTimeSec();
    let autoResumeAfterError = false;
    this.setState("seeking");
    this.seekBuffering = {
      startSec: null,
      targetSec: clamped,
      decodedSec: null,
      ready: false,
    };
    this.beginBufferingState("seek");

    let epoch = this.playbackEpoch;
    try {
      // 1. Bump epoch — current feed loops will exit on next check
      this.playbackEpoch++;
      epoch = this.playbackEpoch;
      this.seekWarmupGeneration++;

      this.debugLog?.("sdp-v2", "seek:start", {
        target: +clamped.toFixed(3),
        epoch,
        wasPlaying,
      });

      // Ask any existing packet pumps to stop before we wait on them.
      await this.cancelCurrentPumps();
      await this.audioRenderer?.pause();

      // 2. Stop render loop + freeze clock at target
      this.videoRenderer?.stopRenderLoop();
      this.clock.pause();
      this.clock.seekTo(clamped);
      this.videoRenderer?.beginSeekSuppression();
      this.videoRenderer?.setSeekTargetUs(clamped * 1_000_000);

      // 3. Wait for old feed loops to actually exit
      const feedStop = await this.waitForFeedLoopsToStop();
      if (this.disposed || epoch !== this.playbackEpoch) {
        return;
      }

      // 4. Reset decoders (clears pipeline + frame queue + audio baseline)
      const resetStartPerf = performance.now();
      await this.videoRenderer?.reset(this.videoInfo.decoderConfig);
      if (this.audioInfo) {
        await this.audioRenderer?.reset(this.audioInfo.decoderConfig);
      }
      const resetMs = performance.now() - resetStartPerf;

      // 5. Find nearest keyframe at/before target
      const videoKeyStartPerf = performance.now();
      const videoKeyResult = await this.getVideoKeyPacketForSeek(clamped);
      const videoKeyPacket = videoKeyResult.packet;
      const videoKeyMs = performance.now() - videoKeyStartPerf;

      const audioPacketStartPerf = performance.now();
      const audioPacket = this.audioInfo
        ? await this.demuxer.getAudioPacket(clamped)
        : null;
      const audioPacketMs = performance.now() - audioPacketStartPerf;

      if (this.disposed || epoch !== this.playbackEpoch) {
        return;
      }

      if (this.seekBuffering) {
        const seekStartSec = videoKeyPacket?.timestamp ?? 0;
        this.seekBuffering.startSec = seekStartSec;
        this.seekBuffering.decodedSec = seekStartSec;
      }
      this.updateBufferingState();

      this.debugLog?.("sdp-v2", "seek:keyframe", {
        target: +clamped.toFixed(3),
        videoKeyTime: videoKeyPacket ? +videoKeyPacket.timestamp.toFixed(3) : null,
        audioTime: audioPacket ? +audioPacket.timestamp.toFixed(3) : null,
        videoKeyCacheHit: videoKeyResult.cacheHit,
        videoKeyInflightHit: videoKeyResult.inflightHit,
        videoKeyCacheGapSec: videoKeyResult.cacheGapSec,
        timing: {
          feedStopMs: Math.round(feedStop.elapsedMs),
          feedStopTimedOut: feedStop.timedOut,
          resetMs: Math.round(resetMs),
          videoKeyMs: Math.round(videoKeyMs),
          audioPacketMs: Math.round(audioPacketMs),
          totalMs: Math.round(performance.now() - seekStartPerf),
        },
      });

      // 6. Restart from keyframe with seek-suppressed display.
      //    The feed loop decodes hidden until it has reached the target,
      //    then commits the target frame and releases normal rendering.
      const seekPreviewReady = this.createDeferred<void>();
      this.videoRenderer?.startRenderLoop();
      void this.feedVideoLoop(epoch, videoKeyPacket ?? undefined, {
        seekTargetSec: clamped,
        onSeekPreviewReady: () => {
          this.markSeekBufferingReady();
          seekPreviewReady.resolve();
        },
        onSeekPreviewError: (error) => seekPreviewReady.reject(error),
      });

      if (wasPlaying) {
        await seekPreviewReady.promise;
        await nextAnimationFrame();
        if (this.audioRenderer) {
          await this.audioRenderer.play();
          void this.feedAudioLoop(epoch, audioPacket ?? undefined);
        }
        this.setState("playing");
        this.clock.play(clamped);
        this.resetStallTracker();
        this.updateBufferingState();
      } else {
        await seekPreviewReady.promise;
        // Stay paused: store audio resume point for the next play()
        this.setState("paused");
        this.resumeSeekSec = clamped;
        this.resumeAudioPacket = audioPacket;
        this.clearBufferingState();
      }
    } catch (err) {
      if (!this.disposed) {
        this.debugLog?.("sdp-v2", "seek:error", {
          target: +clamped.toFixed(3),
          epoch,
          wasPlaying,
          error: errMsg(err),
        });
        this.videoRenderer?.endSeekSuppression();
        this.clock.seekTo(previousTimeSec);
        this.resumeSeekSec = previousTimeSec;
        this.resumeAudioPacket = null;
        this.setState("paused");
        this.clearBufferingState();
        autoResumeAfterError = wasPlaying;
      }
    } finally {
      this.seeking = false;

      // Handle any seek requested while we were seeking
      if (this.pendingSeekSec !== null) {
        const next = this.pendingSeekSec;
        this.pendingSeekSec = null;
        void this.seek(next);
      } else if (autoResumeAfterError && !this.disposed) {
        void this.play();
      }
    }
  }

  /** Wait until both feed loops have stopped (with timeout) */
  private async waitForFeedLoopsToStop(): Promise<{ elapsedMs: number; timedOut: boolean }> {
    const start = performance.now();
    const deadline = start + 3000;
    while (this.feedingVideo || this.feedingAudio) {
      if (performance.now() > deadline) {
        this.debugLog?.("sdp-v2", "seek:feed-stop-timeout", {
          feedingVideo: this.feedingVideo,
          feedingAudio: this.feedingAudio,
        });
        return { elapsedMs: performance.now() - start, timedOut: true };
      }
      await sleep(16);
    }
    return { elapsedMs: performance.now() - start, timedOut: false };
  }

  private async cancelCurrentPumps(): Promise<void> {
    // Stop buffer filling (which owns the underlying iterators)
    this.videoBuffer?.stopFilling();
    this.audioBuffer?.stopFilling();
    this.debugLog?.("sdp-v2", "feed:cancel-request", {
      video: true,
      audio: true,
    });
  }

  private async getVideoKeyPacketForSeek(targetSec: number): Promise<{
    packet: MbEncodedPacket | null;
    cacheHit: boolean;
    inflightHit: boolean;
    cacheGapSec: number | null;
  }> {
    const cached = this.getCachedVideoKeyPacket(targetSec);
    if (cached) {
      return {
        packet: cached,
        cacheHit: true,
        inflightHit: false,
        cacheGapSec: +(targetSec - cached.timestamp).toFixed(3),
      };
    }

    const inFlight = this.videoKeyLookupInFlight;
    if (inFlight && Math.abs(inFlight.targetSec - targetSec) <= VIDEO_KEY_INFLIGHT_REUSE_DISTANCE_SEC) {
      const packet = await inFlight.promise;
      if (packet) this.cacheVideoKeyPacket(targetSec, packet);
      return {
        packet,
        cacheHit: false,
        inflightHit: true,
        cacheGapSec: packet ? +(targetSec - packet.timestamp).toFixed(3) : null,
      };
    }

    const promise = this.demuxer.getVideoKeyPacket(targetSec);
    this.videoKeyLookupInFlight = { targetSec, promise };
    try {
      const packet = await promise;
      if (packet) this.cacheVideoKeyPacket(targetSec, packet);
      return { packet, cacheHit: false, inflightHit: false, cacheGapSec: null };
    } finally {
      if (this.videoKeyLookupInFlight?.promise === promise) {
        this.videoKeyLookupInFlight = null;
      }
    }
  }

  private getCachedVideoKeyPacket(targetSec: number): MbEncodedPacket | null {
    let best: MbEncodedPacket | null = null;
    for (const entry of this.videoKeyPacketCache) {
      const packet = entry.packet;
      if (packet.timestamp > targetSec) continue;
      if (!best || packet.timestamp > best.timestamp) best = packet;
    }
    if (!best) return null;
    return targetSec - best.timestamp <= VIDEO_KEY_CACHE_MAX_REWIND_SEC
      ? best
      : null;
  }

  private cacheVideoKeyPacket(targetSec: number, packet: MbEncodedPacket) {
    const exists = this.videoKeyPacketCache.some(
      (entry) => Math.abs(entry.packet.timestamp - packet.timestamp) < 0.001,
    );
    if (exists) return;

    // Keep the original packet object so mediabunny can use it as
    // the startPacket for `sink.packets(startPacket)`.
    this.videoKeyPacketCache.push({ targetSec, packet });
    if (this.videoKeyPacketCache.length > VIDEO_KEY_CACHE_MAX_ENTRIES) {
      this.videoKeyPacketCache.shift();
    }
  }

  /** Stop and reset */
  stop() {
    this.playbackEpoch++;
    this.clearEndTimer();
    void this.cancelCurrentPumps();
    this.clock.pause();
    this.videoRenderer?.stopRenderLoop();
    this.videoRenderer?.clearFrameQueue();
    this.resumeSeekSec = null;
    this.resumeAudioPacket = null;
    this.clearBufferingState();
    this.setState("idle");
  }

  /** Dispose all resources */
  dispose() {
    this.disposed = true;
    this.playbackEpoch++;
    this.clearEndTimer();
    void this.cancelCurrentPumps();
    this.videoBuffer?.dispose();
    this.audioBuffer?.dispose();
    this.videoRenderer?.dispose();
    this.audioRenderer?.dispose();
    this.demuxer.dispose();
    this.clock.reset();
    this.resumeSeekSec = null;
    this.resumeAudioPacket = null;
    this.clearBufferingState();
    if (this.visibilityHandler) {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.setState("idle");
  }

  /** Feed video packets to decoder with back-pressure */
  private async feedVideoLoop(epoch: number, startPacket?: MbEncodedPacket, options?: { seekTargetSec?: number; onSeekPreviewReady?: () => void; onSeekPreviewError?: (error: unknown) => void }) {
    if (this.disposed) return;
    if (this.feedingVideo && this.videoFeedEpoch === epoch) return;
    this.feedingVideo = true;
    this.videoFeedEpoch = epoch;

    const sink = this.demuxer.getVideoSink();
    if (!sink || !this.videoRenderer || !this.videoBuffer) {
      this.feedingVideo = false;
      return;
    }

    // If startPacket provided (seek), reset buffer to fill from that point
    if (startPacket) {
      this.videoBuffer.reset(sink, startPacket);
    }

    this.debugLog?.("sdp-v2", "video:feed:start", { epoch, from: startPacket?.timestamp ?? 0, seekTarget: options?.seekTargetSec ?? null });
    let packetCount = 0;
    const LOOKAHEAD_SEC = 2; // only decode up to 2s ahead of clock
    let seekPreviewCommitted = false;
    let seekDecodeWindowStarted = false;
    let packetsDecodedAfterSeekTarget = 0;
    const SEEK_POST_TARGET_PACKETS = 6;

    try {
      while (true) {
        if (this.disposed || epoch !== this.playbackEpoch) break;

        const packet = await this.videoBuffer.take(
          () => this.disposed || epoch !== this.playbackEpoch,
        );
        if (!packet) break; // end of stream or aborted

        // Wait for decoder/frame queue to have space
        await this.videoRenderer.waitForSpace(
          () => this.disposed || epoch !== this.playbackEpoch,
        );
        if (this.disposed || epoch !== this.playbackEpoch) break;

        // Time-gate: don't decode too far ahead of playback clock
        const packetTimeSec = packet.timestamp; // mediabunny uses seconds
        while (!this.disposed && epoch === this.playbackEpoch) {
          const clockSec = this.clock.getCurrentTimeSec();
          if (packetTimeSec <= clockSec + LOOKAHEAD_SEC) break;
          // Wait a bit for clock to catch up
          await sleep(16);
        }
        if (this.disposed || epoch !== this.playbackEpoch) break;

        // Feed the chunk
        const chunk = packet.toEncodedVideoChunk();
        this.videoRenderer.decode(chunk);
        packetCount++;

        if (!seekPreviewCommitted && options?.seekTargetSec !== undefined) {
          if (packetTimeSec >= options.seekTargetSec) {
            seekDecodeWindowStarted = true;
          }
          if (seekDecodeWindowStarted) {
            packetsDecodedAfterSeekTarget++;
          }
          const seekTargetUs = options.seekTargetSec * 1_000_000;
          const committed =
            seekDecodeWindowStarted &&
            packetsDecodedAfterSeekTarget >= SEEK_POST_TARGET_PACKETS &&
            this.videoRenderer.hasFrameAtOrBefore(seekTargetUs) &&
            this.videoRenderer.commitSeekFrame(seekTargetUs);
          if (committed) {
            seekPreviewCommitted = true;
            options.onSeekPreviewReady?.();
          }
        }

        // Log progress every 300 packets (~10s of video at 30fps)
        if (packetCount % 300 === 0) {
          const clockSec = this.clock.getCurrentTimeSec();
          const audioClock = this.audioRenderer?.getClockSnapshot() ?? null;
          const audioTimeSec = audioClock?.currentTimeSec ?? -1;
          const avDriftMs = audioTimeSec >= 0
            ? Math.round((clockSec - audioTimeSec) * 1000)
            : null;

          this.debugLog?.("sdp-v2", "video:feed:progress", {
            packets: packetCount,
            clockSec: this.clock.getCurrentTimeSec(),
            audioTimeSec: audioTimeSec >= 0 ? +audioTimeSec.toFixed(3) : null,
            avDriftMs: audioTimeSec >= 0
              ? Math.round((this.clock.getCurrentTimeSec() - audioTimeSec) * 1000)
              : null,
            audioBufferedSec: this.audioRenderer?.getBufferedAheadSec() ?? null,
            audioClockClamped: audioClock?.clamped ?? null,
            audioFreeRunSec: audioClock ? +audioClock.freeRunSec.toFixed(3) : null,
            audioScheduledEndSec: audioClock ? +audioClock.scheduledEndSec.toFixed(3) : null,
            videoBufferSec: this.videoBuffer?.bufferedDurationSec ?? null,
            videoBufferPkts: this.videoBuffer?.length ?? null,
            queueLen: this.videoRenderer.queueLength,
            renderedFrames: this.videoRenderer.renderedFrames,
          });
        }
      }
      // All packets consumed — flush decoder (only if still current epoch)
      if (!this.disposed && epoch === this.playbackEpoch) {
        await this.videoRenderer.flush();
        if (!seekPreviewCommitted && options?.seekTargetSec !== undefined) {
          const committed = this.videoRenderer.commitSeekFrame(options.seekTargetSec * 1_000_000);
          if (committed) {
            seekPreviewCommitted = true;
            options.onSeekPreviewReady?.();
          }
        }
        this.debugLog?.("sdp-v2", "video:eof", {
          renderedFrames: this.videoRenderer.renderedFrames,
        });
        this.schedulePlaybackEnd(epoch);
      }
    } catch (err) {
      if (!seekPreviewCommitted && options?.seekTargetSec !== undefined) {
        options.onSeekPreviewError?.(err);
      }
      if (!this.disposed && epoch === this.playbackEpoch) {
        this.handleError("Video feed error: " + errMsg(err));
      }
    } finally {
      if (this.videoFeedEpoch === epoch) {
        this.feedingVideo = false;
        this.videoFeedEpoch = null;
      }
    }
  }

  private createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Feed audio packets to decoder */
  private async feedAudioLoop(epoch: number, startPacket?: MbEncodedPacket) {
    if (this.disposed || !this.audioRenderer) return;
    if (this.feedingAudio && this.audioFeedEpoch === epoch) return;
    this.feedingAudio = true;
    this.audioFeedEpoch = epoch;

    const sink = this.demuxer.getAudioSink();
    if (!sink || !this.audioBuffer) {
      this.feedingAudio = false;
      return;
    }

    // If startPacket provided (seek), reset buffer to fill from that point
    if (startPacket) {
      this.audioBuffer.reset(sink, startPacket);
    }

    try {
      const AUDIO_LOOKAHEAD_SEC = 3; // schedule audio slightly ahead
      while (true) {
        if (this.disposed || epoch !== this.playbackEpoch) break;

        const packet = await this.audioBuffer.take(
          () => this.disposed || epoch !== this.playbackEpoch,
        );
        if (!packet) break; // end of stream or aborted

        // Time-gate audio too
        const packetTimeSec = packet.timestamp;
        while (!this.disposed && epoch === this.playbackEpoch) {
          const clockSec = this.clock.getCurrentTimeSec();
          if (packetTimeSec <= clockSec + AUDIO_LOOKAHEAD_SEC) break;
          await sleep(32);
        }
        if (this.disposed || epoch !== this.playbackEpoch) break;

        const chunk = packet.toEncodedAudioChunk();
        this.audioRenderer!.decode(chunk);
      }
      if (!this.disposed && epoch === this.playbackEpoch) {
        await this.audioRenderer!.flush();
      }
    } catch (err) {
      if (!this.disposed && epoch === this.playbackEpoch) {
        this.debugLog?.("sdp-v2", "audio:error", { error: errMsg(err) });
      }
    } finally {
      if (this.audioFeedEpoch === epoch) {
        this.feedingAudio = false;
        this.audioFeedEpoch = null;
      }
    }
  }

  /** Handle page visibility changes */
  private handleVisibilityChange() {
    if (document.hidden && this.state === "playing") {
      const frozenAt = this.clock.getCurrentTimeSec();
      this.clock.pause();
      this.videoRenderer?.stopRenderLoop();
      this.videoRenderer?.clearFrameQueue();
      this.audioRenderer?.pause();
      this.clearBufferingState();
      this.debugLog?.("sdp-v2", "visibility:hidden", { frozenAt });
    } else if (!document.hidden && this.state === "playing") {
      void this.resumeFromVisibilityHidden();
    }
  }

  private async resumeFromVisibilityHidden() {
    if (this.visibilityResumeInFlight) return;
    this.visibilityResumeInFlight = true;
    const resumeFrom = this.clock.getCurrentTimeSec();
    const resumeStart = performance.now();
    try {
      await this.audioRenderer?.resume();
      if (this.disposed || document.hidden || this.state !== "playing") return;
      this.clock.play(resumeFrom);
      this.resetStallTracker();
      this.videoRenderer?.startRenderLoop();
      const clockSec = this.clock.getCurrentTimeSec();
      const audioTimeSec = this.audioRenderer?.getCurrentAudioTimeSec() ?? -1;
      this.debugLog?.("sdp-v2", "visibility:show", {
        resumeFrom,
        audioResumeMs: Math.round(performance.now() - resumeStart),
        clockSec,
        audioTimeSec: audioTimeSec >= 0 ? +audioTimeSec.toFixed(3) : null,
        avDriftMs: audioTimeSec >= 0 ? Math.round((clockSec - audioTimeSec) * 1000) : null,
      });
    } finally {
      this.visibilityResumeInFlight = false;
    }
  }

  private timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

  private startTimeUpdates() {
    if (this.timeUpdateInterval) return;
    this.timeUpdateInterval = setInterval(() => {
      if (this.state === "playing" && this.onTimeUpdate) {
        const rawTime = this.clock.getCurrentTimeSec();
        const currentTime = this.duration > 0 ? Math.min(rawTime, this.duration) : rawTime;
        this.onTimeUpdate(currentTime);
        if (this.duration > 0 && rawTime >= this.duration) {
          this.finishPlayback(this.playbackEpoch, "time-update");
          return;
        }
        this.updateStallState(rawTime);
      }
    }, 250);
  }

  private schedulePlaybackEnd(epoch: number) {
    this.clearEndTimer();
    if (this.duration <= 0) {
      this.finishPlayback(epoch, "eof-no-duration");
      return;
    }
    const clockSec = this.clock.getCurrentTimeSec();
    const remainingMs = Math.max(0, (this.duration - clockSec) * 1000);
    this.debugLog?.("sdp-v2", "ended:scheduled", {
      epoch,
      duration: this.duration,
      clockSec,
      remainingMs: Math.round(remainingMs),
    });
    if (remainingMs === 0) {
      this.finishPlayback(epoch, "eof-now");
    }
  }

  private resetStallTracker() {
    this.stallLastMediaSec = this.clock.getCurrentTimeSec();
    this.stallLastAdvanceAtMs = performance.now();
    if (this.bufferingState?.reason === "stall") {
      this.clearBufferingState();
    }
  }

  private updateStallState(rawTimeSec: number) {
    if (document.hidden || this.state !== "playing") return;

    if (rawTimeSec > this.stallLastMediaSec + 0.05) {
      this.stallLastMediaSec = rawTimeSec;
      this.stallLastAdvanceAtMs = performance.now();
      if (this.bufferingState?.reason === "stall") {
        this.clearBufferingState();
      }
      return;
    }

    const audioClock = this.audioRenderer?.getClockSnapshot() ?? null;
    const stalledForMs = performance.now() - this.stallLastAdvanceAtMs;
    const shouldStall = stalledForMs >= 1000 && (
      audioClock === null ||
      audioClock.clamped ||
      audioClock.bufferedAheadSec < 0.15
    );

    if (shouldStall) {
      this.beginBufferingState("stall", {
        stalledForMs: Math.round(stalledForMs),
        clockSec: +rawTimeSec.toFixed(3),
        audioTimeSec: audioClock ? +audioClock.currentTimeSec.toFixed(3) : null,
        audioBufferedSec: audioClock ? +audioClock.bufferedAheadSec.toFixed(3) : null,
        audioClockClamped: audioClock?.clamped ?? null,
      });
    }
  }

  private handleSeekDecodeProgress(decodedSec: number) {
    if (!this.seekBuffering || this.seekBuffering.ready || this.bufferingState?.reason !== "seek") return;
    if (this.seekBuffering.startSec === null) return;

    const previousDecodedSec = this.seekBuffering.decodedSec ?? this.seekBuffering.startSec;
    if (!Number.isFinite(decodedSec) || decodedSec <= previousDecodedSec) return;

    this.seekBuffering.decodedSec = decodedSec;
    this.updateBufferingState();
  }

  private markSeekBufferingReady() {
    if (!this.seekBuffering) return;

    this.seekBuffering.ready = true;
    this.seekBuffering.decodedSec = this.seekBuffering.targetSec;
    this.updateBufferingState();
  }

  private beginBufferingState(reason: BufferingReason, data?: Record<string, unknown>) {
    const wasBuffering = this.bufferingState?.reason === reason;
    this.bufferingState = this.createBufferingState(reason);
    this.onBufferingChange?.(this.bufferingState);
    if (!wasBuffering) {
      this.debugLog?.("sdp-v2", reason === "seek" ? "playback:seek-buffering" : "playback:stall", {
        progressPct: this.bufferingState.progressPct,
        speedBytesPerSec: this.bufferingState.speedBytesPerSec,
        progressSec: roundOptionalSec(this.bufferingState.progressSec),
        requiredSec: roundOptionalSec(this.bufferingState.requiredSec),
        ...data,
      });
    }
  }

  private updateBufferingState() {
    if (!this.bufferingState) return;

    this.bufferingState = this.createBufferingState(this.bufferingState.reason);
    this.onBufferingChange?.(this.bufferingState);

    if (
      this.bufferingState.reason === "seek" &&
      this.state === "playing" &&
      this.bufferingState.progressPct !== null &&
      this.bufferingState.progressPct >= 100
    ) {
      this.clearBufferingState();
    }
  }

  private createBufferingState(reason: BufferingReason): BufferingState {
    return reason === "seek" ? this.createSeekBufferingState() : this.createStallBufferingState();
  }

  private createSeekBufferingState(): BufferingState {
    const seek = this.seekBuffering;
    if (!seek || seek.startSec === null || seek.decodedSec === null) {
      return {
        reason: "seek",
        progressPct: null,
        speedBytesPerSec: this.getRecentSourceReadSpeedBytesPerSec(),
        progressSec: null,
        requiredSec: null,
      };
    }

    const startSec = seek.startSec;
    const targetSec = seek.targetSec;
    const requiredSec = Math.max(0, targetSec - startSec);
    const decodedSec = seek.decodedSec;
    const progressSec = seek.ready
      ? requiredSec
      : Math.max(0, Math.min(decodedSec - startSec, requiredSec));
    const progressPct = seek.ready
      ? 100
      : requiredSec <= 0
        ? 0
        : Math.min(99, Math.floor((progressSec / requiredSec) * 100));

    return {
      reason: "seek",
      progressPct,
      speedBytesPerSec: this.getRecentSourceReadSpeedBytesPerSec(),
      progressSec,
      requiredSec,
    };
  }

  private createStallBufferingState(): BufferingState {
    const progressSec = this.audioRenderer?.getClockSnapshot()?.bufferedAheadSec ?? 0;
    const requiredSec = RECOVERY_BUFFER_TARGET_SEC;
    const progressPct = requiredSec <= 0
      ? 0
      : Math.max(0, Math.min(100, Math.round((progressSec / requiredSec) * 100)));

    return {
      reason: "stall",
      progressPct,
      speedBytesPerSec: this.getRecentSourceReadSpeedBytesPerSec(),
      progressSec,
      requiredSec,
    };
  }

  private getRecentSourceReadSpeedBytesPerSec(): number | null {
    if (!this.lastSourceReadAtMs) return null;
    if (performance.now() - this.lastSourceReadAtMs > SOURCE_READ_SPEED_STALE_MS) return null;
    return this.lastSourceReadSpeedBytesPerSec;
  }

  private clearBufferingState() {
    const wasBuffering = this.bufferingState !== null;
    this.bufferingState = null;
    this.seekBuffering = null;
    if (!wasBuffering) return;
    this.onBufferingChange?.(null);
    this.debugLog?.("sdp-v2", "playback:resume");
  }

  private finishPlayback(epoch: number, reason: string) {
    if (this.disposed || epoch !== this.playbackEpoch || this.state === "ended") return;
    this.clearEndTimer();
    const finalTime = this.duration > 0 ? this.duration : this.clock.getCurrentTimeSec();
    this.clock.pause();
    this.clock.seekTo(finalTime);
    this.videoRenderer?.stopRenderLoop();
    void this.audioRenderer?.pause();
    this.clearBufferingState();
    this.onTimeUpdate?.(finalTime);
    this.setState("ended");
    this.debugLog?.("sdp-v2", "ended", {
      reason,
      epoch,
      finalTime,
      duration: this.duration,
    });
  }

  private clearEndTimer() {
    if (this.endTimer) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
  }

  private setState(s: PlayerState) {
    this.state = s;
    this.onStateChange?.(s);
  }

  private handleError(msg: string) {
    this.setState("error");
    this.onError?.(msg);
    this.debugLog?.("sdp-v2", "error", { error: msg });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function roundOptionalSec(value: number | null): number | null {
  return value === null ? null : +value.toFixed(3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
