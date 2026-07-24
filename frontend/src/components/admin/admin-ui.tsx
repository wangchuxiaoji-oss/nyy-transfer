"use client";

import { AlertCircle, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";

export const ADMIN_ACTION_BASE = "retro-action-button min-h-[44px] disabled:pointer-events-none";
export const ADMIN_ACTION_MUTED = `${ADMIN_ACTION_BASE} retro-action-muted`;
export const ADMIN_ACTION_DANGER = `${ADMIN_ACTION_BASE} retro-action-danger`;
export const ADMIN_ACTION_SUCCESS = `${ADMIN_ACTION_BASE} retro-action-success`;
export const ADMIN_ACTION_WARNING = `${ADMIN_ACTION_BASE} retro-action-warning`;
export const ADMIN_ACTION_PRIMARY = `${ADMIN_ACTION_BASE} retro-action-primary`;
export const ADMIN_CODE_CLASS = "font-mono admin-code";

export const ADMIN_BADGE_DANGER = "bg-red-100 text-red-700 ring-1 ring-red-200 dark:bg-red-500/20 dark:text-red-200 dark:ring-transparent";
export const ADMIN_BADGE_SUCCESS = "bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200 dark:bg-green-500/20 dark:text-green-200 dark:ring-transparent";
export const ADMIN_BADGE_WARNING = "bg-amber-100 text-amber-800 ring-1 ring-amber-200 dark:bg-yellow-500/20 dark:text-yellow-200 dark:ring-transparent";
export const ADMIN_BADGE_ORANGE = "bg-orange-100 text-orange-800 ring-1 ring-orange-200 dark:bg-orange-500/10 dark:text-orange-200 dark:ring-transparent";
export const ADMIN_BADGE_PURPLE = "bg-purple-100 text-purple-700 ring-1 ring-purple-200 dark:bg-purple-500/20 dark:text-purple-200 dark:ring-transparent";
export const ADMIN_BADGE_MUTED = "bg-stone-100 text-stone-700 ring-1 ring-stone-200 dark:bg-white/10 dark:text-white/70 dark:ring-transparent";

export function formatAdminDate(value?: string | null, includeSeconds = false): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
  });
}

export function formatRelativeTime(value?: string | null): string {
  if (!value) return "未记录";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "时间未知";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function AdminLoading({ label = "正在加载当前模块" }: { label?: string }) {
  return (
    <div className="retro-panel flex min-h-48 items-center justify-center gap-3 p-6 retro-muted" role="status">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="type-body-sm">{label}...</span>
    </div>
  );
}

export function AdminSectionError({ title = "当前模块加载失败", message, onRetry }: { title?: string; message: string; onRetry: () => void }) {
  return (
    <div className="retro-panel border-red-300/45 p-6" role="alert">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1">
          <h2 className="type-body-sm font-semibold retro-text">{title}</h2>
          <p className="mt-1 break-words type-caption retro-muted">{message}</p>
        </div>
        <button type="button" onClick={onRetry} className="retro-btn-secondary shrink-0 px-3 type-caption">
          <RefreshCw className="h-4 w-4" />重试
        </button>
      </div>
    </div>
  );
}

interface AdminListPagerProps {
  mode: "cursor" | "page";
  page: number;
  pageSize: number;
  loaded: number;
  total?: number | null;
  totalEstimated?: boolean;
  hasMore?: boolean;
  nextCursor?: string | null;
  onPage: (page: number) => void;
  onCursor: (cursor: string | null) => void;
}

export function AdminListPager({ mode, page, pageSize, loaded, total, totalEstimated, hasMore, nextCursor, onPage, onCursor }: AdminListPagerProps) {
  if (mode === "cursor") {
    return (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-black/8 pt-4 dark:border-white/10">
        <p className="type-caption retro-muted">已加载 {loaded} 条{hasMore ? "，仍有更多" : ""}</p>
        <div className="flex gap-2">
          <button type="button" onClick={() => onCursor(null)} disabled={page <= 1} className="retro-btn-secondary px-3 type-caption"><ChevronLeft className="h-4 w-4" />第一批</button>
          <button type="button" onClick={() => nextCursor && onCursor(nextCursor)} disabled={!hasMore || !nextCursor} className="retro-btn-secondary px-3 type-caption">继续加载<ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
    );
  }

  const safeTotal = total || 0;
  const totalPages = Math.max(1, Math.ceil(safeTotal / pageSize));
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-black/8 pt-4 dark:border-white/10">
      <p className="type-caption retro-muted">第 {page} / {totalPages} 页，共 {totalEstimated ? "约 " : ""}{safeTotal} 条</p>
      <div className="flex gap-2">
        <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} className="retro-btn-secondary px-3 type-caption"><ChevronLeft className="h-4 w-4" />上一页</button>
        <button type="button" onClick={() => onPage(page + 1)} disabled={page >= totalPages} className="retro-btn-secondary px-3 type-caption">下一页<ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
