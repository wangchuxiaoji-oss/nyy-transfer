"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { Download, Clock, AlertCircle, Package, Copy, Flag, X, Folder, Play } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { SelfDevelopPlayer } from "@/components/self-develop-player";
import { PdfPreview } from "@/components/pdf-preview";
import {
  getShareInfo, verifyShare, downloadShare, reportShare,
  type ShareInfo, type ShareFileDownload,
} from "@/lib/api";
import { supportsChunkedDownload, chunkedDownload, type ChunkedDownloadProgress } from "@/lib/chunked-download";
import { getErrorMessage, isHttpStatusError } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import type { DebugLogFn } from "@/lib/debug";
import s from "./share-4c.module.css";

type PageState = "loading" | "locked" | "ready" | "not_found" | "expired" | "error";
type FileType = "video" | "image" | "pdf" | "audio" | "text" | "other";

// 分类文件类型（用于选择图标 + 预览策略）
function classifyFile(name: string): FileType {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mkv", "wmv", "mov", "webm", "ogg"].includes(ext)) return "video";
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

function getFileExtClass(type: FileType): string {
  switch (type) {
    case "video": return "bg-gradient-to-br from-yc-accent to-yc-accent-3";
    case "image": return "bg-gradient-to-br from-yc-accent-2 to-yc-mesh-2";
    case "pdf": return "bg-gradient-to-br from-yc-accent-3 to-yc-mesh-2";
    case "audio": return "bg-gradient-to-br from-emerald-400 to-yc-accent-2";
    default: return "bg-white/10";
  }
}

function getFileIcon(type: FileType): string {
  switch (type) {
    case "video": return "▶";
    case "image": return "🖼";
    case "pdf": return "📄";
    case "audio": return "♪";
    case "text": return "¶";
    default: return "⋯";
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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
  const [chunkProgress, setChunkProgress] = useState<ChunkedDownloadProgress | null>(null);
  const [qr, setQr] = useState("");
  const [reported, setReported] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [theme, setTheme] = useState<"dark" | "light" | "auto">("dark");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  // ===== Debug（精简版，保留 appendDebugLog 用于 SDP 播放器回调） =====

  const appendDebugLog = useCallback<DebugLogFn>(() => {}, []);

  // ===== 主题 =====
  useEffect(() => {
    const saved = localStorage.getItem("nyy-theme-4c");
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      root.setAttribute("data-theme", prefersDark ? "dark" : "light");
    } else {
      root.setAttribute("data-theme", theme);
    }
    localStorage.setItem("nyy-theme-4c", theme);
  }, [theme]);

  // ===== 初始化:获取分享信息 =====
  useEffect(() => {
    if (!code) return;
    getShareInfo(code)
      .then((data) => {
        setShare(data);
        setPageState(data.has_password ? "locked" : "ready");
        if (!data.has_password) void autoFetchDownloads();
      })
      .catch((err) => {
        if (isHttpStatusError(err, 410)) setPageState("expired");
        else if (isHttpStatusError(err, 404)) setPageState("not_found");
        else setPageState("error");
      });
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

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
    } catch {
      // 预览不可用，但不阻塞页面——用户仍可通过下载按钮获取
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
      if (share?.has_password) {
        const res = await verifyShare(code, pwInput);
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
      if (f.is_chunked && f.chunks.length > 0) {
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
          if (!(err instanceof DOMException && err.name === "AbortError")) setPwError(getErrorMessage(err, "下载失败"));
        }
      } else {
        const a = document.createElement("a");
        if (!isSafeUrl(f.download_url)) { setPwError("下载链接无效"); setDownloading(false); return; }
        a.href = f.download_url; a.download = f.file_name; a.rel = "noopener"; a.click();
      }
    }
    setDownloading(false);
  };

  const handleDownloadAll = async () => {
    if (downloads.length === 0 && (!share || share.empty_dirs.length === 0)) return;
    setDownloading(true);
    try {
      const { downloadZip } = await import("client-zip");
      const responses = await Promise.all(downloads.map(async (f) => ({ name: f.file_name, input: await fetch(f.download_url) })));
      const folders = (share?.empty_dirs || []).map((dir) => ({ name: dir.endsWith("/") ? dir : `${dir}/` }));
      const blob = await downloadZip([...folders, ...responses]).blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${code}.zip`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      setPwError("打包下载失败");
    }
    setDownloading(false);
  };

  const handleCopyLink = () => {
    const text = window.location.href;
    if (navigator.clipboard?.writeText) { void navigator.clipboard.writeText(text); }
    else { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); document.body.removeChild(ta); }
    showToast({ title: "链接已复制", type: "success" });
  };

  const handleReport = async () => {
    if (!reportReason.trim()) return;
    try { await reportShare(code, reportReason.trim()); setReported(true); setReportOpen(false); setReportReason(""); showToast({ title: "举报已提交", type: "success" }); }
    catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
  };

  // ===== 选中文件预览 =====
  const selectedFile = downloads.length > 0 ? downloads[Math.min(selectedIdx, downloads.length - 1)] : null;
  const selectedType = selectedFile ? classifyFile(selectedFile.file_name) : "other";

  // 主题切换按钮（三处状态页/主页面共用，统一主题感知配色）
  const ThemeToggle = () => (
    <div className="fixed top-4 right-4 z-50 flex gap-1 bg-white/6 rounded-lg border border-white/10 backdrop-blur-xl p-1">
      {(["light", "auto", "dark"] as const).map((t) => (
        <button key={t} onClick={() => setTheme(t)} title={t === "light" ? "浅色" : t === "dark" ? "深色" : "自动"}
          className={`w-8 h-8 rounded-md text-sm flex items-center justify-center transition-all ${theme === t ? "bg-nyy-500 text-white shadow-[0_0_14px_rgba(255,138,61,0.6)]" : `${s.tSecondary} hover:opacity-80`}`}>
          {t === "light" ? "☀" : t === "dark" ? "☾" : "◐"}
        </button>
      ))}
    </div>
  );

  // ===== 状态页渲染 =====
  if (pageState === "loading") {
    return (
      <main className={`min-h-dvh flex items-center justify-center ${s.meshBg}`}>
        <div className="text-center">
          <BrandLogo className={`w-32 h-auto mx-auto mb-4 ${s.logoBreath}`} />
          <p className={`font-tech text-sm tracking-[0.2em] ${s.tSecondary}`}>正在打开保险库…</p>
        </div>
      </main>
    );
  }

  // 状态页共用的 logo + 主题切换
  const StatusPage = ({ children }: { children: React.ReactNode }) => (
    <main className={`min-h-dvh flex flex-col items-center justify-center gap-4 ${s.meshBg}`}>
      <ThemeToggle />
      <BrandLogo className="w-24 h-auto mx-auto mb-2 opacity-60" />
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
      <main className={`min-h-dvh flex flex-col items-center justify-center px-4 ${s.meshBg}`}>
        <ThemeToggle />

        <div className={`${s.glass} p-10 max-w-sm w-full text-center animate-vault-open`}>
          <BrandLogo className="w-28 h-auto mx-auto mb-6" />
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
        <p className={`mt-8 font-tech text-[10px] tracking-[0.15em] ${s.tFaint}`}>由拿呀呀 SDP 自研引擎驱动</p>
      </main>
    );
  }

  // ===== Ready 状态：4C 主布局 =====
  const isSingle = share.files.length === 1 && share.empty_dirs.length === 0;
  const hasOnlyEmptyDirs = share.files.length === 0 && share.empty_dirs.length > 0;

  return (
    <main className={`min-h-dvh overflow-x-hidden ${s.meshBg} ${s.tPrimary}`}>
      <ThemeToggle />

      <div className="max-w-[1320px] mx-auto px-4 py-6 lg:px-10">
        {/* Topbar */}
        <div className={`${s.glass} flex items-center justify-between gap-4 px-6 py-4 mb-5`}>
          <div className="flex items-center gap-3">
            <BrandLogo className="w-28 h-auto" />
            <span className="font-tech text-sm font-bold tracking-[0.12em] text-yc-accent px-3 py-1.5 bg-white/6 border border-white/10 rounded-md">{code}</span>
          </div>
          <div className={`hidden md:flex items-center gap-6 text-xs ${s.tSecondary}`}>
            <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>文件数</span><b className={`font-tech ${s.tPrimary}`}>{share.files.length}</b></div>
            <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>总大小</span><b className={`font-tech ${s.tPrimary}`}>{formatSize(share.total_bytes)}</b></div>
            {share.expires_at && <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>到期</span><b className={`font-tech ${s.tPrimary}`}>{new Date(share.expires_at).toLocaleDateString("zh-CN")}</b></div>}
            {share.max_downloads > 0 && <div><span className={`block font-tech text-[10px] tracking-[0.1em] ${s.tMuted}`}>下载次数</span><b className={`font-tech ${s.tPrimary}`}>{share.download_count} / {share.max_downloads}</b></div>}
          </div>
        </div>

        {/* 主体两栏 */}
        <div className={`grid gap-5 ${s.desktopTwoCol}`}>
          {/* 左:内联预览舞台 */}
          <div>
            {downloads.length > 0 ? (
              <div className="animate-fade-in">
                <div className={`${s.stagePlayer} min-h-[320px]`}>
                  {/* 视频:SDP 播放器 */}
                  {selectedType === "video" && selectedFile && (
                    <SelfDevelopPlayer file={selectedFile} className={s.sdpFill} debugLog={appendDebugLog} />
                  )}
                  {/* 图片 */}
                  {selectedType === "image" && selectedFile && isSafeUrl(selectedFile.download_url) && (
                    <div className={s.imageStage}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={selectedFile.download_url} alt={selectedFile.file_name} className="max-w-full max-h-full object-contain rounded-lg" />
                    </div>
                  )}
                  {/* PDF */}
                  {selectedType === "pdf" && selectedFile && (
                    <PdfPreview url={selectedFile.download_url} className={`w-full h-full ${s.pdfScroll}`} />
                  )}
                  {/* 音频 */}
                  {selectedType === "audio" && selectedFile && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-gradient-to-br from-yc-bg via-yc-mesh-1 to-yc-mesh-2">
                      <div className="w-44 h-44 rounded-2xl bg-gradient-to-br from-yc-accent to-yc-accent-3 flex items-center justify-center text-6xl text-white shadow-[0_0_48px_rgba(255,138,61,0.5)]">♪</div>
                      <p className={`font-tech font-bold tracking-widest ${s.tPrimary}`}>{selectedFile.file_name}</p>
                      <p className={`text-xs ${s.tMuted}`}>{formatSize(selectedFile.file_size)}</p>
                      <div className={s.audioWave}>
                        {Array.from({ length: 24 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.06}s` }} />)}
                      </div>
                    </div>
                  )}
                  {/* 文本 */}
                  {selectedType === "text" && selectedFile && (
                    <div className={s.textScroll}>
                      <div className={s.textContent}>
                        <p className={`${s.tMuted} mb-2`}># {selectedFile.file_name}</p>
                        <p className={s.tSecondary}>文本预览需要下载后查看。</p>
                        <p className={`${s.tMuted} mt-4 text-xs`}>文件大小: {formatSize(selectedFile.file_size)}</p>
                      </div>
                    </div>
                  )}
                  {/* 其他 */}
                  {selectedType === "other" && selectedFile && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                      <div className="w-20 h-20 rounded-2xl bg-white/6 border border-white/10 flex items-center justify-center text-3xl">⋯</div>
                      <p className={`font-tech text-sm tracking-widest ${s.tSecondary}`}>{selectedFile.file_name}</p>
                      <p className={`text-xs ${s.tMuted}`}>{formatSize(selectedFile.file_size)}</p>
                    </div>
                  )}
                </div>
                {/* 文件名 + 操作栏 */}
                {selectedFile && (
                <div className="flex items-center justify-between gap-4 mt-4 flex-wrap">
                  <div className="min-w-0">
                    <p className={`font-tech text-lg font-bold tracking-wide truncate ${s.tPrimary}`}>{selectedFile.file_name}</p>
                    <p className={`font-tech text-xs ${s.tMuted} mt-1`}>
                      {formatSize(selectedFile.file_size)}
                      {selectedFile.is_chunked && ` · ${selectedFile.chunks.length} 分片`}
                    </p>
                  </div>
                  <div className="flex gap-3">
                    {!selectedFile.is_chunked && isSafeUrl(selectedFile.download_url) && (
                      <a href={selectedFile.download_url} download={selectedFile.file_name} className={`${s.ghostBtn} px-4 py-2.5 font-tech text-xs tracking-widest flex items-center gap-2`}><Download className="w-4 h-4" /> 下载</a>
                    )}
                    <button onClick={handleDownloadAll} disabled={downloading}
                      className={`${s.glowBtn} px-4 py-2.5 font-tech text-xs tracking-widest flex items-center gap-2`}>
                      <Package className="w-4 h-4" />
                      {downloading ? "打包中…" : `打包 ${formatSize(share.total_bytes)}`}
                    </button>
                  </div>
                </div>
                )}
              </div>
            ) : (
              /* 没有 downloads 时显示占位 */
              <div className={`${s.stagePlayer} min-h-[320px] flex items-center justify-center`}>
                <div className="text-center">
                  <BrandLogo className="w-20 h-auto mx-auto mb-4 opacity-30" />
                  <p className={`font-tech text-xs tracking-widest ${s.tMuted}`}>
                    {hasOnlyEmptyDirs ? "该分享仅包含空文件夹" : "选择一个文件开始预览"}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* 右:侧栏 */}
          <aside className="flex flex-col gap-4">
            {/* 文件列表 */}
            <div className={`${s.glass} p-4`}>
              <div className="flex items-center justify-between mb-3">
                <span className={`font-tech text-[11px] tracking-[0.1em] ${s.tMuted}`}>{share.files.length + share.empty_dirs.length} 项 · {formatSize(share.total_bytes)}</span>
                <div className="flex gap-1 bg-white/6 border border-white/10 rounded-md p-0.5">
                  <button onClick={() => setViewMode("list")} title="列表视图" className={`px-2 py-1 rounded text-xs transition-all ${viewMode === "list" ? "bg-yc-accent text-white" : s.tMuted}`}>≡</button>
                  <button onClick={() => setViewMode("grid")} title="网格视图" className={`px-2 py-1 rounded text-xs transition-all ${viewMode === "grid" ? "bg-yc-accent text-white" : s.tMuted}`}>▦</button>
                </div>
              </div>

              {/* 空文件夹 */}
              {share.empty_dirs.map((dir) => (
                <div key={dir} className="flex items-center gap-3 px-3 py-2.5 mb-1.5 rounded-lg border border-white/8 bg-white/3">
                  <Folder className="w-5 h-5 text-yc-accent flex-shrink-0" />
                  <span className="text-sm truncate flex-1">{dir}</span>
                  <span className={`font-tech text-[10px] ${s.tMuted}`}>空</span>
                </div>
              ))}

              {/* 列表视图 */}
              {viewMode === "list" && downloads.length > 0 && (
                <div className="flex flex-col gap-1.5">
                  {downloads.map((dl, i) => {
                    const ft = classifyFile(dl.file_name);
                    const isActive = i === selectedIdx;
                    return (
                    <div key={i} onClick={() => setSelectedIdx(i)} role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedIdx(i); } }}
                      className={`${s.fileRow} flex items-center gap-3 px-3 py-2.5 rounded-lg border ${isActive ? s.active : "border-white/8 bg-white/3 hover:border-yc-accent"}`}>
                        <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm flex-shrink-0 text-white ${getFileExtClass(ft)}`}>
                          {getFileIcon(ft)}
                        </div>
                        <span className="text-sm truncate flex-1 font-medium">{dl.file_name}</span>
                        <span className={`font-tech text-[10px] ${s.tMuted}`}>{formatSize(dl.file_size)}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 网格视图 */}
              {viewMode === "grid" && downloads.length > 0 && (
                <div className="grid grid-cols-2 gap-2">
                  {downloads.map((dl, i) => {
                    const ft = classifyFile(dl.file_name);
                    const isActive = i === selectedIdx;
                    return (
                    <div key={i} onClick={() => setSelectedIdx(i)} role="button" tabIndex={0}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedIdx(i); } }}
                      className={`${s.fileRow} p-3 rounded-xl border ${isActive ? s.active : "border-white/8 bg-white/3 hover:border-yc-accent"} flex flex-col gap-2`}>
                        <div className={`aspect-[4/3] rounded-lg flex items-center justify-center text-2xl text-white ${getFileExtClass(ft)}`}>
                          {getFileIcon(ft)}
                        </div>
                        <span className="text-xs truncate font-medium">{dl.file_name}</span>
                        <span className={`font-tech text-[10px] ${s.tMuted}`}>{formatSize(dl.file_size)}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 没有 downloads 时显示文件名列表 */}
              {downloads.length === 0 && share.files.map((f, i) => {
                const ft = classifyFile(f.file_name);
                return (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5 mb-1.5 rounded-lg border border-white/8 bg-white/3">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm flex-shrink-0 text-white ${getFileExtClass(ft)}`}>
                      {getFileIcon(ft)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate font-medium">{f.file_name}</p>
                      <p className={`font-tech text-[10px] ${s.tMuted}`}>{formatSize(f.file_size)}</p>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 分享信息 */}
            <div className={`${s.glass} p-4`}>
              <p className={`font-tech text-[11px] tracking-[0.1em] ${s.tMuted} mb-3`}>分享信息</p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div><span className={`block font-tech text-[10px] ${s.tMuted}`}>下载次数</span><span className="font-tech font-bold">{share.download_count}</span></div>
                {share.expires_at && <div><span className={`block font-tech text-[10px] ${s.tMuted}`}>到期</span><span className="font-tech font-bold">{new Date(share.expires_at).toLocaleDateString("zh-CN")}</span></div>}
              </div>
            </div>

            {/* 二维码（移动端隐藏，仅复制链接即可） */}
            {qr && (
              <div className={`${s.glass} p-4 hidden lg:block`}>
                <p className={`font-tech text-[11px] tracking-[0.1em] ${s.tMuted} mb-3`}>扫码取件</p>
                <div className="flex items-center gap-3">
                  <Image src={qr} alt="二维码" width={92} height={92} unoptimized className="rounded-lg" />
                  <div className={`text-xs ${s.tMuted}`}>
                    <p>手机扫码</p><p>随时随地取件</p>
                  </div>
                </div>
              </div>
            )}

            {/* 操作按钮 */}
            <div className="flex flex-col gap-2">
              {downloads.length > 0 && !isSingle && (
                <button onClick={handleDownloadAll} disabled={downloading}
                  className={`${s.glowBtn} w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                  <Package className="w-4 h-4" />
                  {downloading ? "打包中…" : `打包下载 ${formatSize(share.total_bytes)}`}
                </button>
              )}
              {downloads.length === 0 && (
                <button onClick={handleDownloadSingle} disabled={downloading}
                  className={`${s.glowBtn} w-full py-3.5 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                  <Download className="w-4 h-4" />
                  {downloading ? "获取中…" : hasOnlyEmptyDirs ? "下载文件夹" : isSingle ? "下载" : "获取下载链接"}
                </button>
              )}
              {/* 复制链接（提权为主按钮，方便取件） */}
              <button onClick={handleCopyLink}
                className={`${s.ghostBtn} w-full py-3 font-tech text-xs tracking-widest flex items-center justify-center gap-2`}>
                <Copy className="w-4 h-4" /> 复制链接
              </button>
            </div>

            {/* 底部操作（举报 / 首页保持低调） */}
            <div className={`flex items-center justify-center gap-5 text-xs ${s.tMuted}`}>
              <button onClick={() => setReportOpen(true)} disabled={reported} className="flex items-center gap-1 hover:text-red-400 transition-colors disabled:opacity-40"><Flag className="w-3 h-3" /> {reported ? "已举报" : "举报"}</button>
              <a href="/" className="hover:text-yc-accent transition-colors">返回首页</a>
            </div>
          </aside>
        </div>

        {/* 分片下载进度 */}
        {chunkProgress && (
          <div className={`${s.glass} mt-4 p-4`}>
            <div className={`flex justify-between text-xs ${s.tSecondary} mb-2`}>
              <span className="font-tech">下载中 · 分片 {chunkProgress.currentChunk + 1}/{chunkProgress.totalChunks}</span>
              <span className="font-tech">{Math.round((chunkProgress.downloadedBytes / chunkProgress.totalBytes) * 100)}%</span>
            </div>
            <div className="h-2 bg-white/10 rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-yc-accent to-yc-accent-3 rounded-full transition-all duration-300"
                style={{ width: `${(chunkProgress.downloadedBytes / chunkProgress.totalBytes) * 100}%` }} />
            </div>
            <p className={`font-tech text-[10px] ${s.tMuted} mt-1`}>{formatSize(chunkProgress.downloadedBytes)} / {formatSize(chunkProgress.totalBytes)}</p>
          </div>
        )}

        {/* 底部品牌 */}
        <p className={`mt-16 mb-8 text-center font-tech text-[10px] tracking-[0.15em] ${s.tFaint}`}>由拿呀呀 SDP 自研引擎驱动</p>
      </div>

      {/* 举报 Modal */}
      {reportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setReportOpen(false)} />
          <div className={`${s.glass} relative w-full max-w-sm p-6`}>
            <button onClick={() => setReportOpen(false)} className={`absolute right-4 top-4 ${s.tMuted} hover:opacity-80`}><X className="h-5 w-5" /></button>
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
