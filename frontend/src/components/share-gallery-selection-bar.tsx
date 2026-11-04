"use client";

import { FolderDown, Images, X } from "lucide-react";
import styles from "./share-image-gallery.module.css";

interface ShareGallerySelectionBarProps {
  selectedCount: number;
  currentGroupName: string;
  currentGroupCount: number;
  downloading: boolean;
  onDownloadSelected: () => void;
  onDownloadGroup: () => void;
  onClearSelection: () => void;
}

export function ShareGallerySelectionBar({
  selectedCount,
  currentGroupName,
  currentGroupCount,
  downloading,
  onDownloadSelected,
  onDownloadGroup,
  onClearSelection,
}: ShareGallerySelectionBarProps) {
  return (
    <div className={styles.selectionBar} data-testid="gallery-selection-bar" aria-label="画廊下载操作">
      <div className={styles.selectionSummary}>
        <span className={styles.selectionCount}>已选 {selectedCount} 张</span>
        <span className={styles.selectionContext} title={currentGroupName}>当前分组：{currentGroupName}</span>
      </div>
      <div className={styles.selectionActions}>
        <button type="button" onClick={onDownloadSelected} disabled={downloading || selectedCount === 0} className={styles.selectionPrimaryAction}>
          <Images className="h-4 w-4" /> 下载已选
        </button>
        <button type="button" onClick={onDownloadGroup} disabled={downloading || currentGroupCount === 0} className={styles.selectionSecondaryAction} title={`下载 ${currentGroupName} 分组`}>
          <FolderDown className="h-4 w-4" /> <span>当前分组（{currentGroupCount}）</span>
        </button>
        <button type="button" onClick={onClearSelection} className={styles.clearButton} aria-label="清空已选图片">
          <X className="h-4 w-4" /> <span>清空</span>
        </button>
      </div>
    </div>
  );
}
