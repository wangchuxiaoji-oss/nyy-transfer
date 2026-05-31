"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { createVirtualMediaFileId, registerVirtualMediaFile } from "@/lib/virtual-media";
import { RangeFileReader } from "@/lib/range-file-reader";
import { probeUnsupportedMediaBuffer, type UnsupportedMediaProbe } from "@/lib/unsupported-media-probe";
import { MkvWebCodecsPreview } from "@/components/mkv-webcodecs-preview";
import { SdpPoc } from "@/components/sdp-poc";
import { SdpPlayer } from "@/components/sdp-player";

const SDP_VIDEO_EXTS = new Set(["mp4", "mkv", "wmv"]);
const PROBE_BYTES = 16 * 1024 * 1024;
const MKV_FAST_PROBE_BYTES = 4 * 1024 * 1024;

type SdpMediaType = "video" | null;
type PipelineState = "idle" | "probing" | "native-mp4" | "mkv-ready" | "decoder-required" | "wmv-deferred" | "error";

interface SdpCapabilities {
  webAssembly: boolean;
  mediaSource: boolean;
  webCodecsVideoDecoder: boolean;
  webCodecsAudioDecoder: boolean;
  audioContext: boolean;
  offscreenCanvas: boolean;
  webgl2: boolean;
  secureContext: boolean;
  crossOriginIsolated: boolean;
}

interface SelfDevelopPlayerProps {
  file: ShareFileDownload;
  className?: string;
  debugLog?: DebugLogFn;
}

export function getSelfDevelopMediaType(fileName: string): SdpMediaType {
  return SDP_VIDEO_EXTS.has(getFileExtension(fileName)) ? "video" : null;
}

export function SelfDevelopPlayer({ file, className = "", debugLog }: SelfDevelopPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const virtualFileIdRef = useRef("");
  const [state, setState] = useState<PipelineState>("idle");
  const [error, setError] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [probe, setProbe] = useState<UnsupportedMediaProbe | null>(null);
  const [status, setStatus] = useState("SDP 初始化中...");
  const [sdpVersion, setSdpVersion] = useState<"1" | "2">("1");
  const ext = getFileExtension(file.file_name);
  const capabilities = useMemo(() => collectCapabilities(), []);
  const mediaType = getSelfDevelopMediaType(file.file_name);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sdp") === "2") setSdpVersion("2");
  }, []);

  const getOrCreateVirtualFileId = useCallback(() => {
    if (!virtualFileIdRef.current) virtualFileIdRef.current = createVirtualMediaFileId(`sdp-${file.file_name}`);
    return virtualFileIdRef.current;
  }, [file.file_name]);

  const setupMp4NativeReference = useCallback(async (signal: AbortSignal) => {
    setState("native-mp4");
    setStatus("SDP MP4 对照路径：使用浏览器原生 video 作为基准");
    debugLog?.("sdp", "mp4:native-reference:start", {
      fileName: file.file_name,
      fileSize: file.file_size,
      isChunked: file.is_chunked,
      chunks: file.chunks.length,
    });

    const nextSourceUrl = file.is_chunked
      ? await registerVirtualMediaFile(file, `sdp-${file.file_name}`, debugLog, getOrCreateVirtualFileId())
      : file.download_url;

    if (signal.aborted) return;
    setSourceUrl(nextSourceUrl);
    debugLog?.("sdp", "mp4:native-reference:ready", { sourceKind: file.is_chunked ? "virtual-range" : "direct-url" });
  }, [debugLog, file, getOrCreateVirtualFileId]);

  const probeRemoteContainer = useCallback(async (signal: AbortSignal) => {
    setState("probing");
    const firstProbeBytes = ext === "mkv" ? MKV_FAST_PROBE_BYTES : PROBE_BYTES;
    setStatus(`SDP ${ext.toUpperCase()} 路径：读取头部 ${formatSize(Math.min(firstProbeBytes, file.file_size))} 做容器探测`);
    debugLog?.("sdp", "probe:start", { fileName: file.file_name, fileSize: file.file_size, ext, probeBytes: firstProbeBytes });

    const reader = new RangeFileReader(file);
    let buffer = await reader.readFirstBytes(firstProbeBytes, signal);
    if (signal.aborted) return;

    let nextProbe = probeUnsupportedMediaBuffer(buffer, file.file_name, file.file_size);
    if (ext === "mkv" && nextProbe.probe_status !== "ok" && firstProbeBytes < PROBE_BYTES) {
      debugLog?.("sdp", "probe:retry", { fileName: file.file_name, previousStatus: nextProbe.probe_status, previousError: nextProbe.probe_error || null, probeBytes: PROBE_BYTES });
      setStatus(`SDP MKV 快速探测不足，扩大到 ${formatSize(Math.min(PROBE_BYTES, file.file_size))}`);
      buffer = await reader.readFirstBytes(PROBE_BYTES, signal);
      if (signal.aborted) return;
      nextProbe = probeUnsupportedMediaBuffer(buffer, file.file_name, file.file_size);
    }
    setProbe(nextProbe);
    if (ext === "mkv") {
      setState("mkv-ready");
      setStatus("SDP MKV-first：头部探测完成，可启动 Matroska demux + WebCodecs video-only 预览");
    } else if (ext === "wmv") {
      setState("wmv-deferred");
      setStatus("SDP WMV 已挪到最后阶段；当前只保留 ASF/WMV 探测结果，不启动解码链");
    } else {
      setState("decoder-required");
      setStatus(`SDP 已完成 ${ext.toUpperCase()} 头部探测；下一步需要接入 WASM demux/decoder`);
    }
    debugLog?.("sdp", "probe:done", {
      status: nextProbe.probe_status,
      container: nextProbe.container,
      videoCodec: nextProbe.video_tracks?.[0]?.codec || null,
      audioCodec: nextProbe.audio_tracks?.[0]?.codec || null,
      bytesRead: nextProbe.bytes_read,
    });
  }, [debugLog, ext, file]);

  useEffect(() => {
    const abort = new AbortController();
    setError("");
    setProbe(null);
    setSourceUrl("");

    debugLog?.("sdp", "init", {
      fileName: file.file_name,
      fileSize: file.file_size,
      ext,
      mediaType,
      capabilities,
    });

    if (!mediaType) {
      setState("error");
      setError("SDP 初版只接受 mp4 / mkv / wmv");
      return () => abort.abort();
    }

    const run = ext === "mp4" ? setupMp4NativeReference(abort.signal) : probeRemoteContainer(abort.signal);
    run.catch((err) => {
      if (abort.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      setState("error");
      setError(message);
      setStatus("SDP 初始化失败");
      debugLog?.("sdp", "error", { error: message });
    });

    return () => abort.abort();
  }, [capabilities, debugLog, ext, file.file_name, file.file_size, mediaType, probeRemoteContainer, setupMp4NativeReference]);

  return (
    <div className={`space-y-3 rounded-2xl border border-nyy-200 bg-white/80 p-3 dark:border-nyy-800 dark:bg-black/20 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="type-caption font-semibold text-nyy-900 dark:text-nyy-200">SelfDevelopPlayer · SDP</p>
          <p className="type-caption break-all text-gray-500 dark:text-gray-400">{file.file_name}</p>
        </div>
        <span className={getStateClassName(state)}>{getStateLabel(state)}</span>
      </div>

      {sourceUrl && ext === "mp4" && (
        <video
          ref={videoRef}
          src={sourceUrl}
          controls
          crossOrigin="anonymous"
          preload="metadata"
          playsInline
          className="block w-full rounded-2xl bg-black"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            debugLog?.("sdp", "mp4:metadata", {
              duration: Number(video.duration.toFixed(3)),
              videoWidth: video.videoWidth,
              videoHeight: video.videoHeight,
              readyState: video.readyState,
            });
          }}
          onCanPlay={(event) => debugLog?.("sdp", "mp4:canplay", { readyState: event.currentTarget.readyState })}
          onError={() => {
            setError("SDP MP4 对照播放失败");
            debugLog?.("sdp", "mp4:error", { mediaError: videoRef.current?.error?.message || null, code: videoRef.current?.error?.code || null });
          }}
        />
      )}

      <div className="rounded-xl bg-warm-50 p-3 text-xs text-gray-700 dark:bg-white/5 dark:text-gray-300">
        <p className="font-medium text-gray-900 dark:text-gray-100">当前状态</p>
        <p className="mt-1">{status}</p>
      </div>

      {probe && (
        <div className="grid grid-cols-1 gap-2 rounded-xl bg-warm-50 p-3 text-xs text-gray-700 dark:bg-white/5 dark:text-gray-300 sm:grid-cols-2">
          <Field label="容器" value={probe.container_label || probe.container || "unknown"} />
          <Field label="读取大小" value={formatSize(probe.bytes_read)} />
          <Field label="视频编码" value={probe.video_tracks?.[0]?.codec || "unknown"} />
          <Field label="音频编码" value={probe.audio_tracks?.[0]?.codec || "unknown"} />
          <Field label="换封装判断" value={probe.playback?.remux_potential.level || "unknown"} />
          <Field label="下一步" value={getDecoderTarget(ext, probe)} />
        </div>
      )}

      {ext === "mkv" && probe?.probe_status === "ok" && sdpVersion === "1" && (
        <MkvWebCodecsPreview file={file} debugLog={debugLog} />
      )}

      {ext === "mkv" && sdpVersion === "1" && <SdpPoc file={file} />}

      {ext === "mkv" && sdpVersion === "2" && (
        <SdpPlayer file={file} debugLog={debugLog} />
      )}

      <div className="rounded-xl bg-warm-50 p-3 text-xs text-gray-700 dark:bg-white/5 dark:text-gray-300">
        <p className="font-medium text-gray-900 dark:text-gray-100">能力探测</p>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Capability label="WebAssembly" value={capabilities.webAssembly} />
          <Capability label="WebCodecs Video" value={capabilities.webCodecsVideoDecoder} />
          <Capability label="WebCodecs Audio" value={capabilities.webCodecsAudioDecoder} />
          <Capability label="MediaSource" value={capabilities.mediaSource} />
          <Capability label="AudioContext" value={capabilities.audioContext} />
          <Capability label="WebGL2" value={capabilities.webgl2} />
        </div>
      </div>

      {ext === "mkv" && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-900 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-200">
          MKV 已提升为当前优先级：本阶段实现 Matroska 容器解析和 WebCodecs 视频解码预览，音频同步和 seek 会在下一阶段补齐。
        </div>
      )}

      {ext === "wmv" && (
        <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-900 dark:border-yellow-900/50 dark:bg-yellow-950/20 dark:text-yellow-200">
          WMV 已按你的要求挪到最后：当前只做 ASF/WMV 探测，暂不启动 WASM 解码链。
        </div>
      )}

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500 dark:text-gray-400">{label}: </span>
      <span>{value}</span>
    </div>
  );
}

function Capability({ label, value }: { label: string; value: boolean }) {
  return <span>{label}: {value ? "yes" : "no"}</span>;
}

function collectCapabilities(): SdpCapabilities {
  if (typeof window === "undefined") {
    return {
      webAssembly: false,
      mediaSource: false,
      webCodecsVideoDecoder: false,
      webCodecsAudioDecoder: false,
      audioContext: false,
      offscreenCanvas: false,
      webgl2: false,
      secureContext: false,
      crossOriginIsolated: false,
    };
  }
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const canvas = document.createElement("canvas");
  return {
    webAssembly: typeof WebAssembly !== "undefined",
    mediaSource: "MediaSource" in window,
    webCodecsVideoDecoder: "VideoDecoder" in window,
    webCodecsAudioDecoder: "AudioDecoder" in window,
    audioContext: Boolean(AudioContextCtor),
    offscreenCanvas: "OffscreenCanvas" in window,
    webgl2: Boolean(canvas.getContext("webgl2")),
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated,
  };
}

function getDecoderTarget(ext: string, probe: UnsupportedMediaProbe): string {
  const videoCodec = probe.video_tracks?.[0]?.codec || "unknown";
  const audioCodec = probe.audio_tracks?.[0]?.codec || "unknown";
  if (ext === "mkv") return `Matroska demux + ${videoCodec}/${audioCodec} decode`;
  if (ext === "wmv") return `ASF demux + ${videoCodec}/${audioCodec} WASM software decode`;
  return "native MP4 reference";
}

function getStateLabel(state: PipelineState): string {
  if (state === "probing") return "探测中";
  if (state === "native-mp4") return "MP4 对照";
  if (state === "mkv-ready") return "MKV 优先";
  if (state === "decoder-required") return "待接解码器";
  if (state === "wmv-deferred") return "WMV 最后";
  if (state === "error") return "错误";
  return "初始化";
}

function getStateClassName(state: PipelineState): string {
  const base = "rounded-full px-2 py-0.5 text-xs";
  if (state === "native-mp4") return `${base} bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300`;
  if (state === "mkv-ready") return `${base} bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300`;
  if (state === "decoder-required") return `${base} bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300`;
  if (state === "wmv-deferred") return `${base} bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300`;
  if (state === "error") return `${base} bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300`;
  return `${base} bg-nyy-100 text-nyy-800 dark:bg-nyy-900/30 dark:text-nyy-300`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function getFileExtension(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}
