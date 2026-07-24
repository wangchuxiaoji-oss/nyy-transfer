import { expect, test, type Page } from "@playwright/test";

const REPORT_ID = "report-e2e-1";
const DELIVERY_ID = "delivery-e2e-1";

const report = {
  id: REPORT_ID,
  share_code: "queue-e2e",
  reason: "涉嫌侵权内容",
  detail: "包含未授权影视资源",
  status: "pending",
  created_at: "2026-07-20T09:00:00Z",
  share_title: "待审核资源包",
  source: { ip: "1.2.3.4", geo: { country: "中国", region: "上海", city: "上海", isp: "电信" } },
  report_count: 3,
  share_status: "active",
};

const failedEmail = {
  id: DELIVERY_ID,
  delivery_id: DELIVERY_ID,
  recipient: "user@example.com",
  share_code: "queue-e2e",
  status: "failed",
  error: "SMTP 535 认证失败",
  created_at: "2026-07-20T08:00:00Z",
  sent_at: null,
  last_attempt_at: "2026-07-20T08:05:00Z",
  attempt_count: 2,
  email_type: "分享通知",
};

async function routeAdminAuth(page: Page) {
  await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "admin", email: "admin@nyy.app", plan: "admin", is_admin: true, email_verified: true }) }));
}

async function routeDashboardFallback(page: Page) {
  await page.route("**/api/v1/admin/dashboard**", async (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "not found" }) }));
  await page.route("**/api/v1/admin/stats**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ users_total: 10, shares_total: 20, shares_active: 15, shares_banned: 2, uploaded_bytes_total: 1024, uploaded_bytes_24h: 512, reports_pending: 1, emails_failed: 1 }) }));
}

test("举报队列显式筛选待处理，全部状态与 URL 和请求保持一致", async ({ page }) => {
  const requestedStatuses: Array<string | null> = [];
  const patchedStatuses: string[] = [];
  const banReasons: string[] = [];
  await routeAdminAuth(page);
  await routeDashboardFallback(page);
  await page.route("**/api/v1/admin/reports?**", async (route) => {
    requestedStatuses.push(new URL(route.request().url()).searchParams.get("status"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ reports: [report], total: 1, page: 1, page_size: 20 }) });
  });
  await page.route(`**/api/v1/admin/reports/${REPORT_ID}/status`, async (route) => {
    const body = route.request().postDataJSON() as { status: string };
    patchedStatuses.push(body.status);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...report, status: body.status }) });
  });
  await page.route("**/api/v1/admin/shares/queue-e2e/ban", async (route) => {
    const body = route.request().postDataJSON() as { reason: string };
    banReasons.push(body.reason);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "已封禁" }) });
  });

  await page.goto("/admin?tab=reports&status=pending");

  const queue = page.getByTestId("admin-report-queue");
  await expect(queue).toBeVisible();
  // 显式待处理筛选必须同时反映在 URL、控件和请求中
  await expect.poll(() => requestedStatuses[0]).toBe("pending");
  await expect(page.getByLabel("筛选状态")).toHaveValue("pending");
  await expect(queue.getByText("涉嫌侵权内容").first()).toBeVisible();
  await expect(queue.getByText("待处理").first()).toBeVisible();
  // 预览入口直接打开管理员预览页
  await expect(queue.getByRole("link", { name: "/queue-e2e" }).first()).toHaveAttribute("href", "/admin/preview/queue-e2e");

  await page.getByLabel("筛选状态").selectOption("all");
  await expect(page).toHaveURL(/\/admin\?tab=reports$/);
  await expect(page.getByLabel("筛选状态")).toHaveValue("all");
  await expect.poll(() => requestedStatuses[requestedStatuses.length - 1]).toBe(null);

  // 标记处理：PATCH 状态并刷新当前模块
  await queue.getByRole("button", { name: "标记处理" }).click();
  await expect.poll(() => patchedStatuses).toEqual(["resolved"]);

  // 封禁联动：自动引用举报原因并同时处理举报
  await queue.getByRole("button", { name: "封禁并处理" }).click();
  await expect.poll(() => banReasons.length).toBe(1);
  expect(banReasons[0]).toContain("举报联动");
  expect(banReasons[0]).toContain("涉嫌侵权内容");
  await expect.poll(() => patchedStatuses).toEqual(["resolved", "resolved"]);
});

test("邮件队列失败投递提供幂等重试入口并防止双击", async ({ page }) => {
  const retryBodies: Array<{ delivery_ids: string[]; request_id: string }> = [];
  const retryHeaders: string[] = [];
  await routeAdminAuth(page);
  await routeDashboardFallback(page);
  await page.route("**/api/v1/admin/emails?**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ emails: [failedEmail], total: 1, page: 1, page_size: 20 }) }));
  await page.route("**/api/v1/admin/emails/batch-retry", async (route) => {
    retryBodies.push(route.request().postDataJSON() as { delivery_ids: string[]; request_id: string });
    retryHeaders.push(route.request().headers()["x-nyy-request-id"] || "");
    // 延迟响应以便观察 pending 状态
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "已提交", accepted: 1 }) });
  });

  await page.goto("/admin?tab=emails&status=failed");

  const queue = page.getByTestId("admin-email-queue");
  await expect(queue).toBeVisible();
  await expect(queue.getByText("user@example.com").first()).toBeVisible();
  await expect(queue.getByText("SMTP 535 认证失败").first()).toBeVisible();
  await expect(queue.getByText("2 次").first()).toBeVisible();

  const retryButton = queue.getByRole("button", { name: "重试" });
  await retryButton.click();
  // pending 期间按钮禁用，防止双击重复提交
  await expect(queue.getByRole("button", { name: "提交中" })).toBeDisabled();
  await expect.poll(() => retryBodies.length).toBe(1);
  expect(retryBodies[0].delivery_ids).toEqual([DELIVERY_ID]);
  expect(retryBodies[0].request_id).toBeTruthy();
  expect(retryHeaders[0]).toBe(retryBodies[0].request_id);
});
