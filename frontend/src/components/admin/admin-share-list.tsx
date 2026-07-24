"use client";

import { Eye } from "lucide-react";
import type { AdminShareItem } from "@/lib/admin";
import { formatSize } from "@/lib/utils";
import { formatIpLocation } from "@/components/admin-ip-sources-drawer";
import { AdminListPager, ADMIN_ACTION_DANGER, ADMIN_ACTION_PRIMARY, ADMIN_BADGE_DANGER, ADMIN_BADGE_ORANGE, ADMIN_BADGE_PURPLE, ADMIN_BADGE_SUCCESS, ADMIN_CODE_CLASS, formatAdminDate } from "./admin-ui";
import { AdminShareDrawer } from "./admin-share-drawer";
import { useState } from "react";

interface AdminShareListProps {
  shares: AdminShareItem[];
  pagination: { mode: "cursor" | "page"; page: number; pageSize: number; total?: number | null; totalEstimated?: boolean; hasMore?: boolean; nextCursor?: string | null };
  pendingCodes: Set<string>;
  onBan: (share: AdminShareItem) => void;
  onSource: (share: AdminShareItem) => void;
  onPage: (page: number) => void;
  onCursor: (cursor: string | null) => void;
}

export function getAdminShareStatus(share: AdminShareItem): { key: string; label: string; className: string } {
  if (share.banned) return { key: "banned", label: "封禁", className: ADMIN_BADGE_DANGER };
  if (share.revoked) return { key: "revoked", label: "撤销", className: ADMIN_BADGE_ORANGE };
  if (share.expires_at && new Date(share.expires_at) <= new Date()) return { key: "expired", label: "过期", className: ADMIN_BADGE_ORANGE };
  if (share.max_downloads > 0 && share.download_count >= share.max_downloads) return { key: "download_exhausted", label: "耗尽", className: ADMIN_BADGE_PURPLE };
  return { key: "active", label: "有效", className: ADMIN_BADGE_SUCCESS };
}

export function AdminShareList({ shares, pagination, pendingCodes, onBan, onSource, onPage, onCursor }: AdminShareListProps) {
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const selectedShare = shares.find((share) => share.code === selectedCode) || null;

  if (shares.length === 0) return <div className="retro-panel py-16 text-center type-body-sm retro-muted">当前条件下没有分享</div>;
  return (
    <>
      <section className="retro-panel overflow-hidden" data-testid="admin-share-list">
        <div className="hidden max-h-[calc(100dvh-250px)] overflow-auto md:block" data-testid="admin-share-table">
          <table className="w-full min-w-[1180px] border-separate border-spacing-0 type-caption">
            <thead className="sticky top-0 z-10 bg-[#fffaf4]/95 text-left shadow-[0_1px_0_rgba(0,0,0,0.08)] backdrop-blur-xl dark:bg-[#130b22]/95 dark:shadow-[0_1px_0_rgba(255,255,255,0.1)]"><tr className="retro-muted">
              <th className="px-4 py-3">短码 / 标题</th><th className="px-3 py-3">身份 / 来源</th><th className="px-3 py-3">状态</th><th className="px-3 py-3">创建 / 到期</th><th className="px-3 py-3">文件 / 容量</th><th className="px-3 py-3">打开 / 真人 / 取链 / 预解析</th><th className="px-4 py-3 text-right">操作</th>
            </tr></thead>
            <tbody>{shares.map((share) => {
              const status = getAdminShareStatus(share);
              const humanCount = share.human_interaction_count ?? 0;
              const renderedCount = share.page_rendered_count ?? share.access_event_count ?? 0;
              const previewCount = share.preview_fetch_count ?? 0;
              return <tr key={share.code} className="h-[68px] border-b border-black/8 transition-colors hover:bg-orange-500/[0.045] dark:border-white/10">
                <td className="max-w-[220px] border-b border-black/8 px-4 py-2 dark:border-white/10"><button type="button" onClick={() => setSelectedCode(share.code)} className="block max-w-full text-left"><span className={`${ADMIN_CODE_CLASS} block text-xs font-semibold`}>/{share.code}</span><span className="mt-1 block truncate type-body-sm font-semibold retro-text" title={share.title || undefined}>{share.title || "未命名分享"}</span></button></td>
                <td className="max-w-[230px] border-b border-black/8 px-3 py-2 dark:border-white/10"><button type="button" onClick={() => onSource(share)} className="block max-w-full text-left"><span className="block truncate type-caption font-semibold retro-text">{share.owner_email || share.guest_label || "游客"}</span><span className="mt-1 block truncate font-mono text-[10px] admin-code">{share.source?.ip || "IP 未记录"} · {formatIpLocation(share.source)}</span></button></td>
                <td className="border-b border-black/8 px-3 py-2 dark:border-white/10"><span className={`rounded-full px-2 py-1 text-[10px] ${status.className}`}>{status.label}</span></td>
                <td className="whitespace-nowrap border-b border-black/8 px-3 py-2 dark:border-white/10"><span className="block retro-text">{formatAdminDate(share.created_at)}</span><span className="mt-1 block retro-muted">{share.expires_at ? formatAdminDate(share.expires_at) : "长期有效"}</span></td>
                <td className="whitespace-nowrap border-b border-black/8 px-3 py-2 dark:border-white/10"><span className="block retro-text">{share.file_count} 个文件</span><span className="mt-1 block retro-muted">{formatSize(share.total_bytes)}</span></td>
                <td className="whitespace-nowrap border-b border-black/8 px-3 py-2 tabular-nums dark:border-white/10"><span className="retro-text">{renderedCount} / {humanCount} / {share.download_count} / {previewCount}</span></td>
                <td className="border-b border-black/8 px-4 py-2 text-right dark:border-white/10"><div className="flex justify-end gap-2"><button type="button" onClick={() => setSelectedCode(share.code)} className={ADMIN_ACTION_PRIMARY}><Eye className="h-3.5 w-3.5" />详情</button><button type="button" disabled={pendingCodes.has(share.code)} onClick={() => onBan(share)} className={share.banned ? ADMIN_ACTION_PRIMARY : ADMIN_ACTION_DANGER}>{pendingCodes.has(share.code) ? "处理中" : share.banned ? "解封" : "封禁"}</button></div></td>
              </tr>;
            })}</tbody>
          </table>
        </div>

        <div className="divide-y divide-black/8 md:hidden dark:divide-white/10" data-testid="admin-share-mobile-list">
          {shares.map((share) => {
            const status = getAdminShareStatus(share);
            return <button key={share.code} type="button" onClick={() => setSelectedCode(share.code)} className="block min-h-[76px] w-full px-3 py-3 text-left transition-colors hover:bg-orange-500/[0.06]" aria-label={`查看分享 /${share.code} 详情`}>
              <span className="flex min-w-0 items-center gap-2"><span className={`${ADMIN_CODE_CLASS} shrink-0 text-xs font-semibold`}>/{share.code}</span><span className="min-w-0 flex-1 truncate type-body-sm font-semibold retro-text">{share.title || "未命名分享"}</span><span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${status.className}`}>{status.label}</span><span className="shrink-0 text-[10px] retro-muted">{formatAdminDate(share.created_at).slice(5, 16)}</span></span>
              <span className="mt-2 flex min-w-0 items-center gap-2 text-[11px] retro-muted"><span className="min-w-0 flex-1 truncate">{share.owner_email || share.guest_label || "游客"}</span><span className="shrink-0">{share.file_count} 件 · {formatSize(share.total_bytes)}</span><span className="shrink-0">真人 {share.human_interaction_count ?? 0} · 取链 {share.download_count}</span></span>
            </button>;
          })}
        </div>
        <div className="px-4 pb-4"><AdminListPager mode={pagination.mode} page={pagination.page} pageSize={pagination.pageSize} loaded={shares.length} total={pagination.total} totalEstimated={pagination.totalEstimated} hasMore={pagination.hasMore} nextCursor={pagination.nextCursor} onPage={onPage} onCursor={onCursor} /></div>
      </section>

      <AdminShareDrawer share={selectedShare} pending={selectedShare ? pendingCodes.has(selectedShare.code) : false} onClose={() => setSelectedCode(null)} onBan={onBan} onSource={(share) => { setSelectedCode(null); onSource(share); }} />
    </>
  );
}
