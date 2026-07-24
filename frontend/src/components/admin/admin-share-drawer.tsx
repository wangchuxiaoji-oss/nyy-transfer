"use client";

import { ExternalLink, Network, ShieldOff } from "lucide-react";
import type { AdminShareItem } from "@/lib/admin";
import { formatSize } from "@/lib/utils";
import { AdminDrawer } from "./admin-drawer";
import { ADMIN_ACTION_DANGER, ADMIN_ACTION_PRIMARY, formatAdminDate } from "./admin-ui";
import { formatIpLocation } from "@/components/admin-ip-sources-drawer";

interface AdminShareDrawerProps {
  share: AdminShareItem | null;
  pending: boolean;
  onClose: () => void;
  onBan: (share: AdminShareItem) => void;
  onSource: (share: AdminShareItem) => void;
}

export function AdminShareDrawer({ share, pending, onClose, onBan, onSource }: AdminShareDrawerProps) {
  return (
    <AdminDrawer open={!!share} title={share ? `/${share.code}` : "分享详情"} eyebrow="分享详情" description="列表只读取摘要；完整文件内容在管理员预览中按需加载。" onClose={onClose} footer={share ? (
      <div className="grid grid-cols-2 gap-2">
        <a href={`/admin/preview/${share.code}`} target="_blank" rel="noopener noreferrer" className={`${ADMIN_ACTION_PRIMARY} w-full`}><ExternalLink className="h-4 w-4" />完整查看</a>
        <button type="button" disabled={pending} onClick={() => onBan(share)} className={`${share.banned ? ADMIN_ACTION_PRIMARY : ADMIN_ACTION_DANGER} w-full`}><ShieldOff className="h-4 w-4" />{pending ? "处理中..." : share.banned ? "解封" : "封禁"}</button>
      </div>
    ) : undefined}>
      {share && (
        <div className="space-y-5">
          <section className="retro-card p-4">
            <p className="retro-kicker">标题与身份</p>
            <h3 className="mt-2 break-words text-lg font-semibold retro-text">{share.title || "未命名分享"}</h3>
            <p className="mt-2 type-body-sm retro-muted">{share.owner_email || share.guest_label || "游客"}</p>
          </section>
          <dl className="grid grid-cols-2 gap-3">
            <Detail label="创建时间" value={formatAdminDate(share.created_at)} />
            <Detail label="到期时间" value={share.expires_at ? formatAdminDate(share.expires_at) : "长期有效"} />
            <Detail label="文件摘要" value={`${share.file_count} 个文件`} />
            <Detail label="容量" value={formatSize(share.total_bytes)} />
            <Detail label="取链" value={share.max_downloads > 0 ? `${share.download_count} / ${share.max_downloads}` : `${share.download_count} 次`} />
            <Detail label="来源事件" value={`${share.access_event_count || 0} 条 / ${share.unique_access_ips || 0} IP`} />
          </dl>
          <button type="button" onClick={() => onSource(share)} className="retro-card flex w-full items-center gap-3 p-4 text-left">
            <Network className="h-5 w-5 shrink-0 text-orange-500" />
            <span className="min-w-0"><span className="block type-body-sm font-semibold retro-text">来源与关联调查</span><span className="mt-1 block truncate font-mono type-caption admin-code">{share.source?.ip || "IP 未记录"}</span><span className="mt-1 block truncate type-caption retro-muted">{formatIpLocation(share.source)}</span></span>
          </button>
          {share.banned_reason && <div className="rounded-xl border border-red-300/40 bg-red-50 p-4 type-body-sm text-red-700 dark:bg-red-500/10 dark:text-red-200">封禁原因：{share.banned_reason}</div>}
        </div>
      )}
    </AdminDrawer>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div className="rounded-xl border border-black/8 bg-white/55 p-3 dark:border-white/10 dark:bg-white/[0.035]"><dt className="type-caption retro-muted">{label}</dt><dd className="mt-1 break-words type-body-sm font-semibold retro-text">{value}</dd></div>;
}
