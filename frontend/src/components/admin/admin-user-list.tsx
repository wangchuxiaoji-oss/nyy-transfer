"use client";

import { Network } from "lucide-react";
import type { AdminUserItem, AdminUserPatch } from "@/lib/admin";
import { formatIpLocation } from "@/components/admin-ip-sources-drawer";
import { AdminListPager, ADMIN_ACTION_DANGER, ADMIN_ACTION_MUTED, ADMIN_ACTION_PRIMARY, ADMIN_ACTION_SUCCESS, ADMIN_ACTION_WARNING, ADMIN_BADGE_DANGER, ADMIN_BADGE_SUCCESS, ADMIN_BADGE_WARNING, formatAdminDate } from "./admin-ui";

export type UserConfirmAction = "disable" | "enable" | "delete" | "restore" | "reset";

interface AdminUserListProps {
  users: AdminUserItem[];
  total: number;
  page: number;
  pendingIds: Set<string>;
  onUpdate: (user: AdminUserItem, patch: AdminUserPatch, message: string) => void;
  onConfirm: (user: AdminUserItem, action: UserConfirmAction) => void;
  onSource: (user: AdminUserItem) => void;
  onPage: (page: number) => void;
}

function userStatus(user: AdminUserItem) {
  if (user.deleted) return { label: "已删除", className: ADMIN_BADGE_DANGER };
  if (user.disabled) return { label: "已禁用", className: ADMIN_BADGE_WARNING };
  return { label: "正常", className: ADMIN_BADGE_SUCCESS };
}

export function AdminUserList({ users, total, page, pendingIds, onUpdate, onConfirm, onSource, onPage }: AdminUserListProps) {
  if (users.length === 0) return <div className="retro-panel py-16 text-center type-body-sm retro-muted">当前条件下没有用户</div>;
  const actions = (user: AdminUserItem) => {
    if (user.is_admin) return <span className="inline-flex min-h-[44px] items-center type-caption retro-muted">管理员受保护</span>;
    const pending = pendingIds.has(user.id);
    if (user.deleted) return <button type="button" disabled={pending} onClick={() => onConfirm(user, "restore")} className={ADMIN_ACTION_SUCCESS}>{pending ? "处理中" : "恢复"}</button>;
    return <div className="flex flex-wrap gap-2"><button type="button" disabled={pending} onClick={() => onConfirm(user, user.disabled ? "enable" : "disable")} className={user.disabled ? ADMIN_ACTION_SUCCESS : ADMIN_ACTION_WARNING}>{pending ? "处理中" : user.disabled ? "启用" : "禁用"}</button><button type="button" disabled={pending} onClick={() => onUpdate(user, { email_verified: !user.email_verified }, user.email_verified ? "已取消邮箱验证" : "已标记邮箱验证")} className={ADMIN_ACTION_MUTED}>{user.email_verified ? "取消验证" : "设为验证"}</button><button type="button" disabled={pending} onClick={() => onConfirm(user, "reset")} className={ADMIN_ACTION_PRIMARY}>重置邮件</button><button type="button" disabled={pending} onClick={() => onConfirm(user, "delete")} className={ADMIN_ACTION_DANGER}>删除</button></div>;
  };
  return (
    <section className="retro-panel overflow-hidden" data-testid="admin-user-list">
      <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[1080px] type-caption"><thead><tr className="border-b border-black/8 text-left retro-muted dark:border-white/10"><th className="px-4 py-3">邮箱</th><th className="px-3 py-3">计划</th><th className="px-3 py-3">状态</th><th className="px-3 py-3">注册</th><th className="px-3 py-3">最近登录 / 来源</th><th className="px-4 py-3">操作</th></tr></thead><tbody>{users.map((user) => { const status = userStatus(user); return <tr key={user.id} className="border-b border-black/8 dark:border-white/10"><td className="max-w-[260px] px-4 py-3"><p className="truncate type-body-sm font-semibold retro-text" title={user.email}>{user.email}</p><p className="mt-1 retro-muted">{user.is_admin ? "管理员" : user.email_verified ? "邮箱已验证" : "邮箱未验证"}</p></td><td className="px-3 py-3">{user.is_admin ? <span className="retro-muted">管理员</span> : <select value={user.plan === "pro" ? "pro" : "free"} disabled={pendingIds.has(user.id) || user.deleted} onChange={(event) => onUpdate(user, { plan: event.target.value as "free" | "pro" }, "计划已更新")} aria-label={`修改 ${user.email} 的用户计划`} className="retro-input px-2 type-caption"><option value="free">免费</option><option value="pro">Pro</option></select>}</td><td className="px-3 py-3"><span className={`rounded-full px-2 py-1 text-[10px] ${status.className}`}>{status.label}</span></td><td className="whitespace-nowrap px-3 py-3 retro-muted">{formatAdminDate(user.created_at)}</td><td className="max-w-[260px] px-3 py-3"><button type="button" onClick={() => onSource(user)} className="flex min-h-[44px] max-w-full items-center gap-2 text-left"><Network className="h-4 w-4 shrink-0 text-orange-500" /><span className="min-w-0"><span className="block truncate retro-text">{user.last_login_at ? formatAdminDate(user.last_login_at) : "尚未登录"}</span><span className="mt-1 block truncate font-mono admin-code">{user.last_login_source?.ip || user.registration_source?.ip || "IP 未记录"} · {formatIpLocation(user.last_login_source || user.registration_source)}</span></span></button></td><td className="px-4 py-3">{actions(user)}</td></tr>; })}</tbody></table></div>
      <div className="space-y-3 p-3 md:hidden">{users.map((user) => { const status = userStatus(user); return <article key={user.id} className="retro-card p-4"><div className="flex items-start justify-between gap-3"><h3 className="min-w-0 break-all type-body-sm font-semibold retro-text">{user.email}</h3><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${status.className}`}>{status.label}</span></div><button type="button" onClick={() => onSource(user)} className="mt-2 flex min-h-[44px] w-full items-center gap-2 text-left type-caption retro-muted"><Network className="h-4 w-4 text-orange-500" /><span className="truncate">{user.last_login_source?.ip || user.registration_source?.ip || "查看注册与登录来源"}</span></button><div className="mt-3">{actions(user)}</div></article>; })}</div>
      <div className="px-4 pb-4"><AdminListPager mode="page" page={page} pageSize={20} loaded={users.length} total={total} onPage={onPage} onCursor={() => {}} /></div>
    </section>
  );
}
