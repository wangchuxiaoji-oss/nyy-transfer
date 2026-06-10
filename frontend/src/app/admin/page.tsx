"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Shield, Users, Share2, Database, Ban, RefreshCw, Search, HardDrive, Clock } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { getMe, login, logout } from "@/lib/auth";
import {
  banAdminShare,
  getAdminShares,
  getAdminReports,
  getAdminEmails,
  getAdminStats,
  getAdminUsers,
  getQuotaConfig,
  getDownloadConfig,
  sendAdminUserPasswordReset,
  unbanAdminShare,
  updateAdminReportStatus,
  updateAdminUser,
  updateQuotaConfig,
  updateDownloadConfig,
  getDoubaoSessionStatus,
  startDoubaoQR,
  getDoubaoQRStatus,
  cancelDoubaoQR,
  getDoubaoTestBSessionStatus,
  startDoubaoTestBQR,
  getDoubaoTestBQRStatus,
  cancelDoubaoTestBQR,
  type AdminShareItem,
  type AdminStats,
  type AdminUserItem,
  type AdminUserPatch,
  type AdminReportItem,
  type AdminEmailItem,
  type QuotaConfig,
  type DownloadConfig,
  type DoubaoSessionStatus,
} from "@/lib/admin";
import { formatSize } from "@/lib/utils";
import { getErrorMessage } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Pagination } from "@/components/pagination";
import { CaptchaChallenge } from "@/components/captcha-challenge";
import { ThemeToggle } from "@/components/theme-toggle";

const ADMIN_PATH = "/admin";
type AdminTab = "users" | "shares" | "reports" | "emails" | "quota" | "download" | "doubao";
type UserConfirmAction = "disable" | "enable" | "delete" | "restore" | "reset";
type DownloadBooleanKey = "smart_download_enabled" | "target_video" | "target_audio" | "target_pdf" | "target_image" | "target_other" | "filesystem_access_enabled" | "leave_warning_enabled";
const PAGE_SIZE = 20;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const ADMIN_ACTION_BASE = "retro-action-button w-full sm:min-h-0 sm:w-auto sm:py-1";
const ADMIN_ACTION_MUTED = `${ADMIN_ACTION_BASE} retro-action-muted`;
const ADMIN_ACTION_DANGER = `${ADMIN_ACTION_BASE} retro-action-danger`;
const ADMIN_ACTION_SUCCESS = `${ADMIN_ACTION_BASE} retro-action-success`;
const ADMIN_ACTION_WARNING = `${ADMIN_ACTION_BASE} retro-action-warning`;
const ADMIN_ACTION_PRIMARY = `${ADMIN_ACTION_BASE} retro-action-primary`;
const ADMIN_CODE_CLASS = "font-mono admin-code";
const ADMIN_BADGE_DANGER = "bg-red-100 text-red-700 ring-1 ring-red-200 dark:bg-red-500/20 dark:text-red-200 dark:ring-transparent";
const ADMIN_BADGE_SUCCESS = "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 dark:bg-green-500/20 dark:text-green-200 dark:ring-transparent";
const ADMIN_BADGE_WARNING = "bg-amber-100 text-amber-800 ring-1 ring-amber-200 dark:bg-yellow-500/20 dark:text-yellow-200 dark:ring-transparent";
const ADMIN_BADGE_ORANGE = "bg-orange-100 text-orange-800 ring-1 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-200 dark:ring-transparent";
const ADMIN_BADGE_PURPLE = "bg-purple-100 text-purple-700 ring-1 ring-purple-200 dark:bg-purple-500/20 dark:text-purple-200 dark:ring-transparent";
const ADMIN_BADGE_MUTED = "bg-stone-100 text-stone-700 ring-1 ring-stone-200 dark:bg-white/10 dark:text-white/70 dark:ring-transparent";
const USER_SORT_OPTIONS = [
  { key: "created_desc", label: "注册时间 ↓" },
  { key: "created_asc", label: "注册时间 ↑" },
  { key: "email_asc", label: "邮箱 A-Z" },
  { key: "email_desc", label: "邮箱 Z-A" },
  { key: "last_login_desc", label: "最近登录 ↓" },
  { key: "last_login_asc", label: "最近登录 ↑" },
];
const SHARE_SORT_OPTIONS = [
  { key: "created_desc", label: "创建时间 ↓" },
  { key: "created_asc", label: "创建时间 ↑" },
  { key: "size_desc", label: "大小 ↓" },
  { key: "downloads_desc", label: "下载 ↓" },
  { key: "expires_asc", label: "到期 ↑" },
];

function num(v: string) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function bytesToUnit(b: number, u: "MB" | "GB") { return u === "GB" ? b / GB : b / MB; }
function unitToBytes(v: string, u: "MB" | "GB") { return Math.max(1, Math.round(Math.max(num(v), 0.01) * (u === "GB" ? GB : MB))); }
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function planLabel(plan: string) { return ({ free: "免费", pro: "Pro", admin: "管理员" } as Record<string, string>)[plan] || plan; }
function sidGuardStatusLabel(status?: DoubaoSessionStatus["sid_guard_status"] | null) {
  return ({ ok: "标称有效", warning: "即将到期", expired: "标称过期", unknown: "未记录" } as Record<DoubaoSessionStatus["sid_guard_status"], string>)[status || "unknown"];
}
function sidGuardStatusClass(status?: DoubaoSessionStatus["sid_guard_status"] | null) {
  if (status === "ok") return "text-green-300";
  if (status === "warning") return "text-yellow-300";
  if (status === "expired") return "text-red-300";
  return "retro-muted";
}
function sidGuardHoursLabel(hours?: number | null) {
  if (hours === null || hours === undefined) return "";
  if (hours <= 0) return `已过期 ${Math.abs(hours)}h`;
  return `剩余 ${hours}h`;
}

export default function AdminPage() {
  return <Suspense fallback={<main className="nyy-product-shell admin-console-shell flex items-center justify-center retro-text">加载中...</main>}><AdminConsolePage /></Suspense>;
}

function AdminConsolePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();

  const tabParam = searchParams.get("tab") as AdminTab | null;
  const activeTab: AdminTab = (["users", "shares", "reports", "emails", "quota", "download", "doubao"] as AdminTab[]).includes(tabParam!) ? tabParam! : "shares";
  const q = searchParams.get("q") || "";
  const statusFilter = searchParams.get("status") || "all";
  const planFilter = searchParams.get("plan") || "all";
  const sortParam = searchParams.get("sort") || "created_desc";
  const sortOptions = activeTab === "users" ? USER_SORT_OPTIONS : activeTab === "shares" ? SHARE_SORT_OPTIONS : [];
  const activeSort = sortOptions.some((option) => option.key === sortParam) ? sortParam : "created_desc";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [email, setEmail] = useState("admin@nyy.app");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loginNeedsCaptcha, setLoginNeedsCaptcha] = useState(false);
  const [loginCaptchaToken, setLoginCaptchaToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authed, setAuthed] = useState(false);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [shares, setShares] = useState<AdminShareItem[]>([]);
  const [sharesTotal, setSharesTotal] = useState(0);
  const [reports, setReports] = useState<AdminReportItem[]>([]);
  const [reportsTotal, setReportsTotal] = useState(0);
  const [emails, setEmails] = useState<AdminEmailItem[]>([]);
  const [emailsTotal, setEmailsTotal] = useState(0);
  const [quota, setQuota] = useState<QuotaConfig | null>(null);
  const [downloadConfig, setDownloadConfig] = useState<DownloadConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [tabLoading, setTabLoading] = useState(false);
  const [searchDraft, setSearchDraft] = useState(q);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<AdminShareItem | null>(null);
  const [userConfirm, setUserConfirm] = useState<{ user: AdminUserItem; action: UserConfirmAction } | null>(null);

  const setQuery = useCallback((patch: Record<string, string | number | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all") params.delete(k);
      else params.set(k, String(v));
    }
    router.replace(`${ADMIN_PATH}?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const loadMeta = useCallback(async () => {
    const [s, qc, dc] = await Promise.all([getAdminStats(), getQuotaConfig(), getDownloadConfig()]);
    setStats(s);
    setQuota(qc);
    setDownloadConfig(dc);
  }, []);

  useEffect(() => { setSearchDraft(q); }, [q]);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    setTabLoading(true);
    const load = async () => {
      try {
        if (activeTab === "users") {
          const res = await getAdminUsers({ page, pageSize: PAGE_SIZE, q: q || undefined, plan: planFilter !== "all" ? planFilter : undefined, status: statusFilter !== "all" ? statusFilter : undefined, sort: activeSort });
          if (!cancelled) { setUsers(res.users || []); setUsersTotal(res.total); }
        } else if (activeTab === "shares") {
          const res = await getAdminShares({ page, pageSize: PAGE_SIZE, q: q || undefined, status: statusFilter !== "all" ? statusFilter : undefined, sort: activeSort });
          if (!cancelled) { setShares(res.shares || []); setSharesTotal(res.total); }
        } else if (activeTab === "reports") {
          const res = await getAdminReports({ page, pageSize: PAGE_SIZE, q: q || undefined, status: statusFilter !== "all" ? statusFilter : undefined });
          if (!cancelled) { setReports(res.reports || []); setReportsTotal(res.total ?? 0); }
        } else if (activeTab === "emails") {
          const res = await getAdminEmails({ page, pageSize: PAGE_SIZE, q: q || undefined, status: statusFilter !== "all" ? statusFilter : undefined });
          if (!cancelled) { setEmails(res.emails || []); setEmailsTotal(res.total ?? 0); }
        }
      } catch (e) {
        if (!cancelled) showToast({ title: getErrorMessage(e), type: "error" });
      } finally {
        if (!cancelled) setTabLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [authed, activeTab, q, planFilter, statusFilter, activeSort, page, showToast]);

  useEffect(() => {
    if (window.location.pathname !== ADMIN_PATH) { router.replace(ADMIN_PATH); return; }
    getMe()
      .then((u) => { if (!u.is_admin) throw new Error("非管理员"); setEmail(u.email); setAuthed(true); return loadMeta(); })
      .catch(() => setAuthed(false))
      .finally(() => setLoading(false));
  }, [loadMeta, router]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault(); setLoginError(""); setLoading(true);
    try {
      await login(email, password, loginCaptchaToken || undefined);
      const u = await getMe();
      if (!u.is_admin) throw new Error("当前账号不是管理员");
      setEmail(u.email); setAuthed(true); await loadMeta();
    } catch (err) {
      const status = typeof err === "object" && err && "status" in err ? (err as { status?: number }).status : undefined;
      if (status === 428) {
        setLoginNeedsCaptcha(true);
        setLoginError("登录失败次数过多，请完成人机验证");
      } else {
        logout(); setLoginError(getErrorMessage(err, "登录失败"));
      }
    }
    finally { setLoading(false); }
  }

  async function handleQuotaSave(e: React.FormEvent) {
    e.preventDefault(); if (!quota) return; setSaving(true);
    if (Object.values(quota).some((value) => !Number.isFinite(value) || value < 1)) {
      setSaving(false); showToast({ title: "配额必须为正数", type: "error" }); return;
    }
    try { setQuota(await updateQuotaConfig(quota)); showToast({ title: "配额已保存", type: "success" }); }
    catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
    finally { setSaving(false); }
  }

  async function handleDownloadConfigSave(e: React.FormEvent) {
    e.preventDefault(); if (!downloadConfig) return; setSaving(true);
    try { setDownloadConfig(await updateDownloadConfig(downloadConfig)); showToast({ title: "下载配置已保存", type: "success" }); }
    catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
    finally { setSaving(false); }
  }

  async function handleBanToggle() {
    if (!confirmTarget) return;
    try {
      if (confirmTarget.banned) await unbanAdminShare(confirmTarget.code);
      else await banAdminShare(confirmTarget.code, "管理员封禁");
      showToast({ title: confirmTarget.banned ? "已解封" : "已封禁", type: "success" });
      const [res, s] = await Promise.all([getAdminShares({ page, pageSize: PAGE_SIZE, q: q || undefined, status: statusFilter !== "all" ? statusFilter : undefined, sort: activeSort }), getAdminStats()]);
      setShares(res.shares || []); setSharesTotal(res.total); setStats(s);
    } catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
    finally { setConfirmOpen(false); setConfirmTarget(null); }
  }

  async function handleReportStatus(report: AdminReportItem, nextStatus: "pending" | "resolved" | "dismissed") {
    try {
      await updateAdminReportStatus(report.id, nextStatus);
      showToast({ title: nextStatus === "pending" ? "举报已重新打开" : nextStatus === "resolved" ? "举报已标记处理" : "举报已驳回", type: "success" });
      const [res, s] = await Promise.all([getAdminReports({ page, pageSize: PAGE_SIZE, q: q || undefined, status: statusFilter !== "all" ? statusFilter : undefined }), getAdminStats()]);
      setReports(res.reports || []); setReportsTotal(res.total ?? 0); setStats(s);
    } catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
  }

  async function reloadUsers() {
    const [res, s] = await Promise.all([
      getAdminUsers({ page, pageSize: PAGE_SIZE, q: q || undefined, plan: planFilter !== "all" ? planFilter : undefined, status: statusFilter !== "all" ? statusFilter : undefined, sort: activeSort }),
      getAdminStats(),
    ]);
    setUsers(res.users || []);
    setUsersTotal(res.total);
    setStats(s);
  }

  async function handleUserUpdate(user: AdminUserItem, patch: AdminUserPatch, message: string) {
    try {
      await updateAdminUser(user.id, patch);
      showToast({ title: message, type: "success" });
      await reloadUsers();
    } catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
  }

  async function handleUserPasswordReset(user: AdminUserItem) {
    try {
      await sendAdminUserPasswordReset(user.id);
      showToast({ title: "重置邮件已发送", type: "success" });
    } catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
  }

  async function handleUserConfirm() {
    if (!userConfirm) return;
    const { user, action } = userConfirm;
    if (action === "reset") {
      await handleUserPasswordReset(user);
      setUserConfirm(null);
      return;
    }
    const patch: AdminUserPatch = action === "disable" ? { disabled: true } : action === "enable" ? { disabled: false } : action === "delete" ? { deleted: true } : { deleted: false };
    const message = action === "disable" ? "用户已禁用" : action === "enable" ? "用户已启用" : action === "delete" ? "用户已软删除" : "用户已恢复";
    await handleUserUpdate(user, patch, message);
    setUserConfirm(null);
  }

  async function handleLogout() {
    await logout();
    setAuthed(false);
    setPassword("");
    router.replace(ADMIN_PATH);
  }

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); setQuery({ q: searchDraft || null, page: null }); };
  const tabs: { key: AdminTab; label: string }[] = [{ key: "shares", label: "分享" }, { key: "users", label: "用户" }, { key: "reports", label: "举报" }, { key: "emails", label: "邮件" }, { key: "quota", label: "配额" }, { key: "download", label: "下载" }, { key: "doubao", label: "豆包" }];

  if (loading) return <main className="nyy-product-shell admin-console-shell flex items-center justify-center retro-text">加载中...</main>;

  if (!authed) {
    return (
      <main className="nyy-product-shell admin-console-shell flex items-center justify-center px-4 py-8">
        <form onSubmit={handleLogin} className="nyy-product-content retro-panel-strong w-full max-w-sm p-8">
          <div className="mb-4 flex justify-end"><ThemeToggle /></div>
          <BrandLogo className="mx-auto h-auto w-44" priority />
          <p className="retro-kicker mt-6">运营后台入口</p>
          {loginError && <p role="alert" className="mt-4 rounded-xl bg-red-950/50 px-3 py-2 type-body-sm text-red-100">{loginError}</p>}
          <label className="mt-6 block"><span className="type-body-sm retro-text">管理员邮箱</span>
            <input className="retro-input mt-2 w-full type-body-sm" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="mt-3 block"><span className="type-body-sm retro-text">密码</span>
            <input className="retro-input mt-2 w-full type-body-sm" type="password" autoComplete="current-password" placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {loginNeedsCaptcha && !loginCaptchaToken && (
            <div className="mt-4 rounded-xl border border-white/10 p-3">
              <p className="type-caption mb-2 retro-muted">请完成人机验证后登录</p>
              <CaptchaChallenge purpose="login" onVerified={(token) => { setLoginCaptchaToken(token); setLoginError(""); }} />
            </div>
          )}
          <button disabled={loading || (loginNeedsCaptcha && !loginCaptchaToken)} className="btn-primary mt-5 w-full">进入控制台</button>
        </form>
      </main>
    );
  }

  return (
    <main className="nyy-product-shell admin-console-shell px-4 py-8 sm:px-6">
      <div className="nyy-product-content mx-auto max-w-7xl">
        <header className="retro-panel flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-5">
            <BrandLogo className="h-auto w-36" priority />
            <div><p className="retro-kicker">内部控制台</p><h1 className="retro-title mt-1 text-2xl">运营后台</h1></div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-white/10 px-3 py-2 type-caption retro-muted">{email}</span>
            <ThemeToggle />
            <button onClick={() => router.push("/")} className="retro-nav-button">返回首页</button>
            <button onClick={loadMeta} className="retro-nav-button"><RefreshCw size={16} /> 刷新</button>
            <button onClick={handleLogout} className="retro-nav-button">退出</button>
          </div>
        </header>

        {stats && (
          <section className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
            {([
              [Users, "用户", stats.users_total], [Share2, "分享", stats.shares_total], [Shield, "活跃", stats.shares_active],
              [Ban, "封禁", stats.shares_banned], [Database, "待处理举报", stats.reports_pending], [Database, "邮件失败", stats.emails_failed],
              [HardDrive, "总上传", formatSize(stats.uploaded_bytes_total)], [Clock, "24h 上传", formatSize(stats.uploaded_bytes_24h)],
            ] as const).map(([Icon, label, value]) => (
              <div key={label} className="retro-card p-5"><Icon className="text-nyy-500" size={20} /><p className="retro-kicker mt-4">{label}</p><p className="retro-title mt-1 whitespace-nowrap text-lg tracking-[0.03em] sm:text-xl">{value}</p></div>
            ))}
          </section>
        )}

        {/* Tabs */}
        <div className="retro-segmented mt-8 flex gap-1 overflow-x-auto" role="tablist" aria-label="后台栏目">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => { setSearchDraft(""); setQuery({ tab: t.key === "shares" ? null : t.key, q: null, plan: null, status: null, sort: null, page: null }); }}
              role="tab" aria-selected={activeTab === t.key}
              className="retro-segment-button whitespace-nowrap px-4 py-2 type-body-sm">{t.label}</button>
          ))}
        </div>

        {/* Search & Filter */}
        {activeTab !== "quota" && activeTab !== "download" && activeTab !== "doubao" && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <form onSubmit={handleSearch} className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 retro-muted" />
              <input type="text" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="搜索…"
                className="retro-input w-full py-2 pl-9 pr-3 type-body-sm" />
            </form>
            {(activeTab === "shares" || activeTab === "reports" || activeTab === "emails") && (
              <select value={statusFilter} onChange={(e) => setQuery({ status: e.target.value, page: null })}
                className="retro-input px-3 py-2 type-body-sm">
                <option value="all">全部状态</option>
                {activeTab === "shares" && <><option value="active">有效</option><option value="download_exhausted">下载耗尽</option><option value="banned">已封禁</option><option value="expired">已过期</option><option value="revoked">已撤销</option></>}
                {activeTab === "reports" && <><option value="pending">待处理</option><option value="resolved">已处理</option><option value="dismissed">已驳回</option></>}
                {activeTab === "emails" && <><option value="pending">待发送</option><option value="sent">已发送</option><option value="failed">失败</option></>}
              </select>
            )}
            {activeTab === "users" && (
              <>
                <select value={planFilter} onChange={(e) => setQuery({ plan: e.target.value, page: null })}
                  className="retro-input px-3 py-2 type-body-sm">
                  <option value="all">全部计划</option>
                  <option value="free">免费</option>
                  <option value="pro">Pro</option>
                  <option value="admin">管理员</option>
                </select>
                <select value={statusFilter} onChange={(e) => setQuery({ status: e.target.value, page: null })}
                  className="retro-input px-3 py-2 type-body-sm">
                  <option value="all">全部状态</option>
                  <option value="active">正常</option>
                  <option value="disabled">已禁用</option>
                  <option value="deleted">已删除</option>
                  <option value="verified">已验证</option>
                  <option value="unverified">未验证</option>
                </select>
              </>
            )}
            {sortOptions.length > 0 && (
              <select value={activeSort} onChange={(e) => setQuery({ sort: e.target.value === "created_desc" ? null : e.target.value, page: null })}
                className="retro-input px-3 py-2 type-body-sm">
                {sortOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
              </select>
            )}
          </div>
        )}

        {/* Content */}
        <section className="mt-6">
          {tabLoading ? <div className="py-12 text-center retro-muted">加载中...</div>
          : activeTab === "shares" ? <SharesPanel shares={shares} total={sharesTotal} page={page} onBan={(s) => { setConfirmTarget(s); setConfirmOpen(true); }} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "users" ? <UsersPanel users={users} total={usersTotal} page={page} onUpdate={handleUserUpdate} onConfirmAction={(user, action) => setUserConfirm({ user, action })} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "reports" ? <ReportsPanel reports={reports} total={reportsTotal} page={page} onStatus={handleReportStatus} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "emails" ? <EmailsPanel emails={emails} total={emailsTotal} page={page} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "download" ? <DownloadPanel config={downloadConfig} saving={saving} onChange={setDownloadConfig} onSave={handleDownloadConfigSave} />
          : activeTab === "doubao" ? <DoubaoPanel />
          : <QuotaPanel quota={quota} saving={saving} onChange={setQuota} onSave={handleQuotaSave} />}
        </section>
      </div>

      <ConfirmDialog open={confirmOpen} title={confirmTarget?.banned ? "解封分享" : "封禁分享"}
        description={confirmTarget?.banned ? `确定解封 /${confirmTarget?.code}？` : `确定封禁 /${confirmTarget?.code}？封禁后链接将不可访问。`}
        confirmText={confirmTarget?.banned ? "确定解封" : "确定封禁"} danger={!confirmTarget?.banned}
        onConfirm={handleBanToggle} onCancel={() => { setConfirmOpen(false); setConfirmTarget(null); }} />
      <ConfirmDialog open={!!userConfirm} title={userConfirm ? ({ disable: "禁用用户", enable: "启用用户", delete: "软删除用户", restore: "恢复用户", reset: "发送重置邮件" }[userConfirm.action]) : "用户操作"}
        description={userConfirm ? `${userConfirm.user.email}：${({ disable: "禁用后该用户无法继续使用账号，当前会话会失效。", enable: "启用后该用户可重新使用账号。", delete: "软删除后该用户无法登录，业务数据会保留。", restore: "恢复后账号重新出现在正常用户列表。", reset: "系统会向该邮箱发送密码重置验证码邮件。" }[userConfirm.action])}` : ""}
        confirmText={userConfirm ? ({ disable: "确定禁用", enable: "确定启用", delete: "确定软删除", restore: "确定恢复", reset: "确定发送" }[userConfirm.action]) : "确认"} danger={userConfirm?.action === "disable" || userConfirm?.action === "delete"}
        onConfirm={handleUserConfirm} onCancel={() => setUserConfirm(null)} />
    </main>
  );
}

/* ─── Shares Panel ─── */
function SharesPanel({ shares, total, page, onBan, onPage }: { shares: AdminShareItem[]; total: number; page: number; onBan: (s: AdminShareItem) => void; onPage: (p: number) => void }) {
  if (shares.length === 0) return <p className="py-8 text-center retro-muted">暂无数据</p>;
  const st = (s: AdminShareItem) => s.banned ? "封禁" : s.revoked ? "撤销" : (s.expires_at && new Date(s.expires_at) < new Date()) ? "过期" : (s.max_downloads > 0 && s.download_count >= s.max_downloads) ? "耗尽" : "有效";
  const stCls = (s: AdminShareItem) => { const v = st(s); return v === "封禁" ? ADMIN_BADGE_DANGER : v === "有效" ? ADMIN_BADGE_SUCCESS : v === "耗尽" ? ADMIN_BADGE_PURPLE : ADMIN_BADGE_ORANGE; };
  const dl = (s: AdminShareItem) => s.max_downloads > 0 ? `${s.download_count}/${s.max_downloads}` : String(s.download_count);
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-white/10 text-left type-caption retro-muted">
          <th className="pb-2 pr-4">短码</th><th className="pb-2 pr-4">标题</th><th className="pb-2 pr-4">所有者</th><th className="pb-2 pr-4">文件</th><th className="pb-2 pr-4">下载</th><th className="pb-2 pr-4">状态</th><th className="pb-2 pr-4">创建</th><th className="pb-2">操作</th>
        </tr></thead><tbody>
          {shares.map((s) => (
            <tr key={s.code} className="border-b border-white/10">
              <td className={`py-3 pr-4 ${ADMIN_CODE_CLASS}`}>/{s.code}</td>
              <td className="py-3 pr-4 max-w-[120px] truncate">{s.title || "—"}</td>
              <td className="py-3 pr-4 retro-text">{s.owner_email || "游客"}</td>
              <td className="py-3 pr-4">{s.file_count} · {formatSize(s.total_bytes)}</td>
              <td className="py-3 pr-4">{dl(s)}</td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${stCls(s)}`}>{st(s)}</span></td>
              <td className="py-3 pr-4 type-caption retro-muted">{fmtDate(s.created_at)}</td>
              <td className="py-3"><button onClick={() => onBan(s)} className={s.banned ? ADMIN_ACTION_PRIMARY : ADMIN_ACTION_DANGER}>{s.banned ? "解封" : "封禁"}</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {shares.map((s) => (
          <div key={s.code} className="retro-card p-4">
            <div className="flex items-center justify-between"><span className={`${ADMIN_CODE_CLASS} type-body-sm`}>/{s.code}</span><span className={`rounded-full px-2 py-0.5 type-caption ${stCls(s)}`}>{st(s)}</span></div>
            {s.title && <p className="mt-1 truncate type-body-sm retro-text">{s.title}</p>}
            <p className="mt-1 type-caption retro-muted">{s.owner_email || "游客"} · {s.file_count} 文件 · {formatSize(s.total_bytes)} · {dl(s)} 下载</p>
            <button onClick={() => onBan(s)} className={`mt-3 ${s.banned ? ADMIN_ACTION_PRIMARY : ADMIN_ACTION_DANGER}`}>{s.banned ? "解封" : "封禁"}</button>
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Users Panel ─── */
function UsersPanel({ users, total, page, onUpdate, onConfirmAction, onPage }: { users: AdminUserItem[]; total: number; page: number; onUpdate: (u: AdminUserItem, patch: AdminUserPatch, message: string) => void; onConfirmAction: (u: AdminUserItem, action: UserConfirmAction) => void; onPage: (p: number) => void }) {
  if (users.length === 0) return <p className="py-8 text-center retro-muted">暂无用户</p>;
  const userStatus = (u: AdminUserItem) => u.deleted ? "已删除" : u.disabled ? "已禁用" : "正常";
  const userStatusCls = (u: AdminUserItem) => u.deleted ? ADMIN_BADGE_DANGER : u.disabled ? ADMIN_BADGE_WARNING : ADMIN_BADGE_SUCCESS;
  const actions = (u: AdminUserItem) => {
    if (u.is_admin) return <span className="type-caption retro-muted">受保护</span>;
    if (u.deleted) return <button onClick={() => onConfirmAction(u, "restore")} className={ADMIN_ACTION_SUCCESS}>恢复</button>;
    return (
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <button onClick={() => onConfirmAction(u, u.disabled ? "enable" : "disable")} className={u.disabled ? ADMIN_ACTION_SUCCESS : ADMIN_ACTION_WARNING}>{u.disabled ? "启用" : "禁用"}</button>
        <button onClick={() => onUpdate(u, { email_verified: !u.email_verified }, u.email_verified ? "已取消邮箱验证" : "已标记邮箱验证")} className={ADMIN_ACTION_MUTED}>{u.email_verified ? "取消验证" : "设为验证"}</button>
        <button onClick={() => onConfirmAction(u, "reset")} className={ADMIN_ACTION_PRIMARY}>重置邮件</button>
        <button onClick={() => onConfirmAction(u, "delete")} className={ADMIN_ACTION_DANGER}>删除</button>
      </div>
    );
  };
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-white/10 text-left type-caption retro-muted">
          <th className="pb-2 pr-4">邮箱</th><th className="pb-2 pr-4">计划</th><th className="pb-2 pr-4">状态</th><th className="pb-2 pr-4">角色</th><th className="pb-2 pr-4">验证</th><th className="pb-2 pr-4">注册</th><th className="pb-2 pr-4">最后登录</th><th className="pb-2">操作</th>
        </tr></thead><tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-white/10">
              <td className="py-3 pr-4">{u.email}</td>
              <td className="py-3 pr-4">
                {u.is_admin ? <span className="type-caption retro-muted">{planLabel(u.plan)}</span> : (
                  <select value={u.plan === "pro" ? "pro" : "free"} disabled={u.deleted} onChange={(e) => onUpdate(u, { plan: e.target.value as "free" | "pro" }, "计划已更新")}
                    className="retro-input min-h-[34px] px-2 py-1 type-caption disabled:opacity-50">
                    <option value="free">免费</option>
                    <option value="pro">Pro</option>
                  </select>
                )}
              </td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${userStatusCls(u)}`}>{userStatus(u)}</span></td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${u.is_admin ? ADMIN_BADGE_ORANGE : ADMIN_BADGE_SUCCESS}`}>{u.is_admin ? "管理员" : "用户"}</span></td>
              <td className="py-3 pr-4 type-caption">{u.email_verified ? "已验证" : "未验证"}</td>
              <td className="py-3 pr-4 type-caption retro-muted">{fmtDate(u.created_at)}</td>
              <td className="py-3 pr-4 type-caption retro-muted">{u.last_login_at ? fmtDate(u.last_login_at) : "—"}</td>
              <td className="py-3">{actions(u)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {users.map((u) => (
          <div key={u.id} className="retro-card p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 break-all type-body-sm font-medium">{u.email}</p>
              <span className={`shrink-0 rounded-full px-2 py-0.5 type-caption ${userStatusCls(u)}`}>{userStatus(u)}</span>
            </div>
            <p className="mt-1 type-caption retro-muted">{planLabel(u.plan)} · {u.is_admin ? "管理员" : "用户"} · {u.email_verified ? "已验证" : "未验证"} · {fmtDate(u.created_at)}</p>
            {!u.is_admin && !u.deleted && (
              <select value={u.plan === "pro" ? "pro" : "free"} onChange={(e) => onUpdate(u, { plan: e.target.value as "free" | "pro" }, "计划已更新")}
                className="retro-input mt-3 w-full px-3 py-2 type-body-sm">
                <option value="free">免费</option>
                <option value="pro">Pro</option>
              </select>
            )}
            <div className="mt-3">{actions(u)}</div>
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Reports Panel ─── */
function ReportsPanel({ reports, total, page, onStatus, onPage }: { reports: AdminReportItem[]; total: number; page: number; onStatus: (r: AdminReportItem, status: "pending" | "resolved" | "dismissed") => void; onPage: (p: number) => void }) {
  if (reports.length === 0) return <p className="py-8 text-center retro-muted">暂无举报</p>;
  const reportStatus = (status: string) => status === "pending" ? "待处理" : status === "dismissed" ? "已驳回" : "已处理";
  const reportStatusCls = (status: string) => status === "pending" ? ADMIN_BADGE_WARNING : status === "dismissed" ? ADMIN_BADGE_MUTED : ADMIN_BADGE_SUCCESS;
  const actions = (r: AdminReportItem) => r.status === "pending" ? (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      <button onClick={() => onStatus(r, "resolved")} className={ADMIN_ACTION_SUCCESS}>处理</button>
      <button onClick={() => onStatus(r, "dismissed")} className={ADMIN_ACTION_MUTED}>驳回</button>
    </div>
  ) : (
    <button onClick={() => onStatus(r, "pending")} className={ADMIN_ACTION_WARNING}>重开</button>
  );
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-white/10 text-left type-caption retro-muted">
          <th className="pb-2 pr-4">分享码</th><th className="pb-2 pr-4">原因</th><th className="pb-2 pr-4">补充</th><th className="pb-2 pr-4">状态</th><th className="pb-2 pr-4">时间</th><th className="pb-2">操作</th>
        </tr></thead><tbody>
          {reports.map((r) => (
            <tr key={r.id} className="border-b border-white/10">
              <td className={`py-3 pr-4 ${ADMIN_CODE_CLASS}`}>/{r.share_code}</td>
              <td className="py-3 pr-4">{r.reason}</td>
              <td className="py-3 pr-4 max-w-[200px] truncate retro-text">{r.detail || "—"}</td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${reportStatusCls(r.status)}`}>{reportStatus(r.status)}</span></td>
              <td className="py-3 pr-4 type-caption retro-muted">{fmtDate(r.created_at)}</td>
              <td className="py-3">{actions(r)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {reports.map((r) => (
          <div key={r.id} className="retro-card p-4">
            <div className="flex items-center justify-between"><span className={`${ADMIN_CODE_CLASS} type-body-sm`}>/{r.share_code}</span><span className={`rounded-full px-2 py-0.5 type-caption ${reportStatusCls(r.status)}`}>{reportStatus(r.status)}</span></div>
            <p className="mt-1 type-body-sm">{r.reason}</p>
            {r.detail && <p className="mt-0.5 type-caption retro-muted">{r.detail}</p>}
            <div className="mt-3">{actions(r)}</div>
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Emails Panel ─── */
function EmailsPanel({ emails, total, page, onPage }: { emails: AdminEmailItem[]; total: number; page: number; onPage: (p: number) => void }) {
  if (emails.length === 0) return <p className="py-8 text-center retro-muted">暂无邮件记录</p>;
  const emailStatus = (status: string) => status === "sent" ? "已发送" : status === "failed" ? "失败" : "待发送";
  const emailStatusCls = (status: string) => status === "sent" ? ADMIN_BADGE_SUCCESS : status === "failed" ? ADMIN_BADGE_DANGER : ADMIN_BADGE_WARNING;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-white/10 text-left type-caption retro-muted">
          <th className="pb-2 pr-4">收件人</th><th className="pb-2 pr-4">分享码</th><th className="pb-2 pr-4">状态</th><th className="pb-2 pr-4">错误</th><th className="pb-2">时间</th>
        </tr></thead><tbody>
          {emails.map((e, i) => (
            <tr key={`${e.share_code}-${e.recipient}-${i}`} className="border-b border-white/10">
              <td className="py-3 pr-4">{e.recipient}</td>
              <td className={`py-3 pr-4 ${ADMIN_CODE_CLASS}`}>/{e.share_code}</td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${emailStatusCls(e.status)}`}>{emailStatus(e.status)}</span></td>
              <td className="py-3 pr-4 max-w-[200px] truncate retro-muted">{e.error || "—"}</td>
              <td className="py-3 type-caption retro-muted">{fmtDate(e.created_at)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {emails.map((e, i) => (
          <div key={`${e.share_code}-${e.recipient}-${i}`} className="retro-card p-4">
            <p className="type-body-sm">{e.recipient}</p>
            <p className="mt-1 type-caption retro-muted">/{e.share_code} · <span className={e.status === "sent" ? "text-emerald-700 dark:text-green-300" : e.status === "failed" ? "text-red-700 dark:text-red-300" : "text-amber-800 dark:text-yellow-300"}>{emailStatus(e.status)}</span>{e.error ? ` · ${e.error}` : ""}</p>
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Quota Panel ─── */
function QuotaPanel({ quota, saving, onChange, onSave }: { quota: QuotaConfig | null; saving: boolean; onChange: (q: QuotaConfig) => void; onSave: (e: React.FormEvent) => void }) {
  if (!quota) return <p className="py-8 text-center retro-muted">加载配额中...</p>;
  return (
    <form onSubmit={onSave} className="retro-panel p-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div><p className="retro-kicker">配额规则</p><h2 className="retro-title mt-1 text-xl">配额配置</h2></div>
        <p className="type-body-sm retro-text">保存后，前台额度展示和上传校验同步生效。</p>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="type-body-sm font-semibold text-nyy-500">游客规则</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <QSizeField label="游客周期上传额度" hint="游客统计周期内可上传总量" bytes={quota.guest_max_file_bytes} unit="MB" onChange={(v) => onChange({ ...quota, guest_max_file_bytes: v })} />
            <QNumField label="活跃分享数" hint="未撤销、未封禁的分享上限" value={quota.guest_max_active_shares} suffix="个" onChange={(v) => onChange({ ...quota, guest_max_active_shares: v })} />
            <QNumField label="统计周期" hint="游客配额滚动窗口" value={quota.guest_ttl_hours} suffix="小时" onChange={(v) => onChange({ ...quota, guest_ttl_hours: v })} />
          </div>
        </section>
        <section>
          <h3 className="type-body-sm font-semibold text-nyy-500">注册用户规则</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <QSizeField label="注册用户周期上传额度" hint="注册用户统计周期内可上传总量" bytes={quota.user_max_file_bytes} unit="GB" onChange={(v) => onChange({ ...quota, user_max_file_bytes: v })} />
            <QNumField label="活跃分享数" hint="可同时保留的分享数量" value={quota.user_max_active_shares} suffix="个" onChange={(v) => onChange({ ...quota, user_max_active_shares: v })} />
            <QNumField label="统计周期" hint="注册用户配额滚动窗口" value={quota.user_ttl_hours} suffix="小时" onChange={(v) => onChange({ ...quota, user_ttl_hours: v })} />
          </div>
        </section>
      </div>
      <button disabled={saving} className="btn-primary mt-5 disabled:opacity-50">{saving ? "保存中" : "保存配置"}</button>
    </form>
  );
}

/* ─── Download Panel ─── */
function DownloadPanel({ config, saving, onChange, onSave }: { config: DownloadConfig | null; saving: boolean; onChange: (config: DownloadConfig) => void; onSave: (e: React.FormEvent) => void }) {
  if (!config) return <p className="py-8 text-center retro-muted">加载下载配置中...</p>;
  const toggle = (key: DownloadBooleanKey) => onChange({ ...config, [key]: !config[key] });
  return (
    <form onSubmit={onSave} className="retro-panel p-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div><p className="retro-kicker">下载行为</p><h2 className="retro-title mt-1 text-xl">下载配置</h2></div>
        <p className="type-body-sm retro-text">默认增强下载；管理员可关闭回原生直链。</p>
      </div>

      <div className="retro-card mt-4 border-amber-300/40 bg-amber-200/10 p-4">
        <p className="type-body-sm font-semibold text-amber-800 dark:text-amber-100">大文件边界</p>
        <p className="mt-1 type-caption retro-muted">支持 File System Access 的浏览器会让用户选择保存位置，再按 64MB Range 分段写盘，不走后端带宽。不支持本地写盘的浏览器直接打开原始链接；分片文件没有单个原始链接，只能用支持本地写盘的浏览器下载。</p>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section>
          <h3 className="type-body-sm font-semibold text-nyy-500">适用范围</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ToggleCard label="启用智能下载" hint="默认开启；关闭后非分片文件走原始直链" checked={config.smart_download_enabled} onChange={() => toggle("smart_download_enabled")} />
            <ToggleCard label="视频" hint="video/* 和常见视频扩展名" checked={config.target_video} onChange={() => toggle("target_video")} />
            <ToggleCard label="音频" hint="audio/* 和常见音频扩展名" checked={config.target_audio} onChange={() => toggle("target_audio")} />
            <ToggleCard label="PDF" hint="application/pdf 或 .pdf" checked={config.target_pdf} onChange={() => toggle("target_pdf")} />
            <ToggleCard label="图片" hint="默认纳入增强，方便保存原图" checked={config.target_image} onChange={() => toggle("target_image")} />
            <ToggleCard label="其他文件" hint="未归类扩展名和普通附件" checked={config.target_other} onChange={() => toggle("target_other")} />
          </div>
        </section>

        <section>
          <h3 className="type-body-sm font-semibold text-nyy-500">保存能力</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <ToggleCard label="File System Access" hint="支持时按 64MB Range 分段写盘" checked={config.filesystem_access_enabled} onChange={() => toggle("filesystem_access_enabled")} />
            <ToggleCard label="离开页面提醒" hint="智能下载进行中离开页面会中断" checked={config.leave_warning_enabled} onChange={() => toggle("leave_warning_enabled")} />
          </div>
        </section>
      </div>

      <button disabled={saving} className="btn-primary mt-5 disabled:opacity-50">{saving ? "保存中" : "保存配置"}</button>
    </form>
  );
}

function ToggleCard({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="retro-card flex cursor-pointer items-start gap-3 p-4">
      <input type="checkbox" checked={checked} onChange={onChange} className="mt-1 h-4 w-4 rounded border-white/20 accent-nyy-500" />
      <span>
        <span className="block type-body-sm font-medium retro-text">{label}</span>
        <span className="mt-1 block type-caption retro-muted">{hint}</span>
      </span>
    </label>
  );
}

/* ─── Doubao Panel ─── */
function DoubaoPanel() {
  const [session, setSession] = useState<DoubaoSessionStatus | null>(null);
  const [qrBase64, setQrBase64] = useState("");
  const [qrStatus, setQrStatus] = useState("idle");
  const [qrMessage, setQrMessage] = useState("");
  const [testBSession, setTestBSession] = useState<DoubaoSessionStatus | null>(null);
  const [testBQrBase64, setTestBQrBase64] = useState("");
  const [testBQrStatus, setTestBQrStatus] = useState("idle");
  const [testBQrMessage, setTestBQrMessage] = useState("");
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingTestBSession, setLoadingTestBSession] = useState(true);
  const [starting, setStarting] = useState(false);
  const [startingTestB, setStartingTestB] = useState(false);
  const { showToast } = useToast();

  const loadSession = useCallback(async (probe = false) => {
    try {
      setLoadingSession(true);
      setSession(await getDoubaoSessionStatus(probe));
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    } finally {
      setLoadingSession(false);
    }
  }, [showToast]);

  const loadTestBSession = useCallback(async (probe = false) => {
    try {
      setLoadingTestBSession(true);
      setTestBSession(await getDoubaoTestBSessionStatus(probe));
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    } finally {
      setLoadingTestBSession(false);
    }
  }, [showToast]);

  useEffect(() => { loadSession(); loadTestBSession(); }, [loadSession, loadTestBSession]);

  // Poll QR status when active
  useEffect(() => {
    if (!["fetching_qr", "waiting_scan", "scanned"].includes(qrStatus)) return;
    const interval = setInterval(async () => {
      try {
        const res = await getDoubaoQRStatus();
        setQrStatus(res.status);
        setQrMessage(res.message);
        if (res.status === "confirmed") {
          showToast({ title: "豆包登录成功", type: "success" });
          setQrBase64("");
          loadSession();
        } else if (["expired", "error", "idle"].includes(res.status)) {
          setQrBase64("");
        }
      } catch { /* ignore poll errors */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [qrStatus, showToast, loadSession]);

  useEffect(() => {
    if (!["fetching_qr", "waiting_scan", "scanned"].includes(testBQrStatus)) return;
    const interval = setInterval(async () => {
      try {
        const res = await getDoubaoTestBQRStatus();
        setTestBQrStatus(res.status);
        setTestBQrMessage(res.message);
        if (res.status === "confirmed") {
          showToast({ title: "B 账号登录成功", type: "success" });
          setTestBQrBase64("");
          loadTestBSession(true);
        } else if (["expired", "error", "idle"].includes(res.status)) {
          setTestBQrBase64("");
        }
      } catch { /* ignore poll errors */ }
    }, 1200);
    return () => clearInterval(interval);
  }, [testBQrStatus, showToast, loadTestBSession]);

  async function handleStartQR() {
    setStarting(true);
    setQrStatus("fetching_qr");
    setQrMessage("正在获取二维码...");
    try {
      const res = await startDoubaoQR();
      setQrBase64(res.qr_base64);
      setQrStatus("waiting_scan");
      setQrMessage("等待扫码");
    } catch (e) {
      setQrStatus("error");
      setQrMessage(getErrorMessage(e));
      showToast({ title: getErrorMessage(e), type: "error" });
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    try {
      await cancelDoubaoQR();
      setQrBase64("");
      setQrStatus("idle");
      setQrMessage("");
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    }
  }

  async function handleStartTestBQR() {
    setStartingTestB(true);
    setTestBQrStatus("fetching_qr");
    setTestBQrMessage("正在获取 B 账号二维码...");
    try {
      const res = await startDoubaoTestBQR();
      setTestBQrBase64(res.qr_base64);
      setTestBQrStatus("waiting_scan");
      setTestBQrMessage("等待扫码，请用另一个豆包账号确认");
    } catch (e) {
      setTestBQrStatus("error");
      setTestBQrMessage(getErrorMessage(e));
      showToast({ title: getErrorMessage(e), type: "error" });
    } finally {
      setStartingTestB(false);
    }
  }

  async function handleCancelTestBQR() {
    try {
      await cancelDoubaoTestBQR();
      setTestBQrBase64("");
      setTestBQrStatus("idle");
      setTestBQrMessage("");
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    }
  }

  const isQRActive = ["fetching_qr", "waiting_scan", "scanned"].includes(qrStatus);
  const isTestBQRActive = ["fetching_qr", "waiting_scan", "scanned"].includes(testBQrStatus);
  const sessionStatusLabel = !session?.has_session ? "无 Session" : session.verified ? (session.usable ? "有效" : "不可用") : "未验证";
  const sessionStatusClass = !session?.has_session ? "text-red-300" : session.verified ? (session.usable ? "text-green-300" : "text-red-300") : "text-yellow-300";
  const testBSessionLabel = !testBSession?.has_session ? "未保存" : testBSession.verified ? (testBSession.usable ? "有效" : "不可用") : "已保存未验证";
  const testBSessionClass = !testBSession?.has_session ? "text-yellow-300" : testBSession.verified ? (testBSession.usable ? "text-green-300" : "text-red-300") : "text-orange-200";
  const qrSteps = [
    { key: "idle", label: "空闲" },
    { key: "fetching_qr", label: "获取二维码" },
    { key: "waiting_scan", label: "等待扫码" },
    { key: "scanned", label: "手机确认" },
    { key: "confirmed", label: "已保存" },
  ];

  return (
    <div className="space-y-6">
      {/* Session Status Card */}
      <div className="retro-panel p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="retro-kicker">TOS 存储</p>
            <h2 className="retro-title mt-1 text-xl">豆包 Session</h2>
          </div>
          <button onClick={() => loadSession(true)} disabled={loadingSession}
            className="retro-nav-button min-h-[44px] px-3 type-caption disabled:opacity-50">
            <RefreshCw size={14} className={loadingSession ? "animate-spin" : ""} /> 验证
          </button>
        </div>

        {loadingSession && !session ? (
          <p className="mt-4 type-body-sm retro-muted">加载中...</p>
        ) : session ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <div className="retro-card p-4">
              <p className="retro-kicker">状态</p>
              <p className={`mt-1 type-body-sm font-semibold ${sessionStatusClass}`}>
                {sessionStatusLabel}
              </p>
              {session.has_session && !session.verified && (
                <p className="mt-1 type-caption text-yellow-300">点击“验证”实际检查豆包授权是否可用</p>
              )}
              {session.verified && session.check_message && (
                <p className={`mt-1 type-caption ${session.usable ? "text-green-300" : "text-red-300"}`}>{session.check_message}</p>
              )}
            </div>
            <div className="retro-card p-4">
              <p className="retro-kicker">Session ID</p>
              <p className="mt-1 type-body-sm font-mono text-orange-200">
                {session.sessionid_prefix || "—"}
              </p>
            </div>
            <div className="retro-card p-4">
              <p className="retro-kicker">上次刷新</p>
              <p className="mt-1 type-body-sm retro-text">
                {session.last_refresh || "—"}
              </p>
              {session.age_hours > 0 && (
                <p className={`mt-0.5 type-caption ${session.age_hours > 24 ? "text-yellow-300" : "retro-muted"}`}>
                  {session.age_hours}h ago
                </p>
              )}
            </div>
            <div className="retro-card p-4">
              <p className="retro-kicker">标称到期</p>
              <p className={`mt-1 type-body-sm font-semibold ${sidGuardStatusClass(session.sid_guard_status)}`}>
                {sidGuardStatusLabel(session.sid_guard_status)}
              </p>
              <p className="mt-1 type-caption retro-text">{session.sid_guard_expires_at || "—"}</p>
              {session.sid_guard_expires_in_hours !== null && session.sid_guard_expires_in_hours !== undefined && (
                <p className={`mt-0.5 type-caption ${sidGuardStatusClass(session.sid_guard_status)}`}>
                  {sidGuardHoursLabel(session.sid_guard_expires_in_hours)}
                </p>
              )}
            </div>
            <div className="retro-card p-4">
              <p className="retro-kicker">最近探活</p>
              <p className={`mt-1 type-body-sm ${session.last_probe_error ? "text-red-300" : "retro-text"}`}>
                {session.last_probe_error ? session.last_probe_at || "—" : session.last_probe_success_at || session.last_probe_at || "—"}
              </p>
              {session.last_probe_error && <p className="mt-1 type-caption text-red-300">{session.last_probe_error}</p>}
            </div>
            <div className="retro-card p-4">
              <p className="retro-kicker">登录心跳</p>
              <p className={`mt-1 type-body-sm ${session.last_heartbeat_error ? "text-red-300" : "retro-text"}`}>
                {session.last_heartbeat_error ? session.last_heartbeat_at || "—" : session.last_heartbeat_success_at || session.last_heartbeat_at || "—"}
              </p>
              {session.last_heartbeat_error && <p className="mt-1 type-caption text-red-300">{session.last_heartbeat_error}</p>}
            </div>
          </div>
        ) : null}
      </div>

      {/* QR Login Card */}
      <div className="retro-panel p-6">
        <h3 className="type-body-sm font-semibold text-nyy-500">扫码登录</h3>
          <p className="mt-1 type-caption retro-muted">
          用豆包 App 扫描二维码来刷新 Session；标称到期来自 sid_guard，真实可用性以“验证”为准。
        </p>

        {!isQRActive && qrStatus !== "confirmed" && (
          <button onClick={handleStartQR} disabled={starting}
            className="btn-primary mt-4 disabled:opacity-50">
            {starting ? "获取中..." : "开始扫码登录"}
          </button>
        )}

        {qrBase64 && (
          <div className="mt-4 flex flex-col items-center gap-4">
            <div className="rounded-2xl border border-nyy-500/30 bg-white p-3 shadow-[0_0_24px_rgba(255,138,61,0.18)]">
              <img src={`data:image/png;base64,${qrBase64}`} alt="QR Code" className="h-48 w-48" />
            </div>
            <p className="type-body-sm retro-text">{qrMessage}</p>
            <button onClick={handleCancel}
              className="retro-btn-secondary min-h-[44px] px-4 type-body-sm">
              取消
            </button>
          </div>
        )}

        {!qrBase64 && isQRActive && (
          <div className="mt-4 flex items-center gap-3">
            <RefreshCw size={16} className="animate-spin text-orange-400" />
            <p className="type-body-sm retro-text">{qrMessage}</p>
          </div>
        )}

        {qrStatus === "confirmed" && (
          <p className="mt-4 type-body-sm font-medium text-green-300">
            登录成功，Session 已更新
          </p>
        )}

        {qrStatus === "expired" && (
          <div className="mt-4">
            <p className="type-body-sm text-yellow-300">二维码已过期</p>
            <button onClick={handleStartQR} className="btn-primary mt-2 min-h-[44px] px-4 type-body-sm">
              重新获取
            </button>
          </div>
        )}

        {qrStatus === "error" && (
          <div className="mt-4">
            <p className="type-body-sm text-red-300">{qrMessage}</p>
            <button onClick={handleStartQR} className="btn-primary mt-2 min-h-[44px] px-4 type-body-sm">
              重试
            </button>
          </div>
        )}
      </div>

      <div className="retro-panel p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="retro-kicker">互读实验</p>
            <h3 className="type-body-sm font-semibold text-nyy-500">B 账号测试 Session</h3>
            <p className="mt-1 type-caption retro-muted">扫码保存到独立文件，不覆盖当前生产 Session。二维码很短效，点按钮后立即扫码。</p>
          </div>
          <button onClick={() => loadTestBSession(true)} disabled={loadingTestBSession} className="retro-nav-button min-h-[44px] px-3 type-caption disabled:opacity-50">
            <RefreshCw size={14} className={loadingTestBSession ? "animate-spin" : ""} /> 验证 B
          </button>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <div className="retro-card p-4">
            <p className="retro-kicker">B Session</p>
            <p className={`mt-1 type-body-sm font-semibold ${testBSessionClass}`}>{testBSessionLabel}</p>
            {testBSession?.check_message && <p className={`mt-1 type-caption ${testBSession.usable ? "text-green-300" : "text-red-300"}`}>{testBSession.check_message}</p>}
          </div>
          <div className="retro-card p-4">
            <p className="retro-kicker">Session ID</p>
            <p className="mt-1 type-body-sm font-mono text-orange-200">{testBSession?.sessionid_prefix || "—"}</p>
          </div>
          <div className="retro-card p-4">
            <p className="retro-kicker">上次刷新</p>
            <p className="mt-1 type-body-sm retro-text">{testBSession?.last_refresh || "—"}</p>
            {!!testBSession?.age_hours && <p className="mt-0.5 type-caption retro-muted">{testBSession.age_hours}h ago</p>}
          </div>
          <div className="retro-card p-4">
            <p className="retro-kicker">标称到期</p>
            <p className={`mt-1 type-body-sm font-semibold ${sidGuardStatusClass(testBSession?.sid_guard_status || "unknown")}`}>
              {sidGuardStatusLabel(testBSession?.sid_guard_status || "unknown")}
            </p>
            <p className="mt-1 type-caption retro-text">{testBSession?.sid_guard_expires_at || "—"}</p>
            {testBSession?.sid_guard_expires_in_hours !== null && testBSession?.sid_guard_expires_in_hours !== undefined && (
              <p className={`mt-0.5 type-caption ${sidGuardStatusClass(testBSession.sid_guard_status)}`}>
                {sidGuardHoursLabel(testBSession.sid_guard_expires_in_hours)}
              </p>
            )}
          </div>
          <div className="retro-card p-4">
            <p className="retro-kicker">最近探活</p>
            <p className={`mt-1 type-body-sm ${testBSession?.last_probe_error ? "text-red-300" : "retro-text"}`}>
              {testBSession?.last_probe_error ? testBSession.last_probe_at || "—" : testBSession?.last_probe_success_at || testBSession?.last_probe_at || "—"}
            </p>
            {testBSession?.last_probe_error && <p className="mt-1 type-caption text-red-300">{testBSession.last_probe_error}</p>}
          </div>
          <div className="retro-card p-4">
            <p className="retro-kicker">登录心跳</p>
            <p className={`mt-1 type-body-sm ${testBSession?.last_heartbeat_error ? "text-red-300" : "retro-text"}`}>
              {testBSession?.last_heartbeat_error ? testBSession.last_heartbeat_at || "—" : testBSession?.last_heartbeat_success_at || testBSession?.last_heartbeat_at || "—"}
            </p>
            {testBSession?.last_heartbeat_error && <p className="mt-1 type-caption text-red-300">{testBSession.last_heartbeat_error}</p>}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {qrSteps.map((step) => (
            <span key={step.key} className={`rounded-full border px-3 py-1 type-caption ${testBQrStatus === step.key ? "border-nyy-500 bg-nyy-500/15 text-nyy-500" : "border-white/10 retro-muted"}`}>{step.label}</span>
          ))}
          {testBQrStatus === "expired" && <span className="rounded-full border border-yellow-500/30 bg-yellow-500/10 px-3 py-1 type-caption text-yellow-300">已过期</span>}
          {testBQrStatus === "error" && <span className="rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 type-caption text-red-300">失败</span>}
        </div>

        {!isTestBQRActive && testBQrStatus !== "confirmed" && (
          <button onClick={handleStartTestBQR} disabled={startingTestB} className="btn-primary mt-4 disabled:opacity-50">
            {startingTestB ? "获取中..." : "获取 B 账号二维码"}
          </button>
        )}

        {testBQrBase64 && (
          <div className="mt-4 flex flex-col items-center gap-4">
            <div className="rounded-2xl border border-nyy-500/30 bg-white p-3 shadow-[0_0_24px_rgba(255,138,61,0.18)]">
              <img src={`data:image/png;base64,${testBQrBase64}`} alt="B 账号豆包二维码" className="h-52 w-52" />
            </div>
            <p className="type-body-sm retro-text">{testBQrMessage}</p>
            <button onClick={handleCancelTestBQR} className="retro-btn-secondary min-h-[44px] px-4 type-body-sm">取消 B 账号扫码</button>
          </div>
        )}

        {!testBQrBase64 && isTestBQRActive && (
          <div className="mt-4 flex items-center gap-3">
            <RefreshCw size={16} className="animate-spin text-orange-400" />
            <p className="type-body-sm retro-text">{testBQrMessage}</p>
          </div>
        )}

        {testBQrStatus === "confirmed" && <p className="mt-4 type-body-sm font-medium text-green-300">B 账号登录成功，测试 Session 已独立保存</p>}
        {testBQrStatus === "expired" && <button onClick={handleStartTestBQR} className="btn-primary mt-4 min-h-[44px] px-4 type-body-sm">重新获取 B 二维码</button>}
        {testBQrStatus === "error" && (
          <div className="mt-4">
            <p className="type-body-sm text-red-300">{testBQrMessage}</p>
            <button onClick={handleStartTestBQR} className="btn-primary mt-2 min-h-[44px] px-4 type-body-sm">重试 B 账号扫码</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Quota Field Helpers ─── */
function QNumField({ label, hint, value, suffix, onChange }: { label: string; hint: string; value: number; suffix: string; onChange: (v: number) => void }) {
  return (
    <label className="retro-card block p-4">
      <span className="type-body-sm font-medium retro-text">{label}</span>
      <span className="mt-1 block type-caption retro-muted">{hint}</span>
      <div className="retro-input mt-3 flex items-center overflow-hidden p-0 focus-within:border-nyy-500">
        <input className="min-h-[44px] min-w-0 flex-1 bg-transparent px-3 outline-none" type="number" min={1} step={1} inputMode="numeric" value={value} onChange={(e) => onChange(Math.max(1, Math.floor(num(e.target.value))))} />
        <span className="border-l border-white/10 px-3 type-caption retro-text">{suffix}</span>
      </div>
    </label>
  );
}

function QSizeField({ label, hint, bytes, unit, onChange }: { label: string; hint: string; bytes: number; unit: "MB" | "GB"; onChange: (b: number) => void }) {
  const dv = bytesToUnit(bytes, unit);
  return (
    <label className="retro-card block p-4">
      <span className="type-body-sm font-medium retro-text">{label}</span>
      <span className="mt-1 block type-caption retro-muted">{hint}</span>
      <div className="retro-input mt-3 flex items-center overflow-hidden p-0 focus-within:border-nyy-500">
        <input className="min-h-[44px] min-w-0 flex-1 bg-transparent px-3 outline-none" type="number" min={0.01} step={0.01} inputMode="decimal" value={Number.isInteger(dv) ? dv : dv.toFixed(2)} onChange={(e) => onChange(unitToBytes(e.target.value, unit))} />
        <span className="border-l border-white/10 px-3 type-caption font-semibold retro-text">{unit}</span>
      </div>
      <span className="mt-2 block type-caption retro-muted">实际保存：{formatSize(bytes)}（{bytes.toLocaleString()} bytes）</span>
    </label>
  );
}
