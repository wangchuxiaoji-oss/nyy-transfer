import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const SHARE_URL = process.env.SHARE_TEST_URL || "http://127.0.0.1:3000/U5qDU8";
const WAIT_MS = Number(process.env.SHARE_WAIT_MS || 90000);
const REPORT_PATH = process.env.SHARE_CODEC_REPORT || "/tmp/opencode/nyy-codec-lab/codec-lab-smoke-report.json";

const EXPECTATIONS = [
  {
    name: "mp4_h264_aac_faststart.mp4",
    hard: true,
    route: "native",
    ready: true,
    virtual: false,
  },
  {
    name: "mp4_h264_aac_tailmoov.mp4",
    hard: true,
    route: "native",
    ready: true,
    virtual: true,
    assets: ["mp4_faststart_init"],
  },
  {
    name: "mp4_h264_ac3_faststart.mp4",
    hard: true,
    route: "ac3",
    ready: true,
    virtual: true,
    blobFallback: true,
    audioSchedule: true,
    assets: ["mp4_video_only_init"],
  },
  {
    name: "mp4_h264_eac3_faststart.mp4",
    hard: true,
    route: "sdp",
    ready: false,
    virtual: false,
    sdpPlay: true,
  },
  {
    name: "mkv_h264_aac.mkv",
    hard: true,
    route: "native",
    ready: true,
    virtual: false,
  },
  {
    name: "webm_vp9_opus.webm",
    hard: true,
    route: "native",
    ready: true,
    virtual: false,
  },
  {
    name: "mp4_h265_aac_faststart.mp4",
    hard: false,
    route: "native",
    ready: true,
    virtual: false,
  },
  {
    name: "mp4_h265_aac_tailmoov.mp4",
    hard: false,
    route: "native",
    ready: true,
    virtual: true,
    assets: ["mp4_faststart_init"],
  },
  {
    name: "mp4_h265_10bit_aac_faststart.mp4",
    hard: false,
    route: "native",
    ready: true,
    virtual: false,
  },
  {
    name: "mkv_h265_aac.mkv",
    hard: false,
    route: "native-or-sdp",
    ready: true,
    virtual: false,
  },
  {
    name: "mkv_h264_ac3.mkv",
    hard: true,
    route: "sdp",
    ready: false,
    virtual: false,
    sdpPlay: true,
  },
  {
    name: "mkv_h264_eac3.mkv",
    hard: true,
    route: "sdp",
    ready: false,
    virtual: false,
    sdpPlay: true,
  },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleMessages = [];
const pageErrors = [];

page.on("console", (msg) => {
  if (["error", "warning"].includes(msg.type())) {
    consoleMessages.push({ type: msg.type(), text: msg.text() });
  }
});
page.on("pageerror", (err) => {
  pageErrors.push(err.message);
  console.error("pageerror:", err.message);
});

await page.addInitScript(() => {
  window.__nyyCodecMatrixSnapshot = (expectedName) => {
    const ac3Video = document.querySelector('[data-testid="ac3-video-preview"]');
    const nativeRoot = document.querySelector('[data-testid="native-video-preview"]');
    const nativeVideo = nativeRoot?.querySelector("video") || null;
    const sdpRoot = document.querySelector('[data-testid="sdp-player"]') || document.querySelector('[data-testid="mkv-sdp-preview"]');
    const bodyText = document.body.innerText || "";
    const unsupported = bodyText.includes("浏览器无法直接预览此视频");
    const video = ac3Video || nativeVideo || document.querySelector("video");
    let route = "none";
    if (ac3Video) route = "ac3";
    else if (sdpRoot) route = "sdp";
    else if (nativeVideo) route = "native";
    else if (unsupported) route = "unsupported";
    const probe = document.createElement("video");
    return {
      expectedName: expectedName || "",
      fileNameVisible: expectedName ? bodyText.includes(expectedName) : true,
      route,
      hasNativeRoot: nativeRoot instanceof HTMLElement,
      hasSdpRoot: sdpRoot instanceof HTMLElement,
      unsupported,
      canPlayType: {
        mp4: probe.canPlayType("video/mp4"),
        h264Aac: probe.canPlayType('video/mp4; codecs="avc1.64001f,mp4a.40.2"'),
        h265Aac: probe.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0,mp4a.40.2"'),
        ac3: probe.canPlayType('video/mp4; codecs="avc1.64001f,ac-3"'),
        eac3: probe.canPlayType('video/mp4; codecs="avc1.64001f,ec-3"'),
        matroska: probe.canPlayType("video/x-matroska"),
        webm: probe.canPlayType('video/webm; codecs="vp9,opus"'),
      },
      video: {
        present: video instanceof HTMLVideoElement,
        currentSrc: video?.currentSrc || "",
        readyState: video?.readyState ?? -1,
        networkState: video?.networkState ?? -1,
        duration: video?.duration ?? -1,
        currentTime: video?.currentTime ?? -1,
        paused: video?.paused ?? true,
        videoWidth: video?.videoWidth ?? 0,
        videoHeight: video?.videoHeight ?? 0,
        errorCode: video?.error?.code ?? null,
        errorMessage: video?.error?.message || "",
      },
      ac3Debug: window.__nyyAc3Debug || null,
      sdpDebug: window.__nyySdpDebug || null,
    };
  };
});

try {
  const shareUrl = new URL(SHARE_URL);
  const code = shareUrl.pathname.split("/").filter(Boolean).pop();
  if (!code) throw new Error(`无法从分享 URL 解析 code: ${SHARE_URL}`);

  const apiUrl = process.env.SHARE_API_URL || `${shareUrl.origin}/api/v1/shares/${code}/download`;
  const apiResponse = await fetch(apiUrl);
  if (!apiResponse.ok) throw new Error(`下载接口失败: HTTP ${apiResponse.status}`);
  const download = await apiResponse.json();
  const apiFiles = new Map(download.files.map((file) => [file.file_name, file]));
  const missingApiFiles = EXPECTATIONS.filter((item) => !apiFiles.has(item.name)).map((item) => item.name);
  if (missingApiFiles.length) throw new Error(`下载接口缺少样本: ${missingApiFiles.join(", ")}`);

  await page.goto(SHARE_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForFunction(() => document.querySelectorAll('button[aria-label^="预览 "]').length > 0, undefined, { timeout: WAIT_MS });
  await page.evaluate(() => {
    const expand = Array.from(document.querySelectorAll("button")).find((btn) => (btn.textContent || "").includes("展开更多"));
    if (expand instanceof HTMLButtonElement) expand.click();
  });
  await page.waitForFunction((expectedCount) => document.querySelectorAll('button[aria-label^="预览 "]').length >= expectedCount, EXPECTATIONS.length, { timeout: WAIT_MS });

  const results = [];
  for (const expectation of EXPECTATIONS) {
    const file = apiFiles.get(expectation.name);
    const apiCheck = checkApiFile(file, expectation);
    const uiResult = await probeFile(page, expectation);
    const failures = [...apiCheck.failures, ...checkUiResult(uiResult, expectation)];
    const hardFailures = expectation.hard ? failures : apiCheck.failures;
    const result = {
      name: expectation.name,
      hard: expectation.hard,
      ok: hardFailures.length === 0,
      failures,
      api: apiCheck.summary,
      ui: uiResult,
    };
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }

  const report = {
    shareUrl: SHARE_URL,
    apiUrl,
    generatedAt: new Date().toISOString(),
    pageErrors,
    consoleMessages: consoleMessages.slice(-50),
    results,
  };
  mkdirSync(new URL(`file://${REPORT_PATH}`).pathname.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const noisyAbortMessages = consoleMessages.filter(isAbortFetchNoise);
  const failed = results.filter((item) => !item.ok);
  await browser.close();
  if (noisyAbortMessages.length) {
    console.error(`codec matrix smoke failed: 控制台出现 AbortError fetch 噪声 ${noisyAbortMessages.length} 条`);
    process.exit(1);
  }
  if (failed.length) {
    console.error(`codec matrix smoke failed: ${failed.map((item) => item.name).join(", ")}`);
    process.exit(1);
  }
  console.log(`codec matrix smoke passed; report=${REPORT_PATH}`);
  process.exit(0);
} catch (err) {
  await browser.close();
  console.error(err);
  process.exit(2);
}

function checkApiFile(file, expectation) {
  const assets = Array.isArray(file.media_metadata?.playback_assets) ? file.media_metadata.playback_assets : [];
  const assetKinds = assets.map((asset) => asset.kind).filter(Boolean);
  const failures = [];
  for (const kind of expectation.assets || []) {
    const asset = assets.find((item) => item.kind === kind);
    if (!asset) {
      failures.push(`缺少 playback asset: ${kind}`);
      continue;
    }
    if (!asset.download_url) failures.push(`${kind} 缺少签名 download_url`);
    if (!Number.isFinite(Number(asset.virtual_size)) || Number(asset.virtual_size) <= 0) failures.push(`${kind} virtual_size 无效`);
    if (!Number.isFinite(Number(asset.sidecar_size)) || Number(asset.sidecar_size) <= 0) failures.push(`${kind} sidecar_size 无效`);
  }
  return {
    failures,
    summary: {
      contentType: file.content_type,
      container: file.media_metadata?.container || null,
      isFaststart: file.media_metadata?.is_faststart ?? null,
      playbackHints: file.media_metadata?.playback_hints || null,
      assetKinds,
    },
  };
}

function isAbortFetchNoise(message) {
  const text = message?.text || "";
  return text.includes("Fetch request failed")
    || text.includes("AbortError")
    || text.includes("signal is aborted without reason");
}

async function probeFile(page, expectation) {
  await page.evaluate(() => {
    for (const button of Array.from(document.querySelectorAll("button"))) {
      if ((button.textContent || "").includes("展开更多") && button instanceof HTMLButtonElement) button.click();
    }
  });
  await page.waitForFunction((name) => {
    return Array.from(document.querySelectorAll('button[aria-label^="预览 "]'))
      .some((btn) => btn.getAttribute("aria-label") === `预览 ${name}`);
  }, expectation.name, { timeout: WAIT_MS });

  await page.evaluate((name) => {
    const candidates = Array.from(document.querySelectorAll('button[aria-label^="预览 "]'))
      .filter((btn) => btn.getAttribute("aria-label") === `预览 ${name}`);
    const visible = candidates.find((btn) => {
      const style = window.getComputedStyle(btn);
      return style.display !== "none" && style.visibility !== "hidden" && btn.getClientRects().length > 0;
    });
    const target = visible || candidates[0];
    if (!(target instanceof HTMLButtonElement)) throw new Error(`找不到预览按钮: ${name}`);
    target.click();
  }, expectation.name);
  await page.waitForFunction((name) => (document.body.innerText || "").includes(name), expectation.name, { timeout: WAIT_MS }).catch(() => undefined);
  await page.waitForTimeout(500);

  await page.waitForFunction(() => {
    const snap = window.__nyyCodecMatrixSnapshot?.();
    return snap && snap.route !== "none";
  }, undefined, { timeout: WAIT_MS }).catch(() => undefined);

  if (expectation.ready) {
    await page.waitForFunction((name) => {
      const snap = window.__nyyCodecMatrixSnapshot?.();
      if (!snap) return false;
      if (snap.route === "sdp" || snap.route === "unsupported") return true;
      return snap.fileNameVisible && snap.video.readyState >= 1 && Number.isFinite(snap.video.duration) && snap.video.duration > 0 && !snap.video.errorCode;
    }, expectation.name, { timeout: WAIT_MS }).catch(() => undefined);
  }

  if (expectation.audioSchedule) {
    await clickVisiblePlay(page).catch(() => undefined);
    await page.waitForFunction((name) => {
      const snap = window.__nyyCodecMatrixSnapshot?.();
      return snap?.route === "ac3"
        && snap.ac3Debug
        && (snap.ac3Debug.src.includes(name) || snap.ac3Debug.transport === "blob")
        && !snap.ac3Debug.error
        && (snap.ac3Debug.scheduledWindows > 0 || snap.ac3Debug.scheduledWindowCount > 0);
    }, expectation.name, { timeout: WAIT_MS }).catch(() => undefined);
  }

  if (expectation.sdpPlay) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await clickVisiblePlay(page).catch(() => undefined);
      const played = await page.waitForFunction((name) => {
        const snap = window.__nyyCodecMatrixSnapshot?.(name);
        return snap?.route === "sdp"
          && snap.sdpDebug
          && snap.sdpDebug.fileName === name
          && snap.sdpDebug.state === "playing"
          && snap.sdpDebug.currentTime > 0.2
          && !snap.sdpDebug.error;
      }, expectation.name, { timeout: Math.min(WAIT_MS, 30000) }).then(() => true).catch(() => false);
      if (played) break;
    }
  }

  return await page.evaluate((name) => window.__nyyCodecMatrixSnapshot?.(name), expectation.name);
}

async function clickVisiblePlay(page) {
  await page.waitForFunction(() => {
    const ac3Scope = document.querySelector('[data-testid="ac3-video-preview"]')?.closest('[data-testid="player-chrome"]');
    const sdpScope = document.querySelector('[data-testid="sdp-player"]') || document.querySelector('[data-testid="mkv-sdp-preview"]');
    const scope = ac3Scope || sdpScope || document;
    return Array.from(scope.querySelectorAll('button[aria-label="播放"]'))
      .some((button) => {
        const style = window.getComputedStyle(button);
        return button instanceof HTMLButtonElement
          && !button.disabled
          && style.display !== "none"
          && style.visibility !== "hidden"
          && button.getClientRects().length > 0;
      });
  }, undefined, { timeout: WAIT_MS });
  await page.evaluate(() => {
    const ac3Scope = document.querySelector('[data-testid="ac3-video-preview"]')?.closest('[data-testid="player-chrome"]');
    const sdpScope = document.querySelector('[data-testid="sdp-player"]') || document.querySelector('[data-testid="mkv-sdp-preview"]');
    const scope = ac3Scope || sdpScope || document;
    const target = Array.from(scope.querySelectorAll('button[aria-label="播放"]'))
      .find((button) => {
        const style = window.getComputedStyle(button);
        return button instanceof HTMLButtonElement
          && !button.disabled
          && style.display !== "none"
          && style.visibility !== "hidden"
          && button.getClientRects().length > 0;
      });
    if (!(target instanceof HTMLButtonElement)) throw new Error("找不到可点击播放按钮");
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
  });
}

function checkUiResult(result, expectation) {
  if (!result) return ["未取得 UI 快照"];
  const failures = [];
  if (!result.fileNameVisible) failures.push("页面未显示目标文件名");
  if (expectation.route === "native" && result.route !== "native") failures.push(`预期 native，实际 ${result.route}`);
  if (expectation.route === "ac3" && result.route !== "ac3") failures.push(`预期 ac3，实际 ${result.route}`);
  if (expectation.route === "sdp" && result.route !== "sdp") failures.push(`预期 sdp，实际 ${result.route}`);
  if (expectation.route === "native-or-sdp" && !["native", "sdp"].includes(result.route)) failures.push(`预期 native/sdp，实际 ${result.route}`);
  if (expectation.route === "unsupported" && result.route !== "unsupported") failures.push(`预期 unsupported，实际 ${result.route}`);
  if (expectation.ready && ["native", "ac3"].includes(result.route)) {
    if (result.video.readyState < 1) failures.push(`readyState 过低: ${result.video.readyState}`);
    if (!Number.isFinite(result.video.duration) || result.video.duration <= 0) failures.push(`duration 无效: ${result.video.duration}`);
    if (result.video.errorCode) failures.push(`video error: ${result.video.errorCode} ${result.video.errorMessage}`);
  }
  if (expectation.virtual === true) {
    const isVirtualUrl = result.video.currentSrc.includes("/__nyy_virtual_media__/");
    const isBlobFallback = expectation.blobFallback && result.video.currentSrc.startsWith("blob:");
    if (!isVirtualUrl && !isBlobFallback) failures.push("预期虚拟媒体 URL 或 Blob 兜底，实际不是");
  }
  if (expectation.virtual === false && result.video.currentSrc.includes("/__nyy_virtual_media__/")) failures.push("预期原始媒体 URL，实际是虚拟 URL");
  if (expectation.audioSchedule) {
    if (!result.ac3Debug) failures.push("缺少 AC-3 debug 状态");
    else if (result.ac3Debug.error) failures.push(`AC-3 debug error: ${result.ac3Debug.error}`);
    else if (result.ac3Debug.scheduledWindows <= 0 && result.ac3Debug.scheduledWindowCount <= 0) failures.push("AC-3 未调度音频窗口");
  }
  if (expectation.sdpPlay) {
    if (!result.sdpDebug) failures.push("缺少 SDP debug 状态");
    else if (result.sdpDebug.error) failures.push(`SDP debug error: ${result.sdpDebug.error}`);
    else if (result.sdpDebug.state !== "playing") failures.push(`SDP 未进入播放态: ${result.sdpDebug.state}`);
    else if (result.sdpDebug.currentTime <= 0.2) failures.push(`SDP 播放时间未推进: ${result.sdpDebug.currentTime}`);
  }
  return failures;
}
