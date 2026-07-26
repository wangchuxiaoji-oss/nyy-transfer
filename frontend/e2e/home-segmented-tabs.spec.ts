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
      body: JSON.stringify({ used_bytes: 0, limit_bytes: 2 * 1024 * 1024 * 1024, remaining_bytes: 2 * 1024 * 1024 * 1024, ttl_hours: 24 }),
    });
  });
  await page.route("**/api/v1/system/announcements?**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], has_more: false, next_offset: null }) });
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

  test("各端首屏露出上传工具且光晕平滑收口", async ({ page }) => {
    await mockGuestHome(page);

    for (const viewport of [{ width: 390, height: 844 }, { width: 1920, height: 1080 }, { width: 3840, height: 2160 }]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      const hero = page.getByTestId("home-hero");
      const upload = page.locator("#upload-section");
      const atmosphere = page.getByTestId("hero-atmosphere");
      await expect(upload).toBeVisible();
      await expect(hero.getByRole("link", { name: "创建收件链接" })).toHaveCount(0);
      await expect(hero.getByRole("link", { name: "选择文件发送" })).toHaveCount(0);
      const [heroBox, uploadBox, atmosphereBox, atmosphereStyle] = await Promise.all([
        hero.boundingBox(),
        upload.boundingBox(),
        atmosphere.boundingBox(),
        atmosphere.evaluate((element) => ({
          maskImage: getComputedStyle(element).maskImage,
          webkitMaskImage: getComputedStyle(element).webkitMaskImage,
        })),
      ]);
      expect(heroBox).not.toBeNull();
      expect(uploadBox).not.toBeNull();
      expect(atmosphereBox).not.toBeNull();
      expect(uploadBox!.y).toBeLessThan(viewport.height);
      expect(heroBox!.height).toBeLessThan(viewport.height * 0.72);
      expect(atmosphereBox!.x).toBeLessThan(0);
      expect(atmosphereBox!.width).toBeGreaterThan(viewport.width);
      expect(atmosphereStyle.maskImage === "none" ? atmosphereStyle.webkitMaskImage : atmosphereStyle.maskImage).toContain("linear-gradient");
    }
  });
});
