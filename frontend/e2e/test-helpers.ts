import { expect, type Page } from "@playwright/test";

const DOWNLOAD_CONFIG = {
  smart_download_enabled: true,
  target_video: true,
  target_audio: true,
  target_pdf: true,
  target_image: true,
  target_other: true,
  filesystem_access_enabled: true,
  leave_warning_enabled: true,
};

export async function mockDownloadConfig(
  page: Page,
  pattern = "**/api/v1/shares/download-config",
) {
  await page.route(pattern, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DOWNLOAD_CONFIG),
    });
  });
}

export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}
