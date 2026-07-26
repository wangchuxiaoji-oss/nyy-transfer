"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Home, LogOut, RefreshCw } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { CaptchaChallenge } from "@/components/captcha-challenge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/components/toast-provider";
import { AdminIpSourcesDrawer } from "@/components/admin-ip-sources-drawer";
import { getMe, login, logout } from "@/lib/auth";
import { getErrorMessage, isHttpStatusError } from "@/lib/errors";
import {
  banAdminShare,
  getAdminDashboard,
  getAdminEmails,
  getAdminReports,
  getAdminShares,
  getAdminUsers,
  getDownloadConfig,
  getQuotaPolicies,
  retryAdminEmails,
  sendAdminUserPasswordReset,
  unbanAdminShare,
  updateAdminReportStatus,
  updateAdminUser,
  updateDownloadConfig,
  type AdminDashboard,
  type AdminEmailItem,
  type AdminReportItem,
  type AdminShareItem,
  type AdminSourceTarget,
  type AdminUserItem,
  type AdminUserPatch,
  type DownloadConfig,
  type QuotaPolicyList,
} from "@/lib/admin";
import { ADMIN_QUERY_RESET, readAdminQueryState, type AdminTab } from "@/lib/admin-query-state";
import { AdminNavigation } from "./admin-navigation";
import { AdminOverview } from "./admin-overview";
import { AdminShareFilters } from "./admin-share-filters";
import { AdminShareList } from "./admin-share-list";
import { AdminReportQueue } from "./admin-report-queue";
import { AdminUserList, type UserConfirmAction } from "./admin-user-list";
import { AdminEmailQueue, adminEmailKey } from "./admin-email-queue";
import { AdminDownloadPanel, AdminQuotaPanel } from "./admin-config-panel";
import { AdminDoubaoPanel } from "./admin-doubao-panel";
import { AdminDiagnosticsPanel } from "./admin-diagnostics-panel";
import { AdminListToolbar } from "./admin-list-toolbar";
import { AdminBanDialog } from "./admin-ban-dialog";
import { AdminLoading, AdminSectionError } from "./admin-ui";
import { AdminMailbox } from "./admin-mailbox";
import { AdminAnnouncementsPanel } from "./admin-announcements-panel";

const ADMIN_PATH = "/admin";
const PAGE_SIZE = 20;
type AuthState = "checking" | "authenticated" | "anonymous" | "error";

const TAB_TITLES: Record<AdminTab, [string, string]> = {
  overview: ["运营总览", "优先处理异常与待办"], shares: ["分享管理", "高密度审核与来源调查"], reports: ["举报队列", "预览、处置与封禁联动"], users: ["用户管理", "账号状态与来源核查"], emails: ["邮件队列", "失败投递与重试入口"], mailbox: ["收件箱", "支持线程、附件与完整处置的邮件工作台"], announcements: ["更新发布", "版本、维护与服务事件通知"], quota: ["配额配置", "游客与注册用户规则"], download: ["下载配置", "浏览器保存行为"], doubao: ["豆包 Session", "生产凭据验证与刷新"], diagnostics: ["系统诊断", "开发与维护工具"],
};

function createRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function AdminShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = readAdminQueryState(searchParams);
  const { showToast } = useToast();
  const requestSerialRef = useRef(0);
  const pendingRef = useRef(new Set<string>());

  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authError, setAuthError] = useState("");
  const [email, setEmail] = useState("admin@nyy.app");
  const [password, setPassword] = useState("");
  const [mailboxRefreshToken, setMailboxRefreshToken] = useState(0);
  const [loginError, setLoginError] = useState("");
  const [loginNeedsCaptcha, setLoginNeedsCaptcha] = useState(false);
  const [loginCaptchaToken, setLoginCaptchaToken] = useState<string | null>(null);

  const [moduleLoading, setModuleLoading] = useState(false);
  const [moduleError, setModuleError] = useState("");
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [shares, setShares] = useState<AdminShareItem[]>([]);
  const [sharePagination, setSharePagination] = useState({ mode: "page" as "cursor" | "page", page: 1, pageSize: PAGE_SIZE, total: 0 as number | null, totalEstimated: false, hasMore: false, nextCursor: null as string | null });
  const [reports, setReports] = useState<AdminReportItem[]>([]);
  const [reportsTotal, setReportsTotal] = useState(0);
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [emails, setEmails] = useState<AdminEmailItem[]>([]);
  const [emailsTotal, setEmailsTotal] = useState(0);
  const [quotaPolicies, setQuotaPolicies] = useState<QuotaPolicyList | null>(null);
  const [downloadConfig, setDownloadConfig] = useState<DownloadConfig | null>(null);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [sourceTarget, setSourceTarget] = useState<AdminSourceTarget | null>(null);
  const [banTarget, setBanTarget] = useState<AdminShareItem | null>(null);
  const [userConfirm, setUserConfirm] = useState<{ user: AdminUserItem; action: UserConfirmAction } | null>(null);

  const setQuery = useCallback((patch: Record<string, string | number | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(patch).forEach(([key, value]) => {
      if (value === null || value === "" || value === "all") params.delete(key);
      else params.set(key, String(value));
    });
    const next = params.toString();
    router.replace(next ? `${ADMIN_PATH}?${next}` : ADMIN_PATH, { scroll: false });
  }, [router, searchParams]);

  const expireAuth = useCallback(async () => {
    await logout();
    setAuthState("anonymous");
    setPassword("");
    setLoginError("管理员登录已失效，请重新登录");
  }, []);

  const handleDataError = useCallback((error: unknown) => {
    if (isHttpStatusError(error, 401) || isHttpStatusError(error, 403)) {
      void expireAuth();
      return "管理员登录已失效或权限不足";
    }
    return getErrorMessage(error, "当前模块加载失败");
  }, [expireAuth]);

  const loadCurrentModule = useCallback(async () => {
    if (authState !== "authenticated") return;
    const serial = ++requestSerialRef.current;
    setModuleError("");
    if (query.tab === "doubao" || query.tab === "diagnostics" || query.tab === "mailbox" || query.tab === "announcements") {
      setModuleLoading(false);
      return;
    }
    setModuleLoading(true);
    try {
      if (query.tab === "overview") {
        const result = await getAdminDashboard();
        if (serial === requestSerialRef.current) setDashboard(result);
      } else if (query.tab === "shares") {
        const result = await getAdminShares({
          page: query.page, pageSize: PAGE_SIZE, q: query.q || undefined, status: query.status, sort: query.sort,
          paginationMode: query.paginationMode, after: query.after || undefined, createdFrom: query.createdFrom || undefined,
          createdTo: query.createdTo || undefined, expiresFrom: query.expiresFrom || undefined, expiresTo: query.expiresTo || undefined,
          activityFrom: query.activityFrom || undefined, activityTo: query.activityTo || undefined, minFiles: query.minFiles,
          maxFiles: query.maxFiles, minBytes: query.minBytes, maxBytes: query.maxBytes, risk: query.risk,
        });
        if (serial !== requestSerialRef.current) return;
        const items = result.items || result.shares || [];
        const responseMode = result.pagination_mode || (result.next_cursor !== undefined ? query.paginationMode : "page");
        setShares(items);
        setSharePagination({ mode: responseMode, page: result.page || query.page, pageSize: result.page_size || PAGE_SIZE, total: result.total ?? null, totalEstimated: Boolean(result.total_is_estimated), hasMore: Boolean(result.has_more), nextCursor: result.next_cursor || null });
      } else if (query.tab === "reports") {
        const result = await getAdminReports({ page: query.page, pageSize: PAGE_SIZE, q: query.q || undefined, status: query.status });
        if (serial === requestSerialRef.current) { setReports(result.reports || []); setReportsTotal(result.total || 0); }
      } else if (query.tab === "users") {
        const result = await getAdminUsers({ page: query.page, pageSize: PAGE_SIZE, q: query.q || undefined, status: query.status, sort: query.sort });
        if (serial === requestSerialRef.current) { setUsers(result.items || result.users || []); setUsersTotal(result.total || 0); }
      } else if (query.tab === "emails") {
        const result = await getAdminEmails({ page: query.page, pageSize: PAGE_SIZE, q: query.q || undefined, status: query.status });
        if (serial === requestSerialRef.current) { setEmails(result.emails || []); setEmailsTotal(result.total || 0); }
      } else if (query.tab === "quota") {
        const result = await getQuotaPolicies();
        if (serial === requestSerialRef.current) setQuotaPolicies(result);
      } else if (query.tab === "download") {
        const result = await getDownloadConfig();
        if (serial === requestSerialRef.current) setDownloadConfig(result);
      }
    } catch (error) {
      if (serial === requestSerialRef.current) setModuleError(handleDataError(error));
    } finally {
      if (serial === requestSerialRef.current) setModuleLoading(false);
    }
  }, [authState, handleDataError, query.activityFrom, query.activityTo, query.after, query.createdFrom, query.createdTo, query.expiresFrom, query.expiresTo, query.maxBytes, query.maxFiles, query.minBytes, query.minFiles, query.page, query.paginationMode, query.q, query.risk, query.sort, query.status, query.tab]);

  const verifyAuth = useCallback(async () => {
    setAuthState("checking");
    setAuthError("");
    try {
      const user = await getMe();
      if (!user.is_admin) {
        setLoginError("当前账号不是管理员");
        setAuthState("anonymous");
        return;
      }
      setEmail(user.email);
      setAuthState("authenticated");
    } catch (error) {
      if (isHttpStatusError(error, 401) || isHttpStatusError(error, 403)) setAuthState("anonymous");
      else { setAuthError(getErrorMessage(error, "管理员身份验证失败")); setAuthState("error"); }
    }
  }, []);

  useEffect(() => { void verifyAuth(); }, [verifyAuth]);
  useEffect(() => { void loadCurrentModule(); }, [loadCurrentModule]);

  const refreshCurrent = useCallback(async () => {
    if (query.tab === "mailbox") setMailboxRefreshToken((value) => value + 1);
    const operations: Promise<unknown>[] = [loadCurrentModule()];
    if (query.tab !== "overview") operations.push(getAdminDashboard().then(setDashboard));
    await Promise.allSettled(operations);
  }, [loadCurrentModule, query.tab]);

  const runMutation = useCallback(async (key: string, operation: () => Promise<void>, successMessage: string, refresh = true): Promise<boolean> => {
    if (pendingRef.current.has(key)) return false;
    pendingRef.current.add(key);
    setPendingKeys(new Set(pendingRef.current));
    try {
      await operation();
      showToast({ title: successMessage, type: "success" });
      if (refresh) await refreshCurrent();
      return true;
    } catch (error) {
      showToast({ title: handleDataError(error), type: "error" });
      if (refresh) await refreshCurrent();
      return false;
    } finally {
      pendingRef.current.delete(key);
      setPendingKeys(new Set(pendingRef.current));
    }
  }, [handleDataError, refreshCurrent, showToast]);

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (authState === "checking") return;
    setLoginError("");
    setAuthState("checking");
    try {
      await login(email, password, loginCaptchaToken || undefined);
      const user = await getMe();
      if (!user.is_admin) throw new Error("当前账号不是管理员");
      setEmail(user.email);
      setAuthState("authenticated");
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? (error as { status?: number }).status : undefined;
      if (status === 428 || loginCaptchaToken) {
        setLoginNeedsCaptcha(true);
        setLoginCaptchaToken(null);
      }
      if (status === 428) setLoginError("登录失败次数过多，请完成人机验证");
      else setLoginError(getErrorMessage(error, "登录失败"));
      if (status === 401 || status === 403) await logout();
      setAuthState("anonymous");
    }
  };

  const changeTab = (tab: AdminTab, status?: string) => {
    const tabValue = tab === "overview" ? null : tab;
    setQuery({ ...ADMIN_QUERY_RESET, tab: tabValue, status: status || (tab === "reports" ? "pending" : null) });
  };

  const handleBanConfirm = async (reason: string) => {
    if (!banTarget) return;
    const target = banTarget;
    const success = await runMutation(`share:${target.code}`, async () => {
      if (target.banned) await unbanAdminShare(target.code);
      else await banAdminShare(target.code, reason);
    }, target.banned ? "分享已解封" : "分享已封禁");
    if (success) setBanTarget(null);
  };

  const updateUser = (user: AdminUserItem, patch: AdminUserPatch, message: string) => void runMutation(`user:${user.id}`, async () => { await updateAdminUser(user.id, patch); }, message);
  const confirmUser = async () => {
    if (!userConfirm) return;
    const { user, action } = userConfirm;
    const success = await runMutation(`user:${user.id}`, async () => {
      if (action === "reset") await sendAdminUserPasswordReset(user.id);
      else await updateAdminUser(user.id, action === "disable" ? { disabled: true } : action === "enable" ? { disabled: false } : action === "delete" ? { deleted: true } : { deleted: false });
    }, action === "reset" ? "重置邮件已发送" : action === "disable" ? "用户已禁用" : action === "enable" ? "用户已启用" : action === "delete" ? "用户已软删除" : "用户已恢复");
    if (success) setUserConfirm(null);
  };

  const updateReport = (report: AdminReportItem, status: "pending" | "resolved" | "dismissed") => void runMutation(`report:${report.id}`, async () => { await updateAdminReportStatus(report.id, status); }, status === "pending" ? "举报已重新打开" : status === "resolved" ? "举报已标记处理" : "举报已驳回");
  const banFromReport = (report: AdminReportItem) => void runMutation(`report:${report.id}`, async () => { await banAdminShare(report.share_code, `举报联动：${report.reason}`); await updateAdminReportStatus(report.id, "resolved"); }, "分享已封禁，举报已处理");
  const retryEmail = (item: AdminEmailItem) => {
    const key = adminEmailKey(item);
    void runMutation(`email:${key}`, async () => { await retryAdminEmails([item.delivery_id || item.id || key], createRequestId()); }, "邮件重试任务已提交");
  };
  const saveDownload = (config: DownloadConfig) => runMutation("config:download", async () => { setDownloadConfig(await updateDownloadConfig(config)); }, "下载配置已保存", false);

  if (authState === "checking") return <main className="nyy-product-shell admin-console-shell flex items-center justify-center retro-text"><RefreshCw className="mr-2 h-5 w-5 animate-spin" />正在验证管理员身份...</main>;
  if (authState === "error") return <main className="nyy-product-shell admin-console-shell flex items-center justify-center px-4"><div className="retro-panel-strong w-full max-w-md p-6 text-center"><h1 className="retro-title text-lg">身份服务暂时不可用</h1><p className="mt-2 type-body-sm retro-muted">{authError}</p><button type="button" onClick={() => void verifyAuth()} className="btn-primary mt-5">重试验证</button></div></main>;
  if (authState === "anonymous") return <AdminLogin email={email} password={password} loginError={loginError} needsCaptcha={loginNeedsCaptcha} captchaToken={loginCaptchaToken} onEmail={setEmail} onPassword={setPassword} onCaptcha={(token) => { setLoginCaptchaToken(token); setLoginError(""); }} onSubmit={handleLogin} />;

  const [title, subtitle] = TAB_TITLES[query.tab];
  const controls = query.tab === "shares" ? <AdminShareFilters query={query} setQuery={setQuery} /> : (["reports", "users", "emails"] as AdminTab[]).includes(query.tab) ? <AdminListToolbar tab={query.tab as "reports" | "users" | "emails"} query={query} setQuery={setQuery} /> : null;
  let moduleContent: React.ReactNode;
  if (moduleLoading) moduleContent = <AdminLoading />;
  else if (moduleError) moduleContent = <AdminSectionError message={moduleError} onRetry={() => void loadCurrentModule()} />;
  else if (query.tab === "overview" && dashboard) moduleContent = <AdminOverview dashboard={dashboard} onNavigate={changeTab} />;
  else if (query.tab === "shares") moduleContent = <AdminShareList shares={shares} pagination={sharePagination} pendingCodes={new Set(Array.from(pendingKeys).filter((key) => key.startsWith("share:")).map((key) => key.slice(6)))} onBan={setBanTarget} onSource={(share) => setSourceTarget({ kind: "share", id: share.code, label: `/${share.code}` })} onPage={(page) => setQuery({ page: page <= 1 ? null : page, after: null })} onCursor={(cursor) => setQuery({ after: cursor, page: cursor ? query.page + 1 : null })} />;
  else if (query.tab === "reports") moduleContent = <AdminReportQueue reports={reports} total={reportsTotal} page={query.page} pendingIds={new Set(Array.from(pendingKeys).filter((key) => key.startsWith("report:")).map((key) => key.slice(7)))} onStatus={updateReport} onBan={banFromReport} onSource={(report) => setSourceTarget({ kind: "share", id: report.share_code, label: `/${report.share_code}` })} onPage={(page) => setQuery({ page: page <= 1 ? null : page })} />;
  else if (query.tab === "users") moduleContent = <AdminUserList users={users} total={usersTotal} page={query.page} pendingIds={new Set(Array.from(pendingKeys).filter((key) => key.startsWith("user:")).map((key) => key.slice(5)))} onUpdate={updateUser} onConfirm={(user, action) => setUserConfirm({ user, action })} onSource={(user) => setSourceTarget({ kind: "user", id: user.id, label: user.email })} onPage={(page) => setQuery({ page: page <= 1 ? null : page })} />;
  else if (query.tab === "emails") moduleContent = <AdminEmailQueue emails={emails} total={emailsTotal} page={query.page} pendingIds={new Set(Array.from(pendingKeys).filter((key) => key.startsWith("email:")).map((key) => key.slice(6)))} onRetry={retryEmail} onPage={(page) => setQuery({ page: page <= 1 ? null : page })} />;
  else if (query.tab === "quota" && quotaPolicies) moduleContent = <AdminQuotaPanel initial={quotaPolicies} onChange={setQuotaPolicies} />;
  else if (query.tab === "download" && downloadConfig) moduleContent = <AdminDownloadPanel initial={downloadConfig} saving={pendingKeys.has("config:download")} onSave={saveDownload} />;
  else if (query.tab === "doubao") moduleContent = <AdminDoubaoPanel />;
  else if (query.tab === "mailbox") moduleContent = <AdminMailbox onError={handleDataError} refreshToken={mailboxRefreshToken} />;
  else if (query.tab === "announcements") moduleContent = <AdminAnnouncementsPanel />;
  else if (query.tab === "diagnostics") moduleContent = <AdminDiagnosticsPanel />;
  else moduleContent = <AdminLoading />;

  return (
    <main className="nyy-product-shell admin-console-shell min-w-0 px-3 py-4 sm:px-6 sm:py-6">
      <div className="nyy-product-content mx-auto max-w-[1500px]">
        <header className="retro-panel flex flex-col gap-4 p-4 sm:p-5 xl:flex-row xl:items-center xl:justify-between"><div className="flex min-w-0 items-center gap-4"><BrandLogo className="h-auto w-28 shrink-0 sm:w-36" priority /><div className="min-w-0 border-l border-black/10 pl-4 dark:border-white/10"><p className="retro-kicker">内部控制台</p><h1 className="truncate retro-title text-xl sm:text-2xl">{title}</h1><p className="mt-1 truncate type-caption retro-muted">{subtitle}</p></div></div><div className="flex flex-wrap items-center gap-1"><span className="max-w-full truncate rounded-full border border-black/8 px-3 py-2 type-caption retro-muted dark:border-white/10">{email}</span><ThemeToggle /><button type="button" onClick={() => router.push("/")} className="retro-nav-button"><Home className="h-4 w-4" />首页</button><button type="button" onClick={() => void refreshCurrent()} disabled={moduleLoading} className="retro-nav-button disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${moduleLoading ? "animate-spin" : ""}`} />刷新当前</button><button type="button" onClick={() => void expireAuth()} className="retro-nav-button"><LogOut className="h-4 w-4" />退出</button></div></header>
        <div className="mt-4 lg:hidden"><AdminNavigation activeTab={query.tab} onChange={changeTab} /></div>
        <div className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[176px_minmax(0,1fr)]"><div className="hidden lg:block"><AdminNavigation activeTab={query.tab} onChange={changeTab} /></div><section className="min-w-0">{controls}<div className={controls && query.tab === "shares" ? "mt-4" : ""}>{moduleContent}</div></section></div>
      </div>
      <AdminBanDialog share={banTarget} pending={banTarget ? pendingKeys.has(`share:${banTarget.code}`) : false} onClose={() => setBanTarget(null)} onConfirm={(reason) => void handleBanConfirm(reason)} />
      <ConfirmDialog open={!!userConfirm} title={userConfirm ? ({ disable: "禁用用户", enable: "启用用户", delete: "软删除用户", restore: "恢复用户", reset: "发送重置邮件" }[userConfirm.action]) : "用户操作"} description={userConfirm ? `${userConfirm.user.email}：${({ disable: "禁用后用户无法继续登录。", enable: "启用后用户可以重新登录。", delete: "软删除后业务数据仍保留。", restore: "恢复后账号重新可用。", reset: "系统会发送密码重置验证码。" }[userConfirm.action])}` : ""} confirmText="确认执行" danger={userConfirm?.action === "disable" || userConfirm?.action === "delete"} loading={userConfirm ? pendingKeys.has(`user:${userConfirm.user.id}`) : false} onConfirm={() => void confirmUser()} onCancel={() => setUserConfirm(null)} />
      <AdminIpSourcesDrawer target={sourceTarget} onClose={() => setSourceTarget(null)} />
    </main>
  );
}

function AdminLogin({ email, password, loginError, needsCaptcha, captchaToken, onEmail, onPassword, onCaptcha, onSubmit }: { email: string; password: string; loginError: string; needsCaptcha: boolean; captchaToken: string | null; onEmail: (value: string) => void; onPassword: (value: string) => void; onCaptcha: (token: string) => void; onSubmit: (event: React.FormEvent) => void }) {
  return <main className="nyy-product-shell admin-console-shell flex items-center justify-center px-4 py-8"><form onSubmit={onSubmit} className="nyy-product-content retro-panel-strong w-full max-w-sm p-7"><div className="mb-4 flex justify-end"><ThemeToggle /></div><BrandLogo className="mx-auto h-auto w-40" priority /><p className="retro-kicker mt-6">运营后台入口</p>{loginError && <p role="alert" className="mt-4 rounded-xl bg-red-950/80 px-3 py-2 type-body-sm text-red-100">{loginError}</p>}<label className="mt-6 block"><span className="type-body-sm retro-text">管理员邮箱</span><input className="retro-input mt-2 w-full type-body-sm" type="email" autoComplete="email" value={email} onChange={(event) => onEmail(event.target.value)} /></label><label className="mt-3 block"><span className="type-body-sm retro-text">密码</span><input className="retro-input mt-2 w-full type-body-sm" type="password" autoComplete="current-password" value={password} onChange={(event) => onPassword(event.target.value)} /></label>{needsCaptcha && !captchaToken && <div className="mt-4 rounded-xl border border-white/10 p-3"><p className="mb-2 type-caption retro-muted">请完成人机验证后登录</p><CaptchaChallenge purpose="login" onVerified={onCaptcha} /></div>}<button disabled={needsCaptcha && !captchaToken} className="btn-primary mt-5 w-full">进入控制台</button></form></main>;
}
