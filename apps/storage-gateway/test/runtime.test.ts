import { describe, expect, it, vi } from "vitest";
import { storageErasureMarkerDigest, type StorageErasureProof } from "@ohmyhost/database";

import { createStorageGateway } from "../src/runtime.js";

const PROJECT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const TRANSFER = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const bucketName = `ohmyho-${PROJECT.toLowerCase()}-${ENVIRONMENT.toLowerCase()}`;
const locator = { physicalObjectKey: "uploads/photo.png", dataEnvironmentId: ENVIRONMENT };
const deletionLease = { expiresAt: new Date("2026-08-24T12:05:00.000Z"), completedAt: null };

function setup() {
  let now = new Date("2026-08-24T12:00:00.000Z");
  const markers = new Map<string, { markerSha256: Uint8Array; erasedAt: Date }>();
  const erasedTransfers = new Set<string>();
  const authenticate = vi.fn(
    async () =>
      ({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        bucketName,
        jurisdiction: "us",
        quotaBytes: 1_073_741_824,
        dataEnvironmentId: ENVIRONMENT,
      }) as never,
  );
  const claim = vi.fn(async () => ({
    ...locator,
    outcome: "claimed" as const,
    transferId: TRANSFER,
    expiresAt: new Date("2026-08-24T12:05:00.000Z"),
  }));
  const readReservation = vi.fn(async () => ({
    ...locator,
    environmentId: ENVIRONMENT,
    jurisdiction: "us" as const,
    transferId: TRANSFER,
    objectKey: "uploads/photo.png",
    contentType: "image/png",
    expectedBytes: 12_345,
    requestedAt: new Date("2026-08-24T12:00:00.000Z"),
    expiresAt: new Date("2026-08-24T12:05:00.000Z"),
    completed: false,
  }));
  const complete = vi.fn(async () => "created" as const);
  const readObject = vi.fn(async () => ({
    ...locator,
    organizationId: ORGANIZATION,
    projectId: PROJECT,
    environmentId: ENVIRONMENT,
    transferId: TRANSFER,
    objectKey: "uploads/photo.png",
    contentType: "image/png",
    size: 12_345,
    etag: "0123456789abcdef0123456789abcdef",
    uploadedAt: new Date("2026-08-24T12:04:00.000Z"),
    jurisdiction: "us" as "us" | "eu",
  }));
  const createTransfer = vi.fn(
    async (input: { operation: "DELETE" | "GET" | "PUT"; contentLength?: number }) => ({
      operation: input.operation,
      objectKey: "uploads/photo.png",
      url: "https://capability.example.test/signed",
      expiresAt: new Date("2026-08-24T12:05:00.000Z"),
      expectedContentLength: input.operation === "PUT" ? (input.contentLength ?? 12_345) : null,
      requiredHeaders: input.operation === "PUT" ? { "content-type": "image/png" } : {},
    }),
  );
  const observeObject = vi.fn(async () => ({
    state: "found" as const,
    objectKey: "uploads/photo.png",
    contentLength: 12_345,
    contentType: "image/png",
    etag: "0123456789abcdef0123456789abcdef",
    uploadedAt: new Date("2026-08-24T12:04:00.000Z"),
  }));
  const erasePayloads = vi.fn(async (value: unknown, options?: { signal?: AbortSignal }) => {
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
    return input.objects.map((object) => {
      const marker = {
        markerSha256: storageErasureMarkerDigest({
          ...object,
          physicalObjectKey: object.objectKey,
        }),
        erasedAt: new Date(now),
      };
      markers.set(`${object.environmentId}/${object.objectKey}`, marker);
      return {
        status: "erased" as const,
        objectKey: object.objectKey,
        transferId: object.transferId,
        ...marker,
      };
    });
  });
  const claimDelete = vi.fn(async () => ({
    ...locator,
    ...deletionLease,
    outcome: "claimed" as const,
    deletionId: TRANSFER,
    environmentId: ENVIRONMENT,
    jurisdiction: "us" as "us" | "eu",
    transferId: TRANSFER,
    payloadErased: erasedTransfers.has(`${ENVIRONMENT}/${TRANSFER}`),
  }));
  const completeDelete = vi.fn(async (proof: StorageErasureProof) => {
    const marker = markers.get(`${proof.environmentId}/${proof.physicalObjectKey}`);
    expect(marker).toBeDefined();
    expect(proof.markerSha256).toEqual(marker?.markerSha256);
    expect(proof.erasedAt).toBe(marker?.erasedAt.toISOString());
    erasedTransfers.add(`${proof.environmentId}/${proof.transferId}`);
    return "created" as const;
  });
  const gateway = createStorageGateway({
    authenticate,
    claim,
    readReservation,
    complete,
    readObject,
    claimDelete,
    completeDelete,
    readObjects: async () => [],
    claimDeletes: async () => [],
    completeDeletes: async () => [],
    provider: {
      createTransfer,
      observeObject,
      erasePayloads,
      readObject: async () => ({ state: "absent", objectKey: "uploads/photo.png" }),
    },
    sha256: vi.fn(async () => new Uint8Array(32).fill(1)),
    ids: { next: () => TRANSFER },
    now: () => now,
  });
  return {
    gateway,
    authenticate,
    claim,
    readReservation,
    complete,
    readObject,
    createTransfer,
    observeObject,
    erasePayloads,
    claimDelete,
    completeDelete,
    advance: (value: string) => {
      now = new Date(value);
    },
  };
}

const auth = { projectId: PROJECT, environmentId: ENVIRONMENT, key: "s".repeat(43) };

describe("storage gateway", () => {
  it("reserves one upload, verifies provider HEAD, and signs only confirmed downloads", async () => {
    const harness = setup();
    await expect(
      harness.gateway.upload({
        ...auth,
        objectKey: "uploads/photo.png",
        contentType: "image/png",
        contentLength: 12_345,
        idempotencyKey: "photo-1",
      }),
    ).resolves.toMatchObject({ status: "ready", transferId: TRANSFER });
    expect(harness.claim).toHaveBeenCalledWith(expect.objectContaining({ expectedBytes: 12_345 }));
    expect(harness.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "PUT" }),
    );

    await expect(harness.gateway.complete({ ...auth, transferId: TRANSFER })).resolves.toEqual({
      status: "completed",
      transferId: TRANSFER,
    });
    expect(harness.complete).toHaveBeenCalledWith(
      expect.objectContaining({ etag: "0123456789abcdef0123456789abcdef" }),
    );

    await expect(
      harness.gateway.download({ ...auth, objectKey: "uploads/photo.png" }),
    ).resolves.toMatchObject({
      status: "ready",
      capability: { operation: "GET" },
    });

    await expect(
      harness.gateway.delete({
        ...auth,
        objectKey: "uploads/photo.png",
        idempotencyKey: "delete-1",
      }),
    ).rejects.toMatchObject({
      code: "storage_delete_pending",
      retryAt: "2026-08-24T12:05:30.000Z",
    });
    expect(harness.erasePayloads).not.toHaveBeenCalled();
    harness.advance("2026-08-24T12:06:00.000Z");
    await expect(
      harness.gateway.delete({
        ...auth,
        objectKey: "uploads/photo.png",
        idempotencyKey: "delete-1",
      }),
    ).resolves.toEqual({ status: "completed", deletionId: TRANSFER });
    expect(harness.erasePayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        objects: [
          {
            organizationId: ORGANIZATION,
            projectId: PROJECT,
            environmentId: ENVIRONMENT,
            dataEnvironmentId: ENVIRONMENT,
            transferId: TRANSFER,
            objectKey: "uploads/photo.png",
          },
        ],
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.completeDelete).toHaveBeenCalledOnce();
    expect(harness.completeDelete).toHaveBeenCalledWith({
      deletionId: TRANSFER,
      organizationId: ORGANIZATION,
      projectId: PROJECT,
      environmentId: ENVIRONMENT,
      dataEnvironmentId: ENVIRONMENT,
      transferId: TRANSFER,
      objectKey: "uploads/photo.png",
      physicalObjectKey: "uploads/photo.png",
      markerSha256: storageErasureMarkerDigest({
        organizationId: ORGANIZATION,
        projectId: PROJECT,
        environmentId: ENVIRONMENT,
        dataEnvironmentId: ENVIRONMENT,
        transferId: TRANSFER,
        physicalObjectKey: "uploads/photo.png",
      }),
      erasedAt: "2026-08-24T12:06:00.000Z",
    });

    const ownerEnvironment = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    harness.readObject.mockResolvedValueOnce({
      ...(await harness.readObject()),
      environmentId: ownerEnvironment,
      jurisdiction: "eu",
    });
    await expect(
      harness.gateway.download({ ...auth, objectKey: "uploads/photo.png" }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(harness.createTransfer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          bucketName: `ohmyho-${PROJECT.toLowerCase()}-${ownerEnvironment.toLowerCase()}`,
          jurisdiction: "eu",
        }),
      }),
    );
    harness.claimDelete.mockResolvedValueOnce({
      ...locator,
      ...deletionLease,
      outcome: "claimed",
      deletionId: TRANSFER,
      environmentId: ownerEnvironment,
      jurisdiction: "eu",
      transferId: TRANSFER,
      payloadErased: false,
    });
    await expect(
      harness.gateway.delete({
        ...auth,
        objectKey: "uploads/photo.png",
        idempotencyKey: "delete-shared",
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(harness.erasePayloads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          bucketName: `ohmyho-${PROJECT.toLowerCase()}-${ownerEnvironment.toLowerCase()}`,
          jurisdiction: "eu",
        }),
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(harness.completeDelete).toHaveBeenLastCalledWith(
      expect.objectContaining({ environmentId: ownerEnvironment }),
    );
  });

  it("reserves a zero-byte object without a project-specific fallback", async () => {
    const harness = setup();

    await expect(
      harness.gateway.upload({
        ...auth,
        objectKey: "uploads/empty.txt",
        contentType: "text/plain",
        contentLength: 0,
        idempotencyKey: "empty-1",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      capability: { expectedContentLength: 0 },
    });
    expect(harness.claim).toHaveBeenCalledWith(expect.objectContaining({ expectedBytes: 0 }));
  });

  it("records bytes an earlier attempt stored instead of signing a second create-only PUT", async () => {
    // A retry after a failed completion reaches the same reservation; R2 would refuse a new
    // create-only PUT with 412 and leave the stored object unrecorded, even once expired.
    for (const expiresAt of ["2026-08-24T12:05:00.000Z", "2026-08-24T12:00:30.000Z"]) {
      const harness = setup();
      harness.claim.mockResolvedValueOnce({
        ...locator,
        outcome: "existing",
        transferId: TRANSFER,
        expiresAt: new Date(expiresAt),
      } as never);
      await expect(
        harness.gateway.upload({
          ...auth,
          objectKey: "uploads/photo.png",
          contentType: "image/png",
          contentLength: 12_345,
          idempotencyKey: "photo-1",
        }),
      ).resolves.toEqual({ status: "completed", transferId: TRANSFER });
      expect(harness.observeObject).toHaveBeenCalledWith(
        expect.objectContaining({ objectKey: "uploads/photo.png" }),
      );
      expect(harness.complete).toHaveBeenCalledWith(
        expect.objectContaining({ transferId: TRANSFER, size: 12_345, contentType: "image/png" }),
      );
      expect(harness.createTransfer).not.toHaveBeenCalled();
    }

    // Without stored bytes the existing reservation still signs its PUT; a fresh claim never
    // looks, because its key was never reserved before.
    const absent = setup();
    absent.claim.mockResolvedValueOnce({
      ...locator,
      outcome: "existing",
      transferId: TRANSFER,
      expiresAt: new Date("2026-08-24T12:05:00.000Z"),
    } as never);
    absent.observeObject.mockResolvedValueOnce({
      state: "absent",
      objectKey: "uploads/photo.png",
    } as never);
    const upload = {
      ...auth,
      objectKey: "uploads/photo.png",
      contentType: "image/png",
      contentLength: 12_345,
      idempotencyKey: "photo-1",
    };
    await expect(absent.gateway.upload(upload)).resolves.toMatchObject({ status: "ready" });
    await expect(absent.gateway.upload(upload)).resolves.toMatchObject({ status: "ready" });
    expect(absent.observeObject).toHaveBeenCalledOnce();
    expect(absent.complete).not.toHaveBeenCalled();
  });

  it("refuses a confirmation strictly after the upload expired with expired, and records nothing; the expiry instant still counts", async () => {
    const at = setup();
    at.advance("2026-08-24T12:05:00.000Z");
    await expect(at.gateway.complete({ ...auth, transferId: TRANSFER })).resolves.toEqual({
      status: "completed",
      transferId: TRANSFER,
    });
    const late = setup();
    late.advance("2026-08-24T12:05:00.001Z");
    await expect(late.gateway.complete({ ...auth, transferId: TRANSFER })).resolves.toEqual({
      status: "expired",
      transferId: TRANSFER,
    });
    expect(late.complete).not.toHaveBeenCalled();
  });

  it("fails closed for unauthorized, absent, pending, completed, expired, and widened requests", async () => {
    const unauthorized = setup();
    unauthorized.authenticate.mockResolvedValueOnce(null as never);
    await expect(
      unauthorized.gateway.download({ ...auth, objectKey: "uploads/photo.png" }),
    ).resolves.toEqual({ status: "unauthorized" });

    const absent = setup();
    absent.readReservation.mockResolvedValueOnce(null as never);
    await expect(absent.gateway.complete({ ...auth, transferId: TRANSFER })).resolves.toEqual({
      status: "not_found",
    });
    absent.readObject.mockResolvedValueOnce(null as never);
    await expect(
      absent.gateway.download({ ...auth, objectKey: "uploads/photo.png" }),
    ).resolves.toEqual({ status: "not_found" });

    const pending = setup();
    pending.observeObject.mockResolvedValueOnce({
      state: "absent",
      objectKey: "uploads/photo.png",
    } as never);
    await expect(pending.gateway.complete({ ...auth, transferId: TRANSFER })).resolves.toEqual({
      status: "pending",
      transferId: TRANSFER,
    });
    pending.readReservation.mockResolvedValueOnce({
      ...(await setup().readReservation()),
      completed: true,
    });
    await expect(pending.gateway.complete({ ...auth, transferId: TRANSFER })).resolves.toEqual({
      status: "completed",
      transferId: TRANSFER,
    });

    const expired = setup();
    expired.claim.mockResolvedValueOnce({
      ...locator,
      outcome: "existing",
      transferId: TRANSFER,
      expiresAt: new Date("2026-08-24T12:00:30.000Z"),
    } as never);
    expired.observeObject.mockResolvedValueOnce({
      state: "absent",
      objectKey: "uploads/photo.png",
    } as never);
    await expect(
      expired.gateway.upload({
        ...auth,
        objectKey: "uploads/photo.png",
        contentType: "image/png",
        contentLength: 12_345,
        idempotencyKey: "photo-1",
      }),
    ).resolves.toEqual({ status: "expired", transferId: TRANSFER });

    expect(() => createStorageGateway({} as never)).toThrow("dependencies are invalid");
    await expect(setup().gateway.upload({ ...auth, extra: true })).rejects.toThrow(
      "input is invalid",
    );
  });
});
