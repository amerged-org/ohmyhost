import { describe, expect, it, vi } from "vitest";
import { CloudflareR2TransferRejectedError } from "@ohmyhost/provider-cloudflare";
import { streamStorageBatch } from "../src/batch.js";
import {
  StorageGatewayBindingChangedError,
  StorageGatewayDataChangeInProgressError,
  StorageErasureConflictError,
} from "@ohmyhost/database";
import { StorageGatewayDeletePendingError } from "../src/runtime.js";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(context: unknown, env: unknown) {
      void context;
      this.env = env;
    }
  },
}));

const bindings = {
  RUNTIME_CONFIGURATION_STATE: "configured",
  CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000001",
  CLOUDFLARE_R2_API_TOKEN: `token-${"x".repeat(32)}`,
  CLOUDFLARE_R2_PARENT_ACCESS_KEY_ID: "a".repeat(32),
  GATEWAY_RATE_LIMITER: { limit: async () => ({ success: true }) },
} as const;
const scope = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  dataEnvironmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
};
function scopedFactory(
  make: typeof import("../src/worker-main.js").createStorageGatewayEntrypoint,
) {
  return (dependencies: Parameters<typeof make>[0]) => {
    const port = make(dependencies);
    return {
      fetch: (request: Request, bindings: unknown, context?: { props: unknown }) =>
        port.fetch(request, bindings, context ?? { props: scope }),
    };
  };
}

function request(path: string, body: object, idempotencyKey?: string) {
  return new Request(`https://gateway.example.test${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${"s".repeat(43)}`,
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify({
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      ...body,
    }),
  });
}

describe("storage gateway Worker", () => {
  it("routes bounded upload, completion, and download requests", async () => {
    const { createStorageGatewayEntrypoint: makeEntrypoint } = await import(
      "../src/worker-main.js"
    );
    const createStorageGatewayEntrypoint = scopedFactory(makeEntrypoint);
    const upload = vi.fn(async () => ({
      status: "ready",
      transferId: "transfer",
      capability: { url: "https://signed" },
    }));
    const complete = vi.fn(async () => ({ status: "pending", transferId: "transfer" }));
    const download = vi.fn(async () => ({ status: "not_found" }));
    const remove = vi.fn(async () => ({ status: "completed", deletionId: "deletion" }));
    const entrypoint = createStorageGatewayEntrypoint({
      runtimeFactory: () =>
        ({
          upload,
          complete,
          download,
          delete: remove,
          readMany: async () => ({
            status: "stream",
            body: streamStorageBatch({
              projectId: scope.projectId,
              objectKeys: ["one.bin"],
              objects: [null],
              readObject: async () => {
                throw new Error("unused");
              },
            }),
          }),
          deleteMany: async () => ({
            status: "batch",
            state: "partial",
            results: [
              {
                object_key: "one.bin",
                state: "failed",
                code: "object_not_found",
                retryable: false,
              },
            ],
          }),
        }) as never,
    });
    const body = { projectId: scope.projectId, environmentId: scope.environmentId };

    await expect(
      entrypoint.fetch(request("/v1/uploads", body, "upload-1"), bindings),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      entrypoint.fetch(request("/v1/uploads/complete", body), bindings),
    ).resolves.toMatchObject({ status: 202 });
    await expect(entrypoint.fetch(request("/v1/downloads", body), bindings)).resolves.toMatchObject(
      { status: 404 },
    );
    await expect(
      entrypoint.fetch(request("/v1/deletions", body, "delete-1"), bindings),
    ).resolves.toMatchObject({ status: 200 });
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ key: "s".repeat(43), idempotencyKey: "upload-1" }),
    );
    const bulkRead = await entrypoint.fetch(
      request("/v1/downloads/batch", { objectKeys: ["one.bin"] }),
      bindings,
    );
    expect(bulkRead.headers.get("content-type")).toBe("application/vnd.ohmyhost.storage-batch.v1");
    expect(await bulkRead.text()).toContain('"state":"not_found"');
    const bulkDelete = await entrypoint.fetch(
      request("/v1/deletions/batch", {
        objects: [{ objectKey: "one.bin", idempotencyKey: "one" }],
      }),
      bindings,
    );
    await expect(bulkDelete.json()).resolves.toMatchObject({
      state: "partial",
      results: [{ state: "failed", code: "object_not_found" }],
    });
    const raw = makeEntrypoint({
      runtimeFactory: () => ({ upload, complete, download, delete: remove }) as never,
    });
    await expect(raw.fetch(request("/v1/uploads", body), bindings)).resolves.toMatchObject({
      status: 401,
    });
    await expect(
      raw.fetch(request("/v1/uploads", body), bindings, {
        props: { ...scope, environmentId: scope.organizationId },
      }),
    ).resolves.toMatchObject({ status: 401 });
  });

  it("fails closed for unknown routes, malformed requests, and typed runtime outcomes", async () => {
    const module = await import("../src/worker-main.js");
    const createStorageGatewayEntrypoint = scopedFactory(module.createStorageGatewayEntrypoint);
    const runtime = { upload: vi.fn(), complete: vi.fn(), download: vi.fn(), delete: vi.fn() };
    const entrypoint = createStorageGatewayEntrypoint({
      runtimeFactory: () => runtime as never,
    });
    await expect(
      entrypoint.fetch(new Request("https://gateway.example.test/nope"), bindings),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      entrypoint.fetch(
        new Request("https://gateway.example.test/v1/uploads", { method: "POST" }),
        bindings,
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      entrypoint.fetch(request("/v1/uploads", { data: "x".repeat(8192) }), bindings),
    ).resolves.toMatchObject({ status: 413 });
    await expect(
      entrypoint.fetch(
        new Request("https://gateway.example.test/v1/uploads", {
          method: "POST",
          headers: {
            authorization: `Bearer ${"s".repeat(43)}`,
            "content-type": "application/json",
          },
        }),
        bindings,
      ),
    ).resolves.toMatchObject({ status: 400 });

    runtime.upload.mockResolvedValueOnce({ status: "unauthorized" });
    await expect(
      entrypoint.fetch(request("/v1/uploads", {}, "x"), bindings),
    ).resolves.toMatchObject({ status: 401 });
    runtime.upload.mockResolvedValueOnce({ status: "expired", transferId: "t" });
    await expect(
      entrypoint.fetch(request("/v1/uploads", {}, "x"), bindings),
    ).resolves.toMatchObject({ status: 409 });
    runtime.upload.mockResolvedValueOnce({ status: "completed", transferId: "t" });
    await expect(
      entrypoint.fetch(request("/v1/uploads", {}, "x"), bindings),
    ).resolves.toMatchObject({ status: 200 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runtime.upload.mockRejectedValueOnce(new CloudflareR2TransferRejectedError(10_000, 403));
    const rejected = await entrypoint.fetch(request("/v1/uploads", {}, "x"), bindings);
    expect(rejected.status).toBe(502);
    await expect(rejected.json()).resolves.toEqual({
      code: "cloudflare_r2_transfer_request_rejected",
    });
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        event: "cloudflare_r2_transfer_rejected",
        providerCode: 10_000,
        providerStatus: 403,
      }),
    );
    warning.mockRestore();
    runtime.upload.mockRejectedValueOnce(new Error("provider detail"));
    await expect(
      entrypoint.fetch(request("/v1/uploads", {}, "x"), bindings),
    ).resolves.toMatchObject({ status: 503 });
    for (const error of [
      new StorageGatewayBindingChangedError(),
      new StorageGatewayDataChangeInProgressError(),
      new StorageErasureConflictError(),
      new StorageGatewayDeletePendingError("2026-09-28T12:05:30.000Z"),
    ]) {
      runtime.upload.mockRejectedValueOnce(error);
      const result = await entrypoint.fetch(request("/v1/uploads", {}, "x"), bindings);
      expect(result.status).toBe(409);
      await expect(result.json()).resolves.toEqual(
        error instanceof StorageGatewayDeletePendingError
          ? { code: error.code, retry_at: error.retryAt }
          : { code: error.code },
      );
    }

    await expect(
      module.default.fetch(new Request("https://gateway.example.test/nope"), bindings, {
        props: scope,
      }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("limits the legacy props path per project before any Core work", async () => {
    const module = await import("../src/worker-main.js");
    const limit = vi.fn(async () => ({ success: false }));
    const response = await module.default.fetch(
      request("/v1/uploads", {}),
      { ...bindings, GATEWAY_RATE_LIMITER: { limit } },
      { props: scope },
    );
    expect(limit).toHaveBeenCalledWith({ key: scope.projectId });
    expect(response.status).toBe(429);
  });
});
