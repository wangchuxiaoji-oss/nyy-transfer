import type { MediaMetadata, MediaTrackMetadata } from "./api";

const PROBE_VERSION = 1;
export const MAX_MOOV_READ_BYTES = 128 * 1024 * 1024;
const HEADER_READ_BYTES = 32;
const HEAD_METADATA_BYTES = 1024 * 1024;
const TAIL_SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
const TAIL_SCAN_OVERLAP_BYTES = 32;
const SUPPORTED_EXTS = new Set(["mp4", "m4v", "mov"]);
const SUPPORTED_TYPES = new Set(["video/mp4", "video/quicktime", "application/mp4"]);

interface Mp4Box {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
}

interface ParsedTrack {
  id?: number;
  handlerType?: string;
  durationSeconds?: number;
  timescale?: number;
  width?: number;
  height?: number;
  sampleDescriptions: SampleDescription[];
}

interface SampleDescription {
  codecTag: string;
  codec: string;
  width?: number;
  height?: number;
  sampleRate?: number;
  channelCount?: number;
}

export function shouldProbeMediaMetadata(file: File, uploadName: string): boolean {
  const ext = uploadName.split(".").pop()?.toLowerCase() || "";
  return SUPPORTED_EXTS.has(ext) || SUPPORTED_TYPES.has(file.type);
}

export async function probeMediaMetadata(file: File, uploadName: string): Promise<MediaMetadata | null> {
  if (!shouldProbeMediaMetadata(file, uploadName)) return null;
  const container = (uploadName.split(".").pop()?.toLowerCase() || file.type || "mp4").replace(/^video\//, "");
  try {
    const topLevelBoxes = await scanTopLevelBoxes(file);
    const moov = topLevelBoxes.find((box) => box.type === "moov") || await findMoovInTail(file);
    if (!moov) throw new Error("moov box not found");
    if (moov.size > MAX_MOOV_READ_BYTES) throw new Error(`moov box too large (${moov.size} bytes)`);

    const firstMdat = topLevelBoxes.find((box) => box.type === "mdat");
    const brands = await readBrands(file, topLevelBoxes);
    const moovBuffer = await readFileRange(file, moov.offset, moov.offset + moov.size);
    const parsed = parseMoov(moovBuffer, moov);

    return {
      probe_version: PROBE_VERSION,
      probe_status: "ok",
      probe_source: "client-upload",
      container,
      file_size: file.size,
      moov_offset: moov.offset,
      moov_size: moov.size,
      is_faststart: firstMdat ? moov.offset < firstMdat.offset : true,
      is_fragmented: topLevelBoxes.some((box) => box.type === "moof") || parsed.isFragmented,
      duration_seconds: parsed.durationSeconds,
      brands,
      video_tracks: parsed.videoTracks,
      audio_tracks: parsed.audioTracks,
    };
  } catch (err) {
    return {
      probe_version: PROBE_VERSION,
      probe_status: "failed",
      probe_source: "client-upload",
      probe_error: err instanceof Error ? err.message : String(err),
      container,
      file_size: file.size,
    };
  }
}

async function scanTopLevelBoxes(file: File): Promise<Mp4Box[]> {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  for (let guard = 0; guard < 10000 && offset < file.size; guard++) {
    const header = await readFileRange(file, offset, Math.min(file.size, offset + HEADER_READ_BYTES));
    const box = parseBoxHeader(new DataView(header), 0, offset, file.size);
    if (!box || box.size < box.headerSize) break;
    boxes.push(box);
    if (box.type === "moov") break;
    if (box.size <= 0) break;
    offset += box.size;
  }
  return boxes;
}

async function findMoovInTail(file: File): Promise<Mp4Box | null> {
  const scanStartLimit = file.size - Math.min(MAX_MOOV_READ_BYTES, file.size);
  let searchEnd = file.size;

  while (searchEnd > scanStartLimit) {
    const searchStart = Math.max(scanStartLimit, searchEnd - TAIL_SCAN_WINDOW_BYTES);
    const readStart = Math.max(0, searchStart - TAIL_SCAN_OVERLAP_BYTES);
    const buffer = await readFileRange(file, readStart, searchEnd);
    const found = findMoovInBuffer(buffer, readStart, file.size);
    if (found) return found;
    searchEnd = searchStart;
  }

  return null;
}

function findMoovInBuffer(buffer: ArrayBuffer, absoluteStart: number, fileSize: number): Mp4Box | null {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  for (let i = 4; i < bytes.length - 4; i++) {
    if (bytes[i] !== 0x6d || bytes[i + 1] !== 0x6f || bytes[i + 2] !== 0x6f || bytes[i + 3] !== 0x76) continue;
    const boxStart = i - 4;
    const size32 = view.getUint32(boxStart);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1 && boxStart + 16 <= bytes.length) {
      size = Number(view.getBigUint64(boxStart + 8));
      headerSize = 16;
    }
    const absoluteOffset = absoluteStart + boxStart;
    if (size >= headerSize && size <= MAX_MOOV_READ_BYTES && absoluteOffset + size <= fileSize) {
      return { type: "moov", offset: absoluteOffset, size, headerSize };
    }
  }
  return null;
}

async function readBrands(file: File, topLevelBoxes: Mp4Box[]): Promise<string[]> {
  const ftyp = topLevelBoxes.find((box) => box.type === "ftyp");
  if (!ftyp || ftyp.size > HEAD_METADATA_BYTES) return [];
  const buffer = await readFileRange(file, ftyp.offset, ftyp.offset + ftyp.size);
  const view = new DataView(buffer);
  const brands: string[] = [];
  const contentStart = ftyp.headerSize;
  if (contentStart + 8 > view.byteLength) return brands;
  brands.push(readAscii(view, contentStart, 4));
  for (let offset = contentStart + 8; offset + 4 <= view.byteLength; offset += 4) {
    const brand = readAscii(view, offset, 4);
    if (brand && !brands.includes(brand)) brands.push(brand);
  }
  return brands;
}

async function readFileRange(file: File, start: number, end: number): Promise<ArrayBuffer> {
  return file.slice(start, end).arrayBuffer();
}

function parseMoov(buffer: ArrayBuffer, moov: Mp4Box): {
  durationSeconds?: number;
  isFragmented: boolean;
  videoTracks: MediaTrackMetadata[];
  audioTracks: MediaTrackMetadata[];
} {
  const view = new DataView(buffer);
  const root = parseBoxHeader(view, 0, moov.offset, moov.offset + moov.size);
  const moovHeaderSize = root?.headerSize || moov.headerSize;
  const children = parseBoxes(view, moovHeaderSize, view.byteLength, moov.offset + moovHeaderSize);
  const mvhd = children.find((box) => box.type === "mvhd");
  const movieDuration = mvhd ? parseDurationBox(view, mvhd) : undefined;
  const tracks = children
    .filter((box) => box.type === "trak")
    .map((box) => parseTrack(view, box))
    .filter((track): track is ParsedTrack => Boolean(track));
  const videoTracks: MediaTrackMetadata[] = [];
  const audioTracks: MediaTrackMetadata[] = [];

  for (const track of tracks) {
    const description = track.sampleDescriptions[0];
    if (!description) continue;
    const durationSeconds = track.durationSeconds;
    if (track.handlerType === "vide") {
      videoTracks.push({
        id: track.id,
        type: "video",
        codec: description.codec,
        codec_tag: description.codecTag,
        duration_seconds: durationSeconds,
        timescale: track.timescale,
        width: description.width || track.width,
        height: description.height || track.height,
      });
    } else if (track.handlerType === "soun") {
      audioTracks.push({
        id: track.id,
        type: "audio",
        codec: description.codec,
        codec_tag: description.codecTag,
        duration_seconds: durationSeconds,
        timescale: track.timescale,
        sample_rate: description.sampleRate,
        channel_count: description.channelCount,
      });
    }
  }

  return {
    durationSeconds: movieDuration,
    isFragmented: children.some((box) => box.type === "mvex"),
    videoTracks,
    audioTracks,
  };
}

function parseTrack(view: DataView, trak: BufferedBox): ParsedTrack | null {
  const children = parseBoxes(view, trak.offsetInBuffer + trak.headerSize, trak.offsetInBuffer + trak.size, trak.offset + trak.headerSize);
  const tkhd = children.find((box) => box.type === "tkhd");
  const mdia = children.find((box) => box.type === "mdia");
  if (!mdia) return null;
  const mdiaChildren = parseBoxes(view, mdia.offsetInBuffer + mdia.headerSize, mdia.offsetInBuffer + mdia.size, mdia.offset + mdia.headerSize);
  const mdhd = mdiaChildren.find((box) => box.type === "mdhd");
  const hdlr = mdiaChildren.find((box) => box.type === "hdlr");
  const minf = mdiaChildren.find((box) => box.type === "minf");
  const minfChildren = minf ? parseBoxes(view, minf.offsetInBuffer + minf.headerSize, minf.offsetInBuffer + minf.size, minf.offset + minf.headerSize) : [];
  const stbl = minfChildren.find((box) => box.type === "stbl");
  const stblChildren = stbl ? parseBoxes(view, stbl.offsetInBuffer + stbl.headerSize, stbl.offsetInBuffer + stbl.size, stbl.offset + stbl.headerSize) : [];
  const stsd = stblChildren.find((box) => box.type === "stsd");
  const duration = mdhd ? parseDurationBox(view, mdhd) : undefined;
  const tkhdSize = tkhd ? parseTkhdSize(view, tkhd) : {};
  return {
    id: tkhd ? parseTkhdTrackId(view, tkhd) : undefined,
    handlerType: hdlr ? parseHandlerType(view, hdlr) : undefined,
    durationSeconds: duration,
    timescale: mdhd ? parseTimescale(view, mdhd) : undefined,
    width: tkhdSize.width,
    height: tkhdSize.height,
    sampleDescriptions: stsd ? parseStsd(view, stsd) : [],
  };
}

type BufferedBox = Mp4Box & { offsetInBuffer: number };

function parseBoxes(view: DataView, start: number, end: number, absoluteStart: number): BufferedBox[] {
  const boxes: BufferedBox[] = [];
  let offset = start;
  for (let guard = 0; guard < 10000 && offset + 8 <= end; guard++) {
    const parsed = parseBoxHeader(view, offset, absoluteStart + offset - start, absoluteStart + end - start);
    if (!parsed || parsed.size < parsed.headerSize || offset + parsed.size > end) break;
    boxes.push({ ...parsed, offsetInBuffer: offset });
    offset += parsed.size;
  }
  return boxes;
}

function parseBoxHeader(view: DataView, offsetInBuffer: number, absoluteOffset: number, fileOrBoxEnd: number): Mp4Box | null {
  if (offsetInBuffer + 8 > view.byteLength) return null;
  const size32 = view.getUint32(offsetInBuffer);
  const type = readAscii(view, offsetInBuffer + 4, 4);
  let size = size32;
  let headerSize = 8;
  if (size32 === 1) {
    if (offsetInBuffer + 16 > view.byteLength) return null;
    size = Number(view.getBigUint64(offsetInBuffer + 8));
    headerSize = 16;
  } else if (size32 === 0) {
    size = fileOrBoxEnd - absoluteOffset;
  }
  if (!type || !Number.isFinite(size) || size < headerSize) return null;
  return { type, offset: absoluteOffset, size, headerSize };
}

function parseDurationBox(view: DataView, box: BufferedBox): number | undefined {
  const content = box.offsetInBuffer + box.headerSize;
  if (content + 20 > view.byteLength) return undefined;
  const version = view.getUint8(content);
  if (version === 1) {
    if (content + 32 > view.byteLength) return undefined;
    const timescale = view.getUint32(content + 20);
    const duration = Number(view.getBigUint64(content + 24));
    return timescale > 0 ? duration / timescale : undefined;
  }
  const timescale = view.getUint32(content + 12);
  const duration = view.getUint32(content + 16);
  return timescale > 0 ? duration / timescale : undefined;
}

function parseTimescale(view: DataView, box: BufferedBox): number | undefined {
  const content = box.offsetInBuffer + box.headerSize;
  if (content + 20 > view.byteLength) return undefined;
  const version = view.getUint8(content);
  if (version === 1) return content + 24 <= view.byteLength ? view.getUint32(content + 20) : undefined;
  return view.getUint32(content + 12);
}

function parseTkhdTrackId(view: DataView, box: BufferedBox): number | undefined {
  const content = box.offsetInBuffer + box.headerSize;
  if (content + 24 > view.byteLength) return undefined;
  const version = view.getUint8(content);
  return version === 1 ? view.getUint32(content + 20) : view.getUint32(content + 12);
}

function parseTkhdSize(view: DataView, box: BufferedBox): { width?: number; height?: number } {
  const end = box.offsetInBuffer + box.size;
  if (end - 8 < 0 || end > view.byteLength) return {};
  return {
    width: view.getUint32(end - 8) / 65536,
    height: view.getUint32(end - 4) / 65536,
  };
}

function parseHandlerType(view: DataView, box: BufferedBox): string | undefined {
  const content = box.offsetInBuffer + box.headerSize;
  return content + 12 <= view.byteLength ? readAscii(view, content + 8, 4) : undefined;
}

function parseStsd(view: DataView, stsd: BufferedBox): SampleDescription[] {
  const content = stsd.offsetInBuffer + stsd.headerSize;
  if (content + 8 > view.byteLength) return [];
  const entryCount = view.getUint32(content + 4);
  const descriptions: SampleDescription[] = [];
  let offset = content + 8;
  for (let i = 0; i < entryCount && offset + 8 <= stsd.offsetInBuffer + stsd.size; i++) {
    const entry = parseBoxHeader(view, offset, stsd.offset + offset - stsd.offsetInBuffer, stsd.offset + stsd.size) as BufferedBox | null;
    if (!entry || offset + entry.size > stsd.offsetInBuffer + stsd.size) break;
    entry.offsetInBuffer = offset;
    descriptions.push(parseSampleDescription(view, entry));
    offset += entry.size;
  }
  return descriptions;
}

function parseSampleDescription(view: DataView, entry: BufferedBox): SampleDescription {
  const content = entry.offsetInBuffer + entry.headerSize;
  const codecTag = entry.type;
  const childStart = audioEntryChildStart(codecTag, content) || videoEntryChildStart(codecTag, content) || content + 8;
  const childBoxes = parseBoxes(view, childStart, entry.offsetInBuffer + entry.size, entry.offset + childStart - entry.offsetInBuffer);
  let codec = codecTag;

  const avcC = childBoxes.find((box) => box.type === "avcC");
  const esds = childBoxes.find((box) => box.type === "esds");
  if ((codecTag === "avc1" || codecTag === "avc3") && avcC) codec = parseAvcCodec(view, codecTag, avcC) || codecTag;
  if (codecTag === "mp4a" && esds) codec = parseMp4aCodec(view, esds) || codecTag;

  return {
    codecTag,
    codec,
    ...parseVideoSampleEntry(view, codecTag, content),
    ...parseAudioSampleEntry(view, codecTag, content),
  };
}

function videoEntryChildStart(codecTag: string, content: number): number | null {
  return ["avc1", "avc3", "hvc1", "hev1", "mp4v", "vp09"].includes(codecTag) ? content + 78 : null;
}

function audioEntryChildStart(codecTag: string, content: number): number | null {
  return ["mp4a", "ac-3", "ec-3", "alac", "dtsc", "dtsh", "dtsl", "dtsx"].includes(codecTag) ? content + 28 : null;
}

function parseVideoSampleEntry(view: DataView, codecTag: string, content: number): { width?: number; height?: number } {
  if (!videoEntryChildStart(codecTag, content) || content + 28 > view.byteLength) return {};
  return { width: view.getUint16(content + 24), height: view.getUint16(content + 26) };
}

function parseAudioSampleEntry(view: DataView, codecTag: string, content: number): { sampleRate?: number; channelCount?: number } {
  if (!audioEntryChildStart(codecTag, content) || content + 28 > view.byteLength) return {};
  const sampleRateFixed = view.getUint32(content + 24);
  return { channelCount: view.getUint16(content + 16), sampleRate: sampleRateFixed >>> 16 };
}

function parseAvcCodec(view: DataView, codecTag: string, avcC: BufferedBox): string | null {
  const content = avcC.offsetInBuffer + avcC.headerSize;
  if (content + 4 > view.byteLength) return null;
  const profile = view.getUint8(content + 1);
  const compatibility = view.getUint8(content + 2);
  const level = view.getUint8(content + 3);
  return `${codecTag}.${toHex(profile)}${toHex(compatibility)}${toHex(level)}`;
}

function parseMp4aCodec(view: DataView, esds: BufferedBox): string | null {
  const content = esds.offsetInBuffer + esds.headerSize + 4;
  const end = esds.offsetInBuffer + esds.size;
  const esDescriptor = readDescriptor(view, content, end, 0x03);
  if (!esDescriptor || esDescriptor.payloadStart + 3 > esDescriptor.payloadEnd) return null;
  let decoderConfigStart = esDescriptor.payloadStart + 3;
  const flags = view.getUint8(esDescriptor.payloadStart + 2);
  if (flags & 0x80) decoderConfigStart += 2;
  if (flags & 0x40) {
    if (decoderConfigStart >= esDescriptor.payloadEnd) return null;
    decoderConfigStart += 1 + view.getUint8(decoderConfigStart);
  }
  if (flags & 0x20) decoderConfigStart += 2;
  const decoderConfig = readDescriptor(view, decoderConfigStart, esDescriptor.payloadEnd, 0x04);
  if (!decoderConfig || decoderConfig.payloadStart + 13 > view.byteLength) return null;
  const objectTypeIndication = view.getUint8(decoderConfig.payloadStart);
  const decoderSpecific = readDescriptor(view, decoderConfig.payloadStart + 13, decoderConfig.payloadEnd, 0x05);
  const audioObjectType = decoderSpecific ? parseAudioObjectType(view, decoderSpecific.payloadStart, decoderSpecific.payloadEnd) : undefined;
  return audioObjectType ? `mp4a.${toHex(objectTypeIndication)}.${audioObjectType}` : `mp4a.${toHex(objectTypeIndication)}`;
}

function readDescriptor(view: DataView, start: number, end: number, targetTag: number): { payloadStart: number; payloadEnd: number } | null {
  let offset = start;
  while (offset + 2 <= end) {
    const tag = view.getUint8(offset++);
    const lengthResult = readDescriptorLength(view, offset, end);
    if (!lengthResult) return null;
    const { length, nextOffset } = lengthResult;
    const payloadStart = nextOffset;
    const payloadEnd = Math.min(end, payloadStart + length);
    if (tag === targetTag) return { payloadStart, payloadEnd };
    offset = payloadEnd;
  }
  return null;
}

function readDescriptorLength(view: DataView, start: number, end: number): { length: number; nextOffset: number } | null {
  let length = 0;
  let offset = start;
  for (let i = 0; i < 4 && offset < end; i++) {
    const value = view.getUint8(offset++);
    length = (length << 7) | (value & 0x7f);
    if ((value & 0x80) === 0) return { length, nextOffset: offset };
  }
  return null;
}

function parseAudioObjectType(view: DataView, start: number, end: number): number | undefined {
  if (start >= end) return undefined;
  const first = view.getUint8(start);
  const objectType = first >> 3;
  if (objectType !== 31) return objectType;
  if (start + 1 >= end) return objectType;
  return 32 + (((first & 0x07) << 3) | (view.getUint8(start + 1) >> 5));
}

function readAscii(view: DataView, offset: number, length: number): string {
  if (offset + length > view.byteLength) return "";
  let value = "";
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i));
  return value;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

const INCOMPATIBLE_VIDEO_CODECS: Record<string, string> = {
  mp4v: "MPEG-4 Part 2 编码无法在线播放",
};

const PARTIAL_VIDEO_CODEC_PREFIXES: [string, string][] = [
  ["hev1", "HEVC/H.265 编码仅 Safari 可播放"],
  ["hvc1", "HEVC/H.265 编码仅 Safari 可播放"],
];

export function checkCodecCompatibility(metadata: MediaMetadata | null): string | null {
  if (!metadata || metadata.probe_status !== "ok") return null;
  const videoTracks = metadata.video_tracks || [];
  for (const track of videoTracks) {
    const codec = track.codec || track.codec_tag || "";
    if (INCOMPATIBLE_VIDEO_CODECS[codec]) return INCOMPATIBLE_VIDEO_CODECS[codec];
    for (const [prefix, message] of PARTIAL_VIDEO_CODEC_PREFIXES) {
      if (codec.startsWith(prefix)) return message;
    }
  }
  return null;
}
