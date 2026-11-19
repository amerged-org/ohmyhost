import { parseUlid } from "@ohmyhost/platform";
import {
  StorageGatewayConflictError,
  StorageGatewayBindingChangedError,
  StorageGatewayDataChangeInProgressError,
  StorageGatewayQuotaError,
  StorageErasureConflictError,
} from "@ohmyhost/database";
import type { StorageGatewayScope } from "./bindings.js";
import type {
  StorageGatewayPersistence,
  StorageRequestScope,
  StorageGatewayRuntimeBinding,
} from "./persistence.js";
import type {
  RetiredStoragePersistence,
  StorageDataRuntimeBinding,
} from "./management-persistence.js";
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid Storage Core response");
  return v as Record<string, unknown>;
}
function date(v: unknown): Date {
  if (!(v instanceof Date) || !Number.isFinite(v.getTime()))
    throw new Error("Invalid Storage Core date");
  return v;
}
async function invoke<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof Error) {
      if (e.name === "StorageGatewayConflictError")
        throw new StorageGatewayConflictError(
          e.message.includes("multiple historical")
            ? "storage_object_conflict"
            : "storage_gateway_conflict",
        );
      if (e.name === "StorageGatewayQuotaError") throw new StorageGatewayQuotaError();
      if (e.name === "StorageGatewayBindingChangedError")
        throw new StorageGatewayBindingChangedError();
      if (e.name === "StorageGatewayDataChangeInProgressError")
        throw new StorageGatewayDataChangeInProgressError();
      if (e.name === "StorageErasureConflictError") throw new StorageErasureConflictError();
    }
    throw e;
  }
}
export function requireStorageCore(value: unknown): StorageGatewayRuntimeBinding {
  if (
    !value ||
    typeof value !== "object" ||
    [
      "authenticateStorageGateway",
      "claimStorageUpload",
      "readStorageUploadReservation",
      "completeStorageUpload",
      "readStorageObject",
      "claimStorageDelete",
      "completeStorageErasure",
      "readStorageObjects",
      "readUnconfirmedStorageClaims",
      "markUnconfirmedStorageClaimAttempts",
      "claimStorageDeletes",
      "completeStorageErasures",
    ].some((k) => typeof Reflect.get(value, k) !== "function")
  )
    throw new Error("Storage private Core runtime required");
  return value as StorageGatewayRuntimeBinding;
}
function result(v: unknown): "created" | "existing" {
  if (v !== "created" && v !== "existing") throw new Error("Invalid Storage completion response");
  return v;
}
/** The frozen identity accompanies EVERY compound; no metadata response is reused as a later authorization. */
export function createCoreStoragePersistence(
  binding: StorageGatewayRuntimeBinding,
  scope: StorageRequestScope,
): StorageGatewayPersistence {
  let bound: StorageGatewayScope | null = "kind" in scope ? (scope.deploymentScope ?? null) : scope;
  const call = (run: (requestScope: StorageGatewayScope) => Promise<unknown>) =>
    invoke(() => {
      if (bound === null) throw new Error("Storage work before authentication");
      return run(bound);
    });
  return {
    async authenticate(projectId, environmentId, keySha256) {
      const value = await invoke(() =>
        binding.authenticateStorageGateway({
          scope: bound,
          input: {
            projectId,
            environmentId,
            keySha256,
            ...(bound ? { dataEnvironmentId: bound.dataEnvironmentId } : {}),
          },
        }),
      );
      if (value === null) return null;
      const r = object(value),
        identity = {
          organizationId: parseUlid(String(r["organizationId"])),
          projectId: parseUlid(String(r["projectId"])),
          environmentId: parseUlid(String(r["environmentId"])),
          bucketName: String(r["bucketName"]),
          jurisdiction: r["jurisdiction"] as "eu" | "us",
          quotaBytes: Number(r["quotaBytes"]),
          dataEnvironmentId: parseUlid(String(r["dataEnvironmentId"])),
        };
      if (
        identity.projectId !== scope.projectId ||
        (bound &&
          (identity.organizationId !== bound.organizationId ||
            identity.projectId !== bound.projectId ||
            identity.environmentId !== bound.environmentId ||
            identity.dataEnvironmentId !== bound.dataEnvironmentId))
      )
        return null;
      if (bound === null)
        bound = {
          organizationId: identity.organizationId,
          projectId: identity.projectId,
          environmentId: identity.environmentId,
          dataEnvironmentId: identity.dataEnvironmentId,
        };
      return identity;
    },
    async claim(input) {
      const r = object(await call((scope) => binding.claimStorageUpload({ scope, input })));
      return {
        outcome: r["outcome"] as "claimed" | "existing" | "completed",
        transferId: String(r["transferId"]),
        expiresAt: date(r["expiresAt"]),
        physicalObjectKey: String(r["physicalObjectKey"]),
        dataEnvironmentId: String(r["dataEnvironmentId"]),
      };
    },
    async readReservation(input) {
      const value = await call((scope) => binding.readStorageUploadReservation({ scope, input }));
      if (value === null) return null;
      const r = object(value);
      return {
        transferId: String(r["transferId"]),
        objectKey: String(r["objectKey"]),
        contentType: String(r["contentType"]),
        expectedBytes: Number(r["expectedBytes"]),
        requestedAt: date(r["requestedAt"]),
        expiresAt: date(r["expiresAt"]),
        completed: r["completed"] === true,
        environmentId: String(r["environmentId"]),
        physicalObjectKey: String(r["physicalObjectKey"]),
        dataEnvironmentId: String(r["dataEnvironmentId"]),
        jurisdiction: r["jurisdiction"] as "eu" | "us",
      };
    },
    async complete(input) {
      return result(await call((scope) => binding.completeStorageUpload({ scope, input })));
    },
    async readObject(input) {
      const value = await call((scope) => binding.readStorageObject({ scope, input }));
      if (value === null) return null;
      const r = object(value);
      return { ...r, uploadedAt: date(r["uploadedAt"]) } as Awaited<
        ReturnType<StorageGatewayPersistence["readObject"]>
      >;
    },
    async claimDelete(input) {
      const r = object(await call((scope) => binding.claimStorageDelete({ scope, input })));
      return {
        ...r,
        expiresAt: date(r["expiresAt"]),
        completedAt: r["completedAt"] == null ? null : date(r["completedAt"]),
      } as Awaited<ReturnType<StorageGatewayPersistence["claimDelete"]>>;
    },
    async completeDelete(input) {
      return result(await call((scope) => binding.completeStorageErasure({ scope, input })));
    },
    async readObjects(input) {
      const value = await call((scope) =>
        binding.readStorageObjects({
          scope,
          input: {
            organizationId: input.organizationId,
            projectId: input.projectId,
            environmentId: input.environmentId,
            objectKeys: input.objectKeys,
          },
        }),
      );
      if (!Array.isArray(value)) throw new Error("Invalid Storage objects response");
      return value.map((v) =>
        v === null ? null : { ...object(v), uploadedAt: date(object(v)["uploadedAt"]) },
      ) as Awaited<ReturnType<StorageGatewayPersistence["readObjects"]>>;
    },
    async claimDeletes(inputs) {
      const value = await call((scope) =>
        binding.claimStorageDeletes({
          scope,
          inputs: inputs.map((q) => ({
            deletionId: q.deletionId,
            organizationId: q.organizationId,
            projectId: q.projectId,
            environmentId: q.environmentId,
            idempotencyKey: q.idempotencyKey,
            requestSha256: q.requestSha256,
            objectKey: q.objectKey,
            requestedAt: q.requestedAt,
          })),
        }),
      );
      if (!Array.isArray(value)) throw new Error("Invalid Storage delete response");
      return value.map(
        (v): Awaited<ReturnType<StorageGatewayPersistence["claimDeletes"]>>[number] => {
          const r = object(v);
          if (r["state"] === "not_found")
            return { state: "not_found", objectKey: String(r["objectKey"]) };
          if (r["state"] !== "claimed" && r["state"] !== "completed")
            throw new Error("Invalid Storage delete state");
          return {
            state: r["state"],
            objectKey: String(r["objectKey"]),
            deletionId: String(r["deletionId"]),
            environmentId: String(r["environmentId"]),
            dataEnvironmentId: String(r["dataEnvironmentId"]),
            physicalObjectKey: String(r["physicalObjectKey"]),
            jurisdiction: r["jurisdiction"] as "eu" | "us",
            expiresAt: date(r["expiresAt"]),
            completedAt: r["completedAt"] == null ? null : date(r["completedAt"]),
            transferId: String(r["transferId"]),
            payloadErased: r["payloadErased"] === true,
          };
        },
      );
    },
    async completeDeletes(inputs) {
      const value = await call((scope) => binding.completeStorageErasures({ scope, inputs }));
      if (!Array.isArray(value) || value.length !== inputs.length)
        throw new Error("Invalid Storage erasure vector");
      return value.map(result);
    },
  };
}
/** One unconfirmed upload claim a day old, as the platform sweep lists it; the scope is its own frozen data area. */
export interface UnconfirmedStorageClaim {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly dataEnvironmentId: string;
  readonly transferId: string;
  readonly objectKey: string;
  readonly physicalObjectKey: string;
  readonly jurisdiction: "eu" | "us";
  readonly requestedAt: Date;
}

/** The platform sweep stamps the claims it tried and did not erase, so the next pass lists the others first. */
export async function markUnconfirmedStorageClaimAttempts(
  binding: StorageGatewayRuntimeBinding,
  input: { readonly now: string; readonly transferIds: readonly string[] },
): Promise<void> {
  await invoke(() => binding.markUnconfirmedStorageClaimAttempts(input));
}
/** The platform sweep's read: no caller scope, so the Core answers for the whole partition, oldest claims first. */
export async function readUnconfirmedStorageClaims(
  binding: StorageGatewayRuntimeBinding,
  input: { readonly now: string; readonly limit: number },
): Promise<readonly UnconfirmedStorageClaim[]> {
  const value = await invoke(() => binding.readUnconfirmedStorageClaims(input));
  if (!Array.isArray(value)) throw new Error("Invalid Storage sweep response");
  return value.map((v) => {
    const r = object(v);
    if (r["jurisdiction"] !== "eu" && r["jurisdiction"] !== "us")
      throw new Error("Invalid Storage sweep jurisdiction");
    return {
      organizationId: String(r["organizationId"]),
      projectId: String(r["projectId"]),
      environmentId: String(r["environmentId"]),
      dataEnvironmentId: String(r["dataEnvironmentId"]),
      transferId: String(r["transferId"]),
      objectKey: String(r["objectKey"]),
      physicalObjectKey: String(r["physicalObjectKey"]),
      jurisdiction: r["jurisdiction"],
      requestedAt: date(r["requestedAt"]),
    };
  });
}

export function requireStorageDataCore(value: unknown): StorageDataRuntimeBinding {
  if (
    !value ||
    typeof value !== "object" ||
    [
      "readRetiredStorageInventory",
      "claimRetiredStorageDeletes",
      "completeRetiredStorageDeletes",
    ].some((k) => typeof Reflect.get(value, k) !== "function")
  )
    throw new Error("Retired Storage Core runtime required");
  return value as StorageDataRuntimeBinding;
}
/** Suppliers remain local and are materialized immediately before the named RPC; no callback or SQL crosses it. */
export function createCoreRetiredStoragePersistence(
  binding: StorageDataRuntimeBinding,
): RetiredStoragePersistence {
  return {
    async read(input) {
      const r = object(await invoke(() => binding.readRetiredStorageInventory(input)));
      if (!Array.isArray(r["items"])) throw new Error("Invalid retired inventory");
      return {
        items: r["items"].map((v) => {
          const r = object(v);
          return { ...r, requestedAt: date(r["requestedAt"]), expiresAt: date(r["expiresAt"]) };
        }) as Awaited<ReturnType<RetiredStoragePersistence["read"]>>["items"],
        maxExpiresAt: r["maxExpiresAt"] == null ? null : date(r["maxExpiresAt"]),
        deletedFiles: Number(r["deletedFiles"]),
      };
    },
    async claim(scope, items, requestedAt) {
      return (await invoke(() =>
        binding.claimRetiredStorageDeletes({
          ...scope,
          items: items(),
          requestedAt: requestedAt(),
        }),
      )) as Awaited<ReturnType<RetiredStoragePersistence["claim"]>>;
    },
    async complete(input) {
      await invoke(() => binding.completeRetiredStorageDeletes(input));
    },
  };
}
