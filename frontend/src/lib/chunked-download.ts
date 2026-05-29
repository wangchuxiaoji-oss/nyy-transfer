/**
 * 大文件流式下载：使用 File System Access API 将多个 chunk 顺序写入磁盘。
 * 仅支持桌面 Chrome/Edge（Chromium 内核）。
 *
 * 零内存占用：每个 chunk fetch → pipe → writable，不在内存中拼接。
 */

import type { ChunkDownloadInfo } from "./api";
import type { DebugLogFn } from "./debug";

export interface ChunkedDownloadProgress {
  /** 当前正在下载的 chunk 索引 */
  currentChunk: number;
  /** 总 chunk 数 */
  totalChunks: number;
  /** 已下载字节数 */
  downloadedBytes: number;
  /** 文件总大小 */
  totalBytes: number;
}

export type ProgressCallback = (progress: ChunkedDownloadProgress) => void;
type WritableFileSink = { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: () => Promise<void> };

/**
 * 检测当前浏览器是否支持 File System Access API（大文件流式下载）。
 */
export function supportsChunkedDownload(): boolean {
  return (
    typeof window !== "undefined" &&
    "showSaveFilePicker" in window &&
    typeof ReadableStream !== "undefined"
  );
}

/**
 * 流式下载分片大文件到本地磁盘。
 *
 * @param fileName - 保存的文件名
 * @param totalSize - 文件总大小（字节）
 * @param chunks - 按顺序排列的 chunk 下载信息
 * @param onProgress - 进度回调
 * @throws 用户取消或网络错误时抛出
 */
export async function chunkedDownload(
  fileName: string,
  totalSize: number,
  chunks: ChunkDownloadInfo[],
  onProgress?: ProgressCallback,
  debugLog?: DebugLogFn,
): Promise<void> {
  if (!supportsChunkedDownload()) {
    throw new Error("当前浏览器不支持大文件下载，请使用桌面版 Chrome 或 Edge");
  }

  // 推断 MIME type
  const ext = fileName.includes(".") ? fileName.split(".").pop()?.toLowerCase() : "";
  const mimeMap: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
    mp3: "audio/mpeg", aac: "audio/aac", ogg: "audio/ogg",
    zip: "application/zip", iso: "application/octet-stream",
  };
  const accept: Record<string, string[]> = {};
  if (ext && mimeMap[ext]) {
    accept[mimeMap[ext]] = [`.${ext}`];
  }

  // 让用户选择保存位置
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const showSaveFilePicker = (window as any).showSaveFilePicker;
  let downloadedBytes = 0;
  const startedAt = performance.now();
  let writable: WritableFileSink | null = null;

  try {
    debugLog?.("download", "picker:open", { fileName, totalSize, chunks: chunks.length });
    const fileHandle = await showSaveFilePicker({
      suggestedName: fileName,
      types: ext && mimeMap[ext] ? [{ description: fileName, accept }] : undefined,
    });

    const output = await fileHandle.createWritable() as WritableFileSink;
    writable = output;
    debugLog?.("download", "start", { fileName, totalSize, chunks: chunks.length });

    const sortedChunks = [...chunks].sort((a, b) => a.index - b.index);

    for (let i = 0; i < sortedChunks.length; i++) {
      const chunk = sortedChunks[i];
      const chunkStartedAt = performance.now();
      let chunkBytes = 0;
      debugLog?.("download", "chunk:start", { index: i, size: chunk.size });
      const response = await fetch(chunk.download_url);
      if (!response.ok) {
        throw new Error(`下载分片 ${i + 1} 失败: HTTP ${response.status}`);
      }
      debugLog?.("download", "chunk:response", { index: i, status: response.status });

      const reader = response.body?.getReader();
      if (!reader) throw new Error("无法读取响应流");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await output.write(value);
        chunkBytes += value.byteLength;
        downloadedBytes += value.byteLength;
        onProgress?.({
          currentChunk: i,
          totalChunks: sortedChunks.length,
          downloadedBytes,
          totalBytes: totalSize,
        });
      }
      const chunkDurationMs = Math.round(performance.now() - chunkStartedAt);
      debugLog?.("download", "chunk:done", {
        index: i,
        bytes: chunkBytes,
        durationMs: chunkDurationMs,
        mibps: Number(((chunkBytes / Math.max(1, chunkDurationMs)) * 1000 / (1024 * 1024)).toFixed(2)),
      });
    }

    await output.close();
    writable = null;
    const durationMs = Math.round(performance.now() - startedAt);
    debugLog?.("download", "done", {
      bytes: downloadedBytes,
      durationMs,
      mibps: Number(((downloadedBytes / Math.max(1, durationMs)) * 1000 / (1024 * 1024)).toFixed(2)),
    });
  } catch (err) {
    await writable?.abort().catch(() => {});
    if (err instanceof DOMException && err.name === "AbortError") {
      debugLog?.("download", "cancel", { atBytes: downloadedBytes });
    } else {
      debugLog?.("download", "error", { error: err instanceof Error ? err.message : String(err), atBytes: downloadedBytes });
    }
    throw err;
  }
}
