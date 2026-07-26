import { expect, test, type Page } from "@playwright/test";

const SHARES_RESPONSE = {
  shares: [
    {
      code: "abc123",
      title: null,
      preview_files: ["alpha.txt", "beta.pdf"],
      empty_dir_count: 1,
      file_count: 3,
      total_bytes: 4096,
      has_password: true,
      download_count: 2,
      max_downloads: 10,
      last_downloaded_at: new Date("2026-06-06T03:00:00Z").toISOString(),
      created_at: new Date("2026-06-05T03:00:00Z").toISOString(),
      expires_at: new Date("2027-06-20T03:00:00Z").toISOString(),
      revoked: false,
    },
  ],
  total: 1,
  page: 1,
  page_size: 10,
};

const INBOX_RESPONSE = {
  groups: [
    {
      code: "rq1234",
      title: "设计稿收件",
      created_at: new Date("2026-06-05T04:00:00Z").toISOString(),
      expires_at: new Date("2027-06-20T04:00:00Z").toISOString(),
      file_count: 1,
      total_bytes: 2048,
      max_files: 5,
      max_bytes: 1_048_576,
      has_password: false,
      revoked: false,
      files: [
        {
          id: "file-1",
          request_code: "rq1234",
          file_name: "design-final.pdf",
          file_size: 2048,
          created_at: new Date("2026-06-06T04:00:00Z").toISOString(),
        },
      ],
    },
  ],
  total: 1,
  page: 1,
  page_size: 10,
};

async function loginWorkbench(page: Page) {
  await page.route("**/api/v1/auth/refresh", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ access_token: "e2e-token", token_type: "bearer", expires_in: 900 }),
    });
  });
  await page.route("**/api/v1/auth/me", async (route) => {
    const auth = route.request().headers().authorization || "";
    if (!auth.includes("e2e-token")) {
      await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ detail: "未登录" }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "user-1", email: "e2e@example.com", plan: "free", email_verified: true }),
    });
  });
}

async function mockWorkbenchApi(page: Page) {
  let lastPatchBody: unknown = null;
  let lastRequestPatchBody: unknown = null;
  let requestRevoked = false;
  await page.route("**/api/v1/my/shares**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(SHARES_RESPONSE) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/my/shares/abc123", async (route) => {
    if (route.request().method() === "PATCH") {
      lastPatchBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "修改成功" }) });
      return;
    }
    if (route.request().method() === "DELETE") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "分享已撤销" }) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/file-requests/my/inbox**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(INBOX_RESPONSE) });
  });
  await page.route("**/api/v1/file-requests/my/rq1234", async (route) => {
    if (route.request().method() === "PATCH") {
      lastRequestPatchBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "修改成功" }) });
      return;
    }
    if (route.request().method() === "DELETE") {
      requestRevoked = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "收件链接已撤销" }) });
      return;
    }
    await route.fallback();
  });
  await page.route("**/api/v1/file-requests/my/files/file-1/download", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ download_url: "https://download.test/design-final.pdf" }) });
  });
  await page.route("https://download.test/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/pdf", body: "pdf" });
  });
  return {
    getLastPatchBody: () => lastPatchBody,
    getLastRequestPatchBody: () => lastRequestPatchBody,
    isRequestRevoked: () => requestRevoked,
  };
}

test.describe("我的工作台", () => {
  test("分享列表展示摘要并支持清除提取码编辑", async ({ page }) => {
    await loginWorkbench(page);
    const api = await mockWorkbenchApi(page);

    await page.goto("/my");
    await expect(page.getByText("我的工作台")).toBeVisible();
    await expect(page.getByText("/abc123")).toBeVisible();
    await expect(page.getByText("alpha.txt")).toBeVisible();
    await expect(page.getByText("等 1 个")).toBeVisible();

    await page.getByRole("button", { name: "编辑" }).click();
    await page.getByRole("checkbox", { name: "清除当前提取码" }).check();
    await page.getByLabel("下载次数").selectOption("200");
    await page.getByRole("button", { name: "保存", exact: true }).click();

    await expect.poll(() => api.getLastPatchBody()).toMatchObject({ password: "", max_downloads: 200 });
  });

  test("收件箱分组展示并支持单文件下载", async ({ page }) => {
    await loginWorkbench(page);
    await mockWorkbenchApi(page);

    await page.goto("/my?tab=inbox");
    await expect(page.getByText("设计稿收件")).toBeVisible();
    await expect(page.getByText("design-final.pdf")).toBeVisible();
    await expect(page.getByText("剩余 4 个")).toBeVisible();

    const downloadRequest = page.waitForRequest("**/api/v1/file-requests/my/files/file-1/download");
    await page.getByRole("button", { name: "下载" }).click();
    await downloadRequest;
  });

  test("收件箱支持编辑和撤销收件链接", async ({ page }) => {
    await loginWorkbench(page);
    const api = await mockWorkbenchApi(page);

    await page.goto("/my?tab=inbox");
    await page.getByRole("button", { name: "编辑" }).click();
    await page.getByLabel("收件标题", { exact: true }).fill("更新收件标题");
    await page.getByLabel("有效期").selectOption("24");
    await page.getByLabel("最大文件数").fill("4");
    await page.getByRole("button", { name: "保存", exact: true }).click();

    await expect.poll(() => api.getLastRequestPatchBody()).toMatchObject({
      title: "更新收件标题",
      extend_hours: 24,
      max_files: 4,
    });

    await page.getByRole("button", { name: "撤销" }).click();
    const dialog = page.getByRole("dialog", { name: "撤销收件链接" });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "撤销并移除文件" }).click();
    await expect.poll(() => api.isRequestRevoked()).toBe(true);
  });
});
