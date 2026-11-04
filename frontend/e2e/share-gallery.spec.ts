import { expect, test, type Page, type Route } from "@playwright/test";
import { mockDownloadConfig } from "./test-helpers";

const CODE = "gallery-e2e";
const NOW = "2026-07-27T00:00:00.000Z";
const TINY_IMAGE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const EXIF_JPEG = Buffer.from("ffd8ffe1002245786966000049492a000800000001000f010200040000004e59590000000000ffd9", "hex");

interface MockOptions {
  gallery?: (route: Route, call: number) => Promise<void>;
  galleryEligible?: boolean;
  hasPassword?: boolean;
  infoFiles?: ReturnType<typeof shareFile>[];
  onDownloadSession?: (body: Record<string, unknown>) => void;
  onOriginalRequest?: (url: string) => void | Promise<void>;
}

function shareFile(index: number, fileName = `${index < 5 ? "旅行相册" : index < 10 ? "家人合影" : ""}${index < 10 ? "/" : ""}photo-${String(index + 1).padStart(2, "0")}.jpg`) {
  return {
    file_name: fileName,
    file_size: TINY_IMAGE.length,
    file_ext: "jpg",
    content_type: "image/jpeg",
    index,
    is_chunked: false,
    chunk_count: 0,
    media_metadata: null,
  };
}

function galleryFile(index: number, status = "ready") {
  const file = shareFile(index);
  return {
    index,
    file_name: file.file_name,
    file_size: file.file_size,
    content_type: file.content_type,
    status,
    width: index % 3 === 0 ? 1200 : 1600,
    height: index % 3 === 0 ? 1600 : 1067,
    error_code: status === "failed" ? "PREVIEW_FAILED" : null,
    exif_summary: index === 0 ? { Camera: "NYY One", GPSLatitude: 31.2304, GPSLongitude: 121.4737 } : { Camera: `NYY ${index + 1}` },
    is_animated: false,
    frame_count: 1,
    assets: status === "ready" ? [
      { kind: "thumbnail_960", format: "webp", content_type: "image/webp", width: 960, height: index % 3 === 0 ? 1280 : 640, byte_size: TINY_IMAGE.length, download_url: `https://preview.test/960/${index}.webp`, backup_download_url: `https://preview-backup.test/960/${index}.webp` },
      { kind: "preview_2048", format: "webp", content_type: "image/webp", width: 1600, height: index % 3 === 0 ? 2133 : 1067, byte_size: TINY_IMAGE.length, download_url: `https://preview.test/2048/${index}.webp`, backup_download_url: `https://preview-backup.test/2048/${index}.webp` },
      ...(index === 0 ? [{ kind: "exif_json", format: "json", content_type: "application/json", width: 0, height: 0, byte_size: 64, download_url: "https://preview.test/exif/0.json", backup_download_url: "" }] : []),
    ] : [],
  };
}

function originalJpegGalleryFile(index: number, status = "ready") {
  const file = galleryFile(index, status);
  return {
    ...file,
    exif_summary: { Camera: "mock", GPSLatitude: 0, GPSLongitude: 0 },
    assets: status === "ready" ? [{
      kind: "original_preview",
      format: "jpeg",
      content_type: "image/jpeg",
      width: file.width,
      height: file.height,
      byte_size: TINY_IMAGE.length,
      download_url: `https://original.test/gallery/${index}.jpg`,
      backup_download_url: `https://original-backup.test/gallery/${index}.jpg`,
    }] : [],
  };
}

function galleryResponse(files = Array.from({ length: 12 }, (_, index) => galleryFile(index))) {
  return {
    eligible: true,
    files,
    ready_count: files.filter((file) => file.status === "ready").length,
    pending_count: files.filter((file) => file.status === "pending").length,
    failed_count: files.filter((file) => file.status === "failed").length,
    retry_after_seconds: 0.1,
    expires_in: 3600,
  };
}

async function fulfillJson(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockGalleryShare(page: Page, options: MockOptions = {}) {
  const files = options.infoFiles || Array.from({ length: 12 }, (_, index) => shareFile(index));
  let galleryCalls = 0;

  await page.route(`**/api/v1/shares/${CODE}/gallery-session`, async (route) => {
    galleryCalls += 1;
    if (options.gallery) await options.gallery(route, galleryCalls);
    else await fulfillJson(route, galleryResponse());
  });
  await page.route(`**/api/v1/shares/${CODE}/unlock`, async (route) => fulfillJson(route, {
    code: CODE,
    files,
    empty_dirs: [],
    total_bytes: files.reduce((total, file) => total + file.file_size, 0),
    created_at: NOW,
    expires_at: null,
    download_count: 0,
    max_downloads: 0,
    has_password: true,
    gallery_eligible: options.galleryEligible ?? true,
  }));
  await page.route(`**/api/v1/shares/${CODE}/download-session`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    options.onDownloadSession?.(body);
    const requested = Array.isArray(body.file_indices) ? body.file_indices as number[] : files.map((file) => file.index);
    await fulfillJson(route, {
      files: requested.map((index) => {
        const file = files.find((item) => item.index === index) || files[0];
        return {
          file_name: file.file_name,
          file_size: file.file_size,
          content_type: file.content_type,
          is_chunked: false,
          download_url: `https://original.test/${index}.jpg`,
          chunks: [],
          media_metadata: null,
        };
      }),
      empty_dirs: [],
      expires_in: 3600,
    });
  });
  await page.route(`**/api/v1/shares/${CODE}/interaction`, async (route) => route.fulfill({ status: 204, body: "" }));
  await page.route(`**/api/v1/shares/${CODE}`, async (route) => fulfillJson(route, {
    code: CODE,
    files: options.hasPassword ? [] : files,
    empty_dirs: [],
    total_bytes: files.reduce((total, file) => total + file.file_size, 0),
    created_at: NOW,
    expires_at: null,
    download_count: 0,
    max_downloads: 0,
    has_password: options.hasPassword || false,
    gallery_eligible: options.galleryEligible ?? true,
  }));
  await page.route("https://preview.test/**", async (route) => route.fulfill({ status: 200, contentType: "image/png", body: TINY_IMAGE }));
  await page.route("https://preview.test/exif/0.json", async (route) => fulfillJson(route, [{
    EXIF: { Make: "NYY", Model: "NYY One", ExposureTime: "1/250", LongValue: "metadata".repeat(180) },
    GPS: { Latitude: 31.2304, Longitude: 121.4737 },
  }]));
  await page.route("https://preview-backup.test/**", async (route) => route.fulfill({ status: 200, contentType: "image/png", body: TINY_IMAGE }));
  await page.route("https://original.test/**", async (route) => {
    await options.onOriginalRequest?.(route.request().url());
    const body = route.request().resourceType() === "fetch" ? EXIF_JPEG : TINY_IMAGE;
    await route.fulfill({
      status: 200,
      contentType: "image/jpeg",
      headers: { "Accept-Ranges": "bytes" },
      body,
    });
  });
  await mockDownloadConfig(page);
  return () => galleryCalls;
}

async function installDirectoryPicker(page: Page) {
  await page.addInitScript(() => {
    type MockDirectory = {
      getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<MockDirectory>;
      getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{
        createWritable: () => Promise<{ write: () => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> }>;
      }>;
    };
    const createDirectory = (): MockDirectory => {
      const files = new Set<string>();
      const directories = new Map<string, MockDirectory>();
      return {
        getDirectoryHandle: async (name: string, options?: { create?: boolean }) => {
          const existing = directories.get(name);
          if (existing) return existing;
          if (!options?.create) throw new DOMException("not found", "NotFoundError");
          const created = createDirectory();
          directories.set(name, created);
          return created;
        },
        getFileHandle: async (name: string, options?: { create?: boolean }) => {
          if (!files.has(name) && !options?.create) throw new DOMException("not found", "NotFoundError");
          files.add(name);
          return {
            createWritable: async () => ({
              write: async () => undefined,
              close: async () => undefined,
              abort: async () => undefined,
            }),
          };
        },
      };
    };
    const directory = createDirectory();
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => directory });
  });
}

test("gallery_eligible 自动加载分组画廊，桌面灯箱只预加载相邻派生图", async ({ page }) => {
  let downloadSessionCalls = 0;
  let originalRequests = 0;
  const getGalleryCalls = await mockGalleryShare(page, {
    onDownloadSession: () => { downloadSessionCalls += 1; },
    onOriginalRequest: () => { originalRequests += 1; },
  });

  await page.goto(`/${CODE}`);
  await expect(page.getByTestId("share-image-gallery")).toBeVisible({ timeout: 10000 });
  await expect.poll(getGalleryCalls).toBe(1);
  expect(downloadSessionCalls).toBe(0);
  await expect(page.getByRole("heading", { name: "旅行相册" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "家人合影" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "根目录" })).toBeVisible();

  const galleryImages = page.getByTestId("share-image-gallery").locator("img");
  await expect(galleryImages).toHaveCount(12);
  expect(await galleryImages.evaluateAll((images) => images.filter((image) => image.getAttribute("loading") === "eager").length)).toBe(10);
  expect(await galleryImages.evaluateAll((images) => images.filter((image) => image.getAttribute("loading") === "lazy").length)).toBe(2);

  await page.getByRole("button", { name: "在灯箱中查看 photo-01.jpg" }).click();
  await expect(page.locator(".yarl__root")).toBeVisible();
  const lightboxImages = page.locator(".yarl__slide img");
  await expect(lightboxImages).toHaveCount(3);
  await expect(lightboxImages.nth(1)).toHaveAttribute("src", /preview\.test\/(?:960|2048)\/0\.webp/);
  await expect(page.locator(".yarl__counter")).toContainText("1 / 12");
  await page.getByRole("button", { name: "下一张" }).click();
  await expect(lightboxImages.nth(1)).toHaveAttribute("src", /preview\.test\/(?:960|2048)\/1\.webp/);
  await expect(page.locator(".yarl__counter")).toContainText("2 / 12");
  await page.getByTestId("lightbox-select-current").click();
  await expect(page.getByTestId("lightbox-select-current")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "关闭灯箱" }).click();
  await expect(page.getByTestId("gallery-selection-bar")).toContainText("已选 1 张");
  expect(downloadSessionCalls).toBe(0);
  expect(originalRequests).toBe(0);
});

test("JPEG 原图直接预览并仅在打开面板时读取客户端 EXIF", async ({ page }) => {
  let originalRequests = 0;
  await mockGalleryShare(page, {
    gallery: async (route) => fulfillJson(
      route,
      galleryResponse(Array.from({ length: 12 }, (_, index) => originalJpegGalleryFile(index))),
    ),
    onOriginalRequest: () => { originalRequests += 1; },
  });

  await page.goto(`/${CODE}`);
  const galleryImages = page.getByTestId("share-image-gallery").locator("img");
  await expect(galleryImages.first()).toHaveAttribute("src", "https://original.test/gallery/0.jpg");
  await expect.poll(() => originalRequests).toBeGreaterThan(0);

  await page.getByRole("button", { name: "在灯箱中查看 photo-01.jpg" }).click();
  await expect(page.locator(".yarl__slide img").nth(1)).toHaveAttribute("src", "https://original.test/gallery/0.jpg");
  const requestsBeforeMetadata = originalRequests;
  await page.getByTestId("lightbox-metadata").click();

  const panel = page.getByTestId("gallery-metadata-panel");
  await expect(panel).toContainText("Make");
  await expect(panel).toContainText("NYY");
  await expect.poll(() => originalRequests).toBeGreaterThan(requestsBeforeMetadata);
});

test("静态 WebP、AVIF、HEIC 与动画源都只展示派生预览", async ({ page }) => {
  const names = ["static.webp", "static.avif", "camera.heic", "motion.webp", "photo.jpg", "photo.png"];
  const infoFiles = names.map((name, index) => shareFile(index, `formats/${name}`));
  let originalRequests = 0;
  await mockGalleryShare(page, {
    infoFiles,
    gallery: async (route) => fulfillJson(route, galleryResponse(names.map((name, index) => ({
      ...galleryFile(index),
      file_name: `formats/${name}`,
      is_animated: index === 3,
      frame_count: index === 3 ? 12 : 1,
    })))),
    onOriginalRequest: () => { originalRequests += 1; },
  });

  await page.goto(`/${CODE}`);
  await page.getByRole("button", { name: "在灯箱中查看 static.webp" }).click();
  const activeImage = page.locator(".yarl__slide img").nth(1);
  for (const [index, extension] of ["webp", "avif", "heic", "webp"].entries()) {
    await expect(activeImage).toHaveAttribute("src", new RegExp(`preview\\.test\\/(?:960|2048)\\/${index}\\.webp`));
    await expect(page.getByText(`${index === 3 ? "动画预览" : "高清预览"} · ${extension.toUpperCase()}`)).toBeVisible();
    if (index < 3) await page.getByRole("button", { name: "下一张" }).click();
  }
  expect(originalRequests).toBe(0);
});

test("微信移动端优先展示图片并区分长按保存与原图下载", async ({ page }) => {
  let originalRequests = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 MicroMessenger/8.0.50",
    });
  });
  await mockGalleryShare(page, { onOriginalRequest: () => { originalRequests += 1; } });

  await page.goto(`/${CODE}`);
  await expect(page.getByTestId("share-image-gallery")).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("gallery-top-bar")).toBeVisible();
  await expect(page.getByTestId("wechat-gallery-guide")).toHaveCount(0);
  await expect(page.getByTestId("gallery-selection-bar")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /选择 photo-/ })).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "分享内容视图" })).toHaveCount(0);
  await expect(page.getByTestId("gallery-download-all")).toHaveCount(0);

  const firstPhoto = page.getByRole("button", { name: "在灯箱中查看 photo-01.jpg" });
  const firstPhotoBounds = await firstPhoto.boundingBox();
  expect(firstPhotoBounds).not.toBeNull();
  expect(firstPhotoBounds?.y || 999).toBeLessThan(300);

  await page.getByTestId("gallery-details-trigger").click();
  const detailsSheet = page.getByTestId("gallery-details-sheet");
  await expect(detailsSheet).toBeVisible();
  await expect(detailsSheet.getByRole("heading", { name: "图片分享详情" })).toBeVisible();
  await expect(detailsSheet.getByRole("button", { name: "复制分享链接" })).toBeVisible();
  await detailsSheet.getByRole("button", { name: "关闭分享详情" }).click();

  await firstPhoto.click();
  await expect(page.getByTestId("lightbox-select-current")).toHaveCount(0);
  const mobileLightboxImages = page.locator(".yarl__slide img");
  await expect(mobileLightboxImages).toHaveCount(3);
  await expect(mobileLightboxImages.nth(1)).toHaveAttribute("src", /preview\.test\/(?:960|2048)\/0\.webp/);
  expect(originalRequests).toBe(0);
  await expect(page.getByText("长按图片可保存到相册或转发")).toBeVisible();
  await expect(page.getByText("点击右上角下载按钮获取原图文件")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载原图文件" })).toBeVisible();
  await page.getByRole("button", { name: "关闭长按保存提示" }).click();
  await expect(page.getByText("长按图片可保存到相册或转发")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭灯箱" }).click();

  await firstPhoto.click();
  await expect(page.getByText("长按图片可保存到相册或转发")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭灯箱" }).click();
});

test("普通移动浏览器隐藏多选但保留保存全部", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    });
  });
  await mockGalleryShare(page);

  await page.goto(`/${CODE}`);
  await expect(page.getByTestId("share-image-gallery")).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("button", { name: /选择 photo-/ })).toHaveCount(0);
  await expect(page.getByTestId("gallery-selection-bar")).toHaveCount(0);
  await expect(page.getByTestId("gallery-download-all")).toBeVisible();

  await page.getByRole("button", { name: "在灯箱中查看 photo-01.jpg" }).click();
  await expect(page.getByTestId("lightbox-select-current")).toHaveCount(0);
  await page.getByRole("button", { name: "关闭灯箱" }).click();
});

test("窄桌面窗口的网格与灯箱都保留选择入口", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 760 });
  await mockGalleryShare(page);

  await page.goto(`/${CODE}`);
  await expect(page.getByRole("button", { name: "选择 photo-01.jpg" })).toBeVisible({ timeout: 10000 });
  await page.getByRole("button", { name: "在灯箱中查看 photo-01.jpg" }).click();
  await expect(page.getByTestId("lightbox-select-current")).toBeVisible();
});

test("六张图片直接进入画廊，其他文件置底且整包保存保留目录", async ({ page }) => {
  await installDirectoryPicker(page);
  const mixedFiles = [
    ...Array.from({ length: 6 }, (_, index) => shareFile(index)),
    { ...shareFile(6, "photos/broken.avif"), file_ext: "avif", content_type: "image/avif" },
    { ...shareFile(7, "docs/readme.txt"), file_ext: "txt", content_type: "text/plain" },
    { ...shareFile(8, "vectors/logo.svg"), file_ext: "svg", content_type: "image/svg+xml" },
  ];
  const downloadBodies: Record<string, unknown>[] = [];
  let originalRequests = 0;
  await mockGalleryShare(page, {
    infoFiles: mixedFiles,
    gallery: async (route) => fulfillJson(route, galleryResponse([
      ...Array.from({ length: 6 }, (_, index) => galleryFile(index)),
      { ...galleryFile(6, "failed"), file_name: "photos/broken.avif", content_type: "image/avif" },
    ])),
    onDownloadSession: (body) => downloadBodies.push(body),
    onOriginalRequest: () => { originalRequests += 1; },
  });

  await page.goto(`/${CODE}`);
  await expect(page.getByTestId("share-image-gallery")).toBeVisible({ timeout: 10000 });
  await expect(page.getByRole("tablist", { name: "分享内容视图" })).toHaveCount(0);
  await expect(page.getByTestId("share-image-gallery").locator("img")).toHaveCount(6);

  const otherFiles = page.getByTestId("gallery-other-files");
  await expect(otherFiles).toBeVisible();
  await expect(otherFiles).toContainText("broken.avif");
  await expect(otherFiles).toContainText("readme.txt");
  await expect(otherFiles).toContainText("logo.svg");
  await expect(otherFiles.getByRole("button", { name: "下载原文件 broken.avif" })).toBeVisible();

  await page.getByTestId("gallery-download-all").click();
  await expect.poll(() => downloadBodies.length).toBe(1);
  expect(downloadBodies[0].intent).toBe("download");
  expect(downloadBodies[0].file_indices).toBeUndefined();
  await expect.poll(() => originalRequests).toBe(mixedFiles.length);
});

test("EXIF 面板直接显示 GPS，并按需读取完整对象", async ({ page }) => {
  await page.setViewportSize({ width: 980, height: 720 });
  const iphoneFileName = "03-raw-camera/dng-apple-iphone12pro-proraw-cc0.dng";
  const infoFiles = [shareFile(0, iphoneFileName), ...Array.from({ length: 11 }, (_, index) => shareFile(index + 1))];
  await mockGalleryShare(page, {
    infoFiles,
    gallery: async (route) => fulfillJson(route, galleryResponse(Array.from({ length: 12 }, (_, index) => ({
      ...galleryFile(index),
      ...(index === 0 ? {
        file_name: iphoneFileName,
        content_type: "image/x-adobe-dng",
      } : {}),
    })))),
  });
  await page.goto(`/${CODE}`);
  await page.getByRole("button", { name: "在灯箱中查看 dng-apple-iphone12pro-proraw-cc0.dng" }).click();
  await page.getByTestId("lightbox-metadata").click();

  const panel = page.getByTestId("gallery-metadata-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("GPSLatitude");
  await expect(panel).toContainText("31.2304");
  await expect(panel).toContainText("ExposureTime");
  const bounds = await panel.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x || 0) + (bounds?.width || 0)).toBeLessThanOrEqual(980.5);
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("textbox", { name: "搜索完整 EXIF" }).fill("Longitude");
  await expect(panel).toContainText("121.4737");
  await expect(panel).not.toContainText("ExposureTime");
  await page.getByRole("button", { name: "关闭元数据面板" }).click();
  await expect(panel).toHaveCount(0);
});

test("临时多选只发起一次 download intent 并携带去重 file_indices", async ({ page }) => {
  await installDirectoryPicker(page);
  const downloadBodies: Record<string, unknown>[] = [];
  await mockGalleryShare(page, { onDownloadSession: (body) => downloadBodies.push(body) });
  await page.goto(`/${CODE}`);
  await expect(page.getByTestId("share-image-gallery")).toBeVisible({ timeout: 10000 });

  await page.getByRole("button", { name: "选择 photo-01.jpg" }).click();
  expect(await page.getByTestId("gallery-selection-reveal").evaluate((element) => getComputedStyle(element).transitionDuration)).not.toBe("0s");
  const selectedButton = page.getByRole("button", { name: "取消选择 photo-01.jpg" });
  expect(await selectedButton.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("999px");
  expect(await selectedButton.evaluate((element) => ({
    outerBorder: getComputedStyle(element).borderWidth,
    ringBorder: getComputedStyle(element, "::before").borderWidth,
    ringWidth: getComputedStyle(element, "::before").width,
    secondRing: getComputedStyle(element, "::after").content,
  }))).toEqual({ outerBorder: "0px", ringBorder: "2px", ringWidth: "25px", secondRing: "none" });
  await page.getByRole("button", { name: "选择 photo-02.jpg" }).click();
  await expect(page.getByTestId("gallery-selection-bar")).toContainText("已选 2 张");
  await page.getByRole("button", { name: "下载已选" }).click();

  await expect.poll(() => downloadBodies.length).toBe(1);
  expect(downloadBodies[0].intent).toBe("download");
  expect(downloadBodies[0].file_indices).toEqual([0, 1]);
});

test("多选下载三路并发并以叠卡展开逐文件进度", async ({ page }) => {
  await installDirectoryPicker(page);
  let activeRequests = 0;
  let maxActiveRequests = 0;
  await mockGalleryShare(page, {
    onOriginalRequest: async () => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 120));
      activeRequests -= 1;
    },
  });
  await page.goto(`/${CODE}`);
  await expect(page.getByTestId("share-image-gallery")).toBeVisible({ timeout: 10000 });

  await page.getByRole("button", { name: "选择 photo-01.jpg" }).click();
  await page.getByRole("button", { name: "选择 photo-02.jpg" }).click();
  await page.getByRole("button", { name: "选择 photo-03.jpg" }).click();
  await page.getByRole("button", { name: "下载已选" }).click();

  const hud = page.getByTestId("download-progress-hud");
  await expect(hud).toBeVisible();
  await expect.poll(() => maxActiveRequests).toBe(3);
  await expect(page.getByTestId("download-progress-toggle")).toContainText("3 个文件");
  await page.getByTestId("download-progress-toggle").click();
  const rows = page.getByTestId("download-file-progress-row");
  await expect(rows).toHaveCount(3);
  await expect.poll(async () => rows.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-status")))).toEqual([
    "completed", "completed", "completed",
  ]);
});

test("RAW 灯箱保留派生预览并明确提供原文件下载", async ({ page }) => {
  const rawInfo = Array.from({ length: 6 }, (_, index) => shareFile(index, `raw/photo-${index + 1}.dng`));
  await mockGalleryShare(page, {
    infoFiles: rawInfo,
    gallery: async (route) => fulfillJson(route, galleryResponse(
      Array.from({ length: 6 }, (_, index) => ({
        ...galleryFile(index),
        file_name: `raw/photo-${index + 1}.dng`,
        content_type: "image/x-adobe-dng",
      })),
    )),
  });
  await page.goto(`/${CODE}`);
  await page.getByRole("button", { name: "在灯箱中查看 photo-1.dng" }).click();
  await expect(page.locator(".yarl__slide img").nth(1)).toHaveAttribute("src", /preview\.test\/(?:960|2048)\/0\.webp/);
  await expect(page.getByText("RAW 预览 · DNG")).toBeVisible();
  await expect(page.getByRole("button", { name: "下载 RAW 原文件" })).toBeVisible();
});

test("pending 会按 retry_after_seconds 轮询并原位转为图片", async ({ page }) => {
  const pendingFiles = Array.from({ length: 6 }, (_, index) => galleryFile(index, "pending"));
  const getGalleryCalls = await mockGalleryShare(page, {
    infoFiles: Array.from({ length: 6 }, (_, index) => shareFile(index)),
    gallery: async (route, call) => fulfillJson(route, call === 1
      ? { ...galleryResponse(pendingFiles), retry_after_seconds: 0.5 }
      : galleryResponse(Array.from({ length: 6 }, (_, index) => galleryFile(index))), 200),
  });

  await page.goto(`/${CODE}`);
  await expect(page.getByText("6 张预览处理中")).toBeVisible({ timeout: 10000 });
  await expect.poll(getGalleryCalls).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "在灯箱中查看 photo-01.jpg" })).toBeEnabled();
});

test("混合状态轮询保留已就绪资源并只请求新增资产", async ({ page }) => {
  const requestBodies: Array<{ known_ready_indices?: number[] }> = [];
  const firstFiles = [galleryFile(0), ...Array.from({ length: 5 }, (_, index) => galleryFile(index + 1, "pending"))];
  const secondFiles = Array.from({ length: 6 }, (_, index) => index === 0
    ? { ...galleryFile(0), assets: [] }
    : galleryFile(index));
  let initialImageSource = "";
  const getGalleryCalls = await mockGalleryShare(page, {
    infoFiles: Array.from({ length: 6 }, (_, index) => shareFile(index)),
    gallery: async (route, call) => {
      requestBodies.push(route.request().postDataJSON() as { known_ready_indices?: number[] });
      await fulfillJson(route, call === 1
        ? { ...galleryResponse(firstFiles), retry_after_seconds: 0.5 }
        : galleryResponse(secondFiles));
    },
  });

  await page.goto(`/${CODE}`);
  const firstImage = page.getByTestId("share-image-gallery").locator("img").first();
  await expect(firstImage).toBeVisible({ timeout: 10000 });
  initialImageSource = await firstImage.getAttribute("src") || "";
  await expect.poll(getGalleryCalls).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("button", { name: "在灯箱中查看 photo-06.jpg" })).toBeEnabled();
  expect(requestBodies[1].known_ready_indices).toEqual([0]);
  expect(await firstImage.getAttribute("src")).toBe(initialImageSource);
});

test("画廊会话失败回退文件列表，普通分享恢复自动预览", async ({ page }) => {
  let downloadCalls = 0;
  const downloadBodies: Record<string, unknown>[] = [];
  const files = Array.from({ length: 6 }, (_, index) => shareFile(index, `photo-${index + 1}.jpg`));
  await mockGalleryShare(page, {
    infoFiles: files,
    gallery: async (route) => fulfillJson(route, { detail: "gallery unavailable" }, 500),
    onDownloadSession: (body) => { downloadCalls += 1; downloadBodies.push(body); },
  });

  await page.goto(`/${CODE}`);
  await expect(page.getByRole("button", { name: "获取下载链接" })).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId("share-image-gallery")).toHaveCount(0);
  expect(downloadCalls).toBe(0);
  await page.getByRole("button", { name: "获取下载链接" }).click();
  await expect.poll(() => downloadCalls).toBe(1);
  expect(downloadBodies[0].intent).toBe("download");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  downloadCalls = 0;
  await mockGalleryShare(page, {
    galleryEligible: false,
    infoFiles: [shareFile(0, "ordinary.jpg")],
    onDownloadSession: () => { downloadCalls += 1; },
  });
  await page.goto(`/${CODE}`);
  await expect.poll(() => downloadCalls).toBe(1);
  await expect(page.getByRole("button", { name: "获取下载链接" })).toHaveCount(0);
});

test("密码分享解锁后按图片数量请求带密码的画廊会话", async ({ page }) => {
  const files = Array.from({ length: 6 }, (_, index) => shareFile(index));
  let galleryPassword = "";
  let downloadSessionCalls = 0;
  await mockGalleryShare(page, {
    hasPassword: true,
    infoFiles: files,
    onDownloadSession: () => { downloadSessionCalls += 1; },
    gallery: async (route) => {
      galleryPassword = (route.request().postDataJSON() as { password?: string }).password || "";
      await fulfillJson(route, galleryResponse(Array.from({ length: 6 }, (_, index) => galleryFile(index))));
    },
  });

  await page.goto(`/${CODE}`);
  await page.locator('input[aria-label="输入4位提取码"]').fill("1234");
  await expect(page.getByTestId("share-image-gallery")).toBeVisible({ timeout: 10000 });
  expect(galleryPassword).toBe("1234");
  expect(downloadSessionCalls).toBe(0);
});
