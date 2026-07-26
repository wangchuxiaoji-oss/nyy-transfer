import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, mockDownloadConfig } from "./test-helpers";

const quota = { used_bytes: 0, limit_bytes: 50 * 1024 ** 3, remaining_bytes: 50 * 1024 ** 3, ttl_hours: 720 };
const user = { id: "growth-user", email: "growth@nyy.app", plan: "free", is_admin: false, email_verified: true };

async function mockHomeBootstrap(page: Page, loggedIn = false) {
  await page.route("**/api/v1/auth/bootstrap", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ auth: { status: loggedIn ? "user" : "guest", user: loggedIn ? user : null, token_type: "bearer" }, quota }),
  }));
  await page.route("**/api/v1/growth/me", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      available_coupons: [{ id: "coupon-90", target_ttl_days: 90, status: "available", issued_at: "2026-07-24T00:00:00Z", expires_at: "2026-12-31T00:00:00Z" }],
      referrals: { qualified: 2, pending: 1 },
    }),
  }));
  await page.route("**/api/v1/system/announcements?**", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [], has_more: false, next_offset: null }),
  }));
}

test.describe("增长与公开内容", () => {
  test("首页在 390px 保持工具优先并渲染 SSR 叙事", async ({ page }) => {
    await mockHomeBootstrap(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");

    const tool = page.getByRole("region", { name: "文件操作" });
    const storyHeading = page.getByRole("heading", { name: "三步，把文件交到对方手里" });
    await expect(tool).toBeVisible();
    await expect(storyHeading).toBeVisible();
    const positions = await Promise.all([tool.boundingBox(), storyHeading.boundingBox()]);
    expect(positions[0]?.y || 0).toBeLessThan(positions[1]?.y || 0);
    await expectNoHorizontalOverflow(page);
    await expect.poll(() => page.locator('script[type="application/ld+json"]').evaluateAll((scripts) => scripts.some((script) => script.textContent?.includes("FAQPage")))).toBe(true);
    const guestQuota = page.getByText("游客每日额度").locator("..");
    await guestQuota.scrollIntoViewIfNeeded();
    await expect(guestQuota).toContainText("2GB");
    await expect(page.getByText("游客最长分享").locator("..")).toContainText("3天");
    await expect(page.getByText("用户每月额度").locator("..")).toContainText("50GB");
  });

  test("首页采集 ref_share 与 UTM 并持久化", async ({ page }) => {
    await mockHomeBootstrap(page);
    let landingBody: Record<string, string> | null = null;
    await page.route("**/api/v1/growth/landing", async (route) => {
      landingBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ recorded: true }) });
    });

    await page.goto("/?ref_share=VIRAL88&utm_source=wechat&utm_campaign=summer");
    await expect.poll(() => landingBody).toMatchObject({ utm_source: "wechat", utm_campaign: "summer" });
    await expect.poll(() => landingBody?.request_id).toMatch(/^landing:/);
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("nyy_growth_attribution") || "null"))).toMatchObject({ referralShareCode: "VIRAL88" });
    await page.goto("/?ref_share=SECOND1&utm_source=other");
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("nyy_growth_attribution") || "null"))).toMatchObject({ referralShareCode: "VIRAL88", utmSource: "wechat" });
  });

  test("SEO 页面有独立 meta，未知带点路径返回 404", async ({ page }) => {
    const response = await page.goto("/large-file-transfer");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle(/大文件传输：无需安装的浏览器直传工具/);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://nyy.app/large-file-transfer");
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", "https://nyy.app/logo-home-preview.png");
    await expect(page.getByRole("heading", { name: "大文件传输，不必先把文件塞进聊天窗口" })).toBeVisible();

    const missing = await page.goto("/definitely-missing.asset");
    expect(missing?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "页面不存在或分享已过期" })).toBeVisible();
  });

  test("分享页 CTA 上报点击并携带来源码回首页", async ({ page }) => {
    const code = "viral-e2e";
    await page.route(`**/api/v1/shares/${code}`, async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code, files: [], empty_dirs: ["待上传/"], total_bytes: 0, created_at: "2026-07-24T00:00:00Z", expires_at: null, download_count: 0, max_downloads: 0, has_password: false }),
    }));
    await page.route(`**/api/v1/shares/${code}/interaction`, async (route) => route.fulfill({ status: 204, body: "" }));
    await mockDownloadConfig(page);
    let clickBody: Record<string, string> | null = null;
    await page.route("**/api/v1/growth/viral-click", async (route) => {
      clickBody = route.request().postDataJSON();
      await route.fulfill({ status: 204, body: "" });
    });
    await mockHomeBootstrap(page);

    await page.goto(`/${code}`);
    const cta = page.getByTestId("viral-share-cta");
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(new RegExp(`ref_share=${code}`));
    await expect.poll(() => clickBody).toMatchObject({ share_code: code });
    await expect.poll(() => clickBody?.request_id).toMatch(/^viral:/);
  });

  test("收件页 CTA 不把收件码误作分享推荐码", async ({ page }) => {
    const code = "request-e2e";
    await page.route(`**/api/v1/file-requests/${code}`, async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ code, title: "项目资料收件", has_password: false, expires_at: null, max_files: 10, max_bytes: 1024 ** 3, received_files: 0, received_bytes: 0 }),
    }));
    let viralClicks = 0;
    await page.route("**/api/v1/growth/viral-click", async (route) => { viralClicks += 1; await route.fulfill({ status: 204, body: "" }); });
    await mockHomeBootstrap(page);

    await page.goto(`/r/${code}`);
    await page.getByTestId("viral-share-cta").click();
    await expect(page).toHaveURL(/\/$/);
    expect(viralClicks).toBe(0);
  });

  test("账号权益与上传设置展示可手动选择的 90 天券", async ({ page }) => {
    await mockHomeBootstrap(page, true);
    await page.goto("/");
    await expect(page.getByText("growth@nyy.app")).toBeVisible();
    await page.locator('input[aria-label="选择文件"]').setInputFiles({ name: "handoff.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    const couponSetting = page.getByTestId("retention-coupon-setting");
    await expect(couponSetting).toBeVisible();
    await couponSetting.getByLabel("保留券").selectOption("coupon-90");
    await expect(couponSetting.getByLabel("保留券")).toHaveValue("coupon-90");

    await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(user) }));
    await page.route("**/api/v1/my/shares?**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ shares: [], total: 0, page: 1, page_size: 10 }) }));
    await page.goto("/my");
    await expect(page.getByTestId("growth-benefits")).toContainText("90 天保留券");
    await expect(page.getByTestId("growth-benefits")).toContainText("已完成 2 / 3");
  });

  test("上传成功消费保留券后刷新权益且重置不可再次选择", async ({ page }) => {
    await mockHomeBootstrap(page, true);
    await page.unroute("**/api/v1/growth/me");
    let growthRequests = 0;
    let committed = false;
    let commitBody: { retention_coupon_id?: string } | null = null;
    await page.route("**/api/v1/growth/me", async (route) => {
      growthRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          available_coupons: committed ? [] : [{ id: "coupon-90", target_ttl_days: 90, status: "available", issued_at: "2026-07-24T00:00:00Z", expires_at: "2026-12-31T00:00:00Z" }],
          referrals: { qualified: 2, pending: 0 },
        }),
      });
    });
    await page.route("**/api/v1/uploads/init", async (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ upload_url: "/__e2e-upload-target", authorization: "test", store_uri: "store://coupon-test", commit_token: "commit-token", commit_token_expires_at: "2099-01-01T00:00:00Z" }),
    }));
    await page.route("**/__e2e-upload-target", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.route("**/api/v1/uploads/commit", async (route) => {
      commitBody = route.request().postDataJSON() as { retention_coupon_id?: string };
      committed = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ share_code: "coupon-share", share_url: "https://nyy.app/coupon-share", file_count: 1 }) });
    });
    await page.route("**/api/v1/uploads/quota", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(quota) }));

    await page.goto("/");
    await expect(page.getByText("growth@nyy.app")).toBeVisible();
    await page.locator('input[aria-label="选择文件"]').setInputFiles({ name: "coupon.txt", mimeType: "text/plain", buffer: Buffer.from("coupon") });
    await page.getByLabel("保留券").selectOption("coupon-90");
    const growthRequestsBeforeCommit = growthRequests;
    await page.getByRole("button", { name: "开始上传" }).click();
    await expect.poll(() => commitBody).toMatchObject({ retention_coupon_id: "coupon-90" });
    await expect.poll(() => growthRequests).toBeGreaterThan(growthRequestsBeforeCommit);
    await page.getByRole("button", { name: "继续上传" }).click();
    await page.locator('input[aria-label="选择文件"]').setInputFiles({ name: "next.txt", mimeType: "text/plain", buffer: Buffer.from("next") });
    await expect(page.getByTestId("retention-coupon-setting")).toHaveCount(0);
  });

});

test.describe("Admin 邮件工作台", () => {
  test("桌面三栏支持线程、星标、附件和回复", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...user, id: "admin", email: "admin@nyy.app", is_admin: true }) }));
    const message = {
      id: "mail-1", thread_id: "thread-1", subject: "关于大文件交付的咨询", direction: "inbound",
      from_addresses: [{ name: "林檎", address: "lin@example.com" }], to_addresses: [{ name: "", address: "admin@nyy.app" }], cc_addresses: [], body_preview: "上传到一半网络切换后...",
      text_body: "上传到一半网络切换后，页面提示可以重试。请问应该如何继续？", received_at: "2026-07-22T09:30:00Z", date: "2026-07-22T09:30:00Z",
      is_read: false, is_starred: false, is_archived: false, is_spam: false, is_trashed: false, attachment_count: 1,
      attachments: [{ id: "att-1", filename: "error-log.txt", content_type: "text/plain", size: 128 }],
    };
    await page.route("**/api/v1/admin/mailbox/messages?**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [message], total: 1, folders: { inbox: 1, starred: 0 } }) }));
    await page.route("**/api/v1/admin/mailbox/messages/mail-1", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [message] }) }));
    await page.route("**/api/v1/admin/mailbox/messages/mail-1/state", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...message, ...route.request().postDataJSON() }) }));
    let replyBody = "";
    await page.route("**/api/v1/admin/mailbox/messages/mail-1/reply", async (route) => { replyBody = route.request().postDataJSON().text; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sent: true, message }) }); });
    await page.route("**/api/v1/admin/mailbox/messages/mail-1/attachments/att-1", async (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "log" }));

    await page.goto("/admin?tab=mailbox");
    const mailbox = page.getByTestId("admin-mailbox");
    const detail = page.getByTestId("mailbox-desktop-detail");
    await expect(mailbox.getByRole("navigation", { name: "邮箱文件夹" })).toBeVisible();
    await mailbox.getByRole("button", { name: "打开邮件 关于大文件交付的咨询" }).click();
    await expect(detail.getByText("上传到一半网络切换后，页面提示可以重试。请问应该如何继续？")).toBeVisible();
    await detail.getByRole("button", { name: "星标" }).click();
    await detail.getByRole("button", { name: /error-log.txt/ }).click();
    await detail.getByRole("button", { name: "回复" }).click();
    await detail.getByLabel("正文").fill("可以重新选择同一批文件，页面会提示恢复进度。");
    await detail.getByRole("button", { name: "发送邮件" }).click();
    await expect.poll(() => replyBody).toContain("恢复进度");
  });

  test("390px 从邮件列表打开移动抽屉", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...user, id: "admin", email: "admin@nyy.app", is_admin: true }) }));
    const message = { id: "mobile-mail", thread_id: "mobile-thread", folder: "inbox", subject: "移动端邮件", from: { email: "mobile@example.com" }, to: [{ email: "admin@nyy.app" }], snippet: "移动端正文", body_text: "移动端正文", received_at: "2026-07-22T09:30:00Z", is_read: true, is_starred: false, attachment_count: 0 };
    await page.route("**/api/v1/admin/mailbox/messages?**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [message], total: 1 }) }));
    await page.route("**/api/v1/admin/mailbox/messages/mobile-mail", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message }) }));

    await page.goto("/admin?tab=mailbox");
    await page.getByRole("button", { name: "打开邮件 移动端邮件" }).click();
    const drawer = page.getByRole("dialog", { name: "移动端邮件" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "返回列表" })).toBeFocused();
    await expect(drawer.getByText("移动端正文").last()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole("button", { name: "打开邮件 移动端邮件" })).toBeFocused();
  });

  test("快速切换文件夹时旧列表响应不会覆盖新列表", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...user, id: "admin", email: "admin@nyy.app", is_admin: true }) }));
    const requestedFolders: string[] = [];
    const message = (id: string, subject: string, starred: boolean) => ({ id, thread_id: id, subject, direction: "inbound", from: { email: `${id}@example.com` }, to: [{ email: "admin@nyy.app" }], snippet: subject, body_text: subject, received_at: "2026-07-22T09:30:00Z", is_read: true, is_starred: starred, attachment_count: 0 });
    await page.route("**/api/v1/admin/mailbox/messages?**", async (route) => {
      const folder = new URL(route.request().url()).searchParams.get("folder") || "inbox";
      requestedFolders.push(folder);
      if (folder === "inbox") await new Promise((resolve) => setTimeout(resolve, 350));
      const item = folder === "starred" ? message("starred-mail", "新的星标邮件", true) : message("inbox-mail", "过期的收件箱邮件", false);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [item], total: 1 }) }).catch(() => {});
    });

    await page.goto("/admin?tab=mailbox");
    await expect.poll(() => requestedFolders).toContain("inbox");
    await page.getByRole("button", { name: "已星标" }).click();
    await expect(page.getByRole("button", { name: "打开邮件 新的星标邮件" })).toBeVisible();
    await page.waitForTimeout(450);
    await expect(page.getByText("过期的收件箱邮件")).toHaveCount(0);
  });

  test("快速选择邮件时旧详情响应不会覆盖新线程", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...user, id: "admin", email: "admin@nyy.app", is_admin: true }) }));
    const message = (id: string, subject: string, body: string) => ({ id, thread_id: id, subject, direction: "inbound", from: { email: `${id}@example.com` }, to: [{ email: "admin@nyy.app" }], snippet: body, body_text: body, received_at: "2026-07-22T09:30:00Z", is_read: true, is_starred: false, attachment_count: 0 });
    const first = message("mail-a", "第一封邮件", "第一封旧详情正文");
    const second = message("mail-b", "第二封邮件", "第二封最新详情正文");
    await page.route("**/api/v1/admin/mailbox/messages?**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [first, second], total: 2 }) }));
    await page.route("**/api/v1/admin/mailbox/messages/mail-a", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [first] }) }).catch(() => {});
    });
    await page.route("**/api/v1/admin/mailbox/messages/mail-b", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ messages: [second] }) }));

    await page.goto("/admin?tab=mailbox");
    await page.getByRole("button", { name: "打开邮件 第一封邮件" }).click();
    await page.getByRole("button", { name: "打开邮件 第二封邮件" }).click();
    const detail = page.getByTestId("mailbox-desktop-detail");
    await expect(detail.getByText("第二封最新详情正文")).toBeVisible();
    await page.waitForTimeout(450);
    await expect(detail.getByText("第一封旧详情正文")).toHaveCount(0);
  });

  test("邮件超过 50 封时可继续加载后续页面", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      const originalSetInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => originalSetInterval(handler, timeout === 60_000 ? 2_000 : timeout, ...args)) as typeof window.setInterval;
    });
    await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...user, id: "admin", email: "admin@nyy.app", is_admin: true }) }));
    const message = (index: number) => ({ id: `mail-${index}`, thread_id: `thread-${index}`, subject: `分页邮件 ${index}`, direction: "inbound", from: { email: `sender-${index}@example.com` }, to: [{ email: "admin@nyy.app" }], snippet: `正文 ${index}`, body_text: `正文 ${index}`, received_at: "2026-07-22T09:30:00Z", is_read: true, is_starred: false, attachment_count: 0 });
    const requestedPages: number[] = [];
    await page.route("**/api/v1/admin/mailbox/messages?**", async (route) => {
      const requestedPage = Number(new URL(route.request().url()).searchParams.get("page") || 1);
      requestedPages.push(requestedPage);
      const items = requestedPage === 1 ? Array.from({ length: 50 }, (_, index) => message(index + 1)) : [message(51)];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, total: 51, page: requestedPage, page_size: 50 }) });
    });

    await page.goto("/admin?tab=mailbox");
    const mailbox = page.getByTestId("admin-mailbox");
    await expect(mailbox.getByRole("button", { name: "打开邮件 分页邮件 1", exact: true })).toBeVisible();
    await mailbox.getByRole("button", { name: /加载更多/ }).click();
    await expect(mailbox.getByRole("button", { name: "打开邮件 分页邮件 51" })).toBeVisible();
    await expect(mailbox.getByRole("button", { name: /加载更多/ })).toHaveCount(0);
    await expect.poll(() => requestedPages.filter((requestedPage) => requestedPage === 2).length).toBeGreaterThanOrEqual(2);
    await expect(mailbox.getByRole("button", { name: "打开邮件 分页邮件 51" })).toBeVisible();
    const pageTwoRequestsBeforeManualRefresh = requestedPages.filter((requestedPage) => requestedPage === 2).length;
    await page.getByRole("button", { name: "刷新当前" }).click();
    await expect.poll(() => requestedPages.filter((requestedPage) => requestedPage === 2).length).toBeGreaterThan(pageTwoRequestsBeforeManualRefresh);
    await expect(mailbox.getByRole("button", { name: "打开邮件 分页邮件 51" })).toBeVisible();
  });
});
