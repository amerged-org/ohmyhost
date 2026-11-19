import type { StorageObjectAccess } from "@ohmyhost/database";
import { projectR2BucketTarget } from "@ohmyhost/provider-cloudflare";

export const STORAGE_BATCH_CONTENT_TYPE = "application/vnd.ohmyhost.storage-batch.v1";
// A found body that sends no chunk for this long is cancelled, so one stalled object cannot hold the batch open.
const STORAGE_BODY_IDLE_MILLISECONDS = 10_000;
/** Reads the next chunk of a found body, cancelling the body when it stays silent past the idle bound. */
async function readNextChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("storage_batch_body_idle")),
      STORAGE_BODY_IDLE_MILLISECONDS,
    );
  });
  try {
    return await Promise.race([reader.read(), idle]);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function frame(header: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(header));
  if (json.byteLength > 2048) throw new Error("storage_batch_contract_invalid");
  const bytes = new Uint8Array(4 + json.byteLength);
  new DataView(bytes.buffer).setUint32(0, json.byteLength);
  bytes.set(json, 4);
  return bytes;
}
export function streamStorageBatch(input: {
  projectId: string;
  objectKeys: readonly string[];
  objects: readonly (StorageObjectAccess | null)[];
  readObject: (input: unknown) => Promise<
    | { state: "absent"; objectKey: string }
    | {
        state: "found";
        objectKey: string;
        contentType: string;
        contentLength: number;
        etag: string;
        body: ReadableStream<Uint8Array>;
      }
  >;
}): ReadableStream<Uint8Array> {
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const iterator = generate();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        if (activeReader !== null) await activeReader.cancel(reason);
      } finally {
        await iterator.return(undefined);
      }
    },
  });
  async function* generate(): AsyncGenerator<Uint8Array, void, unknown> {
    const metadata = new Uint8Array(16 * 1024);
    let metadataLength = 0;
    function flushMetadata(): Uint8Array | null {
      if (metadataLength === 0) return null;
      const bytes = metadata.slice(0, metadataLength);
      metadataLength = 0;
      return bytes;
    }
    function appendMetadata(header: unknown): Uint8Array | null {
      const bytes = frame(header);
      const flushed =
        metadataLength + bytes.byteLength > metadata.byteLength ? flushMetadata() : null;
      metadata.set(bytes, metadataLength);
      metadataLength += bytes.byteLength;
      return flushed;
    }
    for (let index = 0; index < input.objectKeys.length; index++) {
      const objectKey = input.objectKeys[index];
      if (objectKey === undefined) throw new Error("storage_batch_contract_invalid");
      const object = input.objects[index];
      if (!object) {
        const flushed = appendMetadata({ index, objectKey, state: "not_found" });
        if (flushed !== null) yield flushed;
        continue;
      }
      const pending = flushMetadata();
      if (pending !== null) yield pending;
      const stored = await input.readObject({
        target: projectR2BucketTarget(input.projectId, object.environmentId, object.jurisdiction),
        objectKey: object.physicalObjectKey,
      });
      if (stored.state === "absent") {
        const flushed = appendMetadata({ index, objectKey, state: "not_found" });
        if (flushed !== null) yield flushed;
        continue;
      }
      if (
        stored.objectKey !== object.physicalObjectKey ||
        stored.contentLength !== object.size ||
        stored.contentType !== object.contentType ||
        stored.etag !== object.etag
      ) {
        try {
          await stored.body.cancel();
        } catch {
          /* Preserve the metadata rejection after releasing the upstream body. */
        }
        throw new Error("storage_batch_contract_invalid");
      }
      const reader = stored.body.getReader();
      activeReader = reader;
      let consumed = 0;
      try {
        yield frame({
          index,
          objectKey,
          state: "found",
          contentType: object.contentType,
          contentLength: object.size,
          etag: object.etag,
        });
        while (true) {
          const next = await readNextChunk(reader);
          if (next.done) break;
          consumed += next.value.byteLength;
          if (consumed > object.size) throw new Error("storage_batch_contract_invalid");
          yield next.value;
        }
        if (consumed !== object.size) throw new Error("storage_batch_contract_invalid");
      } finally {
        activeReader = null;
        try {
          await reader.cancel();
        } catch {
          /* Preserve the original read failure while releasing its reader. */
        }
        reader.releaseLock();
      }
    }
    const overflow = appendMetadata({ state: "completed", count: input.objectKeys.length });
    if (overflow !== null) yield overflow;
    const final = flushMetadata();
    if (final !== null) yield final;
  }
}
