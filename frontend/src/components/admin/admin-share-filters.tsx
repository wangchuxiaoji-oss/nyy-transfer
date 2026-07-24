"use client";

import { useEffect, useState } from "react";
import { Filter, Search, X } from "lucide-react";
import type { AdminQueryState } from "@/lib/admin-query-state";
import { hasPreciseShareFilters } from "@/lib/admin-query-state";

interface AdminShareFiltersProps {
  query: AdminQueryState;
  setQuery: (patch: Record<string, string | number | null>) => void;
}

const MB = 1024 * 1024;

export function AdminShareFilters({ query, setQuery }: AdminShareFiltersProps) {
  const [searchDraft, setSearchDraft] = useState(query.q);
  useEffect(() => setSearchDraft(query.q), [query.q]);
  const precise = hasPreciseShareFilters(query);

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setQuery({ q: searchDraft.trim() || null, page: null, after: null });
  };

  const clearExtended = () => setQuery({
    created_from: null,
    created_to: null,
    expires_from: null,
    expires_to: null,
    activity_from: null,
    activity_to: null,
    min_files: null,
    max_files: null,
    min_bytes: null,
    max_bytes: null,
    risk: null,
    page: null,
    after: null,
  });

  return (
    <div className="retro-panel p-3 sm:p-4" data-testid="admin-share-filters">
      <div className="grid gap-2 xl:grid-cols-[minmax(260px,1fr)_auto_auto_auto]">
        <form onSubmit={submitSearch} className="relative min-w-0">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 retro-muted" />
          <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} aria-label="搜索分享" placeholder="短码、标题、邮箱、游客标识或 IP" className="retro-input w-full pl-9 pr-3 type-body-sm" />
        </form>
        <select value={query.status} onChange={(event) => setQuery({ status: event.target.value, page: null, after: null })} aria-label="筛选分享状态" className="retro-input px-3 type-body-sm">
          <option value="all">全部状态</option><option value="active">有效</option><option value="download_exhausted">耗尽</option><option value="expired">过期</option><option value="revoked">撤销</option><option value="banned">封禁</option>
        </select>
        <select value={query.sort} onChange={(event) => setQuery({ sort: event.target.value === "created_desc" ? null : event.target.value, page: null, after: null })} aria-label="分享排序" className="retro-input px-3 type-body-sm">
          <option value="created_desc">创建时间 ↓</option><option value="created_asc">创建时间 ↑</option><option value="size_desc">容量 ↓</option><option value="downloads_desc">取链 ↓</option><option value="expires_asc">到期 ↑</option>
        </select>
        <select value={query.paginationMode} onChange={(event) => setQuery({ pagination_mode: event.target.value === "page" ? "page" : null, page: null, after: null })} aria-label="分页模式" className="retro-input px-3 type-body-sm">
          <option value="cursor">游标模式</option><option value="page" disabled={!precise}>精确页码{precise ? "" : "（需筛选）"}</option>
        </select>
      </div>

      <details className="group mt-2">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-1 type-caption font-semibold retro-text"><Filter className="h-4 w-4 text-orange-500" />日期、文件与风险筛选<span className="retro-muted">（契约兼容字段）</span></summary>
        <div className="mt-2 grid gap-3 border-t border-black/8 pt-3 dark:border-white/10 md:grid-cols-2 xl:grid-cols-4">
          <DateRange label="创建时间" from={query.createdFrom} to={query.createdTo} onChange={(from, to) => setQuery({ created_from: from || null, created_to: to || null, page: null, after: null })} />
          <DateRange label="到期时间" from={query.expiresFrom} to={query.expiresTo} onChange={(from, to) => setQuery({ expires_from: from || null, expires_to: to || null, page: null, after: null })} />
          <DateRange label="最近活动" from={query.activityFrom} to={query.activityTo} onChange={(from, to) => setQuery({ activity_from: from || null, activity_to: to || null, page: null, after: null })} />
          <label><span className="type-caption retro-muted">风险信号</span><select value={query.risk} onChange={(event) => setQuery({ risk: event.target.value, page: null, after: null })} className="retro-input mt-1 w-full px-3 type-body-sm"><option value="all">全部风险</option><option value="reported">有举报</option><option value="suspicious_ip">异常 IP</option><option value="preview_only">仅预解析</option><option value="human_link">真人取链</option><option value="no_access">无访问</option></select></label>
          <NumberRange label="文件数量" min={query.minFiles} max={query.maxFiles} onChange={(min, max) => setQuery({ min_files: min, max_files: max, page: null, after: null })} />
          <NumberRange label="容量（MB）" min={query.minBytes === null ? null : query.minBytes / MB} max={query.maxBytes === null ? null : query.maxBytes / MB} onChange={(min, max) => setQuery({ min_bytes: min === null ? null : Math.round(min * MB), max_bytes: max === null ? null : Math.round(max * MB), page: null, after: null })} />
          <div className="flex items-end md:col-span-2"><button type="button" onClick={clearExtended} className="retro-btn-secondary w-full px-3 type-caption md:w-auto"><X className="h-4 w-4" />清除扩展筛选</button></div>
        </div>
      </details>
    </div>
  );
}

function DateRange({ label, from, to, onChange }: { label: string; from: string; to: string; onChange: (from: string, to: string) => void }) {
  return <fieldset><legend className="type-caption retro-muted">{label}</legend><div className="mt-1 grid grid-cols-2 gap-2"><input type="date" value={from} onChange={(event) => onChange(event.target.value, to)} aria-label={`${label}开始`} className="retro-input min-w-0 px-2 type-caption" /><input type="date" value={to} onChange={(event) => onChange(from, event.target.value)} aria-label={`${label}结束`} className="retro-input min-w-0 px-2 type-caption" /></div></fieldset>;
}

function NumberRange({ label, min, max, onChange }: { label: string; min: number | null; max: number | null; onChange: (min: number | null, max: number | null) => void }) {
  const parse = (value: string) => value === "" ? null : Math.max(0, Number(value));
  return <fieldset><legend className="type-caption retro-muted">{label}</legend><div className="mt-1 grid grid-cols-2 gap-2"><input type="number" min={0} value={min ?? ""} onChange={(event) => onChange(parse(event.target.value), max)} placeholder="最小" aria-label={`${label}最小`} className="retro-input min-w-0 px-2 type-caption" /><input type="number" min={0} value={max ?? ""} onChange={(event) => onChange(min, parse(event.target.value))} placeholder="最大" aria-label={`${label}最大`} className="retro-input min-w-0 px-2 type-caption" /></div></fieldset>;
}
