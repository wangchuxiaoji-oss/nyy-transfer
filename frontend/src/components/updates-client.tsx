"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock3, Radio, RefreshCw, Rocket } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  ANNOUNCEMENT_CATEGORY_LABELS,
  ANNOUNCEMENT_STATE_LABELS,
  announcementTimestamp,
  formatAnnouncementTime,
  getSystemAnnouncements,
  type SystemAnnouncement,
} from "@/lib/announcements";

const PAGE_SIZE = 20;

function TimelineIcon({ item }: { item: SystemAnnouncement }) {
  if (item.category === "incident") return <AlertTriangle className="h-5 w-5" />;
  if (item.category === "maintenance") return item.state === "completed" ? <CheckCircle2 className="h-5 w-5" /> : <Radio className="h-5 w-5" />;
  return <Rocket className="h-5 w-5" />;
}

export function UpdatesClient() {
  const [items, setItems] = useState<SystemAnnouncement[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async (offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const response = await getSystemAnnouncements({ limit: PAGE_SIZE, offset });
      setItems((current) => offset ? [...current, ...response.items] : response.items);
      setNextOffset(response.next_offset);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "更新记录加载失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  return (
    <main className="nyy-product-shell min-h-dvh px-4 py-5 sm:py-8">
      <div className="nyy-product-content mx-auto max-w-4xl">
        <header className="flex items-center justify-between gap-4">
          <Link href="/" className="inline-flex items-center gap-3"><BrandLogo className="h-auto w-28 sm:w-36" priority /><span className="hidden border-l border-black/10 pl-3 retro-kicker dark:border-white/10 sm:inline">最近更新</span></Link>
          <div className="flex items-center gap-2"><ThemeToggle /><Link href="/" className="retro-nav-button"><ArrowLeft className="h-4 w-4" />返回首页</Link></div>
        </header>

        <section className="relative mt-10 overflow-hidden rounded-[2.5rem] border border-orange-500/20 bg-[#2a1511] px-6 py-10 text-white shadow-[0_30px_100px_rgba(91,37,5,.24)] sm:px-10 sm:py-14">
          <div aria-hidden="true" className="absolute inset-0 [background:radial-gradient(circle_at_15%_20%,rgba(255,138,61,.34),transparent_34%),radial-gradient(circle_at_88%_80%,rgba(34,211,238,.17),transparent_35%)]" />
          <div aria-hidden="true" className="absolute right-8 top-7 text-7xl font-black tracking-tighter text-white/[0.045] sm:text-9xl">更新</div>
          <div className="relative max-w-2xl"><p className="font-mono text-[10px] uppercase tracking-[0.22em] text-orange-200/65">最近做了哪些改进</p><h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-5xl">每一次变化，<br />都清楚告诉你。</h1><p className="mt-5 max-w-xl text-sm leading-7 text-white/65 sm:text-base">这里会记录新功能、问题修复和维护完成时间。你可以随时回来看看，不需要记住任何版本号。</p></div>
        </section>

        <section aria-labelledby="timeline-title" className="mt-10">
          <div className="flex items-end justify-between gap-4"><div><p className="retro-kicker">最新内容排在前面</p><h2 id="timeline-title" className="retro-title mt-2 text-2xl">最近更新</h2></div><span className="type-caption retro-muted">共 {items.length} 条</span></div>

          {error && <div role="alert" className="retro-panel mt-6 flex items-center justify-between gap-4 p-5"><span className="type-body-sm text-red-600 dark:text-red-300">{error}</span><button type="button" onClick={() => void load()} className="retro-btn-secondary"><RefreshCw className="h-4 w-4" />重试</button></div>}
          {!error && !loading && items.length === 0 && <div className="retro-panel mt-6 p-8 text-center retro-muted">暂时还没有公开更新记录。</div>}

          <div className="relative mt-7 space-y-5 before:absolute before:bottom-5 before:left-[1.2rem] before:top-5 before:w-px before:bg-gradient-to-b before:from-orange-500/50 before:via-orange-500/15 before:to-transparent sm:before:left-[2.2rem]">
            {items.map((item) => (
              <article key={item.notice_id} className="relative grid grid-cols-[2.5rem_1fr] gap-3 sm:grid-cols-[4.5rem_1fr] sm:gap-5">
                <div className="relative z-10 grid h-10 w-10 place-items-center rounded-2xl border border-orange-500/25 bg-[#fff8ef] text-orange-600 shadow-[0_8px_24px_rgba(76,31,5,.12)] dark:bg-[#21131e] dark:text-orange-300 sm:ml-4"><TimelineIcon item={item} /></div>
                <div className="retro-panel-strong p-5 sm:p-7">
                  <div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-orange-500/10 px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.14em] text-orange-700 dark:text-orange-200">{item.version}</span><span className="type-caption retro-muted">{ANNOUNCEMENT_CATEGORY_LABELS[item.category]}</span><span className={`type-caption font-semibold ${["in_progress", "investigating", "monitoring"].includes(item.state) ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}`}>{ANNOUNCEMENT_STATE_LABELS[item.state]}</span></div>
                  <h3 className="retro-title mt-4 text-xl sm:text-2xl">{item.title}</h3><p className="type-body-sm mt-3 leading-7 retro-text">{item.summary}</p>
                  {item.details.length > 0 && <ul className="mt-5 grid gap-2 sm:grid-cols-2">{item.details.map((detail, index) => <li key={`${item.notice_id}-${index}`} className="rounded-2xl border border-black/8 bg-white/35 px-4 py-3 type-caption leading-6 retro-text dark:border-white/10 dark:bg-white/[0.035]">{detail}</li>)}</ul>}
                  <p className="mt-5 flex items-center gap-2 border-t border-black/8 pt-4 type-caption retro-muted dark:border-white/10"><Clock3 className="h-3.5 w-3.5" />{item.completed_at ? "完成时间" : "发布时间"}：{formatAnnouncementTime(announcementTimestamp(item))}</p>
                </div>
              </article>
            ))}
          </div>

          {loading && <div className="mt-7 flex items-center justify-center gap-2 py-8 type-body-sm retro-muted"><RefreshCw className="h-4 w-4 animate-spin" />正在同步更新记录...</div>}
          {!loading && nextOffset !== null && <div className="mt-8 text-center"><button type="button" onClick={() => void load(nextOffset)} className="retro-btn-secondary">加载更早记录</button></div>}
        </section>
      </div>
    </main>
  );
}
