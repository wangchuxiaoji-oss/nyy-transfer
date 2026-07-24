"use client";

import { ChevronRight, FlaskConical, Monitor } from "lucide-react";
import { AdminDoubaoTestPanel } from "./admin-doubao-panel";
import { AdminArchivePanel, AdminAuditLog } from "./admin-audit-log";

export function AdminDiagnosticsPanel() {
  return (
    <div className="space-y-4" data-testid="admin-diagnostics-panel">
      <div className="retro-panel border-amber-300/40 p-5"><div className="flex items-start gap-3"><Monitor className="mt-0.5 h-5 w-5 text-amber-600 dark:text-amber-300" /><div><p className="retro-kicker">开发 / 维护工具</p><h2 className="retro-title mt-1 text-xl">系统诊断</h2><p className="mt-2 type-body-sm retro-muted">此区域不参与日常运营流程，默认折叠以避免误操作。</p></div></div></div>
      <details className="retro-panel group p-4 sm:p-5">
        <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3"><span className="flex items-center gap-3"><FlaskConical className="h-5 w-5 text-orange-500" /><span><span className="block type-body-sm font-semibold retro-text">B 账号互读实验</span><span className="mt-1 block type-caption retro-muted">独立测试 Session 与扫码流程</span></span></span><ChevronRight className="h-5 w-5 retro-muted transition-transform group-open:rotate-90" /></summary>
        <div className="mt-5"><AdminDoubaoTestPanel /></div>
      </details>
      <AdminAuditLog />
      <AdminArchivePanel />
    </div>
  );
}
