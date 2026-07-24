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
type ProbeState = "idle" | "loading" | "ready" | "error";

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
  const [probeState, setProbeState] = useState<ProbeState>("idle");
  const [probeError, setProbeError] = useState("");
  const [probeAttempt, setProbeAttempt] = useState(0);
  const ext = getFileExtension(file.file_name);
  const capabilities = useMemo(() => collectCapabilities(), []);
  const mediaType = getSelfDevelopMediaType(file.file_name);
  const hasProbeAudioTrack = (probe?.audio_tracks?.length ?? 0) > 0;
  // 上传探针已给 MP4/MKV 填充音视频轨信息时，不需要再发远端 Range 探测。
  const hasMetadataAudioTrack = (file.media_metadata?.audio_tracks?.length ?? 0) > 0;
  const hasMetadataVideoTrack = (file.media_metadata?.video_tracks?.length ?? 0) > 0;
  const hasUsableMkvMetadata = ext === "mkv"
    && file.media_metadata?.probe_status === "ok"
    && hasMetadataAudioTrack
    && hasMetadataVideoTrack;

  const probeRemoteContainer = useCallback(async (isCancelled: () => boolean): Promise<UnsupportedMediaProbe | null> => {
    const firstProbeBytes = ext === "mkv" ? MKV_FAST_PROBE_BYTES : PROBE_BYTES;
    const fileName = file.file_name;
    const fileSize = file.file_size;
    debugLog?.("sdp", "probe:start", { fileName, fileSize, ext, probeBytes: firstProbeBytes, message: `SDP ${ext.toUpperCase()} 路径：读取头部 ${formatSize(Math.min(firstProbeBytes, fileSize))} 做容器探测` });

    const reader = new RangeFileReader(file);
    let buffer = await reader.readFirstBytes(firstProbeBytes);
    if (isCancelled()) return null;

    let nextProbe = probeUnsupportedMediaBuffer(buffer, fileName, fileSize);
    if (ext === "mkv" && nextProbe.probe_status !== "ok" && firstProbeBytes < PROBE_BYTES) {
      debugLog?.("sdp", "probe:retry", { fileName, previousStatus: nextProbe.probe_status, previousError: nextProbe.probe_error || null, probeBytes: PROBE_BYTES, message: `SDP MKV 快速探测不足，扩大到 ${formatSize(Math.min(PROBE_BYTES, fileSize))}` });
      buffer = await reader.readFirstBytes(PROBE_BYTES);
      if (isCancelled()) return null;
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
  }, [debugLog, ext, file]);

  useEffect(() => {
    let cancelled = false;
    setProbe(null);
    setProbeState("idle");
    setProbeError("");

    debugLog?.("sdp", "init", {
      fileName: file.file_name,
      fileSize: file.file_size,
      ext,
      mediaType,
      capabilities,
    });

    if (!mediaType) {
      debugLog?.("sdp", "unsupported:ext", { ext, reason: "mediaType=null", error: "SDP 初版只接受 mp4 / mkv / wmv" });
      setProbeState("error");
      setProbeError("当前文件格式尚未接入客户端播放通道。");
      return () => { cancelled = true; };
    }

    if (!supportsSelfDevelopPlayback()) {
      const message = "当前浏览器缺少 WebCodecs 音视频解码能力，无法建立客户端播放通道。";
      debugLog?.("sdp", "unsupported:runtime", { ext, error: message });
      setProbeState("error");
      setProbeError(message);
      return () => { cancelled = true; };
    }

    // MP4: upload probe already has track info in media_metadata,
    // skip the container probe and go directly to the SDP engine.
    if (ext === "mp4") {
      setProbeState(hasMetadataAudioTrack ? "ready" : "error");
      if (!hasMetadataAudioTrack) setProbeError("当前文件没有可用于同步播放的音频轨信息。");
      debugLog?.("sdp", "state", { state: "mkv-ready", message: "SDP MP4：复用上传探针，直接启动 Matroska/ISOBMFF demux + WebCodecs" });
      if (!hasMetadataAudioTrack) {
        debugLog?.("sdp", "no-audio-track", { ext, source: "media_metadata", error: "SDP v2 音频主时钟需要音频轨；当前 MP4 文件未检测到音频轨（media_metadata 无音频信息），已禁用 SDP 播放" });
      } else {
        debugLog?.("sdp", "render:sdp-player", { ext, branch: "mp4-metadata" });
      }
      return () => { cancelled = true; };
    }

    if (hasUsableMkvMetadata) {
      setProbeState("ready");
      debugLog?.("sdp", "render:sdp-player", { ext, branch: "mkv-metadata" });
      return () => { cancelled = true; };
    }

    if (ext === "mkv") {
      debugLog?.("sdp", "mkv:hint", { note: "MKV 已提升为当前优先级；本阶段实现 Matroska 容器解析和 WebCodecs 视频解码预览，音频同步和 seek 会在下一阶段补齐" });
    }
    if (ext === "wmv") {
      debugLog?.("sdp", "wmv:hint", { note: "WMV 已按你的要求挪到最后：当前只做 ASF/WMV 探测，暂不启动 WASM 解码链" });
    }

    setProbeState("loading");
    probeRemoteContainer(() => cancelled)
      .then((result) => {
        if (cancelled || !result) return;
        setProbe(result);
        if (ext === "mkv" && result.probe_status === "ok") {
          const probeHasAudio = (result.audio_tracks?.length ?? 0) > 0;
          const probeHasVideo = (result.video_tracks?.length ?? 0) > 0;
          if (!probeHasAudio || !probeHasVideo) {
            setProbeState("error");
            setProbeError(!probeHasVideo ? "未在 MKV 头部识别到视频轨。" : "当前 MKV 没有可用于同步播放的音频轨。");
            debugLog?.("sdp", "no-audio-track", { ext, source: "container-probe", error: "SDP v2 音频主时钟需要音频轨；当前文件未检测到音频轨，已禁用 SDP 播放" });
          } else {
            setProbeState("ready");
            debugLog?.("sdp", "render:sdp-player", { ext, branch: "mkv-probe" });
          }
        } else {
          setProbeState("error");
          setProbeError(result.probe_error || "未能从文件头识别出可播放的音视频轨。");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setProbeState("error");
        setProbeError(message);
        debugLog?.("sdp", "error", { error: message, message: "SDP 初始化失败" });
      });

    return () => { cancelled = true; };
  }, [capabilities, debugLog, ext, file.file_name, file.file_size, hasMetadataAudioTrack, hasUsableMkvMetadata, mediaType, probeAttempt, probeRemoteContainer]);

  return (
    <div className={className}>
      {probeState === "loading" && (
        <div data-testid="sdp-probe-loading" className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[radial-gradient(circle_at_center,rgba(255,138,61,0.14),transparent_48%),#050308] px-6 text-center text-white">
          <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 shadow-[0_0_32px_rgba(255,138,61,0.16)]">
            <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/15 border-t-[#FF8A3D]" />
          </div>
          <div>
            <p className="font-tech text-sm font-bold tracking-widest">正在建立 MKV 播放通道</p>
            <p className="mt-2 text-xs leading-5 text-white/55">仅读取视频头部进行轨道识别，不会下载完整文件。</p>
          </div>
        </div>
      )}
      {probeState === "error" && (
        <div data-testid="sdp-probe-error" className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[radial-gradient(circle_at_center,rgba(255,51,102,0.1),transparent_46%),#050308] px-6 text-center text-white">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-xl text-[#FF8A3D]">!</div>
          <div>
            <p className="font-tech text-sm font-bold tracking-widest">无法建立在线视频通道</p>
            <p className="mt-2 max-w-lg text-xs leading-5 text-white/55">{probeError || "当前浏览器无法解码此视频，请打开原文件或在其他设备下载。"}</p>
          </div>
          <button
            type="button"
            onClick={() => setProbeAttempt((attempt) => attempt + 1)}
            className="rounded-xl border border-[#FF8A3D]/55 bg-[#FF8A3D]/15 px-4 py-2 font-tech text-xs tracking-widest text-white transition hover:border-[#FF8A3D] hover:bg-[#FF8A3D]/25"
          >
            重新检测
          </button>
        </div>
      )}
      {(probeState === "ready" && ext === "mkv" && (hasUsableMkvMetadata || (probe?.probe_status === "ok" && hasProbeAudioTrack))) && (
        <SdpPlayer file={file} debugLog={debugLog} />
      )}
      {(probeState === "ready" && ext === "mp4" && hasMetadataAudioTrack) && (
        <SdpPlayer file={file} debugLog={debugLog} />
      )}
    </div>
  );
}

export function supportsSelfDevelopPlayback(): boolean {
  if (typeof window === "undefined") return false;
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return typeof VideoDecoder !== "undefined"
    && typeof VideoDecoder.isConfigSupported === "function"
    && typeof AudioDecoder !== "undefined"
    && typeof AudioDecoder.isConfigSupported === "function"
    && Boolean(AudioContextCtor);
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
