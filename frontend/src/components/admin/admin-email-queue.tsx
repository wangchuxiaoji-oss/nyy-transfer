"use client";

import { RefreshCw } from "lucide-react";
import type { AdminEmailItem } from "@/lib/admin";
import { AdminListPager, ADMIN_ACTION_WARNING, ADMIN_BADGE_DANGER, ADMIN_BADGE_SUCCESS, ADMIN_BADGE_WARNING, ADMIN_CODE_CLASS, formatAdminDate } from "./admin-ui";

interface AdminEmailQueueProps {
  emails: AdminEmailItem[];
  total: number;
  page: number;
  pendingIds: Set<string>;
  onRetry: (email: AdminEmailItem) => void;
  onPage: (page: number) => void;
}

export function adminEmailKey(email: AdminEmailItem): string {
  return email.id || email.delivery_id || `${email.share_code}:${email.recipient}:${email.created_at}`;
}

function statusMeta(status: string) {
  if (status === "sent") return { label: "已发送", className: ADMIN_BADGE_SUCCESS };
  if (status === "failed") return { label: "失败", className: ADMIN_BADGE_DANGER };
  return { label: "待发送", className: ADMIN_BADGE_WARNING };
}

export function AdminEmailQueue({ emails, total, page, pendingIds, onRetry, onPage }: AdminEmailQueueProps) {
  if (emails.length === 0) return <div className="retro-panel py-16 text-center type-body-sm retro-muted">当前队列没有邮件</div>;
  return (
    <section className="retro-panel overflow-hidden" data-testid="admin-email-queue">
      <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[900px] type-caption"><thead><tr className="border-b border-black/8 text-left retro-muted dark:border-white/10"><th className="px-4 py-3">投递 / 收件人</th><th className="px-3 py-3">类型 / 分享</th><th className="px-3 py-3">状态 / 尝试</th><th className="px-3 py-3">错误摘要</th><th className="px-3 py-3">首次 / 最后尝试</th><th className="px-4 py-3">操作</th></tr></thead><tbody>{emails.map((email) => { const key = adminEmailKey(email); const meta = statusMeta(email.status); const pending = pendingIds.has(key); return <tr key={key} className="border-b border-black/8 dark:border-white/10"><td className="max-w-[260px] px-4 py-3"><p className="truncate type-body-sm font-semibold retro-text" title={email.recipient}>{email.recipient}</p><p className="mt-1 font-mono retro-muted">{email.delivery_id || email.id || "旧投递记录"}</p></td><td className="px-3 py-3"><p className="retro-text">{email.email_type || email.delivery_type || "分享通知"}</p><p className={`${ADMIN_CODE_CLASS} mt-1`}>/{email.share_code}</p></td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[10px] ${meta.className}`}>{meta.label}</span><p className="mt-2 retro-muted">{email.attempt_count || email.attempt_number || 1} 次</p></td><td className="max-w-[260px] px-3 py-3"><p className="line-clamp-2 text-red-700 dark:text-red-200" title={email.error || undefined}>{email.error || "无错误"}</p></td><td className="whitespace-nowrap px-3 py-3 retro-muted"><p>{formatAdminDate(email.created_at)}</p><p className="mt-1">{formatAdminDate(email.last_attempt_at || email.sent_at)}</p></td><td className="px-4 py-3">{email.status === "failed" ? <button type="button" disabled={pending} onClick={() => onRetry(email)} className={ADMIN_ACTION_WARNING}><RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />{pending ? "提交中" : "重试"}</button> : <span className="inline-flex min-h-[44px] items-center retro-muted">无需操作</span>}</td></tr>; })}</tbody></table></div>
      <div className="space-y-3 p-3 md:hidden">{emails.map((email) => { const key = adminEmailKey(email); const meta = statusMeta(email.status); const pending = pendingIds.has(key); return <article key={key} className="retro-card p-4"><div className="flex items-start justify-between gap-2"><h3 className="min-w-0 break-all type-body-sm font-semibold retro-text">{email.recipient}</h3><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${meta.className}`}>{meta.label}</span></div><p className="mt-2 type-caption retro-muted">/{email.share_code} · 尝试 {email.attempt_count || email.attempt_number || 1} 次</p>{email.error && <p className="mt-2 type-caption text-red-700 dark:text-red-200">{email.error}</p>}{email.status === "failed" && <button type="button" disabled={pending} onClick={() => onRetry(email)} className={`${ADMIN_ACTION_WARNING} mt-3 w-full`}><RefreshCw className={`h-3.5 w-3.5 ${pending ? "animate-spin" : ""}`} />{pending ? "提交中" : "重试失败邮件"}</button>}</article>; })}</div>
      <div className="px-4 pb-4"><AdminListPager mode="page" page={page} pageSize={20} loaded={emails.length} total={total} onPage={onPage} onCursor={() => {}} /></div>
    </section>
  );
}
