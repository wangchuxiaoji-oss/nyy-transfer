// MKV Video Decode Worker
// Receives encoded video chunks from main thread, decodes them via VideoDecoder,
// and renders frames to a transferred OffscreenCanvas using media time from main thread.

/** @type {OffscreenCanvas | null} */
let canvas = null;
/** @type {OffscreenCanvasRenderingContext2D | null} */
let ctx = null;
/** @type {VideoDecoder | null} */
let decoder = null;
/** @type {Array<VideoFrame>} */
let frameQueue = [];
/** @type {number} */
let renderedFrames = 0;
/** @type {number} */
let consumedFrames = 0;
/** @type {number | null} */
let rafId = null;
/** @type {number} */
let currentMediaTimeUs = 0;
/** @type {number} */
let lastMediaTimeUs = 0;
/** @type {number} */
let firstTimestampUs = -1;
/** @type {boolean} */
let decodeDone = false;
/** @type {boolean} */
let renderPending = false;
/** @type {number} - last time we received a "time" message (perf.now ms) */
let lastTimeMessageAt = 0;
/**
 * Max microseconds the clock can jump in a single tick.
 * If the gap is larger (e.g. page was hidden), we clamp to this so playback
 * resumes smoothly from where it paused instead of fast-forwarding.
 */
const MAX_CLOCK_JUMP_US = 200_000; // 200ms = ~12 frames at 60fps
/**
 * Max frames to skip per tick. Prevents bulk frame-close which looks like
 * flickering / artifacts on motion areas.
 */
const MAX_SKIP_PER_TICK = 2;

// Use setInterval as fallback since requestAnimationFrame may not work in all Worker contexts
const useRAF = typeof requestAnimationFrame === 'function';

function startTicking() {
  if (useRAF) {
    rafId = requestAnimationFrame(tick);
  } else {
    // ~60fps via setInterval
    rafId = setInterval(tick, 16);
  }
}

function stopTicking() {
  if (rafId !== null) {
    if (useRAF) {
      cancelAnimationFrame(rafId);
    } else {
      clearInterval(rafId);
    }
    rafId = null;
  }
}

function tick() {
  if (!renderPending && frameQueue.length > 0) {
    if (firstTimestampUs < 0) {
      firstTimestampUs = frameQueue[0].timestamp;
    }
    const targetUs = currentMediaTimeUs;

    // Skip at most MAX_SKIP_PER_TICK frames per tick to avoid bulk-close
    // that causes visual jumps on motion areas
    let skippedFrames = 0;
    while (
      frameQueue.length > 1 &&
      frameQueue[1].timestamp <= targetUs &&
      skippedFrames < MAX_SKIP_PER_TICK
    ) {
      const skipped = frameQueue.shift();
      try { skipped.close(); } catch (e) {}
      consumedFrames++;
      skippedFrames++;
    }
    if (skippedFrames > 0) {
      self.postMessage({
        type: "progress",
        renderedFrames,
        consumedFrames,
        skippedFrames,
        queuedFrames: frameQueue.length,
        decodeQueueSize: decoder?.decodeQueueSize ?? 0,
      });
    }

    const frame = frameQueue[0];
    if (frame && frame.timestamp <= targetUs && canvas && ctx) {
      renderPending = true;
      const w = frame.displayWidth || frame.codedWidth;
      const h = frame.displayHeight || frame.codedHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        ctx = canvas.getContext("2d");
      }
      createImageBitmap(frame)
        .then((bitmap) => {
          try {
            if (ctx) {
              ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            }
          } finally {
            bitmap.close();
          }
          frameQueue.shift();
          try { frame.close(); } catch (e) {}
          renderedFrames++;
          consumedFrames++;
          self.postMessage({
            type: "rendered",
            renderedFrames,
            consumedFrames,
            queuedFrames: frameQueue.length,
            decodeQueueSize: decoder?.decodeQueueSize ?? 0,
            frameTimestampUs: frame.timestamp,
            mediaTimeUs: targetUs,
            driftMs: (targetUs - frame.timestamp) / 1000,
          });
        })
        .catch((bitmapErr) => {
          self.postMessage({ type: "error", error: "createImageBitmap/drawImage: " + (bitmapErr.message || String(bitmapErr)) });
          frameQueue.shift();
          try { frame.close(); } catch (e) {}
          consumedFrames++;
        })
        .finally(() => {
          renderPending = false;
        });
    }
  }

  if (decodeDone && frameQueue.length === 0) {
    self.postMessage({ type: "done", renderedFrames, consumedFrames });
    stopTicking();
    return;
  }
  if (useRAF) rafId = requestAnimationFrame(tick);
}

self.onmessage = function (e) {
  const msg = e.data;
  switch (msg.type) {
    case "support": {
      self.postMessage({
        type: "support",
        supported: typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined" && typeof OffscreenCanvas !== "undefined",
        hasRAF: useRAF,
      });
      break;
    }
    case "init": {
      canvas = msg.canvas;
      ctx = canvas.getContext("2d");
      if (!ctx) {
        self.postMessage({ type: "error", error: "Cannot get 2d context from OffscreenCanvas" });
        return;
      }
      // Configure decoder
      decoder = new VideoDecoder({
        output(frame) {
          insertFrameByTimestamp(frameQueue, frame);
        },
        error(err) {
          self.postMessage({ type: "error", error: "decoder: " + (err.message || String(err)) });
        },
      });
      try {
        decoder.configure(msg.config);
      } catch (configErr) {
        self.postMessage({ type: "error", error: "configure failed: " + (configErr.message || String(configErr)) });
        return;
      }
      self.postMessage({ type: "ready", hasRAF: useRAF });
      // Start render loop
      startTicking();
      break;
    }
    case "decode": {
      if (!decoder || decoder.state !== "configured") {
        return;
      }
      try {
        const chunk = new EncodedVideoChunk({
          type: msg.keyframe ? "key" : "delta",
          timestamp: msg.timestamp,
          duration: msg.duration || undefined,
          data: msg.data,
        });
        decoder.decode(chunk);
      } catch (decErr) {
        self.postMessage({ type: "error", error: "decode: " + (decErr.message || String(decErr)) });
      }
      break;
    }
    case "time": {
      const now = performance.now();
      const newTimeUs = msg.mediaTimeUs;
      // Detect large clock jumps (page was hidden/minimized) and clamp
      if (lastTimeMessageAt > 0 && currentMediaTimeUs > 0) {
        const wallGapMs = now - lastTimeMessageAt;
        const clockJumpUs = newTimeUs - currentMediaTimeUs;
        // If wall-clock gap > 500ms AND clock jumped more than MAX_CLOCK_JUMP_US,
        // the page was likely hidden. Clamp the jump.
        if (wallGapMs > 500 && clockJumpUs > MAX_CLOCK_JUMP_US) {
          currentMediaTimeUs = currentMediaTimeUs + MAX_CLOCK_JUMP_US;
          lastTimeMessageAt = now;
          break;
        }
      }
      currentMediaTimeUs = newTimeUs;
      lastTimeMessageAt = now;
      break;
    }
    case "flush": {
      if (decoder && decoder.state === "configured") {
        decoder.flush().then(() => {
          decodeDone = true;
          self.postMessage({ type: "flushed" });
        }).catch((err) => {
          decodeDone = true;
          self.postMessage({ type: "flushed" });
        });
      } else {
        decodeDone = true;
        self.postMessage({ type: "flushed" });
      }
      break;
    }
    case "stop": {
      stopTicking();
      if (decoder) { try { decoder.close(); } catch (ex) {} }
      decoder = null;
      for (const f of frameQueue) { try { f.close(); } catch (ex) {} }
      frameQueue = [];
      renderedFrames = 0;
      consumedFrames = 0;
      decodeDone = false;
      firstTimestampUs = -1;
      lastTimeMessageAt = 0;
      currentMediaTimeUs = 0;
      self.postMessage({ type: "stopped" });
      break;
    }
  }
};

function insertFrameByTimestamp(queue, frame) {
  let index = queue.length;
  while (index > 0 && queue[index - 1].timestamp > frame.timestamp) index--;
  queue.splice(index, 0, frame);
}
