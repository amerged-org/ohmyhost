import { expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import type { R2PayloadErasureResult } from "@ohmyhost/provider-cloudflare";
import { createStorageGateway } from "../src/runtime.js";

const id = (n: number) => parseUlid(String(n).padStart(26, "0"));
const now = new Date("2026-09-28T12:00:00Z");
const auth = { projectId: id(10), environmentId: id(11), key: "s".repeat(43) };
function fixture(signal?: AbortSignal) {
  const physicalDeletes: unknown[] = [],
    erasures: string[] = [],
    persisted: string[] = [];
  const claim = (objectKey: string, index = 0) => ({
    outcome: "completed" as const,
    state: "completed" as const,
    deletionId: id(100 + index),
    objectKey,
    environmentId: id(11),
    jurisdiction: "us" as const,
    physicalObjectKey: `d/${id(12)}/${objectKey}`,
    dataEnvironmentId: id(12),
    expiresAt: new Date("2026-09-28T11:00:00Z"),
    completedAt: new Date("2026-09-28T11:06:00Z"),
    transferId: id(200 + index),
    payloadErased: false,
  });
  const dependencies = {
    authenticate: async () => ({
      organizationId: id(1),
      projectId: id(10),
      environmentId: id(11),
      dataEnvironmentId: id(12),
      bucketName: `ohmyho-${id(10)}-${id(11)}`,
      jurisdiction: "us" as const,
      quotaBytes: 1073741824,
    }),
    claim: async () => {
      throw new Error("unused");
    },
    readReservation: async () => null,
    complete: async () => "created" as const,
    readObject: async () => null,
    claimDelete: async (input: { objectKey: string }) => claim(input.objectKey),
    completeDelete: async (proof: { objectKey: string; markerSha256?: Uint8Array }) => {
      expect(proof.markerSha256).toEqual(new Uint8Array(32));
      persisted.push(proof.objectKey);
      return "created" as const;
    },
    readObjects: async () => [],
    claimDeletes: async (inputs: readonly { objectKey: string }[]) =>
      inputs.map((input, index) => claim(input.objectKey, index)),
    completeDeletes: async (
      proofs: readonly { objectKey: string; markerSha256?: Uint8Array }[],
    ) => {
      for (const proof of proofs) {
        expect(proof.markerSha256).toEqual(new Uint8Array(32));
        persisted.push(proof.objectKey);
      }
      return proofs.map(() => "created" as const);
    },
    provider: {
      createTransfer: async () => {
        throw new Error("unused");
      },
      observeObject: async () => ({ state: "absent" as const, objectKey: "unused" }),
      readObject: async () => ({ state: "absent" as const, objectKey: "unused" }),
      deleteObject: async (value: unknown) => {
        physicalDeletes.push(value);
        return { status: "deleted" as const, objectKey: "unused" };
      },
      deleteObjects: async (value: unknown) => {
        physicalDeletes.push(value);
        return (value as { objectKeys: string[] }).objectKeys.map((objectKey) => ({
          status: "deleted" as const,
          objectKey,
        }));
      },
      erasePayloads: async (
        value: unknown,
        options: { signal?: AbortSignal } = {},
      ): Promise<readonly R2PayloadErasureResult[]> =>
        (value as { objects: { objectKey: string; transferId: string }[] }).objects.map((item) => {
          if (options.signal?.aborted) return { ...item, status: "pending" as const };
          erasures.push(item.objectKey);
          return {
            ...item,
            status: "erased" as const,
            markerSha256: new Uint8Array(32),
            erasedAt: now,
          };
        }),
    },
    sha256: async () => new Uint8Array(32),
    ids: { next: () => id(900) },
    now: () => now,
  };
  return {
    dependencies,
    physicalDeletes,
    erasures,
    persisted,
    gateway: () => createStorageGateway(dependencies, signal === undefined ? {} : { signal }),
  };
}

it("upgrades an old absence-only scalar receipt using a persistent erasure proof, then replays without deleting its marker", async () => {
  const f = fixture();
  expect(
    await f.gateway().delete({ ...auth, objectKey: "file.bin", idempotencyKey: "erase" }),
  ).toEqual({ status: "completed", deletionId: id(100) });
  expect(f.erasures).toEqual([`d/${id(12)}/file.bin`]);
  expect(f.persisted).toEqual(["file.bin"]);
  expect(f.physicalDeletes).toEqual([]);
  const original = f.dependencies.claimDelete;
  f.dependencies.claimDelete = async (input) => ({
    ...(await original(input)),
    payloadErased: true,
  });
  await f.gateway().delete({ ...auth, objectKey: "file.bin", idempotencyKey: "erase" });
  expect(f.erasures).toHaveLength(1);
  expect(f.physicalDeletes).toEqual([]);
});

it("persists a verified bulk page before cancellation and returns ordered pending entries for untouched keys", async () => {
  const abort = new AbortController(),
    f = fixture(abort.signal),
    persist = f.dependencies.completeDeletes;
  f.dependencies.completeDeletes = async (proofs) => {
    const result = await persist(proofs);
    abort.abort();
    return result;
  };
  const objects = Array.from({ length: 70 }, (_, index) => ({
    objectKey: `${index}.bin`,
    idempotencyKey: `erase-${index}`,
  }));
  const response = await f.gateway().deleteMany({ ...auth, objects });
  expect(response.status).toBe("batch");
  if (response.status !== "batch") throw new Error("expected batch");
  expect(f.persisted).toHaveLength(32);
  expect(f.erasures).toHaveLength(32);
  expect(f.physicalDeletes).toEqual([]);
  expect(response.results.slice(0, 32).every((item) => item.state === "completed")).toBe(true);
  expect(response.results.slice(32).every((item) => item.state === "pending")).toBe(true);
  expect(response.results.map((item) => item.object_key)).toEqual(
    objects.map((item) => item.objectKey),
  );
});

it("never turns an aborted marker or a mismatched proof into a completed deletion", async () => {
  const f = fixture();
  f.dependencies.provider.erasePayloads = async (value) =>
    (value as { objects: { objectKey: string; transferId: string }[] }).objects.map((item) => ({
      ...item,
      status: "pending" as const,
    }));
  await expect(
    f.gateway().delete({ ...auth, objectKey: "file.bin", idempotencyKey: "erase" }),
  ).rejects.toMatchObject({ code: "storage_delete_pending" });
  expect(f.persisted).toEqual([]);
  const g = fixture();
  const erase = g.dependencies.provider.erasePayloads;
  g.dependencies.provider.erasePayloads = async (value, options) =>
    (await erase(value, options)).map((item) => ({ ...item, transferId: id(999) }));
  await expect(
    g
      .gateway()
      .deleteMany({ ...auth, objects: [{ objectKey: "file.bin", idempotencyKey: "erase" }] }),
  ).rejects.toMatchObject({ code: "storage_gateway_input_invalid" });
  expect(g.persisted).toEqual([]);
  vi.useFakeTimers();
  try {
    const bounded = fixture();
    bounded.dependencies.provider.erasePayloads = async (value, options = {}) => {
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      return (value as { objects: { objectKey: string; transferId: string }[] }).objects.map(
        (item) => ({ ...item, status: "pending" as const }),
      );
    };
    const pending = expect(
      bounded.gateway().delete({ ...auth, objectKey: "file.bin", idempotencyKey: "budget" }),
    ).rejects.toMatchObject({ code: "storage_delete_pending" });
    await vi.advanceTimersByTimeAsync(6000);
    await pending;
    expect(bounded.persisted).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

it("authenticates again before every page of a bulk erasure and stops once the data environment changed", async () => {
  const f = fixture(),
    authenticate = f.dependencies.authenticate;
  let authentications = 0;
  // The environment moves to another data area after the first page has been erased.
  f.dependencies.authenticate = async () => ({
    ...(await authenticate()),
    dataEnvironmentId: ++authentications < 3 ? id(12) : id(13),
  });
  const objects = Array.from({ length: 33 }, (_, index) => ({
    objectKey: `${index}.bin`,
    idempotencyKey: `erase-${index}`,
  }));
  await expect(f.gateway().deleteMany({ ...auth, objects })).rejects.toMatchObject({
    code: "storage_gateway_input_invalid",
  });
  expect(f.erasures).toHaveLength(32);
  expect(f.persisted).toHaveLength(32);
});
