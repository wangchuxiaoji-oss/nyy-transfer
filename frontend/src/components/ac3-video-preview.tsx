"use client";

import { useRef } from "react";
import type { ShareFileDownload } from "@/lib/api";
import { PlayerChrome } from "@/components/player/player-chrome";
import { useAc3PlayerAdapter } from "@/components/player/use-ac3-player-adapter";

interface Ac3VideoPreviewProps {
  file: ShareFileDownload;
  onDownload?: () => void;
}

export function Ac3VideoPreview({ file }: Ac3VideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { viewState, actions, src } = useAc3PlayerAdapter(videoRef, file);

  return (
    <PlayerChrome view={viewState} actions={actions}>
      <video
        ref={videoRef}
        src={src || undefined}
        muted
        playsInline
        preload="metadata"
        crossOrigin="anonymous"
        className="absolute inset-0 h-full w-full bg-black object-contain"
        data-testid="ac3-video-preview"
      />
    </PlayerChrome>
  );
}
