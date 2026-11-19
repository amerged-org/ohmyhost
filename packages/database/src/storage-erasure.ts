import { createHash } from "node:crypto";
import { parseUlid } from "@ohmyhost/platform";
import type { TransactionClient } from "./transaction.js";

export interface StorageErasureProof {
  readonly deletionId: string;
  readonly organizationId: string;
  readonly projectId: string;
  /** The original uploader's bucket environment, independent of the current caller. */
  readonly environmentId: string;
  readonly dataEnvironmentId: string;
  readonly transferId: string;
  readonly objectKey: string;
  readonly physicalObjectKey: string;
  readonly markerSha256: Uint8Array;
  readonly erasedAt: string;
}
type MarkerScope = Pick<
  StorageErasureProof,
  | "organizationId"
  | "projectId"
  | "environmentId"
  | "dataEnvironmentId"
  | "transferId"
  | "physicalObjectKey"
>;
export class StorageErasureConflictError extends Error {
  readonly code = "storage_erasure_conflict";
  constructor() {
    super("Storage erasure conflicts with accepted deletion custody");
    this.name = "StorageErasureConflictError";
  }
}

function key(value: unknown, maximumBytes: number): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    !/^[A-Za-z0-9._/-]+$/u.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new StorageErasureConflictError();
}

/** Deterministic marker metadata; callers must verify an actual zero-byte R2 marker before completion. */
export function storageErasureMarkerDigest(scope: MarkerScope): Uint8Array {
  for (const value of [
    scope.organizationId,
    scope.projectId,
    scope.environmentId,
    scope.dataEnvironmentId,
    scope.transferId,
  ])
    parseUlid(value);
  key(scope.physicalObjectKey, 544);
  return new Uint8Array(
    createHash("sha256")
      .update(
        [
          "ohmyhost.r2-erasure/v1",
          scope.organizationId,
          scope.projectId,
          scope.environmentId,
          scope.dataEnvironmentId,
          scope.transferId,
          scope.physicalObjectKey,
        ].join(String.fromCharCode(10)),
        "utf8",
      )
      .digest(),
  );
}

/** One bounded vector statement: invalid custody prevents every insert, even before caller rollback. */
export declare function completeStorageErasures(
  client: TransactionClient,
  proofs: readonly StorageErasureProof[],
): Promise<readonly ("created" | "existing")[]>;
