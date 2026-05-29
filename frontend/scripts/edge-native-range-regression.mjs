import { chromium } from "@playwright/test";

const URL = process.env.EDGE_TEST_URL || "https://dev.nyy.app/ac3-lab/xJlatE";
const HEADLESS = process.env.EDGE_HEADLESS !== "0";

const browser = await chromium.launch({
  channel: "msedge",
  headless: HEADLESS,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
const logs = [];

page.on("console", (msg) => {
  const text = msg.text();
  if (text.includes("Service Worker") || text.includes("Range") || text.includes("video error")) {
    logs.push(`${msg.type()}: ${text}`);
    console.log(`${msg.type()}: ${text}`);
  }
});

page.on("pageerror", (err) => {
  logs.push(`pageerror: ${err.message}`);
  console.log(`pageerror: ${err.message}`);
});

async function clickNativeRangeButton() {
  await page.getByRole("button", { name: /启动原生 Range 播放 POC/ }).click({ timeout: 30_000 });
}

async function readNativeRangeStatus() {
  return page.locator("text=状态：").last().textContent({ timeout: 10_000 }).catch(() => "");
}

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });

  await clickNativeRangeButton();
  await page.waitForTimeout(3_000);
  let status = await readNativeRangeStatus();

  if (status.includes("尚未接管页面") || status.includes("刷新后再试")) {
    await page.reload({ waitUntil: "networkidle", timeout: 90_000 });
    await clickNativeRangeButton();
    await page.waitForTimeout(3_000);
    status = await readNativeRangeStatus();
  }

  await page.waitForFunction(() => {
    const videos = Array.from(document.querySelectorAll("video"));
    const video = videos[videos.length - 1];
    return Boolean(video && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0);
  }, { timeout: 60_000 });

  const result = await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll("video"));
    const video = videos[videos.length - 1];
    const statusText = Array.from(document.querySelectorAll("p"))
      .map((item) => item.textContent || "")
      .filter((text) => text.startsWith("状态："))
      .pop() || "";
    return {
      statusText,
      hasVideo: Boolean(video),
      currentSrc: video?.currentSrc || "",
      readyState: video?.readyState ?? -1,
      networkState: video?.networkState ?? -1,
      duration: video?.duration ?? -1,
      errorCode: video?.error?.code ?? null,
      errorMessage: video?.error?.message || "",
    };
  });

  console.log("\n=== Edge native Range regression result ===");
  console.log(JSON.stringify({ url: URL, headless: HEADLESS, status, result, logs }, null, 2));

  await browser.close();
  process.exit(result.readyState >= 1 && result.duration > 0 && !result.errorCode ? 0 : 1);
} catch (err) {
  console.error("\n=== Edge native Range regression crashed ===");
  console.error(err);
  await browser.close();
  process.exit(2);
}
