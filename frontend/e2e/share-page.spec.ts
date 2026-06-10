import { expect, test, type Page } from "@playwright/test";

const MOCK_CODE = "share-e2e";
const LONG_NAME = "超长文件名".repeat(8);
const NOW = "2026-06-08T00:00:00.000Z";
const VIDEO_META = {
  probe_version: 1,
  probe_status: "ok",
  file_size: 12_345_678,
  audio_tracks: [{ codec: "aac", codec_tag: "mp4a" }],
  video_tracks: [{ codec: "h264" }],
};

interface ShareFileMock {
  file_name: string;
  file_size: number;
  file_ext: string;
  content_type: string;
  index: number;
  is_chunked: boolean;
  chunk_count: number;
  media_metadata?: Record<string, unknown> | null;
}

interface DownloadFileMock {
  file_name: string;
  file_size: number;
  content_type: string;
  is_chunked: boolean;
  download_url: string;
  chunks: Array<{ index: number; size: number; download_url: string }>;
  media_metadata?: Record<string, unknown> | null;
}

interface ShareInfoMock {
  code: string;
  files: ShareFileMock[];
  empty_dirs: string[];
  total_bytes: number;
  created_at: string;
  expires_at: string | null;
  download_count: number;
  max_downloads: number;
  has_password: boolean;
}

interface DownloadResponseMock {
  files: DownloadFileMock[];
  empty_dirs: string[];
  expires_in: number;
}

function videoMeta(overrides: Record<string, unknown> = {}) {
  return { ...VIDEO_META, ...overrides };
}

function shareFile(overrides: Partial<ShareFileMock> = {}): ShareFileMock {
  return {
    file_name: `${LONG_NAME}.mp4`,
    file_size: 1_000_000,
    file_ext: "mp4",
    content_type: "video/mp4",
    index: 0,
    is_chunked: false,
    chunk_count: 0,
    media_metadata: videoMeta(),
    ...overrides,
  };
}

function downloadFile(file: ShareFileMock, overrides: Partial<DownloadFileMock> = {}): DownloadFileMock {
  return {
    file_name: file.file_name,
    file_size: file.file_size,
    content_type: file.content_type,
    is_chunked: false,
    download_url: `https://example.com/${encodeURIComponent(file.file_name)}`,
    chunks: [],
    media_metadata: file.media_metadata,
    ...overrides,
  };
}

function shareInfo(files = [shareFile()], overrides: Partial<ShareInfoMock> = {}): ShareInfoMock {
  return {
    code: MOCK_CODE,
    files,
    empty_dirs: [],
    total_bytes: files.reduce((sum, file) => sum + file.file_size, 0),
    created_at: NOW,
    expires_at: null,
    download_count: 0,
    max_downloads: 0,
    has_password: false,
    ...overrides,
  };
}

function downloadResponse(files: ShareFileMock[], overrides: Partial<DownloadResponseMock> = {}): DownloadResponseMock {
  return {
    files: files.map((file) => downloadFile(file)),
    empty_dirs: [],
    expires_in: 3600,
    ...overrides,
  };
}

async function routeShare(
  page: Page,
  info: ShareInfoMock,
  download: DownloadResponseMock,
  options: { infoDelayMs?: number; downloadDelayMs?: number; downloadGate?: Promise<void> } = {},
) {
  await page.route(`**/api/v1/shares/${MOCK_CODE}`, async (route) => {
    if (options.infoDelayMs) await new Promise((resolve) => setTimeout(resolve, options.infoDelayMs));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(info) });
  });
  await page.route(`**/api/v1/shares/${MOCK_CODE}/download`, async (route) => {
    if (options.downloadGate) await options.downloadGate;
    if (options.downloadDelayMs) await new Promise((resolve) => setTimeout(resolve, options.downloadDelayMs));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(download) });
  });
  await page.route(`**/api/v1/shares/${MOCK_CODE}/verify`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(download) });
  });
}

async function routeExternal(page: Page, contentType = "application/octet-stream") {
  await page.route("https://example.com/**", async (route) => {
    await route.fulfill({
      status: 206,
      contentType,
      headers: { "Content-Range": "bytes 0-8191/12345678", "Accept-Ranges": "bytes" },
      body: "x".repeat(1024),
    });
  });
}

async function openMockShare(page: Page, info = shareInfo(), download = downloadResponse(info.files)) {
  await routeShare(page, info, download);
  await routeExternal(page);
  await page.goto(`/${MOCK_CODE}`);
}

async function waitForReady(page: Page) {
  await expect(page.locator("aside").getByText("分享概览")).toBeVisible({ timeout: 10000 });
}

async function installMockNativeVideo(page: Page) {
  await page.addInitScript(() => {
    type MockVideo = HTMLMediaElement & {
      __nyyPaused?: boolean;
      __nyyCurrentTime?: number;
    };

    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true,
      get() { return (this as MockVideo).__nyyPaused ?? true; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "ended", {
      configurable: true,
      get() { return false; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
      configurable: true,
      get() { return 4; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "networkState", {
      configurable: true,
      get() { return 1; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "duration", {
      configurable: true,
      get() { return 120; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "videoWidth", {
      configurable: true,
      get() { return 1280; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "videoHeight", {
      configurable: true,
      get() { return 720; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "error", {
      configurable: true,
      get() { return null; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get() { return (this as MockVideo).__nyyCurrentTime ?? 0; },
      set(value: number) { (this as MockVideo).__nyyCurrentTime = value; },
    });
    HTMLMediaElement.prototype.load = function () {
      this.dispatchEvent(new Event("loadedmetadata"));
      this.dispatchEvent(new Event("loadeddata"));
      this.dispatchEvent(new Event("canplay"));
    };
    HTMLMediaElement.prototype.play = function () {
      const video = this as MockVideo;
      video.__nyyPaused = false;
      video.dispatchEvent(new Event("loadedmetadata"));
      video.dispatchEvent(new Event("durationchange"));
      video.dispatchEvent(new Event("play"));
      video.dispatchEvent(new Event("playing"));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      const video = this as MockVideo;
      video.__nyyPaused = true;
      video.dispatchEvent(new Event("pause"));
    };
    HTMLElement.prototype.requestFullscreen = function () {
      fullscreenElement = this;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
    document.exitFullscreen = () => {
      fullscreenElement = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    };
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

async function sidebarActionsHeight(page: Page) {
  return page.evaluate(() => {
    const target = document.querySelector("aside [data-testid='share-actions']") as HTMLElement | null;
    return target ? Math.round(target.getBoundingClientRect().height) : null;
  });
}

test.describe("分享页核心状态", () => {
  test("不存在的分享码显示状态页且 Logo 可回首页", async ({ page }) => {
    await page.route("**/api/v1/shares/not-found-e2e", async (route) => {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ detail: "not found" }) });
    });

    await page.goto("/not-found-e2e");

    await expect(page.getByText("分享不存在或已被删除")).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("link", { name: /返回.*首页/ }).first()).toHaveAttribute("href", "/");
  });

  test("有密码分享显示保险库输入", async ({ page }) => {
    const file = shareFile();
    await routeShare(page, shareInfo([file], { has_password: true }), downloadResponse([file]));

    await page.goto(`/${MOCK_CODE}`);

    await expect(page.getByText("安全保险库")).toBeVisible({ timeout: 10000 });
    const input = page.locator('input[aria-label="输入4位提取码"]');
    await expect(input).toHaveAttribute("inputMode", "numeric");
    await expect(input).toHaveAttribute("maxLength", "4");
  });

  test("ready 页展示品牌、主题、概览和底部官网", async ({ page }) => {
    await openMockShare(page);
    await waitForReady(page);

    await expect(page.locator('img[alt="拿呀²"]').first()).toBeVisible();
    await expect(page.getByRole("link", { name: /返回.*首页/ }).first()).toHaveAttribute("href", "/");
    await page.getByRole("button", { name: /当前：(浅色模式|深色模式|跟随系统)，点击切换/ }).first().click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", /^(light|dark)$/);
    await expect(page.locator("aside").getByText("分享概览").first()).toBeVisible();
    await expect(page.getByText("想传文件？拿呀²")).toBeVisible();
    await expect(page.getByRole("link", { name: "nyy.app" }).first()).toBeVisible();
  });
});

test.describe("分享页布局回归", () => {
  test("移动端无横向溢出、无固定底栏，并通过扫码 Tab 展示二维码", async ({ page }) => {
    const files = [shareFile({ index: 0 }), shareFile({ file_name: `${LONG_NAME}.png`, file_ext: "png", content_type: "image/png", index: 1, media_metadata: null })];
    await page.setViewportSize({ width: 375, height: 667 });
    await openMockShare(page, shareInfo(files), downloadResponse(files));
    await expect(page.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true", { timeout: 10000 });
    const tabRadius = await page.getByRole("tab", { name: "文件" }).evaluate((element) => ({
      actual: getComputedStyle(element).borderRadius,
      expected: getComputedStyle(document.documentElement).getPropertyValue("--radius-control").trim(),
    }));
    expect(tabRadius.actual).toBe(tabRadius.expected);
    await expectNoHorizontalOverflow(page);

    const hasFixedBottomBar = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("body *")).some((el) => {
        const style = getComputedStyle(el);
        return style.position === "fixed" && style.bottom === "0px" && el.clientHeight > 0 && el.clientWidth > 200;
      });
    });
    expect(hasFixedBottomBar).toBe(false);

    await page.getByRole("tab", { name: "扫码" }).click();
    await expect(page.locator('img[alt="二维码"]').first()).toBeVisible();
  });

  test("关键视口均无横向溢出", async ({ page }) => {
    const viewports = [
      { width: 320, height: 640 },
      { width: 375, height: 667 },
      { width: 768, height: 1024 },
    ];

    for (const viewport of viewports) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.setViewportSize(viewport);
      await openMockShare(page);
      await expect(page.locator("main")).toBeVisible({ timeout: 10000 });
      await expectNoHorizontalOverflow(page);
    }
  });

  test("播放器舞台保持 16:9，grid 子项允许收缩", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await openMockShare(page);
    await expect(page.getByTestId("native-video-preview").first()).toBeVisible({ timeout: 10000 });

    const metrics = await page.evaluate(() => {
      const stage = document.querySelector('main [class*="stagePlayer"]') as HTMLElement | null;
      const grid = document.querySelector('main [class*="desktopTwoCol"]');
      return {
        ratio: stage ? stage.getBoundingClientRect().width / stage.getBoundingClientRect().height : null,
        minWidths: grid ? Array.from(grid.children).map((el) => getComputedStyle(el).minWidth) : [],
      };
    });
    expect(metrics.ratio).not.toBeNull();
    expect(Math.abs(metrics.ratio! - 16 / 9)).toBeLessThan(0.02);
    expect(metrics.minWidths.every((value) => value === "0px")).toBe(true);
  });

  test("慢下载时侧栏位置不跳变", async ({ page }) => {
    const files = [shareFile({ file_name: "文件1.mp4", index: 0 }), shareFile({ file_name: "文件2.mp4", index: 1 })];
    await routeShare(page, shareInfo(files), downloadResponse(files), { downloadDelayMs: 1200 });
    await routeExternal(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/${MOCK_CODE}`);
    await expect(page.locator("aside").getByRole("tab", { name: "文件" })).toBeVisible({ timeout: 5000 });

    const asideTop = () => page.evaluate(() => {
      const aside = document.querySelector("aside");
      return aside ? Math.round(aside.getBoundingClientRect().top) : null;
    });
    const before = await asideTop();
    await expect(page.locator("aside button:has-text('保存到文件夹'), aside button:has-text('请逐个下载')").first()).toBeVisible({ timeout: 5000 });
    const after = await asideTop();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs(after! - before!)).toBeLessThanOrEqual(2);
  });

  test("浅色主题文字为深色", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("nyy-theme", "light"));
    await openMockShare(page);
    await waitForReady(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const color = await page.evaluate(() => {
      const element = document.querySelector('main [class*="tPrimary"]');
      return element ? getComputedStyle(element).color : null;
    });
    expect(color).not.toBeNull();
    const channels = color!.match(/\d+/g)!.map(Number);
    expect(Math.max(channels[0], channels[1], channels[2])).toBeLessThan(120);
  });
});

test.describe("播放器代表性回归", () => {
  test("音频文件显示自定义播放器且 OGG 归入音频分支", async ({ page }) => {
    await installMockNativeVideo(page);
    await page.addInitScript(() => {
      const original = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function patchedCanPlayType(type: string) {
        if (type.includes("audio/ogg")) return "probably";
        return original.call(this, type);
      };
    });
    const file = shareFile({ file_name: "现场录音.ogg", file_ext: "ogg", content_type: "audio/ogg", media_metadata: null });
    await routeShare(page, shareInfo([file]), downloadResponse([file], { files: [downloadFile(file, { download_url: "https://example.com/live.ogg", content_type: "audio/ogg", media_metadata: null })] }));
    await routeExternal(page, "audio/ogg");

    await page.goto(`/${MOCK_CODE}`);

    await expect(page.getByTestId("audio-preview")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("audio-element")).toBeAttached();
    await expect(page.getByTestId("audio-visualizer")).toBeVisible();
    await expect(page.getByText("NYY AUDIO")).toHaveCount(0);
    await expect(page.getByText("REAL-TIME FFT")).toHaveCount(0);
    await expect(page.getByText("ANALYSER ON")).toHaveCount(0);
    await expect(page.getByText(/audio\/ogg/)).toHaveCount(0);
    await expect(page.getByTestId("native-video-preview")).toHaveCount(0);
    const desktopControls = await page.evaluate(() => {
      const progress = document.querySelector('[data-testid="audio-progress"]') as HTMLElement | null;
      const volume = document.querySelector('input[aria-label="音量"]') as HTMLElement | null;
      const progressRect = progress?.getBoundingClientRect();
      const volumeRect = volume?.getBoundingClientRect();
      return {
        sameRow: Boolean(progressRect && volumeRect && Math.abs(progressRect.y - volumeRect.y) <= 2),
      };
    });
    expect(desktopControls.sameRow).toBe(true);
    await page.getByTestId("audio-play-toggle").click();
    await expect(page.getByTestId("audio-play-toggle")).toHaveAttribute("aria-label", "暂停");
    await expect(page.getByText("准备就绪")).toHaveCount(0);
    await expect(page.getByText("正在播放")).toHaveCount(0);
    await expect(page.getByText("播放结束")).toHaveCount(0);
  });

  test("音频播放器移动端保持 16:9 且静音可恢复", async ({ page }) => {
    await installMockNativeVideo(page);
    await page.addInitScript(() => {
      localStorage.setItem("nyy-share-audio-volume", "0");
      localStorage.setItem("nyy-share-audio-muted", "true");
      const original = HTMLMediaElement.prototype.canPlayType;
      HTMLMediaElement.prototype.canPlayType = function patchedCanPlayType(type: string) {
        if (type.includes("audio/mpeg")) return "probably";
        return original.call(this, type);
      };
    });
    const file = shareFile({ file_name: "爱在西元前_伴奏.mp3", file_ext: "mp3", content_type: "audio/mpeg", media_metadata: null });
    await routeShare(page, shareInfo([file]), downloadResponse([file], { files: [downloadFile(file, { download_url: "https://example.com/audio.mp3", content_type: "audio/mpeg", media_metadata: null })] }));
    await routeExternal(page, "audio/mpeg");
    await page.setViewportSize({ width: 375, height: 667 });

    await page.goto(`/${MOCK_CODE}`);

    await expect(page.getByTestId("audio-preview")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("audio-controls")).toBeVisible();
    await expect(page.getByText(/audio\/mpeg/)).toHaveCount(0);
    const metrics = await page.evaluate(() => {
      const stage = document.querySelector('main [class*="stagePlayer"]') as HTMLElement | null;
      const controls = document.querySelector('[data-testid="audio-controls"]') as HTMLElement | null;
      const preview = document.querySelector('[data-testid="audio-preview"]') as HTMLElement | null;
      const visualizer = document.querySelector('[data-testid="audio-visualizer"]') as HTMLElement | null;
      const stageRect = stage?.getBoundingClientRect();
      const controlsRect = controls?.getBoundingClientRect();
      const previewRect = preview?.getBoundingClientRect();
      const visualizerRect = visualizer?.getBoundingClientRect();
      return {
        ratio: stageRect ? stageRect.width / stageRect.height : null,
        controlsInside: Boolean(stageRect && controlsRect && controlsRect.bottom <= stageRect.bottom + 1 && controlsRect.top >= stageRect.top - 1),
        previewInside: Boolean(stageRect && previewRect && previewRect.bottom <= stageRect.bottom + 1 && previewRect.top >= stageRect.top - 1),
        visualizerWide: Boolean(stageRect && visualizerRect && visualizerRect.width >= stageRect.width * 0.9),
      };
    });
    expect(metrics.ratio).not.toBeNull();
    expect(Math.abs(metrics.ratio! - 16 / 9)).toBeLessThan(0.02);
    expect(metrics.controlsInside).toBe(true);
    expect(metrics.previewInside).toBe(true);
    expect(metrics.visualizerWide).toBe(true);

    await page.getByRole("button", { name: "取消静音" }).click();
    await expect(page.getByRole("button", { name: "静音" })).toBeVisible();
  });

  test("原生播放器使用自定义控制条并支持基础交互", async ({ page }) => {
    await installMockNativeVideo(page);
    await openMockShare(page);

    const preview = page.getByTestId("native-video-preview").first();
    await expect(preview).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="native-video-preview"] video').first()).toBeAttached();
    await expect(page.locator('[data-testid="native-video-preview"] video').first()).not.toHaveAttribute("controls", /.*/);
    await expect(page.getByRole("slider", { name: "播放进度" })).toBeVisible();

    await page.getByTestId("native-video-center-toggle").click();
    await expect(page.getByTestId("native-video-center-toggle")).toHaveCount(0);
    await preview.click({ position: { x: 120, y: 120 } });
    await expect(page.getByTestId("native-video-center-toggle")).toBeVisible({ timeout: 1000 });
    await page.getByRole("button", { name: "全屏" }).click();
    await expect(page.getByRole("button", { name: "退出全屏" })).toBeVisible();
  });

  test("播放后缓冲态不重新显示中心播放按钮", async ({ page }) => {
    await installMockNativeVideo(page);
    await page.addInitScript(() => {
      HTMLMediaElement.prototype.play = function () {
        this.dispatchEvent(new Event("waiting"));
        return new Promise(() => undefined);
      };
    });
    await openMockShare(page);

    await expect(page.getByTestId("native-video-center-toggle")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("native-video-center-toggle").click();
    await expect(page.getByTestId("native-video-buffering")).toBeVisible({ timeout: 1000 });
    await expect(page.getByTestId("native-video-center-toggle")).toHaveCount(0);
  });

  test("AC-3 大文件使用虚拟媒体通道", async ({ page }) => {
    await installMockNativeVideo(page);
    const largeSize = 512 * 1024 * 1024;
    const asset = {
      kind: "mp4_video_only_init",
      sidecar_size: 8192,
      virtual_size: largeSize - 1024,
      source_media_start: 4096,
      source_media_end: largeSize - 4096,
      download_url: "https://example.com/large-ac3-init.mp4",
    };
    const meta = videoMeta({
      file_size: largeSize,
      audio_tracks: [{ codec: "ac-3", codec_tag: "ac-3" }],
      playback_hints: { has_video_only_virtual: true },
      playback_assets: [asset],
    });
    const file = shareFile({ file_size: largeSize, media_metadata: meta });
    const dl = downloadResponse([file], { files: [downloadFile(file, { download_url: "https://example.com/large-ac3.mp4", media_metadata: meta })] });

    await routeShare(page, shareInfo([file]), dl);
    await routeExternal(page, "video/mp4");
    await page.goto(`/${MOCK_CODE}`);

    const preview = page.getByTestId("ac3-video-preview").first();
    await expect(preview).toBeVisible({ timeout: 10000 });
    await expect(preview).toHaveAttribute("src", /\/__nyy_virtual_media__\//, { timeout: 10000 });
    await expect(page.getByText("当前文件过大，无法启用 AC-3 Blob 兜底")).toHaveCount(0);
  });

  test("E-AC-3 MP4 默认进入 SDP 路径", async ({ page }) => {
    const meta = videoMeta({ audio_tracks: [{ codec: "eac3", codec_tag: "ec-3" }] });
    const file = shareFile({ media_metadata: meta });
    await openMockShare(page, shareInfo([file]), downloadResponse([file], { files: [downloadFile(file, { media_metadata: meta })] }));

    await expect(page.locator("canvas").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("native-video-preview")).toHaveCount(0);
    await expect(page.getByTestId("ac3-video-preview")).toHaveCount(0);
  });

  test("tail-moov AAC 有 sidecar 时走虚拟快启 URL", async ({ page }) => {
    await installMockNativeVideo(page);
    const asset = {
      kind: "mp4_faststart_init",
      sidecar_size: 8192,
      virtual_size: 12_345_678,
      source_media_start: 32,
      source_media_end: 12_337_486,
      download_url: "https://example.com/tail-aac-init.mp4",
    };
    const meta = videoMeta({
      is_faststart: false,
      moov_offset: 9_000_000,
      moov_size: 4096,
      playback_hints: { needs_virtual_faststart: true },
      playback_assets: [asset],
      audio_tracks: [{ codec: "mp4a.40.2", codec_tag: "mp4a" }],
    });
    const file = shareFile({ media_metadata: meta });
    await openMockShare(page, shareInfo([file]), downloadResponse([file], { files: [downloadFile(file, { media_metadata: meta })] }));

    await expect(page.getByTestId("native-video-preview").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="native-video-preview"] video').first()).toHaveAttribute("src", /\/__nyy_virtual_media__\//, { timeout: 10000 });
  });

  test("虚拟快启播放中刷新下载链接不重置会话", async ({ page }) => {
    await installMockNativeVideo(page);
    const makeAsset = (suffix: string) => ({
      kind: "mp4_faststart_init",
      sidecar_size: 8192,
      virtual_size: 12_345_678,
      source_media_start: 32,
      source_media_end: 12_337_486,
      download_url: `https://example.com/tail-aac-init-${suffix}.mp4`,
    });
    const baseMeta = videoMeta({
      is_faststart: false,
      moov_offset: 9_000_000,
      moov_size: 4096,
      playback_hints: { needs_virtual_faststart: true },
      playback_assets: [makeAsset("a")],
      audio_tracks: [{ codec: "mp4a.40.2", codec_tag: "mp4a" }],
    });
    const file = shareFile({ media_metadata: baseMeta });
    let releaseSecondDownload!: () => void;
    let downloadCalls = 0;
    await page.route(`**/api/v1/shares/${MOCK_CODE}`, async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(shareInfo([file])) });
    });
    await page.route(`**/api/v1/shares/${MOCK_CODE}/download`, async (route) => {
      downloadCalls += 1;
      if (downloadCalls > 1) await new Promise<void>((resolve) => { releaseSecondDownload = resolve; });
      const suffix = downloadCalls === 1 ? "a" : "b";
      const media_metadata = { ...baseMeta, playback_assets: [makeAsset(suffix)] };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(downloadResponse([file], { files: [downloadFile(file, { download_url: `https://example.com/tail-aac-${suffix}.mp4`, media_metadata })] })),
      });
    });
    await routeExternal(page, "video/mp4");

    await page.goto(`/${MOCK_CODE}`);
    const video = page.locator('[data-testid="native-video-preview"] video').first();
    await expect(video).toHaveAttribute("src", /\/__nyy_virtual_media__\//, { timeout: 10000 });
    const firstSrc = await video.getAttribute("src");
    await expect.poll(() => typeof releaseSecondDownload).toBe("function");
    await page.getByTestId("native-video-center-toggle").dispatchEvent("click");
    await expect(page.getByTestId("native-video-center-toggle")).toHaveCount(0);
    releaseSecondDownload();
    await page.waitForResponse((response) => response.url().includes(`/api/v1/shares/${MOCK_CODE}/download`) && response.status() === 200);

    await expect(video).toHaveAttribute("src", firstSrc || "");
    await expect(page.getByTestId("native-video-center-toggle")).toHaveCount(0);
  });

  test("MKV 路由根据原生支持和音频编码选择预览路径", async ({ page }) => {
    const scenarios = [
      { code: "mkv-sdp", canPlay: "", audio: VIDEO_META.audio_tracks, expected: "sdp" },
      { code: "mkv-native", canPlay: "maybe", audio: VIDEO_META.audio_tracks, expected: "native" },
      { code: "mkv-eac3", canPlay: "maybe", audio: [{ codec: "eac3", codec_tag: "ec-3" }], expected: "sdp" },
    ] as const;

    for (const scenario of scenarios) {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.addInitScript((canPlay) => {
        const original = HTMLMediaElement.prototype.canPlayType;
        HTMLMediaElement.prototype.canPlayType = function patchedCanPlayType(type: string) {
          if (type.includes("matroska")) return canPlay;
          return original.call(this, type);
        };
      }, scenario.canPlay);
      const meta = videoMeta({ audio_tracks: scenario.audio });
      const file = shareFile({ file_name: `${LONG_NAME}.mkv`, file_ext: "mkv", content_type: "video/x-matroska", media_metadata: meta });
      await routeShare(page, shareInfo([file]), downloadResponse([file], { files: [downloadFile(file, { download_url: `https://example.com/${scenario.code}.mkv`, media_metadata: meta })] }));
      await routeExternal(page);
      await page.goto(`/${MOCK_CODE}`);

      if (scenario.expected === "native") {
        await expect(page.getByTestId("native-video-preview").first()).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId("mkv-sdp-preview")).toHaveCount(0);
      } else {
        await expect(page.getByTestId("mkv-sdp-preview")).toBeVisible({ timeout: 10000 });
        await expect(page.locator('[data-testid="native-video-preview"]:visible')).toHaveCount(0);
      }
    }
  });
});

test.describe("骨架和文件列表回归", () => {
  test("loading 阶段渲染骨架且移动端不溢出", async ({ page }) => {
    const file = shareFile({ file_name: "演示视频.mp4" });
    await routeShare(page, shareInfo([file]), downloadResponse([file]), { infoDelayMs: 1500, downloadDelayMs: 1500 });
    await routeExternal(page);
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto(`/${MOCK_CODE}`);
    await page.waitForTimeout(400);

    expect(await page.evaluate(() => !!document.querySelector('main [class*="stagePlayer"]'))).toBe(true);
    expect(await page.evaluate(() => !!document.querySelector("main aside"))).toBe(true);
    await expectNoHorizontalOverflow(page);
  });

  test("loading 到 ready 侧栏 Y 坐标保持稳定", async ({ page }) => {
    const file = shareFile({ file_name: "演示视频.mp4" });
    await routeShare(page, shareInfo([file]), downloadResponse([file]), { infoDelayMs: 1200, downloadDelayMs: 1200 });
    await routeExternal(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/${MOCK_CODE}`);
    await page.waitForTimeout(400);

    const asideTop = () => page.evaluate(() => {
      const aside = document.querySelector("main aside");
      return aside ? Math.round(aside.getBoundingClientRect().top) : null;
    });
    const before = await asideTop();
    await waitForReady(page);
    const after = await asideTop();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(Math.abs(after! - before!)).toBeLessThanOrEqual(2);
  });

  test("小型文件列表默认完整展示", async ({ page }) => {
    const files = Array.from({ length: 8 }, (_, index) => shareFile({ file_name: `文件_${index + 1}.mp4`, index }));
    await openMockShare(page, shareInfo(files), downloadResponse(files));
    await waitForReady(page);

    const rows = page.locator("aside [role='treeitem']:visible");
    await expect(rows).toHaveCount(8);
    await expect(page.locator("aside button:has-text('显示更多'):visible")).toHaveCount(0);
  });

  test("文件数未超过折叠阈值时不显示展开更多", async ({ page }) => {
    const files = Array.from({ length: 4 }, (_, index) => shareFile({ file_name: `文件_${index + 1}.mp4`, index }));
    await openMockShare(page, shareInfo(files), downloadResponse(files));
    await waitForReady(page);

    await expect(page.locator("aside [role='treeitem']:visible")).toHaveCount(4);
    await expect(page.locator("aside button:has-text('显示更多'):visible")).toHaveCount(0);
  });

  test("文件夹分享按目录树展示", async ({ page }) => {
    const files = [
      shareFile({ file_name: "品管圈/全套文件/会议记录1.docx", file_ext: "docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", index: 0, media_metadata: null }),
      shareFile({ file_name: "品管圈/全套文件/原始资料.xlsx", file_ext: "xlsx", content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", index: 1, media_metadata: null }),
    ];
    const emptyDirs = ["品管圈/空文件夹/"];
    await openMockShare(page, shareInfo(files, { empty_dirs: emptyDirs }), downloadResponse(files, { empty_dirs: emptyDirs }));
    await waitForReady(page);

    const aside = page.locator("aside");
    const visibleText = (text: string) => aside.locator("p:visible").filter({ hasText: new RegExp(`^${text}$`) });
    await expect(visibleText("品管圈")).toHaveCount(1);
    await expect(visibleText("全套文件")).toHaveCount(1);
    await expect(visibleText("会议记录1.docx")).toHaveCount(1);
    await expect(visibleText("原始资料.xlsx")).toHaveCount(1);
    await expect(visibleText("空文件夹").first()).toBeVisible();
    await expect(aside.getByText("品管圈/全套文件/会议记录1.docx", { exact: true })).toHaveCount(0);
  });

  test("超深目录和超长 Remux 文件名保持稳定且可查看详情", async ({ page }) => {
    const remuxName = `${"RUMUX超长片名".repeat(10)}.2160p.UHD.BluRay.REMUX.DV.HDR.TrueHD.Atmos.mkv`;
    const fullPath = `蓝光原盘/Disc 1/BDMV/STREAM/导演剪辑版/正片/超深目录/第七层/第八层/${remuxName}`;
    const files = [
      shareFile({ file_name: fullPath, file_ext: "mkv", content_type: "video/x-matroska", index: 0 }),
      shareFile({ file_name: "蓝光原盘/校验/SFV校验.txt", file_ext: "txt", content_type: "text/plain", index: 1, media_metadata: null }),
    ];
    await openMockShare(page, shareInfo(files), downloadResponse(files));
    await waitForReady(page);

    const aside = page.locator("aside");
    await aside.locator("input[aria-label='搜索文件名、扩展名或路径']:visible").fill("TrueHD");
    const fileRow = aside.locator("[role='button']:visible").filter({ hasText: /TrueHD\.Atmos\.mkv/ }).first();
    await expect(fileRow).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await fileRow.getByRole("button", { name: /详情/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(remuxName, { exact: true })).toBeVisible();
    await expect(dialog.getByText(fullPath, { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "复制完整路径" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "复制文件名" })).toBeVisible();
  });

  test("搜索到目录后回到树形并展开目录", async ({ page }) => {
    const files = [
      shareFile({ file_name: "资料库/Alpha/inside.txt", file_ext: "txt", content_type: "text/plain", index: 0, media_metadata: null }),
      shareFile({ file_name: "资料库/Beta/else.txt", file_ext: "txt", content_type: "text/plain", index: 1, media_metadata: null }),
    ];
    await openMockShare(page, shareInfo(files), downloadResponse(files));
    await waitForReady(page);

    const aside = page.locator("aside");
    await aside.locator("input[aria-label='搜索文件名、扩展名或路径']:visible").fill("Alpha");
    await expect(aside.locator("mark:visible").filter({ hasText: "Alpha" }).first()).toBeVisible();
    await aside.locator("[role='button']:visible").filter({ hasText: /^Alpha/ }).first().click();

    await expect(aside.locator("[role='treeitem']:visible").filter({ hasText: /^Alpha/ })).toBeVisible();
    await expect(aside.locator("p:visible").filter({ hasText: /^inside\.txt$/ })).toBeVisible();
    await expect(aside.locator("input[aria-label='搜索文件名、扩展名或路径']:visible")).toHaveValue("");
    await expect(aside.locator("button:visible", { hasText: "全部" })).toHaveCount(0);
  });

  test("大型深目录保留树形视图并支持搜索", async ({ page }) => {
    const files = Array.from({ length: 220 }, (_, index) => {
      const branch = index % 2 === 0 ? "x64" : "x86";
      return shareFile({
        file_name: `大型软件/lib/${branch}/plugins/plugin-${String(index + 1).padStart(2, "0")}.dll`,
        file_ext: "dll",
        content_type: "application/octet-stream",
        index,
        media_metadata: null,
      });
    });
    files.push(shareFile({ file_name: "大型软件/setup.exe", file_ext: "exe", content_type: "application/octet-stream", index: files.length, media_metadata: null }));
    await openMockShare(page, shareInfo(files), downloadResponse(files));
    await waitForReady(page);

    const aside = page.locator("aside");
    await expect(aside.getByText("目录较大，已保留树形视图")).toBeVisible();
    await expect(aside.locator("button:visible", { hasText: "全部" })).toHaveCount(0);
    await expect(aside.getByRole("tab", { name: "浏览视图" })).toHaveCount(0);
    await expect(aside.locator("p:visible").filter({ hasText: /^大型软件$/ })).toBeVisible();
    await expect(aside.locator("p:visible").filter({ hasText: /^lib$/ })).toBeVisible();
    await expect(aside.locator("p:visible").filter({ hasText: /^setup.exe$/ })).toBeVisible();

    await aside.locator("input[aria-label='搜索文件名、扩展名或路径']:visible").fill("plugin-220");
    await expect(aside.locator("mark:visible").filter({ hasText: "plugin-220" })).toBeVisible();
    await expect(aside.locator("p:visible").filter({ hasText: /^plugin-220.dll$/ })).toBeVisible();
    await expect(aside.getByText("大型软件/lib/x86/plugins", { exact: true })).toBeVisible();
  });
});

test.describe("单/多文件动作区回归", () => {
  async function setupFileCount(page: Page, fileCount: number) {
    const files = Array.from({ length: fileCount }, (_, index) => shareFile({ file_name: `文件${index + 1}.mp4`, index }));
    await openMockShare(page, shareInfo(files), downloadResponse(files));
    return files;
  }

  test("单文件只保留侧栏下载入口并隐藏文件列表", async ({ page }) => {
    await setupFileCount(page, 1);
    await waitForReady(page);

    await expect(page.getByText("有人通过拿呀²分享给你").last()).toBeVisible();
    await expect(page.locator("aside").getByText("文件列表")).toHaveCount(0);
    await expect(page.locator("aside button:has-text('下载此文件')")).toHaveCount(1);
    await expect(page.locator("aside button:has-text('整体打包下载')")).toHaveCount(0);
    expect(await sidebarActionsHeight(page)).toBe(46);
  });

  test("多文件显示文件列表、当前下载和整体打包入口", async ({ page }) => {
    await setupFileCount(page, 3);
    await waitForReady(page);

    await expect(page.locator("aside span:visible").filter({ hasText: "文件列表" })).toHaveCount(1);
    await expect(page.locator("aside button:has-text('下载当前文件')")).toHaveCount(1);
    await expect(page.locator("aside button:has-text('保存到文件夹'), aside button:has-text('请逐个下载')")).toHaveCount(1);
    expect(await sidebarActionsHeight(page)).toBe(46);
  });

  test("单文件下载链接加载前后按钮位置稳定", async ({ page }) => {
    let releaseDownload!: () => void;
    const gate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const file = shareFile({ file_name: "单.mp4" });
    await routeShare(page, shareInfo([file]), downloadResponse([file]), { downloadGate: gate });
    await routeExternal(page);
    await page.goto(`/${MOCK_CODE}`);
    await page.getByRole("button", { name: "复制链接" }).first().waitFor({ timeout: 10000 });

    const buttonArea = page.locator("aside [data-testid='share-actions']");
    await expect(buttonArea.getByText("获取中…").first()).toBeVisible();
    const before = await buttonArea.getByText("获取中…").first().boundingBox();

    releaseDownload();
    await expect(buttonArea.getByText("下载此文件", { exact: true }).first()).toBeVisible({ timeout: 5000 });
    const after = await buttonArea.getByText("下载此文件", { exact: true }).first().boundingBox();
    expect(await buttonArea.locator("button, a").count()).toBe(1);
    if (before && after) expect(Math.abs(before.y - after.y)).toBeLessThanOrEqual(1);
  });
});
