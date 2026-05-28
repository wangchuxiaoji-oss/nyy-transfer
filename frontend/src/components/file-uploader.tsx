"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import {
  Upload, CheckCircle2, AlertCircle, FileIcon, Copy, Lock, Clock,
  X, RotateCcw, Files, Download, Folder,
} from "lucide-react";
import QRCode from "qrcode";
import { cn } from "@/lib/utils";
import { computeCRC32 } from "@/lib/crc32";
import { uploadInit, uploadCommit, getQuota, type QuotaInfo, type CommitFileItem } from "@/lib/api";
import { formatXhrStatusError, getErrorMessage, isSuccessfulHttpStatus } from "@/lib/errors";

const MAX_RETRIES = 3;
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB
const MAX_FILE_COUNT = 500;
const MAX_EMPTY_DIR_COUNT = 500;

const getFileUploadName = (file: File) =>
  (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;

type PickedFile = { file: File; uploadName: string };
type PickedSelection = { files: PickedFile[]; emptyDirs: string[] };

type FileState = "pending" | "hashing" | "uploading" | "done" | "error";

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
}

type OverallState = "idle" | "uploading" | "committing" | "done" | "error";

interface UploadResult {
  shareCode: string;
  shareUrl: string;
  fileCount: number;
  revokeToken?: string | null;
}

export function FileUploader({ onUploadDone, loggedIn = false, onLoginClick }: { onUploadDone?: () => void; loggedIn?: boolean; onLoginClick?: () => void } = {}) {
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
  const [copied, setCopied] = useState(false);
  const [qrUrl, setQrUrl] = useState<string>("");
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [password, setPassword] = useState("");
  const [expiresHours, setExpiresHours] = useState(loggedIn ? 168 : 1);
  const [maxDownloads, setMaxDownloads] = useState(loggedIn ? 0 : 10);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [supportsDirectoryPicker, setSupportsDirectoryPicker] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<Map<string, XMLHttpRequest>>(new Map());

  useEffect(() => {
    getQuota().then(setQuota).catch(() => {});
    setSupportsDirectoryPicker(typeof window !== "undefined" && "showDirectoryPicker" in window);
  }, []);

  // Transition from checkmark animation to result card
  useEffect(() => {
    if (overall === "done" && resultPhase === "check") {
      const timer = setTimeout(() => setResultPhase("card"), 1500);
      return () => clearTimeout(timer);
    }
  }, [overall, resultPhase]);

  const reset = () => {
    abortRef.current.forEach((xhr) => xhr.abort());
    abortRef.current.clear();
    setOverall("idle");
    setFiles([]);
    setEmptyDirs([]);
    setError("");
    setFolderWarning("");
    setResult(null);
    setResultPhase("check");
    setCopied(false);
    setQrUrl("");
    setShowAllFiles(false);
    getQuota().then(setQuota).catch(() => {});
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
    // 保留 0 字节文件，仅过滤超大文件
    const valid = newFiles.filter(({ file }) => file.size <= MAX_FILE_SIZE);
    if (valid.length < newFiles.length) {
      setError(`${newFiles.length - valid.length} 个文件超过 1 GB 已跳过`);
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

  /** Upload a single file to TOS with retry. */
  const uploadSingleFile = async (entry: FileEntry): Promise<CommitFileItem> => {
    let lastError = "";
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        updateFile(entry.id, { state: "hashing", progress: 0, retries: attempt });
        const crc32 = await computeCRC32(entry.file);

        updateFile(entry.id, { state: "uploading", progress: 0 });
        const uploadName = entry.uploadName;
        const ext = uploadName.includes(".") ? uploadName.split(".").pop() || "" : "";
        const initRes = await uploadInit({
          file_name: uploadName,
          file_size: entry.file.size,
          file_ext: ext,
        });

        if (entry.file.size > 0 && initRes.upload_url) {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            abortRef.current.set(entry.id, xhr);
            xhr.open("POST", initRes.upload_url);
            xhr.setRequestHeader("Authorization", initRes.authorization);
            xhr.setRequestHeader("Content-CRC32", crc32);
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                updateFile(entry.id, { progress: Math.round((e.loaded / e.total) * 100) });
              }
            };
            xhr.onload = () => {
              abortRef.current.delete(entry.id);
              if (isSuccessfulHttpStatus(xhr.status)) resolve();
              else reject(new Error(formatXhrStatusError(xhr.status, "上传到存储服务失败")));
            };
            xhr.onerror = () => {
              abortRef.current.delete(entry.id);
              reject(new Error(formatXhrStatusError(0, "网络错误")));
            };
            xhr.send(entry.file);
          });
        }

        updateFile(entry.id, { state: "done", progress: 100, commitToken: initRes.commit_token, storeUri: initRes.store_uri });
        return { commit_token: initRes.commit_token, store_uri: initRes.store_uri };
      } catch (err) {
        lastError = getErrorMessage(err, "上传失败");
        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    updateFile(entry.id, { state: "error", error: lastError });
    throw new Error(lastError);
  };

  /** Start uploading all pending files, then commit. */
  const startUpload = async () => {
    if (files.length === 0 && emptyDirs.length === 0) return;
    setOverall("uploading");
    setError("");

    // Upload all files concurrently (max 3 parallel)
    const results: CommitFileItem[] = [];
    const queue = [...files];
    let hasError = false;
    let uploadError = "";

    const worker = async () => {
      while (queue.length > 0 && !hasError) {
        const entry = queue.shift()!;
        try {
          const item = await uploadSingleFile(entry);
          results.push(item);
        } catch (err) {
          hasError = true;
          uploadError = getErrorMessage(err, "部分文件上传失败");
        }
      }
    };

    const concurrency = Math.min(3, files.length);
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (hasError || results.length !== files.length) {
      setOverall("error");
      setError(uploadError || "部分文件上传失败");
      return;
    }

    // Commit all files as one share
    try {
      setOverall("committing");
      const commitRes = await uploadCommit({
        files: results,
        empty_dirs: emptyDirs,
        password: password || undefined,
        expires_hours: expiresHours,
        max_downloads: maxDownloads || undefined,
      });
      setOverall("done");
      setResultPhase("check");
      setResult({ shareCode: commitRes.share_code, shareUrl: commitRes.share_url, fileCount: commitRes.file_count, revokeToken: commitRes.revoke_token });
      QRCode.toDataURL(commitRes.share_url, { width: 160, margin: 2, color: { dark: "#2a1810" } }).then(setQrUrl).catch(() => {});
      // 游客：存到 localStorage 以便后续撤销
      if (commitRes.revoke_token) {
        try {
          const stored = JSON.parse(localStorage.getItem("nyy_guest_shares") || "[]");
          stored.unshift({ code: commitRes.share_code, url: commitRes.share_url, revokeToken: commitRes.revoke_token, createdAt: Date.now() });
          localStorage.setItem("nyy_guest_shares", JSON.stringify(stored.slice(0, 10)));
        } catch {}
      }
      getQuota().then(setQuota).catch(() => {});
      onUploadDone?.();
    } catch (err) {
      setOverall("error");
      setError(getErrorMessage(err, "提交失败"));
    }
  };

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const dropped = await extractFilesFromDrop(e.dataTransfer);
    addFiles(dropped.files, dropped.emptyDirs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);

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
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  const isIdle = overall === "idle";
  const totalSize = files.reduce((s, f) => s + f.file.size, 0);
  const totalItemCount = files.length + emptyDirs.length;
  const visibleFiles = showAllFiles ? files : files.slice(0, 5);
  const visibleEmptyDirs = showAllFiles ? emptyDirs : emptyDirs.slice(0, Math.max(0, 5 - visibleFiles.length));

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
          "relative rounded-2xl p-8",
          "transition-all duration-200 ease-out",
          "flex flex-col items-center justify-center gap-3 min-h-[120px] sm:min-h-[180px]",
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

        <p className="type-body-sm text-gray-600 dark:text-gray-400 text-center">
          {overall === "idle" && (totalItemCount === 0 ? <><span className="hidden sm:inline">拖拽文件或文件夹到这里，或点击选择</span><span className="sm:hidden">选择要分享的文件</span></> : "可继续添加文件，或点击「开始上传」")}
          {overall === "uploading" && "上传中..."}
          {overall === "committing" && "确认中..."}
          {overall === "error" && "上传失败"}
        </p>

        {overall === "idle" && totalItemCount === 0 && (
          <div className="inline-flex items-center rounded-xl bg-orange-100/60 dark:bg-orange-950/30 p-1 gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); inputRef.current?.click(); }}
                className="btn-primary rounded-lg"
              >
                选择文件
              </button>
              <button
                onClick={handleFolderPick}
                disabled={!supportsDirectoryPicker}
                title={supportsDirectoryPicker ? "选择文件夹" : "当前浏览器无法保留空文件夹结构，请使用 Chrome / Edge 桌面端"}
                className={cn(
                  "type-action hidden sm:inline-flex items-center min-h-[44px] rounded-lg px-4 transition-all active:scale-[0.97]",
                  supportsDirectoryPicker
                    ? "text-nyy-800 dark:text-nyy-300 hover:bg-white/70 dark:hover:bg-white/10"
                    : "cursor-not-allowed text-gray-300 dark:text-gray-600"
                )}
              >
                选择文件夹
            </button>
          </div>
        )}

        {overall === "idle" && totalItemCount === 0 && !supportsDirectoryPicker && (
          <p className="type-caption max-w-xs text-center text-gray-400 dark:text-gray-500">
            当前浏览器无法完整保留空文件夹结构，请使用 Chrome / Edge 桌面端。
          </p>
        )}

        {/* Quota inside drop zone */}
        {quota && overall === "idle" && (
          <p className="type-caption absolute bottom-3 left-0 right-0 text-center text-gray-400 dark:text-gray-500">
            已用 {formatSize(quota.used_bytes)} / {formatSize(quota.limit_bytes)}，剩余 {formatSize(quota.remaining_bytes)}
          </p>
        )}
      </motion.div>
      ) : (
      /* Done state: true one-take — single checkmark, fixed pixel positions, CSS transition */
      <div className="relative rounded-2xl overflow-hidden bg-green-50/60 dark:bg-green-900/10 border border-green-200 dark:border-green-800/40 min-h-[180px]"
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
              className="type-body-sm absolute left-0 right-0 text-center text-gray-600 dark:text-gray-400"
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
              {/* Header row */}
              <div className="flex items-center justify-between mb-3">
                <span className="type-label pl-6 text-gray-700 dark:text-gray-300">
                  上传完成 · {result?.fileCount} 个文件{emptyDirs.length > 0 ? ` · ${emptyDirs.length} 个空文件夹` : ""}
                </span>
                {password && (
                  <span className="type-caption text-nyy-600 flex items-center gap-1">
                    <Lock className="w-3 h-3" /> 提取码: {password}
                  </span>
                )}
              </div>
              {/* File list */}
              {totalItemCount > 0 && (
                <div className="mb-3 space-y-1.5">
                  {visibleFiles.map((entry) => (
                    <div key={entry.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/60 dark:bg-white/5">
                      <FileIcon className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="type-file-name flex-1 text-gray-700 dark:text-gray-300 truncate">{entry.uploadName}</span>
                      <span className="type-file-meta text-gray-400 shrink-0">{formatSize(entry.file.size)}</span>
                    </div>
                  ))}
                  {visibleEmptyDirs.map((dir) => (
                    <div key={dir} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/60 dark:bg-white/5">
                      <Folder className="w-4 h-4 text-gray-400 shrink-0" />
                      <span className="type-file-name flex-1 text-gray-700 dark:text-gray-300 truncate">{dir}</span>
                      <span className="type-file-meta text-gray-400 shrink-0">空文件夹</span>
                    </div>
                  ))}
                  {!showAllFiles && totalItemCount > 5 && (
                    <button
                      onClick={() => setShowAllFiles(true)}
                      className="type-action w-full py-1 text-gray-500 dark:text-gray-400 hover:text-nyy-600 dark:hover:text-nyy-400 transition-colors"
                    >
                      显示全部 {totalItemCount} 项
                    </button>
                  )}
                  {showAllFiles && totalItemCount > 5 && (
                    <button
                      onClick={() => setShowAllFiles(false)}
                      className="type-action w-full py-1 text-gray-500 dark:text-gray-400 hover:text-nyy-600 dark:hover:text-nyy-400 transition-colors"
                    >
                      收起
                    </button>
                  )}
                </div>
              )}
              {/* Link + QR row */}
              <div className="flex flex-col sm:flex-row sm:gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <code className="type-body flex-1 px-3 py-2 bg-white dark:bg-white/5 border border-gray-100 dark:border-gray-700 rounded-xl dark:text-gray-200 truncate select-all">
                      {result?.shareUrl}
                    </code>
                    <button
                      onClick={copyLink}
                      className={cn(
                        "btn-primary flex items-center gap-1 px-3 py-2",
                        copied && "!bg-none !bg-green-100 !text-green-700 !shadow-none"
                      )}
                    >
                      <Copy className="w-4 h-4" />
                      {copied ? "已复制" : "复制"}
                    </button>
                  </div>
                  <button onClick={reset} className="type-action mt-3 min-h-[36px] rounded-lg text-gray-600 dark:text-gray-400 hover:text-nyy-800 dark:hover:text-nyy-400 transition-colors">继续上传</button>
                </div>
                {qrUrl && (
                  <div className="flex justify-center sm:justify-end pt-3 sm:pt-0 sm:items-center shrink-0">
                    <img src={qrUrl} alt="分享二维码" className="w-24 h-24 sm:w-28 sm:h-28 rounded-lg" />
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      )}

      {/* File list */}
      {totalItemCount > 0 && overall !== "done" && (
        <div className="mt-4 space-y-2 max-h-[240px] overflow-y-auto">
          {visibleFiles.map((entry) => (
            <div key={entry.id} className="flex items-center gap-2 p-2 bg-white dark:bg-white/5 rounded-xl border border-warm-200 dark:border-gray-700">
              <FileIcon className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="type-file-name text-gray-700 dark:text-gray-300 truncate">{entry.uploadName}</p>
                <div className="flex items-center gap-2">
                  <span className="type-file-meta text-gray-400">{formatSize(entry.file.size)}</span>
                  {entry.state === "uploading" && (
                    <div className="flex-1 h-1 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <div className="h-full bg-nyy-500 rounded-full transition-all" style={{ width: `${entry.progress}%` }} />
                    </div>
                  )}
                  {entry.state === "hashing" && <span className="type-caption text-nyy-500">校验中...</span>}
                  {entry.state === "done" && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                  {entry.state === "error" && (
                    <span className="type-caption text-red-500 flex items-center gap-0.5">
                      <AlertCircle className="w-3 h-3" /> {entry.error}
                      {entry.retries > 0 && ` (重试${entry.retries}次)`}
                    </span>
                  )}
                </div>
              </div>
              {isIdle && (
                <button onClick={() => removeFile(entry.id)} aria-label={`移除 ${entry.uploadName}`} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-white/10">
                  <X className="w-3 h-3 text-gray-400" />
                </button>
              )}
            </div>
          ))}
          {visibleEmptyDirs.map((dir) => (
            <div key={dir} className="flex items-center gap-2 p-2 bg-white dark:bg-white/5 rounded-xl border border-warm-200 dark:border-gray-700">
              <Folder className="w-4 h-4 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="type-file-name text-gray-700 dark:text-gray-300 truncate">{dir}</p>
                <span className="type-file-meta text-gray-400">空文件夹</span>
              </div>
              {isIdle && (
                <button onClick={() => setEmptyDirs((prev) => prev.filter((item) => item !== dir))} aria-label={`移除 ${dir}`} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-white/10">
                  <X className="w-3 h-3 text-gray-400" />
                </button>
              )}
            </div>
          ))}
          {!showAllFiles && totalItemCount > 5 && (
            <button
              onClick={() => setShowAllFiles(true)}
              className="type-action w-full py-1.5 text-gray-500 dark:text-gray-400 hover:text-nyy-600 dark:hover:text-nyy-400 transition-colors"
            >
              查看全部 {totalItemCount} 项
            </button>
          )}
          {showAllFiles && totalItemCount > 5 && (
            <button
              onClick={() => setShowAllFiles(false)}
              className="type-action w-full py-1.5 text-gray-500 dark:text-gray-400 hover:text-nyy-600 dark:hover:text-nyy-400 transition-colors"
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
            <span className="type-body-sm text-gray-600 dark:text-gray-400">
              <Files className="w-3 h-3 inline mr-1" />
              {files.length} 个文件，{emptyDirs.length} 个空文件夹，共 {formatSize(totalSize)}
            </span>
            {quota && totalSize > quota.remaining_bytes && (
              <p className="type-caption text-red-500 dark:text-red-400">
                超出剩余容量 {formatSize(totalSize - quota.remaining_bytes)}，请移除部分文件
              </p>
            )}
            {files.length > MAX_FILE_COUNT && (
              <p className="type-caption text-red-500 dark:text-red-400">
                文件数量超出上限（最多 {MAX_FILE_COUNT} 个），请移除部分文件
              </p>
            )}
            {emptyDirs.length > MAX_EMPTY_DIR_COUNT && (
              <p className="type-caption text-red-500 dark:text-red-400">
                空文件夹数量超出上限（最多 {MAX_EMPTY_DIR_COUNT} 个），请移除部分空文件夹
              </p>
            )}
            {folderWarning && <p className="type-caption text-yellow-600 dark:text-yellow-400">{folderWarning}</p>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => inputRef.current?.click()}
            className="type-action min-h-[44px] rounded-xl border border-nyy-700 dark:border-nyy-600 px-4 text-nyy-800 dark:text-nyy-400 transition-all hover:bg-nyy-50 dark:hover:bg-nyy-900/20"
          >
            继续添加
          </button>
          <button
            onClick={startUpload}
            disabled={(!!quota && totalSize > quota.remaining_bytes) || files.length > MAX_FILE_COUNT || emptyDirs.length > MAX_EMPTY_DIR_COUNT}
            className={cn(
              "btn-primary",
              ((!!quota && totalSize > quota.remaining_bytes) || files.length > MAX_FILE_COUNT || emptyDirs.length > MAX_EMPTY_DIR_COUNT) && "!bg-none !bg-gray-200 dark:!bg-gray-800 !text-gray-500 !shadow-none cursor-not-allowed"
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
                className="type-body-sm h-9 flex-1 max-w-[160px] rounded-lg border border-gray-200 dark:border-gray-700 bg-transparent px-3 text-gray-700 dark:text-gray-200 placeholder:text-gray-300 dark:placeholder:text-gray-600 focus:outline-none focus:border-nyy-400 focus:ring-1 focus:ring-nyy-300/40 transition-all"
              />
            </div>
            <div className="mx-4 h-px bg-gray-100 dark:bg-white/[0.04]" />
            {/* 过期时间 */}
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="flex items-center gap-2 w-24 shrink-0">
                <Clock className="w-3.5 h-3.5 text-gray-400" />
                <label className="text-sm text-gray-500 dark:text-gray-400">有效期</label>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { value: 1, label: "1时" },
                  { value: 6, label: "6时" },
                  { value: 24, label: "1天" },
                  { value: 72, label: "3天" },
                  { value: 168, label: "7天" },
                  { value: 360, label: "15天" },
                ].map((opt) => {
                  const locked = !loggedIn && opt.value !== 1;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        if (locked) { onLoginClick?.(); return; }
                        setExpiresHours(opt.value);
                      }}
                      className={cn(
                        "relative h-8 rounded-md px-3 text-sm font-medium transition-all",
                        locked
                          ? "text-gray-300 dark:text-gray-600 cursor-default"
                          : expiresHours === opt.value
                            ? "bg-nyy-500 text-white shadow-sm shadow-nyy-500/25"
                            : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                      )}
                      title={locked ? "登录后解锁" : undefined}
                    >
                      {opt.label}
                      {locked && <Lock className="absolute -top-1 -right-1 w-2.5 h-2.5 text-gray-300 dark:text-gray-600" />}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mx-4 h-px bg-gray-100 dark:bg-white/[0.04]" />
            {/* 下载次数 */}
            <div className="flex items-center gap-4 px-4 py-3">
              <div className="flex items-center gap-2 w-24 shrink-0">
                <Download className="w-3.5 h-3.5 text-gray-400" />
                <label className="text-sm text-gray-500 dark:text-gray-400">下载上限</label>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { value: 1, label: "1次" },
                  { value: 5, label: "5次" },
                  { value: 10, label: "10次" },
                  { value: 50, label: "50次" },
                  { value: 100, label: "100次" },
                  { value: 0, label: "不限" },
                ].map((opt) => {
                  const locked = !loggedIn && ![1, 5, 10].includes(opt.value);
                  return (
                    <button
                      key={opt.value}
                      onClick={() => {
                        if (locked) { onLoginClick?.(); return; }
                        setMaxDownloads(opt.value);
                      }}
                      className={cn(
                        "relative h-8 rounded-md px-3 text-sm font-medium transition-all",
                        locked
                          ? "text-gray-300 dark:text-gray-600 cursor-default"
                          : maxDownloads === opt.value
                            ? "bg-nyy-500 text-white shadow-sm shadow-nyy-500/25"
                            : "text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]"
                      )}
                      title={locked ? "登录后解锁" : undefined}
                    >
                      {opt.label}
                      {locked && <Lock className="absolute -top-1 -right-1 w-2.5 h-2.5 text-gray-300 dark:text-gray-600" />}
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
          <button onClick={reset} className="type-action flex min-h-[44px] items-center gap-1 rounded-lg px-2 text-nyy-800 dark:text-nyy-400 hover:underline">
            <RotateCcw className="w-3 h-3" /> 重试
          </button>
        </div>
      )}
    </div>
  );
}
