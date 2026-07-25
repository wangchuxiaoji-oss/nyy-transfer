"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { User, FolderOpen, Upload, Inbox, LogOut, ChevronDown, Shield } from "lucide-react";
import Link from "next/link";
import { FileUploader } from "@/components/file-uploader";
import { FileRequestCreator } from "@/components/file-request-creator";
import dynamic from "next/dynamic";

const AuthModal = dynamic(() => import("@/components/auth-modal").then((m) => m.AuthModal), { ssr: false });
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { bootstrapSession, logout, type UserInfo } from "@/lib/auth";
import { guestRevokeShare, getGuestShares, getQuota, type GuestShareInfo, type QuotaInfo } from "@/lib/api";
import { ShareDetailModal } from "@/components/share-detail-modal";
import { GuestShareCard } from "@/components/guest-share-card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { formatDebugLine, type DebugLogFn } from "@/lib/debug";
import { BRAND_NAME } from "@/lib/copy";
import { recordGrowthLanding } from "@/lib/growth";
import { SystemAnnouncementCenter } from "@/components/system-announcement-center";

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

function formatSize(bytes: number | null) {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function getConnectionInfo() {
  const nav = navigator as Navigator & { connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean } };
  const connection = nav.connection;
  return connection ? {
    effectiveType: connection.effectiveType,
    downlink: connection.downlink,
    rtt: connection.rtt,
    saveData: connection.saveData,
  } : null;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* fallback below */ }
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
}

export function HomeClient() {
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

  const loadGuestShares = useCallback(() => {
    getGuestShares().then(setGuestShares).catch((err) => console.error("加载游客分享失败:", err));
  }, []);

  const loadQuota = useCallback(() => {
    setQuotaLoaded(false);
    getQuota()
      .then((nextQuota) => {
        setQuota(nextQuota);
        setQuotaLoaded(true);
      })
      .catch((err) => {
        console.error("加载额度失败:", err);
        setQuota(null);
        setQuotaLoaded(true);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    bootstrapSession()
      .then((data) => {
        if (cancelled) return;
        setQuota(data.quota);
        setQuotaLoaded(true);
        if (data.auth.status === "user" && data.auth.user) setUser(data.auth.user);
        else {
          setUser(null);
          loadGuestShares();
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("会话初始化失败:", err);
        setUser(null);
        setQuota(null);
        setQuotaLoaded(true);
        loadGuestShares();
      });
    return () => { cancelled = true; };
  }, [loadGuestShares]);

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
    void recordGrowthLanding(new URL(window.location.href)).catch(() => {});
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
    let revokeToken = "";
    try {
      const stored = JSON.parse(localStorage.getItem("nyy_guest_shares") || "[]");
      const entry = stored.find((s: { code: string }) => s.code === code);
      if (entry) revokeToken = entry.revokeToken;
    } catch { /* ignore */ }

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
      } catch { /* ignore */ }
      setDetailShare(null);
      loadGuestShares();
    } catch (err) {
      alert(err instanceof Error ? err.message : "撤销失败");
      throw err;
    }
  };

  const handleConfirmRevokeGuest = async () => {
    if (!revokeTarget) return;
    setRevokeLoading(true);
    try {
      await handleRevokeGuest(revokeTarget.code);
      setRevokeTarget(null);
    } catch { /* handled in handleRevokeGuest */ } finally {
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

  const handleLogout = async () => {
    setUser(null);
    setAccountMenuOpen(false);
    loadGuestShares();
    await logout();
    loadQuota();
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
    <>
      {/* 固定顶栏 */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/20 bg-white/60 backdrop-blur-2xl transition-colors dark:border-white/10 dark:bg-[#121212]/60" data-ui-revision="20260722.4">
        <nav className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]" aria-label="主导航">
          <span className="select-none inline-flex min-w-0 items-center gap-1 text-sm tracking-wide">
            <Link href="/" aria-label={`返回${BRAND_NAME}首页`} className="inline-flex items-center gap-1.5 transition-opacity hover:opacity-80">
              <BrandLogo className="h-[26px] w-auto rounded-md" />
              <span className="hidden font-semibold tracking-tight sm:inline retro-text">{BRAND_NAME}</span>
            </Link>
          </span>
          {user ? (
            <>
              <div className="hidden items-center gap-3 sm:flex">
                <ThemeToggle />
                <Link href="/my" className="retro-nav-button">
                  <FolderOpen size={16} />
                  我的分享
                </Link>
                {user.is_admin && (
                  <Link href="/admin" className="retro-nav-button">
                    <Shield size={16} />
                    后台
                  </Link>
                )}
                <span className="type-body-sm max-w-[11rem] truncate retro-text">{user.email}</span>
                <button onClick={handleLogout} className="retro-nav-button">退出</button>
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:hidden">
                <Link href="/my" className="retro-nav-button px-3">
                  <FolderOpen size={16} />
                  工作台
                </Link>
                {user.is_admin && (
                  <Link href="/admin" className="retro-nav-button px-3">
                    <Shield size={16} />
                    后台
                  </Link>
                )}
                <div ref={accountMenuRef} className="relative">
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-expanded={accountMenuOpen}
                    aria-label="打开账号菜单"
                    onClick={() => setAccountMenuOpen((open) => !open)}
                    className="retro-nav-button h-11 px-2.5"
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
                        <ThemeToggle className="h-11 min-h-[44px] w-11 min-w-[44px]" />
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
              <ThemeToggle />
              <button onClick={() => setAuthOpen(true)} className="btn-primary">
                <User size={16} />
                登录
              </button>
            </div>
          )}
        </nav>
      </header>
      <SystemAnnouncementCenter />

      {/* 主操作面板（紧跟 Hero 之后，用户滚动即可触达） */}
      <section id="upload-section" className="glass-card mt-8 w-full max-w-3xl scroll-mt-[calc(env(safe-area-inset-top)+5rem)]" aria-label="文件操作">
        <h2 className="sr-only">传文件或收文件</h2>
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <div className="retro-segmented relative grid grid-cols-2 gap-1" role="tablist" aria-label="选择文件操作类型">
            <div
              aria-hidden="true"
              data-testid="home-mode-indicator"
              className="pointer-events-none absolute inset-y-1 left-1 rounded-xl bg-gradient-to-br from-[#FF8A3D] to-[#e0652a] shadow-[0_2px_16px_rgba(255,138,61,0.35)] will-change-transform transition-transform duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
              style={{ width: "calc(50% - 0.375rem)", transform: mode === "send" ? "translateX(0)" : "translateX(calc(100% + 0.25rem))" }}
            />
            <button
              id="send-tab"
              role="tab"
              aria-selected={mode === "send"}
              aria-controls="send-panel"
              aria-label="传文件 - 生成分享链接"
              onClick={() => setMode("send")}
              className="retro-segment-button relative z-10 min-h-[56px] px-4 py-2.5"
            >
              <span className={`type-action flex items-center justify-center gap-2 font-semibold transition-colors duration-200 ${mode === "send" ? "text-white" : "text-gray-600 dark:text-gray-400"}`}>
                <span className={`inline-flex transition-transform duration-400 ${mode === "send" ? "rotate-0" : "-rotate-10"}`}>
                  <Upload className="h-4 w-4" />
                </span>
                传文件
              </span>
              <span className={`type-caption mt-0.5 hidden sm:block transition-colors duration-200 ${mode === "send" ? "text-white/80" : "text-gray-400 dark:text-gray-500"}`}>生成分享链接</span>
            </button>
            <button
              id="receive-tab"
              role="tab"
              aria-selected={mode === "receive"}
              aria-controls="receive-panel"
              aria-label="收文件 - 生成收件链接"
              onClick={() => setMode("receive")}
              className="retro-segment-button relative z-10 min-h-[56px] px-4 py-2.5"
            >
              <span className={`type-action flex items-center justify-center gap-2 font-semibold transition-colors duration-200 ${mode === "receive" ? "text-white" : "text-gray-600 dark:text-gray-400"}`}>
                <span className={`inline-flex transition-transform duration-400 ${mode === "receive" ? "rotate-0" : "rotate-10"}`}>
                  <Inbox className="h-4 w-4" />
                </span>
                收文件
              </span>
              <span className={`type-caption mt-0.5 hidden sm:block transition-colors duration-200 ${mode === "receive" ? "text-white/80" : "text-gray-400 dark:text-gray-500"}`}>生成收件链接</span>
            </button>
          </div>
        </div>

        <div className="px-5 pt-5 pb-6 sm:px-6 sm:pb-8 overflow-hidden">
          <div
            key={mode}
            role="tabpanel"
            aria-labelledby={mode === "send" ? "send-tab" : "receive-tab"}
            className="animate-[fadeIn_0.2s_ease]"
          >
            {mode === "send" ? (
              <FileUploader
                key={user ? "user" : "guest"}
                initialQuota={quota}
                onQuotaChange={(nextQuota) => { setQuota(nextQuota); setQuotaLoaded(true); }}
                onUploadDone={loadGuestShares}
                loggedIn={!!user}
                onLoginClick={() => setAuthOpen(true)}
                debugLog={debugEnabled ? appendDebugLog : undefined}
              />
            ) : (
              <>
                <FileRequestCreator embedded loggedIn={!!user} onLoginClick={() => setAuthOpen(true)} />
                {user && <p className="type-caption mt-4 text-center retro-muted">收到的文件会占用你的账号上传额度，当前剩余 {quotaLoaded ? formatSize(quota?.remaining_bytes ?? null) : "同步中"}</p>}
              </>
            )}
          </div>
        </div>
      </section>

      {/* Debug 面板 */}
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
              <button onClick={handleCopyDebugLogs} className="retro-text-button min-h-[44px] px-2 py-1 type-caption">
                {debugCopied ? "已复制文本" : "复制文本"}
              </button>
              <button onClick={handleCopyDebugJson} className="retro-text-button min-h-[44px] px-2 py-1 type-caption">
                复制 JSON
              </button>
            </div>
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-black/90 p-3 text-[11px] leading-relaxed text-green-100">
            {debugEntries.length ? debugEntries.map((entry) => entry.line).join("\n") : "等待上传日志..."}
          </pre>
        </section>
      )}

      {/* 游客分享管理 */}
      {!user && guestShares.length > 0 && (
        <section className="retro-panel mt-5 w-full max-w-3xl overflow-hidden p-3 sm:p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-semibold leading-6 text-[color:var(--yc-text)]">刚刚创建的链接</h2>
              <p className="mt-0.5 text-sm leading-5 text-[color:var(--yc-text-t)]">本浏览器保留 · {guestShares.length} 个</p>
            </div>
            <button
              type="button"
              onClick={() => setAuthOpen(true)}
              className="retro-btn-secondary min-h-[44px] shrink-0 px-2.5 text-xs"
            >
              登录后管理
            </button>
          </div>
          <div className="mt-3 space-y-2">
            {guestShares.map((s) => (
              <GuestShareCard
                key={s.code}
                share={s}
                onCopy={(share) => copyText(share.url)}
                onOpenDetail={setDetailShare}
              />
            ))}
          </div>
        </section>
      )}

      {/* 分享详情弹窗 */}
      {detailShare && (
        <ShareDetailModal
          share={detailShare}
          open={!!detailShare}
          onClose={() => setDetailShare(null)}
          onCopy={copyText}
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

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onLoginSuccess={handleLoginSuccess}
      />
    </>
  );
}
