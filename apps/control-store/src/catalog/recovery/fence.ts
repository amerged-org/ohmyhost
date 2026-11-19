import { workflowExecutionGuards } from "../provisioning/authority.js";
import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  OPERATION_LEASE_MILLISECONDS,
  addMilliseconds,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { isoOf } from "../platform-support.js";
import {
  ProjectRecoveryConflictError,
  RecoveryFenceLostError,
  RecoveryScopeUnavailableError,
  RecoverySourceBusyError,
} from "./errors.js";
import {
  atExecution,
  executionClock,
  effectiveNowSql,
  FENCE_HELD_SQL,
  DB_NOW,
  fenceCurrentParams,
  fenceCurrentSql,
  isCurrentHolder,
  isExecutionClock,
  liveFence,
  readRecoverySnapshot,
  uuid,
  RECOVERY_JOB_DATA_ALLOWED_SQL,
  type RecoverySnapshot,
} from "./shared.js";

/** A capture lease never outlives one operation lease (15 minutes); the PostgreSQL transaction was bounded at 11 minutes. */
export const MAXIMUM_FENCE_LEASE_MILLISECONDS = OPERATION_LEASE_MILLISECONDS;
const STALE = ["claim_lost", "precondition_changed", "row_version_conflict"] as const;

const holderScope = {
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  holderId: uuid,
  now: instant,
  clock: executionClock,
};
const leaseMilliseconds = z.number().int().min(1_000).max(MAXIMUM_FENCE_LEASE_MILLISECONDS);

export interface RecoveryFenceLease {
  readonly outcome: "acquired" | "renewed" | "replayed";
  readonly epoch: number;
  readonly holderId: string;
  readonly leaseExpiresAt: string;
  readonly sourceOwnershipVersion: number;
  readonly sourceLifecycleVersion: number;
}

// ---------------------------------------------------------------------------------------------------------------
// acquire
// ---------------------------------------------------------------------------------------------------------------

export const acquireRecoveryFenceInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  claimId: uuid,
  /** Names this one executor invocation; a repeat of the same call is a replay, another holder is refused while the lease is live. */
  holderId: uuid,
  now: instant,
  clock: executionClock,
  leaseMilliseconds,
});

/**
 * The durable capture lease that replaces the PostgreSQL advisory transaction lock. It is acquired only for a running
 * job the caller claimed, on an active project, and only when no live lease exists. Taking over an expired or released
 * lease raises the epoch, so a former holder is recognised as stale by every later guarded write. The fence is a row,
 * not a database session: nothing is held across a D1 call, and a crashed holder simply lets the lease lapse.
 */
export async function acquireRecoveryFence(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecoveryFenceLease> {
  const request = acquireRecoveryFenceInput.parse(rawInput);
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<RecoverySnapshot, RecoveryFenceLease> = {
    name: "recovery.acquireRecoveryFence",
    input: request,
    retryOn: STALE,
    naturalKeyTables: ["project_recovery_fences"],
    read: (reader) => readRecoverySnapshot(reader, request),
    decide: ({ job, fence, project, dbNow, delegation }) => {
      // Every attempt decides at the SQL clock it just read (`clock: "execution"`) and guards its write at execution.
      const input = atExecution(request, "now", dbNow);
      const execution = isExecutionClock(request);
      const leaseExpiresAt = addMilliseconds(input.now, input.leaseMilliseconds);
      if (project === null || project.active !== 1) {
        return { reject: new RecoveryScopeUnavailableError() };
      }
      if (
        job === null ||
        job.state !== "running" ||
        job.claim_id !== input.claimId ||
        job.active_scope !== 1
      ) {
        return { reject: new ProjectRecoveryConflictError() };
      }
      const live = liveFence(fence, input.now);
      if (live !== null) {
        return live.holder_id === input.holderId &&
          live.operation_id === input.operationId &&
          live.claim_id === input.claimId
          ? {
              statements: [
                ...workflowExecutionGuards(shard.db, input, delegation),
                guard(
                  shard.db,
                  "claim_lost",
                  `NOT EXISTS(SELECT 1 FROM project_recovery_jobs job WHERE job.organization_id=?1
                    AND job.project_id=?2 AND job.operation_id=?3 AND ${RECOVERY_JOB_DATA_ALLOWED_SQL})`,
                  [input.organizationId, input.projectId, input.operationId],
                ),
              ],
              result: () => ({
                outcome: "replayed" as const,
                epoch: live.epoch,
                holderId: live.holder_id,
                leaseExpiresAt: isoOf(live.lease_expires_at),
                sourceOwnershipVersion: live.source_ownership_version,
                sourceLifecycleVersion: live.source_lifecycle_version,
              }),
            }
          : { reject: new RecoverySourceBusyError() };
      }
      const epoch = (fence?.epoch ?? 0) + 1;
      const statements: D1PreparedStatement[] = [
        ...workflowExecutionGuards(shard.db, input, delegation),
        // The job is still the running, claimed one and the project still has the versions the lease will pin.
        guard(
          shard.db,
          "claim_lost",
          `NOT EXISTS (SELECT 1 FROM project_recovery_jobs job JOIN operations operation ON operation.organization_id = job.organization_id AND operation.operation_id = job.operation_id
             WHERE job.organization_id = ?1 AND job.operation_id = ?2 AND job.claim_id = ?3 AND operation.state = 'running' AND job.finished_at IS NULL AND ${RECOVERY_JOB_DATA_ALLOWED_SQL})`,
          [input.organizationId, input.operationId, input.claimId],
        ),
        guard(
          shard.db,
          "precondition_changed",
          `NOT EXISTS (SELECT 1 FROM projects WHERE organization_id = ?1 AND project_id = ?2 AND owner_state = 'active' AND lifecycle_state = 'active'
             AND ownership_version = ?3 AND lifecycle_version = ?4)`,
          [
            input.organizationId,
            input.projectId,
            project.ownership_version,
            project.lifecycle_version,
          ],
        ),
        // The lease about to be written must still be live when the batch executes; otherwise decide again at a fresh instant.
        ...(execution
          ? [
              guard(shard.db, "precondition_changed", `?1 <= ${effectiveNowSql("?2", true)}`, [
                leaseExpiresAt,
                input.now,
              ]),
            ]
          : []),
        fence === null
          ? shard.db
              .prepare(
                "INSERT INTO project_recovery_fences(organization_id, project_id, epoch, holder_id, operation_id, claim_id, acquired_at, lease_expires_at, released_at, source_ownership_version, source_lifecycle_version) VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9)",
              )
              .bind(
                input.organizationId,
                input.projectId,
                input.holderId,
                input.operationId,
                input.claimId,
                input.now,
                leaseExpiresAt,
                project.ownership_version,
                project.lifecycle_version,
              )
          : shard.db
              .prepare(
                // The previous epoch is the compare-and-swap and its lease must still be dead.
                `UPDATE project_recovery_fences SET epoch = ?3 + 1, holder_id = ?4, operation_id = ?5, claim_id = ?6, acquired_at = ?7, lease_expires_at = ?8,
                   released_at = NULL, source_ownership_version = ?9, source_lifecycle_version = ?10
                 WHERE organization_id = ?1 AND project_id = ?2 AND epoch = ?3 AND (released_at IS NOT NULL OR lease_expires_at <= ${effectiveNowSql("?7", execution)})`,
              )
              .bind(
                input.organizationId,
                input.projectId,
                fence.epoch,
                input.holderId,
                input.operationId,
                input.claimId,
                input.now,
                leaseExpiresAt,
                project.ownership_version,
                project.lifecycle_version,
              ),
        ...(fence === null ? [] : [guard(shard.db, "row_version_conflict", "changes() = 0")]),
      ];
      return {
        statements,
        result: () => ({
          outcome: "acquired",
          epoch,
          holderId: input.holderId,
          leaseExpiresAt: isoOf(leaseExpiresAt),
          sourceOwnershipVersion: project.ownership_version,
          sourceLifecycleVersion: project.lifecycle_version,
        }),
      };
    },
  };
  return runCommand(shard.db, command);
}

// ---------------------------------------------------------------------------------------------------------------
// renew
// ---------------------------------------------------------------------------------------------------------------

export const renewRecoveryFenceInput = z.strictObject({ ...holderScope, leaseMilliseconds });

/**
 * Extends the live lease of the current holder, never beyond one operation lease from its acquisition and never
 * backwards. A lapsed lease, another holder, a newer epoch or changed project versions are `recovery_fence_lost`.
 */
export async function renewRecoveryFence(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecoveryFenceLease> {
  const request = renewRecoveryFenceInput.parse(rawInput);
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<RecoverySnapshot, RecoveryFenceLease> = {
    name: "recovery.renewRecoveryFence",
    input: request,
    retryOn: STALE,
    read: (reader) => readRecoverySnapshot(reader, request),
    decide: ({ fence, project, dbNow, delegation }) => {
      const input = atExecution(request, "now", dbNow);
      const execution = isExecutionClock(request);
      if (fence === null || !isCurrentHolder(fence, project, input, input.now)) {
        return { reject: new RecoveryFenceLostError() };
      }
      const requested = addMilliseconds(input.now, input.leaseMilliseconds);
      const ceiling = addMilliseconds(fence.acquired_at, MAXIMUM_FENCE_LEASE_MILLISECONDS);
      const capped = requested < ceiling ? requested : ceiling;
      const next = capped > fence.lease_expires_at ? capped : fence.lease_expires_at;
      const lease = (outcome: RecoveryFenceLease["outcome"]): RecoveryFenceLease => ({
        outcome,
        epoch: fence.epoch,
        holderId: fence.holder_id,
        leaseExpiresAt: isoOf(next),
        sourceOwnershipVersion: fence.source_ownership_version,
        sourceLifecycleVersion: fence.source_lifecycle_version,
      });
      return {
        statements: [
          ...workflowExecutionGuards(shard.db, input, delegation),
          shard.db
            .prepare(
              `UPDATE project_recovery_fences SET lease_expires_at = ?7
               WHERE organization_id = ?1 AND project_id = ?2 AND epoch = ?3 AND holder_id = ?4 AND operation_id = ?5
                 AND EXISTS (${fenceCurrentSql(execution)})`,
            )
            .bind(...fenceCurrentParams(input, input, input.now), next),
          guard(shard.db, "claim_lost", "changes() = 0"),
        ],
        result: () => lease(next === fence.lease_expires_at ? "replayed" : "renewed"),
      };
    },
  };
  return runCommand(shard.db, command);
}

// ---------------------------------------------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------------------------------------------

export const releaseRecoveryFenceInput = z.strictObject(holderScope);

export interface RecoveryFenceRelease {
  /** `superseded`: a newer epoch or another holder owns the row (the caller's lease was already gone); `absent`: never acquired. */
  readonly outcome: "released" | "replayed" | "superseded" | "absent";
}

/** Releases the caller's own lease early. It touches only the exact (epoch, holder) row; a stale holder cannot free a newer lease. */
export async function releaseRecoveryFence(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecoveryFenceRelease> {
  const request = releaseRecoveryFenceInput.parse(rawInput);
  const shard = await routeOrganization(context, request.organizationId);
  const command: Command<RecoverySnapshot, RecoveryFenceRelease> = {
    name: "recovery.releaseRecoveryFence",
    input: request,
    retryOn: STALE,
    read: (reader) => readRecoverySnapshot(reader, request),
    decide: ({ fence, dbNow }) => {
      const input = atExecution(request, "now", dbNow);
      if (fence === null) return { replay: { outcome: "absent" } };
      if (fence.epoch !== input.epoch || fence.holder_id !== input.holderId) {
        return { replay: { outcome: "superseded" } };
      }
      if (fence.released_at !== null) return { replay: { outcome: "replayed" } };
      return {
        statements: [
          shard.db
            .prepare(
              "UPDATE project_recovery_fences SET released_at = ?5 WHERE organization_id = ?1 AND project_id = ?2 AND epoch = ?3 AND holder_id = ?4 AND released_at IS NULL",
            )
            .bind(input.organizationId, input.projectId, input.epoch, input.holderId, input.now),
          guard(shard.db, "claim_lost", "changes() = 0"),
        ],
        result: () => ({ outcome: "released" }),
      };
    },
  };
  return runCommand(shard.db, command);
}

// ---------------------------------------------------------------------------------------------------------------
// the deletion side of the fence
// ---------------------------------------------------------------------------------------------------------------

export const readRecoveryCaptureHeldInput = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  now: instant,
  clock: executionClock,
});

/**
 * The shard form of `allowDeletionDuringRecovery` (negated): true while a capture holds the project at `now`. A
 * deletion or data change must not be accepted then. The composing command also puts `recoveryCaptureHeldGuard`
 * into its own batch, so a capture that starts after its snapshot aborts the acceptance.
 */
export async function readRecoveryCaptureHeld(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly held: boolean }> {
  const input = readRecoveryCaptureHeldInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const execution = input.clock === "execution";
  const row = await shard.db
    .prepare(`SELECT ${execution ? FENCE_HELD_SQL.replace("?3", DB_NOW) : FENCE_HELD_SQL} AS held`)
    .bind(input.organizationId, input.projectId, ...(execution ? [] : [input.now]))
    .first<{ held: number }>();
  return { held: row?.held === 1 };
}

/** Aborts the batch (`precondition_changed`) while a capture holds the project. Compose it into the batch of a deletion or data-change acceptance. */
export function recoveryCaptureHeldGuard(
  db: D1Database,
  scope: { readonly organizationId: string; readonly projectId: string },
  now: string,
  executionClock = true,
): D1PreparedStatement {
  // Production defaults to the SQL clock, not max(caller time, SQL time): a forged future must not bypass a capture.
  // The false option exists only for deterministic local comparison fixtures, never on a service-binding body.
  return guard(
    db,
    "precondition_changed",
    executionClock ? FENCE_HELD_SQL.replace("?3", DB_NOW) : FENCE_HELD_SQL,
    [scope.organizationId, scope.projectId, ...(executionClock ? [] : [now])],
  );
}
