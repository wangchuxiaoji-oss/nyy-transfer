const files = new Map();
const FETCH_SLICE_SIZE = 2 * 1024 * 1024;
const debugClientIds = new Set();

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
    files.set(data.id, normalizeFile(data.file));
    postDebug("sw", "register", { id: data.id, fileName: data.file.fileName, fileSize: data.file.fileSize, chunks: data.file.chunks?.length || 0 });
    event.ports?.[0]?.postMessage({ ok: true, id: data.id });
  } else if (data.type === "UNREGISTER_VIRTUAL_FILE" && data.id) {
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

function normalizeFile(file) {
  const chunks = [...(file.chunks || [])].sort((a, b) => a.index - b.index);
  let offset = 0;
  return {
    fileName: file.fileName || "media.mp4",
    contentType: file.contentType || "video/mp4",
    fileSize: Number(file.fileSize || 0),
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

function postDebug(scope, event, data) {
  if (debugClientIds.size === 0) return;
  self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if (!debugClientIds.has(client.id)) continue;
      client.postMessage({ type: "NYY_DEBUG_LOG", ts: Date.now(), scope, event, data });
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

  postDebug("sw", "range:start", { url: url.pathname, start: range.start, end: range.end, fileSize: file.fileSize });
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

function isAbortError(err) {
  return !!err && err.name === "AbortError";
}

function isClosedStreamError(err) {
  return err instanceof Error && /closed readable stream|already closed|stream is closed/i.test(err.message);
}

function makeRangeStream(file, start, end, signal) {
  let cursor = start;
  let streamClosed = false;
  let activeAbortController = null;

  function markStreamClosed() {
    if (streamClosed) return;
    streamClosed = true;
    activeAbortController?.abort();
    activeAbortController = null;
  }

  function closeStream(controller) {
    markStreamClosed();
    try { controller.close(); } catch {}
  }

  function errorStream(controller, err) {
    markStreamClosed();
    try { controller.error(err); } catch {}
  }

  return new ReadableStream({
    async pull(controller) {
      if (streamClosed) return;
      if (cursor > end) { closeStream(controller); return; }
      if (signal && signal.aborted) { closeStream(controller); return; }
      const chunk = file.chunks.find((item) => item.start <= cursor && item.end >= cursor);
      if (!chunk) {
        postDebug("sw", "range:error", { start, end, cursor, reason: "no-backing-chunk" });
        errorStream(controller, new Error(`No backing chunk for offset ${cursor}`));
        return;
      }
      const globalEnd = Math.min(end, chunk.end, cursor + FETCH_SLICE_SIZE - 1);
      const localStart = cursor - chunk.start;
      const localEnd = globalEnd - chunk.start;
      const startedAt = performance.now();
      postDebug("sw", "slice:start", { cursorStart: cursor, cursorEnd: globalEnd, localStart, localEnd, sliceSize: globalEnd - cursor + 1 });
      const abortController = new AbortController();
      activeAbortController = abortController;
      const abortFromRequest = () => abortController.abort();
      if (signal) {
        if (signal.aborted) abortController.abort();
        else signal.addEventListener("abort", abortFromRequest, { once: true });
      }
      try {
        const resp = await fetch(chunk.url, {
          headers: { Range: `bytes=${localStart}-${localEnd}` },
          mode: "cors",
          signal: abortController.signal,
        });
        if (streamClosed) return;
        if (signal && signal.aborted) { closeStream(controller); return; }
        if (!resp.ok && resp.status !== 206) {
          postDebug("sw", "slice:response-error", { status: resp.status });
          errorStream(controller, new Error(`Backing chunk fetch failed: HTTP ${resp.status}`));
          return;
        }
        postDebug("sw", "slice:response", { status: resp.status });
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (streamClosed) return;
        if (signal && signal.aborted) { closeStream(controller); return; }
        try {
          controller.enqueue(bytes);
        } catch (err) {
          if (isClosedStreamError(err)) { markStreamClosed(); return; }
          throw err;
        }
        postDebug("sw", "slice:done", { bytes: bytes.byteLength, durationMs: Math.round(performance.now() - startedAt) });
        cursor = globalEnd + 1;
      } catch (err) {
        if (isAbortError(err) || isClosedStreamError(err)) {
          postDebug("sw", "stream:abort", { cursor });
          closeStream(controller);
        } else {
          postDebug("sw", "slice:error", { error: err instanceof Error ? err.message : String(err) });
          errorStream(controller, err);
        }
      } finally {
        if (activeAbortController === abortController) activeAbortController = null;
        if (signal) signal.removeEventListener("abort", abortFromRequest);
      }
    },
    cancel() { markStreamClosed(); postDebug("sw", "stream:cancel", {}); },
  });
}
