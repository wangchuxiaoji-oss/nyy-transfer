import { expect, test, type Locator, type Page } from "@playwright/test";
import { createOfficeFixture, createPdfFixture, OFFICE_FIXTURE_MIME } from "./office-fixtures";

type OfficeExtension = keyof typeof OFFICE_FIXTURE_MIME;
type OfficeKind = "document" | "spreadsheet" | "presentation";

interface ShareMockOptions {
  extension: string;
  contentType: string;
  body: Buffer;
  fileSize?: number;
  externalDelayMs?: number;
  externalStatus?: number;
  backupStatus?: number;
}

interface ShareMockResult {
  code: string;
  fileName: string;
  externalRequests: () => number;
  backupRequests: () => number;
}

const NOW = "2026-07-24T00:00:00.000Z";
const SUPPORTED_KINDS: Record<OfficeExtension, OfficeKind> = {
  docx: "document",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  pptx: "presentation",
};
const READY_MARKERS: Record<OfficeExtension, string> = {
  docx: "Office DOCX fixture",
  xls: "Office XLS fixture",
  xlsx: "Office XLSX fixture",
  pptx: "Office PPTX fixture",
};

let mockSerial = 0;

function fixture(extension: OfficeExtension, options: { compressed?: boolean; long?: boolean; dangerous?: boolean; external?: boolean; externalCss?: boolean } = {}): Buffer {
  return Buffer.from(createOfficeFixture(extension, options));
}

async function routeShare(page: Page, options: ShareMockOptions): Promise<ShareMockResult> {
  mockSerial += 1;
  const code = `office-${options.extension}-${mockSerial}`;
  const fileName = `预览样例.${options.extension}`;
  const fileSize = options.fileSize ?? options.body.byteLength;
  const downloadUrl = `https://office-fixtures.test/${code}/${encodeURIComponent(fileName)}`;
  const backupUrl = `https://office-backup.test/${code}/${encodeURIComponent(fileName)}`;
  let externalRequestCount = 0;
  let backupRequestCount = 0;

  const shareFile = {
    file_name: fileName,
    file_size: fileSize,
    file_ext: options.extension,
    content_type: options.contentType,
    index: 0,
    is_chunked: false,
    chunk_count: 0,
    media_metadata: null,
  };
  const downloadFile = {
    file_name: fileName,
    file_size: fileSize,
    content_type: options.contentType,
    is_chunked: false,
    download_url: downloadUrl,
    backup_download_url: options.backupStatus ? backupUrl : "",
    chunks: [],
    media_metadata: null,
  };

  await page.route("**/api/v1/shares/download-config", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        smart_download_enabled: true,
        target_video: true,
        target_audio: true,
        target_pdf: true,
        target_image: true,
        target_other: true,
        filesystem_access_enabled: true,
        leave_warning_enabled: true,
      }),
    });
  });
  await page.route(`**/api/v1/shares/${code}/interaction`, async (route) => {
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route(`**/api/v1/shares/${code}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        code,
        files: [shareFile],
        empty_dirs: ["fixture-empty/"],
        total_bytes: fileSize,
        created_at: NOW,
        expires_at: null,
        download_count: 0,
        max_downloads: 0,
        has_password: false,
      }),
    });
  });
  await page.route(`**/api/v1/shares/${code}/download-session`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ files: [downloadFile], empty_dirs: ["fixture-empty/"], expires_in: 3600 }),
    });
  });
  await page.route(downloadUrl, async (route) => {
    externalRequestCount += 1;
    if (options.externalDelayMs) await new Promise((resolve) => setTimeout(resolve, options.externalDelayMs));
    await route.fulfill({
      status: options.externalStatus ?? 200,
      contentType: options.contentType,
      body: options.body,
    });
  });
  if (options.backupStatus) {
    await page.route(backupUrl, async (route) => {
      backupRequestCount += 1;
      await route.fulfill({ status: options.backupStatus, contentType: options.contentType, body: options.body });
    });
  }

  return { code, fileName, externalRequests: () => externalRequestCount, backupRequests: () => backupRequestCount };
}

async function routeOfficeShare(
  page: Page,
  extension: OfficeExtension,
  options: Omit<Partial<ShareMockOptions>, "extension" | "contentType" | "body"> & { body?: Buffer; compressed?: boolean; long?: boolean; dangerous?: boolean; external?: boolean; externalCss?: boolean } = {},
): Promise<ShareMockResult> {
  return routeShare(page, {
    extension,
    contentType: OFFICE_FIXTURE_MIME[extension],
    body: options.body ?? fixture(extension, {
      compressed: options.compressed,
      long: options.long,
      dangerous: options.dangerous,
      external: options.external,
      externalCss: options.externalCss,
    }),
    fileSize: options.fileSize,
    externalDelayMs: options.externalDelayMs,
    externalStatus: options.externalStatus,
    backupStatus: options.backupStatus,
  });
}

async function openShare(page: Page, mock: ShareMockResult): Promise<Locator> {
  await page.goto(`/${mock.code}`);
  await page.getByRole("button", { name: "获取下载链接" }).click();
  return page.getByTestId("office-preview");
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="office-preview"]');
    const rootRect = root?.getBoundingClientRect();
    return {
      documentScrollWidth: document.documentElement.scrollWidth,
      documentClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body.scrollWidth,
      rootLeft: rootRect?.left ?? 0,
      rootRight: rootRect?.right ?? 0,
      viewportWidth: window.innerWidth,
    };
  });
  expect(metrics.documentScrollWidth).toBeLessThanOrEqual(metrics.documentClientWidth + 1);
  expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.rootLeft).toBeGreaterThanOrEqual(-1);
  expect(metrics.rootRight).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

function parseRgb(value: string): [number, number, number] {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) throw new Error(`无法解析颜色：${value}`);
  return [channels[0], channels[1], channels[2]];
}

function luminance(value: string): number {
  const channels = parseRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(first: string, second: string): number {
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

async function officeThemeColors(page: Page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="office-preview-stage"]');
    const documentPage = document.querySelector('[data-testid="office-preview-document"]');
    if (!stage || !documentPage) throw new Error("Office 主题测试节点不存在");
    const stageStyle = getComputedStyle(stage);
    const documentStyle = getComputedStyle(documentPage);
    return {
      stageBackground: stageStyle.backgroundColor,
      documentBackground: documentStyle.backgroundColor,
      documentColor: documentStyle.color,
    };
  });
}

async function installStateRecorder(page: Page) {
  await page.addInitScript(() => {
    const stateWindow = window as Window & { __officePreviewStateHistory?: string[] };
    stateWindow.__officePreviewStateHistory = [];
    const collect = () => {
      const state = document.querySelector('[data-testid="office-preview"]')?.getAttribute("data-state");
      if (state && !stateWindow.__officePreviewStateHistory?.includes(state)) stateWindow.__officePreviewStateHistory?.push(state);
    };
    const start = () => {
      if (!document.documentElement) {
        requestAnimationFrame(start);
        return;
      }
      new MutationObserver(collect).observe(document.documentElement, { attributes: true, childList: true, subtree: true });
      collect();
    };
    start();
  });
}

test.describe("Office 预览分类与回退", () => {
  for (const extension of Object.keys(SUPPORTED_KINDS) as OfficeExtension[]) {
    test(`${extension} 分类后进入对应 Office 预览`, async ({ page }) => {
      const mock = await routeOfficeShare(page, extension);
      const preview = await openShare(page, mock);

      await expect(preview).toBeVisible({ timeout: 10000 });
      await expect(preview).toHaveAttribute("data-kind", SUPPORTED_KINDS[extension]);
      await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 20000 });
      await expect(preview).toContainText(READY_MARKERS[extension]);
    });
  }

  test("doc、ppt、docm、xlsm、pptm 保持下载回退且不拉取预览内容", async ({ page }) => {
    const extensions = ["doc", "ppt", "docm", "xlsm", "pptm"];
    for (const extension of extensions) {
      await test.step(extension, async () => {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        const contentType = extension.startsWith("xls") ? "application/vnd.ms-excel" : "application/octet-stream";
        const mock = await routeShare(page, { extension, contentType, body: Buffer.from("unsupported") });
        await page.goto(`/${mock.code}`);
        await page.getByRole("button", { name: "获取下载链接" }).click();

        await expect(page.getByTestId("office-preview")).toHaveCount(0);
        const fallback = page.getByTestId("office-preview-fallback");
        await expect(fallback).toBeVisible();
        await expect(fallback).toContainText(mock.fileName);
        await expect(fallback).toContainText(/暂不支持.*在线预览|请下载后查看/);
        await expect(fallback.getByRole("button", { name: /下载(查看|此文件)/ })).toBeVisible();
        expect(mock.externalRequests()).toBe(0);
      });
    }
  });
});

test.describe("Office 预览主题", () => {
  test("浅色文档舞台不使用黑色背景", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("nyy-theme", "light"));
    const preview = await openShare(page, await routeOfficeShare(page, "docx"));
    await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const colors = await officeThemeColors(page);
    expect(luminance(colors.stageBackground)).toBeGreaterThan(0.55);
    expect(luminance(colors.documentBackground)).toBeGreaterThan(0.75);
    expect(contrastRatio(colors.documentBackground, colors.documentColor)).toBeGreaterThanOrEqual(4.5);
  });

  test("深色文档舞台保持暗色且正文可读", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("nyy-theme", "dark"));
    const preview = await openShare(page, await routeOfficeShare(page, "docx"));
    await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    const colors = await officeThemeColors(page);
    expect(luminance(colors.stageBackground)).toBeLessThan(0.4);
    expect(contrastRatio(colors.documentBackground, colors.documentColor)).toBeGreaterThanOrEqual(4.5);
  });
});

test("浅色 PDF 舞台无黑底、隐藏滚动条并释放离屏画布", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("nyy-theme", "light"));
  const mock = await routeShare(page, {
    extension: "pdf",
    contentType: "application/pdf",
    body: createPdfFixture(12),
  });
  await page.goto(`/${mock.code}`);
  await page.getByRole("button", { name: "获取下载链接" }).click();
  const stage = page.getByTestId("preview-stage");
  const scroller = page.getByTestId("pdf-preview-scroll");
  await expect(stage).toHaveAttribute("data-preview-kind", "document");
  const firstCanvas = scroller.locator("canvas").first();
  await expect(firstCanvas).toBeVisible({ timeout: 15000 });
  await expect.poll(() => firstCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(1);
  const background = await stage.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(luminance(background)).toBeGreaterThan(0.55);
  await scroller.hover();
  await page.mouse.wheel(0, 420);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(scroller).toHaveAttribute("data-scrolling", "true");
  await expect(scroller).not.toHaveAttribute("data-scrolling", "true", { timeout: 2500 });
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => firstCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width), { timeout: 10000 }).toBe(1);
  await scroller.evaluate((element) => { element.scrollTop = 0; });
  await expect.poll(() => firstCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width), { timeout: 10000 }).toBeGreaterThan(1);
});

test("PDF 页面尺寸异常时拒绝创建超大画布", async ({ page }) => {
  const mock = await routeShare(page, {
    extension: "pdf",
    contentType: "application/pdf",
    body: createPdfFixture(1, { width: 1, height: 100_000_000 }),
  });
  await page.goto(`/${mock.code}`);
  await page.getByRole("button", { name: "获取下载链接" }).click();

  await expect(page.getByTestId("pdf-preview-scroll").getByRole("alert")).toContainText("PDF 页面尺寸异常", { timeout: 15000 });
});

test("PDF 主预览源失败后自动切换备用源", async ({ page }) => {
  const mock = await routeShare(page, {
    extension: "pdf",
    contentType: "application/pdf",
    body: createPdfFixture(2),
    externalStatus: 503,
    backupStatus: 200,
  });
  await page.goto(`/${mock.code}`);
  await page.getByRole("button", { name: "获取下载链接" }).click();

  await expect(page.getByTestId("pdf-preview-scroll").locator("canvas").first()).toBeVisible({ timeout: 15000 });
  expect(mock.externalRequests()).toBe(1);
  expect(mock.backupRequests()).toBeGreaterThan(0);
});

test.describe("Office 预览滚动", () => {
  test("PC 滚动时标记 data-scrolling 并在停止后自动移除", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const preview = await openShare(page, await routeOfficeShare(page, "docx", { long: true }));
    await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
    const scroller = page.getByTestId("office-preview-scroll");
    await expect(scroller).toBeVisible();
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    await scroller.hover();
    await page.mouse.wheel(0, 480);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(scroller).toHaveAttribute("data-scrolling", "true");
    await expect(scroller).not.toHaveAttribute("data-scrolling", "true", { timeout: 2500 });
  });
});

test.describe("Office 预览触屏滚动条", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("触屏视口通过 DOM 和 CSS 隐藏常驻滚动条", async ({ page }) => {
    const preview = await openShare(page, await routeOfficeShare(page, "docx", { long: true }));
    await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
    const scrollbarPolicy = await page.getByTestId("office-preview-scroll").evaluate((element) => {
      const style = getComputedStyle(element);
      const webkitScrollbar = getComputedStyle(element, "::-webkit-scrollbar");
      return {
        coarsePointer: matchMedia("(pointer: coarse)").matches,
        scrollbarWidth: style.scrollbarWidth,
        webkitDisplay: webkitScrollbar.display,
        webkitWidth: webkitScrollbar.width,
      };
    });

    expect(scrollbarPolicy.coarsePointer).toBe(true);
    expect(
      scrollbarPolicy.scrollbarWidth === "none" ||
      scrollbarPolicy.webkitDisplay === "none" ||
      scrollbarPolicy.webkitWidth === "0px",
    ).toBe(true);
  });
});

test.describe("Office 预览状态", () => {
  test("明确经历下载、解析、就绪状态", async ({ page }) => {
    await installStateRecorder(page);
    const preview = await openShare(page, await routeOfficeShare(page, "docx", { externalDelayMs: 600 }));

    await expect(preview).toHaveAttribute("data-state", "downloading");
    await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
    const history = await page.evaluate(() => (window as Window & { __officePreviewStateHistory?: string[] }).__officePreviewStateHistory || []);
    expect(history).toEqual(expect.arrayContaining(["downloading", "parsing", "ready"]));
  });

  test("下载失败和解析失败显示可恢复错误", async ({ page }) => {
    const cases = [
      { name: "下载失败", options: { externalStatus: 503 }, message: /下载.*失败|无法下载/ },
      { name: "解析失败", options: { body: Buffer.from("not-an-office-file") }, message: /解析.*失败|文件已损坏|格式无效/ },
    ];
    for (const scenario of cases) {
      await test.step(scenario.name, async () => {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        const preview = await openShare(page, await routeOfficeShare(page, "docx", scenario.options));
        await expect(preview).toHaveAttribute("data-state", "error", { timeout: 10000 });
        await expect(preview).toContainText(scenario.message);
        await expect(preview.getByRole("button", { name: "重试预览" })).toBeVisible();
        await expect(preview.getByRole("button", { name: "下载查看" })).toBeVisible();
      });
    }
  });

  test("Office 主预览源失败后自动切换备用源", async ({ page }) => {
    const mock = await routeOfficeShare(page, "docx", { externalStatus: 503, backupStatus: 200 });
    const preview = await openShare(page, mock);

    await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
    expect(mock.externalRequests()).toBe(1);
    expect(mock.backupRequests()).toBe(1);
  });

  test("Deflate 压缩的 DOCX 通过 Worker 预检并完成渲染", async ({ page }) => {
    const preview = await openShare(page, await routeOfficeShare(page, "docx", { compressed: true }));

    await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
    await expect(preview).toContainText("Office DOCX fixture");
  });

  test("包含外部媒体关系的 Office 文件会被阻止", async ({ page }) => {
    const preview = await openShare(page, await routeOfficeShare(page, "docx", { external: true }));

    await expect(preview).toHaveAttribute("data-state", "error", { timeout: 10000 });
    await expect(preview).toContainText(/外部媒体|外部资源|无法预览/);
    await expect(preview.getByRole("button", { name: "下载查看" })).toBeVisible();
  });

  test("PPTX 伪装为 hyperlink 的外部关系会被阻止", async ({ page }) => {
    const preview = await openShare(page, await routeOfficeShare(page, "pptx", { external: true }));

    await expect(preview).toHaveAttribute("data-state", "error", { timeout: 10000 });
    await expect(preview).toContainText(/外部媒体|外部资源|无法预览/);
  });

  test("DOCX 注入的外部 CSS 不会发起网络请求", async ({ page }) => {
    let styleRequests = 0;
    await page.route("https://office-style.invalid/**", async (route) => {
      styleRequests += 1;
      await route.abort();
    });
    const preview = await openShare(page, await routeOfficeShare(page, "docx", { externalCss: true }));

    await expect(preview).toHaveAttribute("data-state", "error", { timeout: 10000 });
    await expect(preview).toContainText(/外部样式资源|无法预览/);
    expect(styleRequests).toBe(0);
  });

  test("超限文件不发起内容请求并显示下载回退", async ({ page }) => {
    const mock = await routeOfficeShare(page, "xlsx", { fileSize: 256 * 1024 * 1024 });
    const preview = await openShare(page, mock);

    await expect(preview).toHaveAttribute("data-state", "too-large", { timeout: 10000 });
    await expect(preview).toContainText(/文件过大|超出.*预览.*限制/);
    await expect(preview.getByRole("button", { name: /下载(查看|此文件)/ })).toBeVisible();
    expect(mock.externalRequests()).toBe(0);
  });

  test("PPTX 单独允许 100MiB，超过 100MiB 时不发起内容请求", async ({ page }) => {
    const accepted = await routeOfficeShare(page, "pptx", { fileSize: 100 * 1024 * 1024 });
    const acceptedPreview = await openShare(page, accepted);
    await expect(acceptedPreview).toHaveAttribute("data-state", "ready", { timeout: 20000 });
    expect(accepted.externalRequests()).toBe(1);

    await page.unrouteAll({ behavior: "ignoreErrors" });
    const rejected = await routeOfficeShare(page, "pptx", { fileSize: 100 * 1024 * 1024 + 1 });
    const rejectedPreview = await openShare(page, rejected);
    await expect(rejectedPreview).toHaveAttribute("data-state", "too-large", { timeout: 10000 });
    await expect(rejectedPreview.getByRole("button", { name: "下载查看" })).toBeVisible();
    expect(rejected.externalRequests()).toBe(0);
  });
});

test("mobile、pad、desktop 的 Office 舞台均不造成页面横向溢出", async ({ page }) => {
  const viewports = [
    { name: "mobile", width: 390, height: 844 },
    { name: "pad", width: 820, height: 1180 },
    { name: "desktop", width: 1440, height: 900 },
  ];

  for (const viewport of viewports) {
    await test.step(viewport.name, async () => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const preview = await openShare(page, await routeOfficeShare(page, "xlsx", { long: true }));
      await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
      await expectNoHorizontalOverflow(page);
    });
  }
});

test("Office 内容不执行危险 HTML、javascript 链接或外部公式", async ({ page }) => {
  await page.addInitScript(() => {
    (window as Window & { __officePreviewPwned?: number }).__officePreviewPwned = 0;
  });
  const scenarios: Array<{ extension: OfficeExtension; visibleText: string }> = [
    { extension: "docx", visibleText: "window.__officePreviewPwned=1" },
    { extension: "xlsx", visibleText: "危险公式" },
  ];

  for (const scenario of scenarios) {
    await test.step(scenario.extension, async () => {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      let formulaRequests = 0;
      const mock = await routeOfficeShare(page, scenario.extension, { dangerous: true });
      await page.route("https://office-formula.invalid/**", async (route) => {
        formulaRequests += 1;
        await route.abort();
      });
      const preview = await openShare(page, mock);
      await expect(preview).toHaveAttribute("data-state", "ready", { timeout: 10000 });
      await expect(preview).toContainText(scenario.visibleText);

      const security = await preview.evaluate((element) => {
        const roots: ParentNode[] = [element];
        element.querySelectorAll("*").forEach((node) => { if (node.shadowRoot) roots.push(node.shadowRoot); });
        const allNodes = roots.flatMap((root) => Array.from(root.querySelectorAll("*")));
        return {
          pwned: (window as Window & { __officePreviewPwned?: number }).__officePreviewPwned || 0,
          activeContent: roots.reduce((count, root) => count + root.querySelectorAll("script, iframe, object, embed").length, 0),
          unsafeLinks: roots.reduce((count, root) => count + root.querySelectorAll('a[href^="javascript:"], a[href^="data:text/html"]').length, 0),
          inlineHandlers: allNodes.some((node) => Array.from(node.attributes).some((attribute) => /^on/i.test(attribute.name))),
        };
      });
      expect(security).toEqual({ pwned: 0, activeContent: 0, unsafeLinks: 0, inlineHandlers: false });
      expect(formulaRequests).toBe(0);
    });
  }
});
