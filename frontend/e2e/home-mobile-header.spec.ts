import { expect, test } from "@playwright/test";

test.describe("首页移动端顶栏", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/v1/system/announcements?**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], has_more: false, next_offset: null }) });
    });
  });

  test("已登录态保持单行并将账号操作收进菜单", async ({ page }) => {
    await page.route("**/api/v1/auth/bootstrap", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          auth: { status: "user", user: { id: "admin-user", email: "admin@nyy.app", plan: "free", is_admin: true, email_verified: true }, token_type: "bearer" },
          quota: { used_bytes: 0, limit_bytes: 1024 * 1024 * 1024, remaining_bytes: 1024 * 1024 * 1024, ttl_hours: 720 },
        }),
      });
    });
    await page.route("**/api/v1/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-user", email: "admin@nyy.app", plan: "free", is_admin: true, email_verified: true }),
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
    await expect(page.getByRole("link", { name: /后台/ })).toBeVisible();
    await expect(header.getByText("admin@nyy.app")).toBeHidden();
    const headerHeight = await header.evaluate((element) => element.getBoundingClientRect().height);
    expect(headerHeight).toBeLessThanOrEqual(72);

    await page.getByRole("button", { name: "打开账号菜单" }).click();
    await expect(page.getByRole("menu")).toContainText("admin@nyy.app");
    await expect(page.getByRole("menuitem", { name: /退出登录/ })).toBeVisible();
  });

  test("登录弹窗可打开、输入并关闭", async ({ page }) => {
    await page.route("**/api/v1/auth/bootstrap", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ auth: { status: "guest", user: null, token_type: "bearer" }, quota: { used_bytes: 0, limit_bytes: 1024 * 1024 * 1024, remaining_bytes: 1024 * 1024 * 1024, ttl_hours: 720 } }),
      });
    });
    await page.route("**/api/v1/auth/refresh", async (route) => {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "未登录" }) });
    });
    await page.route("**/api/v1/auth/me", async (route) => {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "未登录" }) });
    });
    await page.route("**/api/v1/uploads/quota", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ used_bytes: 0, limit_bytes: 1024 * 1024 * 1024, ttl_hours: 720 }),
      });
    });

    await page.goto("/");
    await page.getByRole("button", { name: /^登录$/ }).click();

    const closeButton = page.getByRole("button", { name: "关闭", exact: true });
    await expect(closeButton).toBeVisible();
    await page.getByPlaceholder("you@example.com").fill("test@nyy.app");
    await expect(page.getByPlaceholder("you@example.com")).toHaveValue("test@nyy.app");
    await closeButton.click();
    await expect(closeButton).toHaveCount(0);
  });
});
