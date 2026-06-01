"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { RangeFileReader } from "@/lib/range-file-reader";
import { probeUnsupportedMediaBuffer, type UnsupportedMediaProbe } from "@/lib/unsupported-media-probe";
import { SdpPlayer } from "@/components/sdp-player";

const SDP_VIDEO_EXTS = new Set(["mp4", "mkv", "wmv"]);
const PROBE_BYTES = 16 * 1024 * 1024;
const MKV_FAST_PROBE_BYTES = 4 * 1024 * 1024;

type SdpMediaType = "video" | null;

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
  const [probe, setProbe] = useState<UnsupportedMediaProbe | null>(null);
  const ext = getFileExtension(file.file_name);
  const capabilities = useMemo(() => collectCapabilities(), []);
  const mediaType = getSelfDevelopMediaType(file.file_name);
  const hasProbeAudioTrack = (probe?.audio_tracks?.length ?? 0) > 0;
  // For MP4, the upload probe already filled media_metadata with audio track info.
  const hasMetadataAudioTrack = ext === "mp4" && (file.media_metadata?.audio_tracks?.length ?? 0) > 0;

  const probeRemoteContainer = useCallback(async (signal: AbortSignal): Promise<UnsupportedMediaProbe | null> => {
    const firstProbeBytes = ext === "mkv" ? MKV_FAST_PROBE_BYTES : PROBE_BYTES;
    const fileName = file.file_name;
    const fileSize = file.file_size;
    debugLog?.("sdp", "probe:start", { fileName, fileSize, ext, probeBytes: firstProbeBytes, message: `SDP ${ext.toUpperCase()} 路径：读取头部 ${formatSize(Math.min(firstProbeBytes, fileSize))} 做容器探测` });

    const reader = new RangeFileReader(file);
    let buffer = await reader.readFirstBytes(firstProbeBytes, signal);
    if (signal.aborted) return null;

    let nextProbe = probeUnsupportedMediaBuffer(buffer, fileName, fileSize);
    if (ext === "mkv" && nextProbe.probe_status !== "ok" && firstProbeBytes < PROBE_BYTES) {
      debugLog?.("sdp", "probe:retry", { fileName, previousStatus: nextProbe.probe_status, previousError: nextProbe.probe_error || null, probeBytes: PROBE_BYTES, message: `SDP MKV 快速探测不足，扩大到 ${formatSize(Math.min(PROBE_BYTES, fileSize))}` });
      buffer = await reader.readFirstBytes(PROBE_BYTES, signal);
      if (signal.aborted) return null;
      nextProbe = probeUnsupportedMediaBuffer(buffer, fileName, fileSize);
    }
    const decoderTarget = getDecoderTarget(ext, nextProbe);
    const message = ext === "mkv"
      ? "SDP MKV-first：头部探测完成，可启动 Matroska demux + WebCodecs video-only 预览"
      : ext === "wmv"
        ? "SDP WMV 已挪到最后阶段；当前只保留 ASF/WMV 探测结果，不启动解码链"
        : `SDP 已完成 ${ext.toUpperCase()} 头部探测；下一步需要接入 WASM demux/decoder`;
    debugLog?.("sdp", "probe:done", {
      status: nextProbe.probe_status,
      container: nextProbe.container_label || nextProbe.container || "unknown",
      videoCodec: nextProbe.video_tracks?.[0]?.codec || "unknown",
      audioCodec: nextProbe.audio_tracks?.[0]?.codec || "unknown",
      bytesRead: nextProbe.bytes_read,
      remuxLevel: nextProbe.playback?.remux_potential.level || "unknown",
      nextStep: decoderTarget,
      message,
    });
    return nextProbe;
  }, [debugLog, ext, file.file_name, file.file_size]);

  useEffect(() => {
    const abort = new AbortController();
    setProbe(null);

    debugLog?.("sdp", "init", {
      fileName: file.file_name,
      fileSize: file.file_size,
      ext,
      mediaType,
      capabilities,
    });

    if (!mediaType) {
      debugLog?.("sdp", "unsupported:ext", { ext, reason: "mediaType=null", error: "SDP 初版只接受 mp4 / mkv / wmv" });
      return () => abort.abort();
    }

    // MP4: upload probe already has track info in media_metadata,
    // skip the container probe and go directly to the SDP engine.
    if (ext === "mp4") {
      debugLog?.("sdp", "state", { state: "mkv-ready", message: "SDP MP4：复用上传探针，直接启动 Matroska/ISOBMFF demux + WebCodecs" });
      if (!hasMetadataAudioTrack) {
        debugLog?.("sdp", "no-audio-track", { ext, source: "media_metadata", error: "SDP v2 音频主时钟需要音频轨；当前 MP4 文件未检测到音频轨（media_metadata 无音频信息），已禁用 SDP 播放" });
      } else {
        debugLog?.("sdp", "render:sdp-player", { ext, branch: "mp4-metadata" });
      }
      return () => abort.abort();
    }

    if (ext === "mkv") {
      debugLog?.("sdp", "mkv:hint", { note: "MKV 已提升为当前优先级；本阶段实现 Matroska 容器解析和 WebCodecs 视频解码预览，音频同步和 seek 会在下一阶段补齐" });
    }
    if (ext === "wmv") {
      debugLog?.("sdp", "wmv:hint", { note: "WMV 已按你的要求挪到最后：当前只做 ASF/WMV 探测，暂不启动 WASM 解码链" });
    }

    probeRemoteContainer(abort.signal)
      .then((result) => {
        if (abort.signal.aborted || !result) return;
        setProbe(result);
        if (ext === "mkv" && result.probe_status === "ok") {
          const probeHasAudio = (result.audio_tracks?.length ?? 0) > 0;
          if (!probeHasAudio) {
            debugLog?.("sdp", "no-audio-track", { ext, source: "container-probe", error: "SDP v2 音频主时钟需要音频轨；当前文件未检测到音频轨，已禁用 SDP 播放" });
          } else {
            debugLog?.("sdp", "render:sdp-player", { ext, branch: "mkv-probe" });
          }
        }
      })
      .catch((err) => {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        debugLog?.("sdp", "error", { error: message, message: "SDP 初始化失败" });
      });

    return () => abort.abort();
  }, [capabilities, debugLog, ext, file.file_name, file.file_size, hasMetadataAudioTrack, mediaType, probeRemoteContainer]);

  return (
    <div className={className}>
      {(ext === "mkv" && probe?.probe_status === "ok" && hasProbeAudioTrack) && (
        <SdpPlayer file={file} debugLog={debugLog} />
      )}
      {(ext === "mp4" && hasMetadataAudioTrack) && (
        <SdpPlayer file={file} debugLog={debugLog} />
      )}
    </div>
  );
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
