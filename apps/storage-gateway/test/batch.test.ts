import { expect, it, vi } from "vitest";
import { streamStorageBatch } from "../src/batch.js";
import { createStorageGateway } from "../src/runtime.js";
import { parseUlid } from "@ohmyhost/platform";
import { CloudflareR2TransferContractError } from "@ohmyhost/provider-cloudflare";
import { storageErasureMarkerDigest, type StorageErasureProof } from "@ohmyhost/database";
import { decodeStorageBatch } from "../../../packages/customer-runtime/dist/storage-batch-stream.js";
const id = (n: number) => parseUlid(String(n).padStart(26, "0"));
const object = (key: string, size = 3) => ({
  organizationId: id(1),
  projectId: id(10),
  environmentId: id(11),
  dataEnvironmentId: id(11),
  physicalObjectKey: `d/${id(11)}/${key}`,
  objectKey: key,
  transferId: id(30),
  contentType: "application/octet-stream",
  size,
  etag: "a".repeat(32),
  uploadedAt: new Date("2026-09-28T12:00:00Z"),
  jurisdiction: "us" as const,
});
function body(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
async function headers(stream: ReadableStream<Uint8Array>) {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  const items: unknown[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, offset, 4).getUint32(0);
    offset += 4;
    const header = JSON.parse(new TextDecoder().decode(bytes.slice(offset, offset + length))) as {
      contentLength?: number;
    };
    offset += length;
    items.push(header);
    if (header.contentLength !== undefined) {
      items.push([...bytes.slice(offset, offset + header.contentLength)]);
      offset += header.contentLength;
    }
  }
  return items;
}
it("coalesces 4000 ordered metadata results for the unchanged Runtime decoder with bounded reads", async () => {
  const prefix = "release024/worker/run-bulk-runtime026-probe/";
  const keys = [
    prefix + "binary.bin",
    prefix + "text.txt",
    ...Array.from({ length: 3998 }, (_, index) => prefix + `missing-max-${index}.bin`),
  ];
  const binary = new Uint8Array([0, 255, 128, 1, 42, 10, 0]);
  const text = new TextEncoder().encode("release-0.1.24");
  const objects = keys.map((key, index) =>
    index < 2
      ? {
          ...object(key, index === 0 ? binary.byteLength : text.byteLength),
          contentType: index === 0 ? "application/octet-stream" : "text/plain",
        }
      : null,
  );
  let providerReads = 0;
  const chunks: Uint8Array[] = [];
  const stream = streamStorageBatch({
    projectId: id(10),
    objectKeys: keys,
    objects,
    readObject: async (value: unknown) => {
      const { objectKey } = value as { objectKey: string };
      const index = objects.findIndex((item) => item?.physicalObjectKey === objectKey);
      const stored = objects[index];
      if (!stored || index > 1) throw new Error("unexpected provider read");
      providerReads++;
      const bytes = index === 0 ? binary : text;
      return {
        state: "found",
        objectKey,
        contentType: stored.contentType,
        contentLength: bytes.byteLength,
        etag: stored.etag,
        body: body(bytes),
      };
    },
  }).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        chunks.push(chunk);
        controller.enqueue(chunk);
      },
    }),
  );
  const timer = vi.spyOn(globalThis, "setTimeout");
  try {
    const results: { objectKey: string; state: string; bytes?: number[] }[] = [];
    for await (const item of decodeStorageBatch(
      new Response(stream, {
        headers: { "content-type": "application/vnd.ohmyhost.storage-batch.v1" },
      }),
      keys,
      1000,
    )) {
      results.push(
        item.state === "found"
          ? {
              objectKey: item.objectKey,
              state: item.state,
              bytes: [...new Uint8Array(await new Response(item.body).arrayBuffer())],
            }
          : item,
      );
    }
    expect(results).toHaveLength(4000);
    expect(results.map((item) => item.objectKey)).toEqual(keys);
    expect(results[0]?.bytes).toEqual([...binary]);
    expect(results[1]?.bytes).toEqual([...text]);
    expect(results.slice(2).every((item) => item.state === "not_found")).toBe(true);
    expect(providerReads).toBe(2);
    expect(chunks.length).toBeLessThan(40);
    expect(chunks.every((chunk) => chunk.byteLength <= 16 * 1024)).toBe(true);
    expect(timer.mock.calls.length).toBeLessThan(42);
  } finally {
    timer.mockRestore();
  }
});
it("flushes immutable bounded metadata before waiting for R2 and preserves file backpressure", async () => {
  const keys = Array.from({ length: 4000 }, (_, index) => `missing-${index}.bin`);
  keys[1000] = "large.bin";
  let releaseProvider: () => void = () => undefined;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  let visited = 0;
  const guardedKeys = new Proxy(keys, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) visited++;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const bytes = new Uint8Array(32 * 1024).fill(42);
  const stored = object("large.bin", bytes.byteLength);
  const reader = streamStorageBatch({
    projectId: id(10),
    objectKeys: guardedKeys,
    objects: keys.map((key) => (key === "large.bin" ? stored : null)),
    readObject: async () => {
      await providerGate;
      return {
        state: "found",
        objectKey: stored.physicalObjectKey,
        contentLength: bytes.byteLength,
        contentType: stored.contentType,
        etag: stored.etag,
        body: body(bytes),
      };
    },
  }).getReader();
  try {
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(visited).toBeLessThan(1000);
    const snapshot = first.value?.slice();
    function missingHeaders(bytes: Uint8Array | undefined) {
      if (!bytes) throw new Error("missing metadata chunk");
      let count = 0;
      for (let offset = 0; offset < bytes.byteLength; ) {
        const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
        offset += 4;
        const header = JSON.parse(
          new TextDecoder().decode(bytes.subarray(offset, offset + length)),
        );
        expect(header.state).toBe("not_found");
        offset += length;
        count++;
      }
      return count;
    }
    let missingRead = missingHeaders(first.value);
    let metadataChunks = 1;
    while (missingRead < 1000) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      expect(next.value?.byteLength).toBeLessThanOrEqual(16 * 1024);
      missingRead += missingHeaders(next.value);
      metadataChunks++;
    }
    expect(metadataChunks).toBeLessThan(8);
    releaseProvider();
    let foundBody: Uint8Array | undefined;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value === bytes) foundBody = next.value;
      else expect(next.value.byteLength).toBeLessThanOrEqual(16 * 1024);
    }
    expect(foundBody).toBe(bytes);
    expect(first.value).toEqual(snapshot);
  } finally {
    releaseProvider();
    await reader.cancel();
    reader.releaseLock();
  }
});
it("rejects partial coalesced reads and cancels an active upstream without a completion frame", async () => {
  for (const badBytes of [new Uint8Array([1]), new Uint8Array([1, 2, 3, 4])]) {
    const keys = [...Array.from({ length: 400 }, (_, index) => `missing-${index}.bin`), "one.bin"];
    const stored = object("one.bin");
    const stream = streamStorageBatch({
      projectId: id(10),
      objectKeys: keys,
      objects: [...Array.from({ length: 400 }, () => null), stored],
      readObject: async () => ({
        state: "found",
        objectKey: stored.physicalObjectKey,
        contentLength: stored.size,
        contentType: stored.contentType,
        etag: stored.etag,
        body: body(badBytes),
      }),
    });
    let completed = false;
    await expect(
      (async () => {
        for await (const item of decodeStorageBatch(
          new Response(stream, {
            headers: { "content-type": "application/vnd.ohmyhost.storage-batch.v1" },
          }),
          keys,
          1000,
        )) {
          if (item.state === "found") await new Response(item.body).arrayBuffer();
        }
        completed = true;
      })(),
    ).rejects.toThrow();
    expect(completed).toBe(false);
  }
  let cancelled = false;
  const stored = object("one.bin");
  const upstream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const reader = streamStorageBatch({
    projectId: id(10),
    objectKeys: ["missing.bin", "one.bin", "not-read.bin"],
    objects: [null, stored, null],
    readObject: async () => ({
      state: "found",
      objectKey: stored.physicalObjectKey,
      contentLength: stored.size,
      contentType: stored.contentType,
      etag: stored.etag,
      body: upstream,
    }),
  }).getReader();
  await reader.read();
  await reader.read();
  await reader.read();
  await reader.cancel();
  reader.releaseLock();
  expect(cancelled).toBe(true);
});
it("streams ordered binary objects and an explicit terminal marker without buffering the batch", async () => {
  const keys = ["one.bin", "missing.bin", "zero.bin"];
  const objects = [object("one.bin"), null, object("zero.bin", 0)];
  const readObject = async (value: unknown) => {
    const input = value as { objectKey: string };
    const bytes = input.objectKey.endsWith("zero.bin")
      ? new Uint8Array()
      : new Uint8Array([0, 255, 10]);
    return {
      state: "found" as const,
      objectKey: input.objectKey,
      contentType: "application/octet-stream",
      contentLength: bytes.length,
      etag: "a".repeat(32),
      body: body(bytes),
    };
  };
  expect(
    await headers(streamStorageBatch({ projectId: id(10), objectKeys: keys, objects, readObject })),
  ).toEqual([
    {
      index: 0,
      objectKey: "one.bin",
      state: "found",
      contentType: "application/octet-stream",
      contentLength: 3,
      etag: "a".repeat(32),
    },
    [0, 255, 10],
    { index: 1, objectKey: "missing.bin", state: "not_found" },
    {
      index: 2,
      objectKey: "zero.bin",
      state: "found",
      contentType: "application/octet-stream",
      contentLength: 0,
      etag: "a".repeat(32),
    },
    [],
    { state: "completed", count: 3 },
  ]);
});
it("rejects mismatched provider metadata, truncated bytes and cancels an unfinished object", async () => {
  for (const change of [
    { etag: "b".repeat(32) },
    { contentLength: 4 },
    { bytes: new Uint8Array([1]) },
  ]) {
    const stored = object("one.bin");
    let metadataBodyCancelled = false;
    const metadataBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        metadataBodyCancelled = true;
      },
    });
    const readObject = async () => ({
      state: "found" as const,
      objectKey: stored.physicalObjectKey,
      contentType: stored.contentType,
      contentLength: stored.size,
      etag: stored.etag,
      body: "bytes" in change ? body(change.bytes) : metadataBody,
      ...("etag" in change ? { etag: change.etag } : {}),
      ...("contentLength" in change ? { contentLength: change.contentLength } : {}),
    });
    await expect(
      headers(
        streamStorageBatch({
          projectId: id(10),
          objectKeys: [stored.objectKey],
          objects: [stored],
          readObject,
        }),
      ),
    ).rejects.toThrow("storage_batch_contract_invalid");
    if (!("bytes" in change)) expect(metadataBodyCancelled).toBe(true);
    else await metadataBody.cancel();
  }
  let cancelled = false;
  const stored = object("one.bin");
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const stream = streamStorageBatch({
    projectId: id(10),
    objectKeys: [stored.objectKey],
    objects: [stored],
    readObject: async () => ({
      state: "found",
      objectKey: stored.physicalObjectKey,
      contentType: stored.contentType,
      contentLength: stored.size,
      etag: stored.etag,
      body: source,
    }),
  });
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  await reader.cancel();
  expect(cancelled).toBe(true);

  let markReadStarted: () => void = () => undefined;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  let releaseUpstream: () => void = () => undefined;
  const upstreamGate = new Promise<void>((resolve) => {
    releaseUpstream = resolve;
  });
  let stalledUpstreamCancelled = false;
  const stalledSource = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        markReadStarted();
        await upstreamGate;
        if (!stalledUpstreamCancelled) controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        stalledUpstreamCancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const stalledReader = streamStorageBatch({
    projectId: id(10),
    objectKeys: [stored.objectKey],
    objects: [stored],
    readObject: async () => ({
      state: "found",
      objectKey: stored.physicalObjectKey,
      contentType: stored.contentType,
      contentLength: stored.size,
      etag: stored.etag,
      body: stalledSource,
    }),
  }).getReader();
  await stalledReader.read();
  const waitingForBytes = stalledReader.read();
  await readStarted;
  const cancellation = stalledReader.cancel();
  try {
    expect(
      await Promise.race([
        cancellation.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
      ]),
    ).toBe(true);
    expect(stalledUpstreamCancelled).toBe(true);
  } finally {
    releaseUpstream();
    await cancellation;
    await waitingForBytes;
    stalledReader.releaseLock();
  }
});
it("authenticates one bulk hop and finalizes only a persisted scoped erasure marker", async () => {
  const erased: string[] = [];
  const completed: string[] = [];
  const proofs: StorageErasureProof[] = [];
  const markers = new Map<string, { markerSha256: Uint8Array; erasedAt: Date }>();
  let nextDeletion = 30;
  let authenticated = 0;
  let providerFailure: Error | undefined;
  const gateway = createStorageGateway({
    authenticate: async () => {
      authenticated++;
      return {
        organizationId: id(1),
        projectId: id(10),
        environmentId: id(11),
        dataEnvironmentId: id(11),
        bucketName: `ohmyho-${id(10)}-${id(11)}`,
        jurisdiction: "us",
        quotaBytes: 1073741824,
      };
    },
    claim: async () => {
      throw new Error("unused");
    },
    readReservation: async () => null,
    complete: async () => "created",
    readObject: async () => null,
    claimDelete: async () => {
      throw new Error("unused");
    },
    completeDelete: async () => "created",
    readObjects: async (input) => input.objectKeys.map((key) => object(key)),
    claimDeletes: async (inputs) =>
      inputs.map((input) => ({
        state: "claimed" as const,
        objectKey: input.objectKey,
        deletionId: input.deletionId,
        environmentId: id(11),
        dataEnvironmentId: id(11),
        physicalObjectKey: object(input.objectKey).physicalObjectKey,
        jurisdiction: "us" as const,
        expiresAt: new Date(
          input.objectKey === "pending.bin" ? "2026-09-28T12:05:00Z" : "2026-09-28T11:59:00Z",
        ),
        completedAt: null,
        transferId: id(
          input.objectKey === "one.bin" ? 40 : input.objectKey === "pending.bin" ? 41 : 42,
        ),
        payloadErased: false,
      })),
    completeDeletes: async (inputs) => {
      for (const input of inputs) {
        const marker = markers.get(input.physicalObjectKey);
        expect(marker).toBeDefined();
        expect(input.markerSha256).toEqual(marker?.markerSha256);
        expect(input.erasedAt).toBe(marker?.erasedAt.toISOString());
      }
      completed.push(...inputs.map((input) => input.objectKey));
      proofs.push(...inputs);
      return inputs.map(() => "created" as const);
    },
    provider: {
      createTransfer: async () => {
        throw new Error("unused");
      },
      observeObject: async () => {
        throw new Error("unused");
      },
      readObject: async (input) => {
        const key = (input as { objectKey: string }).objectKey;
        return {
          state: "found",
          objectKey: key,
          contentType: "application/octet-stream",
          contentLength: 3,
          etag: "a".repeat(32),
          body: body(new Uint8Array([1, 2, 3])),
        };
      },
      erasePayloads: async (value, options) => {
        if (providerFailure) throw providerFailure;
        const input = value as {
          objects: readonly {
            organizationId: string;
            projectId: string;
            environmentId: string;
            dataEnvironmentId: string;
            transferId: string;
            objectKey: string;
          }[];
        };
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        erased.push(...input.objects.map((object) => object.objectKey));
        return input.objects.map((object) => {
          expect(object).toMatchObject({
            organizationId: id(1),
            projectId: id(10),
            environmentId: id(11),
            dataEnvironmentId: id(11),
          });
          if (object.objectKey.endsWith("failed.bin"))
            return {
              objectKey: object.objectKey,
              transferId: object.transferId,
              status: "failed" as const,
              retryable: true,
            };
          const marker = {
            markerSha256: storageErasureMarkerDigest({
              ...object,
              physicalObjectKey: object.objectKey,
            }),
            erasedAt: new Date("2026-09-28T12:00:00Z"),
          };
          markers.set(object.objectKey, marker);
          return {
            objectKey: object.objectKey,
            transferId: object.transferId,
            status: "erased" as const,
            ...marker,
          };
        });
      },
    },
    sha256: async () => new Uint8Array(32),
    ids: { next: () => id(nextDeletion++) },
    now: () => new Date("2026-09-28T12:00:00Z"),
  });
  const auth = { projectId: id(10), environmentId: id(11), key: "s".repeat(43) };
  const read = await gateway.readMany({ ...auth, objectKeys: ["one.bin"] });
  expect(read.status).toBe("stream");
  if (read.status === "stream")
    expect((await headers(read.body)).at(-1)).toEqual({ state: "completed", count: 1 });
  await expect(gateway.readMany({ ...auth, objectKeys: ["one.bin", "one.bin"] })).rejects.toThrow(
    "invalid",
  );
  const result = await gateway.deleteMany({
    ...auth,
    objects: ["one.bin", "pending.bin", "failed.bin"].map((objectKey) => ({
      objectKey,
      idempotencyKey: objectKey,
    })),
  });
  expect(result.status).toBe("batch");
  if (result.status === "batch")
    expect(result.results).toEqual([
      { object_key: "one.bin", state: "completed", deletion_id: id(30) },
      { object_key: "pending.bin", state: "pending", retry_at: "2026-09-28T12:05:30.000Z" },
      {
        object_key: "failed.bin",
        state: "failed",
        code: "storage_gateway_unavailable",
        retryable: true,
      },
    ]);
  expect(erased).toEqual([
    object("one.bin").physicalObjectKey,
    object("failed.bin").physicalObjectKey,
  ]);
  expect(completed).toEqual(["one.bin"]);
  expect(proofs).toEqual([
    {
      organizationId: id(1),
      projectId: id(10),
      environmentId: id(11),
      dataEnvironmentId: id(11),
      transferId: id(40),
      objectKey: "one.bin",
      physicalObjectKey: object("one.bin").physicalObjectKey,
      deletionId: id(30),
      markerSha256: storageErasureMarkerDigest({ ...object("one.bin"), transferId: id(40) }),
      erasedAt: "2026-09-28T12:00:00.000Z",
    },
  ]);
  expect(authenticated).toBeGreaterThanOrEqual(2);
  for (const [failure, retryable] of [
    [new CloudflareR2TransferContractError(), false],
    [new Error("lost provider response"), true],
  ] as const) {
    providerFailure = failure;
    expect(
      await gateway.deleteMany({
        ...auth,
        objects: [{ objectKey: "one.bin", idempotencyKey: "again" }],
      }),
    ).toMatchObject({
      status: "batch",
      state: "partial",
      results: [{ state: "failed", retryable }],
    });
  }
});

it("ends a found body that stays silent past the idle bound and cancels its upstream", async () => {
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const stored = object("silent.bin", 3);
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = streamStorageBatch({
      projectId: id(10),
      objectKeys: [stored.objectKey],
      objects: [stored],
      readObject: async () => ({
        state: "found",
        objectKey: stored.physicalObjectKey,
        contentLength: stored.size,
        contentType: stored.contentType,
        etag: stored.etag,
        body: upstream,
      }),
    });
    const reading = new Response(stream).arrayBuffer().then(
      () => "completed",
      () => "failed",
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await Promise.race([reading, Promise.resolve("still reading")])).toBe("failed");
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("reports the idle failure of a silent found body even when its upstream refuses the cancel", async () => {
  vi.useFakeTimers();
  try {
    const stored = object("refused-cancel.bin", 3);
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        throw new Error("upstream refused the cancel");
      },
    });
    const stream = streamStorageBatch({
      projectId: id(11),
      objectKeys: [stored.objectKey],
      objects: [stored],
      readObject: async () => ({
        state: "found",
        objectKey: stored.physicalObjectKey,
        contentLength: stored.size,
        contentType: stored.contentType,
        etag: stored.etag,
        body: upstream,
      }),
    });
    const reading = new Response(stream).arrayBuffer().then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.message : "unknown"),
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await reading).toBe("storage_batch_body_idle");
  } finally {
    vi.useRealTimers();
  }
});
