import CRC32 from "crc-32";

/**
 * 计算文件的 CRC32（hex string），流式读取避免内存爆炸。
 * 返回 8 位小写 hex，如 "dc044986"。
 */
export async function computeCRC32(file: File): Promise<string> {
  const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunks
  let crc = 0;
  let offset = 0;

  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    crc = CRC32.buf(bytes, crc);
    offset += CHUNK_SIZE;
  }

  // Convert to unsigned 32-bit hex
  return (crc >>> 0).toString(16).padStart(8, "0");
}
