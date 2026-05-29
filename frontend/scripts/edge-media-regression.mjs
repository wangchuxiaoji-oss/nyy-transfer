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

const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
const logs = [];

page.on("console", (msg) => {
  const text = msg.text();
  if (text.includes("[MediaPlayer]") || text.includes("[patchInitSegment]") || text.includes("SourceBuffer")) {
    logs.push(`${msg.type()}: ${text}`);
    console.log(`${msg.type()}: ${text}`);
  }
});

page.on("pageerror", (err) => {
  logs.push(`pageerror: ${err.message}`);
  console.log(`pageerror: ${err.message}`);
});

try {
  await page.goto(URL, { waitUntil: "networkidle", timeout: 90_000 });
  await page.evaluate(() => localStorage.removeItem("nyy-init-variant"));
  await page.reload({ waitUntil: "networkidle", timeout: 90_000 });

  await page.getByRole("button", { name: /跑 Edge init matrix/ }).click({ timeout: 30_000 });
  await page.waitForTimeout(8_000);
  const matrixText = await page.locator("text=raw ·").locator("..", { hasText: "raw" }).evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()).join("\n")).catch(() => "");

  await page.getByRole("button", { name: /显示预览器/ }).click({ timeout: 30_000 });
  await page.waitForTimeout(20_000);

  const result = await page.evaluate(() => {
    const video = document.querySelector("video");
    const errorText = Array.from(document.querySelectorAll("p"))
      .map((item) => item.textContent || "")
      .find((text) => text.includes("视频初始化失败") || text.includes("视频片段加载失败")) || "";
    return {
      hasVideo: Boolean(video),
      readyState: video?.readyState ?? -1,
      networkState: video?.networkState ?? -1,
      currentTime: video?.currentTime ?? -1,
      duration: video?.duration ?? -1,
      errorText,
    };
  });

  console.log("\n=== Edge media regression result ===");
  console.log(JSON.stringify({ url: URL, headless: HEADLESS, matrixText, result, logs }, null, 2));

  await browser.close();
  process.exit(result.readyState >= 3 && !result.errorText ? 0 : 1);
} catch (err) {
  console.error("\n=== Edge media regression crashed ===");
  console.error(err);
  await browser.close();
  process.exit(2);
}
