import { expect, test } from "@playwright/test";

const CODE = "admin-preview-e2e";

const share = {
  code: CODE,
  files: [{
    file_name: "审核图片.png",
    file_size: 4096,
    file_ext: "png",
    content_type: "image/png",
    index: 0,
    is_chunked: false,
    chunk_count: 1,
    media_metadata: null,
  }],
  empty_dirs: [],
  total_bytes: 4096,
  created_at: "2026-07-01T00:00:00Z",
  expires_at: "2026-07-02T00:00:00Z",
  download_count: 8,
  max_downloads: 8,
  has_password: true,
  status: "revoked",
};

const content = {
  files: [{
    file_name: "审核图片.png",
    file_size: 4096,
    content_type: "image/png",
    is_chunked: false,
    download_url: "https://example.com/admin-preview.png",
    chunks: [],
    media_metadata: null,
  }],
  empty_dirs: [],
  expires_in: 86400,
};

test("后台分享卡片提供新标签完整查看入口", async ({ page }) => {
  await page.route("**/api/v1/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "admin", email: "admin@nyy.app", plan: "admin", is_admin: true, email_verified: true }),
    });
  });
  await page.route("**/api/v1/admin/stats", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ users_total: 1, shares_total: 1, shares_active: 0, shares_banned: 0, uploaded_bytes_total: 4096, uploaded_bytes_24h: 0, reports_pending: 0, emails_failed: 0 }),
    });
  });
  await page.route("**/api/v1/admin/config/quota", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ guest_max_file_bytes: 1, guest_max_active_shares: 1, guest_ttl_hours: 1, user_max_file_bytes: 1, user_max_active_shares: 1, user_ttl_hours: 1 }),
    });
  });
  await page.route("**/api/v1/admin/config/download", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ smart_download_enabled: true, target_video: true, target_audio: true, target_pdf: true, target_image: true, target_other: true, filesystem_access_enabled: true, leave_warning_enabled: true }),
    });
  });
  await page.route("**/api/v1/admin/shares?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        shares: [{ code: CODE, title: "审核分享", owner_email: null, file_count: 1, total_bytes: 4096, download_count: 8, max_downloads: 8, created_at: "2026-07-01T00:00:00Z", expires_at: "2026-07-02T00:00:00Z", revoked: true, banned: false, banned_reason: null, source: { ip: "8.8.8.8", geo: { country: "美国", region: "加利福尼亚", city: "山景城", isp: "Google" } }, guest_label: "访客 #A31F", access_event_count: 2, unique_access_ips: 1 }],
        total: 1,
        page: 1,
        page_size: 20,
      }),
    });
  });
  await page.route(`**/api/v1/admin/shares/${CODE}/sources?**`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        code: CODE,
        identity_type: "guest",
        identity_label: "访客 #A31F",
        creation_source: { ip: "8.8.8.8", geo: { country: "美国", region: "加利福尼亚", city: "山景城", isp: "Google" } },
        created_at: "2026-07-01T00:00:00Z",
        event_count: 2,
        unique_ip_count: 1,
        events: [{ event_type: "view", occurred_at: "2026-07-18T00:00:00Z", source: { ip: "8.8.8.8", geo: { country: "美国", region: "加利福尼亚", city: "山景城", isp: "Google" } }, user_agent: "Playwright", actor_label: "访客 #A31F" }],
      }),
    });
  });
  await page.route("**/api/v1/admin/ip-relations?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ source: { ip: "8.8.8.8", geo: { country: "美国", region: "加利福尼亚", city: "山景城", isp: "Google" } }, users: [], shares: [{ code: CODE, owner_email: null, relation_types: ["创建分享", "访问分享"] }], guest_labels: ["访客 #A31F"] }),
    });
  });

  await page.goto("/admin?tab=shares");

  await page.getByRole("button", { name: "详情" }).click();
  const detailDrawer = page.getByRole("dialog", { name: `/${CODE}` });
  const link = detailDrawer.getByRole("link", { name: "完整查看" });
  await expect(link).toHaveText(/完整查看/);
  await expect(link).toHaveAttribute("target", "_blank");
  await detailDrawer.getByRole("button", { name: "关闭详情抽屉" }).click();

  await page.getByRole("button", { name: /访客 #A31F/ }).click();
  const drawer = page.getByRole("dialog", { name: `/${CODE}` });
  await expect(drawer).toContainText("页面访问");
  await drawer.getByText("8.8.8.8").first().click();
  await expect(drawer).toContainText("同 IP 关联");
  await expect(drawer).toContainText("创建分享 · 访问分享");
  await expect(drawer.getByRole("link", { name: "DB-IP" })).toHaveAttribute("href", "https://db-ip.com");
});

test("管理员预览复用完整分享页并绕过公开限制", async ({ page }) => {
  let contentMethod = "";
  await page.route(`**/api/v1/admin/shares/${CODE}/view`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(share) });
  });
  await page.route(`**/api/v1/admin/shares/${CODE}/content`, async (route) => {
    contentMethod = route.request().method();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(content) });
  });
  await page.route("**/api/v1/shares/download-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ smart_download_enabled: true, target_video: true, target_audio: true, target_pdf: true, target_image: true, target_other: true, filesystem_access_enabled: true, leave_warning_enabled: true }),
    });
  });
  await page.route("https://example.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/png", body: "preview" });
  });

  await page.goto(`/admin/preview/${CODE}`);

  await expect(page.getByTestId("admin-preview-banner")).toContainText("已撤销");
  await expect(page.getByTestId("admin-preview-banner")).toContainText("不会恢复分享，也不会计入下载次数");
  await expect(page.getByText("安全保险库")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "举报" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载此文件" })).toBeVisible();
  await expect(page.locator('img[alt="二维码"]').first()).toBeVisible();
  expect(contentMethod).toBe("POST");

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (value: string) => localStorage.setItem("copied-admin-preview-link", value) },
    });
  });
  await page.getByRole("button", { name: "复制链接" }).first().click();
  const publicShareUrl = `${new URL(page.url()).origin}/${CODE}`;
  await expect.poll(() => page.evaluate(() => localStorage.getItem("copied-admin-preview-link"))).toBe(publicShareUrl);
});
