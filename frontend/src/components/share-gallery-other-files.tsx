"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Download, File, FileWarning } from "lucide-react";
import type { ShareFileInfo } from "@/lib/api";
import styles from "./share-image-gallery.module.css";

export interface ShareGalleryOtherFile {
  file: ShareFileInfo;
  reason: string;
  failed: boolean;
}

interface ShareGalleryOtherFilesProps {
  files: ShareGalleryOtherFile[];
  downloading: boolean;
  formatSize: (bytes: number) => string;
  onDownloadFile: (index: number) => void;
}

function getBaseName(fileName: string): string {
  return fileName.replace(/\\/g, "/").split("/").filter(Boolean).pop() || fileName;
}

function getExtension(fileName: string): string {
  const baseName = getBaseName(fileName);
  const dotIndex = baseName.lastIndexOf(".");
  return dotIndex >= 0 ? baseName.slice(dotIndex + 1).toUpperCase() : "FILE";
}

export function ShareGalleryOtherFiles({ files, downloading, formatSize, onDownloadFile }: ShareGalleryOtherFilesProps) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;

  const visibleFiles = expanded ? files : files.slice(0, 8);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);

  return (
    <section className={styles.otherFilesSection} aria-labelledby="gallery-other-files-title" data-testid="gallery-other-files">
      <header className={styles.otherFilesHeader}>
        <div className="min-w-0">
          <p className="retro-kicker">保留原文件</p>
          <h2 id="gallery-other-files-title" className={styles.otherFilesTitle}>其他文件</h2>
        </div>
        <span className={styles.otherFilesCount}>{files.length} 个文件</span>
      </header>

      <div className={styles.otherFilesGrid}>
        {visibleFiles.map(({ file, reason, failed }) => {
          const Icon = failed ? FileWarning : File;
          const baseName = getBaseName(file.file_name);
          return (
            <article key={file.index} className={styles.otherFileCard} data-failed={failed ? "true" : "false"}>
              <span className={styles.otherFileIcon} aria-hidden="true"><Icon /></span>
              <div className={styles.otherFileCopy}>
                <p title={file.file_name}>{baseName}</p>
                <span>{getExtension(file.file_name)} · {formatSize(file.file_size)} · {reason}</span>
              </div>
              <button type="button" onClick={() => onDownloadFile(file.index)} disabled={downloading} className={styles.otherFileDownload} aria-label={`下载原文件 ${baseName}`}>
                <Download aria-hidden="true" />
              </button>
            </article>
          );
        })}
      </div>

      {(hiddenCount > 0 || expanded) && (
        <button type="button" onClick={() => setExpanded((current) => !current)} className={styles.otherFilesExpand} aria-expanded={expanded}>
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          {expanded ? "收起其他文件" : `再显示 ${hiddenCount} 个文件`}
        </button>
      )}
    </section>
  );
}
