import { expect, test, type Page } from "@playwright/test";

async function mockGuestHome(page: Page) {
  await page.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "未登录" }) });
  });
  await page.route("**/api/v1/auth/refresh", async (route) => {
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "未登录" }) });
  });
  await page.route("**/api/v1/uploads/quota", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ used_bytes: 0, limit_bytes: 1024 * 1024 * 1024, remaining_bytes: 1024 * 1024 * 1024, ttl_hours: 720 }),
    });
  });
}

async function expectIndicatorAlignedWithTab(page: Page, name: RegExp) {
  const tab = page.getByRole("tab", { name });
  const indicator = page.getByTestId("home-mode-indicator");

  await expect(tab).toBeVisible();
  await expect(indicator).toBeVisible();
  await expect.poll(async () => {
    const [tabBox, indicatorBox] = await Promise.all([tab.boundingBox(), indicator.boundingBox()]);
    if (!tabBox || !indicatorBox) return 999;
    return Math.max(
      Math.abs(tabBox.x - indicatorBox.x),
      Math.abs(tabBox.y - indicatorBox.y),
      Math.abs(tabBox.width - indicatorBox.width),
      Math.abs(tabBox.height - indicatorBox.height),
    );
  }, { timeout: 2500 }).toBeLessThanOrEqual(1);
}

test.describe("首页主操作选项卡", () => {
  test("滑动 pill 与当前 tab 按钮边界对齐", async ({ page }) => {
    await mockGuestHome(page);

    for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await expectIndicatorAlignedWithTab(page, /传文件/);

      await page.getByRole("tab", { name: /收文件/ }).click();
      await expectIndicatorAlignedWithTab(page, /收文件/);
    }
  });
});
