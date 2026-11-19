import { describe, expect, it, vi } from "vitest";

import {
  CloudflareR2BucketContractError,
  CloudflareR2BucketInputError,
  CloudflareR2BucketQuotaExceededError,
  CloudflareR2BucketRejectedError,
  CloudflareR2BucketReceiptMismatchError,
  CloudflareR2BucketUncertainError,
  createCloudflareR2BucketProvider,
  projectR2BucketTarget,
} from "./r2-bucket-provider.js";

const ACCOUNT_ID = "00000000000000000000000000000001";
const PROJECT_ID = "01arz3ndektsv4rrffq69g5fav";
const ENVIRONMENT_ID = "01arz3ndektsv4rrffq69g5faw";
const TARGET = projectR2BucketTarget(PROJECT_ID, ENVIRONMENT_ID, "eu");
const BUCKET_ID = "0113a9e4549cf9b1ff1bf56e04da0cef";
const DELETE_RECEIPT = {
  ...TARGET,
  bucketId: BUCKET_ID,
  observedAt: new Date("2026-08-24T20:00:00.000Z"),
} as const;
const OBSERVED_AT = new Date("2026-08-24T18:00:00.000Z");

function success(result: unknown): Response {
  return Response.json({ success: true, errors: [], messages: [], result });
}

function absent(): Response {
  return Response.json(
    {
      success: false,
      errors: [{ code: 10006, message: "Bucket not found" }],
      messages: [],
      result: null,
    },
    { status: 404 },
  );
}

function objectAbsent(): Response {
  return Response.json(
    {
      success: false,
      errors: [{ code: 10007, message: "Object not found" }],
      messages: [],
      result: null,
    },
    { status: 404 },
  );
}

function rateLimited(): Response {
  return Response.json(
    {
      success: false,
      errors: [{ code: 10000, message: "Rate limited" }],
      messages: [],
      result: null,
    },
    { status: 429, headers: { "retry-after": "60" } },
  );
}

function objectPage(
  objects: readonly Readonly<{ key: string; size: number }>[],
  options: { cursor?: string; truncated?: boolean } = {},
): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: objects.map((object) => ({
      ...object,
      etag: "d41d8cd98f00b204e9800998ecf8427e",
      uploaded: "2026-08-24T20:00:00.000Z",
      storage_class: "Standard",
    })),
    result_info: {
      cursor: options.cursor,
      is_truncated: options.truncated ?? false,
      per_page: 100,
    },
  });
}

function bucket() {
  return {
    name: TARGET.bucketName,
    jurisdiction: "eu",
    storage_class: "Standard",
    location: "weur",
    creation_date: "2026-08-24T17:55:00.000Z",
  };
}

function managedDomain(bucketId = BUCKET_ID, enabled = false) {
  return {
    bucketId,
    domain: `pub-${bucketId}.r2.dev`,
    enabled,
  };
}

function provider(fetch: typeof globalThis.fetch) {
  return createCloudflareR2BucketProvider({
    accountId: ACCOUNT_ID,
    apiToken: "token-" + "x".repeat(32),
    fetch,
    now: () => OBSERVED_AT,
  });
}

describe("Cloudflare project R2 bucket provider", () => {
  it("derives one stable EU-private bucket target per project environment", () => {
    expect(TARGET).toEqual({
      bucketName: `ohmyho-${PROJECT_ID}-${ENVIRONMENT_ID}`,
      jurisdiction: "eu",
      storageClass: "Standard",
      publicAccess: false,
    });
    expect(TARGET.bucketName).toHaveLength(60);
    expect(
      projectR2BucketTarget(PROJECT_ID.toUpperCase(), ENVIRONMENT_ID.toUpperCase(), "eu"),
    ).toEqual(TARGET);
    expect(() => projectR2BucketTarget("not-a-project", ENVIRONMENT_ID, "eu")).toThrow(
      CloudflareR2BucketInputError,
    );
  });

  it("observes exact private bucket state without mutating Cloudflare", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }));

    await expect(provider(fetch).observeBucket(TARGET)).resolves.toEqual({
      state: "found",
      bucketName: TARGET.bucketName,
      bucketId: BUCKET_ID,
      jurisdiction: "eu",
      storageClass: "Standard",
      publicAccess: false,
      observedAt: OBSERVED_AT,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(fetch.mock.calls.every(([, init]) => init?.headers instanceof Headers)).toBe(true);
    for (const [, init] of fetch.mock.calls) {
      const headers = init?.headers as Headers;
      expect(headers.get("authorization")).toBe("Bearer token-" + "x".repeat(32));
      expect(headers.get("cf-r2-jurisdiction")).toBe("eu");
    }
    const wallStart = Date.now();
    const defaults = [success(bucket()), success(managedDomain()), success({ domains: [] })];
    const observed = await createCloudflareR2BucketProvider({
      accountId: ACCOUNT_ID,
      apiToken: "token-" + "x".repeat(32),
      fetch: async () => {
        const response = defaults.shift();
        if (!response) throw new Error("Unexpected private-bucket request");
        return response;
      },
    }).observeBucket(TARGET);
    expect(observed.state).toBe("found");
    if (observed.state !== "found") throw new Error("Expected private bucket observation");
    expect(observed.bucketId).toBe(BUCKET_ID);
    expect(observed.publicAccess).toBe(false);
    expect(observed.observedAt.getTime()).toBeGreaterThanOrEqual(wallStart);
    expect(observed.observedAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("returns explicit absence after one strict bucket lookup", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(absent());

    await expect(provider(fetch).observeBucket(TARGET)).resolves.toEqual({
      state: "absent",
      bucketName: TARGET.bucketName,
      jurisdiction: "eu",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects another or ambiguous 404 instead of inventing bucket absence", async () => {
    const other = provider(vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(objectAbsent()));
    const ambiguous = provider(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            errors: [
              { code: 10006, message: "Bucket not found" },
              { code: 10007, message: "Object not found" },
            ],
            messages: [],
            result: null,
          },
          { status: 404 },
        ),
      ),
    );

    await expect(other.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketContractError,
    );
    await expect(ambiguous.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketContractError,
    );
  });

  it("reuses exact existing state and never sends a create request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }));

    await expect(provider(fetch).ensureBucket(TARGET)).resolves.toMatchObject({
      outcome: "existing",
      receipt: { bucketName: TARGET.bucketName, bucketId: BUCKET_ID },
    });
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it.each(["eu", "us"] as const)(
    "creates an absent %s bucket and requires exact private readback",
    async (jurisdiction) => {
      const target = projectR2BucketTarget(PROJECT_ID, ENVIRONMENT_ID, jurisdiction);
      const observedBucket = {
        ...bucket(),
        jurisdiction,
        location: jurisdiction === "us" ? "enam" : "weur",
      };
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(absent())
        .mockResolvedValueOnce(success(observedBucket))
        .mockResolvedValueOnce(success(observedBucket))
        .mockResolvedValueOnce(success(managedDomain()))
        .mockResolvedValueOnce(success({ domains: [] }));

      await expect(provider(fetch).ensureBucket(target)).resolves.toMatchObject({
        outcome: "created",
        receipt: { bucketName: target.bucketName, jurisdiction, publicAccess: false },
      });
      const [url, init] = fetch.mock.calls[1] ?? [];
      expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/r2/buckets`);
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      const headers = init?.headers as Headers;
      expect(headers.get("cf-r2-jurisdiction")).toBe(jurisdiction);
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: TARGET.bucketName,
        storageClass: "Standard",
        locationHint: jurisdiction === "us" ? "enam" : "weur",
      });
    },
  );

  it("recovers a lost create response only through exact readback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(absent())
      .mockRejectedValueOnce(new TypeError("credential-bearing transport detail"))
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }));

    await expect(provider(fetch).ensureBucket(TARGET)).resolves.toMatchObject({
      outcome: "recovered",
      receipt: { bucketId: BUCKET_ID },
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("creates from the absence it was given, so no read can follow the create authorization", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }));
    const observed = {
      state: "absent" as const,
      bucketName: TARGET.bucketName,
      jurisdiction: "eu" as const,
    };

    await expect(provider(fetch).ensureBucket(TARGET, observed)).resolves.toMatchObject({
      outcome: "created",
    });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
    // the POST, then exactly the readback of the created bucket: no request before it
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("reuses a found bucket it was given without any request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const observed = {
      state: "found" as const,
      bucketName: TARGET.bucketName,
      jurisdiction: "eu" as const,
      bucketId: BUCKET_ID,
      storageClass: "Standard" as const,
      publicAccess: false as const,
      observedAt: OBSERVED_AT,
    };

    await expect(provider(fetch).ensureBucket(TARGET, observed)).resolves.toMatchObject({
      outcome: "existing",
      receipt: { bucketId: BUCKET_ID },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps an unobserved create result uncertain and never retries the mutation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(absent())
      .mockRejectedValueOnce(new TypeError("provider transport failed"))
      .mockResolvedValueOnce(absent());

    await expect(provider(fetch).ensureBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketUncertainError,
    );
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("fails closed on public access, custom domains, bucket drift, and malformed envelopes", async () => {
    const runtime = provider(
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(success(bucket()))
        .mockResolvedValueOnce(success(managedDomain(BUCKET_ID, true)))
        .mockResolvedValueOnce(success(bucket()))
        .mockResolvedValueOnce(success(managedDomain()))
        .mockResolvedValueOnce(
          success({ domains: [{ domain: "files.example.com", enabled: false }] }),
        )
        .mockResolvedValueOnce(success({ ...bucket(), jurisdiction: "default" }))
        .mockResolvedValueOnce(Response.json({ success: true, result: bucket() })),
    );

    await expect(runtime.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketContractError,
    );
    await expect(runtime.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketContractError,
    );
    await expect(runtime.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketContractError,
    );
    await expect(runtime.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketContractError,
    );
  });

  it("separates rejected requests from uncertain transport without leaking provider details", async () => {
    const rejected = provider(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            success: false,
            errors: [{ code: 9109, message: "secret provider detail" }],
            messages: [],
            result: null,
          },
          { status: 403 },
        ),
      ),
    );
    const uncertain = provider(
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("secret transport detail")),
    );

    await expect(rejected.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketRejectedError,
    );
    await expect(uncertain.observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketUncertainError,
    );
    await expect(rejected.observeBucket(TARGET)).rejects.not.toThrow("secret provider detail");
  });

  it("purges a multi-page exact inventory, reports bytes, and confirms bucket absence", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }))
      .mockResolvedValueOnce(
        objectPage([{ key: "tenant/a.txt", size: 5 }], { cursor: "next", truncated: true }),
      )
      .mockResolvedValueOnce(success({ key: "tenant/a.txt" }))
      .mockResolvedValueOnce(objectPage([{ key: "tenant/b.txt", size: 7 }]))
      .mockResolvedValueOnce(success({ key: "tenant/b.txt" }))
      .mockResolvedValueOnce(objectPage([]))
      .mockResolvedValueOnce(success({}))
      .mockResolvedValueOnce(absent());

    await expect(provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT)).resolves.toEqual({
      outcome: "deleted",
      bucketName: TARGET.bucketName,
      objectCount: 2,
      bytes: 12,
    });
    expect(String(fetch.mock.calls[3]?.[0])).toContain("/objects?per_page=100");
    expect(String(fetch.mock.calls[5]?.[0])).toContain("/objects?per_page=100");
    expect(String(fetch.mock.calls[5]?.[0])).not.toContain("cursor=");
  });

  it("purges a full page of platform objects whose listing is larger than 64 KiB", async () => {
    const stored = Array.from({ length: 100 }, (_, index) => ({
      key: `d/01M5NCS9D1ND1V77FXA79D9CEH/gateway-canary/${String(index).padStart(20, "0")}`,
      etag: "d41d8cd98f00b204e9800998ecf8427e",
      last_modified: "2026-10-24T00:04:02.441Z",
      size: 34,
      http_metadata: { cacheControl: "no-store", contentType: "application/octet-stream" },
      custom_metadata: {
        "ohmyhost-data-environment-id": "01M5NCS9D1ND1V77FXA79D9CEH",
        "ohmyhost-deletion-barrier": "1",
        "ohmyhost-organization-id": "01M2VCTZ2VPRDFSJMKA3Q5Y8AX",
        "ohmyhost-origin-environment-id": "01M5NCS9D1ND1V77FXA79D9CEH",
        "ohmyhost-project-id": "01M5NCS9D1ND1V77FXA79D9CEC",
        "ohmyhost-scope-sha256": "b9fa92e6b8923e1336e02b7a48cd253e7e7a62b3e8ea0374e2269dfc987770cf",
        "ohmyhost-transfer-id": "01M5NG3K0KV6ESX7FFYR5GYC1W",
      },
      storage_class: "Standard",
    }));
    const listing = {
      success: true,
      errors: [],
      messages: [],
      result: stored,
      result_info: { is_truncated: false, per_page: 100 },
    };
    expect(new TextEncoder().encode(JSON.stringify(listing)).byteLength).toBeGreaterThan(64 * 1024);

    const remaining = new Set(stored.map((object) => object.key));
    let bucketDeleted = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (init?.method === "DELETE" && url.includes("/objects/")) {
        const key = (url.split("/objects/")[1] ?? "").split("/").map(decodeURIComponent).join("/");
        remaining.delete(key);
        return success({ key });
      }
      if (init?.method === "DELETE") {
        bucketDeleted = true;
        return success({});
      }
      if (url.includes("/objects?")) {
        return Response.json({ ...listing, result: stored.filter((o) => remaining.has(o.key)) });
      }
      if (bucketDeleted) return absent();
      if (url.endsWith("/domains/managed")) return success(managedDomain());
      if (url.endsWith("/domains/custom")) return success({ domains: [] });
      return success(bucket());
    });

    await expect(provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT)).resolves.toEqual({
      outcome: "deleted",
      bucketName: TARGET.bucketName,
      objectCount: 100,
      bytes: 3_400,
    });
    expect(remaining.size).toBe(0);
  });

  it("keeps a small bound on bucket answers and a larger bound on one object page", async () => {
    // Every answer of the observation is read, so a bucket answer above 64 KiB must fail the
    // observation itself; a single shared response would fail on its second read anyway.
    const oversizedBucket = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success({ ...bucket(), padding: "x".repeat(64 * 1024) }))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }));
    await expect(provider(oversizedBucket).observeBucket(TARGET)).rejects.toBeInstanceOf(
      CloudflareR2BucketContractError,
    );

    const observation = () =>
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(success(bucket()))
        .mockResolvedValueOnce(success(managedDomain()))
        .mockResolvedValueOnce(success({ domains: [] }));
    const emptyPage = { success: true, errors: [], messages: [], result: [] };
    const hugePage = observation().mockResolvedValueOnce(
      Response.json({
        ...emptyPage,
        result_info: { is_truncated: false, per_page: 100, padding: "x".repeat(2 * 1024 * 1024) },
      }),
    );
    const declaredPage = observation().mockResolvedValueOnce(
      new Response(JSON.stringify(emptyPage), {
        headers: { "content-length": String(2 * 1024 * 1024 + 1) },
      }),
    );
    for (const fetch of [hugePage, declaredPage]) {
      await expect(provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT)).rejects.toBeInstanceOf(
        CloudflareR2BucketContractError,
      );
      expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    }
  });

  it("makes repeated deletion safe and purges a zero-byte object", async () => {
    const absentFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(absent());
    await expect(provider(absentFetch).purgeAndDeleteBucket(DELETE_RECEIPT)).resolves.toEqual({
      outcome: "absent",
      bucketName: TARGET.bucketName,
      objectCount: 0,
      bytes: 0,
    });

    const zeroFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }))
      .mockResolvedValueOnce(success([{ key: "empty", size: 0, etag: "etag-empty" }]))
      .mockResolvedValueOnce(success({ key: "empty" }))
      .mockResolvedValueOnce(success([]))
      .mockResolvedValueOnce(success({}))
      .mockResolvedValueOnce(absent());
    await expect(provider(zeroFetch).purgeAndDeleteBucket(DELETE_RECEIPT)).resolves.toMatchObject({
      objectCount: 1,
      bytes: 0,
    });
  });

  it("accepts exactly one GiB and rejects any inventory above quota before mutation", async () => {
    const boundaryFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }))
      .mockResolvedValueOnce(objectPage([{ key: "boundary", size: 1024 ** 3 }]))
      .mockResolvedValueOnce(success({ key: "boundary" }))
      .mockResolvedValueOnce(objectPage([]))
      .mockResolvedValueOnce(success({}))
      .mockResolvedValueOnce(absent());
    await expect(
      provider(boundaryFetch).purgeAndDeleteBucket(DELETE_RECEIPT),
    ).resolves.toMatchObject({
      bytes: 1024 ** 3,
    });

    const overFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }))
      .mockResolvedValueOnce(objectPage([{ key: "over", size: 1024 ** 3 + 1 }]));
    await expect(provider(overFetch).purgeAndDeleteBucket(DELETE_RECEIPT)).rejects.toBeInstanceOf(
      CloudflareR2BucketQuotaExceededError,
    );
    expect(overFetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("re-lists after partial and lost object responses and accepts only confirmed absence", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }))
      .mockResolvedValueOnce(
        objectPage([
          { key: "a", size: 1 },
          { key: "b", size: 2 },
        ]),
      )
      .mockRejectedValueOnce(new TypeError("lost object response"))
      .mockResolvedValueOnce(success({ key: "b" }))
      .mockResolvedValueOnce(objectPage([{ key: "a", size: 1 }]))
      .mockResolvedValueOnce(objectAbsent())
      .mockResolvedValueOnce(objectPage([]))
      .mockRejectedValueOnce(new TypeError("lost bucket response"))
      .mockResolvedValueOnce(absent());

    await expect(provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT)).resolves.toEqual({
      outcome: "deleted",
      bucketName: TARGET.bucketName,
      objectCount: 2,
      bytes: 3,
    });
  });

  it("fails closed on an object page above the listing bound", async () => {
    const oversizedPageFetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain()))
      .mockResolvedValueOnce(success({ domains: [] }))
      .mockResolvedValueOnce(
        objectPage(
          Array.from({ length: 101 }, (_, index) => ({ key: `object-${index}`, size: 0 })),
        ),
      );
    await expect(
      provider(oversizedPageFetch).purgeAndDeleteBucket(DELETE_RECEIPT),
    ).rejects.toBeInstanceOf(CloudflareR2BucketContractError);
  });

  it("purges more objects than one listing names, resuming each pass until the bucket is deleted", async () => {
    const objects = new Map<string, number>(
      Array.from({ length: 10_001 }, (_, index) => [`tenant/object-${index}`, 1]),
    );
    const bucketPath = `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${TARGET.bucketName}`;
    let present = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === bucketPath) {
        if (method === "DELETE") {
          if (objects.size !== 0)
            return Response.json(
              {
                success: false,
                errors: [{ code: 10000, message: "Bucket not empty" }],
                messages: [],
                result: null,
              },
              { status: 409 },
            );
          present = false;
          return success({});
        }
        return present ? success(bucket()) : absent();
      }
      if (url.pathname === `${bucketPath}/domains/managed`) return success(managedDomain());
      if (url.pathname === `${bucketPath}/domains/custom`) return success({ domains: [] });
      if (url.pathname === `${bucketPath}/objects`) {
        const page = [...objects].slice(0, 100).map(([key, size]) => ({ key, size }));
        return objectPage(page, objects.size > 100 ? { cursor: "next", truncated: true } : {});
      }
      const key = decodeURIComponent(url.pathname.slice(`${bucketPath}/objects/`.length));
      objects.delete(key);
      return success({ key });
    });

    let outcome: unknown;
    for (let pass = 1; outcome === undefined; pass += 1) {
      expect(pass).toBeLessThanOrEqual(40);
      try {
        outcome = await provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT);
      } catch (error) {
        expect(error).toBeInstanceOf(CloudflareR2BucketUncertainError);
      }
    }
    expect(outcome).toMatchObject({ outcome: "deleted", bucketName: TARGET.bucketName });
    expect(objects.size).toBe(0);
    expect(present).toBe(false);
  });

  it("stops starting purge passes and delete batches once a call's 100-second time box has passed", async () => {
    let clock = OBSERVED_AT.getTime();
    let listingDurationMilliseconds = 100_000;
    const bucketPath = `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${TARGET.bucketName}`;
    const objects = new Map<string, number>(
      Array.from({ length: 250 }, (_, index) => [`tenant/object-${index}`, 1]),
    );
    let bucketDeletes = 0;
    let present = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === bucketPath) {
        if (method !== "DELETE") return present ? success(bucket()) : absent();
        bucketDeletes += 1;
        present = false;
        return success({});
      }
      if (url.pathname === `${bucketPath}/domains/managed`) return success(managedDomain());
      if (url.pathname === `${bucketPath}/domains/custom`) return success({ domains: [] });
      if (url.pathname === `${bucketPath}/objects`) {
        clock += listingDurationMilliseconds;
        const page = [...objects].slice(0, 100).map(([key, size]) => ({ key, size }));
        return objectPage(page, objects.size > 100 ? { cursor: "next", truncated: true } : {});
      }
      const key = decodeURIComponent(url.pathname.slice(`${bucketPath}/objects/`.length));
      objects.delete(key);
      return success({ key });
    });
    const timed = createCloudflareR2BucketProvider({
      accountId: ACCOUNT_ID,
      apiToken: "token-" + "x".repeat(32),
      fetch,
      now: () => new Date(clock),
    });

    await expect(timed.purgeAndDeleteBucket(DELETE_RECEIPT)).rejects.toBeInstanceOf(
      CloudflareR2BucketUncertainError,
    );
    const listings = fetch.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === `${bucketPath}/objects`,
    );
    expect(listings).toHaveLength(1);
    // The time box passed during that listing, so no delete batch of its page started.
    expect(objects.size).toBe(250);
    expect(bucketDeletes).toBe(0);

    // A retry starts a new time box, resumes from the first listing and deletes the bucket once that listing is empty.
    listingDurationMilliseconds = 0;
    await expect(timed.purgeAndDeleteBucket(DELETE_RECEIPT)).resolves.toEqual({
      outcome: "deleted",
      bucketName: TARGET.bucketName,
      objectCount: 250,
      bytes: 250,
    });
    expect(bucketDeletes).toBe(1);
  });

  it("caps one purge call at its subrequest budget and leaves the rest of the bucket for a retry", async () => {
    const objects = new Map<string, number>(
      Array.from({ length: 2_000 }, (_, index) => [`tenant/object-${index}`, 1]),
    );
    const bucketPath = `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${TARGET.bucketName}`;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === bucketPath) return success(bucket());
      if (url.pathname === `${bucketPath}/domains/managed`) return success(managedDomain());
      if (url.pathname === `${bucketPath}/domains/custom`) return success({ domains: [] });
      if (url.pathname === `${bucketPath}/objects`) {
        const page = [...objects].slice(0, 100).map(([key, size]) => ({ key, size }));
        return objectPage(page, objects.size > 100 ? { cursor: "next", truncated: true } : {});
      }
      const key = decodeURIComponent(url.pathname.slice(`${bucketPath}/objects/`.length));
      objects.delete(key);
      return success({ key });
    });

    await expect(provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT)).rejects.toBeInstanceOf(
      CloudflareR2BucketUncertainError,
    );
    const listings = fetch.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === `${bucketPath}/objects`,
    );
    // Eight passes of one listing and up to 100 deletions fit the 900-request budget next to the bucket reads.
    expect(listings).toHaveLength(8);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(900);
    expect(objects.size).toBe(1_200);
  });

  it("retries a rate-limited object delete on the next listing and stops a call on a rate-limited listing", async () => {
    const bucketPath = `/client/v4/accounts/${ACCOUNT_ID}/r2/buckets/${TARGET.bucketName}`;
    const objects = new Map<string, number>([
      ["tenant/a", 1],
      ["tenant/b", 1],
    ]);
    let present = true;
    let limitedOnce = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.pathname === bucketPath) {
        if (method !== "DELETE") return present ? success(bucket()) : absent();
        present = false;
        return success({});
      }
      if (url.pathname === `${bucketPath}/domains/managed`) return success(managedDomain());
      if (url.pathname === `${bucketPath}/domains/custom`) return success({ domains: [] });
      if (url.pathname === `${bucketPath}/objects`) {
        return objectPage([...objects].map(([key, size]) => ({ key, size })));
      }
      const key = decodeURIComponent(url.pathname.slice(`${bucketPath}/objects/`.length));
      if (key === "tenant/a" && !limitedOnce) {
        limitedOnce = true;
        return rateLimited();
      }
      objects.delete(key);
      return success({ key });
    });

    await expect(provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT)).resolves.toEqual({
      outcome: "deleted",
      bucketName: TARGET.bucketName,
      objectCount: 2,
      bytes: 2,
    });
    expect(objects.size).toBe(0);
    expect(present).toBe(false);

    const limitedListing = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === bucketPath) return success(bucket());
      if (url.pathname === `${bucketPath}/domains/managed`) return success(managedDomain());
      if (url.pathname === `${bucketPath}/domains/custom`) return success({ domains: [] });
      return rateLimited();
    });
    await expect(
      provider(limitedListing).purgeAndDeleteBucket(DELETE_RECEIPT),
    ).rejects.toBeInstanceOf(CloudflareR2BucketUncertainError);
    expect(limitedListing.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("rejects provider bucket identity drift before object listing or deletion", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(success(bucket()))
      .mockResolvedValueOnce(success(managedDomain("1113a9e4549cf9b1ff1bf56e04da0cef")))
      .mockResolvedValueOnce(success({ domains: [] }));

    await expect(provider(fetch).purgeAndDeleteBucket(DELETE_RECEIPT)).rejects.toBeInstanceOf(
      CloudflareR2BucketReceiptMismatchError,
    );
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/objects"))).toBe(false);
  });

  it("rejects invalid dependencies and targets before any provider request", async () => {
    for (const dependencies of [
      { accountId: "bad", apiToken: "token-" + "x".repeat(32), fetch: globalThis.fetch },
      { accountId: ACCOUNT_ID, apiToken: "short", fetch: globalThis.fetch },
      {
        accountId: ACCOUNT_ID,
        apiToken: "token-" + "x".repeat(20) + "\n",
        fetch: globalThis.fetch,
      },
    ]) {
      expect(() => createCloudflareR2BucketProvider(dependencies)).toThrow(
        CloudflareR2BucketInputError,
      );
    }

    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      provider(fetch).observeBucket({ ...TARGET, bucketName: "foreign-bucket" }),
    ).rejects.toBeInstanceOf(CloudflareR2BucketInputError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
