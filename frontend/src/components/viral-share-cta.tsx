"use client";

import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { recordViralClick } from "@/lib/growth";

export function ViralShareCta({ shareCode, compact = false }: { shareCode?: string; compact?: boolean }) {
  const href = shareCode ? `/?ref_share=${encodeURIComponent(shareCode)}` : "/";
  return (
    <aside className={compact ? "mx-auto mt-6 w-full max-w-md px-4" : "mx-auto -mt-2 mb-10 w-full max-w-[1320px] px-4 lg:px-10"} aria-label="免费发文件">
      <Link
        href={href}
        data-testid="viral-share-cta"
        onClick={() => { if (shareCode) void recordViralClick(shareCode).catch(() => {}); }}
        className="group flex min-h-[56px] items-center justify-between gap-4 rounded-2xl border border-orange-400/35 bg-gradient-to-r from-orange-500/14 via-white/55 to-cyan-400/10 px-4 py-3 text-left shadow-[0_14px_40px_rgba(255,138,61,0.12)] backdrop-blur-xl transition hover:-translate-y-0.5 hover:border-orange-400/60 hover:shadow-[0_18px_48px_rgba(255,138,61,0.2)] dark:via-white/[0.06]"
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-orange-500 text-white shadow-[0_8px_24px_rgba(255,138,61,0.3)]"><Sparkles className="h-4 w-4" /></span>
          <span className="min-w-0">
            <strong className="block text-sm font-semibold retro-text">我也要免费发文件</strong>
            <span className="mt-0.5 block truncate text-xs retro-muted">无需安装，打开首页就能创建分享链接</span>
          </span>
        </span>
        <ArrowUpRight className="h-5 w-5 shrink-0 text-orange-500 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
      </Link>
    </aside>
  );
}
