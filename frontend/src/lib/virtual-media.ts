import type { PlaybackAsset, ShareFileDownload } from "./api";
import type { DebugLogFn } from "./debug";

const VIDEO_ONLY_BLOB_FALLBACK_MAX_BYTES = 96 * 1024 * 1024;
const VIRTUAL_MEDIA_SW_VERSION = "20260616-low-initial-prefetch";

function getSwUrl(): string {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("sw") === "legacy") {
    return `/nyy-virtual-media-sw-legacy.js?v=${VIRTUAL_MEDIA_SW_VERSION}`;
  }
  return `/nyy-virtual-media-sw.js?v=${VIRTUAL_MEDIA_SW_VERSION}`;
}

function workerMatchesCurrentMode(worker: ServiceWorker): boolean {
  const actual = new URL(worker.scriptURL);
  const expected = new URL(getSwUrl(), window.location.origin);
  return actual.pathname === expected.pathname && actual.search === expected.search;
}

function hasExpectedController(): boolean {
  return !!navigator.serviceWorker.controller && workerMatchesCurrentMode(navigator.serviceWorker.controller);
}

async function waitForExpectedController(timeoutMs: number): Promise<void> {
  if (hasExpectedController()) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    const onChange = () => {
      if (!hasExpectedController()) return;
      finish();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
  });
}

async function requestWorkerClaim(worker: ServiceWorker | null | undefined): Promise<void> {
  if (!worker || !workerMatchesCurrentMode(worker)) return;
  const channel = new MessageChannel();
  const ack = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("Service Worker 接管页面超时")), 3000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timer);
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.error || "Service Worker 接管页面失败"));
    };
  });
  worker.postMessage({ type: "NYY_CLAIM_CLIENTS" }, [channel.port2]);
  await ack;
}

async function ensureVirtualMediaServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new Error("当前浏览器不支持 Service Worker");
  const swUrl = getSwUrl();
  const registration = await navigator.serviceWorker.register(swUrl, { scope: "/" });
  const updatedRegistration = await registration.update().catch(() => registration);
  await navigator.serviceWorker.ready;

  await requestWorkerClaim(updatedRegistration.waiting).catch(() => {});
  await requestWorkerClaim(updatedRegistration.active).catch(() => {});

  if (!hasExpectedController()) {
    await waitForExpectedController(8000);
  }

  if (!hasExpectedController()) {
    throw new Error("Service Worker 已安装但尚未接管页面，已尝试自动接管失败，请刷新后再试");
  }
  return registration;
}

async function getVirtualMediaWorker(): Promise<ServiceWorker> {
  if (!("serviceWorker" in navigator)) throw new Error("当前浏览器不支持 Service Worker");
  if (navigator.serviceWorker.controller && workerMatchesCurrentMode(navigator.serviceWorker.controller)) return navigator.serviceWorker.controller;
  const registration = await ensureVirtualMediaServiceWorker();
  const worker = navigator.serviceWorker.controller || registration.active;
  if (!worker) throw new Error("Service Worker 未激活");
  return worker;
}

export async function prepareVirtualMediaTransport(): Promise<void> {
  await ensureVirtualMediaServiceWorker();
}

export async function setVirtualMediaDebugEnabled(enabled: boolean): Promise<void> {
  const worker = await getVirtualMediaWorker();

  const channel = new MessageChannel();
  const ack = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Service Worker 调试开关超时")), 5000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.error || "Service Worker 调试开关失败"));
    };
  });

  worker.postMessage({ type: enabled ? "NYY_DEBUG_ENABLE" : "NYY_DEBUG_DISABLE" }, [channel.port2]);
  await ack;
}

export function createVirtualMediaFileId(idPrefix = "media"): string {
  return `${idPrefix}-${crypto.randomUUID?.() || Date.now()}`;
}

function getPlaybackAsset(file: ShareFileDownload, kind: string): PlaybackAsset | null {
  const assets = file.media_metadata?.playback_assets;
  if (!Array.isArray(assets)) return null;
  const asset = assets.find((item) => item?.kind === kind);
  return asset || null;
}

function hasAc3Audio(file: ShareFileDownload): boolean {
  const tracks = file.media_metadata?.audio_tracks;
  return Array.isArray(tracks) && tracks.some((track) => {
    const values = [track.codec_tag, track.codec]
      .map((value) => `${value || ""}`.toLowerCase())
      .filter(Boolean);
    return values.some((value) => value === "ac-3" || value === "ec-3" || value === "ac3" || value === "eac3");
  });
}

function getFaststartVirtualLayout(file: ShareFileDownload): {
  sidecarUrl: string;
  sidecarBackupUrl: string;
  sidecarSize: number;
  virtualSize: number;
  sourceMediaStart: number;
  sourceMediaEnd: number;
} | null {
  const hints = file.media_metadata?.playback_hints;
  if (!hints || hints.needs_virtual_faststart !== true) return null;
  const asset = getPlaybackAsset(file, "mp4_faststart_init");
  if (!asset?.download_url) return null;
  if (!Number.isFinite(asset.sidecar_size) || !Number.isFinite(asset.virtual_size) || !Number.isFinite(asset.source_media_start) || !Number.isFinite(asset.source_media_end)) {
    return null;
  }
  return {
    sidecarUrl: asset.download_url,
    sidecarBackupUrl: asset.backup_download_url || "",
    sidecarSize: Number(asset.sidecar_size),
    virtualSize: Number(asset.virtual_size),
    sourceMediaStart: Number(asset.source_media_start),
    sourceMediaEnd: Number(asset.source_media_end),
  };
}

export function needsVirtualFaststart(file: ShareFileDownload): boolean {
  return getFaststartVirtualLayout(file) !== null;
}

function getVideoOnlyVirtualLayout(file: ShareFileDownload): {
  sidecarUrl: string;
  sidecarBackupUrl: string;
  sidecarSize: number;
  virtualSize: number;
  sourceMediaStart: number;
  sourceMediaEnd: number;
} | null {
  if (!hasAc3Audio(file)) return null;
  const hints = file.media_metadata?.playback_hints;
  if (!hints || hints.has_video_only_virtual !== true) return null;
  const asset = getPlaybackAsset(file, "mp4_video_only_init");
  if (!asset?.download_url) return null;
  if (!Number.isFinite(asset.sidecar_size) || !Number.isFinite(asset.virtual_size) || !Number.isFinite(asset.source_media_start) || !Number.isFinite(asset.source_media_end)) {
    return null;
  }
  return {
    sidecarUrl: asset.download_url,
    sidecarBackupUrl: asset.backup_download_url || "",
    sidecarSize: Number(asset.sidecar_size),
    virtualSize: Number(asset.virtual_size),
    sourceMediaStart: Number(asset.source_media_start),
    sourceMediaEnd: Number(asset.source_media_end),
  };
}

export function needsVideoOnlyVirtualMp4(file: ShareFileDownload): boolean {
  return getVideoOnlyVirtualLayout(file) !== null;
}

function getPhysicalChunks(file: ShareFileDownload): Array<{ urls: string[]; start: number; end: number; size: number }> {
  if (!file.is_chunked) {
    return [{ urls: [file.download_url, file.backup_download_url || ""].filter(Boolean), start: 0, end: file.file_size - 1, size: file.file_size }];
  }

  let offset = 0;
  return [...file.chunks].sort((a, b) => a.index - b.index).map((chunk) => {
    const size = Number(chunk.size || 0);
    const item = { urls: [chunk.download_url, chunk.backup_download_url || ""].filter(Boolean), start: offset, end: offset + size - 1, size };
    offset += size;
    return item;
  });
}

async function fetchWholeBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const resp = await fetch(url, { mode: "cors", signal });
  if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function fetchWholeBytesFromSources(urls: string[], signal?: AbortSignal): Promise<Uint8Array> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await fetchWholeBytes(url, signal);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Fetch failed");
}

export function getVideoOnlyBlobFallbackSize(file: ShareFileDownload): number | null {
  const layout = getVideoOnlyVirtualLayout(file);
  if (!layout) return null;
  const sourceBytes = layout.sourceMediaEnd - layout.sourceMediaStart;
  const totalBytes = layout.sidecarSize + sourceBytes;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || totalBytes > VIDEO_ONLY_BLOB_FALLBACK_MAX_BYTES) return null;
  return totalBytes;
}

export async function createVideoOnlyMp4BlobUrl(file: ShareFileDownload, signal?: AbortSignal): Promise<string> {
  const layout = getVideoOnlyVirtualLayout(file);
  if (!layout) throw new Error("缺少 video-only MP4 sidecar");
  const totalBytes = getVideoOnlyBlobFallbackSize(file);
  if (totalBytes === null) throw new Error("当前文件过大，无法启用 AC-3 Blob 兜底");

  const sidecarBytes = await fetchWholeBytesFromSources([layout.sidecarUrl, layout.sidecarBackupUrl].filter(Boolean), signal);
  if (sidecarBytes.byteLength < layout.sidecarSize) throw new Error("video-only sidecar 数据不完整");

  const parts: BlobPart[] = [sidecarBytes.slice(0, layout.sidecarSize)];
  for (const chunk of getPhysicalChunks(file)) {
    if (chunk.end < layout.sourceMediaStart) continue;
    if (chunk.start >= layout.sourceMediaEnd) break;
    const bytes = await fetchWholeBytesFromSources(chunk.urls, signal);
    const localStart = Math.max(0, layout.sourceMediaStart - chunk.start);
    const localEnd = Math.min(chunk.size, layout.sourceMediaEnd - chunk.start);
    parts.push(bytes.slice(localStart, localEnd));
  }

  return URL.createObjectURL(new Blob(parts, { type: file.content_type || "video/mp4" }));
}

export async function registerVirtualMediaFile(file: ShareFileDownload, idPrefix = "media", debugLog?: DebugLogFn, idOverride?: string): Promise<string> {
  const worker = await getVirtualMediaWorker();

  const id = idOverride || createVirtualMediaFileId(idPrefix);
  const channel = new MessageChannel();
  const ack = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Service Worker 注册虚拟文件超时")), 5000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.error || "Service Worker 注册虚拟文件失败"));
    };
  });

  const virtualLayout = getVideoOnlyVirtualLayout(file) || getFaststartVirtualLayout(file);
  debugLog?.("sw", "register:file", {
    id,
    fileName: file.file_name,
    fileSize: file.file_size,
    contentType: file.content_type || "video/mp4",
    chunks: file.chunks.length,
    virtualFaststart: Boolean(virtualLayout),
    mode: getSwUrl().includes("legacy") ? "legacy" : "optimized",
  });

  worker.postMessage({
    type: "REGISTER_VIRTUAL_FILE",
    id,
    file: {
      fileName: file.file_name,
      fileSize: file.file_size,
      downloadUrl: file.download_url,
      backupDownloadUrl: file.backup_download_url || "",
      contentType: file.content_type || "video/mp4",
      virtualFileSize: virtualLayout?.virtualSize,
      sidecar: virtualLayout ? {
        downloadUrl: virtualLayout.sidecarUrl,
        backupDownloadUrl: virtualLayout.sidecarBackupUrl,
        size: virtualLayout.sidecarSize,
        sourceMediaStart: virtualLayout.sourceMediaStart,
        sourceMediaEnd: virtualLayout.sourceMediaEnd,
      } : undefined,
      chunks: file.chunks.map((chunk) => ({
        index: chunk.index,
        size: chunk.size,
        downloadUrl: chunk.download_url,
        backupDownloadUrl: chunk.backup_download_url || "",
      })),
    },
  }, [channel.port2]);
  await ack;

  debugLog?.("sw", "register:ack", { id, fileName: file.file_name });

  return `/__nyy_virtual_media__/${encodeURIComponent(id)}/${encodeURIComponent(file.file_name)}`;
}
