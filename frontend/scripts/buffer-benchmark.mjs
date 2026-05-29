/**
 * Buffer Benchmark — measures seek-to-play latency (the real UX metric)
 *
 * For each seek point, measures:
 *   - seekToPlay: time from seek until video.currentTime actually advances (playing)
 *   - seekToData: time from seek until readyState >= 3 (SW has delivered enough data)
 *
 * The script calls play() after seeking to trigger active buffering.
 * No artificial timeout cap — records actual time even if slow.
 * Hard cap at 60s per point to avoid infinite hangs.
 *
 * Usage:
 *   node scripts/buffer-benchmark.mjs [--url=URL] [--points=N] [--label=LABEL]
 */
import { chromium } from "@playwright/test";

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.slice(2).split('=');
    return [k, v || 'true'];
  })
);

const PAGE_URL = args.url || 'https://dev.nyy.app/cJ9gup';
const NUM_POINTS = parseInt(args.points || '10', 10);
const LABEL = args.label || 'baseline';
const HARD_CAP_MS = 60000; // 60s hard cap per point
const POLL_MS = 50;

function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
    : `${m}:${String(sec).padStart(2,'0')}`;
}

async function run() {
  console.log(`\n=== Buffer Benchmark [${LABEL}] ===`);
  console.log(`URL: ${PAGE_URL}`);
  console.log(`Points: ${NUM_POINTS} | Hard cap: ${HARD_CAP_MS}ms\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  console.log('Loading page...');
  await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 90000 });
  await page.getByRole('button', { name: '预览' }).click();
  await page.waitForTimeout(15000);

  const videoInfo = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    return { readyState: v.readyState, duration: v.duration, src: v.currentSrc.slice(0, 80) };
  });
  console.log('Video info:', JSON.stringify(videoInfo));
  if (!videoInfo || !videoInfo.duration) {
    console.log('FAIL: Video not ready');
    await browser.close();
    process.exit(1);
  }

  const duration = videoInfo.duration;
  const seekPoints = Array.from({ length: NUM_POINTS }, (_, i) =>
    Math.round((duration * 0.9 / (NUM_POINTS + 1)) * (i + 1) + duration * 0.05)
  );
  console.log(`Duration: ${fmtTime(duration)} | Seeks: ${seekPoints.map(fmtTime).join(', ')}\n`);

  const results = [];

  for (let i = 0; i < seekPoints.length; i++) {
    const target = seekPoints[i];
    const label = `[${i + 1}/${NUM_POINTS}] ${fmtTime(target)}`;

    // Seek + play, then measure time until currentTime actually advances
    const timing = await page.evaluate(async ({ target, hardCap, pollMs }) => {
      const v = document.querySelector('video');
      if (!v) return { error: 'no video' };

      // Seek and trigger play
      v.currentTime = target;
      v.play().catch(() => {});
      const t0 = performance.now();
      let seekToData = -1;
      let seekToPlay = -1;
      const startTime = target;

      while (performance.now() - t0 < hardCap) {
        // Record when SW has buffered enough data
        if (v.readyState >= 3 && seekToData < 0) {
          seekToData = Math.round(performance.now() - t0);
        }
        // Record when video is actually playing (currentTime advanced from seek target)
        if (!v.paused && v.currentTime > startTime + 0.1 && seekToPlay < 0) {
          seekToPlay = Math.round(performance.now() - t0);
          break;
        }
        await new Promise(r => setTimeout(r, pollMs));
      }

      return {
        target,
        seekToData,
        seekToPlay,
        readyState: v.readyState,
        currentTime: v.currentTime,
        paused: v.paused,
        error: v.error?.message || null,
      };
    }, { target, hardCap: HARD_CAP_MS, pollMs: POLL_MS });

    results.push(timing);
    const d = timing.seekToData >= 0 ? `${timing.seekToData}ms` : '>60s';
    const p = timing.seekToPlay >= 0 ? `${timing.seekToPlay}ms` : '>60s';
    console.log(`  ${label} — data: ${d} | play: ${p} | rs=${timing.readyState}`);

    // Pause before next seek to reset state
    await page.evaluate(() => { document.querySelector('video')?.pause(); });
    await page.waitForTimeout(1000);
  }

  // === Report ===
  const dataT = results.filter(r => r.seekToData >= 0).map(r => r.seekToData);
  const playT = results.filter(r => r.seekToPlay >= 0).map(r => r.seekToPlay);
  const stalls = results.filter(r => r.seekToPlay < 0).length;

  const stats = (arr) => {
    if (!arr.length) return { avg: -1, p50: -1, p95: -1, max: -1 };
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      avg: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      p50: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted[sorted.length - 1],
    };
  };

  const report = {
    label: LABEL,
    url: PAGE_URL,
    points: NUM_POINTS,
    stalls,
    seekToData: stats(dataT),
    seekToPlay: stats(playT),
    results,
  };

  console.log(`\n========== BUFFER BENCHMARK [${LABEL}] ==========`);
  console.log(`Points: ${NUM_POINTS} | Stalls (>60s): ${stalls}`);
  console.log(`Seek→Data  (rs>=3): avg=${report.seekToData.avg}ms p50=${report.seekToData.p50}ms p95=${report.seekToData.p95}ms max=${report.seekToData.max}ms`);
  console.log(`Seek→Play (playing): avg=${report.seekToPlay.avg}ms p50=${report.seekToPlay.p50}ms p95=${report.seekToPlay.p95}ms max=${report.seekToPlay.max}ms`);
  console.log(JSON.stringify(report, null, 2));

  await browser.close();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
