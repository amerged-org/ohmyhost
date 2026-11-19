import { CustomerRuntimeGatewayError } from "./errors.js";
import { exactRecord, invalidResponse } from "./http.js";

export type StorageReadResult =
  | Readonly<{ state: "not_found"; objectKey: string }>
  | Readonly<{
      state: "found";
      objectKey: string;
      contentType: string;
      contentLength: number;
      etag: string;
      body: ReadableStream<Uint8Array>;
    }>;
export type StorageDeleteResult =
  | Readonly<{ state: "completed"; objectKey: string; deletionId: string }>
  | Readonly<{ state: "pending"; objectKey: string; retryAt: string }>
  | Readonly<{
      state: "failed";
      objectKey: string;
      code: "object_not_found" | "storage_gateway_unavailable";
      retryable: boolean;
    }>;
export const STORAGE_BATCH_CONTENT_TYPE = "application/vnd.ohmyhost.storage-batch.v1";
const MAX_CONTROL_BYTES = 4 * 1024 * 1024;
const MAX_HEADER_BYTES = 2048;

/** Pending reads are bounded; errors never expose provider text. */
async function timedRead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMilliseconds: number,
  status: number,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    if (signal?.aborted) {
      void reader.cancel().catch(() => undefined);
      throw new CustomerRuntimeGatewayError("gateway_timeout", status, true);
    }
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        const abort = () => {
          reject(new CustomerRuntimeGatewayError("gateway_timeout", status, true));
          void reader.cancel().catch(() => undefined);
        };
        timer = setTimeout(abort, timeoutMilliseconds);
        if (signal !== undefined) {
          abortListener = abort;
          signal.addEventListener("abort", abortListener, { once: true });
        }
      }),
    ]);
  } catch (error) {
    if (error instanceof CustomerRuntimeGatewayError) throw error;
    if (signal?.aborted) throw new CustomerRuntimeGatewayError("gateway_timeout", status, true);
    throw new CustomerRuntimeGatewayError("gateway_unavailable", status, true);
  } finally {
    clearTimeout(timer);
    if (abortListener !== undefined) signal?.removeEventListener("abort", abortListener);
  }
}

/** Yields one bounded body at a time; completion requires the final frame and exact EOF. */
export function decodeStorageBatch(
  response: Response,
  keys: readonly string[],
  timeoutMilliseconds: number,
): AsyncIterable<StorageReadResult> {
  if (
    response.headers.get("content-type") !== STORAGE_BATCH_CONTENT_TYPE ||
    response.body === null
  ) {
    void response.body?.cancel().catch(() => undefined);
    invalidResponse(response.status);
  }
  const source = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer: Uint8Array = new Uint8Array();
  let offset = 0;
  let controlBytes = 0;
  let started = false;
  let finished = false;
  let cancelled = false;
  let released = false;
  let activeBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  function cancellationError() {
    return new CustomerRuntimeGatewayError(
      "gateway_request_invalid",
      null,
      false,
      "this storage read was cancelled; start another readMany() to read more objects",
    );
  }
  function closeSource() {
    if (released) return;
    released = true;
    if (!finished) void source.cancel().catch(() => undefined);
    source.releaseLock();
  }
  async function chunk(maximum: number): Promise<Uint8Array> {
    if (cancelled) throw cancellationError();
    while (offset === buffer.byteLength) {
      const next = await timedRead(source, timeoutMilliseconds, response.status);
      if (cancelled) throw cancellationError();
      if (next.done || !(next.value instanceof Uint8Array)) invalidResponse(response.status);
      buffer = next.value;
      offset = 0;
    }
    const length = Math.min(maximum, buffer.byteLength - offset);
    const bytes = buffer.subarray(offset, offset + length);
    offset += length;
    return bytes;
  }
  async function exactBytes(length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const next = await chunk(length - written);
      bytes.set(next, written);
      written += next.byteLength;
    }
    return bytes;
  }
  async function header(): Promise<unknown> {
    const length = new DataView((await exactBytes(4)).buffer).getUint32(0);
    controlBytes += 4 + length;
    if (length < 1 || length > MAX_HEADER_BYTES || controlBytes > MAX_CONTROL_BYTES)
      invalidResponse(response.status);
    const bytes = await exactBytes(length);
    return parseHeader(bytes);
  }
  function bufferedHeader(): unknown {
    if (cancelled) throw cancellationError();
    if (buffer.byteLength - offset < 4) return undefined;
    const length = new DataView(buffer.buffer, buffer.byteOffset + offset, 4).getUint32(0);
    if (length < 1 || length > MAX_HEADER_BYTES || controlBytes + 4 + length > MAX_CONTROL_BYTES)
      invalidResponse(response.status);
    if (buffer.byteLength - offset < 4 + length) return undefined;
    controlBytes += 4 + length;
    const bytes = buffer.subarray(offset + 4, offset + 4 + length);
    offset += 4 + length;
    return parseHeader(bytes);
  }
  function parseHeader(bytes: Uint8Array): unknown {
    try {
      return JSON.parse(decoder.decode(bytes)) as unknown;
    } catch {
      return invalidResponse(response.status);
    }
  }
  const iterator = iterate();
  // Returning an unstarted async generator skips its finally block.
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => (cancelled ? Promise.reject(cancellationError()) : iterator.next()),
        async return() {
          cancelled = true;
          activeBody?.error(cancellationError());
          activeBody = undefined;
          closeSource();
          if (!started) return { done: true as const, value: undefined };
          return iterator.return(undefined);
        },
      };
    },
  };
  async function* iterate(): AsyncGenerator<StorageReadResult, void, unknown> {
    started = true;
    let currentConsumed = true;
    let bodyFailure: unknown;
    try {
      for (let index = 0; index < keys.length; index++) {
        const objectKey = keys[index];
        if (objectKey === undefined) invalidResponse(response.status);
        if (!currentConsumed)
          throw new CustomerRuntimeGatewayError(
            "gateway_request_invalid",
            null,
            false,
            "consume or cancel each object's body before reading the next object",
          );
        if (bodyFailure !== undefined) throw bodyFailure;
        const buffered = bufferedHeader();
        const value = buffered === undefined ? await header() : buffered;
        const candidate = value as Record<string, unknown>;
        const record = exactRecord(
          value,
          candidate?.["state"] === "found"
            ? ["index", "objectKey", "state", "contentType", "contentLength", "etag"]
            : ["index", "objectKey", "state"],
          response.status,
        );
        if (record["index"] !== index || record["objectKey"] !== keys[index])
          invalidResponse(response.status);
        if (record["state"] === "not_found") {
          yield Object.freeze({ state: "not_found", objectKey });
          continue;
        }
        if (
          record["state"] !== "found" ||
          typeof record["contentType"] !== "string" ||
          !/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u.test(
            record["contentType"],
          ) ||
          !Number.isSafeInteger(record["contentLength"]) ||
          Number(record["contentLength"]) < 0 ||
          Number(record["contentLength"]) > 1_073_741_824 ||
          typeof record["etag"] !== "string" ||
          !/^[0-9a-f]{32}(?:-[1-9][0-9]{0,4})?$/u.test(record["etag"])
        )
          invalidResponse(response.status);
        let remaining = Number(record["contentLength"]);
        currentConsumed = remaining === 0;
        // This body's source reads run one at a time: a cancel waits for the pull in flight, so two drains never share
        // the one source reader and its buffer.
        let bodyCancelled = false;
        let sourceRead: Promise<void> = Promise.resolve();
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              if (remaining === 0) controller.close();
              else activeBody = controller;
            },
            pull(controller) {
              sourceRead = sourceRead.then(async () => {
                // A cancel that started first drains what remains, so this read neither enqueues nor fails the batch.
                if (bodyCancelled) return;
                try {
                  const bytes = await chunk(remaining);
                  remaining -= bytes.byteLength;
                  if (bodyCancelled) return;
                  controller.enqueue(bytes);
                  if (remaining === 0) {
                    currentConsumed = true;
                    activeBody = undefined;
                    controller.close();
                  }
                } catch (error) {
                  // A read that fails under a cancel still fails the batch, and its source is released, so the
                  // cancel never reads a timed-out source again.
                  if (bodyCancelled) {
                    bodyFailure = error;
                    closeSource();
                    return;
                  }
                  bodyFailure = error;
                  currentConsumed = true;
                  activeBody = undefined;
                  controller.error(error);
                  closeSource();
                }
              });
              return sourceRead;
            },
            async cancel() {
              bodyCancelled = true;
              activeBody = undefined;
              await sourceRead;
              try {
                // A source that already failed is not read again: its failure is the one this body reports.
                if (bodyFailure !== undefined) throw bodyFailure;
                while (remaining > 0) {
                  const bytes = await chunk(remaining);
                  remaining -= bytes.byteLength;
                }
                currentConsumed = true;
              } catch (error) {
                bodyFailure = error;
                currentConsumed = true;
                closeSource();
                throw error;
              }
            },
          },
          { highWaterMark: 0 },
        );
        yield Object.freeze({
          state: "found",
          objectKey,
          contentType: record["contentType"],
          contentLength: Number(record["contentLength"]),
          etag: record["etag"],
          body,
        });
      }
      if (!currentConsumed)
        throw new CustomerRuntimeGatewayError(
          "gateway_request_invalid",
          null,
          false,
          "consume or cancel the last object's body before completing the read",
        );
      if (bodyFailure !== undefined) throw bodyFailure;
      const buffered = bufferedHeader();
      const terminal = exactRecord(
        buffered === undefined ? await header() : buffered,
        ["state", "count"],
        response.status,
      );
      if (
        terminal["state"] !== "completed" ||
        terminal["count"] !== keys.length ||
        offset !== buffer.byteLength
      )
        invalidResponse(response.status);
      const end = await timedRead(source, timeoutMilliseconds, response.status);
      if (!end.done) invalidResponse(response.status);
      if (cancelled) throw cancellationError();
      finished = true;
    } finally {
      activeBody?.error(bodyFailure ?? cancellationError());
      activeBody = undefined;
      closeSource();
    }
  }
}

/** Control JSON has its own four-MiB budget and never buffers object payloads. */
export async function readStorageBatchJson(
  response: Response,
  timeoutMilliseconds: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json" ||
    (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_CONTROL_BYTES)) ||
    response.body === null
  ) {
    void response.body?.cancel().catch(() => undefined);
    invalidResponse(response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  try {
    for (;;) {
      const next = await timedRead(reader, timeoutMilliseconds, response.status, signal);
      if (next.done) {
        finished = true;
        break;
      }
      if (!(next.value instanceof Uint8Array)) invalidResponse(response.status);
      length += next.value.byteLength;
      if (length > MAX_CONTROL_BYTES) invalidResponse(response.status);
      chunks.push(next.value);
    }
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return invalidResponse(response.status);
  }
}
