"use client";

import { useRef } from "react";
import type { ShareFileDownload } from "@/lib/api";
import type { DebugLogFn } from "@/lib/debug";
import { PlayerChrome } from "@/components/player/player-chrome";
import { useSdpPlayerAdapter } from "@/components/player/use-sdp-player-adapter";

interface SdpPlayerProps {
  file: ShareFileDownload;
  debugLog?: DebugLogFn;
}

export function SdpPlayer({ file, debugLog }: SdpPlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { viewState, actions } = useSdpPlayerAdapter(canvasRef, file, debugLog);

  return (
    <div data-testid="sdp-player" className="h-full w-full min-w-0">
      <PlayerChrome view={viewState} actions={actions}>
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full min-w-0 max-w-full bg-black object-contain"
        />
      </PlayerChrome>
    </div>
  );
}
