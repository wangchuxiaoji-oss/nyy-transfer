import type { MediaTrackMetadata } from "./api";

const PROBE_VERSION = 1;
const HEADER_READ_BYTES = 16 * 1024 * 1024;

type BrowserKey = "windows_chrome" | "windows_edge" | "iphone_safari" | "harmony_browser" | "android_browser";
type SupportLevel = "yes" | "maybe" | "no" | "unknown";
type RemuxLevel = "good" | "possible" | "poor" | "unknown";

interface BrowserSupport {
  level: SupportLevel;
  reason: string;
}

interface RemuxPotential {
  level: RemuxLevel;
  reason: string;
}

interface PlaybackProbe {
  current_project: {
    playable: boolean;
    reason: string;
  };
  remux_potential: RemuxPotential;
  browser_support: Record<BrowserKey, BrowserSupport>;
  recommendations: string[];
}

export interface UnsupportedMediaProbe {
  probe_version: number;
  probe_status: "ok" | "failed" | "unsupported";
  probe_source: "client-container-header";
  container?: string;
  container_label?: string;
  file_size: number;
  bytes_read: number;
  video_tracks?: MediaTrackMetadata[];
  audio_tracks?: MediaTrackMetadata[];
  subtitle_tracks?: MediaTrackMetadata[];
  playback?: PlaybackProbe;
  warnings?: string[];
  probe_error?: string;
}

interface ParsedContainer {
  container: string;
  containerLabel: string;
  videoTracks: MediaTrackMetadata[];
  audioTracks: MediaTrackMetadata[];
  subtitleTracks: MediaTrackMetadata[];
  warnings: string[];
}

interface EbmlReadResult {
  value: number;
  length: number;
  unknown?: boolean;
}

interface EbmlRange {
  start: number;
  end: number;
}

const EBML_IDS = {
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackType: 0x83,
  codecId: 0x86,
  video: 0xe0,
  audio: 0xe1,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  samplingFrequency: 0xb5,
  channels: 0x9f,
};

const ASF_GUIDS = {
  header: "3026b2758e66cf11a6d900aa0062ce6c",
  streamProperties: "9107dcb7b7a9cf118ee600c00c205365",
  videoMedia: "c0ef19bc4d5bcf11a8fd00805f5c442b",
  audioMedia: "409e69f84d5bcf11a8fd00805f5c442b",
};

export async function probeUnsupportedMedia(file: File, fileName: string): Promise<UnsupportedMediaProbe> {
  const readBytes = Math.min(file.size, HEADER_READ_BYTES);
  const buffer = await file.slice(0, readBytes).arrayBuffer();
  return probeUnsupportedMediaBuffer(buffer, fileName, file.size);
}

export function probeUnsupportedMediaBuffer(buffer: ArrayBuffer, fileName: string, fileSize: number): UnsupportedMediaProbe {
  const ext = getFileExtension(fileName);
  const readBytes = buffer.byteLength;
  const view = new DataView(buffer);

  try {
    const parsed = parseByExtension(view, ext);
    if (!parsed) {
      return {
        probe_version: PROBE_VERSION,
        probe_status: "unsupported",
        probe_source: "client-container-header",
        file_size: fileSize,
        bytes_read: readBytes,
        probe_error: `暂未实现 ${ext || "unknown"} 容器头解析`,
      };
    }

    const playback = buildPlaybackProbe(parsed, ext);
    return {
      probe_version: PROBE_VERSION,
      probe_status: "ok",
      probe_source: "client-container-header",
      container: parsed.container,
      container_label: parsed.containerLabel,
      file_size: fileSize,
      bytes_read: readBytes,
      video_tracks: parsed.videoTracks,
      audio_tracks: parsed.audioTracks,
      subtitle_tracks: parsed.subtitleTracks,
      playback,
      warnings: parsed.warnings,
    };
  } catch (err) {
    return {
      probe_version: PROBE_VERSION,
      probe_status: "failed",
      probe_source: "client-container-header",
      file_size: fileSize,
      bytes_read: readBytes,
      probe_error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseByExtension(view: DataView, ext: string): ParsedContainer | null {
  if (ext === "mkv") return parseMatroska(view);
  if (ext === "avi" || ext === "divx" || ext === "xvid") return parseAvi(view);
  if (ext === "wmv" || ext === "asf") return parseAsf(view);
  return null;
}

function parseMatroska(view: DataView): ParsedContainer {
  const tracksRange = findEbmlElement(view, EBML_IDS.tracks);
  const videoTracks: MediaTrackMetadata[] = [];
  const audioTracks: MediaTrackMetadata[] = [];
  const subtitleTracks: MediaTrackMetadata[] = [];
  const warnings: string[] = [];

  if (!tracksRange) {
    warnings.push("未在头部读取范围内找到 Matroska Tracks 元素");
    return { container: "matroska", containerLabel: "MKV / Matroska", videoTracks, audioTracks, subtitleTracks, warnings };
  }

  let offset = tracksRange.start;
  while (offset < tracksRange.end) {
    const element = readEbmlElement(view, offset, tracksRange.end);
    if (!element) break;
    if (element.id === EBML_IDS.trackEntry) {
      const track = parseMatroskaTrackEntry(view, element.contentStart, element.contentEnd);
      if (track.type === "video") videoTracks.push(track);
      else if (track.type === "audio") audioTracks.push(track);
      else if (track.type === "subtitle") subtitleTracks.push(track);
    }
    offset = element.nextOffset;
  }

  if (videoTracks.length === 0 && audioTracks.length === 0) warnings.push("Matroska Tracks 已找到，但未识别到音视频轨道");
  return { container: "matroska", containerLabel: "MKV / Matroska", videoTracks, audioTracks, subtitleTracks, warnings };
}

function parseMatroskaTrackEntry(view: DataView, start: number, end: number): MediaTrackMetadata {
  let trackType = 0;
  let codecId = "";
  const video: { width?: number; height?: number } = {};
  const audio: { sampleRate?: number; channelCount?: number } = {};

  let offset = start;
  while (offset < end) {
    const element = readEbmlElement(view, offset, end);
    if (!element) break;
    if (element.id === EBML_IDS.trackType) trackType = readEbmlUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === EBML_IDS.codecId) codecId = readAscii(view, element.contentStart, element.contentEnd - element.contentStart);
    if (element.id === EBML_IDS.video) parseMatroskaVideo(view, element.contentStart, element.contentEnd, video);
    if (element.id === EBML_IDS.audio) parseMatroskaAudio(view, element.contentStart, element.contentEnd, audio);
    offset = element.nextOffset;
  }

  const mapped = mapMatroskaCodec(codecId, trackType);
  return {
    type: mapped.type,
    codec: mapped.codec,
    codec_tag: codecId || undefined,
    width: video.width,
    height: video.height,
    sample_rate: audio.sampleRate,
    channel_count: audio.channelCount,
  };
}

function parseMatroskaVideo(view: DataView, start: number, end: number, video: { width?: number; height?: number }) {
  let offset = start;
  while (offset < end) {
    const element = readEbmlElement(view, offset, end);
    if (!element) break;
    if (element.id === EBML_IDS.pixelWidth) video.width = readEbmlUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === EBML_IDS.pixelHeight) video.height = readEbmlUnsigned(view, element.contentStart, element.contentEnd);
    offset = element.nextOffset;
  }
}

function parseMatroskaAudio(view: DataView, start: number, end: number, audio: { sampleRate?: number; channelCount?: number }) {
  let offset = start;
  while (offset < end) {
    const element = readEbmlElement(view, offset, end);
    if (!element) break;
    if (element.id === EBML_IDS.channels) audio.channelCount = readEbmlUnsigned(view, element.contentStart, element.contentEnd);
    if (element.id === EBML_IDS.samplingFrequency) audio.sampleRate = Math.round(readEbmlFloat(view, element.contentStart, element.contentEnd) || 0) || undefined;
    offset = element.nextOffset;
  }
}

function findEbmlElement(view: DataView, targetId: number): EbmlRange | null {
  const stack: EbmlRange[] = [{ start: 0, end: view.byteLength }];
  while (stack.length > 0) {
    const range = stack.pop()!;
    let offset = range.start;
    while (offset < range.end) {
      const element = readEbmlElement(view, offset, range.end);
      if (!element) break;
      if (element.id === targetId) return { start: element.contentStart, end: element.contentEnd };
      if (element.id === EBML_IDS.segment) stack.push({ start: element.contentStart, end: element.contentEnd });
      offset = element.nextOffset;
    }
  }
  return null;
}

function readEbmlElement(view: DataView, offset: number, end: number) {
  const id = readEbmlId(view, offset, end);
  if (!id) return null;
  const size = readEbmlSize(view, offset + id.length, end);
  if (!size) return null;
  const contentStart = offset + id.length + size.length;
  const contentEnd = size.unknown ? end : Math.min(end, contentStart + size.value);
  if (contentStart > end || contentEnd < contentStart) return null;
  return { id: id.value, contentStart, contentEnd, nextOffset: contentEnd };
}

function readEbmlId(view: DataView, offset: number, end: number): EbmlReadResult | null {
  if (offset >= end) return null;
  const first = view.getUint8(offset);
  const length = ebmlVintLength(first);
  if (!length || offset + length > end) return null;
  let value = first;
  for (let i = 1; i < length; i++) value = (value << 8) | view.getUint8(offset + i);
  return { value, length };
}

function readEbmlSize(view: DataView, offset: number, end: number): EbmlReadResult | null {
  if (offset >= end) return null;
  const first = view.getUint8(offset);
  const length = ebmlVintLength(first);
  if (!length || offset + length > end) return null;
  const mask = 1 << (8 - length);
  let value = first & (mask - 1);
  let max = mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + view.getUint8(offset + i);
    max = max * 256 + 255;
  }
  return { value, length, unknown: value === max };
}

function ebmlVintLength(firstByte: number): number | null {
  for (let length = 1; length <= 8; length++) {
    if (firstByte & (1 << (8 - length))) return length;
  }
  return null;
}

function readEbmlUnsigned(view: DataView, start: number, end: number): number {
  let value = 0;
  for (let offset = start; offset < end; offset++) value = value * 256 + view.getUint8(offset);
  return value;
}

function readEbmlFloat(view: DataView, start: number, end: number): number | undefined {
  const length = end - start;
  if (length === 4) return view.getFloat32(start, false);
  if (length === 8) return view.getFloat64(start, false);
  return undefined;
}

function parseAvi(view: DataView): ParsedContainer {
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "AVI ") {
    throw new Error("不是有效的 AVI RIFF 文件");
  }

  const videoTracks: MediaTrackMetadata[] = [];
  const audioTracks: MediaTrackMetadata[] = [];
  const warnings: string[] = [];
  parseAviChunks(view, 12, view.byteLength, videoTracks, audioTracks);
  if (videoTracks.length === 0 && audioTracks.length === 0) warnings.push("未在 AVI 头部读取范围内识别到音视频轨道");
  return { container: "avi", containerLabel: "AVI / RIFF", videoTracks, audioTracks, subtitleTracks: [], warnings };
}

function parseAviChunks(view: DataView, start: number, end: number, videoTracks: MediaTrackMetadata[], audioTracks: MediaTrackMetadata[]) {
  let offset = start;
  while (offset + 8 <= end) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const contentStart = offset + 8;
    const contentEnd = Math.min(end, contentStart + size);
    if (contentEnd < contentStart) break;
    if (id === "LIST") {
      const listType = readAscii(view, contentStart, 4);
      if (listType === "strl") parseAviStreamList(view, contentStart + 4, contentEnd, videoTracks, audioTracks);
      else parseAviChunks(view, contentStart + 4, contentEnd, videoTracks, audioTracks);
    }
    offset = contentEnd + (size % 2);
  }
}

function parseAviStreamList(view: DataView, start: number, end: number, videoTracks: MediaTrackMetadata[], audioTracks: MediaTrackMetadata[]) {
  let streamType = "";
  let streamHandler = "";
  const track: MediaTrackMetadata = { type: "unknown", codec: "unknown" };

  let offset = start;
  while (offset + 8 <= end) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const contentStart = offset + 8;
    const contentEnd = Math.min(end, contentStart + size);
    if (id === "strh" && contentStart + 8 <= contentEnd) {
      streamType = readAscii(view, contentStart, 4);
      streamHandler = sanitizeFourCc(readAscii(view, contentStart + 4, 4));
      track.type = streamType === "vids" ? "video" : streamType === "auds" ? "audio" : "unknown";
      if (track.type === "video" && streamHandler) {
        const mapped = mapVideoFourCc(streamHandler);
        track.codec = mapped.codec;
        track.codec_tag = streamHandler;
      }
    } else if (id === "strf") {
      if (streamType === "vids" && contentStart + 20 <= contentEnd) {
        track.type = "video";
        track.width = Math.abs(view.getInt32(contentStart + 4, true));
        track.height = Math.abs(view.getInt32(contentStart + 8, true));
        const fourCc = sanitizeFourCc(readAscii(view, contentStart + 16, 4)) || streamHandler;
        const mapped = mapVideoFourCc(fourCc);
        track.codec = mapped.codec;
        track.codec_tag = fourCc || undefined;
      }
      if (streamType === "auds" && contentStart + 16 <= contentEnd) {
        track.type = "audio";
        const tag = view.getUint16(contentStart, true);
        const mapped = mapAudioFormatTag(tag);
        track.codec = mapped.codec;
        track.codec_tag = mapped.tag;
        track.channel_count = view.getUint16(contentStart + 2, true);
        track.sample_rate = view.getUint32(contentStart + 4, true);
      }
    }
    offset = contentEnd + (size % 2);
  }

  if (track.type === "video") videoTracks.push(track);
  if (track.type === "audio") audioTracks.push(track);
}

function parseAsf(view: DataView): ParsedContainer {
  if (guidAt(view, 0) !== ASF_GUIDS.header) throw new Error("不是有效的 ASF/WMV 文件");
  const objectCount = view.byteLength >= 28 ? view.getUint32(24, true) : 0;
  const videoTracks: MediaTrackMetadata[] = [];
  const audioTracks: MediaTrackMetadata[] = [];
  const warnings: string[] = [];
  let offset = 30;

  for (let i = 0; i < objectCount && offset + 24 <= view.byteLength; i++) {
    const guid = guidAt(view, offset);
    const size = readUint64Le(view, offset + 16);
    const contentStart = offset + 24;
    const contentEnd = Math.min(view.byteLength, offset + size);
    if (guid === ASF_GUIDS.streamProperties) parseAsfStreamProperties(view, contentStart, contentEnd, videoTracks, audioTracks);
    if (!Number.isFinite(size) || size < 24) break;
    offset += size;
  }

  if (videoTracks.length === 0 && audioTracks.length === 0) warnings.push("未在 ASF 头部读取范围内识别到音视频轨道");
  return { container: "asf", containerLabel: "ASF / WMV", videoTracks, audioTracks, subtitleTracks: [], warnings };
}

function parseAsfStreamProperties(view: DataView, start: number, end: number, videoTracks: MediaTrackMetadata[], audioTracks: MediaTrackMetadata[]) {
  if (start + 54 > end) return;
  const streamType = guidAt(view, start);
  const typeSpecificLength = view.getUint32(start + 40, true);
  const dataStart = start + 54;
  const dataEnd = Math.min(end, dataStart + typeSpecificLength);

  if (streamType === ASF_GUIDS.videoMedia && dataStart + 31 <= dataEnd) {
    const bmiStart = dataStart + 11;
    const fourCc = sanitizeFourCc(readAscii(view, bmiStart + 16, 4));
    const mapped = mapVideoFourCc(fourCc);
    videoTracks.push({
      type: "video",
      codec: mapped.codec,
      codec_tag: fourCc || undefined,
      width: view.getUint32(dataStart, true) || view.getInt32(bmiStart + 4, true),
      height: view.getUint32(dataStart + 4, true) || Math.abs(view.getInt32(bmiStart + 8, true)),
    });
  }

  if (streamType === ASF_GUIDS.audioMedia && dataStart + 16 <= dataEnd) {
    const tag = view.getUint16(dataStart, true);
    const mapped = mapAudioFormatTag(tag);
    audioTracks.push({
      type: "audio",
      codec: mapped.codec,
      codec_tag: mapped.tag,
      channel_count: view.getUint16(dataStart + 2, true),
      sample_rate: view.getUint32(dataStart + 4, true),
    });
  }
}

function buildPlaybackProbe(parsed: ParsedContainer, ext: string): PlaybackProbe {
  const videoCodec = parsed.videoTracks[0]?.codec || "unknown";
  const audioCodec = parsed.audioTracks[0]?.codec || "unknown";
  const remux = getRemuxPotential(parsed.container, videoCodec, audioCodec);
  const browserSupport = getBrowserSupport(parsed.container, videoCodec, audioCodec);
  const recommendations = [
    "当前项目默认不把该扩展名交给 HTML5 播放器，上传后应提示仅支持下载或实验性直放",
  ];

  if (parsed.container === "matroska") recommendations.push("MKV 可在 Chromium 系浏览器做实验性 direct-play 检测，但不能作为跨端稳定能力");
  if (remux.level === "good") recommendations.push("如果用户明确同意修改云端文件字节，可考虑未来做客户端 remux 到 MP4；当前不建议默认执行");
  if (parsed.container === "avi" || parsed.container === "asf") recommendations.push(`${ext.toUpperCase()} 更适合明确降级为下载，本项目不建议浏览器端软解作为默认方案`);

  return {
    current_project: {
      playable: false,
      reason: "当前播放器基于浏览器原生 HTML5 video，且该扩展名未进入可播放白名单",
    },
    remux_potential: remux,
    browser_support: browserSupport,
    recommendations,
  };
}

function getRemuxPotential(container: string, videoCodec: string, audioCodec: string): RemuxPotential {
  const mp4Video = ["h264", "hevc", "av1", "vp9"].includes(videoCodec);
  const mp4Audio = ["aac", "mp3", "ac3", "eac3", "opus"].includes(audioCodec) || audioCodec === "unknown";
  if (container === "matroska" && mp4Video && mp4Audio) {
    return { level: "possible", reason: "内部编码可能可放入 MP4；仍需处理字幕、附件、时间戳等 Matroska 特性" };
  }
  if (container === "avi" && videoCodec === "h264" && mp4Audio) {
    return { level: "possible", reason: "H.264 in AVI 理论上可换封装，但 AVI 时间戳/B-frame 兼容风险较高" };
  }
  if (["wmv", "wmv2", "wmv3", "vc1", "mpeg4-part2", "mjpeg"].includes(videoCodec)) {
    return { level: "poor", reason: "视频编码本身不属于现代浏览器稳定支持范围，换容器无法解决" };
  }
  return { level: "unknown", reason: "需要更完整的流信息才能判断是否可无损换封装" };
}

function getBrowserSupport(container: string, videoCodec: string, audioCodec: string): Record<BrowserKey, BrowserSupport> {
  const no = (reason: string): BrowserSupport => ({ level: "no", reason });
  const maybe = (reason: string): BrowserSupport => ({ level: "maybe", reason });

  if (container === "matroska") {
    const baseCodecOk = ["h264", "vp8", "vp9", "av1"].includes(videoCodec) && ["aac", "mp3", "opus", "vorbis", "unknown"].includes(audioCodec);
    const hevc = videoCodec === "hevc";
    return {
      windows_chrome: baseCodecOk ? maybe("Chromium 支持 Matroska 容器，但 H.264/AAC in MKV 仍需实测") : hevc ? maybe("HEVC 依赖 Chrome 版本、系统和硬件解码") : no("容器或编码组合不在 Chromium 稳定 Web 播放范围"),
      windows_edge: baseCodecOk ? maybe("Edge 为 Chromium 内核，Matroska 行为接近 Chrome，仍需实测") : hevc ? maybe("HEVC 依赖系统 HEVC 扩展和硬件") : no("容器或编码组合不在 Edge 稳定 Web 播放范围"),
      iphone_safari: no("Safari 官方静态视频建议 H.264 MP4，不支持 MKV 容器作为稳定 Web 格式"),
      harmony_browser: maybe("鸿蒙浏览器内核和系统解码能力差异较大，MKV 不能作为稳定能力"),
      android_browser: baseCodecOk || hevc ? maybe("Android 平台支持部分 Matroska，但浏览器/WebView 表现依设备而异") : no("编码组合不在移动浏览器稳定范围"),
    };
  }

  if (container === "avi") {
    return {
      windows_chrome: no("Chromium 官方容器列表不包含 AVI"),
      windows_edge: no("新版 Edge 为 Chromium 内核，不提供 AVI Web 播放能力"),
      iphone_safari: no("Safari 静态视频推荐 H.264 MP4，不支持 AVI"),
      harmony_browser: no("移动浏览器不应假设支持 AVI 容器"),
      android_browser: no("Android 平台格式支持不等于浏览器 HTML5 video 支持，AVI 不可靠"),
    };
  }

  if (container === "asf") {
    return {
      windows_chrome: no("Chromium 官方容器列表不包含 ASF/WMV"),
      windows_edge: no("新版 Edge 不再是旧版 EdgeHTML/Windows Media Player 插件路径"),
      iphone_safari: no("Safari 不支持 ASF/WMV Web 播放"),
      harmony_browser: no("移动浏览器不应假设支持 ASF/WMV"),
      android_browser: no("Android 浏览器不提供稳定 WMV Web 播放能力"),
    };
  }

  return {
    windows_chrome: { level: "unknown", reason: "未知容器" },
    windows_edge: { level: "unknown", reason: "未知容器" },
    iphone_safari: { level: "unknown", reason: "未知容器" },
    harmony_browser: { level: "unknown", reason: "未知容器" },
    android_browser: { level: "unknown", reason: "未知容器" },
  };
}

function mapMatroskaCodec(codecId: string, trackType: number): { type: string; codec: string } {
  if (codecId === "V_MPEG4/ISO/AVC") return { type: "video", codec: "h264" };
  if (codecId === "V_MPEGH/ISO/HEVC") return { type: "video", codec: "hevc" };
  if (codecId === "V_AV1") return { type: "video", codec: "av1" };
  if (codecId === "V_VP9") return { type: "video", codec: "vp9" };
  if (codecId === "V_VP8") return { type: "video", codec: "vp8" };
  if (codecId === "V_MPEG4/ISO/ASP") return { type: "video", codec: "mpeg4-part2" };
  if (codecId === "A_AAC") return { type: "audio", codec: "aac" };
  if (codecId === "A_AC3") return { type: "audio", codec: "ac3" };
  if (codecId === "A_EAC3") return { type: "audio", codec: "eac3" };
  if (codecId === "A_DTS") return { type: "audio", codec: "dts" };
  if (codecId === "A_OPUS") return { type: "audio", codec: "opus" };
  if (codecId === "A_VORBIS") return { type: "audio", codec: "vorbis" };
  if (codecId === "A_MPEG/L3") return { type: "audio", codec: "mp3" };
  if (codecId.startsWith("S_")) return { type: "subtitle", codec: codecId.toLowerCase() };
  if (trackType === 1) return { type: "video", codec: codecId || "unknown" };
  if (trackType === 2) return { type: "audio", codec: codecId || "unknown" };
  if (trackType === 17) return { type: "subtitle", codec: codecId || "unknown" };
  return { type: "unknown", codec: codecId || "unknown" };
}

function mapVideoFourCc(fourCc: string): { codec: string } {
  const value = fourCc.toUpperCase();
  if (["H264", "X264", "AVC1"].includes(value)) return { codec: "h264" };
  if (["HEVC", "HVC1"].includes(value)) return { codec: "hevc" };
  if (["XVID", "DIVX", "DX50", "FMP4", "MP4V", "M4S2"].includes(value)) return { codec: "mpeg4-part2" };
  if (["WMV1"].includes(value)) return { codec: "wmv" };
  if (["WMV2"].includes(value)) return { codec: "wmv2" };
  if (["WMV3"].includes(value)) return { codec: "wmv3" };
  if (["WVC1", "VC-1"].includes(value)) return { codec: "vc1" };
  if (["MJPG", "MJPEG"].includes(value)) return { codec: "mjpeg" };
  return { codec: value ? value.toLowerCase() : "unknown" };
}

function mapAudioFormatTag(tag: number): { codec: string; tag: string } {
  if (tag === 0x0001) return { codec: "pcm", tag: "0x0001" };
  if (tag === 0x0055) return { codec: "mp3", tag: "0x0055" };
  if (tag === 0x00ff) return { codec: "aac", tag: "0x00ff" };
  if (tag === 0x2000) return { codec: "ac3", tag: "0x2000" };
  if (tag === 0x2001) return { codec: "dts", tag: "0x2001" };
  if (tag === 0x0160 || tag === 0x0161) return { codec: "wma", tag: `0x${tag.toString(16).padStart(4, "0")}` };
  if (tag === 0x0162) return { codec: "wma-pro", tag: "0x0162" };
  if (tag === 0x0163) return { codec: "wma-lossless", tag: "0x0163" };
  return { codec: "unknown", tag: `0x${tag.toString(16).padStart(4, "0")}` };
}

function guidAt(view: DataView, offset: number): string {
  if (offset + 16 > view.byteLength) return "";
  let value = "";
  for (let i = 0; i < 16; i++) value += view.getUint8(offset + i).toString(16).padStart(2, "0");
  return value;
}

function readUint64Le(view: DataView, offset: number): number {
  if (offset + 8 > view.byteLength) return 0;
  return Number(view.getBigUint64(offset, true));
}

function readAscii(view: DataView, offset: number, length: number): string {
  if (offset < 0 || offset + length > view.byteLength) return "";
  let value = "";
  for (let i = 0; i < length; i++) value += String.fromCharCode(view.getUint8(offset + i));
  return value.replace(/\0+$/g, "");
}

function sanitizeFourCc(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").trim();
}

function getFileExtension(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}
