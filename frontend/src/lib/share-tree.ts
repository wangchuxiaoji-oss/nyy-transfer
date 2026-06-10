import type { ShareFileDownload, ShareFileInfo } from "./api";

export type ShareTreeFile = ShareFileInfo | ShareFileDownload;
export type ShareTreeSortMode = "upload" | "name" | "size" | "type";
export type ShareTreeDisplayMode = "single-file" | "flat-list" | "expanded-tree" | "smart-tree" | "explorer";

export interface ShareTreeDisplayLimits {
  expandAllMaxNodes: number;
  expandAllMaxDepth: number;
  smartTreeMaxNodes: number;
  heavyDirectoryChildCount: number;
  virtualizeVisibleNodeCount: number;
  autoExpandSingleChainMaxDepth: number;
}

export const DEFAULT_SHARE_TREE_LIMITS: ShareTreeDisplayLimits = {
  expandAllMaxNodes: 50,
  expandAllMaxDepth: 3,
  smartTreeMaxNodes: 180,
  heavyDirectoryChildCount: 50,
  virtualizeVisibleNodeCount: 200,
  autoExpandSingleChainMaxDepth: 4,
};

interface ShareTreeNodeBase {
  id: string;
  name: string;
  path: string;
  depth: number;
  parentPath: string | null;
  originalOrder: number;
  directFileCount: number;
  directDirCount: number;
  totalFileCount: number;
  totalDirCount: number;
  totalBytes: number;
  explicitEmpty: boolean;
}

export interface ShareTreeFileNode extends ShareTreeNodeBase {
  type: "file";
  file: ShareTreeFile;
  fileIndex: number;
  extension: string;
}

export interface ShareTreeDirectoryNode extends ShareTreeNodeBase {
  type: "directory";
  children: ShareTreeNode[];
}

export type ShareTreeNode = ShareTreeDirectoryNode | ShareTreeFileNode;

export interface ShareTreeStats {
  totalFiles: number;
  totalDirectories: number;
  totalNodes: number;
  emptyDirCount: number;
  maxDepth: number;
  maxChildren: number;
  rootFileCount: number;
  rootDirectoryCount: number;
  hasDirectories: boolean;
  singleRootDirectoryPath: string | null;
}

export interface ShareTreeModel {
  roots: ShareTreeNode[];
  directories: ShareTreeDirectoryNode[];
  files: ShareTreeFileNode[];
  directoryMap: Map<string, ShareTreeDirectoryNode>;
  stats: ShareTreeStats;
  signature: string;
}

export interface ShareTreeVisibleRow {
  node: ShareTreeNode;
  depth: number;
  ariaLevel: number;
  ariaPosInSet: number;
  ariaSetSize: number;
}

export interface ShareTreeSearchResult {
  node: ShareTreeNode;
  ancestorLabel: string;
}

export function splitSharePath(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter((part) => part.length > 0);
}

export function normalizeSharePath(path: string): string {
  return splitSharePath(path).join("/");
}

export function getSharePathBaseName(path: string): string {
  const parts = splitSharePath(path);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function getShareFileExtension(path: string): string {
  const baseName = getSharePathBaseName(path);
  const dotIndex = baseName.lastIndexOf(".");
  return dotIndex >= 0 ? baseName.slice(dotIndex + 1).toLowerCase() : "";
}

export function isShareFileDownload(file: ShareTreeFile): file is ShareFileDownload {
  return "download_url" in file && "chunks" in file;
}

function createDirectoryNode(path: string, name: string, depth: number, parentPath: string | null, order: number): ShareTreeDirectoryNode {
  return {
    id: `dir:${path}`,
    type: "directory",
    name,
    path,
    depth,
    parentPath,
    originalOrder: order,
    directFileCount: 0,
    directDirCount: 0,
    totalFileCount: 0,
    totalDirCount: 0,
    totalBytes: 0,
    explicitEmpty: false,
    children: [],
  };
}

function createFileNode(file: ShareTreeFile, fileIndex: number, path: string, name: string, depth: number, parentPath: string | null): ShareTreeFileNode {
  return {
    id: `file:${fileIndex}:${path}`,
    type: "file",
    name,
    path,
    depth,
    parentPath,
    originalOrder: fileIndex,
    directFileCount: 0,
    directDirCount: 0,
    totalFileCount: 1,
    totalDirCount: 0,
    totalBytes: file.file_size,
    explicitEmpty: false,
    file,
    fileIndex,
    extension: getShareFileExtension(path),
  };
}

function updateDirectoryOrder(directory: ShareTreeDirectoryNode, order: number) {
  if (order < directory.originalOrder) directory.originalOrder = order;
}

function getOrCreateDirectory(params: {
  path: string;
  name: string;
  depth: number;
  parentPath: string | null;
  order: number;
  siblings: ShareTreeNode[];
  directoryMap: Map<string, ShareTreeDirectoryNode>;
  directories: ShareTreeDirectoryNode[];
}) {
  const existing = params.directoryMap.get(params.path);
  if (existing) {
    updateDirectoryOrder(existing, params.order);
    return existing;
  }

  const directory = createDirectoryNode(params.path, params.name, params.depth, params.parentPath, params.order);
  params.directoryMap.set(params.path, directory);
  params.directories.push(directory);
  params.siblings.push(directory);
  return directory;
}

function computeNodeStats(node: ShareTreeNode): { maxDepth: number; maxChildren: number; originalOrder: number } {
  if (node.type === "file") {
    return { maxDepth: node.depth, maxChildren: 0, originalOrder: node.originalOrder };
  }

  node.directFileCount = node.children.filter((child) => child.type === "file").length;
  node.directDirCount = node.children.filter((child) => child.type === "directory").length;
  node.totalFileCount = 0;
  node.totalDirCount = node.directDirCount;
  node.totalBytes = 0;

  let maxDepth = node.depth;
  let maxChildren = node.children.length;
  let originalOrder = node.originalOrder;

  node.children.forEach((child) => {
    const childStats = computeNodeStats(child);
    node.totalFileCount += child.totalFileCount;
    node.totalBytes += child.totalBytes;
    if (child.type === "directory") node.totalDirCount += child.totalDirCount;
    maxDepth = Math.max(maxDepth, childStats.maxDepth);
    maxChildren = Math.max(maxChildren, childStats.maxChildren);
    originalOrder = Math.min(originalOrder, childStats.originalOrder);
  });

  node.originalOrder = originalOrder;
  return { maxDepth, maxChildren, originalOrder };
}

export function createShareTreeModel(files: ShareTreeFile[], emptyDirs: string[]): ShareTreeModel {
  const roots: ShareTreeNode[] = [];
  const directories: ShareTreeDirectoryNode[] = [];
  const fileNodes: ShareTreeFileNode[] = [];
  const directoryMap = new Map<string, ShareTreeDirectoryNode>();

  files.forEach((file, fileIndex) => {
    const parts = splitSharePath(file.file_name);
    const fileName = parts.pop() || file.file_name || `文件 ${fileIndex + 1}`;
    let siblings = roots;
    let parentPath: string | null = null;
    let currentPath = "";

    parts.forEach((part, depth) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const directory = getOrCreateDirectory({
        path: currentPath,
        name: part,
        depth,
        parentPath,
        order: fileIndex,
        siblings,
        directoryMap,
        directories,
      });
      siblings = directory.children;
      parentPath = directory.path;
    });

    const filePath = parentPath ? `${parentPath}/${fileName}` : fileName;
    const fileNode = createFileNode(file, fileIndex, filePath, fileName, parts.length, parentPath);
    siblings.push(fileNode);
    fileNodes.push(fileNode);
  });

  emptyDirs.forEach((rawDir, emptyIndex) => {
    const parts = splitSharePath(rawDir);
    if (parts.length === 0) return;

    let siblings = roots;
    let parentPath: string | null = null;
    let currentPath = "";
    const order = files.length + emptyIndex;

    parts.forEach((part, depth) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const directory = getOrCreateDirectory({
        path: currentPath,
        name: part,
        depth,
        parentPath,
        order,
        siblings,
        directoryMap,
        directories,
      });
      siblings = directory.children;
      parentPath = directory.path;
    });

    const emptyDirectory = directoryMap.get(currentPath);
    if (emptyDirectory) emptyDirectory.explicitEmpty = true;
  });

  let maxDepth = 0;
  let maxChildren = roots.length;
  roots.forEach((root) => {
    const nodeStats = computeNodeStats(root);
    maxDepth = Math.max(maxDepth, nodeStats.maxDepth);
    maxChildren = Math.max(maxChildren, nodeStats.maxChildren);
  });

  const explicitEmptyDirCount = directories.filter((directory) => directory.explicitEmpty).length;
  const rootFileCount = roots.filter((node) => node.type === "file").length;
  const rootDirectoryCount = roots.filter((node) => node.type === "directory").length;
  const singleRootDirectoryPath = rootDirectoryCount === 1 && rootFileCount === 0
    ? (roots.find((node): node is ShareTreeDirectoryNode => node.type === "directory")?.path || null)
    : null;
  const signature = [
    files.map((file) => normalizeSharePath(file.file_name)).join("|"),
    emptyDirs.map(normalizeSharePath).join("|"),
  ].join("::");

  return {
    roots,
    directories,
    files: fileNodes,
    directoryMap,
    signature,
    stats: {
      totalFiles: files.length,
      totalDirectories: directories.length,
      totalNodes: files.length + directories.length,
      emptyDirCount: explicitEmptyDirCount,
      maxDepth,
      maxChildren,
      rootFileCount,
      rootDirectoryCount,
      hasDirectories: directories.length > 0,
      singleRootDirectoryPath,
    },
  };
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, "zh-CN", { numeric: true, sensitivity: "base" });
}

function compareFolderFirst(left: ShareTreeNode, right: ShareTreeNode): number {
  if (left.type === right.type) return 0;
  return left.type === "directory" ? -1 : 1;
}

function compareNodes(left: ShareTreeNode, right: ShareTreeNode, sortMode: ShareTreeSortMode): number {
  if (sortMode === "upload") return left.originalOrder - right.originalOrder || naturalCompare(left.name, right.name);

  const folderCompare = compareFolderFirst(left, right);
  if (folderCompare !== 0) return folderCompare;

  if (sortMode === "size") {
    return right.totalBytes - left.totalBytes || naturalCompare(left.name, right.name);
  }

  if (sortMode === "type") {
    const leftType = left.type === "directory" ? "" : left.extension;
    const rightType = right.type === "directory" ? "" : right.extension;
    return naturalCompare(leftType, rightType) || naturalCompare(left.name, right.name);
  }

  return naturalCompare(left.name, right.name);
}

export function sortShareTreeNodes(nodes: ShareTreeNode[], sortMode: ShareTreeSortMode): ShareTreeNode[] {
  return nodes
    .map((node): ShareTreeNode => node.type === "directory" ? { ...node, children: sortShareTreeNodes(node.children, sortMode) } : { ...node })
    .sort((left, right) => compareNodes(left, right, sortMode));
}

export function detectShareTreeDisplayMode(model: ShareTreeModel, limits: ShareTreeDisplayLimits = DEFAULT_SHARE_TREE_LIMITS): ShareTreeDisplayMode {
  if (model.stats.totalFiles === 1 && model.stats.emptyDirCount === 0) return "single-file";
  if (!model.stats.hasDirectories) return "flat-list";
  if (model.stats.totalNodes <= limits.expandAllMaxNodes && model.stats.maxDepth <= limits.expandAllMaxDepth) return "expanded-tree";
  if (
    model.stats.totalNodes > limits.smartTreeMaxNodes
    || model.stats.maxChildren > limits.heavyDirectoryChildCount
    || model.stats.maxDepth > limits.autoExpandSingleChainMaxDepth
  ) return "explorer";
  return "smart-tree";
}

export function getAncestorPaths(path: string): string[] {
  const parts = splitSharePath(path);
  if (parts.length <= 1) return [];

  const ancestors: string[] = [];
  let currentPath = "";
  parts.slice(0, -1).forEach((part) => {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    ancestors.push(currentPath);
  });
  return ancestors;
}

export function getInitialExpandedPaths(model: ShareTreeModel, mode: ShareTreeDisplayMode, limits: ShareTreeDisplayLimits = DEFAULT_SHARE_TREE_LIMITS): Set<string> {
  const expandedPaths = new Set<string>();

  if (mode === "expanded-tree") {
    model.directories.forEach((directory) => expandedPaths.add(directory.path));
    return expandedPaths;
  }

  const expandSmartDirectory = (directory: ShareTreeDirectoryNode) => {
    if (directory.children.length > limits.heavyDirectoryChildCount) return;
    if (directory.depth > limits.autoExpandSingleChainMaxDepth) return;

    expandedPaths.add(directory.path);
    if (directory.depth >= limits.expandAllMaxDepth) return;

    directory.children
      .filter((child): child is ShareTreeDirectoryNode => child.type === "directory")
      .forEach((childDirectory) => {
        if (childDirectory.children.length === 1 || directory.children.length <= limits.heavyDirectoryChildCount) {
          expandSmartDirectory(childDirectory);
        }
      });
  };

  model.roots
    .filter((node): node is ShareTreeDirectoryNode => node.type === "directory")
    .forEach((directory) => {
      if (mode === "smart-tree") expandSmartDirectory(directory);
      else expandedPaths.add(directory.path);
    });

  return expandedPaths;
}

export function flattenVisibleShareTree(nodes: ShareTreeNode[], expandedPaths: Set<string>): ShareTreeVisibleRow[] {
  const rows: ShareTreeVisibleRow[] = [];

  const appendRows = (siblings: ShareTreeNode[], depth: number) => {
    const setSize = siblings.length;
    siblings.forEach((node, index) => {
      rows.push({
        node,
        depth,
        ariaLevel: depth + 1,
        ariaPosInSet: index + 1,
        ariaSetSize: setSize,
      });
      if (node.type === "directory" && expandedPaths.has(node.path)) {
        appendRows(node.children, depth + 1);
      }
    });
  };

  appendRows(nodes, 0);
  return rows;
}

export function getNodeByFileIndex(model: ShareTreeModel, fileIndex: number): ShareTreeFileNode | null {
  return model.files.find((fileNode) => fileNode.fileIndex === fileIndex) || null;
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

export function searchShareTree(nodes: ShareTreeNode[], query: string, limit = 200): ShareTreeSearchResult[] {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return [];

  const results: ShareTreeSearchResult[] = [];
  const walk = (siblings: ShareTreeNode[], ancestors: string[]) => {
    for (const node of siblings) {
      if (results.length >= limit) return;
      const haystack = [node.name, node.path, node.type === "file" ? node.extension : ""].join(" ").toLowerCase();
      if (haystack.includes(normalizedQuery)) {
        results.push({ node, ancestorLabel: ancestors.join(" / ") });
      }
      if (node.type === "directory") walk(node.children, [...ancestors, node.name]);
    }
  };

  walk(nodes, []);
  return results;
}
