import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // 本地默认手动启动；CI 通过环境变量启用自动服务。
  webServer: process.env.PLAYWRIGHT_WEB_SERVER
    ? {
        command: process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120000,
      }
    : undefined,
});
