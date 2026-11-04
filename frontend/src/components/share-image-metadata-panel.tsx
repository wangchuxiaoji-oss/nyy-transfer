"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, Search, X } from "lucide-react";
import type { GalleryFile } from "@/lib/api";
import styles from "./share-image-gallery.module.css";

interface MetadataEntry {
  group: string;
  label: string;
  value: string;
}

interface ShareImageMetadataPanelProps {
  file: GalleryFile;
  open: boolean;
  onClose: () => void;
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "无";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function flattenMetadata(value: unknown, group = "基本信息", path: string[] = []): MetadataEntry[] {
  if (value instanceof Date) {
    return path.length > 0 ? [{ group, label: path.join(" · "), value: value.toLocaleString("zh-CN") }] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => flattenMetadata(
      child,
      group,
      value.length === 1 ? path : [...path, String(index + 1)],
    ));
  }
  if (!value || typeof value !== "object") {
    return path.length > 0 ? [{ group, label: path.join(" · "), value: formatMetadataValue(value) }] : [];
  }

  const entries: MetadataEntry[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextGroup = path.length === 0 && child && typeof child === "object" && !Array.isArray(child) ? key : group;
    const nextPath = path.length === 0 && nextGroup === key ? [] : [...path, key];
    if (child && typeof child === "object" && !Array.isArray(child)) {
      entries.push(...flattenMetadata(child, nextGroup, nextPath));
    } else {
      entries.push({ group: nextGroup, label: nextPath.join(" · ") || key, value: formatMetadataValue(child) });
    }
  }
  return entries;
}

function clientExifSummary(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const metadata = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  const fields: Array<[string, string[]]> = [
    ["Make", ["Make"]],
    ["Model", ["Model"]],
    ["Lens", ["LensModel", "Lens", "LensID"]],
    ["ExposureTime", ["ExposureTime"]],
    ["FNumber", ["FNumber"]],
    ["ISO", ["ISO"]],
    ["FocalLength", ["FocalLength"]],
    ["DateTimeOriginal", ["DateTimeOriginal", "CreateDate"]],
    ["GPSLatitude", ["latitude", "GPSLatitude"]],
    ["GPSLongitude", ["longitude", "GPSLongitude"]],
  ];
  for (const [label, candidates] of fields) {
    const key = candidates.find((candidate) => metadata[candidate] !== undefined && metadata[candidate] !== null);
    if (key) summary[label] = metadata[key];
  }
  return summary;
}

function groupEntries(entries: MetadataEntry[]): Array<[string, MetadataEntry[]]> {
  const groups = new Map<string, MetadataEntry[]>();
  for (const entry of entries) {
    const current = groups.get(entry.group) || [];
    current.push(entry);
    groups.set(entry.group, current);
  }
  return Array.from(groups.entries());
}

function safeAssetUrl(url: string): string | null {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function ShareImageMetadataPanel({ file, open, onClose }: ShareImageMetadataPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [fullExif, setFullExif] = useState<unknown>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const exifAsset = file.assets.find((asset) => asset.kind === "exif_json");
  const originalPreview = file.assets.find((asset) => asset.kind === "original_preview" && asset.format === "jpeg");

  useEffect(() => {
    if (!open) return;
    const abortController = new AbortController();
    setQuery("");
    setFullExif(null);
    const metadataAsset = originalPreview || exifAsset;
    if (!metadataAsset) {
      setLoadState("error");
      return () => abortController.abort();
    }

    setLoadState("loading");
    const urls = [metadataAsset.download_url, metadataAsset.backup_download_url || ""]
      .map(safeAssetUrl)
      .filter((url): url is string => Boolean(url));

    void (async () => {
      for (const url of urls) {
        try {
          const response = await fetch(url, { signal: abortController.signal, cache: "force-cache" });
          if (!response.ok) continue;
          const data: unknown = originalPreview
            ? await (await import("exifr")).parse(await response.blob(), true)
            : await response.json();
          if (abortController.signal.aborted) return;
          setFullExif(data);
          setLoadState("ready");
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return;
        }
      }
      setLoadState("error");
    })();

    return () => abortController.abort();
  }, [exifAsset, file.index, open, originalPreview]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
      if (focusable.length === 0) return;
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
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocus?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    if (!open || loadState !== "ready") return;
    const focusFrame = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [loadState, open]);

  if (!open) return null;

  const summaryEntries = flattenMetadata(file.exif_summary || clientExifSummary(fullExif));
  const allEntries = flattenMetadata(fullExif || {});
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredEntries = normalizedQuery
    ? allEntries.filter((entry) => `${entry.group} ${entry.label} ${entry.value}`.toLocaleLowerCase("zh-CN").includes(normalizedQuery))
    : allEntries;

  return createPortal(
    <div className={styles.metadataLayer} onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
      <button type="button" className={styles.metadataBackdrop} onClick={onClose} aria-label="关闭图片元数据" />
      <div ref={panelRef} className={styles.metadataPanel} role="dialog" aria-modal="true" aria-labelledby="gallery-metadata-title" data-testid="gallery-metadata-panel">
        <header className={styles.metadataHeader}>
          <div className="min-w-0">
            <p className="retro-kicker">图片元数据</p>
            <h2 id="gallery-metadata-title" className="mt-1 truncate font-tech text-sm font-bold tracking-wide text-white" title={file.file_name}>{file.file_name}</h2>
          </div>
          <button ref={closeRef} type="button" onClick={onClose} className={styles.metadataClose} aria-label="关闭元数据面板"><X className="h-5 w-5" /></button>
        </header>

        <div className={styles.metadataBody}>
          <section aria-labelledby="gallery-summary-title">
            <h3 id="gallery-summary-title" className={styles.metadataSectionTitle}>摘要</h3>
            {summaryEntries.length > 0 ? (
              <dl className={styles.metadataGrid}>
                {summaryEntries.map((entry, index) => (
                  <div key={`${entry.group}-${entry.label}-${index}`} className={styles.metadataRow}>
                    <dt>{entry.label}</dt>
                    <dd>{entry.value}</dd>
                  </div>
                ))}
              </dl>
            ) : <p className={styles.metadataHint}>这张图片没有可用的 EXIF 摘要。</p>}
          </section>

          <section aria-labelledby="gallery-full-exif-title">
            <div className={styles.metadataSectionHeading}>
              <h3 id="gallery-full-exif-title" className={styles.metadataSectionTitle}>完整 EXIF</h3>
              {loadState === "ready" && <span>{allEntries.length} 项</span>}
            </div>
            <label className={styles.metadataSearch}>
              <Search className="h-4 w-4" aria-hidden="true" />
              <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索字段或值" aria-label="搜索完整 EXIF" disabled={loadState !== "ready"} />
            </label>

            {loadState === "loading" && <p className={styles.metadataHint} role="status">正在读取完整 EXIF…</p>}
            {loadState === "error" && (
              <div className={styles.metadataError} role="status"><AlertCircle className="h-4 w-4" />完整 EXIF 暂时不可用，摘要仍可查看。</div>
            )}
            {loadState === "ready" && filteredEntries.length === 0 && <p className={styles.metadataHint}>没有匹配的 EXIF 字段。</p>}
            {loadState === "ready" && groupEntries(filteredEntries).map(([group, entries]) => (
              <div key={group} className={styles.metadataGroup}>
                <h4>{group}</h4>
                <dl className={styles.metadataGrid}>
                  {entries.map((entry, index) => (
                    <div key={`${entry.label}-${index}`} className={styles.metadataRow}>
                      <dt>{entry.label}</dt>
                      <dd>{entry.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
