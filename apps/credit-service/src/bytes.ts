const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)));
}

/** Both directions run through the platform streams so memory stays flat and no Node-only API is needed. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class SizeLimitError extends Error {
  public constructor() {
    super("credit_service_size_limit");
    this.name = "SizeLimitError";
  }
}

/** Decompresses at most `limit` bytes; a longer stream is a limit error, not a truncation. */
export async function gunzip(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  limit: number,
): Promise<Uint8Array> {
  const reader = body.pipeThrough(new DecompressionStream("gzip")).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new SizeLimitError();
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const textOf = (bytes: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The body of a stored object as a stream, for the gunzip helper. */
export const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> =>
  new Blob([bytes as BlobPart]).stream();
