import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createCloudflareR2ObjectTransferProvider } from "./r2-object-transfer-provider.js";

const id = (value: number) => String(value).padStart(26, "0");
const target = {
  bucketName: `ohmyho-${id(10)}-${id(11)}`,
  jurisdiction: "us" as const,
  storageClass: "Standard" as const,
  publicAccess: false as const,
};
const input = {
  target,
  organizationId: id(1),
  projectId: id(10),
  environmentId: id(11),
  dataEnvironmentId: id(12),
  transferId: id(30),
  objectKey: `d/${id(12)}/file.bin`,
};
function provider(fetch: typeof globalThis.fetch) {
  return createCloudflareR2ObjectTransferProvider({
    accountId: "a".repeat(32),
    apiToken: "x".repeat(43),
    parentAccessKeyId: "b".repeat(32),
    now: () => new Date("2026-09-28T12:00:00Z"),
    fetch,
  });
}
function digest(value = input) {
  return createHash("sha256")
    .update(
      [
        "ohmyhost.r2-erasure/v1",
        value.organizationId,
        value.projectId,
        value.environmentId,
        value.dataEnvironmentId,
        value.transferId,
        value.objectKey,
      ].join("\n"),
    )
    .digest();
}
function markerHeaders(headers: Headers) {
  const result = new Headers({
    "content-length": "0",
    "content-type": "application/octet-stream",
    etag: '"d41d8cd98f00b204e9800998ecf8427e"',
    "last-modified": "Mon, 28 Sep 2026 12:00:00 GMT",
  });
  headers.forEach((value, name) => {
    if (name.startsWith("x-amz-meta-")) result.set(name, value);
  });
  return result;
}

it("replaces payload with an exact persistent zero-byte marker and never removes the marker on replay", async () => {
  const calls: string[] = [];
  let stored: Headers | undefined;
  const storage = provider(async (_url, init) => {
    calls.push(init?.method ?? "GET");
    if (init?.method === "PUT") {
      const headers = new Headers(init.headers);
      expect(headers.get("content-length")).toBe("0");
      expect(headers.has("if-none-match")).toBe(false);
      expect(init.body).toBeInstanceOf(Uint8Array);
      expect((init.body as Uint8Array).byteLength).toBe(0);
      stored = markerHeaders(headers);
      return new Response(null, {
        status: 200,
        headers: { etag: '"d41d8cd98f00b204e9800998ecf8427e"' },
      });
    }
    if (!stored) throw new Error("Marker was not stored");
    return new Response(null, { status: 200, headers: stored });
  });
  const erased = await storage.erasePayload(input);
  expect(erased).toMatchObject({
    status: "erased",
    objectKey: input.objectKey,
    transferId: input.transferId,
  });
  expect([...erased.markerSha256]).toEqual([...digest()]);
  expect(stored?.get("x-amz-meta-ohmyhost-deletion-barrier")).toBe("1");
  expect(stored?.get("x-amz-meta-ohmyhost-scope-sha256")).toBe(digest().toString("hex"));
  expect(await storage.erasePayload(input)).toMatchObject({ status: "erased" });
  expect(calls).toEqual(["PUT", "HEAD", "PUT", "HEAD"]);
});

it("recovers a lost marker PUT response only from exact zero-byte scope metadata", async () => {
  for (const mutation of [
    null,
    "wrong_hash",
    "wrong_scope",
    "wrong_version",
    "wrong_length",
    "absent",
  ] as const) {
    let stored: Headers | undefined;
    const storage = provider(async (_url, init) => {
      if (init?.method === "PUT") {
        stored = markerHeaders(new Headers(init.headers));
        if (mutation === "wrong_hash")
          stored.set("x-amz-meta-ohmyhost-scope-sha256", "f".repeat(64));
        if (mutation === "wrong_scope")
          stored.set("x-amz-meta-ohmyhost-data-environment-id", id(99));
        if (mutation === "wrong_version") stored.set("x-amz-meta-ohmyhost-deletion-barrier", "2");
        if (mutation === "wrong_length") stored.set("content-length", "1");
        throw new Error("Marker PUT response lost");
      }
      return mutation === "absent"
        ? new Response(null, { status: 404 })
        : new Response(null, { status: 200, headers: stored ?? {} });
    });
    if (mutation === null)
      await expect(storage.erasePayload(input)).resolves.toMatchObject({ status: "erased" });
    else
      await expect(storage.erasePayload(input)).rejects.toMatchObject({
        code:
          mutation === "absent"
            ? "cloudflare_r2_transfer_result_uncertain"
            : "cloudflare_r2_transfer_contract_invalid",
      });
  }
  const aborted = new AbortController();
  aborted.abort();
  let started = 0;
  const stopped = provider(async () => {
    started++;
    throw new Error("must not start");
  });
  expect(
    await stopped.erasePayloads(
      {
        target,
        objects: [{ ...input, target: undefined }].map(({ target: _target, ...object }) => {
          expect(_target).toBeUndefined();
          return object;
        }),
      },
      { signal: aborted.signal },
    ),
  ).toEqual([{ status: "pending", objectKey: input.objectKey, transferId: input.transferId }]);
  expect(started).toBe(0);
  const abort = new AbortController();
  let bodyCancelled = false;
  let startedRead: () => void = () => undefined;
  const readStarted = new Promise<void>((resolve) => {
    startedRead = resolve;
  });
  const stalled = provider(async (_url, init) => {
    if (init?.method !== "PUT") throw new Error("aborted PUT cannot admit a new proof");
    return new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          startedRead();
        },
        cancel() {
          bodyCancelled = true;
        },
      }),
      { status: 200 },
    );
  });
  const waiting = stalled.erasePayloads(
    {
      target,
      objects: [{ ...input, target: undefined }].map(({ target: _target, ...object }) => {
        expect(_target).toBeUndefined();
        return object;
      }),
    },
    { signal: abort.signal },
  );
  await readStarted;
  abort.abort();
  expect(
    await Promise.race([
      waiting,
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 200)),
    ]),
  ).toEqual([{ status: "pending", objectKey: input.objectKey, transferId: input.transferId }]);
  expect(bodyCancelled).toBe(true);
});

it("accepts the maximum marker batch with bounded four-job concurrency and validates all scope before IO", async () => {
  const objects = Array.from({ length: 4000 }, (_, index) => ({
    ...input,
    target: undefined,
    transferId: id(1000 + index),
    objectKey: `d/${id(12)}/${index}.bin`,
  }));
  const descriptors = objects.map(({ target: _target, ...object }) => {
    expect(_target).toBeUndefined();
    return object;
  });
  const stored = new Map<string, Headers>();
  let active = 0,
    peak = 0,
    calls = 0;
  const storage = provider(async (url, init) => {
    active++;
    peak = Math.max(peak, active);
    calls++;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const key = decodeURIComponent(new URL(String(url)).pathname);
    const headers =
      init?.method === "PUT" ? markerHeaders(new Headers(init.headers)) : stored.get(key);
    if (init?.method === "PUT" && headers) stored.set(key, headers);
    active--;
    return new Response(null, { status: 200, headers: headers ?? {} });
  });
  const results = await storage.erasePayloads({ target, objects: descriptors });
  expect(results).toHaveLength(4000);
  expect(results.every((result) => result.status === "erased")).toBe(true);
  expect(calls).toBe(8000);
  expect(peak).toBe(4);
  await expect(
    storage.erasePayloads({ target, objects: [...descriptors, descriptors[0]] }),
  ).rejects.toMatchObject({ code: "cloudflare_r2_transfer_input_invalid" });
  await expect(
    storage.erasePayloads({ target, objects: [{ ...descriptors[0], environmentId: id(99) }] }),
  ).rejects.toMatchObject({ code: "cloudflare_r2_transfer_input_invalid" });
  expect(calls).toBe(8000);
}, 60_000);
