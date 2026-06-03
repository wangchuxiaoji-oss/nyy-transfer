"use client";

import { useEffect, useRef, useState } from "react";

interface PdfPreviewProps {
  url: string;
  className?: string;
}

export function PdfPreview({ url, className = "" }: PdfPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    async function loadPdf() {
      try {
        setStatus("loading");
        // 动态加载 PDF.js（避免首次 bundle 过大）
        const pdfjsLib = await import("pdfjs-dist");
        pdfjsLib.GlobalWorkerOptions.workerSrc =
          "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";

        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        if (disposed || !container) return;

        const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
        if (disposed || !container) return;

        container.innerHTML = "";
        for (let n = 1; n <= pdf.numPages; n++) {
          const page = await pdf.getPage(n);
          if (disposed || !container) return;
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.maxWidth = "100%";
          canvas.style.height = "auto";
          container.appendChild(canvas);
          await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
        }
        if (!disposed) setStatus("ready");
      } catch (err) {
        if (!disposed) {
          setStatus("error");
          setErrorMsg(err instanceof Error ? err.message : "PDF 渲染失败");
        }
      }
    }

    void loadPdf();
    return () => { disposed = true; };
  }, [url]);

  return (
    <div className={className}>
      {status === "loading" && (
        <div className="flex items-center justify-center h-full">
          <p className="font-tech text-sm tracking-widest text-white/60">PDF 渲染中…</p>
        </div>
      )}
      {status === "error" && (
        <div className="flex items-center justify-center h-full">
          <p className="font-tech text-sm tracking-widest text-red-400">{errorMsg}</p>
        </div>
      )}
      <div ref={containerRef} />
    </div>
  );
}
