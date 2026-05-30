import { chromium } from "@playwright/test";

const DEFAULT_URL = "https://dev.nyy.app/bpJpXZ?sdp=1&debug=1";

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function numberArg(name, fallback) {
  const value = Number(argValue(name, fallback));
  return Number.isFinite(value) ? value : Number(fallback);
}

const url = argValue("url", process.env.MKV_DRIFT_URL || DEFAULT_URL);
const durationSeconds = numberArg("duration", process.env.MKV_DRIFT_DURATION || 180);
const warmupSeconds = numberArg("warmup", process.env.MKV_DRIFT_WARMUP || 45);
const stableRenderedFrames = numberArg("stable-rendered", process.env.MKV_DRIFT_STABLE_RENDERED || 600);
const intervalMs = numberArg("interval-ms", process.env.MKV_DRIFT_INTERVAL_MS || 1000);
const maxAvgDriftMs = numberArg("max-avg-ms", process.env.MKV_DRIFT_MAX_AVG_MS || 20);
const maxPeakDriftMs = numberArg("max-peak-ms", process.env.MKV_DRIFT_MAX_PEAK_MS || 50);
const headless = (process.env.MKV_DRIFT_HEADLESS || "0") !== "0";
const disableGpu = (process.env.MKV_DRIFT_DISABLE_GPU || "0") !== "0";

function summarize(samples) {
  if (samples.length === 0) return null;
  const values = samples.map((sample) => Math.abs(sample.driftMs));
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  const max = Math.max(...values);
  const min = Math.min(...values);
  return { avg, max, min, range: max - min, count: values.length };
}

async function clickIfVisible(locator) {
  if (await locator.isVisible().catch(() => false)) {
    await locator.click();
    return true;
  }
  return false;
}

const browserArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--autoplay-policy=no-user-gesture-required",
];
if (disableGpu) browserArgs.push("--disable-gpu");

const browser = await chromium.launch({
  headless,
  args: browserArgs,
});

const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  console.log("=== MKV Drift Regression ===");
  console.log(JSON.stringify({ url, durationSeconds, warmupSeconds, stableRenderedFrames, intervalMs, maxAvgDriftMs, maxPeakDriftMs, headless, disableGpu }, null, 2));

  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.waitForTimeout(2_000);
  await clickIfVisible(page.locator("button", { hasText: /SDP 预览/ }));
  await page.waitForTimeout(4_000);
  await page.locator("button", { hasText: /启动 MKV 预览/ }).click({ timeout: 30_000 });

  const startedAt = Date.now();
  const activeSamples = [];
  const warmupSamples = [];
  let staleSamples = 0;
  let lastRendered = -1;
  let activeStartedAt = null;

  while (Date.now() - startedAt < (warmupSeconds + durationSeconds + 60) * 1000) {
    await page.waitForTimeout(intervalMs);
    const elapsedSeconds = (Date.now() - startedAt) / 1000;
    const drift = await page.evaluate(() => window.__sdpDrift || null);
    if (!drift || typeof drift.driftMs !== "number" || typeof drift.rendered !== "number") continue;

    const sample = {
      at: Math.round(elapsedSeconds * 10) / 10,
      driftMs: drift.driftMs,
      rendered: drift.rendered,
      audioClockActive: Boolean(drift.audioClockActive),
      frameTimestampUs: drift.frameTimestampUs,
      elapsedUs: drift.elapsedUs,
    };

    if (elapsedSeconds <= warmupSeconds || (activeStartedAt === null && sample.rendered < stableRenderedFrames)) {
      warmupSamples.push(sample);
    } else {
      if (activeStartedAt === null) {
        activeStartedAt = elapsedSeconds;
        console.log(`steady-state reached at ${sample.rendered} rendered frames`);
      }
      if (elapsedSeconds - activeStartedAt <= durationSeconds && sample.rendered !== lastRendered) {
        activeSamples.push(sample);
      } else if (sample.rendered === lastRendered) {
        staleSamples += 1;
      }
    }
    lastRendered = sample.rendered;
    if (activeStartedAt !== null && elapsedSeconds - activeStartedAt > durationSeconds) break;
  }

  const summary = summarize(activeSamples);
  const warmupSummary = summarize(warmupSamples);
  const finalState = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      drift: window.__sdpDrift || null,
      statusLines: text.split("\n").filter((line) => line.includes("MKV WebCodecs") || line.startsWith("queued:") || line.startsWith("read:")),
      recentDebug: text.split("\n").filter((line) => line.includes("[sdp-mkv]")).slice(-20),
    };
  });

  console.log("\n=== Warmup ===");
  console.log(JSON.stringify(warmupSummary, null, 2));
  console.log("\n=== Active Drift ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n=== Final State ===");
  console.log(JSON.stringify({ staleSamples, pageErrors: pageErrors.length, finalState }, null, 2));

  if (activeStartedAt === null) {
    console.log(`steady-state not reached within ${warmupSeconds + durationSeconds + 60}s`);
  }

  const failed = !summary
    || summary.avg > maxAvgDriftMs
    || summary.max > maxPeakDriftMs
    || activeStartedAt === null
    || pageErrors.length > 0;

  await browser.close();
  process.exit(failed ? 1 : 0);
} catch (error) {
  console.error("\n=== MKV drift regression crashed ===");
  console.error(error);
  await browser.close();
  process.exit(2);
}
