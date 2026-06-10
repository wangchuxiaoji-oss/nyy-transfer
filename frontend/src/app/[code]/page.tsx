"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { CheckCircle2, Download, Clock, AlertCircle, Package, Flag, X, Play, Pause, Volume2, VolumeX } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { CopyLinkButton } from "@/components/copy-link-button";
import { ShareFileBrowser } from "@/components/share-file-browser";
import { SelfDevelopPlayer } from "@/components/self-develop-player";
import { NativeVideoPlayer, type NativeVideoErrorInfo, type NativeVideoResumeRequest } from "@/components/native-video-player";
import { Ac3VideoPreview } from "@/components/ac3-video-preview";
import { PdfPreview } from "@/components/pdf-preview";
import {
  getShareInfo, verifyShare, downloadShare, reportShare, getPublicDownloadConfig,
  type ShareInfo, type ShareFileDownload,
} from "@/lib/api";
import {
  defaultDownloadConfig,
  downloadFilesToDirectoryHandle,
  downloadSmart,
  pickDownloadDirectory,
  supportsDirectoryPicker,
  type DownloadConfig,
  type SmartDownloadProgress,
} from "@/lib/smart-download";
import { getErrorMessage, isHttpStatusError } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import type { DebugLogFn } from "@/lib/debug";
import { createVirtualMediaFileId, needsVideoOnlyVirtualMp4, needsVirtualFaststart, prepareVirtualMediaTransport, registerVirtualMediaFile } from "@/lib/virtual-media";
import { BRAND_DOMAIN, BRAND_NAME, BRAND_SLOGAN_SHORT } from "@/lib/copy";
import s from "./share-4c.module.css";

type PageState = "loading" | "locked" | "ready" | "not_found" | "expired" | "error";
type FileType = "video" | "image" | "pdf" | "audio" | "text" | "other";
type DownloadLinksState = "idle" | "loading" | "ready" | "error";
type MobilePanel = "files" | "overview" | "scan";
type DownloadTaskState = "idle" | "running" | "completed";

// 分类文件类型（用于选择图标 + 预览策略）
function classifyFile(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mkv", "wmv", "mov", "webm"].includes(ext)) return "video";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["mp3", "aac", "wav", "flac", "m4a", "ogg"].includes(ext)) return "audio";
  if (["txt", "md", "json", "csv", "log", "ini", "yml", "yaml", "xml"].includes(ext)) return "text";
  return "other";
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
  return type === "video" || type === "audio" || type === "pdf";
}

function getSingleContentLabel(type: FileType): string {
  switch (type) {
    case "video": return "1 个视频";
    case "image": return "1 张图片";
    case "audio": return "1 个音频";
    case "pdf": return "1 个 PDF";
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
    if (onPlaybackFailure) {
      onPlaybackFailure(message);
      return;
    }
    setErrorMessage(message);
    setFailed(true);
  }, [onPlaybackFailure]);

  const registerVirtualPlaybackUrl = useCallback(async () => {
    const currentFile = fileRef.current;
    await prepareVirtualMediaTransport();
    return registerVirtualMediaFile(currentFile, "share-video", undefined, virtualMediaIdRef.current || undefined);
  }, [playbackSessionKey]);

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
    if (useVirtualFaststart && isVirtualPlaybackUrl) {
      void recoverVirtualTransport(message, info);
      return;
    }
    handlePlaybackFailure(message);
  }, [handlePlaybackFailure, isVirtualPlaybackUrl, recoverVirtualTransport, useVirtualFaststart]);

  const handleNativeLoadedMetadata = useCallback(() => {
    setMetadataReady(true);
    virtualRecoveryCountRef.current = 0;
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
    if (mime && probe.canPlayType(mime) === "") setFailed(true);
  }, [playbackUrl, mime, safeUrl]);

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
  const [mode, setMode] = useState<"checking" | "native" | "sdp">("checking");

  useEffect(() => {
    if (typeof document === "undefined") return;
    const params = new URLSearchParams(window.location.search);
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
  }, [file]);

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
  }, [audioTransportPreparing, drawIdleVisualizer, ensureAudioGraph, file.download_url, persistVolume, playbackUrl, releaseAudioGraph, resetVisualizer, safeUrl, startVisualizerLoop, state, syncBuffered]);

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

export default function SharePage() {
  const params = useParams();
  const code = params.code as string;
  const { showToast } = useToast();

  // ===== 页面状态 =====
  const [pageState, setPageState] = useState<PageState>("loading");
  const [share, setShare] = useState<ShareInfo | null>(null);
  const [downloads, setDownloads] = useState<ShareFileDownload[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwVerifying, setPwVerifying] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<SmartDownloadProgress | null>(null);
  const [downloadProgressFile, setDownloadProgressFile] = useState<ShareFileDownload | null>(null);
  const [downloadTaskState, setDownloadTaskState] = useState<DownloadTaskState>("idle");
  const [downloadCancelArmed, setDownloadCancelArmed] = useState(false);
  const [downloadPreviewSuspended, setDownloadPreviewSuspended] = useState(false);
  const [downloadConfig, setDownloadConfig] = useState<DownloadConfig>(() => defaultDownloadConfig());
  const [directoryDownloadSupported, setDirectoryDownloadSupported] = useState(false);
  const [qr, setQr] = useState("");
  const [reported, setReported] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [downloadState, setDownloadState] = useState<DownloadLinksState>("idle");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("files");

  const downloadAbortRef = useRef<AbortController | null>(null);

  const appendDebugLog = useCallback<DebugLogFn>(() => {}, []);

  const FooterSlogan = () => (
    <p className={`mt-16 mb-8 text-center font-tech text-[10px] tracking-[0.12em] ${s.tFaint}`}>
      {BRAND_SLOGAN_SHORT} · <a href="https://nyy.app" className="text-nyy-300 hover:text-nyy-200 transition-colors">{BRAND_DOMAIN}</a>
    </p>
  );

  // ===== 初始化:获取分享信息 =====
  useEffect(() => {
    if (!code) return;
    getShareInfo(code)
      .then((data) => {
        setShare(data);
        setMobilePanel(getDefaultMobilePanel(data));
        setDownloadState(data.has_password ? "idle" : "loading");
        setPageState(data.has_password ? "locked" : "ready");
        if (!data.has_password) void autoFetchDownloads();
      })
      .catch((err) => {
        if (isHttpStatusError(err, 410)) setPageState("expired");
        else if (isHttpStatusError(err, 404)) setPageState("not_found");
        else setPageState("error");
      });
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    getPublicDownloadConfig()
      .then((config) => { if (!cancelled) setDownloadConfig(config); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setDirectoryDownloadSupported(supportsDirectoryPicker());
  }, []);

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
    QRCode.toDataURL(window.location.href, { margin: 1, width: 180 })
      .then(setQr)
      .catch(() => {});
  }, []);

  // 自动获取下载 URL（无密码时）
  const autoFetchDownloads = async () => {
    try {
      const res = await downloadShare(code);
      setDownloads(res.files);
      setDownloadState("ready");
    } catch {
      // 预览不可用，但不阻塞页面——用户仍可通过下载按钮获取
      setDownloadState("error");
    }
  };

  // ===== 密码验证 =====
  const handleVerify = async () => {
    if (pwInput.length !== 4) { setPwError("请输入4位提取码"); return; }
    setPwVerifying(true);
    setPwError("");
    try {
      const res = await verifyShare(code, pwInput);
      setDownloads(res.files);
      setDownloadState("ready");
      setPageState("ready");
      appendDebugLog("page", "verify:ok", { files: res.files.length });
    } catch (err) {
      setPwError(getErrorMessage(err, "提取码错误"));
      appendDebugLog("page", "verify:fail", { error: getErrorMessage(err) });
    } finally {
      setPwVerifying(false);
    }
  };

  // ===== 获取下载 URL（密码已验证或无密码时） =====
  const fetchDownloadUrls = async (): Promise<{ files: ShareFileDownload[]; emptyDirs: string[] } | null> => {
    try {
      setDownloadState("loading");
      if (share?.has_password) {
        const res = await verifyShare(code, pwInput);
        setDownloadState("ready");
        return { files: res.files, emptyDirs: res.empty_dirs };
      } else {
        const res = await downloadShare(code);
        setDownloadState("ready");
        return { files: res.files, emptyDirs: res.empty_dirs };
      }
    } catch (err) {
      setDownloadState("error");
      setPwError(getErrorMessage(err, "获取下载链接失败"));
      return null;
    }
  };

  // ===== 下载 =====
  const handleDownloadSingle = async () => {
    if (!share) return;
    setDownloading(true);
    setPwError("");
    const res = await fetchDownloadUrls();
    if (!res) { setDownloading(false); return; }
    setDownloads(res.files);

    if (res.files.length === 1 && res.emptyDirs.length === 0) {
      const f = res.files[0];
      await downloadOneFile(f);
    }
    setDownloading(false);
  };

  const handleDownloadAll = async () => {
    if (!share) return;
    const filesToDownload = downloads;
    const emptyDirs = share.empty_dirs;
    if (filesToDownload.length === 0 && emptyDirs.length === 0) return;
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
    downloadAbortRef.current?.abort();
    const abortController = new AbortController();
    downloadAbortRef.current = abortController;
    let lastProgress: SmartDownloadProgress | null = null;
    setDownloading(true);
    setPwError("");
    setDownloadCancelArmed(false);
    setDownloadProgress(null);
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
      setDownloadProgress(null);
      setDownloadProgressFile(null);
      setDownloadTaskState("idle");
      if (err instanceof DOMException && err.name === "AbortError") {
        showToast({ title: "下载已取消", type: "info" });
      } else {
        showToast({ title: getErrorMessage(err, "批量保存失败"), type: "error" });
      }
    } finally {
      if (downloadAbortRef.current === abortController) downloadAbortRef.current = null;
      setDownloadPreviewSuspended(false);
      setDownloading(false);
    }
  };

  const handleCopyLink = () => {
    const text = window.location.href;
    if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text); }
    else { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); }
    showToast({ title: "链接已复制", type: "success" });
  };

  // 下载单个文件（文件列表行内图标使用）
  const downloadOneFile = async (file: ShareFileDownload) => {
    if (!file.is_chunked && !isSafeUrl(file.download_url)) { showToast({ title: "下载链接无效", type: "error" }); return; }
    if (file.is_chunked && !file.chunks.every((chunk) => isSafeUrl(chunk.download_url))) { showToast({ title: "下载链接无效", type: "error" }); return; }
    downloadAbortRef.current?.abort();
    const abortController = new AbortController();
    downloadAbortRef.current = abortController;
    let lastProgress: SmartDownloadProgress | null = null;
    setDownloading(true);
    setDownloadProgress(null);
    setDownloadProgressFile(file);
    setDownloadTaskState("running");
    setDownloadPreviewSuspended(shouldSuspendPreviewForDownload(file));
    try {
      await downloadSmart(file, {
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

  const handleCancelDownload = () => {
    downloadAbortRef.current?.abort();
  };

  const handleDismissDownloadHud = () => {
    setDownloadProgress(null);
    setDownloadProgressFile(null);
    setDownloadTaskState("idle");
    setDownloadCancelArmed(false);
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
  const selectedFile = downloads.length > 0 ? downloads[Math.min(selectedIdx, downloads.length - 1)] : null;
  const selectedType = selectedFile ? classifyFile(selectedFile.file_name) : "other";
  // 选中文件的“元信息”：share.files 在第一阶段（getShareInfo）就有 file_name/file_size，
  // 据此让文件名+操作栏区域提前以恒定高度渲染，避免 downloads 后到时把布局挤开。
  const selectedMeta = share && share.files.length > 0 ? share.files[Math.min(selectedIdx, share.files.length - 1)] : null;
  const downloadProgressRatio = downloadProgress ? getProgressRatio(downloadProgress) : 0;
  const downloadProgressPercentLabel = downloadProgress ? getDownloadPercentLabel(downloadProgress, downloadTaskState) : "0%";
  const downloadProgressName = downloadProgress?.currentFileName || downloadProgressFile?.file_name || selectedMeta?.file_name || "正在下载的文件";
  const downloadSpeedLabel = downloadTaskState === "completed" ? "已完成" : downloadProgress ? formatSpeed(downloadProgress.bytesPerSecond) : "计算中";
  const downloadEtaLabel = downloadProgress && downloadProgress.bytesPerSecond > 0
    ? formatDuration((Math.max(0, downloadProgress.totalBytes - downloadProgress.downloadedBytes)) / downloadProgress.bytesPerSecond)
    : "计算中";
  const downloadBatchLabel = downloadProgress?.totalFiles && downloadProgress.totalFiles > 1
    ? `第 ${downloadProgress.currentFileIndex || 1} / ${downloadProgress.totalFiles} 个 · `
    : "";
  const downloadStatusLabel = downloadTaskState === "completed" ? "已保存到本地" : "请保持页面打开";
  const downloadHintLabel = downloadTaskState === "completed" ? "可以关闭此提示" : `${downloadBatchLabel}预计剩余 ${downloadEtaLabel}`;
  const showDownloadHud = Boolean(downloadProgress && downloadProgressFile && downloadTaskState !== "idle");
  const downloadActionLabel = downloadTaskState === "completed" ? "关闭" : "取消下载";
  const handleDownloadRailAction = () => {
    if (downloadTaskState === "completed") {
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
        <a href="/" className="font-tech text-xs tracking-widest text-nyy-400 hover:text-nyy-300 underline">返回首页</a>
      </StatusPage>
    );
  }

  if (pageState === "expired") {
    return (
      <StatusPage>
        <Clock className={`w-12 h-12 ${s.tMuted}`} />
        <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>分享已过期</p>
        <a href="/" className="font-tech text-xs tracking-widest text-nyy-400 hover:text-nyy-300 underline">返回首页</a>
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
    return (
      <main className={`nyy-product-shell flex flex-col items-center justify-center px-4 ${s.tPrimary}`}>
        <ThemeToggle className="fixed top-4 right-4 z-50" />

        <div className={`${s.glass} p-10 max-w-sm w-full text-center animate-vault-open`}>
          <BrandLogo href="/" className="w-28 h-auto mx-auto mb-6" />
          <h1 className={`font-tech text-lg font-bold tracking-[0.15em] ${s.tPrimary} mb-2`}>安全保险库</h1>
          <p className={`font-tech text-[11px] tracking-[0.1em] ${s.tMuted} mb-8`}>请输入 4 位提取码解锁</p>

          {/* 4 位数字方块 */}
          <div className="flex justify-center gap-3 mb-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={`${s.digitCell} ${pwInput[i] ? s.filled : ""} ${pwError ? s.error : ""} ${pwVerifying ? s.scanning : ""}`}>
                {pwInput[i] || "·"}
              </div>
            ))}
          </div>

          {/* 隐藏的真输入框 */}
          <input
            type="text" maxLength={4} inputMode="numeric" autoFocus
            value={pwInput}
            onChange={(e) => { setPwInput(e.target.value.replace(/\D/g, "").slice(0, 4)); setPwError(""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && pwInput.length === 4) void handleVerify(); }}
            className="sr-only"
            aria-label="输入4位提取码"
            id="pwInput"
          />
          <label htmlFor="pwInput" className="block mb-6 cursor-pointer">
            <span className={`font-tech text-[11px] tracking-widest ${s.tMuted}`}>点击输入提取码</span>
          </label>

          {pwError && <p role="alert" className="font-tech text-xs tracking-widest text-red-400 mb-4">{pwError}</p>}

          <button onClick={handleVerify} disabled={pwInput.length !== 4 || pwVerifying}
            className={`${s.glowBtn} w-full py-4 font-tech text-sm font-bold tracking-[0.12em] flex items-center justify-center gap-2`}>
            {pwVerifying ? "验证中…" : <><Play className="w-4 h-4 fill-current" /> 解锁</>}
          </button>

          {/* 分享元信息（不泄露文件名） */}
          <div className="mt-8 grid grid-cols-2 gap-4 text-center">
            <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>文件数</span><span className={`font-tech text-base font-bold ${s.tPrimary}`}>{share.files.length}</span></div>
            <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>总大小</span><span className={`font-tech text-base font-bold ${s.tPrimary}`}>{formatSize(share.total_bytes)}</span></div>
          </div>
        </div>

        {/* 底部品牌 */}
        <p className={`mt-8 text-center font-tech text-[10px] tracking-[0.12em] ${s.tFaint}`}>
          {BRAND_SLOGAN_SHORT} · <a href="https://nyy.app" className="text-nyy-300 hover:text-nyy-200 transition-colors">{BRAND_DOMAIN}</a>
        </p>
      </main>
    );
  }

  // ===== Ready 状态：4C 主布局 =====
  const isSingle = share.files.length === 1 && share.empty_dirs.length === 0;
  const hasOnlyEmptyDirs = share.files.length === 0 && share.empty_dirs.length > 0;

  const effectiveFiles = downloads.length > 0 ? downloads : share.files;
  const contentSummary = getShareContentSummary(share);
  const expiryLabel = getExpiryLabel(share);
  const downloadLabel = getDownloadLabel(share);
  const showMultiDownloadActions = !isSingle && !hasOnlyEmptyDirs && downloadState === "ready" && !!selectedFile;
  const showLinkFetchButton =
    (isSingle && downloadState === "error") ||
    (!isSingle && !hasOnlyEmptyDirs && !showMultiDownloadActions);
  const canBatchSaveToDirectory = downloadConfig.smart_download_enabled && downloadConfig.filesystem_access_enabled && directoryDownloadSupported;
  const batchDownloadLabel = canBatchSaveToDirectory ? "保存到文件夹" : "请逐个下载";
  const batchDownloadBusyLabel = canBatchSaveToDirectory ? "保存中…" : "请逐个下载";
  const activeMobilePanel = isSingle && mobilePanel === "files" ? "overview" : mobilePanel;
  const mobileTabs: Array<{ id: MobilePanel; label: string }> = isSingle
    ? [{ id: "overview", label: "概览" }, { id: "scan", label: "扫码" }]
    : [{ id: "files", label: "文件" }, { id: "overview", label: "概览" }, { id: "scan", label: "扫码" }];

  const renderFileListContent = (variant: "desktop" | "mobile") => (
    <ShareFileBrowser
      files={effectiveFiles}
      emptyDirs={share.empty_dirs}
      downloadsReady={downloads.length > 0}
      selectedIndex={selectedIdx}
      onSelectFile={setSelectedIdx}
      onDownloadFile={(file) => { void downloadOneFile(file); }}
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

  return (
    <main className={`nyy-product-shell ${s.tPrimary}`}>
      <div className="nyy-product-content max-w-[1320px] mx-auto px-4 py-6 lg:px-10">
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
            {/* 黑色 16:9 外框始终存在、不卸载，仅内部内容切换时淡入，杜绝闪烁 */}
            <div className={s.stagePlayer}>
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
                      <MkvVideoPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile); }} debugLog={appendDebugLog} />
                    ) : needsSdpPlayer(selectedFile) ? (
                      <SelfDevelopPlayer file={selectedFile} className={s.sdpFill} debugLog={appendDebugLog} />
                    ) : isAc3Mp4(selectedFile) ? (
                      <Ac3VideoPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile); }} />
                    ) : isEac3Mp4(selectedFile) ? (
                      <UnsupportedVideoPreview
                        message="当前客户端解码器尚不支持 E-AC-3 音频；为避免误播无声视频，请先下载后使用本地播放器查看。"
                        onDownload={() => { void downloadOneFile(selectedFile); }}
                      />
                    ) : (
                      <NativeVideoPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile); }} />
                    )
                  )}
                  {/* 图片 */}
                  {!downloadPreviewSuspended && selectedType === "image" && isSafeUrl(selectedFile.download_url) && (
                    <div className={s.imageStage}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={selectedFile.download_url} alt={selectedFile.file_name} className="max-w-full max-h-full object-contain rounded-lg" />
                    </div>
                  )}
                  {/* PDF */}
                  {!downloadPreviewSuspended && selectedType === "pdf" && (
                    <PdfPreview url={selectedFile.download_url} className={`w-full h-full ${s.pdfScroll}`} />
                  )}
                  {/* 音频 */}
                  {!downloadPreviewSuspended && selectedType === "audio" && (
                    <AudioPreview file={selectedFile} onDownload={() => { void downloadOneFile(selectedFile); }} />
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
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                      <div className="w-20 h-20 rounded-2xl bg-white/6 border border-white/10 flex items-center justify-center text-3xl">⋯</div>
                      <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>{selectedFile.file_name}</p>
                      <p className={`text-xs ${s.tMuted}`}>{formatSize(selectedFile.file_size)}</p>
                    </div>
                  )}
                </div>
              ) : (
                /* 占位（加载中/仅空文件夹）——同一外框内淡入，外框尺寸不变故无跳变 */
                <div className={`${s.stageContent} flex items-center justify-center`}>
                  <div className="text-center">
                    <BrandLogo className="w-20 h-auto mx-auto mb-4 opacity-30" />
                    <p className={`font-tech text-xs tracking-widest ${s.tMuted}`}>
                      {hasOnlyEmptyDirs ? "该分享仅包含空文件夹" : "选择一个文件开始预览"}
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
                    className="retro-icon-button h-9 w-9"
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
              {isSingle && downloadState === "ready" && downloads[0] && (
                <button onClick={() => { if (downloads[0]) void downloadOneFile(downloads[0]); }} disabled={downloading || !downloads[0]}
                  className={`${s.glowBtn} col-span-2 w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                  <Download className="w-4 h-4" />
                  {downloading ? "下载中…" : "下载此文件"}
                </button>
              )}
              {isSingle && downloadState === "loading" && (
                <button disabled
                  className={`${s.glowBtn} col-span-2 w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2 opacity-50 cursor-not-allowed`}>
                  <Download className="w-4 h-4" />
                  获取中…
                </button>
              )}
              {showMultiDownloadActions && (
                <>
                  <button onClick={() => { if (selectedFile) void downloadOneFile(selectedFile); }} disabled={downloading || !selectedFile}
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
                <button onClick={handleDownloadSingle} disabled={downloading || downloadState === "loading"}
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
              <button onClick={() => setReportOpen(true)} disabled={reported} className="retro-text-button retro-text-button-danger min-h-0 px-2 py-1 text-xs"><Flag className="w-3 h-3" /> {reported ? "已举报" : "举报"}</button>
              <a href="/" className="hover:text-yc-accent transition-colors">返回首页</a>
            </div>
          </aside>
        </div>

        {/* 底部品牌 */}
        <FooterSlogan />
      </div>

      {/* 智能下载进度：固定在视口，避免长文件列表把进度挤到页面底部 */}
      {showDownloadHud && downloadProgress && (
        <div
          className={`${s.downloadHud} ${downloadTaskState === "completed" ? s.downloadHudComplete : ""}`}
          role="status"
          aria-live="polite"
        >
          <div className={s.downloadHudVeil} />
          <div className="relative grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2 pr-1">
                <span className={s.downloadStatusPill}>{downloadTaskState === "completed" && <CheckCircle2 className="h-3 w-3" />}{downloadStatusLabel}</span>
                <p className={`min-w-0 flex-1 truncate font-tech text-sm font-black tracking-wide ${s.tPrimary}`} title={downloadProgressName}>
                  {downloadProgressName}
                </p>
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
        </div>
      )}

      {/* 举报 Modal */}
      {reportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setReportOpen(false)} />
          <div className={`${s.glass} relative w-full max-w-sm p-6`}>
            <button type="button" onClick={() => setReportOpen(false)} aria-label="关闭举报弹窗" className="retro-close-button absolute right-4 top-4"><X className="h-4 w-4" /></button>
            <h3 className={`font-tech text-sm tracking-widest font-bold mb-2 ${s.tPrimary}`}>举报分享</h3>
            <p className={`text-xs ${s.tMuted} mb-4`}>请选择举报原因。</p>
            <select value={reportReason} onChange={(e) => setReportReason(e.target.value)}
              className={`w-full bg-white/6 border border-white/10 rounded-lg px-3 py-2.5 text-sm ${s.tPrimary} focus:outline-none focus:border-yc-accent mb-4`}>
              <option value="" className="text-black">选择原因…</option>
              <option value="侵权内容" className="text-black">侵权内容</option>
              <option value="恶意软件" className="text-black">恶意软件</option>
              <option value="违法内容" className="text-black">违法内容</option>
              <option value="其他" className="text-black">其他</option>
            </select>
            <button onClick={handleReport} disabled={!reportReason}
              className={`${s.glowBtn} w-full py-3 font-tech text-xs tracking-widest`}>
              提交举报
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
