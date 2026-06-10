"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Info } from "lucide-react";
import { CopyLinkButton } from "@/components/copy-link-button";
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
  if (share.max_downloads > 0) return `下载 ${share.download_count}/${share.max_downloads}`;
  return `下载 ${share.download_count}`;
}

function getShareTitle(share: GuestShareInfo): string {
  const first = share.preview_files[0];
  if (!first) return share.empty_dir_count > 0 ? "空文件夹分享" : `分享 /${share.code}`;
  const hidden = Math.max(0, share.file_count - 1);
  return hidden > 0 ? `${first} +${hidden}` : first;
}

function statusText(status: GuestShareInfo["status"], countdown: string): string {
  if (status === "download_exhausted") return "下载已满";
  if (status === "expired") return "已过期";
  return countdown;
}

function statusClass(status: GuestShareInfo["status"]): string {
  if (status === "expiring") return "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-300/25 dark:bg-amber-300/10 dark:text-amber-200";
  if (status === "download_exhausted" || status === "expired") return "border-red-200 bg-red-50 text-red-600 dark:border-red-300/25 dark:bg-red-400/10 dark:text-red-200";
  return "border-black/5 bg-black/[0.03] text-[color:var(--yc-text-s)] dark:border-white/10 dark:bg-white/[0.06]";
}

function getDisplayLink(share: GuestShareInfo): string {
  try {
    return new URL(share.url).pathname || `/${share.code}`;
  } catch {
    return `/${share.code}`;
  }
}

interface GuestShareCardProps {
  share: GuestShareInfo;
  onCopy: (share: GuestShareInfo) => Promise<void> | void;
  onOpenDetail: (share: GuestShareInfo) => void;
}

function AutoScrollTitle({ title }: { title: string }) {
  const containerRef = useRef<HTMLHeadingElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const updateDistance = () => {
      const nextDistance = Math.max(0, text.scrollWidth - container.clientWidth);
      setScrollDistance(nextDistance > 6 ? nextDistance : 0);
    };

    updateDistance();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateDistance);
      return () => window.removeEventListener("resize", updateDistance);
    }

    const observer = new ResizeObserver(updateDistance);
    observer.observe(container);
    observer.observe(text);
    return () => observer.disconnect();
  }, [title]);

  const titleStyle = scrollDistance > 0 ? {
    "--guest-share-title-shift": `-${scrollDistance}px`,
    "--guest-share-title-duration": `${Math.min(18, Math.max(7, scrollDistance / 28))}s`,
  } as CSSProperties : undefined;

  return (
    <h3 ref={containerRef} title={title} className={`mt-2 overflow-hidden ${scrollDistance > 0 ? "guest-share-title-mask" : ""}`}>
      <span
        ref={textRef}
        style={titleStyle}
        className={`block w-max whitespace-nowrap text-[15px] font-semibold leading-5 tracking-normal text-[color:var(--yc-text)] ${scrollDistance > 0 ? "guest-share-title-marquee" : ""}`}
      >
        {title}
      </span>
    </h3>
  );
}

export function GuestShareCard({ share, onCopy, onOpenDetail }: GuestShareCardProps) {
  const title = getShareTitle(share);
  const countdown = formatCountdown(share.expires_at);
  const displayLink = getDisplayLink(share);
  const fileSummary = [
    share.file_count > 0 ? `${share.file_count} 个文件` : "无文件",
    share.empty_dir_count > 0 ? `${share.empty_dir_count} 个空文件夹` : "",
    formatBytes(share.total_bytes),
  ].filter(Boolean).join(" · ");
  const metaSummary = [fileSummary, downloadLabel(share), share.has_password ? "有提取码" : ""].filter(Boolean).join(" · ");

  const copyShare = async () => {
    await onCopy(share);
  };
  const buttonClass = "retro-btn-secondary min-h-[44px] w-full px-2.5 text-xs";

  return (
    <article className="retro-card p-3 sm:p-3.5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium leading-4 ${statusClass(share.status)}`}>{statusText(share.status, countdown)}</span>
            <span className="text-xs leading-4 text-[color:var(--yc-text-t)]">{displayLink}</span>
          </div>

          <AutoScrollTitle title={title} />

          <p className="mt-1 truncate text-xs leading-4 text-[color:var(--yc-text-t)]">{metaSummary}</p>
        </div>

        <div className="grid w-full shrink-0 grid-cols-2 gap-2 sm:w-auto sm:min-w-[172px]">
          <CopyLinkButton onCopy={copyShare} className={buttonClass} iconClassName="h-3.5 w-3.5" />
          <button type="button" onClick={() => onOpenDetail(share)} className={buttonClass}>
            <Info className="h-3.5 w-3.5" />详情
          </button>
        </div>
      </div>
    </article>
  );
}
