"use client";

import { useEffect, useRef } from "react";
import { PlayerChrome } from "@/components/player/player-chrome";
import { useNativePlayerAdapter, type NativeVideoErrorInfo } from "@/components/player/use-native-player-adapter";

export type { NativeVideoErrorInfo };

export interface NativeVideoResumeRequest {
  key: number;
  time: number;
  play: boolean;
}

interface NativeVideoPlayerProps {
  src: string;
  type: string;
  onError: (message: string, info: NativeVideoErrorInfo) => void;
  onLoadedMetadata?: () => void;
  resumeRequest?: NativeVideoResumeRequest | null;
}

export function NativeVideoPlayer({ src, type, onError, onLoadedMetadata, resumeRequest }: NativeVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { viewState, actions } = useNativePlayerAdapter(videoRef, { src, type, onError, onLoadedMetadata });

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !resumeRequest) return;

    const applyResume = () => {
      if (resumeRequest.time > 0 && Number.isFinite(resumeRequest.time)) {
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Number.POSITIVE_INFINITY;
        video.currentTime = Math.max(0, Math.min(duration - 0.25, resumeRequest.time));
      }
      if (resumeRequest.play) void video.play().catch(() => {});
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      applyResume();
      return;
    }
    video.addEventListener("loadedmetadata", applyResume, { once: true });
    return () => video.removeEventListener("loadedmetadata", applyResume);
  }, [resumeRequest, src]);

  return (
    <PlayerChrome rootTestId="native-video-preview" view={viewState} actions={actions}>
      <video
        ref={videoRef}
        src={src}
        playsInline
        preload="metadata"
        className="absolute inset-0 h-full w-full bg-black object-contain"
      >
        <source src={src} type={type} />
      </video>
    </PlayerChrome>
  );
}
