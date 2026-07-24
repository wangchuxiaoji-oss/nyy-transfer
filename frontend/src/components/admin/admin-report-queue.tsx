"use client";

import { ExternalLink, Network, ShieldOff } from "lucide-react";
import type { AdminReportItem } from "@/lib/admin";
import { AdminListPager, ADMIN_ACTION_DANGER, ADMIN_ACTION_MUTED, ADMIN_ACTION_SUCCESS, ADMIN_ACTION_WARNING, ADMIN_BADGE_MUTED, ADMIN_BADGE_SUCCESS, ADMIN_BADGE_WARNING, ADMIN_CODE_CLASS, formatAdminDate } from "./admin-ui";

interface AdminReportQueueProps {
  reports: AdminReportItem[];
  total: number;
  page: number;
  pendingIds: Set<string>;
  onStatus: (report: AdminReportItem, status: "pending" | "resolved" | "dismissed") => void;
  onBan: (report: AdminReportItem) => void;
  onSource: (report: AdminReportItem) => void;
  onPage: (page: number) => void;
}

function statusMeta(status: string) {
  if (status === "pending") return { label: "待处理", className: ADMIN_BADGE_WARNING };
  if (status === "dismissed") return { label: "已驳回", className: ADMIN_BADGE_MUTED };
  return { label: "已处理", className: ADMIN_BADGE_SUCCESS };
}

export function AdminReportQueue({ reports, total, page, pendingIds, onStatus, onBan, onSource, onPage }: AdminReportQueueProps) {
  if (reports.length === 0) return <div className="retro-panel py-16 text-center type-body-sm retro-muted">当前队列没有举报</div>;
  const actions = (report: AdminReportItem) => {
    const pending = pendingIds.has(report.id);
    if (report.status !== "pending") return <button type="button" disabled={pending} onClick={() => onStatus(report, "pending")} className={ADMIN_ACTION_WARNING}>{pending ? "处理中" : "重新打开"}</button>;
    return <div className="flex flex-wrap gap-2"><button type="button" disabled={pending} onClick={() => onStatus(report, "resolved")} className={ADMIN_ACTION_SUCCESS}>{pending ? "处理中" : "标记处理"}</button><button type="button" disabled={pending} onClick={() => onStatus(report, "dismissed")} className={ADMIN_ACTION_MUTED}>驳回</button><button type="button" disabled={pending} onClick={() => onBan(report)} className={ADMIN_ACTION_DANGER}><ShieldOff className="h-3.5 w-3.5" />封禁并处理</button></div>;
  };
  return (
    <section className="retro-panel overflow-hidden" data-testid="admin-report-queue">
      <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[960px] type-caption"><thead><tr className="border-b border-black/8 text-left retro-muted dark:border-white/10"><th className="px-4 py-3">分享</th><th className="px-3 py-3">举报原因</th><th className="px-3 py-3">来源 / 数量</th><th className="px-3 py-3">时间</th><th className="px-3 py-3">状态</th><th className="px-4 py-3">处理</th></tr></thead>
        <tbody>{reports.map((report) => { const meta = statusMeta(report.status); return <tr key={report.id} className="border-b border-black/8 align-top dark:border-white/10"><td className="px-4 py-3"><a href={`/admin/preview/${report.share_code}`} target="_blank" rel="noopener noreferrer" className={`${ADMIN_CODE_CLASS} inline-flex min-h-[44px] items-center gap-1 font-semibold`}><ExternalLink className="h-3.5 w-3.5" />/{report.share_code}</a><p className="max-w-[180px] truncate retro-muted">{report.share_title || report.share_status || "打开预览核查"}</p></td><td className="max-w-[320px] px-3 py-3"><p className="font-semibold retro-text">{report.reason}</p><p className="mt-1 line-clamp-2 retro-muted" title={report.detail || undefined}>{report.detail || "无补充说明"}</p></td><td className="px-3 py-3"><button type="button" onClick={() => onSource(report)} className="inline-flex min-h-[44px] items-center gap-2 text-left"><Network className="h-4 w-4 text-orange-500" /><span><span className="block font-mono admin-code">{report.source?.ip || "查看来源"}</span><span className="block retro-muted">累计 {report.report_count || 1} 次</span></span></button></td><td className="whitespace-nowrap px-3 py-3 retro-muted">{formatAdminDate(report.created_at)}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[10px] ${meta.className}`}>{meta.label}</span></td><td className="px-4 py-3">{actions(report)}</td></tr>; })}</tbody>
      </table></div>
      <div className="space-y-3 p-3 md:hidden">{reports.map((report) => { const meta = statusMeta(report.status); return <article key={report.id} className="retro-card p-4"><div className="flex items-center justify-between gap-2"><a href={`/admin/preview/${report.share_code}`} target="_blank" rel="noopener noreferrer" className={`${ADMIN_CODE_CLASS} inline-flex min-h-[44px] items-center gap-1 font-semibold`}><ExternalLink className="h-3.5 w-3.5" />/{report.share_code}</a><span className={`rounded-full px-2 py-1 text-[10px] ${meta.className}`}>{meta.label}</span></div><h3 className="mt-2 type-body-sm font-semibold retro-text">{report.reason}</h3>{report.detail && <p className="mt-1 type-caption retro-muted">{report.detail}</p>}<div className="mt-3">{actions(report)}</div></article>; })}</div>
      <div className="px-4 pb-4"><AdminListPager mode="page" page={page} pageSize={20} loaded={reports.length} total={total} onPage={onPage} onCursor={() => {}} /></div>
    </section>
  );
}
