import type { ShareFileDownload } from "./api";

interface VirtualChunk {
  index: number;
  url: string;
  start: number;
  end: number;
  size: number;
}

const RANGE_FETCH_MAX_ATTEMPTS = 3;
const RANGE_FETCH_RETRY_DELAYS_MS = [300, 900];
// Dynamic per-attempt timeout: scales with requested bytes so that large
// sequential reads (mediabunny grows reads up to ~8MB) are not killed at a
// fixed deadline, while small cold reads still fail fast enough to retry.
// CDN cold-region TTFB can spike to several seconds, so keep a generous base.
const RANGE_READ_TIMEOUT_BASE_MS = 10_000;
const RANGE_READ_TIMEOUT_PER_MB_MS = 3_500;
const RANGE_READ_TIMEOUT_MAX_MS = 30_000;

function computeReadTimeoutMs(bytes: number): number {
  const mb = Math.max(0, bytes) / (1024 * 1024);
  const ms = RANGE_READ_TIMEOUT_BASE_MS + mb * RANGE_READ_TIMEOUT_PER_MB_MS;
  return Math.min(RANGE_READ_TIMEOUT_MAX_MS, Math.round(ms));
}

/** Marks errors that must not be retried (definitive failures). */
class NonRetryableRangeError extends Error {}

/** Per-attempt observability hook (retry visibility in debug logs). */
export interface RangeReadAttemptInfo {
  attempt: number;
  ok: boolean;
  status?: number;
  timedOut: boolean;
  timeoutMs: number;
  durationMs: number;
  willRetry: boolean;
  error?: string;
  chunkIndex: number;
  requestedBytes: number;
}
export type RangeReadObserver = (info: RangeReadAttemptInfo) => void;

export class RangeFileReader {
  private chunks: VirtualChunk[];
  readonly totalSize: number;

  constructor(file: ShareFileDownload) {
    if (file.is_chunked) {
      let offset = 0;
      this.chunks = [...file.chunks].sort((a, b) => a.index - b.index).map((chunk) => {
        const size = Number(chunk.size || 0);
        const item = {
          index: chunk.index,
          url: chunk.download_url,
          start: offset,
          end: offset + size - 1,
          size,
        };
        offset += size;
        return item;
      });
      this.totalSize = offset;
    } else {
      this.chunks = [{ index: 0, url: file.download_url, start: 0, end: file.file_size - 1, size: file.file_size }];
      this.totalSize = file.file_size;
    }
  }

  async read(start: number, end: number, signal?: AbortSignal, observer?: RangeReadObserver): Promise<ArrayBuffer> {
    const boundedStart = Math.max(0, start);
    const boundedEnd = Math.min(Math.max(boundedStart, end), this.totalSize);
    if (boundedStart >= boundedEnd) return new ArrayBuffer(0);

    const parts: ArrayBuffer[] = [];
    for (const chunk of this.chunks) {
      if (chunk.end < boundedStart) continue;
      if (chunk.start >= boundedEnd) break;

      const localStart = Math.max(0, boundedStart - chunk.start);
      const localEnd = Math.min(chunk.size, boundedEnd - chunk.start);
      const requestedBytes = localEnd - localStart;
      const buf = await fetchChunkRange(chunk, localStart, localEnd, requestedBytes, signal, observer);
      parts.push(buf);
    }

    if (parts.length === 1) return parts[0];
    const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(new Uint8Array(part), offset);
      offset += part.byteLength;
    }
    return out.buffer;
  }

  readFirstBytes(bytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.read(0, Math.min(bytes, this.totalSize), signal);
  }
}

async function fetchChunkRange(
  chunk: VirtualChunk,
  localStart: number,
  localEnd: number,
  requestedBytes: number,
  parentSignal?: AbortSignal,
  observer?: RangeReadObserver,
): Promise<ArrayBuffer> {
  const range = `bytes=${localStart}-${localEnd - 1}`;
  const timeoutMs = computeReadTimeoutMs(requestedBytes);
  let lastError: unknown;

  const report = (
    attempt: number,
    fields: Partial<RangeReadAttemptInfo> & { durationMs: number },
  ) => {
    observer?.({
      attempt,
      ok: false,
      timedOut: false,
      willRetry: false,
      timeoutMs,
      chunkIndex: chunk.index,
      requestedBytes,
      ...fields,
    });
  };

  for (let attempt = 1; attempt <= RANGE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    // Parent cancellation (e.g. a newer seek) is definitive — never retry.
    if (parentSignal?.aborted) {
      throw new Error(`${abortReasonMessage(parentSignal)} (${describeChunkRange(chunk, localStart, localEnd)})`);
    }

    const attemptAbort = createReadAbortSignal(parentSignal, timeoutMs);
    const startedAt = performance.now();
    try {
      const resp = await fetch(chunk.url, { headers: { Range: range }, signal: attemptAbort.signal });

      // 200 on a partial request means the CDN ignored Range — fetching the
      // whole (possibly 512MB) chunk is never acceptable. Definitive failure.
      if (resp.status === 200 && requestedBytes < chunk.size) {
        await resp.body?.cancel().catch(() => undefined);
        report(attempt, { status: 200, durationMs: performance.now() - startedAt, error: "CDN ignored Range" });
        throw new NonRetryableRangeError(
          `CDN ignored Range request; refusing to fetch a full large chunk (${describeChunkRange(chunk, localStart, localEnd)})`,
        );
      }

      if (resp.ok || resp.status === 206) {
        // Body download is part of the timed window: a stalled stream after
        // headers arrive must also count against the per-attempt deadline.
        const buf = await resp.arrayBuffer();
        if (attempt > 1) report(attempt, { ok: true, status: resp.status, durationMs: performance.now() - startedAt });
        return buf;
      }

      await resp.body?.cancel().catch(() => undefined);
      if (!isRetryableRangeStatus(resp.status) || attempt === RANGE_FETCH_MAX_ATTEMPTS) {
        report(attempt, { status: resp.status, durationMs: performance.now() - startedAt, error: `HTTP ${resp.status}` });
        throw new NonRetryableRangeError(`Range fetch failed: HTTP ${resp.status} (${describeChunkRange(chunk, localStart, localEnd)})`);
      }
      lastError = new Error(`HTTP ${resp.status}`);
      report(attempt, { status: resp.status, durationMs: performance.now() - startedAt, error: `HTTP ${resp.status}`, willRetry: true });
    } catch (err) {
      if (err instanceof NonRetryableRangeError) throw err;
      // Distinguish OUR per-attempt timeout (retryable) from a parent cancel
      // (definitive). attemptAbort fires for both, so check the parent first.
      if (parentSignal?.aborted) {
        throw new Error(`${abortReasonMessage(parentSignal)} (${describeChunkRange(chunk, localStart, localEnd)})`);
      }
      const isLast = attempt === RANGE_FETCH_MAX_ATTEMPTS;
      report(attempt, {
        timedOut: attemptAbort.timedOut,
        durationMs: performance.now() - startedAt,
        error: attemptAbort.timedOut ? `timeout ${timeoutMs}ms` : errorMessage(err),
        willRetry: !isLast,
      });
      if (isLast) {
        const message = attemptAbort.timedOut
          ? `Range read timeout after ${timeoutMs}ms`
          : errorMessage(err);
        throw new Error(`Range fetch failed after ${attempt} attempt(s): ${message} (${describeChunkRange(chunk, localStart, localEnd)})`);
      }
      lastError = err;
    } finally {
      attemptAbort.cleanup();
    }

    await waitForRetry(RANGE_FETCH_RETRY_DELAYS_MS[attempt - 1] ?? RANGE_FETCH_RETRY_DELAYS_MS[RANGE_FETCH_RETRY_DELAYS_MS.length - 1], parentSignal);
  }

  throw new Error(`Range fetch failed: ${errorMessage(lastError)} (${describeChunkRange(chunk, localStart, localEnd)})`);
}

function isRetryableRangeStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(abortReasonMessage(signal)));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(new Error(signal ? abortReasonMessage(signal) : "Range fetch aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createReadAbortSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void; readonly timedOut: boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Range read timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  const onParentAbort = () => {
    controller.abort(parentSignal?.reason ?? new Error("Range fetch aborted"));
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

function describeChunkRange(chunk: VirtualChunk, localStart: number, localEnd: number): string {
  return `chunk=${chunk.index} host=${safeHost(chunk.url)} bytes=${localStart}-${localEnd - 1}`;
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReasonMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  return "Range fetch aborted";
}
