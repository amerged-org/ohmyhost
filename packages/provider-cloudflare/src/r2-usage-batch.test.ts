import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createR2UsageProvider } from "./r2-usage-provider.js";

const accountId = "a".repeat(32);
const apiToken = "private-test-token-value";
const bucket = (n: number) =>
  `ohmyho-${String(n).padStart(26, "0")}-${String(n + 100).padStart(26, "0")}`;
const from = "2026-09-08T00:00:00.000Z";
const to = "2026-09-09T00:00:00.000Z";
const buckets = [
  { bucketName: bucket(1), jurisdiction: "eu" as const },
  { bucketName: bucket(1), jurisdiction: "us" as const },
];
type Body = { query: string; variables: Record<string, string | number> };
const payload = (storage: unknown[] = [], operations: unknown[] = []) => ({
  data: { viewer: { accounts: [{ storage, operations }] } },
  errors: null,
});
const storage = (name: string, size = 1) => ({
  dimensions: { bucketName: name, date: "2026-09-08", storageClass: "Standard" },
  max: { payloadSize: size },
});
const operation = (name: string, requests = 4) => ({
  dimensions: {
    bucketName: name,
    datetimeHour: "2026-09-08T00:00:00Z",
    storageClass: "Standard",
    actionType: "PutObject",
    actionStatus: "success",
  },
  sum: { requests },
  confidence: {
    sum: {
      requests: { estimate: requests, sampleSize: requests, lower: requests, upper: requests },
    },
  },
});
const json = (response: ServerResponse, value: unknown) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

function must<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("Expected fixture value");
  return value;
}

async function http<Result>(
  handler: (request: IncomingMessage, response: ServerResponse, body: Body) => void,
  work: (fetch: typeof globalThis.fetch, requests: Body[]) => Promise<Result>,
) {
  const requests: Body[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const chunk of request) parts.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(parts).toString()) as Body;
    requests.push(body);
    handler(request, response, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  const fetch: typeof globalThis.fetch = async function (this: typeof globalThis, url, init) {
    expect(this).toBe(globalThis);
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("x-rate-limit-type")).toBe("account-based");
    return globalThis.fetch(`http://127.0.0.1:${String(address.port)}/`, init);
  };
  try {
    return await work(fetch, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it("queries one account with bounded parameterized OR buckets and preserves empty scopes and single-bucket output", async () => {
  await http(
    (_request, response) =>
      json(response, payload([storage(`eu_${bucket(1)}`, 1000)], [operation(`us_${bucket(1)}`)])),
    async (fetch, requests) => {
      const reader = createR2UsageProvider({ accountId, apiToken, fetch });
      const result = await reader.readUsageBatch({ buckets, from, to });
      expect(
        result.map((item) => [item.bucketName, item.jurisdiction, item.records.length]),
      ).toEqual([
        [bucket(1), "eu", 1],
        [bucket(1), "us", 1],
      ]);
      expect(result[0]?.records[0]).toMatchObject({
        meter: "r2.storage.observed",
        quantity: "1000",
        exact: false,
      });
      expect(result[1]?.records[0]).toMatchObject({
        meter: "r2.class_a",
        quantity: "4",
        exact: true,
      });
      const body = must(requests[0]);
      expect(body.query.match(/accounts\(/gu)).toHaveLength(1);
      expect(body.query).toContain("OR: [{ bucketName: $bucket0 }, { bucketName: $bucket1 }]");
      expect(body.query).not.toContain("bucketName_in");
      expect(body.query).not.toContain(bucket(1));
      expect(body.query).not.toContain(apiToken);
      expect(body.variables).toMatchObject({
        account: accountId,
        bucket0: `eu_${bucket(1)}`,
        bucket1: `us_${bucket(1)}`,
        from,
        to,
      });
    },
  );
  await http(
    (_request, response) => json(response, payload()),
    async (fetch, requests) => {
      const reader = createR2UsageProvider({ accountId, apiToken, fetch });
      const requested = Array.from({ length: 25 }, (_, index) => ({
        bucketName: bucket(index + 1),
        jurisdiction: "eu" as const,
      }));
      expect(await reader.readUsageBatch({ buckets: requested, from, to })).toEqual(
        requested.map((scope) => ({ ...scope, records: [] })),
      );
      expect(await reader.readUsage({ ...must(buckets[0]), from, to })).toEqual([]);
      expect(requests[1]?.variables["bucket"]).toBe(`eu_${bucket(1)}`);
      for (const invalid of [
        [],
        [...requested, must(requested[0])],
        [must(buckets[0]), must(buckets[0])],
        [{ bucketName: "foreign", jurisdiction: "eu" }],
      ]) {
        await expect(
          reader.readUsageBatch({ buckets: invalid as typeof buckets, from, to }),
        ).rejects.toThrow("R2 usage input is invalid");
      }
      expect(requests).toHaveLength(2);
    },
  );
});

it("rejects foreign, duplicate, invalid, partial and truncated captures, with typed capacity and rate-limit outcomes", async () => {
  let reply: unknown = payload();
  let status = 200;
  let retryAfter: string | undefined;
  await http(
    (_request, response) => {
      response.writeHead(status, {
        "content-type": "application/json",
        ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
      });
      response.end(typeof reply === "string" ? reply : JSON.stringify(reply));
    },
    async (fetch, requests) => {
      const reader = createR2UsageProvider({ accountId, apiToken, fetch });
      const read = () => reader.readUsageBatch({ buckets, from, to });
      const invalid = [
        payload([
          {
            ...storage(`eu_${bucket(1)}`),
            dimensions: {
              ...storage("").dimensions,
              bucketName: `eu_${bucket(1)}`,
              date: "2026-02-31",
            },
          },
        ]),
        payload(
          [],
          [
            {
              ...operation(`eu_${bucket(1)}`, -1),
              dimensions: {
                ...operation("").dimensions,
                bucketName: `eu_${bucket(1)}`,
                actionType: "DeleteObject",
              },
            },
          ],
        ),
        payload([storage("foreign")]),
        payload([], [operation(`eu_${bucket(2)}`)]),
        payload([storage(`eu_${bucket(1)}`), storage(`eu_${bucket(1)}`)]),
        payload([], [operation(`eu_${bucket(1)}`), operation(`eu_${bucket(1)}`)]),
        payload([storage(`eu_${bucket(1)}`, -1)]),
        payload([], [operation(`eu_${bucket(1)}`, 1.5)]),
        payload(
          [],
          [
            {
              ...operation(`eu_${bucket(1)}`),
              dimensions: {
                ...operation("").dimensions,
                bucketName: `eu_${bucket(1)}`,
                datetimeHour: "2026-09-07T00:00:00Z",
              },
            },
          ],
        ),
        { ...payload(), errors: [{ message: "private-provider-detail" }] },
        { data: { viewer: { accounts: [] } } },
        "private-non-json",
      ];
      for (reply of invalid) await expect(read()).rejects.toThrow("R2 usage response is invalid");
      reply = payload(new Array(10000).fill(storage(`eu_${bucket(1)}`)));
      await expect(read()).rejects.toMatchObject({
        code: "r2_usage_capacity",
        reason: "row_limit",
      });
      reply = payload([], [operation(`eu_${bucket(1)}`), operation(`us_${bucket(1)}`)]);
      const smaller = createR2UsageProvider({
        accountId,
        apiToken,
        fetch,
        limits: { maxPageSize: 2, maxDurationSeconds: 86400 },
      });
      await expect(smaller.readUsageBatch({ buckets, from, to })).rejects.toMatchObject({
        code: "r2_usage_capacity",
        reason: "row_limit",
      });
      expect(requests.at(-1)?.query).toContain("limit: 2");
      await expect(
        smaller.readUsageBatch({ buckets, from, to: "2026-09-10T00:00:00.000Z" }),
      ).rejects.toMatchObject({ code: "r2_usage_capacity", reason: "time_window" });
      status = 429;
      retryAfter = "37";
      reply = "private-rate-limit-detail";
      await expect(read()).rejects.toMatchObject({
        code: "r2_usage_rate_limited",
        status: 429,
        retryAfterSeconds: 37,
      });
      retryAfter = "not-a-date";
      await expect(read()).rejects.toMatchObject({ retryAfterSeconds: null });
      retryAfter = new Date(Date.now() + 60000).toUTCString();
      const beforeRetry = requests.length;
      await expect(read()).rejects.toMatchObject({ code: "r2_usage_rate_limited" });
      expect(requests).toHaveLength(beforeRetry + 1);
      status = 200;
      retryAfter = "7";
      reply = {
        errors: [
          { message: "rate limiter budget exceeded", extensions: { code: "too_many_requests" } },
        ],
        data: null,
      };
      await expect(read()).rejects.toMatchObject({
        code: "r2_usage_rate_limited",
        retryAfterSeconds: 7,
      });
    },
  );
});

it("bounds streamed bytes, body stalls and outer deadlines without waiting for uncooperative cancellation", async () => {
  let mode = "oversize";
  await http(
    (_request, response) => {
      if (mode === "no-headers") return;
      response.writeHead(mode === "bad-status" ? 503 : 200, { "content-type": "application/json" });
      response.flushHeaders();
      if (mode === "oversize") {
        response.write(" ".repeat(2 * 1024 * 1024));
        response.end(" ".repeat(2 * 1024 * 1024 + 1));
      }
      if (mode === "valid-chunks") {
        const text = JSON.stringify(payload());
        response.write(text.slice(0, 20));
        response.end(text.slice(20));
      }
    },
    async (fetch) => {
      const reader = createR2UsageProvider({ accountId, apiToken, fetch });
      await expect(reader.readUsageBatch({ buckets, from, to })).rejects.toMatchObject({
        code: "r2_usage_capacity",
        reason: "body_limit",
      });
      mode = "valid-chunks";
      expect(await reader.readUsageBatch({ buckets, from, to })).toHaveLength(2);
      for (mode of ["stall", "no-headers", "bad-status"]) {
        const start = performance.now();
        await expect(
          reader.readUsageBatch({ buckets, from, to, signal: AbortSignal.timeout(75) }),
        ).rejects.toThrow();
        expect(performance.now() - start).toBeLessThan(1000);
      }
      mode = "stall";
      const realTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(40));
      try {
        await expect(reader.readUsageBatch({ buckets, from, to })).rejects.toThrow();
        expect(timeout).toHaveBeenCalledWith(15000);
      } finally {
        timeout.mockRestore();
      }
    },
  );
  // An injected transport may ignore AbortSignal or expose a cancel() that never settles.
  let canceled = 0;
  const late: typeof globalThis.fetch = async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return new Response(
      new ReadableStream({
        cancel() {
          canceled++;
          throw new Error("private-cancel-detail");
        },
      }),
    );
  };
  await expect(
    createR2UsageProvider({ accountId, apiToken, fetch: late }).readUsageBatch({
      buckets,
      from,
      to,
      signal: AbortSignal.timeout(20),
    }),
  ).rejects.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(canceled).toBe(1);
  const hanging: typeof globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel() {
          return new Promise(() => undefined);
        },
      }),
    );
  const start = performance.now();
  await expect(
    createR2UsageProvider({ accountId, apiToken, fetch: hanging }).readUsageBatch({
      buckets,
      from,
      to,
    }),
  ).rejects.toMatchObject({ reason: "body_limit" });
  expect(performance.now() - start).toBeLessThan(1000);
});
