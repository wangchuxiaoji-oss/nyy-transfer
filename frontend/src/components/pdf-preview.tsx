"use client";

import { useEffect, useRef, useState } from "react";
import pdfjsPackage from "pdfjs-dist/package.json";

interface PdfPreviewProps {
  url: string;
  backupUrl?: string;
  className?: string;
}

const MIB = 1024 * 1024;
const PDF_MAX_PAGES = 2000;
const PDF_MAX_IMAGE_PIXELS = 16_777_216;
const PDF_MAX_CANVAS_BYTES = 64 * MIB;
const PDF_MAX_PAGE_POINTS = 20_000;
const PDF_MAX_CANVAS_DIMENSION = 16_384;
const PDF_RANGE_CHUNK_BYTES = 256 * 1024;
const PDFJS_ASSET_BASE = `/pdfjs/${pdfjsPackage.version}`;

export function PdfPreview({ url, backupUrl = "", className = "" }: PdfPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [sourceUrl, setSourceUrl] = useState(url);

  useEffect(() => setSourceUrl(url), [url]);

  useEffect(() => {
    const pagesContainer = containerRef.current;
    const scrollContainer = scrollRef.current;
    if (!pagesContainer || !scrollContainer) return;
    const target = pagesContainer;

    let disposed = false;
    let limitExceeded = false;
    let loadingTask: import("pdfjs-dist").PDFDocumentLoadingTask | null = null;
    const renderTasks = new Set<import("pdfjs-dist").RenderTask>();
    const observers: Array<IntersectionObserver | ResizeObserver> = [];
    const pageRecords: Array<{
      pageNumber: number;
      page: import("pdfjs-dist").PDFPageProxy | null;
      wrapper: HTMLDivElement;
      canvas: HTMLCanvasElement;
      baseViewport: import("pdfjs-dist").PageViewport | null;
      visible: boolean;
    }> = [];

    const releaseAllResources = () => {
      observers.forEach((observer) => observer.disconnect());
      observers.length = 0;
      renderTasks.forEach((task) => task.cancel());
      renderTasks.clear();
      pageRecords.forEach((record) => record.page?.cleanup());
      pageRecords.length = 0;
      const taskToDestroy = loadingTask;
      loadingTask = null;
      if (taskToDestroy) void taskToDestroy.destroy().catch(() => {});
      target.replaceChildren();
    };

    const showLoadError = (error: unknown) => {
      if (disposed || limitExceeded) return;
      if (sourceUrl === url && backupUrl && backupUrl !== url) {
        releaseAllResources();
        setSourceUrl(backupUrl);
        return;
      }
      setStatus("error");
      setErrorMsg(error instanceof Error ? error.message : "PDF 渲染失败");
      releaseAllResources();
    };

    async function loadPdf() {
      try {
        setStatus("loading");
        setErrorMsg("");
        setProgress(null);
        const pdfModuleUrl = `${PDFJS_ASSET_BASE}/pdf.min.mjs`;
        const pdfjsLib = await import(/* webpackIgnore: true */ pdfModuleUrl) as typeof import("pdfjs-dist");
        if (disposed) return;
        pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_BASE}/pdf.worker.min.mjs`;
        const lowResource = window.matchMedia("(pointer: coarse)").matches || window.innerWidth < 768;
        const maxPdfBytes = (lowResource ? 40 : 100) * MIB;
        const maxCanvasPixels = lowResource ? 12_000_000 : 32_000_000;

        loadingTask = pdfjsLib.getDocument({
          url: sourceUrl,
          isEvalSupported: false,
          cMapUrl: `${PDFJS_ASSET_BASE}/cmaps/`,
          cMapPacked: true,
          iccUrl: `${PDFJS_ASSET_BASE}/iccs/`,
          standardFontDataUrl: `${PDFJS_ASSET_BASE}/standard_fonts/`,
          wasmUrl: `${PDFJS_ASSET_BASE}/wasm/`,
          maxImageSize: PDF_MAX_IMAGE_PIXELS,
          canvasMaxAreaInBytes: PDF_MAX_CANVAS_BYTES,
          rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
          disableAutoFetch: true,
          disableStream: true,
        });
        loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
          if (disposed) return;
          if (loaded > maxPdfBytes || total > maxPdfBytes) {
            limitExceeded = true;
            setStatus("error");
            setErrorMsg(`当前设备最多在线预览 ${Math.round(maxPdfBytes / MIB)} MB 的 PDF。`);
            releaseAllResources();
            return;
          }
          if (total > 0) setProgress(Math.min(100, Math.round((loaded / total) * 100)));
        };
        const pdf = await loadingTask.promise;
        if (disposed) {
          releaseAllResources();
          return;
        }
        if (pdf.numPages > PDF_MAX_PAGES) throw new Error(`PDF 页数超过 ${PDF_MAX_PAGES} 页，请下载后查看`);

        target.replaceChildren();
        const recordsByWrapper = new Map<Element, (typeof pageRecords)[number]>();

        const releasePage = (record: (typeof pageRecords)[number]) => {
          if (record.wrapper.dataset.rendering === "true") return;
          record.page?.cleanup();
          record.page = null;
          record.canvas.width = 1;
          record.canvas.height = 1;
          delete record.wrapper.dataset.rendered;
        };

        const renderPage = async (record: (typeof pageRecords)[number]) => {
          if (disposed || record.wrapper.dataset.rendered === "true" || record.wrapper.dataset.rendering === "true") return;
          record.wrapper.dataset.rendering = "true";
          try {
            if (!record.page) record.page = await pdf.getPage(record.pageNumber);
            if (disposed) return;
            record.baseViewport = record.page.getViewport({ scale: 1 });
            if (!Number.isFinite(record.baseViewport.width)
              || !Number.isFinite(record.baseViewport.height)
              || record.baseViewport.width <= 0
              || record.baseViewport.height <= 0
              || record.baseViewport.width > PDF_MAX_PAGE_POINTS
              || record.baseViewport.height > PDF_MAX_PAGE_POINTS) {
              throw new Error("PDF 页面尺寸异常，请下载后查看");
            }
            record.wrapper.style.aspectRatio = `${record.baseViewport.width} / ${record.baseViewport.height}`;
            const availableWidth = Math.max(240, target.clientWidth);
            const cssScale = Math.min(1.75, availableWidth / record.baseViewport.width);
            const outputScale = Math.min(window.devicePixelRatio || 1, 2);
            const cssWidth = record.baseViewport.width * cssScale;
            const cssHeight = record.baseViewport.height * cssScale;
            const requestedViewport = record.page.getViewport({ scale: cssScale * outputScale });
            const pixelReduction = Math.min(
              1,
              Math.sqrt(maxCanvasPixels / Math.max(1, requestedViewport.width * requestedViewport.height)),
              PDF_MAX_CANVAS_DIMENSION / Math.max(1, requestedViewport.width),
              PDF_MAX_CANVAS_DIMENSION / Math.max(1, requestedViewport.height),
            );
            const viewport = pixelReduction < 1
              ? record.page.getViewport({ scale: cssScale * outputScale * pixelReduction })
              : requestedViewport;
            record.canvas.width = Math.max(1, Math.floor(viewport.width));
            record.canvas.height = Math.max(1, Math.floor(viewport.height));
            record.canvas.style.width = `${Math.floor(cssWidth)}px`;
            record.canvas.style.height = `${Math.floor(cssHeight)}px`;
            record.wrapper.style.width = record.canvas.style.width;
            record.wrapper.style.height = record.canvas.style.height;
            const renderTask = record.page.render({ canvas: record.canvas, viewport });
            renderTasks.add(renderTask);
            try {
              await renderTask.promise;
            } finally {
              renderTasks.delete(renderTask);
            }
            if (!disposed) record.wrapper.dataset.rendered = "true";
          } finally {
            delete record.wrapper.dataset.rendering;
            if (!record.visible) releasePage(record);
          }
        };

        const intersectionObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const record = recordsByWrapper.get(entry.target);
            if (!record) continue;
            record.visible = entry.isIntersecting;
            if (!entry.isIntersecting) {
              releasePage(record);
              continue;
            }
            void renderPage(record).catch((error) => {
              if (!disposed && error?.name !== "RenderingCancelledException") {
                showLoadError(error instanceof Error ? error : new Error("PDF 页面渲染失败"));
              }
            });
          }
        }, { root: scrollContainer, rootMargin: "100% 0px", threshold: 0.01 });
        observers.push(intersectionObserver);

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
          const wrapper = document.createElement("div");
          wrapper.dataset.pdfPage = String(pageNumber);
          wrapper.style.aspectRatio = "612 / 792";
          wrapper.style.width = `${Math.max(240, target.clientWidth)}px`;
          wrapper.style.maxWidth = "100%";
          wrapper.style.flex = "none";
          const canvas = document.createElement("canvas");
          canvas.setAttribute("aria-label", `PDF 第 ${pageNumber} 页`);
          wrapper.appendChild(canvas);
          target.appendChild(wrapper);
          const record = { pageNumber, page: null, wrapper, canvas, baseViewport: null, visible: false };
          pageRecords.push(record);
          recordsByWrapper.set(wrapper, record);
          intersectionObserver.observe(wrapper);
        }

        let previousWidth = target.clientWidth;
        const resizeObserver = new ResizeObserver(() => {
          const nextWidth = target.clientWidth;
          if (disposed || Math.abs(nextWidth - previousWidth) < 24) return;
          previousWidth = nextWidth;
          for (const record of pageRecords) {
            if (record.wrapper.dataset.rendering === "true") continue;
            releasePage(record);
            intersectionObserver.unobserve(record.wrapper);
            intersectionObserver.observe(record.wrapper);
          }
        });
        resizeObserver.observe(target);
        observers.push(resizeObserver);
        if (!disposed) setStatus("ready");
      } catch (error) {
        showLoadError(error);
      }
    }

    void loadPdf();
    return () => {
      disposed = true;
      releaseAllResources();
    };
  }, [backupUrl, sourceUrl, url]);

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

  return (
    <div
      ref={scrollRef}
      className={className}
      tabIndex={0}
      data-pdf-scroll
      data-testid="pdf-preview-scroll"
      aria-label="PDF 文档滚动区域"
      aria-busy={status === "loading"}
      onScroll={handleScroll}
    >
      {status === "loading" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-inherit">
          <p className="font-tech text-sm tracking-widest text-[var(--yc-text-t)]">
            PDF 渲染中{progress === null ? "…" : ` ${progress}%`}
          </p>
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-inherit px-6 text-center" role="alert">
          <p className="font-tech text-sm tracking-widest text-red-400">{errorMsg}</p>
        </div>
      )}
      <div ref={containerRef} className="flex w-full flex-col items-center gap-4" />
    </div>
  );
}
