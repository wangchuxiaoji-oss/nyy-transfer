declare module "mp4box" {
  interface MP4Info {
    duration: number;
    timescale: number;
    brands: string[];
    tracks: MP4Track[];
    mime: string;
  }

  interface MP4Track {
    id: number;
    type: string;
    codec: string;
    duration: number;
    timescale: number;
    nb_samples: number;
    size: number;
    bitrate: number;
    width?: number;
    height?: number;
    audio?: { sample_rate: number; channel_count: number };
  }

  interface MP4Sample {
    number: number;
    track_id: number;
    description_index: number;
    description: Record<string, unknown>;
    data: ArrayBuffer;
    size: number;
    duration: number;
    cts: number;
    dts: number;
    is_sync: boolean;
    is_leading: number;
    depends_on: number;
    is_depended_on: number;
    has_redundancy: number;
    degradation_priority: number;
    offset: number;
  }

  interface SegmentOptions {
    nbSamples?: number;
    rapAlignement?: boolean;
  }

  interface MP4File {
    onReady: ((info: MP4Info) => void) | null;
    onError: ((e: Error) => void) | null;
    onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null;
    onSegment: ((id: number, user: unknown, buffer: ArrayBuffer, sampleNum: number, is_last: boolean) => void) | null;
    appendBuffer(buffer: ArrayBuffer & { fileStart?: number }): number;
    start(): void;
    stop(): void;
    flush(): void;
    setExtractionOptions(trackId: number, user?: unknown, options?: { nbSamples?: number }): void;
    setSegmentOptions(trackId: number, user?: unknown, options?: SegmentOptions): void;
    initializeSegmentation(): { id: number; user: unknown; buffer: ArrayBuffer }[];
    getTrackById(id: number): MP4Track | undefined;
    getInfo(): MP4Info;
    seek(time: number, useRap?: boolean): { offset: number; time: number };
  }

  function createFile(): MP4File;
  export { createFile, MP4File, MP4Info, MP4Track, MP4Sample, SegmentOptions };
}
