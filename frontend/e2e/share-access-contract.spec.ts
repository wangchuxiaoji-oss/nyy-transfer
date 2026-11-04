import { expect, test } from "@playwright/test";
import { mockDownloadConfig } from "./test-helpers";

const CODE = "access-contract-e2e";

test("公开分享分层埋点且自动预览优先 POST 并携带幂等 ID", async ({ page }) => {
  const events: string[] = [];
  const requestIds: string[] = [];
  const intents: string[] = [];
  let downloadCalls = 0;
  await page.route(`**/api/v1/shares/${CODE}`, async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: CODE, files: [{ file_name: "contract.txt", file_size: 12, file_ext: "txt", content_type: "text/plain", index: 0, is_chunked: false, chunk_count: 1, media_metadata: null }], empty_dirs: [], total_bytes: 12, created_at: "2026-07-20T00:00:00Z", expires_at: null, download_count: 0, max_downloads: 0, has_password: false }) }));
  await page.route(`**/api/v1/shares/${CODE}/interaction`, async (route) => {
    const body = route.request().postDataJSON() as { event_type: string; request_id: string };
    events.push(body.event_type);
    requestIds.push(body.request_id);
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route(`**/api/v1/shares/${CODE}/download-session`, async (route) => {
    downloadCalls += 1;
    expect(route.request().method()).toBe("POST");
    const body = route.request().postDataJSON() as { request_id: string; intent: string };
    expect(route.request().headers()["x-nyy-link-request-id"]).toBe(body.request_id);
    expect(body.intent).toBe("preview");
    intents.push(body.intent);
    requestIds.push(body.request_id);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ files: [{ file_name: "contract.txt", file_size: 12, content_type: "text/plain", is_chunked: false, download_url: "https://example.com/contract.txt", chunks: [], media_metadata: null }], empty_dirs: [], expires_in: 3600 }) });
  });
  await mockDownloadConfig(page);
  await page.route("https://example.com/**", async (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "contract" }));

  await page.goto(`/${CODE}`);
  await expect.poll(() => events).toContain("page_rendered");
  await expect.poll(() => downloadCalls).toBe(1);
  expect(intents).toEqual(["preview"]);
  await expect(page.getByRole("button", { name: "获取下载链接" })).toHaveCount(0);
  await page.locator("main").click({ position: { x: 8, y: 8 } });
  await expect.poll(() => events).toContain("human_interaction");
  expect(new Set(requestIds).size).toBe(requestIds.length);
});
