import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { readSnapshot } from "../platform-support.js";
import {
  ACTIVE_TARGET_SQL,
  CURRENT_OPERATION_EPOCH,
  CLAIM_SQL,
  OBSERVABLE_CLAIM_SQL,
  DELETE_AUTHORITY_SQL,
  claimParams,
  deleteAuthorityParams,
  type ClaimScope,
} from "./authority.js";
import { cleanupLocatorOf } from "./contracts.js";
import { stale } from "./run.js";

type Row = Record<string, unknown>;

/**
 * The ways `authorizeDatabaseProviderClaim` of the PostgreSQL original is satisfied. Each is a fact that a write batch
 * re-checks as a guard, so an authority that lapses between the decision and the commit aborts the whole batch.
 *
 * - `claim`: the accepted provider mutation claim of this operation (current owner, lifecycle, queued or running).
 * - `delete`: `database.delete` under the frozen deletion inventory (claim id is the operation id).
 * - `cutover`: the owner's authorization of a live PGCF region cutover (`database.create` / `role.create:*`).
 *
 * `database.resize` requires its own live native compute claim under the original owner/epoch/lifecycle.
 */
export type AuthorityGrant =
  | { readonly kind: "claim" }
  | { readonly kind: "operation_observation" }
  | { readonly kind: "cutover" }
  | { readonly kind: "compute" }
  | { readonly kind: "delete"; readonly databaseId: string; readonly locator: string };

/** Parameters ?1 organization, ?2 project, ?3 physical environment, ?4 operation. */
export const CUTOVER_AUTHORITY_SQL = `SELECT 1 FROM database_provider_cutover_authorizations a
  JOIN operations op ON op.organization_id = a.organization_id AND op.project_id = a.project_id AND op.operation_id = a.operation_id
  JOIN projects p ON p.organization_id = a.organization_id AND p.project_id = a.project_id
  JOIN database_provider_target_heads h ON h.organization_id = a.organization_id AND h.project_id = a.project_id AND h.physical_environment_id = a.physical_environment_id
 WHERE a.organization_id = ?1 AND a.project_id = ?2 AND a.physical_environment_id = ?3 AND a.operation_id = ?4
   AND op.state = 'running' AND p.lifecycle_state = 'active' AND p.lifecycle_version = a.expected_lifecycle_version AND p.owner_state = 'active'
   AND ${CURRENT_OPERATION_EPOCH} AND h.target_version = a.source_target_version AND h.state = 'active'`;

/** Original221 resize authority uses execution time, never a caller-supplied clock. */
export const COMPUTE_AUTHORITY_SQL = `SELECT 1 FROM pgcf_database_compute_changes j
 JOIN projects p ON p.organization_id=j.organization_id AND p.project_id=j.project_id
 JOIN operations op ON op.organization_id=j.organization_id AND op.project_id=j.project_id AND op.operation_id=j.operation_id
 WHERE j.organization_id=?1 AND j.project_id=?2 AND j.data_environment_id=?3 AND j.operation_id=?4 AND j.claim_id=?5
 AND j.claim_expires_at>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND j.completed_at IS NULL
 AND j.accepted_lifecycle_version=p.lifecycle_version AND j.billing_epoch_id=p.active_billing_epoch_id
 AND p.owner_state='active' AND p.lifecycle_state='active' AND op.state='running'`;

const cutoverParams = (claim: ClaimScope) => claimParams(claim).slice(0, 4);
/** Original dispatch evidence permits observation after Paid loss under the unchanged current claim, never another effect. */
export const DATABASE_OPERATION_OBSERVATION = `SELECT 1 FROM database_provider_operations observation WHERE observation.organization_id=?1 AND observation.project_id=?2 AND observation.physical_environment_id=?3 AND observation.operation_id=?4 AND observation.claim_id=?5 AND observation.state<>'reserved' AND EXISTS(${OBSERVABLE_CLAIM_SQL})`;

const isCutoverStep = (step: string | undefined) =>
  step === "database.create" || (step?.startsWith("role.create:") ?? false);

export interface AuthoritySnapshot {
  readonly grant: AuthorityGrant | null;
  /** The active target row of the physical environment, when there is one. */
  readonly target: Row | null;
}

/**
 * One consistent read of the authority facts of a claim. The decision uses `grant`; the write batch carries
 * `authorityGuard(grant)` so the same fact is re-proved at commit.
 */
export async function readAuthority(
  db: D1Database,
  claim: ClaimScope,
  step?: string,
): Promise<AuthoritySnapshot> {
  const [claimed, cutover, target, compute] = await readSnapshot(db, [
    [CLAIM_SQL, ...claimParams(claim)],
    [CUTOVER_AUTHORITY_SQL, ...cutoverParams(claim)],
    [ACTIVE_TARGET_SQL, claim.organizationId, claim.projectId, claim.physicalEnvironmentId],
    [COMPUTE_AUTHORITY_SQL, ...claimParams(claim)],
  ]);
  const activeTarget = target?.[0] ?? null;
  if (step === "database.resize" && (compute?.length ?? 0) === 1)
    return { grant: { kind: "compute" }, target: activeTarget };
  if ((claimed?.length ?? 0) === 1) return { grant: { kind: "claim" }, target: activeTarget };
  if (claim.claimId === claim.operationId && isCutoverStep(step) && (cutover?.length ?? 0) === 1)
    return { grant: { kind: "cutover" }, target: activeTarget };
  if (
    claim.claimId === claim.operationId &&
    step === "database.delete" &&
    activeTarget !== null &&
    activeTarget["provider"] === "pgcf" &&
    typeof activeTarget["database_id"] === "string"
  ) {
    const databaseId = activeTarget["database_id"];
    const locator = cleanupLocatorOf(databaseId);
    const [deletion] = await readSnapshot(db, [
      [DELETE_AUTHORITY_SQL, ...deleteAuthorityParams({ ...claim, databaseId }, locator)],
    ]);
    if ((deletion?.length ?? 0) === 1)
      return { grant: { kind: "delete", databaseId, locator }, target: activeTarget };
  }
  return { grant: null, target: activeTarget };
}

/** Aborts the batch with `precondition_changed` unless the exact authority the decision read still holds. */
export function authorityGuard(
  db: D1Database,
  claim: ClaimScope,
  grant: AuthorityGrant,
): D1PreparedStatement {
  switch (grant.kind) {
    case "claim":
      return stale(db, `NOT EXISTS (${CLAIM_SQL})`, claimParams(claim));
    case "operation_observation":
      return stale(db, `NOT EXISTS (${DATABASE_OPERATION_OBSERVATION})`, claimParams(claim));
    case "compute":
      return stale(db, `NOT EXISTS (${COMPUTE_AUTHORITY_SQL})`, claimParams(claim));
    case "cutover":
      return stale(db, `NOT EXISTS (${CUTOVER_AUTHORITY_SQL})`, cutoverParams(claim));
    case "delete":
      return stale(
        db,
        `NOT EXISTS (${DELETE_AUTHORITY_SQL})`,
        deleteAuthorityParams({ ...claim, databaseId: grant.databaseId }, grant.locator),
      );
  }
}
