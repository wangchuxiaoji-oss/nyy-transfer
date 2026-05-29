const files = new Map();
const FIRST_FETCH_SLICE_SIZE = 512 * 1024;
const FETCH_SLICE_SIZE = 2 * 1024 * 1024;
const MIN_PREFETCH_CONCURRENCY = 2;
const MAX_PREFETCH_CONCURRENCY = 4;
const THROUGHPUT_WINDOW = 3;
const THROUGHPUT_MIBPS_FOR_4 = 2;
const THROUGHPUT_MIBPS_FOR_3 = 0.8;
const RANGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const debugClientIds = new Set();
const rangeCache = new Map();
let rangeCacheBytes = 0;

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "NYY_DEBUG_ENABLE" && event.source?.id) {
    debugClientIds.add(event.source.id);
    event.ports?.[0]?.postMessage({ ok: true });
  } else if (data.type === "NYY_DEBUG_DISABLE" && event.source?.id) {
    debugClientIds.delete(event.source.id);
    event.ports?.[0]?.postMessage({ ok: true });
  } else if (data.type === "REGISTER_VIRTUAL_FILE" && data.id && data.file) {
    const existingFile = files.get(data.id);
    const file = normalizeFile(data.file, data.id);
    if (existingFile && existingFile.cacheKey !== file.cacheKey) purgeRangeCache(existingFile.cacheKey);
    files.set(data.id, file);
    postDebug("sw", "register", {
      id: data.id,
      fileName: data.file.fileName,
      fileSize: data.file.fileSize,
      chunks: data.file.chunks?.length || 0,
    });
    event.ports?.[0]?.postMessage({ ok: true, id: data.id });
  } else if (data.type === "UNREGISTER_VIRTUAL_FILE" && data.id) {
    const file = files.get(data.id);
    if (file) purgeRangeCache(file.cacheKey);
    files.delete(data.id);
    postDebug("sw", "unregister", { id: data.id });
    event.ports?.[0]?.postMessage({ ok: true, id: data.id });
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith("/__nyy_virtual_media__/")) return;
  event.respondWith(handleVirtualMediaRequest(event.request, url));
});

function normalizeFile(file, id) {
  const chunks = [...(file.chunks || [])].sort((a, b) => a.index - b.index);
  let offset = 0;
  const fileSize = Number(file.fileSize || 0);
  return {
    fileName: file.fileName || "media.mp4",
    contentType: file.contentType || "video/mp4",
    fileSize,
    cacheKey: `${id}:${fileSize}:${chunks.map((chunk) => `${chunk.index}:${chunk.size}`).join(",")}`,
    chunks: chunks.map((chunk) => {
      const size = Number(chunk.size || 0);
      const item = {
        url: chunk.downloadUrl,
        start: offset,
        end: offset + size - 1,
        size,
      };
      offset += size;
      return item;
    }),
  };
}

function purgeRangeCache(cacheKey) {
  for (const [key, entry] of rangeCache) {
    if (entry.cacheKey !== cacheKey) continue;
    rangeCache.delete(key);
    rangeCacheBytes -= entry.bytes.byteLength;
  }
  rangeCacheBytes = Math.max(0, rangeCacheBytes);
}

function getRangeCacheEntry(cacheKey, start, end, shouldLog = true) {
  const entries = Array.from(rangeCache.entries()).reverse();
  for (const [key, entry] of entries) {
    if (entry.cacheKey !== cacheKey || entry.start > start || entry.end < start) continue;
    rangeCache.delete(key);
    rangeCache.set(key, entry);
    const sliceEnd = Math.min(entry.end, end);
    const bytes = entry.bytes.subarray(start - entry.start, sliceEnd - entry.start + 1);
    if (shouldLog) {
      postDebug("sw", "cache:hit", {
        cursorStart: start,
        cursorEnd: sliceEnd,
        bytes: bytes.byteLength,
        cacheBytes: rangeCacheBytes,
        entries: rangeCache.size,
      });
    }
    return { start, end: sliceEnd, bytes };
  }
  return null;
}

function putRangeCacheEntry(cacheKey, start, end, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength !== end - start + 1) return;
  const existingCover = getRangeCacheEntry(cacheKey, start, end, false);
  if (existingCover && existingCover.end >= end) return;
  const key = `${cacheKey}:${start}-${end}`;
  const existing = rangeCache.get(key);
  if (existing) {
    rangeCache.delete(key);
    rangeCacheBytes -= existing.bytes.byteLength;
  }
  rangeCache.set(key, { cacheKey, start, end, bytes });
  rangeCacheBytes += bytes.byteLength;
  while (rangeCacheBytes > RANGE_CACHE_MAX_BYTES && rangeCache.size > 0) {
    const [oldestKey, oldestEntry] = rangeCache.entries().next().value;
    rangeCache.delete(oldestKey);
    rangeCacheBytes -= oldestEntry.bytes.byteLength;
    postDebug("sw", "cache:evict", {
      cursorStart: oldestEntry.start,
      cursorEnd: oldestEntry.end,
      bytes: oldestEntry.bytes.byteLength,
      cacheBytes: Math.max(0, rangeCacheBytes),
      entries: rangeCache.size,
    });
  }
  postDebug("sw", "cache:store", {
    cursorStart: start,
    cursorEnd: end,
    bytes: bytes.byteLength,
    cacheBytes: Math.max(0, rangeCacheBytes),
    entries: rangeCache.size,
  });
}

function joinUint8Arrays(chunks, totalBytes) {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function makeCachedReader(bytes) {
  let sent = false;
  return {
    async read() {
      if (sent) return { done: true };
      sent = true;
      return { done: false, value: bytes };
    },
    async cancel() { sent = true; },
  };
}

function postDebug(scope, event, data) {
  if (debugClientIds.size === 0) return;
  self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (!debugClientIds.has(client.id)) continue;
      client.postMessage({
        type: "NYY_DEBUG_LOG",
        ts: Date.now(),
        scope,
        event,
        data,
      });
    }
  }).catch(() => {});
}

async function handleVirtualMediaRequest(request, url) {
  const id = decodeURIComponent(url.pathname.split("/")[2] || "");
  const file = files.get(id);
  if (!file) {
    return new Response("Virtual media file is not registered", { status: 404 });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const range = parseRange(request.headers.get("range"), file.fileSize);
  if (!range) {
    return new Response("Range header required", {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${file.fileSize}`,
      },
    });
  }

  const headers = {
    "Accept-Ranges": "bytes",
    "Content-Type": file.contentType,
    "Content-Length": String(range.end - range.start + 1),
    "Content-Range": `bytes ${range.start}-${range.end}/${file.fileSize}`,
    "Cache-Control": "no-store",
  };

  if (request.method === "HEAD") {
    return new Response(null, { status: 206, headers });
  }

  const body = makeRangeStream(file, range.start, range.end, request.signal);
  return new Response(body, { status: 206, headers });
}

function parseRange(header, fileSize) {
  if (!header) return { start: 0, end: Math.min(fileSize - 1, FETCH_SLICE_SIZE - 1) };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  let start;
  let end;
  if (match[1] === "" && match[2] !== "") {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, fileSize - suffix);
    end = fileSize - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? fileSize - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) return null;
  return { start, end: Math.min(end, fileSize - 1) };
}

function makeRangeStream(file, start, end, signal) {
  let cursor = start;
  let activeReader = null;
  let activeSliceMeta = null;
  let streamClosed = false;
  let desiredConcurrency = MAX_PREFETCH_CONCURRENCY;
  const readerQueue = []; // ordered promises resolving to { reader } or { done/error }
  const abortControllers = new Set();
  const recentThroughputsMibps = [];
  let sliceIndex = 0;

  function isAbortError(err) {
    return !!err && err.name === "AbortError";
  }

  function isClosedStreamError(err) {
    return err instanceof Error && /closed readable stream|already closed|stream is closed/i.test(err.message);
  }

  function markStreamClosed() {
    if (streamClosed) return;
    streamClosed = true;
    readerQueue.length = 0;
    for (const abortController of abortControllers) abortController.abort();
    abortControllers.clear();
    if (activeReader) activeReader.cancel().catch(() => {});
    activeSliceMeta?.cleanup?.();
    activeReader = null;
    activeSliceMeta = null;
  }

  function closeStream(controller) {
    markStreamClosed();
    try { controller.close(); } catch {}
  }

  function errorStream(controller, err) {
    markStreamClosed();
    try { controller.error(err); } catch {}
  }

  function releaseActiveReader() {
    activeSliceMeta?.cleanup?.();
    activeReader = null;
    activeSliceMeta = null;
  }

  function recalculateConcurrency() {
    if (recentThroughputsMibps.length === 0) return;
    const avgMibps = recentThroughputsMibps.reduce((sum, value) => sum + value, 0) / recentThroughputsMibps.length;
    const nextConcurrency = avgMibps >= THROUGHPUT_MIBPS_FOR_4
      ? 4
      : avgMibps >= THROUGHPUT_MIBPS_FOR_3
        ? 3
        : 2;
    desiredConcurrency = Math.max(MIN_PREFETCH_CONCURRENCY, Math.min(MAX_PREFETCH_CONCURRENCY, nextConcurrency));
  }

  function logConcurrency(reason) {
    postDebug("sw", "concurrency", {
      reason,
      desiredConcurrency,
      avgMibps: recentThroughputsMibps.length ? Number((recentThroughputsMibps.reduce((sum, value) => sum + value, 0) / recentThroughputsMibps.length).toFixed(2)) : null,
      inFlight: readerQueue.length + (activeReader ? 1 : 0),
    });
  }

  function recordSliceThroughput(sliceIndex, bytesRead, durationMs) {
    if (!Number.isFinite(bytesRead) || bytesRead <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
    const mibps = (bytesRead / durationMs) * 1000 / (1024 * 1024);
    recentThroughputsMibps.push(mibps);
    if (recentThroughputsMibps.length > THROUGHPUT_WINDOW) {
      recentThroughputsMibps.shift();
    }
    const previousConcurrency = desiredConcurrency;
    recalculateConcurrency();
    postDebug("sw", "slice:done", {
      sliceIndex,
      bytesRead,
      durationMs: Math.round(durationMs),
      mibps: Number(mibps.toFixed(2)),
      previousConcurrency,
      desiredConcurrency,
    });
    logConcurrency("throughput-update");
  }

  function nextReader() {
    if (streamClosed) return null;
    if (cursor > end) return null;
    if (signal && signal.aborted) return null;
    const cached = getRangeCacheEntry(file.cacheKey, cursor, end);
    if (cached) {
      const currentSliceIndex = sliceIndex++;
      cursor = cached.end + 1;
      return Promise.resolve({
        reader: makeCachedReader(cached.bytes),
        startedAt: performance.now(),
        plannedBytes: cached.bytes.byteLength,
        sliceIndex: currentSliceIndex,
        cursorStart: cached.start,
        cursorEnd: cached.end,
        cached: true,
      });
    }
    const chunk = file.chunks.find((item) => item.start <= cursor && item.end >= cursor);
    if (!chunk) {
      cursor = end + 1;
      postDebug("sw", "range:error", { start, end, cursor, reason: "no-backing-chunk" });
      return Promise.resolve({ error: new Error(`No backing chunk for offset ${cursor}`) });
    }
    const sliceSize = cursor === start ? FIRST_FETCH_SLICE_SIZE : FETCH_SLICE_SIZE;
    const globalEnd = Math.min(end, chunk.end, cursor + sliceSize - 1);
    const localStart = cursor - chunk.start;
    const localEnd = globalEnd - chunk.start;
    const globalStart = cursor;
    const startedAt = performance.now();
    const plannedBytes = globalEnd - cursor + 1;
    const currentSliceIndex = sliceIndex++;
    cursor = globalEnd + 1;

    postDebug("sw", "slice:start", {
      sliceIndex: currentSliceIndex,
      cursorStart: globalStart,
      cursorEnd: globalEnd,
      plannedBytes,
      localStart,
      localEnd,
      sliceSize,
      desiredConcurrency,
    });

    const abortController = new AbortController();
    abortControllers.add(abortController);
    const abortFromRequest = () => abortController.abort();
    if (signal) {
      if (signal.aborted) abortController.abort();
      else signal.addEventListener("abort", abortFromRequest, { once: true });
    }
    const cleanup = () => {
      abortControllers.delete(abortController);
      if (signal) signal.removeEventListener("abort", abortFromRequest);
    };

    return fetch(chunk.url, {
      headers: { Range: `bytes=${localStart}-${localEnd}` },
      mode: "cors",
      signal: abortController.signal,
    }).then((resp) => {
      if (!resp.ok && resp.status !== 206) {
        postDebug("sw", "slice:response-error", { sliceIndex: currentSliceIndex, status: resp.status });
        cleanup();
        return { error: new Error(`Backing chunk fetch failed: HTTP ${resp.status}`) };
      }
      if (!resp.body) {
        postDebug("sw", "slice:response-error", { sliceIndex: currentSliceIndex, reason: "no-body" });
        cleanup();
        return { error: new Error("Backing chunk fetch has no body") };
      }
      if (streamClosed || (signal && signal.aborted)) {
        resp.body.cancel().catch(() => {});
        cleanup();
        return { done: true };
      }
      postDebug("sw", "slice:response", { sliceIndex: currentSliceIndex, status: resp.status });
      return {
        reader: resp.body.getReader(),
        startedAt,
        plannedBytes,
        sliceIndex: currentSliceIndex,
        cursorStart: globalStart,
        cursorEnd: globalEnd,
        cached: false,
        cleanup,
      };
    }).catch((err) => {
      cleanup();
      if (isAbortError(err)) return { done: true };
      return { error: err };
    });
  }

  function fillQueue() {
    if (streamClosed) return;
    while ((readerQueue.length + (activeReader ? 1 : 0)) < desiredConcurrency) {
      const p = nextReader();
      if (!p) break;
      readerQueue.push(p);
    }
    logConcurrency("fillQueue");
  }

  fillQueue();

  return new ReadableStream({
    async pull(controller) {
      // Loop until we enqueue a chunk or close/error
      while (true) {
        if (streamClosed) return;
        if (signal && signal.aborted) { closeStream(controller); return; }

        if (!activeReader) {
          if (readerQueue.length === 0) { closeStream(controller); return; }
          const slotPromise = readerQueue.shift();
          const slot = await slotPromise;
          if (streamClosed) {
            if (slot?.reader) slot.reader.cancel().catch(() => {});
            slot?.cleanup?.();
            return;
          }
          if (signal && signal.aborted) {
            if (slot?.reader) slot.reader.cancel().catch(() => {});
            slot?.cleanup?.();
            closeStream(controller);
            return;
          }
          if (slot.done) { closeStream(controller); return; }
          if (slot.error) { errorStream(controller, slot.error); return; }
          activeReader = slot.reader;
          activeSliceMeta = {
            startedAt: slot.startedAt,
            plannedBytes: slot.plannedBytes,
            sliceIndex: slot.sliceIndex,
            cursorStart: slot.cursorStart,
            cursorEnd: slot.cursorEnd,
            cached: !!slot.cached,
            cacheChunks: [],
            bytesRead: 0,
            firstChunkLogged: false,
            cleanup: slot.cleanup,
          };
          fillQueue();
          postDebug("sw", "slice:reader-open", {
            plannedBytes: slot.plannedBytes,
            desiredConcurrency,
            queueDepth: readerQueue.length,
          });
        }

        try {
          const { done, value } = await activeReader.read();
          if (streamClosed) return;
          if (signal && signal.aborted) { closeStream(controller); return; }
          if (done) {
            if (activeSliceMeta) {
              if (!activeSliceMeta.cached && activeSliceMeta.bytesRead > 0) {
                if (activeSliceMeta.bytesRead === activeSliceMeta.plannedBytes) {
                  putRangeCacheEntry(
                    file.cacheKey,
                    activeSliceMeta.cursorStart,
                    activeSliceMeta.cursorEnd,
                    joinUint8Arrays(activeSliceMeta.cacheChunks, activeSliceMeta.bytesRead),
                  );
                }
                recordSliceThroughput(activeSliceMeta.sliceIndex, activeSliceMeta.bytesRead, performance.now() - activeSliceMeta.startedAt);
              }
            }
            releaseActiveReader();
            fillQueue();
            postDebug("sw", "slice:stream-done", { desiredConcurrency, queueDepth: readerQueue.length });
            continue; // move to next reader in queue
          }
          try {
            controller.enqueue(value);
          } catch (err) {
            if (isClosedStreamError(err)) { markStreamClosed(); return; }
            throw err;
          }
          if (activeSliceMeta && !activeSliceMeta.cached) {
            activeSliceMeta.cacheChunks.push(value);
            activeSliceMeta.bytesRead += value.byteLength;
          }
          if (activeSliceMeta && !activeSliceMeta.firstChunkLogged) {
            activeSliceMeta.firstChunkLogged = true;
            postDebug("sw", "slice:first-chunk", {
              sliceIndex: activeSliceMeta.sliceIndex,
              bytes: value.byteLength,
              firstChunkMs: Math.round(performance.now() - activeSliceMeta.startedAt),
              desiredConcurrency,
            });
          }
          return;
        } catch (err) {
          releaseActiveReader();
          if (streamClosed) { markStreamClosed(); return; }
          if (isAbortError(err) || isClosedStreamError(err)) { closeStream(controller); return; }
          postDebug("sw", "slice:error", { error: err instanceof Error ? err.message : String(err) });
          errorStream(controller, err);
          return;
        }
      }
    },
    cancel() {
      markStreamClosed();
      postDebug("sw", "stream:cancel", { desiredConcurrency });
    },
  });
}
