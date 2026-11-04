"use client";

import { useState, type SyntheticEvent } from "react";
import { Check, Circle, Download as DownloadIcon, Info, X } from "lucide-react";
import Lightbox, { type Slide } from "yet-another-react-lightbox";
import Counter from "yet-another-react-lightbox/plugins/counter";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import type { GalleryAsset, GalleryFile } from "@/lib/api";
import { ShareImageMetadataPanel } from "@/components/share-image-metadata-panel";
import styles from "./share-image-gallery.module.css";

interface ShareGalleryLightboxProps {
  files: GalleryFile[];
  index: number;
  open: boolean;
  selectedIndices: ReadonlySet<number>;
  downloading: boolean;
  wechatMode: boolean;
  selectionEnabled: boolean;
  onClose: () => void;
  onView: (index: number) => void;
  onToggleSelection: (index: number) => void;
  onDownloadFile: (index: number) => void;
}

function getAsset(file: GalleryFile, kind: string): GalleryAsset | undefined {
  return file.assets.find((asset) => asset.kind === kind && asset.format === "webp" && asset.download_url)
    || file.assets.find((asset) => asset.kind === kind && asset.download_url);
}

function getPreviewAsset(file: GalleryFile): GalleryAsset | undefined {
  return getAsset(file, "original_preview") || getAsset(file, "preview_2048");
}

function fileExtension(fileName: string): string {
  const baseName = fileName.replace(/\\/g, "/").split("/").pop() || fileName;
  const dotIndex = baseName.lastIndexOf(".");
  return dotIndex >= 0 ? baseName.slice(dotIndex + 1).toLowerCase() : "";
}

function responsivePreviewSources(file: GalleryFile): Array<{ src: string; width: number; height: number }> {
  if (getAsset(file, "original_preview")) return [];
  return [getAsset(file, "thumbnail_960"), getAsset(file, "preview_2048")]
    .filter((asset): asset is GalleryAsset => Boolean(asset?.download_url))
    .map((asset) => ({
      src: asset.download_url,
      width: Math.max(1, asset.width),
      height: Math.max(1, asset.height),
    }));
}

export function ShareGalleryLightbox({
  files,
  index,
  open,
  selectedIndices,
  downloading,
  wechatMode,
  selectionEnabled,
  onClose,
  onView,
  onToggleSelection,
  onDownloadFile,
}: ShareGalleryLightboxProps) {
  const [metadataOpen, setMetadataOpen] = useState(false);
  const [wechatHintDismissed, setWechatHintDismissed] = useState(false);
  const activeIndex = Math.min(Math.max(index, 0), Math.max(files.length - 1, 0));
  const activeFile = files[activeIndex];
  const slides: Slide[] = files.map((file) => {
    const width = Math.max(1, file.width || 1);
    const height = Math.max(1, file.height || 1);
    const preview = getPreviewAsset(file);
    return {
      src: preview?.download_url || "",
      alt: file.file_name,
      width,
      height,
      imageFit: "contain",
      srcSet: responsivePreviewSources(file),
    };
  });

  if (files.length === 0 || !activeFile) return null;

  const selected = selectedIndices.has(activeFile.index);
  const selectionButton = (
    <button
      key="gallery-select"
      type="button"
      className={`yarl__button ${styles.lightboxSelectionButton}`}
      aria-label={selected ? "取消选择当前图片" : "选择当前图片"}
      aria-pressed={selected}
      title={selected ? "取消选择当前图片" : "选择当前图片"}
      onClick={() => onToggleSelection(activeFile.index)}
      data-testid="lightbox-select-current"
    >
      {selected ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
    </button>
  );
  const metadataButton = (
    <button
      key="gallery-metadata"
      type="button"
      className="yarl__button"
      aria-label="查看图片元数据"
      title="查看图片元数据"
      onClick={() => setMetadataOpen(true)}
      data-testid="lightbox-metadata"
    >
      <Info aria-hidden="true" />
    </button>
  );
  const rawPreview = ["dng", "cr3", "cr2", "nef", "arw", "raf", "rw2", "orf", "pef"].includes(fileExtension(activeFile.file_name));
  const downloadButton = (
    <button
      key="gallery-download-original"
      type="button"
      className="yarl__button"
      aria-label={rawPreview ? "下载 RAW 原文件" : "下载原图文件"}
      title={rawPreview ? "下载 RAW 原文件" : "下载原图文件"}
      disabled={downloading}
      onClick={() => onDownloadFile(activeFile.index)}
      data-testid="lightbox-download-original"
    >
      <DownloadIcon aria-hidden="true" />
    </button>
  );

  return (
    <Lightbox
      className={styles.lightbox}
      open={open}
      close={() => {
        setMetadataOpen(false);
        onClose();
      }}
      index={activeIndex}
      slides={slides}
      plugins={[Counter, Zoom]}
       carousel={{ preload: 1, imageFit: "contain", imageProps: (slide) => {
        const slideIndex = slides.indexOf(slide);
        const file = files[Math.max(0, slideIndex)];
        const previewAsset = file ? getPreviewAsset(file) : undefined;
        const fallbackUrls = file ? [
          previewAsset?.download_url || "",
          previewAsset?.backup_download_url || "",
        ].filter((url, fallbackIndex, values) => Boolean(url) && url !== slide.src && values.indexOf(url) === fallbackIndex) : [];
        return {
          loading: "eager",
          decoding: "async",
          referrerPolicy: "no-referrer",
          onError: (event: SyntheticEvent<HTMLImageElement>) => {
            const fallbackIndex = Number(event.currentTarget.dataset.fallbackIndex || "0");
            const fallback = fallbackUrls[fallbackIndex];
            if (!fallback) return;
            event.currentTarget.dataset.fallbackIndex = String(fallbackIndex + 1);
            event.currentTarget.srcset = "";
            event.currentTarget.src = fallback;
          },
        };
      } }}
      controller={{ closeOnBackdropClick: true, closeOnEscape: !metadataOpen }}
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 2, pinchZoomV4: true }}
      counter={{ separator: " / " }}
      toolbar={{ buttons: selectionEnabled
        ? ["zoom", selectionButton, metadataButton, downloadButton, "close"]
        : ["zoom", metadataButton, downloadButton, "close"] }}
      labels={{
        Previous: "上一张",
        Next: "下一张",
        Close: "关闭灯箱",
        Slide: "图片",
        Carousel: "图片轮播",
        Lightbox: "图片灯箱",
        "Photo gallery": "分享图片画廊",
        "{index} of {total}": "第 {index} 张，共 {total} 张",
        "Zoom in": "放大",
        "Zoom out": "缩小",
      }}
      on={{ view: ({ index: nextIndex }) => onView(nextIndex) }}
      render={{
        controls: () => (
          <>
            {(!wechatMode || !wechatHintDismissed) && (
              <div className={`${styles.lightboxModeBadge} ${wechatMode ? styles.lightboxWeChatGuide : ""}`} role={wechatMode ? "note" : undefined}>
                {wechatMode ? (
                  <>
                    <strong>{rawPreview ? "当前显示 RAW 预览图" : "长按图片可保存到相册或转发"}</strong>
                    <span>{rawPreview ? "点击右上角下载按钮获取 RAW 原文件" : "点击右上角下载按钮获取原图文件"}</span>
                    <button type="button" onClick={() => setWechatHintDismissed(true)} className={styles.lightboxWeChatGuideClose} aria-label="关闭长按保存提示">
                      <X aria-hidden="true" />
                    </button>
                  </>
                ) : (
                  rawPreview
                    ? `RAW 预览 · ${fileExtension(activeFile.file_name).toUpperCase()}`
                    : `${activeFile.is_animated ? "动画预览" : "高清预览"} · ${fileExtension(activeFile.file_name).toUpperCase()}`
                )}
              </div>
            )}
            <ShareImageMetadataPanel file={activeFile} open={metadataOpen} onClose={() => setMetadataOpen(false)} />
          </>
        ),
      }}
    />
  );
}
