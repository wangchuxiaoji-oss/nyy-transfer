"use client";

import { Fragment, useCallback, useState } from "react";
import { FolderOpen, Play, AlertTriangle, CheckCircle, XCircle, Clock, FileVideo, HardDrive } from "lucide-react";
import { probeMediaMetadata, shouldProbeMediaMetadata } from "@/lib/media-metadata";
import type { MediaMetadata } from "@/lib/api";
import { probeUnsupportedMedia, type UnsupportedMediaProbe } from "@/lib/unsupported-media-probe";

// 可播放的视频格式
const PLAYABLE_VIDEO_EXTS = new Set(["mp4", "m4v", "mov", "webm", "ogg"]);
// 当前自研播放器优先支持分析的非原生格式
const ANALYZABLE_VIDEO_EXTS = new Set(["mkv"]);
// 不可播放但可识别的视频格式
const UNPLAYABLE_VIDEO_EXTS = new Set([
  "avi", "flv", "wmv", "rmvb", "3gp", "asf", "f4v",
  "vob", "mpg", "mpeg", "m2ts", "mts", "divx", "xvid", "rm",
]);
// 音频格式（跳过）
const AUDIO_EXTS = new Set(["mp3", "aac", "wav", "flac", "m4a", "wma", "opus", "ape"]);

// 最大文件大小：10GB
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024;

interface FileInfo {
  file: File;
  relativePath: string;
  classification: "playable_video" | "analyzable_video" | "unplayable_video" | "audio" | "unknown";
}

interface AnalysisResult {
  file_name: string;
  relative_path: string;
  file_size: number;
  status: "analyzed" | "unsupported" | "skipped_too_large" | "error" | "skipped_not_probable";
  error_message?: string;
  media_metadata?: MediaMetadata | null;
  unsupported_probe?: UnsupportedMediaProbe | null;
}

interface ScanProgress {
  total: number;
  analyzed: number;
  unsupported: number;
  skipped: number;
  errors: number;
  currentFile: string;
  isRunning: boolean;
}

function getFileExtension(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

function classifyFile(fileName: string): FileInfo["classification"] {
  const ext = getFileExtension(fileName);
  if (PLAYABLE_VIDEO_EXTS.has(ext)) return "playable_video";
  if (ANALYZABLE_VIDEO_EXTS.has(ext)) return "analyzable_video";
  if (UNPLAYABLE_VIDEO_EXTS.has(ext)) return "unplayable_video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "unknown";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds) return "-";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getSeverityIcon(severity: string) {
  switch (severity) {
    case "high": return <XCircle className="w-4 h-4 text-red-500" />;
    case "medium": return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    default: return <CheckCircle className="w-4 h-4 text-green-500" />;
  }
}

function formatBrowserSupportLabel(level: string): string {
  if (level === "yes") return "可播";
  if (level === "maybe") return "可能可播";
  if (level === "no") return "不可播";
  return "未知";
}

function getBrowserSupportRows(probe: UnsupportedMediaProbe | null | undefined) {
  const support = probe?.playback?.browser_support;
  return [
    { label: "Windows Chrome", level: support?.windows_chrome?.level || "unknown", reason: support?.windows_chrome?.reason || "-" },
    { label: "Windows Edge", level: support?.windows_edge?.level || "unknown", reason: support?.windows_edge?.reason || "-" },
    { label: "iPhone Safari", level: support?.iphone_safari?.level || "unknown", reason: support?.iphone_safari?.reason || "-" },
    { label: "鸿蒙浏览器", level: support?.harmony_browser?.level || "unknown", reason: support?.harmony_browser?.reason || "-" },
    { label: "安卓浏览器", level: support?.android_browser?.level || "unknown", reason: support?.android_browser?.reason || "-" },
  ];
}

export default function VideoInspectPage() {
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [unsupported, setUnsupported] = useState<AnalysisResult[]>([]);
  const [progress, setProgress] = useState<ScanProgress>({
    total: 0,
    analyzed: 0,
    unsupported: 0,
    skipped: 0,
    errors: 0,
    currentFile: "",
    isRunning: false,
  });
  const [savedPath, setSavedPath] = useState<string | null>(null);

  // 递归遍历文件夹
  const traverseDirectory = useCallback(async (dirHandle: FileSystemDirectoryHandle, path: string = ""): Promise<FileInfo[]> => {
    const result: FileInfo[] = [];

    // 使用 entries() 方法遍历目录
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries = (dirHandle as any).values ? (dirHandle as any).values() : [];
    for await (const entry of entries) {
      const entryPath = path ? `${path}/${entry.name}` : entry.name;

      if (entry.kind === "file") {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        const classification = classifyFile(entry.name);

        // 跳过音频文件
        if (classification === "audio") continue;

        // 跳过未知格式
        if (classification === "unknown") continue;

        result.push({
          file,
          relativePath: entryPath,
          classification,
        });
      } else if (entry.kind === "directory") {
        const dirHandleEntry = entry as FileSystemDirectoryHandle;
        const subFiles = await traverseDirectory(dirHandleEntry, entryPath);
        result.push(...subFiles);
      }
    }

    return result;
  }, []);

  // 选择文件夹
  const handleSelectFolder = useCallback(async () => {
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: "read" });
      const allFiles = await traverseDirectory(dirHandle);
      setFiles(allFiles);
      setResults([]);
      setUnsupported([]);
      setSavedPath(null);
    } catch {
      console.log("Folder selection cancelled");
    }
  }, [traverseDirectory]);

  // 分析单个文件（纯客户端）
  const analyzeFile = useCallback(async (fileInfo: FileInfo): Promise<AnalysisResult> => {
    const { file, relativePath } = fileInfo;
    const fileName = file.name;
    const fileSize = file.size;
    const ext = getFileExtension(fileName);

    // 检查文件大小
    if (fileSize > MAX_FILE_SIZE) {
      return {
        file_name: fileName,
        relative_path: relativePath,
        file_size: fileSize,
        status: "skipped_too_large",
        error_message: `文件大小 ${formatSize(fileSize)} 超过 10GB 限制`,
      };
    }

    // 自研播放器优先支持的非原生格式：做客户端容器分析，并计入分析结果
    if (fileInfo.classification === "analyzable_video") {
      const unsupportedProbe = await probeUnsupportedMedia(file, fileName);
      return {
        file_name: fileName,
        relative_path: relativePath,
        file_size: fileSize,
        status: unsupportedProbe.probe_status === "ok" ? "analyzed" : "error",
        error_message: unsupportedProbe.probe_status === "ok" ? undefined : unsupportedProbe.probe_error || `格式 ${ext} 探测失败`,
        unsupported_probe: unsupportedProbe,
      };
    }

    // 不可播放格式只记录元数据
    if (fileInfo.classification === "unplayable_video") {
      const unsupportedProbe = await probeUnsupportedMedia(file, fileName);
      return {
        file_name: fileName,
        relative_path: relativePath,
        file_size: fileSize,
        status: "unsupported",
        error_message: unsupportedProbe.probe_error || `格式 ${ext} 不支持在线播放`,
        unsupported_probe: unsupportedProbe,
      };
    }

    // 检查是否可以进行客户端探测
    if (!shouldProbeMediaMetadata(file, fileName)) {
      return {
        file_name: fileName,
        relative_path: relativePath,
        file_size: fileSize,
        status: "skipped_not_probable",
        error_message: `格式 ${ext} 不支持客户端探测`,
      };
    }

    // 使用现有探测逻辑（纯客户端，只读取必要部分）
    const metadata = await probeMediaMetadata(file, fileName);

    return {
      file_name: fileName,
      relative_path: relativePath,
      file_size: fileSize,
      status: metadata?.probe_status === "ok" ? "analyzed" : "error",
      error_message: metadata?.probe_status === "failed" ? metadata.probe_error : undefined,
      media_metadata: metadata,
    };
  }, []);

  // 开始分析
  const handleStartAnalysis = useCallback(async () => {
    if (files.length === 0) return;

    setProgress({
      total: files.length,
      analyzed: 0,
      unsupported: 0,
      skipped: 0,
      errors: 0,
      currentFile: "",
      isRunning: true,
    });

    const analyzedResults: AnalysisResult[] = [];
    const unsupportedResults: AnalysisResult[] = [];

    for (let i = 0; i < files.length; i++) {
      const fileInfo = files[i];

      setProgress(prev => ({
        ...prev,
        currentFile: fileInfo.relativePath,
      }));

      try {
        const result = await analyzeFile(fileInfo);

        if (result.status === "unsupported" || result.status === "skipped_too_large" || result.status === "skipped_not_probable" || result.status === "error") {
          unsupportedResults.push(result);
          setUnsupported([...unsupportedResults]);
          if (result.status === "unsupported") {
            setProgress(prev => ({ ...prev, unsupported: prev.unsupported + 1 }));
          } else if (result.status === "skipped_too_large") {
            setProgress(prev => ({ ...prev, skipped: prev.skipped + 1 }));
          } else {
            setProgress(prev => ({ ...prev, errors: prev.errors + 1 }));
          }
        } else {
          analyzedResults.push(result);
          setResults([...analyzedResults]);
          setProgress(prev => ({ ...prev, analyzed: prev.analyzed + 1 }));
        }
      } catch (err) {
        const errorResult: AnalysisResult = {
          file_name: fileInfo.file.name,
          relative_path: fileInfo.relativePath,
          file_size: fileInfo.file.size,
          status: "error",
          error_message: err instanceof Error ? err.message : "Unknown error",
        };
        unsupportedResults.push(errorResult);
        setUnsupported([...unsupportedResults]);
        setProgress(prev => ({ ...prev, errors: prev.errors + 1 }));
      }
    }

    // 保存报告
    try {
      const report = {
        scan_time: new Date().toISOString(),
        folder_name: files[0]?.relativePath.split("/")[0] || "unknown",
        total_files: files.length,
        analyzed: analyzedResults,
        unsupported: unsupportedResults,
      };

      const response = await fetch("/api/v1/video-inspect/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });

      if (response.ok) {
        const data = await response.json();
        setSavedPath(data.saved_path);
      }
    } catch (err) {
      console.error("Failed to save report:", err);
    }

    setProgress(prev => ({
      ...prev,
      isRunning: false,
    }));
  }, [files, analyzeFile]);

  // 渲染分析结果
  const renderAnalysisResult = (result: AnalysisResult, index: number) => {
    const meta = result.media_metadata;
    const unsupportedProbe = result.unsupported_probe;
    const videoTrack = meta?.video_tracks?.[0];
    const audioTrack = meta?.audio_tracks?.[0];
    const unsupportedVideo = unsupportedProbe?.video_tracks?.[0];
    const unsupportedAudio = unsupportedProbe?.audio_tracks?.[0];
    const playback = unsupportedProbe?.playback;

    return (
      <div key={index} className="bg-gray-800 rounded-lg p-4">
        {/* 文件信息 */}
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-medium">{result.file_name}</h3>
            <p className="text-sm text-gray-400">{result.relative_path}</p>
          </div>
          <div className="text-right text-sm text-gray-400">
            <p>{formatSize(result.file_size)}</p>
            {meta?.duration_seconds && (
              <p>{formatDuration(meta.duration_seconds)}</p>
            )}
          </div>
        </div>

        {/* 视频流信息 */}
        {videoTrack && (
          <div className="mb-3">
            <h4 className="text-sm font-medium text-gray-300 mb-1">视频流</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                <span className="text-gray-500">编码:</span>{" "}
                <span>{videoTrack.codec}</span>
              </div>
              {videoTrack.width && videoTrack.height && (
                <div>
                  <span className="text-gray-500">分辨率:</span>{" "}
                  <span>{videoTrack.width}x{videoTrack.height}</span>
                </div>
              )}
              {videoTrack.timescale && videoTrack.duration_seconds && (
                <div>
                  <span className="text-gray-500">时长:</span>{" "}
                  <span>{formatDuration(videoTrack.duration_seconds)}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 音频流信息 */}
        {audioTrack && (
          <div className="mb-3">
            <h4 className="text-sm font-medium text-gray-300 mb-1">音频流</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                <span className="text-gray-500">编码:</span>{" "}
                <span>{audioTrack.codec}</span>
              </div>
              {audioTrack.sample_rate && (
                <div>
                  <span className="text-gray-500">采样率:</span>{" "}
                  <span>{audioTrack.sample_rate} Hz</span>
                </div>
              )}
              {audioTrack.channel_count && (
                <div>
                  <span className="text-gray-500">声道:</span>{" "}
                  <span>{audioTrack.channel_count}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* moov 信息 */}
        {meta?.moov_offset !== undefined && (
          <div className="mb-3">
            <h4 className="text-sm font-medium text-gray-300 mb-1">MP4 结构</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                <span className="text-gray-500">moov 位置:</span>{" "}
                <span className={meta.is_faststart ? "text-green-400" : "text-yellow-400"}>
                  {meta.is_faststart ? "文件头部 (faststart)" : "文件尾部"}
                </span>
              </div>
              {meta.moov_size && (
                <div>
                  <span className="text-gray-500">moov 大小:</span>{" "}
                  <span>{formatSize(meta.moov_size)}</span>
                </div>
              )}
              <div>
                <span className="text-gray-500">Fast Start:</span>{" "}
                <span className={meta.is_faststart ? "text-green-400" : "text-yellow-400"}>
                  {meta.is_faststart ? "是" : "否"}
                </span>
              </div>
              {meta.is_fragmented !== undefined && (
                <div>
                  <span className="text-gray-500">分片:</span>{" "}
                  <span>{meta.is_fragmented ? "是" : "否"}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Brands */}
        {meta?.brands && meta.brands.length > 0 && (
          <div className="mb-3">
            <h4 className="text-sm font-medium text-gray-300 mb-1">Brands</h4>
            <div className="flex gap-2 text-sm">
              {meta.brands.map((brand, i) => (
                <span key={i} className="px-2 py-0.5 bg-gray-700 rounded">{brand}</span>
              ))}
            </div>
          </div>
        )}

        {/* 诊断问题 */}
        {meta?.probe_status === "failed" && (
          <div className="mb-3">
            <h4 className="text-sm font-medium text-gray-300 mb-1">诊断</h4>
            <div className="flex items-start gap-2 text-sm">
              {getSeverityIcon("high")}
              <p className="text-red-400">{meta.probe_error}</p>
            </div>
          </div>
        )}

        {/* 播放策略建议 */}
        {meta?.probe_status === "ok" && (
          <div>
            <h4 className="text-sm font-medium text-gray-300 mb-1">播放策略</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                <span className="text-gray-500">moov 预读:</span>{" "}
                <span>{meta.is_faststart ? "不需要" : "需要"}</span>
              </div>
              {!meta.is_faststart && meta.moov_size && (
                <div>
                  <span className="text-gray-500">预读大小:</span>{" "}
                  <span>{formatSize(meta.moov_size + 1024 * 1024)}</span>
                </div>
              )}
              <div>
                <span className="text-gray-500">缓冲策略:</span>{" "}
                <span>{meta.is_faststart ? "normal" : "aggressive"}</span>
              </div>
            </div>
          </div>
        )}

        {/* 不支持格式的容器探测 */}
        {unsupportedProbe?.probe_status === "ok" && (
          <div>
            <h4 className="text-sm font-medium text-gray-300 mb-1">容器头部探测</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
              <div>
                <span className="text-gray-500">容器:</span>{" "}
                <span>{unsupportedProbe.container_label || unsupportedProbe.container || "unknown"}</span>
              </div>
              <div>
                <span className="text-gray-500">读取大小:</span>{" "}
                <span>{formatSize(unsupportedProbe.bytes_read)}</span>
              </div>
            </div>

            {unsupportedVideo && (
              <div className="mt-3">
                <h5 className="text-xs font-medium text-gray-400 mb-1">视频流</h5>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-sm">
                  <div>
                    <span className="text-gray-500">编码:</span>{" "}
                    <span>{unsupportedVideo.codec}</span>
                  </div>
                  {unsupportedVideo.codec_tag && (
                    <div>
                      <span className="text-gray-500">Tag:</span>{" "}
                      <span>{unsupportedVideo.codec_tag}</span>
                    </div>
                  )}
                  {unsupportedVideo.width && unsupportedVideo.height && (
                    <div>
                      <span className="text-gray-500">分辨率:</span>{" "}
                      <span>{unsupportedVideo.width}x{unsupportedVideo.height}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {unsupportedAudio && (
              <div className="mt-3">
                <h5 className="text-xs font-medium text-gray-400 mb-1">音频流</h5>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-sm">
                  <div>
                    <span className="text-gray-500">编码:</span>{" "}
                    <span>{unsupportedAudio.codec}</span>
                  </div>
                  {unsupportedAudio.codec_tag && (
                    <div>
                      <span className="text-gray-500">Tag:</span>{" "}
                      <span>{unsupportedAudio.codec_tag}</span>
                    </div>
                  )}
                  {unsupportedAudio.sample_rate && (
                    <div>
                      <span className="text-gray-500">采样率:</span>{" "}
                      <span>{unsupportedAudio.sample_rate} Hz</span>
                    </div>
                  )}
                  {unsupportedAudio.channel_count && (
                    <div>
                      <span className="text-gray-500">声道:</span>{" "}
                      <span>{unsupportedAudio.channel_count}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {playback && (
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div>
                  <h5 className="text-xs font-medium text-gray-400 mb-1">当前项目</h5>
                  <p className={playback.current_project.playable ? "text-green-400" : "text-red-400"}>
                    {playback.current_project.playable ? "可播放" : "不可播放"}：{playback.current_project.reason}
                  </p>
                </div>
                <div>
                  <h5 className="text-xs font-medium text-gray-400 mb-1">换封装潜力</h5>
                  <p className={playback.remux_potential.level === "good" || playback.remux_potential.level === "possible" ? "text-yellow-300" : playback.remux_potential.level === "poor" ? "text-red-400" : "text-gray-300"}>
                    {playback.remux_potential.level.toUpperCase()}：{playback.remux_potential.reason}
                  </p>
                </div>
              </div>
            )}

            {playback && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b border-gray-800">
                      <th className="text-left py-1 pr-3">浏览器</th>
                      <th className="text-left py-1 pr-3">兼容性</th>
                      <th className="text-left py-1">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {([
                      ["Windows Chrome", playback.browser_support.windows_chrome],
                      ["Windows Edge", playback.browser_support.windows_edge],
                      ["iPhone Safari", playback.browser_support.iphone_safari],
                      ["鸿蒙浏览器", playback.browser_support.harmony_browser],
                      ["安卓浏览器", playback.browser_support.android_browser],
                    ] as const).map(([label, support]) => (
                      <tr key={label} className="border-b border-gray-800/60">
                        <td className="py-1 pr-3 text-gray-300">{label}</td>
                        <td className={`py-1 pr-3 ${support.level === "yes" ? "text-green-400" : support.level === "maybe" ? "text-yellow-400" : support.level === "no" ? "text-red-400" : "text-gray-400"}`}>
                          {formatBrowserSupportLabel(support.level)}
                        </td>
                        <td className="py-1 text-gray-400">{support.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {playback?.recommendations?.length ? (
              <div className="mt-3 text-sm">
                <h5 className="text-xs font-medium text-gray-400 mb-1">建议</h5>
                <ul className="list-disc pl-5 space-y-1 text-gray-300">
                  {playback.recommendations.map((item, itemIndex) => (
                    <li key={itemIndex}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* 标题 */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FileVideo className="w-6 h-6 text-blue-400" />
            视频分析工具
          </h1>
          <p className="text-gray-400 mt-2">
            选择本地文件夹，递归扫描所有视频文件并进行深度分析（纯客户端，不上传文件）
          </p>
        </div>

        {/* 选择文件夹 */}
        <div className="bg-gray-900 rounded-lg p-6 mb-6">
          <div className="flex items-center gap-4">
            <button
              onClick={handleSelectFolder}
              disabled={progress.isRunning}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              <FolderOpen className="w-4 h-4" />
              选择文件夹
            </button>

            {files.length > 0 && !progress.isRunning && (
              <button
                onClick={handleStartAnalysis}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors"
              >
                <Play className="w-4 h-4" />
                开始分析 ({files.length} 个文件)
              </button>
            )}

            {progress.isRunning && (
              <div className="flex items-center gap-2 text-gray-400">
                <Clock className="w-4 h-4 animate-spin" />
                分析中...
              </div>
            )}
          </div>

          {/* 文件统计 */}
          {files.length > 0 && (
            <div className="mt-4 flex gap-4 text-sm text-gray-400">
              <span>总计: {files.length} 个视频文件</span>
              <span>可分析: {files.filter(f => f.classification === "playable_video" || f.classification === "analyzable_video").length} 个</span>
              <span>不支持: {files.filter(f => f.classification === "unplayable_video").length} 个</span>
            </div>
          )}
        </div>

        {/* 进度条 */}
        {progress.isRunning && (
          <div className="bg-gray-900 rounded-lg p-6 mb-6">
            <div className="mb-4">
              <div className="flex justify-between text-sm text-gray-400 mb-2">
                <span>分析进度</span>
                <span>{progress.analyzed + progress.unsupported + progress.skipped + progress.errors} / {progress.total}</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{
                    width: `${((progress.analyzed + progress.unsupported + progress.skipped + progress.errors) / progress.total) * 100}%`,
                  }}
                />
              </div>
            </div>

            <div className="text-sm text-gray-400">
              <p>当前文件: {progress.currentFile}</p>
              <div className="flex gap-4 mt-2">
                <span className="text-green-400">✓ 已分析: {progress.analyzed}</span>
                <span className="text-yellow-400">⚠ 不支持: {progress.unsupported}</span>
                <span className="text-orange-400">⏭ 跳过: {progress.skipped}</span>
                <span className="text-red-400">✗ 错误: {progress.errors}</span>
              </div>
            </div>
          </div>
        )}

        {/* 分析结果 */}
        {results.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-green-400" />
              分析结果 ({results.length} 个文件)
            </h2>

            <div className="space-y-4">
              {results.map((result, index) => renderAnalysisResult(result, index))}
            </div>
          </div>
        )}

        {/* 不支持的格式 */}
        {unsupported.length > 0 && (
          <div className="bg-gray-900 rounded-lg p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-yellow-400" />
              不支持的格式 ({unsupported.length} 个文件)
            </h2>

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-800">
                    <th className="text-left py-2">文件名</th>
                    <th className="text-left py-2">路径</th>
                    <th className="text-right py-2">大小</th>
                    <th className="text-left py-2">状态</th>
                    <th className="text-left py-2">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {unsupported.map((item, index) => (
                    <Fragment key={index}>
                      <tr className="border-b border-gray-800 align-top">
                        <td className="py-2">{item.file_name}</td>
                        <td className="py-2 text-gray-400">{item.relative_path}</td>
                        <td className="py-2 text-right">{formatSize(item.file_size)}</td>
                        <td className="py-2">
                          <span className={`px-2 py-0.5 rounded text-xs ${
                            item.status === "skipped_too_large" ? "bg-orange-900 text-orange-300" :
                            item.status === "error" ? "bg-red-900 text-red-300" :
                            item.status === "skipped_not_probable" ? "bg-purple-900 text-purple-300" :
                            "bg-yellow-900 text-yellow-300"
                          }`}>
                            {item.status === "skipped_too_large" ? "跳过" :
                             item.status === "error" ? "错误" :
                             item.status === "skipped_not_probable" ? "不支持探测" :
                             "不支持"}
                          </span>
                        </td>
                        <td className="py-2 text-gray-400">{item.error_message}</td>
                      </tr>
                      {item.unsupported_probe?.probe_status === "ok" && (
                        <tr className="border-b border-gray-800/70 bg-gray-950/40">
                          <td colSpan={5} className="py-3">
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
                              <div>
                                <div className="text-gray-400 mb-2">容器 / 流</div>
                                <div className="space-y-1 text-gray-300">
                                  <div>容器: {item.unsupported_probe.container_label || item.unsupported_probe.container || "unknown"}</div>
                                  <div>读取大小: {formatSize(item.unsupported_probe.bytes_read)}</div>
                                  <div>视频编码: {item.unsupported_probe.video_tracks?.[0]?.codec || "-"}</div>
                                  <div>音频编码: {item.unsupported_probe.audio_tracks?.[0]?.codec || "-"}</div>
                                </div>
                              </div>
                              <div>
                                <div className="text-gray-400 mb-2">兼容性摘要</div>
                                <div className="space-y-1 text-gray-300">
                                  <div>当前项目: {item.unsupported_probe.playback?.current_project.playable ? "可播" : "不可播"}</div>
                                  <div>换封装潜力: {item.unsupported_probe.playback?.remux_potential.level || "unknown"}</div>
                                </div>
                                <table className="mt-2 w-full text-xs">
                                  <tbody>
                                    {getBrowserSupportRows(item.unsupported_probe).map((supportRow) => (
                                      <tr key={supportRow.label} className="border-b border-gray-800/50 align-top">
                                        <td className="py-1 pr-2 text-gray-300 whitespace-nowrap">{supportRow.label}</td>
                                        <td className={`py-1 pr-2 whitespace-nowrap ${supportRow.level === "yes" ? "text-green-400" : supportRow.level === "maybe" ? "text-yellow-400" : supportRow.level === "no" ? "text-red-400" : "text-gray-400"}`}>
                                          {formatBrowserSupportLabel(supportRow.level)}
                                        </td>
                                        <td className="py-1 text-gray-500">{supportRow.reason}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                            {item.unsupported_probe.playback?.recommendations?.length ? (
                              <div className="mt-3 text-xs text-gray-400 space-y-1">
                                {item.unsupported_probe.playback.recommendations.map((recommendation, recommendationIndex) => (
                                  <p key={recommendationIndex}>• {recommendation}</p>
                                ))}
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 保存路径 */}
        {savedPath && (
          <div className="bg-gray-900 rounded-lg p-6">
            <h2 className="text-lg font-semibold mb-2 flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-blue-400" />
              报告已保存
            </h2>
            <p className="text-gray-400 text-sm font-mono">{savedPath}</p>
          </div>
        )}
      </div>
    </div>
  );
}
