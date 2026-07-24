import type { MediaMetadata, ShareFileDownload } from "./api";

const METADATA_HEAD_BYTES = 1024 * 1024;
const SAMPLE_RANGE_MAX_GAP_BYTES = 256 * 1024;
const DECODED_WINDOW_CACHE_LIMIT = 24;
const RANGE_FETCH_RETRY_COUNT = 2;
const RANGE_FETCH_RETRY_DELAY_MS = 160;

interface VirtualChunk {
  urls: string[];
  start: number;
  end: number;
  size: number;
}

interface Mp4MetadataBuffer {
  fileStart: number;
  bytes: ArrayBuffer;
}

interface AudioSampleEntry {
  offset: number;
  size: number;
  dts: number;
  duration: number;
}

interface Ac3SampleTable {
  id: number;
  codec: string;
  timescale: number;
  samples: AudioSampleEntry[];
}

declare global {
  interface Window {
    LibAV?: {
      base?: string;
      LibAV?: (opts?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

let libavLoaderPromise: Promise<void> | null = null;

// AC-3 音轨探测结果缓存，按当前签名链接维度复用。
const ac3TrackCache = new Map<string, boolean>();

// 复用 libav 实例，避免每个音频窗口重复实例化 WASM。
let libavInstance: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null;

const mp4MetadataBufferCache = new Map<string, Promise<Mp4MetadataBuffer[]>>();
const ac3SampleTableCache = new Map<string, Promise<Ac3SampleTable>>();
const decodedAc3WindowCache = new Map<string, Promise<DecodedAc3Window>>();

class SidecarVirtualFile {
  private chunks: VirtualChunk[];
  readonly totalSize: number;

  constructor(file: ShareFileDownload) {
    if (file.is_chunked) {
      let offset = 0;
      this.chunks = [...file.chunks].sort((a, b) => a.index - b.index).map((chunk) => {
        const item = { urls: [chunk.download_url, chunk.backup_download_url || ""].filter(Boolean), start: offset, end: offset + chunk.size - 1, size: chunk.size };
        offset += chunk.size;
        return item;
      });
      this.totalSize = offset;
    } else {
      this.chunks = [{ urls: [file.download_url, file.backup_download_url || ""].filter(Boolean), start: 0, end: file.file_size - 1, size: file.file_size }];
      this.totalSize = file.file_size;
    }
  }

  async fetchRange(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    end = Math.min(end, this.totalSize);
    if (start >= end) return new ArrayBuffer(0);
    const parts: ArrayBuffer[] = [];
    for (const chunk of this.chunks) {
      if (chunk.end < start) continue;
      if (chunk.start >= end) break;
      const localStart = Math.max(0, start - chunk.start);
      const localEnd = Math.min(chunk.size, end - chunk.start);
      const resp = await fetchRangeWithRetry(chunk.urls, localStart, localEnd - 1, signal);
      if (!resp.ok && resp.status !== 206) throw new Error(`Range fetch failed: HTTP ${resp.status}`);
      parts.push(await resp.arrayBuffer());
    }
    if (parts.length === 1) return parts[0];
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const part of parts) {
      out.set(new Uint8Array(part), pos);
      pos += part.byteLength;
    }
    return out.buffer;
  }
}

function makeAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function isTransientFetchError(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|networkerror/i.test(err.message || "");
}

async function waitForRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw makeAbortError();
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, RANGE_FETCH_RETRY_DELAY_MS);
    const onAbort = () => {
      window.clearTimeout(timer);
      cleanup();
      reject(makeAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchRangeWithRetry(urls: string[], start: number, end: number, signal?: AbortSignal): Promise<Response> {
  let lastError: unknown;
  let lastResponse: Response | null = null;
  for (const url of urls) {
    for (let attempt = 0; attempt <= RANGE_FETCH_RETRY_COUNT; attempt += 1) {
      if (signal?.aborted) throw makeAbortError();
      try {
        const response = await fetch(url, {
          headers: { Range: `bytes=${start}-${end}` },
          signal,
        });
        if (response.ok || response.status === 206) return response;
        lastResponse = response;
        break;
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw makeAbortError();
        lastError = err;
        if (!isTransientFetchError(err) || attempt >= RANGE_FETCH_RETRY_COUNT) break;
        await waitForRetry(signal);
      }
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error("Range fetch failed");
}

export function canNativePlayAc3(): boolean {
  if (typeof document === "undefined") return false;
  const video = document.createElement("video");
  return Boolean(video.canPlayType('video/mp4; codecs="avc1.640029,ac-3"'));
}

async function loadLibavAc3Script(): Promise<void> {
  if (typeof window === "undefined") throw new Error("window is unavailable");
  if (window.LibAV?.LibAV) return;
  if (libavLoaderPromise) return libavLoaderPromise;

  libavLoaderPromise = new Promise<void>((resolve, reject) => {
    window.LibAV = { ...(window.LibAV || {}), base: `${window.location.origin}/libav-ac3` };
    const script = document.createElement("script");
    script.src = "/libav-ac3/libav-ac3.js";
    script.async = true;
    script.onload = () => {
      if (window.LibAV?.LibAV) resolve();
      else reject(new Error("libav-ac3 loaded but LibAV factory is missing"));
    };
    script.onerror = () => reject(new Error("Failed to load libav-ac3.js"));
    document.head.appendChild(script);
  }).catch((err) => {
    // 加载失败后允许下一次重新尝试。
    libavLoaderPromise = null;
    throw err;
  });

  return libavLoaderPromise;
}

function getNumberMetadataField(metadata: MediaMetadata | null | undefined, key: string): number | null {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function getAudioCodecs(metadata: MediaMetadata | null | undefined): string[] {
  return (metadata?.audio_tracks || [])
    .map((track) => (track.codec || track.codec_tag || "").toLowerCase())
    .filter(Boolean);
}

function getFileCacheKey(file: ShareFileDownload): string {
  const metadata = file.media_metadata;
  const chunks = file.is_chunked
    ? file.chunks.map((chunk) => `${chunk.index}:${chunk.size}`).join("|")
    : "single";
  const audioTracks = (metadata?.audio_tracks || [])
    .map((track) => `${track.codec || ""}:${track.codec_tag || ""}`)
    .join("|");
  const videoTracks = (metadata?.video_tracks || [])
    .map((track) => `${track.codec || ""}:${track.codec_tag || ""}`)
    .join("|");
  const assets = (metadata?.playback_assets || [])
    .map((asset) => `${asset.kind || ""}:${asset.sidecar_size || ""}:${asset.virtual_size || ""}:${asset.source_media_start || ""}:${asset.source_media_end || ""}`)
    .join("|");
  return [
    file.file_name,
    file.file_size,
    getNumberMetadataField(metadata, "moov_offset") ?? "no-moov-offset",
    getNumberMetadataField(metadata, "moov_size") ?? "no-moov-size",
    metadata?.container || "",
    chunks,
    audioTracks,
    videoTracks,
    assets,
  ].join("::");
}

function getSignedUrlCacheKey(file: ShareFileDownload): string {
  const metadata = file.media_metadata;
  const urls = file.is_chunked
    ? file.chunks.map((chunk) => `${chunk.index}:${chunk.size}:${chunk.download_url}`).join("|")
    : file.download_url;
  return [
    file.file_name,
    file.file_size,
    getNumberMetadataField(metadata, "moov_offset") ?? "no-moov-offset",
    getNumberMetadataField(metadata, "moov_size") ?? "no-moov-size",
    urls,
  ].join("::");
}

function getDecodedWindowCacheKey(file: ShareFileDownload, targetSec: number, requestedSec: number): string {
  return `${getFileCacheKey(file)}::window:${Math.max(0, targetSec).toFixed(3)}:${Math.max(0, requestedSec).toFixed(3)}`;
}

function cacheDecodedWindow(cacheKey: string, promise: Promise<DecodedAc3Window>): Promise<DecodedAc3Window> {
  decodedAc3WindowCache.set(cacheKey, promise);
  while (decodedAc3WindowCache.size > DECODED_WINDOW_CACHE_LIMIT) {
    const oldest = decodedAc3WindowCache.keys().next().value;
    if (!oldest) break;
    decodedAc3WindowCache.delete(oldest);
  }
  promise.catch(() => {
    if (decodedAc3WindowCache.get(cacheKey) === promise) decodedAc3WindowCache.delete(cacheKey);
  });
  return promise;
}

async function fetchMp4MetadataBuffers(file: ShareFileDownload, virtualFile: SidecarVirtualFile): Promise<Mp4MetadataBuffer[]> {
  const moovOffset = getNumberMetadataField(file.media_metadata, "moov_offset");
  const moovSize = getNumberMetadataField(file.media_metadata, "moov_size");
  if (moovOffset === null || moovSize === null || moovSize <= 0) {
    throw new Error("AC-3 sidecar requires uploaded MP4 metadata");
  }

  if (moovOffset <= METADATA_HEAD_BYTES) {
    const end = Math.min(virtualFile.totalSize, moovOffset + moovSize);
    return [{ fileStart: 0, bytes: await virtualFile.fetchRange(0, end) }];
  }

  return [
    {
      fileStart: 0,
      bytes: await virtualFile.fetchRange(0, Math.min(METADATA_HEAD_BYTES, virtualFile.totalSize)),
    },
    {
      fileStart: moovOffset,
      bytes: await virtualFile.fetchRange(moovOffset, Math.min(virtualFile.totalSize, moovOffset + moovSize)),
    },
  ];
}

function getMp4MetadataBuffers(file: ShareFileDownload, virtualFile: SidecarVirtualFile): Promise<Mp4MetadataBuffer[]> {
  const cacheKey = getFileCacheKey(file);
  const cached = mp4MetadataBufferCache.get(cacheKey);
  if (cached) return cached;

  const promise = fetchMp4MetadataBuffers(file, virtualFile).catch((err) => {
    mp4MetadataBufferCache.delete(cacheKey);
    throw err;
  });
  mp4MetadataBufferCache.set(cacheKey, promise);
  return promise;
}

async function parseMp4Metadata(
  mp4boxFile: import("mp4box").MP4File,
  buffers: Mp4MetadataBuffer[],
  signal?: AbortSignal,
): Promise<import("mp4box").MP4Info> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  let settled = false;
  let timer = 0;
  let rejectInfo: (reason?: unknown) => void = () => {};
  const cleanup = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
    mp4boxFile.onReady = null;
    mp4boxFile.onError = null;
  };

  const infoPromise = new Promise<import("mp4box").MP4Info>((resolve, reject) => {
    rejectInfo = reject;
    timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("mp4 metadata parsing timed out"));
    }, 15000);
    mp4boxFile.onReady = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    mp4boxFile.onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err || "mp4 metadata parsing failed")));
    };
  });

  try {
    for (const item of buffers) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const buffer = item.bytes.slice(0) as ArrayBuffer & { fileStart: number };
      buffer.fileStart = item.fileStart;
      mp4boxFile.appendBuffer(buffer);
    }
    try {
      mp4boxFile.flush();
    } catch {
      // 忽略 flush 异常，继续等待 onReady 或解析超时。
    }
    return await infoPromise;
  } catch (err) {
    if (!settled) {
      settled = true;
      cleanup();
      rejectInfo(err);
    }
    throw err;
  }
}

async function loadMp4Metadata(file: ShareFileDownload, signal?: AbortSignal): Promise<{
  mp4boxFile: import("mp4box").MP4File;
  info: import("mp4box").MP4Info;
  virtualFile: SidecarVirtualFile;
}> {
  const { createFile } = await import("mp4box");
  const vf = new SidecarVirtualFile(file);
  const metadataBuffers = await getMp4MetadataBuffers(file, vf);
  const mp4boxFile = createFile();
  return { mp4boxFile, info: await parseMp4Metadata(mp4boxFile, metadataBuffers, signal), virtualFile: vf };
}

function getMp4TrackSamples(mp4boxFile: import("mp4box").MP4File, trackId: number): AudioSampleEntry[] {
  const fileWithTrack = mp4boxFile as unknown as {
    getTrackById?: (id: number) => { samples?: Array<Partial<AudioSampleEntry>> } | undefined;
    getTrack?: (id: number) => { samples?: Array<Partial<AudioSampleEntry>> } | undefined;
  };
  const samples = fileWithTrack.getTrackById?.(trackId)?.samples || fileWithTrack.getTrack?.(trackId)?.samples || [];
  return samples
    .map((sample) => ({
      offset: Number(sample.offset || 0),
      size: Number(sample.size || 0),
      dts: Number(sample.dts || 0),
      duration: Number(sample.duration || 0),
    }))
    .filter((sample) => sample.offset >= 0 && sample.size > 0 && sample.duration > 0);
}

async function parseAc3SampleTable(file: ShareFileDownload, signal?: AbortSignal): Promise<Ac3SampleTable> {
  const { mp4boxFile, info } = await loadMp4Metadata(file, signal);
  const audioTrack = info.tracks.find((track) => track.type === "audio" && /^(ac-3|ec-3)$/i.test(track.codec || ""));
  if (!audioTrack) throw new Error("No AC-3 audio track found");

  const samples = getMp4TrackSamples(mp4boxFile, audioTrack.id);
  if (samples.length === 0) throw new Error("AC-3 sample table is empty");

  return {
    id: audioTrack.id,
    codec: audioTrack.codec || "ac-3",
    timescale: audioTrack.timescale || samples[0]?.duration || 1,
    samples,
  };
}

function getAc3SampleTable(file: ShareFileDownload, signal?: AbortSignal): Promise<Ac3SampleTable> {
  const cacheKey = getFileCacheKey(file);
  const cached = ac3SampleTableCache.get(cacheKey);
  if (cached) return cached;

  const promise = parseAc3SampleTable(file, signal).catch((err) => {
    ac3SampleTableCache.delete(cacheKey);
    throw err;
  });
  ac3SampleTableCache.set(cacheKey, promise);
  return promise;
}

function selectSamples(table: Ac3SampleTable, targetSec: number, requestedSec: number): AudioSampleEntry[] {
  const start = Math.max(0, targetSec) * table.timescale;
  const end = Math.max(targetSec, targetSec + requestedSec) * table.timescale;
  return table.samples.filter((sample) => sample.dts < end && sample.dts + sample.duration > start);
}

function groupSampleRanges(samples: AudioSampleEntry[]): Array<{ start: number; end: number; samples: AudioSampleEntry[] }> {
  const sorted = [...samples].sort((a, b) => a.offset - b.offset);
  const groups: Array<{ start: number; end: number; samples: AudioSampleEntry[] }> = [];
  for (const sample of sorted) {
    const start = sample.offset;
    const end = sample.offset + sample.size;
    const last = groups[groups.length - 1];
    if (last && start <= last.end + SAMPLE_RANGE_MAX_GAP_BYTES) {
      last.end = Math.max(last.end, end);
      last.samples.push(sample);
    } else {
      groups.push({ start, end, samples: [sample] });
    }
  }
  return groups;
}

async function extractAc3Payload(file: ShareFileDownload, targetSec: number, requestedSec: number, signal?: AbortSignal): Promise<Uint8Array> {
  const table = await getAc3SampleTable(file, signal);
  const vf = new SidecarVirtualFile(file);
  const samples = selectSamples(table, targetSec, requestedSec);
  if (samples.length === 0) throw new Error("No AC-3 samples found for requested time window");

  const payload = new Uint8Array(samples.reduce((sum, sample) => sum + sample.size, 0));
  let writeOffset = 0;
  const sampleToWriteOffset = new Map<AudioSampleEntry, number>();
  for (const sample of samples) {
    sampleToWriteOffset.set(sample, writeOffset);
    writeOffset += sample.size;
  }

  const groups = groupSampleRanges(samples);
  await Promise.all(groups.map(async (group) => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const bytes = new Uint8Array(await vf.fetchRange(group.start, group.end, signal));
    for (const sample of group.samples) {
      const offset = sampleToWriteOffset.get(sample);
      if (offset === undefined) continue;
      const localStart = sample.offset - group.start;
      payload.set(bytes.subarray(localStart, localStart + sample.size), offset);
    }
  }));

  return payload;
}

export async function prewarmAc3Decoder(file: ShareFileDownload, signal?: AbortSignal): Promise<void> {
  await Promise.all([
    getAc3SampleTable(file, signal),
    loadLibavAc3Script().then(async () => {
      if (!window.LibAV?.LibAV || libavInstance) return;
      libavInstance = await window.LibAV.LibAV({ noworker: true }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
      await libavInstance.av_log_set_level?.(-8);
    }),
  ]);
}

async function decodeAc3Payload(payload: Uint8Array): Promise<DecodedAc3Window> {
  await loadLibavAc3Script();
  if (!window.LibAV?.LibAV) throw new Error("LibAV factory missing");

  if (!libavInstance) {
    libavInstance = await window.LibAV.LibAV({ noworker: true }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  }
  const api = libavInstance;
  const sampleName = `sample-${Date.now()}-${Math.random().toString(36).slice(2)}.ac3`;
  await api.av_log_set_level?.(-8);
  await api.writeFile?.(sampleName, payload);
  const [fmtCtx, streams] = await api.ff_init_demuxer_file(sampleName) as [number, Array<Record<string, unknown>>];
  const stream = streams[0];
  const codecId = stream.codec_id as number;
  const codecpar = stream.codecpar;
  const [, c, pkt, frame] = await api.ff_init_decoder(codecId, codecpar ? { codecpar } : undefined) as number[];
  const read = await api.ff_read_frame_multi(fmtCtx, pkt) as [number, Record<string, unknown[]>];
  const packetsByStream = read[1];
  const firstKey = Object.keys(packetsByStream)[0];
  const packets = (packetsByStream[firstKey] || []) as unknown[];
  const frames = await api.ff_decode_multi(c, pkt, frame, packets, true) as Array<Record<string, unknown>>;
  await api.ff_free_decoder?.(c, pkt, frame);
  await api.avformat_close_input_js?.(fmtCtx);
  try {
    await api.unlink?.(sampleName);
  } catch {}

  const firstFrame = frames[0] || {};
  const sampleRate = Number(firstFrame.sample_rate || 0) || 0;
  const channels = Number(firstFrame.channels || 0) || 0;
  if (!frames.length || !sampleRate || !channels) throw new Error("AC-3 decoder returned no PCM frames");

  const totalSamples = frames.reduce((sum, item) => sum + Number(item.nb_samples || 0), 0);
  const planar = Array.from({ length: channels }, () => new Float32Array(totalSamples));
  let offset = 0;
  for (const item of frames) {
    const frameSamples = Number(item.nb_samples || 0);
    const frameData = item.data as Float32Array[] | Float32Array;
    if (Array.isArray(frameData)) {
      for (let ch = 0; ch < channels; ch++) {
        const src = frameData[ch] as Float32Array;
        if (src) planar[ch].set(src, offset);
      }
    }
    offset += frameSamples;
  }

  return { sampleRate, channels, totalSamples, planar };
}

export async function hasAc3AudioTrack(file: ShareFileDownload, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  // 缓存键使用分片 URL 签名，确保同一轮签名链接内稳定复用。
  const cacheKey = getSignedUrlCacheKey(file);
  const cached = ac3TrackCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result = getAudioCodecs(file.media_metadata).some((codec) => /^(ac-3|ec-3)$/.test(codec));
  ac3TrackCache.set(cacheKey, result);
  return result;
}

export interface DecodedAc3Window {
  sampleRate: number;
  channels: number;
  totalSamples: number;
  planar: Float32Array[];
}

export async function prewarmAc3Window(file: ShareFileDownload, targetSec = 0, requestedSec = 12, signal?: AbortSignal): Promise<void> {
  const cacheKey = getDecodedWindowCacheKey(file, targetSec, requestedSec);
  const cached = decodedAc3WindowCache.get(cacheKey);
  if (cached) {
    if (signal?.aborted) throw makeAbortError();
    await cached;
    if (signal?.aborted) throw makeAbortError();
    return;
  }
  if (signal?.aborted) throw makeAbortError();
  await cacheDecodedWindow(cacheKey, (async () => {
    const payload = await extractAc3Payload(file, targetSec, requestedSec, signal);
    if (signal?.aborted) throw makeAbortError();
    return decodeAc3Payload(payload);
  })());
}

export async function decodeAc3Window(file: ShareFileDownload, targetSec: number, requestedSec = 12, signal?: AbortSignal): Promise<DecodedAc3Window> {
  const cacheKey = getDecodedWindowCacheKey(file, targetSec, requestedSec);
  const cached = decodedAc3WindowCache.get(cacheKey);
  if (cached) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const decoded = await cached;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return decoded;
  }
  if (!signal) {
    return cacheDecodedWindow(cacheKey, (async () => {
      const payload = await extractAc3Payload(file, targetSec, requestedSec);
      return decodeAc3Payload(payload);
    })());
  }
  const payload = await extractAc3Payload(file, targetSec, requestedSec, signal);
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  return decodeAc3Payload(payload);
}
