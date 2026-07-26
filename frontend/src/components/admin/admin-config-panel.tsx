"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Clock3, Eye, History, Plus, RotateCcw, Save, Send } from "lucide-react";
import {
  createQuotaPolicyDraft,
  getQuotaPolicies,
  previewQuotaPolicy,
  publishQuotaPolicy,
  rollbackQuotaPolicy,
  updateQuotaPolicyDraft,
  type DownloadConfig,
  type QuotaPolicyImpact,
  type QuotaPolicyList,
  type QuotaPolicyVersion,
} from "@/lib/admin";
import type { QuotaPolicyConfig, SendQuotaPolicy } from "@/lib/quota-policy";
import { getErrorMessage } from "@/lib/errors";
import { formatSize } from "@/lib/utils";

const GB = 1024 ** 3;
type DownloadBooleanKey = keyof DownloadConfig;

export function AdminQuotaPanel({ initial, onChange }: { initial: QuotaPolicyList; onChange: (value: QuotaPolicyList) => void }) {
  const current = initial.items.find((item) => item.id === initial.current_id) || null;
  const availableDraft = initial.items.find((item) => item.status === "draft") || null;
  const [selectedId, setSelectedId] = useState(availableDraft?.id || current?.id || initial.items[0]?.id || "");
  const selected = initial.items.find((item) => item.id === selectedId) || availableDraft || current;
  const [draft, setDraft] = useState<QuotaPolicyConfig | null>(selected?.config || null);
  const [note, setNote] = useState(selected?.note || "");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [impact, setImpact] = useState<QuotaPolicyImpact | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const editable = selected?.status === "draft";
  const dirty = Boolean(editable && draft && selected && (JSON.stringify(draft) !== JSON.stringify(selected.config) || note !== selected.note));

  useEffect(() => {
    const row = initial.items.find((item) => item.id === selectedId) || initial.items.find((item) => item.status === "draft") || initial.items.find((item) => item.id === initial.current_id) || initial.items[0];
    if (!row) return;
    setSelectedId(row.id);
    setDraft(structuredClone(row.config));
    setNote(row.note);
    setImpact(null);
  }, [initial, selectedId]);

  const changeDraft = (value: QuotaPolicyConfig) => {
    setDraft(value);
    setImpact(null);
  };

  const reload = async (focusId?: string) => {
    const next = await getQuotaPolicies();
    onChange(next);
    if (focusId) setSelectedId(focusId);
    return next;
  };

  const run = async (key: string, operation: () => Promise<QuotaPolicyVersion | QuotaPolicyImpact>) => {
    if (busy) return null;
    setBusy(key);
    setError("");
    try {
      return await operation();
    } catch (reason) {
      setError(getErrorMessage(reason, "配额策略操作失败"));
      return null;
    } finally {
      setBusy("");
    }
  };

  const createDraft = async () => {
    const row = await run("create", () => createQuotaPolicyDraft("新配额策略草稿"));
    if (row && "config" in row) await reload(row.id);
  };

  const saveDraft = async (): Promise<boolean> => {
    if (!selected || !draft || !dirty) return true;
    const row = await run("save", () => updateQuotaPolicyDraft(selected.id, draft, note));
    if (!row || !("config" in row)) return false;
    try {
      await reload(row.id);
      return true;
    } catch (reason) {
      setError(getErrorMessage(reason, "草稿已保存，但刷新版本列表失败"));
      return false;
    }
  };

  const preview = async () => {
    if (!selected) return;
    if (dirty && !(await saveDraft())) return;
    const result = await run("preview", () => previewQuotaPolicy(selected.id));
    if (result && "valid" in result) setImpact(result);
  };

  const publish = async () => {
    if (!selected || !editable) return;
    if (dirty && !(await saveDraft())) return;
    const iso = effectiveAt ? new Date(`${effectiveAt}:00+08:00`).toISOString() : null;
    if (!impact?.config_hash) return;
    const row = await run("publish", () => publishQuotaPolicy(selected.id, iso, note, impact.config_hash));
    if (row && "config" in row) {
      setEffectiveAt("");
      await reload(row.id);
    }
  };

  const rollback = async (row: QuotaPolicyVersion) => {
    if (!window.confirm(`确认立即回滚到版本 ${row.version}？此操作会创建一个新的已发布版本。`)) return;
    const created = await run(`rollback:${row.id}`, () => rollbackQuotaPolicy(row.id, null, `回滚到版本 ${row.version}`));
    if (created && "config" in created) await reload(created.id);
  };

  if (!selected || !draft) return <div className="retro-panel p-6"><p className="type-body-sm retro-muted">暂无配额策略。</p><button type="button" onClick={() => void createDraft()} className="btn-primary mt-4"><Plus className="h-4 w-4" />创建初始草稿</button></div>;

  return (
    <div className="space-y-4">
      <section className="retro-panel overflow-hidden p-4 sm:p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div><p className="retro-kicker">Policy Control Deck</p><div className="mt-1 flex flex-wrap items-center gap-2"><h2 className="retro-title text-xl">配额策略 v{selected.version}</h2><StatusBadge status={selected.status} />{current?.id === selected.id && <span className="rounded-full bg-emerald-500/12 px-2 py-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">当前生效</span>}</div><p className="mt-2 max-w-2xl type-caption retro-muted">新策略只约束新分享与新收件链接；已用额度保留，降额后超限身份会暂停新增上传直到北京时间周期重置。</p></div>
          <div className="flex flex-wrap gap-2"><select value={selected.id} onChange={(event) => setSelectedId(event.target.value)} className="retro-input min-h-[44px] px-3 type-body-sm">{initial.items.map((row) => <option key={row.id} value={row.id}>v{row.version} · {statusLabel(row.status)}</option>)}</select>{!availableDraft && <button type="button" onClick={() => void createDraft()} disabled={Boolean(busy)} className="retro-btn-secondary"><Plus className="h-4 w-4" />基于当前创建草稿</button>}</div>
        </div>

        <div className="mt-6 grid gap-4 2xl:grid-cols-2">
          <AudiencePolicyEditor title="游客发送" accent="orange" policy={draft.guest} disabled={!editable} onChange={(guest) => changeDraft({ ...draft, guest })} />
          <AudiencePolicyEditor title="注册用户发送" accent="cyan" policy={draft.user} disabled={!editable} onChange={(user) => changeDraft({ ...draft, user })} />
        </div>
        <ReceivePolicyEditor config={draft} disabled={!editable} onChange={changeDraft} />

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_14rem]">
          <label className="retro-card block p-4"><span className="type-label retro-text">发布说明</span><textarea value={note} disabled={!editable} onChange={(event) => { setNote(event.target.value); setImpact(null); }} rows={2} maxLength={500} className="retro-input mt-2 w-full resize-y px-3 py-2 type-body-sm disabled:opacity-60" /></label>
          <label className="retro-card block p-4"><span className="type-label retro-text">保留券时长</span><div className="retro-input mt-2 flex items-center p-0"><input type="number" min={1} disabled={!editable} value={draft.retention_coupon_hours} onChange={(event) => changeDraft({ ...draft, retention_coupon_hours: Math.max(1, Number(event.target.value)) })} className="min-h-[44px] min-w-0 flex-1 bg-transparent px-3 outline-none" /><span className="border-l border-black/8 px-3 type-caption retro-muted dark:border-white/10">小时</span></div></label>
        </div>

        {error && <p role="alert" className="mt-4 flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 type-body-sm text-red-700 dark:text-red-300"><AlertCircle className="h-4 w-4" />{error}</p>}
        {impact && <ImpactPanel impact={impact} />}

        {editable && <div className="sticky bottom-2 z-10 mt-6 rounded-2xl border border-black/8 bg-white/92 p-3 shadow-[0_18px_50px_rgba(32,12,2,0.18)] backdrop-blur-xl dark:border-white/10 dark:bg-[#150c24]/92"><div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"><div className="flex min-w-0 items-center gap-2"><Clock3 className="h-4 w-4 shrink-0 text-orange-500" /><input type="datetime-local" value={effectiveAt} onChange={(event) => setEffectiveAt(event.target.value)} className="retro-input min-h-[42px] min-w-0 px-3 type-caption" /><span className="hidden type-caption retro-muted sm:inline">北京时间，留空立即发布</span></div><div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => void saveDraft()} disabled={!dirty || Boolean(busy)} className="retro-btn-secondary"><Save className="h-4 w-4" />{busy === "save" ? "保存中" : "保存草稿"}</button><button type="button" onClick={() => void preview()} disabled={Boolean(busy)} className="retro-btn-secondary"><Eye className="h-4 w-4" />影响预览</button><button type="button" onClick={() => void publish()} disabled={Boolean(busy) || dirty || !impact?.valid} className="btn-primary"><Send className="h-4 w-4" />{effectiveAt ? "预约发布" : "立即发布"}</button></div></div></div>}
      </section>

      <section className="retro-panel p-4 sm:p-6"><div className="flex items-center justify-between"><div><p className="retro-kicker">Immutable Timeline</p><h3 className="retro-title mt-1 text-lg">版本历史</h3></div><History className="h-5 w-5 text-orange-500" /></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{initial.items.filter((row) => row.status !== "draft").map((row) => <article key={row.id} className="retro-card flex items-start justify-between gap-3 p-4"><div><div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold retro-text">v{row.version}</span><StatusBadge status={row.status} />{row.id === initial.current_id && <span className="text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">生效中</span>}</div><p className="mt-2 type-caption retro-muted">{row.note || "无发布说明"}</p><p className="mt-1 text-[10px] retro-muted">{row.effective_at ? new Date(row.effective_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "未设置生效时间"}</p></div><button type="button" onClick={() => void rollback(row)} disabled={Boolean(busy) || row.id === initial.current_id} className="retro-nav-button shrink-0 disabled:opacity-40"><RotateCcw className="h-3.5 w-3.5" />回滚</button></article>)}</div></section>
    </div>
  );
}

function statusLabel(status: QuotaPolicyVersion["status"]) {
  return status === "draft" ? "草稿" : status === "scheduled" ? "已预约" : "已发布";
}

function StatusBadge({ status }: { status: QuotaPolicyVersion["status"] }) {
  const tone = status === "draft" ? "bg-amber-500/12 text-amber-700 dark:text-amber-300" : status === "scheduled" ? "bg-cyan-500/12 text-cyan-700 dark:text-cyan-300" : "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300";
  return <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${tone}`}>{statusLabel(status)}</span>;
}

function AudiencePolicyEditor({ title, accent, policy, disabled, onChange }: { title: string; accent: "orange" | "cyan"; policy: SendQuotaPolicy; disabled: boolean; onChange: (value: SendQuotaPolicy) => void }) {
  const update = <K extends keyof SendQuotaPolicy,>(key: K, value: SendQuotaPolicy[K]) => onChange({ ...policy, [key]: value });
  return <section className="retro-card min-w-0 overflow-hidden"><div className={`border-b border-black/8 px-4 py-3 dark:border-white/10 ${accent === "orange" ? "bg-orange-500/8" : "bg-cyan-500/8"}`}><div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><h3 className="type-body-sm font-semibold retro-text">{title}</h3><select value={policy.period_kind} disabled={disabled} onChange={(event) => update("period_kind", event.target.value as SendQuotaPolicy["period_kind"])} className="retro-input min-h-[36px] min-w-0 px-2 type-caption"><option value="daily">北京时间每日</option><option value="monthly">北京时间每月</option></select></div></div><div className="grid min-w-0 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3"><PolicySizeField label="周期额度" value={policy.period_limit_bytes} disabled={disabled} onChange={(value) => update("period_limit_bytes", value)} /><PolicySizeField label="单文件" value={policy.max_file_bytes} disabled={disabled} onChange={(value) => update("max_file_bytes", value)} /><PolicySizeField label="单分享" value={policy.max_share_bytes} disabled={disabled} onChange={(value) => update("max_share_bytes", value)} /><PolicyNumberField label="文件 / 分享" value={policy.max_files_per_share} disabled={disabled} onChange={(value) => update("max_files_per_share", value)} /><PolicyNumberField label="空目录 / 分享" value={policy.max_empty_dirs_per_share} disabled={disabled} onChange={(value) => update("max_empty_dirs_per_share", value)} /><PolicyNumberField label="活跃分享" value={policy.max_active_shares} disabled={disabled} onChange={(value) => update("max_active_shares", value)} /><PolicyNumberField label="并发上传批次" value={policy.max_concurrent_upload_batches} disabled={disabled} onChange={(value) => update("max_concurrent_upload_batches", value)} /><PolicyNumberField label="默认有效期（小时）" value={policy.default_retention_hours} disabled={disabled} onChange={(value) => update("default_retention_hours", value)} /><PolicyNumberField label="默认下载次数" value={policy.default_max_downloads} min={0} disabled={disabled} onChange={(value) => update("default_max_downloads", value)} /><OptionsField label="有效期选项（小时）" values={policy.retention_options_hours} disabled={disabled} onChange={(value) => update("retention_options_hours", value)} /><OptionsField label="下载次数选项（0=不限）" values={policy.download_options} min={0} disabled={disabled} onChange={(value) => update("download_options", value)} /></div></section>;
}

function ReceivePolicyEditor({ config, disabled, onChange }: { config: QuotaPolicyConfig; disabled: boolean; onChange: (value: QuotaPolicyConfig) => void }) {
  const policy = config.receive;
  const update = <K extends keyof typeof policy,>(key: K, value: (typeof policy)[K]) => onChange({ ...config, receive: { ...policy, [key]: value } });
  return <section className="retro-card mt-4 min-w-0 overflow-hidden"><div className="flex items-center justify-between border-b border-black/8 bg-fuchsia-500/8 px-4 py-3 dark:border-white/10"><div><h3 className="type-body-sm font-semibold retro-text">收件链接</h3><p className="mt-1 text-[10px] retro-muted">收到的文件计入创建者账号月度额度</p></div><label className="flex items-center gap-2 type-caption retro-text"><input type="checkbox" checked={policy.enabled} disabled={disabled} onChange={(event) => update("enabled", event.target.checked)} className="h-4 w-4 accent-orange-500" />开放创建</label></div><div className="grid min-w-0 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4"><PolicySizeField label="单条收件容量" value={policy.max_request_bytes} disabled={disabled} onChange={(value) => update("max_request_bytes", value)} /><PolicySizeField label="收件单文件" value={policy.max_file_bytes} disabled={disabled} onChange={(value) => update("max_file_bytes", value)} /><PolicyNumberField label="文件 / 收件链接" value={policy.max_files_per_request} disabled={disabled} onChange={(value) => update("max_files_per_request", value)} /><PolicyNumberField label="活跃收件链接" value={policy.max_active_requests} disabled={disabled} onChange={(value) => update("max_active_requests", value)} /><PolicyNumberField label="默认有效期（小时）" value={policy.default_retention_hours} disabled={disabled} onChange={(value) => update("default_retention_hours", value)} /><OptionsField label="有效期选项（小时）" values={policy.retention_options_hours} disabled={disabled} onChange={(value) => update("retention_options_hours", value)} /></div></section>;
}

function PolicySizeField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  const gib = value / GB;
  return <label className="block min-w-0"><span className="type-label retro-text">{label}</span><div className="retro-input mt-1.5 flex min-w-0 items-center p-0"><input type="number" min={0.01} step={0.01} disabled={disabled} value={Number.isInteger(gib) ? gib : Number(gib.toFixed(3))} onChange={(event) => onChange(Math.max(1, Math.round(Number(event.target.value) * GB)))} className="min-h-[42px] w-full min-w-0 flex-1 bg-transparent px-3 outline-none disabled:opacity-60" /><span className="border-l border-black/8 px-3 type-caption retro-muted dark:border-white/10">GB</span></div><span className="mt-1 block text-[10px] retro-muted">{formatSize(value)}</span></label>;
}

function PolicyNumberField({ label, value, min = 1, disabled, onChange }: { label: string; value: number; min?: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label className="block"><span className="type-label retro-text">{label}</span><input type="number" min={min} disabled={disabled} value={value} onChange={(event) => onChange(Math.max(min, Math.floor(Number(event.target.value))))} className="retro-input mt-1.5 min-h-[42px] w-full px-3 disabled:opacity-60" /></label>;
}

function OptionsField({ label, values, min = 1, disabled, onChange }: { label: string; values: number[]; min?: number; disabled: boolean; onChange: (value: number[]) => void }) {
  const [text, setText] = useState(values.join(", "));
  useEffect(() => setText(values.join(", ")), [values]);
  const commit = () => {
    const parsed = Array.from(new Set(text.split(/[,，\s]+/).map(Number).filter((value) => Number.isFinite(value) && value >= min)));
    if (parsed.length) onChange(parsed);
    else setText(values.join(", "));
  };
  return <label className="block sm:col-span-2"><span className="type-label retro-text">{label}</span><input disabled={disabled} value={text} onChange={(event) => setText(event.target.value)} onBlur={commit} className="retro-input mt-1.5 min-h-[42px] w-full px-3 font-mono text-xs disabled:opacity-60" /></label>;
}

function ImpactPanel({ impact }: { impact: QuotaPolicyImpact }) {
  return <div className={`mt-4 rounded-2xl border p-4 ${impact.valid ? "border-emerald-500/20 bg-emerald-500/8" : "border-red-500/20 bg-red-500/8"}`}><div className="flex items-center gap-2"><Eye className="h-4 w-4" /><h3 className="type-body-sm font-semibold retro-text">影响预览 · {impact.changed_fields.length} 项变更</h3></div>{impact.errors.map((item) => <p key={item} className="mt-2 type-caption text-red-700 dark:text-red-300">错误：{item}</p>)}{impact.warnings.map((item) => <p key={item} className="mt-2 type-caption text-amber-700 dark:text-amber-300">提醒：{item}</p>)}{impact.valid && impact.warnings.length === 0 && <p className="mt-2 type-caption text-emerald-700 dark:text-emerald-300">校验通过，没有发现超限身份。</p>}<p className="mt-2 type-caption retro-muted">当前已用量高于新上限：{impact.over_limit_identities} 个身份</p></div>;
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

const TOGGLE_LABELS: Record<DownloadBooleanKey, [string, string]> = {
  smart_download_enabled: ["启用智能下载", "关闭后非分片文件走原始直链"], target_video: ["视频", "常见视频类型"], target_audio: ["音频", "常见音频类型"], target_pdf: ["PDF", "PDF 文档"], target_image: ["图片", "原图保存"], target_other: ["其他文件", "未归类附件"], filesystem_access_enabled: ["File System Access", "支持时按分段写盘"], leave_warning_enabled: ["离开页面提醒", "下载中离开会提醒"],
};

function ToggleGroup({ title, config, keys, onToggle }: { title: string; config: DownloadConfig; keys: DownloadBooleanKey[]; onToggle: (key: DownloadBooleanKey) => void }) {
  return <section><h3 className="type-body-sm font-semibold text-orange-600 dark:text-orange-300">{title}</h3><div className="mt-3 grid gap-3 sm:grid-cols-2">{keys.map((key) => <label key={key} className="retro-card flex cursor-pointer items-start gap-3 p-4"><input type="checkbox" checked={config[key]} onChange={() => onToggle(key)} className="mt-1 h-4 w-4 accent-orange-500" /><span><span className="block type-body-sm font-medium retro-text">{TOGGLE_LABELS[key][0]}</span><span className="mt-1 block type-caption retro-muted">{TOGGLE_LABELS[key][1]}</span></span></label>)}</div></section>;
}
