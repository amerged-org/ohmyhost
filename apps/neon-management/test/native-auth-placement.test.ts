import { describe, expect, it, vi } from "vitest";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import {
  placeNativeAuthDatabase,
  type NativeAuthPlacementPersistence,
} from "../src/native-auth-placement.js";

const claim = {
  organizationId: "org",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  environmentId: "env",
  operationId: "operation",
  claimId: "claim",
  regionId: "eu-dev" as const,
};
const target = {
  organizationId: claim.organizationId,
  projectId: claim.projectId,
  providerProjectId: "provider",
  databaseId: "a1234567890123456789",
  providerOperationId: "operation",
  regionId: claim.regionId,
  sizeClassId: "r256-s500m" as const,
  targetVersion: 1,
};
const database = {
  id: target.databaseId,
  projectId: "provider",
  regionId: "eu-dev",
  name: `ohmyho-auth-${claim.projectId.toLowerCase()}`,
  sizeClassId: "r256-s500m",
  resources: { memoryMiB: 256, cpuMillicores: 250, storageMiB: 500 },
  desiredState: "running" as const,
  observedState: "ready" as const,
  generation: 1,
  observedGeneration: 1,
  sleepAfterSeconds: 300,
};
const operation = {
  id: "operation",
  projectId: "provider",
  databaseId: database.id,
  generation: 1,
  kind: "database.create",
  status: "succeeded" as const,
  errorCode: null,
};

describe("Native Auth placement", () => {
  it("persists and attributes the first provider receipt and replays with the original key", async () => {
    const provider = {
      projectId: "provider",
      createDatabase: vi.fn().mockResolvedValue({ database, operation }),
      readDatabase: vi.fn().mockResolvedValue(database),
      readOperation: vi.fn().mockResolvedValue(operation),
    } as unknown as PgcfProjectProvider;
    const persistence: NativeAuthPlacementPersistence = {
      readDispatchedCreate: vi.fn().mockResolvedValue(null),
      resolveClaim: vi.fn().mockResolvedValue(claim),
      readTarget: vi.fn().mockResolvedValue(null),
      reserveCreate: vi.fn().mockResolvedValue({
        idempotencyKey: "original",
        databaseId: null,
        providerOperationId: null,
      }),
      authorizeDispatch: vi.fn(),
      recordCreated: vi.fn().mockResolvedValue(target),
    };
    await expect(placeNativeAuthDatabase(provider, persistence, claim)).resolves.toEqual({
      status: "ready",
      target,
    });
    expect(provider.createDatabase).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "original", sizeClassId: "r256-s500m" }),
    );
    expect(persistence.recordCreated).toHaveBeenCalledWith(claim, expect.anything(), {
      database,
      operation,
    });
    expect(vi.mocked(persistence.authorizeDispatch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(provider.createDatabase).mock.invocationCallOrder[0] ?? 0,
    );
    vi.mocked(persistence.readTarget).mockResolvedValue(target);
    vi.mocked(provider.readOperation).mockResolvedValue({ ...operation, status: "pending" });
    await expect(placeNativeAuthDatabase(provider, persistence, claim)).resolves.toEqual({
      status: "reconciliation_required",
      target,
    });
    vi.mocked(persistence.readTarget).mockResolvedValue(null);
    vi.mocked(provider.createDatabase).mockResolvedValue({
      database,
      operation: { ...operation, status: "failed" },
    });
    await expect(placeNativeAuthDatabase(provider, persistence, claim)).rejects.toThrow();
    expect(persistence.recordCreated).toHaveBeenLastCalledWith(claim, expect.anything(), {
      database,
      operation: { ...operation, status: "failed" },
    });
  });

  it("rejects an observed database belonging to a different project before attribution", async () => {
    const provider = {
      projectId: "provider",
      createDatabase: vi
        .fn()
        .mockResolvedValue({ database: { ...database, projectId: "foreign" }, operation }),
    } as unknown as PgcfProjectProvider;
    const persistence: NativeAuthPlacementPersistence = {
      readDispatchedCreate: vi.fn().mockResolvedValue(null),
      resolveClaim: vi.fn().mockResolvedValue(claim),
      readTarget: vi.fn().mockResolvedValue(null),
      reserveCreate: vi.fn().mockResolvedValue({
        idempotencyKey: "original",
        databaseId: null,
        providerOperationId: null,
      }),
      authorizeDispatch: vi.fn(),
      recordCreated: vi.fn(),
    };
    await expect(placeNativeAuthDatabase(provider, persistence, claim)).rejects.toThrow();
    expect(persistence.recordCreated).not.toHaveBeenCalled();
  });

  it("observes an acknowledged create without dispatching another mutation", async () => {
    const provider = {
      projectId: "provider",
      createDatabase: vi.fn(),
      readDatabase: vi.fn().mockResolvedValue(database),
      readOperation: vi.fn().mockResolvedValue(operation),
    } as unknown as PgcfProjectProvider;
    const persistence: NativeAuthPlacementPersistence = {
      readDispatchedCreate: vi.fn().mockResolvedValue(null),
      resolveClaim: vi.fn().mockResolvedValue(claim),
      readTarget: vi.fn().mockResolvedValue(null),
      reserveCreate: vi.fn().mockResolvedValue({
        idempotencyKey: "original",
        databaseId: database.id,
        providerOperationId: operation.id,
      }),
      authorizeDispatch: vi.fn(),
      recordCreated: vi.fn().mockResolvedValue(target),
    };
    await expect(placeNativeAuthDatabase(provider, persistence, claim)).resolves.toEqual({
      status: "ready",
      target,
    });
    expect(provider.createDatabase).not.toHaveBeenCalled();
    expect(provider.readOperation).toHaveBeenCalledWith(operation.id);
    expect(persistence.recordCreated).toHaveBeenCalledWith(claim, expect.anything(), {
      database,
      operation,
    });
  });
});
