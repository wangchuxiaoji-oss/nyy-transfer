import { chromium } from "@playwright/test";

const URL = process.env.SHARE_TEST_URL || "http://127.0.0.1:3000/2FprGJ";
const EXPECT_NAME = process.env.SHARE_EXPECT_NAME || "TEAM-053.mkv";
const WAIT_MS = Number(process.env.SHARE_WAIT_MS || 90000);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

page.on("pageerror", (err) => {
  console.error("pageerror:", err.message);
});

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector('[data-testid="native-video-preview"] video', { timeout: WAIT_MS });
  await page.waitForFunction(() => {
    const video = document.querySelector('[data-testid="native-video-preview"] video');
    return video instanceof HTMLVideoElement
      && video.readyState >= 1
      && Number.isFinite(video.duration)
      && video.duration > 0
      && video.videoWidth > 0
      && video.videoHeight > 0
      && !video.error;
  }, undefined, { timeout: WAIT_MS });

  const result = await page.evaluate((expectName) => {
    const video = document.querySelector('[data-testid="native-video-preview"] video');
    return {
      hasNativePreview: video instanceof HTMLVideoElement,
      hasSdpPreview: Boolean(document.querySelector('[data-testid="mkv-sdp-preview"]')),
      currentSrc: video?.currentSrc || "",
      readyState: video?.readyState ?? -1,
      networkState: video?.networkState ?? -1,
      duration: video?.duration ?? -1,
      videoWidth: video?.videoWidth ?? 0,
      videoHeight: video?.videoHeight ?? 0,
      errorCode: video?.error?.code ?? null,
      errorMessage: video?.error?.message || "",
      fileTitle: document.body.innerText.includes(expectName),
    };
  }, EXPECT_NAME);

  console.log(JSON.stringify({ url: URL, expectName: EXPECT_NAME, result }, null, 2));

  const ok = result.hasNativePreview
    && !result.hasSdpPreview
    && result.fileTitle
    && result.readyState >= 1
    && Number.isFinite(result.duration)
    && result.duration > 0
    && result.videoWidth > 0
    && result.videoHeight > 0
    && !result.errorCode;

  await browser.close();
  process.exit(ok ? 0 : 1);
} catch (err) {
  console.error(err);
  await browser.close();
  process.exit(2);
}
