/// <reference lib="webworker" />

import { Inflate } from "fflate";

interface ResourcePolicy {
  maxEntries: number;
  maxEntryBytes: number;
  maxExpandedBytes: number;
}

interface WorkerRequest {
  buffer: ArrayBuffer;
  kind: "document" | "presentation" | "xlsx";
  policy: ResourcePolicy;
}

interface ZipEntryMeta {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  compressionMethod: number;
  dataOffset: number;
}

const REQUIRED_PART = {
  document: "word/document.xml",
  presentation: "ppt/presentation.xml",
  xlsx: "xl/workbook.xml",
} as const;
const INFLATE_INPUT_CHUNK_BYTES = 256 * 1024;
const MAX_RELATIONSHIP_BYTES = 1024 * 1024;

class WorkerLimitError extends Error {}

function readZipEntries(buffer: ArrayBuffer, policy: ResourcePolicy): ZipEntryMeta[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength < 22) throw new Error("Office 文件格式无效或文档已损坏");
  const minEocdOffset = Math.max(0, bytes.byteLength - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minEocdOffset; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Office 文件格式无效或文档已损坏");

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const directorySize = view.getUint32(eocdOffset + 12, true);
  const directoryOffset = view.getUint32(eocdOffset + 16, true);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new WorkerLimitError("暂不支持 ZIP64 Office 文档在线预览");
  }
  if (entryCount > policy.maxEntries) throw new WorkerLimitError("Office 文档包含过多资源，无法安全预览");
  if (directoryOffset + directorySize > bytes.byteLength) throw new Error("Office 文档目录已损坏");

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const names = new Set<string>();
  const entries: ZipEntryMeta[] = [];
  let offset = directoryOffset;
  while (offset < directoryOffset + directorySize && entries.length < entryCount) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error("Office 文档目录结构无效");
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    if ((flags & 0x1) !== 0) throw new Error("加密 Office 文档无法在线预览");
    if (compressionMethod !== 0 && compressionMethod !== 8) throw new Error("Office 文档包含不支持的压缩格式");
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error("Office 文档文件名结构无效");
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd)).replaceAll("\\", "/").replace(/^\/+/, "");
    if (!name || name.split("/").includes("..")) throw new Error("Office 文档包含不安全路径");
    if (names.has(name)) throw new Error("Office 文档包含重复内部路径");
    names.add(name);
    if (uncompressedSize > policy.maxEntryBytes) throw new WorkerLimitError("Office 文档包含过大的内部资源");

    if (localHeaderOffset + 30 > bytes.byteLength || view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error("Office 文档本地文件头无效");
    }
    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    if ((localFlags & 0x1) !== 0 || localMethod !== compressionMethod) throw new Error("Office 文档压缩目录不一致");
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > bytes.byteLength) throw new Error("Office 文档内部资源不完整");
    entries.push({ name, compressedSize, uncompressedSize, compressionMethod, dataOffset });
    offset = nameEnd + extraLength + commentLength;
  }
  if (entries.length !== entryCount) throw new Error("Office 文档目录条目不完整");
  return entries;
}

function inspectExternalRelationships(name: string, content: Uint8Array, kind: WorkerRequest["kind"]) {
  if (!name.toLowerCase().endsWith(".rels")) return;
  if (content.byteLength > MAX_RELATIONSHIP_BYTES) throw new WorkerLimitError("Office 外部关系文件过大");
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(content);
  const decodeAttribute = (value: string) => value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
  for (const match of xml.matchAll(/<(?:[^<>\s/:]+:)?Relationship\b[^>]*>/giu)) {
    const tag = match[0];
    const mode = decodeAttribute(/\bTargetMode\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || "");
    if (mode.toLowerCase() !== "external") continue;
    const type = decodeAttribute(/\bType\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || "");
    if (kind === "presentation" || !type.toLowerCase().endsWith("/hyperlink")) {
      throw new Error("Office 文档包含外部媒体资源，请下载后查看");
    }
  }
}

function validateEntry(bytes: Uint8Array, entry: ZipEntryMeta, policy: ResourcePolicy, remainingExpandedBytes: number, kind: WorkerRequest["kind"]): number {
  if (entry.uncompressedSize > remainingExpandedBytes) {
    throw new WorkerLimitError("Office 文档解压后超出当前设备限制");
  }
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200) {
    throw new WorkerLimitError("Office 文档压缩比异常，已停止预览");
  }
  const collectRelationships = entry.name.toLowerCase().endsWith(".rels");
  if (collectRelationships && entry.uncompressedSize > MAX_RELATIONSHIP_BYTES) {
    throw new WorkerLimitError("Office 外部关系文件过大");
  }
  if (entry.compressionMethod === 0) {
    if (entry.compressedSize !== entry.uncompressedSize) throw new Error("Office 文档存储大小声明不一致");
    const content = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
    inspectExternalRelationships(entry.name, content, kind);
    return content.byteLength;
  }

  let expandedBytes = 0;
  const relationshipContent = collectRelationships ? new Uint8Array(entry.uncompressedSize) : null;
  const inflate = new Inflate((chunk) => {
    const nextExpandedBytes = expandedBytes + chunk.byteLength;
    if (nextExpandedBytes > entry.uncompressedSize || nextExpandedBytes > policy.maxEntryBytes || nextExpandedBytes > remainingExpandedBytes) {
      throw new WorkerLimitError("Office 文档实际解压大小超出安全限制");
    }
    relationshipContent?.set(chunk, expandedBytes);
    expandedBytes = nextExpandedBytes;
  });
  const end = entry.dataOffset + entry.compressedSize;
  if (entry.compressedSize === 0 && entry.uncompressedSize > 0) throw new Error("Office 文档压缩数据无效");
  for (let offset = entry.dataOffset; offset < end; offset += INFLATE_INPUT_CHUNK_BYTES) {
    const chunkEnd = Math.min(end, offset + INFLATE_INPUT_CHUNK_BYTES);
    inflate.push(bytes.subarray(offset, chunkEnd), chunkEnd === end);
  }
  if (expandedBytes !== entry.uncompressedSize) throw new Error("Office 文档实际解压大小与目录声明不一致");
  if (relationshipContent) inspectExternalRelationships(entry.name, relationshipContent, kind);
  return expandedBytes;
}

function validateOfficeBuffer(buffer: ArrayBuffer, kind: WorkerRequest["kind"], policy: ResourcePolicy) {
  const entries = readZipEntries(buffer, policy);
  const names = new Set(entries.map((entry) => entry.name));
  if (!names.has("[Content_Types].xml") || !names.has(REQUIRED_PART[kind])) {
    throw new Error("Office 文档缺少必要内容，可能已损坏或扩展名不正确");
  }
  const bytes = new Uint8Array(buffer);
  const declaredExpandedBytes = entries.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (declaredExpandedBytes > policy.maxExpandedBytes) {
    throw new WorkerLimitError("Office 文档解压后超出当前设备限制");
  }
  let expandedBytes = 0;
  for (const entry of entries) {
    expandedBytes += validateEntry(bytes, entry, policy, policy.maxExpandedBytes - expandedBytes, kind);
    if (expandedBytes > policy.maxExpandedBytes) throw new WorkerLimitError("Office 文档解压后超出当前设备限制");
  }
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { buffer, kind, policy } = event.data;
  try {
    validateOfficeBuffer(buffer, kind, policy);
    workerScope.postMessage({ ok: true, buffer }, [buffer]);
  } catch (error) {
    workerScope.postMessage({
      ok: false,
      limit: error instanceof WorkerLimitError,
      message: error instanceof Error ? error.message : "Office 文档安全检查失败",
    });
  }
};
