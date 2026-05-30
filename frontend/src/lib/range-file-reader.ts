import type { ShareFileDownload } from "./api";

interface VirtualChunk {
  url: string;
  start: number;
  end: number;
  size: number;
}

export class RangeFileReader {
  private chunks: VirtualChunk[];
  readonly totalSize: number;

  constructor(file: ShareFileDownload) {
    if (file.is_chunked) {
      let offset = 0;
      this.chunks = [...file.chunks].sort((a, b) => a.index - b.index).map((chunk) => {
        const size = Number(chunk.size || 0);
        const item = {
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
      this.chunks = [{ url: file.download_url, start: 0, end: file.file_size - 1, size: file.file_size }];
      this.totalSize = file.file_size;
    }
  }

  async read(start: number, end: number, signal?: AbortSignal): Promise<ArrayBuffer> {
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
      const resp = await fetch(chunk.url, {
        headers: { Range: `bytes=${localStart}-${localEnd - 1}` },
        signal,
      });
      if (!resp.ok && resp.status !== 206) throw new Error(`Range fetch failed: HTTP ${resp.status}`);
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
  }

  readFirstBytes(bytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.read(0, Math.min(bytes, this.totalSize), signal);
  }
}
