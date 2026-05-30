import { RangeFileReader } from "./range-file-reader";
import type { ShareFileDownload } from "./api";
import type { DebugLogFn } from "./debug";

const MKV_PREVIEW_BYTES = 64 * 1024 * 1024;
const CLUSTER_ID_BYTES = [0x1f, 0x43, 0xb6, 0x75];

const IDS = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  info: 0x1549a966,
  timecodeScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  defaultDuration: 0x23e383,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  bitDepth: 0x6264,
  cluster: 0x1f43b675,
  clusterTimecode: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  referenceBlock: 0xfb,
};

interface EbmlReadResult {
  value: number;
  length: number;
  unknown?: boolean;
}

interface EbmlElement {
  id: number;
  contentStart: number;
  contentEnd: number;
  nextOffset: number;
}

export interface MkvTrack {
  number: number;
  type: number;
  codecId: string;
  codecPrivate?: Uint8Array;
  defaultDurationUs?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  bitDepth?: number;
}

export interface MkvVideoBlock {
  timestampUs: number;
  durationUs?: number;
  keyframe: boolean;
  data: Uint8Array;
}

export interface MkvAudioBlock {
  timestampUs: number;
  durationUs?: number;
  data: Uint8Array;
}

export interface MkvWebCodecsPlan {
  bytesRead: number;
  timecodeScaleNs: number;
  durationSeconds?: number;
  videoTrack: MkvTrack;
  config: VideoDecoderConfigLike;
  audioTrack?: MkvTrack;
  audioConfig?: AudioDecoderConfigLike;
  blocks: MkvVideoBlock[];
  audioBlocks: MkvAudioBlock[];
  warnings: string[];
}

export interface MkvParseOptions {
  maxBlocks?: number;
}

export interface VideoDecoderConfigLike {
  codec: string;
  codedWidth?: number;
  codedHeight?: number;
  description?: BufferSource;
  optimizeForLatency?: boolean;
  hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
}

export interface AudioDecoderConfigLike {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: BufferSource;
}

export async function buildMkvWebCodecsPlan(file: ShareFileDownload, signal?: AbortSignal, debugLog?: DebugLogFn): Promise<MkvWebCodecsPlan> {
  const reader = new RangeFileReader(file);
  const bytesToRead = Math.min(MKV_PREVIEW_BYTES, reader.totalSize);
  debugLog?.("sdp-mkv", "range:start", { bytesToRead, fileSize: reader.totalSize });
  const startedAt = performance.now();
  const buffer = await reader.readFirstBytes(bytesToRead, signal);
  debugLog?.("sdp-mkv", "range:done", { bytesRead: buffer.byteLength, elapsedMs: Math.round(performance.now() - startedAt) });
  return parseMkvWebCodecsPlanFromBuffer(buffer);
}

export function parseMkvWebCodecsPlanFromBuffer(buffer: ArrayBuffer, options: MkvParseOptions = {}): MkvWebCodecsPlan {
  const view = new DataView(buffer);
  const segment = findRootElement(view, IDS.segment);
  if (!segment) throw new Error("未找到 Matroska Segment");

  const warnings: string[] = [];
  let timecodeScaleNs = 1_000_000;
  let durationSeconds: number | undefined;
  const tracks: MkvTrack[] = [];
  const clusters: EbmlElement[] = [];

  let offset = segment.contentStart;
  while (offset < segment.contentEnd) {
    const element = readElement(view, offset, segment.contentEnd);
    if (!element) break;
    if (element.id === IDS.info) {
      const info = parseInfo(view, element.contentStart, element.contentEnd);
      timecodeScaleNs = info.timecodeScaleNs ?? timecodeScaleNs;
      durationSeconds = info.durationSeconds;
    } else if (element.id === IDS.tracks) {
      tracks.push(...parseTracks(view, element.contentStart, element.contentEnd));
    } else if (element.id === IDS.cluster) {
      clusters.push(element);
    }
    offset = element.nextOffset;
  }

  const videoTrack = tracks.find((track) => track.type === 1);
  if (!videoTrack) throw new Error("MKV 中未识别到视频轨");

  const config = getVideoDecoderConfig(videoTrack);
  if (!config) throw new Error(`SDP MKV 首阶段暂不支持视频编码 ${videoTrack.codecId || "unknown"}`);
  if (clusters.length === 0) throw new Error("当前读取范围内没有找到可解析 Cluster；需要继续增量读取");

  const blocks = parseVideoBlocks(view, clusters, videoTrack, timecodeScaleNs, warnings, options.maxBlocks ?? Number.POSITIVE_INFINITY);
  if (blocks.length === 0) throw new Error("当前 Cluster 中没有找到可解码视频块；需要继续增量读取");
  applyDurations(blocks, videoTrack.defaultDurationUs);

  const audioTrack = tracks.find((track) => track.type === 2);
  const audioConfig = audioTrack ? getAudioDecoderConfig(audioTrack) : null;
  const audioBlocks = audioTrack ? parseAudioBlocks(view, clusters, audioTrack, timecodeScaleNs) : [];

  return {
    bytesRead: buffer.byteLength,
    timecodeScaleNs,
    durationSeconds,
    videoTrack,
    config,
    audioTrack: audioTrack ?? undefined,
    audioConfig: audioConfig ?? undefined,
    blocks,
    audioBlocks,
    warnings,
  };
}

export function parseMkvVideoBlocksFromBuffer(
  buffer: ArrayBuffer,
  videoTrack: MkvTrack,
  timecodeScaleNs: number,
  options: MkvParseOptions = {},
): { blocks: MkvVideoBlock[]; warnings: string[] } {
  const view = new DataView(buffer);
  const warnings: string[] = [];
  const clusters = findClusterElements(view);
  const blocks = parseVideoBlocks(view, clusters, videoTrack, timecodeScaleNs, warnings, options.maxBlocks ?? Number.POSITIVE_INFINITY);
  applyDurations(blocks, videoTrack.defaultDurationUs);
  return { blocks, warnings };
}

export function parseMkvAudioBlocksFromBuffer(
  buffer: ArrayBuffer,
  audioTrack: MkvTrack,
  timecodeScaleNs: number,
): MkvAudioBlock[] {
  const view = new DataView(buffer);
  const clusters = findClusterElements(view);
  return parseAudioBlocks(view, clusters, audioTrack, timecodeScaleNs);
}

export function getMkvClusterCarry(buffer: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(buffer);
  const lastClusterStart = findLastClusterStart(bytes);
  if (lastClusterStart >= 0) return copyBytes(bytes.slice(lastClusterStart));
  return copyBytes(bytes.slice(Math.max(0, bytes.byteLength - CLUSTER_ID_BYTES.length + 1)));
}

function parseInfo(view: DataView, start: number, end: number): { timecodeScaleNs?: number; durationSeconds?: number } {
  let timecodeScaleNs: number | undefined;
  let rawDuration: number | undefined;
  let offset = start;
  while (offset < end) {
    const element = readElement(view, offset, end);
    if (!element) break;
    if (element.id === IDS.timecodeScale) timecodeScaleNs = readUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === IDS.duration) rawDuration = readFloat(view, element.contentStart, element.contentEnd);
    offset = element.nextOffset;
  }
  return {
    timecodeScaleNs,
    durationSeconds: rawDuration !== undefined ? (rawDuration * (timecodeScaleNs ?? 1_000_000)) / 1_000_000_000 : undefined,
  };
}

function parseTracks(view: DataView, start: number, end: number): MkvTrack[] {
  const tracks: MkvTrack[] = [];
  let offset = start;
  while (offset < end) {
    const element = readElement(view, offset, end);
    if (!element) break;
    if (element.id === IDS.trackEntry) tracks.push(parseTrackEntry(view, element.contentStart, element.contentEnd));
    offset = element.nextOffset;
  }
  return tracks;
}

function parseTrackEntry(view: DataView, start: number, end: number): MkvTrack {
  const track: MkvTrack = { number: 0, type: 0, codecId: "" };
  let offset = start;
  while (offset < end) {
    const element = readElement(view, offset, end);
    if (!element) break;
    if (element.id === IDS.trackNumber) track.number = readUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === IDS.trackType) track.type = readUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === IDS.codecId) track.codecId = readAscii(view, element.contentStart, element.contentEnd - element.contentStart);
    if (element.id === IDS.codecPrivate) track.codecPrivate = readBytes(view, element.contentStart, element.contentEnd);
    if (element.id === IDS.defaultDuration) track.defaultDurationUs = readUnsigned(view, element.contentStart, element.contentEnd) / 1000;
    if (element.id === IDS.video) parseVideoTrack(view, element.contentStart, element.contentEnd, track);
    if (element.id === IDS.audio) parseAudioTrack(view, element.contentStart, element.contentEnd, track);
    offset = element.nextOffset;
  }
  return track;
}

function parseVideoTrack(view: DataView, start: number, end: number, track: MkvTrack) {
  let offset = start;
  while (offset < end) {
    const element = readElement(view, offset, end);
    if (!element) break;
    if (element.id === IDS.pixelWidth) track.width = readUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === IDS.pixelHeight) track.height = readUnsigned(view, element.contentStart, element.contentEnd);
    offset = element.nextOffset;
  }
}

function parseAudioTrack(view: DataView, start: number, end: number, track: MkvTrack) {
  let offset = start;
  while (offset < end) {
    const element = readElement(view, offset, end);
    if (!element) break;
    if (element.id === IDS.samplingFrequency) track.sampleRate = Math.round(readFloat(view, element.contentStart, element.contentEnd) ?? 0);
    if (element.id === IDS.channels) track.channels = readUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === IDS.bitDepth) track.bitDepth = readUnsigned(view, element.contentStart, element.contentEnd);
    offset = element.nextOffset;
  }
}

function parseVideoBlocks(view: DataView, clusters: EbmlElement[], videoTrack: MkvTrack, timecodeScaleNs: number, warnings: string[], maxBlocks: number): MkvVideoBlock[] {
  const blocks: MkvVideoBlock[] = [];
  for (const cluster of clusters) {
    let clusterTimecode = 0;
    let offset = cluster.contentStart;
    while (offset < cluster.contentEnd && blocks.length < maxBlocks) {
      const element = readElement(view, offset, cluster.contentEnd);
      if (!element) break;
      if (element.id === IDS.clusterTimecode) clusterTimecode = readUnsigned(view, element.contentStart, element.contentEnd);
      if (element.id === IDS.simpleBlock) {
        const block = parseBlock(view, element.contentStart, element.contentEnd, clusterTimecode, timecodeScaleNs, videoTrack.number, true);
        if (block) blocks.push(block);
      }
      if (element.id === IDS.blockGroup) {
        const block = parseBlockGroup(view, element.contentStart, element.contentEnd, clusterTimecode, timecodeScaleNs, videoTrack.number);
        if (block) blocks.push(block);
      }
      offset = element.nextOffset;
    }
    if (Number.isFinite(maxBlocks) && blocks.length >= maxBlocks) {
      warnings.push(`预览阶段最多解析 ${maxBlocks} 个视频块`);
      break;
    }
  }
  return blocks;
}

function parseBlockGroup(view: DataView, start: number, end: number, clusterTimecode: number, timecodeScaleNs: number, trackNumber: number): MkvVideoBlock | null {
  let blockElement: EbmlElement | null = null;
  let hasReferenceBlock = false;
  let offset = start;
  while (offset < end) {
    const element = readElement(view, offset, end);
    if (!element) break;
    if (element.id === IDS.block) blockElement = element;
    if (element.id === IDS.referenceBlock) hasReferenceBlock = true;
    offset = element.nextOffset;
  }
  if (!blockElement) return null;
  return parseBlock(view, blockElement.contentStart, blockElement.contentEnd, clusterTimecode, timecodeScaleNs, trackNumber, !hasReferenceBlock);
}

function parseBlock(view: DataView, start: number, end: number, clusterTimecode: number, timecodeScaleNs: number, targetTrackNumber: number, keyframeFromContainer: boolean): MkvVideoBlock | null {
  const track = readVint(view, start, end, true);
  if (!track) return null;
  if (track.value !== targetTrackNumber) return null;
  const timecodeOffset = start + track.length;
  if (timecodeOffset + 3 > end) return null;
  const relativeTimecode = view.getInt16(timecodeOffset, false);
  const flags = view.getUint8(timecodeOffset + 2);
  const lacing = (flags & 0x06) >> 1;
  if (lacing !== 0) return null;
  const payloadStart = timecodeOffset + 3;
  if (payloadStart >= end) return null;
  const timestampUs = ((clusterTimecode + relativeTimecode) * timecodeScaleNs) / 1000;
  const keyframe = keyframeFromContainer || Boolean(flags & 0x80);
  return {
    timestampUs,
    keyframe,
    data: readBytes(view, payloadStart, end),
  };
}

function applyDurations(blocks: MkvVideoBlock[], defaultDurationUs?: number) {
  for (let i = 0; i < blocks.length; i++) {
    const next = blocks[i + 1];
    const duration = next ? next.timestampUs - blocks[i].timestampUs : defaultDurationUs;
    if (duration && duration > 0) blocks[i].durationUs = duration;
  }
}

function getVideoDecoderConfig(track: MkvTrack): VideoDecoderConfigLike | null {
  if (track.codecId === "V_MPEG4/ISO/AVC") {
    if (!track.codecPrivate || track.codecPrivate.byteLength < 4) throw new Error("H.264 MKV 缺少 AVCDecoderConfigurationRecord");
    return {
      codec: getAvcCodecString(track.codecPrivate),
      codedWidth: track.width,
      codedHeight: track.height,
      description: copyBytesToArrayBuffer(track.codecPrivate),
      optimizeForLatency: true,
      hardwareAcceleration: "no-preference",
    };
  }
  if (track.codecId === "V_VP8") {
    return { codec: "vp8", codedWidth: track.width, codedHeight: track.height, optimizeForLatency: true };
  }
  if (track.codecId === "V_VP9") {
    return { codec: "vp09.00.10.08", codedWidth: track.width, codedHeight: track.height, optimizeForLatency: true };
  }
  return null;
}

function getAvcCodecString(codecPrivate: Uint8Array): string {
  const profile = codecPrivate[1]?.toString(16).padStart(2, "0") || "42";
  const compatibility = codecPrivate[2]?.toString(16).padStart(2, "0") || "00";
  const level = codecPrivate[3]?.toString(16).padStart(2, "0") || "1e";
  return `avc1.${profile}${compatibility}${level}`;
}

function getAudioDecoderConfig(track: MkvTrack): AudioDecoderConfigLike | null {
  if (track.codecId === "A_AAC" || track.codecId === "A_AAC/MPEG4/LC" || track.codecId === "A_AAC/MPEG2/LC") {
    if (!track.codecPrivate || track.codecPrivate.byteLength < 2) return null;
    return {
      codec: "mp4a.40.2",
      sampleRate: track.sampleRate || 44100,
      numberOfChannels: track.channels || 2,
      description: copyBytesToArrayBuffer(track.codecPrivate),
    };
  }
  if (track.codecId === "A_OPUS") {
    return {
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: track.channels || 2,
      description: track.codecPrivate ? copyBytesToArrayBuffer(track.codecPrivate) : undefined,
    };
  }
  if (track.codecId === "A_VORBIS") {
    if (!track.codecPrivate) return null;
    return {
      codec: "vorbis",
      sampleRate: track.sampleRate || 44100,
      numberOfChannels: track.channels || 2,
      description: copyBytesToArrayBuffer(track.codecPrivate),
    };
  }
  return null;
}

function parseAudioBlocks(view: DataView, clusters: EbmlElement[], audioTrack: MkvTrack, timecodeScaleNs: number): MkvAudioBlock[] {
  const blocks: MkvAudioBlock[] = [];
  for (const cluster of clusters) {
    let clusterTimecode = 0;
    let offset = cluster.contentStart;
    while (offset < cluster.contentEnd) {
      const element = readElement(view, offset, cluster.contentEnd);
      if (!element) break;
      if (element.id === IDS.clusterTimecode) clusterTimecode = readUnsigned(view, element.contentStart, element.contentEnd);
      if (element.id === IDS.simpleBlock) {
        const parsed = parseAudioBlockLaced(view, element.contentStart, element.contentEnd, clusterTimecode, timecodeScaleNs, audioTrack.number, audioTrack.defaultDurationUs);
        if (parsed) blocks.push(...parsed);
      }
      if (element.id === IDS.blockGroup) {
        const parsed = parseAudioBlockGroupLaced(view, element.contentStart, element.contentEnd, clusterTimecode, timecodeScaleNs, audioTrack.number, audioTrack.defaultDurationUs);
        if (parsed) blocks.push(...parsed);
      }
      offset = element.nextOffset;
    }
  }
  return blocks;
}

function parseAudioBlockLaced(view: DataView, start: number, end: number, clusterTimecode: number, timecodeScaleNs: number, targetTrackNumber: number, defaultDurationUs?: number): MkvAudioBlock[] | null {
  const track = readVint(view, start, end, true);
  if (!track) return null;
  if (track.value !== targetTrackNumber) return null;
  const timecodeOffset = start + track.length;
  if (timecodeOffset + 3 > end) return null;
  const relativeTimecode = view.getInt16(timecodeOffset, false);
  const flags = view.getUint8(timecodeOffset + 2);
  const lacing = (flags & 0x06) >> 1;
  const payloadStart = timecodeOffset + 3;
  if (payloadStart >= end) return null;
  const timestampUs = ((clusterTimecode + relativeTimecode) * timecodeScaleNs) / 1000;

  if (lacing === 0) {
    return [{ timestampUs, data: readBytes(view, payloadStart, end) }];
  }

  const frameSizes = parseLacingSizes(view, payloadStart, end, lacing);
  if (!frameSizes) return null;

  const blocks: MkvAudioBlock[] = [];
  let dataOffset = frameSizes.dataStart;
  const frameDurationUs = defaultDurationUs || 21333;
  for (let i = 0; i < frameSizes.sizes.length; i++) {
    const size = frameSizes.sizes[i];
    if (dataOffset + size > end) break;
    blocks.push({
      timestampUs: timestampUs + i * frameDurationUs,
      durationUs: frameDurationUs,
      data: readBytes(view, dataOffset, dataOffset + size),
    });
    dataOffset += size;
  }
  return blocks.length > 0 ? blocks : null;
}

function parseAudioBlockGroupLaced(view: DataView, start: number, end: number, clusterTimecode: number, timecodeScaleNs: number, trackNumber: number, defaultDurationUs?: number): MkvAudioBlock[] | null {
  let blockElement: EbmlElement | null = null;
  let offset = start;
  while (offset < end) {
    const element = readElement(view, offset, end);
    if (!element) break;
    if (element.id === IDS.block) blockElement = element;
    offset = element.nextOffset;
  }
  if (!blockElement) return null;
  return parseAudioBlockLaced(view, blockElement.contentStart, blockElement.contentEnd, clusterTimecode, timecodeScaleNs, trackNumber, defaultDurationUs);
}

function parseLacingSizes(view: DataView, payloadStart: number, end: number, lacingType: number): { sizes: number[]; dataStart: number } | null {
  if (payloadStart >= end) return null;
  const frameCount = view.getUint8(payloadStart) + 1;
  let offset = payloadStart + 1;

  if (lacingType === 2) {
    const totalData = end - offset;
    const frameSize = Math.floor(totalData / frameCount);
    const sizes = Array(frameCount).fill(frameSize);
    return { sizes, dataStart: offset };
  }

  if (lacingType === 1) {
    const sizes: number[] = [];
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      while (offset < end) {
        const byte = view.getUint8(offset);
        offset++;
        size += byte;
        if (byte < 255) break;
      }
      sizes.push(size);
    }
    const remaining = end - offset - sizes.reduce((a, b) => a + b, 0);
    if (remaining < 0) return null;
    sizes.push(remaining);
    return { sizes, dataStart: offset };
  }

  if (lacingType === 3) {
    const sizes: number[] = [];
    for (let i = 0; i < frameCount - 1; i++) {
      const vint = readVint(view, offset, end, true);
      if (!vint) return null;
      if (i === 0) {
        sizes.push(vint.value);
      } else {
        const prev = sizes[sizes.length - 1];
        const signedDiff = vint.value - ((1 << (7 * vint.length - 1)) - 1);
        sizes.push(prev + signedDiff);
      }
      offset += vint.length;
    }
    const remaining = end - offset - sizes.reduce((a, b) => a + b, 0);
    if (remaining < 0) return null;
    sizes.push(remaining);
    return { sizes, dataStart: offset };
  }

  return null;
}

function findRootElement(view: DataView, targetId: number): EbmlElement | null {
  let offset = 0;
  while (offset < view.byteLength) {
    const element = readElement(view, offset, view.byteLength);
    if (!element) break;
    if (element.id === targetId) return element;
    offset = element.nextOffset;
  }
  return null;
}

function findClusterElements(view: DataView): EbmlElement[] {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const clusters: EbmlElement[] = [];
  let offset = 0;
  while (offset <= bytes.byteLength - CLUSTER_ID_BYTES.length) {
    if (!matchesClusterId(bytes, offset)) {
      offset += 1;
      continue;
    }
    const element = readElement(view, offset, view.byteLength);
    if (!element) break;
    if (element.id === IDS.cluster) {
      clusters.push(element);
      if (element.nextOffset > offset) {
        offset = Math.max(offset + 1, element.nextOffset);
        continue;
      }
    }
    offset += 1;
  }
  return clusters;
}

function findLastClusterStart(bytes: Uint8Array): number {
  for (let offset = bytes.byteLength - CLUSTER_ID_BYTES.length; offset >= 0; offset--) {
    if (matchesClusterId(bytes, offset)) return offset;
  }
  return -1;
}

function matchesClusterId(bytes: Uint8Array, offset: number): boolean {
  return CLUSTER_ID_BYTES.every((value, index) => bytes[offset + index] === value);
}

function readElement(view: DataView, offset: number, end: number): EbmlElement | null {
  const id = readEbmlId(view, offset, end);
  if (!id) return null;
  const size = readVint(view, offset + id.length, end, true);
  if (!size) return null;
  const contentStart = offset + id.length + size.length;
  const fullContentEnd = size.unknown ? end : contentStart + size.value;
  if (!size.unknown && fullContentEnd > end && id.value !== IDS.segment && id.value !== IDS.cluster) return null;
  const contentEnd = Math.min(end, fullContentEnd);
  if (contentStart > end || contentEnd < contentStart) return null;
  return { id: id.value, contentStart, contentEnd, nextOffset: contentEnd };
}

function readEbmlId(view: DataView, offset: number, end: number): EbmlReadResult | null {
  if (offset >= end) return null;
  const first = view.getUint8(offset);
  const length = vintLength(first);
  if (!length || offset + length > end) return null;
  let value = first;
  for (let i = 1; i < length; i++) value = value * 256 + view.getUint8(offset + i);
  return { value, length };
}

function readVint(view: DataView, offset: number, end: number, stripMarker: boolean): EbmlReadResult | null {
  if (offset >= end) return null;
  const first = view.getUint8(offset);
  const length = vintLength(first);
  if (!length || offset + length > end) return null;
  const marker = 1 << (8 - length);
  let value = stripMarker ? first & (marker - 1) : first;
  let max = marker - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + view.getUint8(offset + i);
    max = max * 256 + 255;
  }
  return { value, length, unknown: stripMarker && value === max };
}

function vintLength(firstByte: number): number | null {
  for (let length = 1; length <= 8; length++) {
    if (firstByte & (1 << (8 - length))) return length;
  }
  return null;
}

function readUnsigned(view: DataView, start: number, end: number): number {
  let value = 0;
  for (let offset = start; offset < end; offset++) value = value * 256 + view.getUint8(offset);
  return value;
}

function readFloat(view: DataView, start: number, end: number): number | undefined {
  const length = end - start;
  if (length === 4) return view.getFloat32(start, false);
  if (length === 8) return view.getFloat64(start, false);
  return undefined;
}

function readBytes(view: DataView, start: number, end: number): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(Math.max(0, end - start));
  copy.set(new Uint8Array(view.buffer, view.byteOffset + start, copy.byteLength));
  return copy;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function readAscii(view: DataView, offset: number, length: number): string {
  if (offset < 0 || offset + length > view.byteLength) return "";
  let value = "";
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i));
  return value.replace(/\0+$/g, "");
}
