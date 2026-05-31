import type { MediaMetadata, ShareFileDownload } from "./api";

const METADATA_HEAD_BYTES = 1024 * 1024;
const FETCH_SIZE = 2 * 1024 * 1024;

interface VirtualChunk {
  url: string;
  start: number;
  end: number;
  size: number;
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

// Cache for hasAc3AudioTrack results (keyed by file chunks signature)
const ac3TrackCache = new Map<string, boolean>();

// Reusable libav instance
let libavInstance: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null;

class SidecarVirtualFile {
  private chunks: VirtualChunk[];
  readonly totalSize: number;

  constructor(file: ShareFileDownload) {
    if (file.is_chunked) {
      let offset = 0;
      this.chunks = [...file.chunks].sort((a, b) => a.index - b.index).map((chunk) => {
        const item = { url: chunk.download_url, start: offset, end: offset + chunk.size - 1, size: chunk.size };
        offset += chunk.size;
        return item;
      });
      this.totalSize = offset;
    } else {
      this.chunks = [{ url: file.download_url, start: 0, end: file.file_size - 1, size: file.file_size }];
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
      const resp = await fetch(chunk.url, {
        headers: { Range: `bytes=${localStart}-${localEnd - 1}` },
        signal,
      });
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
    // Reset so next call retries instead of permanently failing
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

async function loadMp4Metadata(file: ShareFileDownload, signal?: AbortSignal): Promise<{
  mp4boxFile: import("mp4box").MP4File;
  info: import("mp4box").MP4Info;
  virtualFile: SidecarVirtualFile;
}> {
  const { createFile } = await import("mp4box");
  const vf = new SidecarVirtualFile(file);
  const moovOffset = getNumberMetadataField(file.media_metadata, "moov_offset");
  const moovSize = getNumberMetadataField(file.media_metadata, "moov_size");
  if (moovOffset === null || moovSize === null || moovSize <= 0) {
    throw new Error("AC-3 sidecar requires uploaded MP4 metadata");
  }

  const mp4boxFile = createFile();
  const infoPromise = new Promise<import("mp4box").MP4Info>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("mp4 metadata parsing timed out"));
      }
    }, 5000);
    mp4boxFile.onReady = (value) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      }
    };
    mp4boxFile.onError = (err) => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timer);
        reject(err);
      }
    };
  });

  if (moovOffset <= METADATA_HEAD_BYTES) {
    const end = Math.min(vf.totalSize, moovOffset + moovSize);
    const head = await vf.fetchRange(0, end, signal);
    const ab = head as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    mp4boxFile.appendBuffer(ab);
  } else {
    const head = await vf.fetchRange(0, Math.min(METADATA_HEAD_BYTES, vf.totalSize), signal);
    const headBuffer = head as ArrayBuffer & { fileStart: number };
    headBuffer.fileStart = 0;
    mp4boxFile.appendBuffer(headBuffer);

    const moov = await vf.fetchRange(moovOffset, Math.min(vf.totalSize, moovOffset + moovSize), signal);
    const moovBuffer = moov as ArrayBuffer & { fileStart: number };
    moovBuffer.fileStart = moovOffset;
    mp4boxFile.appendBuffer(moovBuffer);
  }

  return { mp4boxFile, info: await infoPromise, virtualFile: vf };
}

async function extractAc3Payload(file: ShareFileDownload, targetSec: number, requestedSec: number, signal?: AbortSignal): Promise<Uint8Array> {
  const { mp4boxFile, info, virtualFile: vf } = await loadMp4Metadata(file, signal);

  const audioTrack = info.tracks.find((track) => track.type === "audio" && /^(ac-3|ec-3)$/i.test(track.codec || ""));
  if (!audioTrack) throw new Error("No AC-3 audio track found");

  const samples: import("mp4box").MP4Sample[] = [];
  let sampleDurationSec = 0;
  let sampleBytes = 0;
  mp4boxFile.setExtractionOptions(audioTrack.id, null, { nbSamples: 128 });
  mp4boxFile.onSamples = (_id, _user, batch) => {
    for (const sample of batch) {
      samples.push(sample);
      sampleDurationSec += sample.duration / audioTrack.timescale;
      sampleBytes += sample.size || sample.data?.byteLength || 0;
    }
  };

  const seek = mp4boxFile.seek(targetSec, true);
  mp4boxFile.start();
  let nextOffset = Math.max(0, seek.offset);
  let fetchedBytes = 0;
  const maxFetchBytes = 32 * 1024 * 1024;

  while (sampleDurationSec < requestedSec && nextOffset < vf.totalSize && fetchedBytes < maxFetchBytes) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const end = Math.min(nextOffset + FETCH_SIZE, vf.totalSize);
    const buf = await vf.fetchRange(nextOffset, end, signal);
    const ab = buf as ArrayBuffer & { fileStart: number };
    ab.fileStart = nextOffset;
    mp4boxFile.appendBuffer(ab);
    fetchedBytes += buf.byteLength;
    nextOffset = end;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  mp4boxFile.stop();

  const payload = new Uint8Array(sampleBytes);
  let writeOffset = 0;
  for (const sample of samples) {
    const bytes = new Uint8Array(sample.data);
    payload.set(bytes, writeOffset);
    writeOffset += bytes.byteLength;
  }
  return payload;
}

export async function hasAc3AudioTrack(file: ShareFileDownload, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  // Cache key: use chunk URLs as signature (stable across mounts)
  const cacheKey = file.is_chunked
    ? file.chunks.map((c) => c.download_url).join("|")
    : file.download_url;
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

export async function decodeAc3Window(file: ShareFileDownload, targetSec: number, requestedSec = 12, signal?: AbortSignal): Promise<DecodedAc3Window> {
  const payload = await extractAc3Payload(file, targetSec, requestedSec, signal);
  await loadLibavAc3Script();
  if (!window.LibAV?.LibAV) throw new Error("LibAV factory missing");

  // Reuse libav instance to avoid repeated wasm instantiation
  if (!libavInstance) {
    libavInstance = await window.LibAV.LibAV({ noworker: true }) as Record<string, (...args: unknown[]) => Promise<unknown>>;
  }
  const api = libavInstance;
  await api.writeFile?.("sample.ac3", payload);
  const [fmtCtx, streams] = await api.ff_init_demuxer_file("sample.ac3") as [number, Array<Record<string, unknown>>];
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
