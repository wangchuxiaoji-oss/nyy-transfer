import { expect, test } from "@playwright/test";

test.describe("首页移动端顶栏", () => {
  test("已登录态保持单行并将账号操作收进菜单", async ({ page }) => {
    await page.route("**/api/v1/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ email: "admin@nyy.app", plan: "admin" }),
      });
    });
    await page.route("**/api/v1/uploads/quota", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ used_bytes: 0, limit_bytes: 1024 * 1024 * 1024, ttl_hours: 720 }),
      });
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const header = page.locator("header").first();
    await expect(page.getByRole("link", { name: /工作台/ })).toBeVisible();
    await expect(header.getByText("admin@nyy.app")).toBeHidden();
    const headerHeight = await header.evaluate((element) => element.getBoundingClientRect().height);
    expect(headerHeight).toBeLessThanOrEqual(72);

    await page.getByRole("button", { name: "打开账号菜单" }).click();
    await expect(page.getByRole("menu")).toContainText("admin@nyy.app");
    await expect(page.getByRole("menuitem", { name: /退出登录/ })).toBeVisible();
  });
});
