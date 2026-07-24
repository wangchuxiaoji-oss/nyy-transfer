import { expect, test, type Page } from "@playwright/test";

const CODE = "ops-e2e";
const source = { ip: "8.8.4.4", geo: { country: "美国", region: "加利福尼亚", city: "山景城", isp: "Google" } };
const share = {
  code: CODE,
  title: "季度运营资料与审核样本",
  owner_email: null,
  file_count: 12,
  total_bytes: 48 * 1024 * 1024,
  download_count: 7,
  max_downloads: 20,
  created_at: "2026-07-20T08:00:00Z",
  expires_at: "2026-08-20T08:00:00Z",
  revoked: false,
  banned: false,
  banned_reason: null,
  source,
  guest_label: "访客 #C201",
  access_event_count: 14,
  unique_access_ips: 3,
  preview_fetch_count: 4,
  page_rendered_count: 8,
  human_interaction_count: 5,
  link_issued_count: 7,
  admin_review_count: 1,
};

async function routeAdminAuth(page: Page) {
  await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "admin", email: "admin@nyy.app", plan: "admin", is_admin: true, email_verified: true }) }));
}

async function routeShares(page: Page, status = 200) {
  await page.route("**/api/v1/admin/shares?**", async (route) => route.fulfill({
    status,
    contentType: "application/json",
    body: status === 200 ? JSON.stringify({ items: [share], pagination_mode: "cursor", total: null, page: null, page_size: 20, next_cursor: "cursor-2", prev_cursor: null, has_more: true, total_is_estimated: false }) : JSON.stringify({ detail: "shares unavailable" }),
  }));
}

test("风险验证码登录失败后清空旧 token 并重新加载挑战", async ({ page }) => {
  const loginBodies: Array<{ captcha_token?: string }> = [];
  let challengeRequests = 0;
  let verifyRequests = 0;
  await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "未登录" }) }));
  await page.route("**/api/v1/auth/refresh", async (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "未登录" }) }));
  await page.route("**/api/v1/auth/logout", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/api/v1/captcha/challenge?purpose=login", async (route) => {
    challengeRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ challenge_id: `challenge-${challengeRequests}`, challenge: { algorithm: "SHA-256", challenge: "00", salt: "test", signature: "test" }, expires_in: 300 }),
    });
  });
  await page.route("**/api/v1/captcha/verify", async (route) => {
    verifyRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ captcha_token: `captcha-${verifyRequests}`, expires_in: 300 }) });
  });
  await page.route("**/api/v1/auth/login", async (route) => {
    loginBodies.push(route.request().postDataJSON() as { captcha_token?: string });
    if (loginBodies.length === 1) {
      await route.fulfill({ status: 428, contentType: "application/json", body: JSON.stringify({ detail: { error: "captcha_required", message: "需要人机验证" } }) });
      return;
    }
    await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "邮箱或密码错误" }) });
  });

  await page.goto("/admin");
  await page.getByLabel("密码").fill("wrong-password");
  await page.getByRole("button", { name: "进入控制台" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "请完成人机验证" })).toBeVisible();
  await expect.poll(() => challengeRequests).toBeGreaterThanOrEqual(1);
  const challengeRequestsBeforeRetry = challengeRequests;

  await page.locator("altcha-widget").evaluate((element) => {
    element.dispatchEvent(new CustomEvent("statechange", { detail: { state: "verified", payload: "proof" } }));
  });
  await expect.poll(() => verifyRequests).toBe(1);
  await expect(page.getByRole("button", { name: "进入控制台" })).toBeEnabled();
  await page.getByRole("button", { name: "进入控制台" }).click();

  await expect.poll(() => loginBodies.length).toBe(2);
  expect(loginBodies[1].captcha_token).toBe("captcha-1");
  await expect.poll(() => challengeRequests).toBeGreaterThan(challengeRequestsBeforeRetry);
  await expect(page.getByRole("button", { name: "进入控制台" })).toBeDisabled();
});

test("桌面分享使用固定表头紧凑表格并保留 URL 状态", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await routeAdminAuth(page);
  await routeShares(page);
  await page.goto("/admin?tab=shares&status=active&sort=size_desc");

  await expect(page.getByText("运营", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("系统", { exact: true }).last()).toBeVisible();
  const table = page.getByTestId("admin-share-table");
  await expect(table).toBeVisible();
  await expect(table.getByText("打开 / 真人 / 取链 / 预解析")).toBeVisible();
  await expect(table.getByText("8 / 5 / 7 / 4")).toBeVisible();
  const headerPosition = await table.locator("thead").evaluate((element) => getComputedStyle(element).position);
  expect(headerPosition).toBe("sticky");
  await expect(page).toHaveURL(/tab=shares/);
  await expect(page).toHaveURL(/status=active/);
  await expect(page).toHaveURL(/sort=size_desc/);
});

test("390px 使用两行紧凑列表并从整行打开详情抽屉", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routeAdminAuth(page);
  await routeShares(page);
  await page.goto("/admin?tab=shares");

  await expect(page.getByTestId("admin-share-mobile-list")).toBeVisible();
  await expect(page.getByTestId("admin-share-table")).toBeHidden();
  await expect(page.getByRole("button", { name: `查看分享 /${CODE} 详情` })).toContainText("访客 #C201");
  const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

  await page.getByRole("button", { name: `查看分享 /${CODE} 详情` }).click();
  const drawer = page.getByRole("dialog", { name: `/${CODE}` });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("来源与关联调查")).toBeVisible();
  await expect(drawer.getByRole("link", { name: "完整查看" })).toHaveAttribute("href", `/admin/preview/${CODE}`);
  await drawer.getByRole("button", { name: "封禁" }).click();
  const banDialog = page.getByRole("dialog", { name: `封禁 /${CODE}` });
  await expect(banDialog).toBeVisible();
  await expect.poll(() => banDialog.evaluate((element) => element.closest("[inert]") === null)).toBe(true);
  await expect(banDialog.getByRole("button", { name: "确认封禁" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(banDialog).toHaveCount(0);
  await expect(drawer).toBeVisible();
});

test("非鉴权数据失败显示分区重试且不退出管理员", async ({ page }) => {
  let logoutCalls = 0;
  await routeAdminAuth(page);
  await routeShares(page, 500);
  await page.route("**/api/v1/auth/logout", async (route) => { logoutCalls += 1; await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }); });
  await page.goto("/admin?tab=shares");

  const moduleAlert = page.getByRole("alert").filter({ hasText: "当前模块加载失败" });
  await expect(moduleAlert).toContainText("服务器内部错误");
  await expect(page.getByText("admin@nyy.app")).toBeVisible();
  await expect(page.getByLabel("管理员邮箱")).toHaveCount(0);
  await page.getByRole("button", { name: "重试" }).click();
  await expect(moduleAlert).toBeVisible();
  expect(logoutCalls).toBe(0);
});

test("来源抽屉区分预解析、页面打开、真人互动和管理员预览", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await routeAdminAuth(page);
  await routeShares(page);
  await page.route(`**/api/v1/admin/shares/${CODE}/sources?**`, async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      code: CODE,
      identity_type: "guest",
      identity_label: "访客 #C201",
      creation_source: source,
      created_at: "2026-07-20T08:00:00Z",
      event_count: 4,
      unique_ip_count: 1,
      events: [
        { event_type: "preview_fetch", category: "preview", client_kind: "preview_bot", confidence: "high", detector: "QQUrlRichService", occurred_at: "2026-07-20T08:00:00Z", source, user_agent: "QQUrlRichService", actor_label: "QQ 预解析" },
        { event_type: "page_rendered", category: "rendered", client_kind: "unknown", confidence: "medium", occurred_at: "2026-07-20T08:00:08Z", source, user_agent: "Chrome", actor_label: "访客 #C201" },
        { event_type: "human_interaction", category: "human", client_kind: "human", confidence: "high", occurred_at: "2026-07-20T08:00:12Z", source, user_agent: "Chrome", actor_label: "访客 #C201" },
        { event_type: "admin_review", category: "admin", client_kind: "admin", confidence: "high", occurred_at: "2026-07-20T08:01:00Z", source, user_agent: "Chrome", actor_label: "admin@nyy.app" },
      ],
      next_cursor: null,
      has_more: false,
    }),
  }));

  await page.goto("/admin?tab=shares");
  await page.getByText("8.8.4.4").first().click();
  const drawer = page.getByRole("dialog", { name: `/${CODE}` });
  await expect(drawer.getByText("预解析", { exact: true })).toBeVisible();
  await expect(drawer.getByText("页面打开", { exact: true })).toBeVisible();
  await expect(drawer.getByText("真人互动", { exact: true })).toBeVisible();
  await expect(drawer.getByText("管理员预览", { exact: true })).toBeVisible();
  await expect(drawer.getByText("QQUrlRichService", { exact: true })).toBeVisible();
});

test("诊断页提供只读审计和历史归档入口", async ({ page }) => {
  await routeAdminAuth(page);
  await page.route("**/api/v1/admin/audit-logs?**", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [{ id: "audit-1", created_at: "2026-07-21T10:00:00Z", request_id: "request-1", actor_email: "admin@nyy.app", action: "share.ban", target_type: "share", target_id: CODE, before: null, after: { banned: true }, reason: "违规内容", note: null, batch_id: null, success: true, error_summary: null, ip: "8.8.8.8", user_agent: "Chrome" }], next_cursor: null, has_more: false }),
  }));
  await page.route("**/api/v1/admin/archived-shares?**", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [{ id: "archive-1", code: "old-e2e", title: "历史分享", terminal_status: "expired", total_bytes: 1024, logical_file_count: 1, stored_object_count: 1, created_at: "2025-01-01T00:00:00Z", last_activity_at: "2025-01-02T00:00:00Z", archived_at: "2026-07-21T10:00:00Z" }], next_cursor: null, has_more: false }),
  }));

  await page.goto("/admin?tab=diagnostics");
  const audit = page.getByTestId("admin-audit-log");
  const archive = page.getByTestId("admin-archive-panel");
  await audit.locator("summary").click();
  await archive.locator("summary").click();
  await expect(audit.getByText("share.ban", { exact: true })).toBeVisible();
  await expect(audit.getByText(`share:${CODE}`, { exact: true })).toBeVisible();
  await expect(archive.getByText("/old-e2e", { exact: true })).toBeVisible();
});
