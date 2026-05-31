"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { User, FolderOpen, Upload, Inbox, Trash2, Eye, Clock } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { FileUploader } from "@/components/file-uploader";
import { FileRequestCreator } from "@/components/file-request-creator";
import { AuthModal } from "@/components/auth-modal";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { isLoggedIn, getMe, logout, type UserInfo } from "@/lib/auth";
import { guestRevokeShare, getGuestShares, type GuestShareInfo } from "@/lib/api";
import { ShareDetailModal } from "@/components/share-detail-modal";
import { formatDebugLine, type DebugLogFn } from "@/lib/debug";

interface DebugEntry {
  elapsedMs: number;
  scope: string;
  event: string;
  data?: Record<string, unknown>;
  line: string;
}

interface UploadDebugStatus {
  phase: string;
  uploadedBytes: number | null;
  totalBytes: number | null;
  speedBps: number | null;
  progress: number | null;
  metadataFiles: number;
  lastScope: string;
  lastEvent: string;
}

function formatCountdownShort(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "已过期";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  if (days > 0) return `${days}天后过期`;
  return `${hours}小时后过期`;
}

export default function Home() {
  const [authOpen, setAuthOpen] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [mode, setMode] = useState<"send" | "receive">("send");
  const [guestShares, setGuestShares] = useState<GuestShareInfo[]>([]);
  const [detailShare, setDetailShare] = useState<GuestShareInfo | null>(null);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [debugCopied, setDebugCopied] = useState(false);
  const [debugStatus, setDebugStatus] = useState<UploadDebugStatus>({
    phase: "idle",
    uploadedBytes: null,
    totalBytes: null,
    speedBps: null,
    progress: null,
    metadataFiles: 0,
    lastScope: "",
    lastEvent: "",
  });
  const debugStartPerfRef = useRef(0);

  const ingestDebugEntry = useCallback((entry: Omit<DebugEntry, "line">) => {
    if (!debugEnabled) return;
    const line = formatDebugLine(entry.elapsedMs, entry.scope, entry.event, entry.data);
    setDebugEntries((entries) => [...entries.slice(-499), { ...entry, line }]);
    setDebugStatus((status) => {
      let next = status;
      if (entry.scope === "upload" && entry.event === "start") next = { ...next, phase: "uploading", metadataFiles: 0, uploadedBytes: 0, totalBytes: null, speedBps: null, progress: 0 };
      if (entry.scope === "commit" && entry.event === "start") next = { ...next, phase: "committing" };
      if (entry.scope === "upload" && entry.event === "done") next = { ...next, phase: "done" };
      if (entry.event === "error") next = { ...next, phase: "error" };
      if (entry.scope === "media" && entry.event === "probe:start") next = { ...next, metadataFiles: next.metadataFiles + 1 };
      if (entry.scope === "upload" && entry.event === "metrics" && entry.data) {
        next = {
          ...next,
          uploadedBytes: typeof entry.data.uploadedBytes === "number" ? entry.data.uploadedBytes : next.uploadedBytes,
          totalBytes: typeof entry.data.totalBytes === "number" ? entry.data.totalBytes : next.totalBytes,
          speedBps: typeof entry.data.speedBps === "number" ? entry.data.speedBps : next.speedBps,
          progress: typeof entry.data.progress === "number" ? entry.data.progress : next.progress,
        };
      }
      return { ...next, lastScope: entry.scope, lastEvent: entry.event };
    });
  }, [debugEnabled]);

  const appendDebugLog = useCallback<DebugLogFn>((scope, event, data) => {
    const elapsedMs = performance.now() - debugStartPerfRef.current;
    ingestDebugEntry({ elapsedMs, scope, event, data });
  }, [ingestDebugEntry]);

  const loadGuestShares = () => {
    getGuestShares().then(setGuestShares).catch(() => {});
  };

  useEffect(() => {
    if (isLoggedIn()) {
      getMe()
        .then(setUser)
        .catch(() => {
          logout();
        });
    } else {
      loadGuestShares();
    }
  }, []);

  useEffect(() => {
    setDebugEnabled(new URLSearchParams(window.location.search).get("debug") === "1");
  }, []);

  useEffect(() => {
    if (!debugEnabled) return;
    debugStartPerfRef.current = performance.now();
    setDebugEntries([]);
    setDebugStatus({
      phase: "idle",
      uploadedBytes: null,
      totalBytes: null,
      speedBps: null,
      progress: null,
      metadataFiles: 0,
      lastScope: "",
      lastEvent: "",
    });
    appendDebugLog("page", "debug:on", {
      url: window.location.href,
      userAgent: navigator.userAgent,
      connection: getConnectionInfo(),
    });
  }, [appendDebugLog, debugEnabled]);

  const handleRevokeGuest = async (code: string) => {
    // Try localStorage token first
    let revokeToken = "";
    try {
      const stored = JSON.parse(localStorage.getItem("nyy_guest_shares") || "[]");
      const entry = stored.find((s: { code: string }) => s.code === code);
      if (entry) revokeToken = entry.revokeToken;
    } catch {}

    if (!revokeToken) {
      alert("该分享没有撤销令牌（创建于功能上线前），请等待自动过期");
      return;
    }

    try {
      await guestRevokeShare(code, revokeToken);
      // Remove from localStorage
      try {
        const stored = JSON.parse(localStorage.getItem("nyy_guest_shares") || "[]");
        const updated = stored.filter((s: { code: string }) => s.code !== code);
        localStorage.setItem("nyy_guest_shares", JSON.stringify(updated));
      } catch {}
      setDetailShare(null);
      loadGuestShares();
    } catch (err) {
      alert(err instanceof Error ? err.message : "删除失败");
    }
  };

  const handleLoginSuccess = (u: UserInfo) => {
    setUser(u);
  };

  const handleLogout = () => {
    logout();
    setUser(null);
  };

  const formatSize = (bytes: number | null) => {
    if (bytes === null) return "-";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  const getConnectionInfo = () => {
    const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean } };
    const connection = nav.connection;
    return connection ? {
      effectiveType: connection.effectiveType,
      downlink: connection.downlink,
      rtt: connection.rtt,
      saveData: connection.saveData,
    } : null;
  };

  const copyText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {}
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.setSelectionRange(0, text.length);
    document.execCommand("copy");
    document.body.removeChild(ta);
  };

  const handleCopyDebugLogs = () => {
    void copyText(debugEntries.map((entry) => entry.line).join("\n"));
    setDebugCopied(true);
    window.setTimeout(() => setDebugCopied(false), 1200);
  };

  const handleCopyDebugJson = () => {
    const text = JSON.stringify({
      status: debugStatus,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      entries: debugEntries.map(({ line: _line, ...entry }) => entry),
    }, null, 2);
    void copyText(text);
    setDebugCopied(true);
    window.setTimeout(() => setDebugCopied(false), 1200);
  };

  return (
    <main className="relative min-h-dvh bg-warm-50 dark:bg-background flex flex-col items-center px-4 pt-[92px] pb-16">
      {/* Background icon pattern */}
      <div className="bg-icon-pattern pointer-events-none fixed inset-0 z-0" aria-hidden="true" />
      {/* Top bar */}
      <header className="fixed inset-x-0 top-0 z-40 bg-white/70 backdrop-blur-md dark:bg-[#121212]/70 transition-colors">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <span className="select-none inline-flex items-center gap-1 text-sm tracking-wide">
            <span className="font-light text-gray-500 dark:text-gray-400">文件中转，就用</span>
            <img src="/logo-sm.svg" alt="拿呀呀" className="inline-block h-[26px] w-auto" />
          </span>
          {user ? (
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <ThemeToggle />
              <Link
                href="/my"
                className="type-action flex min-h-[44px] items-center gap-1 rounded-full px-2 text-gray-700 transition hover:text-nyy-700 dark:text-gray-300 dark:hover:text-nyy-400"
              >
                <FolderOpen size={16} />
                我的分享
              </Link>
              <span className="type-body-sm max-w-[11rem] truncate text-gray-700 dark:text-gray-300">{user.email}</span>
              <button
                onClick={handleLogout}
                className="type-action min-h-[44px] rounded-full px-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
              >
                退出
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button
                onClick={() => setAuthOpen(true)}
                className="type-action flex min-h-[44px] items-center gap-1.5 rounded-full border border-gray-300 px-4 text-gray-700 transition hover:border-nyy-600 hover:text-nyy-700 dark:border-gray-600 dark:text-gray-300 dark:hover:border-nyy-500 dark:hover:text-nyy-400"
              >
                <User size={16} />
                登录
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Header */}
      <div className="mb-4 flex flex-col items-center text-center sm:flex-row sm:items-center sm:gap-6 sm:text-left">
        <BrandLogo className="h-auto w-44 sm:w-72 shrink-0" priority />
        <div className="mt-3 sm:mt-0">
          <p className="type-section text-gray-700 dark:text-gray-300">文件传来传去，拿呀²一下</p>
          <p className="type-body-sm mt-1 text-gray-600 dark:text-gray-400">大文件直传，链接分享，也能向别人收文件</p>
          <p className="type-caption mt-1 text-gray-500 dark:text-gray-500">
            {user ? "已登录：1 GB / 30天 · 可管理分享与收件" : "游客：200 MB / 24h · 注册后 1 GB / 30天"}
          </p>
        </div>
      </div>

      {/* Primary action panel */}
      <section className="glass-card w-full max-w-3xl">
        {/* Tab header */}
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="relative grid grid-cols-2 gap-1 rounded-2xl bg-gray-100/70 dark:bg-white/[0.04] p-1" role="tablist" aria-label="选择文件操作类型">
            {/* Sliding pill indicator */}
            <motion.div
              className="absolute inset-y-1 left-1 w-[calc(50%-4px)] rounded-xl bg-gradient-to-br from-[#FF8A3D] to-[#e0652a] shadow-[0_2px_16px_rgba(255,138,61,0.35)] will-change-transform"
              animate={{ x: mode === "send" ? 0 : "calc(100% + 4px)" }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
            />

            <button
              id="send-tab"
              role="tab"
              aria-selected={mode === "send"}
              aria-controls="send-panel"
              onClick={() => setMode("send")}
              className="relative z-10 min-h-[56px] rounded-xl px-4 py-2.5 text-center"
            >
              <span
                className={`type-action flex items-center justify-center gap-2 font-semibold transition-colors duration-200 ${mode === "send" ? "text-white" : "text-gray-600 dark:text-gray-400"}`}
              >
                <motion.span animate={{ rotate: mode === "send" ? [0, -10, 0] : 0 }} transition={{ duration: 0.4, delay: 0.05 }}>
                  <Upload className="h-4 w-4" />
                </motion.span>
                传文件
              </span>
              <span
                className={`type-caption mt-0.5 block transition-colors duration-200 ${mode === "send" ? "text-white/80" : "text-gray-400 dark:text-gray-500"}`}
              >生成分享链接</span>
            </button>
            <button
              id="receive-tab"
              role="tab"
              aria-selected={mode === "receive"}
              aria-controls="receive-panel"
              onClick={() => setMode("receive")}
              className="relative z-10 min-h-[56px] rounded-xl px-4 py-2.5 text-center"
            >
              <span
                className={`type-action flex items-center justify-center gap-2 font-semibold transition-colors duration-200 ${mode === "receive" ? "text-white" : "text-gray-600 dark:text-gray-400"}`}
              >
                <motion.span animate={{ rotate: mode === "receive" ? [0, 10, 0] : 0 }} transition={{ duration: 0.4, delay: 0.05 }}>
                  <Inbox className="h-4 w-4" />
                </motion.span>
                收文件
              </span>
              <span
                className={`type-caption mt-0.5 block transition-colors duration-200 ${mode === "receive" ? "text-white/80" : "text-gray-400 dark:text-gray-500"}`}
              >生成收件链接</span>
            </button>
          </div>
        </div>

        {/* Tab content */}
        <div className="px-5 pt-5 pb-6 sm:px-6 sm:pb-8 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={mode}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
              role="tabpanel"
              aria-labelledby={mode === "send" ? "send-tab" : "receive-tab"}
            >
              {mode === "send" ? (
                <FileUploader key={user ? "user" : "guest"} onUploadDone={loadGuestShares} loggedIn={!!user} onLoginClick={() => setAuthOpen(true)} debugLog={debugEnabled ? appendDebugLog : undefined} />
              ) : (
                <>
                  <FileRequestCreator embedded loggedIn={!!user} onLoginClick={() => setAuthOpen(true)} />
                  {user && <p className="type-caption mt-4 text-center text-gray-500 dark:text-gray-500">收到的文件会占用你的账号配额：1 GB / 30 天</p>}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      {debugEnabled && (
        <section className="mt-6 w-full max-w-3xl rounded-2xl border border-nyy-200 bg-nyy-50/70 p-3 dark:border-nyy-800 dark:bg-nyy-950/20">
          <div className="mb-3 rounded-xl bg-white/80 p-3 dark:bg-black/20">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-700 dark:text-gray-300">
              <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">phase: {debugStatus.phase}</span>
              <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">progress: {debugStatus.progress ?? "-"}%</span>
              <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">uploaded: {formatSize(debugStatus.uploadedBytes)} / {formatSize(debugStatus.totalBytes)}</span>
              <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">speed: {debugStatus.speedBps !== null ? `${formatSize(debugStatus.speedBps)}/s` : "-"}</span>
              <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">metadata: {debugStatus.metadataFiles}</span>
              <span className="rounded-full bg-nyy-100 px-2 py-0.5 dark:bg-nyy-900/40">last: {debugStatus.lastScope}/{debugStatus.lastEvent}</span>
            </div>
          </div>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="type-caption font-semibold text-nyy-900 dark:text-nyy-200">上传 Debug 日志 · {debugEntries.length}</p>
            <div className="flex gap-2">
              <button onClick={handleCopyDebugLogs} className="type-caption rounded-lg border border-nyy-300 px-2 py-1 text-nyy-800 dark:border-nyy-700 dark:text-nyy-300">
                {debugCopied ? "已复制文本" : "复制文本"}
              </button>
              <button onClick={handleCopyDebugJson} className="type-caption rounded-lg border border-nyy-300 px-2 py-1 text-nyy-800 dark:border-nyy-700 dark:text-nyy-300">
                复制 JSON
              </button>
            </div>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/90 p-3 text-[11px] leading-relaxed text-green-100">
            {debugEntries.length ? debugEntries.map((entry) => entry.line).join("\n") : "等待上传日志..."}
          </pre>
        </section>
      )}

      {/* Guest shares management */}
      {!user && guestShares.length > 0 && (
        <div className="mt-6 w-full max-w-3xl">
          <p className="type-caption mb-2 text-gray-500 dark:text-gray-500">我的分享（游客）· 删除后可释放配额</p>
          <div className="space-y-2">
            {guestShares.map((s) => (
              <div key={s.code} className="type-body-sm flex items-center gap-3 rounded-xl bg-gray-100 dark:bg-white/5 border border-gray-200/80 dark:border-transparent px-4 py-2.5">
                <code className="type-body flex-1 truncate text-gray-700 dark:text-gray-300">{s.url}</code>
                {s.expires_at && (
                  <span className="type-caption hidden sm:flex items-center gap-1 text-gray-400 dark:text-gray-500 shrink-0">
                    <Clock className="w-3 h-3" />
                    {formatCountdownShort(s.expires_at)}
                  </span>
                )}
                <button
                  onClick={() => setDetailShare(s)}
                  className="type-action flex items-center gap-1 rounded-lg px-2 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10 transition-colors"
                >
                  <Eye className="w-3 h-3" /> 查看
                </button>
                <button
                  onClick={() => handleRevokeGuest(s.code)}
                  className="type-action flex items-center gap-1 rounded-lg px-2 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                >
                  <Trash2 className="w-3 h-3" /> 删除
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Share Detail Modal */}
      {detailShare && (
        <ShareDetailModal
          share={detailShare}
          open={!!detailShare}
          onClose={() => setDetailShare(null)}
          onDelete={handleRevokeGuest}
          canDelete={detailShare.has_revoke_token}
        />
      )}

      {/* Auth Modal */}
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onLoginSuccess={handleLoginSuccess}
      />
    </main>
  );
}
