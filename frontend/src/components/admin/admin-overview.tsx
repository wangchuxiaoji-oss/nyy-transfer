"use client";

import { AlertTriangle, Bot, ChevronRight, Eye, HardDrive, Link2, MailWarning, MousePointer2, Share2, ShieldAlert, Users } from "lucide-react";
import type { AdminDashboard } from "@/lib/admin";
import type { AdminTab } from "@/lib/admin-query-state";
import { formatSize } from "@/lib/utils";

interface AdminOverviewProps {
  dashboard: AdminDashboard;
  onNavigate: (tab: AdminTab, status?: string) => void;
}

export function AdminOverview({ dashboard, onNavigate }: AdminOverviewProps) {
  const tasks = [
    { label: "待处理举报", value: dashboard.tasks.reports_pending, Icon: AlertTriangle, tab: "reports" as const, status: "pending", tone: "text-amber-700 bg-amber-100 dark:text-amber-200 dark:bg-amber-500/15" },
    { label: "异常访问", value: dashboard.tasks.suspicious_access, Icon: ShieldAlert, tab: "shares" as const, status: "", tone: "text-red-700 bg-red-100 dark:text-red-200 dark:bg-red-500/15" },
    { label: "失败邮件", value: dashboard.tasks.emails_failed, Icon: MailWarning, tab: "emails" as const, status: "failed", tone: "text-red-700 bg-red-100 dark:text-red-200 dark:bg-red-500/15" },
    { label: "豆包失效", value: dashboard.tasks.doubao_unavailable, Icon: Bot, tab: "doubao" as const, status: "", tone: "text-violet-700 bg-violet-100 dark:text-violet-200 dark:bg-violet-500/15" },
  ];
  const trends = [
    { label: "新增分享", value: dashboard.today.shares_created, Icon: Share2 },
    { label: "取链次数", value: dashboard.today.links_issued, Icon: Link2 },
    { label: "真人互动", value: dashboard.today.human_interactions, Icon: MousePointer2 },
    { label: "预解析", value: dashboard.today.preview_fetches, Icon: Eye },
    { label: "上传字节", value: formatSize(dashboard.today.uploaded_bytes), Icon: HardDrive },
  ];

  return (
    <div className="space-y-6" data-testid="admin-overview">
      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div><p className="retro-kicker">优先队列</p><h2 className="retro-title mt-1 text-xl">现在需要处理</h2></div>
          <span className="type-caption retro-muted">点击进入已带筛选的模块</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {tasks.map(({ label, value, Icon, tab, status, tone }) => (
            <button key={label} type="button" onClick={() => onNavigate(tab, status)} className="retro-card group flex min-h-28 items-center gap-4 p-4 text-left">
              <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tone}`}><Icon className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1"><span className="block type-caption retro-muted">{label}</span><strong className="mt-1 block text-2xl tabular-nums retro-text">{value}</strong></span>
              <ChevronRight className="h-4 w-4 shrink-0 retro-muted transition-transform group-hover:translate-x-1" />
            </button>
          ))}
        </div>
      </section>

      <section className="retro-panel p-5">
        <div><p className="retro-kicker">今日趋势</p><h2 className="retro-title mt-1 text-lg">运营信号</h2></div>
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-black/8 bg-black/8 dark:border-white/10 dark:bg-white/10 sm:grid-cols-3 xl:grid-cols-5">
          {trends.map(({ label, value, Icon }) => (
            <div key={label} className="bg-white/80 p-4 dark:bg-[#160d25]/85">
              <div className="flex items-center gap-2 type-caption retro-muted"><Icon className="h-4 w-4 text-orange-500" />{label}</div>
              <p className="mt-2 text-lg font-bold tabular-nums retro-text">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <details className="retro-panel group p-5">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3">
          <div><p className="retro-kicker">累计数据</p><h2 className="retro-title mt-1 text-lg">全局规模</h2></div>
          <ChevronRight className="h-5 w-5 retro-muted transition-transform group-open:rotate-90" />
        </summary>
        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="累计用户" value={dashboard.totals.users_total} Icon={Users} />
          <Metric label="累计分享" value={dashboard.totals.shares_total} Icon={Share2} />
          <Metric label="累计创建字节" value={formatSize(dashboard.totals.uploaded_bytes_total)} Icon={HardDrive} />
          <Metric label="封禁总数" value={dashboard.totals.shares_banned} Icon={ShieldAlert} />
        </div>
      </details>
    </div>
  );
}

function Metric({ label, value, Icon }: { label: string; value: string | number; Icon: typeof Users }) {
  return <div className="rounded-xl border border-black/8 bg-white/50 p-4 dark:border-white/10 dark:bg-white/[0.035]"><Icon className="h-4 w-4 text-orange-500" /><p className="mt-3 type-caption retro-muted">{label}</p><p className="mt-1 text-lg font-bold retro-text">{value}</p></div>;
}
