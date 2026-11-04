import type { ShareFileDownload } from "./api";
import type { DebugLogFn } from "./debug";

export interface DownloadConfig {
  smart_download_enabled: boolean;
  target_video: boolean;
  target_audio: boolean;
  target_pdf: boolean;
  target_image: boolean;
  target_other: boolean;
  filesystem_access_enabled: boolean;
  leave_warning_enabled: boolean;
}

export interface SmartDownloadProgress {
  downloadedBytes: number;
  totalBytes: number;
  currentPart: number;
  totalParts: number;
  method: "filesystem" | "original";
  bytesPerSecond: number;
  elapsedMs: number;
  currentFileIndex?: number;
  totalFiles?: number;
  currentFileName?: string;
}

export type BatchDownloadFileState = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BatchDownloadFileProgress {
  index: number;
  fileName: string;
  savedPath: string;
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  status: BatchDownloadFileState;
  error?: string;
}

export interface BatchDownloadProgress {
  files: BatchDownloadFileProgress[];
  downloadedBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  completedFiles: number;
  failedFiles: number;
  activeFiles: number;
  elapsedMs: number;
}

export interface SmartDownloadOptions {
  config: DownloadConfig;
  onProgress?: (progress: SmartDownloadProgress | null) => void;
  onUnsupported?: (message: string, openOriginal: () => void) => void;
  debugLog?: DebugLogFn;
  signal?: AbortSignal;
}

type WritableFileSink = {
  write: (data: Uint8Array | { type: "write"; position: number; data: Uint8Array }) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
};

export type DownloadDirectoryHandle = {
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<{ createWritable: () => Promise<WritableFileSink> }>;
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<DownloadDirectoryHandle>;
};

export interface DirectoryDownloadOptions {
  config: DownloadConfig;
  emptyDirs?: string[];
  onProgress?: (progress: SmartDownloadProgress | null) => void;
  onBatchProgress?: (progress: BatchDownloadProgress) => void;
  onFileStart?: (file: ShareFileDownload, index: number, total: number) => void;
  concurrency?: number;
  debugLog?: DebugLogFn;
  signal?: AbortSignal;
}

interface SanitizedNameResult {
  value: string;
  reasons: string[];
}

interface SanitizedPathResult {
  directories: string[];
  fileName: string;
  originalPath: string;
  savedPath: string;
  reasons: string[];
}

interface SaveRewriteReport {
  originalPath: string;
  savedPath: string;
  reasons: string[];
}

type ProgressState = {
  downloadedBytes: number;
  totalBytes: number;
  currentPart: number;
  totalParts: number;
  method: SmartDownloadProgress["method"];
  startedAtMs: number;
  lastEmitAtMs: number;
  lastEmitBytes: number;
  bytesPerSecond: number;
  onProgress?: SmartDownloadOptions["onProgress"];
  currentFileIndex?: number;
  totalFiles?: number;
  currentFileName?: string;
};

const PROGRESS_EMIT_INTERVAL_MS = 250;
const FILESYSTEM_RANGE_CHUNK_BYTES = 64 * 1024 * 1024;
const DOWNLOAD_SOURCE_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_DELAYS_MS = [300, 900];
const MAX_SAFE_DIRECTORY_SEGMENT_CHARS = 100;
const MAX_SAFE_FILE_NAME_CHARS = 180;
const MAX_SAFE_RELATIVE_PATH_CHARS = 240;
const SAVE_REPORT_FILE_NAME = "_nyy-save-report.txt";

const DEFAULT_CONFIG: DownloadConfig = {
  smart_download_enabled: true,
  target_video: true,
  target_audio: true,
  target_pdf: true,
  target_image: true,
  target_other: true,
  filesystem_access_enabled: true,
  leave_warning_enabled: true,
};

const EXTENSION_TYPES: Record<string, "video" | "audio" | "pdf" | "image" | "other"> = {
  mp4: "video",
  webm: "video",
  mkv: "video",
  mov: "video",
  m4v: "video",
  avi: "video",
  mp3: "audio",
  m4a: "audio",
  aac: "audio",
  flac: "audio",
  wav: "audio",
  ogg: "audio",
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
};

const RESERVED_PATH_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

export function normalizeDownloadConfig(config?: Partial<DownloadConfig> | null): DownloadConfig {
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

function normalizeOriginalPath(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter((segment) => segment.trim().length > 0).join("/");
}

function shortPathHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(6, "0").slice(0, 8);
}

function splitExtensionForSave(name: string): { base: string; extension: string } {
  const lower = name.toLowerCase();
  for (const extension of [".tar.gz", ".tar.bz2", ".tar.xz", ".user.js"]) {
    if (lower.endsWith(extension) && name.length > extension.length) {
      return { base: name.slice(0, -extension.length), extension: name.slice(-extension.length) };
    }
  }
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return { base: name, extension: "" };
  return { base: name.slice(0, dotIndex), extension: name.slice(dotIndex) };
}

function shortenPreservingExtension(name: string, maxChars: number, hashSource: string): string {
  if (name.length <= maxChars) return name;
  const { base, extension } = splitExtensionForSave(name);
  const hash = shortPathHash(hashSource);
  const suffix = `-${hash}${extension}`;
  const available = Math.max(12, maxChars - suffix.length - 1);
  const headChars = Math.max(6, Math.ceil(available * 0.58));
  const tailChars = Math.max(4, available - headChars);
  return `${base.slice(0, headChars)}…${base.slice(Math.max(0, base.length - tailChars))}${suffix}`.slice(0, maxChars);
}

function sanitizeNamePart(rawName: string, fallback: string, maxChars: number, hashSource: string): SanitizedNameResult {
  const reasons: string[] = [];
  let cleaned = rawName
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();

  if (cleaned !== rawName.trim()) reasons.push("非法字符或空白已规范化");
  if (!cleaned) {
    cleaned = fallback;
    reasons.push("空名称已使用兜底名称");
  }
  if (RESERVED_PATH_NAMES.has(cleaned.toLowerCase())) {
    cleaned = `_${cleaned}`;
    reasons.push("系统保留名称已加前缀");
  }
  const shortened = shortenPreservingExtension(cleaned, maxChars, hashSource);
  if (shortened !== cleaned) reasons.push("名称过长已保留扩展名并追加短标识");
  return { value: shortened, reasons };
}

function uniqueReasons(reasons: string[]): string[] {
  return Array.from(new Set(reasons));
}

export function sanitizeFileName(name: string): string {
  return sanitizeNamePart(name, "download", MAX_SAFE_FILE_NAME_CHARS, name).value;
}

function fitPathLength(directories: string[], fileName: string, originalPath: string): { directories: string[]; fileName: string; reason: string | null } {
  const savedPath = [...directories, fileName].join("/");
  if (savedPath.length <= MAX_SAFE_RELATIVE_PATH_CHARS) return { directories, fileName, reason: null };

  const hash = shortPathHash(originalPath);
  const compactedDirectories = directories.length > 2
    ? [
        shortenPreservingExtension(directories[0], 48, `${originalPath}:first`),
        `_nyy_path_${hash}`,
        shortenPreservingExtension(directories[directories.length - 1], 48, `${originalPath}:last`),
      ]
    : directories.map((directory, index) => shortenPreservingExtension(directory, 48, `${originalPath}:dir:${index}`));
  const prefixLength = compactedDirectories.length > 0 ? compactedDirectories.join("/").length + 1 : 0;
  const fileMaxChars = Math.max(48, MAX_SAFE_RELATIVE_PATH_CHARS - prefixLength);
  return {
    directories: compactedDirectories,
    fileName: shortenPreservingExtension(fileName, fileMaxChars, `${originalPath}:file`),
    reason: "完整路径过长已压缩中间目录",
  };
}

function sanitizeFilePath(fileName: string): SanitizedPathResult {
  const rawSegments = fileName.split(/[\\/]+/).filter((segment) => segment.trim().length > 0);
  const originalPath = normalizeOriginalPath(fileName) || fileName;
  if (rawSegments.length === 0) return { directories: [], fileName: "download", originalPath, savedPath: "download", reasons: ["空路径已使用兜底名称"] };

  const reasons: string[] = [];
  const directories = rawSegments.slice(0, -1).map((segment, index) => {
    const result = sanitizeNamePart(segment, "文件夹", MAX_SAFE_DIRECTORY_SEGMENT_CHARS, `${originalPath}:dir:${index}`);
    reasons.push(...result.reasons);
    return result.value;
  });
  const fileResult = sanitizeNamePart(rawSegments[rawSegments.length - 1], "download", MAX_SAFE_FILE_NAME_CHARS, `${originalPath}:file`);
  reasons.push(...fileResult.reasons);

  const fitted = fitPathLength(directories, fileResult.value, originalPath);
  if (fitted.reason) reasons.push(fitted.reason);
  const savedPath = [...fitted.directories, fitted.fileName].join("/");
  if (savedPath !== originalPath && reasons.length === 0) reasons.push("路径已规范化");

  return {
    directories: fitted.directories,
    fileName: fitted.fileName,
    originalPath,
    savedPath,
    reasons: uniqueReasons(reasons),
  };
}

function sanitizeDirectoryPath(path: string): SanitizedPathResult {
  const rawSegments = path.split(/[\\/]+/).filter((segment) => segment.trim().length > 0);
  const originalPath = normalizeOriginalPath(path);
  const reasons: string[] = [];
  const directories = rawSegments.map((segment, index) => {
    const result = sanitizeNamePart(segment, "文件夹", MAX_SAFE_DIRECTORY_SEGMENT_CHARS, `${originalPath}:dir:${index}`);
    reasons.push(...result.reasons);
    return result.value;
  });
  const fitted = fitPathLength(directories, "", originalPath);
  const savedDirectories = fitted.fileName ? [...fitted.directories, fitted.fileName] : fitted.directories;
  const savedPath = savedDirectories.join("/");
  if (fitted.reason) reasons.push(fitted.reason);
  if (savedPath !== originalPath && reasons.length === 0) reasons.push("路径已规范化");
  return { directories: savedDirectories, fileName: "", originalPath, savedPath, reasons: uniqueReasons(reasons) };
}

function fileExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index >= 0 ? fileName.slice(index + 1).toLowerCase() : "";
}

function classifyDownloadFile(file: Pick<ShareFileDownload, "file_name" | "content_type">): "video" | "audio" | "pdf" | "image" | "other" {
  const contentType = (file.content_type || "").toLowerCase();
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType === "application/pdf") return "pdf";
  if (contentType.startsWith("image/")) return "image";
  return EXTENSION_TYPES[fileExtension(file.file_name)] || "other";
}

export function isSmartDownloadTarget(file: ShareFileDownload, config: DownloadConfig): boolean {
  if (!config.smart_download_enabled) return false;
  const type = classifyDownloadFile(file);
  if (type === "video") return config.target_video;
  if (type === "audio") return config.target_audio;
  if (type === "pdf") return config.target_pdf;
  if (type === "image") return config.target_image;
  return config.target_other;
}

export function supportsFileSystemAccessDownload(): boolean {
  return typeof window !== "undefined" && "showSaveFilePicker" in window && typeof ReadableStream !== "undefined";
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window && typeof ReadableStream !== "undefined";
}

export function openOriginalDownload(file: ShareFileDownload): void {
  if (file.is_chunked && file.chunks.length > 0) throw new Error("分片文件不能直接打开原始链接");
  const url = file.download_url;
  if (!url) throw new Error("下载链接无效");
  const link = document.createElement("a");
  link.href = url;
  link.download = sanitizeFileName(file.file_name);
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function filePickerAccept(fileName: string, contentType: string): Record<string, string[]> | undefined {
  const ext = fileExtension(fileName);
  if (!ext || !contentType) return undefined;
  return { [contentType]: [`.${ext}`] };
}

async function createFileSystemWritable(fileName: string, contentType: string): Promise<WritableFileSink> {
  const showSaveFilePicker = (window as unknown as {
    showSaveFilePicker: (options?: unknown) => Promise<{ createWritable: () => Promise<WritableFileSink> }>;
  }).showSaveFilePicker;
  const accept = filePickerAccept(fileName, contentType);
  const fileHandle = await showSaveFilePicker({
    suggestedName: fileName,
    types: accept ? [{ description: fileName, accept }] : undefined,
  });
  return fileHandle.createWritable();
}

export async function pickDownloadDirectory(): Promise<DownloadDirectoryHandle> {
  if (!supportsDirectoryPicker()) throw new Error("当前浏览器不支持批量保存到文件夹，请逐个下载文件。");
  const showDirectoryPicker = (window as unknown as {
    showDirectoryPicker: (options?: unknown) => Promise<DownloadDirectoryHandle>;
  }).showDirectoryPicker;
  return showDirectoryPicker({ mode: "readwrite" });
}

async function ensureDirectory(root: DownloadDirectoryHandle, path: string[]): Promise<DownloadDirectoryHandle> {
  let current = root;
  for (const segment of path) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function fileExists(directory: DownloadDirectoryHandle, fileName: string): Promise<boolean> {
  try {
    await directory.getFileHandle(fileName, { create: false });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    return true;
  }
}

function withFileNameSuffix(fileName: string, suffix: number): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return `${fileName} (${suffix})`;
  return `${fileName.slice(0, dotIndex)} (${suffix})${fileName.slice(dotIndex)}`;
}

async function createUniqueFileWritable(
  directory: DownloadDirectoryHandle,
  desiredName: string,
  usedNames: Set<string>,
): Promise<{ fileName: string; writable: WritableFileSink }> {
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const fileName = suffix === 0 ? desiredName : withFileNameSuffix(desiredName, suffix);
    const key = fileName.toLowerCase();
    if (usedNames.has(key) || await fileExists(directory, fileName)) continue;
    usedNames.add(key);
    const fileHandle = await directory.getFileHandle(fileName, { create: true });
    return { fileName, writable: await fileHandle.createWritable() };
  }
  throw new Error(`无法为 ${desiredName} 生成可用文件名`);
}

function buildSaveReport(entries: SaveRewriteReport[]): string {
  const lines = [
    "拿呀² 本地保存命名说明",
    "",
    "以下文件或文件夹在保存时因系统限制被安全重命名。分享页面中的原始名称未改变。",
    "",
  ];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.originalPath}`);
    lines.push(`   -> ${entry.savedPath}`);
    lines.push(`   原因：${entry.reasons.join("、")}`);
    lines.push("");
  });
  return lines.join("\n");
}

async function writeSaveReport(directory: DownloadDirectoryHandle, entries: SaveRewriteReport[], usedNames: Set<string>): Promise<void> {
  const { writable } = await createUniqueFileWritable(directory, SAVE_REPORT_FILE_NAME, usedNames);
  try {
    await writable.write(new TextEncoder().encode(buildSaveReport(entries)));
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException("下载已取消", "AbortError");
}

function createProgressState(
  totalBytes: number,
  totalParts: number,
  method: SmartDownloadProgress["method"],
  onProgress?: SmartDownloadOptions["onProgress"],
): ProgressState {
  const startedAtMs = nowMs();
  return {
    downloadedBytes: 0,
    totalBytes,
    currentPart: 0,
    totalParts,
    method,
    startedAtMs,
    lastEmitAtMs: startedAtMs,
    lastEmitBytes: 0,
    bytesPerSecond: 0,
    onProgress,
  };
}

function emitProgress(progress: ProgressState, force = false): void {
  if (!progress.onProgress) return;
  const timestamp = nowMs();
  const elapsedSinceEmit = timestamp - progress.lastEmitAtMs;
  const isComplete = progress.downloadedBytes >= progress.totalBytes;
  if (!force && !isComplete && elapsedSinceEmit < PROGRESS_EMIT_INTERVAL_MS) return;

  if (elapsedSinceEmit > 0) {
    const bytesDelta = Math.max(0, progress.downloadedBytes - progress.lastEmitBytes);
    const instantSpeed = (bytesDelta * 1000) / elapsedSinceEmit;
    progress.bytesPerSecond = progress.bytesPerSecond > 0
      ? (progress.bytesPerSecond * 0.7) + (instantSpeed * 0.3)
      : instantSpeed;
  }
  progress.lastEmitAtMs = timestamp;
  progress.lastEmitBytes = progress.downloadedBytes;
  progress.onProgress({
    downloadedBytes: progress.downloadedBytes,
    totalBytes: progress.totalBytes,
    currentPart: progress.currentPart,
    totalParts: progress.totalParts,
    method: progress.method,
    bytesPerSecond: progress.bytesPerSecond,
    elapsedMs: timestamp - progress.startedAtMs,
    currentFileIndex: progress.currentFileIndex,
    totalFiles: progress.totalFiles,
    currentFileName: progress.currentFileName,
  });
}

function downloadParts(file: ShareFileDownload): { url: string; backupUrl: string; size: number; index: number }[] {
  if (file.is_chunked && file.chunks.length > 0) {
    return [...file.chunks].sort((left, right) => left.index - right.index).map((chunk) => ({
      url: chunk.download_url,
      backupUrl: chunk.backup_download_url || "",
      size: chunk.size,
      index: chunk.index,
    }));
  }
  return [{ url: file.download_url, backupUrl: file.backup_download_url || "", size: file.file_size, index: 0 }];
}

async function fetchPartRange(
  part: ReturnType<typeof downloadParts>[number],
  rangeStart: number,
  rangeEnd: number,
  signal?: AbortSignal,
): Promise<Response> {
  const urls = [part.url, part.backupUrl].filter((url, index, values) => Boolean(url) && values.indexOf(url) === index);
  let lastError = "下载链接无效";
  for (const url of urls) {
    for (let attempt = 1; attempt <= DOWNLOAD_SOURCE_MAX_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: { Range: `bytes=${rangeStart}-${rangeEnd}` },
          signal,
        });
        if (response.status === 200 && part.size > FILESYSTEM_RANGE_CHUNK_BYTES) {
          await response.body?.cancel().catch(() => undefined);
          lastError = "下载源未按 Range 返回分段数据";
          break;
        }
        if (!response.ok && response.status !== 206) {
          await response.body?.cancel().catch(() => undefined);
          lastError = `下载失败：HTTP ${response.status}`;
          if (!isRetryableDownloadStatus(response.status)) break;
        } else {
          return response;
        }
      } catch (error) {
        throwIfAborted(signal);
        lastError = error instanceof Error ? error.message : "下载请求失败";
      }
      if (attempt < DOWNLOAD_SOURCE_MAX_ATTEMPTS) {
        await waitForDownloadRetry(DOWNLOAD_RETRY_DELAYS_MS[attempt - 1] ?? DOWNLOAD_RETRY_DELAYS_MS[DOWNLOAD_RETRY_DELAYS_MS.length - 1], signal);
      }
    }
  }
  throw new Error(lastError);
}

function isRetryableDownloadStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function waitForDownloadRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("下载已取消", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("下载已取消", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function writeRangeResponseToFile(
  response: Response,
  writable: WritableFileSink,
  writeStart: number,
  progress: ProgressState,
  signal?: AbortSignal,
): Promise<number> {
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("当前浏览器无法读取下载流");
  let written = 0;
  while (true) {
    throwIfAborted(signal);
    const { done, value } = await reader.read();
    if (done) break;
    throwIfAborted(signal);
    await writable.write({ type: "write", position: writeStart + written, data: value });
    written += value.byteLength;
    progress.downloadedBytes += value.byteLength;
    emitProgress(progress);
  }
  return written;
}

async function writeFilePartsToWritable(
  file: ShareFileDownload,
  writable: WritableFileSink,
  progress: ProgressState,
  options: Pick<SmartDownloadOptions, "debugLog" | "signal"> & { setCurrentPart?: (partIndex: number) => void },
): Promise<void> {
  const parts = downloadParts(file);
  let fileOffset = 0;
  throwIfAborted(options.signal);
  if (file.file_size === 0) return;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part.url) throw new Error("下载链接无效");
    options.setCurrentPart?.(index);
    options.debugLog?.("download", "filesystem:part:start", { index, size: part.size });
    for (let partOffset = 0; partOffset < part.size; partOffset += FILESYSTEM_RANGE_CHUNK_BYTES) {
      throwIfAborted(options.signal);
      const rangeEnd = Math.min(part.size - 1, partOffset + FILESYSTEM_RANGE_CHUNK_BYTES - 1);
      const response = await fetchPartRange(part, partOffset, rangeEnd, options.signal);
      const expectedBytes = rangeEnd - partOffset + 1;
      const written = await writeRangeResponseToFile(response, writable, fileOffset + partOffset, progress, options.signal);
      if (written !== expectedBytes && response.status === 206) {
        throw new Error("下载分段大小不完整，请重试");
      }
    }
    fileOffset += part.size;
    emitProgress(progress, true);
    options.debugLog?.("download", "filesystem:part:done", { index, downloadedBytes: progress.downloadedBytes });
  }
}

export async function downloadFileToWritable(
  file: ShareFileDownload,
  writable: WritableFileSink,
  options: SmartDownloadOptions & { progress?: ProgressState; setCurrentPart?: (partIndex: number) => void },
): Promise<void> {
  const progress = options.progress || createProgressState(file.file_size, downloadParts(file).length, "filesystem", options.onProgress);
  emitProgress(progress, true);
  try {
    await writeFilePartsToWritable(file, writable, progress, options);
    await writable.close();
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

async function downloadWithFileSystem(file: ShareFileDownload, options: SmartDownloadOptions): Promise<void> {
  const fileName = sanitizeFileName(file.file_name);
  const writable = await createFileSystemWritable(fileName, file.content_type || "application/octet-stream");
  const progress = createProgressState(file.file_size, downloadParts(file).length, "filesystem", options.onProgress);
  await downloadFileToWritable(file, writable, {
    ...options,
    progress,
    setCurrentPart: (partIndex) => { progress.currentPart = partIndex; },
  });
}

export async function downloadFilesToDirectoryHandle(
  directory: DownloadDirectoryHandle,
  files: ShareFileDownload[],
  options: DirectoryDownloadOptions,
): Promise<void> {
  const config = normalizeDownloadConfig(options.config);
  if (!config.smart_download_enabled || !config.filesystem_access_enabled) throw new Error("批量保存到文件夹已被管理员关闭，请逐个下载文件。");

  const emptyDirs = options.emptyDirs || [];
  const rewriteReports: SaveRewriteReport[] = [];
  for (const dir of emptyDirs) {
    throwIfAborted(options.signal);
    const directoryPath = sanitizeDirectoryPath(dir);
    await ensureDirectory(directory, directoryPath.directories);
    if (directoryPath.reasons.length > 0 && directoryPath.savedPath !== directoryPath.originalPath) {
      rewriteReports.push({ originalPath: `${directoryPath.originalPath}/`, savedPath: `${directoryPath.savedPath}/`, reasons: directoryPath.reasons });
    }
  }
  if (files.length === 0) {
    if (rewriteReports.length > 0) {
      try {
        await writeSaveReport(directory, rewriteReports, new Set<string>());
      } catch (error) {
        options.debugLog?.("download", "filesystem:save-report:failed", { message: error instanceof Error ? error.message : String(error) });
      }
    }
    options.onProgress?.(null);
    return;
  }

  const totalBytes = files.reduce((total, file) => total + file.file_size, 0);
  const batchStartedAt = nowMs();
  const fileProgress: BatchDownloadFileProgress[] = files.map((file, index) => ({
    index,
    fileName: file.file_name,
    savedPath: sanitizeFilePath(file.file_name).savedPath,
    downloadedBytes: 0,
    totalBytes: file.file_size,
    bytesPerSecond: 0,
    status: "pending",
  }));
  const usedNamesByDirectory = new Map<string, Set<string>>();
  let latestFileIndex = 0;

  const batchSnapshot = (): BatchDownloadProgress => ({
    files: fileProgress.map((item) => ({ ...item })),
    downloadedBytes: fileProgress.reduce((total, item) => total + item.downloadedBytes, 0),
    totalBytes,
    bytesPerSecond: fileProgress.reduce((total, item) => total + item.bytesPerSecond, 0),
    completedFiles: fileProgress.filter((item) => item.status === "completed").length,
    failedFiles: fileProgress.filter((item) => item.status === "failed").length,
    activeFiles: fileProgress.filter((item) => item.status === "running").length,
    elapsedMs: nowMs() - batchStartedAt,
  });
  const emitBatchProgress = () => {
    const snapshot = batchSnapshot();
    options.onBatchProgress?.(snapshot);
    const active = snapshot.files[latestFileIndex] || snapshot.files.find((item) => item.status === "running") || snapshot.files[0];
    options.onProgress?.({
      downloadedBytes: snapshot.downloadedBytes,
      totalBytes: snapshot.totalBytes,
      currentPart: snapshot.completedFiles + snapshot.failedFiles,
      totalParts: files.length,
      method: "filesystem",
      bytesPerSecond: snapshot.bytesPerSecond,
      elapsedMs: snapshot.elapsedMs,
      currentFileIndex: active ? active.index + 1 : 1,
      totalFiles: files.length,
      currentFileName: active?.savedPath || active?.fileName,
    });
  };

  let allocationTail = Promise.resolve();
  const allocateWritable = async (file: ShareFileDownload) => {
    let releaseAllocation = () => {};
    const previousAllocation = allocationTail;
    allocationTail = new Promise<void>((resolve) => { releaseAllocation = resolve; });
    await previousAllocation;
    try {
      throwIfAborted(options.signal);
      const filePath = sanitizeFilePath(file.file_name);
      const parentDirectory = await ensureDirectory(directory, filePath.directories);
      const directoryKey = filePath.directories.join("/");
      let usedNames = usedNamesByDirectory.get(directoryKey);
      if (!usedNames) {
        usedNames = new Set<string>();
        usedNamesByDirectory.set(directoryKey, usedNames);
      }
      const { fileName, writable } = await createUniqueFileWritable(parentDirectory, filePath.fileName, usedNames);
      const savedPath = [...filePath.directories, fileName].join("/") || fileName;
      const rewriteReasons = [...filePath.reasons];
      if (fileName !== filePath.fileName) rewriteReasons.push("同目录重名已追加序号");
      if (rewriteReasons.length > 0 && savedPath !== filePath.originalPath) {
        rewriteReports.push({ originalPath: filePath.originalPath, savedPath, reasons: uniqueReasons(rewriteReasons) });
      }
      return { writable, savedPath };
    } finally {
      releaseAllocation();
    }
  };

  let nextFileIndex = 0;
  const worker = async () => {
    while (nextFileIndex < files.length) {
      const index = nextFileIndex;
      nextFileIndex += 1;
      const file = files[index];
      const item = fileProgress[index];
      if (options.signal?.aborted) {
        item.status = "cancelled";
        emitBatchProgress();
        continue;
      }
      item.status = "running";
      latestFileIndex = index;
      emitBatchProgress();
      try {
        const { writable, savedPath } = await allocateWritable(file);
        item.savedPath = savedPath;
        options.onFileStart?.(file, index, files.length);
        options.debugLog?.("download", "filesystem:file:start", { index, fileName: savedPath, size: file.file_size });
        const progress = createProgressState(file.file_size, downloadParts(file).length, "filesystem", (current) => {
          if (!current) return;
          item.downloadedBytes = current.downloadedBytes;
          item.bytesPerSecond = current.bytesPerSecond;
          latestFileIndex = index;
          emitBatchProgress();
        });
        progress.currentFileIndex = index + 1;
        progress.totalFiles = files.length;
        progress.currentFileName = savedPath;
        await downloadFileToWritable(file, writable, {
          ...options,
          config,
          progress,
          setCurrentPart: (partIndex) => { progress.currentPart = partIndex; },
        });
        item.downloadedBytes = item.totalBytes;
        item.bytesPerSecond = 0;
        item.status = "completed";
        options.debugLog?.("download", "filesystem:file:done", { index, downloadedBytes: item.downloadedBytes });
      } catch (error) {
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        item.status = cancelled ? "cancelled" : "failed";
        item.bytesPerSecond = 0;
        item.error = cancelled ? "下载已取消" : error instanceof Error ? error.message : "下载失败";
        options.debugLog?.("download", "filesystem:file:error", { index, error: item.error });
      }
      emitBatchProgress();
    }
  };

  emitBatchProgress();
  const concurrency = Math.min(files.length, Math.max(1, Math.floor(options.concurrency ?? 3)));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  if (options.signal?.aborted) {
    options.onProgress?.(null);
    throw new DOMException("下载已取消", "AbortError");
  }

  if (rewriteReports.length > 0) {
    const rootUsedNames = usedNamesByDirectory.get("") || new Set<string>();
    usedNamesByDirectory.set("", rootUsedNames);
    try {
      await writeSaveReport(directory, rewriteReports, rootUsedNames);
    } catch (error) {
      options.debugLog?.("download", "filesystem:save-report:failed", { message: error instanceof Error ? error.message : String(error) });
    }
  }

  emitBatchProgress();
  options.onProgress?.(null);
  const failedFiles = fileProgress.filter((item) => item.status === "failed");
  if (failedFiles.length > 0) {
    throw new Error(`${failedFiles.length} 个文件保存失败，其余文件已继续处理`);
  }
}

export async function downloadFilesToDirectory(files: ShareFileDownload[], options: DirectoryDownloadOptions): Promise<void> {
  const config = normalizeDownloadConfig(options.config);
  if (!config.smart_download_enabled || !config.filesystem_access_enabled || !supportsDirectoryPicker()) {
    throw new Error("当前浏览器不支持批量保存到文件夹，请逐个下载文件。");
  }
  const directory = await pickDownloadDirectory();
  await downloadFilesToDirectoryHandle(directory, files, { ...options, config });
}

export async function downloadSmart(file: ShareFileDownload, options: SmartDownloadOptions): Promise<void> {
  const config = normalizeDownloadConfig(options.config);
  try {
    const needsStreamSave = isSmartDownloadTarget(file, config) || (file.is_chunked && file.chunks.length > 0);
    if (needsStreamSave) {
      if (config.filesystem_access_enabled && supportsFileSystemAccessDownload()) {
        await downloadWithFileSystem(file, { ...options, config });
        return;
      }
      if (file.is_chunked && file.chunks.length > 0) {
        throw new Error("当前浏览器不支持本地分段写盘，分片文件不能安全回退到原始直链；请使用 Chrome/Edge/鸿蒙浏览器下载。");
      }
      options.onUnsupported?.("当前浏览器不支持本地分段写盘，已改用原始直链。", () => openOriginalDownload(file));
      openOriginalDownload(file);
      return;
    }
    openOriginalDownload(file);
  } finally {
    options.onProgress?.(null);
  }
}

export function defaultDownloadConfig(): DownloadConfig {
  return { ...DEFAULT_CONFIG };
}
