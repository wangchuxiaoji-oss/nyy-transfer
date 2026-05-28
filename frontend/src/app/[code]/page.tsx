"use client";

import { useEffect, useId, useState } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import QRCode from "qrcode";
import { Download, FileIcon, Clock, AlertCircle, Lock, Play, Package, Files, Flag, QrCode, Copy, X, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandLogo } from "@/components/brand-logo";
import {
  getShareInfo, verifyShare, downloadShare, reportShare,
  type ShareInfo, type ShareFileDownload,
} from "@/lib/api";
import { getErrorMessage, isHttpStatusError } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";

type PageState = "loading" | "ready" | "not_found" | "expired" | "error";
const VIDEO_EXTS = ["mp4", "webm", "ogg", "mov"];

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
  const [videoUrl, setVideoUrl] = useState("");
  const [qr, setQr] = useState("");
  const [reported, setReported] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const { showToast } = useToast();

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

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  const fetchDownloadUrls = async (): Promise<{ files: ShareFileDownload[]; emptyDirs: string[] } | null> => {
    try {
      if (share?.has_password) {
        if (password.length !== 4) { setPwError("请输入4位提取码"); return null; }
        const res = await verifyShare(code, password);
        return { files: res.files, emptyDirs: res.empty_dirs };
      } else {
        const res = await downloadShare(code);
        return { files: res.files, emptyDirs: res.empty_dirs };
      }
    } catch (err) {
      setPwError(getErrorMessage(err, "获取下载链接失败"));
      return null;
    }
  };

  const handleDownload = async () => {
    if (!share) return;
    setDownloading(true);
    setPwError("");
    const res = await fetchDownloadUrls();
    if (!res) { setDownloading(false); return; }
    const files = res.files;
    setDownloads(files);

    if (files.length === 1 && res.emptyDirs.length === 0) {
      // Single file: trigger browser download
      const a = document.createElement("a");
      a.href = files[0].download_url;
      a.download = files[0].file_name;
      a.rel = "noopener";
      a.click();
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
    showToast({ title: "链接已复制", type: "success" });
  };

  const downloadZipArchive = async (files: ShareFileDownload[], emptyDirs: string[]) => {
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
  };

  const handleDownloadAll = async () => {
    if (downloads.length === 0 && (!share || share.empty_dirs.length === 0)) return;
    setDownloading(true);
    try {
      await downloadZipArchive(downloads, share?.empty_dirs || []);
    } catch {
      setPwError("打包下载失败");
    }
    setDownloading(false);
  };

  const handlePreview = async () => {
    if (!share) return;
    const res = await fetchDownloadUrls();
    if (res && res.files.length > 0) {
      const videoFile = res.files.find((f) => VIDEO_EXTS.includes(f.file_name.split(".").pop()?.toLowerCase() || ""));
      if (videoFile) setVideoUrl(videoFile.download_url);
      setDownloads(res.files);
    }
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
  const hasVideo = share.files.some((f) => VIDEO_EXTS.includes(f.file_ext.toLowerCase()));

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
                <p className="type-file-meta text-gray-600 dark:text-gray-400">{formatSize(f.file_size)}</p>
              </div>
              {/* Individual download if URLs available */}
              {downloads[i] && (
                <a href={downloads[i].download_url} target="_blank" rel="noopener" download={downloads[i].file_name} aria-label={`下载 ${f.file_name}`} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-xl hover:bg-nyy-50">
                  <Download className="w-4 h-4 text-nyy-500" />
                </a>
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

        {/* Video preview */}
        {hasVideo && videoUrl && (
          <video src={videoUrl} controls className="w-full rounded-2xl" preload="metadata" />
        )}
        {hasVideo && !videoUrl && !share.has_password && (
          <button onClick={handlePreview} className="type-action flex min-h-[44px] w-full items-center justify-center gap-2 rounded-2xl border border-nyy-300 dark:border-nyy-700 text-nyy-800 dark:text-nyy-400 hover:bg-nyy-50 dark:hover:bg-nyy-900/20">
            <Play className="w-4 h-4" /> 预览视频
          </button>
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
