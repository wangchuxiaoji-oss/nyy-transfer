import { chromium } from "@playwright/test";

const URL = process.env.SHARE_TEST_URL || "http://127.0.0.1:3000/Y8PguC";
const EXPECT_NAME = process.env.SHARE_EXPECT_NAME || "信条";
const WAIT_MS = Number(process.env.SHARE_WAIT_MS || 90000);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("pageerror", (err) => {
  console.error("pageerror:", err.message);
});

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForTimeout(8000);

  await page.evaluate(() => {
    const expand = Array.from(document.querySelectorAll("button")).find((btn) => (btn.textContent || "").includes("展开更多"));
    if (expand instanceof HTMLButtonElement) expand.click();
  });

  await page.waitForTimeout(1000);
  await page.evaluate((expectName) => {
    const target = Array.from(document.querySelectorAll('button[aria-label^="预览 "]')).find((btn) => {
      const rect = btn.getBoundingClientRect();
      return (btn.getAttribute("aria-label") || "").includes(expectName) && rect.width > 0 && rect.height > 0;
    });
    if (target instanceof HTMLButtonElement) target.click();
  }, EXPECT_NAME);

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

  const result = await page.evaluate((expectName) => {
    const video = document.querySelector('[data-testid="ac3-video-preview"]');
    const debug = window.__nyyAc3Debug || null;
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
      fileTitle: document.body.innerText.includes(expectName),
    };
  }, EXPECT_NAME);

  console.log(JSON.stringify({ url: URL, expectName: EXPECT_NAME, result }, null, 2));

  const ok = result.hasAc3Preview
    && result.fileTitle
    && (result.currentSrc.includes("/__nyy_virtual_media__/") || result.currentSrc.startsWith("blob:"))
    && result.readyState >= 1
    && Number.isFinite(result.duration)
    && result.duration > 0
    && !result.errorCode
    && result.ac3Debug
    && !result.ac3Debug.error
    && (result.ac3Debug.scheduledWindows > 0 || result.ac3Debug.scheduledWindowCount > 0);

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
