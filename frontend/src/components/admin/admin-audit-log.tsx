"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, ChevronRight, ClipboardList, RefreshCw } from "lucide-react";
import { getErrorMessage } from "@/lib/errors";
import {
  dryRunAdminArchive,
  getAdminArchivedShares,
  getAdminAuditLogs,
  type AdminArchiveDryRun,
  type AdminArchivedShare,
  type AdminAuditItem,
} from "@/lib/admin";
import { formatSize } from "@/lib/utils";
import { ADMIN_ACTION_PRIMARY, ADMIN_BADGE_DANGER, ADMIN_BADGE_SUCCESS, ADMIN_CODE_CLASS, formatAdminDate } from "./admin-ui";

export function AdminAuditLog() {
  const [items, setItems] = useState<AdminAuditItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (after?: string, append = false) => {
    setLoading(true);
    setError("");
    try {
      const result = await getAdminAuditLogs(after);
      setItems((current) => append ? [...current, ...(result.items || [])] : (result.items || []));
      setNextCursor(result.next_cursor || null);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "审计日志加载失败"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <details className="retro-panel group p-4 sm:p-5" data-testid="admin-audit-log">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3"><span className="flex items-center gap-3"><ClipboardList className="h-5 w-5 text-orange-500" /><span><span className="block type-body-sm font-semibold retro-text">管理员操作审计</span><span className="mt-1 block type-caption retro-muted">追加式记录，正文长期保留，IP / UA 180 天清空</span></span></span><ChevronRight className="h-5 w-5 retro-muted transition-transform group-open:rotate-90" /></summary>
      <div className="mt-5">
        {error ? <div role="alert" className="rounded-xl bg-red-500/10 p-3 type-body-sm text-red-700 dark:text-red-200">{error}<button type="button" onClick={() => void load()} className="ml-3 underline">重试</button></div> : null}
        {!error && items.length === 0 && !loading ? <p className="py-8 text-center type-body-sm retro-muted">暂无管理员操作记录</p> : null}
        {items.length > 0 ? <div className="overflow-x-auto"><table className="w-full min-w-[860px] type-caption"><thead><tr className="border-b border-black/8 text-left retro-muted dark:border-white/10"><th className="px-3 py-2">时间 / 管理员</th><th className="px-3 py-2">动作</th><th className="px-3 py-2">目标</th><th className="px-3 py-2">原因 / 结果</th><th className="px-3 py-2">请求</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} className="border-b border-black/8 align-top dark:border-white/10"><td className="px-3 py-3"><p className="retro-text">{formatAdminDate(item.created_at)}</p><p className="mt-1 retro-muted">{item.actor_email || "系统"}</p></td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[10px] ${item.success ? ADMIN_BADGE_SUCCESS : ADMIN_BADGE_DANGER}`}>{item.action}</span></td><td className="px-3 py-3"><p className={ADMIN_CODE_CLASS}>{item.target_type || "-"}:{item.target_id || "-"}</p><p className="mt-1 retro-muted">批次 {item.batch_id || "-"}</p></td><td className="max-w-[300px] px-3 py-3"><p className="retro-text">{item.reason || item.note || (item.success ? "执行成功" : "执行失败")}</p>{item.error_summary ? <p className="mt-1 text-red-700 dark:text-red-200">{item.error_summary}</p> : null}</td><td className="max-w-[230px] px-3 py-3"><p className="truncate font-mono retro-muted" title={item.request_id || undefined}>{item.request_id || "-"}</p><p className="mt-1 font-mono retro-muted">{item.ip || "IP 已清理"}</p></td></tr>)}</tbody></table></div> : null}
        <div className="mt-3 flex justify-end">{nextCursor ? <button type="button" disabled={loading} onClick={() => void load(nextCursor, true)} className={ADMIN_ACTION_PRIMARY}><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />加载更多</button> : loading ? <span className="type-caption retro-muted">加载中...</span> : null}</div>
      </div>
    </details>
  );
}

export function AdminArchivePanel() {
  const [items, setItems] = useState<AdminArchivedShare[]>([]);
  const [dryRun, setDryRun] = useState<AdminArchiveDryRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadArchived = useCallback(async () => {
    try {
      const result = await getAdminArchivedShares();
      setItems(result.items || []);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "历史归档加载失败"));
    }
  }, []);
  useEffect(() => { void loadArchived(); }, [loadArchived]);

  const previewArchive = async () => {
    setLoading(true);
    setError("");
    try {
      setDryRun(await dryRunAdminArchive());
    } catch (loadError) {
      setError(getErrorMessage(loadError, "归档预检失败"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <details className="retro-panel group p-4 sm:p-5" data-testid="admin-archive-panel">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3"><span className="flex items-center gap-3"><Archive className="h-5 w-5 text-violet-500" /><span><span className="block type-body-sm font-semibold retro-text">历史归档</span><span className="mt-1 block type-caption retro-muted">终态分享只读查询；后台仅提供安全 dry-run</span></span></span><ChevronRight className="h-5 w-5 retro-muted transition-transform group-open:rotate-90" /></summary>
      <div className="mt-5 space-y-4">
        <div className="flex flex-wrap items-center gap-3"><button type="button" disabled={loading} onClick={() => void previewArchive()} className={ADMIN_ACTION_PRIMARY}><RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />运行归档预检</button>{dryRun ? <span className="type-body-sm retro-text">候选 {dryRun.candidate_count} 条 · 截止 {formatAdminDate(dryRun.cutoff)}</span> : null}</div>
        {error ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 type-body-sm text-red-700 dark:text-red-200">{error}</p> : null}
        {items.length === 0 ? <p className="py-5 text-center type-body-sm retro-muted">暂无历史归档</p> : <div className="grid gap-2 sm:grid-cols-2">{items.map((item) => <article key={item.id} className="retro-card p-3"><div className="flex items-center justify-between gap-2"><p className={`${ADMIN_CODE_CLASS} truncate`}>/{item.code}</p><span className="rounded-full bg-violet-500/10 px-2 py-1 text-[10px] text-violet-700 dark:text-violet-200">{item.terminal_status}</span></div><p className="mt-2 truncate type-body-sm font-semibold retro-text">{item.title || "未命名分享"}</p><p className="mt-1 type-caption retro-muted">{item.logical_file_count} 件 · {formatSize(item.total_bytes)} · 归档于 {formatAdminDate(item.archived_at)}</p></article>)}</div>}
      </div>
    </details>
  );
}
