"use client";

import { useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Upload, CheckCircle2, AlertCircle, FileIcon, Lock, Clock, FileCheck2,
  X, RotateCcw, Files, Download, Folder, ExternalLink,
} from "lucide-react";
import { CopyLinkButton } from "@/components/copy-link-button";
import { cn } from "@/lib/utils";
import { computeCRC32 } from "@/lib/crc32";
import { cancelUploadBatch, uploadInit, uploadCommit, multipartInit, multipartMerge, getQuota, type QuotaInfo, type CommitFileItem, type CommitLogicalFileItem, type MediaMetadata, type MultipartInitResponse } from "@/lib/api";
import { formatXhrStatusError, getErrorMessage, HttpStatusError, isSuccessfulHttpStatus } from "@/lib/errors";
import { probeMediaMetadata, shouldProbeMediaMetadata, checkCodecCompatibility } from "@/lib/media-metadata";
import type { DebugLogFn } from "@/lib/debug";
import { getAvailableRetentionCoupons, getGrowthMe, type GrowthMe } from "@/lib/growth";
import { uploadWithTTUploader } from "@/lib/tt-uploader";
import {
  clearExpiredUploadSessions,
  createUploadSession,
  deleteUploadSession,
  findUploadSession,
  getUploadFileKey,
  markUploadChunkComplete,
  markMultipartInit,
  markMultipartPartComplete,
  markMultipartMerged,
  saveUploadSession,
  type StoredCommitItem,
  type UploadSession,
  type UploadSessionFile,
} from "@/lib/upload-state";

const MAX_RETRIES = 3;
const CHUNK_SIZE = 512 * 1024 * 1024; // 512 MiB
const SMALL_FILE_XHR_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours per small file
const COMMIT_MAX_RETRIES = 3;
const GLOBAL_UPLOAD_CONCURRENCY = 2;
const TOKEN_EXPIRY_SAFETY_MS = 5 * 60 * 1000;
const MULTIPART_THRESHOLD = 512 * 1024 * 1024; // >512MB 走 multipart
const MULTIPART_PART_CONCURRENCY = 3;
const PART_XHR_TIMEOUT = 30 * 60 * 1000;

const getFileUploadName = (file: File) =>
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

type PickedFile = { file: File; uploadName: string };
type PickedSelection = { files: PickedFile[]; emptyDirs: string[] };

type FileState = "pending" | "hashing" | "uploading" | "done" | "error";
type MediaProbeState = "analyzing" | "ready" | "warning" | "failed";

interface FileEntry {
  id: string;
  file: File;
  uploadName: string;
  state: FileState;
  progress: number;
  error: string;
  retries: number;
  commitToken?: string;
  storeUri?: string;
  mediaProbeState?: MediaProbeState;
  mediaProbeMessage?: string;
}

type OverallState = "idle" | "uploading" | "committing" | "done" | "error";

interface UploadResult {
  shareCode: string;
  shareUrl: string;
  fileCount: number;
  revokeToken?: string | null;
}

export function FileUploader({
  onUploadDone,
  loggedIn = false,
  onLoginClick,
  debugLog,
  initialQuota,
  onQuotaChange,
}: {
  onUploadDone?: () => void;
  loggedIn?: boolean;
  onLoginClick?: () => void;
  debugLog?: DebugLogFn;
  initialQuota?: QuotaInfo | null;
  onQuotaChange?: (quota: QuotaInfo | null) => void;
} = {}) {
  const idPrefix = useId();
  const shouldReduceMotion = useReducedMotion();
  const [overall, setOverall] = useState<OverallState>("idle");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [emptyDirs, setEmptyDirs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [folderWarning, setFolderWarning] = useState("");
  const [result, setResult] = useState<UploadResult | null>(null);
  const [resultPhase, setResultPhase] = useState<"check" | "card">("check");
  const [dragOver, setDragOver] = useState(false);
  const [qrUrl, setQrUrl] = useState<string>("");
  const [quota, setQuota] = useState<QuotaInfo | null>(initialQuota ?? null);
  const [password, setPassword] = useState("");
  const [expiresHours, setExpiresHours] = useState(initialQuota?.default_retention_hours ?? (loggedIn ? 168 : 1));
  const [maxDownloads, setMaxDownloads] = useState(initialQuota?.default_max_downloads ?? (loggedIn ? 100 : 10));
  const [growth, setGrowth] = useState<GrowthMe | null>(null);
  const [retentionCouponId, setRetentionCouponId] = useState("");
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [supportsDirectoryPicker, setSupportsDirectoryPicker] = useState(false);
  const [resumeMessage, setResumeMessage] = useState("");
  const [uploadMetrics, setUploadMetrics] = useState({ uploadedBytes: 0, speedBps: 0, elapsedMs: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<Map<string, XMLHttpRequest>>(new Map());
  const sdkAbortRef = useRef<Map<string, () => void>>(new Map());
  const activeUploadBatchIdRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);
  const fileLoadedRef = useRef<Map<string, number>>(new Map());
  const uploadStartAtRef = useRef(0);
  const uploadSamplesRef = useRef<Array<{ at: number; bytes: number }>>([]);
  const lastMetricsUpdateRef = useRef(0);
  const lastDebugMetricsAtRef = useRef(0);
  const retentionTouchedRef = useRef(false);
  const downloadsTouchedRef = useRef(false);
  const appliedPolicyVersionRef = useRef<string | null>(null);
  const maxFileSize = quota?.max_file_bytes ?? (loggedIn ? 10 : 2) * 1024 ** 3;
  const maxFileCount = quota?.max_files_per_share ?? (loggedIn ? 500 : 100);
  const maxEmptyDirCount = quota?.max_empty_dirs_per_share ?? (loggedIn ? 500 : 100);
  const maxShareSize = quota?.max_share_bytes ?? quota?.limit_bytes ?? Number.MAX_SAFE_INTEGER;

  useEffect(() => {
    if (!quota) return;
    const fallbackRetention = loggedIn ? [1, 6, 24, 72, 168, 360, 720] : [1, 6, 24, 72];
    const fallbackDownloads = loggedIn ? [1, 10, 50, 100, 200, 0] : [1, 10];
    const retentionOptions = quota.retention_options_hours ?? fallbackRetention;
    const downloadOptions = quota.download_options ?? fallbackDownloads;
    const defaultRetention = quota.default_retention_hours ?? (loggedIn ? 168 : 1);
    const defaultDownloads = quota.default_max_downloads ?? (loggedIn ? 100 : 10);
    const policyKey = `${loggedIn}:${quota.policy_version ?? 0}:${quota.period_kind ?? "legacy"}:${quota.limit_bytes}`;
    if (appliedPolicyVersionRef.current !== policyKey) {
      if (!retentionTouchedRef.current) setExpiresHours(defaultRetention);
      if (!downloadsTouchedRef.current) setMaxDownloads(defaultDownloads);
      appliedPolicyVersionRef.current = policyKey;
    }
    if (!retentionOptions.includes(expiresHours)) setExpiresHours(defaultRetention);
    if (!downloadOptions.includes(maxDownloads)) setMaxDownloads(defaultDownloads);
  }, [expiresHours, loggedIn, maxDownloads, quota]);

  useEffect(() => {
    setSupportsDirectoryPicker(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  useEffect(() => {
    setQuota(initialQuota ?? null);
  }, [initialQuota]);

  useEffect(() => {
    if (!loggedIn) {
      setGrowth(null);
      setRetentionCouponId("");
      return;
    }
    let cancelled = false;
    getGrowthMe().then((data) => { if (!cancelled) setGrowth(data); }).catch(() => {});
    return () => { cancelled = true; };
  }, [loggedIn]);

  // Transition from checkmark animation to result card
  useEffect(() => {
    if (overall === "done" && resultPhase === "check") {
      const timer = setTimeout(() => setResultPhase("card"), 1500);
      return () => clearTimeout(timer);
    }
  }, [overall, resultPhase]);

  useEffect(() => {
    if (overall !== "uploading" && overall !== "committing") return;
    const timer = window.setInterval(() => updateUploadMetrics(true), 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overall]);

  const reset = () => {
    const activeUploadBatchId = activeUploadBatchIdRef.current;
    if (activeUploadBatchId) {
      void cancelUploadBatch({ upload_batch_id: activeUploadBatchId }).catch(() => {});
      void deleteUploadSession(activeUploadBatchId).catch(() => {});
    }
    abortRef.current.forEach((xhr) => xhr.abort());
    abortRef.current.clear();
    sdkAbortRef.current.forEach((cancel) => cancel());
    sdkAbortRef.current.clear();
    setOverall("idle");
    setFiles([]);
    setEmptyDirs([]);
    setError("");
    setFolderWarning("");
    setResult(null);
    setResultPhase("check");
    setQrUrl("");
    setResumeMessage("");
    setUploadMetrics({ uploadedBytes: 0, speedBps: 0, elapsedMs: 0 });
    setShowAllFiles(false);
    setRetentionCouponId("");
    fileLoadedRef.current.clear();
    uploadStartAtRef.current = 0;
    uploadSamplesRef.current = [];
    lastMetricsUpdateRef.current = 0;
    lastDebugMetricsAtRef.current = 0;
    cancelledRef.current = false;
    activeUploadBatchIdRef.current = null;
    debugLog?.("upload", "reset");
  };

  const updateFile = (id: string, patch: Partial<FileEntry>) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  const normalizeDirPath = (path: string) => {
    const parts = path.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".");
    if (parts.length === 0 || parts.some((part) => part === "..")) return "";
    return `${parts.join("/")}/`;
  };

  const mergeEmptyDirs = (current: string[], incoming: string[]) => {
    const seen = new Set(current);
    const merged = [...current];
    for (const raw of incoming) {
      const normalized = normalizeDirPath(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(normalized);
    }
    return merged;
  };

  const pickFile = (file: File, uploadName = getFileUploadName(file)): PickedFile => ({ file, uploadName });

  const addFiles = (newFiles: PickedFile[], newEmptyDirs: string[] = []) => {
    const maxSize = maxFileSize;
    debugLog?.("upload", "selection:add", {
      incomingFiles: newFiles.length,
      incomingBytes: newFiles.reduce((sum, item) => sum + item.file.size, 0),
      incomingEmptyDirs: newEmptyDirs.length,
      loggedIn,
    });
    // 检查是否超过游客单文件上限且未登录。
    const hasLargeFile = newFiles.some(({ file }) => file.size > maxFileSize);
    if (hasLargeFile && !loggedIn) {
      debugLog?.("upload", "selection:blocked", { reason: "large-file-requires-login" });
      setError("超过游客单文件上限的大文件需要登录后上传");
      onLoginClick?.();
      return;
    }
    const valid = newFiles.filter(({ file }) => file.size <= maxSize);
    if (valid.length < newFiles.length) {
      debugLog?.("upload", "selection:skipped", { skippedFiles: newFiles.length - valid.length, maxSize });
      setError(`${newFiles.length - valid.length} 个文件超过单文件上限，已跳过`);
    }
    const normalizedEmptyDirs = newEmptyDirs.map(normalizeDirPath).filter(Boolean);
    if (valid.length === 0 && normalizedEmptyDirs.length === 0) return;

    const entries: FileEntry[] = valid.map(({ file, uploadName }) => ({
      id: Math.random().toString(36).slice(2) + Date.now().toString(36),
      file,
      uploadName,
      state: "pending" as FileState,
      progress: 0,
      error: "",
      retries: 0,
    }));
    if (entries.length > 0) setFiles((prev) => [...prev, ...entries]);
    if (normalizedEmptyDirs.length > 0) setEmptyDirs((prev) => mergeEmptyDirs(prev, normalizedEmptyDirs));
  };

  /** 递归读取 FileSystemEntry（文件夹展开为文件 + 空目录）。 */
  const readEntrySelection = (entry: FileSystemEntry, parentPath = ""): Promise<PickedSelection> => {
    return new Promise((resolve) => {
      if (entry.isFile) {
        (entry as FileSystemFileEntry).file((f) => {
          resolve({ files: [pickFile(f, `${parentPath}${entry.name}`)], emptyDirs: [] });
        }, () => resolve({ files: [], emptyDirs: [] }));
      } else if (entry.isDirectory) {
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        const dirPath = `${parentPath}${entry.name}/`;
        const allFiles: PickedFile[] = [];
        const allEmptyDirs: string[] = [];
        let childCount = 0;
        const readBatch = () => {
          reader.readEntries(async (entries) => {
            if (entries.length === 0) {
              resolve({ files: allFiles, emptyDirs: childCount === 0 ? [dirPath] : allEmptyDirs });
              return;
            }
            childCount += entries.length;
            const results = await Promise.all(entries.map((child) => readEntrySelection(child, dirPath)));
            results.forEach((r) => {
              allFiles.push(...r.files);
              allEmptyDirs.push(...r.emptyDirs);
            });
            readBatch(); // readEntries 可能分批返回
          }, () => resolve({ files: allFiles, emptyDirs: allEmptyDirs }));
        };
        readBatch();
      } else {
        resolve({ files: [], emptyDirs: [] });
      }
    });
  };

  /** 从 DataTransfer 提取所有文件（支持文件夹递归 + 空目录）。 */
  const extractFilesFromDrop = async (dataTransfer: DataTransfer): Promise<PickedSelection> => {
    const items = Array.from(dataTransfer.items);
    const entries = items
      .map((item) => item.webkitGetAsEntry?.())
      .filter((e): e is FileSystemEntry => e !== null && e !== undefined);

    if (entries.length > 0) {
      const results = await Promise.all(entries.map((entry) => readEntrySelection(entry)));
      return {
        files: results.flatMap((r) => r.files),
        emptyDirs: results.flatMap((r) => r.emptyDirs),
      };
    }
    // fallback: 没有 webkitGetAsEntry 支持时用 files
    return { files: Array.from(dataTransfer.files).map((file) => pickFile(file)), emptyDirs: [] };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const readDirectoryHandleSelection = async (dirHandle: { name: string; entries: () => AsyncIterableIterator<[string, any]> }, parentPath = ""): Promise<PickedSelection> => {
    const dirPath = `${parentPath}${dirHandle.name}/`;
    const files: PickedFile[] = [];
    const emptyDirs: string[] = [];
    let childCount = 0;

    for await (const [, handle] of dirHandle.entries()) {
      childCount += 1;
      if (handle.kind === "file") {
        const file = await handle.getFile();
        files.push(pickFile(file, `${dirPath}${handle.name}`));
      } else if (handle.kind === "directory") {
        const child = await readDirectoryHandleSelection(handle, dirPath);
        files.push(...child.files);
        emptyDirs.push(...child.emptyDirs);
      }
    }

    if (childCount === 0) emptyDirs.push(dirPath);
    return { files, emptyDirs };
  };

  const handleFolderPick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setFolderWarning("");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const showDirectoryPicker = (window as Window & { showDirectoryPicker?: (options?: { mode?: "read" }) => Promise<{ name: string; entries: () => AsyncIterableIterator<[string, any]> }> }).showDirectoryPicker;

    if (typeof showDirectoryPicker === "function") {
      try {
        const dirHandle = await showDirectoryPicker({ mode: "read" });
        const selection = await readDirectoryHandleSelection(dirHandle);
        addFiles(selection.files, selection.emptyDirs);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(getErrorMessage(err, "读取文件夹失败"));
        }
      }
      return;
    }

    setFolderWarning("当前浏览器无法保留空文件夹结构，请使用 Chrome / Edge 桌面端。");
  };

  /** Generate a UUID v4 for logical_file_id. */
  const generateUUID = (): string => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  };

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const abortActiveUploads = () => {
    abortRef.current.forEach((xhr) => xhr.abort());
    abortRef.current.clear();
    sdkAbortRef.current.forEach((cancel) => cancel());
    sdkAbortRef.current.clear();
  };

  const updateUploadMetrics = (force = false) => {
    const now = performance.now();
    if (!uploadStartAtRef.current) uploadStartAtRef.current = now;
    const uploadedBytes = Array.from(fileLoadedRef.current.values()).reduce((sum, bytes) => sum + bytes, 0);
    const samples = uploadSamplesRef.current;
    samples.push({ at: now, bytes: uploadedBytes });
    const cutoff = now - 10000;
    while (samples.length > 1 && samples[0].at < cutoff) samples.shift();

    if (!force && now - lastMetricsUpdateRef.current < 500) return;
    lastMetricsUpdateRef.current = now;
    const first = samples[0];
    const seconds = first && now > first.at ? (now - first.at) / 1000 : 0;
    const speedBps = seconds > 0 ? Math.max(0, (uploadedBytes - first.bytes) / seconds) : 0;
    if (debugLog && uploadStartAtRef.current && (force || now - lastDebugMetricsAtRef.current >= 2000)) {
      lastDebugMetricsAtRef.current = now;
      const totalBytes = files.reduce((sum, item) => sum + item.file.size, 0);
      debugLog("upload", "metrics", {
        uploadedBytes,
        totalBytes,
        speedBps: Math.round(speedBps),
        elapsedMs: Math.round(now - uploadStartAtRef.current),
        progress: totalBytes > 0 ? Number(((uploadedBytes / totalBytes) * 100).toFixed(2)) : 0,
      });
    }
    setUploadMetrics({ uploadedBytes, speedBps, elapsedMs: now - uploadStartAtRef.current });
  };

  const recordFileLoaded = (fileId: string, loadedBytes: number, force = false) => {
    fileLoadedRef.current.set(fileId, Math.max(0, loadedBytes));
    updateUploadMetrics(force);
  };

  const cancelUpload = async () => {
    debugLog?.("upload", "cancel", { uploadBatchId: activeUploadBatchIdRef.current });
    cancelledRef.current = true;
    abortActiveUploads();
    const activeUploadBatchId = activeUploadBatchIdRef.current;
    if (activeUploadBatchId) await cancelUploadBatch({ upload_batch_id: activeUploadBatchId }).catch(() => {});
    if (activeUploadBatchId) await deleteUploadSession(activeUploadBatchId).catch(() => {});
    activeUploadBatchIdRef.current = null;
    fileLoadedRef.current.clear();
    uploadSamplesRef.current = [];
    uploadStartAtRef.current = 0;
    lastMetricsUpdateRef.current = 0;
    setUploadMetrics({ uploadedBytes: 0, speedBps: 0, elapsedMs: 0 });
    setFiles((prev) => prev.map((entry) => (
      entry.state === "uploading" || entry.state === "hashing"
        ? { ...entry, state: "error", error: "上传已取消", progress: 0 }
        : entry
    )));
    setOverall("error");
    setError("上传已取消");
  };

  const getErrorStatus = (error: unknown): number | null => {
    if (error instanceof HttpStatusError) return error.status;
    const message = getErrorMessage(error, "");
    const match = message.match(/^(\d+)[:：]/);
    return match ? Number(match[1]) : null;
  };

  const isRetryableUploadError = (error: unknown) => {
    const status = getErrorStatus(error);
    const message = getErrorMessage(error, "");
    if (status !== null) {
      return status === 0 || status === 408 || status >= 500;
    }
    return message.includes("超时") || message.includes("网络") || message.includes("timeout");
  };

  const isStoredCommitItemFresh = (item: StoredCommitItem | null | undefined): item is StoredCommitItem => {
    if (!item) return false;
    const expiresAt = Date.parse(item.commit_token_expires_at);
    return Number.isFinite(expiresAt) && expiresAt - Date.now() > TOKEN_EXPIRY_SAFETY_MS;
  };

  const stripStoredCommitItem = (item: StoredCommitItem): CommitFileItem => ({
    commit_token: item.commit_token,
    store_uri: item.store_uri,
    logical_file_id: item.logical_file_id,
    chunk_index: item.chunk_index,
    chunk_total: item.chunk_total,
  });

  const makeStoredCommitItem = (item: CommitFileItem, commitTokenExpiresAt: string): StoredCommitItem => ({
    ...item,
    commit_token_expires_at: commitTokenExpiresAt,
  });

  const summarizeMediaMetadata = (metadata: MediaMetadata | null) => {
    if (!metadata) return "";
    if (metadata.probe_status !== "ok") return "媒体信息未识别，可继续";
    const videoCodec = metadata.video_tracks?.[0]?.codec || metadata.video_tracks?.[0]?.codec_tag || "视频";
    const audioCodecs = (metadata.audio_tracks || [])
      .map((track) => track.codec || track.codec_tag)
      .filter(Boolean)
      .join(" / ");
    return audioCodecs ? `已识别 ${videoCodec} · ${audioCodecs}` : `已识别 ${videoCodec}`;
  };

  const getMediaMetadataDebugData = (metadata: MediaMetadata | null) => ({
    probeStatus: metadata?.probe_status || null,
    probeError: metadata?.probe_error || null,
    metadataSource: metadata?.probe_source || null,
    moovOffset: metadata?.moov_offset ?? null,
    moovSize: metadata?.moov_size ?? null,
    isFastStart: metadata?.is_faststart ?? null,
    durationSeconds: metadata?.duration_seconds ?? null,
    videoCodecs: (metadata?.video_tracks || []).map((track) => track.codec || track.codec_tag).filter(Boolean),
    audioCodecs: (metadata?.audio_tracks || []).map((track) => track.codec || track.codec_tag).filter(Boolean),
  });

  const chunkSizeAtPart = (fileSize: number, partSize: number, i: number) =>
    Math.min(partSize, fileSize - i * partSize);

  const getCurrentSelectionFileKeys = () => {
    const seen = new Map<string, number>();
    return files.map((entry) => {
      const baseKey = getUploadFileKey(entry.uploadName, entry.file);
      const occurrence = seen.get(baseKey) || 0;
      seen.set(baseKey, occurrence + 1);
      return `${baseKey}#${occurrence}`;
    });
  };

  const createSessionForCurrentSelection = (uploadBatchId: string, fileKeys: string[]): UploadSession => {
    const sessionFiles: UploadSessionFile[] = files.map((entry, index) => {
      return {
        file_key: fileKeys[index],
        upload_name: entry.uploadName,
        file_name: entry.file.name,
        file_size: entry.file.size,
        last_modified: entry.file.lastModified,
        logical_file_id: generateUUID(),
        chunk_total: 1,
        commit_items: new Array(1).fill(null),
      };
    });

    return createUploadSession({
      uploadBatchId,
      fileKeys,
      files: sessionFiles,
      emptyDirs,
    });
  };

  /** 直传单个 part 到 TOS，返回该片 CRC32。 */
  const uploadPart = async (
    entry: FileEntry,
    blob: Blob,
    partIndex: number,
    mpu: MultipartInitResponse,
    onProgress: (loaded: number) => void,
  ): Promise<string> => {
    let lastError = "";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const crc32 = await computeCRC32(blob);
        const partNumber = mpu.part_number_base + partIndex;
        const url = `https://${mpu.tos_host}/${mpu.store_uri}?partNumber=${partNumber}&uploadID=${mpu.upload_id}`;
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          const xhrKey = `${entry.id}_part_${partIndex}`;
          abortRef.current.set(xhrKey, xhr);
          xhr.open("PUT", url);
          xhr.timeout = PART_XHR_TIMEOUT;
          xhr.setRequestHeader("Authorization", mpu.tos_auth);
          xhr.setRequestHeader("Content-CRC32", crc32);
          // gateway 模式：part 上传也必须带此头，否则 merge 时 TOS 找不到分片。
          if (mpu.part_number_base === 1) {
            xhr.setRequestHeader("X-Storage-Mode", "gateway");
          }
          xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
          xhr.onload = () => {
            abortRef.current.delete(xhrKey);
            if (!isSuccessfulHttpStatus(xhr.status)) {
              // CRC 不匹配（TOS 返回 400 MismatchChecksum）当作可重试：重新读 blob 重算 CRC
              if (xhr.status === 400 && xhr.responseText.includes("MismatchChecksum")) {
                reject(new Error("CRC_RETRY:分片校验值不匹配，重试"));
                return;
              }
              reject(new Error(formatXhrStatusError(xhr.status, "分片上传失败"))); return;
            }
            // 成功响应必须是 JSON 且 success===0；并校验服务端回算的 crc32 与本地一致
            try {
              const body = JSON.parse(xhr.responseText);
              if (body.success !== undefined && body.success !== 0) {
                reject(new Error(body.error?.message || "TOS error")); return;
              }
              const serverCrc = body?.payload?.crc32;
              if (serverCrc && String(serverCrc).toLowerCase() !== crc32.toLowerCase()) {
                // 极少见：CDN 缓存旧响应/代理篡改。本地与服务端 CRC 不一致 → 重传该片
                reject(new Error("CRC_RETRY:分片落盘校验值不一致，重试"));
                return;
              }
            } catch {
              // 成功响应应为合法 JSON；解析失败说明响应异常，重试更安全
              reject(new Error("CRC_RETRY:分片响应异常，重试"));
              return;
            }
            resolve();
          };
          xhr.onerror = () => { abortRef.current.delete(xhrKey); reject(new Error("网络错误")); };
          xhr.ontimeout = () => { abortRef.current.delete(xhrKey); reject(new Error("上传超时，正在重试")); };
          xhr.onabort = () => { abortRef.current.delete(xhrKey); reject(new Error("上传已取消")); };
          xhr.send(blob);
        });
        return crc32;
      } catch (err) {
        lastError = getErrorMessage(err, "分片上传失败");
        if (cancelledRef.current) throw new Error("上传已取消");
        // CRC 类错误强制重试（不经过 isRetryableUploadError 的状态码判定）
        const isCrcRetry = lastError.startsWith("CRC_RETRY:");
        if (isCrcRetry) lastError = lastError.slice("CRC_RETRY:".length);
        if (!isCrcRetry && !isRetryableUploadError(err)) throw new Error(lastError);
        if (attempt < MAX_RETRIES) await delay(2000 * 2 ** attempt);
      }
    }
    throw new Error(lastError);
  };

  /** 使用 TTUploader 直传 TOS，降级策略由调用方统一处理。 */
  const uploadWithTTUploaderPrimary = async (
    entry: FileEntry, fileKey: string, session: UploadSession, persistSession: boolean,
  ): Promise<StoredCommitItem> => {
    const fileSize = entry.file.size;
    const sessionFile = session.files.find((f) => f.file_key === fileKey);
    if (!sessionFile) throw new Error("断点续传状态异常，请重新选择文件上传");
    if (!sessionFile.logical_file_id) sessionFile.logical_file_id = generateUUID();

    debugLog?.("upload", "tt:start", { fileName: entry.uploadName, fileSize });

    return new Promise<StoredCommitItem>((resolve, reject) => {
      const cancel = uploadWithTTUploader(entry.file, {
        uploadName: entry.uploadName,
        uploadBatchId: session.upload_batch_id,
        logicalFileId: sessionFile.logical_file_id,
      }, {
        onProgress: (p) => {
          updateFile(entry.id, { progress: p.percent, state: "uploading" });
          recordFileLoaded(entry.id, p.loaded);
        },
        onError: (err) => {
          sdkAbortRef.current.delete(entry.id);
          debugLog?.("upload", "tt:error", { fileName: entry.uploadName, error: err.message });
          reject(err);
        },
        onComplete: (result) => {
          sdkAbortRef.current.delete(entry.id);
          debugLog?.("upload", "tt:complete", { fileName: entry.uploadName, commitToken: result.commitToken.slice(0, 8) });
          updateFile(entry.id, {
            state: "done",
            progress: 100,
            commitToken: result.commitToken,
            storeUri: result.storeUri,
          });
          recordFileLoaded(entry.id, fileSize, true);
          const storedItem = makeStoredCommitItem({
            commit_token: result.commitToken,
            store_uri: result.storeUri,
            logical_file_id: sessionFile.logical_file_id,
            chunk_index: 0,
            chunk_total: 1,
          }, result.commitTokenExpiresAt);
          sessionFile.commit_items[0] = storedItem;
          if (persistSession) {
            markUploadChunkComplete(session.upload_batch_id, fileKey, 0, storedItem)
              .catch((err) => {
                setResumeMessage(`断点续传状态保存失败：${getErrorMessage(err, "无法保存本地上传进度")}`);
              })
              .finally(() => resolve(storedItem));
          } else {
            resolve(storedItem);
          }
        },
        onCancel: () => {
          sdkAbortRef.current.delete(entry.id);
          reject(new Error("上传已取消"));
        },
      }, debugLog);
      sdkAbortRef.current.set(entry.id, cancel);
    });
  };

  /** 小文件上传（旧 XHR 路径）— 仅供 TTUploader 失败时降级使用。 */
  const uploadSingleFileLegacy = async (
    entry: FileEntry, fileKey: string, session: UploadSession, persistSession: boolean,
  ): Promise<StoredCommitItem> => {
    const sessionFile = session.files.find((f) => f.file_key === fileKey);
    if (!sessionFile) throw new Error("断点续传状态异常，请重新选择文件上传");
    if (!sessionFile.logical_file_id) sessionFile.logical_file_id = generateUUID();

    let lastError = "";
    let crc32 = "";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        updateFile(entry.id, { state: "hashing", progress: 0, retries: attempt });
        if (!crc32) {
          crc32 = await computeCRC32(entry.file);
        }
        updateFile(entry.id, { state: "uploading", progress: 0 });
        const uploadName = entry.uploadName;
        const ext = uploadName.includes(".") ? uploadName.split(".").pop() || "" : "";
        const initRes = await uploadInit({
          file_name: uploadName,
          file_size: entry.file.size,
          file_ext: ext,
          content_type: entry.file.type || "",
          chunk_index: 0,
          chunk_total: 1,
          logical_file_id: sessionFile.logical_file_id,
          logical_file_size: entry.file.size,
          upload_batch_id: session.upload_batch_id,
        });
        if (entry.file.size > 0 && initRes.upload_url) {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            abortRef.current.set(entry.id, xhr);
            xhr.open("POST", initRes.upload_url);
            xhr.timeout = SMALL_FILE_XHR_TIMEOUT;
            xhr.setRequestHeader("Authorization", initRes.authorization);
            xhr.setRequestHeader("Content-CRC32", crc32);
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                updateFile(entry.id, { progress: Math.round((e.loaded / e.total) * 100) });
                recordFileLoaded(entry.id, e.loaded);
              }
            };
            xhr.onload = () => {
              abortRef.current.delete(entry.id);
              if (!isSuccessfulHttpStatus(xhr.status)) {
                reject(new Error(formatXhrStatusError(xhr.status, "上传到存储服务失败")));
                return;
              }
              try {
                const body = JSON.parse(xhr.responseText);
                if (body.code && body.code !== 2000) {
                  reject(new Error(body.message || `TOS error: ${body.code}`));
                  return;
                }
              } catch {
                // TOS 成功响应可能没有 JSON body。
              }
              resolve();
            };
            xhr.onerror = () => {
              abortRef.current.delete(entry.id);
              reject(new Error(formatXhrStatusError(0, "网络错误")));
            };
            xhr.ontimeout = () => {
              abortRef.current.delete(entry.id);
              reject(new Error("上传超时，正在重试"));
            };
            xhr.onabort = () => {
              abortRef.current.delete(entry.id);
              reject(new Error("上传已取消"));
            };
            xhr.send(entry.file);
          });
        }
        const storedItem = makeStoredCommitItem({
          commit_token: initRes.commit_token,
          store_uri: initRes.store_uri,
          logical_file_id: sessionFile.logical_file_id,
          chunk_index: 0,
          chunk_total: 1,
        }, initRes.commit_token_expires_at);
        sessionFile.commit_items[0] = storedItem;
        if (persistSession) {
          await markUploadChunkComplete(session.upload_batch_id, fileKey, 0, storedItem).catch((err) => {
            setResumeMessage(`断点续传状态保存失败：${getErrorMessage(err, "无法保存本地上传进度")}`);
          });
        }
        updateFile(entry.id, {
          state: "done",
          progress: 100,
          commitToken: initRes.commit_token,
          storeUri: initRes.store_uri,
        });
        recordFileLoaded(entry.id, entry.file.size, true);
        return storedItem;
      } catch (err) {
        lastError = getErrorMessage(err, "上传失败");
        debugLog?.("upload", "legacy:error", { fileName: entry.uploadName, attempt, error: lastError });
        if (cancelledRef.current) throw new Error("上传已取消");
        if (!isRetryableUploadError(err)) throw new Error(lastError);
        if (attempt < MAX_RETRIES) await delay(2000 * 2 ** attempt);
      }
    }
    throw new Error(lastError);
  };

  /** 大文件 multipart 上传：init → 并发传 part → merge。返回 commit 用的 StoredCommitItem。 */
  const uploadMultipartFile = async (
    entry: FileEntry, fileKey: string, session: UploadSession, persistSession: boolean,
  ): Promise<StoredCommitItem> => {
    const fileSize = entry.file.size;
    const contentType = entry.file.type || "";
    const sessionFile = session.files.find((f) => f.file_key === fileKey);
    if (!sessionFile) throw new Error("断点续传状态异常，请重新选择文件上传");
    if (!sessionFile.logical_file_id) sessionFile.logical_file_id = generateUUID();

    let mpuState = sessionFile.multipart;
    const expired = mpuState && new Date(mpuState.commit_token_expires_at).getTime() < Date.now() + TOKEN_EXPIRY_SAFETY_MS;
    if (!mpuState || expired) {
      const ext = entry.uploadName.includes(".") ? entry.uploadName.split(".").pop() || "" : "";
      const res = await multipartInit({
        file_name: entry.uploadName, file_size: fileSize, file_ext: ext,
        content_type: contentType, logical_file_id: sessionFile.logical_file_id,
        upload_batch_id: session.upload_batch_id,
      });
      mpuState = { ...res, parts: new Array(res.part_count).fill(null), merged: false };
      sessionFile.multipart = mpuState;
      if (persistSession) await markMultipartInit(session.upload_batch_id, fileKey, mpuState);
    }

    const partSize = mpuState.part_size;
    const partCount = mpuState.part_count;
    const partLoaded: number[] = mpuState.parts.map((p, i) => p ? chunkSizeAtPart(fileSize, partSize, i) : 0);
    recordFileLoaded(entry.id, partLoaded.reduce((a, b) => a + b, 0), true);

    const queue = Array.from({ length: partCount }, (_, i) => i).filter((i) => !mpuState!.parts[i]);
    const errors: Array<string | null> = new Array(partCount).fill(null);
    const worker = async () => {
      while (queue.length > 0) {
        const i = queue.shift()!;
        const start = i * partSize;
        const blob = entry.file.slice(start, Math.min(start + partSize, fileSize));
        try {
          const crc = await uploadPart(entry, blob, i, mpuState!, (loaded) => {
            partLoaded[i] = loaded;
            updateFile(entry.id, { progress: Math.round((partLoaded.reduce((a, b) => a + b, 0) / fileSize) * 100) });
            recordFileLoaded(entry.id, partLoaded.reduce((a, b) => a + b, 0));
          });
          mpuState!.parts[i] = { part_index: i, crc32: crc };
          partLoaded[i] = chunkSizeAtPart(fileSize, partSize, i);
          if (persistSession) await markMultipartPartComplete(session.upload_batch_id, fileKey, i, mpuState!.parts[i]!);
        } catch (err) {
          errors[i] = getErrorMessage(err, `分片 ${i + 1}/${partCount} 上传失败`);
          if (cancelledRef.current) throw new Error("上传已取消");
          if (!isRetryableUploadError(err)) { abortActiveUploads(); throw new Error(errors[i]!); }
          await delay(2000);
        }
      }
    };
    const concurrency = Math.min(MULTIPART_PART_CONCURRENCY, queue.length || 1);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (mpuState.parts.some((p) => !p)) throw new Error(errors.find(Boolean) || "部分分片上传失败");

    if (!mpuState.merged) {
      const crcList = mpuState.parts.map((p) => p!.crc32);
      debugLog?.("upload", "multipart:merge:start", {
        fileName: entry.uploadName,
        fileSize,
        partCount,
        crcCount: crcList.length,
        partSize: mpuState.part_size,
        partNumberBase: mpuState.part_number_base,
        uploadId: mpuState.upload_id,
      });
      try {
        const mergeRes = await multipartMerge({ multipart_token: mpuState.multipart_token, crc_list: crcList });
        mpuState.merged = true;
        mpuState.commit_token = mergeRes.commit_token;
        mpuState.commit_token_expires_at = mergeRes.commit_token_expires_at;
        if (persistSession) await markMultipartMerged(session.upload_batch_id, fileKey, mergeRes.commit_token, mergeRes.commit_token_expires_at);
        debugLog?.("upload", "multipart:merge:done", { fileName: entry.uploadName, partCount });
      } catch (err) {
        // merge 失败时记录完整诊断：part 数量、总字节、每片 CRC（便于定位服务端 500）
        debugLog?.("upload", "multipart:merge:error", {
          fileName: entry.uploadName,
          fileSize,
          partCount,
          crcCount: crcList.length,
          crcList: crcList.join(","),
          uploadId: mpuState.upload_id,
          error: getErrorMessage(err, "分片合并失败"),
        });
        throw err;
      }
    }

    updateFile(entry.id, { state: "done", progress: 100 });
    recordFileLoaded(entry.id, fileSize, true);
    const storedItem = makeStoredCommitItem({
      commit_token: mpuState.commit_token,
      store_uri: mpuState.store_uri,
      logical_file_id: sessionFile.logical_file_id,
      chunk_index: 0,
      chunk_total: 1,
    }, mpuState.commit_token_expires_at);
    // 必须写回 session，否则 commit 阶段从 commit_items 收集时找不到
    sessionFile.commit_items[0] = storedItem;
    return storedItem;
  };

  /** Upload a single file (possibly chunked) to TOS with retry/resume. */
  const uploadSingleFile = async (entry: FileEntry, fileKey: string, session: UploadSession, persistSession: boolean): Promise<StoredCommitItem[]> => {
    const fileSize = entry.file.size;
    const isMultipart = fileSize > MULTIPART_THRESHOLD;
    const sessionFile = session.files.find((candidate) => candidate.file_key === fileKey);
    if (!sessionFile) throw new Error("断点续传状态异常，请重新选择文件上传");
    if (!sessionFile.logical_file_id) sessionFile.logical_file_id = generateUUID();
    debugLog?.("upload", "file:start", {
      fileName: entry.uploadName,
      fileSize,
      isMultipart,
      logicalFileId: sessionFile.logical_file_id,
    });

    const existing = sessionFile.commit_items[0];
    if (isStoredCommitItemFresh(existing)) {
      const normalizedExisting = existing.logical_file_id ? existing : {
        ...existing,
        logical_file_id: sessionFile.logical_file_id,
        chunk_index: 0,
        chunk_total: 1,
      };
      sessionFile.commit_items[0] = normalizedExisting;
      updateFile(entry.id, { state: "done", progress: 100, commitToken: normalizedExisting.commit_token, storeUri: normalizedExisting.store_uri });
      recordFileLoaded(entry.id, entry.file.size, true);
      debugLog?.("upload", "file:resume-hit", { fileName: entry.uploadName, chunkIndex: 0, chunkTotal: 1 });
      return [normalizedExisting];
    }

    if (fileSize === 0) {
      const storedItem = await uploadSingleFileLegacy(entry, fileKey, session, persistSession);
      return [storedItem];
    }

    try {
      const storedItem = await uploadWithTTUploaderPrimary(entry, fileKey, session, persistSession);
      return [storedItem];
    } catch (err) {
      if (cancelledRef.current) throw new Error("上传已取消");
      debugLog?.("upload", "tt:fallback", {
        fileName: entry.uploadName,
        fallback: isMultipart ? "multipart" : "xhr",
        error: getErrorMessage(err, "TTUploader 上传失败"),
      });
      const storedItem = isMultipart
        ? await uploadMultipartFile(entry, fileKey, session, persistSession)
        : await uploadSingleFileLegacy(entry, fileKey, session, persistSession);
      return [storedItem];
    }
  };

  /** Start uploading all pending files, then commit. */
  const startUpload = async () => {
    if (files.length === 0 && emptyDirs.length === 0) return;
    const selectedBytes = files.reduce((sum, item) => sum + item.file.size, 0);
    if (files.some((item) => item.file.size > maxFileSize)) {
      setError(`有文件超过当前单文件上限 ${formatSize(maxFileSize)}`);
      return;
    }
    if (selectedBytes > maxShareSize || files.length > maxFileCount || emptyDirs.length > maxEmptyDirCount) {
      setError("当前选择已超过单次分享策略，请移除部分内容");
      return;
    }
    cancelledRef.current = false;
    fileLoadedRef.current.clear();
    uploadStartAtRef.current = performance.now();
    uploadSamplesRef.current = [{ at: uploadStartAtRef.current, bytes: 0 }];
    lastMetricsUpdateRef.current = 0;
    lastDebugMetricsAtRef.current = 0;
    setUploadMetrics({ uploadedBytes: 0, speedBps: 0, elapsedMs: 0 });
    setOverall("uploading");
    setError("");
    setResumeMessage("");
    debugLog?.("upload", "start", {
      files: files.length,
      emptyDirs: emptyDirs.length,
      totalBytes: selectedBytes,
      globalConcurrency: GLOBAL_UPLOAD_CONCURRENCY,
      chunkSize: CHUNK_SIZE,
    });

    const fileKeys = getCurrentSelectionFileKeys();
    let session: UploadSession;
    let persistSession = true;

    try {
      await clearExpiredUploadSessions();
      const existingSession = await findUploadSession(fileKeys, emptyDirs);
      if (existingSession) {
        const completed = existingSession.files.reduce(
          (total, file) => total + file.commit_items.filter(isStoredCommitItemFresh).length,
          0,
        );
        const total = existingSession.files.length;
        debugLog?.("upload", "session:found", { uploadBatchId: existingSession.upload_batch_id, completedFiles: completed, totalFiles: total });
        const resume = window.confirm(`发现未完成的上传进度（已完成 ${completed}/${total} 个文件），是否继续上传？`);
        if (resume) {
          session = existingSession;
          if (completed > 0) setResumeMessage(`已恢复 ${completed}/${total} 个文件`);
          debugLog?.("upload", "session:resume", { uploadBatchId: session.upload_batch_id, completedFiles: completed, totalFiles: total });
        } else {
          await cancelUploadBatch({ upload_batch_id: existingSession.upload_batch_id }).catch(() => {});
          await deleteUploadSession(existingSession.upload_batch_id);
          session = createSessionForCurrentSelection(generateUUID(), fileKeys);
          await saveUploadSession(session);
          debugLog?.("upload", "session:restart", { previousUploadBatchId: existingSession.upload_batch_id, uploadBatchId: session.upload_batch_id });
        }
      } else {
        session = createSessionForCurrentSelection(generateUUID(), fileKeys);
        await saveUploadSession(session);
        debugLog?.("upload", "session:create", { uploadBatchId: session.upload_batch_id });
      }
    } catch (err) {
      session = createSessionForCurrentSelection(generateUUID(), fileKeys);
      persistSession = false;
      setResumeMessage(`断点续传不可用：${getErrorMessage(err, "无法读取本地上传进度")}`);
      debugLog?.("upload", "session:error", { uploadBatchId: session.upload_batch_id, error: getErrorMessage(err, "无法读取本地上传进度") });
    }
    activeUploadBatchIdRef.current = session.upload_batch_id;
    let sessionChanged = false;
    session.files.forEach((file) => {
      if (!file.logical_file_id) {
        file.logical_file_id = generateUUID();
        sessionChanged = true;
      }
    });
    if (sessionChanged && persistSession) await saveUploadSession(session).catch(() => {});

    const mediaMetadataPromises = new Map<string, Promise<MediaMetadata | null>>();
    files.forEach((entry, index) => {
      const fileKey = fileKeys[index];
      if (!shouldProbeMediaMetadata(entry.file, entry.uploadName)) return;
      const probeStartedAt = performance.now();
      debugLog?.("media", "probe:start", { fileName: entry.uploadName, fileSize: entry.file.size, contentType: entry.file.type || "" });
      updateFile(entry.id, { mediaProbeState: "analyzing", mediaProbeMessage: "正在分析媒体信息..." });
      const promise = probeMediaMetadata(entry.file, entry.uploadName)
        .then((metadata) => {
          const summary = summarizeMediaMetadata(metadata);
          const compatWarning = checkCodecCompatibility(metadata);
          if (compatWarning) {
            updateFile(entry.id, {
              mediaProbeState: "warning",
              mediaProbeMessage: compatWarning,
            });
          } else {
            updateFile(entry.id, {
              mediaProbeState: metadata?.probe_status === "ok" ? "ready" : "failed",
              mediaProbeMessage: summary,
            });
          }
          debugLog?.("media", "probe:done", {
            fileName: entry.uploadName,
            probeMs: Math.round(performance.now() - probeStartedAt),
            ...getMediaMetadataDebugData(metadata),
          });
          return metadata;
        })
        .catch((err) => {
          updateFile(entry.id, { mediaProbeState: "failed", mediaProbeMessage: "媒体信息未识别，可继续" });
          debugLog?.("media", "probe:error", { fileName: entry.uploadName, probeMs: Math.round(performance.now() - probeStartedAt), error: getErrorMessage(err, "媒体信息解析失败") });
          return {
            probe_version: 1,
            probe_status: "failed" as const,
            probe_source: "client-upload",
            probe_error: getErrorMessage(err, "媒体信息解析失败"),
            file_size: entry.file.size,
          };
        });
      mediaMetadataPromises.set(fileKey, promise);
    });

    if (cancelledRef.current) {
      if (persistSession) await deleteUploadSession(session.upload_batch_id).catch(() => {});
      activeUploadBatchIdRef.current = null;
      setOverall("error");
      setError("上传已取消");
      return;
    }

    // Upload all files with a global concurrency cap to avoid slow-network timeouts.
    const queue = files.map((entry, index) => ({ entry, fileKey: fileKeys[index] }));
    let hasError = false;
    let uploadError = "";

    const worker = async () => {
      while (queue.length > 0 && !hasError) {
        const { entry, fileKey } = queue.shift()!;
        try {
          await uploadSingleFile(entry, fileKey, session, persistSession);
        } catch (err) {
          hasError = true;
          uploadError = getErrorMessage(err, "部分文件上传失败");
          if (cancelledRef.current) uploadError = "上传已取消";
          if (!isRetryableUploadError(err)) abortActiveUploads();
        }
      }
    };

    const concurrency = Math.min(GLOBAL_UPLOAD_CONCURRENCY, files.length || 1);
    debugLog?.("upload", "workers:start", { concurrency, files: files.length, uploadBatchId: session.upload_batch_id });
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const expectedItems = session.files.reduce((sum, file) => sum + file.chunk_total, 0);
    const finalResults = session.files.flatMap((file) => file.commit_items).filter((item): item is StoredCommitItem => Boolean(item));
    debugLog?.("upload", "workers:done", { hasError, finalItems: finalResults.length, expectedItems, uploadBatchId: session.upload_batch_id });
    if (hasError || finalResults.length !== expectedItems) {
      debugLog?.("upload", "error", { stage: "upload", error: uploadError || "部分文件上传失败", finalItems: finalResults.length, expectedItems });
      setOverall("error");
      setError(uploadError || "部分文件上传失败");
      return;
    }

    const metadataByFileKey = new Map<string, MediaMetadata | null>();
    if (mediaMetadataPromises.size > 0) debugLog?.("media", "probe:wait", { files: mediaMetadataPromises.size });
    for (const [fileKey, promise] of Array.from(mediaMetadataPromises.entries())) {
      metadataByFileKey.set(fileKey, await promise);
    }
    if (mediaMetadataPromises.size > 0) debugLog?.("media", "probe:wait-done", { files: mediaMetadataPromises.size });
    if (cancelledRef.current) {
      if (persistSession) await deleteUploadSession(session.upload_batch_id).catch(() => {});
      activeUploadBatchIdRef.current = null;
      setOverall("error");
      setError("上传已取消");
      return;
    }

    const logicalFiles: CommitLogicalFileItem[] = session.files.map((sessionFile, index) => ({
      logical_file_id: sessionFile.logical_file_id,
      file_name: sessionFile.upload_name,
      file_size: sessionFile.file_size,
      content_type: files[index]?.file.type || "",
      chunk_total: sessionFile.chunk_total,
      media_metadata: metadataByFileKey.get(sessionFile.file_key) || null,
    }));

    // Commit all files as one share
    try {
      updateUploadMetrics(true);
      setOverall("committing");
      let commitRes = null;
      for (let attempt = 0; attempt <= COMMIT_MAX_RETRIES; attempt++) {
        try {
          const commitStartedAt = performance.now();
          debugLog?.("commit", "start", {
            uploadBatchId: session.upload_batch_id,
            attempt,
            chunks: finalResults.length,
            logicalFiles: logicalFiles.length,
            emptyDirs: emptyDirs.length,
          });
          commitRes = await uploadCommit({
            upload_batch_id: session.upload_batch_id,
            files: finalResults.map(stripStoredCommitItem),
            logical_files: logicalFiles,
            empty_dirs: emptyDirs,
            password: password || undefined,
            expires_hours: expiresHours,
            max_downloads: maxDownloads,
            retention_coupon_id: retentionCouponId || undefined,
          });
          debugLog?.("commit", "done", {
            uploadBatchId: session.upload_batch_id,
            attempt,
            commitMs: Math.round(performance.now() - commitStartedAt),
            shareCode: commitRes.share_code,
            fileCount: commitRes.file_count,
          });
          break;
        } catch (err) {
          debugLog?.("commit", "error", { uploadBatchId: session.upload_batch_id, attempt, error: getErrorMessage(err, "提交失败"), retryable: isRetryableUploadError(err) });
          if (attempt >= COMMIT_MAX_RETRIES || !isRetryableUploadError(err)) throw err;
          await delay(2000 * 2 ** attempt);
        }
      }
      if (!commitRes) throw new Error("提交失败");
      if (persistSession) await deleteUploadSession(session.upload_batch_id).catch(() => {});
      activeUploadBatchIdRef.current = null;
      setOverall("done");
      debugLog?.("upload", "done", { uploadBatchId: session.upload_batch_id, shareCode: commitRes.share_code, totalBytes: totalSize, elapsedMs: Math.round(performance.now() - uploadStartAtRef.current) });
      setResultPhase("check");
      setResult({ shareCode: commitRes.share_code, shareUrl: commitRes.share_url, fileCount: commitRes.file_count, revokeToken: commitRes.revoke_token });
      import("qrcode").then((QRCode) => QRCode.toDataURL(commitRes.share_url, { width: 160, margin: 2, color: { dark: "#2a1810" } })).then(setQrUrl).catch(() => {});
      // 游客：存到 localStorage 以便后续展示；有撤销令牌时才允许撤销。
      if (!loggedIn) {
        try {
          const stored = JSON.parse(localStorage.getItem("nyy_guest_shares") || "[]");
          stored.unshift({ code: commitRes.share_code, url: commitRes.share_url, revokeToken: commitRes.revoke_token || "", createdAt: Date.now() });
          localStorage.setItem("nyy_guest_shares", JSON.stringify(stored.slice(0, 10)));
        } catch {}
      }
      if (loggedIn && retentionCouponId) {
        const consumedCouponId = retentionCouponId;
        setRetentionCouponId("");
        setGrowth((current) => current ? {
          ...current,
          retention_coupons: current.retention_coupons.filter((coupon) => coupon.id !== consumedCouponId),
        } : current);
        getGrowthMe().then((nextGrowth) => setGrowth({
          ...nextGrowth,
          retention_coupons: nextGrowth.retention_coupons.filter((coupon) => coupon.id !== consumedCouponId),
        })).catch(() => {});
      }
      getQuota().then((nextQuota) => { setQuota(nextQuota); onQuotaChange?.(nextQuota); }).catch(() => {});
      onUploadDone?.();
    } catch (err) {
      if (cancelledRef.current) {
        setOverall("error");
        setError("上传已取消");
        return;
      }
      setOverall("error");
      debugLog?.("upload", "error", { stage: "commit", error: getErrorMessage(err, "提交失败") });
      setError(getErrorMessage(err, "提交失败"));
    }
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = await extractFilesFromDrop(e.dataTransfer);
    addFiles(dropped.files, dropped.emptyDirs);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []).map((file) => pickFile(file));
    addFiles(selected);
    if (inputRef.current) inputRef.current.value = "";
  };

  const copyLink = () => {
    if (!result) return;
    const text = result.shareUrl;
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
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  const formatDuration = (ms: number) => {
    if (!Number.isFinite(ms) || ms <= 0) return "00:00";
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };

  const formatSpeed = (bytesPerSecond: number) => (
    bytesPerSecond > 0 ? `${formatSize(bytesPerSecond)}/s` : "计算中"
  );

  const isIdle = overall === "idle";
  const totalSize = files.reduce((s, f) => s + f.file.size, 0);
  const displayedUploadedBytes = overall === "committing" || overall === "done"
    ? totalSize
    : Math.min(uploadMetrics.uploadedBytes, totalSize);
  const totalProgress = totalSize > 0 ? Math.min(100, Math.round((displayedUploadedBytes / totalSize) * 100)) : 0;
  const remainingBytes = Math.max(0, totalSize - displayedUploadedBytes);
  const remainingMs = uploadMetrics.speedBps > 0 && remainingBytes > 0 ? (remainingBytes / uploadMetrics.speedBps) * 1000 : 0;
  const totalItemCount = files.length + emptyDirs.length;
  const visibleFiles = showAllFiles ? files : files.slice(0, 5);
  const retentionCoupons = getAvailableRetentionCoupons(growth);
  const visibleEmptyDirs = showAllFiles ? emptyDirs : emptyDirs.slice(0, Math.max(0, 5 - visibleFiles.length));
  const resultShareUrl = result?.shareUrl || "";
  const resultSummary = [
    `${result?.fileCount ?? files.length} 个文件`,
    emptyDirs.length > 0 ? `${emptyDirs.length} 个空文件夹` : "",
    formatSize(totalSize),
  ].filter(Boolean).join(" · ");

  return (
    <div className="w-full">
      <input ref={inputRef} type="file" multiple hidden aria-label="选择文件" onChange={onFileChange} />

      {/* Drop zone / Done state */}
      {overall !== "done" ? (
      <motion.div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "retro-file-dropzone relative p-8",
          dragOver ? cn("bg-nyy-50 dark:bg-nyy-900/20 ring-2 ring-nyy-400/50 dark:ring-nyy-500/40", !shouldReduceMotion && "scale-[1.01]")
            : overall === "error" ? "bg-red-50/60 dark:bg-red-900/10"
            : "hover:bg-gray-50/80 dark:hover:bg-white/[0.02]"
        )}
        whileTap={isIdle && !shouldReduceMotion ? { scale: 0.98 } : undefined}
      >
        <AnimatePresence mode="wait">
          {overall === "error" ? (
            <motion.div key="err" initial={shouldReduceMotion ? false : { scale: 0 }} animate={{ scale: 1 }}>
              <AlertCircle className="w-10 h-10 text-red-400" />
            </motion.div>
          ) : (
            <motion.div key="upload" animate={shouldReduceMotion ? undefined : { y: dragOver ? -4 : 0 }}>
              <Upload className="w-10 h-10 text-nyy-400" />
            </motion.div>
          )}
        </AnimatePresence>

        <p className="type-body-sm retro-text text-center">
          {overall === "idle" && (totalItemCount === 0 ? <><span className="hidden sm:inline">拖拽文件或文件夹到这里，或点击选择</span><span className="sm:hidden">选择要分享的文件</span></> : "可继续添加文件，或点击「开始上传」")}
          {overall === "uploading" && "上传中..."}
          {overall === "committing" && "确认中..."}
          {overall === "error" && "上传失败"}
        </p>

        {overall === "idle" && totalItemCount === 0 && (
          <div className="retro-segmented inline-flex items-center gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
                className="btn-primary"
              >
                选择文件
              </button>
              {supportsDirectoryPicker && (
                <button
                  onClick={handleFolderPick}
                  title="选择文件夹"
                  className="retro-segment-button hidden min-h-[44px] px-4 active:scale-[0.97] sm:inline-flex"
                >
                  选择文件夹
                </button>
              )}
          </div>
        )}

        {overall === "idle" && totalItemCount === 0 && !supportsDirectoryPicker && (
          <p className="type-caption max-w-xs text-center retro-muted">
            当前浏览器无法完整保留空文件夹结构，请使用 Chrome / Edge 桌面端。
          </p>
        )}

        {/* Quota inside drop zone */}
        {quota && overall === "idle" && (
          <p className="type-caption mt-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-center retro-muted">
            可上传 {formatSize(quota.remaining_bytes)}
          </p>
        )}
      </motion.div>
      ) : (
      /* Done state: true one-take — single checkmark, fixed pixel positions, CSS transition */
      <div className="retro-panel relative min-h-[180px] overflow-hidden border-green-400/40"
        style={{ padding: resultPhase === "check" ? 32 : 20 }}
      >
        {/* The ONE checkmark — always absolute, fixed px, CSS transition handles everything */}
        <div
          className="absolute z-10 text-green-500 transition-[top,left,width,height,transform] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]"
          style={resultPhase === "check" ? {
            top: 51,
            left: "50%",
            transform: "translateX(-50%)",
            width: 48,
            height: 48,
          } : {
            top: 21,
            left: 20,
            transform: "translateX(0)",
            width: 18,
            height: 18,
          }}
        >
          <svg width="100%" height="100%" viewBox="0 0 48 48" fill="none">
            <motion.circle
              cx="24" cy="24" r="20"
              stroke="currentColor" strokeWidth="2.5" fill="none"
              strokeDasharray="126"
              initial={{ strokeDashoffset: 126 }}
              animate={{ strokeDashoffset: 0 }}
              transition={{ duration: 0.5, ease: "easeOut" }}
            />
            <motion.path
              d="M15 25 L21 31 L33 19"
              stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" fill="none"
              strokeDasharray="30"
              initial={{ strokeDashoffset: 30 }}
              animate={{ strokeDashoffset: 0 }}
              transition={{ duration: 0.4, delay: 0.4, ease: "easeOut" }}
            />
          </svg>
        </div>

        {/* "上传完成！" text — check phase only, fixed position below checkmark */}
        <AnimatePresence>
          {resultPhase === "check" && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ delay: 0.7 }}
              className="type-body-sm absolute left-0 right-0 text-center retro-text"
              style={{ top: 109 }}
            >
              上传完成！
            </motion.p>
          )}
        </AnimatePresence>

        {/* Card content — fades in after checkmark arrives */}
        <AnimatePresence>
          {resultPhase === "card" && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: 0.4 }}
            >
              <div className="space-y-3">
                <div className="flex flex-col gap-2 pl-7 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="type-body-strong text-green-700 dark:text-green-300">上传完成</p>
                    <p className="type-body-sm mt-0.5 retro-muted">{resultSummary}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {password && (
                      <span className="type-caption inline-flex w-fit items-center gap-1 rounded-full border border-nyy-300/60 bg-nyy-50 px-2 py-1 text-nyy-700 dark:border-nyy-500/30 dark:bg-nyy-500/10 dark:text-nyy-300">
                        <Lock className="w-3 h-3" /> 提取码 {password}
                      </span>
                    )}
                    <button onClick={reset} className="retro-btn-secondary min-h-[44px] px-3 text-xs">继续上传</button>
                  </div>
                </div>

                <div className={cn("grid gap-4 border-t border-white/10 pt-4", qrUrl && "lg:grid-cols-[minmax(0,1fr)_8.5rem] lg:items-start")}>
                  <div className="min-w-0 space-y-3">
                    <div>
                      <p className="type-label retro-text">分享内容</p>
                    </div>
                    {totalItemCount > 0 && (
                      <div className="space-y-1.5">
                        {visibleFiles.map((entry) => (
                          <div key={entry.id} className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3 rounded-control border border-white/10 bg-white/5 px-3 py-2 dark:bg-black/10">
                            <span className="flex min-w-0 items-center gap-2">
                              <FileIcon className="w-4 h-4 text-gray-400 shrink-0" />
                              <span className="type-file-name truncate retro-text">{entry.uploadName}</span>
                            </span>
                            <span className="type-file-meta justify-self-end retro-muted">{formatSize(entry.file.size)}</span>
                          </div>
                        ))}
                        {visibleEmptyDirs.map((dir) => (
                          <div key={dir} className="grid grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3 rounded-control border border-white/10 bg-white/5 px-3 py-2 dark:bg-black/10">
                            <span className="flex min-w-0 items-center gap-2">
                              <Folder className="w-4 h-4 text-gray-400 shrink-0" />
                              <span className="type-file-name truncate retro-text">{dir}</span>
                            </span>
                            <span className="type-file-meta justify-self-end retro-muted">空文件夹</span>
                          </div>
                        ))}
                        {!showAllFiles && totalItemCount > 5 && (
                          <button
                            onClick={() => setShowAllFiles(true)}
                            className="retro-text-button ml-auto min-h-[44px] py-1 pr-1"
                          >
                            显示全部
                          </button>
                        )}
                        {showAllFiles && totalItemCount > 5 && (
                          <button
                            onClick={() => setShowAllFiles(false)}
                            className="retro-text-button ml-auto min-h-[44px] py-1 pr-1"
                          >
                            收起
                          </button>
                        )}
                      </div>
                    )}

                    <div className="grid gap-2 border-t border-white/10 pt-3 sm:grid-cols-[minmax(0,1fr)_8.25rem_5.5rem] sm:items-center">
                      <code className="block truncate select-all rounded-control border border-white/10 bg-white/5 px-3 py-2 font-mono text-sm text-orange-600 dark:bg-black/10 dark:text-orange-300">
                        {resultShareUrl}
                      </code>
                      <CopyLinkButton
                        onCopy={copyLink}
                        className="btn-primary min-h-[44px] w-full px-3"
                        iconClassName="w-4 h-4"
                        copiedDuration={2000}
                      />
                      <a href={resultShareUrl || "#"} target="_blank" rel="noopener noreferrer" className="retro-btn-secondary min-h-[44px] w-full px-3">
                        <ExternalLink className="h-4 w-4" />打开
                      </a>
                    </div>
                  </div>

                  {qrUrl && (
                    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-3 rounded-control border border-white/10 bg-white/5 p-2 dark:bg-black/10 lg:grid-cols-1 lg:justify-items-center lg:self-start">
                      <Image src={qrUrl} alt="分享二维码" width={96} height={96} unoptimized className="h-20 w-20 rounded-lg bg-white p-1 lg:h-24 lg:w-24" />
                      <span className="type-caption retro-muted lg:text-center">扫码访问</span>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      )}

      {(overall === "uploading" || overall === "committing") && totalSize > 0 && (
        <div className="retro-panel mt-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="type-label retro-text">总进度</span>
            <span className="type-body-sm retro-muted">
              {overall === "committing" ? "确认中" : `${totalProgress}%`}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-gradient-to-r from-yc-accent to-yc-accent-3 transition-all" style={{ width: `${totalProgress}%` }} />
          </div>
          <div className="mt-3 grid grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] gap-2 md:grid-cols-[1.45fr_1fr_1fr_1fr_auto]">
            <div className="retro-card px-3 py-2">
              <p className="type-caption retro-muted">已上传</p>
              <p className="type-body-sm whitespace-nowrap retro-text">{formatSize(displayedUploadedBytes)} / {formatSize(totalSize)}</p>
            </div>
            <div className="retro-card px-3 py-2">
              <p className="type-caption retro-muted">实时速度</p>
              <p className="type-body-sm retro-text">{formatSpeed(uploadMetrics.speedBps)}</p>
            </div>
            <div className="retro-card px-3 py-2">
              <p className="type-caption retro-muted">已用时间</p>
              <p className="type-body-sm retro-text">{formatDuration(uploadMetrics.elapsedMs)}</p>
            </div>
            <div className="retro-card px-3 py-2">
              <p className="type-caption retro-muted">预计剩余</p>
              <p className="type-body-sm retro-text">
                {overall === "committing" ? "即将完成" : remainingMs > 0 ? formatDuration(remainingMs) : "计算中"}
              </p>
            </div>
            {overall === "uploading" && (
              <button
                onClick={() => void cancelUpload()}
                className="retro-action-button retro-action-danger col-span-2 min-h-[44px] px-4 type-action md:col-span-1 md:h-full md:self-stretch md:whitespace-nowrap"
              >
                取消上传
              </button>
            )}
          </div>
        </div>
      )}

      {/* File list */}
      {totalItemCount > 0 && overall !== "done" && (
        <div className="mt-4 space-y-2 max-h-[240px] overflow-y-auto">
          {visibleFiles.map((entry) => (
            <div key={entry.id} className="retro-card flex items-center gap-2 p-2">
              <FileIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="type-file-name truncate retro-text">{entry.uploadName}</p>
                <div className="flex items-center gap-2">
                  <span className="type-file-meta text-gray-400">{formatSize(entry.file.size)}</span>
                  {entry.state === "uploading" && (
                    <>
                      <div className="flex-1 h-1 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div className="h-full bg-nyy-500 rounded-full transition-all" style={{ width: `${entry.progress}%` }} />
                      </div>
                      <span className="type-caption text-gray-400 tabular-nums">{entry.progress}%</span>
                    </>
                  )}
                  {entry.state === "hashing" && <span className="type-caption text-nyy-500">校验中...</span>}
                  {entry.mediaProbeState === "analyzing" && <span className="type-caption text-nyy-500">正在分析媒体信息...</span>}
                  {entry.mediaProbeState === "ready" && entry.mediaProbeMessage && <span className="type-caption text-green-600 dark:text-green-400 truncate">{entry.mediaProbeMessage}</span>}
                  {entry.mediaProbeState === "warning" && entry.mediaProbeMessage && <span className="type-caption text-orange-500 dark:text-orange-400 truncate flex items-center gap-0.5"><AlertCircle className="w-3 h-3 shrink-0" />{entry.mediaProbeMessage}</span>}
                  {entry.mediaProbeState === "failed" && entry.mediaProbeMessage && <span className="type-caption text-yellow-600 dark:text-yellow-400 truncate">{entry.mediaProbeMessage}</span>}
                  {entry.state === "done" && <><CheckCircle2 className="w-3 h-3 text-green-500" /><span className="type-caption text-green-600 dark:text-green-400">100%</span></>}
                  {entry.state === "error" && (
                    <span className="type-caption text-red-500 flex items-center gap-0.5">
                      <AlertCircle className="w-3 h-3" /> {entry.error}
                      {entry.retries > 0 && ` (重试${entry.retries}次)`}
                    </span>
                  )}
                </div>
              </div>
              {isIdle && (
                <button onClick={() => removeFile(entry.id)} aria-label={`移除 ${entry.uploadName}`} className="retro-icon-button h-11 w-11 text-gray-400">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {visibleEmptyDirs.map((dir) => (
            <div key={dir} className="retro-card flex items-center gap-2 p-2">
              <Folder className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="type-file-name truncate retro-text">{dir}</p>
                <span className="type-file-meta text-gray-400">空文件夹</span>
              </div>
              {isIdle && (
                <button onClick={() => setEmptyDirs((prev) => prev.filter((item) => item !== dir))} aria-label={`移除 ${dir}`} className="retro-icon-button h-11 w-11 text-gray-400">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
          {!showAllFiles && totalItemCount > 5 && (
            <button
              onClick={() => setShowAllFiles(true)}
              className="retro-text-button min-h-[44px] w-full py-1.5"
            >
              查看全部
            </button>
          )}
          {showAllFiles && totalItemCount > 5 && (
            <button
              onClick={() => setShowAllFiles(false)}
              className="retro-text-button min-h-[44px] w-full py-1.5"
            >
              收起
            </button>
          )}
        </div>
      )}

      {/* Upload button + summary */}
      {isIdle && totalItemCount > 0 && (
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <span className="type-body-sm retro-text">
              <Files className="w-3 h-3 inline mr-1" />
              {files.length} 个文件，{emptyDirs.length} 个空文件夹，共 {formatSize(totalSize)}
            </span>
            {quota && totalSize > quota.remaining_bytes && (
              <p className="type-caption text-red-500 dark:text-red-400">
                超出剩余容量 {formatSize(totalSize - quota.remaining_bytes)}，请移除部分文件
              </p>
            )}
            {files.length > maxFileCount && (
              <p className="type-caption text-red-500 dark:text-red-400">
                文件数量超出上限（最多 {maxFileCount} 个），请移除部分文件
              </p>
            )}
            {emptyDirs.length > maxEmptyDirCount && (
              <p className="type-caption text-red-500 dark:text-red-400">
                空文件夹数量超出上限（最多 {maxEmptyDirCount} 个），请移除部分空文件夹
              </p>
            )}
            {totalSize > maxShareSize && (
              <p className="type-caption text-red-500 dark:text-red-400">
                文件总大小超出单次分享上限 {formatSize(maxShareSize)}
              </p>
            )}
            {folderWarning && <p className="type-caption text-yellow-600 dark:text-yellow-400">{folderWarning}</p>}
            {resumeMessage && <p className="type-caption text-nyy-600 dark:text-nyy-400">{resumeMessage}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => inputRef.current?.click()}
            className="retro-btn-secondary"
          >
            继续添加
          </button>
          <button
            onClick={startUpload}
            disabled={(!!quota && totalSize > quota.remaining_bytes) || totalSize > maxShareSize || files.length > maxFileCount || emptyDirs.length > maxEmptyDirCount}
            className={cn(
              "btn-primary",
              ((!!quota && totalSize > quota.remaining_bytes) || totalSize > maxShareSize || files.length > maxFileCount || emptyDirs.length > maxEmptyDirCount) && "!bg-none !bg-gray-200 dark:!bg-gray-800 !text-gray-500 !shadow-none cursor-not-allowed"
            )}
          >
            开始上传
          </button>
          </div>
        </div>
      )}

      {/* Options */}
      {isIdle && totalItemCount > 0 && (
        <div className="mt-5">
          <div className="space-y-0 pt-1 pb-2">
            {/* 提取码 */}
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="flex items-center gap-2 w-24 shrink-0">
                <Lock className="w-3.5 h-3.5 text-gray-400" />
                <label htmlFor={`${idPrefix}-password`} className="text-sm text-gray-500 dark:text-gray-400">提取码</label>
              </div>
              <input
                id={`${idPrefix}-password`}
                type="text" maxLength={4} pattern="[0-9]*" inputMode="numeric"
                placeholder="留空不设密码"
                value={password}
                onChange={(e) => setPassword(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="retro-input type-body-sm h-11 max-w-[160px] flex-1 px-3"
              />
            </div>
            <div className="mx-4 h-px bg-gray-100 dark:bg-white/[0.08]" />
            {/* 过期时间 */}
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="flex items-center gap-2 w-24 shrink-0">
                <Clock className="w-3.5 h-3.5 text-gray-400" />
                <label className="text-sm text-gray-500 dark:text-gray-400">有效期</label>
              </div>
              <div className="flex flex-wrap gap-2">
                {(quota?.retention_options_hours ?? (loggedIn ? [1, 6, 24, 72, 168, 360, 720] : [1, 6, 24, 72])).map((value) => {
                  const opt = { value, label: value % 24 === 0 ? `${value / 24}天` : `${value}时` };
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        retentionTouchedRef.current = true;
                        setExpiresHours(opt.value);
                      }}
                      className={cn(
                        "relative h-8 rounded-md px-3 text-sm font-medium transition-all",
                        expiresHours === opt.value
                          ? "bg-nyy-500 text-white shadow-sm shadow-nyy-500/25"
                          : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
            {loggedIn && retentionCoupons.length > 0 && (
              <>
                <div className="mx-4 h-px bg-gray-100 dark:bg-white/[0.08]" />
                <div className="flex items-start gap-4 px-4 py-3" data-testid="retention-coupon-setting">
                  <div className="flex w-24 shrink-0 items-center gap-2 pt-3">
                    <FileCheck2 className="h-3.5 w-3.5 text-orange-500" />
                    <label htmlFor={`${idPrefix}-retention-coupon`} className="text-sm text-gray-500 dark:text-gray-400">保留券</label>
                  </div>
                  <div className="min-w-0 flex-1">
                    <select
                      id={`${idPrefix}-retention-coupon`}
                      value={retentionCouponId}
                      onChange={(event) => setRetentionCouponId(event.target.value)}
                      className="retro-input type-body-sm w-full max-w-sm px-3"
                    >
                      <option value="">不使用保留券</option>
                      {retentionCoupons.map((coupon) => (
                        <option key={coupon.id} value={coupon.id}>{coupon.duration_days || 90} 天保留券{coupon.expires_at ? ` · ${new Date(coupon.expires_at).toLocaleDateString("zh-CN")} 前使用` : ""}</option>
                      ))}
                    </select>
                    <p className="mt-1.5 type-caption retro-muted">手动选择后，本次创建分享才会提交对应的保留券。</p>
                  </div>
                </div>
              </>
            )}
            <div className="mx-4 h-px bg-gray-100 dark:bg-white/[0.08]" />
            {/* 下载次数 */}
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="flex items-center gap-2 w-24 shrink-0">
                <Download className="w-3.5 h-3.5 text-gray-400" />
                <label className="text-sm text-gray-500 dark:text-gray-400">下载上限</label>
              </div>
              <div className="flex flex-wrap gap-2">
                {(quota?.download_options ?? (loggedIn ? [1, 10, 50, 100, 200, 0] : [1, 10])).map((value) => {
                  const opt = { value, label: value === 0 ? "不限" : `${value}次` };
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        downloadsTouchedRef.current = true;
                        setMaxDownloads(opt.value);
                      }}
                      className={cn(
                        "relative h-8 rounded-md px-3 text-sm font-medium transition-all",
                        maxDownloads === opt.value
                          ? "bg-nyy-500 text-white shadow-sm shadow-nyy-500/25"
                          : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error */}
      {overall === "error" && (
        <div role="alert" className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-red-200 dark:border-red-800/40 bg-red-50 dark:bg-red-900/20 p-3">
          <span className="type-body-sm text-red-700 dark:text-red-400">{error}</span>
          <button onClick={() => void startUpload()} className="retro-text-button px-2 text-nyy-800 dark:text-nyy-400">
            <RotateCcw className="w-3 h-3" /> 重试
          </button>
        </div>
      )}
    </div>
  );
}
