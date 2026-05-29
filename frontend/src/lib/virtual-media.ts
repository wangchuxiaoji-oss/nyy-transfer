import type { ShareFileDownload } from "./api";
import type { DebugLogFn } from "./debug";

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

  debugLog?.("sw", "register:file", {
    id,
    fileName: file.file_name,
    fileSize: file.file_size,
    contentType: file.content_type || "video/mp4",
    chunks: file.chunks.length,
    mode: getSwUrl().includes("legacy") ? "legacy" : "optimized",
  });

  worker.postMessage({
    type: "REGISTER_VIRTUAL_FILE",
    id,
    file: {
      fileName: file.file_name,
      fileSize: file.file_size,
      contentType: file.content_type || "video/mp4",
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
