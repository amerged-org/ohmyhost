const MAX_BODY_BYTES = 16 * 1024;
const MAX_URL_BYTES = 8 * 1024;
const MAX_COOKIE_BYTES = 16 * 1024;

function failure(status: number, code: string): Response {
  return Response.json(
    { error: code },
    { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } },
  );
}

/** Bound browser-controlled bytes before a DO acquisition or PostgreSQL wake. */
export async function boundNativeRequest(
  request: Request,
  signal: AbortSignal,
): Promise<Request | Response> {
  const encoder = new TextEncoder();
  if (
    encoder.encode(request.url).byteLength > MAX_URL_BYTES ||
    encoder.encode(request.headers.get("cookie") ?? "").byteLength > MAX_COOKIE_BYTES
  )
    return failure(413, "auth_request_too_large");
  if (request.method !== "POST") return request;
  if (!/^application\/json(?:\s*;|\s*$)/iu.test(request.headers.get("content-type") ?? ""))
    return failure(415, "auth_unsupported_content_type");
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^\d+$/u.test(declared)) return failure(400, "auth_invalid_request");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES)
    return failure(413, "auth_request_too_large");
  if (!request.body) return failure(400, "auth_invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("auth_unavailable");
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_BODY_BYTES) {
        cancel();
        return failure(413, "auth_request_too_large");
      }
      chunks.push(item.value);
    }
    if (signal.aborted) throw new Error("auth_unavailable");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return failure(400, "auth_invalid_request");
    } catch {
      return failure(400, "auth_invalid_request");
    }
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    return new Request(request.url, {
      method: request.method,
      headers,
      body: bytes,
      redirect: "manual",
    });
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
