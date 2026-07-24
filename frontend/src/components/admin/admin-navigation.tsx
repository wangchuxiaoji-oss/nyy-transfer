"use client";

import { Activity, AlertTriangle, Database, Download, Gauge, Inbox, LayoutDashboard, Mail, Share2, Users, type LucideIcon } from "lucide-react";
import type { AdminTab } from "@/lib/admin-query-state";

interface AdminNavigationProps {
  activeTab: AdminTab;
  onChange: (tab: AdminTab) => void;
}

const GROUPS: Array<{ label: string; items: Array<{ key: AdminTab; label: string; Icon: LucideIcon }> }> = [
  {
    label: "运营",
    items: [
      { key: "overview", label: "总览", Icon: LayoutDashboard },
      { key: "shares", label: "分享", Icon: Share2 },
      { key: "reports", label: "举报", Icon: AlertTriangle },
      { key: "users", label: "用户", Icon: Users },
      { key: "emails", label: "邮件", Icon: Mail },
      { key: "mailbox", label: "收件箱", Icon: Inbox },
    ],
  },
  {
    label: "系统",
    items: [
      { key: "quota", label: "配额", Icon: Gauge },
      { key: "download", label: "下载", Icon: Download },
      { key: "doubao", label: "豆包", Icon: Database },
      { key: "diagnostics", label: "诊断", Icon: Activity },
    ],
  },
];

export function AdminNavigation({ activeTab, onChange }: AdminNavigationProps) {
  return (
    <>
      <nav aria-label="后台栏目" className="retro-panel sticky top-4 hidden self-start p-3 lg:block">
        {GROUPS.map((group, groupIndex) => (
          <div key={group.label} className={groupIndex ? "mt-5" : ""}>
            <p className="px-3 retro-kicker">{group.label}</p>
            <div className="mt-2 grid gap-1">
              {group.items.map(({ key, label, Icon }) => (
                <button key={key} type="button" onClick={() => onChange(key)} aria-current={activeTab === key ? "page" : undefined} className={`flex min-h-[44px] items-center gap-3 rounded-xl px-3 text-left type-body-sm font-semibold transition-colors ${activeTab === key ? "bg-orange-500 text-white shadow-[0_8px_22px_rgba(255,138,61,0.24)]" : "retro-text hover:bg-orange-500/10 hover:text-orange-600 dark:hover:text-orange-300"}`}>
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <nav aria-label="后台栏目" className="lg:hidden">
        <div className="retro-segmented flex max-w-full gap-1 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {GROUPS.flatMap((group) => group.items).map(({ key, label, Icon }) => (
            <button key={key} type="button" onClick={() => onChange(key)} aria-current={activeTab === key ? "page" : undefined} className="retro-segment-button min-w-[76px] shrink-0 px-3 type-caption">
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
