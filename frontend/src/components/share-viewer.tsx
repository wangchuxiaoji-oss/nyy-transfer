"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import Link from "next/link";
import { CheckCircle2, Download, Clock, AlertCircle, Package, Flag, X, Play, Pause, Volume2, VolumeX, ChevronDown, ChevronUp, MoreHorizontal, FolderDown } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { CopyLinkButton } from "@/components/copy-link-button";
import { ShareFileBrowser } from "@/components/share-file-browser";
import { ShareImageGallery } from "@/components/share-image-gallery";
import { ShareGalleryOtherFiles, type ShareGalleryOtherFile } from "@/components/share-gallery-other-files";
import { SelfDevelopPlayer, supportsSelfDevelopPlayback } from "@/components/self-develop-player";
import { NativeVideoPlayer, type NativeVideoErrorInfo, type NativeVideoResumeRequest } from "@/components/native-video-player";
import { Ac3VideoPreview } from "@/components/ac3-video-preview";
import { PdfPreview } from "@/components/pdf-preview";
import {
  createLinkRequestId, getShareInfo, getGallerySession, unlockShare, verifyShare, downloadShare, reportShare, getPublicDownloadConfig, recordShareInteraction,
  type GallerySessionResponse, type ShareInfo, type ShareFileDownload,
} from "@/lib/api";
import { getAdminShareContent, getAdminShareView, type AdminShareView } from "@/lib/admin";
import {
  defaultDownloadConfig,
  downloadFilesToDirectoryHandle,
  downloadSmart,
  pickDownloadDirectory,
  supportsDirectoryPicker,
  type BatchDownloadProgress,
  type DownloadConfig,
  type SmartDownloadProgress,
} from "@/lib/smart-download";
import { getErrorMessage, isHttpStatusError } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import type { DebugLogFn } from "@/lib/debug";
import { createVirtualMediaFileId, needsVideoOnlyVirtualMp4, needsVirtualFaststart, prepareVirtualMediaTransport, registerVirtualMediaFile } from "@/lib/virtual-media";
import { BRAND_DOMAIN, BRAND_NAME, BRAND_SLOGAN_SHORT } from "@/lib/copy";
import s from "@/app/[code]/share-4c.module.css";

const OfficePreview = dynamic(
  () => import("@/components/office-preview").then((module) => module.OfficePreview),
  { ssr: false },
);

type PageState = "loading" | "locked" | "ready" | "not_found" | "expired" | "unauthorized" | "error";
type FileType = "video" | "image" | "pdf" | "audio" | "text" | "document" | "spreadsheet" | "presentation" | "other";
type DownloadLinksState = "idle" | "loading" | "ready" | "error";
type MobilePanel = "files" | "overview" | "scan";
type DownloadTaskState = "idle" | "running" | "completed" | "failed";
type WeChatEnvironment = "wechat" | "wecom";

interface ShareViewerProps {
  code: string;
  mode?: "public" | "admin";
}

const ADMIN_STATUS_LABELS: Record<AdminShareView["status"], string> = {
  active: "有效",
  revoked: "已撤销",
  expired: "已过期",
  banned: "已封禁",
  download_exhausted: "下载次数已耗尽",
};

function getPublicShareUrl(code: string): string {
  if (typeof window === "undefined") return `/${code}`;
  return `${window.location.origin}/${code}`;
}

// 分类文件类型（用于选择图标 + 预览策略）
function classifyFile(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "m4v", "mkv", "wmv", "mov", "webm"].includes(ext)) return "video";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "avif", "heic", "heif", "dng", "cr3", "cr2", "nef", "arw", "raf", "rw2", "orf", "pef"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["mp3", "aac", "wav", "flac", "m4a", "ogg"].includes(ext)) return "audio";
  if (["txt", "md", "json", "csv", "log", "ini", "yml", "yaml", "xml"].includes(ext)) return "text";
  if (ext === "docx") return "document";
  if (["xls", "xlsx"].includes(ext)) return "spreadsheet";
  if (ext === "pptx") return "presentation";
  return "other";
}

function isOfficeDownloadOnly(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return ["doc", "ppt", "docm", "xlsm", "pptm"].includes(ext);
}

function isDocumentStage(type: FileType): boolean {
  return ["pdf", "text", "document", "spreadsheet", "presentation"].includes(type);
}

function shouldAutoPrepareSingleDocument(share: ShareInfo): boolean {
  if (share.files.length !== 1 || share.files[0].is_chunked) return false;
  const fileName = share.files[0].file_name;
  const type = classifyFile(fileName);
  return ["pdf", "document", "spreadsheet", "presentation"].includes(type) || isOfficeDownloadOnly(fileName);
}

// URL 安全校验（防止 javascript: 等 XSS 协议）
function isSafeUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function isVirtualMediaUrl(url: string): boolean {
  return url.startsWith("/__nyy_virtual_media__/");
}

function isSameOriginUrl(url: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function isAnalyzableAudioUrl(url: string): boolean {
  return isVirtualMediaUrl(url) || isSameOriginUrl(url);
}

function isLiVehicleBrowser(userAgent: string): boolean {
  return /LiBrowser\/[\d.]+|\bHU_SS\d*\b/i.test(userAgent);
}

function detectWeChatEnvironment(userAgent: string): WeChatEnvironment | null {
  if (/\bwxwork\//i.test(userAgent)) return "wecom";
  if (/MicroMessenger/i.test(userAgent)) return "wechat";
  return null;
}

function isMobileBrowser(userAgent: string): boolean {
  return /Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(userAgent);
}

function hasSafeAudioSource(file: ShareFileDownload): boolean {
  return isSafeUrl(file.download_url) || file.chunks.some((chunk) => isSafeUrl(chunk.download_url));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "计算中";
  return `${formatSize(bytesPerSecond)}/s`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "计算中";
  const rounded = Math.ceil(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainSeconds = rounded % 60;
  if (hours > 0) return `${hours}小时${minutes.toString().padStart(2, "0")}分`;
  if (minutes > 0) return `${minutes}分${remainSeconds.toString().padStart(2, "0")}秒`;
  return `${remainSeconds}秒`;
}

function getProgressRatio(progress: SmartDownloadProgress): number {
  return Math.min(1, Math.max(0, progress.downloadedBytes / Math.max(1, progress.totalBytes)));
}

function getDownloadPercentLabel(progress: SmartDownloadProgress, state: DownloadTaskState): string {
  if (state === "completed") return "100%";
  const percent = getProgressRatio(progress) * 100;
  if (percent > 0 && percent < 1) return `${Math.max(0.1, percent).toFixed(1)}%`;
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.floor(percent)}%`;
}

function shouldSuspendPreviewForDownload(file: ShareFileDownload): boolean {
  const type = classifyFile(file.file_name);
  return type === "video" || type === "audio" || type === "pdf" || type === "document" || type === "spreadsheet" || type === "presentation";
}

function getSingleContentLabel(type: FileType): string {
  switch (type) {
    case "video": return "1 个视频";
    case "image": return "1 张图片";
    case "audio": return "1 个音频";
    case "pdf": return "1 个 PDF";
    case "document": return "1 个 Word 文档";
    case "spreadsheet": return "1 个表格";
    case "presentation": return "1 个演示文稿";
    default: return "1 个文件";
  }
}

function getShareContentSummary(share: ShareInfo): string {
  const fileCount = share.files.length;
  const dirCount = share.empty_dirs.length;
  if (fileCount === 0) return dirCount > 0 ? `仅包含 ${dirCount} 个空文件夹` : "空分享";
  const size = formatSize(share.total_bytes);
  if (fileCount === 1 && dirCount === 0) return `${getSingleContentLabel(classifyFile(share.files[0].file_name))} · ${size}`;
  const dirs = dirCount > 0 ? ` + ${dirCount} 个空文件夹` : "";
  return `${fileCount} 个文件${dirs} · ${size}`;
}

function getExpiryLabel(share: ShareInfo): string {
  return share.expires_at ? new Date(share.expires_at).toLocaleDateString("zh-CN") : "长期有效";
}

function getDownloadLabel(share: ShareInfo): string {
  return share.max_downloads > 0 ? `${share.download_count} / ${share.max_downloads}` : `${share.download_count} 次`;
}

function getDefaultMobilePanel(share: ShareInfo): MobilePanel {
  return share.files.length === 1 && share.empty_dirs.length === 0 ? "overview" : "files";
}

function getNativeVideoMime(file: ShareFileDownload): string {
  if (file.content_type?.startsWith("video/")) return file.content_type;
  const ext = file.file_name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "mp4": return "video/mp4";
    case "webm": return "video/webm";
    case "ogg":
    case "ogv": return "video/ogg";
    case "mov": return "video/quicktime";
    case "mkv": return "video/x-matroska";
    default: return "video/mp4";
  }
}

function getNativeAudioMime(file: ShareFileDownload): string {
  if (file.content_type?.startsWith("audio/")) return file.content_type;
  const ext = file.file_name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "mp3": return "audio/mpeg";
    case "aac": return "audio/aac";
    case "wav": return "audio/wav";
    case "flac": return "audio/flac";
    case "m4a": return "audio/mp4";
    case "ogg": return "audio/ogg";
    default: return "audio/mpeg";
  }
}

function formatAudioTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainSeconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainSeconds).padStart(2, "0")}`;
  return `${minutes}:${String(remainSeconds).padStart(2, "0")}`;
}

function getAudioErrorMessage(error: MediaError | null): string {
  switch (error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "音频加载已取消，请重新播放。";
    case MediaError.MEDIA_ERR_NETWORK:
      return "音频网络加载失败，请刷新页面或重新获取下载链接。";
    case MediaError.MEDIA_ERR_DECODE:
      return "浏览器解码失败，可能是不支持当前音频编码。";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "浏览器不支持此音频格式或下载链接不可用。";
    default:
      return "音频无法播放，请下载后本地查看。";
  }
}

function getVisualizerBandLevel(data: Uint8Array | null, bandIndex: number, bandCount: number, timestamp: number): number {
  if (!data || data.length === 0) {
    return Math.max(0.035, 0.08 + Math.sin(timestamp / 820 + bandIndex * 0.42) * 0.026);
  }
  const startRatio = bandIndex / bandCount;
  const endRatio = (bandIndex + 1) / bandCount;
  const start = Math.floor(Math.pow(startRatio, 1.9) * (data.length - 1));
  const end = Math.max(start + 1, Math.floor(Math.pow(endRatio, 1.9) * data.length));
  let sum = 0;
  for (let i = start; i < end; i += 1) sum += data[i] || 0;
  const normalized = sum / Math.max(1, end - start) / 255;
  const contour = 0.86 + Math.sin((bandIndex / Math.max(1, bandCount - 1)) * Math.PI) * 0.2;
  return Math.max(0.035, Math.min(1, Math.pow(normalized, 0.58) * contour));
}

function drawAudioVisualizer(canvas: HTMLCanvasElement, data: Uint8Array | null, active: boolean, timestamp: number) {
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width);
  const cssHeight = Math.max(1, rect.height);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.floor(cssWidth * pixelRatio);
  const pixelHeight = Math.floor(cssHeight * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const bandCount = Math.max(96, Math.min(AUDIO_VISUALIZER_BANDS, Math.floor(cssWidth / 5)));
  const levels = Array.from({ length: bandCount }, (_, index) => getVisualizerBandLevel(data, index, bandCount, timestamp));
  const left = Math.max(8, cssWidth * 0.01);
  const right = cssWidth - left;
  const centerY = cssHeight * 0.54;
  const amplitude = cssHeight * (active ? 0.46 : 0.22);
  const energy = levels.reduce((sum, level) => sum + level, 0) / Math.max(1, levels.length);
  const bass = levels.slice(0, Math.max(4, Math.floor(levels.length * 0.16))).reduce((sum, level) => sum + level, 0) / Math.max(1, Math.floor(levels.length * 0.16));
  const glow = active ? 10 + energy * 34 : 8;
  const phase = timestamp / 680;

  const points = levels.map((level, index) => {
    const ratio = index / Math.max(1, bandCount - 1);
    const x = left + ratio * (right - left);
    const shimmer = Math.sin(phase + index * 0.18) * 0.035 + Math.cos(phase * 0.72 + index * 0.07) * 0.025;
    const shaped = Math.max(0.02, Math.min(1, level + shimmer + bass * Math.max(0, 0.42 - ratio) * 0.22));
    return {
      x,
      top: centerY - shaped * amplitude,
      bottom: centerY + shaped * amplitude * 0.62,
      level: shaped,
      ratio,
    };
  });

  const strokePath = (items: typeof points, key: "top" | "bottom") => {
    if (items.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(items[0].x, items[0][key]);
    for (let index = 1; index < items.length - 1; index += 1) {
      const current = items[index];
      const next = items[index + 1];
      ctx.quadraticCurveTo(current.x, current[key], (current.x + next.x) / 2, (current[key] + next[key]) / 2);
    }
    const last = items[items.length - 1];
    ctx.lineTo(last.x, last[key]);
  };

  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  for (let i = 0; i < 6; i += 1) {
    const y = cssHeight * (0.14 + i * 0.14);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const area = new Path2D();
  points.forEach((point, index) => {
    if (index === 0) area.moveTo(point.x, point.top);
    else area.lineTo(point.x, point.top);
  });
  for (let index = points.length - 1; index >= 0; index -= 1) area.lineTo(points[index].x, points[index].bottom);
  area.closePath();
  const fill = ctx.createLinearGradient(0, cssHeight * 0.08, 0, cssHeight);
  fill.addColorStop(0, active ? "rgba(255, 210, 143, 0.42)" : "rgba(255,255,255,0.12)");
  fill.addColorStop(0.44, active ? "rgba(255, 55, 112, 0.2)" : "rgba(255,255,255,0.055)");
  fill.addColorStop(0.8, active ? "rgba(121, 94, 255, 0.12)" : "rgba(255,255,255,0.02)");
  fill.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = fill;
  ctx.fill(area);

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const neon = ctx.createLinearGradient(left, 0, right, 0);
  neon.addColorStop(0, "rgba(255, 220, 154, 0.95)");
  neon.addColorStop(0.34, "rgba(255, 64, 126, 0.98)");
  neon.addColorStop(0.68, "rgba(174, 98, 255, 0.96)");
  neon.addColorStop(1, "rgba(93, 150, 255, 0.9)");

  ctx.strokeStyle = neon;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = active ? "rgba(255, 72, 126, 0.72)" : "rgba(255,255,255,0.18)";
  ctx.shadowBlur = glow;
  ctx.lineWidth = active ? 2.2 : 1.4;
  strokePath(points, "top");
  ctx.stroke();
  ctx.globalAlpha = 0.62;
  ctx.lineWidth = 1.15;
  strokePath(points, "bottom");
  ctx.stroke();

  const ribbonOffsets = [-0.34, 0, 0.34];
  ribbonOffsets.forEach((offset, ribbonIndex) => {
    ctx.globalAlpha = active ? 0.2 - ribbonIndex * 0.035 : 0.08;
    ctx.shadowBlur = glow * (0.55 + ribbonIndex * 0.18);
    ctx.lineWidth = 1.15 + ribbonIndex * 0.55;
    ctx.beginPath();
    points.forEach((point, index) => {
      const ripple = Math.sin(phase * (1.15 + ribbonIndex * 0.22) + index * (0.12 + ribbonIndex * 0.03)) * amplitude * 0.05;
      const y = centerY + offset * amplitude * point.level + ripple;
      if (index === 0) ctx.moveTo(point.x, y);
      else ctx.lineTo(point.x, y);
    });
    ctx.stroke();
  });

  points.forEach((point, index) => {
    if (index % 2 !== 0) return;
    const height = Math.max(3, (point.bottom - point.top) * (0.7 + point.level * 0.38));
    const top = centerY - height / 2;
    const bottom = centerY + height / 2;
    const needle = ctx.createLinearGradient(0, top, 0, bottom);
    needle.addColorStop(0, "rgba(255, 225, 165, 0.34)");
    needle.addColorStop(0.5, "rgba(255, 62, 122, 0.22)");
    needle.addColorStop(1, "rgba(96, 100, 255, 0.08)");
    ctx.strokeStyle = needle;
    ctx.shadowBlur = 0;
    ctx.globalAlpha = active ? 0.78 : 0.28;
    ctx.lineWidth = point.level > 0.55 ? 1.25 : 0.7;
    ctx.beginPath();
    ctx.moveTo(point.x, top);
    ctx.lineTo(point.x, bottom);
    ctx.stroke();
  });

  ctx.globalAlpha = active ? 0.9 : 0.35;
  ctx.shadowColor = "rgba(255, 195, 124, 0.72)";
  ctx.shadowBlur = active ? 13 : 5;
  points.forEach((point, index) => {
    if (index % 4 !== 0) return;
    const orbit = Math.sin(phase * 1.7 + index * 0.23) * Math.max(2, amplitude * 0.025);
    const radius = active ? 0.9 + point.level * 2.1 : 0.8;
    ctx.fillStyle = point.ratio < 0.42 ? "rgba(255, 213, 145, 0.95)" : point.ratio < 0.74 ? "rgba(255, 84, 142, 0.9)" : "rgba(150, 130, 255, 0.88)";
    ctx.beginPath();
    ctx.arc(point.x, point.top + orbit, radius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function isMkvFile(file: ShareFileDownload): boolean {
  return file.file_name.split(".").pop()?.toLowerCase() === "mkv";
}

/** 浏览器原生不支持的音频编码 fourcc / codec tag */
const NATIVE_UNSUPPORTED_AUDIO_RE = /^(ac-3|ec-3|dts[a-z]?)$/;

function hasAudioCodec(file: ShareFileDownload, codecs: Set<string>): boolean {
  const tracks = file.media_metadata?.audio_tracks;
  if (!Array.isArray(tracks)) return false;
  return tracks.some((track) => {
    const values = [track.codec_tag, track.codec]
      .map((value) => `${value || ""}`.toLowerCase())
      .filter(Boolean);
    return values.some((value) => codecs.has(value));
  });
}

function hasAc3Audio(file: ShareFileDownload): boolean {
  return hasAudioCodec(file, new Set(["ac-3", "ac3"]));
}

function hasEac3Audio(file: ShareFileDownload): boolean {
  return hasAudioCodec(file, new Set(["ec-3", "eac3"]));
}

function getPlaybackAssetSessionKey(file: ShareFileDownload): string {
  const chunksKey = file.chunks.map((chunk) => `${chunk.index}:${chunk.size}`).join(",");
  const assetsKey = (file.media_metadata?.playback_assets || [])
    .map((asset) => [
      asset.kind,
      asset.version || "",
      asset.virtual_size || "",
      asset.sidecar_size || "",
      asset.source_media_start || "",
      asset.source_media_end || "",
    ].join(":"))
    .sort()
    .join("|");
  const audioKey = (file.media_metadata?.audio_tracks || [])
    .map((track) => `${track.codec || ""}:${track.codec_tag || ""}`)
    .sort()
    .join("|");
  const hints = file.media_metadata?.playback_hints;
  return [
    file.file_name,
    file.file_size,
    file.content_type || "",
    file.is_chunked ? "chunked" : "single",
    chunksKey,
    file.media_metadata?.probe_status || "",
    file.media_metadata?.container || "",
    hints?.needs_virtual_faststart === true ? "faststart" : "",
    hints?.has_video_only_virtual === true ? "video-only" : "",
    assetsKey,
    audioKey,
  ].join("#");
}

/**
 * 判断 mp4/mov 视频是否需要走 SDP 播放器（不含 MKV，MKV 有独立逻辑）。
 * 当前 SDP 对常规 MP4 的 Range 调度、seek 恢复和 AC-3 音频主时钟仍不如原生
 * video 稳定，因此只默认接管 E-AC-3 MP4；其余 MP4 保留 ?sdp=1 调试入口。
 */
function needsSdpPlayer(file: ShareFileDownload): boolean {
  if (isMkvFile(file)) return false; // MKV 走独立分支
  if (isEac3Mp4(file)) return true;
  if (typeof window === "undefined" || new URLSearchParams(window.location.search).get("sdp") !== "1") return false;
  const meta = file.media_metadata;
  if (!meta || meta.probe_status !== "ok") return false; // 无元数据时走原生兜底
  const hasUnsupportedAudio = (meta.audio_tracks || []).some((t) => {
    const codec = (t.codec_tag || t.codec || "").toLowerCase();
    return NATIVE_UNSUPPORTED_AUDIO_RE.test(codec);
  });
  return hasUnsupportedAudio;
}

function isAc3Mp4(file: ShareFileDownload): boolean {
  if (isMkvFile(file)) return false;
  const meta = file.media_metadata;
  if (!meta || meta.probe_status !== "ok") return false;
  return hasAc3Audio(file);
}

function isEac3Mp4(file: ShareFileDownload): boolean {
  if (isMkvFile(file)) return false;
  const meta = file.media_metadata;
  if (!meta || meta.probe_status !== "ok") return false;
  return hasEac3Audio(file);
}

function UnsupportedVideoPreview({ message, onDownload }: { message: string; onDownload: () => void }) {
  return (
    <div data-testid="unsupported-video-preview" className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="w-16 h-16 rounded-2xl bg-white/6 border border-white/10 flex items-center justify-center text-2xl text-yc-accent">▶</div>
      <div>
        <p className={`font-tech text-sm font-bold tracking-widest ${s.tPrimary}`}>浏览器无法直接预览此视频</p>
        <p className={`mt-2 text-xs leading-5 ${s.tMuted}`}>{message}</p>
      </div>
      <button type="button" onClick={onDownload}
        className={`${s.glowBtn} px-4 py-2.5 font-tech text-xs tracking-widest flex items-center gap-2`}>
        <Download className="w-4 h-4" /> 下载此文件
      </button>
    </div>
  );
}

function ImagePreview({ file, onFailure }: { file: ShareFileDownload; onFailure: () => void }) {
  const primaryUrl = isSafeUrl(file.download_url) ? file.download_url : "";
  const backupUrl = isSafeUrl(file.backup_download_url || "") ? file.backup_download_url || "" : "";
  const [sourceUrl, setSourceUrl] = useState(primaryUrl || backupUrl);

  useEffect(() => setSourceUrl(primaryUrl || backupUrl), [backupUrl, primaryUrl]);
  if (!sourceUrl) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={sourceUrl}
      alt={file.file_name}
      onError={() => {
        if (sourceUrl === primaryUrl && backupUrl && backupUrl !== primaryUrl) {
          setSourceUrl(backupUrl);
          return;
        }
        onFailure();
      }}
      className="max-w-full max-h-full object-contain rounded-lg"
    />
  );
}

const MKV_NATIVE_METADATA_TIMEOUT_MS = 20_000;
const AUDIO_VOLUME_STORAGE_KEY = "nyy-share-audio-volume";
const AUDIO_MUTED_STORAGE_KEY = "nyy-share-audio-muted";
const AUDIO_VISUALIZER_BANDS = 128;

function NativeVideoPreview({
  file,
  onDownload,
  onPlaybackFailure,
  metadataTimeoutMs,
}: {
  file: ShareFileDownload;
  onDownload: () => void;
  onPlaybackFailure?: (message: string) => void;
  metadataTimeoutMs?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [errorMessage, setErrorMessage] = useState("可以先下载文件后本地查看；SDP 自研播放器仍保留，后续继续优化。");
  const [playbackUrl, setPlaybackUrl] = useState(file.download_url);
  const [transportPreparing, setTransportPreparing] = useState(false);
  const [metadataReady, setMetadataReady] = useState(false);
  const [virtualReloadKey, setVirtualReloadKey] = useState(0);
  const [resumeRequest, setResumeRequest] = useState<NativeVideoResumeRequest | null>(null);
  const virtualMediaIdRef = useRef<string | null>(null);
  const fileRef = useRef(file);
  const virtualRecoveryInFlightRef = useRef(false);
  const virtualRecoveryCountRef = useRef(0);
  const virtualRecoverySerialRef = useRef(0);
  const directBackupAttemptedRef = useRef(false);
  if (!virtualMediaIdRef.current) virtualMediaIdRef.current = createVirtualMediaFileId("share-video");
  const mime = getNativeVideoMime(file);
  const useVirtualFaststart = needsVirtualFaststart(file) || needsVideoOnlyVirtualMp4(file);
  const structuralSessionKey = getPlaybackAssetSessionKey(file);
  const playbackSessionKey = useVirtualFaststart ? structuralSessionKey : `${structuralSessionKey}#${file.download_url}`;
  const awaitingVirtualTransport = useVirtualFaststart && playbackUrl === file.download_url && !failed;
  const preparingVirtualTransport = transportPreparing || awaitingVirtualTransport;
  const safeUrl = isSafeUrl(playbackUrl) || playbackUrl.startsWith("/__nyy_virtual_media__/");
  const isVirtualPlaybackUrl = playbackUrl.startsWith("/__nyy_virtual_media__/");

  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  const handlePlaybackFailure = useCallback((message: string) => {
    const videoCodec = file.media_metadata?.video_tracks?.[0]?.codec || "";
    const isHevc = /^(hev1|hvc1|hevc|h265)(\.|$)/i.test(videoCodec);
    const failureMessage = isHevc
      ? `${message} 此视频使用 HEVC/H.265 编码；若当前设备不支持，请下载后使用支持 HEVC 的播放器，或转换为 H.264。`
      : message;
    if (onPlaybackFailure) {
      onPlaybackFailure(failureMessage);
      return;
    }
    setErrorMessage(failureMessage);
    setFailed(true);
  }, [file.media_metadata, onPlaybackFailure]);

  const registerVirtualPlaybackUrl = useCallback(async () => {
    const currentFile = fileRef.current;
    await prepareVirtualMediaTransport();
    return registerVirtualMediaFile(currentFile, "share-video", undefined, virtualMediaIdRef.current || undefined);
  }, []);

  const recoverVirtualTransport = useCallback(async (message: string, info?: NativeVideoErrorInfo) => {
    if (virtualRecoveryInFlightRef.current) return;
    if (virtualRecoveryCountRef.current >= 1) {
      handlePlaybackFailure(message);
      return;
    }
    virtualRecoveryInFlightRef.current = true;
    virtualRecoveryCountRef.current += 1;
    setTransportPreparing(true);
    setFailed(false);
    setErrorMessage("正在恢复视频快启通道…");
    try {
      const url = await registerVirtualPlaybackUrl();
      virtualRecoverySerialRef.current += 1;
      setPlaybackUrl(url);
      setMetadataReady(false);
      setResumeRequest({
        key: virtualRecoverySerialRef.current,
        time: Math.max(0, info?.currentTime || 0),
        play: Boolean(info?.playRequested),
      });
      setVirtualReloadKey((key) => key + 1);
    } catch (err) {
      handlePlaybackFailure(getErrorMessage(err, "虚拟快启播放通道恢复失败，请刷新页面后重试。"));
    } finally {
      virtualRecoveryInFlightRef.current = false;
      setTransportPreparing(false);
    }
  }, [handlePlaybackFailure, registerVirtualPlaybackUrl]);

  const handleNativePlaybackFailure = useCallback((message: string, info: NativeVideoErrorInfo) => {
    if (!useVirtualFaststart
      && playbackUrl === file.download_url
      && isSafeUrl(file.backup_download_url || "")
      && file.backup_download_url !== file.download_url
      && !directBackupAttemptedRef.current) {
      directBackupAttemptedRef.current = true;
      setPlaybackUrl(file.backup_download_url || "");
      setMetadataReady(false);
      return;
    }
    if (useVirtualFaststart && isVirtualPlaybackUrl) {
      void recoverVirtualTransport(message, info);
      return;
    }
    handlePlaybackFailure(message);
  }, [file.backup_download_url, file.download_url, handlePlaybackFailure, isVirtualPlaybackUrl, playbackUrl, recoverVirtualTransport, useVirtualFaststart]);

  const handleNativeLoadedMetadata = useCallback(() => {
    setMetadataReady(true);
    virtualRecoveryCountRef.current = 0;
    directBackupAttemptedRef.current = false;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTransportPreparing(false);
    setMetadataReady(false);
    setFailed(false);
    setResumeRequest(null);
    setVirtualReloadKey((key) => key + 1);
    virtualRecoveryCountRef.current = 0;

    if (!useVirtualFaststart) {
      setPlaybackUrl(fileRef.current.download_url);
      return;
    }

    setTransportPreparing(true);
    registerVirtualPlaybackUrl()
      .then((url) => {
        if (!cancelled) setPlaybackUrl(url);
      })
      .catch((err) => {
        if (cancelled) return;
        handlePlaybackFailure(getErrorMessage(err, "虚拟快启播放通道初始化失败，请刷新页面后重试。"));
      })
      .finally(() => {
        if (!cancelled) setTransportPreparing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [handlePlaybackFailure, playbackSessionKey, registerVirtualPlaybackUrl, useVirtualFaststart]);

  useEffect(() => {
    if (!useVirtualFaststart) return;
    const refreshRegistration = () => {
      if (document.visibilityState !== "visible" || !isVirtualPlaybackUrl) return;
      void registerVirtualPlaybackUrl().catch(() => {});
    };
    document.addEventListener("visibilitychange", refreshRegistration);
    window.addEventListener("focus", refreshRegistration);
    return () => {
      document.removeEventListener("visibilitychange", refreshRegistration);
      window.removeEventListener("focus", refreshRegistration);
    };
  }, [isVirtualPlaybackUrl, registerVirtualPlaybackUrl, useVirtualFaststart]);

  useEffect(() => {
    if (!metadataTimeoutMs || metadataReady || preparingVirtualTransport || failed || !safeUrl) return;
    const timer = window.setTimeout(() => {
      handlePlaybackFailure("原生视频元数据加载超时，已切换到客户端播放兜底。");
    }, metadataTimeoutMs);
    return () => window.clearTimeout(timer);
  }, [failed, handlePlaybackFailure, metadataReady, metadataTimeoutMs, playbackUrl, preparingVirtualTransport, safeUrl]);

  useEffect(() => {
    setFailed(false);
    setErrorMessage("可以先下载文件后本地查看；SDP 自研播放器仍保留，后续继续优化。");
    if (!safeUrl || typeof document === "undefined") return;
    // Chrome 对 video/x-matroska 的 canPlayType 经常返回空字符串，
    // 但实际仍可能播放成功；MKV 必须交给真实 video 加载结果判断。
    if (mime === "video/x-matroska") return;
    const probe = document.createElement("video");
    // HEVC 元数据可能只有 hev1/hvc1 标签，缺少 profile/level；
    // 不据此提前拒绝播放，由实际加载失败时提供兼容性指引。
    if (mime && probe.canPlayType(mime) === "") setFailed(true);
  }, [file.media_metadata, playbackUrl, mime, safeUrl]);

  if (preparingVirtualTransport) {
    return (
      <div data-testid="native-video-preview" className="absolute inset-0 flex items-center justify-center bg-black text-xs text-white/60">
        正在准备视频快启通道…
      </div>
    );
  }

  if (!safeUrl || failed) {
    return (
      <div data-testid="native-video-preview" className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="w-16 h-16 rounded-2xl bg-white/6 border border-white/10 flex items-center justify-center text-2xl text-yc-accent">▶</div>
        <div>
          <p className={`font-tech text-sm font-bold tracking-widest ${s.tPrimary}`}>浏览器无法直接预览此视频</p>
          <p className={`mt-2 text-xs leading-5 ${s.tMuted}`}>{errorMessage}</p>
        </div>
        <button type="button" onClick={onDownload}
          className={`${s.glowBtn} px-4 py-2.5 font-tech text-xs tracking-widest flex items-center gap-2`}>
          <Download className="w-4 h-4" /> 下载此文件
        </button>
      </div>
    );
  }

  return (
    <NativeVideoPlayer
      key={`${playbackUrl}:${virtualReloadKey}`}
      src={playbackUrl}
      type={mime}
      onError={handleNativePlaybackFailure}
      onLoadedMetadata={handleNativeLoadedMetadata}
      resumeRequest={resumeRequest}
    />
  );
}

function MkvVideoPreview({ file, onDownload, debugLog }: { file: ShareFileDownload; onDownload: () => void; debugLog: DebugLogFn }) {
  const [mode, setMode] = useState<"checking" | "native" | "sdp" | "unsupported">("checking");

  useEffect(() => {
    if (typeof document === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (isLiVehicleBrowser(navigator.userAgent)) {
      const sdpSupported = supportsSelfDevelopPlayback();
      debugLog("sdp", "route:li-vehicle", {
        userAgent: navigator.userAgent,
        sdpSupported,
        message: sdpSupported
          ? "检测到理想车机浏览器，绕过不可靠的原生 MKV 声明并强制进入 SDP"
          : "检测到理想车机浏览器，但当前运行环境缺少完整 WebCodecs 能力",
      });
      setMode(sdpSupported ? "sdp" : "unsupported");
      return;
    }
    if (params.get("sdp") === "1") {
      setMode("sdp");
      return;
    }
    if (hasAc3Audio(file) || hasEac3Audio(file)) {
      setMode("sdp");
      return;
    }
    const probe = document.createElement("video");
    const nativeSupport = [getNativeVideoMime(file), "video/x-matroska", "video/matroska"]
      .some((type) => Boolean(type && probe.canPlayType(type)));
    setMode(nativeSupport ? "native" : "sdp");
  }, [debugLog, file]);

  if (mode === "checking") {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black text-xs text-white/60">
        正在检测 MKV 播放能力…
      </div>
    );
  }

  if (mode === "sdp") {
    return (
      <div data-testid="mkv-sdp-preview" className="absolute inset-0">
        <SelfDevelopPlayer file={file} className={s.sdpFill} debugLog={debugLog} />
      </div>
    );
  }

  if (mode === "unsupported") {
    return (
      <div data-testid="li-vehicle-mkv-fallback" className="absolute inset-0">
        <UnsupportedVideoPreview
          message="当前车机浏览器缺少完整 WebCodecs 解码能力，无法在线预览此 MKV。请使用右侧“打开原文件”，或扫码后在手机、电脑下载。"
          onDownload={onDownload}
        />
      </div>
    );
  }

  return (
    <NativeVideoPreview
      file={file}
      onDownload={onDownload}
      metadataTimeoutMs={MKV_NATIVE_METADATA_TIMEOUT_MS}
      onPlaybackFailure={() => setMode("sdp")}
    />
  );
}

function AudioPreview({ file, onDownload }: { file: ShareFileDownload; onDownload: () => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const visualizerCanvasRef = useRef<HTMLCanvasElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const visualizerFrameRef = useRef<number | null>(null);
  const audioVirtualIdRef = useRef<string | null>(null);
  const virtualAudioFallbackAttemptedRef = useRef(false);
  const directAudioBackupAttemptedRef = useRef(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "playing" | "paused" | "ended" | "error">("idle");
  const [playbackUrl, setPlaybackUrl] = useState("");
  const [audioTransportPreparing, setAudioTransportPreparing] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedPct, setBufferedPct] = useState(0);
  const [volume, setVolumeState] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const mime = getNativeAudioMime(file);
  if (!audioVirtualIdRef.current) audioVirtualIdRef.current = createVirtualMediaFileId("share-audio");
  const safeUrl = isSafeUrl(playbackUrl) || isVirtualMediaUrl(playbackUrl);
  const isPlaying = state === "playing";
  const isWaiting = state === "loading" || audioTransportPreparing;
  const playable = duration > 0 && Number.isFinite(duration);
  const progressPct = playable ? Math.max(0, Math.min(100, (currentTime / duration) * 100)) : 0;
  const safeBufferedPct = Math.max(progressPct, bufferedPct);
  const progressStyle: CSSProperties = {
    background: `linear-gradient(90deg, #FF8A3D 0%, #FF8A3D ${progressPct}%, rgba(255,255,255,0.34) ${progressPct}%, rgba(255,255,255,0.34) ${safeBufferedPct}%, rgba(255,255,255,0.14) ${safeBufferedPct}%, rgba(255,255,255,0.14) 100%)`,
  };
  const volumeStyle: CSSProperties = {
    background: `linear-gradient(90deg, #FF8A3D 0%, #FF8A3D ${(isMuted ? 0 : volume) * 100}%, rgba(255,255,255,0.16) ${(isMuted ? 0 : volume) * 100}%, rgba(255,255,255,0.16) 100%)`,
  };

  const persistVolume = useCallback((nextVolume: number, muted: boolean) => {
    try {
      localStorage.setItem(AUDIO_VOLUME_STORAGE_KEY, String(nextVolume));
      localStorage.setItem(AUDIO_MUTED_STORAGE_KEY, String(muted));
    } catch {}
  }, []);

  const syncBuffered = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0 || audio.buffered.length === 0) {
      setBufferedPct(0);
      return;
    }
    const end = audio.buffered.end(audio.buffered.length - 1);
    setBufferedPct(Math.max(0, Math.min(100, (end / audio.duration) * 100)));
  }, []);

  const drawIdleVisualizer = useCallback(() => {
    const canvas = visualizerCanvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    drawAudioVisualizer(canvas, null, false, performance.now());
  }, []);

  const stopVisualizerLoop = useCallback(() => {
    if (visualizerFrameRef.current !== null) {
      window.cancelAnimationFrame(visualizerFrameRef.current);
      visualizerFrameRef.current = null;
    }
  }, []);

  const releaseAudioGraph = useCallback(() => {
    stopVisualizerLoop();
    analyserRef.current?.disconnect();
    audioSourceRef.current?.disconnect();
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    audioSourceRef.current = null;
    analyserRef.current = null;
  }, [stopVisualizerLoop]);

  const resetVisualizer = useCallback(() => {
    stopVisualizerLoop();
    drawIdleVisualizer();
  }, [drawIdleVisualizer, stopVisualizerLoop]);

  const ensureAudioGraph = useCallback(async (): Promise<AnalyserNode | null> => {
    const audio = audioRef.current;
    if (!audio || typeof window === "undefined" || !isAnalyzableAudioUrl(playbackUrl)) return null;
    if (analyserRef.current) {
      await audioContextRef.current?.resume().catch(() => {});
      return analyserRef.current;
    }
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;
    try {
      const context = new AudioContextCtor();
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      analyser.connect(context.destination);
      audioContextRef.current = context;
      audioSourceRef.current = source;
      analyserRef.current = analyser;
      await context.resume().catch(() => {});
      return analyser;
    } catch {
      return null;
    }
  }, [playbackUrl]);

  const startVisualizerLoop = useCallback(() => {
    stopVisualizerLoop();
    const canvas = visualizerCanvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) {
      drawIdleVisualizer();
      return;
    }
    const data = new Uint8Array(analyser.frequencyBinCount);

    const tick = (timestamp: number) => {
      analyser.getByteFrequencyData(data);
      drawAudioVisualizer(canvas, data, true, timestamp);
      visualizerFrameRef.current = window.requestAnimationFrame(tick);
    };

    visualizerFrameRef.current = window.requestAnimationFrame(tick);
  }, [drawIdleVisualizer, stopVisualizerLoop]);

  useEffect(() => {
    let cancelled = false;
    releaseAudioGraph();
    drawIdleVisualizer();
    setPlaybackUrl("");
    setAudioTransportPreparing(true);
    virtualAudioFallbackAttemptedRef.current = false;
    directAudioBackupAttemptedRef.current = false;

    if (!hasSafeAudioSource(file)) {
      setAudioTransportPreparing(false);
      return;
    }

    const audioFile = { ...file, content_type: file.content_type || mime };
    prepareVirtualMediaTransport()
      .then(() => registerVirtualMediaFile(audioFile, "share-audio", undefined, audioVirtualIdRef.current || undefined))
      .then((url) => {
        if (!cancelled) setPlaybackUrl(url);
      })
      .catch(() => {
        if (!cancelled) setPlaybackUrl(file.download_url);
      })
      .finally(() => {
        if (!cancelled) setAudioTransportPreparing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [drawIdleVisualizer, file, mime, releaseAudioGraph]);

  useEffect(() => {
    drawIdleVisualizer();
    if (typeof ResizeObserver === "undefined") return;
    const canvas = visualizerCanvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() => drawIdleVisualizer());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [drawIdleVisualizer, file.file_name]);

  useEffect(() => {
    try {
      const savedVolume = Number(localStorage.getItem(AUDIO_VOLUME_STORAGE_KEY));
      if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) setVolumeState(savedVolume);
      setIsMuted(localStorage.getItem(AUDIO_MUTED_STORAGE_KEY) === "true");
    } catch {}
  }, []);

  useEffect(() => {
    setState("idle");
    setCurrentTime(0);
    setDuration(0);
    setBufferedPct(0);
    setErrorMessage("");
    if (audioTransportPreparing) return;
    if (!safeUrl) {
      setErrorMessage("音频链接无效，请下载后本地查看。");
      setState("error");
      return;
    }
    if (typeof document !== "undefined" && mime) {
      const probe = document.createElement("audio");
      if (probe.canPlayType(mime) === "") {
        setErrorMessage("浏览器不支持此音频格式，请下载后本地查看。");
        setState("error");
      }
    }
  }, [audioTransportPreparing, mime, playbackUrl, safeUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = isMuted;
  }, [isMuted, playbackUrl, volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !safeUrl || audioTransportPreparing || state === "error") return;

    const syncMetadata = () => {
      if (!audio.error) setState(audio.paused ? "ready" : "playing");
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setCurrentTime(audio.currentTime || 0);
      syncBuffered();
    };
    const onTimeUpdate = () => setCurrentTime(audio.currentTime || 0);
    const onProgress = () => syncBuffered();
    const onPlay = () => setState("playing");
    const onPause = () => {
      setState(audio.ended ? "ended" : "paused");
      resetVisualizer();
    };
    const onEnded = () => {
      setState("ended");
      resetVisualizer();
    };
    const onWaiting = () => setState("loading");
    const onPlaying = () => {
      setState("playing");
      void ensureAudioGraph().then((ready) => {
        if (ready) startVisualizerLoop();
      });
    };
    const onCanPlay = () => { if (audio.paused) setState("ready"); };
    const onVolumeChange = () => {
      setVolumeState(audio.volume);
      setIsMuted(audio.muted);
      persistVolume(audio.volume, audio.muted);
    };
    const onAudioError = () => {
      if (isVirtualMediaUrl(playbackUrl) && isSafeUrl(file.download_url) && !virtualAudioFallbackAttemptedRef.current) {
        virtualAudioFallbackAttemptedRef.current = true;
        releaseAudioGraph();
        drawIdleVisualizer();
        setErrorMessage("");
        setState("idle");
        setPlaybackUrl(file.download_url);
        return;
      }
      if (playbackUrl === file.download_url
        && isSafeUrl(file.backup_download_url || "")
        && file.backup_download_url !== file.download_url
        && !directAudioBackupAttemptedRef.current) {
        directAudioBackupAttemptedRef.current = true;
        releaseAudioGraph();
        setErrorMessage("");
        setState("idle");
        setPlaybackUrl(file.backup_download_url || "");
        return;
      }
      setErrorMessage(getAudioErrorMessage(audio.error));
      setState("error");
      resetVisualizer();
    };

    audio.addEventListener("loadedmetadata", syncMetadata);
    audio.addEventListener("durationchange", syncMetadata);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("progress", onProgress);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("canplay", onCanPlay);
    audio.addEventListener("volumechange", onVolumeChange);
    audio.addEventListener("error", onAudioError);

    if (audio.error) onAudioError();
    else if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) syncMetadata();
    else syncBuffered();

    return () => {
      audio.removeEventListener("loadedmetadata", syncMetadata);
      audio.removeEventListener("durationchange", syncMetadata);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("progress", onProgress);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("canplay", onCanPlay);
      audio.removeEventListener("volumechange", onVolumeChange);
      audio.removeEventListener("error", onAudioError);
    };
  }, [audioTransportPreparing, drawIdleVisualizer, ensureAudioGraph, file.backup_download_url, file.download_url, persistVolume, playbackUrl, releaseAudioGraph, resetVisualizer, safeUrl, startVisualizerLoop, state, syncBuffered]);

  useEffect(() => () => {
    releaseAudioGraph();
  }, [releaseAudioGraph]);

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio || !safeUrl || audioTransportPreparing || state === "error") return;
    if (isPlaying) {
      audio.pause();
      return;
    }
    try {
      setState("loading");
      const graphReady = ensureAudioGraph();
      await audio.play();
      if (!audio.paused) setState("playing");
      void graphReady.then((ready) => {
        if (ready && !audio.paused) startVisualizerLoop();
      });
    } catch (err) {
      if (audio.error) return;
      setErrorMessage(getErrorMessage(err, "音频播放失败，请下载后本地查看。"));
      setState("error");
      resetVisualizer();
    }
  };

  const seekTo = (seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !playable) return;
    const next = Math.max(0, Math.min(duration, seconds));
    audio.currentTime = next;
    setCurrentTime(next);
  };

  const setVolume = (next: number) => {
    const safeVolume = Math.max(0, Math.min(1, next));
    const muted = safeVolume === 0;
    setVolumeState(safeVolume);
    setIsMuted(muted);
    persistVolume(safeVolume, muted);
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = safeVolume;
    audio.muted = muted;
  };

  const setMuted = (muted: boolean) => {
    const nextVolume = !muted && volume === 0 ? 0.8 : volume;
    if (nextVolume !== volume) setVolumeState(nextVolume);
    setIsMuted(muted);
    persistVolume(nextVolume, muted);
    const audio = audioRef.current;
    if (!audio) return;
    if (nextVolume !== volume) audio.volume = nextVolume;
    audio.muted = muted;
  };

  return (
    <div data-testid="audio-preview" className={s.audioStage}>
      {safeUrl && state !== "error" && (
        <audio key={playbackUrl} ref={audioRef} src={playbackUrl} preload="metadata" data-testid="audio-element">
          <source src={playbackUrl} type={mime} />
        </audio>
      )}

      <div className={s.audioLayout}>
        <div className={s.audioHero}>
          <div className={s.audioVisualPanel}>
            <div className={s.audioTitleRow}>
              <div className="min-w-0">
                <p className="font-tech text-[10px] font-bold tracking-[0.24em] text-nyy-300 sm:text-[11px]">音频预览</p>
                <p className="mt-1 truncate font-tech text-[17px] font-bold leading-tight tracking-wide text-white sm:text-3xl">{file.file_name}</p>
              </div>
            </div>
            <div className={s.audioCanvasShell}>
              <canvas ref={visualizerCanvasRef} data-testid="audio-visualizer" className={s.audioVisualizerCanvas} aria-hidden="true" />
            </div>
          </div>
        </div>

        {state === "error" ? (
          <div className={s.audioError}>
            <p className="font-tech text-sm font-bold tracking-widest text-white">浏览器无法直接预览此音频</p>
            <p className="mt-2 text-xs leading-5 text-white/58">{errorMessage}</p>
            <button type="button" onClick={onDownload} className={`${s.glowBtn} mt-4 inline-flex items-center gap-2 px-4 py-2.5 font-tech text-xs tracking-widest`}>
              <Download className="h-4 w-4" /> 下载此文件
            </button>
          </div>
        ) : (
          <div data-testid="audio-controls" className={s.audioControls}>
            <div className={s.audioControlRow}>
              <button
                type="button"
                data-testid="audio-play-toggle"
                onClick={() => { void togglePlay(); }}
                disabled={!safeUrl || isWaiting}
                aria-label={isPlaying ? "暂停" : "播放"}
                className={s.audioControlButton}
              >
                {isPlaying ? <Pause className="h-4 w-4 fill-current" /> : <Play className="ml-0.5 h-4 w-4 fill-current" />}
              </button>
              <span className={s.audioTimeLabel}>{formatAudioTime(currentTime)}</span>
              <input
                type="range"
                data-testid="audio-progress"
                min={0}
                max={duration || 0}
                step={0.1}
                value={Number.isFinite(currentTime) ? currentTime : 0}
                disabled={!playable}
                aria-label="音频播放进度"
                onChange={(event) => seekTo(Number(event.target.value))}
                className={`${s.audioRange} ${s.audioProgressRange}`}
                style={progressStyle}
              />
              <span className={s.audioTimeLabel}>{formatAudioTime(duration)}</span>
              <div className={s.audioVolumeGroup}>
                <button
                  type="button"
                  onClick={() => setMuted(!(isMuted || volume === 0))}
                  aria-label={isMuted || volume === 0 ? "取消静音" : "静音"}
                  className={s.audioControlButton}
                >
                  {isMuted || volume === 0 ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={(event) => setVolume(Number(event.target.value))}
                  aria-label="音量"
                  className={`${s.audioRange} ${s.audioVolumeRange}`}
                  style={volumeStyle}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ShareViewer({ code, mode = "public" }: ShareViewerProps) {
  const isAdminPreview = mode === "admin";
  const { showToast } = useToast();

  // ===== 页面状态 =====
  const [pageState, setPageState] = useState<PageState>("loading");
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [downloads, setDownloads] = useState<ShareFileDownload[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwVerifying, setPwVerifying] = useState(false);
  const [pwFocused, setPwFocused] = useState(false);
  const [pwShake, setPwShake] = useState(false);
  const [pwDissolving, setPwDissolving] = useState(false);
  const [pwDigitTick, setPwDigitTick] = useState(0);
  const pwInputRef = useRef<HTMLInputElement>(null);
  const pwLatestRef = useRef("");
  const pwVerifyInFlightRef = useRef(false);
  const pwVerifyTimerRef = useRef<number | null>(null);
  const pwErrorTimersRef = useRef<number[]>([]);
  const reportDialogRef = useRef<HTMLDivElement>(null);
  const reportCloseRef = useRef<HTMLButtonElement>(null);
  const reportTriggerRef = useRef<HTMLButtonElement>(null);
  const galleryDetailsCloseRef = useRef<HTMLButtonElement>(null);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<SmartDownloadProgress | null>(null);
  const [downloadBatchProgress, setDownloadBatchProgress] = useState<BatchDownloadProgress | null>(null);
  const [downloadProgressFile, setDownloadProgressFile] = useState<ShareFileDownload | null>(null);
  const [downloadTaskState, setDownloadTaskState] = useState<DownloadTaskState>("idle");
  const [downloadHudExpanded, setDownloadHudExpanded] = useState(false);
  const [downloadCancelArmed, setDownloadCancelArmed] = useState(false);
  const [downloadPreviewSuspended, setDownloadPreviewSuspended] = useState(false);
  const [downloadConfig, setDownloadConfig] = useState<DownloadConfig>(() => defaultDownloadConfig());
  const [directoryDownloadSupported, setDirectoryDownloadSupported] = useState(false);
  const [liVehicleBrowser, setLiVehicleBrowser] = useState(false);
  const [mobileBrowser, setMobileBrowser] = useState(false);
  const [weChatEnvironment, setWeChatEnvironment] = useState<WeChatEnvironment | null>(null);
  const [weChatNoticeDismissed, setWeChatNoticeDismissed] = useState(false);
  const [qr, setQr] = useState("");
  const [reported, setReported] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [downloadState, setDownloadState] = useState<DownloadLinksState>("idle");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("files");
  const [previewErrorKey, setPreviewErrorKey] = useState<string | null>(null);
  const [adminStatus, setAdminStatus] = useState<AdminShareView["status"] | null>(null);
  const [galleryDetailsOpen, setGalleryDetailsOpen] = useState(false);
  const [galleryState, setGalleryState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [gallerySession, setGallerySession] = useState<GallerySessionResponse | null>(null);
  const [galleryRequest, setGalleryRequest] = useState<{ password?: string } | null>(null);
  const [selectedGalleryIndices, setSelectedGalleryIndices] = useState<Set<number>>(() => new Set());
  const [currentGalleryIndex, setCurrentGalleryIndex] = useState<number | null>(null);

  const downloadAbortRef = useRef<AbortController | null>(null);
  const galleryDownloadInFlightRef = useRef(false);
  const humanInteractionRecordedRef = useRef(false);
  const autoFetchStartedRef = useRef(false);

  const appendDebugLog = useCallback<DebugLogFn>(() => {}, []);

  const FooterSlogan = () => (
    <p className={`mt-16 mb-8 text-center font-tech text-[10px] tracking-[0.12em] ${s.tFaint}`}>
      {BRAND_SLOGAN_SHORT} · <a href="https://nyy.app" className="inline-flex min-h-[44px] items-center text-nyy-300 transition-colors hover:text-nyy-200">{BRAND_DOMAIN}</a>
    </p>
  );

  // ===== 初始化:获取分享信息 =====
  useEffect(() => {
    if (!code) return;
    const request = isAdminPreview ? getAdminShareView(code) : getShareInfo(code);
    request
      .then((data) => {
        const shouldUseGallery = !isAdminPreview && !data.has_password && data.gallery_eligible === true;
        const shouldAutoFetch = !shouldUseGallery && (isAdminPreview || !data.has_password);
        setShare(data);
        if (isAdminPreview) setAdminStatus((data as AdminShareView).status);
        setMobilePanel(getDefaultMobilePanel(data));
        setDownloadState(shouldAutoFetch ? "loading" : "idle");
        setGalleryState(shouldUseGallery ? "loading" : "idle");
        setGalleryRequest(shouldUseGallery ? {} : null);
        setGallerySession(null);
        setSelectedGalleryIndices(new Set());
        setCurrentGalleryIndex(null);
        setPageState(!isAdminPreview && data.has_password ? "locked" : "ready");
        if (!isAdminPreview) window.requestAnimationFrame(() => { void recordShareInteraction(code, "page_rendered").catch(() => {}); });
        if (shouldAutoFetch) void autoFetchDownloads();
      })
      .catch((err) => {
        if (isAdminPreview && (isHttpStatusError(err, 401) || isHttpStatusError(err, 403))) setPageState("unauthorized");
        else if (isHttpStatusError(err, 410)) setPageState("expired");
        else if (isHttpStatusError(err, 404)) setPageState("not_found");
        else setPageState("error");
      });
  }, [code, isAdminPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isAdminPreview || !code) return;
    humanInteractionRecordedRef.current = false;
    const record = (event: PointerEvent | KeyboardEvent) => {
      if (!event.isTrusted || humanInteractionRecordedRef.current) return;
      if (event instanceof KeyboardEvent && !["Enter", " ", "Spacebar"].includes(event.key)) return;
      humanInteractionRecordedRef.current = true;
      window.removeEventListener("pointerdown", record);
      window.removeEventListener("keydown", record);
      void recordShareInteraction(code, "human_interaction").catch(() => {});
    };
    window.addEventListener("pointerdown", record, { passive: true });
    window.addEventListener("keydown", record);
    return () => {
      window.removeEventListener("pointerdown", record);
      window.removeEventListener("keydown", record);
    };
  }, [code, isAdminPreview]);

  useEffect(() => {
    let cancelled = false;
    getPublicDownloadConfig()
      .then((config) => { if (!cancelled) setDownloadConfig(config); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setDirectoryDownloadSupported(supportsDirectoryPicker());
    setLiVehicleBrowser(isLiVehicleBrowser(navigator.userAgent));
    setMobileBrowser(isMobileBrowser(navigator.userAgent));
    const environment = detectWeChatEnvironment(navigator.userAgent);
    setWeChatEnvironment(environment);
    if (environment) {
      try {
        setWeChatNoticeDismissed(sessionStorage.getItem("nyy-wechat-download-notice-dismissed") === "1");
      } catch {
        setWeChatNoticeDismissed(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!mobileBrowser) return;
    setSelectedGalleryIndices(new Set());
  }, [mobileBrowser]);

  const dismissWeChatNotice = () => {
    setWeChatNoticeDismissed(true);
    try {
      sessionStorage.setItem("nyy-wechat-download-notice-dismissed", "1");
    } catch {
      return;
    }
  };

  useEffect(() => {
    if (!galleryDetailsOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusFrame = window.requestAnimationFrame(() => galleryDetailsCloseRef.current?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setGalleryDetailsOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, [galleryDetailsOpen]);

  useEffect(() => {
    if (!reportOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const trigger = reportTriggerRef.current;
    const focusFrame = window.requestAnimationFrame(() => reportCloseRef.current?.focus());
    const handleDialogKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setReportOpen(false);
        return;
      }
      if (event.key !== "Tab" || !reportDialogRef.current) return;
      const focusable = Array.from(reportDialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleDialogKey);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKey);
      (trigger || previousFocus)?.focus();
    };
  }, [reportOpen]);

  // 提取码输入框自动聚焦
  useEffect(() => {
    if (pageState === "locked" && pwInputRef.current) {
      const timer = setTimeout(() => {
        pwInputRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [pageState]);

  useEffect(() => {
    if (!downloadConfig.leave_warning_enabled || !downloadProgress || downloadTaskState !== "running") return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [downloadConfig.leave_warning_enabled, downloadProgress, downloadTaskState]);

  // QR 二维码
  useEffect(() => {
    import("qrcode").then((QRCode) => QRCode.toDataURL(getPublicShareUrl(code), { margin: 1, width: 180 }))
      .then(setQr)
      .catch(() => {});
  }, [code]);

  // 自动获取下载 URL（无密码时）
  const autoFetchDownloads = async () => {
    if (autoFetchStartedRef.current) return;
    autoFetchStartedRef.current = true;
    try {
      const res = isAdminPreview
        ? await getAdminShareContent(code)
        : await downloadShare(code, createLinkRequestId(), { intent: "preview" });
      setDownloads(res.files);
      setDownloadState("ready");
    } catch (err) {
      // 预览不可用，但不阻塞页面——用户仍可通过下载按钮获取
      setDownloadState("error");
      if (isAdminPreview) showToast({ title: getErrorMessage(err, "管理员预览链接获取失败"), type: "error" });
    }
  };

  useEffect(() => {
    if (!galleryRequest || isAdminPreview || !code) return;
    let cancelled = false;
    let pollTimer: number | null = null;
    const abortController = new AbortController();
    let latestSession: GallerySessionResponse | null = null;
    let refreshAllAssetsAt = 0;
    let consecutiveFailures = 0;

    const pollGallery = async (forceAssetRefresh = false) => {
      try {
        const refreshAllAssets = forceAssetRefresh || latestSession === null || Date.now() >= refreshAllAssetsAt;
        const knownReadyIndices = refreshAllAssets ? [] : (latestSession?.files || [])
          .filter((file) => file.status === "ready" && file.assets.length > 0)
          .map((file) => file.index);
        const response = await getGallerySession(
          code,
          galleryRequest.password,
          abortController.signal,
          knownReadyIndices,
        );
        if (cancelled) return;
        if (!response.eligible) {
          setGallerySession(response);
          setGalleryState("error");
          return;
        }

        const previousFiles = new Map(latestSession?.files.map((file) => [file.index, file]) || []);
        const mergedResponse: GallerySessionResponse = {
          ...response,
          files: response.files.map((file) => {
            const previous = previousFiles.get(file.index);
            return {
              ...file,
              assets: file.assets.length === 0 && previous?.assets.length ? previous.assets : file.assets,
            };
          }),
        };
        latestSession = mergedResponse;
        consecutiveFailures = 0;
        if (refreshAllAssets) {
          refreshAllAssetsAt = Date.now() + Math.max(60, (response.expires_in || 3600) - 60) * 1000;
        }
        setGallerySession(mergedResponse);
        setGalleryState("ready");
        setSelectedGalleryIndices((current) => {
          const available = new Set(mergedResponse.files.map((file) => file.index));
          return new Set(Array.from(current).filter((index) => available.has(index)));
        });
        setCurrentGalleryIndex((current) => {
          if (current !== null && mergedResponse.files.some((file) => file.index === current)) return current;
          return mergedResponse.files.find((file) => file.status === "ready")?.index ?? mergedResponse.files[0]?.index ?? null;
        });
        if (response.pending_count > 0) {
          const retryDelay = Math.max(0.1, response.retry_after_seconds || 1) * 1000;
          pollTimer = window.setTimeout(() => { void pollGallery(); }, retryDelay);
        } else {
          const refreshDelay = Math.max(1000, refreshAllAssetsAt - Date.now());
          pollTimer = window.setTimeout(() => { void pollGallery(true); }, refreshDelay);
        }
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        if (latestSession?.eligible) {
          consecutiveFailures += 1;
          if (consecutiveFailures === 1) {
            showToast({ title: "图片画廊更新暂时失败，正在自动重试", type: "warning" });
          }
          const retryDelay = Math.min(30, 2 ** consecutiveFailures) * 1000;
          pollTimer = window.setTimeout(() => { void pollGallery(); }, retryDelay);
          return;
        }
        setGalleryState("error");
        showToast({ title: getErrorMessage(error, "图片画廊加载失败，已回退到普通分享页"), type: "warning" });
      }
    };

    void pollGallery();
    return () => {
      cancelled = true;
      abortController.abort();
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [code, galleryRequest, isAdminPreview]); // eslint-disable-line react-hooks/exhaustive-deps

  // 同步 ref 与 state（handleVerify 通过 ref 读取最新值，避免闭包陷阱）
  useEffect(() => { pwLatestRef.current = pwInput; }, [pwInput]);

  // ===== 密码验证 =====
  const clearPasswordErrorTimers = () => {
    pwErrorTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    pwErrorTimersRef.current = [];
  };

  const handleVerify = async () => {
    const latestPw = pwLatestRef.current;
    if (latestPw.length !== 4) { setPwError("请输入4位提取码"); return; }
    if (pwVerifyInFlightRef.current) return;
    pwVerifyInFlightRef.current = true;
    clearPasswordErrorTimers();
    setPwVerifying(true);
    setPwError("");
    try {
      const unlocked = await unlockShare(code, latestPw);
      const shouldUseGallery = unlocked.gallery_eligible === true;
      setShare(unlocked);
      if (shouldUseGallery) {
        setDownloads([]);
        setDownloadState("idle");
      } else {
        const res = await verifyShare(code, latestPw, createLinkRequestId(), { intent: "preview" });
        setDownloads(res.files);
        setDownloadState("ready");
      }
      setGalleryState(shouldUseGallery ? "loading" : "idle");
      setGalleryRequest(shouldUseGallery ? { password: latestPw } : null);
      setPageState("ready");
      appendDebugLog("page", "verify:ok", { files: unlocked.files.length });
    } catch (err) {
      if (pwLatestRef.current !== latestPw) return;
      appendDebugLog("page", "verify:fail", { error: getErrorMessage(err) });
      const errorMsg = getErrorMessage(err, "提取码错误");
      // 阶段 1: 立即 — 抖动 + 红色 + 错误文字淡入
      setPwError(errorMsg);
      setPwShake(true);
      setPwDissolving(false);
      // 阶段 2: 350ms — 抖动结束，数字消散
      const dissolveTimer = window.setTimeout(() => {
        setPwDissolving(true);
      }, 350);
      // 阶段 3: 550ms — 清空输入 + 清空错误文字 + 回聚焦
      const resetTimer = window.setTimeout(() => {
        setPwShake(false);
        setPwDissolving(false);
        setPwInput("");
        setPwError("");
        pwInputRef.current?.focus();
      }, 550);
      pwErrorTimersRef.current = [dissolveTimer, resetTimer];
    } finally {
      pwVerifyInFlightRef.current = false;
      setPwVerifying(false);
    }
  };

  const scheduleVerify = () => {
    if (pwVerifyTimerRef.current !== null) window.clearTimeout(pwVerifyTimerRef.current);
    pwVerifyTimerRef.current = window.setTimeout(() => {
      pwVerifyTimerRef.current = null;
      void handleVerify();
    }, 80);
  };

  useEffect(() => () => {
    if (pwVerifyTimerRef.current !== null) window.clearTimeout(pwVerifyTimerRef.current);
    clearPasswordErrorTimers();
  }, []);

  // ===== 密码输入：自动聚焦（排除错误清空中） =====
  useEffect(() => {
    if (pageState === "locked" && !pwShake && !pwDissolving) {
      const timer = setTimeout(() => { pwInputRef.current?.focus(); }, 120);
      return () => clearTimeout(timer);
    }
  }, [pageState, pwShake, pwDissolving]);

  // ===== 获取下载 URL（密码已验证或无密码时） =====
  const fetchDownloadUrls = async (
    intent: "preview" | "download" = "preview",
    fileIndices?: number[],
  ): Promise<{ files: ShareFileDownload[]; emptyDirs: string[] } | null> => {
    const requestId = createLinkRequestId();
    const updatePreviewState = intent === "preview";
    const delivery = intent === "download"
      && typeof navigator !== "undefined"
      && detectWeChatEnvironment(navigator.userAgent)
      ? "same_origin"
      : "direct";
    try {
      if (updatePreviewState) setDownloadState("loading");
      if (isAdminPreview) {
        const res = await getAdminShareContent(code);
        if (updatePreviewState) setDownloadState("ready");
        return { files: res.files, emptyDirs: res.empty_dirs };
      } else if (share?.has_password) {
        const res = await verifyShare(code, pwLatestRef.current, requestId, { intent, delivery, fileIndices });
        if (updatePreviewState) setDownloadState("ready");
        return { files: res.files, emptyDirs: res.empty_dirs };
      } else {
        const res = await downloadShare(code, requestId, { intent, delivery, fileIndices });
        if (updatePreviewState) setDownloadState("ready");
        return { files: res.files, emptyDirs: res.empty_dirs };
      }
    } catch (err) {
      if (updatePreviewState) setDownloadState("error");
      const message = getErrorMessage(err, "获取下载链接失败");
      setPwError(message);
      showToast({ title: message, type: "error" });
      return null;
    }
  };

  // ===== 下载 =====
  const handleFetchDownloadLinks = async () => {
    if (!share) return;
    setDownloading(true);
    setPwError("");
    const intent = galleryState === "error" ? "download" : "preview";
    const res = await fetchDownloadUrls(intent);
    if (!res) { setDownloading(false); return; }
    setDownloads(res.files);
    if (intent === "download" && !isAdminPreview) {
      setShare((current) => current ? { ...current, download_count: current.download_count + 1 } : current);
    }
    setDownloading(false);
  };

  const handleDownloadAll = async () => {
    if (!share) return;
    if (share.files.length === 0 && share.empty_dirs.length === 0) return;
    if (!downloadConfig.smart_download_enabled || !downloadConfig.filesystem_access_enabled || !directoryDownloadSupported) {
      showToast({
        title: !downloadConfig.smart_download_enabled || !downloadConfig.filesystem_access_enabled
          ? "批量保存到文件夹已关闭，请逐个下载文件。"
          : "当前浏览器不支持批量保存到文件夹，请逐个下载文件。",
        type: "warning",
        duration: 8000,
      });
      return;
    }
    let directory;
    try {
      directory = await pickDownloadDirectory();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      showToast({ title: getErrorMessage(err, "无法选择保存文件夹"), type: "error" });
      return;
    }
    const downloadResponse = await fetchDownloadUrls("download");
    if (!downloadResponse) return;
    const filesToDownload = downloadResponse.files.map((file) => file.proxy_download_url ? {
      ...file,
      download_url: new URL(file.proxy_download_url, window.location.origin).toString(),
      backup_download_url: "",
    } : file);
    const emptyDirs = downloadResponse.emptyDirs;
    if (!isAdminPreview) {
      setShare((current) => current ? { ...current, download_count: current.download_count + 1 } : current);
    }
    downloadAbortRef.current?.abort();
    const abortController = new AbortController();
    downloadAbortRef.current = abortController;
    let lastProgress: SmartDownloadProgress | null = null;
    let lastBatchProgress: BatchDownloadProgress | null = null;
    setDownloading(true);
    setPwError("");
    setDownloadCancelArmed(false);
    setDownloadProgress(null);
    setDownloadBatchProgress(null);
    setDownloadHudExpanded(false);
    setDownloadProgressFile(filesToDownload[0] || null);
    setDownloadTaskState(filesToDownload.length > 0 ? "running" : "idle");
    setDownloadPreviewSuspended(filesToDownload.some(shouldSuspendPreviewForDownload));
    try {
      await downloadFilesToDirectoryHandle(directory, filesToDownload, {
        config: downloadConfig,
        emptyDirs,
        signal: abortController.signal,
        debugLog: appendDebugLog,
        onFileStart: (file) => {
          setDownloadProgressFile(file);
          setDownloadPreviewSuspended(shouldSuspendPreviewForDownload(file));
        },
        onProgress: (progress) => {
          if (!progress) return;
          lastProgress = progress;
          setDownloadProgress(progress);
        },
        onBatchProgress: (progress) => {
          lastBatchProgress = progress;
          setDownloadBatchProgress(progress);
        },
        concurrency: 3,
      });
      const completedProgress = lastProgress as SmartDownloadProgress | null;
      if (completedProgress) {
        setDownloadProgress({ ...completedProgress, downloadedBytes: completedProgress.totalBytes, bytesPerSecond: 0 });
        setDownloadTaskState("completed");
      } else {
        setDownloadProgress(null);
        setDownloadProgressFile(null);
        setDownloadTaskState("idle");
        showToast({ title: "空文件夹已保存", type: "success" });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setDownloadProgress(null);
        setDownloadBatchProgress(null);
        setDownloadProgressFile(null);
        setDownloadTaskState("idle");
        showToast({ title: "下载已取消", type: "info" });
      } else {
        if (lastBatchProgress) {
          setDownloadBatchProgress(lastBatchProgress);
          setDownloadTaskState("failed");
        } else {
          setDownloadProgress(null);
          setDownloadProgressFile(null);
          setDownloadTaskState("idle");
        }
        showToast({ title: getErrorMessage(err, "批量保存失败"), type: "error" });
      }
    } finally {
      if (downloadAbortRef.current === abortController) downloadAbortRef.current = null;
      setDownloadPreviewSuspended(false);
      setDownloading(false);
    }
  };

  const handleGalleryDownload = async (requestedIndices: number[]) => {
    if (!share || requestedIndices.length === 0) return;
    const availableIndices = new Set(share.files.map((file) => file.index));
    const fileIndices = Array.from(new Set(requestedIndices)).filter((index) => availableIndices.has(index));
    if (fileIndices.length === 0) return;
    if (galleryDownloadInFlightRef.current || downloading) return;
    galleryDownloadInFlightRef.current = true;

    const isBatch = fileIndices.length > 1;
    if (isBatch && (!downloadConfig.smart_download_enabled || !downloadConfig.filesystem_access_enabled || !directoryDownloadSupported)) {
      showToast({
        title: "当前浏览器不支持将多个文件一次保存到文件夹，请在下方逐个下载原文件。不会生成 ZIP，也不会自动弹出多个下载。",
        type: "warning",
        duration: 9000,
      });
      galleryDownloadInFlightRef.current = false;
      return;
    }

    let directory;
    if (isBatch) {
      try {
        directory = await pickDownloadDirectory();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          galleryDownloadInFlightRef.current = false;
          return;
        }
        showToast({ title: getErrorMessage(error, "无法选择保存文件夹"), type: "error" });
        galleryDownloadInFlightRef.current = false;
        return;
      }
    }

    setDownloading(true);
    setPwError("");
    const response = await fetchDownloadUrls("download", fileIndices);
    if (!response) {
      setDownloading(false);
      galleryDownloadInFlightRef.current = false;
      return;
    }

    const files = response.files.map((file) => file.proxy_download_url ? {
      ...file,
      download_url: new URL(file.proxy_download_url, window.location.origin).toString(),
      backup_download_url: "",
    } : file);
    setShare((current) => current ? { ...current, download_count: current.download_count + 1 } : current);

    downloadAbortRef.current?.abort();
    const abortController = new AbortController();
    downloadAbortRef.current = abortController;
    let lastProgress: SmartDownloadProgress | null = null;
    let lastBatchProgress: BatchDownloadProgress | null = null;
    setDownloadCancelArmed(false);
    setDownloadProgress(null);
    setDownloadBatchProgress(null);
    setDownloadHudExpanded(false);
    setDownloadProgressFile(files[0] || null);
    setDownloadTaskState(files.length > 0 ? "running" : "idle");
    try {
      const progressOptions = {
        config: downloadConfig,
        signal: abortController.signal,
        debugLog: appendDebugLog,
        onProgress: (progress: SmartDownloadProgress | null) => {
          if (!progress) return;
          lastProgress = progress;
          setDownloadProgress(progress);
        },
        onBatchProgress: (progress: BatchDownloadProgress) => {
          lastBatchProgress = progress;
          setDownloadBatchProgress(progress);
        },
      };
      if (isBatch && directory) {
        await downloadFilesToDirectoryHandle(directory, files, {
          ...progressOptions,
          onFileStart: (file) => setDownloadProgressFile(file),
          concurrency: 3,
        });
      } else if (files[0]) {
        await downloadSmart(files[0], {
          ...progressOptions,
          onUnsupported: (message) => showToast({ title: message, type: "warning", duration: 6000 }),
        });
      }

      const completedProgress = lastProgress as SmartDownloadProgress | null;
      if (completedProgress) {
        setDownloadProgress({ ...completedProgress, downloadedBytes: completedProgress.totalBytes, bytesPerSecond: 0 });
        setDownloadTaskState("completed");
      } else {
        setDownloadProgress(null);
        setDownloadProgressFile(null);
        setDownloadTaskState("idle");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setDownloadProgress(null);
        setDownloadBatchProgress(null);
        setDownloadProgressFile(null);
        setDownloadTaskState("idle");
        showToast({ title: "下载已取消", type: "info" });
      } else {
        if (lastBatchProgress) {
          setDownloadBatchProgress(lastBatchProgress);
          setDownloadTaskState("failed");
        } else {
          setDownloadProgress(null);
          setDownloadProgressFile(null);
          setDownloadTaskState("idle");
        }
        showToast({ title: getErrorMessage(error, isBatch ? "批量保存失败" : "下载失败"), type: "error" });
      }
    } finally {
      if (downloadAbortRef.current === abortController) downloadAbortRef.current = null;
      setDownloading(false);
      galleryDownloadInFlightRef.current = false;
    }
  };

  const handleCopyLink = () => {
    const text = getPublicShareUrl(code);
    if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text); }
    else { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); }
    showToast({ title: "链接已复制", type: "success" });
  };

  const handleCopyOriginalLink = async (file: ShareFileDownload) => {
    if (file.is_chunked || !isSafeUrl(file.download_url)) {
      showToast({ title: "原文件链接无效", type: "error" });
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(file.download_url);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = file.download_url;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    showToast({ title: "原文件链接已复制", type: "success" });
  };

  // 下载单个文件（文件列表行内图标使用）
  const downloadOneFile = async (file: ShareFileDownload | undefined, fileIndex = 0) => {
    setDownloading(true);
    let downloadFile = file;
    if (!isAdminPreview) {
      const downloadResponse = await fetchDownloadUrls("download");
      if (!downloadResponse) {
        setDownloading(false);
        return;
      }
      downloadFile = downloadResponse.files[Math.min(fileIndex, downloadResponse.files.length - 1)];
      if (downloadFile?.proxy_download_url) {
        downloadFile = {
          ...downloadFile,
          download_url: new URL(downloadFile.proxy_download_url, window.location.origin).toString(),
          backup_download_url: "",
        };
      }
      setShare((current) => current ? { ...current, download_count: current.download_count + 1 } : current);
    }
    if (!downloadFile) { setDownloading(false); return; }
    if (!downloadFile.is_chunked && !isSafeUrl(downloadFile.download_url)) { setDownloading(false); showToast({ title: "下载链接无效", type: "error" }); return; }
    if (downloadFile.is_chunked && !downloadFile.chunks.every((chunk) => isSafeUrl(chunk.download_url))) { setDownloading(false); showToast({ title: "下载链接无效", type: "error" }); return; }
    if (liVehicleBrowser && !downloadFile.is_chunked) {
      window.location.assign(downloadFile.download_url);
      return;
    }
    downloadAbortRef.current?.abort();
    const abortController = new AbortController();
    downloadAbortRef.current = abortController;
    let lastProgress: SmartDownloadProgress | null = null;
    setDownloadProgress(null);
    setDownloadBatchProgress(null);
    setDownloadHudExpanded(false);
    setDownloadProgressFile(downloadFile);
    setDownloadTaskState("running");
    setDownloadPreviewSuspended(shouldSuspendPreviewForDownload(downloadFile));
    try {
      await downloadSmart(downloadFile, {
        config: downloadConfig,
        signal: abortController.signal,
        onProgress: (progress) => {
          if (!progress) return;
          lastProgress = progress;
          setDownloadProgress(progress);
        },
        debugLog: appendDebugLog,
        onUnsupported: (message) => showToast({ title: message, type: "warning", duration: 6000 }),
      });
      const completedProgress = lastProgress as SmartDownloadProgress | null;
      if (completedProgress) {
        setDownloadProgress({ ...completedProgress, downloadedBytes: completedProgress.totalBytes, bytesPerSecond: 0 });
        setDownloadTaskState("completed");
      } else {
        setDownloadProgress(null);
        setDownloadProgressFile(null);
        setDownloadTaskState("idle");
      }
    } catch (err) {
      setDownloadProgress(null);
      setDownloadProgressFile(null);
      setDownloadTaskState("idle");
      if (err instanceof DOMException && err.name === "AbortError") {
        showToast({ title: "下载已取消", type: "info" });
      } else {
        showToast({ title: getErrorMessage(err, "下载失败"), type: "error" });
      }
    } finally {
      if (downloadAbortRef.current === abortController) downloadAbortRef.current = null;
      setDownloadPreviewSuspended(false);
      setDownloading(false);
    }
  };

  const handleSingleDocumentDownload = async () => {
    setPwError("");
    await downloadOneFile(downloads[0], 0);
  };

  const handleCancelDownload = () => {
    downloadAbortRef.current?.abort();
  };

  const handleDismissDownloadHud = () => {
    setDownloadProgress(null);
    setDownloadBatchProgress(null);
    setDownloadProgressFile(null);
    setDownloadTaskState("idle");
    setDownloadCancelArmed(false);
    setDownloadHudExpanded(false);
  };

  useEffect(() => {
    if (!downloadCancelArmed) return;
    const timeout = window.setTimeout(() => setDownloadCancelArmed(false), 3000);
    return () => window.clearTimeout(timeout);
  }, [downloadCancelArmed]);

  const handleReport = async () => {
    if (!reportReason.trim()) return;
    try { await reportShare(code, reportReason.trim()); setReported(true); setReportOpen(false); setReportReason(""); showToast({ title: "举报已提交", type: "success" }); }
    catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
  };

  // ===== 选中文件预览 =====
  const selectedMeta = share && share.files.length > 0 ? share.files[Math.min(selectedIdx, share.files.length - 1)] : null;
  const selectedFile = downloads.length > 0 ? downloads[Math.min(selectedIdx, downloads.length - 1)] : null;
  const selectedType = classifyFile(selectedFile?.file_name || selectedMeta?.file_name || "");
  const selectedUsesDocumentStage = isDocumentStage(selectedType) || isOfficeDownloadOnly(selectedFile?.file_name || selectedMeta?.file_name || "");
  const inlineDocumentUrl = selectedFile && !selectedFile.is_chunked
    ? isSafeUrl(selectedFile.download_url)
      ? selectedFile.download_url
      : isSafeUrl(selectedFile.backup_download_url || "")
        ? selectedFile.backup_download_url || ""
        : ""
    : "";
  const inlineDocumentBackupUrl = selectedFile
    && isSafeUrl(selectedFile.backup_download_url || "")
    && selectedFile.backup_download_url !== inlineDocumentUrl
    ? selectedFile.backup_download_url || ""
    : "";
  const hasSafeInlineDocumentUrl = Boolean(inlineDocumentUrl);
  const selectedPreviewKey = selectedFile ? `${selectedFile.file_name}:${selectedFile.download_url || ""}` : "";
  const previewLoadFailed = Boolean(selectedPreviewKey && previewErrorKey === selectedPreviewKey);
  // 选中文件的“元信息”：share.files 在第一阶段（getShareInfo）就有 file_name/file_size，
  // 据此让文件名+操作栏区域提前以恒定高度渲染，避免 downloads 后到时把布局挤开。
  const downloadProgressRatio = downloadProgress ? getProgressRatio(downloadProgress) : 0;
  const downloadProgressPercentLabel = downloadProgress ? getDownloadPercentLabel(downloadProgress, downloadTaskState) : "0%";
  const downloadProgressName = downloadProgress?.currentFileName || downloadProgressFile?.file_name || selectedMeta?.file_name || "正在下载的文件";
  const downloadSpeedLabel = downloadTaskState === "completed" ? "已完成" : downloadTaskState === "failed" ? "部分失败" : downloadProgress ? formatSpeed(downloadProgress.bytesPerSecond) : "计算中";
  const downloadEtaLabel = downloadProgress && downloadProgress.bytesPerSecond > 0
    ? formatDuration((Math.max(0, downloadProgress.totalBytes - downloadProgress.downloadedBytes)) / downloadProgress.bytesPerSecond)
    : "计算中";
  const downloadBatchLabel = downloadBatchProgress && downloadBatchProgress.files.length > 1
    ? `并行 ${downloadBatchProgress.activeFiles} 项 · 已完成 ${downloadBatchProgress.completedFiles} / ${downloadBatchProgress.files.length} · `
    : downloadProgress?.totalFiles && downloadProgress.totalFiles > 1
      ? `第 ${downloadProgress.currentFileIndex || 1} / ${downloadProgress.totalFiles} 个 · `
      : "";
  const downloadStatusLabel = downloadTaskState === "completed" ? "已保存到本地" : downloadTaskState === "failed" ? "部分文件保存失败" : "请保持页面打开";
  const downloadHintLabel = downloadTaskState === "completed" || downloadTaskState === "failed" ? "可以展开查看各文件结果" : `${downloadBatchLabel}预计剩余 ${downloadEtaLabel}`;
  const showDownloadHud = Boolean(downloadTaskState !== "idle" && ((downloadProgress && downloadProgressFile) || downloadBatchProgress));
  const downloadActionLabel = downloadTaskState === "completed" || downloadTaskState === "failed" ? "关闭" : "取消下载";
  const batchDownloadFiles = downloadBatchProgress?.files || [];
  const showDownloadStack = batchDownloadFiles.length > 1;
  useEffect(() => {
    if (selectedPreviewKey && previewErrorKey === selectedPreviewKey) return;
    setPreviewErrorKey(null);
  }, [previewErrorKey, selectedPreviewKey]);
  const handleDownloadRailAction = () => {
    if (downloadTaskState === "completed" || downloadTaskState === "failed") {
      handleDismissDownloadHud();
      return;
    }
    const canHover = typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    if (canHover || downloadCancelArmed) {
      handleCancelDownload();
      return;
    }
    setDownloadCancelArmed(true);
  };

  // ===== 状态页渲染 =====
  // loading：渲染与 ready 完全等尺寸的骨架布局，数据到达后原地替换，零布局跳变。
  // 注意：此处 share===null，不得访问 share.* 任何字段。
  if (pageState === "loading") {
    return (
      <main className={`nyy-product-shell ${s.tPrimary}`}>
        <div className="nyy-product-content max-w-[1320px] mx-auto px-4 py-6 lg:px-10">

          {/* ── Topbar 骨架 ── */}
          <div className={`mb-4 grid gap-5 ${s.desktopTwoCol}`}>
            <div className="flex min-w-0 items-center gap-3 sm:gap-5">
              <BrandLogo href="/" className="w-[112px] h-auto shrink-0 sm:w-[156px] lg:w-[168px]" />
              <div className="min-w-0 flex-1">
                <div className={`${s.skel} h-4 w-full max-w-[11.5rem] sm:h-5 sm:max-w-[18rem]`} />
                <div className={`${s.skel} mt-2 h-3.5 w-28 sm:w-36`} />
              </div>
              <ThemeToggle className="shrink-0 lg:hidden" />
            </div>
            <div className="hidden justify-end lg:flex">
              <ThemeToggle className="shrink-0" />
            </div>
          </div>

          {/* ── 主体两栏 骨架 ── */}
          <div className={`grid gap-5 ${s.desktopTwoCol}`}>

            {/* 左列：舞台 + 操作栏 */}
            <div>
              {/* 舞台：16:9 黑框与 ready 完全同尺寸 */}
              <div className={s.stagePlayer}>
                <div className={`${s.stageContent} flex items-center justify-center`}>
                  <BrandLogo className={`w-20 h-auto opacity-20 ${s.logoBreath}`} />
                </div>
              </div>
              {/* 当前文件信息骨架：播放器下方只保留文件名/大小 */}
              <div className="flex items-center justify-between gap-4 mt-3 min-h-[44px]">
                <div className="min-w-0 flex-1">
                  <div className={`${s.skel} h-7 w-3/4`} />
                  <div className={`${s.skel} h-4 w-1/4 mt-1`} />
                </div>
              </div>
            </div>

            {/* 右列：侧栏骨架 */}
            <aside className="flex flex-col gap-4">

              {/* 主操作区骨架：复制链接已移到当前文件信息区，下载动作只占一行 */}
              <div data-testid="share-actions" className="grid grid-cols-2 gap-2 min-h-[46px]">
                <div className={`${s.skel} h-[46px] w-full rounded-lg`} />
                <div className={`${s.skel} h-[46px] w-full rounded-lg`} />
              </div>

              {/* 分享概览 + 扫码取件卡片骨架 */}
              <div className={`${s.glass} p-4`}>
                <div className="flex items-center justify-between gap-3">
                  <div className={`${s.skel} h-3.5 w-16`} />
                  <div className={`${s.skel} h-3.5 w-16`} />
                </div>
                <div className="mt-4 flex items-stretch gap-3 sm:gap-4">
                  <div className="grid min-w-0 flex-1 gap-2 sm:gap-2.5">
                    <div className="rounded-xl border border-white/10 bg-white/4 px-3 py-2.5 sm:py-3">
                      <div className={`${s.skel} h-3 w-10`} />
                      <div className={`${s.skel} h-4 w-24 mt-2 sm:h-5 sm:w-32`} />
                    </div>
                    <div className="rounded-xl border border-white/10 bg-white/4 px-3 py-2.5 sm:py-3">
                      <div className={`${s.skel} h-3 w-10`} />
                      <div className={`${s.skel} h-4 w-16 mt-2 sm:h-5 sm:w-20`} />
                    </div>
                    <div className="rounded-xl border border-white/10 bg-white/4 px-3 py-2.5 sm:py-3">
                      <div className={`${s.skel} h-3 w-10`} />
                      <div className={`${s.skel} h-4 w-14 mt-2 sm:h-5 sm:w-16`} />
                    </div>
                  </div>
                  <div className="w-[116px] shrink-0 rounded-2xl border border-white/10 bg-white/4 p-2.5 sm:w-[156px] sm:p-3">
                    <div className="flex flex-col items-center gap-3">
                      <div className={`${s.skel} h-[92px] w-[92px] rounded-xl shrink-0 sm:h-[108px] sm:w-[108px]`} />
                      <div className="flex flex-col items-center gap-2">
                        <div className={`${s.skel} h-3.5 w-16`} />
                        <div className={`${s.skel} h-3.5 w-20`} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 举报/首页链接占位（保持高度稳定） */}
              <div className="flex items-center justify-center gap-5">
                <div className={`${s.skel} h-3.5 w-10`} />
                <div className={`${s.skel} h-3.5 w-16`} />
              </div>

            </aside>
          </div>

          {/* 底部品牌（与 ready 一致，立即渲染） */}
          <FooterSlogan />
        </div>
      </main>
    );
  }

  // 状态页共用的 logo + 主题切换
  const StatusPage = ({ children }: { children: React.ReactNode }) => (
    <main className={`nyy-product-shell flex flex-col items-center justify-center gap-4 ${s.tPrimary}`}>
      <ThemeToggle className="fixed top-4 right-4 z-50" />
      <BrandLogo href="/" className="w-24 h-auto mx-auto mb-2 opacity-60" />
      {children}
    </main>
  );

  if (pageState === "not_found") {
    return (
      <StatusPage>
        <AlertCircle className={`w-12 h-12 ${s.tMuted}`} />
        <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>分享不存在或已被删除</p>
        <Link href="/" className="inline-flex min-h-[44px] items-center font-tech text-xs tracking-widest text-nyy-400 underline hover:text-nyy-300">返回首页</Link>
      </StatusPage>
    );
  }

  if (pageState === "expired") {
    return (
      <StatusPage>
        <Clock className={`w-12 h-12 ${s.tMuted}`} />
        <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>分享已过期</p>
        <Link href="/" className="inline-flex min-h-[44px] items-center font-tech text-xs tracking-widest text-nyy-400 underline hover:text-nyy-300">返回首页</Link>
      </StatusPage>
    );
  }

  if (pageState === "unauthorized") {
    return (
      <StatusPage>
        <AlertCircle className="w-12 h-12 text-amber-400" />
        <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>管理员登录已失效或权限不足</p>
        <Link href="/admin" className="inline-flex min-h-[44px] items-center font-tech text-xs tracking-widest text-nyy-400 underline hover:text-nyy-300">返回管理后台</Link>
      </StatusPage>
    );
  }

  if (pageState === "error" || !share) {
    return (
      <StatusPage>
        <AlertCircle className="w-12 h-12 text-red-400" />
        <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>加载失败，请稍后重试</p>
      </StatusPage>
    );
  }

  // ===== Vault Unlock（密码输入）=====
  if (pageState === "locked") {
    // 确定哪个格子是「当前活跃」的：-1=未聚焦，0~3=活跃格，4=已满
    const activeIdx = pwFocused ? Math.min(pwInput.length, 3) : -1;
    const isComplete = pwInput.length === 4;
    const isError = !!pwShake;

    return (
      <main className={`nyy-product-shell flex flex-col items-center justify-center px-4 ${s.tPrimary}`}>
        <ThemeToggle className="fixed top-4 right-4 z-50" />

        <div className={`${s.glass} p-10 max-w-sm w-full text-center animate-vault-open`}>
          <BrandLogo href="/" className="w-28 h-auto mx-auto mb-6" />
          <h1 className={`font-tech text-lg font-bold tracking-[0.15em] ${s.tPrimary} mb-2`}>安全保险库</h1>
          <p className={`font-tech text-[11px] tracking-[0.1em] ${s.tMuted} mb-8`}>请输入 4 位提取码解锁</p>

          {/* 4 位数字方块 + 真输入框（透明覆盖层） */}
          <div className="relative flex justify-center gap-3 mb-6">
            {[0, 1, 2, 3].map((i) => {
              const hasDigit = !!pwInput[i];
              const isActive = i === activeIdx;
              const cellClass = [
                s.digitCell,
                pwVerifying && s.digitCellScanning,
                isError && s.digitCellError,
                !pwVerifying && !isError && hasDigit && s.digitCellFilled,
                !pwVerifying && !isError && !hasDigit && isActive && s.digitCellActive,
              ].filter(Boolean).join(" ");
              return (
                <div key={i} className={`${cellClass}${pwDissolving && hasDigit ? ` ${s.digitDissolve}` : ""}`}>
                  {hasDigit ? <span key={`d-${i}-${pwDigitTick}`}>{pwInput[i]}</span> : <span className={s.digitPlaceholder}>·</span>}
                </div>
              );
            })}
            {/* 透明的真输入框，覆盖在数字方块上方 */}
            <input
              ref={pwInputRef}
              type="text"
              maxLength={4}
              inputMode="numeric"
              autoComplete="one-time-code"
              value={pwInput}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, "").slice(0, 4);
                clearPasswordErrorTimers();
                if (val.length > pwInput.length) setPwDigitTick((t) => t + 1);
                pwLatestRef.current = val;
                setPwInput(val);
                setPwError("");
                setPwDissolving(false);
                if (val.length === 4) scheduleVerify();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && pwInput.length === 4) {
                  if (pwVerifyTimerRef.current !== null) window.clearTimeout(pwVerifyTimerRef.current);
                  pwVerifyTimerRef.current = null;
                  void handleVerify();
                }
              }}
              onPaste={(e) => {
                const text = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 4);
                if (text.length === 4) {
                  e.preventDefault();
                  clearPasswordErrorTimers();
                  pwLatestRef.current = text;
                  setPwInput(text);
                  setPwDigitTick((t) => t + 1);
                  setPwError("");
                  scheduleVerify();
                }
              }}
              onFocus={() => setPwFocused(true)}
              onBlur={() => setPwFocused(false)}
              className="absolute inset-0 w-full h-full opacity-0 cursor-text"
              aria-label="输入4位提取码"
              id="pwInput"
            />
          </div>

          {/* 提示文字 */}
          <p className={`font-tech text-[11px] tracking-widest ${s.tMuted} mb-6`}>
            {pwVerifying ? "正在验证…" : pwError ? "重新输入" : isComplete ? "验证中" : pwFocused ? "输入 4 位数字提取码" : "点击方块输入提取码"}
          </p>

          {/* 错误消息（始终可见，淡入退场） */}
          {pwError && <p role="alert" className={`${s.errorMessage} font-tech text-xs tracking-widest text-red-400 mb-4`}>{pwError}</p>}

          {/* 解锁按钮 */}
          <button
            onClick={handleVerify}
            disabled={!isComplete || pwVerifying}
            className={`${s.glowBtn} w-full py-4 font-tech text-sm font-bold tracking-[0.12em] flex items-center justify-center gap-2 ${isComplete && !pwVerifying ? "shadow-[0_0_30px_rgba(255,138,61,0.6)]" : ""}`}
          >
            {pwVerifying ? (
              <span className="flex items-center gap-2"><span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> 验证中…</span>
            ) : (
              <><Play className="w-4 h-4 fill-current" /> 解锁</>
            )}
          </button>

          {/* 分享元信息（不泄露文件名） */}
          <div className="mt-8 grid grid-cols-2 gap-4 text-center">
            <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>文件数</span><span className={`font-tech text-base font-bold ${s.tPrimary}`}>{share.files.length}</span></div>
            <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>总大小</span><span className={`font-tech text-base font-bold ${s.tPrimary}`}>{formatSize(share.total_bytes)}</span></div>
          </div>
        </div>

        {/* 底部品牌 */}
        <p className={`mt-8 text-center font-tech text-[10px] tracking-[0.12em] ${s.tFaint}`}>
          {BRAND_SLOGAN_SHORT} · <a href="https://nyy.app" className="inline-flex min-h-[44px] items-center text-nyy-300 transition-colors hover:text-nyy-200">{BRAND_DOMAIN}</a>
        </p>
      </main>
    );
  }

  // ===== Ready 状态：4C 主布局 =====
  const isSingle = share.files.length === 1 && share.empty_dirs.length === 0;
  const hasOnlyEmptyDirs = share.files.length === 0 && share.empty_dirs.length > 0;
  const autoPreparesSingleDocument = shouldAutoPrepareSingleDocument(share);

  const effectiveFiles = downloads.length > 0 ? downloads : share.files;
  const contentSummary = getShareContentSummary(share);
  const expiryLabel = getExpiryLabel(share);
  const downloadLabel = getDownloadLabel(share);
  const showMultiDownloadActions = !isSingle && !hasOnlyEmptyDirs && downloadState === "ready" && !!selectedFile;
  const showLinkFetchButton =
    (isSingle && !autoPreparesSingleDocument && (downloadState === "idle" || downloadState === "error")) ||
    (!isSingle && !autoPreparesSingleDocument && !hasOnlyEmptyDirs && !showMultiDownloadActions);
  const canBatchSaveToDirectory = downloadConfig.smart_download_enabled && downloadConfig.filesystem_access_enabled && directoryDownloadSupported;
  const batchDownloadLabel = canBatchSaveToDirectory ? "保存到文件夹" : "请逐个下载";
  const batchDownloadBusyLabel = canBatchSaveToDirectory ? "保存中…" : "请逐个下载";
  const activeMobilePanel = isSingle && mobilePanel === "files" ? "overview" : mobilePanel;
  const mobileTabs: Array<{ id: MobilePanel; label: string }> = isSingle
    ? [{ id: "overview", label: "概览" }, { id: "scan", label: "扫码" }]
    : [{ id: "files", label: "文件" }, { id: "overview", label: "概览" }, { id: "scan", label: "扫码" }];
  const showGalleryView = galleryState === "ready" || gallerySession?.eligible === true;

  const galleryFiles = gallerySession?.eligible ? gallerySession.files : [];
  const galleryFileMap = new Map(galleryFiles.map((file) => [file.index, file]));
  const otherGalleryFiles: ShareGalleryOtherFile[] = gallerySession?.eligible ? share.files.flatMap((file) => {
    const galleryFile = galleryFileMap.get(file.index);
    if (galleryFile && galleryFile.status !== "failed") return [];
    const failed = galleryFile?.status === "failed";
    return [{
      file,
      failed,
      reason: failed
        ? "预览处理失败"
        : classifyFile(file.file_name) === "image" ? "当前格式不支持画廊预览" : "非图片文件",
    }];
  }) : [];

  const renderFileListContent = (variant: "desktop" | "mobile") => (
    <ShareFileBrowser
      files={effectiveFiles}
      emptyDirs={share.empty_dirs}
      downloadsReady={downloads.length > 0}
      selectedIndex={selectedIdx}
      onSelectFile={setSelectedIdx}
      onDownloadFile={(file) => { void downloadOneFile(file, Math.max(0, effectiveFiles.findIndex((item) => item.file_name === file.file_name && item.file_size === file.file_size))); }}
      formatSize={formatSize}
      variant={variant}
    />
  );

  const renderOverviewStats = () => (
    <div className="grid min-w-0 flex-1 gap-2 sm:gap-2.5">
      <div className="rounded-xl border border-white/10 bg-white/4 px-3 py-2.5 sm:py-3">
        <span className={`block font-tech text-[10px] ${s.tMuted}`}>内容</span>
        <span className="mt-1 block break-words font-tech text-[12px] font-bold leading-4 sm:text-sm sm:leading-5">{contentSummary}</span>
      </div>
      <div className="rounded-xl border border-white/10 bg-white/4 px-3 py-2.5 sm:py-3">
        <span className={`block font-tech text-[10px] ${s.tMuted}`}>到期</span>
        <span className="mt-1 block font-tech text-[12px] font-bold leading-4 sm:text-sm sm:leading-5">{expiryLabel}</span>
      </div>
      <div className="rounded-xl border border-white/10 bg-white/4 px-3 py-2.5 sm:py-3">
        <span className={`block font-tech text-[10px] ${s.tMuted}`}>下载</span>
        <span className="mt-1 block font-tech text-[12px] font-bold leading-4 sm:text-sm sm:leading-5">{downloadLabel}</span>
      </div>
    </div>
  );

  const renderScanContent = () => (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      {qr ? (
        <div className="rounded-xl bg-white p-1.5 shadow-[0_10px_30px_rgba(0,0,0,0.18)] sm:p-2">
          <Image src={qr} alt="二维码" width={108} height={108} unoptimized className="h-[92px] w-[92px] rounded-md sm:h-[108px] sm:w-[108px]" />
        </div>
      ) : (
        <div className={`${s.skel} h-[92px] w-[92px] rounded-xl shrink-0 sm:h-[108px] sm:w-[108px]`} aria-hidden="true" />
      )}
      <div>
        <p className="font-tech text-[10px] tracking-[0.1em] text-nyy-300">扫码取件</p>
        <p className={`mt-1 text-[11px] leading-4 sm:text-xs ${s.tMuted}`}>手机扫码取件</p>
      </div>
    </div>
  );

  const renderPreviewFallback = (message: string, testId?: string) => (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center" data-testid={testId}>
      <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-white/15 bg-white/6 shadow-[0_0_28px_rgba(255,138,61,0.18)]">
        <Download className="h-7 w-7 text-yc-accent" />
      </div>
      <div className="max-w-sm">
        <p className={`break-words font-tech text-sm font-bold tracking-widest ${s.tSecondary}`}>{selectedFile?.file_name || "文件预览不可用"}</p>
        <p className={`mt-2 text-xs leading-5 ${s.tMuted}`}>{message}</p>
      </div>
      {selectedFile && (
        <button type="button" onClick={() => { void downloadOneFile(selectedFile, selectedIdx); }} className={`${s.glowBtn} min-h-[44px] px-4 py-3 font-tech text-xs tracking-widest`}>
          下载查看
        </button>
      )}
    </div>
  );

  return (
    <main className={`nyy-product-shell ${s.tPrimary}`}>
      {showGalleryView ? (
        <div className="nyy-product-content mx-auto max-w-[1840px] px-2.5 py-2.5 sm:px-4 sm:py-3 lg:px-6 lg:py-4" data-testid="gallery-view">
          <header className={s.galleryTopBar} aria-label="画廊分享状态与操作" data-testid="gallery-top-bar">
            <div className={s.galleryTopBrand}>
              <BrandLogo href="/" className={s.galleryTopLogo} />
              <div className={s.galleryTopCopy}>
                <p className={s.galleryTopTitle}>有人通过{BRAND_NAME}分享给你</p>
                <p className={s.galleryTopMeta}>{gallerySession ? `${gallerySession.ready_count} 张可浏览 · ` : "正在准备图片 · "}{contentSummary}</p>
              </div>
            </div>

            <dl className={s.galleryTopStats} aria-label="分享状态">
              <div className={s.galleryTopStat}>
                <dt>图片</dt>
                <dd>{gallerySession ? `${gallerySession.ready_count} / ${gallerySession.files.length}` : "--"}</dd>
              </div>
              <div className={s.galleryTopStat}>
                <dt>到期</dt>
                <dd>{expiryLabel}</dd>
              </div>
              <div className={s.galleryTopStat}>
                <dt>下载</dt>
                <dd>{downloadLabel}</dd>
              </div>
            </dl>

            <div className={s.galleryTopActions}>
              {!weChatEnvironment && (
                <button type="button" onClick={() => { void handleDownloadAll(); }} disabled={downloading} className={s.gallerySaveAll} data-testid="gallery-download-all" title={canBatchSaveToDirectory ? "选择文件夹并保留原目录结构" : "当前浏览器不支持批量保存时会给出说明"}>
                  <FolderDown aria-hidden="true" />
                  <span>{downloading ? "保存中…" : "保存全部"}</span>
                </button>
              )}
              <CopyLinkButton onCopy={handleCopyLink} label="复制链接" copiedLabel="已复制" className={s.galleryCopyAction} iconClassName="h-4 w-4" />
              <ThemeToggle className={s.galleryThemeAction} />
              <button type="button" onClick={() => setGalleryDetailsOpen(true)} aria-label="查看分享详情" className={s.galleryDetailsAction} data-testid="gallery-details-trigger">
                <MoreHorizontal aria-hidden="true" />
              </button>
            </div>
          </header>

          {gallerySession && (gallerySession.pending_count > 0 || gallerySession.failed_count > 0) && (
            <p className={s.galleryStatusNotice} role="status">
              {gallerySession.pending_count > 0 && `${gallerySession.pending_count} 张预览处理中`}
              {gallerySession.pending_count > 0 && gallerySession.failed_count > 0 && " · "}
              {gallerySession.failed_count > 0 && `${gallerySession.failed_count} 个失败文件已移至下方原文件区`}
            </p>
          )}

          <ShareImageGallery
            files={galleryFiles}
            loading={galleryState === "loading"}
            downloading={downloading}
            selectedIndices={selectedGalleryIndices}
            currentIndex={currentGalleryIndex}
            wechatMode={Boolean(weChatEnvironment)}
            selectionEnabled={!mobileBrowser}
            formatSize={formatSize}
            onCurrentChange={setCurrentGalleryIndex}
            onToggleSelection={(index) => setSelectedGalleryIndices((current) => {
              const next = new Set(current);
              if (next.has(index)) next.delete(index);
              else next.add(index);
              return next;
            })}
            onClearSelection={() => setSelectedGalleryIndices(new Set())}
            onDownloadFiles={(indices) => { void handleGalleryDownload(indices); }}
          />

          <ShareGalleryOtherFiles
            files={otherGalleryFiles}
            downloading={downloading}
            formatSize={formatSize}
            onDownloadFile={(index) => { void handleGalleryDownload([index]); }}
          />

          <div className={`mt-8 flex items-center justify-center gap-5 text-xs ${s.tMuted}`}>
            <button ref={reportTriggerRef} onClick={() => setReportOpen(true)} disabled={reported} className="retro-text-button retro-text-button-danger min-h-[44px] px-2 py-1 text-xs"><Flag className="h-3 w-3" /> {reported ? "已举报" : "举报"}</button>
            <Link href="/" className="inline-flex min-h-[44px] items-center transition-colors hover:text-yc-accent">返回首页</Link>
          </div>
          <FooterSlogan />

          {galleryDetailsOpen && (
            <div className="fixed inset-0 z-[48] sm:hidden" role="dialog" aria-modal="true" aria-labelledby="gallery-details-title" data-testid="gallery-details-sheet">
              <button type="button" className="absolute inset-0 h-full w-full bg-black/55 backdrop-blur-sm" aria-label="关闭详情遮罩" onClick={() => setGalleryDetailsOpen(false)} />
              <section className="absolute inset-x-0 bottom-0 max-h-[82dvh] overflow-y-auto rounded-t-[28px] border border-b-0 border-white/15 bg-[color-mix(in_srgb,var(--yc-bg,#0a0418)_94%,white_3%)] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-3 shadow-[0_-24px_70px_rgba(0,0,0,0.38)]">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" aria-hidden="true" />
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="retro-kicker">分享信息</p>
                    <h2 id="gallery-details-title" className={`mt-1 font-tech text-base font-black tracking-[0.04em] ${s.tPrimary}`}>图片分享详情</h2>
                  </div>
                  <button ref={galleryDetailsCloseRef} type="button" onClick={() => setGalleryDetailsOpen(false)} aria-label="关闭分享详情" className="retro-close-button"><X className="h-4 w-4" /></button>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <div className="min-w-0 rounded-xl border border-white/10 bg-white/5 px-2.5 py-3">
                    <span className={`block text-[9px] ${s.tMuted}`}>图片</span>
                    <strong className="mt-1 block truncate font-tech text-[11px]">{gallerySession ? `${gallerySession.ready_count} / ${gallerySession.files.length} 张` : "准备中"}</strong>
                  </div>
                  <div className="min-w-0 rounded-xl border border-white/10 bg-white/5 px-2.5 py-3">
                    <span className={`block text-[9px] ${s.tMuted}`}>到期</span>
                    <strong className="mt-1 block truncate font-tech text-[11px]">{expiryLabel}</strong>
                  </div>
                  <div className="min-w-0 rounded-xl border border-white/10 bg-white/5 px-2.5 py-3">
                    <span className={`block text-[9px] ${s.tMuted}`}>下载</span>
                    <strong className="mt-1 block truncate font-tech text-[11px]">{downloadLabel}</strong>
                  </div>
                </div>

                <div className="mt-3 rounded-xl border border-white/10 bg-white/4 px-3 py-3">
                  <p className={`font-tech text-[9px] tracking-[0.08em] ${s.tMuted}`}>全部内容</p>
                  <p className={`mt-1 break-words text-xs leading-5 ${s.tPrimary}`}>{contentSummary}</p>
                </div>

                {weChatEnvironment && (
                  <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/8 px-3 py-3">
                    <p className="font-tech text-[10px] font-bold text-amber-700 dark:text-amber-300">微信浏览提示</p>
                    <p className={`mt-1 text-[10px] leading-5 ${s.tMuted}`}>普通图片可在灯箱中长按保存或转发；RAW 显示的是预览图，请使用下载按钮获取原文件。</p>
                  </div>
                )}

                <div className="mt-4 flex items-center gap-2">
                  <CopyLinkButton onCopy={handleCopyLink} label="复制分享链接" copiedLabel="链接已复制" className={`${s.ghostBtn} flex min-h-[44px] min-w-0 flex-1 items-center justify-center gap-2 px-3 font-tech text-xs`} iconClassName="h-4 w-4" />
                  <ThemeToggle className="shrink-0" />
                </div>
              </section>
            </div>
          )}
        </div>
      ) : (
      <div className="nyy-product-content max-w-[1320px] mx-auto px-4 py-6 lg:px-10">
        {isAdminPreview && adminStatus && (
          <div data-testid="admin-preview-banner" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-400/10 px-4 py-3 text-amber-900 dark:border-amber-400/30 dark:text-amber-100">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-tech text-xs font-bold tracking-[0.12em]">管理员预览</span>
              <span className="rounded-full border border-amber-500/30 bg-amber-900/5 px-2.5 py-1 font-tech text-[10px] tracking-widest dark:border-amber-300/30 dark:bg-black/15">{ADMIN_STATUS_LABELS[adminStatus]}</span>
              <span className="text-xs text-amber-800/80 dark:text-amber-100/70">不会恢复分享，也不会计入下载次数</span>
            </div>
            <Link href="/admin" className="inline-flex min-h-[44px] items-center font-tech text-[11px] tracking-widest underline underline-offset-4 hover:text-amber-950 dark:hover:text-white">返回管理后台</Link>
          </div>
        )}
        {/* Topbar */}
        <div className={`mb-4 grid gap-5 ${s.desktopTwoCol}`}>
          <div className="flex min-w-0 items-center gap-3 sm:gap-5">
            <BrandLogo href="/" className="w-[112px] h-auto shrink-0 sm:w-[156px] lg:w-[168px]" />
            <div className="min-w-0 flex-1">
              <p className={`min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-tech text-sm font-bold leading-none tracking-[0.03em] sm:text-base sm:tracking-[0.06em] ${s.tPrimary}`}>有人通过{BRAND_NAME}分享给你</p>
              <p className={`mt-2 truncate text-[11px] sm:text-[13px] ${s.tMuted}`}>{contentSummary}</p>
            </div>
            <ThemeToggle className="shrink-0 lg:hidden" />
          </div>
          <div className="hidden justify-end lg:flex">
            <ThemeToggle className="shrink-0" />
          </div>
        </div>

        {/* 主体两栏 */}
        <div className={`grid gap-5 ${s.desktopTwoCol}`}>
          {/* 左:内联预览舞台 */}
          <div>
            {/* 舞台外框始终存在；媒体保持 16:9，文档使用独立响应式高度。 */}
            <div
              className={`${s.stagePlayer} ${selectedUsesDocumentStage ? s.stageDocument : s.stageMedia}`}
              data-testid="preview-stage"
              data-preview-kind={selectedUsesDocumentStage ? "document" : "media"}
            >
              {downloads.length > 0 && selectedFile ? (
                <div key={`${selectedType}-${selectedIdx}`} className={s.stageContent}>
                  {downloadPreviewSuspended && downloadProgress ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-3xl border border-white/15 bg-white/6 shadow-[0_0_28px_rgba(255,138,61,0.18)]">
                        <Download className="h-7 w-7 text-yc-accent" />
                      </div>
                      <div>
                        <p className={`font-tech text-sm font-bold tracking-widest ${s.tSecondary}`}>正在下载，已暂停预览以节省内存</p>
                        <p className={`mt-2 text-xs ${s.tMuted}`}>完成后会自动恢复当前文件预览。</p>
                      </div>
                    </div>
                  ) : selectedType === "video" && (
                    isMkvFile(selectedFile) ? (
                      <MkvVideoPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }} debugLog={appendDebugLog} />
                    ) : needsSdpPlayer(selectedFile) ? (
                      <SelfDevelopPlayer file={selectedFile} className={s.sdpFill} debugLog={appendDebugLog} />
                    ) : isAc3Mp4(selectedFile) ? (
                      <Ac3VideoPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }} />
                    ) : isEac3Mp4(selectedFile) ? (
                      <UnsupportedVideoPreview
                        message="当前客户端解码器尚不支持 E-AC-3 音频；为避免误播无声视频，请先下载后使用本地播放器查看。"
                        onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }}
                      />
                    ) : (
                      <NativeVideoPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }} />
                    )
                  )}
                  {/* 图片 */}
                  {!downloadPreviewSuspended && selectedType === "image" && (
                    <div className={s.imageStage}>
                      {(isSafeUrl(selectedFile.download_url) || isSafeUrl(selectedFile.backup_download_url || "")) && !previewLoadFailed ? (
                        <ImagePreview file={selectedFile} onFailure={() => setPreviewErrorKey(selectedPreviewKey)} />
                      ) : renderPreviewFallback("图片预览加载失败，可能是链接已过期或浏览器无法读取该资源。")}
                    </div>
                  )}
                  {/* PDF */}
                  {!downloadPreviewSuspended && selectedType === "pdf" && (
                    hasSafeInlineDocumentUrl
                      ? <PdfPreview url={inlineDocumentUrl} backupUrl={inlineDocumentBackupUrl} className={`w-full h-full ${s.pdfScroll}`} />
                      : renderPreviewFallback("该 PDF 使用分片存储或预览链接无效，请下载后查看。")
                  )}
                  {/* Word */}
                  {!downloadPreviewSuspended && selectedType === "document" && (
                    hasSafeInlineDocumentUrl
                      ? <OfficePreview
                          kind="document"
                          url={inlineDocumentUrl}
                          backupUrl={inlineDocumentBackupUrl}
                          fileName={selectedFile.file_name}
                          fileSize={selectedFile.file_size}
                          className="h-full w-full"
                          onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }}
                        />
                      : renderPreviewFallback("该文档使用分片存储或预览链接无效，请下载后查看。")
                  )}
                  {/* 表格 */}
                  {!downloadPreviewSuspended && selectedType === "spreadsheet" && (
                    hasSafeInlineDocumentUrl
                      ? <OfficePreview
                          kind="spreadsheet"
                          url={inlineDocumentUrl}
                          backupUrl={inlineDocumentBackupUrl}
                          fileName={selectedFile.file_name}
                          fileSize={selectedFile.file_size}
                          className="h-full w-full"
                          onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }}
                        />
                      : renderPreviewFallback("该表格使用分片存储或预览链接无效，请下载后查看。")
                  )}
                  {/* PowerPoint */}
                  {!downloadPreviewSuspended && selectedType === "presentation" && (
                    hasSafeInlineDocumentUrl
                      ? <OfficePreview
                          kind="presentation"
                          url={inlineDocumentUrl}
                          backupUrl={inlineDocumentBackupUrl}
                          fileName={selectedFile.file_name}
                          fileSize={selectedFile.file_size}
                          className="h-full w-full"
                          onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }}
                        />
                      : renderPreviewFallback("该演示文稿使用分片存储或预览链接无效，请下载后查看。")
                  )}
                  {/* 音频 */}
                  {!downloadPreviewSuspended && selectedType === "audio" && (
                    <AudioPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile, selectedIdx); }} />
                  )}
                  {/* 文本 */}
                  {!downloadPreviewSuspended && selectedType === "text" && (
                    <div className={s.textScroll}>
                      <div className={s.textContent}>
                        <p className={`${s.tMuted} mb-2`}># {selectedFile.file_name}</p>
                        <p className={s.tSecondary}>文本预览需要下载后查看。</p>
                        <p className={`${s.tMuted} mt-4 text-xs`}>文件大小: {formatSize(selectedFile.file_size)}</p>
                      </div>
                    </div>
                  )}
                  {/* 其他 */}
                  {!downloadPreviewSuspended && selectedType === "other" && (
                    isOfficeDownloadOnly(selectedFile.file_name)
                      ? renderPreviewFallback("该格式暂不支持在线预览，请下载后使用 Office 查看。", "office-preview-fallback")
                      : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                          <div className="w-20 h-20 rounded-2xl bg-white/6 border border-white/10 flex items-center justify-center text-3xl">⋯</div>
                          <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>{selectedFile.file_name}</p>
                          <p className={`text-xs ${s.tMuted}`}>{formatSize(selectedFile.file_size)}</p>
                        </div>
                      )
                  )}
                </div>
              ) : (
                /* 占位（加载中/仅空文件夹）——同一外框内淡入，外框尺寸不变故无跳变 */
                <div className={`${s.stageContent} flex items-center justify-center`}>
                  <div className="text-center">
                    <BrandLogo className="w-20 h-auto mx-auto mb-4 opacity-30" />
                    <p className={`font-tech text-xs tracking-widest ${s.tMuted}`}>
                      {hasOnlyEmptyDirs
                        ? "该分享仅包含空文件夹"
                        : autoPreparesSingleDocument && downloadState === "loading"
                          ? "正在加载文档预览…"
                          : autoPreparesSingleDocument && downloadState === "error"
                            ? "预览加载失败，可直接下载文件"
                            : "选择一个文件开始预览"}
                    </p>
                  </div>
                </div>
              )}
            </div>
            {/* 当前文件信息：下载动作统一放到主操作区/文件列表 */}
            {selectedMeta && (
              <div className="mt-3 flex min-h-[44px] items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className={`font-tech text-lg font-bold tracking-wide truncate ${s.tPrimary}`}>{selectedMeta.file_name}</p>
                  <p className={`font-tech text-xs ${s.tMuted} mt-1`}>
                    {formatSize(selectedMeta.file_size)}
                    {selectedFile?.is_chunked && ` · ${selectedFile.chunks.length} 分片`}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 pt-0.5">
                  {!isSingle && share.files.length > 1 && (
                    <span className={`rounded-full border border-white/10 bg-white/6 px-2.5 py-1 font-tech text-[10px] ${s.tMuted}`}>
                      {Math.min(selectedIdx + 1, share.files.length)} / {share.files.length}
                    </span>
                  )}
                  <CopyLinkButton
                    onCopy={handleCopyLink}
                    iconOnly
                    className="retro-icon-button h-11 w-11"
                    iconClassName="w-4 h-4"
                    title="复制链接"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 右:侧栏 */}
          <aside className="flex flex-col gap-4">
            {/* 主操作区：复制链接移到当前文件信息区，这里只保留下载主动作 */}
            <div data-testid="share-actions" className="grid grid-cols-2 gap-2 min-h-[46px]">
              {hasOnlyEmptyDirs && (
                <button onClick={handleDownloadAll} disabled={downloading}
                  className={`${s.glowBtn} col-span-2 w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                  <Package className="w-4 h-4" />
                  {downloading ? batchDownloadBusyLabel : batchDownloadLabel}
                </button>
              )}
              {isSingle && autoPreparesSingleDocument && (
                <button onClick={() => { void handleSingleDocumentDownload(); }} disabled={downloading || downloadState === "loading"}
                  className={`${s.glowBtn} col-span-2 w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                  <Download className="w-4 h-4" />
                  {downloading ? "下载中…" : downloadState === "loading" ? "正在准备预览…" : "下载此文件"}
                </button>
              )}
              {isSingle && !autoPreparesSingleDocument && downloadState === "ready" && downloads[0] && (
                liVehicleBrowser && !downloads[0].is_chunked && isSafeUrl(downloads[0].download_url) ? (
                  <div className="col-span-2" data-testid="li-vehicle-download-actions">
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                      <a
                        data-testid="li-vehicle-original-link"
                        href={downloads[0].download_url}
                        referrerPolicy="no-referrer"
                        aria-disabled={downloading}
                        onClick={(event) => {
                          event.preventDefault();
                          if (!downloading) void downloadOneFile(downloads[0], 0);
                        }}
                        className={`${s.glowBtn} flex min-w-0 items-center justify-center gap-2 px-4 py-3.5 font-tech text-xs tracking-widest`}
                      >
                        <Download className="h-4 w-4 shrink-0" />
                        <span className="truncate">打开原文件</span>
                      </a>
                      <CopyLinkButton
                        onCopy={() => handleCopyOriginalLink(downloads[0])}
                        label="复制直链"
                        copiedLabel="已复制"
                        className={`${s.ghostBtn} flex min-h-[46px] items-center justify-center gap-2 px-3 font-tech text-xs tracking-wider`}
                        iconClassName="h-4 w-4"
                      />
                    </div>
                    <p data-testid="li-vehicle-download-hint" className={`mt-2 px-1 text-[11px] leading-5 ${s.tMuted}`}>
                      车机可能不提供网页下载器。打开后可尝试浏览器菜单保存，或复制直链、扫码后在手机或电脑下载。
                    </p>
                  </div>
                ) : (
                  <button onClick={() => { if (downloads[0]) void downloadOneFile(downloads[0], 0); }} disabled={downloading || !downloads[0]}
                    className={`${s.glowBtn} col-span-2 w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                    <Download className="w-4 h-4" />
                    {downloading ? "下载中…" : "下载此文件"}
                  </button>
                )
              )}
              {isSingle && !autoPreparesSingleDocument && downloadState === "loading" && (
                <button disabled
                  className={`${s.glowBtn} col-span-2 w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2 opacity-50 cursor-not-allowed`}>
                  <Download className="w-4 h-4" />
                  获取中…
                </button>
              )}
              {showMultiDownloadActions && (
                <>
                  <button onClick={() => { if (selectedFile) void downloadOneFile(selectedFile, selectedIdx); }} disabled={downloading || !selectedFile}
                    className={`${s.glowBtn} min-w-0 w-full py-3.5 font-tech text-[11px] tracking-[0.08em] sm:text-xs sm:tracking-widest flex items-center justify-center gap-2`}>
                    <Download className="w-4 h-4 shrink-0" />
                    <span className="truncate">下载当前文件</span>
                  </button>
                  <button onClick={handleDownloadAll} disabled={downloading}
                    className={`${s.glowBtn} min-w-0 w-full py-3.5 font-tech text-[11px] tracking-[0.08em] sm:text-xs sm:tracking-widest flex items-center justify-center gap-2`}>
                    <Package className="w-4 h-4 shrink-0" />
                    <span className="truncate">{downloading ? batchDownloadBusyLabel : batchDownloadLabel}</span>
                  </button>
                </>
              )}
              {showLinkFetchButton && (
                <button onClick={handleFetchDownloadLinks} disabled={downloading || downloadState === "loading"}
                  className={`${s.glowBtn} col-span-2 w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                  <Download className="w-4 h-4" />
                  {downloading || downloadState === "loading" ? "获取中…" : "获取下载链接"}
                </button>
              )}
              {!selectedMeta && (
                <CopyLinkButton
                  onCopy={handleCopyLink}
                  className={`${s.ghostBtn} col-span-2 w-full py-3 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}
                  iconClassName="w-4 h-4"
                />
              )}
            </div>

            {weChatEnvironment && !weChatNoticeDismissed && selectedMeta && !selectedMeta.is_chunked && (
              <div data-testid="wechat-download-notice" role="status" className="relative rounded-2xl border border-amber-400/25 bg-amber-400/8 px-4 py-3 pr-11 shadow-[0_0_24px_rgba(251,191,36,0.07)]">
                <p className={`font-tech text-[11px] font-bold tracking-[0.08em] ${s.tPrimary}`}>
                  {weChatEnvironment === "wecom" ? "企业微信下载提示" : "微信下载提示"}
                </p>
                <p className={`mt-1 text-[11px] leading-5 ${s.tMuted}`}>
                  接收页下载中可能暂时显示 0 B，当前文件实际为 {formatSize(selectedMeta.file_size)}。暂停时通常会刷新大小，不影响文件完整性或继续下载。
                </p>
                <button type="button" onClick={dismissWeChatNotice} aria-label="关闭微信下载提示" className={`absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-white/10 ${s.tMuted}`}>
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* 移动端：文件 / 概览 / 扫码选项卡 */}
            <div className={`${s.glass} p-3 sm:hidden`}>
              <div role="tablist" aria-label="分享信息" className={`retro-segmented grid gap-1 ${isSingle ? "grid-cols-2" : "grid-cols-3"}`}>
                {mobileTabs.map((tab) => {
                  const active = activeMobilePanel === tab.id;
                  return (
                    <button key={tab.id} type="button" role="tab" aria-selected={active}
                      onClick={() => setMobilePanel(tab.id)}
                      className="retro-segment-button py-2 font-tech text-[11px] tracking-[0.12em]">
                      {tab.label}
                    </button>
                  );
                })}
              </div>
              <div role="tabpanel" className="mt-3">
                {!isSingle && activeMobilePanel === "files" && renderFileListContent("mobile")}
                {activeMobilePanel === "overview" && renderOverviewStats()}
                {activeMobilePanel === "scan" && (
                  <div className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-[0_0_24px_rgba(255,138,61,0.08)]">
                    {renderScanContent()}
                  </div>
                )}
              </div>
            </div>

            {/* 桌面/平板：保持文件列表展开展示 */}
            {!isSingle && <div className={`${s.glass} hidden p-4 sm:block`}>
              {renderFileListContent("desktop")}
            </div>}

            {/* 桌面/平板：保持分享概览 + 扫码取件同屏展示 */}
            <div className={`${s.glass} hidden p-4 sm:block`}>
              <div className="flex items-center justify-between gap-3">
                <p className={`font-tech text-[11px] tracking-[0.1em] ${s.tMuted}`}>分享概览</p>
                <span className={`font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>扫码取件</span>
              </div>
              <div className="mt-4 flex items-stretch gap-3 sm:gap-4">
                {renderOverviewStats()}
                <div className="w-[116px] shrink-0 rounded-2xl border border-white/10 bg-white/5 p-2.5 shadow-[0_0_24px_rgba(255,138,61,0.08)] sm:w-[156px] sm:p-3">
                  {renderScanContent()}
                </div>
              </div>
            </div>

            {/* 底部操作（举报 / 首页保持低调） */}
            <div className={`flex items-center justify-center gap-5 text-xs ${s.tMuted}`}>
              {!isAdminPreview && <button ref={reportTriggerRef} onClick={() => setReportOpen(true)} disabled={reported} className="retro-text-button retro-text-button-danger min-h-[44px] px-2 py-1 text-xs"><Flag className="w-3 h-3" /> {reported ? "已举报" : "举报"}</button>}
              <a href={isAdminPreview ? "/admin" : "/"} className="inline-flex min-h-[44px] items-center transition-colors hover:text-yc-accent">{isAdminPreview ? "返回管理后台" : "返回首页"}</a>
            </div>
          </aside>
        </div>

        {/* 底部品牌 */}
        <FooterSlogan />
      </div>
      )}

      {/* 智能下载进度：固定在视口，避免长文件列表把进度挤到页面底部 */}
      {showDownloadHud && downloadProgress && (
        <div
          className={`${s.downloadHud} ${downloadTaskState === "completed" ? s.downloadHudComplete : ""} ${downloadTaskState === "failed" ? s.downloadHudFailed : ""} ${showDownloadStack ? s.downloadHudStacked : ""} ${downloadHudExpanded ? s.downloadHudExpanded : ""}`}
          role="status"
          aria-live="polite"
          data-testid="download-progress-hud"
        >
          {showDownloadStack && !downloadHudExpanded && (
            <>
              <span className={`${s.downloadStackCard} ${s.downloadStackCardFirst}`} aria-hidden="true" />
              <span className={`${s.downloadStackCard} ${s.downloadStackCardSecond}`} aria-hidden="true" />
            </>
          )}
          <div className={s.downloadHudVeil} />
          <div className="relative grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 pr-1">
                <span className={s.downloadStatusPill}>{downloadTaskState === "completed" && <CheckCircle2 className="h-3 w-3" />}{downloadStatusLabel}</span>
                <p className={`min-w-0 flex-1 truncate font-tech text-sm font-black tracking-wide ${s.tPrimary}`} title={downloadProgressName}>
                  {downloadProgressName}
                </p>
                {showDownloadStack && (
                  <button
                    type="button"
                    className={s.downloadExpandButton}
                    onClick={() => setDownloadHudExpanded((current) => !current)}
                    aria-expanded={downloadHudExpanded}
                    aria-controls="download-file-progress-list"
                    data-testid="download-progress-toggle"
                  >
                    {batchDownloadFiles.length} 个文件
                    {downloadHudExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>
              <div className={s.downloadProgressTrack} aria-hidden="true">
                <div
                  className={`${s.downloadProgressFill} ${downloadTaskState === "completed" ? s.downloadProgressFillComplete : ""}`}
                  style={{ width: `${downloadTaskState === "completed" ? 100 : Math.max(downloadProgressRatio * 100, downloadProgressRatio > 0 ? 1.6 : 0)}%` }}
                />
              </div>
              <div className={`mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 font-tech text-[10px] ${s.tMuted}`}>
                <span>{formatSize(downloadProgress.downloadedBytes)} / {formatSize(downloadProgress.totalBytes)}</span>
                <span>{downloadHintLabel}</span>
              </div>
            </div>

            <button
              type="button"
              className={`${s.downloadSideRail} ${downloadCancelArmed ? s.downloadSideRailArmed : ""}`}
              onClick={handleDownloadRailAction}
              aria-label={downloadActionLabel}
            >
              <div className={s.downloadMetrics}>
                <strong>{downloadProgressPercentLabel}</strong>
                <span>{downloadSpeedLabel}</span>
              </div>
              <span className={s.downloadCancelLabel}>{downloadActionLabel}</span>
            </button>
          </div>
          {showDownloadStack && downloadHudExpanded && (
            <div id="download-file-progress-list" className={s.downloadFileList} data-testid="download-file-progress-list">
              {batchDownloadFiles.map((item) => {
                const ratio = Math.min(1, Math.max(0, item.downloadedBytes / Math.max(1, item.totalBytes)));
                const itemStatus = item.status === "completed" ? "完成" : item.status === "failed" ? "失败" : item.status === "cancelled" ? "已取消" : item.status === "running" ? "下载中" : "等待中";
                return (
                  <div key={`${item.index}-${item.fileName}`} className={s.downloadFileRow} data-status={item.status} data-testid="download-file-progress-row">
                    <div className={s.downloadFileRowHeader}>
                      <span className={s.downloadFileStateIcon} aria-hidden="true">
                        {item.status === "completed" ? <CheckCircle2 /> : item.status === "failed" ? <AlertCircle /> : <Clock />}
                      </span>
                      <span className={s.downloadFileName} title={item.savedPath || item.fileName}>{item.savedPath || item.fileName}</span>
                      <span className={s.downloadFileStatus}>{itemStatus}</span>
                    </div>
                    <div className={s.downloadFileTrack} aria-label={`${item.fileName} ${Math.floor(ratio * 100)}%`}>
                      <span style={{ width: `${item.status === "completed" ? 100 : ratio * 100}%` }} />
                    </div>
                    <div className={s.downloadFileMeta}>
                      <span>{formatSize(item.downloadedBytes)} / {formatSize(item.totalBytes)}</span>
                      <span>{item.status === "running" ? formatSpeed(item.bytesPerSecond) : item.error || itemStatus}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 举报 Modal */}
      {!isAdminPreview && reportOpen && (
        <div ref={reportDialogRef} className="fixed inset-0 z-50 flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-labelledby="share-report-title">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" onClick={() => setReportOpen(false)} />
          <div className={`${s.glass} relative w-full max-w-sm p-6`}>
            <button ref={reportCloseRef} type="button" onClick={() => setReportOpen(false)} aria-label="关闭举报弹窗" className="retro-close-button absolute right-4 top-4"><X className="h-4 w-4" /></button>
            <h3 id="share-report-title" className={`font-tech text-sm tracking-widest font-bold mb-2 ${s.tPrimary}`}>举报分享</h3>
            <p className={`text-xs ${s.tMuted} mb-4`}>请选择举报原因。</p>
            <select value={reportReason} onChange={(e) => setReportReason(e.target.value)} aria-label="选择举报原因"
              className={`mb-4 min-h-[44px] w-full rounded-lg border border-white/10 bg-white/6 px-3 py-2.5 text-sm ${s.tPrimary} focus:border-yc-accent focus:outline-none`}>
              <option value="">选择原因…</option>
              <option value="侵权内容">侵权内容</option>
              <option value="恶意软件">恶意软件</option>
              <option value="违法内容">违法内容</option>
              <option value="其他">其他</option>
            </select>
            <button onClick={handleReport} disabled={!reportReason}
              className={`${s.glowBtn} min-h-[44px] w-full py-3 font-tech text-xs tracking-widest`}>
              提交举报
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
