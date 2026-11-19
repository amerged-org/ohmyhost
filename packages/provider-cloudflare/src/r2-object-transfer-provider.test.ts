import { describe, expect, it, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";

import {
  CloudflareR2TransferContractError,
  CloudflareR2TransferInputError,
  CloudflareR2TransferRejectedError,
  CloudflareR2TransferUncertainError,
  createCloudflareR2ObjectTransferProvider,
  projectR2BucketTarget,
} from "./index.js";

const ACCOUNT_ID = "00000000000000000000000000000001";
const API_TOKEN = `token-${"x".repeat(32)}`;
const PARENT_ACCESS_KEY_ID = "a".repeat(32);
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NOW = new Date("2026-08-24T12:00:00.000Z");
const target = projectR2BucketTarget(PROJECT_ID, ENVIRONMENT_ID, "us");
function setup(fetch = vi.fn<typeof globalThis.fetch>()) {
  return {
    fetch,
    provider: createCloudflareR2ObjectTransferProvider({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      parentAccessKeyId: PARENT_ACCESS_KEY_ID,
      fetch,
      now: () => NOW,
    }),
  };
}

describe("Cloudflare R2 object transfer provider", () => {
  it("returns a short-lived PUT signature bound to method, key, length and create-only headers", async () => {
    const { provider, fetch } = setup();
    const result = await provider.createTransfer({
      target,
      objectKey: "uploads/user-123/photo.png",
      operation: "PUT",
      expiresInSeconds: 300,
      contentLength: 12345,
      contentType: "image/png",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      operation: "PUT",
      objectKey: "uploads/user-123/photo.png",
      expiresAt: new Date("2026-08-24T12:05:00.000Z"),
      expectedContentLength: 12345,
      requiredHeaders: {
        "content-length": "12345",
        "content-type": "image/png",
        "if-none-match": "*",
      },
    });
    const url = new URL(result.url);
    expect(url.origin).toBe(`https://${ACCOUNT_ID}.us.r2.cloudflarestorage.com`);
    expect(decodeURIComponent(url.pathname)).toBe(
      `/${target.bucketName}/uploads/user-123/photo.png`,
    );
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260824T120000Z");
    expect(url.searchParams.has("X-Amz-Security-Token")).toBe(false);
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host;if-none-match",
    );
    const signature = url.searchParams.get("X-Amz-Signature");
    expect(independentSignature(url, "PUT", result.requiredHeaders)).toBe(signature);
    const otherKey = new URL(url);
    otherKey.pathname += "-other";
    const later = new URL(url);
    later.searchParams.set("X-Amz-Expires", "600");
    for (const [changed, method, headers] of [
      [url, "DELETE", result.requiredHeaders],
      [url, "PUT", { ...result.requiredHeaders, "content-length": "12346" }],
      [url, "PUT", { ...result.requiredHeaders, "content-type": "application/octet-stream" }],
      [url, "PUT", { "content-length": "12345", "content-type": "image/png" }],
      [url, "PUT", { ...result.requiredHeaders, "if-none-match": "other" }],
      [otherKey, "PUT", result.requiredHeaders],
      [later, "PUT", result.requiredHeaders],
    ] as const)
      expect(independentSignature(changed, method, headers)).not.toBe(signature);
    expect(JSON.stringify(result)).not.toContain(API_TOKEN);
    expect(JSON.stringify(result)).not.toContain(
      createHash("sha256").update(API_TOKEN).digest("hex"),
    );
    expect(result).not.toHaveProperty("sessionToken");
    const before = Date.now();
    const current = await createCloudflareR2ObjectTransferProvider({
      accountId: ACCOUNT_ID,
      apiToken: API_TOKEN,
      parentAccessKeyId: PARENT_ACCESS_KEY_ID,
      fetch: globalThis.fetch,
    }).createTransfer({
      target,
      objectKey: "uploads/current.bin",
      operation: "PUT",
      expiresInSeconds: 300,
      contentLength: 1,
      contentType: "application/octet-stream",
    });
    expect(current.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(current.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 300_000);
    const currentUrl = new URL(current.url);
    expect(independentSignature(currentUrl, "PUT", current.requiredHeaders)).toBe(
      currentUrl.searchParams.get("X-Amz-Signature"),
    );
  });

  it("returns one exact GET capability without upload headers", async () => {
    const { provider, fetch } = setup();
    await expect(
      provider.createTransfer({
        target,
        objectKey: "exports/report.pdf",
        operation: "GET",
        expiresInSeconds: 60,
      }),
    ).resolves.toMatchObject({
      operation: "GET",
      objectKey: "exports/report.pdf",
      expiresAt: new Date("2026-08-24T12:01:00.000Z"),
      requiredHeaders: {},
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("observes exact immutable object metadata and distinguishes absence", async () => {
    const found = setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            "content-length": "12345",
            "content-type": "image/png",
            etag: '"0123456789abcdef0123456789abcdef"',
            "last-modified": "Mon, 24 Aug 2026 12:04:00 GMT",
          },
        }),
      ),
    );
    await expect(
      found.provider.observeObject({ target, objectKey: "uploads/user-123/photo.png" }),
    ).resolves.toEqual({
      state: "found",
      objectKey: "uploads/user-123/photo.png",
      contentLength: 12_345,
      contentType: "image/png",
      etag: "0123456789abcdef0123456789abcdef",
      uploadedAt: new Date("2026-08-24T12:04:00.000Z"),
    });

    const absent = setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(null, { status: 404 })),
    );
    await expect(
      absent.provider.observeObject({ target, objectKey: "uploads/missing.png" }),
    ).resolves.toEqual({ state: "absent", objectKey: "uploads/missing.png" });
  });

  it("deletes one exact object and reports success only after HEAD absence", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { provider } = setup(fetch);

    await expect(
      provider.deleteObject({ target, objectKey: "uploads/user-123/photo.png" }),
    ).resolves.toEqual({ status: "deleted", objectKey: "uploads/user-123/photo.png" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("HEAD");
  });

  it.each([
    ["transport loss", new TypeError("lost DELETE response")],
    ["provider 5xx", new Response("provider detail", { status: 503 })],
    ["malformed status", new Response("unexpected", { status: 202 })],
  ])("resolves %s only through one exact targeted absence readback", async (_label, outcome) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (outcome instanceof Error) fetch.mockRejectedValueOnce(outcome);
    else fetch.mockResolvedValueOnce(outcome);
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const { provider } = setup(fetch);

    await expect(
      provider.deleteObject({ target, objectKey: "uploads/user-123/photo.png" }),
    ).resolves.toEqual({ status: "deleted", objectKey: "uploads/user-123/photo.png" });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "HEAD")).toHaveLength(1);
  });

  it("keeps a failed DELETE uncertain when targeted readback still finds the object", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response("provider detail", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: {
            "content-length": "1",
            "content-type": "image/png",
            etag: '"0123456789abcdef0123456789abcdef"',
            "last-modified": "Mon, 24 Aug 2026 12:04:00 GMT",
          },
        }),
      );
    const { provider } = setup(fetch);

    await expect(
      provider.deleteObject({ target, objectKey: "uploads/user-123/photo.png" }),
    ).rejects.toBeInstanceOf(CloudflareR2TransferUncertainError);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("signs an exact create-only zero-byte object", async () => {
    const { provider } = setup();
    const result = await provider.createTransfer({
      target,
      objectKey: "uploads/empty.txt",
      operation: "PUT",
      expiresInSeconds: 60,
      contentLength: 0,
      contentType: "text/plain",
    });
    expect(result).toMatchObject({
      operation: "PUT",
      objectKey: "uploads/empty.txt",
      expectedContentLength: 0,
      requiredHeaders: {
        "content-length": "0",
        "content-type": "text/plain",
        "if-none-match": "*",
      },
    });
    const url = new URL(result.url);
    expect(url.searchParams.has("X-Amz-Security-Token")).toBe(false);
    expect(independentSignature(url, "PUT", result.requiredHeaders)).toBe(
      url.searchParams.get("X-Amz-Signature"),
    );
    expect(
      independentSignature(url, "PUT", { ...result.requiredHeaders, "content-length": "1" }),
    ).not.toBe(url.searchParams.get("X-Amz-Signature"));
  });

  it.each([
    {},
    {
      target,
      objectKey: "../escape",
      operation: "GET",
      expiresInSeconds: 60,
    },
    {
      target,
      objectKey: "uploads/file.bin",
      operation: "PUT",
      expiresInSeconds: 301,
      contentLength: 1,
      contentType: "application/octet-stream",
    },
    {
      target,
      objectKey: "uploads/file.bin",
      operation: "PUT",
      expiresInSeconds: 60,
      contentLength: 1_073_741_825,
      contentType: "application/octet-stream",
    },
    {
      target,
      objectKey: "uploads/file.bin",
      operation: "PUT",
      expiresInSeconds: 60,
      contentLength: 1,
      contentType: "text/plain; charset=utf-8",
    },
    {
      target: { ...target, publicAccess: true },
      objectKey: "uploads/file.bin",
      operation: "GET",
      expiresInSeconds: 60,
    },
  ])("rejects unsafe transfer input before credential minting %#", async (input) => {
    const { provider, fetch } = setup();
    await expect(provider.createTransfer(input)).rejects.toBeInstanceOf(
      CloudflareR2TransferInputError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns redacted typed provider failures", async () => {
    const rejected = setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 403 })),
    );
    await expect(
      rejected.provider.deleteObject({ target, objectKey: "exports/report.pdf" }),
    ).rejects.toBeInstanceOf(CloudflareR2TransferRejectedError);

    const unavailable = setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(
      unavailable.provider.observeObject({ target, objectKey: "exports/report.pdf" }),
    ).rejects.toBeInstanceOf(CloudflareR2TransferUncertainError);

    const malformed = setup(
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 })),
    );
    await expect(
      malformed.provider.observeObject({ target, objectKey: "exports/report.pdf" }),
    ).rejects.toBeInstanceOf(CloudflareR2TransferContractError);

    const uncertain = setup(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("leak")));
    await expect(
      uncertain.provider.observeObject({ target, objectKey: "exports/report.pdf" }),
    ).rejects.toBeInstanceOf(CloudflareR2TransferUncertainError);
    for (const error of [
      new CloudflareR2TransferRejectedError(),
      new CloudflareR2TransferContractError(),
      new CloudflareR2TransferUncertainError(),
    ]) {
      expect(error.message).not.toMatch(/provider detail|leak|session-|token-/u);
    }
  });
});

// Independent SigV4 verification with Node HMAC, not the SDK presigner under test.
function independentSignature(
  url: URL,
  method: string,
  headers: Readonly<Record<string, string>>,
): string {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(
      /[!'()*]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const query = [...url.searchParams]
    .filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, value]) => [encode(key), encode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey
        ? -1
        : leftKey > rightKey
          ? 1
          : leftValue < rightValue
            ? -1
            : leftValue > rightValue
              ? 1
              : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const signed = url.searchParams.get("X-Amz-SignedHeaders") ?? "";
  const canonicalHeaders = signed
    .split(";")
    .map(
      (name) =>
        `${name}:${name === "host" ? url.host : (headers[name] ?? "").trim().replace(/\s+/gu, " ")}\n`,
    )
    .join("");
  const canonical = [
    method,
    url.pathname,
    query,
    canonicalHeaders,
    signed,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const credential = (url.searchParams.get("X-Amz-Credential") ?? "").split("/");
  const scope = credential.slice(1).join("/");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    url.searchParams.get("X-Amz-Date"),
    scope,
    createHash("sha256").update(canonical).digest("hex"),
  ].join("\n");
  let key: Buffer = Buffer.from(`AWS4${createHash("sha256").update(API_TOKEN).digest("hex")}`);
  for (const component of credential.slice(1))
    key = createHmac("sha256", key).update(component).digest();
  return createHmac("sha256", key).update(stringToSign).digest("hex");
}
