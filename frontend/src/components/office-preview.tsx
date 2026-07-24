"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import styles from "./office-preview.module.css";

export type OfficePreviewKind = "document" | "spreadsheet" | "presentation";

interface OfficePreviewProps {
  kind: OfficePreviewKind;
  url: string;
  backupUrl?: string;
  fileName: string;
  fileSize: number;
  className?: string;
  onDownload?: () => void;
}

type PreviewState = "downloading" | "parsing" | "rendering" | "ready" | "too-large" | "error";

interface ResourcePolicy {
  maxCompressedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
  maxCells: number;
  lowResource: boolean;
}

const MIB = 1024 * 1024;
const PRESENTATION_MAX_COMPRESSED_BYTES = 100 * MIB;

class PreviewLimitError extends Error {}

function preflightOoxmlInWorker(
  buffer: ArrayBuffer,
  kind: OfficePreviewKind,
  policy: ResourcePolicy,
  isXlsx: boolean,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("../workers/office-preflight.worker.ts", import.meta.url), { type: "module" });
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(new PreviewLimitError("Office 文档安全检查超时，请下载后查看"));
    }, kind === "presentation" ? 60_000 : 30_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", handleAbort);
      worker.terminate();
    };
    const handleAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Office 预览已取消", "AbortError"));
    };
    worker.onmessage = (event: MessageEvent<{ ok: boolean; buffer?: ArrayBuffer; limit?: boolean; message?: string }>) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (event.data.ok && event.data.buffer) {
        resolve(event.data.buffer);
        return;
      }
      const error = event.data.limit
        ? new PreviewLimitError(event.data.message || "Office 文档超出安全限制")
        : new Error(event.data.message || "Office 文档安全检查失败");
      reject(error);
    };
    worker.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Office 文档安全检查线程异常"));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    worker.postMessage({
      buffer,
      kind: isXlsx ? "xlsx" : kind,
      policy: {
        maxEntries: policy.maxEntries,
        maxEntryBytes: policy.maxEntryBytes,
        maxExpandedBytes: policy.maxExpandedBytes,
      },
    }, [buffer]);
  });
}

function getPolicy(kind: OfficePreviewKind): ResourcePolicy {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const lowResource = window.matchMedia("(pointer: coarse)").matches
    || window.innerWidth < 768
    || (typeof nav.deviceMemory === "number" && nav.deviceMemory <= 4);
  const mobileLimit = kind === "document" ? 8 : kind === "spreadsheet" ? 10 : 15;
  const desktopLimit = kind === "document" ? 20 : kind === "spreadsheet" ? 30 : 40;
  const presentation = kind === "presentation";
  return {
    maxCompressedBytes: presentation ? PRESENTATION_MAX_COMPRESSED_BYTES : (lowResource ? mobileLimit : desktopLimit) * MIB,
    maxEntries: lowResource ? 2000 : 4000,
    maxEntryBytes: presentation ? 100 * MIB : lowResource ? 24 * MIB : 32 * MIB,
    maxExpandedBytes: presentation ? (lowResource ? 192 : 384) * MIB : lowResource ? 128 * MIB : 256 * MIB,
    maxCells: lowResource ? 50_000 : 200_000,
    lowResource,
  };
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): ArrayBuffer {
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

async function fetchWithLimit(
  url: string,
  limit: number,
  signal: AbortSignal,
  onProgress: (received: number, total: number | null) => void,
  expectedSize: number,
): Promise<ArrayBuffer> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`文件下载失败（HTTP ${response.status}）`);
  const headerValue = response.headers.get("content-length");
  const declaredSize = headerValue ? Number(headerValue) : null;
  if (declaredSize !== null && Number.isFinite(declaredSize) && declaredSize > limit) {
    throw new PreviewLimitError("文件超出当前设备的在线预览限制");
  }
  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > limit) throw new PreviewLimitError("文件超出当前设备的在线预览限制");
    onProgress(buffer.byteLength, declaredSize);
    return buffer;
  }

  const reader = response.body.getReader();
  const hasDeclaredSize = declaredSize !== null && Number.isFinite(declaredSize) && declaredSize >= 0;
  const exactSize = hasDeclaredSize
    ? declaredSize
    : Number.isFinite(expectedSize) && expectedSize > 0 && expectedSize <= limit
      ? expectedSize
      : null;
  const progressTotal = hasDeclaredSize ? declaredSize : exactSize;
  const output = exactSize !== null ? new Uint8Array(exactSize) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const nextReceived = received + value.byteLength;
      if (nextReceived > limit || (output && nextReceived > output.byteLength)) {
        await reader.cancel("preview-size-limit");
        throw new PreviewLimitError("文件超出当前设备的在线预览限制");
      }
      if (output) output.set(value, received);
      else chunks.push(value);
      received = nextReceived;
      onProgress(received, progressTotal);
    }
  } finally {
    reader.releaseLock();
  }
  if (output) {
    if (received !== output.byteLength) throw new Error("Office 文件下载不完整");
    return output.buffer;
  }
  return concatChunks(chunks, received);
}

function cleanupBlobUrls(root: ParentNode) {
  const urls = new Set<string>();
  root.querySelectorAll<HTMLElement>("[src], [href], [style]").forEach((element) => {
    const values = [element.getAttribute("src"), element.getAttribute("href"), element.getAttribute("style")];
    for (const value of values) {
      if (!value) continue;
      const pattern = /blob:[^\s)'\"]+/g;
      let match = pattern.exec(value);
      while (match) {
        urls.add(match[0]);
        match = pattern.exec(value);
      }
    }
  });
  root.querySelectorAll("style").forEach((element) => {
    const pattern = /blob:[^\s)'\"]+/g;
    let match = pattern.exec(element.textContent || "");
    while (match) {
      urls.add(match[0]);
      match = pattern.exec(element.textContent || "");
    }
  });
  urls.forEach((url) => URL.revokeObjectURL(url));
}

function normalizeCss(value: string) {
  return value
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/\\([^\r\n])/g, "$1");
}

function containsExternalCss(value: string) {
  const normalized = normalizeCss(value);
  if (/@import\b|image-set\s*\(/i.test(normalized)) return true;
  return Array.from(normalized.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi))
    .some((match) => !/^(?:blob:|data:|#)/i.test(match[2].trim()));
}

function assertNoExternalCss(root: ParentNode) {
  root.querySelectorAll("style").forEach((element) => {
    if (containsExternalCss(element.textContent || "")) {
      throw new Error("Office 文档包含外部样式资源，请下载后查看");
    }
  });
  root.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
    if (containsExternalCss(element.getAttribute("style") || "")) {
      throw new Error("Office 文档包含外部样式资源，请下载后查看");
    }
  });
}

function sanitizeRenderedTree(root: ParentNode) {
  root.querySelectorAll("script, iframe, object, embed, form, meta, base").forEach((element) => element.remove());
  root.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        if (containsExternalCss(attribute.value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (!["href", "src", "xlink:href", "formaction"].includes(name)) continue;
      const value = attribute.value.trim();
      const safeLink = name === "href" || name === "formaction";
      if (!value || value.startsWith("#") || (safeLink
        ? /^(https?:|mailto:|tel:|blob:)/i.test(value)
        : /^(blob:|data:image\/)/i.test(value))) continue;
      element.removeAttribute(attribute.name);
    }
  });
}

function DocxDocument({ buffer, onReady, onError }: { buffer: ArrayBuffer; onReady: () => void; onError: (error: unknown) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });
    shadow.replaceChildren();
    const styleContainer = document.createElement("div");
    const bodyContainer = document.createElement("div");
    bodyContainer.className = "nyy-docx-body";
    const baseStyle = document.createElement("style");
    baseStyle.textContent = `
      :host { display:block; width:100%; min-width:0; }
      .nyy-docx-body { display:flex; flex-direction:column; align-items:center; gap:16px; }
      .nyy-docx-body .nyy-docx-wrapper { background:transparent; padding:0; }
      .nyy-docx-body section.nyy-docx { margin:0 auto 16px; box-shadow:0 12px 34px rgba(63,43,29,.18); }
      @media (max-width:639px) { .nyy-docx-body section.nyy-docx { transform-origin:top left; } }
    `;
    shadow.prepend(baseStyle);
    const cleanupOwnedNodes = () => {
      cleanupBlobUrls(bodyContainer);
      cleanupBlobUrls(styleContainer);
      baseStyle.remove();
      bodyContainer.remove();
      styleContainer.remove();
    };

    void import("docx-preview")
      .then(({ renderAsync }) => {
        if (disposed) return;
        return renderAsync(buffer, bodyContainer, styleContainer, {
          className: "nyy-docx",
          inWrapper: true,
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          renderComments: false,
          renderChanges: false,
          renderAltChunks: false,
          useBase64URL: false,
        });
      })
      .then(() => {
        if (disposed) {
          cleanupOwnedNodes();
          return;
        }
        assertNoExternalCss(styleContainer);
        assertNoExternalCss(bodyContainer);
        sanitizeRenderedTree(styleContainer);
        sanitizeRenderedTree(bodyContainer);
        shadow.append(styleContainer, bodyContainer);
        const fitToWidth = () => {
          const page = shadow.querySelector<HTMLElement>("section.nyy-docx");
          if (!page) return;
          bodyContainer.style.transform = "none";
          bodyContainer.style.width = "max-content";
          const naturalWidth = Math.max(page.scrollWidth, page.getBoundingClientRect().width);
          const availableWidth = Math.max(1, host.clientWidth);
          const scale = Math.min(1, availableWidth / Math.max(1, naturalWidth));
          bodyContainer.style.width = `${naturalWidth}px`;
          bodyContainer.style.transformOrigin = "top left";
          bodyContainer.style.transform = `scale(${scale})`;
          bodyContainer.style.margin = scale === 1 && availableWidth > naturalWidth ? "0 auto" : "0";
          host.style.height = `${Math.ceil(bodyContainer.scrollHeight * scale)}px`;
        };
        fitToWidth();
        resizeObserver = new ResizeObserver(fitToWidth);
        resizeObserver.observe(host);
        onReady();
      })
      .catch((error) => { if (!disposed) onError(error); });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      cleanupOwnedNodes();
    };
  }, [buffer, onError, onReady]);
  return <div ref={hostRef} className={styles.docxHost} data-testid="office-preview-document" />;
}

interface SheetModel {
  name: string;
  sheet: import("xlsx").WorkSheet;
  range: import("xlsx").Range;
  merges: import("xlsx").Range[];
}

function columnLabel(index: number) {
  let value = index + 1;
  let output = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function clampSize(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function sheetColumnWidth(model: SheetModel, actualColumn: number) {
  const column = model.sheet["!cols"]?.[actualColumn] as { wpx?: number; wch?: number } | undefined;
  return clampSize(column?.wpx ?? ((column?.wch ?? 14) * 8), 72, 280);
}

function sheetRowHeight(model: SheetModel, actualRow: number) {
  const row = model.sheet["!rows"]?.[actualRow] as { hpx?: number; hpt?: number } | undefined;
  return clampSize(row?.hpx ?? ((row?.hpt ?? 25.5) * 96 / 72), 28, 120);
}

function safeSheetColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/^#/, "").replace(/^FF/i, "");
  return /^[0-9a-f]{6}$/i.test(normalized) ? `#${normalized}` : undefined;
}

function getSheetCellStyle(cell: import("xlsx").CellObject | undefined): CSSProperties {
  if (!cell || !cell.s || typeof cell.s !== "object") return {};
  const style = cell.s as {
    fill?: { fgColor?: { rgb?: string } };
    font?: { bold?: boolean; italic?: boolean; sz?: number; color?: { rgb?: string } };
    alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
  };
  const horizontal = ["left", "center", "right", "justify"].includes(style.alignment?.horizontal || "")
    ? style.alignment?.horizontal as CSSProperties["textAlign"]
    : undefined;
  const vertical = style.alignment?.vertical === "top" ? "flex-start" : style.alignment?.vertical === "bottom" ? "flex-end" : undefined;
  return {
    backgroundColor: safeSheetColor(style.fill?.fgColor?.rgb),
    color: safeSheetColor(style.font?.color?.rgb),
    fontWeight: style.font?.bold ? 700 : undefined,
    fontStyle: style.font?.italic ? "italic" : undefined,
    fontSize: typeof style.font?.sz === "number" ? `${clampSize(style.font.sz, 8, 28)}px` : undefined,
    textAlign: horizontal,
    justifyContent: horizontal === "center" ? "center" : horizontal === "right" ? "flex-end" : undefined,
    alignItems: vertical,
    whiteSpace: style.alignment?.wrapText ? "normal" : undefined,
  };
}

function SheetGrid({ models }: { models: SheetModel[] }) {
  "use no memo";
  const [activeIndex, setActiveIndex] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const active = models[Math.min(activeIndex, models.length - 1)];
  const rowCount = active ? active.range.e.r - active.range.s.r + 2 : 1;
  const columnCount = active ? active.range.e.c - active.range.s.c + 2 : 1;
  // TanStack Virtual 返回可变函数，组件已通过指令禁用编译器记忆化。
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => index === 0 ? 34 : sheetRowHeight(active, active.range.s.r + index - 1),
    overscan: 8,
  });
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: columnCount,
    getScrollElement: () => viewportRef.current,
    estimateSize: (index) => index === 0 ? 52 : sheetColumnWidth(active, active.range.s.c + index - 1),
    overscan: 4,
  });

  useEffect(() => {
    viewportRef.current?.scrollTo({ top: 0, left: 0 });
    rowVirtualizer.scrollToIndex(0);
    columnVirtualizer.scrollToIndex(0);
  }, [activeIndex, columnVirtualizer, rowVirtualizer]);

  if (!active) return null;
  return (
    <div className={styles.sheetShell} data-testid="office-preview-document">
      <div className={styles.sheetTabs} role="tablist" aria-label="工作表">
        {models.map((model, index) => (
          <button
            key={model.name}
            type="button"
            role="tab"
            aria-selected={index === activeIndex}
            className={`${styles.sheetTab} ${index === activeIndex ? styles.sheetTabActive : ""}`}
            onClick={() => setActiveIndex(index)}
          >
            {model.name}
          </button>
        ))}
      </div>
      <div ref={viewportRef} className={styles.sheetViewport} tabIndex={0} aria-label={`${active.name} 表格内容`}>
        <div className={styles.sheetCanvas} style={{ width: columnVirtualizer.getTotalSize(), height: rowVirtualizer.getTotalSize() }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => (
            <div
              key={virtualRow.key}
              className={`${styles.sheetRow} ${virtualRow.index === 0 ? styles.sheetRowHeader : ""}`}
              style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}
            >
              {columnVirtualizer.getVirtualItems().map((virtualColumn) => {
                const headerRow = virtualRow.index === 0;
                const headerColumn = virtualColumn.index === 0;
                const row = active.range.s.r + virtualRow.index - 1;
                const column = active.range.s.c + virtualColumn.index - 1;
                const merge = !headerRow && !headerColumn
                  ? active.merges.find((item) => row >= item.s.r && row <= item.e.r && column >= item.s.c && column <= item.e.c)
                  : undefined;
                if (merge && (row !== merge.s.r || column !== merge.s.c)) return null;
                let value = "";
                if (headerRow && !headerColumn) value = columnLabel(column);
                else if (headerColumn && !headerRow) value = String(row + 1);
                else if (!headerRow && !headerColumn) {
                  const cell = active.sheet[`${columnLabel(column)}${row + 1}`];
                  value = cell ? String(cell.w ?? cell.v ?? "") : "";
                }
                const cell = !headerRow && !headerColumn ? active.sheet[`${columnLabel(column)}${row + 1}`] : undefined;
                const mergedWidth = merge
                  ? Array.from({ length: merge.e.c - merge.s.c + 1 }, (_, index) => sheetColumnWidth(active, merge.s.c + index)).reduce((sum, width) => sum + width, 0)
                  : virtualColumn.size;
                const mergedHeight = merge
                  ? Array.from({ length: merge.e.r - merge.s.r + 1 }, (_, index) => sheetRowHeight(active, merge.s.r + index)).reduce((sum, height) => sum + height, 0)
                  : virtualRow.size;
                return (
                  <div
                    key={virtualColumn.key}
                    className={`${styles.sheetCell} ${headerRow || headerColumn ? styles.sheetHeaderCell : ""}`}
                    style={{
                      left: virtualColumn.start,
                      width: mergedWidth,
                      height: mergedHeight,
                      zIndex: merge ? 2 : undefined,
                      ...getSheetCellStyle(cell),
                    }}
                    title={value}
                  >
                    {value}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SpreadsheetDocument({ buffer, maxCells, onReady, onError }: { buffer: ArrayBuffer; maxCells: number; onReady: () => void; onError: (error: unknown) => void }) {
  const [models, setModels] = useState<SheetModel[]>([]);
  useEffect(() => {
    let disposed = false;
    void import("xlsx")
      .then((XLSX) => {
        if (disposed) return;
        const workbook = XLSX.read(buffer, {
          type: "array",
          cellDates: true,
          cellFormula: false,
          cellHTML: false,
          cellStyles: true,
          dense: false,
        });
        let populatedCells = 0;
        const nextModels: SheetModel[] = [];
        for (const name of workbook.SheetNames) {
          const sheet = workbook.Sheets[name];
          populatedCells += Object.keys(sheet).filter((key) => !key.startsWith("!")).length;
          if (populatedCells > maxCells) throw new PreviewLimitError("表格有效单元格过多，无法在当前设备安全预览");
          const ref = sheet["!ref"] || "A1:A1";
          const range = XLSX.utils.decode_range(ref);
          if (range.e.r - range.s.r > 1_000_000 || range.e.c - range.s.c > 16_384) {
            throw new PreviewLimitError("表格声明范围异常，已停止预览");
          }
          nextModels.push({ name, sheet, range, merges: sheet["!merges"] || [] });
        }
        if (nextModels.length === 0) throw new Error("工作簿不包含可预览的工作表");
        if (!disposed) {
          setModels(nextModels);
          onReady();
        }
      })
      .catch((error) => { if (!disposed) onError(error); });
    return () => { disposed = true; };
  }, [buffer, maxCells, onError, onReady]);
  return models.length > 0 ? <SheetGrid models={models} /> : null;
}

function PresentationDocument({ buffer, scrollContainer, policy, onReady, onError }: {
  buffer: ArrayBuffer;
  scrollContainer: HTMLElement | null;
  policy: ResourcePolicy;
  onReady: () => void;
  onError: (error: unknown) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    const mount = document.createElement("div");
    mount.style.width = "100%";
    mount.style.minWidth = "0";
    host.replaceChildren(mount);
    let viewer: import("@aiden0z/pptx-renderer").PptxViewer | null = null;
    void import("@aiden0z/pptx-renderer")
      .then(async ({ PptxViewer, RECOMMENDED_ZIP_LIMITS }) => {
        if (controller.signal.aborted) return;
        const openedViewer = await PptxViewer.open(buffer, mount, {
          fitMode: "contain",
          scrollContainer: scrollContainer || undefined,
          zipLimits: {
            ...RECOMMENDED_ZIP_LIMITS,
            maxEntries: policy.maxEntries,
            maxEntryUncompressedBytes: policy.maxEntryBytes,
            maxTotalUncompressedBytes: policy.maxExpandedBytes,
            maxMediaBytes: Math.min(RECOMMENDED_ZIP_LIMITS.maxMediaBytes, policy.maxExpandedBytes),
          },
          lazySlides: true,
          lazyMedia: true,
          pdfjs: false,
          renderMode: "list",
          listOptions: { windowed: true, initialSlides: 4, batchSize: 4, overscanViewport: 1.25, showSlideLabels: true },
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          openedViewer.destroy();
          return;
        }
        viewer = openedViewer;
        onReady();
      })
      .catch((error) => { if (!controller.signal.aborted) onError(error); });
    return () => {
      controller.abort();
      viewer?.destroy();
      mount.remove();
    };
  }, [buffer, onError, onReady, policy, scrollContainer]);
  return <div ref={hostRef} className={styles.pptxHost} data-testid="office-preview-document" />;
}

function stateMessage(state: PreviewState, progress: number | null, error: string) {
  if (state === "downloading") return { title: "正在读取 Office 文件", detail: progress === null ? "正在建立安全连接…" : `已下载 ${progress}%` };
  if (state === "parsing") return { title: "正在检查文档结构", detail: "正在验证格式、压缩目录和资源大小。" };
  if (state === "rendering") return { title: "正在生成浏览器预览", detail: "复杂排版可能需要一些时间。" };
  if (state === "too-large") return { title: "文件过大，无法在线预览", detail: error };
  return { title: "Office 预览失败", detail: error || "文件可能已损坏或包含暂不支持的内容。" };
}

export function OfficePreview({ kind, url, backupUrl = "", fileName, fileSize, className = "", onDownload }: OfficePreviewProps) {
  const [state, setState] = useState<PreviewState>("downloading");
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const policy = useMemo(() => getPolicy(kind), [kind]);
  const extension = fileName.split(".").pop()?.toLowerCase() || "";

  useEffect(() => {
    const controller = new AbortController();
    setState("downloading");
    setBuffer(null);
    setProgress(null);
    setError("");
    if (fileSize > policy.maxCompressedBytes) {
      setState("too-large");
      setError(`当前设备最多预览 ${Math.round(policy.maxCompressedBytes / MIB)} MB 的${kind === "document" ? "文档" : kind === "spreadsheet" ? "表格" : "演示文稿"}。`);
      return () => controller.abort();
    }

    const startTimer = window.setTimeout(() => {
      const updateProgress = (received: number, total: number | null) => {
        setProgress(total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null);
      };
      const fetchPreview = async () => {
        try {
          return await fetchWithLimit(url, policy.maxCompressedBytes, controller.signal, updateProgress, fileSize);
        } catch (caught) {
          if (caught instanceof PreviewLimitError || caught instanceof DOMException && caught.name === "AbortError" || !backupUrl || backupUrl === url) throw caught;
          setProgress(null);
          return fetchWithLimit(backupUrl, policy.maxCompressedBytes, controller.signal, updateProgress, fileSize);
        }
      };
      void fetchPreview().then(async (downloadedBuffer) => {
        if (controller.signal.aborted) return;
        setState("parsing");
        const nextBuffer = kind !== "spreadsheet" || extension === "xlsx"
          ? await preflightOoxmlInWorker(downloadedBuffer, kind, policy, extension === "xlsx", controller.signal)
          : downloadedBuffer;
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        if (controller.signal.aborted) return;
        setBuffer(nextBuffer);
        setState("rendering");
      }).catch((caught) => {
        if (controller.signal.aborted) return;
        const message = caught instanceof Error ? caught.message : "Office 文件预览失败";
        setError(message);
        setState(caught instanceof PreviewLimitError ? "too-large" : "error");
      });
    }, 0);
    return () => {
      window.clearTimeout(startTimer);
      controller.abort();
    };
  }, [attempt, backupUrl, extension, fileSize, kind, policy, url]);

  useEffect(() => () => {
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
  }, []);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    element.dataset.scrolling = "true";
    if (scrollTimerRef.current !== null) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      delete element.dataset.scrolling;
      scrollTimerRef.current = null;
    }, 700);
  };

  const handleReady = useCallback(() => setState("ready"), []);
  const handleRenderError = useCallback((caught: unknown) => {
    setBuffer(null);
    setError(caught instanceof Error ? caught.message : "Office 文件解析失败");
    setState(caught instanceof PreviewLimitError ? "too-large" : "error");
  }, []);
  const message = stateMessage(state, progress, error);

  return (
    <section
      className={`${styles.root} ${className}`}
      data-testid="office-preview"
      data-kind={kind}
      data-state={state}
      aria-label={`${fileName} 在线预览`}
    >
      <div className={styles.stage} data-testid="office-preview-stage">
        {state !== "ready" && (
          <div className={styles.status} role={state === "error" || state === "too-large" ? "alert" : "status"} aria-live="polite">
            <p className={styles.statusTitle}>{message.title}</p>
            <p className={styles.statusDetail}>{message.detail}</p>
            {state === "downloading" && progress !== null && (
              <div className={styles.progressTrack} aria-label={`下载进度 ${progress}%`}>
                <div className={styles.progressFill} style={{ width: `${progress}%` }} />
              </div>
            )}
            {(state === "error" || state === "too-large") && (
              <div className={styles.statusActions}>
                {state === "error" && (
                  <button type="button" className={styles.retryButton} onClick={() => setAttempt((value) => value + 1)}>重试预览</button>
                )}
                {onDownload && (
                  <button type="button" className={styles.retryButton} onClick={onDownload}>下载查看</button>
                )}
              </div>
            )}
          </div>
        )}
        <div
          ref={scrollRef}
          className={styles.scroll}
          data-testid="office-preview-scroll"
          data-office-scroll
          tabIndex={0}
          onScroll={handleScroll}
          aria-label="Office 文档滚动区域"
        >
          <div className={kind === "spreadsheet" ? undefined : styles.documentPage}>
            {buffer && kind === "document" && <DocxDocument buffer={buffer} onReady={handleReady} onError={handleRenderError} />}
            {buffer && kind === "spreadsheet" && <SpreadsheetDocument buffer={buffer} maxCells={policy.maxCells} onReady={handleReady} onError={handleRenderError} />}
            {buffer && kind === "presentation" && (
              <PresentationDocument buffer={buffer} policy={policy} scrollContainer={scrollRef.current} onReady={handleReady} onError={handleRenderError} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
