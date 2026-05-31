/**
 * SDP v2 — MKV Cues seek index (read-only probe support)
 *
 * Consumes the `mkv_seek` block that we attach to a logical file's
 * `media_metadata` (parsed from the MKV `Cues` element at upload time, or
 * bound manually for validation). It maps a target time to the nearest
 * keyframe cue and its absolute byte offset in the logical file.
 *
 * Coordinate system: entries store `cueClusterPosition`, which is relative to
 * the start of the Segment *data*. The absolute byte offset within the logical
 * (multi-chunk) file is `segmentDataStart + cueClusterPosition`. This matches
 * the offset space used by RangeFileReader.read(start, end).
 */

import type { MediaMetadata } from "@/lib/api";

/** A single resolved cue lookup. */
export interface MkvCueLookup {
  /** Cue keyframe timestamp in seconds (<= requested time). */
  cueTimeSec: number;
  /** Absolute byte offset of the Cluster within the logical file. */
  absByteOffset: number;
  /** cueClusterPosition relative to Segment data start. */
  clusterPosition: number;
  /** Index of the chosen entry. */
  entryIndex: number;
}

interface RawSeek {
  timestamp_scale?: unknown;
  segment_data_start?: unknown;
  cue_count?: unknown;
  entries?: unknown;
}

export class MkvSeekIndex {
  /** [timeSec, cueClusterPosition] sorted ascending by time. */
  private readonly entries: ReadonlyArray<readonly [number, number]>;
  readonly segmentDataStart: number;
  readonly timestampScale: number;

  private constructor(
    entries: ReadonlyArray<readonly [number, number]>,
    segmentDataStart: number,
    timestampScale: number,
  ) {
    this.entries = entries;
    this.segmentDataStart = segmentDataStart;
    this.timestampScale = timestampScale;
  }

  get count(): number {
    return this.entries.length;
  }

  /**
   * Build an index from media metadata, or return null if no usable
   * `mkv_seek` block is present. Read-only; never throws on bad input.
   */
  static fromMetadata(meta: MediaMetadata | null | undefined): MkvSeekIndex | null {
    if (!meta || typeof meta !== "object") return null;
    const seek = (meta as { mkv_seek?: RawSeek }).mkv_seek;
    if (!seek || typeof seek !== "object") return null;

    const segmentDataStart = toFiniteNumber(seek.segment_data_start);
    const rawEntries = seek.entries;
    if (segmentDataStart === null || !Array.isArray(rawEntries)) return null;

    const timestampScale = toFiniteNumber(seek.timestamp_scale) ?? 1_000_000;

    const parsed: Array<[number, number]> = [];
    for (const item of rawEntries) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const t = toFiniteNumber(item[0]);
      const pos = toFiniteNumber(item[1]);
      if (t === null || pos === null || t < 0 || pos < 0) continue;
      parsed.push([t, pos]);
    }
    if (parsed.length === 0) return null;
    parsed.sort((a, b) => a[0] - b[0]);

    return new MkvSeekIndex(parsed, segmentDataStart, timestampScale);
  }

  /**
   * Find the nearest cue at or before `timeSec`. Returns null only if the
   * index is empty (guarded by construction) — otherwise clamps to the first
   * entry. Uses binary search over the time-sorted entries.
   */
  lookup(timeSec: number): MkvCueLookup | null {
    const n = this.entries.length;
    if (n === 0) return null;

    const target = Number.isFinite(timeSec) ? timeSec : 0;
    let lo = 0;
    let hi = n - 1;
    let found = 0; // index of greatest entry with time <= target
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid][0] <= target) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    const [cueTimeSec, clusterPosition] = this.entries[found];
    return {
      cueTimeSec,
      clusterPosition,
      absByteOffset: this.segmentDataStart + clusterPosition,
      entryIndex: found,
    };
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
