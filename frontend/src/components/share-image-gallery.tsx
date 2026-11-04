"use client";

import { useState } from "react";
import { Check, Clock3, ImageOff } from "lucide-react";
import { RowsPhotoAlbum, type Photo } from "react-photo-album";
import type { GalleryAsset, GalleryFile } from "@/lib/api";
import { ShareGalleryLightbox } from "@/components/share-gallery-lightbox";
import { ShareGallerySelectionBar } from "@/components/share-gallery-selection-bar";
import styles from "./share-image-gallery.module.css";

const TRANSPARENT_PIXEL = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

interface GalleryPhoto extends Photo {
  file: GalleryFile;
  asset?: GalleryAsset;
  eager: boolean;
}

interface GalleryGroup {
  key: string;
  name: string;
  files: GalleryFile[];
}

interface ShareImageGalleryProps {
  files: GalleryFile[];
  loading: boolean;
  downloading: boolean;
  selectedIndices: ReadonlySet<number>;
  currentIndex: number | null;
  wechatMode: boolean;
  selectionEnabled: boolean;
  formatSize: (bytes: number) => string;
  onCurrentChange: (index: number) => void;
  onToggleSelection: (index: number) => void;
  onClearSelection: () => void;
  onDownloadFiles: (indices: number[]) => void;
}

function getTopLevelGroup(fileName: string): { key: string; name: string } {
  const segments = fileName.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.length > 1
    ? { key: `folder:${segments[0]}`, name: segments[0] }
    : { key: "root:", name: "根目录" };
}

function getBaseName(fileName: string): string {
  return fileName.replace(/\\/g, "/").split("/").filter(Boolean).pop() || fileName;
}

function getAsset(file: GalleryFile, kind: string): GalleryAsset | undefined {
  return file.assets.find((asset) => asset.kind === kind && asset.format === "webp" && asset.download_url)
    || file.assets.find((asset) => asset.kind === kind && asset.download_url);
}

function getPreviewAsset(file: GalleryFile): GalleryAsset | undefined {
  return getAsset(file, "original_preview")
    || getAsset(file, "thumbnail_960")
    || getAsset(file, "thumbnail_480")
    || getAsset(file, "preview_2048");
}

function getLightboxAsset(file: GalleryFile): GalleryAsset | undefined {
  return getAsset(file, "original_preview") || getAsset(file, "preview_2048");
}

function groupFiles(files: GalleryFile[]): GalleryGroup[] {
  const groups = new Map<string, GalleryGroup>();
  for (const file of files) {
    const descriptor = getTopLevelGroup(file.file_name);
    const current = groups.get(descriptor.key) || { ...descriptor, files: [] };
    current.files.push(file);
    groups.set(descriptor.key, current);
  }
  return Array.from(groups.values());
}

function toGalleryPhoto(file: GalleryFile, eager: boolean): GalleryPhoto {
  const asset = getPreviewAsset(file);
  const width = Math.max(1, file.width || asset?.width || 4);
  const height = Math.max(1, file.height || asset?.height || 3);
  const srcSet = asset?.kind === "original_preview" ? [] : [getAsset(file, "thumbnail_480"), getAsset(file, "thumbnail_960"), getAsset(file, "preview_2048")]
    .filter((item): item is GalleryAsset => Boolean(item))
    .map((item) => ({
      src: item.download_url,
      width: Math.max(1, item.width || width),
      height: Math.max(1, item.height || height),
    }));
  return {
    key: String(file.index),
    src: asset?.download_url || TRANSPARENT_PIXEL,
    srcSet,
    width,
    height,
    alt: file.file_name,
    file,
    asset,
    eager,
  };
}

export function ShareImageGallery({
  files,
  loading,
  downloading,
  selectedIndices,
  currentIndex,
  wechatMode,
  selectionEnabled,
  formatSize,
  onCurrentChange,
  onToggleSelection,
  onClearSelection,
  onDownloadFiles,
}: ShareImageGalleryProps) {
  const [openFileIndex, setOpenFileIndex] = useState<number | null>(null);
  const displayFiles = files.filter((file) => file.status !== "failed");
  const groups = groupFiles(displayFiles);
  const lightboxFiles = displayFiles.filter((file) => file.status === "ready" && Boolean(getLightboxAsset(file)));
  const lightboxIndex = openFileIndex === null ? -1 : lightboxFiles.findIndex((file) => file.index === openFileIndex);
  const currentFile = displayFiles.find((file) => file.index === currentIndex) || displayFiles.find((file) => file.status === "ready") || displayFiles[0];
  const currentGroup = currentFile ? getTopLevelGroup(currentFile.file_name) : { key: "root:", name: "根目录" };
  const currentGroupFiles = groups.find((group) => group.key === currentGroup.key)?.files || [];
  const selectionVisible = Boolean(selectionEnabled && currentFile && selectedIndices.size > 0);

  if (loading && files.length === 0) {
    return (
      <div className={styles.galleryLoading} role="status" aria-label="正在准备图片画廊" data-testid="gallery-loading">
        {Array.from({ length: 8 }, (_, index) => <div key={index} className={styles.gallerySkeleton} />)}
      </div>
    );
  }

  if (displayFiles.length === 0) {
    return (
      <div className={styles.emptyGallery} role="status">
        <ImageOff className="h-8 w-8" />
        <p>暂时没有可浏览的图片，原文件仍可在下方获取。</p>
      </div>
    );
  }

  return (
    <div className={`${styles.galleryRoot} ${selectedIndices.size > 0 ? styles.galleryRootSelectionActive : ""}`} data-testid="share-image-gallery">
      <div className={`${styles.selectionReveal} ${selectionVisible ? styles.selectionRevealVisible : ""}`} data-testid="gallery-selection-reveal">
        <div className={styles.selectionRevealInner}>
          {selectionVisible && currentFile && (
            <ShareGallerySelectionBar
              selectedCount={selectedIndices.size}
              currentGroupName={currentGroup.name}
              currentGroupCount={currentGroupFiles.length}
              downloading={downloading}
              onDownloadSelected={() => onDownloadFiles(Array.from(selectedIndices))}
              onDownloadGroup={() => onDownloadFiles(currentGroupFiles.map((file) => file.index))}
              onClearSelection={onClearSelection}
            />
          )}
        </div>
      </div>

      {groups.map((group) => {
        const readyCount = group.files.filter((file) => file.status === "ready").length;
        return (
          <section key={group.key} className={styles.galleryGroup} aria-labelledby={`gallery-group-${encodeURIComponent(group.key)}`} data-testid="gallery-group">
            <header className={styles.groupHeader}>
              <div className="min-w-0">
                <p className="retro-kicker">顶层目录</p>
                <h2 id={`gallery-group-${encodeURIComponent(group.key)}`} className={styles.groupTitle}>{group.name}</h2>
              </div>
              <span className={styles.groupCount}>{readyCount} / {group.files.length} 张就绪</span>
            </header>
            <RowsPhotoAlbum<GalleryPhoto>
              photos={group.files.map((file) => toGalleryPhoto(file, displayFiles.findIndex((item) => item.index === file.index) < 10))}
              spacing={(containerWidth) => containerWidth < 640 ? 6 : 10}
              padding={0}
              targetRowHeight={(containerWidth) => containerWidth < 640 ? 132 : containerWidth < 1024 ? 180 : 220}
              rowConstraints={{ singleRowMaxHeight: 260 }}
              sizes={{
                size: "min(33vw, 520px)",
                sizes: [
                  { viewport: "(max-width: 639px)", size: "calc(50vw - 19px)" },
                  { viewport: "(max-width: 1023px)", size: "calc(33vw - 24px)" },
                ],
              }}
              componentsProps={{
                container: { "aria-label": `${group.name}图片`, className: styles.album },
                wrapper: ({ photo }) => ({
                  className: `${styles.photoCard} ${selectedIndices.has(photo.file.index) ? styles.photoCardSelected : ""}`,
                  "data-status": photo.file.status,
                }),
                image: ({ photo }) => ({
                  loading: photo.eager ? "eager" : "lazy",
                  fetchPriority: photo.eager ? "high" : "auto",
                  decoding: "async",
                  referrerPolicy: "no-referrer",
                }),
              }}
              render={{
                image: (imageProps, { photo }) => {
                  const previewReady = photo.file.status === "ready" && photo.asset;
                  if (!previewReady) {
                    return (
                      <div {...imageProps} className={`${imageProps.className || ""} ${styles.photoPlaceholder}`}>
                        <Clock3 className={`h-7 w-7 ${styles.pendingIcon}`} />
                        <span>正在处理</span>
                      </div>
                    );
                  }
                  return (
                    // eslint-disable-next-line @next/next/no-img-element -- 画廊使用临时签名 URL，JPEG 可直接显示原图。
                    <img
                      {...imageProps}
                      alt={photo.file.file_name}
                      className={`${imageProps.className || ""} ${styles.photoImage}`}
                      onError={(event) => {
                        const backup = photo.asset?.backup_download_url;
                        if (backup && event.currentTarget.dataset.backup !== "true") {
                          event.currentTarget.dataset.backup = "true";
                          event.currentTarget.srcset = "";
                          event.currentTarget.src = backup;
                        } else {
                          event.currentTarget.dataset.failed = "true";
                        }
                      }}
                    />
                  );
                },
                extras: (_, { photo }) => {
                  const canOpen = photo.file.status === "ready" && Boolean(getLightboxAsset(photo.file));
                  const selected = selectedIndices.has(photo.file.index);
                  return (
                    <>
                      <button
                        type="button"
                        className={styles.photoOpenButton}
                        disabled={!canOpen}
                        aria-label={canOpen ? `在灯箱中查看 ${getBaseName(photo.file.file_name)}` : `${getBaseName(photo.file.file_name)}预览不可用`}
                        onClick={() => {
                          onCurrentChange(photo.file.index);
                          setOpenFileIndex(photo.file.index);
                        }}
                      />
                      {selectionEnabled && (
                        <button
                          type="button"
                          className={`${styles.photoSelectButton} ${selected ? styles.photoSelected : ""}`}
                          aria-label={selected ? `取消选择 ${getBaseName(photo.file.file_name)}` : `选择 ${getBaseName(photo.file.file_name)}`}
                          aria-pressed={selected}
                          onClick={() => {
                            onCurrentChange(photo.file.index);
                            onToggleSelection(photo.file.index);
                          }}
                        >
                          {selected && <Check className="h-4 w-4" aria-hidden="true" />}
                        </button>
                      )}
                      <div className={styles.photoCaption} aria-hidden="true">
                        <span>{getBaseName(photo.file.file_name)}</span>
                        <small>{formatSize(photo.file.file_size)}</small>
                      </div>
                    </>
                  );
                },
              }}
            />
          </section>
        );
      })}

      <ShareGalleryLightbox
        files={lightboxFiles}
        index={Math.max(0, lightboxIndex)}
        open={lightboxIndex >= 0}
        selectedIndices={selectedIndices}
        downloading={downloading}
        wechatMode={wechatMode}
        selectionEnabled={selectionEnabled}
        onClose={() => setOpenFileIndex(null)}
        onView={(nextIndex) => {
          const file = lightboxFiles[nextIndex];
          if (file) {
            setOpenFileIndex(file.index);
            onCurrentChange(file.index);
          }
        }}
        onToggleSelection={onToggleSelection}
        onDownloadFile={(index) => onDownloadFiles([index])}
      />
    </div>
  );
}
