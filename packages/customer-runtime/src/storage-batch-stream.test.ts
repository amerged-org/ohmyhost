import { expect, it, vi } from "vitest";
import { createPrivateStorageClient } from "./storage.js";
import { readStorageBatchJson, STORAGE_BATCH_CONTENT_TYPE } from "./storage-batch-stream.js";

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const KEY = "s".repeat(43);
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const encoder = new TextEncoder();
const storage = (fetch: (request: Request) => Promise<Response>, timeoutMilliseconds = 100) =>
  createPrivateStorageClient({
    endpoint: "https://storage-gateway.internal",
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    key: KEY,
    fetch,
    capabilityFetch: fetch,
    timeoutMilliseconds,
  });
const header = (value: unknown) => {
  const json = encoder.encode(JSON.stringify(value));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  return out;
};
const found = (contentLength = 3) => ({
  index: 0,
  objectKey: "one.bin",
  state: "found",
  contentType: "application/octet-stream",
  contentLength,
  etag: "a".repeat(32),
});
const response = (chunks: readonly Uint8Array[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } },
  );
async function collect(client: ReturnType<typeof storage>) {
  const results = [];
  for await (const item of await client.readMany({ objectKeys: ["one.bin"] }))
    results.push(
      item.state === "found" ? new Uint8Array(await new Response(item.body).arrayBuffer()) : item,
    );
  return results;
}

function joined(chunks: readonly Uint8Array[]) {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

it("decodes 4000 coalesced headers from their original views with one fatal UTF-8 decoder", async () => {
  const keys = Array.from({ length: 4000 }, (_, index) => `missing-${index}.bin`);
  const bytes = joined([
    ...keys.map((objectKey, index) => header({ index, objectKey, state: "not_found" })),
    header({ state: "completed", count: keys.length }),
  ]);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 16 * 1024)
    chunks.push(bytes.subarray(offset, offset + 16 * 1024));
  const decode = vi.spyOn(TextDecoder.prototype, "decode");
  try {
    const results = [];
    for await (const item of await storage(async () => response(chunks)).readMany({
      objectKeys: keys,
    }))
      results.push(item);
    expect(results).toEqual(keys.map((objectKey) => ({ objectKey, state: "not_found" })));
    expect(decode.mock.calls).toHaveLength(4001);
    expect(new Set(decode.mock.contexts).size).toBe(1);
    const decoder = decode.mock.contexts[0] as TextDecoder;
    expect(decoder.fatal).toBe(true);
    expect(
      decode.mock.calls.filter(
        ([input]) => ArrayBuffer.isView(input) && input.buffer === bytes.buffer,
      ).length,
    ).toBeGreaterThan(3900);
  } finally {
    decode.mockRestore();
  }
});

it("rejects a fully buffered header that exceeds the cumulative 4 MiB control budget", async () => {
  const payloadBytes = 2000;
  const frameBytes = 4 + payloadBytes;
  const withinBudget = Math.floor((4 * 1024 * 1024) / frameBytes);
  const keys = Array.from({ length: withinBudget + 1 }, (_, index) => `missing-${index}.bin`);
  const frames = keys.map((objectKey, index) => {
    const json = JSON.stringify({ index, objectKey, state: "not_found" });
    const padded = encoder.encode(`${json.slice(0, -1)}${" ".repeat(payloadBytes - json.length)}}`);
    const frame = new Uint8Array(frameBytes);
    new DataView(frame.buffer).setUint32(0, payloadBytes);
    frame.set(padded, 4);
    return frame;
  });
  const bytes = joined([...frames, header({ state: "completed", count: keys.length })]);
  let yielded = 0;
  await expect(
    (async () => {
      for await (const item of await storage(async () => response([bytes])).readMany({
        objectKeys: keys,
      })) {
        expect(item.state).toBe("not_found");
        yielded++;
      }
    })(),
  ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  expect(yielded).toBe(withinBudget);
});

it("preserves offset views and fragmented headers, lengths and binary bodies", async () => {
  const keys = ["one.bin", "missing.bin", "empty.bin"];
  const bytes = joined([
    header(found()),
    new Uint8Array([0, 255, 128]),
    header({ index: 1, objectKey: keys[1], state: "not_found" }),
    header({ ...found(0), index: 2, objectKey: keys[2] }),
    header({ state: "completed", count: keys.length }),
  ]);
  const offsetView = (bytes: Uint8Array) => {
    const backing = new Uint8Array(bytes.byteLength + 11).fill(255);
    backing.set(bytes, 7);
    return backing.subarray(7, 7 + bytes.byteLength);
  };
  for (const chunks of [
    [offsetView(bytes)],
    Array.from({ length: Math.ceil(bytes.byteLength / 3) }, (_, index) =>
      offsetView(bytes.subarray(index * 3, index * 3 + 3)),
    ),
  ]) {
    const results = [];
    for await (const item of await storage(async () => response(chunks)).readMany({
      objectKeys: keys,
    }))
      results.push(
        item.state === "found"
          ? {
              objectKey: item.objectKey,
              bytes: [...new Uint8Array(await new Response(item.body).arrayBuffer())],
            }
          : item,
      );
    expect(results).toEqual([
      { objectKey: keys[0], bytes: [0, 255, 128] },
      { objectKey: keys[1], state: "not_found" },
      { objectKey: keys[2], bytes: [] },
    ]);
  }
});

it("keeps buffered header limits, terminal EOF, body ownership and cancellation strict", async () => {
  const keys = ["one.bin", "missing.bin"];
  const first = header({ index: 0, objectKey: keys[0], state: "not_found" });
  const second = header({ index: 1, objectKey: keys[1], state: "not_found" });
  const terminal = header({ state: "completed", count: keys.length });
  const invalidUtf8 = second.slice();
  invalidUtf8[5] = 255;
  for (const chunks of [
    [first, second, header({ state: "completed", count: 1 })],
    [first, second, terminal, new Uint8Array([1])],
    [first, second],
    [first, header({ index: 1, objectKey: keys[1], state: "not_found", extra: true }), terminal],
    [first, invalidUtf8, terminal],
    [first, new Uint8Array([0, 0, 0, 0])],
    [first, new Uint8Array([0, 0, 8, 1])],
  ])
    await expect(
      (async () => {
        for await (const item of await storage(async () => response([joined(chunks)])).readMany({
          objectKeys: keys,
        }))
          expect(item.state).toBe("not_found");
      })(),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  const buffered = response([joined([header(found()), new Uint8Array([1, 2, 3]), terminal])]);
  const active = (await storage(async () => buffered).readMany({ objectKeys: keys }))[
    Symbol.asyncIterator
  ]();
  const item = await active.next();
  if (item.done || item.value.state !== "found") throw new Error("Expected active body");
  await expect(active.next()).rejects.toMatchObject({ code: "gateway_request_invalid" });
  await expect(new Response(item.value.body).arrayBuffer()).rejects.toMatchObject({
    code: "gateway_request_invalid",
  });
  const cancelled = (
    await storage(async () => response([joined([first, second, terminal])])).readMany({
      objectKeys: keys,
    })
  )[Symbol.asyncIterator]();
  await cancelled.next();
  await cancelled.return?.();
  await expect(cancelled.next()).rejects.toMatchObject({ code: "gateway_request_invalid" });
});

it("consumes the real gateway binary contract with backpressure, missing and empty objects", async () => {
  const sourcePath = new URL("../../../apps/storage-gateway/src/batch.ts", import.meta.url)
    .pathname;
  const gateway = (await import(sourcePath)) as {
    streamStorageBatch: (input: unknown) => ReadableStream<Uint8Array>;
    STORAGE_BATCH_CONTENT_TYPE: string;
  };
  expect(gateway.STORAGE_BATCH_CONTENT_TYPE).toBe(STORAGE_BATCH_CONTENT_TYPE);
  const keys = ["one.bin", "missing.bin", "empty.bin"];
  let reads = 0;
  const object = (objectKey: string, size: number) => ({
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    dataEnvironmentId: ENVIRONMENT,
    objectKey,
    physicalObjectKey: `d/${ENVIRONMENT}/${objectKey}`,
    size,
    contentType: "application/octet-stream",
    etag: "a".repeat(32),
    jurisdiction: "us",
  });
  const requests: Request[] = [];
  const client = storage(async (request) => {
    requests.push(request);
    return new Response(
      gateway
        .streamStorageBatch({
          projectId: PROJECT,
          objectKeys: keys,
          objects: [object("one.bin", 3), null, object("empty.bin", 0)],
          readObject: async (input: { objectKey: string }) => {
            reads++;
            const bytes = input.objectKey.endsWith("empty.bin")
              ? new Uint8Array()
              : new Uint8Array([0, 255, 10]);
            return {
              state: "found",
              objectKey: input.objectKey,
              contentType: "application/octet-stream",
              contentLength: bytes.length,
              etag: "a".repeat(32),
              body: new ReadableStream({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
            };
          },
        })
        .pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              for (let at = 0; at < chunk.length; at += 2)
                controller.enqueue(chunk.subarray(at, at + 2));
            },
          }),
        ),
      { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } },
    );
  });
  const iterator = (await client.readMany({ objectKeys: keys }))[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.done).toBe(false);
  expect(reads).toBe(1);
  if (first.done || first.value.state !== "found") throw new Error("Expected found");
  expect(new Uint8Array(await new Response(first.value.body).arrayBuffer())).toEqual(
    new Uint8Array([0, 255, 10]),
  );
  expect((await iterator.next()).value).toEqual({ state: "not_found", objectKey: "missing.bin" });
  const empty = await iterator.next();
  if (empty.done || empty.value.state !== "found") throw new Error("Expected empty object");
  expect((await new Response(empty.value.body).arrayBuffer()).byteLength).toBe(0);
  expect((await iterator.next()).done).toBe(true);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (request === undefined) throw new Error("Expected one gateway request");
  expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
  expect(await request.json()).toEqual({
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    objectKeys: keys,
  });
});

it("rejects invalid or partial frames and cancels before first iteration or an unfinished body", async () => {
  for (const chunks of [
    [new Uint8Array([0, 0, 8, 1])],
    [header({ ...found(), contentLength: 1_073_741_825 })],
    [header({ ...found(), index: 1 })],
    [header({ ...found(), objectKey: "foreign.bin" })],
    [header(found()), new Uint8Array([1])],
    [header(found()), new Uint8Array([1, 2, 3])],
    [
      header(found()),
      new Uint8Array([1, 2, 3]),
      header({ state: "completed", count: 1 }),
      new Uint8Array([1]),
    ],
  ])
    await expect(collect(storage(async () => response(chunks)))).rejects.toMatchObject({
      code: "gateway_response_invalid",
    });
  let part = 0;
  const lateFailure = storage(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (part++ === 0) controller.enqueue(header(found()));
              else if (part === 2) controller.enqueue(new Uint8Array([1, 2, 3]));
              else controller.error(new Error("provider detail must remain private"));
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } },
      ),
  );
  await expect(collect(lateFailure)).rejects.toMatchObject({
    code: "gateway_unavailable",
    retryable: true,
    message: "gateway_unavailable",
  });
  let cancelled = false;
  const client = storage(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } },
      ),
  );
  const iterator = (await client.readMany({ objectKeys: ["one.bin"] }))[Symbol.asyncIterator]();
  await iterator.return?.();
  expect(cancelled).toBe(true);
  const skip = (
    await storage(async () =>
      response([
        header(found()),
        new Uint8Array([1, 2, 3]),
        header({ index: 1, objectKey: "missing.bin", state: "not_found" }),
        header({ state: "completed", count: 2 }),
      ]),
    ).readMany({ objectKeys: ["one.bin", "missing.bin"] })
  )[Symbol.asyncIterator]();
  const toSkip = await skip.next();
  if (toSkip.done || toSkip.value.state !== "found") throw new Error("Expected skip body");
  await toSkip.value.body.cancel();
  expect((await skip.next()).value).toEqual({ state: "not_found", objectKey: "missing.bin" });
  expect((await skip.next()).done).toBe(true);
  const stop = (
    await storage(async () =>
      response([
        header(found()),
        new Uint8Array([1, 2, 3]),
        header({ state: "completed", count: 1 }),
      ]),
    ).readMany({ objectKeys: ["one.bin"] })
  )[Symbol.asyncIterator]();
  const active = await stop.next();
  if (active.done || active.value.state !== "found") throw new Error("Expected active body");
  await stop.return?.();
  await expect(new Response(active.value.body).arrayBuffer()).rejects.toMatchObject({
    code: "gateway_request_invalid",
  });
  await expect(stop.next()).rejects.toMatchObject({ code: "gateway_request_invalid" });
  const opened = (
    await storage(async () =>
      response([
        header(found()),
        new Uint8Array([1, 2, 3]),
        header({ state: "completed", count: 1 }),
      ]),
    ).readMany({ objectKeys: ["one.bin"] })
  )[Symbol.asyncIterator]();
  await opened.next();
  await expect(opened.next()).rejects.toMatchObject({ code: "gateway_request_invalid" });
  for (const contentType of [STORAGE_BATCH_CONTENT_TYPE, "text/html"]) {
    const rejectCancel = storage(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw new Error("provider cancellation failed");
            },
          }),
          { headers: { "content-type": contentType } },
        ),
    );
    if (contentType === STORAGE_BATCH_CONTENT_TYPE) {
      const unused = (await rejectCancel.readMany({ objectKeys: ["one.bin"] }))[
        Symbol.asyncIterator
      ]();
      await unused.return?.();
    } else
      await expect(rejectCancel.readMany({ objectKeys: ["one.bin"] })).rejects.toMatchObject({
        code: "gateway_response_invalid",
      });
  }
  await Promise.resolve();
});

it("keeps typed delete outcomes distinct and bounds control JSON and read deadlines", async () => {
  const objects = ["one.bin", "pending.bin", "failed.bin"].map((objectKey) => ({
    objectKey,
    idempotencyKey: `delete:${objectKey}`,
  }));
  const client = storage(async () =>
    Response.json({
      state: "partial",
      results: [
        { state: "completed", object_key: "one.bin", deletion_id: ID },
        { state: "pending", object_key: "pending.bin", retry_at: "2026-09-28T12:05:00.000Z" },
        {
          state: "failed",
          object_key: "failed.bin",
          code: "storage_gateway_unavailable",
          retryable: true,
        },
      ],
    }),
  );
  await expect(client.deleteMany({ objects })).resolves.toEqual([
    { state: "completed", objectKey: "one.bin", deletionId: ID },
    { state: "pending", objectKey: "pending.bin", retryAt: "2026-09-28T12:05:00.000Z" },
    {
      state: "failed",
      objectKey: "failed.bin",
      code: "storage_gateway_unavailable",
      retryable: true,
    },
  ]);
  const fetch = vi.fn(async () => Response.json({}));
  const invalid = storage(fetch);
  await expect(invalid.readMany({ objectKeys: ["one.bin", "one.bin"] })).rejects.toMatchObject({
    code: "gateway_request_invalid",
  });
  await expect(
    invalid.readMany({ objectKeys: Array.from({ length: 4001 }, (_, i) => `file${i}.bin`) }),
  ).rejects.toMatchObject({ code: "gateway_request_invalid" });
  expect(fetch).not.toHaveBeenCalled();
  const maximumKeys = Array.from({ length: 4000 }, (_, index) => `item${index}.bin`);
  const maximum = storage(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(header({ index: 0, objectKey: maximumKeys[0], state: "not_found" }));
            controller.close();
          },
        }),
        { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } },
      ),
  );
  const maximumIterator = (await maximum.readMany({ objectKeys: maximumKeys }))[
    Symbol.asyncIterator
  ]();
  expect((await maximumIterator.next()).value).toEqual({
    state: "not_found",
    objectKey: maximumKeys[0],
  });
  await maximumIterator.return?.();
  let emitted = 0;
  const excessControl = storage(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (emitted === maximumKeys.length) {
              controller.close();
              return;
            }
            const json = encoder.encode(
              JSON.stringify({
                index: emitted,
                objectKey: maximumKeys[emitted],
                state: "not_found",
              }).padEnd(2048, " "),
            );
            const bytes = new Uint8Array(2052);
            new DataView(bytes.buffer).setUint32(0, 2048);
            bytes.set(json, 4);
            emitted++;
            controller.enqueue(bytes);
          },
        }),
        { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } },
      ),
  );
  const readExcess = async () => {
    for await (const item of await excessControl.readMany({ objectKeys: maximumKeys }))
      expect(item.state).toBe("not_found");
  };
  await expect(readExcess()).rejects.toMatchObject({ code: "gateway_response_invalid" });
  await expect(
    storage(
      async () =>
        new Response(" ".repeat(4 * 1024 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
    ).deleteMany({ objects }),
  ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  for (const value of [
    {
      state: "completed",
      results: [{ state: "pending", object_key: "one.bin", retry_at: "2026-09-28T12:05:00.000Z" }],
    },
    {
      state: "partial",
      results: [{ state: "pending", object_key: "one.bin", retry_at: "tomorrow" }],
    },
    {
      state: "partial",
      results: [
        { state: "failed", object_key: "foreign.bin", code: "object_not_found", retryable: false },
      ],
    },
    {
      state: "partial",
      results: [
        { state: "failed", object_key: "one.bin", code: "provider_error", retryable: true },
      ],
    },
    {
      state: "partial",
      results: [
        { state: "failed", object_key: "one.bin", code: "object_not_found", retryable: true },
      ],
    },
  ])
    await expect(
      storage(async () => Response.json(value)).deleteMany({
        objects: [{ objectKey: "one.bin", idempotencyKey: "delete:one.bin" }],
      }),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  for (const value of [
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw new Error("cancel failed");
        },
      }),
      { headers: { "content-type": "text/html" } },
    ),
    new Response("not JSON", { headers: { "content-type": "application/json" } }),
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel() {
          throw new Error("cancel failed");
        },
      }),
      { headers: { "content-type": "application/json" } },
    ),
  ])
    await expect(storage(async () => value).deleteMany({ objects })).rejects.toMatchObject({
      code: "gateway_response_invalid",
    });
  vi.useFakeTimers();
  const completedJson = encoder.encode(
    JSON.stringify({
      state: "completed",
      results: [{ state: "completed", object_key: "one.bin", deletion_id: ID }],
    }),
  );
  let trickledState = "pending";
  let trickledController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let trickledSignal: AbortSignal | undefined;
  let trickledCancelled = false;
  const trickled = storage(async (request) => {
    trickledSignal = request.signal;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          trickledController = value;
        },
        cancel() {
          trickledCancelled = true;
          throw new Error("upstream cancel failure stays private");
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  })
    .deleteMany({ objects: [{ objectKey: "one.bin", idempotencyKey: "delete:one.bin" }] })
    .then(
      () => {
        trickledState = "success";
      },
      (error) => {
        trickledState = (error as { code: string }).code;
      },
    );
  try {
    await vi.advanceTimersByTimeAsync(30);
    trickledController?.enqueue(completedJson.subarray(0, 40));
    await vi.advanceTimersByTimeAsync(40);
    trickledController?.enqueue(completedJson.subarray(40, 80));
    await vi.advanceTimersByTimeAsync(31);
    expect(trickledState).toBe("gateway_timeout");
    expect(trickledSignal?.aborted).toBe(true);
    expect(trickledCancelled).toBe(true);
  } finally {
    if (trickledState === "pending") {
      trickledController?.enqueue(completedJson.subarray(80));
      trickledController?.close();
    }
    await trickled;
    vi.useRealTimers();
  }
  const expired = new AbortController();
  expired.abort();
  let expiredCancelled = false;
  await expect(
    readStorageBatchJson(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            expiredCancelled = true;
            throw new Error("expired response cancel failure stays private");
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      100,
      expired.signal,
    ),
  ).rejects.toMatchObject({ code: "gateway_timeout", retryable: true });
  expect(expiredCancelled).toBe(true);
  vi.useFakeTimers();
  let timelyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const timely = storage(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    return new Response(
      new ReadableStream<Uint8Array>({
        start(value) {
          timelyController = value;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }).deleteMany({ objects: [{ objectKey: "one.bin", idempotencyKey: "delete:one.bin" }] });
  try {
    await vi.advanceTimersByTimeAsync(90);
    timelyController?.enqueue(completedJson);
    timelyController?.close();
    expect(await timely).toEqual([{ state: "completed", objectKey: "one.bin", deletionId: ID }]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
  vi.useFakeTimers();
  let binaryController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const longBinary = collect(
    storage(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              binaryController = value;
              value.enqueue(header(found()));
            },
          }),
          { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } },
        ),
    ),
  );
  try {
    for (const byte of [1, 2, 3]) {
      await vi.advanceTimersByTimeAsync(60);
      binaryController?.enqueue(new Uint8Array([byte]));
    }
    binaryController?.enqueue(header({ state: "completed", count: 1 }));
    binaryController?.close();
    expect(await longBinary).toEqual([new Uint8Array([1, 2, 3])]);
  } finally {
    vi.useRealTimers();
  }
  vi.useFakeTimers();
  let settled = "pending";
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const pending = storage(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
          },
          cancel() {
            throw new Error("cancel failed after timeout");
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  )
    .deleteMany({ objects })
    .then(
      () => {
        settled = "success";
      },
      (error) => {
        settled = (error as { code: string }).code;
      },
    );
  try {
    await vi.advanceTimersByTimeAsync(101);
    expect(settled).toBe("gateway_timeout");
  } finally {
    if (settled === "pending") controller?.close();
    await pending;
    vi.useRealTimers();
  }
});

it("cancels a found body while its read is pending without draining the same source twice", async () => {
  // The source holds the found object's bytes until the test releases them, then continues with the next object.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const parts: (Uint8Array | "gate")[] = [
    header(found(3)),
    "gate",
    header({ index: 1, objectKey: "missing.bin", state: "not_found" }),
    header({ state: "completed", count: 2 }),
  ];
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = parts.shift();
      if (next === undefined) controller.close();
      else if (next === "gate") {
        await gate;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      } else controller.enqueue(next);
    },
  });
  const iterator = (
    await storage(
      async () =>
        new Response(source, {
          headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE },
        }),
    ).readMany({ objectKeys: ["one.bin", "missing.bin"] })
  )[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.state !== "found") throw new Error("Expected a found body");
  const reader = first.value.body.getReader();
  const pendingRead = reader.read();
  const cancelled = reader.cancel();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  release();
  await expect(cancelled).resolves.toBeUndefined();
  expect((await pendingRead).done).toBe(true);
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { state: "not_found", objectKey: "missing.bin" },
  });
  await expect(iterator.next()).resolves.toMatchObject({ done: true });
});

it("reports a timed-out read under a cancelled body as that timeout, and never reads the timed-out source again", async () => {
  // The source delivers the header and never the body, so the body's read times out after 100 milliseconds.
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(header(found(3)));
    },
  });
  const iterator = (
    await storage(
      async () => new Response(source, { headers: { "content-type": STORAGE_BATCH_CONTENT_TYPE } }),
      100,
    ).readMany({ objectKeys: ["one.bin"] })
  )[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || first.value.state !== "found") throw new Error("Expected a found body");
  const reader = first.value.body.getReader();
  const pendingRead = reader.read();
  // Let the body's source read start before the cancel, so that read is in flight when the cancel arrives.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  await expect(reader.cancel()).rejects.toMatchObject({ code: "gateway_timeout" });
  expect((await pendingRead).done).toBe(true);
  await expect(iterator.next()).rejects.toMatchObject({ code: "gateway_timeout" });
});
