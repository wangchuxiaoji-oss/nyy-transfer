import type { PlaybackAsset, ShareFileDownload } from "./api";
import type { DebugLogFn } from "./debug";

const VIDEO_ONLY_BLOB_FALLBACK_MAX_BYTES = 96 * 1024 * 1024;

function getSwUrl(): string {
  if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("sw") === "legacy") {
    return "/nyy-virtual-media-sw-legacy.js";
  }
  return "/nyy-virtual-media-sw.js";
}

function workerMatchesCurrentMode(worker: ServiceWorker): boolean {
  return new URL(worker.scriptURL).pathname === getSwUrl();
}

async function ensureVirtualMediaServiceWorker(): Promise<ServiceWorkerRegistration> {
  if (!("serviceWorker" in navigator)) throw new Error("当前浏览器不支持 Service Worker");
  const swUrl = getSwUrl();
  const registration = await navigator.serviceWorker.register(swUrl, { scope: "/" });
  await navigator.serviceWorker.ready;

  const hasExpectedController = () => (
    !!navigator.serviceWorker.controller && workerMatchesCurrentMode(navigator.serviceWorker.controller)
  );

  if (!hasExpectedController()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 3000);
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  if (!hasExpectedController()) {
    throw new Error("Service Worker 已安装但尚未接管页面，请刷新后再试");
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
    sidecarSize: Number(asset.sidecar_size),
    virtualSize: Number(asset.virtual_size),
    sourceMediaStart: Number(asset.source_media_start),
    sourceMediaEnd: Number(asset.source_media_end),
  };
}

export function needsVideoOnlyVirtualMp4(file: ShareFileDownload): boolean {
  return getVideoOnlyVirtualLayout(file) !== null;
}

function getPhysicalChunks(file: ShareFileDownload): Array<{ url: string; start: number; end: number; size: number }> {
  if (!file.is_chunked) {
    return [{ url: file.download_url, start: 0, end: file.file_size - 1, size: file.file_size }];
  }

  let offset = 0;
  return [...file.chunks].sort((a, b) => a.index - b.index).map((chunk) => {
    const size = Number(chunk.size || 0);
    const item = { url: chunk.download_url, start: offset, end: offset + size - 1, size };
    offset += size;
    return item;
  });
}

async function fetchWholeBytes(url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const resp = await fetch(url, { mode: "cors", signal });
  if (!resp.ok) throw new Error(`Fetch failed: HTTP ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
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

  const sidecarBytes = await fetchWholeBytes(layout.sidecarUrl, signal);
  if (sidecarBytes.byteLength < layout.sidecarSize) throw new Error("video-only sidecar 数据不完整");

  const parts: BlobPart[] = [sidecarBytes.slice(0, layout.sidecarSize)];
  for (const chunk of getPhysicalChunks(file)) {
    if (chunk.end < layout.sourceMediaStart) continue;
    if (chunk.start >= layout.sourceMediaEnd) break;
    const bytes = await fetchWholeBytes(chunk.url, signal);
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
      contentType: file.content_type || "video/mp4",
      virtualFileSize: virtualLayout?.virtualSize,
      sidecar: virtualLayout ? {
        downloadUrl: virtualLayout.sidecarUrl,
        size: virtualLayout.sidecarSize,
        sourceMediaStart: virtualLayout.sourceMediaStart,
        sourceMediaEnd: virtualLayout.sourceMediaEnd,
      } : undefined,
      chunks: file.chunks.map((chunk) => ({
        index: chunk.index,
        size: chunk.size,
        downloadUrl: chunk.download_url,
      })),
    },
  }, [channel.port2]);
  await ack;

  debugLog?.("sw", "register:ack", { id, fileName: file.file_name });

  return `/__nyy_virtual_media__/${encodeURIComponent(id)}/${encodeURIComponent(file.file_name)}`;
}
