"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Activity, Download, FileAudio, FileJson, PlayCircle, RefreshCw } from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { MediaPlayer } from "@/components/media-player";
import { downloadShare, getShareInfo, type ShareFileDownload } from "@/lib/api";
import { getErrorMessage } from "@/lib/errors";
import { prepareVirtualMediaTransport, registerVirtualMediaFile } from "@/lib/virtual-media";

const PROBE_BYTES = 8 * 1024 * 1024;

type CapabilityValue = boolean | string | number | null;

interface CapabilityReport {
  userAgent: string;
  platform: string;
  language: string;
  secureContext: boolean;
  crossOriginIsolated: boolean;
  webAssembly: boolean;
  audioContext: boolean;
  audioWorklet: boolean;
  sharedArrayBuffer: boolean;
  mediaSource: boolean;
  webCodecsAudioDecoder: boolean;
  mediaSourceTypes: Record<string, boolean>;
  canPlayTypes: Record<string, string>;
}

interface ParsedTrack {
  id: number;
  type: string;
  codec: string;
  duration: number;
  timescale: number;
  bitrate?: number;
  width?: number;
  height?: number;
  audio?: { sample_rate: number; channel_count: number };
}

interface MediaProbeReport {
  fileName: string;
  fileSize: number;
  contentType: string;
  isChunked: boolean;
  chunkCount: number;
  probeBytes: number;
  durationSec: number;
  brands: string[];
  tracks: ParsedTrack[];
  detectedVideoCodec: string;
  detectedAudioCodec: string;
  ac3Detected: boolean;
}

interface AudioSampleTest {
  targetSec: number;
  requestedSec: number;
  seekTimeSec: number;
  seekOffset: number;
  fetchedBytes: number;
  sampleCount: number;
  sampleBytes: number;
  sampleDurationSec: number;
  firstSampleDtsSec: number | null;
  lastSampleDtsSec: number | null;
  elapsedMs: number;
  status: "ok" | "error";
  error?: string;
}

interface AudioDecodeTest {
  targetSec: number;
  requestedSec: number;
  elapsedMs: number;
  frameCount: number;
  sampleRate: number | null;
  channels: number | null;
  sampleFormat: string;
  decodedDurationSec: number;
  status: "ok" | "error";
  error?: string;
}

interface DecodedAudioSample {
  targetSec: number;
  sampleRate: number;
  channels: number;
  totalSamples: number;
  planar: Float32Array[];
}

interface ManualResult {
  device: string;
  browser: string;
  testPoint: string;
  hasSound: string;
  syncRating: string;
  artifacts: string;
  seekRecovery: string;
  heat: string;
  score: string;
  notes: string;
}

interface LabReport {
  source: string;
  timestamp: string;
  capabilities: CapabilityReport | null;
  media: MediaProbeReport | null;
  decoderInit: {
    status: string;
    elapsedMs: number | null;
    detail: string;
  };
  audioSampleTests: AudioSampleTest[];
  audioDecodeTests: AudioDecodeTest[];
  manualResults: ManualResult[];
  errors: string[];
}


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

const codecTypes = [
  'video/mp4; codecs="avc1.640029,ac-3"',
  'audio/mp4; codecs="ac-3"',
  'video/mp4; codecs="avc1.640029,ec-3"',
  'audio/mp4; codecs="ec-3"',
  'video/mp4; codecs="avc1.640029,mp4a.40.2"',
  'audio/mp4; codecs="mp4a.40.2"',
];

const audioSamplePoints = [30, 300, 1200, 2400, 4200, 5880, 6270];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

function collectCapabilities(): CapabilityReport {
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  const mediaSource = "MediaSource" in window;
  const mediaSourceTypes: Record<string, boolean> = {};
  const canPlayTypes: Record<string, string> = {};

  for (const type of codecTypes) {
    mediaSourceTypes[type] = mediaSource ? MediaSource.isTypeSupported(type) : false;
    canPlayTypes[type] = type.startsWith("audio/") ? audio.canPlayType(type) : video.canPlayType(type);
  }

  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
    webAssembly: typeof WebAssembly !== "undefined",
    audioContext: Boolean(AudioContextCtor),
    audioWorklet: Boolean(AudioContextCtor && "audioWorklet" in AudioContext.prototype),
    sharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
    mediaSource,
    webCodecsAudioDecoder: "AudioDecoder" in window,
    mediaSourceTypes,
    canPlayTypes,
  };
}

function firstPlayableFile(files: ShareFileDownload[]): ShareFileDownload | null {
  return files.find((f) => f.content_type.startsWith("video/") || /\.(mp4|mov|m4v)$/i.test(f.file_name)) || files[0] || null;
}

class LabVirtualFile {
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

  async fetchRange(start: number, end: number): Promise<ArrayBuffer> {
    end = Math.min(end, this.totalSize);
    if (start >= end) return new ArrayBuffer(0);
    const parts: ArrayBuffer[] = [];
    for (const chunk of this.chunks) {
      if (chunk.end < start) continue;
      if (chunk.start >= end) break;
      const localStart = Math.max(0, start - chunk.start);
      const localEnd = Math.min(chunk.size, end - chunk.start);
      const resp = await fetch(chunk.url, { headers: { Range: `bytes=${localStart}-${localEnd - 1}` } });
      if (!resp.ok && resp.status !== 206) throw new Error(`Range fetch failed: HTTP ${resp.status}`);
      if (resp.status === 200 && localEnd - localStart > 1024 * 1024) {
        throw new Error("CDN ignored Range request");
      }
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

let libavLoaderPromise: Promise<void> | null = null;

function loadLibavAc3Script(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("window is unavailable"));
  if (window.LibAV?.LibAV) return Promise.resolve();
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
  });

  return libavLoaderPromise;
}

async function fetchProbe(file: ShareFileDownload): Promise<ArrayBuffer> {
  const url = file.is_chunked ? file.chunks[0]?.download_url : file.download_url;
  const firstSize = file.is_chunked ? file.chunks[0]?.size || file.file_size : file.file_size;
  if (!url) throw new Error("缺少下载地址");
  const probeEnd = Math.min(PROBE_BYTES, firstSize) - 1;
  const resp = await fetch(url, { headers: { Range: `bytes=0-${probeEnd}` } });
  if (!resp.ok && resp.status !== 206) throw new Error(`Range probe failed: HTTP ${resp.status}`);
  if (resp.status === 200 && firstSize > PROBE_BYTES) {
    throw new Error("CDN ignored Range request; refusing to fetch a full large chunk");
  }
  return resp.arrayBuffer();
}

async function parseMp4Probe(file: ShareFileDownload): Promise<MediaProbeReport> {
  const buffer = await fetchProbe(file);
  const { createFile } = await import("mp4box");
  const mp4boxFile = createFile();

  const info = await new Promise<import("mp4box").MP4Info>((resolve, reject) => {
    let settled = false;
    mp4boxFile.onReady = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    mp4boxFile.onError = (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    const ab = buffer as ArrayBuffer & { fileStart: number };
    ab.fileStart = 0;
    mp4boxFile.appendBuffer(ab);
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("moov not found in first 8MB"));
      }
    }, 5000);
  });

  const tracks: ParsedTrack[] = info.tracks.map((track) => ({
    id: track.id,
    type: track.type,
    codec: track.codec,
    duration: track.duration,
    timescale: track.timescale,
    bitrate: track.bitrate,
    width: track.width,
    height: track.height,
    audio: track.audio,
  }));
  const videoTrack = tracks.find((t) => t.type === "video");
  const audioTrack = tracks.find((t) => t.type === "audio");

  return {
    fileName: file.file_name,
    fileSize: file.file_size,
    contentType: file.content_type,
    isChunked: file.is_chunked,
    chunkCount: file.chunks?.length || 0,
    probeBytes: buffer.byteLength,
    durationSec: info.duration / info.timescale,
    brands: info.brands,
    tracks,
    detectedVideoCodec: videoTrack?.codec || "",
    detectedAudioCodec: audioTrack?.codec || "",
    ac3Detected: /^(ac-3|ec-3)$/i.test(audioTrack?.codec || ""),
  };
}

async function extractAudioSamples(file: ShareFileDownload, targetSec: number, requestedSec = 10): Promise<{ test: AudioSampleTest; payload: Uint8Array | null }> {
  const started = performance.now();
  try {
    const { createFile } = await import("mp4box");
    const vf = new LabVirtualFile(file);
    const probe = await vf.fetchRange(0, Math.min(PROBE_BYTES, vf.totalSize));
    const mp4boxFile = createFile();

    const info = await new Promise<import("mp4box").MP4Info>((resolve, reject) => {
      let settled = false;
      mp4boxFile.onReady = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      mp4boxFile.onError = (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      const ab = probe as ArrayBuffer & { fileStart: number };
      ab.fileStart = 0;
      mp4boxFile.appendBuffer(ab);
      setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("moov not found in first 8MB"));
        }
      }, 5000);
    });

    const audioTrack = info.tracks.find((track) => track.type === "audio");
    if (!audioTrack) throw new Error("No audio track found");

    const samples: import("mp4box").MP4Sample[] = [];
    let sampleDurationSec = 0;
    let sampleBytes = 0;
    let firstSampleDtsSec: number | null = null;
    let lastSampleDtsSec: number | null = null;

    mp4boxFile.setExtractionOptions(audioTrack.id, null, { nbSamples: 128 });
    mp4boxFile.onSamples = (_id, _user, batch) => {
      for (const sample of batch) {
        samples.push(sample);
        const dtsSec = sample.dts / audioTrack.timescale;
        if (firstSampleDtsSec === null) firstSampleDtsSec = dtsSec;
        lastSampleDtsSec = dtsSec;
        sampleDurationSec += sample.duration / audioTrack.timescale;
        sampleBytes += sample.size || sample.data?.byteLength || 0;
      }
    };

    const seek = mp4boxFile.seek(targetSec, true);
    mp4boxFile.start();

    let nextOffset = Math.max(0, seek.offset);
    let fetchedBytes = 0;
    const maxFetchBytes = 32 * 1024 * 1024;
    const fetchSize = 2 * 1024 * 1024;

    while (sampleDurationSec < requestedSec && nextOffset < vf.totalSize && fetchedBytes < maxFetchBytes) {
      const end = Math.min(nextOffset + fetchSize, vf.totalSize);
      const buf = await vf.fetchRange(nextOffset, end);
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

    return {
      test: {
      targetSec,
      requestedSec,
      seekTimeSec: seek.time,
      seekOffset: seek.offset,
      fetchedBytes,
      sampleCount: samples.length,
      sampleBytes,
      sampleDurationSec,
      firstSampleDtsSec,
      lastSampleDtsSec,
      elapsedMs: performance.now() - started,
      status: sampleDurationSec >= requestedSec ? "ok" : "error",
      error: sampleDurationSec >= requestedSec ? undefined : "Not enough samples extracted before fetch limit",
      },
      payload,
    };
  } catch (err) {
    return {
      test: {
        targetSec,
        requestedSec,
        seekTimeSec: 0,
        seekOffset: 0,
        fetchedBytes: 0,
        sampleCount: 0,
        sampleBytes: 0,
        sampleDurationSec: 0,
        firstSampleDtsSec: null,
        lastSampleDtsSec: null,
        elapsedMs: performance.now() - started,
        status: "error",
        error: getErrorMessage(err, "Audio sample extraction failed"),
      },
      payload: null,
    };
  }
}

function Field({ label, value }: { label: string; value: CapabilityValue }) {
  const positive = value === true || value === "probably" || value === "maybe";
  const negative = value === false || value === "" || value === null;
  return (
    <div className="rounded-xl border border-warm-200 bg-white/80 p-3 dark:border-gray-700 dark:bg-white/[0.03]">
      <p className="type-caption text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`type-body-sm mt-1 break-words ${positive ? "text-green-700 dark:text-green-400" : negative ? "text-red-600 dark:text-red-400" : "text-gray-800 dark:text-gray-200"}`}>
        {String(value)}
      </p>
    </div>
  );
}

const SyncPreview = memo(function SyncPreview({ file }: { file: ShareFileDownload }) {
  return <MediaPlayer file={file} />;
});

export default function Ac3LabPage() {
  const params = useParams();
  const code = params.code as string;
  const [capabilities, setCapabilities] = useState<CapabilityReport | null>(null);
  const [media, setMedia] = useState<MediaProbeReport | null>(null);
  const [downloadFile, setDownloadFile] = useState<ShareFileDownload | null>(null);
  const [audioSampleTests, setAudioSampleTests] = useState<AudioSampleTest[]>([]);
  const [sampleLoading, setSampleLoading] = useState<number | null>(null);
  const [audioDecodeTests, setAudioDecodeTests] = useState<AudioDecodeTest[]>([]);
  const [decodeLoading, setDecodeLoading] = useState<number | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState("未播放");
  const [syncStatus, setSyncStatus] = useState("未测试");
  const [showSyncPreview, setShowSyncPreview] = useState(false);
  const [nativeRangeStatus, setNativeRangeStatus] = useState("未测试");
  const [nativeRangeUrl, setNativeRangeUrl] = useState("");
  const [decoderInit, setDecoderInit] = useState<{ status: string; elapsedMs: number | null; detail: string }>({
    status: "idle",
    elapsedMs: null,
    detail: "未验证",
  });
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [reportTimestamp, setReportTimestamp] = useState("");
  const [manualResults, setManualResults] = useState<ManualResult[]>([]);
  const [manual, setManual] = useState<ManualResult>({
    device: "",
    browser: "",
    testPoint: "00:05:00",
    hasSound: "未测",
    syncRating: "未测",
    artifacts: "未测",
    seekRecovery: "未测",
    heat: "未测",
    score: "",
    notes: "",
  });
  const samplePayloadsRef = useRef(new Map<number, Uint8Array>());
  const decodedAudioRef = useRef(new Map<number, DecodedAudioSample>());
  const audioContextRef = useRef<AudioContext | null>(null);
  const playerWrapRef = useRef<HTMLDivElement | null>(null);

  const report: LabReport = useMemo(() => ({
    source: code,
    timestamp: reportTimestamp,
    capabilities,
    media,
    decoderInit,
    audioSampleTests,
    audioDecodeTests,
    manualResults,
    errors,
  }), [code, reportTimestamp, capabilities, media, decoderInit, audioSampleTests, audioDecodeTests, manualResults, errors]);

  const runPhase01 = async () => {
    setLoading(true);
    setErrors([]);
    setCapabilities(null);
    setMedia(null);
    setDownloadFile(null);
    setAudioSampleTests([]);
    setAudioDecodeTests([]);
    samplePayloadsRef.current.clear();
    decodedAudioRef.current.clear();
    setDecoderInit({ status: "idle", elapsedMs: null, detail: "未验证" });
    setReportTimestamp(new Date().toISOString());
    try {
      setCapabilities(collectCapabilities());
      await getShareInfo(code);
      const downloads = await downloadShare(code);
      const file = firstPlayableFile(downloads.files);
      if (!file) throw new Error("分享中没有可检测文件");
      setDownloadFile(file);
      const parsed = await parseMp4Probe(file);
      setMedia(parsed);
    } catch (err) {
      setErrors((prev) => [...prev, getErrorMessage(err, "AC-3 Lab 检测失败")]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    runPhase01();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  useEffect(() => {
    void prepareVirtualMediaTransport().catch(() => {});
  }, []);

  const exportReport = () => {
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ac3-lab-${code}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const addManualResult = () => {
    setManualResults((prev) => [...prev, manual]);
  };

  const runNativeRangePoc = async () => {
    if (!downloadFile) return;
    setNativeRangeStatus("注册 Service Worker 中...");
    try {
      const url = await registerVirtualMediaFile(downloadFile, code);
      setNativeRangeUrl(url);
      setNativeRangeStatus(`已生成虚拟 URL：${url}`);
    } catch (err) {
      setNativeRangeStatus(getErrorMessage(err, "原生 Range POC 失败"));
    }
  };

  const runAudioSampleExtraction = async (targetSec: number) => {
    if (!downloadFile) return;
    setSampleLoading(targetSec);
    const result = await extractAudioSamples(downloadFile, targetSec, 10);
    if (result.payload) samplePayloadsRef.current.set(targetSec, result.payload);
    setAudioSampleTests((prev) => [...prev, result.test]);
    setSampleLoading(null);
  };

  const runAllAudioSampleExtractions = async () => {
    if (!downloadFile) return;
    setAudioSampleTests([]);
    samplePayloadsRef.current.clear();
    for (const point of audioSamplePoints) {
      setSampleLoading(point);
      const result = await extractAudioSamples(downloadFile, point, 10);
      if (result.payload) samplePayloadsRef.current.set(point, result.payload);
      setAudioSampleTests((prev) => [...prev, result.test]);
    }
    setSampleLoading(null);
  };

  const runDecoderInitCheck = async () => {
    const started = performance.now();
    setDecoderInit({ status: "loading", elapsedMs: null, detail: "加载 libav-ac3 中..." });
    try {
      await loadLibavAc3Script();
      if (!window.LibAV?.LibAV) throw new Error("LibAV factory missing");
      const libav = await window.LibAV.LibAV({ noworker: true });
      const api = libav as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const init = await api.ff_init_decoder("ac3");
      const [, ctx, pkt, frame] = init as number[];
      if (api.ff_free_decoder) {
        await api.ff_free_decoder(ctx, pkt, frame);
      }
      setDecoderInit({
        status: "ok",
        elapsedMs: performance.now() - started,
        detail: "libav-ac3 加载成功，ff_init_decoder('ac3') 可用",
      });
    } catch (err) {
      setDecoderInit({
        status: "error",
        elapsedMs: performance.now() - started,
        detail: getErrorMessage(err, "decoder init failed"),
      });
    }
  };

  const runDecodeSample = async (targetSec: number, requestedSec = 10) => {
    let payload = samplePayloadsRef.current.get(targetSec) || null;
    if (!downloadFile) return;
    if (!payload) {
      setSampleLoading(targetSec);
      const extracted = await extractAudioSamples(downloadFile, targetSec, requestedSec);
      setAudioSampleTests((prev) => [...prev, extracted.test]);
      if (extracted.payload) {
        samplePayloadsRef.current.set(targetSec, extracted.payload);
        payload = extracted.payload;
      }
      setSampleLoading(null);
    }
    if (!payload) return;

    const started = performance.now();
    setDecodeLoading(targetSec);
    try {
      await loadLibavAc3Script();
      if (!window.LibAV?.LibAV) throw new Error("LibAV factory missing");
      const libav = await window.LibAV.LibAV({ noworker: true });
      const api = libav as Record<string, (...args: unknown[]) => Promise<unknown>>;
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
      const decodedDurationSec = frames.reduce((sum, f) => sum + Number((f.nb_samples as number || 0) / (f.sample_rate as number || 1)), 0);
      if (frames.length > 0 && sampleRate > 0 && channels > 0) {
        const totalSamples = frames.reduce((sum, f) => sum + Number(f.nb_samples || 0), 0);
        const planar = Array.from({ length: channels }, () => new Float32Array(totalSamples));
        let offset = 0;
        for (const frameItem of frames) {
          const frameSamples = Number(frameItem.nb_samples || 0);
          const frameData = frameItem.data as Float32Array[] | Float32Array;
          if (Array.isArray(frameData)) {
            for (let ch = 0; ch < channels; ch++) {
              const src = frameData[ch] as Float32Array;
              if (src) planar[ch].set(src, offset);
            }
          }
          offset += frameSamples;
        }
        decodedAudioRef.current.set(targetSec, { targetSec, sampleRate, channels, totalSamples, planar });
      }
      setAudioDecodeTests((prev) => [...prev, {
        targetSec,
        requestedSec,
        elapsedMs: performance.now() - started,
        frameCount: frames.length,
        sampleRate: sampleRate || null,
        channels: channels || null,
        sampleFormat: String(firstFrame.format || firstFrame.sample_fmt || "unknown"),
        decodedDurationSec,
        status: frames.length > 0 ? "ok" : "error",
        error: frames.length > 0 ? undefined : "Decoder returned zero frames",
      }]);
    } catch (err) {
      setAudioDecodeTests((prev) => [...prev, {
        targetSec,
        requestedSec,
        elapsedMs: performance.now() - started,
        frameCount: 0,
        sampleRate: null,
        channels: null,
        sampleFormat: "unknown",
        decodedDurationSec: 0,
        status: "error",
        error: getErrorMessage(err, "Audio decode failed"),
      }]);
    } finally {
      setDecodeLoading(null);
    }
  };

  const playDecodedSample = async (targetSec: number) => {
    const decoded = decodedAudioRef.current.get(targetSec);
    if (!decoded) {
      setPlaybackStatus(`没有可播放的已解码样本：${formatDuration(targetSec)}`);
      return;
    }
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) {
      setPlaybackStatus("当前浏览器不支持 AudioContext");
      return;
    }
    if (!audioContextRef.current) audioContextRef.current = new AudioContextCtor();
    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") await ctx.resume();

    const buffer = ctx.createBuffer(decoded.channels, decoded.totalSamples, decoded.sampleRate);
    for (let ch = 0; ch < decoded.channels; ch++) {
      buffer.copyToChannel(new Float32Array(decoded.planar[ch]), ch, 0);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => setPlaybackStatus(`播放完成：${formatDuration(targetSec)}`);
    src.start();
    setPlaybackStatus(`播放中：${formatDuration(targetSec)}，${(decoded.totalSamples / decoded.sampleRate).toFixed(2)}s`);
  };

  const runDecodeAndPlaySample = async (targetSec: number) => {
    if (!decodedAudioRef.current.get(targetSec)) {
      await runDecodeSample(targetSec);
    }
    await playDecodedSample(targetSec);
  };

  const syncDriftRef = useRef<number | null>(null);
  const syncSourceRef = useRef<AudioBufferSourceNode | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (syncDriftRef.current !== null) clearInterval(syncDriftRef.current);
      try { syncSourceRef.current?.stop(); } catch {}
    };
  }, []);

  const runWindowSyncPoc = async () => {
    // Stop any previous sync playback
    if (syncDriftRef.current !== null) { clearInterval(syncDriftRef.current); syncDriftRef.current = null; }
    try { syncSourceRef.current?.stop(); } catch {}
    syncSourceRef.current = null;

    const video = playerWrapRef.current?.querySelector("video") as HTMLVideoElement | null;
    if (!video) {
      setSyncStatus("请先点击「显示预览器」并等待视频加载");
      return;
    }
    if (video.readyState < 2) {
      setSyncStatus("等待视频缓冲就绪…");
      const ready = await new Promise<boolean>((resolve) => {
        const onReady = () => { resolve(true); cleanup(); };
        const timeout = setTimeout(() => { resolve(false); cleanup(); }, 15000);
        const cleanup = () => { video.removeEventListener("canplay", onReady); clearTimeout(timeout); };
        video.addEventListener("canplay", onReady, { once: true });
      });
      if (!ready) { setSyncStatus("视频缓冲超时（15s），请稍后重试"); return; }
    }

    const startSec = Math.max(0, Math.floor(video.currentTime || 0));
    // Pause immediately to avoid video advancing during decode (prevents "jump back" feel)
    video.pause();
    setSyncStatus(`[1/4] 解码 AC-3 窗口：${formatDuration(startSec)} → ${formatDuration(startSec + 12)}`);

    await runDecodeSample(startSec, 12);
    const decoded = decodedAudioRef.current.get(startSec);
    if (!decoded) {
      setSyncStatus(`解码失败：${formatDuration(startSec)} 处无法获取音频数据`);
      return;
    }

    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) { setSyncStatus("浏览器不支持 AudioContext"); return; }
    if (!audioContextRef.current) audioContextRef.current = new AudioContextCtor();
    const ctx = audioContextRef.current;
    if (ctx.state === "suspended") await ctx.resume();

    const buffer = ctx.createBuffer(decoded.channels, decoded.totalSamples, decoded.sampleRate);
    for (let ch = 0; ch < decoded.channels; ch++) {
      buffer.copyToChannel(new Float32Array(decoded.planar[ch]), ch, 0);
    }

    // Step 2: seek video to exact start
    setSyncStatus(`[2/4] Seek 视频到 ${formatDuration(startSec)}`);
    video.pause();
    video.currentTime = startSec;
    await new Promise<void>((resolve) => {
      video.addEventListener("seeked", () => resolve(), { once: true });
    });

    // Step 3: wait for enough buffered data after seek
    setSyncStatus(`[3/4] 等待视频缓冲…`);
    if (video.readyState < 3) {
      await new Promise<void>((resolve) => {
        video.addEventListener("canplay", () => resolve(), { once: true });
        setTimeout(resolve, 3000); // 3s timeout fallback
      });
    }

    // Step 4: start video, then immediately start audio
    setSyncStatus(`[4/4] 同步启动…`);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    await video.play(); // resolves when playback actually begins
    const audioStartCtxTime = ctx.currentTime;
    src.start(0); // start audio immediately
    syncSourceRef.current = src;

    const audioDurationSec = decoded.totalSamples / decoded.sampleRate;
    setSyncStatus(`▶ 同步播放中 ${formatDuration(startSec)}+${audioDurationSec.toFixed(1)}s`);

    // Drift monitor: check every 500ms
    syncDriftRef.current = window.setInterval(() => {
      const audioElapsed = ctx.currentTime - audioStartCtxTime;
      const videoElapsed = video.currentTime - startSec;
      const driftMs = Math.round((videoElapsed - audioElapsed) * 1000);
      setSyncStatus(`▶ 播放中 drift=${driftMs}ms（video=${videoElapsed.toFixed(2)}s audio=${audioElapsed.toFixed(2)}s）`);
    }, 500);

    src.onended = () => {
      if (syncDriftRef.current !== null) { clearInterval(syncDriftRef.current); syncDriftRef.current = null; }
      const finalAudioElapsed = ctx.currentTime - audioStartCtxTime;
      const finalVideoElapsed = video.currentTime - startSec;
      const finalDrift = Math.round((finalVideoElapsed - finalAudioElapsed) * 1000);
      setSyncStatus(`✓ 窗口结束 drift=${finalDrift}ms（${formatDuration(startSec)}+${audioDurationSec.toFixed(1)}s）`);
    };
  };

  return (
    <main className="min-h-dvh bg-warm-50 px-4 py-8 text-gray-900 dark:bg-background dark:text-gray-100">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex flex-col gap-4 rounded-3xl border border-warm-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-card sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-2">
            <BrandLogo className="h-auto w-32" />
            <div>
              <h1 className="type-title">AC-3 Frontend Lab</h1>
              <p className="type-body-sm text-gray-600 dark:text-gray-400">源：{code} · Phase 0/1 能力检测与片源解析</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={runPhase01} disabled={loading} className="btn-primary inline-flex items-center gap-2">
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} /> 重新检测
            </button>
            <button onClick={exportReport} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-warm-200 px-4 text-sm font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200">
              <Download size={16} /> 导出报告
            </button>
          </div>
        </header>

        {errors.length > 0 && (
          <section className="rounded-2xl border border-red-200 bg-red-50 p-4 dark:border-red-900/60 dark:bg-red-950/30">
            <h2 className="type-section text-red-700 dark:text-red-300">错误</h2>
            {errors.map((err, i) => <p key={i} className="type-body-sm mt-1 text-red-700 dark:text-red-300">{err}</p>)}
          </section>
        )}

        <section className="grid gap-4 md:grid-cols-2">
          <div className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
            <div className="mb-4 flex items-center gap-2">
              <Activity className="text-nyy-500" size={20} />
              <h2 className="type-section">Phase 0 · 浏览器能力</h2>
            </div>
            {capabilities ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Secure Context" value={capabilities.secureContext} />
                  <Field label="Cross-Origin Isolated" value={capabilities.crossOriginIsolated} />
                  <Field label="WebAssembly" value={capabilities.webAssembly} />
                  <Field label="WebAudio" value={capabilities.audioContext} />
                  <Field label="AudioWorklet" value={capabilities.audioWorklet} />
                  <Field label="SharedArrayBuffer" value={capabilities.sharedArrayBuffer} />
                  <Field label="MediaSource" value={capabilities.mediaSource} />
                  <Field label="WebCodecs AudioDecoder" value={capabilities.webCodecsAudioDecoder} />
                </div>
                <div>
                  <p className="type-label mb-2">Codec support probes</p>
                  <div className="space-y-2">
                    {codecTypes.map((type) => (
                      <div key={type} className="rounded-xl bg-warm-50 p-3 dark:bg-white/[0.04]">
                        <p className="type-caption break-all text-gray-500 dark:text-gray-400">{type}</p>
                        <p className="type-body-sm">MSE: {String(capabilities.mediaSourceTypes[type])} · canPlayType: {capabilities.canPlayTypes[type] || "empty"}</p>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="type-caption break-words text-gray-500 dark:text-gray-400">UA: {capabilities.userAgent}</p>
              </div>
            ) : <p className="type-body-sm text-gray-500">{loading ? "检测中..." : "未检测"}</p>}
          </div>

          <div className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
            <div className="mb-4 flex items-center gap-2">
              <FileAudio className="text-nyy-500" size={20} />
              <h2 className="type-section">Phase 1 · 片源解析</h2>
            </div>
            {media ? (
              <div className="space-y-3">
                <Field label="文件" value={media.fileName} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="大小" value={formatBytes(media.fileSize)} />
                  <Field label="分片" value={media.isChunked ? `${media.chunkCount} chunks` : "no"} />
                  <Field label="Probe" value={formatBytes(media.probeBytes)} />
                  <Field label="时长" value={formatDuration(media.durationSec)} />
                  <Field label="视频 codec" value={media.detectedVideoCodec || "none"} />
                  <Field label="音频 codec" value={media.detectedAudioCodec || "none"} />
                  <Field label="AC-3 detected" value={media.ac3Detected} />
                  <Field label="Brands" value={media.brands.join(", ")} />
                </div>
                <div className="space-y-2">
                  {media.tracks.map((track) => (
                    <div key={track.id} className="rounded-xl bg-warm-50 p-3 dark:bg-white/[0.04]">
                      <p className="type-body-sm font-medium">Track #{track.id}: {track.type} · {track.codec}</p>
                      <p className="type-caption text-gray-500 dark:text-gray-400">
                        duration={formatDuration(track.duration / track.timescale)} bitrate={track.bitrate || "unknown"}
                        {track.width ? ` ${track.width}x${track.height}` : ""}
                        {track.audio ? ` ${track.audio.sample_rate}Hz ${track.audio.channel_count}ch` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : <p className="type-body-sm text-gray-500">{loading ? "解析中..." : "未解析"}</p>}
          </div>
        </section>

        <section className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
          <div className="mb-4 flex items-center gap-2">
            <FileAudio className="text-nyy-500" size={20} />
            <h2 className="type-section">Phase 2A · AC-3 样本提取 POC</h2>
          </div>
          <p className="type-body-sm mb-4 text-gray-600 dark:text-gray-400">
            这一步还不解码，只验证能否从 1.67GB 分片 MP4 的任意时间点提取 10 秒 AC-3 compressed samples。WASM decoder 接入后会直接消费这些 samples。
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={runAllAudioSampleExtractions}
              disabled={!downloadFile || sampleLoading !== null}
              className="btn-primary"
            >
              批量提取全部测试点
            </button>
            {audioSamplePoints.map((point) => (
              <button
                key={point}
                onClick={() => runAudioSampleExtraction(point)}
                disabled={!downloadFile || sampleLoading !== null}
                className="min-h-[44px] rounded-xl border border-warm-200 px-4 text-sm font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
              >
                {sampleLoading === point ? "提取中..." : `提取 ${formatDuration(point)}`}
              </button>
            ))}
          </div>
          {audioSampleTests.length > 0 && (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {audioSampleTests.map((test, index) => (
                <div key={`${test.targetSec}-${index}`} className="rounded-xl bg-warm-50 p-3 dark:bg-white/[0.04]">
                  <p className={`type-body-sm font-medium ${test.status === "ok" ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                    {test.status === "ok" ? "OK" : "ERROR"} · target {formatDuration(test.targetSec)}
                  </p>
                  <p className="type-caption mt-1 text-gray-600 dark:text-gray-400">
                    samples={test.sampleCount} duration={test.sampleDurationSec.toFixed(2)}s bytes={formatBytes(test.sampleBytes)} fetched={formatBytes(test.fetchedBytes)} elapsed={test.elapsedMs.toFixed(0)}ms
                  </p>
                  <p className="type-caption text-gray-500 dark:text-gray-500">
                    seekTime={test.seekTimeSec.toFixed(2)}s offset={formatBytes(test.seekOffset)} dts={test.firstSampleDtsSec?.toFixed(2) ?? "-"}→{test.lastSampleDtsSec?.toFixed(2) ?? "-"}
                  </p>
                  {test.error && <p className="type-caption mt-1 text-red-600 dark:text-red-400">{test.error}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
          <div className="mb-4 flex items-center gap-2">
            <PlayCircle className="text-nyy-500" size={20} />
            <h2 className="type-section">Phase 2B · AC-3 decoder 初始化验证</h2>
          </div>
          <p className="type-body-sm mb-4 text-gray-600 dark:text-gray-400">
            这一步只验证浏览器能否加载自定义 libav-ac3 wasm，并成功创建 `ac3` decoder。还不做 PCM 解码输出。
          </p>
          <div className="flex flex-wrap gap-2">
            <button onClick={runDecoderInitCheck} className="btn-primary">加载并初始化 AC-3 decoder</button>
          </div>
          <div className="mt-4 rounded-xl bg-warm-50 p-3 dark:bg-white/[0.04]">
            <p className={`type-body-sm font-medium ${decoderInit.status === "ok" ? "text-green-700 dark:text-green-400" : decoderInit.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-800 dark:text-gray-200"}`}>
              status={decoderInit.status}
            </p>
            <p className="type-caption mt-1 text-gray-600 dark:text-gray-400">{decoderInit.detail}</p>
            {decoderInit.elapsedMs !== null && (
              <p className="type-caption text-gray-500 dark:text-gray-500">elapsed={decoderInit.elapsedMs.toFixed(0)}ms</p>
            )}
          </div>
        </section>

        <section className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
          <div className="mb-4 flex items-center gap-2">
            <PlayCircle className="text-nyy-500" size={20} />
            <h2 className="type-section">Phase 2C · AC-3 samples → PCM 解码 POC</h2>
          </div>
          <p className="type-body-sm mb-4 text-gray-600 dark:text-gray-400">
            用刚才提取的 compressed AC-3 sample 拼成临时 `.ac3` 文件，交给自定义 libav-ac3 decoder 做实际解码。当前先验证“能否解出 PCM frames”，还不做声音播放。
          </p>
          <div className="flex flex-wrap gap-2">
            {audioSamplePoints.map((point) => (
              <div key={`decode-${point}`} className="flex gap-2">
                <button
                  onClick={() => runDecodeSample(point)}
                  disabled={decodeLoading !== null}
                  className="min-h-[44px] rounded-xl border border-warm-200 px-4 text-sm font-medium text-gray-700 disabled:opacity-50 dark:border-gray-600 dark:text-gray-200"
                >
                  {decodeLoading === point ? "解码中..." : `解码 ${formatDuration(point)}`}
                </button>
                <button
                  onClick={() => runDecodeAndPlaySample(point)}
                  disabled={decodeLoading !== null}
                  className="min-h-[44px] rounded-xl border border-nyy-300 px-4 text-sm font-medium text-nyy-700 disabled:opacity-50 dark:border-nyy-700 dark:text-nyy-300"
                >
                  试听
                </button>
              </div>
            ))}
          </div>
          <p className="type-caption mt-3 text-gray-600 dark:text-gray-400">播放状态：{playbackStatus}</p>
          {audioDecodeTests.length > 0 && (
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {audioDecodeTests.map((test, index) => (
                <div key={`${test.targetSec}-${index}`} className="rounded-xl bg-warm-50 p-3 dark:bg-white/[0.04]">
                  <p className={`type-body-sm font-medium ${test.status === "ok" ? "text-green-700 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                    {test.status === "ok" ? "OK" : "ERROR"} · decode {formatDuration(test.targetSec)}
                  </p>
                  <p className="type-caption mt-1 text-gray-600 dark:text-gray-400">
                    frames={test.frameCount} sampleRate={test.sampleRate ?? "-"} channels={test.channels ?? "-"} format={test.sampleFormat}
                  </p>
                  <p className="type-caption text-gray-500 dark:text-gray-500">
                    decodedDuration={test.decodedDurationSec.toFixed(2)}s elapsed={test.elapsedMs.toFixed(0)}ms
                  </p>
                  {test.status === "ok" && (
                    <button
                      onClick={() => playDecodedSample(test.targetSec)}
                      className="mt-2 min-h-[36px] rounded-lg border border-warm-200 px-3 text-xs font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200"
                    >
                      播放该样本
                    </button>
                  )}
                  {test.error && <p className="type-caption mt-1 text-red-600 dark:text-red-400">{test.error}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        {downloadFile && (
          <section className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
            <div className="mb-4 flex items-center gap-2">
              <PlayCircle className="text-nyy-500" size={20} />
              <h2 className="type-section">Phase 3A · 视频 + AC-3 窗口式同步 POC</h2>
            </div>
            <p className="type-body-sm mb-4 text-gray-600 dark:text-gray-400">
              这是最低风险的同步实验：从当前视频时间点解 12 秒 AC-3 音频，重置视频到同一起点，然后同时开播。目标不是正式播放器，而是验证“嘴型能否大致对上”。
            </p>
            <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
              <p className="type-caption text-amber-900/80 dark:text-amber-200/80">
                Edge init matrix 测试已移除（MSE 路径已废弃，改用 SW 原生 Range）。
              </p>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => setShowSyncPreview((v) => !v)}
                className="min-h-[44px] rounded-xl border border-warm-200 px-4 text-sm font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200"
              >
                {showSyncPreview ? "隐藏预览器" : "显示预览器"}
              </button>
              <button onClick={runWindowSyncPoc} className="btn-primary">同步试听当前点（12秒窗口）</button>
            </div>
            {showSyncPreview && (
              <div ref={playerWrapRef} className="mt-4 overflow-hidden rounded-2xl bg-black/5 p-2 dark:bg-white/[0.03]">
                <SyncPreview file={downloadFile} />
              </div>
            )}
            <p className="type-caption mt-3 text-gray-600 dark:text-gray-400">同步状态：{syncStatus}</p>
          </section>
        )}

        {downloadFile && (
          <section className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
            <div className="mb-4 flex items-center gap-2">
              <PlayCircle className="text-nyy-500" size={20} />
              <h2 className="type-section">POC · Service Worker 原生 Range 播放</h2>
            </div>
            <p className="type-body-sm mb-4 text-gray-600 dark:text-gray-400">
              这条路线绕过手写 MSE append，把多个 512MB chunk 伪装成一个支持 Range 的同源 MP4 URL，交给浏览器原生 <code>{"<video>"}</code> 播放。目标是验证 Windows Edge 是否能走原生 MP4 管线。
            </p>
            <div className="flex flex-wrap gap-2">
              <button onClick={runNativeRangePoc} className="btn-primary">启动原生 Range 播放 POC</button>
            </div>
            <p className="type-caption mt-3 break-all text-gray-600 dark:text-gray-400">状态：{nativeRangeStatus}</p>
            {nativeRangeUrl && (
              <div className="mt-4 overflow-hidden rounded-2xl bg-black/5 p-2 dark:bg-white/[0.03]">
                <video
                  src={nativeRangeUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="block w-full rounded-xl bg-black"
                  onLoadedMetadata={(event) => {
                    const video = event.currentTarget;
                    setNativeRangeStatus(`metadata ok · duration=${video.duration.toFixed(2)}s · readyState=${video.readyState}`);
                  }}
                  onCanPlay={(event) => {
                    const video = event.currentTarget;
                    setNativeRangeStatus(`canplay ok · readyState=${video.readyState} · duration=${video.duration.toFixed(2)}s`);
                  }}
                  onError={(event) => {
                    const mediaError = event.currentTarget.error;
                    setNativeRangeStatus(`video error · code=${mediaError?.code ?? "unknown"} · ${mediaError?.message || "no message"}`);
                  }}
                />
              </div>
            )}
          </section>
        )}

        <section className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
          <div className="mb-4 flex items-center gap-2">
            <PlayCircle className="text-nyy-500" size={20} />
            <h2 className="type-section">人工听感记录</h2>
          </div>
          <p className="type-body-sm mb-4 text-gray-600 dark:text-gray-400">Phase 2 以后这里会配合 AC-3 WASM 播放测试；目前先记录设备与主观结果。</p>
          <div className="grid gap-3 md:grid-cols-3">
            {([
              ["device", "设备，如 Windows Chrome / iPhone Safari"],
              ["browser", "浏览器版本"],
              ["testPoint", "测试点，如 00:05:00"],
              ["hasSound", "是否有声音"],
              ["syncRating", "同步：好/轻微/明显不同步"],
              ["artifacts", "杂音：无/爆音/断续/失真"],
              ["seekRecovery", "seek恢复：<1s/1-3s/3-8s/>8s/失败"],
              ["heat", "发热/卡顿观察"],
              ["score", "主观评分 1-5"],
            ] as const).map(([key, placeholder]) => (
              <input
                key={key}
                value={manual[key]}
                onChange={(e) => setManual((prev) => ({ ...prev, [key]: e.target.value }))}
                placeholder={placeholder}
                className="min-h-[44px] rounded-xl border border-warm-200 bg-white px-3 text-sm outline-none focus:border-nyy-400 dark:border-gray-700 dark:bg-white/[0.04]"
              />
            ))}
            <textarea
              value={manual.notes}
              onChange={(e) => setManual((prev) => ({ ...prev, notes: e.target.value }))}
              placeholder="备注"
              className="min-h-[88px] rounded-xl border border-warm-200 bg-white px-3 py-2 text-sm outline-none focus:border-nyy-400 dark:border-gray-700 dark:bg-white/[0.04] md:col-span-3"
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button onClick={addManualResult} className="btn-primary">添加记录</button>
            <button onClick={exportReport} className="inline-flex min-h-[44px] items-center gap-2 rounded-xl border border-warm-200 px-4 text-sm font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200">
              <FileJson size={16} /> 导出 JSON
            </button>
          </div>
          {manualResults.length > 0 && (
            <div className="mt-4 space-y-2">
              {manualResults.map((item, index) => (
                <div key={index} className="rounded-xl bg-warm-50 p-3 dark:bg-white/[0.04]">
                  <p className="type-body-sm font-medium">{item.device || "未命名设备"} · {item.testPoint} · score {item.score || "-"}</p>
                  <p className="type-caption text-gray-500 dark:text-gray-400">sound={item.hasSound} sync={item.syncRating} artifacts={item.artifacts} recovery={item.seekRecovery}</p>
                  {item.notes && <p className="type-caption mt-1 text-gray-600 dark:text-gray-300">{item.notes}</p>}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-warm-200 bg-white p-5 dark:border-gray-700 dark:bg-card">
          <h2 className="type-section mb-3">当前报告预览</h2>
          <pre className="max-h-[420px] overflow-auto rounded-2xl bg-gray-950 p-4 text-xs text-gray-100">{JSON.stringify(report, null, 2)}</pre>
        </section>
      </div>
    </main>
  );
}
