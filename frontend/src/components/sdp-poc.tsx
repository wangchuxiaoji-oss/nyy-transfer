"use client";

/**
 * POC: Verify mediabunny can parse our chunked MKV file via CustomSource.
 * This component renders a small diagnostic panel showing:
 * - Whether mediabunny can read the file format
 * - Video track decoder config (codec, resolution, description bytes)
 * - Audio track decoder config
 * - Duration
 * - First few packet timestamps
 *
 * Usage: render this alongside the existing player with ?sdp=2
 */

import { useCallback, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import { RangeFileReader } from "@/lib/range-file-reader";

interface PocResult {
  canRead: boolean;
  format: string | null;
  mimeType: string | null;
  duration: number | null;
  videoConfig: Record<string, unknown> | null;
  audioConfig: Record<string, unknown> | null;
  firstPackets: { ts: number; key: boolean; size: number }[];
  error: string | null;
  elapsedMs: number;
}

interface SdpPocProps {
  file: ShareFileDownload;
}

export function SdpPoc({ file }: SdpPocProps) {
  const [result, setResult] = useState<PocResult | null>(null);
  const [running, setRunning] = useState(false);

  const runPoc = useCallback(async () => {
    setRunning(true);
    setResult(null);
    const start = performance.now();
    try {
      const { Input, MATROSKA, CustomSource, EncodedPacketSink } =
        await import("mediabunny");

      const reader = new RangeFileReader(file);
      const source = new CustomSource({
        getSize: () => reader.totalSize,
        read: async (s: number, e: number) => {
          const buf = await reader.read(s, e);
          return new Uint8Array(buf);
        },
        prefetchProfile: "network",
        maxCacheSize: 16 * 1024 * 1024,
      });

      const input = new Input({ source, formats: [MATROSKA] });
      const canRead = await input.canRead();
      const format = canRead
        ? String((await input.getFormat())?.constructor?.name ?? "unknown")
        : null;
      const mimeType = canRead ? await input.getMimeType() : null;
      const duration = canRead
        ? await input.getDurationFromMetadata()
        : null;

      let videoConfig: Record<string, unknown> | null = null;
      let audioConfig: Record<string, unknown> | null = null;
      const firstPackets: { ts: number; key: boolean; size: number }[] = [];

      if (canRead) {
        const videoTrack = await input.getPrimaryVideoTrack();
        if (videoTrack) {
          const cfg = await videoTrack.getDecoderConfig();
          if (cfg) {
            videoConfig = {
              codec: cfg.codec,
              codedWidth: cfg.codedWidth,
              codedHeight: cfg.codedHeight,
              descriptionBytes: cfg.description
                ? (cfg.description as Uint8Array).byteLength
                : 0,
            };
          }
          // Read first 10 packets
          const sink = new EncodedPacketSink(videoTrack);
          let packet = await sink.getFirstKeyPacket();
          let count = 0;
          while (packet && count < 10) {
            firstPackets.push({
              ts: packet.timestamp,
              key: packet.type === "key",
              size: packet.data.byteLength,
            });
            packet = await sink.getNextPacket(packet);
            count++;
          }
        }
        const audioTrack = await input.getPrimaryAudioTrack();
        if (audioTrack) {
          const cfg = await audioTrack.getDecoderConfig();
          if (cfg) {
            audioConfig = {
              codec: cfg.codec,
              sampleRate: cfg.sampleRate,
              numberOfChannels: cfg.numberOfChannels,
              descriptionBytes: cfg.description
                ? (cfg.description as Uint8Array).byteLength
                : 0,
            };
          }
        }
      }

      input.dispose();
      setResult({
        canRead,
        format,
        mimeType,
        duration,
        videoConfig,
        audioConfig,
        firstPackets,
        error: null,
        elapsedMs: Math.round(performance.now() - start),
      });
    } catch (err) {
      setResult({
        canRead: false,
        format: null,
        mimeType: null,
        duration: null,
        videoConfig: null,
        audioConfig: null,
        firstPackets: [],
        error: err instanceof Error ? err.message : String(err),
        elapsedMs: Math.round(performance.now() - start),
      });
    } finally {
      setRunning(false);
    }
  }, [file]);

  return (
    <div className="space-y-2 rounded-xl border border-blue-300 bg-blue-50 p-3 dark:border-blue-700 dark:bg-blue-950/30">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold text-blue-800 dark:text-blue-200">
          SDP v2 POC (mediabunny)
        </p>
        <button
          type="button"
          onClick={runPoc}
          disabled={running}
          className="rounded border border-blue-400 px-2 py-1 text-xs text-blue-700 disabled:opacity-50 dark:text-blue-300"
        >
          {running ? "Running..." : "Run POC"}
        </button>
      </div>
      {result && (
        <pre className="max-h-64 overflow-auto rounded bg-white p-2 text-xs dark:bg-black/40">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}
