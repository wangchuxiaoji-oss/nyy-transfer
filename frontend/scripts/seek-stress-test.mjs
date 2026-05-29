/**
 * Seek Stress Test — 40-point robustness test for NativeRangeChunkedMediaPlayer
 *
 * Two modes:
 *   --mode=patient   (default) Wait 8s per seek for sidecar to fully decode+play
 *   --mode=rapid     Wait only 1s per seek, stress-testing abort/cleanup paths
 *
 * Usage:
 *   node scripts/seek-stress-test.mjs --mode=patient
 *   node scripts/seek-stress-test.mjs --mode=rapid
 */
import { chromium } from "@playwright/test";

const MODE = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] || 'patient';
const NUM_POINTS = 40;
const DURATION = 6309; // video duration in seconds
const PAGE_URL = 'https://dev.nyy.app/xJlatE';

const PATIENT_WAIT_MS = 8000;
const RAPID_WAIT_MS = 1000;
const FINAL_PLAY_MS = 10000;

const WAIT_MS = MODE === 'rapid' ? RAPID_WAIT_MS : PATIENT_WAIT_MS;

// Generate 40 evenly spaced seek points (skip 0 and end)
const SEEK_POINTS = Array.from({ length: NUM_POINTS }, (_, i) =>
  Math.round((DURATION / (NUM_POINTS + 1)) * (i + 1))
);

function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

async function run() {
  console.log(`\n=== Seek Stress Test ===`);
  console.log(`Mode: ${MODE} | Points: ${NUM_POINTS} | Wait: ${WAIT_MS}ms`);
  console.log(`Seek targets: ${SEEK_POINTS.map(fmtTime).join(', ')}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(e.message.slice(0, 200)));

  // Load share page and click preview
  console.log('Loading page...');
  await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 90000 });
  await page.getByRole('button', { name: '预览' }).click();
  await page.waitForTimeout(12000); // wait for SW registration + video ready

  const videoReady = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? { readyState: v.readyState, duration: v.duration, src: v.currentSrc.slice(0, 80) } : null;
  });
  console.log('Video ready:', JSON.stringify(videoReady));
  if (!videoReady || videoReady.readyState < 2) {
    console.log('FAIL: Video not ready after 12s');
    await browser.close();
    process.exit(1);
  }

  // === Seek loop ===
  const results = [];
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < SEEK_POINTS.length; i++) {
    const target = SEEK_POINTS[i];
    const label = `[${i + 1}/${NUM_POINTS}] ${fmtTime(target)} (${target}s)`;

    await page.evaluate((t) => {
      const v = document.querySelector('video');
      if (v) { v.currentTime = t; v.play().catch(() => {}); }
    }, target);

    await page.waitForTimeout(WAIT_MS);

    const state = await page.evaluate(() => {
      const v = document.querySelector('video');
      if (!v) return null;
      const texts = Array.from(document.querySelectorAll('p')).map(p => p.textContent || '');
      const sidecarLine = texts.find(t => t.includes('音频：')) || '';
      return {
        currentTime: v.currentTime,
        readyState: v.readyState,
        paused: v.paused,
        error: v.error?.message || null,
        sidecar: sidecarLine,
      };
    });

    if (!state) {
      results.push({ target, status: 'FAIL', reason: 'no video element' });
      failed++;
      console.log(`  ${label} — FAIL: no video element`);
      continue;
    }

    const timeDelta = Math.abs(state.currentTime - target);
    const seekOk = timeDelta < 5; // within 5s tolerance
    const noError = !state.error;
    const dataReady = state.readyState >= 2;
    const ok = seekOk && noError && dataReady;

    const entry = {
      target,
      currentTime: Math.round(state.currentTime * 10) / 10,
      delta: Math.round(timeDelta * 10) / 10,
      readyState: state.readyState,
      paused: state.paused,
      error: state.error,
      sidecar: state.sidecar.replace('音频：', ''),
      status: ok ? 'PASS' : 'FAIL',
    };
    results.push(entry);

    if (ok) {
      passed++;
      process.stdout.write(`  ${label} — PASS (Δ${entry.delta}s rs=${entry.readyState})\n`);
    } else {
      failed++;
      const reasons = [];
      if (!seekOk) reasons.push(`Δ${entry.delta}s`);
      if (!noError) reasons.push(`err=${state.error}`);
      if (!dataReady) reasons.push(`rs=${state.readyState}`);
      console.log(`  ${label} — FAIL: ${reasons.join(', ')}`);
    }
  }

  // === Final stability check ===
  console.log(`\n=== Final stability: play 10s at last point ===`);
  const lastTarget = SEEK_POINTS[SEEK_POINTS.length - 1];
  await page.evaluate((t) => {
    const v = document.querySelector('video');
    if (v) { v.currentTime = t; v.play().catch(() => {}); }
  }, lastTarget);
  await page.waitForTimeout(FINAL_PLAY_MS);

  const finalState = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    return {
      currentTime: v.currentTime,
      readyState: v.readyState,
      paused: v.paused,
      error: v.error?.message || null,
    };
  });
  const finalAdvanced = finalState && (finalState.currentTime > lastTarget + 2);
  console.log(`  Final: currentTime=${finalState?.currentTime?.toFixed(1)}s paused=${finalState?.paused} advanced=${finalAdvanced}`);

  // === Report ===
  console.log(`\n========== SEEK STRESS TEST REPORT (${MODE}) ==========`);
  console.log(`Total: ${NUM_POINTS} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`Final playback advanced: ${finalAdvanced ? 'YES' : 'NO'}`);
  if (jsErrors.length) console.log(`JS errors: ${jsErrors.length}`, jsErrors.slice(-5));
  if (failed > 0) {
    console.log('\nFailed points:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  ${fmtTime(r.target)} — Δ${r.delta}s rs=${r.readyState} err=${r.error}`));
  }
  console.log(JSON.stringify({ mode: MODE, passed, failed, total: NUM_POINTS, finalAdvanced, results }, null, 2));

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
