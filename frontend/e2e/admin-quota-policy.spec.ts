import { expect, test } from "@playwright/test";
import { DEFAULT_QUOTA_POLICY } from "../src/lib/quota-policy";

test("配额策略台在移动端完成草稿预览与发布", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.route("**/api/v1/auth/me", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: "admin", email: "admin@nyy.app", plan: "admin", is_admin: true, email_verified: true }),
  }));

  const now = "2026-07-26T08:00:00Z";
  const published = {
    id: "00000000-0000-4000-8000-000000000001",
    version: 1,
    status: "published",
    config: structuredClone(DEFAULT_QUOTA_POLICY.config),
    note: "当前策略",
    effective_at: now,
    published_at: now,
    created_at: now,
    updated_at: now,
    created_by: null,
    published_by: null,
    rollback_from_id: null,
  };
  const draft = {
    ...published,
    id: "00000000-0000-4000-8000-000000000002",
    version: 2,
    status: "draft",
    note: "移动端策略草稿",
    effective_at: null,
    published_at: null,
  };
  let items = [draft, published];
  let publishedBody: Record<string, unknown> | null = null;

  await page.route("**/api/v1/admin/quota-policies**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, current_id: published.id }) });
      return;
    }
    if (pathname.endsWith("/preview")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ valid: true, errors: [], warnings: ["游客周期额度将降低"], changed_fields: ["guest.period_limit_bytes"], over_limit_identities: 0, technical: {}, config_hash: "a".repeat(64), updated_at: now }) });
      return;
    }
    if (pathname.endsWith("/publish")) {
      publishedBody = request.postDataJSON() as Record<string, unknown>;
      items = [{ ...draft, status: "published", effective_at: now, published_at: now }, published];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items[0]) });
      return;
    }
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { config: typeof draft.config; note: string };
      items = [{ ...draft, config: body.config, note: body.note }, published];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(items[0]) });
      return;
    }
    await route.abort();
  });

  await page.goto("/admin?tab=quota");
  await expect(page.getByRole("heading", { name: "配额策略 v2" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByLabel("发布说明").fill("移动端发布验证");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "影响预览" }).click();
  await expect(page.getByRole("heading", { name: /影响预览/ })).toBeVisible();
  await page.getByRole("button", { name: "立即发布" }).click();
  await expect.poll(() => publishedBody?.expected_config_hash).toBe("a".repeat(64));
});
