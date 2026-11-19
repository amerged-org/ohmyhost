import { projectR2BucketTarget } from "@ohmyhost/provider-cloudflare";
import type { R2ObjectObservation, R2PayloadErasureResult } from "@ohmyhost/provider-cloudflare";
import type { StorageGatewayScope } from "./bindings.js";
import type { UnconfirmedStorageClaim } from "./core-persistence.js";
import type { StorageGatewayPersistence } from "./persistence.js";
import { STORAGE_PUT_DRAIN_MILLISECONDS } from "./runtime.js";

/** The sweep lists at most this many claims per pass; the next hourly pass takes the rest. */
export const UPLOAD_SWEEP_PASS_LIMIT = 50;

export interface UploadSweepSummary {
  readonly listed: number;
  readonly erased: number;
  readonly deferred: number;
  readonly failed: number;
}

export interface UploadSweepDependencies {
  listUnconfirmed(input: {
    readonly now: string;
    readonly limit: number;
  }): Promise<readonly UnconfirmedStorageClaim[]>;
  markAttempts(input: {
    readonly now: string;
    readonly transferIds: readonly string[];
  }): Promise<void>;
  persistence(
    scope: StorageGatewayScope,
  ): Pick<StorageGatewayPersistence, "claimDelete" | "completeDelete">;
  provider: {
    observeObject(input: unknown): Promise<R2ObjectObservation>;
    erasePayloads(input: unknown): Promise<readonly R2PayloadErasureResult[]>;
  };
  ids: { next(): string };
  sha256(value: string): Promise<Uint8Array>;
  now(): Date;
}

/** A claim the sweep refuses to erase: the provider answered for another object, or the erasure failed. */
class UploadSweepRefusedError extends Error {
  constructor(readonly code: string) {
    super("Storage upload sweep refused an unconfirmed claim");
    this.name = "UploadSweepRefusedError";
  }
}

/**
 * Erases abandoned signed uploads: unconfirmed claims a day old are claimed as deletions in their own frozen scope and
 * their payloads are replaced with erasure markers, then completed with the marker proof. Each claim is independent:
 * a failure is logged by its transfer and the pass goes on with the next claim.
 */
export function createUploadSweep(dependencies: UploadSweepDependencies) {
  return Object.freeze({
    async sweep(): Promise<UploadSweepSummary> {
      const claims = await dependencies.listUnconfirmed({
        now: dependencies.now().toISOString(),
        limit: UPLOAD_SWEEP_PASS_LIMIT,
      });
      const summary = { listed: claims.length, erased: 0, deferred: 0, failed: 0 };
      // The claims not erased in this pass are stamped after it, so the next pass lists the claims not yet tried first.
      const unfinished: string[] = [];
      for (const claim of claims) {
        try {
          if ((await eraseClaim(claim, dependencies)) === "erased") summary.erased++;
          else {
            summary.deferred++;
            unfinished.push(claim.transferId);
          }
        } catch (error) {
          summary.failed++;
          unfinished.push(claim.transferId);
          console.warn(
            JSON.stringify({
              event: "storage_upload_sweep_failed",
              transferId: claim.transferId,
              code: codeOf(error),
            }),
          );
        }
      }
      if (unfinished.length > 0) {
        // The erasures already happened: a failed stamp only delays the rotation of these claims, so the summary is kept.
        try {
          await dependencies.markAttempts({
            now: dependencies.now().toISOString(),
            transferIds: unfinished,
          });
        } catch (error) {
          console.warn(
            JSON.stringify({ event: "storage_upload_sweep_stamp_failed", code: codeOf(error) }),
          );
        }
      }
      return summary;
    },
  });
}

async function eraseClaim(
  claim: UnconfirmedStorageClaim,
  dependencies: UploadSweepDependencies,
): Promise<"erased" | "deferred"> {
  const target = projectR2BucketTarget(claim.projectId, claim.environmentId, claim.jurisdiction);
  // The physical object is observed before anything is written; a locator the provider answers for another key is refused.
  const observed = await dependencies.provider.observeObject({
    target,
    objectKey: claim.physicalObjectKey,
  });
  if (observed.state === "found" && observed.objectKey !== claim.physicalObjectKey)
    throw new UploadSweepRefusedError("storage_locator_invalid");
  const persistence = dependencies.persistence({
    organizationId: claim.organizationId,
    projectId: claim.projectId,
    environmentId: claim.environmentId,
    dataEnvironmentId: claim.dataEnvironmentId,
  });
  // The deletion is claimed before the erasure, so the erasure can prove it happened after the claim was requested.
  const claimed = await persistence.claimDelete({
    deletionId: dependencies.ids.next(),
    organizationId: claim.organizationId,
    projectId: claim.projectId,
    environmentId: claim.environmentId,
    idempotencyKey: `sweep:${claim.transferId}`,
    requestSha256: await dependencies.sha256(
      JSON.stringify({
        projectId: claim.projectId,
        environmentId: claim.environmentId,
        objectKey: claim.objectKey,
        transferId: claim.transferId,
      }),
    ),
    objectKey: claim.objectKey,
    requestedAt: dependencies.now().toISOString(),
  });
  if (
    claimed.transferId !== claim.transferId ||
    claimed.physicalObjectKey !== claim.physicalObjectKey
  )
    throw new UploadSweepRefusedError("storage_locator_invalid");
  if (claimed.payloadErased) return "erased";
  // A late signed PUT may still land until the drain has passed; such a claim waits for a later pass.
  if (claimed.expiresAt.getTime() + STORAGE_PUT_DRAIN_MILLISECONDS > dependencies.now().getTime())
    return "deferred";
  const erased = (
    await dependencies.provider.erasePayloads({
      target,
      objects: [
        {
          organizationId: claim.organizationId,
          projectId: claim.projectId,
          environmentId: claim.environmentId,
          dataEnvironmentId: claim.dataEnvironmentId,
          transferId: claim.transferId,
          objectKey: claim.physicalObjectKey,
        },
      ],
    })
  )[0];
  if (
    erased === undefined ||
    erased.objectKey !== claim.physicalObjectKey ||
    erased.transferId !== claim.transferId
  )
    throw new UploadSweepRefusedError("storage_locator_invalid");
  if (erased.status === "pending") return "deferred";
  if (erased.status === "failed") throw new UploadSweepRefusedError("storage_erasure_failed");
  await persistence.completeDelete({
    deletionId: claimed.deletionId,
    organizationId: claim.organizationId,
    projectId: claim.projectId,
    environmentId: claim.environmentId,
    dataEnvironmentId: claim.dataEnvironmentId,
    transferId: claim.transferId,
    objectKey: claim.objectKey,
    physicalObjectKey: claim.physicalObjectKey,
    markerSha256: erased.markerSha256,
    erasedAt: erased.erasedAt.toISOString(),
  });
  return "erased";
}

function codeOf(error: unknown): string {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "storage_upload_sweep_unexpected";
}
