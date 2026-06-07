import { chromium } from "@playwright/test";

const URL = process.env.SHARE_TEST_URL || "http://127.0.0.1:3000/Y8PguC";
const EXPECT_NAME = process.env.SHARE_EXPECT_NAME || "黑客帝国2";
const WAIT_MS = Number(process.env.SHARE_WAIT_MS || 90000);
const RAPID_SEEK = /^(1|true|yes)$/i.test(process.env.SHARE_RAPID_SEEK || "");
const SEEK_TIMES = (process.env.SHARE_SEEK_TIMES || "600,1200,1800")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item >= 0);
const SEEK_SETTLE_MS = Number(process.env.SHARE_SEEK_SETTLE_MS || 6000);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];

page.on("pageerror", (err) => {
  pageErrors.push(err.message);
  console.error("pageerror:", err.message);
});
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("requestfailed", (request) => {
  const url = request.url();
  if (!url.includes("/__nyy_virtual_media__/") && !url.startsWith("http")) return;
  failedRequests.push({
    url: url.includes("/__nyy_virtual_media__/") ? "__virtual__" : "__remote__",
    range: request.headers().range || "",
    failure: request.failure()?.errorText || "",
  });
});

await installAudioGraphProbe(page);

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(8000);

  await page.evaluate(() => {
    const expand = Array.from(document.querySelectorAll("button")).find((btn) => (btn.textContent || "").includes("展开更多"));
    if (expand instanceof HTMLButtonElement) expand.click();
  });

  await page.waitForTimeout(1000);
  await clickPreviewFile(page, EXPECT_NAME);

  await page.waitForSelector('[data-testid="ac3-video-preview"]', { timeout: WAIT_MS });
  await page.waitForFunction(() => {
    const video = document.querySelector('[data-testid="ac3-video-preview"]');
      return video instanceof HTMLVideoElement
      && (video.currentSrc.includes("/__nyy_virtual_media__/") || video.currentSrc.startsWith("blob:"))
      && video.readyState >= 1
      && Number.isFinite(video.duration)
      && video.duration > 0
      && !video.error;
  }, undefined, { timeout: WAIT_MS });

  let played = false;
  for (let attempt = 0; attempt < 3 && !played; attempt += 1) {
    await clickVisiblePlay(page);
    played = await page.waitForFunction(() => {
      const video = document.querySelector('[data-testid="ac3-video-preview"]');
      const debug = window.__nyyAc3Debug;
      return video instanceof HTMLVideoElement
        && !video.paused
        && video.currentTime > 1
        && debug
        && !debug.error
        && (debug.scheduledWindows > 0 || debug.scheduledWindowCount > 0);
    }, undefined, { timeout: Math.min(WAIT_MS, 30000) }).then(() => true).catch(() => false);
  }
  if (!played) {
    const snap = await page.evaluate(() => {
      const video = document.querySelector('[data-testid="ac3-video-preview"]');
      return {
        currentSrc: video?.currentSrc || "",
        readyState: video?.readyState ?? -1,
        duration: video?.duration ?? -1,
        currentTime: video?.currentTime ?? -1,
        paused: video?.paused ?? true,
        ended: video?.ended ?? false,
        errorCode: video?.error?.code ?? null,
        errorMessage: video?.error?.message || "",
        ac3Debug: window.__nyyAc3Debug || null,
        playButtons: Array.from(document.querySelectorAll('button[aria-label="播放"],button[aria-label="暂停"]')).map((button) => {
          const rect = button.getBoundingClientRect();
          return { label: button.getAttribute("aria-label"), disabled: button.disabled, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        }),
      };
    });
    throw new Error(`AC-3 播放未推进: ${JSON.stringify(snap)}`);
  }

  const seekResult = RAPID_SEEK ? await runRapidSeekSmoke(page, SEEK_TIMES) : null;

  const result = await page.evaluate((expectName) => {
    const video = document.querySelector('[data-testid="ac3-video-preview"]');
    const debug = window.__nyyAc3Debug || null;
    const graph = window.__nyyAudioGraphProbe || null;
    return {
      hasAc3Preview: video instanceof HTMLVideoElement,
      currentSrc: video?.currentSrc || "",
      readyState: video?.readyState ?? -1,
      networkState: video?.networkState ?? -1,
      duration: video?.duration ?? -1,
      currentTime: video?.currentTime ?? -1,
      paused: video?.paused ?? true,
      errorCode: video?.error?.code ?? null,
      errorMessage: video?.error?.message || "",
      ac3Debug: debug,
      audioGraph: graph,
      fileTitle: document.body.innerText.includes(expectName),
    };
  }, EXPECT_NAME);
  const interestingErrors = [...pageErrors, ...consoleErrors].filter(isInterestingPlaybackError);

  console.log(JSON.stringify({
    url: URL,
    expectName: EXPECT_NAME,
    rapidSeek: RAPID_SEEK,
    seekTimes: SEEK_TIMES,
    result,
    seekResult,
    interestingErrors,
    failedRequests: failedRequests.slice(-20),
  }, null, 2));

  const ok = result.hasAc3Preview
    && result.fileTitle
    && (result.currentSrc.includes("/__nyy_virtual_media__/") || result.currentSrc.startsWith("blob:"))
    && result.readyState >= 1
    && Number.isFinite(result.duration)
    && result.duration > 0
    && !result.errorCode
    && result.ac3Debug
    && !result.ac3Debug.error
    && (result.ac3Debug.scheduledWindows > 0 || result.ac3Debug.scheduledWindowCount > 0)
    && interestingErrors.length === 0
    && (!RAPID_SEEK || checkRapidSeekResult(seekResult));

  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err);
  await browser.close();
  process.exit(2);
}

async function clickVisiblePlay(page) {
  const chrome = page.locator('[data-testid="ac3-video-preview"]').locator('xpath=ancestor::*[@data-testid="player-chrome"]');
  await chrome.getByRole("button", { name: "播放" }).first().click({ timeout: WAIT_MS });
}

async function clickPreviewFile(page, expectName) {
  const target = page
    .locator('button[aria-label^="预览 "]')
    .filter({ hasText: expectName })
    .last();
  await target.scrollIntoViewIfNeeded({ timeout: WAIT_MS });
  await target.click({ timeout: WAIT_MS });
}

async function installAudioGraphProbe(page) {
  await page.addInitScript(() => {
    window.__nyyAudioGraphProbe = { starts: 0, stops: 0, connects: 0, gainDisconnects: 0, liveSources: 0 };

    const sourceProto = window.AudioBufferSourceNode?.prototype;
    if (sourceProto && !sourceProto.__nyyPatched) {
      const originalStart = sourceProto.start;
      const originalStop = sourceProto.stop;
      const originalConnect = sourceProto.connect;
      Object.defineProperty(sourceProto, "__nyyPatched", { value: true });
      sourceProto.connect = function (...args) {
        window.__nyyAudioGraphProbe.connects += 1;
        return originalConnect.apply(this, args);
      };
      sourceProto.start = function (...args) {
        window.__nyyAudioGraphProbe.starts += 1;
        window.__nyyAudioGraphProbe.liveSources += 1;
        this.addEventListener("ended", () => {
          window.__nyyAudioGraphProbe.liveSources = Math.max(0, window.__nyyAudioGraphProbe.liveSources - 1);
        }, { once: true });
        return originalStart.apply(this, args);
      };
      sourceProto.stop = function (...args) {
        window.__nyyAudioGraphProbe.stops += 1;
        return originalStop.apply(this, args);
      };
    }

    const gainProto = window.GainNode?.prototype;
    if (gainProto && !gainProto.__nyyPatched) {
      const originalDisconnect = gainProto.disconnect;
      Object.defineProperty(gainProto, "__nyyPatched", { value: true });
      gainProto.disconnect = function (...args) {
        window.__nyyAudioGraphProbe.gainDisconnects += 1;
        return originalDisconnect.apply(this, args);
      };
    }
  });
}

async function runRapidSeekSmoke(page, seekTimes) {
  if (!seekTimes.length) throw new Error("SHARE_SEEK_TIMES 未提供有效 seek 时间");
  const before = await page.evaluate(() => ({
    ac3: window.__nyyAc3Debug || null,
    graph: window.__nyyAudioGraphProbe || null,
  }));

  for (const targetTime of seekTimes) {
    await page.evaluate((time) => {
      const video = document.querySelector('[data-testid="ac3-video-preview"]');
      if (!(video instanceof HTMLVideoElement)) return;
      const duration = Number.isFinite(video.duration) ? video.duration : time + 1;
      video.currentTime = Math.max(0, Math.min(time, duration - 1));
    }, targetTime);
    await page.waitForTimeout(1200);
  }

  await page.waitForFunction(() => {
    const video = document.querySelector('[data-testid="ac3-video-preview"]');
    const debug = window.__nyyAc3Debug;
    return video instanceof HTMLVideoElement
      && !video.paused
      && !video.error
      && debug
      && debug.playing
      && !debug.error;
  }, undefined, { timeout: Math.min(WAIT_MS, 45000) });
  await page.waitForFunction((finalSeekTime) => {
    const video = document.querySelector('[data-testid="ac3-video-preview"]');
    const debug = window.__nyyAc3Debug;
    return video instanceof HTMLVideoElement
      && !video.paused
      && !video.error
      && video.currentTime > finalSeekTime + 1
      && debug
      && debug.playing
      && !debug.error;
  }, seekTimes[seekTimes.length - 1], { timeout: Math.min(WAIT_MS, 45000) });
  await page.waitForTimeout(SEEK_SETTLE_MS);

  const after = await page.evaluate(() => {
    const video = document.querySelector('[data-testid="ac3-video-preview"]');
    return {
      video: video instanceof HTMLVideoElement ? {
        paused: video.paused,
        currentTime: video.currentTime,
        duration: video.duration,
        readyState: video.readyState,
        networkState: video.networkState,
        errorCode: video.error?.code ?? null,
        errorMessage: video.error?.message || "",
      } : null,
      ac3: window.__nyyAc3Debug || null,
      graph: window.__nyyAudioGraphProbe || null,
      centerButtonVisible: !!document.querySelector('[data-testid="native-video-center-toggle"]'),
      bufferingVisible: !!document.querySelector('[data-testid="native-video-buffering"]'),
    };
  });

  return { before, after };
}

function checkRapidSeekResult(seekResult) {
  if (!seekResult?.before?.ac3 || !seekResult?.after?.video || !seekResult?.after?.ac3 || !seekResult?.after?.graph) return false;
  const beforeSession = Number(seekResult.before.ac3.audioSession || 0);
  const afterSession = Number(seekResult.after.ac3.audioSession || 0);
  const beforeDisconnects = Number(seekResult.before.graph?.gainDisconnects || 0);
  const afterDisconnects = Number(seekResult.after.graph.gainDisconnects || 0);
  return !seekResult.after.video.paused
    && !seekResult.after.video.errorCode
    && seekResult.after.video.currentTime > SEEK_TIMES[SEEK_TIMES.length - 1] + 1
    && !seekResult.after.ac3.error
    && !seekResult.after.centerButtonVisible
    && afterSession > beforeSession
    && afterDisconnects - beforeDisconnects >= SEEK_TIMES.length;
}

function isInterestingPlaybackError(message) {
  return /Failed to fetch|Unhandled Runtime Error|网络连接失败|AC-3|mp4 metadata/i.test(message || "");
}
