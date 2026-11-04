"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, LayoutGrid, Monitor, MoveHorizontal, Smartphone } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { PREVIEW_ENTRIES, PREVIEW_GROUPS, getPreviewEntry } from "@/components/design-preview/preview-catalog";
import { DEFAULT_LOGO_CANDIDATE, isLogoCandidate, LOGO_CANDIDATES, type LogoCandidate } from "@/components/design-preview/preview-logo";
import { PreviewScreen } from "@/components/design-preview/preview-screens";

type ViewMode = "compare" | "desktop" | "mobile";

function buildEmbedUrl(path: string, state: string, candidate: LogoCandidate): string {
  const base = path ? `/design-preview/${path}` : "/design-preview";
  const params = new URLSearchParams({ embed: "1", state, mark: candidate });
  return `${base}?${params.toString()}`;
}

export function PreviewApp({ path }: { path: string }) {
  const searchParams = useSearchParams();
  const entry = getPreviewEntry(path);
  const embedded = searchParams.get("embed") === "1";
  const requestedState = searchParams.get("state");
  const requestedMark = searchParams.get("mark");
  const initialState = entry.states.some((item) => item.value === requestedState) ? requestedState! : entry.states[0].value;
  const initialMark: LogoCandidate = isLogoCandidate(requestedMark) ? requestedMark : DEFAULT_LOGO_CANDIDATE;
  const [activeState, setActiveState] = useState(initialState);
  const [candidate, setCandidate] = useState<LogoCandidate>(initialMark);
  const [viewMode, setViewMode] = useState<ViewMode>("compare");
  const [reviewNote, setReviewNote] = useState("");
  const navigationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setActiveState(entry.states[0].value);
  }, [entry.path, entry.states]);

  useEffect(() => {
    const stored = window.localStorage.getItem(`nyy-design-review:${entry.path}`);
    setReviewNote(stored ?? "");
  }, [entry.path]);

  useEffect(() => {
    navigationRef.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
      behavior: "auto",
      block: "nearest",
      inline: "center",
    });
  }, [entry.path]);

  const embedUrl = useMemo(() => buildEmbedUrl(entry.path, activeState, candidate), [activeState, candidate, entry.path]);

  if (embedded) {
    return <PreviewScreen path={entry.path} state={initialState} candidate={initialMark} />;
  }

  const saveReviewNote = (value: string) => {
    setReviewNote(value);
    window.localStorage.setItem(`nyy-design-review:${entry.path}`, value);
  };

  return (
    <main className="dp-review-root">
      <header className="dp-review-banner">
        <div className="dp-review-brand"><span>NYY</span><div><strong>Design Review</strong><small>全量页面 Preview</small></div></div>
        <nav ref={navigationRef} aria-label="设计预览页面">
          {PREVIEW_GROUPS.map((group) => (
            <section key={group} className="dp-review-nav-group">
              <p>{group}</p>
              {PREVIEW_ENTRIES.filter((item) => item.group === group).map((item) => (
                <Link key={item.path} href={item.path ? `/design-preview/${item.path}` : "/design-preview"} aria-current={item.path === entry.path ? "page" : undefined}>
                  <span>{item.label}</span><small>{item.route}</small>
                </Link>
              ))}
            </section>
          ))}
        </nav>
        <span className="dp-review-scroll-hint"><MoveHorizontal aria-hidden="true" />左右滑动</span>
      </header>

      <section className="dp-review-workspace">
        <header className="dp-review-toolbar">
          <div className="dp-review-title"><span>{entry.route}</span><h1>{entry.label}</h1><p>{entry.note}</p></div>
          <a className="dp-review-open" href={embedUrl} target="_blank" rel="noreferrer">全屏打开<ExternalLink aria-hidden="true" /></a>
        </header>

        <div className="dp-review-controls">
          <fieldset><legend>页面状态</legend><div className="dp-review-segments">{entry.states.map((item) => <button key={item.value} type="button" aria-pressed={activeState === item.value} onClick={() => setActiveState(item.value)}>{item.label}</button>)}</div></fieldset>
          <fieldset className="dp-logo-candidate-control"><legend>Logo 候选 · 尚未定稿</legend><div className="dp-review-segments dp-logo-segments">{LOGO_CANDIDATES.map((item) => <button key={item.value} type="button" aria-pressed={candidate === item.value} onClick={() => setCandidate(item.value)} title={`${item.group}：${item.name}`}>{item.value.toUpperCase()} · {item.name}</button>)}</div></fieldset>
          <fieldset><legend>审阅视口</legend><div className="dp-review-segments"><button type="button" aria-pressed={viewMode === "compare"} onClick={() => setViewMode("compare")}><LayoutGrid aria-hidden="true" />双端</button><button type="button" aria-pressed={viewMode === "desktop"} onClick={() => setViewMode("desktop")}><Monitor aria-hidden="true" />桌面</button><button type="button" aria-pressed={viewMode === "mobile"} onClick={() => setViewMode("mobile")}><Smartphone aria-hidden="true" />移动</button></div></fieldset>
        </div>

        <div className={`dp-frame-gallery dp-view-${viewMode}`}>
          {(viewMode === "compare" || viewMode === "desktop") && <PreviewFrame kind="desktop" title="Desktop · 1440 × 900" url={embedUrl} solo={viewMode === "desktop"} />}
          {(viewMode === "compare" || viewMode === "mobile") && <PreviewFrame kind="mobile" title="Mobile · 390 × 844" url={embedUrl} solo={viewMode === "mobile"} />}
        </div>

        <section className="dp-review-notes">
          <div><p>本页审阅备注</p><span>仅保存在当前浏览器，不发送到后端。</span></div>
          <textarea value={reviewNote} onChange={(event) => saveReviewNote(event.target.value)} placeholder="记录：通过、需要修改的细节、拒绝的方向…" aria-label="本页审阅备注" />
        </section>
      </section>
    </main>
  );
}

function PreviewFrame({ kind, title, url, solo }: { kind: "desktop" | "mobile"; title: string; url: string; solo: boolean }) {
  return (
    <article className={`dp-frame-card dp-frame-${kind} ${solo ? "dp-frame-solo" : ""}`}>
      <header><span><i /><i /><i /></span><strong>{title}</strong><a href={url} target="_blank" rel="noreferrer" aria-label={`全屏打开 ${title}`}><ExternalLink aria-hidden="true" /></a></header>
      <div className="dp-frame-stage"><iframe src={url} title={title} /></div>
    </article>
  );
}
