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
const RANGE_READ_TIMEOUT_MS = 15_000;

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

  async read(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    const boundedStart = Math.max(0, start);
    const boundedEnd = Math.min(Math.max(boundedStart, end), this.totalSize);
    if (boundedStart >= boundedEnd) return new ArrayBuffer(0);

    const abort = createReadAbortSignal(signal, RANGE_READ_TIMEOUT_MS);
    try {
      const parts: ArrayBuffer[] = [];
      for (const chunk of this.chunks) {
        if (chunk.end < boundedStart) continue;
        if (chunk.start >= boundedEnd) break;

        const localStart = Math.max(0, boundedStart - chunk.start);
        const localEnd = Math.min(chunk.size, boundedEnd - chunk.start);
        const requestedBytes = localEnd - localStart;
        const resp = await fetchChunkRange(chunk, localStart, localEnd, abort.signal);
        if (!resp.ok && resp.status !== 206) throw new Error(`Range fetch failed: HTTP ${resp.status} (${describeChunkRange(chunk, localStart, localEnd)})`);
        if (resp.status === 200 && requestedBytes < chunk.size) {
          throw new Error("CDN ignored Range request; refusing to fetch a full large chunk");
        }
        parts.push(await resp.arrayBuffer());
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
    } finally {
      abort.cleanup();
    }
  }

  readFirstBytes(bytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.read(0, Math.min(bytes, this.totalSize), signal);
  }
}

async function fetchChunkRange(chunk: VirtualChunk, localStart: number, localEnd: number, signal?: AbortSignal): Promise<Response> {
  const range = `bytes=${localStart}-${localEnd - 1}`;
  let lastError: unknown;

  for (let attempt = 1; attempt <= RANGE_FETCH_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error(`${abortReasonMessage(signal)} (${describeChunkRange(chunk, localStart, localEnd)})`);
    try {
      const resp = await fetch(chunk.url, { headers: { Range: range }, signal });
      if (resp.ok || !isRetryableRangeStatus(resp.status) || attempt === RANGE_FETCH_MAX_ATTEMPTS) return resp;
      lastError = new Error(`HTTP ${resp.status}`);
      await resp.body?.cancel().catch(() => undefined);
    } catch (err) {
      if (signal?.aborted || attempt === RANGE_FETCH_MAX_ATTEMPTS) {
        const message = signal?.aborted ? abortReasonMessage(signal) : errorMessage(err);
        throw new Error(`Range fetch failed after ${attempt} attempt(s): ${message} (${describeChunkRange(chunk, localStart, localEnd)})`);
      }
      lastError = err;
    }

    await waitForRetry(RANGE_FETCH_RETRY_DELAYS_MS[attempt - 1] ?? RANGE_FETCH_RETRY_DELAYS_MS[RANGE_FETCH_RETRY_DELAYS_MS.length - 1], signal);
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

function createReadAbortSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => {
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
