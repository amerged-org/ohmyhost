import type { UsageArchiveBucket } from "./usage-archive.js";

export interface GrowthUsageBucket extends UsageArchiveBucket {
  get(key: string): Promise<{
    size: number;
    body: ReadableStream<Uint8Array>;
  } | null>;
}

/** Bound reads before allocation and while streaming, including corrupt oversized objects. */
export async function readUsageArchive(
  bucket: GrowthUsageBucket,
  key: string,
  maxBytes: number,
): Promise<string | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > maxBytes) {
    await object.body.cancel();
    return null;
  }
  const reader = object.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(next.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* The read result remains bounded. */
    }
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
