"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Shield, Users, Share2, Database, Ban, RefreshCw, Search } from "lucide-react";
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
  unbanAdminShare,
  updateQuotaConfig,
  getDoubaoSessionStatus,
  startDoubaoQR,
  getDoubaoQRStatus,
  cancelDoubaoQR,
  type AdminShareItem,
  type AdminStats,
  type AdminUserItem,
  type AdminReportItem,
  type AdminEmailItem,
  type QuotaConfig,
  type DoubaoSessionStatus,
} from "@/lib/admin";
import { formatSize } from "@/lib/utils";
import { getErrorMessage } from "@/lib/errors";
import { useToast } from "@/components/toast-provider";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Pagination } from "@/components/pagination";

const ADMIN_PATH = process.env.NEXT_PUBLIC_ADMIN_PATH || "/nyy-console";
type AdminTab = "users" | "shares" | "reports" | "emails" | "quota" | "doubao";
const PAGE_SIZE = 20;
const MB = 1024 * 1024;
const GB = 1024 * MB;

function num(v: string) { return Number(v || 0); }
function bytesToUnit(b: number, u: "MB" | "GB") { return u === "GB" ? b / GB : b / MB; }
function unitToBytes(v: string, u: "MB" | "GB") { return Math.round(num(v) * (u === "GB" ? GB : MB)); }
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function AdminPage() {
  return <Suspense fallback={<main className="min-h-dvh bg-[#0b0b0b] text-orange-100 flex items-center justify-center">加载中...</main>}><AdminConsolePage /></Suspense>;
}

function AdminConsolePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { showToast } = useToast();

  const tabParam = searchParams.get("tab") as AdminTab | null;
  const activeTab: AdminTab = (["users", "shares", "reports", "emails", "quota", "doubao"] as AdminTab[]).includes(tabParam!) ? tabParam! : "shares";
  const q = searchParams.get("q") || "";
  const statusFilter = searchParams.get("status") || "all";
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [email, setEmail] = useState("admin@nyy.app");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
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
  const [saving, setSaving] = useState(false);
  const [tabLoading, setTabLoading] = useState(false);
  const [searchDraft, setSearchDraft] = useState(q);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<AdminShareItem | null>(null);

  const setQuery = useCallback((patch: Record<string, string | number | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all") params.delete(k);
      else params.set(k, String(v));
    }
    router.replace(`${ADMIN_PATH}?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  const loadMeta = useCallback(async () => {
    const [s, qc] = await Promise.all([getAdminStats(), getQuotaConfig()]);
    setStats(s);
    setQuota(qc);
  }, []);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    setTabLoading(true);
    const load = async () => {
      try {
        if (activeTab === "users") {
          const res = await getAdminUsers({ page, pageSize: PAGE_SIZE, q: q || undefined });
          if (!cancelled) { setUsers(res.users || []); setUsersTotal(res.total); }
        } else if (activeTab === "shares") {
          const res = await getAdminShares({ page, pageSize: PAGE_SIZE, q: q || undefined, status: statusFilter !== "all" ? statusFilter : undefined });
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
  }, [authed, activeTab, q, statusFilter, page, showToast]);

  useEffect(() => {
    if (window.location.pathname !== ADMIN_PATH) { router.replace(ADMIN_PATH); return; }
    getMe()
      .then((u) => { if (u.plan !== "admin") throw new Error("非管理员"); setAuthed(true); return loadMeta(); })
      .catch(() => setAuthed(false))
      .finally(() => setLoading(false));
  }, [loadMeta, router]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault(); setLoginError(""); setLoading(true);
    try {
      await login(email, password);
      const u = await getMe();
      if (u.plan !== "admin") throw new Error("当前账号不是管理员");
      setAuthed(true); await loadMeta();
    } catch (err) { logout(); setLoginError(getErrorMessage(err, "登录失败")); }
    finally { setLoading(false); }
  }

  async function handleQuotaSave(e: React.FormEvent) {
    e.preventDefault(); if (!quota) return; setSaving(true);
    try { setQuota(await updateQuotaConfig(quota)); showToast({ title: "配额已保存", type: "success" }); }
    catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
    finally { setSaving(false); }
  }

  async function handleBanToggle() {
    if (!confirmTarget) return;
    try {
      if (confirmTarget.banned) await unbanAdminShare(confirmTarget.code);
      else await banAdminShare(confirmTarget.code, "管理员封禁");
      showToast({ title: confirmTarget.banned ? "已解封" : "已封禁", type: "success" });
      const [res, s] = await Promise.all([getAdminShares({ page, pageSize: PAGE_SIZE, q: q || undefined, status: statusFilter !== "all" ? statusFilter : undefined }), getAdminStats()]);
      setShares(res.shares || []); setSharesTotal(res.total); setStats(s);
    } catch (err) { showToast({ title: getErrorMessage(err), type: "error" }); }
    finally { setConfirmOpen(false); setConfirmTarget(null); }
  }

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); setQuery({ q: searchDraft || null, page: null }); };
  const tabs: { key: AdminTab; label: string }[] = [{ key: "shares", label: "分享" }, { key: "users", label: "用户" }, { key: "reports", label: "举报" }, { key: "emails", label: "邮件" }, { key: "quota", label: "配额" }, { key: "doubao", label: "豆包" }];

  if (loading) return <main className="min-h-dvh bg-[#0b0b0b] text-orange-100 flex items-center justify-center">加载中...</main>;

  if (!authed) {
    return (
      <main className="min-h-dvh bg-[#0b0b0b] text-orange-100 flex items-center justify-center px-4 py-8">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-3xl border border-orange-500/20 bg-[#141414] p-8 shadow-2xl shadow-orange-500/10">
          <BrandLogo className="mx-auto h-auto w-44" priority />
          <p className="mt-6 type-caption tracking-[0.3em] text-orange-100/70">运营后台入口</p>
          {loginError && <p role="alert" className="mt-4 rounded-xl bg-red-950/50 px-3 py-2 type-body-sm text-red-100">{loginError}</p>}
          <label className="mt-6 block"><span className="type-body-sm text-orange-100/80">管理员邮箱</span>
            <input className="mt-2 min-h-[44px] w-full rounded-xl border border-orange-500/20 bg-black/30 px-4 type-body-sm outline-none focus:border-orange-400" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="mt-3 block"><span className="type-body-sm text-orange-100/80">密码</span>
            <input className="mt-2 min-h-[44px] w-full rounded-xl border border-orange-500/20 bg-black/30 px-4 type-body-sm outline-none focus:border-orange-400" type="password" autoComplete="current-password" placeholder="请输入密码" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button className="mt-5 min-h-[44px] w-full rounded-xl bg-orange-500 px-4 font-semibold text-black hover:bg-orange-400">进入控制台</button>
        </form>
      </main>
    );
  }

  return (
    <main className="min-h-dvh bg-[#0b0b0b] px-4 py-8 text-orange-50 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-orange-500/10 pb-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-5">
            <BrandLogo className="h-auto w-36" priority />
            <div><p className="type-caption tracking-[0.3em] text-orange-100/70">内部控制台</p><h1 className="mt-1 type-display">运营后台</h1></div>
          </div>
          <button onClick={loadMeta} className="flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-orange-500/20 px-4 type-body-sm text-orange-100 hover:border-orange-400"><RefreshCw size={16} /> 刷新</button>
        </header>

        {stats && (
          <section className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-6">
            {([
              [Users, "用户", stats.users_total], [Share2, "分享", stats.shares_total], [Shield, "活跃", stats.shares_active],
              [Ban, "封禁", stats.shares_banned], [Database, "举报", stats.reports_pending], [Database, "邮件失败", stats.emails_failed],
            ] as const).map(([Icon, label, value]) => (
              <div key={label} className="rounded-3xl border border-orange-500/10 bg-[#141414] p-5"><Icon className="text-orange-400" size={20} /><p className="mt-4 type-body-sm text-orange-100/70">{label}</p><p className="mt-1 type-display">{value}</p></div>
            ))}
          </section>
        )}

        {/* Tabs */}
        <div className="mt-8 flex gap-1 overflow-x-auto rounded-2xl bg-black/30 p-1">
          {tabs.map((t) => (
            <button key={t.key} onClick={() => { setSearchDraft(""); setQuery({ tab: t.key === "shares" ? null : t.key, q: null, status: null, page: null }); }}
              className={`whitespace-nowrap rounded-xl px-4 py-2 type-body-sm font-medium transition ${activeTab === t.key ? "bg-orange-500 text-black" : "text-orange-100/70 hover:text-orange-100"}`}>{t.label}</button>
          ))}
        </div>

        {/* Search & Filter */}
        {activeTab !== "quota" && (
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <form onSubmit={handleSearch} className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-orange-100/50" />
              <input type="text" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} placeholder="搜索…"
                className="w-full rounded-xl border border-orange-500/15 bg-black/30 py-2 pl-9 pr-3 type-body-sm text-orange-50 placeholder:text-orange-100/40 focus:border-orange-400 focus:outline-none" />
            </form>
            {(activeTab === "shares" || activeTab === "reports" || activeTab === "emails") && (
              <select value={statusFilter} onChange={(e) => setQuery({ status: e.target.value, page: null })}
                className="rounded-xl border border-orange-500/15 bg-black/30 px-3 py-2 type-body-sm text-orange-100 focus:border-orange-400 focus:outline-none">
                <option value="all">全部状态</option>
                {activeTab === "shares" && <><option value="active">有效</option><option value="banned">已封禁</option><option value="expired">已过期</option><option value="revoked">已撤销</option></>}
                {activeTab === "reports" && <><option value="pending">待处理</option><option value="resolved">已处理</option></>}
                {activeTab === "emails" && <><option value="sent">已发送</option><option value="failed">失败</option></>}
              </select>
            )}
          </div>
        )}

        {/* Content */}
        <section className="mt-6">
          {tabLoading ? <div className="py-12 text-center text-orange-100/60">加载中...</div>
          : activeTab === "shares" ? <SharesPanel shares={shares} total={sharesTotal} page={page} onBan={(s) => { setConfirmTarget(s); setConfirmOpen(true); }} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "users" ? <UsersPanel users={users} total={usersTotal} page={page} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "reports" ? <ReportsPanel reports={reports} total={reportsTotal} page={page} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "emails" ? <EmailsPanel emails={emails} total={emailsTotal} page={page} onPage={(p) => setQuery({ page: p <= 1 ? null : p })} />
          : activeTab === "doubao" ? <DoubaoPanel />
          : <QuotaPanel quota={quota} saving={saving} onChange={setQuota} onSave={handleQuotaSave} />}
        </section>
      </div>

      <ConfirmDialog open={confirmOpen} title={confirmTarget?.banned ? "解封分享" : "封禁分享"}
        description={confirmTarget?.banned ? `确定解封 /${confirmTarget?.code}？` : `确定封禁 /${confirmTarget?.code}？封禁后链接将不可访问。`}
        confirmText={confirmTarget?.banned ? "确定解封" : "确定封禁"} danger={!confirmTarget?.banned}
        onConfirm={handleBanToggle} onCancel={() => { setConfirmOpen(false); setConfirmTarget(null); }} />
    </main>
  );
}

/* ─── Shares Panel ─── */
function SharesPanel({ shares, total, page, onBan, onPage }: { shares: AdminShareItem[]; total: number; page: number; onBan: (s: AdminShareItem) => void; onPage: (p: number) => void }) {
  if (shares.length === 0) return <p className="py-8 text-center text-orange-100/60">暂无数据</p>;
  const st = (s: AdminShareItem) => s.banned ? "封禁" : s.revoked ? "撤销" : (s.expires_at && new Date(s.expires_at) < new Date()) ? "过期" : "有效";
  const stCls = (s: AdminShareItem) => { const v = st(s); return v === "封禁" ? "bg-red-500/20 text-red-200" : v === "有效" ? "bg-green-500/20 text-green-200" : "bg-orange-500/10 text-orange-200"; };
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-orange-500/10 text-left type-caption text-orange-100/60">
          <th className="pb-2 pr-4">短码</th><th className="pb-2 pr-4">标题</th><th className="pb-2 pr-4">所有者</th><th className="pb-2 pr-4">文件</th><th className="pb-2 pr-4">下载</th><th className="pb-2 pr-4">状态</th><th className="pb-2 pr-4">创建</th><th className="pb-2">操作</th>
        </tr></thead><tbody>
          {shares.map((s) => (
            <tr key={s.code} className="border-b border-orange-500/5">
              <td className="py-3 pr-4 font-mono text-orange-300">/{s.code}</td>
              <td className="py-3 pr-4 max-w-[120px] truncate">{s.title || "—"}</td>
              <td className="py-3 pr-4 text-orange-100/70">{s.owner_email || "游客"}</td>
              <td className="py-3 pr-4">{s.file_count} · {formatSize(s.total_bytes)}</td>
              <td className="py-3 pr-4">{s.download_count}</td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${stCls(s)}`}>{st(s)}</span></td>
              <td className="py-3 pr-4 type-caption text-orange-100/60">{fmtDate(s.created_at)}</td>
              <td className="py-3"><button onClick={() => onBan(s)} className={`rounded-lg px-3 py-1 type-caption font-medium ${s.banned ? "bg-orange-500 text-black" : "bg-red-500/15 text-red-200 hover:bg-red-500/25"}`}>{s.banned ? "解封" : "封禁"}</button></td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {shares.map((s) => (
          <div key={s.code} className="rounded-2xl border border-orange-500/10 bg-[#141414] p-4">
            <div className="flex items-center justify-between"><span className="font-mono type-body-sm text-orange-300">/{s.code}</span><span className={`rounded-full px-2 py-0.5 type-caption ${stCls(s)}`}>{st(s)}</span></div>
            {s.title && <p className="mt-1 truncate type-body-sm text-orange-100/80">{s.title}</p>}
            <p className="mt-1 type-caption text-orange-100/60">{s.owner_email || "游客"} · {s.file_count} 文件 · {formatSize(s.total_bytes)} · {s.download_count} 下载</p>
            <button onClick={() => onBan(s)} className={`mt-3 min-h-[36px] w-full rounded-xl px-3 type-caption font-semibold ${s.banned ? "bg-orange-500 text-black" : "bg-red-500/15 text-red-200"}`}>{s.banned ? "解封" : "封禁"}</button>
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Users Panel ─── */
function UsersPanel({ users, total, page, onPage }: { users: AdminUserItem[]; total: number; page: number; onPage: (p: number) => void }) {
  if (users.length === 0) return <p className="py-8 text-center text-orange-100/60">暂无用户</p>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-orange-500/10 text-left type-caption text-orange-100/60">
          <th className="pb-2 pr-4">邮箱</th><th className="pb-2 pr-4">角色</th><th className="pb-2 pr-4">验证</th><th className="pb-2 pr-4">注册</th><th className="pb-2">最后登录</th>
        </tr></thead><tbody>
          {users.map((u) => (
            <tr key={u.id} className="border-b border-orange-500/5">
              <td className="py-3 pr-4">{u.email}</td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${u.plan === "admin" ? "bg-orange-500/20 text-orange-200" : "bg-green-500/20 text-green-200"}`}>{u.plan === "admin" ? "管理员" : "用户"}</span></td>
              <td className="py-3 pr-4 type-caption">{u.email_verified ? "✓" : "✗"}</td>
              <td className="py-3 pr-4 type-caption text-orange-100/60">{fmtDate(u.created_at)}</td>
              <td className="py-3 type-caption text-orange-100/60">{u.last_login_at ? fmtDate(u.last_login_at) : "—"}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {users.map((u) => (
          <div key={u.id} className="rounded-2xl border border-orange-500/10 bg-[#141414] p-4">
            <p className="type-body-sm font-medium">{u.email}</p>
            <p className="mt-1 type-caption text-orange-100/60">{u.plan === "admin" ? "管理员" : "用户"} · {u.email_verified ? "已验证" : "未验证"} · {fmtDate(u.created_at)}</p>
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Reports Panel ─── */
function ReportsPanel({ reports, total, page, onPage }: { reports: AdminReportItem[]; total: number; page: number; onPage: (p: number) => void }) {
  if (reports.length === 0) return <p className="py-8 text-center text-orange-100/60">暂无举报</p>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-orange-500/10 text-left type-caption text-orange-100/60">
          <th className="pb-2 pr-4">分享码</th><th className="pb-2 pr-4">原因</th><th className="pb-2 pr-4">补充</th><th className="pb-2 pr-4">状态</th><th className="pb-2">时间</th>
        </tr></thead><tbody>
          {reports.map((r) => (
            <tr key={r.id} className="border-b border-orange-500/5">
              <td className="py-3 pr-4 font-mono text-orange-300">/{r.share_code}</td>
              <td className="py-3 pr-4">{r.reason}</td>
              <td className="py-3 pr-4 max-w-[200px] truncate text-orange-100/70">{r.detail || "—"}</td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${r.status === "pending" ? "bg-yellow-500/20 text-yellow-200" : "bg-green-500/20 text-green-200"}`}>{r.status === "pending" ? "待处理" : "已处理"}</span></td>
              <td className="py-3 type-caption text-orange-100/60">{fmtDate(r.created_at)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {reports.map((r) => (
          <div key={r.id} className="rounded-2xl border border-orange-500/10 bg-[#141414] p-4">
            <div className="flex items-center justify-between"><span className="font-mono type-body-sm text-orange-300">/{r.share_code}</span><span className={`rounded-full px-2 py-0.5 type-caption ${r.status === "pending" ? "bg-yellow-500/20 text-yellow-200" : "bg-green-500/20 text-green-200"}`}>{r.status === "pending" ? "待处理" : "已处理"}</span></div>
            <p className="mt-1 type-body-sm">{r.reason}</p>
            {r.detail && <p className="mt-0.5 type-caption text-orange-100/60">{r.detail}</p>}
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Emails Panel ─── */
function EmailsPanel({ emails, total, page, onPage }: { emails: AdminEmailItem[]; total: number; page: number; onPage: (p: number) => void }) {
  if (emails.length === 0) return <p className="py-8 text-center text-orange-100/60">暂无邮件记录</p>;
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full type-body-sm"><thead><tr className="border-b border-orange-500/10 text-left type-caption text-orange-100/60">
          <th className="pb-2 pr-4">收件人</th><th className="pb-2 pr-4">分享码</th><th className="pb-2 pr-4">状态</th><th className="pb-2 pr-4">错误</th><th className="pb-2">时间</th>
        </tr></thead><tbody>
          {emails.map((e, i) => (
            <tr key={`${e.share_code}-${e.recipient}-${i}`} className="border-b border-orange-500/5">
              <td className="py-3 pr-4">{e.recipient}</td>
              <td className="py-3 pr-4 font-mono text-orange-300">/{e.share_code}</td>
              <td className="py-3 pr-4"><span className={`rounded-full px-2 py-0.5 type-caption ${e.status === "sent" ? "bg-green-500/20 text-green-200" : "bg-red-500/20 text-red-200"}`}>{e.status}</span></td>
              <td className="py-3 pr-4 max-w-[200px] truncate text-orange-100/60">{e.error || "—"}</td>
              <td className="py-3 type-caption text-orange-100/60">{fmtDate(e.created_at)}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
      <div className="space-y-3 md:hidden">
        {emails.map((e, i) => (
          <div key={`${e.share_code}-${e.recipient}-${i}`} className="rounded-2xl border border-orange-500/10 bg-[#141414] p-4">
            <p className="type-body-sm">{e.recipient}</p>
            <p className="mt-1 type-caption text-orange-100/60">/{e.share_code} · <span className={e.status === "sent" ? "text-green-300" : "text-red-300"}>{e.status}</span>{e.error ? ` · ${e.error}` : ""}</p>
          </div>
        ))}
      </div>
      <div className="mt-4"><Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={onPage} /></div>
    </>
  );
}

/* ─── Quota Panel ─── */
function QuotaPanel({ quota, saving, onChange, onSave }: { quota: QuotaConfig | null; saving: boolean; onChange: (q: QuotaConfig) => void; onSave: (e: React.FormEvent) => void }) {
  if (!quota) return <p className="py-8 text-center text-orange-100/60">加载配额中...</p>;
  return (
    <form onSubmit={onSave} className="rounded-3xl border border-orange-500/10 bg-[#141414] p-6">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div><p className="type-caption tracking-[0.24em] text-orange-100/70">配额规则</p><h2 className="mt-1 type-title">配额配置</h2></div>
        <p className="type-body-sm text-orange-100/70">填写运营可读单位，保存时自动转换为 bytes。</p>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section>
          <h3 className="type-body-sm font-semibold text-orange-200">游客规则</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <QSizeField label="单次分享容量" hint="游客 24h 窗口内可上传总量" bytes={quota.guest_max_file_bytes} unit="MB" onChange={(v) => onChange({ ...quota, guest_max_file_bytes: v })} />
            <QNumField label="活跃分享数" hint="未撤销、未封禁的分享上限" value={quota.guest_max_active_shares} suffix="个" onChange={(v) => onChange({ ...quota, guest_max_active_shares: v })} />
            <QNumField label="统计周期" hint="游客配额滚动窗口" value={quota.guest_ttl_hours} suffix="小时" onChange={(v) => onChange({ ...quota, guest_ttl_hours: v })} />
          </div>
        </section>
        <section>
          <h3 className="type-body-sm font-semibold text-orange-200">注册用户规则</h3>
          <div className="mt-3 grid gap-3 md:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <QSizeField label="周期上传容量" hint="注册用户统计周期内总上传量" bytes={quota.user_max_file_bytes} unit="GB" onChange={(v) => onChange({ ...quota, user_max_file_bytes: v })} />
            <QNumField label="活跃分享数" hint="可同时保留的分享数量" value={quota.user_max_active_shares} suffix="个" onChange={(v) => onChange({ ...quota, user_max_active_shares: v })} />
            <QNumField label="统计周期" hint="注册用户配额滚动窗口" value={quota.user_ttl_hours} suffix="小时" onChange={(v) => onChange({ ...quota, user_ttl_hours: v })} />
          </div>
        </section>
      </div>
      <button disabled={saving} className="mt-5 min-h-[44px] rounded-xl bg-orange-500 px-5 font-semibold text-black disabled:opacity-50">{saving ? "保存中" : "保存配置"}</button>
    </form>
  );
}

/* ─── Doubao Panel ─── */
function DoubaoPanel() {
  const [session, setSession] = useState<DoubaoSessionStatus | null>(null);
  const [qrBase64, setQrBase64] = useState("");
  const [qrStatus, setQrStatus] = useState("idle");
  const [qrMessage, setQrMessage] = useState("");
  const [loadingSession, setLoadingSession] = useState(true);
  const [starting, setStarting] = useState(false);
  const { showToast } = useToast();

  const loadSession = useCallback(async () => {
    try {
      setLoadingSession(true);
      setSession(await getDoubaoSessionStatus());
    } catch (e) {
      showToast({ title: getErrorMessage(e), type: "error" });
    } finally {
      setLoadingSession(false);
    }
  }, [showToast]);

  useEffect(() => { loadSession(); }, [loadSession]);

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

  const isQRActive = ["fetching_qr", "waiting_scan", "scanned"].includes(qrStatus);

  return (
    <div className="space-y-6">
      {/* Session Status Card */}
      <div className="rounded-3xl border border-orange-500/10 bg-[#141414] p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="type-caption tracking-[0.24em] text-orange-100/70">TOS 存储</p>
            <h2 className="mt-1 type-title">豆包 Session</h2>
          </div>
          <button onClick={loadSession} disabled={loadingSession}
            className="flex min-h-[36px] items-center gap-2 rounded-full border border-orange-500/20 px-3 type-caption text-orange-100 hover:border-orange-400 disabled:opacity-50">
            <RefreshCw size={14} className={loadingSession ? "animate-spin" : ""} /> 刷新
          </button>
        </div>

        {loadingSession && !session ? (
          <p className="mt-4 text-orange-100/60 type-body-sm">加载中...</p>
        ) : session ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl border border-orange-500/10 bg-black/20 p-4">
              <p className="type-caption text-orange-100/70">状态</p>
              <p className={`mt-1 type-body-sm font-semibold ${session.has_session ? "text-green-300" : "text-red-300"}`}>
                {session.has_session ? "有效" : "无 Session"}
              </p>
            </div>
            <div className="rounded-2xl border border-orange-500/10 bg-black/20 p-4">
              <p className="type-caption text-orange-100/70">Session ID</p>
              <p className="mt-1 type-body-sm font-mono text-orange-200">
                {session.sessionid_prefix || "—"}
              </p>
            </div>
            <div className="rounded-2xl border border-orange-500/10 bg-black/20 p-4">
              <p className="type-caption text-orange-100/70">上次刷新</p>
              <p className="mt-1 type-body-sm text-orange-100">
                {session.last_refresh || "—"}
              </p>
              {session.age_hours > 0 && (
                <p className={`mt-0.5 type-caption ${session.age_hours > 24 ? "text-yellow-300" : "text-orange-100/60"}`}>
                  {session.age_hours}h ago
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* QR Login Card */}
      <div className="rounded-3xl border border-orange-500/10 bg-[#141414] p-6">
        <h3 className="type-body-sm font-semibold text-orange-200">扫码登录</h3>
        <p className="mt-1 type-caption text-orange-100/60">
          用豆包 App 扫描二维码来刷新 Session（有效期约 24h）
        </p>

        {!isQRActive && qrStatus !== "confirmed" && (
          <button onClick={handleStartQR} disabled={starting}
            className="mt-4 min-h-[44px] rounded-xl bg-orange-500 px-5 font-semibold text-black hover:bg-orange-400 disabled:opacity-50">
            {starting ? "获取中..." : "开始扫码登录"}
          </button>
        )}

        {qrBase64 && (
          <div className="mt-4 flex flex-col items-center gap-4">
            <div className="rounded-2xl border border-orange-500/20 bg-white p-3">
              <img src={`data:image/png;base64,${qrBase64}`} alt="QR Code" className="h-48 w-48" />
            </div>
            <p className="type-body-sm text-orange-100/80">{qrMessage}</p>
            <button onClick={handleCancel}
              className="min-h-[36px] rounded-xl border border-orange-500/20 px-4 type-body-sm text-orange-100 hover:border-orange-400">
              取消
            </button>
          </div>
        )}

        {!qrBase64 && isQRActive && (
          <div className="mt-4 flex items-center gap-3">
            <RefreshCw size={16} className="animate-spin text-orange-400" />
            <p className="type-body-sm text-orange-100/80">{qrMessage}</p>
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
            <button onClick={handleStartQR} className="mt-2 min-h-[36px] rounded-xl bg-orange-500 px-4 type-body-sm font-semibold text-black hover:bg-orange-400">
              重新获取
            </button>
          </div>
        )}

        {qrStatus === "error" && (
          <div className="mt-4">
            <p className="type-body-sm text-red-300">{qrMessage}</p>
            <button onClick={handleStartQR} className="mt-2 min-h-[36px] rounded-xl bg-orange-500 px-4 type-body-sm font-semibold text-black hover:bg-orange-400">
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Quota Field Helpers ─── */
function QNumField({ label, hint, value, suffix, onChange }: { label: string; hint: string; value: number; suffix: string; onChange: (v: number) => void }) {
  return (
    <label className="block rounded-2xl border border-orange-500/10 bg-black/20 p-4">
      <span className="type-body-sm font-medium text-orange-50">{label}</span>
      <span className="mt-1 block type-caption text-orange-100/70">{hint}</span>
      <div className="mt-3 flex items-center overflow-hidden rounded-xl border border-orange-500/15 bg-black/30 focus-within:border-orange-400">
        <input className="min-h-[44px] min-w-0 flex-1 bg-transparent px-3 text-orange-50 outline-none" inputMode="numeric" value={value} onChange={(e) => onChange(num(e.target.value))} />
        <span className="border-l border-orange-500/10 px-3 type-caption text-orange-100/80">{suffix}</span>
      </div>
    </label>
  );
}

function QSizeField({ label, hint, bytes, unit, onChange }: { label: string; hint: string; bytes: number; unit: "MB" | "GB"; onChange: (b: number) => void }) {
  const dv = bytesToUnit(bytes, unit);
  return (
    <label className="block rounded-2xl border border-orange-500/10 bg-black/20 p-4">
      <span className="type-body-sm font-medium text-orange-50">{label}</span>
      <span className="mt-1 block type-caption text-orange-100/70">{hint}</span>
      <div className="mt-3 flex items-center overflow-hidden rounded-xl border border-orange-500/15 bg-black/30 focus-within:border-orange-400">
        <input className="min-h-[44px] min-w-0 flex-1 bg-transparent px-3 text-orange-50 outline-none" inputMode="decimal" value={Number.isInteger(dv) ? dv : dv.toFixed(2)} onChange={(e) => onChange(unitToBytes(e.target.value, unit))} />
        <span className="border-l border-orange-500/10 px-3 type-caption font-semibold text-orange-200/70">{unit}</span>
      </div>
      <span className="mt-2 block type-caption text-orange-100/60">实际保存：{formatSize(bytes)}（{bytes.toLocaleString()} bytes）</span>
    </label>
  );
}