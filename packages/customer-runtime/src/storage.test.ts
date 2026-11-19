import { describe, expect, it, vi } from "vitest";

import { createPrivateStorageClient } from "./storage.js";

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TRANSFER = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const DELETION = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const KEY = "s".repeat(43);
const objectKey = "visits/visit-1/front.png";

const capability = (operation: "GET" | "PUT") => ({
  operation,
  objectKey,
  url: `https://signed.example.test/object?operation=${operation}`,
  expiresAt: "2026-08-24T12:05:00.000Z",
  expectedContentLength: operation === "PUT" ? 3 : null,
  requiredHeaders:
    operation === "PUT"
      ? { "content-length": "3", "content-type": "image/png", "if-none-match": "*" }
      : {},
});

function client(
  fetch: (request: Request) => Promise<Response>,
  capabilityFetch: (request: Request) => Promise<Response> = fetch,
) {
  return createPrivateStorageClient({
    endpoint: "https://storage-gateway.internal",
    key: KEY,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    fetch,
    capabilityFetch,
  });
}

describe("private storage client", () => {
  it("retries a storage 502 transfer rejection and never retries a 400 input error", async () => {
    const rejected = client(async () =>
      Response.json({ code: "cloudflare_r2_transfer_request_rejected" }, { status: 502 }),
    );
    await expect(rejected.createSignedRead(objectKey)).rejects.toMatchObject({
      code: "gateway_unavailable",
      status: 502,
      retryable: true,
    });
    const invalid = client(async () =>
      Response.json({ code: "storage_gateway_input_invalid" }, { status: 400 }),
    );
    await expect(invalid.createSignedRead(objectKey)).rejects.toMatchObject({
      code: "gateway_request_invalid",
      status: 400,
      retryable: false,
    });
  });

  it("reserves, uploads and completes bytes without exposing the gateway key", async () => {
    const gatewayRequests: Request[] = [];
    const capabilityRequests: Request[] = [];
    const gatewayFetch = vi.fn(async (request: Request) => {
      gatewayRequests.push(request);
      if (request.url.endsWith("/v1/uploads")) {
        return Response.json({
          state: "ready",
          transfer_id: TRANSFER,
          capability: capability("PUT"),
        });
      }
      return Response.json({ state: "completed", transfer_id: TRANSFER });
    });
    const capabilityFetch = vi.fn(async (request: Request) => {
      capabilityRequests.push(request);
      return new Response(null, { status: 200 });
    });
    const storage = client(gatewayFetch, capabilityFetch);

    await expect(
      storage.upload({
        idempotencyKey: "upload-1",
        objectKey,
        contentType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual({ state: "completed", transferId: TRANSFER });
    expect(await gatewayRequests[0]?.json()).toEqual({
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      idempotencyKey: "upload-1",
      objectKey,
      contentType: "image/png",
      contentLength: 3,
    });
    expect(gatewayRequests[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(capabilityRequests[0]?.headers.get("authorization")).toBeNull();
    expect(capabilityRequests[0]?.headers.get("if-none-match")).toBe("*");
    expect(capabilityRequests[0]?.headers.get("content-length")).toBe("3");
    expect(capabilityRequests[0]?.headers.get("content-type")).toBe("image/png");
    expect(await capabilityRequests[0]?.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    expect(
      JSON.stringify(
        await storage.reserveUpload({
          idempotencyKey: "upload-1",
          objectKey,
          contentType: "image/png",
          contentLength: 3,
        }),
      ),
    ).not.toContain(KEY);
  });

  it("supports completed replay, pending completion, signed read and idempotent delete", async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (request.url.endsWith("/v1/uploads")) {
        return Response.json({ state: "completed", transfer_id: TRANSFER });
      }
      if (request.url.endsWith("/v1/uploads/complete")) {
        return Response.json({ state: "pending", transfer_id: TRANSFER }, { status: 202 });
      }
      if (request.url.endsWith("/v1/downloads")) {
        return Response.json({ state: "ready", capability: capability("GET") });
      }
      return Response.json({ state: "completed", deletion_id: DELETION });
    });
    const storage = client(fetch);

    await expect(
      storage.reserveUpload({
        idempotencyKey: "upload-replay",
        objectKey,
        contentType: "image/png",
        contentLength: 3,
      }),
    ).resolves.toEqual({ state: "completed", transferId: TRANSFER });
    await expect(storage.completeUpload(TRANSFER)).resolves.toEqual({
      state: "pending",
      transferId: TRANSFER,
    });
    await expect(storage.createSignedRead(objectKey)).resolves.toMatchObject({
      operation: "GET",
      objectKey,
    });
    await expect(storage.deleteObject({ idempotencyKey: "delete-1", objectKey })).resolves.toEqual({
      state: "completed",
      deletionId: DELETION,
    });
  });

  it.each([
    [401, { code: "unauthorized" }, "unauthorized"],
    [404, { code: "object_not_found" }, "storage_object_not_found"],
    [409, { code: "upload_expired", transfer_id: TRANSFER }, "storage_upload_expired"],
    [409, { code: "storage_gateway_conflict" }, "storage_conflict"],
    [409, { code: "data_change_in_progress" }, "data_change_in_progress"],
    [409, { code: "storage_binding_data_changed" }, "storage_binding_data_changed"],
    [
      409,
      { code: "storage_delete_pending", retry_at: "2026-09-28T12:05:30.000Z" },
      "storage_delete_pending",
    ],
    [413, { code: "storage_gateway_quota_exceeded" }, "storage_quota_exceeded"],
    [503, { code: "storage_gateway_unavailable" }, "gateway_unavailable"],
    [400, { code: "storage_gateway_input_invalid" }, "gateway_request_invalid"],
    [502, { code: "cloudflare_r2_transfer_request_rejected" }, "gateway_unavailable"],
  ])("maps storage gateway status %i to %s", async (status, body, code) => {
    const storage = client(async () => Response.json(body, { status }));

    await expect(storage.createSignedRead(objectKey)).rejects.toMatchObject({ code, status });
  });

  it("keeps data changes and pending deletions actionable without accepting malformed success", async () => {
    const dataChange = client(async () =>
      Response.json({ code: "data_change_in_progress" }, { status: 409 }),
    );
    await expect(
      dataChange.deleteObject({ objectKey, idempotencyKey: "delete-1" }),
    ).rejects.toMatchObject({ code: "data_change_in_progress", retryable: true });
    const moved = client(async () =>
      Response.json({ code: "storage_binding_data_changed" }, { status: 409 }),
    );
    await expect(
      moved.deleteObject({ objectKey, idempotencyKey: "delete-1" }),
    ).rejects.toMatchObject({
      code: "storage_binding_data_changed",
      retryable: false,
      message: expect.stringContaining(ENVIRONMENT),
    });
    const retryAt = "2026-09-28T12:05:30.000Z";
    const pending = client(async () =>
      Response.json({ code: "storage_delete_pending", retry_at: retryAt }, { status: 409 }),
    );
    await expect(
      pending.deleteObject({ objectKey, idempotencyKey: "delete-1" }),
    ).rejects.toMatchObject({
      code: "storage_delete_pending",
      retryable: true,
      message: expect.stringContaining(retryAt),
    });
    for (const [status, body] of [
      [409, { code: "storage_delete_pending" }],
      [409, { code: "storage_delete_pending", retry_at: "tomorrow" }],
      [409, { code: "storage_delete_pending", retry_at: retryAt, extra: "not allowed" }],
      [400, { code: "storage_delete_pending", retry_at: retryAt }],
    ] as const)
      await expect(
        client(async () => Response.json(body, { status })).deleteObject({
          objectKey,
          idempotencyKey: "delete-1",
        }),
      ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  });

  it("rejects malformed source inputs before transport", async () => {
    const fetch = vi.fn();
    const storage = client(fetch);

    await expect(
      storage.reserveUpload({
        idempotencyKey: "bad key",
        objectKey,
        contentType: "image/png",
        contentLength: 1,
      }),
    ).rejects.toMatchObject({ code: "gateway_request_invalid" });
    await expect(
      storage.reserveUpload({
        idempotencyKey: "upload-1",
        objectKey: "/absolute",
        contentType: "image/png",
        contentLength: 1,
      }),
    ).rejects.toMatchObject({ code: "gateway_request_invalid" });
    await expect(
      storage.reserveUpload({
        idempotencyKey: "upload-1",
        objectKey,
        contentType: "invalid",
        contentLength: 1,
      }),
    ).rejects.toMatchObject({ code: "gateway_request_invalid" });
    await expect(
      storage.reserveUpload({
        idempotencyKey: "upload-1",
        objectKey,
        contentType: "image/png",
        contentLength: 1_073_741_825,
      }),
    ).rejects.toMatchObject({ code: "gateway_request_invalid" });
    expect(fetch).not.toHaveBeenCalled();
    expect(() =>
      createPrivateStorageClient({
        endpoint: "https://storage-gateway.internal",
        key: KEY,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        fetch,
        capabilityFetch: null as never,
      }),
    ).toThrow("gateway_configuration_invalid: capabilityFetch ");
    for (const [option, variable] of [
      ["projectId", "OHMYHOST_PROJECT_ID"],
      ["environmentId", "OHMYHOST_ENVIRONMENT_ID"],
    ] as const) {
      expect(() =>
        createPrivateStorageClient({
          endpoint: "https://storage-gateway.internal",
          key: KEY,
          projectId: PROJECT,
          environmentId: ENVIRONMENT,
          fetch,
          capabilityFetch: fetch,
          [option]: "not-ulid",
        }),
      ).toThrow(`gateway_configuration_invalid: ${option} is not a ULID; pass ${variable}`);
    }
  });

  it("completes an upload whose earlier attempt already stored the object", async () => {
    // A retry signs a new create-only PUT; R2 refuses it with 412 because the bytes are there.
    const gatewayFetch = vi.fn(async (request: Request) =>
      request.url.endsWith("/v1/uploads")
        ? Response.json({ state: "ready", transfer_id: TRANSFER, capability: capability("PUT") })
        : Response.json({ state: "completed", transfer_id: TRANSFER }),
    );
    const capabilityFetch = vi.fn(async () => new Response(null, { status: 412 }));

    await expect(
      client(gatewayFetch, capabilityFetch).upload({
        idempotencyKey: "upload-1",
        objectKey,
        contentType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual({ state: "completed", transferId: TRANSFER });
    expect(gatewayFetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      "/v1/uploads",
      "/v1/uploads/complete",
    ]);
  });

  it("rejects unsafe signed capabilities and failed provider uploads", async () => {
    const unsafeHeader = { ...capability("GET"), requiredHeaders: { authorization: "secret" } };
    await expect(
      client(async () =>
        Response.json({ state: "ready", capability: unsafeHeader }),
      ).createSignedRead(objectKey),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });

    const badUrl = { ...capability("GET"), url: "http://signed.example.test/object" };
    await expect(
      client(async () => Response.json({ state: "ready", capability: badUrl })).createSignedRead(
        objectKey,
      ),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });

    for (const [status, retryable] of [
      [403, false],
      [429, true],
      [503, true],
    ] as const) {
      const fetch = vi.fn(async (request: Request) =>
        request.url.endsWith("/v1/uploads")
          ? Response.json({ state: "ready", transfer_id: TRANSFER, capability: capability("PUT") })
          : new Response("provider detail", { status }),
      );
      const error = await client(fetch)
        .upload({
          idempotencyKey: "upload-1",
          objectKey,
          contentType: "image/png",
          bytes: new Uint8Array([1, 2, 3]),
        })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "storage_upload_rejected",
        status,
        retryable,
        message: `storage_upload_rejected: the signed upload answered ${String(status)}. For 5xx or 429, repeat upload() with the same idempotencyKey and objectKey.`,
      });
      expect(String(error)).not.toContain("provider detail");
    }
  });

  it("rejects structurally invalid gateway outcomes", async () => {
    await expect(
      client(async () => Response.json({ state: "ready", unexpected: true })).createSignedRead(
        objectKey,
      ),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
    await expect(
      client(async () => Response.json({ code: "unknown" }, { status: 418 })).createSignedRead(
        objectKey,
      ),
    ).rejects.toMatchObject({ code: "gateway_response_invalid" });
  });
});
