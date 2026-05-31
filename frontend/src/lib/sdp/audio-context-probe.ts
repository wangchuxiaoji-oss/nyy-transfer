import type { DebugLogFn } from "@/lib/debug";

let probeStarted = false;

export function runAudioContextSuspendProbe(debugLog?: DebugLogFn) {
  if (probeStarted) return;
  if (typeof window === "undefined") return;

  const params = new URLSearchParams(window.location.search);
  if (params.get("audioClockProbe") !== "1") return;

  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    probeStarted = true;
    debugLog?.("sdp-v2", "audio-clock:probe:unsupported", { reason: "no-audio-context" });
    return;
  }

  probeStarted = true;
  void runAudioContextSuspendProbeInternal(AudioContextCtor, debugLog);
}

async function runAudioContextSuspendProbeInternal(
  AudioContextCtor: typeof AudioContext,
  debugLog?: DebugLogFn,
) {
  const ctx = new AudioContextCtor();
  try {
    if (ctx.state === "suspended") {
      await ctx.resume();
    }

    const runningStart = ctx.currentTime;
    await sleep(150);
    const runningEnd = ctx.currentTime;

    await ctx.suspend();
    const suspendedStart = ctx.currentTime;
    await sleep(250);
    const suspendedEnd = ctx.currentTime;

    await ctx.resume();
    const resumedStart = ctx.currentTime;
    await sleep(150);
    const resumedEnd = ctx.currentTime;

    const runningDelta = runningEnd - runningStart;
    const suspendedDelta = suspendedEnd - suspendedStart;
    const resumedDelta = resumedEnd - resumedStart;

    debugLog?.("sdp-v2", "audio-clock:probe:done", {
      runningDeltaSec: +runningDelta.toFixed(6),
      suspendedDeltaSec: +suspendedDelta.toFixed(6),
      resumedDeltaSec: +resumedDelta.toFixed(6),
      suspendFrozen: suspendedDelta < 0.02,
      resumeContinues: resumedDelta > 0.05,
      resumeGapSec: +(resumedStart - suspendedEnd).toFixed(6),
      finalState: ctx.state,
    });
  } catch (error) {
    debugLog?.("sdp-v2", "audio-clock:probe:error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await ctx.close();
    } catch {
      // ignore
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
