"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Save } from "lucide-react";
import type { DownloadConfig, QuotaConfig } from "@/lib/admin";
import { formatSize } from "@/lib/utils";

const MB = 1024 * 1024;
const GB = 1024 * MB;
type DownloadBooleanKey = keyof DownloadConfig;

export function AdminQuotaPanel({ initial, saving, onSave }: { initial: QuotaConfig; saving: boolean; onSave: (config: QuotaConfig) => Promise<boolean> }) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const valid = Object.values(draft).every((value) => Number.isFinite(value) && value >= 1);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || !valid || saving) return;
    if (await onSave(draft)) setDraft(draft);
  };
  return (
    <form onSubmit={submit} className="retro-panel p-4 sm:p-6">
      <ConfigHeader eyebrow="配额规则" title="配额配置" dirty={dirty} description="保存后，前台额度展示和上传校验同步生效。" />
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <section><h3 className="type-body-sm font-semibold text-orange-600 dark:text-orange-300">游客规则</h3><div className="mt-3 grid gap-3 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3"><SizeField label="周期上传额度" bytes={draft.guest_max_file_bytes} unit="MB" onChange={(value) => setDraft({ ...draft, guest_max_file_bytes: value })} /><NumberField label="活跃分享数" value={draft.guest_max_active_shares} suffix="个" onChange={(value) => setDraft({ ...draft, guest_max_active_shares: value })} /><NumberField label="统计周期" value={draft.guest_ttl_hours} suffix="小时" onChange={(value) => setDraft({ ...draft, guest_ttl_hours: value })} /></div></section>
        <section><h3 className="type-body-sm font-semibold text-orange-600 dark:text-orange-300">注册用户规则</h3><div className="mt-3 grid gap-3 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3"><SizeField label="周期上传额度" bytes={draft.user_max_file_bytes} unit="GB" onChange={(value) => setDraft({ ...draft, user_max_file_bytes: value })} /><NumberField label="活跃分享数" value={draft.user_max_active_shares} suffix="个" onChange={(value) => setDraft({ ...draft, user_max_active_shares: value })} /><NumberField label="统计周期" value={draft.user_ttl_hours} suffix="小时" onChange={(value) => setDraft({ ...draft, user_ttl_hours: value })} /></div></section>
      </div>
      {!valid && <p className="mt-4 flex items-center gap-2 type-caption text-red-600 dark:text-red-300"><AlertCircle className="h-4 w-4" />所有配额必须为正数</p>}
      <StickySave dirty={dirty} saving={saving} disabled={!valid} />
    </form>
  );
}

export function AdminDownloadPanel({ initial, saving, onSave }: { initial: DownloadConfig; saving: boolean; onSave: (config: DownloadConfig) => Promise<boolean> }) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(initial), [initial]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const toggle = (key: DownloadBooleanKey) => setDraft({ ...draft, [key]: !draft[key] });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!dirty || saving) return;
    if (await onSave(draft)) setDraft(draft);
  };
  return (
    <form onSubmit={submit} className="retro-panel p-4 sm:p-6">
      <ConfigHeader eyebrow="下载行为" title="下载配置" dirty={dirty} description="默认增强下载；关闭后非分片文件回到原生直链。" />
      <div className="mt-6 grid gap-6 xl:grid-cols-2"><ToggleGroup title="适用范围" config={draft} keys={["smart_download_enabled", "target_video", "target_audio", "target_pdf", "target_image", "target_other"]} onToggle={toggle} /><ToggleGroup title="保存能力" config={draft} keys={["filesystem_access_enabled", "leave_warning_enabled"]} onToggle={toggle} /></div>
      <StickySave dirty={dirty} saving={saving} />
    </form>
  );
}

function ConfigHeader({ eyebrow, title, dirty, description }: { eyebrow: string; title: string; dirty: boolean; description: string }) {
  return <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="retro-kicker">{eyebrow}</p><div className="mt-1 flex items-center gap-2"><h2 className="retro-title text-xl">{title}</h2>{dirty && <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">有未保存更改</span>}</div></div><p className="max-w-lg type-caption retro-muted">{description}</p></div>;
}

function StickySave({ dirty, saving, disabled = false }: { dirty: boolean; saving: boolean; disabled?: boolean }) {
  return <div className="sticky bottom-2 z-10 mt-6 flex items-center justify-between gap-3 rounded-2xl border border-black/8 bg-white/90 p-3 shadow-[0_14px_40px_rgba(32,12,2,0.16)] backdrop-blur-xl dark:border-white/10 dark:bg-[#150c24]/90 sm:static sm:border-0 sm:bg-transparent sm:p-0 sm:shadow-none"><p className="type-caption retro-muted">{dirty ? "变更尚未保存，将影响全部新请求" : "当前配置已同步"}</p><button type="submit" disabled={!dirty || saving || disabled} className="btn-primary shrink-0 disabled:opacity-50"><Save className="h-4 w-4" />{saving ? "保存中" : "保存配置"}</button></div>;
}

function NumberField({ label, value, suffix, onChange }: { label: string; value: number; suffix: string; onChange: (value: number) => void }) {
  return <label className="retro-card block p-4"><span className="type-body-sm font-medium retro-text">{label}</span><div className="retro-input mt-3 flex items-center overflow-hidden p-0"><input type="number" min={1} value={value} onChange={(event) => onChange(Math.max(0, Math.floor(Number(event.target.value))))} className="min-h-[44px] min-w-0 flex-1 bg-transparent px-3 outline-none" /><span className="border-l border-black/8 px-3 type-caption retro-muted dark:border-white/10">{suffix}</span></div></label>;
}

function SizeField({ label, bytes, unit, onChange }: { label: string; bytes: number; unit: "MB" | "GB"; onChange: (value: number) => void }) {
  const ratio = unit === "GB" ? GB : MB;
  const value = bytes / ratio;
  return <label className="retro-card block p-4"><span className="type-body-sm font-medium retro-text">{label}</span><div className="retro-input mt-3 flex items-center overflow-hidden p-0"><input type="number" min={0.01} step={0.01} value={Number.isInteger(value) ? value : value.toFixed(2)} onChange={(event) => onChange(Math.max(1, Math.round(Number(event.target.value) * ratio)))} className="min-h-[44px] min-w-0 flex-1 bg-transparent px-3 outline-none" /><span className="border-l border-black/8 px-3 type-caption retro-muted dark:border-white/10">{unit}</span></div><span className="mt-2 block text-[10px] retro-muted">实际保存：{formatSize(bytes)}（{bytes.toLocaleString()} bytes）</span></label>;
}

const TOGGLE_LABELS: Record<DownloadBooleanKey, [string, string]> = {
  smart_download_enabled: ["启用智能下载", "关闭后非分片文件走原始直链"], target_video: ["视频", "常见视频类型"], target_audio: ["音频", "常见音频类型"], target_pdf: ["PDF", "PDF 文档"], target_image: ["图片", "原图保存"], target_other: ["其他文件", "未归类附件"], filesystem_access_enabled: ["File System Access", "支持时按分段写盘"], leave_warning_enabled: ["离开页面提醒", "下载中离开会提醒"],
};

function ToggleGroup({ title, config, keys, onToggle }: { title: string; config: DownloadConfig; keys: DownloadBooleanKey[]; onToggle: (key: DownloadBooleanKey) => void }) {
  return <section><h3 className="type-body-sm font-semibold text-orange-600 dark:text-orange-300">{title}</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">{keys.map((key) => <label key={key} className="retro-card flex cursor-pointer items-start gap-3 p-4"><input type="checkbox" checked={config[key]} onChange={() => onToggle(key)} className="mt-1 h-4 w-4 accent-orange-500" /><span><span className="block type-body-sm font-medium retro-text">{TOGGLE_LABELS[key][0]}</span><span className="mt-1 block type-caption retro-muted">{TOGGLE_LABELS[key][1]}</span></span></label>)}</div></section>;
}
