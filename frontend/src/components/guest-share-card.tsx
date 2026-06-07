"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Clock, Copy, Download, ExternalLink, Eye, Files, KeyRound, MoreHorizontal, QrCode, Trash2 } from "lucide-react";
import type { GuestShareInfo } from "@/lib/api";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatCountdown(expiresAt: string | null): string {
  if (!expiresAt) return "永不过期";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "已过期";
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  if (days > 0) return `${days}天后过期`;
  if (hours > 0) return `${hours}小时后过期`;
  return `${Math.max(1, minutes)}分钟后过期`;
}

function downloadLabel(share: GuestShareInfo): string {
  if (share.max_downloads > 0) return `已下载 ${share.download_count}/${share.max_downloads} 次`;
  return `已下载 ${share.download_count} 次`;
}

function getShareTitle(share: GuestShareInfo): string {
  const first = share.preview_files[0];
  if (!first) return share.empty_dir_count > 0 ? "空文件夹分享" : `分享 /${share.code}`;
  const hidden = Math.max(0, share.file_count - 1);
  return hidden > 0 ? `${first} +${hidden}` : first;
}

function statusText(status: GuestShareInfo["status"]): string {
  if (status === "expiring") return "即将过期";
  if (status === "download_exhausted") return "下载已满";
  if (status === "expired") return "已过期";
  return "有效中";
}

function statusClass(status: GuestShareInfo["status"]): string {
  if (status === "expiring") return "border-amber-300/50 bg-amber-100/70 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300";
  if (status === "download_exhausted" || status === "expired") return "border-red-300/50 bg-red-100/70 text-red-700 dark:bg-red-900/20 dark:text-red-300";
  return "border-emerald-300/50 bg-emerald-100/70 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300";
}

function useMenuDismiss(open: boolean, ref: RefObject<HTMLDivElement>, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current && !ref.current.contains(target)) onClose();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose, ref]);
}

interface GuestShareCardProps {
  share: GuestShareInfo;
  onCopy: (share: GuestShareInfo) => Promise<void> | void;
  onOpenDetail: (share: GuestShareInfo) => void;
  onRevoke: (share: GuestShareInfo) => void;
}

interface ActionItem {
  key: string;
  label: string;
  icon: ReactNode;
  href?: string;
  onClick?: () => void;
  danger?: boolean;
}

function GuestActionMenu({ actions }: { actions: ActionItem[] }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(open, menuRef, () => setOpen(false));

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="retro-btn-secondary min-h-[42px] px-3"
      >
        <MoreHorizontal className="h-4 w-4" />更多
      </button>
      {open && (
        <div role="menu" className="retro-menu absolute right-0 top-full z-30 mt-2 w-48 rounded-2xl p-1">
          {actions.map((action) => {
            const className = `retro-menu-item type-action ${action.danger ? "retro-menu-item-danger" : ""}`;
            if (action.href) {
              return (
                <a key={action.key} href={action.href} target="_blank" rel="noopener noreferrer" role="menuitem" onClick={() => setOpen(false)} className={className}>
                  {action.icon}{action.label}
                </a>
              );
            }
            return (
              <button
                key={action.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  action.onClick?.();
                  setOpen(false);
                }}
                className={className}
              >
                {action.icon}{action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function GuestShareCard({ share, onCopy, onOpenDetail, onRevoke }: GuestShareCardProps) {
  const [copied, setCopied] = useState(false);
  const title = getShareTitle(share);
  const countdown = formatCountdown(share.expires_at);
  const sharePath = share.url || `/${share.code}`;
  const fileSummary = [
    share.file_count > 0 ? `${share.file_count} 个文件` : "无文件",
    share.empty_dir_count > 0 ? `${share.empty_dir_count} 个空文件夹` : "",
    formatBytes(share.total_bytes),
  ].filter(Boolean).join(" · ");

  const copyShare = async () => {
    await onCopy(share);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  const actions: ActionItem[] = [
    { key: "open", label: "打开分享页", icon: <ExternalLink className="h-4 w-4" />, href: sharePath },
    { key: "detail", label: "查看详情 / 二维码", icon: <QrCode className="h-4 w-4" />, onClick: () => onOpenDetail(share) },
  ];
  if (share.has_revoke_token) actions.push({ key: "revoke", label: "撤销分享", icon: <Trash2 className="h-4 w-4" />, onClick: () => onRevoke(share), danger: true });

  return (
    <article className="retro-card overflow-hidden p-0">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <span className={`retro-chip border ${statusClass(share.status)}`}>{statusText(share.status)}</span>
          <span className="type-caption inline-flex shrink-0 items-center gap-1 retro-muted">
            <Clock className="h-3.5 w-3.5" />{countdown}
          </span>
        </div>

        <div className="mt-3 min-w-0">
          <h3 className="type-body-strong truncate retro-title text-base sm:text-lg">{title}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 type-caption retro-muted">
            <span className="inline-flex items-center gap-1"><Files className="h-3.5 w-3.5" />{fileSummary}</span>
            <span className="inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" />{downloadLabel(share)}</span>
            {share.has_password && <span className="inline-flex items-center gap-1"><KeyRound className="h-3.5 w-3.5" />有提取码</span>}
          </div>
        </div>

        <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 px-3 py-2 dark:bg-black/10">
          <code className="block truncate font-mono text-sm text-orange-600 dark:text-orange-300">{share.url}</code>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-white/10 px-4 py-3 sm:px-5">
        <button type="button" onClick={copyShare} className="retro-btn-secondary min-h-[42px] flex-1 px-3 sm:flex-none">
          <Copy className="h-4 w-4" />{copied ? "已复制" : "复制链接"}
        </button>
        <div className="flex items-center gap-2 sm:hidden">
          <GuestActionMenu actions={actions} />
        </div>
        <div className="hidden items-center gap-2 sm:flex lg:hidden">
          <a href={sharePath} target="_blank" rel="noopener noreferrer" className="retro-btn-secondary min-h-[42px] px-3"><ExternalLink className="h-4 w-4" />打开</a>
          <GuestActionMenu actions={actions.slice(1)} />
        </div>
        <div className="hidden items-center gap-2 lg:flex">
          <button type="button" onClick={() => onOpenDetail(share)} className="retro-btn-secondary min-h-[42px] px-3"><QrCode className="h-4 w-4" />二维码</button>
          <a href={sharePath} target="_blank" rel="noopener noreferrer" className="retro-btn-secondary min-h-[42px] px-3"><ExternalLink className="h-4 w-4" />打开</a>
          <button type="button" onClick={() => onOpenDetail(share)} className="retro-btn-secondary min-h-[42px] px-3"><Eye className="h-4 w-4" />详情</button>
          {share.has_revoke_token && <button type="button" onClick={() => onRevoke(share)} className="retro-btn-secondary min-h-[42px] px-3 text-red-500 hover:text-red-500"><Trash2 className="h-4 w-4" />撤销</button>}
        </div>
      </div>
    </article>
  );
}
