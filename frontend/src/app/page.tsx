"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { User, FolderOpen, Upload, Inbox, LogOut, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import Link from "next/link";
import { FileUploader } from "@/components/file-uploader";
import { FileRequestCreator } from "@/components/file-request-creator";
import { AuthModal } from "@/components/auth-modal";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { getMe, logout, type UserInfo } from "@/lib/auth";
import { guestRevokeShare, getGuestShares, getQuota, type GuestShareInfo, type QuotaInfo } from "@/lib/api";
import { ShareDetailModal } from "@/components/share-detail-modal";
import { GuestShareCard } from "@/components/guest-share-card";
import { ConfirmDialog } from "@/components/confirm-dialog";
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

function formatQuotaPeriod(hours: number): string {
  if (hours <= 0) return "长期";
  if (hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

export default function Home() {
  const [authOpen, setAuthOpen] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [mode, setMode] = useState<"send" | "receive">("send");
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [guestShares, setGuestShares] = useState<GuestShareInfo[]>([]);
  const [detailShare, setDetailShare] = useState<GuestShareInfo | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<GuestShareInfo | null>(null);
  const [revokeLoading, setRevokeLoading] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [debugCopied, setDebugCopied] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
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
  const accountMenuRef = useRef<HTMLDivElement>(null);

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

  const loadQuota = () => {
    setQuotaLoaded(false);
    getQuota()
      .then((nextQuota) => {
        setQuota(nextQuota);
        setQuotaLoaded(true);
      })
      .catch(() => {
        setQuota(null);
        setQuotaLoaded(true);
      });
  };

  useEffect(() => {
    loadQuota();
    getMe()
      .then(setUser)
      .catch(() => {
        setUser(null);
        loadGuestShares();
      });
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && accountMenuRef.current && !accountMenuRef.current.contains(target)) {
        setAccountMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountMenuOpen(false);
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [accountMenuOpen]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setDebugEnabled(params.get("debug") === "1");
    if (params.get("mode") === "receive") setMode("receive");
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
    // 使用本机保存的撤销令牌，避免同 IP 游客互相操作分享。
    let revokeToken = "";
    try {
      const stored = JSON.parse(localStorage.getItem("nyy_guest_shares") || "[]");
      const entry = stored.find((s: { code: string }) => s.code === code);
      if (entry) revokeToken = entry.revokeToken;
    } catch {}

    if (!revokeToken) {
      alert("该分享没有撤销令牌（创建于功能上线前），请等待自动过期");
      throw new Error("缺少撤销令牌");
    }

    try {
      await guestRevokeShare(code, revokeToken);
      try {
        const stored = JSON.parse(localStorage.getItem("nyy_guest_shares") || "[]");
        const updated = stored.filter((s: { code: string }) => s.code !== code);
        localStorage.setItem("nyy_guest_shares", JSON.stringify(updated));
      } catch {}
      setDetailShare(null);
      loadGuestShares();
    } catch (err) {
      alert(err instanceof Error ? err.message : "撤销失败");
      throw err;
    }
  };

  const handleRequestRevokeGuest = (share: GuestShareInfo) => {
    setRevokeTarget(share);
  };

  const handleConfirmRevokeGuest = async () => {
    if (!revokeTarget) return;
    setRevokeLoading(true);
    try {
      await handleRevokeGuest(revokeTarget.code);
      setRevokeTarget(null);
    } catch {
    } finally {
      setRevokeLoading(false);
    }
  };

  const handleDetailRevokeGuest = (code: string) => {
    const target = guestShares.find((share) => share.code === code) || detailShare;
    if (target) setRevokeTarget(target);
  };

  const handleLoginSuccess = (u: UserInfo) => {
    setUser(u);
    loadQuota();
  };

  const handleLogout = () => {
    logout();
    setUser(null);
    setAccountMenuOpen(false);
    loadGuestShares();
    loadQuota();
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

  const quotaLabel = quota ? `${formatSize(quota.limit_bytes)} / ${formatQuotaPeriod(quota.ttl_hours)}` : quotaLoaded ? "额度暂不可用" : "额度同步中";
  const heroStatus = user
    ? `当前额度：${quotaLabel} · 分享与收件都可管理`
    : `游客额度：${quotaLabel} · 登录后可管理分享与收件`;

  return (
    <main className="nyy-product-shell flex flex-col items-center px-4 pt-[92px] pb-16">
      {/* Top bar */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/20 bg-white/60 backdrop-blur-2xl transition-colors dark:border-white/10 dark:bg-[#121212]/60">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <span className="select-none inline-flex min-w-0 items-center gap-1 text-sm tracking-wide">
            <span className={`font-light text-gray-500 dark:text-gray-400 ${user ? "hidden sm:inline" : "inline"}`}>文件中转，就用</span>
            <img src="/logo-main.webp?v=20260607-malt-logo" alt="拿呀呀" className="inline-block h-[26px] w-auto" />
          </span>
          {user ? (
            <>
              <div className="hidden items-center gap-3 sm:flex">
                <ThemeToggle className="retro-nav-button" />
                <Link
                  href="/my"
                  className="retro-nav-button rounded-full"
                >
                  <FolderOpen size={16} />
                  我的分享
                </Link>
                <span className="type-body-sm max-w-[11rem] truncate retro-text">{user.email}</span>
                <button
                  onClick={handleLogout}
                  className="retro-nav-button rounded-full"
                >
                  退出
                </button>
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:hidden">
                <Link href="/my" className="retro-nav-button rounded-full px-3">
                  <FolderOpen size={16} />
                  工作台
                </Link>
                <div ref={accountMenuRef} className="relative">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={accountMenuOpen}
                    aria-label="打开账号菜单"
                    onClick={() => setAccountMenuOpen((open) => !open)}
                    className="retro-nav-button h-11 rounded-full px-2.5"
                  >
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-nyy-500 to-[#e0652a] text-sm font-bold text-white shadow-[0_8px_22px_rgba(255,138,61,0.24)]">
                      {user.email.slice(0, 1).toUpperCase()}
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${accountMenuOpen ? "rotate-180" : ""}`} />
                  </button>
                  {accountMenuOpen && (
                    <div role="menu" className="nyy-account-menu retro-menu absolute right-0 top-full z-50 mt-2 w-64 rounded-3xl p-2 shadow-[0_24px_70px_rgba(37,18,6,0.18)] dark:shadow-[0_24px_70px_rgba(0,0,0,0.45)]">
                      <div className="px-3 py-2.5">
                        <p className="retro-kicker">已登录</p>
                        <p className="type-body-sm mt-1 truncate font-medium retro-text">{user.email}</p>
                      </div>
                      <div className="my-1 h-px bg-black/8 dark:bg-white/10" />
                      <div className="flex items-center justify-between gap-3 rounded-2xl px-3 py-2">
                        <span className="type-body-sm retro-text">切换主题</span>
                        <ThemeToggle className="h-10 min-h-[40px] w-10 min-w-[40px] rounded-full" />
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        onClick={handleLogout}
                        className="retro-menu-item retro-menu-item-danger type-action mt-1"
                      >
                        <LogOut className="h-4 w-4" />
                        退出登录
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <ThemeToggle className="retro-nav-button" />
              <button
                onClick={() => setAuthOpen(true)}
                className="retro-btn-secondary rounded-full"
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
        <BrandLogo className="h-auto w-36 sm:w-56 shrink-0" priority />
        <div className="mt-3 sm:mt-0">
          <p className="retro-title text-lg">发给别人，或让别人发给你</p>
          <p className="type-body-sm mt-1 retro-text">上传即生成分享链接；创建收件链接，也能让对方直接提交文件</p>
          <p className="retro-kicker mt-1">
            {heroStatus}
          </p>
        </div>
      </div>

      {/* Primary action panel */}
      <section className="glass-card w-full max-w-3xl">
        {/* Tab header */}
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
            <div className="retro-tabbar relative grid grid-cols-2 gap-1" role="tablist" aria-label="选择文件操作类型">
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
                  {user && <p className="type-caption mt-4 text-center retro-muted">收到的文件会占用你的账号配额：{quotaLabel}</p>}
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </section>

      {debugEnabled && (
        <section className="retro-panel mt-6 w-full max-w-3xl p-3">
          <div className="retro-card mb-3 p-3">
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
        <section className="retro-panel mt-6 w-full max-w-3xl overflow-hidden p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="retro-kicker">本设备的临时分享</p>
              <h2 className="retro-title mt-1 text-lg">刚刚创建的链接都在这里</h2>
              <p className="type-body-sm mt-1 retro-text">只保存在当前浏览器；复制、查看二维码或撤销都可以在这里完成。</p>
            </div>
            <button
              type="button"
              onClick={() => setAuthOpen(true)}
              className="retro-btn-secondary min-h-[40px] shrink-0 px-3 type-caption sm:text-sm sm:leading-5"
            >
              登录后跨设备管理
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {guestShares.map((s) => (
              <GuestShareCard
                key={s.code}
                share={s}
                onCopy={(share) => copyText(share.url)}
                onOpenDetail={setDetailShare}
                onRevoke={handleRequestRevokeGuest}
              />
            ))}
          </div>
        </section>
      )}

      {/* Share Detail Modal */}
      {detailShare && (
        <ShareDetailModal
          share={detailShare}
          open={!!detailShare}
          onClose={() => setDetailShare(null)}
          onDelete={handleDetailRevokeGuest}
          canDelete={detailShare.has_revoke_token}
        />
      )}

      <ConfirmDialog
        open={!!revokeTarget}
        title="撤销游客分享"
        description={`撤销后 /${revokeTarget?.code || ""} 将无法继续访问，此操作不可恢复。确定要撤销吗？`}
        confirmText="确定撤销"
        danger
        loading={revokeLoading}
        onConfirm={handleConfirmRevokeGuest}
        onCancel={() => setRevokeTarget(null)}
      />

      {/* Auth Modal */}
      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onLoginSuccess={handleLoginSuccess}
      />
    </main>
  );
}
