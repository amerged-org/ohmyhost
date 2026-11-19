import { expect, it, vi } from "vitest";
import { createCloudflareR2ObjectTransferProvider } from "./r2-object-transfer-provider.js";
import { projectR2BucketTarget } from "./r2-bucket-provider.js";
const project = "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environment = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const target = projectR2BucketTarget(project, environment, "us");
function provider(fetch: typeof globalThis.fetch) {
  return createCloudflareR2ObjectTransferProvider({
    accountId: "a".repeat(32),
    apiToken: "s".repeat(40),
    parentAccessKeyId: "a".repeat(32),
    fetch,
    now: () => new Date("2026-09-28T12:00:00Z"),
  });
}
const key = `d/${environment}/one.bin`;
it("streams the exact private physical locator and handles empty and absent bodies", async () => {
  const requests: { url: string; method: string | undefined }[] = [];
  const read = provider(async (input, init) => {
    requests.push({ url: String(input), method: init?.method });
    return new Response(new Uint8Array([0, 255, 10]), {
      headers: {
        "content-length": "3",
        "content-type": "application/octet-stream",
        etag: `"${"a".repeat(32)}"`,
        "last-modified": "Mon, 28 Sep 2026 12:00:00 GMT",
      },
    });
  });
  const found = await read.readObject({ target, objectKey: key });
  expect(found.state).toBe("found");
  if (found.state === "found")
    expect(new Uint8Array(await new Response(found.body).arrayBuffer())).toEqual(
      new Uint8Array([0, 255, 10]),
    );
  const first = requests[0];
  if (first === undefined) throw new Error("GET request missing");
  expect(new URL(first.url).pathname).toContain(key);
  expect(first.method).toBe("GET");
  expect(
    await provider(async () => new Response(null, { status: 404 })).readObject({
      target,
      objectKey: key,
    }),
  ).toEqual({ state: "absent", objectKey: key });
  const empty = await provider(
    async () =>
      new Response(null, {
        headers: {
          "content-length": "0",
          "content-type": "application/octet-stream",
          etag: `"${"a".repeat(32)}"`,
          "last-modified": "Mon, 28 Sep 2026 12:00:00 GMT",
        },
      }),
  ).readObject({ target, objectKey: key });
  if (empty.state === "found") expect(await new Response(empty.body).text()).toBe("");
  const legacyDeep = Array.from({ length: 16 }, () => "part").join("/");
  const maximumDeep = `${"a/".repeat(255)}aa`;
  for (const objectKey of [
    legacyDeep,
    `d/${environment}/${legacyDeep}`,
    maximumDeep,
    `d/${environment}/${maximumDeep}`,
  ]) {
    await expect(
      read.createTransfer({ target, objectKey, operation: "GET", expiresInSeconds: 60 }),
    ).resolves.toMatchObject({ objectKey });
  }
  for (const objectKey of [
    `${maximumDeep}a`,
    `d/${environment}/${maximumDeep}a`,
    "part/../file",
    "part//file",
  ])
    await expect(
      read.createTransfer({ target, objectKey, operation: "GET", expiresInSeconds: 60 }),
    ).rejects.toMatchObject({ code: "cloudflare_r2_transfer_input_invalid" });
});
it("uses S3 bulk serialization and returns per-key confirmed success or failure", async () => {
  const other = `d/${environment}/two.bin`;
  let serialized = "";
  let calls = 0;
  const storage = provider(async (_input, init) => {
    calls++;
    serialized =
      typeof init?.body === "string"
        ? init.body
        : new TextDecoder().decode(init?.body as Uint8Array);
    return new Response(
      `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Deleted><Key>${key}</Key></Deleted><Error><Key>${other}</Key><Code>InternalError</Code><Message>private provider details</Message></Error></DeleteResult>`,
      { headers: { "content-type": "application/xml" } },
    );
  });
  expect(await storage.deleteObjects({ target, objectKeys: [key, other] })).toEqual([
    { objectKey: key, status: "deleted" },
    { objectKey: other, status: "failed", retryable: true },
  ]);
  expect(calls).toBe(1);
  expect(serialized).toContain(`<Key>${key}</Key>`);
  expect(serialized).toContain(`<Key>${other}</Key>`);
});
it("refuses invalid batches, incomplete provider acknowledgements and uncertain results", async () => {
  const storage = provider(
    async () => new Response("<DeleteResult/>", { headers: { "content-type": "application/xml" } }),
  );
  for (const objectKeys of [
    [],
    [key, key],
    Array.from({ length: 1001 }, (_, index) => `one/${index}`),
    ["../escape"],
  ])
    await expect(storage.deleteObjects({ target, objectKeys })).rejects.toMatchObject({
      code: "cloudflare_r2_transfer_input_invalid",
    });
  await expect(storage.deleteObjects({ target, objectKeys: [key] })).rejects.toMatchObject({
    code: "cloudflare_r2_transfer_contract_invalid",
  });
  await expect(
    provider(async () => {
      throw new Error("lost response");
    }).deleteObjects({ target, objectKeys: [key] }),
  ).rejects.toMatchObject({ code: "cloudflare_r2_transfer_result_uncertain" });
  for (const response of [
    new Response(null, { status: 503 }),
    new Response(new Uint8Array([1]), { headers: { "content-length": "3" } }),
  ])
    await expect(
      provider(async () => response).readObject({ target, objectKey: key }),
    ).rejects.toThrow();
});

it("keeps a found body readable while its bytes keep flowing past the header bound", async () => {
  // Node's AbortSignal.timeout runs on its own clock, so fake timers cannot stand in for the bound. The body runs
  // 12 s, longer than the 10 s header bound, and must still complete: the bound covers only the wait for headers.
  const read = provider(async (_input, init) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = () => {
          sent += 1;
          controller.enqueue(new Uint8Array(4).fill(sent));
          if (sent === 3) controller.close();
          else timers.push(setTimeout(emit, 4_000));
        };
        timers.push(setTimeout(emit, 4_000));
        init?.signal?.addEventListener("abort", () => {
          for (const timer of timers) clearTimeout(timer);
          controller.error(new DOMException("The operation was aborted.", "TimeoutError"));
        });
      },
      cancel() {
        for (const timer of timers) clearTimeout(timer);
      },
    });
    return new Response(body, {
      headers: {
        "content-length": "12",
        "content-type": "application/octet-stream",
        etag: `"${"a".repeat(32)}"`,
        "last-modified": "Mon, 28 Sep 2026 12:00:00 GMT",
      },
    });
  });

  const found = await read.readObject({ target, objectKey: key });
  if (found.state !== "found") throw new Error("object not found");
  expect(new Uint8Array(await new Response(found.body).arrayBuffer()).byteLength).toBe(12);
}, 30_000);

it("gives up waiting for headers after the bound and reports the read uncertain", async () => {
  vi.useFakeTimers();
  try {
    let requested: () => void = () => undefined;
    const sent = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const read = provider(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          requested();
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );
    const outcome = read.readObject({ target, objectKey: key }).then(
      () => "completed",
      (error: unknown) => (error instanceof Error ? error.name : "other"),
    );
    await sent;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe("CloudflareR2TransferUncertainError");
  } finally {
    vi.useRealTimers();
  }
});
