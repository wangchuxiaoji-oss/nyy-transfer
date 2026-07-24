import { expect, test } from "@playwright/test";

test.describe("首页移动端顶栏", () => {
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

    const accountButtonRadius = await page.getByRole("button", { name: "打开账号菜单" }).evaluate((element) => ({
      actual: getComputedStyle(element).borderRadius,
      expected: getComputedStyle(document.documentElement).getPropertyValue("--radius-control").trim(),
    }));
    expect(accountButtonRadius.actual).toBe(accountButtonRadius.expected);

    await page.getByRole("button", { name: "打开账号菜单" }).click();
    await expect(page.getByRole("menu")).toContainText("admin@nyy.app");
    await expect(page.getByRole("menuitem", { name: /退出登录/ })).toBeVisible();
  });

  test("登录弹窗关闭按钮使用统一控件圆角", async ({ page }) => {
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
    const pageCaret = await page.locator("main").evaluate((element) => getComputedStyle(element).caretColor);
    expect(["transparent", "rgba(0, 0, 0, 0)"].includes(pageCaret)).toBe(true);
    await page.getByRole("button", { name: /^登录$/ }).click();

    const closeButton = page.getByRole("button", { name: "关闭" });
    await expect(closeButton).toBeVisible();
    const radius = await closeButton.evaluate((element) => ({
      actual: getComputedStyle(element).borderRadius,
      expected: getComputedStyle(document.documentElement).getPropertyValue("--radius-control").trim(),
    }));
    expect(radius.actual).toBe(radius.expected);

    const tabRadius = await page.getByRole("tab", { name: "登录" }).evaluate((element) => ({
      actual: getComputedStyle(element).borderRadius,
      expected: getComputedStyle(document.documentElement).getPropertyValue("--radius-control").trim(),
    }));
    expect(tabRadius.actual).toBe(tabRadius.expected);

    const inputCaret = await page.getByPlaceholder("you@example.com").evaluate((element) => getComputedStyle(element).caretColor);
    expect(["transparent", "rgba(0, 0, 0, 0)"].includes(inputCaret)).toBe(false);
  });
});
