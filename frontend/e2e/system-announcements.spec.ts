import { expect, test, type Page } from "@playwright/test";

const publishedAt = "2026-07-25T01:20:00Z";

function announcement(revision = 1, priority: "normal" | "important" = "important") {
  return {
    id: "89c8f084-86fa-4fa8-a771-69d585297b1e",
    notice_id: `89c8f084-86fa-4fa8-a771-69d585297b1e:${revision}`,
    version: "2026.07.25",
    category: "maintenance",
    state: "completed",
    priority,
    title: "维护完成，上传和预览更稳定了",
    summary: "本次维护已经完成，现在可以正常上传和预览文件。",
    details: ["上传问题已经修复", "常见 Office 文档和 PDF 可以直接预览"],
    revision,
    started_at: "2026-07-24T15:34:00Z",
    completed_at: publishedAt,
    visible_until: null,
    published_at: publishedAt,
  };
}

async function routeGuestHome(page: Page) {
  await page.route("**/api/v1/auth/bootstrap", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ auth: { status: "guest", user: null, token_type: "bearer" }, quota: { used_bytes: 0, limit_bytes: 1024, remaining_bytes: 1024, ttl_hours: 24 } }),
  }));
  await page.route("**/api/v1/shares/guest-mine", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
}

test("重要更新每个 revision 在当前设备首次提示一次", async ({ page }) => {
  let revision = 1;
  await routeGuestHome(page);
  await page.route("**/api/v1/system/announcements?**", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [announcement(revision)], has_more: false, next_offset: null }),
  }));
  await page.addInitScript(() => localStorage.removeItem("nyy_system_notice_seen_v1"));

  await page.goto("/");
  const dialog = page.getByTestId("system-announcement-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("维护完成，上传和预览更稳定了");
  await dialog.getByRole("button", { name: "我知道了" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(dialog).toHaveCount(0);

  revision = 2;
  await page.reload();
  await expect(dialog).toBeVisible();
});

test("重要更新在 4K 和紧凑高度下只允许正文纵向滚动", async ({ page }) => {
  const longItem = {
    ...announcement(),
    title: "这是一条用于验证高分辨率与浏览器缩放的较长系统更新标题",
    summary: "弹窗外壳应保持稳定，装饰、标题和底部操作不参与滚动；只有中间正文区域可以通过滚轮、触控或键盘浏览。",
    details: Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 项更新说明用于验证长内容不会撑出横向滚动区域，同时保持正文清晰可读。`),
  };
  await routeGuestHome(page);
  await page.route("**/api/v1/system/announcements?**", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [longItem], has_more: false, next_offset: null }),
  }));
  await page.addInitScript(() => localStorage.removeItem("nyy_system_notice_seen_v1"));

  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.goto("/");
  const dialog = page.getByTestId("system-announcement-dialog");
  const scrollRegion = page.getByTestId("system-announcement-scroll-region");
  await expect(dialog).toBeVisible();

  for (const viewport of [{ width: 3840, height: 2160 }, { width: 960, height: 540 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => scrollRegion.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await expect(dialog.getByRole("button", { name: "我知道了" })).toBeVisible();
  }

  const compactMetrics = await scrollRegion.evaluate((element) => ({ scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
  expect(compactMetrics.scrollHeight).toBeGreaterThan(compactMetrics.clientHeight);
});

test("普通更新使用非阻塞电报卡，更新页保留完整历史", async ({ page }) => {
  await routeGuestHome(page);
  await page.route("**/api/v1/system/announcements?**", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ items: [announcement(1, "normal")], has_more: false, next_offset: null }),
  }));
  await page.addInitScript(() => localStorage.removeItem("nyy_system_notice_seen_v1"));

  await page.goto("/");
  await expect(page.getByTestId("system-announcement-card")).toBeVisible();
  await expect(page.getByTestId("system-announcement-dialog")).toHaveCount(0);
  await page.getByTestId("system-announcement-card").getByRole("link", { name: /看看改了什么/ }).click();

  await expect(page).toHaveURL(/\/updates$/);
  await expect(page.getByRole("heading", { name: "最近更新" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "维护完成，上传和预览更稳定了" })).toBeVisible();
  await expect(page.getByText(/完成时间：2026\/07\/25/)).toBeVisible();
});

test("后台发布台明确区分保存与发布通知", async ({ page }) => {
  const draft = {
    ...announcement(0, "normal"),
    notice_id: undefined,
    status: "draft",
    published_at: null,
    archived_at: null,
    created_at: publishedAt,
    updated_at: publishedAt,
    category: "release",
    state: "released",
    completed_at: null,
  };
  let createBody: Record<string, unknown> | null = null;
  let publishCalls = 0;

  await page.route("**/api/v1/auth/me", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "admin", email: "admin@nyy.app", plan: "admin", is_admin: true, email_verified: true }) }));
  await page.route("**/api/v1/admin/announcements**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [], total: 0, page: 1, page_size: 20, pages: 1 }) });
    } else if (request.method() === "POST" && url.pathname.endsWith("/announcements")) {
      createBody = request.postDataJSON();
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ ...draft, ...createBody }) });
    } else if (request.method() === "PATCH") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...draft, ...request.postDataJSON() }) });
    } else if (request.method() === "POST" && url.pathname.endsWith("/publish")) {
      publishCalls += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...draft, status: "published", revision: 1, published_at: publishedAt }) });
    } else {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "not found" }) });
    }
  });

  await page.goto("/admin?tab=announcements");
  await page.getByRole("button", { name: "新建公告" }).click();
  const editor = page.getByRole("dialog", { name: "新建系统公告" });
  await editor.getByLabel("标题").fill("版本更新已上线");
  await editor.getByLabel("摘要").fill("新增更新电报与维护时间线。");
  await editor.getByLabel(/更新清单/).fill("首次通知只显示一次\n完整历史永久可查");
  await editor.getByRole("button", { name: "保存内容" }).click();
  await expect.poll(() => createBody?.title).toBe("版本更新已上线");
  const savedEditor = page.getByRole("dialog", { name: /编辑 2026/ });
  await expect(savedEditor.getByRole("button", { name: "发布并通知" })).toBeVisible();
  await savedEditor.getByRole("button", { name: "发布并通知" }).click();
  await expect.poll(() => publishCalls).toBe(1);
  await expect(page.getByText(/用户将收到一次新提醒/)).toBeVisible();
});
