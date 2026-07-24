"use client";

import { useEffect, useState } from "react";
import { ShieldOff } from "lucide-react";
import type { AdminShareItem } from "@/lib/admin";
import { AdminDrawer } from "./admin-drawer";

export function AdminBanDialog({ share, pending, onClose, onConfirm }: { share: AdminShareItem | null; pending: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("违反平台内容规范");
  useEffect(() => setReason("违反平台内容规范"), [share?.code]);
  const unbanning = Boolean(share?.banned);
  return (
    <AdminDrawer open={!!share} title={unbanning ? `解封 /${share?.code}` : `封禁 /${share?.code}`} eyebrow="安全操作" description={unbanning ? "解封后，仍需满足有效期和下载次数限制才能公开访问。" : "封禁后公开链接立即不可访问，操作会刷新当前模块。"} onClose={onClose} widthClassName="max-w-[440px]" footer={<div className="grid grid-cols-2 gap-2"><button type="button" onClick={onClose} disabled={pending} className="retro-btn-secondary w-full">取消</button><button type="button" onClick={() => onConfirm(reason.trim())} disabled={pending || (!unbanning && !reason.trim())} className={`min-h-[44px] rounded-xl px-4 font-semibold text-white disabled:opacity-50 ${unbanning ? "bg-orange-600 hover:bg-orange-700" : "bg-red-600 hover:bg-red-700"}`}>{pending ? "处理中..." : unbanning ? "确认解封" : "确认封禁"}</button></div>}>
      <div className="flex items-start gap-3 rounded-2xl border border-red-300/40 bg-red-50 p-4 text-red-700 dark:bg-red-500/10 dark:text-red-200"><ShieldOff className="mt-0.5 h-5 w-5 shrink-0" /><p className="type-body-sm">{unbanning ? "此操作会恢复分享的封禁状态，不会延长有效期或增加下载次数。" : "请填写可追溯的封禁原因，避免使用含糊描述。"}</p></div>
      {!unbanning && <label className="mt-5 block"><span className="type-body-sm font-semibold retro-text">封禁原因</span><select value={reason} onChange={(event) => setReason(event.target.value)} className="retro-input mt-2 w-full px-3 type-body-sm"><option value="违反平台内容规范">违反平台内容规范</option><option value="恶意软件或风险文件">恶意软件或风险文件</option><option value="侵权或违法内容">侵权或违法内容</option><option value="异常访问与滥用">异常访问与滥用</option><option value="">自定义原因</option></select><textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={255} rows={4} className="retro-input mt-2 w-full resize-none px-3 py-2 type-body-sm" placeholder="输入封禁原因" /></label>}
    </AdminDrawer>
  );
}
