"use client";

import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import type { AdminQueryState, AdminTab } from "@/lib/admin-query-state";

export function AdminListToolbar({ tab, query, setQuery }: { tab: Extract<AdminTab, "reports" | "users" | "emails">; query: AdminQueryState; setQuery: (patch: Record<string, string | number | null>) => void }) {
  const [draft, setDraft] = useState(query.q);
  useEffect(() => setDraft(query.q), [query.q]);
  const apply = () => setQuery({ q: draft.trim() || null, page: null });
  const submit = (event: React.FormEvent) => { event.preventDefault(); apply(); };
  return (
    <div className="retro-panel mb-4 grid gap-2 p-3 sm:grid-cols-[minmax(220px,1fr)_auto_auto]">
      <form onSubmit={submit} className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 retro-muted" /><input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={`搜索${tab === "reports" ? "举报" : tab === "users" ? "用户" : "邮件"}`} placeholder={tab === "reports" ? "分享码、原因或补充说明" : tab === "users" ? "邮箱或 IP" : "收件人、分享码或错误"} className="retro-input w-full pl-9 pr-3 type-body-sm" /></form>
      <select value={query.status} onChange={(event) => setQuery({ status: event.target.value, page: null })} aria-label="筛选状态" className="retro-input px-3 type-body-sm">
        {tab !== "reports" && <option value="all">全部状态</option>}
        {tab === "reports" && <><option value="pending">待处理</option><option value="resolved">已处理</option><option value="dismissed">已驳回</option><option value="all">全部状态</option></>}
        {tab === "users" && <><option value="active">正常</option><option value="disabled">已禁用</option><option value="deleted">已删除</option><option value="verified">已验证</option><option value="unverified">未验证</option></>}
        {tab === "emails" && <><option value="pending">待发送</option><option value="sent">已发送</option><option value="failed">失败</option></>}
      </select>
      {tab === "users" ? <select value={query.sort} onChange={(event) => setQuery({ sort: event.target.value === "created_desc" ? null : event.target.value, page: null })} aria-label="用户排序" className="retro-input px-3 type-body-sm"><option value="created_desc">注册时间 ↓</option><option value="created_asc">注册时间 ↑</option><option value="email_asc">邮箱 A-Z</option><option value="email_desc">邮箱 Z-A</option><option value="last_login_desc">最近登录 ↓</option><option value="last_login_asc">最近登录 ↑</option></select> : <button type="button" onClick={apply} className="retro-btn-secondary px-4 type-caption">应用筛选</button>}
    </div>
  );
}
