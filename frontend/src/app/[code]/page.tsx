"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import QRCode from "qrcode";
import { Download, FileIcon, Clock, AlertCircle, Lock, Play, Package, Files, Flag, QrCode, Copy, X, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/brand-logo";
import { MediaPlayer, getMediaType } from "@/components/media-player";
import { SelfDevelopPlayer, getSelfDevelopMediaType } from "@/components/self-develop-player";
import {
  getShareInfo, verifyShare, downloadShare, reportShare,
  type ShareInfo, type ShareFileDownload,
} from "@/lib/api";
import { supportsChunkedDownload, chunkedDownload, type ChunkedDownloadProgress } from "@/lib/chunked-download";
import { getErrorMessage, isHttpStatusError } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import { prepareVirtualMediaTransport, setVirtualMediaDebugEnabled } from "@/lib/virtual-media";
import { formatDebugLine, toDebugRecord, type DebugLogFn } from "@/lib/debug";

type PageState = "loading" | "ready" | "not_found" | "expired" | "error";

interface DebugEntry {
  elapsedMs: number;
  scope: string;
  event: string;
  data?: Record<string, unknown>;
  line: string;
}

interface DebugStatus {
  mode: string;
  concurrency: number | null;
  lastLatencyMs: number | null;
  lastScope: string;
  lastEvent: string;
  metadataSource: string | null;
  moovOffset: number | null;
  audioCodecs: string[];
  sidecarDecision: string | null;
  sdpReadBytes: number | null;
  sdpFileSize: number | null;
  sdpRenderedFrames: number | null;
  sdpQueuedBlocks: number | null;
  sdpPendingBlocks: number | null;
  sdpCarryBytes: number | null;
  sdpDecodeQueueSize: number | null;
}

export default function SharePage() {
  const passwordInputId = useId();
  const shouldReduceMotion = useReducedMotion();
  const params = useParams();
  const code = params.code as string;
  const [state, setState] = useState<PageState>("loading");
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [password, setPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [downloads, setDownloads] = useState<ShareFileDownload[]>([]);
  const [qr, setQr] = useState("");
  const [reported, setReported] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [chunkProgress, setChunkProgress] = useState<ChunkedDownloadProgress | null>(null);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [debugCopied, setDebugCopied] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [sdpEnabled, setSdpEnabled] = useState(false);
  const [debugStatus, setDebugStatus] = useState<DebugStatus>({
    mode: "unknown",
    concurrency: null,
    lastLatencyMs: null,
    lastScope: "",
    lastEvent: "",
    metadataSource: null,
    moovOffset: null,
    audioCodecs: [],
    sidecarDecision: null,
    sdpReadBytes: null,
    sdpFileSize: null,
    sdpRenderedFrames: null,
    sdpQueuedBlocks: null,
    sdpPendingBlocks: null,
    sdpCarryBytes: null,
    sdpDecodeQueueSize: null,
  });
  const debugStartPerfRef = useRef(0);
  const debugStartWallRef = useRef(0);
  const { showToast } = useToast();

  const ingestDebugEntry = useCallback((entry: Omit<DebugEntry, "line">) => {
    if (!debugEnabled) return;
    const line = formatDebugLine(entry.elapsedMs, entry.scope, entry.event, entry.data);
    setDebugEntries((entries) => [...entries.slice(-399), { ...entry, line }]);
    setDebugStatus((status) => {
      let next = status;
      const mode = entry.data && typeof entry.data.mode === "string" ? entry.data.mode : null;
      const concurrency = entry.data && typeof entry.data.desiredConcurrency === "number" ? entry.data.desiredConcurrency : null;
      const latencyMs = entry.data && typeof entry.data.latencyMs === "number" ? entry.data.latencyMs : null;
      if (entry.scope === "sw" && entry.event === "register:file" && mode) {
        next = { ...next, mode };
      }
      if (entry.scope === "sw" && entry.event === "debug:enabled" && next.mode === "unknown") {
        next = { ...next, mode: "optimized" };
      }
      if (entry.scope === "sw" && entry.event === "concurrency" && concurrency !== null) {
        next = { ...next, concurrency };
      }
      if (entry.scope === "player" && (entry.event === "seek:play" || entry.event === "seek:advance") && latencyMs !== null) {
        next = { ...next, lastLatencyMs: latencyMs };
      }
      if (entry.scope === "player" && entry.event === "sidecar:decision" && entry.data) {
        next = {
          ...next,
          metadataSource: typeof entry.data.metadataSource === "string" ? entry.data.metadataSource : null,
          moovOffset: typeof entry.data.moovOffset === "number" ? entry.data.moovOffset : null,
          audioCodecs: Array.isArray(entry.data.audioCodecs) ? entry.data.audioCodecs.filter((item): item is string => typeof item === "string") : [],
          sidecarDecision: typeof entry.data.sidecarDecision === "string" ? entry.data.sidecarDecision : null,
        };
      }
      if (entry.scope === "sdp-mkv" && entry.event === "range:done" && entry.data) {
        next = {
          ...next,
          sdpReadBytes: typeof entry.data.totalBytesRead === "number" ? entry.data.totalBytesRead : next.sdpReadBytes,
        };
      }
      if (entry.scope === "sdp-mkv" && entry.event === "cluster:parsed" && entry.data) {
        next = {
          ...next,
          sdpCarryBytes: typeof entry.data.carryBytes === "number" ? entry.data.carryBytes : next.sdpCarryBytes,
        };
      }
      if (entry.scope === "sdp-mkv" && entry.event === "decoder:backlog" && entry.data) {
        next = {
          ...next,
          sdpPendingBlocks: typeof entry.data.pendingBlocks === "number" ? entry.data.pendingBlocks : next.sdpPendingBlocks,
        };
      }
      if (entry.scope === "sdp-mkv" && entry.event === "decoder:queued" && entry.data) {
        next = {
          ...next,
          sdpQueuedBlocks: typeof entry.data.totalQueuedBlocks === "number" ? entry.data.totalQueuedBlocks : next.sdpQueuedBlocks,
          sdpDecodeQueueSize: typeof entry.data.decodeQueueSize === "number" ? entry.data.decodeQueueSize : next.sdpDecodeQueueSize,
        };
      }
      if (entry.scope === "sdp-mkv" && entry.event === "render:progress" && entry.data) {
        next = {
          ...next,
          sdpRenderedFrames: typeof entry.data.renderedFrames === "number" ? entry.data.renderedFrames : next.sdpRenderedFrames,
        };
      }
      if (entry.scope === "sdp" && entry.event === "init" && entry.data) {
        next = {
          ...next,
          sdpFileSize: typeof entry.data.fileSize === "number" ? entry.data.fileSize : next.sdpFileSize,
        };
      }
      return { ...next, lastScope: entry.scope, lastEvent: entry.event };
    });
  }, [debugEnabled]);

  const appendDebugLog = useCallback<DebugLogFn>((scope, event, data) => {
    const elapsedMs = performance.now() - debugStartPerfRef.current;
    ingestDebugEntry({ elapsedMs, scope, event, data });
  }, [ingestDebugEntry]);

  useEffect(() => {
    if (!code) return;
    getShareInfo(code)
      .then((data) => { setShare(data); setState("ready"); })
      .catch((err) => {
        if (isHttpStatusError(err, 410)) setState("expired");
        else if (isHttpStatusError(err, 404)) setState("not_found");
        else setState("error");
      });
  }, [code]);

  useEffect(() => {
    QRCode.toDataURL(window.location.href, { margin: 1, width: 180 })
      .then(setQr)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void prepareVirtualMediaTransport().catch(() => {});
  }, []);

  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    setDebugEnabled(searchParams.get("debug") === "1");
    setSdpEnabled(searchParams.get("sdp") === "1");
  }, []);

  useEffect(() => {
    if (!debugEnabled) return;
    debugStartPerfRef.current = performance.now();
    debugStartWallRef.current = Date.now();
    const mode = new URLSearchParams(window.location.search).get("sw") === "legacy" ? "legacy" : "optimized";
    setDebugStatus((status) => ({ ...status, mode }));
    appendDebugLog("page", "debug:on", {
      url: window.location.href,
      mode,
      sdpEnabled,
      userAgent: navigator.userAgent,
      connection: getConnectionInfo(),
    });

    const onMessage = (event: MessageEvent) => {
      const record = toDebugRecord(event.data);
      if (!record) return;
      ingestDebugEntry({
        elapsedMs: record.ts - debugStartWallRef.current,
        scope: record.scope,
        event: record.event,
        data: record.data,
      });
    };

    navigator.serviceWorker?.addEventListener("message", onMessage);
    const enableSwDebug = () => setVirtualMediaDebugEnabled(true);
    const refreshSwDebug = () => enableSwDebug()
      .catch((err) => appendDebugLog("sw", "debug:refresh-error", { error: err instanceof Error ? err.message : String(err) }));

    void enableSwDebug()
      .then(() => appendDebugLog("sw", "debug:enabled"))
      .catch((err) => appendDebugLog("sw", "debug:enable-error", { error: err instanceof Error ? err.message : String(err) }));
    const debugRefreshTimer = window.setInterval(() => void refreshSwDebug(), 30000);
    const onControllerChange = () => void refreshSwDebug();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshSwDebug();
    };
    navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearInterval(debugRefreshTimer);
      navigator.serviceWorker?.removeEventListener("message", onMessage);
      navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      void setVirtualMediaDebugEnabled(false).catch(() => {});
    };
  }, [appendDebugLog, debugEnabled, ingestDebugEntry, sdpEnabled]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  const fetchDownloadUrls = async (): Promise<{ files: ShareFileDownload[]; emptyDirs: string[] } | null> => {
    try {
      const startedAt = performance.now();
      appendDebugLog("page", "download-url:start", { hasPassword: !!share?.has_password });
      if (share?.has_password) {
        if (password.length !== 4) { setPwError("请输入4位提取码"); return null; }
        const res = await verifyShare(code, password);
        appendDebugLog("page", "download-url:done", { files: res.files.length, emptyDirs: res.empty_dirs.length, elapsedMs: Math.round(performance.now() - startedAt) });
        return { files: res.files, emptyDirs: res.empty_dirs };
      } else {
        const res = await downloadShare(code);
        appendDebugLog("page", "download-url:done", { files: res.files.length, emptyDirs: res.empty_dirs.length, elapsedMs: Math.round(performance.now() - startedAt) });
        return { files: res.files, emptyDirs: res.empty_dirs };
      }
    } catch (err) {
      appendDebugLog("page", "download-url:error", { error: getErrorMessage(err, "获取下载链接失败") });
      setPwError(getErrorMessage(err, "获取下载链接失败"));
      return null;
    }
  };

  const handleDownload = async () => {
    if (!share) return;
    appendDebugLog("page", "download:click", { totalBytes: share.total_bytes, files: share.files.length });
    setDownloading(true);
    setPwError("");
    const res = await fetchDownloadUrls();
    if (!res) { setDownloading(false); return; }
    const files = res.files;
    setDownloads(files);

    if (files.length === 1 && res.emptyDirs.length === 0) {
      const f = files[0];
      if (f.is_chunked && f.chunks.length > 0) {
        // Chunked large file download
        if (!supportsChunkedDownload()) {
          setPwError("当前浏览器不支持大文件下载，请使用桌面版 Chrome 或 Edge");
          setDownloading(false);
          return;
        }
        try {
          await chunkedDownload(f.file_name, f.file_size, f.chunks, setChunkProgress, appendDebugLog);
          setChunkProgress(null);
        } catch (err) {
          setChunkProgress(null);
          if (err instanceof DOMException && err.name === "AbortError") {
            // User cancelled save dialog
          } else {
            setPwError(getErrorMessage(err, "下载失败"));
          }
        }
      } else {
        // Single regular file: trigger browser download
        appendDebugLog("download", "direct:start", { fileName: f.file_name, fileSize: f.file_size });
        const a = document.createElement("a");
        a.href = f.download_url;
        a.download = f.file_name;
        a.rel = "noopener";
        a.click();
        appendDebugLog("download", "direct:triggered", { fileName: f.file_name });
      }
    } else if (files.length === 0 && res.emptyDirs.length > 0) {
      try {
        await downloadZipArchive([], res.emptyDirs);
      } catch {
        setPwError("打包下载失败");
      }
    }
    // Multi-file: show file list with individual + zip download
    setDownloading(false);
  };

  const handleReport = async () => {
    if (!reportReason.trim()) return;
    try {
      appendDebugLog("page", "report:submit", { reason: reportReason.trim() });
      await reportShare(code, reportReason.trim());
      setReported(true);
      setReportOpen(false);
      setReportReason("");
      showToast({ title: "举报已提交", type: "success" });
    } catch (err) {
      showToast({ title: getErrorMessage(err), type: "error" });
    }
  };

  const handleCopyLink = () => {
    const text = window.location.href;
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.setSelectionRange(0, text.length);
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    appendDebugLog("page", "link:copy", { url: text });
    showToast({ title: "链接已复制", type: "success" });
  };

  const downloadZipArchive = async (files: ShareFileDownload[], emptyDirs: string[]) => {
    const startedAt = performance.now();
    appendDebugLog("download", "zip:start", { files: files.length, emptyDirs: emptyDirs.length });
    const { downloadZip } = await import("client-zip");
    const responses = await Promise.all(
      files.map(async (f) => ({
        name: f.file_name,
        input: await fetch(f.download_url),
      }))
    );
    const folders = emptyDirs.map((dir) => ({ name: dir.endsWith("/") ? dir : `${dir}/` }));
    const blob = await downloadZip([...folders, ...responses]).blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${code}.zip`;
    a.click();
    URL.revokeObjectURL(url);
    appendDebugLog("download", "zip:triggered", { elapsedMs: Math.round(performance.now() - startedAt) });
  };

  const handleDownloadAll = async () => {
    if (downloads.length === 0 && (!share || share.empty_dirs.length === 0)) return;
    setDownloading(true);
    appendDebugLog("page", "download:all:click", { files: downloads.length, emptyDirs: share?.empty_dirs.length || 0 });
    try {
      await downloadZipArchive(downloads, share?.empty_dirs || []);
    } catch {
      setPwError("打包下载失败");
    }
    setDownloading(false);
  };

  const handlePreview = async () => {
    if (!share) return;
    appendDebugLog("page", "preview:click", { code, files: share.files.length, totalBytes: share.total_bytes });
    const startedAt = performance.now();
    const res = await fetchDownloadUrls();
    if (res && res.files.length > 0) {
      appendDebugLog("page", "preview:ready", { files: res.files.length, firstFile: res.files[0]?.file_name, elapsedMs: Math.round(performance.now() - startedAt) });
      setDownloads(res.files);
    }
  };

  const handleCopyDebugLogs = () => {
    const text = debugEntries.map((entry) => entry.line).join("\n");
    void copyText(text);
    setDebugCopied(true);
    window.setTimeout(() => setDebugCopied(false), 1200);
  };

  const handleCopyDebugJson = () => {
    const text = JSON.stringify({
      status: debugStatus,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      entries: debugEntries.map(({ line: _line, ...entry }) => entry),
    }, null, 2);
    void copyText(text);
    setDebugCopied(true);
    window.setTimeout(() => setDebugCopied(false), 1200);
  };

  const copyText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Fall back to execCommand below.
      }
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, text.length);
    document.execCommand("copy");
    document.body.removeChild(ta);
  };

  const getConnectionInfo = () => {
    const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean } };
    const connection = nav.connection;
    return connection ? {
      effectiveType: connection.effectiveType,
      downlink: connection.downlink,
      rtt: connection.rtt,
      saveData: connection.saveData,
    } : null;
  };

  // --- Status pages ---
  if (state === "loading") {
    return <main className="min-h-dvh bg-warm-50 dark:bg-background flex items-center justify-center"><p className="type-body text-gray-600 dark:text-gray-400 animate-pulse">加载中...</p></main>;
  }
  if (state === "not_found") {
    return <main className="min-h-dvh bg-warm-50 dark:bg-background flex flex-col items-center justify-center gap-4"><AlertCircle className="w-12 h-12 text-gray-400" /><p className="type-body text-gray-700 dark:text-gray-300">分享不存在或已被删除</p><a href="/" className="type-action flex min-h-[44px] items-center text-nyy-800 dark:text-nyy-400 hover:underline">返回首页</a></main>;
  }
  if (state === "expired") {
    return <main className="min-h-dvh bg-warm-50 dark:bg-background flex flex-col items-center justify-center gap-4"><Clock className="w-12 h-12 text-gray-400" /><p className="type-body text-gray-700 dark:text-gray-300">分享已过期</p><a href="/" className="type-action flex min-h-[44px] items-center text-nyy-800 dark:text-nyy-400 hover:underline">返回首页</a></main>;
  }
  if (state === "error" || !share) {
    return <main className="min-h-dvh bg-warm-50 dark:bg-background flex flex-col items-center justify-center gap-4"><AlertCircle className="w-12 h-12 text-red-500" /><p className="type-body text-gray-700 dark:text-gray-300">加载失败，请稍后重试</p></main>;
  }

  const isSingle = share.files.length === 1 && share.empty_dirs.length === 0;
  const hasOnlyEmptyDirs = share.files.length === 0 && share.empty_dirs.length > 0;
  const sdpEligibleSingle = sdpEnabled && isSingle && share.files.some((f) => getSelfDevelopMediaType(f.file_name) !== null);
  const hasMedia = sdpEligibleSingle || share.files.some((f) => getMediaType(f.file_name) !== null);

  return (
    <main className="min-h-dvh bg-warm-50 dark:bg-background flex flex-col items-center justify-center px-4 py-16">
      <motion.div initial={shouldReduceMotion ? false : { opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md bg-white dark:bg-card rounded-3xl shadow-sm dark:shadow-none border border-warm-200 dark:border-gray-700 p-8 space-y-6">
        <div className="text-center">
          <div className="flex justify-center">
            <BrandLogo className="h-auto w-36" />
          </div>
          <p className="type-body-sm text-gray-600 dark:text-gray-400 mt-1">{hasOnlyEmptyDirs ? "有人给你分享了空文件夹" : "有人给你分享了文件"}</p>
          {hasOnlyEmptyDirs && (
            <p className="type-caption mt-1 text-gray-500 dark:text-gray-400">没有文件，只有空文件夹，下载时会打包成 ZIP。</p>
          )}
          {share.max_downloads > 0 && (
            <p className="type-body-sm text-gray-600 dark:text-gray-400 mt-1">剩余下载次数 {Math.max(0, share.max_downloads - share.download_count)} / {share.max_downloads}</p>
          )}
        </div>

        {qr && (
          <details className="rounded-2xl bg-warm-50 dark:bg-white/5 p-3 text-center">
            <summary className="type-action cursor-pointer text-gray-700 dark:text-gray-300 flex min-h-[44px] items-center justify-center gap-1"><QrCode className="w-3 h-3" /> 二维码分享</summary>
            <Image src={qr} alt="分享二维码" width={128} height={128} unoptimized className="mx-auto mt-3 h-32 w-32" />
            <a href={qr} download={`nyy-${code}.png`} className="type-action mt-2 inline-flex min-h-[44px] items-center text-nyy-800 dark:text-nyy-400 hover:underline">下载 PNG</a>
          </details>
        )}

        {/* File list */}
        <div className="space-y-2">
          {share.empty_dirs.map((dir) => (
            <div key={dir} className="flex items-center gap-3 p-3 bg-warm-50 dark:bg-white/5 rounded-2xl">
              <Folder className="w-8 h-8 text-nyy-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="type-file-name font-medium text-gray-800 dark:text-gray-200 truncate">{dir}</p>
                <p className="type-file-meta text-gray-600 dark:text-gray-400">空文件夹</p>
              </div>
            </div>
          ))}
          {share.files.map((f, i) => (
            <div key={i} className="flex items-center gap-3 p-3 bg-warm-50 dark:bg-white/5 rounded-2xl">
              <FileIcon className="w-8 h-8 text-nyy-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="type-file-name font-medium text-gray-800 dark:text-gray-200 truncate">{f.file_name}</p>
                <p className="type-file-meta text-gray-600 dark:text-gray-400">
                  {formatSize(f.file_size)}
                  {f.is_chunked && <span className="ml-1 text-nyy-500">({f.chunk_count} 分片)</span>}
                </p>
              </div>
              {/* Individual download if URLs available */}
              {downloads[i] && !downloads[i].is_chunked && (
                <a href={downloads[i].download_url} target="_blank" rel="noopener" download={downloads[i].file_name} aria-label={`下载 ${f.file_name}`} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl hover:bg-nyy-50">
                  <Download className="w-4 h-4 text-nyy-500" />
                </a>
              )}
              {downloads[i] && downloads[i].is_chunked && (
                <button
                  onClick={async () => {
                    if (!supportsChunkedDownload()) {
                      showToast({ title: "请使用桌面版 Chrome/Edge 下载大文件", type: "error" });
                      return;
                    }
                    try {
                      await chunkedDownload(downloads[i].file_name, downloads[i].file_size, downloads[i].chunks, setChunkProgress, appendDebugLog);
                      setChunkProgress(null);
                    } catch (err) {
                      setChunkProgress(null);
                      if (!(err instanceof DOMException && err.name === "AbortError")) {
                        showToast({ title: getErrorMessage(err, "下载失败"), type: "error" });
                      }
                    }
                  }}
                  aria-label={`下载 ${f.file_name}`}
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl hover:bg-nyy-50"
                >
                  <Download className="w-4 h-4 text-nyy-500" />
                </button>
              )}
            </div>
          ))}
          {!isSingle && !hasOnlyEmptyDirs && (
            <p className="type-body-sm text-gray-600 dark:text-gray-400 text-center">
              <Files className="w-3 h-3 inline mr-1" />
              共 {share.files.length} 个文件，{share.empty_dirs.length} 个空文件夹，{formatSize(share.total_bytes)}
            </p>
          )}
          {hasOnlyEmptyDirs && (
            <p className="type-body-sm text-gray-600 dark:text-gray-400 text-center">
              <Files className="w-3 h-3 inline mr-1" />
              共 {share.empty_dirs.length} 个空文件夹
            </p>
          )}
        </div>

        {/* Media player */}
        {downloads.length > 0 && downloads.map((dl, i) => {
          const useSdp = sdpEnabled && isSingle && getSelfDevelopMediaType(dl.file_name) !== null;
          if (useSdp) return <SelfDevelopPlayer key={i} file={dl} className="rounded-2xl overflow-hidden" debugLog={appendDebugLog} />;
          const mt = getMediaType(dl.file_name);
          if (!mt) return null;
          return <MediaPlayer key={i} file={dl} className="rounded-2xl overflow-hidden" debugLog={appendDebugLog} />;
        })}
        {hasMedia && downloads.length === 0 && !share.has_password && (
          <button onClick={handlePreview} className="type-action flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-nyy-300 dark:border-nyy-700 text-nyy-800 dark:text-nyy-400 hover:bg-nyy-50 dark:hover:bg-nyy-900/20">
            <Play className="w-4 h-4" /> {sdpEligibleSingle ? "SDP 预览" : "预览"}
          </button>
        )}

        {debugEnabled && (
          <div className="rounded-2xl border border-nyy-200 bg-nyy-50/70 p-3 dark:border-nyy-800 dark:bg-nyy-950/20">
            <div className="mb-3 rounded-xl bg-white/80 p-3 dark:bg-black/20">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-700 dark:text-gray-300">
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">mode: {debugStatus.mode}</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">sdp: {sdpEnabled ? "on" : "off"}</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">concurrency: {debugStatus.concurrency ?? "-"}</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">last: {debugStatus.lastScope}/{debugStatus.lastEvent}</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">latency: {debugStatus.lastLatencyMs ?? "-"}ms</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">metadata: {debugStatus.metadataSource ?? "-"}</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">moov: {debugStatus.moovOffset ?? "-"}</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">audio: {debugStatus.audioCodecs.length ? debugStatus.audioCodecs.join("/") : "-"}</span>
                <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">sidecar: {debugStatus.sidecarDecision ?? "-"}</span>
              </div>
              {sdpEnabled && debugStatus.sdpReadBytes !== null && (
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-700 dark:text-gray-300">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 dark:bg-emerald-900/40">read: {formatSize(debugStatus.sdpReadBytes)}{debugStatus.sdpFileSize ? ` / ${formatSize(debugStatus.sdpFileSize)} (${Math.round(debugStatus.sdpReadBytes / debugStatus.sdpFileSize * 100)}%)` : ""}</span>
                  {debugStatus.sdpRenderedFrames !== null && <span className="rounded-full bg-emerald-100 px-2 py-0.5 dark:bg-emerald-900/40">rendered: {debugStatus.sdpRenderedFrames}</span>}
                  {debugStatus.sdpQueuedBlocks !== null && <span className="rounded-full bg-emerald-100 px-2 py-0.5 dark:bg-emerald-900/40">queued: {debugStatus.sdpQueuedBlocks}</span>}
                  {debugStatus.sdpPendingBlocks !== null && <span className="rounded-full bg-emerald-100 px-2 py-0.5 dark:bg-emerald-900/40">pending: {debugStatus.sdpPendingBlocks}</span>}
                  {debugStatus.sdpCarryBytes !== null && <span className="rounded-full bg-emerald-100 px-2 py-0.5 dark:bg-emerald-900/40">carry: {formatSize(debugStatus.sdpCarryBytes)}</span>}
                  {debugStatus.sdpDecodeQueueSize !== null && <span className="rounded-full bg-emerald-100 px-2 py-0.5 dark:bg-emerald-900/40">decodeQ: {debugStatus.sdpDecodeQueueSize}</span>}
                </div>
              )}
            </div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="type-caption font-semibold text-nyy-900 dark:text-nyy-200">Debug 日志 · {debugEntries.length}</p>
              <div className="flex gap-2">
                <button onClick={handleCopyDebugLogs} className="type-caption rounded-lg border border-nyy-300 px-2 py-1 text-nyy-800 dark:border-nyy-700 dark:text-nyy-300">
                  {debugCopied ? "已复制文本" : "复制文本"}
                </button>
                <button onClick={handleCopyDebugJson} className="type-caption rounded-lg border border-nyy-300 px-2 py-1 text-nyy-800 dark:border-nyy-700 dark:text-nyy-300">
                  复制 JSON
                </button>
              </div>
            </div>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/90 p-3 text-[11px] leading-relaxed text-green-100">
              {debugEntries.length ? debugEntries.map((entry) => entry.line).join("\n") : "等待日志..."}
            </pre>
          </div>
        )}

        {/* Password input */}
        {share.has_password && downloads.length === 0 && (
          <div className="space-y-2">
            <label htmlFor={passwordInputId} className="type-label text-gray-700 dark:text-gray-300 flex items-center gap-1"><Lock className="w-4 h-4" /> 需要提取码</label>
            <input
              id={passwordInputId}
              type="text" maxLength={4} inputMode="numeric"
              placeholder="输入4位提取码" value={password}
              onChange={(e) => { setPassword(e.target.value.replace(/\D/g, "").slice(0, 4)); setPwError(""); }}
              className="type-section min-h-[44px] w-full rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-background px-4 text-center tracking-[0.5em] dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-nyy-300"
            />
            {pwError && <p role="alert" className="type-caption text-center text-red-700">{pwError}</p>}
          </div>
        )}

        {/* Chunked download progress */}
        {chunkProgress && (
          <div className="space-y-2 p-3 bg-nyy-50/60 dark:bg-nyy-900/10 rounded-2xl">
            <div className="flex justify-between type-caption text-gray-600 dark:text-gray-400">
              <span>下载中 · 分片 {chunkProgress.currentChunk + 1}/{chunkProgress.totalChunks}</span>
              <span>{Math.round((chunkProgress.downloadedBytes / chunkProgress.totalBytes) * 100)}%</span>
            </div>
            <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-nyy-500 rounded-full transition-all duration-300"
                style={{ width: `${(chunkProgress.downloadedBytes / chunkProgress.totalBytes) * 100}%` }}
              />
            </div>
            <p className="type-caption text-gray-500 dark:text-gray-400">
              {formatSize(chunkProgress.downloadedBytes)} / {formatSize(chunkProgress.totalBytes)}
            </p>
          </div>
        )}

        {/* Download buttons */}
        {downloads.length === 0 ? (
          <button
            onClick={handleDownload} disabled={downloading}
            className={cn(
              "btn-primary w-full py-3 rounded-2xl flex items-center justify-center gap-2",
              downloading && "!bg-none !bg-gray-300 !text-gray-800 !shadow-none cursor-not-allowed"
            )}
          >
            <Download className="w-5 h-5" />
            {downloading ? "获取中..." : hasOnlyEmptyDirs ? "下载文件夹" : isSingle ? "下载文件" : "获取下载链接"}
          </button>
        ) : !isSingle && (
          <button
            onClick={handleDownloadAll} disabled={downloading}
            className={cn(
              "btn-primary w-full py-3 rounded-2xl flex items-center justify-center gap-2",
              downloading && "!bg-none !bg-gray-300 !text-gray-800 !shadow-none cursor-not-allowed"
            )}
          >
            <Package className="w-5 h-5" />
            {downloading ? "打包中..." : "打包下载全部"}
          </button>
        )}

        {pwError && downloads.length > 0 && <p role="alert" className="type-caption text-center text-red-700">{pwError}</p>}

        <div className="type-body-sm text-center text-gray-600 dark:text-gray-400">
          <p>已下载 {share.download_count} 次</p>
          {share.expires_at && <p>过期时间: {new Date(share.expires_at).toLocaleString("zh-CN")}</p>}
        </div>
      </motion.div>

      {/* Desktop footer */}
      <footer className="type-body-sm mt-10 hidden text-center text-gray-600 dark:text-gray-400 md:block">
        <button onClick={() => setReportOpen(true)} disabled={reported} className="mr-3 inline-flex min-h-[44px] min-w-[44px] items-center gap-1 hover:text-red-600 disabled:opacity-50"><Flag className="w-3 h-3" /> {reported ? "已举报" : "举报"}</button>
        <button onClick={handleCopyLink} className="mr-3 inline-flex min-h-[44px] min-w-[44px] items-center gap-1 hover:text-nyy-800 dark:hover:text-nyy-400"><Copy className="w-3 h-3" /> 复制链接</button>
        <a href="/" className="inline-flex min-h-[44px] items-center hover:text-nyy-800 dark:hover:text-nyy-400">拿呀呀 nyy.app</a>
      </footer>

      {/* Mobile fixed action bar */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t border-warm-200 dark:border-gray-700 bg-white/95 dark:bg-card/95 px-4 py-2 backdrop-blur-sm md:hidden">
        <button onClick={handleDownload} disabled={downloading} className="type-caption flex flex-col items-center gap-0.5 text-gray-700 dark:text-gray-300">
          <Download className="h-5 w-5 text-nyy" />
          <span>下载</span>
        </button>
        <button onClick={handleCopyLink} className="type-caption flex flex-col items-center gap-0.5 text-gray-700 dark:text-gray-300">
          <Copy className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          <span>复制</span>
        </button>
        <button onClick={() => setReportOpen(true)} disabled={reported} className="type-caption flex flex-col items-center gap-0.5 text-gray-700 dark:text-gray-300 disabled:opacity-50">
          <Flag className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          <span>{reported ? "已举报" : "举报"}</span>
        </button>
      </div>

      {/* Report Modal */}
      {reportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setReportOpen(false)} />
          <div className="relative w-full max-w-sm rounded-2xl bg-white dark:bg-card p-6 shadow-xl">
            <button onClick={() => setReportOpen(false)} className="absolute right-4 top-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"><X className="h-5 w-5" /></button>
            <h3 className="type-section text-gray-900 dark:text-gray-100">举报此分享</h3>
            <p className="type-body-sm mt-1 text-gray-600 dark:text-gray-400">请说明举报原因，我们会尽快处理。</p>
            <select value={reportReason} onChange={(e) => setReportReason(e.target.value)} className="type-body-sm mt-4 min-h-[44px] w-full rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-background px-3 dark:text-gray-200 focus:border-nyy focus:outline-none">
              <option value="">选择原因…</option>
              <option value="侵权内容">侵权内容</option>
              <option value="恶意软件">恶意软件</option>
              <option value="违法内容">违法内容</option>
              <option value="色情低俗">色情低俗</option>
              <option value="其他">其他</option>
            </select>
            <button onClick={handleReport} disabled={!reportReason} className="type-action mt-4 min-h-[44px] w-full rounded-xl bg-red-500 px-4 font-semibold text-white hover:bg-red-600 disabled:opacity-50">提交举报</button>
          </div>
        </div>
      )}

      {/* Bottom padding for mobile action bar */}
      <div className="h-16 md:hidden" />
    </main>
  );
}
