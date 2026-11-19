import type { RetiredStoragePersistence } from "./management-persistence.js";
import type { RetiredStorageScope, StorageErasureProof } from "@ohmyhost/database";
import {
  projectR2BucketTarget,
  type R2ObjectObservation,
  type R2PayloadErasureResult,
} from "@ohmyhost/provider-cloudflare";
import { parseUlid } from "@ohmyhost/platform";
import { STORAGE_PUT_DRAIN_MILLISECONDS } from "./runtime.js";
import { withStorageErasureBudget, STORAGE_ERASURE_ACK_BATCH_SIZE } from "./erasure-budget.js";

export function createRetiredStoragePurger(dependencies: {
  persistence: RetiredStoragePersistence;
  provider: {
    observeObject: (
      input: unknown,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<R2ObjectObservation>;
    erasePayloads: (
      input: unknown,
      options?: { readonly signal?: AbortSignal },
    ) => Promise<readonly R2PayloadErasureResult[]>;
  };
  nextId: () => string;
  now: () => Date;
}) {
  return {
    async purgeRetiredData(
      value: unknown,
    ): Promise<
      | { status: "ready"; deletedFiles: number }
      | { status: "pending"; retryAfterSeconds: number; progress?: "page_completed" }
      | { status: "uncertain" }
    > {
      return withStorageErasureBudget(undefined, async (signal) => {
        const input = parseScope(value);
        const inventory = await dependencies.persistence.read(input);
        const current = dependencies.now();
        if (
          inventory.maxExpiresAt !== null &&
          inventory.maxExpiresAt.getTime() + STORAGE_PUT_DRAIN_MILLISECONDS >= current.getTime()
        )
          return {
            status: "pending",
            retryAfterSeconds:
              Math.ceil(
                (inventory.maxExpiresAt.getTime() +
                  STORAGE_PUT_DRAIN_MILLISECONDS -
                  current.getTime()) /
                  1000,
              ) + 1,
          };
        if (inventory.items.length === 0)
          return { status: "ready", deletedFiles: inventory.deletedFiles };
        let madeProgress = false;
        try {
          for (
            let offset = 0;
            offset < inventory.items.length;
            offset += STORAGE_ERASURE_ACK_BATCH_SIZE
          ) {
            if (signal.aborted) break;
            const page = inventory.items.slice(offset, offset + STORAGE_ERASURE_ACK_BATCH_SIZE);
            const observations = new Map<string, boolean>();
            for (const item of page) {
              if (signal.aborted) break;
              if (item.erasureProof !== undefined || item.completed) {
                observations.set(item.transferId, item.erasureProof === undefined);
                continue;
              }
              const observed = await dependencies.provider.observeObject(
                {
                  target: projectR2BucketTarget(
                    input.projectId,
                    item.environmentId,
                    item.jurisdiction,
                  ),
                  objectKey: item.physicalObjectKey,
                },
                { signal },
              );
              if (observed.state === "found" && observed.objectKey !== item.physicalObjectKey)
                throw new Error("storage_locator_invalid");
              observations.set(item.transferId, observed.state === "found");
            }
            if (signal.aborted) break;
            const claims = await dependencies.persistence.claim(
              input,
              () =>
                page.map((item) => ({
                  transferId: item.transferId,
                  deletionId: dependencies.nextId(),
                  objectObserved: observations.get(item.transferId) === true,
                })),
              () => dependencies.now().toISOString(),
            );
            const groups = new Map<string, typeof page>();
            for (const item of page) {
              const key = `${item.environmentId}/${item.jurisdiction}`;
              const group = groups.get(key) ?? [];
              group.push(item);
              groups.set(key, group);
            }
            for (const group of groups.values()) {
              if (signal.aborted) break;
              const first = group[0];
              if (first === undefined) throw new Error("storage_purge_contract_invalid");
              const uncached = group.filter((item) => item.erasureProof === undefined);
              const erased = uncached.length
                ? await dependencies.provider.erasePayloads(
                    {
                      target: projectR2BucketTarget(
                        input.projectId,
                        first.environmentId,
                        first.jurisdiction,
                      ),
                      objects: uncached.map((item) => ({
                        organizationId: input.organizationId,
                        projectId: input.projectId,
                        environmentId: item.environmentId,
                        dataEnvironmentId: item.dataEnvironmentId,
                        transferId: item.transferId,
                        objectKey: item.physicalObjectKey,
                      })),
                    },
                    { signal },
                  )
                : [];
              const seen = new Set(erased.map((item) => item.transferId));
              if (
                erased.length !== uncached.length ||
                seen.size !== uncached.length ||
                erased.some(
                  (result) =>
                    !uncached.some(
                      (item) =>
                        item.transferId === result.transferId &&
                        item.physicalObjectKey === result.objectKey,
                    ),
                )
              )
                throw new Error("storage_purge_contract_invalid");
              const proofs: StorageErasureProof[] = [];
              for (const item of group) {
                const claim = claims.find(
                  (claim) =>
                    claim.transferId === item.transferId &&
                    claim.environmentId === item.environmentId &&
                    claim.physicalObjectKey === item.physicalObjectKey,
                );
                if (claim === undefined) throw new Error("storage_purge_contract_invalid");
                const result = erased.find((result) => result.transferId === item.transferId);
                const marker =
                  item.erasureProof !== undefined
                    ? new Uint8Array(Buffer.from(item.erasureProof.markerSha256, "hex"))
                    : result?.status === "erased"
                      ? result.markerSha256
                      : undefined;
                if (marker === undefined) continue;
                proofs.push({
                  deletionId: claim.deletionId,
                  organizationId: input.organizationId,
                  projectId: input.projectId,
                  environmentId: item.environmentId,
                  dataEnvironmentId: item.dataEnvironmentId,
                  transferId: item.transferId,
                  objectKey: item.objectKey,
                  physicalObjectKey: item.physicalObjectKey,
                  markerSha256: marker,
                  erasedAt:
                    result?.status === "erased"
                      ? result.erasedAt.toISOString()
                      : dependencies.now().toISOString(),
                });
              }
              if (proofs.length) {
                await dependencies.persistence.complete({ ...input, items: proofs });
                madeProgress = true;
              }
              if (erased.some((result) => result.status === "failed"))
                return { status: "uncertain" as const };
            }
          }
        } catch {
          if (!signal.aborted) return { status: "uncertain" as const };
        }
        const after = await dependencies.persistence.read(input);
        return after.items.length === 0
          ? { status: "ready", deletedFiles: after.deletedFiles }
          : {
              status: "pending",
              retryAfterSeconds: 1,
              ...(madeProgress ? { progress: "page_completed" as const } : {}),
            };
      });
    },
  };
}
function parseScope(value: unknown): RetiredStorageScope {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("storage_purge_scope_invalid");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "claimId,dataEnvironmentId,environmentId,operationId,organizationId,projectId"
  )
    throw new Error("storage_purge_scope_invalid");
  for (const value of Object.values(record)) {
    if (typeof value !== "string") throw new Error("storage_purge_scope_invalid");
    parseUlid(value);
  }
  return record as unknown as RetiredStorageScope;
}
