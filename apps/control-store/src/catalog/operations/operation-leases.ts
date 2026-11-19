import {
  readAbandonedBuildRelease,
  abandonedBuildReleaseStatements,
  type AbandonedBuildRelease,
} from "../provisioning/build-release.js";
import { z } from "zod";

import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  addMilliseconds,
  auditStatement,
  conflict,
  fenceRaceGuard,
  instant,
  notFencedOrganization,
  newUlid,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";

export const readBlockingOperationInput = z.strictObject({
  organizationId: ulid,
  operationId: ulid,
});

/** The queued operation waits behind this one: it holds the project's single provider-mutation claim. */
export async function readBlockingProductOperation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<string | null> {
  const input = readBlockingOperationInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const row = await shard.db
    .prepare(
      `SELECT claim.operation_id FROM operations waiting
       JOIN product_provider_mutation_claims claim
         ON claim.organization_id = waiting.organization_id AND claim.project_id = waiting.project_id
       JOIN operations holder ON holder.organization_id = claim.organization_id AND holder.operation_id = claim.operation_id
       WHERE waiting.organization_id = ?1 AND waiting.operation_id = ?2 AND waiting.state = 'queued'
         AND holder.state IN ('queued','running') AND claim.operation_id <> waiting.operation_id`,
    )
    .bind(input.organizationId, input.operationId)
    .first<{ operation_id: string }>();
  return row?.operation_id ?? null;
}

export const renewOperationLeaseInput = z.strictObject({
  organizationId: ulid,
  operationId: ulid,
  workflowId: z.string().min(1),
  physicalWorkflowId: z.string().min(1),
  now: instant,
  durationMilliseconds: z.number().int().min(900_000).max(4_500_000),
});

/**
 * Fences every executing Workflow step: the lease moves only while the operation is open, its workflow run
 * is the queued run of this physical execution, and the previous lease has not lapsed. A succeeded operation
 * may still finish its cleanup steps.
 */
export async function renewOperationLease(
  context: CatalogContext,
  rawInput: unknown,
): Promise<void> {
  const input = renewOperationLeaseInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const renewed = await shard.db
    .prepare(
      `UPDATE operations SET lease_expires_at = ?4
       WHERE organization_id = ?1 AND operation_id = ?2 AND state IN ('queued','running')
         AND (lease_expires_at IS NULL OR lease_expires_at > ?3)
         AND EXISTS (SELECT 1 FROM product_workflow_runs run
           WHERE run.organization_id = operations.organization_id AND run.operation_id = operations.operation_id
             AND run.workflow_id = ?5 AND run.state = 'queued'
             AND ?6 = CASE WHEN run.active_reconciliation_attempt_id IS NOT NULL
               THEN 'product-provider-reconcile-v1-' || run.active_reconciliation_attempt_id
               WHEN run.active_replay_attempt_id IS NOT NULL
               THEN 'product-command-replay-v1-' || run.active_replay_attempt_id
               ELSE run.workflow_id END)`,
    )
    .bind(
      input.organizationId,
      input.operationId,
      input.now,
      addMilliseconds(input.now, input.durationMilliseconds),
      input.workflowId,
      input.physicalWorkflowId,
    )
    .run();
  if (renewed.meta.changes === 1) return;
  const completed = await shard.db
    .prepare(
      "SELECT 1 AS done FROM operations WHERE organization_id = ?1 AND operation_id = ?2 AND state = 'succeeded'",
    )
    .bind(input.organizationId, input.operationId)
    .first();
  if (completed === null)
    throw conflict("operation_lease_inactive", "Operation lease is no longer active");
}

export const recoverExpiredOperationLeaseInput = z.strictObject({
  now: instant,
  /** The shard a sweeper drains; ignored when one exact captured execution is recovered. */
  shardId: z.number().int().min(0).max(1023).optional(),
  /** Owner-operated recovery may recover only one exact captured expired execution. */
  exactOperation: z
    .strictObject({
      organizationId: ulid,
      projectId: ulid,
      operationId: ulid,
      leaseExpiresAt: instant,
    })
    .optional(),
});

interface Candidate {
  readonly organization_id: string;
  readonly operation_id: string;
  readonly project_id: string;
  readonly state: "queued" | "running";
  readonly billing_epoch_id: string;
  readonly lease_expires_at: string;
  readonly events: number;
  readonly switched_data_change: number;
}

const ABANDONED = {
  code: "OPERATION_ABANDONED",
  message: "The operation stopped renewing its execution lease.",
};
/** A data change whose data assignment switched is held for this long; then nobody reconciled it and it is abandoned. */
const SWITCHED_DATA_CHANGE_HOLD_MILLISECONDS = 24 * 60 * 60 * 1000;
const ABANDONED_SWITCHED_DATA_CHANGE = {
  code: "OPERATION_ABANDONED",
  message:
    "The data change stopped renewing its execution lease 24 hours after its data assignment switched, without reconciliation.",
};
const ABANDONED_SWITCHED_DATA_CHANGE_REASON =
  "A switched data change was not reconciled within 24 hours; its provider claim was released.";

export interface RecoveredOperation {
  readonly organizationId: string;
  readonly operationId: string;
  /** The never-started build reservation is released in this same batch; retained compatibility marker. */
  readonly releaseBuildCredits: true;
}

/**
 * An unresolved Neon project placement keeps its Workflow alive (D431): the reservation and the exact current
 * mutation claim of the same organization, project and operation. Recovery would release that claim, and the
 * provider create may already have started, so the operation is neither failed nor replayed here; another
 * eligible expired operation is selected instead. The physical environment is not compared (shared-data
 * placement can use a different one). `column` is the operation row's alias.
 */
const NO_UNRESOLVED_PLACEMENT = (operation: string) => `NOT EXISTS (
         SELECT 1 FROM product_provider_mutation_claims claim
         JOIN neon_project_placement_reservations placement
           ON placement.claim_id = claim.claim_id AND placement.organization_id = claim.organization_id
          AND placement.project_id = claim.project_id AND placement.operation_id = claim.operation_id
         WHERE claim.organization_id = ${operation}.organization_id AND claim.project_id = ${operation}.project_id
           AND claim.operation_id = ${operation}.operation_id)`;

/**
 * One expired Workflow per batch: the operation is failed (started first when it never started), the run
 * is completed, the provider claim released, deployments and GitHub push deployments failed and unacknowledged
 * outbox events marked for reconciliation. Two sweepers racing for the same candidate cannot both win: the
 * loser's compare-and-swap on the lease aborts its batch and it takes the next candidate. An operation whose
 * Neon placement reservation is unresolved is never selected, and a reservation created after the candidate
 * was read aborts the batch (`operation_conflict`) so the retry reads again without it.
 */
export async function recoverExpiredOperationLease(
  context: CatalogContext,
  rawInput: unknown,
): Promise<RecoveredOperation | null> {
  const input = recoverExpiredOperationLeaseInput.parse(rawInput);
  const exact = input.exactOperation;
  const shard =
    exact !== undefined
      ? await routeOrganization(context, exact.organizationId)
      : await context.router.routeShard(input.shardId ?? 0);
  const ids = {
    startEvent: newUlid(),
    failEvent: newUlid(),
    startAudit: newUlid(),
    failAudit: newUlid(),
  };
  const command: Command<
    { candidate: Candidate | null; build: AbandonedBuildRelease | null },
    RecoveredOperation | null
  > = {
    name: "operations.recoverExpiredOperationLease",
    input,
    retryOn: ["operation_conflict", "precondition_changed"],
    naturalKeyTables: ["credit_log"],
    lookup: async (reader) => {
      const committed = await reader
        .prepare(
          `SELECT event.organization_id,event.operation_id FROM operation_events event
        JOIN operations operation ON operation.organization_id=event.organization_id AND operation.operation_id=event.operation_id
        WHERE event.event_id=?1 AND event.event_type='OperationFailed' AND json_extract(event.payload,'$.failure.code')='OPERATION_ABANDONED' AND operation.state='failed'`,
        )
        .bind(ids.failEvent)
        .first<{ organization_id: string; operation_id: string }>();
      return committed === null
        ? undefined
        : {
            organizationId: committed.organization_id,
            operationId: committed.operation_id,
            releaseBuildCredits: true as const,
          };
    },
    read: async (reader) => {
      const candidate = await reader
        .prepare(
          `SELECT operation.organization_id, operation.operation_id, operation.project_id, operation.state,
                  operation.billing_epoch_id, operation.lease_expires_at,
                  (SELECT count(*) FROM operation_events event
                     WHERE event.organization_id = operation.organization_id AND event.operation_id = operation.operation_id) AS events,
                  EXISTS (SELECT 1 FROM environment_data_assignments switched
                     WHERE switched.organization_id = operation.organization_id AND switched.operation_id = operation.operation_id
                       AND EXISTS (SELECT 1 FROM product_workflow_runs data_run
                         WHERE data_run.organization_id = operation.organization_id AND data_run.operation_id = operation.operation_id
                           AND data_run.event_type = 'ProjectDataChangeRequestedV1')) AS switched_data_change
           FROM operations operation
           WHERE operation.state IN ('queued','running') AND operation.lease_expires_at <= ?1
             AND ${notFencedOrganization("operation.organization_id")}
             AND EXISTS (SELECT 1 FROM product_workflow_runs run
               WHERE run.organization_id = operation.organization_id AND run.operation_id = operation.operation_id)
             AND ${NO_UNRESOLVED_PLACEMENT("operation")}
             AND NOT EXISTS (SELECT 1 FROM native_auth_database_operations dispatched_create
               WHERE dispatched_create.organization_id = operation.organization_id AND dispatched_create.project_id = operation.project_id
                 AND dispatched_create.operation_id = operation.operation_id AND dispatched_create.state = 'dispatched')
             AND NOT EXISTS (SELECT 1 FROM environment_data_assignments switched
               WHERE switched.organization_id = operation.organization_id AND switched.operation_id = operation.operation_id
                 AND switched.assigned_at > ?6
                 AND EXISTS (SELECT 1 FROM product_workflow_runs data_run
                   WHERE data_run.organization_id = operation.organization_id AND data_run.operation_id = operation.operation_id
                     AND data_run.event_type = 'ProjectDataChangeRequestedV1'))
             AND (?2 IS NULL OR (operation.organization_id = ?2 AND operation.project_id = ?3
                  AND operation.operation_id = ?4 AND operation.lease_expires_at = ?5))
           ORDER BY operation.lease_expires_at, operation.operation_id LIMIT 1`,
        )
        .bind(
          input.now,
          exact?.organizationId ?? null,
          exact?.projectId ?? null,
          exact?.operationId ?? null,
          exact?.leaseExpiresAt ?? null,
          addMilliseconds(input.now, -SWITCHED_DATA_CHANGE_HOLD_MILLISECONDS),
        )
        .first<Candidate>();
      return {
        candidate,
        build:
          candidate === null
            ? null
            : await readAbandonedBuildRelease(
                reader,
                candidate.organization_id,
                candidate.project_id,
                candidate.operation_id,
              ),
      };
    },
    decide: ({ candidate, build }) => {
      if (candidate === null) return { replay: null };
      return {
        statements: [
          ...recoveryStatements(shard.db, input.now, candidate, ids),
          ...(build === null
            ? []
            : abandonedBuildReleaseStatements(
                shard.db,
                build,
                candidate.organization_id,
                candidate.project_id,
                candidate.operation_id,
                input.now,
              )),
        ],
        result: () => ({
          organizationId: candidate.organization_id,
          operationId: candidate.operation_id,
          releaseBuildCredits: true as const,
        }),
      };
    },
  };
  return runCommand(shard.db, command);
}

export const releaseStaleTerminalClaimInput = z.strictObject({
  now: instant,
  /** The shard the publisher drains. */
  shardId: z.number().int().min(0).max(1023).optional(),
});

export interface ReleasedClaim {
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly claimId: string;
}

interface StaleClaim {
  readonly organization_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly claim_id: string;
}

/** An ended operation's claim waits this long, so the failure or success path that ended it can finish first. */
const STALE_TERMINAL_CLAIM_MILLISECONDS = 3_600_000;
/** A Neon placement reservation keeps the claim of its ended operation this long (D431, owner approval 2026-11-15). */
const STALE_PLACEMENT_RESERVATION_MILLISECONDS = 7 * 24 * 3_600_000;

/**
 * The predicate of a claim the stale-claim release may delete, over the claim row `claim` and the joined operation row
 * `operation`: the operation succeeded or failed no later than the cutoff bound as ?1, and no spent bucket create or open
 * Native database create holds the claim. A Neon placement reservation of the claim keeps it until the operation ended no
 * later than the placement cutoff bound as ?2 (D431); the batch then deletes that reservation before the claim. A bucket or
 * Native create leaves only under its own rules. An unspent bucket reservation leaves with the claim (0720).
 */
const STALE_TERMINAL_CLAIM = `operation.state IN ('succeeded','failed') AND operation.updated_at <= ?1
     AND (operation.updated_at <= ?2 OR NOT EXISTS (SELECT 1 FROM neon_project_placement_reservations placement
       WHERE placement.organization_id = claim.organization_id AND placement.project_id = claim.project_id
         AND placement.operation_id = claim.operation_id AND placement.claim_id = claim.claim_id))
     AND NOT EXISTS (SELECT 1 FROM project_r2_bucket_reservations bucket
       WHERE bucket.organization_id = claim.organization_id AND bucket.project_id = claim.project_id
         AND bucket.environment_id = claim.environment_id AND bucket.operation_id = claim.operation_id
         AND bucket.claim_id = claim.claim_id AND bucket.create_started_at IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM native_auth_database_operations native_create
       WHERE native_create.organization_id = claim.organization_id AND native_create.project_id = claim.project_id
         AND native_create.operation_id = claim.operation_id AND native_create.claim_id = claim.claim_id
         AND native_create.state IN ('reserved','dispatched'))`;

/**
 * Releases the provider mutation claim of one ended operation an hour after it ended (D614), or seven days after it ended
 * when a Neon placement reservation still holds it (D431); that reservation is deleted in the same batch, before the claim.
 * A failure or success path normally deletes its claim in the same batch; a claim such a path left behind holds the project
 * against every later provider mutation. The batch re-checks the candidate, so a claim that became held or live since it was
 * read aborts the batch and the retry reads again. The candidate is one claim per call, and the publisher calls it only when
 * no lease is expired.
 */
export async function releaseStaleTerminalClaim(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ReleasedClaim | null> {
  const input = releaseStaleTerminalClaimInput.parse(rawInput);
  const shard = await context.router.routeShard(input.shardId ?? 0);
  const cutoff = addMilliseconds(input.now, -STALE_TERMINAL_CLAIM_MILLISECONDS);
  const placementCutoff = addMilliseconds(input.now, -STALE_PLACEMENT_RESERVATION_MILLISECONDS);
  const command: Command<{ candidate: StaleClaim | null }, ReleasedClaim | null> = {
    name: "operations.releaseStaleTerminalClaim",
    input,
    retryOn: ["operation_conflict"],
    read: async (reader) => ({
      candidate: await reader
        .prepare(
          `SELECT claim.organization_id, claim.project_id, claim.operation_id, claim.claim_id
           FROM product_provider_mutation_claims claim
           JOIN operations operation ON operation.organization_id = claim.organization_id
            AND operation.project_id = claim.project_id AND operation.operation_id = claim.operation_id
           WHERE ${notFencedOrganization("claim.organization_id")} AND ${STALE_TERMINAL_CLAIM}
           ORDER BY operation.updated_at, claim.claim_id LIMIT 1`,
        )
        .bind(cutoff, placementCutoff)
        .first<StaleClaim>(),
    }),
    decide: ({ candidate }) => {
      if (candidate === null) return { replay: null };
      const released: ReleasedClaim = {
        organizationId: candidate.organization_id,
        projectId: candidate.project_id,
        operationId: candidate.operation_id,
        claimId: candidate.claim_id,
      };
      return {
        statements: [
          // A fence set after the candidate was read aborts the batch; the retry reads again without that organization.
          fenceRaceGuard(shard.db, "operation_conflict", released.organizationId),
          guard(
            shard.db,
            "operation_conflict",
            `NOT EXISTS (SELECT 1 FROM product_provider_mutation_claims claim
               JOIN operations operation ON operation.organization_id = claim.organization_id
                AND operation.project_id = claim.project_id AND operation.operation_id = claim.operation_id
               WHERE claim.organization_id = ?3 AND claim.project_id = ?4 AND claim.claim_id = ?5 AND ${STALE_TERMINAL_CLAIM})`,
            [
              cutoff,
              placementCutoff,
              released.organizationId,
              released.projectId,
              released.claimId,
            ],
          ),
          // The claim's placement reservation is deleted before the claim, which it references without ON DELETE. The
          // guard above admits a claim that has a reservation only when its operation ended no later than the placement cutoff.
          shard.db
            .prepare(
              "DELETE FROM neon_project_placement_reservations WHERE organization_id = ?1 AND project_id = ?2 AND operation_id = ?3 AND claim_id = ?4",
            )
            .bind(
              released.organizationId,
              released.projectId,
              released.operationId,
              released.claimId,
            ),
          shard.db
            .prepare(
              "DELETE FROM product_provider_mutation_claims WHERE organization_id = ?1 AND project_id = ?2 AND claim_id = ?3",
            )
            .bind(released.organizationId, released.projectId, released.claimId),
          guard(shard.db, "operation_conflict", "changes() = 0"),
        ],
        result: () => released,
      };
    },
  };
  return runCommand(shard.db, command);
}

function recoveryStatements(
  db: D1Database,
  now: string,
  candidate: Candidate,
  ids: { startEvent: string; failEvent: string; startAudit: string; failAudit: string },
) {
  const org = candidate.organization_id;
  const operation = candidate.operation_id;
  const started = candidate.state === "queued";
  const failRevision = candidate.events + (started ? 1 : 0);
  const switched = candidate.switched_data_change === 1;
  const failure = switched ? ABANDONED_SWITCHED_DATA_CHANGE : ABANDONED;
  const audit = (auditEventId: string, eventType: string) =>
    auditStatement(db, org, {
      auditEventId,
      projectId: candidate.project_id,
      operationId: operation,
      billingEpochId: candidate.billing_epoch_id,
      eventType,
      actorType: "system",
      actorId: "operation-lease-sweeper",
      payload: switched
        ? { reasonCode: "OPERATION_ABANDONED", reason: ABANDONED_SWITCHED_DATA_CHANGE_REASON }
        : { reasonCode: "OPERATION_ABANDONED" },
      occurredAt: now,
    });
  const event = (eventId: string, revision: number, type: string, key: string, payload: object) =>
    db
      .prepare(
        "INSERT INTO operation_events(organization_id, operation_id, revision, event_id, project_id, event_type, idempotency_key, payload, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      )
      .bind(
        org,
        operation,
        revision,
        eventId,
        candidate.project_id,
        type,
        key,
        JSON.stringify(payload),
        now,
      );
  return [
    // Shard-wide recovery selected this candidate before reading the fence: a bucket fenced since then aborts the
    // batch (the retry reads again and skips the fenced organization), as the rows are being copied.
    fenceRaceGuard(db, "operation_conflict", org),
    // A Native Auth create dispatched after the candidate was read cannot be failed or released: the batch aborts and
    // the retry reads again without it.
    guard(
      db,
      "operation_conflict",
      `EXISTS (SELECT 1 FROM native_auth_database_operations dispatched_create
         WHERE dispatched_create.organization_id = ?1 AND dispatched_create.project_id = ?2
           AND dispatched_create.operation_id = ?3 AND dispatched_create.state = 'dispatched')`,
      [org, candidate.project_id, operation],
    ),
    // A data change whose data assignment switched after the candidate was read keeps its claim and retired areas:
    // the batch aborts and the retry reads again without it, as the candidate query excludes it.
    guard(
      db,
      "operation_conflict",
      `EXISTS (SELECT 1 FROM environment_data_assignments switched
         WHERE switched.organization_id = ?1 AND switched.operation_id = ?2 AND switched.assigned_at > ?3
           AND EXISTS (SELECT 1 FROM product_workflow_runs data_run
             WHERE data_run.organization_id = ?1 AND data_run.operation_id = ?2
               AND data_run.event_type = 'ProjectDataChangeRequestedV1'))`,
      [org, operation, addMilliseconds(now, -SWITCHED_DATA_CHANGE_HOLD_MILLISECONDS)],
    ),
    // A placement reservation created after the candidate was read would be orphaned by the claim release below.
    guard(
      db,
      "operation_conflict",
      `EXISTS (SELECT 1 FROM product_provider_mutation_claims claim
         JOIN neon_project_placement_reservations placement
           ON placement.claim_id = claim.claim_id AND placement.organization_id = claim.organization_id
          AND placement.project_id = claim.project_id AND placement.operation_id = claim.operation_id
         WHERE claim.organization_id = ?1 AND claim.operation_id = ?2)`,
      [org, operation],
    ),
    // The GitHub push deployments of the abandoned operation end failed. The table admits cleanup_required only on
    // cleanup_pending rows (a superseded push), so a failed push carries none; the abandoned candidate's cleanup is
    // recorded by its own receipts.
    db
      .prepare(
        "UPDATE github_push_deployments SET state = 'failed', updated_at = ?3 WHERE organization_id = ?1 AND operation_id = ?2 AND state IN ('queued','running','reconciliation_required')",
      )
      .bind(org, operation, now),
    db
      .prepare(
        "UPDATE operations SET state = 'failed', failure = ?3, updated_at = ?4, lease_expires_at = NULL WHERE organization_id = ?1 AND operation_id = ?2 AND state = ?5 AND lease_expires_at = ?6",
      )
      .bind(
        org,
        operation,
        JSON.stringify(failure),
        now,
        candidate.state,
        candidate.lease_expires_at,
      ),
    guard(db, "operation_conflict", "changes() = 0"),
    ...(started
      ? [
          event(
            ids.startEvent,
            candidate.events,
            "OperationStarted",
            `lease-expiry:${operation}:start`,
            {},
          ),
          audit(ids.startAudit, "OperationStarted"),
        ]
      : []),
    event(ids.failEvent, failRevision, "OperationFailed", `lease-expiry:${operation}:fail`, {
      failure,
    }),
    audit(ids.failAudit, "OperationFailed"),
    db
      .prepare(
        "UPDATE product_workflow_runs SET state = 'completed', terminal_evidence = ?3, reconciliation_code = NULL, completed_at = ?4, updated_at = ?4 WHERE organization_id = ?1 AND operation_id = ?2 AND state <> 'completed'",
      )
      .bind(org, operation, JSON.stringify({ errorCode: "OPERATION_ABANDONED" }), now),
    db
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id = ?1 AND operation_id = ?2",
      )
      .bind(org, operation),
    db
      .prepare(
        "UPDATE deployments SET status = 'failed', updated_at = ?3 WHERE organization_id = ?1 AND operation_id = ?2 AND status IN ('queued','running','reconciliation_required')",
      )
      .bind(org, operation, now),
    db
      .prepare(
        "UPDATE outbox_events SET reconciliation_required_at = ?3, last_error_code = 'OPERATION_ABANDONED' WHERE organization_id = ?1 AND operation_id = ?2 AND acknowledged_at IS NULL",
      )
      .bind(org, operation, now),
  ];
}
