"use client";

import { useState, useEffect } from "react";
import { X, FileText, Clock, Download, Trash2, Link2, Folder } from "lucide-react";
import QRCode from "qrcode";
import { getShareInfo, type ShareInfo, type GuestShareInfo } from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

function formatCountdown(expiresAt: string | null): string {
  if (!expiresAt) return "永不过期";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "已过期";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `${days}天${hours}小时`;
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${hours}小时${mins}分钟`;
}

interface Props {
  share: GuestShareInfo;
  open: boolean;
  onClose: () => void;
  onDelete: (code: string) => void;
  canDelete: boolean;
}

export function ShareDetailModal({ share, open, onClose, onDelete, canDelete }: Props) {
  const [detail, setDetail] = useState<ShareInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qrUrl, setQrUrl] = useState("");

  const shareUrl = share.url || `${typeof window !== "undefined" ? window.location.origin : ""}/${share.code}`;

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    setQrUrl("");
    getShareInfo(share.code)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : "加载失败"))
      .finally(() => setLoading(false));
    // Generate QR
    QRCode.toDataURL(shareUrl, { width: 200, margin: 2, color: { dark: "#2a1810" } })
      .then(setQrUrl)
      .catch(() => {});
  }, [open, share.code, shareUrl]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl bg-white dark:bg-[#1a1a1a] shadow-2xl p-5 sm:p-6 space-y-4 max-h-[90dvh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="type-section text-gray-900 dark:text-gray-100">
            分享详情
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* Loading / Error */}
        {loading && <p className="type-body-sm text-gray-500 text-center py-4">加载中...</p>}
        {error && <p className="type-body-sm text-red-500 text-center py-4">{error}</p>}

        {/* Content */}
        {detail && !loading && (
          <>
            {/* QR + Meta: side-by-side on desktop, stacked on mobile */}
            <div className="flex flex-col sm:flex-row gap-4 items-center sm:items-start">
              {/* QR Code */}
              {qrUrl && (
                <div className="shrink-0 flex flex-col items-center gap-1.5">
                  <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-white p-2">
                    <img src={qrUrl} alt="分享二维码" className="w-32 h-32 sm:w-36 sm:h-36" />
                  </div>
                  <span className="type-caption text-gray-400 dark:text-gray-500">扫码访问</span>
                </div>
              )}

              {/* Meta + URL */}
              <div className="flex-1 min-w-0 space-y-3 w-full">
                {/* Share URL */}
                <div className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-white/5 px-3 py-2">
                  <Link2 className="w-3.5 h-3.5 text-gray-400 shrink-0" />
                  <span className="type-body-sm text-orange-600 dark:text-orange-400 truncate font-mono">{shareUrl}</span>
                </div>

                {/* Meta info */}
                <div className="type-caption flex flex-wrap gap-x-4 gap-y-1 text-gray-500 dark:text-gray-400">
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    剩余 {formatCountdown(share.expires_at)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Download className="w-3 h-3" />
                    已下载 {detail.download_count}{detail.max_downloads > 0 ? `/${detail.max_downloads}` : ""} 次
                  </span>
                </div>

                {/* Total size (desktop only, mobile shows below file list) */}
                <p className="hidden sm:block type-body-sm text-gray-400 dark:text-gray-500">
                  共 {detail.files.length} 个文件，{detail.empty_dirs.length} 个空文件夹，{formatBytes(detail.total_bytes)}
                </p>
              </div>
            </div>

            {/* File list */}
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {detail.empty_dirs.map((dir) => (
                <div key={dir} className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-white/5 px-3 py-2">
                  <Folder className="w-4 h-4 text-gray-400 shrink-0" />
                  <span className="type-file-name flex-1 truncate text-gray-700 dark:text-gray-300">{dir}</span>
                  <span className="type-file-meta text-gray-400 shrink-0">空文件夹</span>
                </div>
              ))}
              {detail.files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-gray-50 dark:bg-white/5 px-3 py-2">
                  <FileText className="w-4 h-4 text-gray-400 shrink-0" />
                  <span className="type-file-name flex-1 truncate text-gray-700 dark:text-gray-300">{f.file_name}</span>
                  <span className="type-file-meta text-gray-400 shrink-0">{formatBytes(f.file_size)}</span>
                </div>
              ))}
            </div>

            {/* Total size (mobile) */}
            <p className="sm:hidden type-body-sm text-gray-400 dark:text-gray-500">
              共 {detail.files.length} 个文件，{detail.empty_dirs.length} 个空文件夹，{formatBytes(detail.total_bytes)}
            </p>

            {/* Delete button */}
            <button
              onClick={() => onDelete(share.code)}
              disabled={!canDelete}
              className="type-action w-full mt-2 flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {canDelete ? "删除此分享" : "无法删除（缺少令牌）"}
            </button>
            {!canDelete && (
              <p className="type-caption text-gray-400 text-center">该分享创建于功能上线前，请等待自动过期</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
