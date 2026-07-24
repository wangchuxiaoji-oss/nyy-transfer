"use client";

import { useRef, useState } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { PlayerChrome } from "@/components/player/player-chrome";
import { useSdpPlayerAdapter } from "@/components/player/use-sdp-player-adapter";

interface SdpPlayerProps {
  file: ShareFileDownload;
  debugLog?: DebugLogFn;
}

export function SdpPlayer({ file, debugLog }: SdpPlayerProps) {
  const [sessionKey, setSessionKey] = useState(0);

  return (
    <SdpPlayerSession
      key={sessionKey}
      file={file}
      debugLog={debugLog}
      onRetry={() => setSessionKey((key) => key + 1)}
    />
  );
}

function SdpPlayerSession({ file, debugLog, onRetry }: SdpPlayerProps & { onRetry: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { viewState, actions } = useSdpPlayerAdapter(canvasRef, file, debugLog);

  return (
    <div data-testid="sdp-player" className="relative h-full w-full min-w-0">
      <PlayerChrome view={viewState} actions={actions}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full min-w-0 max-w-full bg-black object-contain"
        />
      </PlayerChrome>
      {viewState.error && (
        <button
          type="button"
          data-testid="sdp-retry"
          onClick={onRetry}
          className="absolute bottom-[28%] left-1/2 z-40 -translate-x-1/2 rounded-xl border border-[#FF8A3D]/60 bg-[#1A0E18]/90 px-4 py-2 font-tech text-xs tracking-widest text-white shadow-[0_0_24px_rgba(255,138,61,0.22)] backdrop-blur-xl transition hover:border-[#FF8A3D] hover:bg-[#2A151F] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF8A3D]"
        >
          重试在线预览
        </button>
      )}
    </div>
  );
}
