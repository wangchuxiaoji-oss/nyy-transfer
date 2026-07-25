"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, BellRing, CheckCircle2, Clock3, Edit3, Plus, Radio, RefreshCw, Send } from "lucide-react";
import { useToast } from "@/components/toast-provider";
import {
  ANNOUNCEMENT_CATEGORY_LABELS,
  ANNOUNCEMENT_STATE_LABELS,
  formatAnnouncementTime,
  type AnnouncementCategory,
  type AnnouncementPriority,
  type AnnouncementState,
} from "@/lib/announcements";
import {
  archiveAdminAnnouncement,
  createAdminAnnouncement,
  getAdminAnnouncements,
  publishAdminAnnouncement,
  updateAdminAnnouncement,
  type AdminAnnouncement,
  type AdminAnnouncementInput,
} from "@/lib/admin";
import { getErrorMessage } from "@/lib/errors";
import { AdminDrawer } from "./admin-drawer";

const CATEGORY_STATES: Record<AnnouncementCategory, AnnouncementState[]> = {
  release: ["released"],
  maintenance: ["scheduled", "in_progress", "completed", "cancelled"],
  incident: ["investigating", "monitoring", "resolved"],
};

const PRIORITY_LABELS: Record<AnnouncementPriority, string> = {
  normal: "普通 · 电报卡",
  important: "重要 · 首次弹窗",
  critical: "紧急 · 首次弹窗与状态强调",
};

function localDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function isoDateTime(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function defaultVersion(): string {
  const now = new Date();
  return `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, "0")}.${String(now.getDate()).padStart(2, "0")}`;
}

interface EditorState {
  version: string;
  category: AnnouncementCategory;
  state: AnnouncementState;
  priority: AnnouncementPriority;
  title: string;
  summary: string;
  details: string;
  startedAt: string;
  completedAt: string;
  visibleUntil: string;
}

function createEditor(item?: AdminAnnouncement): EditorState {
  return {
    version: item?.version || defaultVersion(),
    category: item?.category || "release",
    state: item?.state || "released",
    priority: item?.priority || "normal",
    title: item?.title || "",
    summary: item?.summary || "",
    details: item?.details.join("\n") || "",
    startedAt: localDateTime(item?.started_at || null),
    completedAt: localDateTime(item?.completed_at || null),
    visibleUntil: localDateTime(item?.visible_until || null),
  };
}

function editorPayload(editor: EditorState): AdminAnnouncementInput {
  return {
    version: editor.version.trim(),
    category: editor.category,
    state: editor.state,
    priority: editor.priority,
    title: editor.title.trim(),
    summary: editor.summary.trim(),
    details: editor.details.split("\n").map((line) => line.trim().replace(/^[-*]\s*/, "")).filter(Boolean),
    started_at: isoDateTime(editor.startedAt),
    completed_at: isoDateTime(editor.completedAt),
    visible_until: isoDateTime(editor.visibleUntil),
  };
}

function statusClass(status: AdminAnnouncement["status"]): string {
  if (status === "published") return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (status === "archived") return "bg-gray-500/10 text-gray-600 dark:text-gray-300";
  return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

export function AdminAnnouncementsPanel() {
  const { showToast } = useToast();
  const [items, setItems] = useState<AdminAnnouncement[]>([]);
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [editing, setEditing] = useState<AdminAnnouncement | null | undefined>(undefined);
  const [editor, setEditor] = useState<EditorState>(() => createEditor());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getAdminAnnouncements(statusFilter);
      setItems(response.items);
    } catch (error) {
      showToast({ title: getErrorMessage(error, "公告列表加载失败"), type: "error" });
    } finally {
      setLoading(false);
    }
  }, [showToast, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const openEditor = (item?: AdminAnnouncement) => {
    setEditing(item || null);
    setEditor(createEditor(item));
  };

  const save = async () => {
    setPending(true);
    try {
      const payload = editorPayload(editor);
      const saved = editing ? await updateAdminAnnouncement(editing.id, payload) : await createAdminAnnouncement(payload);
      setEditing(saved);
      setEditor(createEditor(saved));
      showToast({ title: editing ? "公告内容已保存" : "公告草稿已创建", type: "success" });
      await load();
    } catch (error) {
      showToast({ title: getErrorMessage(error, "公告保存失败"), type: "error" });
    } finally {
      setPending(false);
    }
  };

  const publish = async () => {
    if (!editing) return;
    setPending(true);
    try {
      await updateAdminAnnouncement(editing.id, editorPayload(editor));
      const published = await publishAdminAnnouncement(editing.id);
      setEditing(published);
      setEditor(createEditor(published));
      showToast({ title: "公告已发布，用户将收到一次新提醒", type: "success" });
      await load();
    } catch (error) {
      showToast({ title: getErrorMessage(error, "公告发布失败"), type: "error" });
    } finally {
      setPending(false);
    }
  };

  const archive = async (item: AdminAnnouncement) => {
    setPending(true);
    try {
      await archiveAdminAnnouncement(item.id);
      showToast({ title: "公告已归档，不再对外展示", type: "success" });
      setEditing(undefined);
      await load();
    } catch (error) {
      showToast({ title: getErrorMessage(error, "公告归档失败"), type: "error" });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="retro-panel-strong overflow-hidden p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="retro-kicker">发布原则</p><h2 className="retro-title mt-2 text-xl">每次点击发布，用户会收到一次新提醒</h2><p className="type-body-sm mt-2 max-w-2xl retro-muted">只保存内容不会打扰用户；明确点击发布或再次发布时才会重新提醒。进行中的维护和服务问题会持续显示状态条，归档后立即停止展示。</p></div>
          <button type="button" onClick={() => openEditor()} className="btn-primary shrink-0"><Plus className="h-4 w-4" />新建公告</button>
        </div>
      </section>

      <div className="retro-panel flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="retro-segmented flex gap-1 p-1">{[["all", "全部"], ["draft", "草稿"], ["published", "已发布"], ["archived", "已归档"]].map(([value, label]) => <button key={value} type="button" onClick={() => setStatusFilter(value)} aria-pressed={statusFilter === value} className={`retro-segment-button min-h-[40px] px-3 type-caption ${statusFilter === value ? "bg-orange-500 text-white" : ""}`}>{label}</button>)}</div>
        <button type="button" onClick={() => void load()} disabled={loading} className="retro-nav-button"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />刷新</button>
      </div>

      {loading && items.length === 0 ? <div className="retro-panel p-8 text-center retro-muted">正在加载公告...</div> : items.length === 0 ? <div className="retro-panel p-8 text-center retro-muted">当前筛选下没有公告。</div> : <div className="grid gap-3 xl:grid-cols-2">{items.map((item) => (
        <article key={item.id} className="retro-panel-strong p-5">
          <div className="flex items-start justify-between gap-3"><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-orange-500/10 px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.12em] text-orange-700 dark:text-orange-200">{item.version}</span><span className={`rounded-full px-2.5 py-1 type-caption font-semibold ${statusClass(item.status)}`}>{item.status === "published" ? `已发布 · 已通知 ${item.revision} 次` : item.status === "draft" ? "草稿" : "已归档"}</span></div><button type="button" onClick={() => openEditor(item)} className="retro-nav-button"><Edit3 className="h-4 w-4" />编辑</button></div>
          <p className="retro-kicker mt-4">{ANNOUNCEMENT_CATEGORY_LABELS[item.category]} · {ANNOUNCEMENT_STATE_LABELS[item.state]}</p><h3 className="retro-title mt-2 text-lg">{item.title}</h3><p className="type-body-sm mt-2 line-clamp-2 retro-muted">{item.summary}</p>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-black/8 pt-4 type-caption retro-muted dark:border-white/10"><span className="flex items-center gap-1.5"><BellRing className="h-3.5 w-3.5" />{PRIORITY_LABELS[item.priority]}</span>{item.published_at && <span className="flex items-center gap-1.5"><Clock3 className="h-3.5 w-3.5" />{formatAnnouncementTime(item.published_at)}</span>}</div>
        </article>
      ))}</div>}

      <AdminDrawer open={editing !== undefined} title={editing ? `编辑 ${editing.version}` : "新建系统公告"} eyebrow="更新发布台" description="先保存草稿，再明确发布；已发布公告再次发布会生成新的首次通知。" onClose={() => !pending && setEditing(undefined)} widthClassName="max-w-[760px]" footer={<div className="flex flex-wrap justify-end gap-2"><button type="button" onClick={() => setEditing(undefined)} disabled={pending} className="retro-btn-secondary">关闭</button>{editing?.status !== "archived" && <button type="button" onClick={() => void save()} disabled={pending} className="retro-btn-secondary">{pending ? "处理中..." : "保存内容"}</button>}{editing && editing.status !== "archived" && <button type="button" onClick={() => void publish()} disabled={pending} className="btn-primary"><Send className="h-4 w-4" />{editing.status === "published" ? "再次发布并通知" : "发布并通知"}</button>}{editing && editing.status !== "archived" && <button type="button" onClick={() => void archive(editing)} disabled={pending} className="min-h-[44px] rounded-xl bg-red-600 px-4 font-semibold text-white hover:bg-red-700"><Archive className="mr-2 inline h-4 w-4" />归档</button>}</div>}>
        <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="grid gap-4 sm:grid-cols-2"><label><span className="type-caption retro-muted">版本标识</span><input className="retro-input mt-2 w-full" value={editor.version} onChange={(event) => setEditor((current) => ({ ...current, version: event.target.value }))} required /></label><label><span className="type-caption retro-muted">通知优先级</span><select className="retro-input mt-2 w-full" value={editor.priority} onChange={(event) => setEditor((current) => ({ ...current, priority: event.target.value as AnnouncementPriority }))}>{Object.entries(PRIORITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <div className="grid gap-4 sm:grid-cols-2"><label><span className="type-caption retro-muted">公告类型</span><select className="retro-input mt-2 w-full" value={editor.category} onChange={(event) => { const category = event.target.value as AnnouncementCategory; setEditor((current) => ({ ...current, category, state: CATEGORY_STATES[category][0] })); }}>{Object.entries(ANNOUNCEMENT_CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label><span className="type-caption retro-muted">事件状态</span><select className="retro-input mt-2 w-full" value={editor.state} onChange={(event) => setEditor((current) => ({ ...current, state: event.target.value as AnnouncementState }))}>{CATEGORY_STATES[editor.category].map((state) => <option key={state} value={state}>{ANNOUNCEMENT_STATE_LABELS[state]}</option>)}</select></label></div>
          <label><span className="type-caption retro-muted">标题</span><input className="retro-input mt-2 w-full" value={editor.title} onChange={(event) => setEditor((current) => ({ ...current, title: event.target.value }))} maxLength={160} required /></label>
          <label><span className="type-caption retro-muted">摘要</span><textarea className="retro-input mt-2 min-h-24 w-full resize-y" value={editor.summary} onChange={(event) => setEditor((current) => ({ ...current, summary: event.target.value }))} maxLength={500} required /></label>
          <label><span className="type-caption retro-muted">更新清单 · 每行一项，最多 12 项</span><textarea className="retro-input mt-2 min-h-36 w-full resize-y font-mono text-sm" value={editor.details} onChange={(event) => setEditor((current) => ({ ...current, details: event.target.value }))} placeholder={"上传链路恢复正常\n新增 Office 与 PDF 预览\n维护任务验收通过"} /></label>
          <div className="grid gap-4 sm:grid-cols-3"><label><span className="type-caption retro-muted">开始时间</span><input type="datetime-local" className="retro-input mt-2 w-full" value={editor.startedAt} onChange={(event) => setEditor((current) => ({ ...current, startedAt: event.target.value }))} /></label><label><span className="type-caption retro-muted">完成时间</span><input type="datetime-local" className="retro-input mt-2 w-full" value={editor.completedAt} onChange={(event) => setEditor((current) => ({ ...current, completedAt: event.target.value }))} /></label><label><span className="type-caption retro-muted">首次提示截止</span><input type="datetime-local" className="retro-input mt-2 w-full" value={editor.visibleUntil} onChange={(event) => setEditor((current) => ({ ...current, visibleUntil: event.target.value }))} /></label></div>
          {editing?.status === "published" && <p className="rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3 type-caption leading-6 text-amber-800 dark:text-amber-200"><Radio className="mr-2 inline h-4 w-4" />当前内容已经公开。保存只更新历史页；需要用户再次收到首次通知时，请明确点击“再次发布并通知”。</p>}
          {editor.state === "completed" || editor.state === "resolved" ? <p className="flex items-center gap-2 type-caption text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" />该状态必须填写完成时间。</p> : null}
        </form>
      </AdminDrawer>
    </div>
  );
}
