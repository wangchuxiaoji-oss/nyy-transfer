"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { Bot, Clock, Copy, Eye, Link2, Loader2, LogIn, Monitor, MousePointer2, RefreshCw, Share2, ShieldCheck, UserPlus, Users } from "lucide-react";

import {
  getAdminIpRelations,
  getAdminShareSources,
  getAdminUserSources,
  type AdminIpRelations,
  type AdminIpSource,
  type AdminShareSources,
  type AdminSourceEvent,
  type AdminSourceTarget,
  type AdminUserSources,
} from "@/lib/admin";
import { getErrorMessage } from "@/lib/errors";
import { AdminDrawer } from "@/components/admin/admin-drawer";

interface Props {
  target: AdminSourceTarget | null;
  onClose: () => void;
}

const EVENT_META = {
  view: { label: "页面访问", Icon: Monitor, className: "text-sky-700 bg-sky-100 dark:text-sky-200 dark:bg-sky-500/15" },
  preview_fetch: { label: "预解析", Icon: Bot, className: "text-stone-700 bg-stone-100 dark:text-stone-200 dark:bg-stone-500/15" },
  page_rendered: { label: "页面打开", Icon: Eye, className: "text-sky-700 bg-sky-100 dark:text-sky-200 dark:bg-sky-500/15" },
  human_interaction: { label: "真人互动", Icon: MousePointer2, className: "text-emerald-700 bg-emerald-100 dark:text-emerald-200 dark:bg-emerald-500/15" },
  link_issued: { label: "获取链接", Icon: Link2, className: "text-orange-700 bg-orange-100 dark:text-orange-200 dark:bg-orange-500/15" },
  admin_review: { label: "管理员预览", Icon: ShieldCheck, className: "text-violet-700 bg-violet-100 dark:text-violet-200 dark:bg-violet-500/15" },
  register: { label: "账号注册", Icon: UserPlus, className: "text-emerald-700 bg-emerald-100 dark:text-emerald-200 dark:bg-emerald-500/15" },
  login: { label: "登录成功", Icon: LogIn, className: "text-orange-700 bg-orange-100 dark:text-orange-200 dark:bg-orange-500/15" },
  active_session: { label: "活跃会话", Icon: Monitor, className: "text-amber-700 bg-amber-100 dark:text-amber-200 dark:bg-amber-500/15" },
} as const;

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatIpLocation(source: AdminIpSource | null): string {
  if (!source) return "未记录";
  const location = [source.geo.country, source.geo.region, source.geo.city].filter(Boolean).join(" · ");
  const parts = [location, source.geo.isp].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "地理库未配置";
}

function SourceButton({ source, onInspect }: { source: AdminIpSource; onInspect: (source: AdminIpSource) => void }) {
  const copy = async (event: MouseEvent) => {
    event.stopPropagation();
    await navigator.clipboard?.writeText(source.ip);
  };
  return (
    <div className="group flex min-w-0 items-center gap-2">
      <button type="button" onClick={() => onInspect(source)} className="min-w-0 text-left">
        <span className="block truncate font-mono text-sm font-semibold text-orange-700 underline-offset-4 group-hover:underline dark:text-orange-300">{source.ip}</span>
        <span className="mt-0.5 block truncate text-[11px] retro-muted">{formatIpLocation(source)}</span>
      </button>
      <button type="button" onClick={copy} aria-label={`复制 IP ${source.ip}`} className="retro-icon-button h-9 w-9 shrink-0 opacity-70 group-hover:opacity-100">
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SummarySource({ label, source, time, onInspect }: { label: string; source: AdminIpSource | null; time?: string; onInspect: (source: AdminIpSource) => void }) {
  return (
    <div className="rounded-xl border border-black/8 bg-white/55 p-3 dark:border-white/10 dark:bg-white/[0.04]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="type-caption retro-muted">{label}</span>
        {time && <span className="text-[10px] retro-muted">{formatDate(time)}</span>}
      </div>
      {source ? <SourceButton source={source} onInspect={onInspect} /> : <span className="type-body-sm retro-muted">暂无记录</span>}
    </div>
  );
}

function EventRow({ event, onInspect }: { event: AdminSourceEvent; onInspect: (source: AdminIpSource) => void }) {
  const meta = EVENT_META[event.event_type] || EVENT_META.view;
  const Icon = meta.Icon;
  return (
    <div className="rounded-xl border border-black/8 bg-white/45 p-3 dark:border-white/10 dark:bg-white/[0.035]">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 rounded-lg p-2 ${meta.className}`}><Icon className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="type-body-sm font-semibold retro-text">{meta.label}</span>
            <span className="text-[10px] retro-muted">{formatDate(event.occurred_at)}</span>
          </div>
           {event.actor_label && <p className="mt-1 truncate text-[11px] retro-muted">{event.actor_label}</p>}
          {(event.category || event.client_kind || event.confidence || event.detector) && <p className="mt-1 truncate text-[10px] retro-muted">{[event.category, event.client_kind, event.confidence ? `${event.confidence}置信` : "", event.detector].filter(Boolean).join(" · ")}</p>}
          <div className="mt-2"><SourceButton source={event.source} onInspect={onInspect} /></div>
          {event.user_agent && <p className="mt-2 truncate text-[10px] retro-muted" title={event.user_agent}>{event.user_agent}</p>}
        </div>
      </div>
    </div>
  );
}

export function AdminIpSourcesDrawer({ target, onClose }: Props) {
  const relationRequestRef = useRef<AbortController | null>(null);
  const eventRequestRef = useRef<AbortController | null>(null);
  const [data, setData] = useState<AdminShareSources | AdminUserSources | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [relationSource, setRelationSource] = useState<AdminIpSource | null>(null);
  const [relations, setRelations] = useState<AdminIpRelations | null>(null);
  const [relationsLoading, setRelationsLoading] = useState(false);
  const [relationsError, setRelationsError] = useState("");
  const [eventsLoadingMore, setEventsLoadingMore] = useState(false);

  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    setLoading(true);
    setData(null);
    setError("");
    setRelationSource(null);
    setRelations(null);
    const request = target.kind === "share"
      ? getAdminShareSources(target.id, { signal: controller.signal, limit: 50 })
      : getAdminUserSources(target.id, { signal: controller.signal, limit: 50 });
    request
      .then(setData)
      .catch((err) => { if (!controller.signal.aborted) setError(getErrorMessage(err, "来源数据加载失败")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [target]);

  useEffect(() => () => {
    relationRequestRef.current?.abort();
    eventRequestRef.current?.abort();
  }, []);

  const inspectRelations = (source: AdminIpSource) => {
    relationRequestRef.current?.abort();
    const controller = new AbortController();
    relationRequestRef.current = controller;
    setRelationSource(source);
    setRelations(null);
    setRelationsLoading(true);
    setRelationsError("");
    getAdminIpRelations(source.ip, { signal: controller.signal, limit: 50 })
      .then((result) => { if (!controller.signal.aborted) setRelations(result); })
      .catch((relationError) => { if (!controller.signal.aborted) setRelationsError(getErrorMessage(relationError, "IP 关联加载失败")); })
      .finally(() => { if (!controller.signal.aborted) setRelationsLoading(false); });
  };

  const loadMoreEvents = async () => {
    if (!target || !data?.next_cursor || eventsLoadingMore) return;
    eventRequestRef.current?.abort();
    const controller = new AbortController();
    eventRequestRef.current = controller;
    setEventsLoadingMore(true);
    try {
      const result = target.kind === "share"
        ? await getAdminShareSources(target.id, { signal: controller.signal, after: data.next_cursor, limit: 50 })
        : await getAdminUserSources(target.id, { signal: controller.signal, after: data.next_cursor, limit: 50 });
      if (controller.signal.aborted) return;
      setData((current) => current ? { ...current, ...result, events: [...current.events, ...result.events] } as typeof current : result);
    } catch (loadError) {
      if (!controller.signal.aborted) setError(getErrorMessage(loadError, "更多来源记录加载失败"));
    } finally {
      if (!controller.signal.aborted) setEventsLoadingMore(false);
    }
  };

  const loadMoreRelations = async () => {
    if (!relationSource || !relations?.next_cursor || relationsLoading) return;
    relationRequestRef.current?.abort();
    const controller = new AbortController();
    relationRequestRef.current = controller;
    setRelationsLoading(true);
    setRelationsError("");
    try {
      const result = await getAdminIpRelations(relationSource.ip, { signal: controller.signal, after: relations.next_cursor, limit: 50 });
      if (controller.signal.aborted) return;
      setRelations((current) => current ? { ...current, ...result, users: [...current.users, ...result.users], shares: [...current.shares, ...result.shares], guest_labels: [...current.guest_labels, ...result.guest_labels] } : result);
    } catch (loadError) {
      if (!controller.signal.aborted) setRelationsError(getErrorMessage(loadError, "更多 IP 关联加载失败"));
    } finally {
      if (!controller.signal.aborted) setRelationsLoading(false);
    }
  };

  const isShare = data && "code" in data;
  const events = data?.events || [];

  return (
    <AdminDrawer open={!!target} title={target?.label || "来源详情"} eyebrow="IP 来源与关联" description="默认近 30 天，访问与身份数据最多保留 180 天。" onClose={onClose} closeLabel="关闭来源抽屉" widthClassName="max-w-[560px]">
          {loading && <div className="flex items-center justify-center gap-2 py-16 retro-muted"><Loader2 className="h-5 w-5 animate-spin" />加载来源记录...</div>}
          {error && <div className="rounded-xl border border-red-300/40 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-200">{error}<button type="button" onClick={() => target && (target.kind === "share" ? getAdminShareSources(target.id) : getAdminUserSources(target.id)).then(setData).catch(() => {})} className="retro-btn-secondary mt-3 px-3 type-caption">重试</button></div>}
          {data && (
            <div className="space-y-5">
              <div className="grid grid-cols-3 gap-2">
                <div className="retro-card p-3"><p className="type-caption retro-muted">事件</p><p className="mt-1 text-xl font-bold retro-text">{data.event_count}</p></div>
                <div className="retro-card p-3"><p className="type-caption retro-muted">独立 IP</p><p className="mt-1 text-xl font-bold retro-text">{data.unique_ip_count}</p></div>
                <div className="retro-card p-3"><p className="type-caption retro-muted">身份</p><p className="mt-1 truncate text-sm font-bold retro-text">{isShare ? data.identity_label : data.email}</p></div>
              </div>

              {isShare ? (
                <SummarySource label="创建来源" source={data.creation_source} time={data.created_at} onInspect={inspectRelations} />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SummarySource label="注册来源" source={data.registration_source} onInspect={inspectRelations} />
                  <SummarySource label={`最近登录 · ${data.active_session_count} 个活跃会话`} source={data.last_login_source} onInspect={inspectRelations} />
                </div>
              )}

              {relationSource && (
                <section className="rounded-2xl border border-orange-300/35 bg-orange-50/70 p-4 dark:border-orange-400/20 dark:bg-orange-500/[0.06]">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="type-label retro-text">同 IP 关联</p><p className="mt-1 font-mono text-xs text-orange-700 dark:text-orange-300">{relationSource.ip}</p></div>
                    <button type="button" onClick={() => inspectRelations(relationSource)} className="retro-icon-button h-10 w-10" aria-label="刷新 IP 关联"><RefreshCw className={`h-4 w-4 ${relationsLoading ? "animate-spin" : ""}`} /></button>
                  </div>
                  {relationsError && <p className="mt-4 type-caption text-red-700 dark:text-red-200">{relationsError}</p>}
                  {relationsLoading && !relations ? <p className="mt-4 type-body-sm retro-muted">查询关联中...</p> : relations && (
                    <div className="mt-4 space-y-3">
                      <div className="flex items-center gap-2 text-xs retro-muted"><Users className="h-4 w-4" />{relations.users.length} 个账号 · {relations.guest_labels.length} 个游客标识</div>
                      {relations.users.map((user) => <div key={user.id} className="rounded-lg bg-white/65 px-3 py-2 text-xs dark:bg-white/5"><p className="font-medium retro-text">{user.email}</p><p className="mt-1 retro-muted">{user.relation_types.join(" · ")}</p></div>)}
                      {relations.guest_labels.map((label) => <div key={label} className="rounded-lg bg-white/65 px-3 py-2 text-xs retro-text dark:bg-white/5">{label}</div>)}
                      <div className="flex items-center gap-2 pt-1 text-xs retro-muted"><Share2 className="h-4 w-4" />{relations.shares.length} 个关联分享</div>
                      {relations.shares.map((share) => <a key={share.code} href={`/admin/preview/${share.code}`} target="_blank" rel="noopener noreferrer" className="block rounded-lg bg-white/65 px-3 py-2 text-xs transition-colors hover:bg-orange-100 dark:bg-white/5 dark:hover:bg-white/10"><p className="font-mono text-orange-700 dark:text-orange-300">/{share.code}</p><p className="mt-1 retro-muted">{share.owner_email || "游客"} · {share.relation_types.join(" · ")}</p></a>)}
                      {(relations.truncated || relations.has_more) && <div className="rounded-lg border border-amber-300/40 bg-amber-50 px-3 py-2 type-caption text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{relations.truncation_reason || "关联结果已截断，请继续加载或收窄时间范围。"}</div>}
                      {relations.has_more && relations.next_cursor && <button type="button" onClick={() => void loadMoreRelations()} disabled={relationsLoading} className="retro-btn-secondary w-full type-caption">{relationsLoading ? "加载中..." : "继续加载关联"}</button>}
                    </div>
                  )}
                </section>
              )}

              <section>
                <div className="mb-3 flex items-center justify-between gap-3"><h3 className="type-label retro-text">最近记录</h3><span className="flex items-center gap-1 text-[10px] retro-muted"><Clock className="h-3.5 w-3.5" />保留 180 天</span></div>
                {events.length === 0 ? <div className="rounded-xl border border-dashed border-black/10 py-10 text-center type-body-sm retro-muted dark:border-white/10">暂无访问或登录记录</div> : <div className="space-y-2">{events.map((event, index) => <EventRow key={`${event.event_type}-${event.occurred_at}-${event.source.ip}-${index}`} event={event} onInspect={inspectRelations} />)}</div>}
                {(data.truncated || data.has_more) && <div className="mt-3 rounded-xl border border-amber-300/40 bg-amber-50 p-3 type-caption text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">{data.truncation_reason || "事件记录已截断，当前统计仍为完整口径。"}</div>}
                {data.has_more && data.next_cursor && <button type="button" onClick={() => void loadMoreEvents()} disabled={eventsLoadingMore} className="retro-btn-secondary mt-3 w-full type-caption">{eventsLoadingMore ? "加载中..." : "继续加载记录"}</button>}
              </section>

              <p className="text-center text-[10px] retro-muted">
                运营商数据由 <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-orange-600 dark:hover:text-orange-300">DB-IP</a> 提供
              </p>
            </div>
          )}
    </AdminDrawer>
  );
}
