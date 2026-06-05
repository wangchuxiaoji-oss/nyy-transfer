import { chromium } from "@playwright/test";

const URL = process.env.SHARE_TEST_URL || "http://127.0.0.1:3000/Y8PguC";
const EXPECT_NAME = process.env.SHARE_EXPECT_NAME || "星际穿越";
const WAIT_MS = Number(process.env.SHARE_WAIT_MS || 120000);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("pageerror", (err) => {
  console.error("pageerror:", err.message);
});

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => document.querySelector("video") !== null, { timeout: WAIT_MS });
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    return video instanceof HTMLVideoElement
      && video.currentSrc.includes("/__nyy_virtual_media__/")
      && video.readyState >= 1
      && Number.isFinite(video.duration)
      && video.duration > 0
      && !video.error;
  }, undefined, { timeout: WAIT_MS });

  const result = await page.evaluate((expectName) => {
    const video = document.querySelector("video");
    const fileTitle = document.body.innerText.includes(expectName);
    return {
      hasVideo: !!video,
      currentSrc: video?.currentSrc || "",
      readyState: video?.readyState ?? -1,
      networkState: video?.networkState ?? -1,
      duration: video?.duration ?? -1,
      errorCode: video?.error?.code ?? null,
      errorMessage: video?.error?.message || "",
      fileTitle,
    };
  }, EXPECT_NAME);

  console.log(JSON.stringify({ url: URL, expectName: EXPECT_NAME, result }, null, 2));

  const ok = result.hasVideo
    && result.fileTitle
    && result.currentSrc.includes("/__nyy_virtual_media__/")
    && result.readyState >= 1
    && Number.isFinite(result.duration)
    && result.duration > 0
    && !result.errorCode;

  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err);
  await browser.close();
  process.exit(2);
}
