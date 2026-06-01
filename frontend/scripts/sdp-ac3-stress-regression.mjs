import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "https://dev.nyy.app/UMklvq?sdp=1&debug=1";

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function numberArg(name, fallback) {
  const raw = argValue(name, String(fallback));
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number(fallback);
}

function boolArg(name, fallback) {
  const raw = argValue(name, fallback ? "1" : "0");
  return raw !== "0" && raw !== "false";
}

function sanitize(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (const ch of String(seed)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fmtSeconds(sec) {
  const safe = Math.max(0, Number(sec) || 0);
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = Math.floor(safe % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function createSeekSchedule({ rng, count, totalSeconds, finalSoakSeconds, maxSeekWaitSeconds, videoDurationSeconds }) {
  const seekStartSeconds = Math.min(30, Math.max(0, totalSeconds * 0.1));
  const seekEndSeconds = totalSeconds - finalSoakSeconds - maxSeekWaitSeconds;
  if (seekEndSeconds <= seekStartSeconds) {
    throw new Error(`测试时长不足：duration=${totalSeconds}s finalSoak=${finalSoakSeconds}s maxSeekWait=${maxSeekWaitSeconds}s`);
  }
  const targetMax = videoDurationSeconds * 0.95;
  return Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    atSeconds: seekStartSeconds + rng() * (seekEndSeconds - seekStartSeconds),
    targetSeconds: rng() * targetMax,
  })).sort((a, b) => a.atSeconds - b.atSeconds);
}

function latestEntry(entries, predicate) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (predicate(entries[i])) return entries[i];
  }
  return null;
}

function isExpectedPageError(message) {
  return /^seek cancelled(?: \(|$)/.test(String(message));
}

const config = {
  url: argValue("url", process.env.SDP_AC3_STRESS_URL || DEFAULT_URL),
  durationSeconds: numberArg("duration", process.env.SDP_AC3_STRESS_DURATION || 900),
  seekCount: numberArg("seeks", process.env.SDP_AC3_STRESS_SEEKS || 20),
  seed: argValue("seed", process.env.SDP_AC3_STRESS_SEED || String(Date.now())),
  finalSoakSeconds: numberArg("final-soak", process.env.SDP_AC3_STRESS_FINAL_SOAK || 120),
  maxSeekWaitSeconds: numberArg("max-seek-wait", process.env.SDP_AC3_STRESS_MAX_SEEK_WAIT || 30),
  recoveryBufferMinSeconds: numberArg("recovery-buffer-min", process.env.SDP_AC3_STRESS_RECOVERY_BUFFER_MIN || 3),
  maxBufferedAheadSeconds: numberArg("max-buffered-ahead", process.env.SDP_AC3_STRESS_MAX_BUFFERED_AHEAD || 35),
  maxBufferedAheadGraceSeconds: numberArg("max-buffered-ahead-grace", process.env.SDP_AC3_STRESS_MAX_BUFFERED_AHEAD_GRACE || 5),
  maxUnderflowGraceSeconds: numberArg("max-underflow-grace", process.env.SDP_AC3_STRESS_MAX_UNDERFLOW_GRACE || 5),
  maxFormalStalls: numberArg("max-stalls", process.env.SDP_AC3_STRESS_MAX_STALLS || 3),
  sampleIntervalMs: numberArg("sample-ms", process.env.SDP_AC3_STRESS_SAMPLE_MS || 1000),
  headless: boolArg("headless", process.env.SDP_AC3_STRESS_HEADLESS !== "0"),
  channel: argValue("channel", process.env.SDP_AC3_STRESS_CHANNEL || "chrome"),
  outputRoot: argValue("out-dir", process.env.SDP_AC3_STRESS_OUT_DIR || path.join(process.cwd(), "test-results", "sdp-ac3-stress")),
  reuseProfile: argValue("reuse-profile", process.env.SDP_AC3_STRESS_REUSE_PROFILE || ""),
  keepProfile: boolArg("keep-profile", process.env.SDP_AC3_STRESS_KEEP_PROFILE === "1"),
  trace: argValue("trace", process.env.SDP_AC3_STRESS_TRACE || "retain-on-failure"),
};

const seedNumber = hashSeed(config.seed);
const rng = mulberry32(seedNumber);
const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-seed-${sanitize(config.seed)}`;
const runDir = path.join(config.outputRoot, runId);
const reportPath = path.join(runDir, "report.json");
const eventsPath = path.join(runDir, "events.ndjson");
const debugLogPath = path.join(runDir, "debug-log.txt");
const summaryPath = path.join(runDir, "summary.txt");
const tracePath = path.join(runDir, "trace.zip");
const failureScreenshotPath = path.join(runDir, "failure.png");

await fs.mkdir(runDir, { recursive: true });

const runtimeEvents = [];
const debugLines = [];
const pageErrors = [];
const consoleMessages = [];
const failures = [];
const warnings = [];
const seekResults = [];
const healthSamples = [];
const sourceReads = [];
const formalStalls = [];
const ignoredInitialStalls = [];
const ignoredSeekRecoveryStalls = [];
const failureCodes = new Set();
const warningCodes = new Set();

let context = null;
let page = null;
let tempProfileDir = "";
let debugCursor = 0;
let formalMetricsStartWallMs = null;
let highBufferSinceMs = null;
let underflowSinceMs = null;
let maxBufferedAhead = 0;
let stallCountFailureReported = false;
let scriptError = null;
let finalSoak = null;
let schedule = [];
let videoDurationSeconds = 0;
let exitCode = 2;
let activeSeek = null;

function elapsedSeconds(startMs = testStartedAtMs) {
  return (Date.now() - startMs) / 1000;
}

function recordEvent(type, data = {}) {
  runtimeEvents.push({ ts: Date.now(), elapsedSeconds: round(elapsedSeconds(), 3), type, ...data });
}

function addFailure(code, message, details = {}) {
  if (failureCodes.has(code)) return;
  failureCodes.add(code);
  const item = { code, message, elapsedSeconds: round(elapsedSeconds(), 3), ...details };
  failures.push(item);
  console.log(`FAIL ${code}: ${message}`);
}

function addWarning(code, message, details = {}) {
  if (warningCodes.has(code)) return;
  warningCodes.add(code);
  const item = { code, message, elapsedSeconds: round(elapsedSeconds(), 3), ...details };
  warnings.push(item);
  console.log(`WARN ${code}: ${message}`);
}

function makeSeekResult(active, state, ok, reason, details = {}) {
  const finalPos = Number(state?.pos);
  const bufferedAhead = Number(state?.latestAudio?.bufferedAhead);
  return {
    index: active.item.index,
    scheduledAtSeconds: round(active.item.atSeconds, 3),
    actualAtSeconds: round(active.startedAtElapsedSeconds, 3),
    completedAtSeconds: round(elapsedSeconds(), 3),
    targetSeconds: round(active.item.targetSeconds, 3),
    beforePos: round(Number(active.beforeState?.pos), 3),
    finalPos: round(finalPos, 3),
    bufferedAhead: round(bufferedAhead, 3),
    waitMs: Date.now() - active.startedAtMs,
    ok,
    superseded: reason === "superseded",
    reason,
    finalState: state,
    ...details,
  };
}

function recordSeekResult(result) {
  seekResults.push(result);
  if (result.ok === false) {
    addFailure(`seek_${result.index}_recovery`, `第 ${result.index} 次 seek 未在 ${config.maxSeekWaitSeconds}s 内恢复到目标窗口`, result);
  }
  const label = result.superseded ? "SUPERSEDED" : result.ok ? "PASS" : "FAIL";
  console.log(`#${result.index}/${schedule.length} target=${round(result.targetSeconds, 1)} final=${result.finalPos} buffer=${result.bufferedAhead} wait=${round(result.waitMs / 1000, 1)}s ${label}`);
}

function finishActiveSeek(ok, state, reason, details = {}) {
  if (!activeSeek) return;
  const result = makeSeekResult(activeSeek, state, ok, reason, details);
  activeSeek = null;
  recordSeekResult(result);
}

function checkActiveSeekRecovery(state) {
  if (!activeSeek) return;
  const pos = Number(state.pos);
  const target = activeSeek.item.targetSeconds;
  const inSeekWindow = Number.isFinite(pos) && pos >= target + 2 && pos <= target + 15;
  const notClamped = state.latestAudio?.audioClockClamped !== true;
  if (inSeekWindow && notClamped) {
    finishActiveSeek(true, state, "recovered");
    return;
  }
  if (Date.now() - activeSeek.startedAtMs >= config.maxSeekWaitSeconds * 1000) {
    finishActiveSeek(false, state, "timeout");
  }
}

async function drainDebugEntries(phase = "") {
  const effectivePhase = activeSeek ? "seek-recovery" : phase;
  if (!page) return [];
  const entries = await page.evaluate(() => {
    const win = window;
    return Array.isArray(win.__nyyDebugEntries) ? win.__nyyDebugEntries : [];
  }).catch(() => []);
  if (entries.length < debugCursor) debugCursor = 0;
  const fresh = entries.slice(debugCursor);
  debugCursor = entries.length;
  for (const entry of fresh) {
    runtimeEvents.push({ type: "debug", ...entry });
    if (entry.line) debugLines.push(entry.line);
    if (entry.scope === "sdp-v2" && entry.event === "source:read" && entry.data) {
      sourceReads.push(entry.data);
    }
    if (entry.scope === "sdp-v2" && entry.event === "playback:stall") {
      if (effectivePhase === "seek-recovery") {
        ignoredSeekRecoveryStalls.push(entry);
      } else if (formalMetricsStartWallMs !== null && entry.ts >= formalMetricsStartWallMs) {
        formalStalls.push(entry);
        if (formalStalls.length > config.maxFormalStalls && !stallCountFailureReported) {
          stallCountFailureReported = true;
          addFailure("stall_count", `正式阶段 stall 次数超过 ${config.maxFormalStalls}`, { count: formalStalls.length });
        }
      } else {
        ignoredInitialStalls.push(entry);
      }
    }
  }
  return fresh;
}

async function readPlaybackState() {
  return page.evaluate(() => {
    const progress = document.querySelector('input[aria-label="播放进度"]')
      || Array.from(document.querySelectorAll('input[type="range"]')).find((input) => Number(input.max) > 10);
    const entries = Array.isArray(window.__nyyDebugEntries) ? window.__nyyDebugEntries : [];
    const latestAudio = (() => {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.scope === "sdp-v2" && entry.event === "audio:ac3:schedule") return entry;
      }
      return null;
    })();
    const latestStall = (() => {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.scope === "sdp-v2" && entry.event === "playback:stall") return entry;
      }
      return null;
    })();
    const latestSeek = (() => {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.scope === "sdp-v2" && entry.event === "seek:start") return entry;
      }
      return null;
    })();
    const text = document.body.innerText || "";
    return {
      progressFound: Boolean(progress),
      pos: progress ? Number(progress.value) : null,
      duration: progress ? Number(progress.max) : null,
      progressDisabled: progress ? Boolean(progress.disabled) : null,
      bufferingText: /缓冲中|定位中|加载中/.test(text),
      debugLength: entries.length,
      latestAudio: latestAudio?.data ?? null,
      latestStall: latestStall?.data ?? null,
      latestSeek: latestSeek?.data ?? null,
      stateText: text.split("\n").filter((line) => line.includes("SelfDevelopPlayer") || line.includes("当前状态") || line.includes("SDP MP4")).slice(0, 8),
    };
  });
}

function recordHealthSample(phase, state, extra = {}) {
  const effectivePhase = activeSeek ? "seek-recovery" : phase;
  const bufferedAhead = Number(state.latestAudio?.bufferedAhead);
  const audioClockClamped = state.latestAudio?.audioClockClamped === true;
  const pos = Number(state.pos);
  const sample = {
    atSeconds: round(elapsedSeconds(), 3),
    phase: effectivePhase,
    pos: Number.isFinite(pos) ? round(pos, 3) : null,
    bufferedAhead: Number.isFinite(bufferedAhead) ? round(bufferedAhead, 3) : null,
    audioClockClamped,
    bufferingText: state.bufferingText,
    ...extra,
  };
  healthSamples.push(sample);
  runtimeEvents.push({ type: "health", ts: Date.now(), ...sample });

  if (!Number.isFinite(bufferedAhead)) return sample;
  maxBufferedAhead = Math.max(maxBufferedAhead, bufferedAhead);
  if (formalMetricsStartWallMs === null) return sample;

  const now = Date.now();
  if (bufferedAhead > config.maxBufferedAheadSeconds) {
    highBufferSinceMs ??= now;
    const highForSeconds = (now - highBufferSinceMs) / 1000;
    if (highForSeconds >= config.maxBufferedAheadGraceSeconds) {
      addFailure("buffer_high", `bufferedAhead 超过 ${config.maxBufferedAheadSeconds}s 持续 ${round(highForSeconds, 1)}s`, {
        bufferedAhead: round(bufferedAhead, 3),
        phase: effectivePhase,
      });
    } else if (bufferedAhead > config.maxBufferedAheadSeconds + 2) {
      addWarning("buffer_high_spike", `bufferedAhead 瞬时超过 ${config.maxBufferedAheadSeconds + 2}s`, {
        bufferedAhead: round(bufferedAhead, 3),
        phase,
      });
    }
  } else {
    highBufferSinceMs = null;
  }

  if (effectivePhase === "seek-recovery") {
    underflowSinceMs = null;
    return sample;
  }

  const underflow = bufferedAhead <= 0.15 || audioClockClamped;
  if (underflow) {
    underflowSinceMs ??= now;
    const underflowForSeconds = (now - underflowSinceMs) / 1000;
    if (underflowForSeconds >= config.maxUnderflowGraceSeconds) {
      addFailure("audio_underflow", `音频断流或 clamped 持续 ${round(underflowForSeconds, 1)}s`, {
        bufferedAhead: round(bufferedAhead, 3),
        audioClockClamped,
        phase: effectivePhase,
      });
    }
  } else {
    underflowSinceMs = null;
  }
  return sample;
}

async function waitWithMonitoring(untilElapsedSeconds, phase) {
  while (elapsedSeconds() < untilElapsedSeconds) {
    const pollingIntervalMs = activeSeek ? Math.min(250, config.sampleIntervalMs) : config.sampleIntervalMs;
    await page.waitForTimeout(Math.min(pollingIntervalMs, Math.max(100, (untilElapsedSeconds - elapsedSeconds()) * 1000)));
    await drainDebugEntries(phase);
    const state = await readPlaybackState();
    recordHealthSample(phase, state);
    checkActiveSeekRecovery(state);
  }
}

async function waitForInitialHealthy(timeoutMs) {
  const started = Date.now();
  let lastState = null;
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(config.sampleIntervalMs);
    await drainDebugEntries("initial");
    lastState = await readPlaybackState();
    recordHealthSample("initial", lastState);
    const bufferedAhead = Number(lastState.latestAudio?.bufferedAhead);
    const pos = Number(lastState.pos);
    if (Number.isFinite(bufferedAhead) && bufferedAhead >= config.recoveryBufferMinSeconds && Number.isFinite(pos) && pos >= 1) {
      formalMetricsStartWallMs = Date.now();
      recordEvent("formal-metrics-start", { bufferedAhead: round(bufferedAhead, 3), pos: round(pos, 3) });
      return { ok: true, state: lastState, waitMs: Date.now() - started };
    }
  }
  return { ok: false, state: lastState, waitMs: Date.now() - started };
}

async function seekTo(targetSeconds) {
  return page.evaluate((target) => {
    if (typeof window.__nyySdpSeek === "function") {
      return window.__nyySdpSeek(target) !== false;
    }
    const progress = document.querySelector('input[aria-label="播放进度"]')
      || Array.from(document.querySelectorAll('input[type="range"]')).find((input) => Number(input.max) > 10);
    if (!(progress instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(progress, String(target));
    progress.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    progress.dispatchEvent(new Event("input", { bubbles: true }));
    progress.dispatchEvent(new Event("change", { bubbles: true }));
    progress.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  }, targetSeconds);
}

async function readVideoDurationFromProgress() {
  await page.locator('input[aria-label="播放进度"]').first().waitFor({ state: "attached", timeout: 60_000 });
  await page.waitForFunction(() => {
    const progress = document.querySelector('input[aria-label="播放进度"]');
    return progress && Number(progress.max) > 0;
  }, { timeout: 60_000 });
  const value = await page.evaluate(() => Number(document.querySelector('input[aria-label="播放进度"]')?.max ?? 0));
  if (!Number.isFinite(value) || value <= 0) throw new Error("无法读取播放进度条 duration");
  return value;
}

async function writeArtifacts(report) {
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  await fs.writeFile(eventsPath, runtimeEvents.map((event) => JSON.stringify(event)).join("\n") + "\n");
  await fs.writeFile(debugLogPath, debugLines.join("\n") + "\n");
  const sourceReadDurations = sourceReads.map((item) => Number(item.durationMs)).filter(Number.isFinite);
  const lines = [
    "# SDP AC3 Stress Regression",
    `status: ${report.passed ? "PASS" : "FAIL"}`,
    `url: ${config.url}`,
    `seed: ${config.seed}`,
    `duration: ${config.durationSeconds}s`,
    `seeks: pass=${report.seekPassCount} fail=${report.seekFailCount} superseded=${report.seekSupersededCount}/${config.seekCount}`,
    `formal stalls: ${formalStalls.length}`,
    `ignored initial stalls: ${ignoredInitialStalls.length}`,
    `ignored seek-recovery stalls: ${ignoredSeekRecoveryStalls.length}`,
    `max bufferedAhead: ${round(maxBufferedAhead, 3)}s`,
    `source read p95: ${percentile(sourceReadDurations, 95) ?? "n/a"}ms`,
    `failures: ${failures.length}`,
    `warnings: ${warnings.length}`,
    `report: ${reportPath}`,
  ];
  if (failures.length) {
    lines.push("", "## Failures", ...failures.map((failure) => `- ${failure.code}: ${failure.message}`));
  }
  if (warnings.length) {
    lines.push("", "## Warnings", ...warnings.map((warning) => `- ${warning.code}: ${warning.message}`));
  }
  await fs.writeFile(summaryPath, `${lines.join("\n")}\n`);
}

function buildReport() {
  const sourceReadDurations = sourceReads.map((item) => Number(item.durationMs)).filter(Number.isFinite);
  const seekPassCount = seekResults.filter((item) => item.ok === true).length;
  const seekFailCount = seekResults.filter((item) => item.ok === false).length;
  const seekSupersededCount = seekResults.filter((item) => item.superseded).length;
  const expectedPageErrors = pageErrors.filter(isExpectedPageError);
  const unexpectedPageErrors = pageErrors.filter((message) => !isExpectedPageError(message));
  return {
    passed: failures.length === 0 && scriptError === null,
    exitCode,
    config,
    runDir,
    schedule,
    videoDurationSeconds: round(videoDurationSeconds, 3),
    seekPassCount,
    seekFailCount,
    seekSupersededCount,
    seekResults,
    finalSoak,
    health: {
      sampleCount: healthSamples.length,
      maxBufferedAhead: round(maxBufferedAhead, 3),
      formalStallCount: formalStalls.length,
      ignoredInitialStallCount: ignoredInitialStalls.length,
      ignoredSeekRecoveryStallCount: ignoredSeekRecoveryStalls.length,
      pageErrorCount: pageErrors.length,
      expectedPageErrorCount: expectedPageErrors.length,
      unexpectedPageErrorCount: unexpectedPageErrors.length,
      consoleMessageCount: consoleMessages.length,
      sourceReadCount: sourceReads.length,
      sourceReadP50Ms: percentile(sourceReadDurations, 50),
      sourceReadP95Ms: percentile(sourceReadDurations, 95),
      sourceReadMaxMs: sourceReadDurations.length ? Math.max(...sourceReadDurations) : null,
    },
    failures,
    warnings,
    pageErrors,
    expectedPageErrors,
    unexpectedPageErrors,
    consoleMessages: consoleMessages.slice(-100),
    scriptError,
    artifacts: {
      reportPath,
      eventsPath,
      debugLogPath,
      summaryPath,
      tracePath: failures.length || scriptError ? tracePath : null,
      failureScreenshotPath: failures.length || scriptError ? failureScreenshotPath : null,
    },
  };
}

const testStartedAtMs = Date.now();

try {
  console.log("=== SDP AC3 Stress Regression ===");
  console.log(JSON.stringify({ ...config, runDir }, null, 2));

  tempProfileDir = config.reuseProfile || await fs.mkdtemp(path.join(os.tmpdir(), "nyy-sdp-ac3-stress-profile-"));
  const launchOptions = {
    headless: config.headless,
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--autoplay-policy=no-user-gesture-required",
    ],
  };
  if (config.channel && config.channel !== "bundled") launchOptions.channel = config.channel;

  context = await chromium.launchPersistentContext(tempProfileDir, launchOptions);
  if (config.trace !== "off") {
    await context.tracing.start({ screenshots: true, snapshots: true });
  }
  page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    recordEvent("pageerror", { message: error.message });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (/error|warning|AudioSample|garbage|playback:stall/i.test(text)) {
      consoleMessages.push({ type: message.type(), text: text.slice(0, 500) });
    }
  });

  await page.goto(config.url, { waitUntil: "networkidle", timeout: 90_000 });
  recordEvent("page-open", { url: config.url });

  await page.getByRole("button", { name: /SDP 预览|预览/ }).first().click({ timeout: 60_000 });
  recordEvent("preview-click");
  await page.locator('input[aria-label="播放进度"]').first().waitFor({ state: "attached", timeout: 90_000 });
  videoDurationSeconds = numberArg("video-duration", process.env.SDP_AC3_STRESS_VIDEO_DURATION || 0) || await readVideoDurationFromProgress();

  await page.getByRole("button", { name: "播放" }).first().click({ timeout: 30_000 }).catch(() => undefined);
  recordEvent("play-click");

  schedule = createSeekSchedule({
    rng,
    count: config.seekCount,
    totalSeconds: config.durationSeconds,
    finalSoakSeconds: config.finalSoakSeconds,
    maxSeekWaitSeconds: config.maxSeekWaitSeconds,
    videoDurationSeconds,
  });

  console.log("\n==== 随机拖动计划 ====");
  for (const item of schedule) {
    console.log(`#${item.index} at ${round(item.atSeconds, 1)}s -> ${fmtSeconds(item.targetSeconds)} (${round(item.targetSeconds, 1)}s)`);
  }
  console.log("====================\n");

  const initialHealthy = await waitForInitialHealthy(90_000);
  if (!initialHealthy.ok) {
    addFailure("initial_not_healthy", "初始播放未在 90s 内达到音频缓冲恢复条件", { state: initialHealthy.state });
  } else {
    console.log(`初始播放健康：${round(initialHealthy.waitMs / 1000, 1)}s`);
  }

  for (const item of schedule) {
    await waitWithMonitoring(item.atSeconds, "between-seeks");
    await drainDebugEntries("between-seeks");
    const beforeState = await readPlaybackState();
    checkActiveSeekRecovery(beforeState);
    if (activeSeek) {
      finishActiveSeek(null, beforeState, "superseded", { supersededByIndex: item.index });
    }
    const committed = await seekTo(item.targetSeconds);
    recordEvent("seek-commit", { seekIndex: item.index, targetSeconds: round(item.targetSeconds, 3), committed });
    if (!committed) {
      addFailure(`seek_${item.index}_commit`, `第 ${item.index} 次拖动未能提交`, { targetSeconds: item.targetSeconds });
      recordSeekResult({
        index: item.index,
        scheduledAtSeconds: round(item.atSeconds, 3),
        actualAtSeconds: round(elapsedSeconds(), 3),
        completedAtSeconds: round(elapsedSeconds(), 3),
        targetSeconds: round(item.targetSeconds, 3),
        beforePos: round(Number(beforeState.pos), 3),
        finalPos: round(Number(beforeState.pos), 3),
        bufferedAhead: round(Number(beforeState.latestAudio?.bufferedAhead), 3),
        waitMs: 0,
        ok: false,
        superseded: false,
        reason: "commit failed",
        finalState: beforeState,
      });
      continue;
    }
    activeSeek = {
      item,
      beforeState,
      startedAtMs: Date.now(),
      startedAtElapsedSeconds: elapsedSeconds(),
    };
  }

  const finalSoakPlannedStartSeconds = config.durationSeconds - config.finalSoakSeconds;
  if (elapsedSeconds() < finalSoakPlannedStartSeconds) {
    await waitWithMonitoring(finalSoakPlannedStartSeconds, "before-final-soak");
  }
  if (activeSeek) {
    const state = await readPlaybackState();
    checkActiveSeekRecovery(state);
  }
  if (activeSeek) {
    const state = await readPlaybackState();
    finishActiveSeek(false, state, "not settled before final soak");
  }

  const finalStartWallMs = Date.now();
  const finalStartState = await readPlaybackState();
  const deadlineMs = testStartedAtMs + config.durationSeconds * 1000;
  while (Date.now() < deadlineMs) {
    const pollingIntervalMs = activeSeek ? Math.min(250, config.sampleIntervalMs) : config.sampleIntervalMs;
    await page.waitForTimeout(Math.min(pollingIntervalMs, Math.max(100, deadlineMs - Date.now())));
    await drainDebugEntries("final-soak");
    const state = await readPlaybackState();
    recordHealthSample("final-soak", state);
    checkActiveSeekRecovery(state);
  }
  const finalEndState = await readPlaybackState();
  const finalSoakSecondsActual = (Date.now() - finalStartWallMs) / 1000;
  const finalAdvance = Number(finalEndState.pos) - Number(finalStartState.pos);
  const finalAdvanceRatio = finalSoakSecondsActual > 0 ? finalAdvance / finalSoakSecondsActual : null;
  finalSoak = {
    plannedSeconds: config.finalSoakSeconds,
    actualSeconds: round(finalSoakSecondsActual, 3),
    startPos: round(Number(finalStartState.pos), 3),
    endPos: round(Number(finalEndState.pos), 3),
    advanceSeconds: round(finalAdvance, 3),
    advanceRatio: round(finalAdvanceRatio ?? NaN, 3),
  };
  if (finalSoakSecondsActual < config.finalSoakSeconds * 0.9) {
    addFailure("final_soak_short", `Final soak 不足 ${round(config.finalSoakSeconds * 0.9, 1)}s`, finalSoak);
  }
  if (finalSoakSecondsActual >= 30 && Number.isFinite(finalAdvanceRatio) && (finalAdvanceRatio < 0.5 || finalAdvanceRatio > 1.5)) {
    addFailure("final_soak_progress_rate", "Final soak 播放推进速率异常", finalSoak);
  }

  await drainDebugEntries();
  const unexpectedPageErrors = pageErrors.filter((message) => !isExpectedPageError(message));
  if (unexpectedPageErrors.length > 0) {
    addFailure("page_errors", "页面存在未捕获 JS 异常", { count: unexpectedPageErrors.length, sample: unexpectedPageErrors.slice(-5) });
  }
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  scriptError = error instanceof Error ? { message: error.message, stack: error.stack } : { message: String(error) };
  console.error("\n=== SDP AC3 stress regression crashed ===");
  console.error(error);
  exitCode = 2;
} finally {
  try {
    await drainDebugEntries();
  } catch {}
  if (page && exitCode !== 0) {
    await page.screenshot({ path: failureScreenshotPath, fullPage: true }).catch(() => undefined);
  }
  if (context) {
    if (config.trace !== "off") {
      if (exitCode !== 0) await context.tracing.stop({ path: tracePath }).catch(() => undefined);
      else await context.tracing.stop().catch(() => undefined);
    }
    await context.close().catch(() => undefined);
  }
  if (!config.reuseProfile && tempProfileDir && !config.keepProfile) {
    await fs.rm(tempProfileDir, { recursive: true, force: true }).catch(() => undefined);
  }
  const report = buildReport();
  await writeArtifacts(report).catch((error) => console.error("写入测试报告失败", error));
  console.log("\n========== SDP AC3 STRESS REPORT ==========");
  console.log(`Status: ${report.passed ? "PASS" : "FAIL"}`);
  console.log(`Run dir: ${runDir}`);
  console.log(`Seeks: pass=${report.seekPassCount} fail=${report.seekFailCount} superseded=${report.seekSupersededCount}/${config.seekCount}`);
  console.log(`Formal stalls: ${formalStalls.length}, ignored initial stalls: ${ignoredInitialStalls.length}, ignored seek-recovery stalls: ${ignoredSeekRecoveryStalls.length}`);
  console.log(`Max bufferedAhead: ${round(maxBufferedAhead, 3)}s`);
  console.log(`Failures: ${failures.length}, warnings: ${warnings.length}`);
  console.log("==========================================\n");
  process.exit(exitCode);
}
