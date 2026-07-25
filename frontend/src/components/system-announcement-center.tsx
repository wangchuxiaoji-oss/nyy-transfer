"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowRight, Check, Clock3, Radio, Sparkles, X } from "lucide-react";
import {
  ANNOUNCEMENT_CATEGORY_LABELS,
  ANNOUNCEMENT_STATE_LABELS,
  announcementTimestamp,
  formatAnnouncementTime,
  getSystemAnnouncements,
  isPersistentSystemStatus,
  type SystemAnnouncement,
} from "@/lib/announcements";

const STORAGE_KEY = "nyy_system_notice_seen_v1";
const MAX_SEEN_NOTICES = 100;

function readSeenNotices(): Set<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function persistSeenNotices(seen: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(seen).slice(-MAX_SEEN_NOTICES)));
  } catch {
    // 隐私模式或存储配额异常时，本次会话仍可正常关闭通知。
  }
}

function NoticeDetails({ item }: { item: SystemAnnouncement }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-orange-500/25 bg-orange-500/10 px-2.5 py-1 font-mono text-[10px] font-bold tracking-[0.16em] text-orange-700 dark:text-orange-200">
          {ANNOUNCEMENT_CATEGORY_LABELS[item.category]}
        </span>
        <span className="type-caption text-emerald-700 dark:text-emerald-300">{ANNOUNCEMENT_STATE_LABELS[item.state]}</span>
      </div>
      <h2 className="retro-title mt-4 text-2xl leading-tight sm:text-3xl">{item.title}</h2>
      <p className="type-body-sm mt-3 leading-7 retro-text">{item.summary}</p>
      {item.details.length > 0 && (
        <ol className="mt-5 space-y-3">
          {item.details.map((detail, index) => (
            <li key={`${item.notice_id}-${index}`} className="grid grid-cols-[1.75rem_1fr] gap-3 type-body-sm leading-6 retro-text">
              <span className="grid h-7 w-7 place-items-center rounded-full border border-orange-500/20 bg-orange-500/8 font-mono text-[10px] font-bold text-orange-600 dark:text-orange-300">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span>{detail}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-5 flex items-center gap-2 type-caption retro-muted">
        <Clock3 className="h-3.5 w-3.5" />
        {item.completed_at ? "完成于" : "发布于"} {formatAnnouncementTime(announcementTimestamp(item))}
      </p>
    </>
  );
}

function ImportantNoticeDialog({ item, onAcknowledge }: { item: SystemAnnouncement; onAcknowledge: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLElement>("button, a")?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onAcknowledge();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')).filter((element) => element.offsetParent !== null);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [onAcknowledge]);

  return (
    <motion.div className="fixed inset-0 z-[70] flex items-center justify-center px-4 py-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button type="button" aria-label="关闭系统更新通知" className="absolute inset-0 cursor-default bg-[#160d08]/55 backdrop-blur-md" onClick={onAcknowledge} />
      <motion.div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="system-notice-title" data-testid="system-announcement-dialog" className="retro-panel-strong relative max-h-[min(760px,calc(100dvh-2rem))] w-full max-w-xl overflow-y-auto p-6 shadow-[0_32px_100px_rgba(73,33,8,0.34)] sm:p-8" initial={{ y: 28, scale: 0.96, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: 16, scale: 0.98, opacity: 0 }} transition={{ type: "spring", stiffness: 340, damping: 30 }}>
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-cyan-300/15 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-24 -left-20 h-64 w-64 rounded-full bg-orange-400/18 blur-3xl" />
        <button type="button" onClick={onAcknowledge} aria-label="关闭系统更新通知" className="retro-close-button absolute right-4 top-4 z-10"><X className="h-4 w-4" /></button>
        <div className="relative">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-orange-500 to-orange-700 text-white shadow-[0_12px_30px_rgba(234,88,12,.28)]">
              {item.priority === "critical" ? <AlertTriangle className="h-5 w-5" /> : <Radio className="h-5 w-5" />}
            </span>
            <div><p className="retro-kicker">拿呀²有新变化</p><p className="type-caption mt-1 retro-muted">看过后，本设备不会重复提醒</p></div>
          </div>
          <div id="system-notice-title"><NoticeDetails item={item} /></div>
          <div className="mt-7 grid gap-2 sm:grid-cols-[1fr_auto]">
            <Link href="/updates" onClick={onAcknowledge} className="retro-btn-secondary justify-center">查看全部更新 <ArrowRight className="h-4 w-4" /></Link>
            <button type="button" onClick={onAcknowledge} className="btn-primary justify-center"><Check className="h-4 w-4" />我知道了</button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function NormalNoticeCard({ item, onAcknowledge }: { item: SystemAnnouncement; onAcknowledge: () => void }) {
  return (
    <motion.aside data-testid="system-announcement-card" aria-label="系统更新通知" className="fixed bottom-[calc(env(safe-area-inset-bottom)+1rem)] right-4 z-50 w-[calc(100vw-2rem)] max-w-sm overflow-hidden rounded-[1.75rem] border border-orange-500/20 bg-[#fffaf4]/95 p-4 shadow-[0_24px_70px_rgba(70,30,7,.22)] backdrop-blur-xl dark:border-orange-300/15 dark:bg-[#1a101c]/95" initial={{ y: 32, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }}>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-orange-500/12 text-orange-600 dark:text-orange-300"><Sparkles className="h-5 w-5" /></span>
        <div className="min-w-0 flex-1"><p className="retro-kicker">拿呀²刚刚有了新变化</p><h2 className="retro-title mt-1 text-base">{item.title}</h2><p className="type-caption mt-1 line-clamp-2 retro-muted">{item.summary}</p></div>
        <button type="button" onClick={onAcknowledge} aria-label="关闭更新通知" className="retro-close-button -mr-1 -mt-1"><X className="h-4 w-4" /></button>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-black/8 pt-3 dark:border-white/10">
        <Link href="/updates" onClick={onAcknowledge} className="retro-text-button type-caption">看看改了什么 <ArrowRight className="h-3.5 w-3.5" /></Link>
        <button type="button" onClick={onAcknowledge} className="retro-btn-secondary min-h-[40px] px-3 py-1.5 type-caption">知道了</button>
      </div>
    </motion.aside>
  );
}

export function SystemAnnouncementCenter() {
  const [items, setItems] = useState<SystemAnnouncement[]>([]);
  const [prompt, setPrompt] = useState<SystemAnnouncement | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSystemAnnouncements({ limit: 10, activeOnly: true })
      .then((response) => {
        if (cancelled) return;
        setItems(response.items);
        const seen = readSeenNotices();
        setPrompt(response.items.find((item) => !seen.has(item.notice_id)) || null);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => { cancelled = true; };
  }, []);

  const acknowledge = useCallback(() => {
    const seen = readSeenNotices();
    items.forEach((item) => seen.add(item.notice_id));
    persistSeenNotices(seen);
    setPrompt(null);
  }, [items]);

  const persistent = items.find(isPersistentSystemStatus) || null;

  return (
    <>
      {persistent && (
        <aside role="status" data-testid="system-status-ribbon" className="fixed inset-x-0 top-[calc(env(safe-area-inset-top)+61px)] z-30 border-y border-amber-500/25 bg-[#fff5dd]/95 px-4 py-2 text-amber-950 shadow-sm backdrop-blur-xl dark:border-amber-300/15 dark:bg-[#2a1b11]/95 dark:text-amber-100">
          <div className="mx-auto flex max-w-5xl items-center justify-center gap-2 type-caption font-semibold"><span className="relative flex h-2.5 w-2.5"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-600" /></span>{persistent.title}<Link href="/updates" className="underline decoration-amber-600/40 underline-offset-4">查看进度</Link></div>
        </aside>
      )}
      <AnimatePresence>
        {prompt && prompt.priority === "normal" && <NormalNoticeCard key={prompt.notice_id} item={prompt} onAcknowledge={acknowledge} />}
        {prompt && prompt.priority !== "normal" && <ImportantNoticeDialog key={prompt.notice_id} item={prompt} onAcknowledge={acknowledge} />}
      </AnimatePresence>
    </>
  );
}
