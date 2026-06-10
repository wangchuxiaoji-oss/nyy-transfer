"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Archive,
  Captions,
  Check,
  ChevronRight,
  Code2,
  Copy,
  Download,
  FileQuestion,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Info,
  Music,
  Package,
  Presentation,
  Search,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  DEFAULT_SHARE_TREE_LIMITS,
  createShareTreeModel,
  detectShareTreeDisplayMode,
  flattenVisibleShareTree,
  getAncestorPaths,
  getInitialExpandedPaths,
  getNodeByFileIndex,
  isShareFileDownload,
  searchShareTree,
  sortShareTreeNodes,
  type ShareTreeFile,
  type ShareTreeNode,
  type ShareTreeSortMode,
  type ShareTreeVisibleRow,
} from "@/lib/share-tree";
import {
  compactPath,
  getHighlightParts,
  getOverflowTreeDepth,
  getSearchSnippet,
  getVisualTreeDepth,
  splitNameForMiddleEllipsis,
} from "@/lib/share-name-display";
import type { ShareFileDownload } from "@/lib/api";

type RowRenderOptions = { depth?: number; treeRow?: ShareTreeVisibleRow; showPath?: boolean };

interface ShareFileBrowserProps {
  files: ShareTreeFile[];
  emptyDirs: string[];
  downloadsReady: boolean;
  selectedIndex: number;
  onSelectFile: (index: number) => void;
  onDownloadFile: (file: ShareFileDownload) => void;
  formatSize: (bytes: number) => string;
  variant: "desktop" | "mobile";
}

const SORT_OPTIONS: Array<{ value: ShareTreeSortMode; label: string }> = [
  { value: "name", label: "名称" },
  { value: "upload", label: "上传顺序" },
  { value: "size", label: "大小" },
  { value: "type", label: "类型" },
];

const TREE_MAX_VISUAL_DEPTH = 7;

type FileBadgeTone = "video" | "audio" | "image" | "pdf" | "document" | "sheet" | "deck" | "code" | "archive" | "installer" | "subtitle" | "unknown";

const FILE_BADGE_TONES: Record<FileBadgeTone, { badge: string; glow: string; icon: LucideIcon }> = {
  video: { badge: "from-[#49323a] via-[#8a4d4f] to-[#c97755]", glow: "shadow-[0_0_18px_rgba(201,119,85,0.12)]", icon: Film },
  audio: { badge: "from-[#27423f] via-[#3f766d] to-[#72a997]", glow: "shadow-[0_0_18px_rgba(114,169,151,0.10)]", icon: Music },
  image: { badge: "from-[#2e4052] via-[#546f8b] to-[#8e87b6]", glow: "shadow-[0_0_18px_rgba(142,172,208,0.10)]", icon: ImageIcon },
  pdf: { badge: "from-[#4e2c32] via-[#94515a] to-[#d48772]", glow: "shadow-[0_0_18px_rgba(212,135,114,0.11)]", icon: FileText },
  document: { badge: "from-[#293a55] via-[#4e678d] to-[#7f9fc4]", glow: "shadow-[0_0_18px_rgba(127,159,196,0.10)]", icon: FileText },
  sheet: { badge: "from-[#2d4534] via-[#54785b] to-[#93ad7d]", glow: "shadow-[0_0_18px_rgba(147,173,125,0.10)]", icon: FileSpreadsheet },
  deck: { badge: "from-[#56382f] via-[#97634f] to-[#d7a06d]", glow: "shadow-[0_0_18px_rgba(215,160,109,0.10)]", icon: Presentation },
  code: { badge: "from-[#32354f] via-[#5a5f89] to-[#8e92bd]", glow: "shadow-[0_0_18px_rgba(142,146,189,0.10)]", icon: Code2 },
  archive: { badge: "from-[#54452c] via-[#92764a] to-[#d6b06f]", glow: "shadow-[0_0_18px_rgba(214,176,111,0.10)]", icon: Archive },
  installer: { badge: "from-[#354532] via-[#687d58] to-[#a7b878]", glow: "shadow-[0_0_18px_rgba(167,184,120,0.09)]", icon: Package },
  subtitle: { badge: "from-[#3e3654] via-[#6d5d8e] to-[#a991c0]", glow: "shadow-[0_0_18px_rgba(169,145,192,0.10)]", icon: Captions },
  unknown: { badge: "from-[#343940] via-[#525a63] to-[#7c858e]", glow: "shadow-[0_0_18px_rgba(255,255,255,0.06)]", icon: FileQuestion },
};

const FOLDER_BADGE_TONE = {
  badge: "from-[#54452c] via-[#92764a] to-[#d6b06f]",
  glow: "shadow-[0_0_18px_rgba(214,176,111,0.10)]",
};

function getNodeDomId(node: ShareTreeNode): string {
  return encodeURIComponent(node.id);
}

function getNodeDomIdFromId(nodeId: string): string {
  return encodeURIComponent(nodeId);
}

function getFileExtension(fileName: string): string {
  return fileName.split(".").pop()?.toLowerCase() || "";
}

function getFileBadgeTone(fileName: string): FileBadgeTone {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";
  if (["mp4", "mkv", "mov", "webm", "avi", "wmv", "m4v"].includes(ext)) return "video";
  if (["mp3", "flac", "wav", "aac", "m4a", "ogg"].includes(ext)) return "audio";
  if (["jpg", "jpeg", "png", "webp", "gif", "svg", "avif", "bmp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "document";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "sheet";
  if (["ppt", "pptx", "key"].includes(ext)) return "deck";
  if (["txt", "md", "json", "xml", "yml", "yaml", "log", "ini"].includes(ext)) return "code";
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext)) return "archive";
  if (["exe", "msi", "apk", "dmg", "pkg", "iso"].includes(ext)) return "installer";
  if (["srt", "ass", "ssa", "vtt"].includes(ext)) return "subtitle";
  return "unknown";
}

function getFileBadgeLabel(fileName: string): string {
  const ext = getFileExtension(fileName);
  if (!ext || ext === fileName.toLowerCase()) return "…";
  if (ext === "json") return "{}";
  if (ext === "xml") return "<>";
  return ext.length > 4 ? ext.slice(0, 4).toUpperCase() : ext.toUpperCase();
}

function getDirectorySummary(node: ShareTreeNode, formatSize: (bytes: number) => string): string {
  if (node.type !== "directory") return "";
  if (node.totalFileCount === 0 && node.totalDirCount === 0) return "空文件夹";
  return [
    `${node.totalFileCount} 个文件`,
    node.totalDirCount > 0 ? `${node.totalDirCount} 个文件夹` : "",
    node.totalBytes > 0 ? formatSize(node.totalBytes) : "",
  ].filter(Boolean).join(" · ");
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("button,input,select,textarea,a"));
}

async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.setSelectionRange(0, text.length);
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

function HighlightedText({ value, query }: { value: string; query: string }) {
  return <>{getHighlightParts(value, query).map((part, index) => part.match ? <mark key={index} className="rounded bg-yc-accent/25 px-0.5 text-yc-accent">{part.text}</mark> : <span key={index}>{part.text}</span>)}</>;
}

function MiddleEllipsisText({ value, query = "", searchSnippet = false }: { value: string; query?: string; searchSnippet?: boolean }) {
  const displayValue = searchSnippet ? getSearchSnippet(value, query) : value;
  const parts = splitNameForMiddleEllipsis(displayValue);
  if (!parts.truncated) return <span className="block truncate"><HighlightedText value={displayValue} query={query} /></span>;

  return (
    <span className="flex min-w-0 max-w-full items-baseline" aria-label={value}>
      <span className="min-w-0 truncate"><HighlightedText value={parts.head} query={query} /></span>
      <span className="shrink-0 px-0.5 text-[var(--yc-text-t)]" aria-hidden="true">…</span>
      <span className="max-w-[58%] shrink-0 truncate text-right"><HighlightedText value={parts.tail} query={query} /></span>
    </span>
  );
}

function getNodeKindLabel(node: ShareTreeNode): string {
  return node.type === "directory" ? "文件夹" : "文件";
}

export function ShareFileBrowser({ files, emptyDirs, downloadsReady, selectedIndex, onSelectFile, onDownloadFile, formatSize, variant }: ShareFileBrowserProps) {
  const model = useMemo(() => createShareTreeModel(files, emptyDirs), [emptyDirs, files]);
  const detectedMode = useMemo(() => detectShareTreeDisplayMode(model), [model]);
  const [sortMode, setSortMode] = useState<ShareTreeSortMode>("name");
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => getInitialExpandedPaths(model, detectedMode));
  const [visibleLimit, setVisibleLimit] = useState(DEFAULT_SHARE_TREE_LIMITS.virtualizeVisibleNodeCount);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [pendingFocusNodeId, setPendingFocusNodeId] = useState<string | null>(null);
  const [detailNode, setDetailNode] = useState<ShareTreeNode | null>(null);
  const [copiedDetailKey, setCopiedDetailKey] = useState<string | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const treeRef = useRef<HTMLDivElement | null>(null);

  const sortedRoots = useMemo(() => sortShareTreeNodes(model.roots, sortMode), [model.roots, sortMode]);
  const selectedNode = useMemo(() => getNodeByFileIndex(model, selectedIndex), [model, selectedIndex]);
  const visibleRows = useMemo(() => flattenVisibleShareTree(sortedRoots, expandedPaths), [expandedPaths, sortedRoots]);
  const searchResults = useMemo(() => searchShareTree(sortedRoots, query, 500), [query, sortedRoots]);
  const hasQuery = query.trim().length > 0;
  const showFilters = variant === "desktop" || mobileFiltersOpen || hasQuery;

  useEffect(() => {
    setExpandedPaths(getInitialExpandedPaths(model, detectedMode));
    setFocusedNodeId(null);
    setPendingFocusNodeId(null);
    setDetailNode(null);
    setMobileFiltersOpen(false);
    setVisibleLimit(DEFAULT_SHARE_TREE_LIMITS.virtualizeVisibleNodeCount);
  }, [detectedMode, model, model.signature]);

  useEffect(() => {
    setVisibleLimit(DEFAULT_SHARE_TREE_LIMITS.virtualizeVisibleNodeCount);
  }, [query, sortMode]);

  useEffect(() => {
    if (!copiedDetailKey) return;
    const timeout = window.setTimeout(() => setCopiedDetailKey(null), 1400);
    return () => window.clearTimeout(timeout);
  }, [copiedDetailKey]);

  useEffect(() => {
    if (!selectedNode) return;
    const ancestors = getAncestorPaths(selectedNode.path);
    if (ancestors.length === 0) return;
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      ancestors.forEach((path) => next.add(path));
      return next;
    });
  }, [selectedNode]);

  useEffect(() => {
    if (!pendingFocusNodeId || hasQuery) return;
    const rowIndex = visibleRows.findIndex((row) => row.node.id === pendingFocusNodeId);
    if (rowIndex < 0) return;
    if (rowIndex >= visibleLimit) {
      const chunk = DEFAULT_SHARE_TREE_LIMITS.virtualizeVisibleNodeCount;
      setVisibleLimit(Math.ceil((rowIndex + 1) / chunk) * chunk);
      return;
    }
    focusTreeRow(pendingFocusNodeId, true);
    setPendingFocusNodeId(null);
  }, [hasQuery, pendingFocusNodeId, visibleLimit, visibleRows]);

  const focusTreeRow = (nodeId: string, scrollIntoView = false) => {
    setFocusedNodeId(nodeId);
    window.requestAnimationFrame(() => {
      const target = treeRef.current?.querySelector<HTMLElement>(`[data-share-tree-row="${getNodeDomIdFromId(nodeId)}"]`);
      if (scrollIntoView) target?.scrollIntoView({ block: "nearest", inline: "nearest" });
      target?.focus();
    });
  };

  const toggleDirectory = (path: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) return;
    if (hasQuery || visibleRows.length === 0) return;
    const fallbackId = selectedNode?.id || visibleRows[0]?.node.id || null;
    const activeId = focusedNodeId || fallbackId;
    const activeIndex = Math.max(0, visibleRows.findIndex((row) => row.node.id === activeId));
    const activeRow = visibleRows[activeIndex];
    if (!activeRow) return;

    const focusByIndex = (index: number) => {
      const nextRow = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, index))];
      if (nextRow) focusTreeRow(nextRow.node.id);
    };

    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusByIndex(activeIndex + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusByIndex(activeIndex - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusByIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusByIndex(visibleRows.length - 1);
      return;
    }
    if (event.key === "ArrowRight" && activeRow.node.type === "directory") {
      event.preventDefault();
      if (!expandedPaths.has(activeRow.node.path)) toggleDirectory(activeRow.node.path);
      else focusByIndex(activeIndex + 1);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (activeRow.node.type === "directory" && expandedPaths.has(activeRow.node.path)) {
        toggleDirectory(activeRow.node.path);
        return;
      }
      if (activeRow.node.parentPath) {
        const parentRow = visibleRows.find((row) => row.node.type === "directory" && row.node.path === activeRow.node.parentPath);
        if (parentRow) focusTreeRow(parentRow.node.id);
      }
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (activeRow.node.type === "directory") toggleDirectory(activeRow.node.path);
      else onSelectFile(activeRow.node.fileIndex);
    }
  };

  const handleNodeAction = (node: ShareTreeNode, options: { fromSearch?: boolean } = {}) => {
    if (node.type === "directory") {
      if (options.fromSearch) {
        setExpandedPaths((previous) => {
          const next = new Set(previous);
          getAncestorPaths(node.path).forEach((path) => next.add(path));
          next.add(node.path);
          return next;
        });
        setQuery("");
        setPendingFocusNodeId(node.id);
        return;
      }
      toggleDirectory(node.path);
      return;
    }
    onSelectFile(node.fileIndex);
    if (options.fromSearch) {
      setExpandedPaths((previous) => {
        const next = new Set(previous);
        getAncestorPaths(node.path).forEach((path) => next.add(path));
        return next;
      });
      setQuery("");
      setPendingFocusNodeId(node.id);
    }
  };

  const openDetail = (node: ShareTreeNode) => {
    setDetailNode(node);
    setCopiedDetailKey(null);
  };

  const copyDetailValue = async (key: string, value: string) => {
    await copyText(value);
    setCopiedDetailKey(key);
  };

  const renderFileBadge = (fileName: string) => {
    const tone = FILE_BADGE_TONES[getFileBadgeTone(fileName)];
    const Icon = tone.icon;
    return (
      <div className={`relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-gradient-to-br ${tone.badge} ${tone.glow}`}>
        <div className="absolute inset-px rounded-[0.45rem] bg-black/10" />
        <Icon className="absolute left-1/2 top-1.5 h-4 w-4 -translate-x-1/2 text-white/92" />
        <span className="absolute inset-x-1 bottom-1 rounded bg-black/38 px-0.5 text-center font-tech text-[7px] font-black leading-[10px] text-white/92 backdrop-blur-sm">
          {getFileBadgeLabel(fileName)}
        </span>
      </div>
    );
  };

  const renderFolderBadge = (isOpen: boolean) => {
    const Icon = isOpen ? FolderOpen : Folder;
    return (
      <div className={`relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg bg-gradient-to-br ${FOLDER_BADGE_TONE.badge} ${FOLDER_BADGE_TONE.glow}`}>
        <div className="absolute inset-px rounded-[0.45rem] bg-black/10" />
        <Icon className="relative h-5 w-5 text-white/92" />
      </div>
    );
  };

  const renderDownloadButton = (node: ShareTreeNode) => {
    if (node.type !== "file" || !downloadsReady || !isShareFileDownload(node.file)) return null;
    const downloadFile = node.file;
    return (
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); onDownloadFile(downloadFile); }}
        onKeyDown={(event) => event.stopPropagation()}
        className="retro-icon-button h-11 w-11"
        title="下载此文件"
        aria-label={`下载 ${downloadFile.file_name}`}
      >
        <Download className="h-3.5 w-3.5" />
      </button>
    );
  };

  const renderDetailButton = (node: ShareTreeNode) => (
    <button
      type="button"
      onClick={(event) => { event.stopPropagation(); openDetail(node); }}
      onKeyDown={(event) => event.stopPropagation()}
      className="retro-icon-button h-11 w-11"
      title={`查看${getNodeKindLabel(node)}详情`}
      aria-label={`查看 ${node.name} 详情`}
    >
      <Info className="h-3.5 w-3.5" />
    </button>
  );

  const renderNodeRow = (node: ShareTreeNode, options: RowRenderOptions = {}) => {
    const isDirectory = node.type === "directory";
    const isExpanded = isDirectory && expandedPaths.has(node.path);
    const isSelected = node.type === "file" && node.fileIndex === selectedIndex;
    const isTreeRow = Boolean(options.treeRow);
    const isSearchRow = Boolean(options.showPath);
    const showDirectoryOpenState = isDirectory && isExpanded;
    const depth = options.depth ?? 0;
    const visualDepth = getVisualTreeDepth(depth, TREE_MAX_VISUAL_DEPTH);
    const overflowDepth = getOverflowTreeDepth(depth, TREE_MAX_VISUAL_DEPTH);
    const indentStep = variant === "mobile" ? 10 : 16;
    const paddingLeft = 10 + visualDepth * indentStep;
    const rowId = getNodeDomId(node);
    const isFirstTreeRow = options.treeRow?.ariaLevel === 1 && options.treeRow.ariaPosInSet === 1;
    const rowClass = isSelected
      ? "border-yc-accent bg-[rgba(255,138,61,0.12)] shadow-[0_0_20px_rgba(255,138,61,0.25)]"
      : "border-white/[0.08] bg-white/[0.03] hover:border-yc-accent hover:bg-white/[0.06]";
    const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
      if (isTreeRow || isInteractiveTarget(event.target)) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      handleNodeAction(node, { fromSearch: isSearchRow });
    };

    return (
      <div
        key={`${node.id}-${options.showPath ? "search" : "row"}`}
        role={options.treeRow ? "treeitem" : "button"}
        aria-expanded={options.treeRow && isDirectory ? isExpanded : undefined}
        aria-selected={options.treeRow && node.type === "file" ? isSelected : undefined}
        aria-level={options.treeRow?.ariaLevel}
        aria-posinset={options.treeRow?.ariaPosInSet}
        aria-setsize={options.treeRow?.ariaSetSize}
        tabIndex={options.treeRow ? (focusedNodeId === node.id || (!focusedNodeId && (isSelected || isFirstTreeRow)) ? 0 : -1) : 0}
        data-share-tree-row={rowId}
        onFocus={() => { if (options.treeRow) setFocusedNodeId(node.id); }}
        onKeyDown={handleRowKeyDown}
        onClick={() => handleNodeAction(node, { fromSearch: isSearchRow })}
        className={`group flex min-w-0 cursor-pointer items-center gap-2 rounded-lg border py-2.5 pr-2 transition-all ${rowClass}`}
        style={{ paddingLeft }}
      >
        {isDirectory ? (
          <>
            <ChevronRight className={`h-4 w-4 shrink-0 text-[#d6b06f] transition-transform ${showDirectoryOpenState ? "rotate-90" : ""}`} />
            {renderFolderBadge(showDirectoryOpenState)}
          </>
        ) : (
          <>
            <span className="w-4 shrink-0" aria-hidden="true" />
            {renderFileBadge(node.file.file_name)}
          </>
        )}
        {overflowDepth > 0 && (
          <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-tech text-[9px] text-[var(--yc-text-t)]" title={`实际层级深度 ${depth + 1}`}>
            +{overflowDepth}
          </span>
        )}
        <div className="min-w-0 flex-1 text-left">
          <p className="min-w-0 text-sm font-medium" title={node.path} aria-label={node.name}>
            <MiddleEllipsisText value={node.name} query={hasQuery ? query : ""} searchSnippet={isSearchRow} />
          </p>
          <p className="mt-0.5 truncate font-tech text-[10px] text-[var(--yc-text-t)]">
            {isDirectory ? getDirectorySummary(node, formatSize) : options.showPath && node.parentPath ? <HighlightedText value={compactPath(getSearchSnippet(node.parentPath, query), 5)} query={query} /> : formatSize(node.totalBytes)}
          </p>
        </div>
        {!isDirectory && !options.showPath && <span className="shrink-0 font-tech text-[10px] text-[var(--yc-text-t)]">{formatSize(node.totalBytes)}</span>}
        {renderDetailButton(node)}
        {renderDownloadButton(node)}
      </div>
    );
  };

  const renderShowMore = (total: number) => total > visibleLimit ? (
    <button
      type="button"
      onClick={() => setVisibleLimit((value) => value + DEFAULT_SHARE_TREE_LIMITS.virtualizeVisibleNodeCount)}
      className="retro-text-button min-h-[44px] w-full py-2 font-tech text-[11px] tracking-widest"
    >
      显示更多（剩余 {total - visibleLimit} 项）
    </button>
  ) : null;

  const renderSearchResults = () => {
    const results = searchResults.slice(0, visibleLimit);
    return (
      <div className="flex flex-col gap-1.5">
        {results.length === 0 ? (
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-5 text-center text-xs text-[var(--yc-text-t)]">没有匹配的文件或文件夹</div>
        ) : results.map((result) => renderNodeRow(result.node, { showPath: true }))}
        {renderShowMore(searchResults.length)}
      </div>
    );
  };

  const renderTree = () => {
    const rows = visibleRows.slice(0, visibleLimit);
    return (
      <div ref={treeRef} role="tree" aria-label="分享文件树" onKeyDown={handleTreeKeyDown} className="flex flex-col gap-1.5">
        {rows.length === 0 ? (
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-5 text-center text-xs text-[var(--yc-text-t)]">没有文件</div>
        ) : rows.map((row) => renderNodeRow(row.node, { depth: row.depth, treeRow: row }))}
        {renderShowMore(visibleRows.length)}
      </div>
    );
  };

  const summary = [
    `${model.stats.totalFiles} 个文件`,
    model.stats.totalDirectories > 0 ? `${model.stats.totalDirectories} 个文件夹` : "",
  ].filter(Boolean).join(" · ");

  const renderDetailModal = () => {
    if (!detailNode) return null;
    const kindLabel = getNodeKindLabel(detailNode);
    const fullPath = detailNode.path;
    const parentPath = detailNode.parentPath || "全部文件";
    const depthLabel = `${detailNode.depth + 1} 层`;
    const extensionLabel = detailNode.type === "file" ? (detailNode.extension || "无扩展名") : "文件夹";
    const summaryLabel = detailNode.type === "directory" ? getDirectorySummary(detailNode, formatSize) : formatSize(detailNode.totalBytes);
    const CopyButton = ({ copyKey, value, label }: { copyKey: string; value: string; label: string }) => {
      const copied = copiedDetailKey === copyKey;
      const Icon = copied ? Check : Copy;
      return (
        <button type="button" onClick={() => { void copyDetailValue(copyKey, value); }} className="retro-btn-secondary min-h-[44px] px-3 py-2 text-xs">
          <Icon className="h-3.5 w-3.5" /> {copied ? "已复制" : label}
        </button>
      );
    };

    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
        <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={() => setDetailNode(null)} />
        <div role="dialog" aria-modal="true" aria-labelledby="share-file-detail-title" className="retro-panel-strong relative max-h-[88dvh] w-full overflow-y-auto rounded-t-2xl p-5 sm:max-w-lg sm:rounded-2xl sm:p-6">
          <button type="button" onClick={() => setDetailNode(null)} aria-label="关闭文件详情" className="retro-close-button absolute right-4 top-4">
            <X className="h-4 w-4" />
          </button>
          <div className="pr-10">
            <p className="font-tech text-[10px] font-bold tracking-[0.22em] text-yc-accent">{kindLabel}详情</p>
            <h2 id="share-file-detail-title" className="mt-2 break-words text-base font-bold leading-6 text-[color:var(--yc-text)]">{detailNode.name}</h2>
          </div>
          <div className="mt-5 grid gap-3">
            <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-3">
              <span className="block font-tech text-[10px] tracking-widest text-[var(--yc-text-t)]">完整路径</span>
              <p className="mt-1 break-all font-tech text-xs leading-5 text-[color:var(--yc-text)]">{fullPath}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-3">
                <span className="block font-tech text-[10px] tracking-widest text-[var(--yc-text-t)]">父目录</span>
                <p className="mt-1 break-all text-xs leading-5 text-[color:var(--yc-text)]">{parentPath}</p>
              </div>
              <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-3">
                <span className="block font-tech text-[10px] tracking-widest text-[var(--yc-text-t)]">属性</span>
                <p className="mt-1 text-xs leading-5 text-[color:var(--yc-text)]">{extensionLabel} · {summaryLabel} · {depthLabel}</p>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <CopyButton copyKey="path" value={fullPath} label="复制完整路径" />
              <CopyButton copyKey="name" value={detailNode.name} label="复制文件名" />
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span className="block font-tech text-[11px] tracking-[0.1em] text-[var(--yc-text-t)]">文件列表</span>
          <span className="mt-1 block truncate font-tech text-[10px] text-[var(--yc-text-t)]">{summary}</span>
        </div>
        {variant === "mobile" && (
          <button
            type="button"
            onClick={() => setMobileFiltersOpen((open) => !open)}
            className="retro-btn-secondary min-h-[44px] shrink-0 px-3 text-xs"
            aria-expanded={showFilters}
          >
            <Search className="h-3.5 w-3.5" />筛选文件
          </button>
        )}
      </div>

      {showFilters && (
        <div className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <label className="relative block min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--yc-text-t)]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件名、扩展名或路径..."
              className="retro-input h-11 w-full pl-9 pr-10 text-xs"
              aria-label="搜索文件名、扩展名或路径"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="retro-icon-button absolute right-0 top-1/2 h-11 w-11 -translate-y-1/2" aria-label="清空搜索">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          <select
            value={sortMode}
            onChange={(event) => setSortMode(event.target.value as ShareTreeSortMode)}
            className="retro-input h-11 w-full px-3 text-xs"
            aria-label="文件排序"
          >
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>按{option.label}</option>)}
          </select>
        </div>
      )}

      {hasQuery ? renderSearchResults() : renderTree()}

      {detectedMode === "explorer" && !hasQuery && variant === "desktop" && (
        <p className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[11px] leading-5 text-[var(--yc-text-t)]">
          目录较大，已保留树形视图；可展开目录或使用搜索快速定位文件。
        </p>
      )}
      {renderDetailModal()}
    </div>
  );
}
