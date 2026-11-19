import { readSnapshot } from "../platform-support.js";
import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  auditRecordInput,
  auditStatement,
  fenceRaceGuard,
  instant,
  notFencedOrganization,
  publicTimestamp,
  ringDoorbell,
  routeOrganization,
  rowsOf,
  ulid,
  type CatalogContext,
} from "../common.js";

const errorCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/u);
const eventTypes = z
  .array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u))
  .min(1)
  .max(100)
  .refine((values) => new Set(values).size === values.length, "event types must be unique");
const eventScope = z.strictObject({
  eventId: ulid,
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
});

/** Either one shard (the sweeper's view) or one exact event (a scoped caller): never both, never neither. */
const target = {
  shardId: z.number().int().min(0).max(1023).optional(),
  eventScope: eventScope.optional(),
};
function exactlyOneTarget(value: { shardId?: number | undefined; eventScope?: unknown }) {
  return (value.shardId === undefined) !== (value.eventScope === undefined);
}
const TARGET_MESSAGE = "name either a shard or an exact event scope";

async function routeTarget(
  context: CatalogContext,
  value: { shardId?: number | undefined; eventScope?: { organizationId: string } | undefined },
) {
  return value.eventScope !== undefined
    ? routeOrganization(context, value.eventScope.organizationId)
    : context.router.routeShard(value.shardId as number);
}

export const claimOutboxEventInput = z
  .strictObject({
    ...target,
    now: instant,
    leaseMilliseconds: z.number().int().min(1),
    attemptId: ulid,
    supportedEventTypes: eventTypes.optional(),
    excludeProjectsWithActiveProviderMutation: z.boolean().optional(),
  })
  .refine(exactlyOneTarget, TARGET_MESSAGE);

export interface ClaimedOutboxEvent {
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly billingEpochId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly maxAttempts: number;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
}

interface ClaimRow {
  readonly organization_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly billing_epoch_id: string;
  readonly event_type: string;
  readonly payload: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly current_attempt_id: string;
  readonly claimed_at: string;
  readonly lease_expires_at: string;
}

const CLAIM_COLUMNS =
  "organization_id, event_id, project_id, operation_id, billing_epoch_id, event_type, payload, attempt_count, max_attempts, current_attempt_id, claimed_at, lease_expires_at";

function claimed(row: ClaimRow): ClaimedOutboxEvent {
  return {
    eventId: row.event_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    operationId: row.operation_id,
    billingEpochId: row.billing_epoch_id,
    eventType: row.event_type,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    attemptId: row.current_attempt_id,
    attemptNumber: row.attempt_count,
    maxAttempts: row.max_attempts,
    claimedAt: publicTimestamp(row.claimed_at),
    leaseExpiresAt: publicTimestamp(row.lease_expires_at),
  };
}

/**
 * `claimOutboxEvent`: one statement picks the oldest due event and leases it, so two concurrent claimers
 * cannot take the same row (the second sees the first's lease). A lost response is resolved by the attempt
 * id, which the caller chose: the event it holds is the one whose current attempt is that id.
 */
export async function claimOutboxEvent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ClaimedOutboxEvent | null> {
  const input = claimOutboxEventInput.parse(rawInput);
  const shard = await routeTarget(context, input);
  const scope = input.eventScope;
  const binds: unknown[] = [input.attemptId, input.now];
  const filters: string[] = [];
  const next = () => `?${binds.length + 1}`;
  const leaseExpiresAt = new Date(Date.parse(input.now) + input.leaseMilliseconds);
  if (!Number.isFinite(leaseExpiresAt.getTime())) {
    throw new RangeError("Outbox lease expiry must be a valid Date");
  }
  binds.push(`${leaseExpiresAt.toISOString().slice(0, 23)}000Z`);
  if (input.supportedEventTypes !== undefined) {
    filters.push(`AND event.event_type IN (SELECT value FROM json_each(${next()}))`);
    binds.push(JSON.stringify(input.supportedEventTypes));
  }
  if (scope !== undefined) {
    const first = binds.length + 1;
    filters.push(
      `AND event.organization_id = ?${first} AND event.event_id = ?${first + 1} AND event.project_id = ?${first + 2} AND event.operation_id = ?${first + 3}`,
    );
    binds.push(scope.organizationId, scope.eventId, scope.projectId, scope.operationId);
  }
  if (input.excludeProjectsWithActiveProviderMutation === true) {
    filters.push(
      "AND NOT EXISTS (SELECT 1 FROM product_provider_mutation_claims active WHERE active.organization_id = event.organization_id AND active.project_id = event.project_id)",
    );
  }
  const command: Command<ClaimRow | null, ClaimedOutboxEvent | null> = {
    name: "operations.claimOutboxEvent",
    input,
    // A claim the caller already holds under this attempt id (a lost response) is answered, not repeated.
    read: (reader) =>
      reader
        .prepare(
          `WITH request(attempt_id,requested_at,requested_lease) AS (VALUES(?1,?2,?3))
           SELECT ${CLAIM_COLUMNS} FROM outbox_events event CROSS JOIN request
            WHERE current_attempt_id = request.attempt_id AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL
            AND EXISTS (SELECT 1 FROM delivery_attempts attempt WHERE attempt.attempt_id=event.current_attempt_id
              AND attempt.event_id=event.event_id AND attempt.status='claimed' AND attempt.attempt_number=event.attempt_count)
            AND ${notFencedOrganization("event.organization_id")}
            ${filters.join(" ")}`,
        )
        .bind(...binds)
        .first<ClaimRow>(),
    decide: (existing) =>
      existing !== null
        ? { replay: claimed(existing) }
        : {
            statements: [
              shard.db
                .prepare(
                  `UPDATE outbox_events
                   SET attempt_count = attempt_count + 1, current_attempt_id = ?1, claimed_at = ?2, lease_expires_at = ?3,
                       last_attempt_status = 'claimed'
                   WHERE (organization_id, event_id) IN (
                     SELECT event.organization_id, event.event_id FROM outbox_events event
                     WHERE event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NULL
                       AND event.available_at <= ?2 AND event.attempt_count < event.max_attempts
                       AND (event.lease_expires_at IS NULL OR event.lease_expires_at <= ?2)
                       AND ${notFencedOrganization("event.organization_id")}
                       ${filters.join(" ")}
                     ORDER BY event.available_at, event.created_at, event.event_id LIMIT 1)
                   RETURNING ${CLAIM_COLUMNS}`,
                )
                .bind(...binds),
              shard.db
                .prepare(
                  `INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,status)
                SELECT current_attempt_id,event_id,attempt_count,claimed_at,lease_expires_at,'claimed' FROM outbox_events
                WHERE current_attempt_id=?1 AND claimed_at=?2 AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL`,
                )
                .bind(input.attemptId, input.now),
            ],
            result: (results) => {
              const row = (results[0]?.results as ClaimRow[] | undefined)?.[0];
              return row === undefined ? null : claimed(row);
            },
          },
  };
  return runCommand(shard.db, command);
}

const failureAudit = auditRecordInput.extend({
  projectId: ulid,
  operationId: ulid,
  eventType: z.enum(["OutboxRetryScheduled", "OutboxReconciliationRequired"]),
});

export const recordOutboxDeliveryFailureInput = z.strictObject({
  organizationId: ulid,
  eventId: ulid,
  attemptId: ulid,
  errorCode,
  failedAt: instant,
  nextAvailableAt: instant.optional(),
  audit: failureAudit,
});

export interface OutboxDeliveryFailureResult {
  readonly outcome: "retry_scheduled" | "reconciliation_required";
  readonly attemptNumber: number;
}

interface AttemptRow {
  readonly project_id: string;
  readonly operation_id: string;
  readonly billing_epoch_id: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly claimed_at: string;
}

const CURRENT_ATTEMPT_SQL = `SELECT event.project_id,event.operation_id,event.billing_epoch_id,attempt.attempt_number AS attempt_count,event.max_attempts,attempt.claimed_at
   FROM outbox_events event JOIN delivery_attempts attempt ON attempt.event_id=event.event_id
     AND attempt.attempt_id=event.current_attempt_id AND attempt.status='claimed'
   WHERE event.organization_id=?1 AND event.event_id=?2 AND event.current_attempt_id=?3
     AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NULL`;

export interface OutboxFailureSnapshot {
  readonly row: AttemptRow | null;
  readonly done: OutboxDeliveryFailureResult | null;
}
export function outboxFailureQueries(input: {
  organizationId: string;
  eventId: string;
  attemptId: string;
  auditEventId: string;
}): (readonly [string, ...unknown[]])[] {
  return [
    [CURRENT_ATTEMPT_SQL, input.organizationId, input.eventId, input.attemptId],
    [
      "SELECT event_type, json_extract(payload, '$.attemptNumber') AS attempt FROM audit_events WHERE organization_id = ?1 AND audit_event_id = ?2",
      input.organizationId,
      input.auditEventId,
    ],
  ];
}
export function outboxFailureSnapshotOf(
  rows: readonly (readonly Record<string, unknown>[])[],
): OutboxFailureSnapshot {
  const done = rows[1]?.[0];
  return {
    row: (rows[0]?.[0] as AttemptRow | undefined) ?? null,
    done:
      done === undefined
        ? null
        : {
            outcome:
              done["event_type"] === "OutboxReconciliationRequired"
                ? "reconciliation_required"
                : "retry_scheduled",
            attemptNumber: Number(done["attempt"]),
          },
  };
}

/**
 * `recordOutboxDeliveryFailure`: the failed attempt is retried later, or - on the last attempt - parked for
 * reconciliation. Null means the attempt is no longer the event's current one (acknowledged, retried,
 * reconciled or recovered by someone else).
 */
/** Pure failure planner: a recovery dispatcher composes its guarded writes with job termination in ONE batch. */
export function outboxDeliveryFailureCommand(
  db: D1Database,
  input: z.output<typeof recordOutboxDeliveryFailureInput>,
): Command<
  { row: AttemptRow | null; done: OutboxDeliveryFailureResult | null },
  OutboxDeliveryFailureResult | null
> {
  return {
    name: "operations.recordOutboxDeliveryFailure",
    input,
    retryOn: ["claim_lost"],
    naturalKeyTables: ["audit_events"],
    // The audit event id is the command's identity: its row is the answer to a repeated call.
    read: async (reader) =>
      outboxFailureSnapshotOf(
        await readSnapshot(
          reader,
          outboxFailureQueries({
            organizationId: input.organizationId,
            eventId: input.eventId,
            attemptId: input.attemptId,
            auditEventId: input.audit.auditEventId,
          }),
        ),
      ),
    decide: ({ row, done }) => {
      if (done !== null) return { replay: done };
      if (row === null) return { replay: null };
      const exhausted = row.attempt_count >= row.max_attempts;
      const expected = exhausted ? "OutboxReconciliationRequired" : "OutboxRetryScheduled";
      if (
        input.audit.projectId !== row.project_id ||
        input.audit.operationId !== row.operation_id
      ) {
        return { reject: new TypeError("Outbox failure audit must share the event scope") };
      }
      if (input.audit.eventType !== expected) {
        return { reject: new TypeError(`Outbox failure audit must use ${expected}`) };
      }
      if (input.audit.occurredAt !== input.failedAt) {
        return { reject: new TypeError("Outbox failure audit must use the failure time") };
      }
      if (input.failedAt < row.claimed_at) {
        return { reject: new RangeError("Outbox failure time must not be before the claim time") };
      }
      if (exhausted && input.nextAvailableAt !== undefined) {
        return {
          reject: new TypeError(
            "Reconciliation-required outbox failures must not schedule a retry",
          ),
        };
      }
      if (!exhausted && input.nextAvailableAt === undefined) {
        return { reject: new TypeError("A retryable outbox failure requires nextAvailableAt") };
      }
      if (input.nextAvailableAt !== undefined && input.nextAvailableAt <= input.failedAt) {
        return {
          reject: new RangeError("Outbox next availability must be after the failure time"),
        };
      }
      const outcome = exhausted ? "reconciliation_required" : "retry_scheduled";
      return {
        statements: [
          db
            .prepare(
              exhausted
                ? `UPDATE outbox_events SET last_error_code = ?4, reconciliation_required_at = ?5, claimed_at = NULL, lease_expires_at = NULL, last_attempt_status = 'reconciliation_required'
                   WHERE organization_id = ?1 AND event_id = ?2 AND current_attempt_id = ?3 AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL`
                : `UPDATE outbox_events SET last_error_code = ?4, available_at = ?5, current_attempt_id = NULL, claimed_at = NULL, lease_expires_at = NULL, last_attempt_status = 'retry_scheduled'
                   WHERE organization_id = ?1 AND event_id = ?2 AND current_attempt_id = ?3 AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL`,
            )
            .bind(
              input.organizationId,
              input.eventId,
              input.attemptId,
              input.errorCode,
              exhausted ? input.failedAt : input.nextAvailableAt,
            ),
          guard(db, "claim_lost", "changes() = 0"),
          db
            .prepare(
              `UPDATE delivery_attempts SET failed_at=?4,next_available_at=?5,error_code=?6,status=?7
             WHERE event_id=?2 AND attempt_id=?3 AND status='claimed' AND EXISTS (
               SELECT 1 FROM outbox_events WHERE organization_id=?1 AND event_id=?2 AND project_id=?8 AND operation_id=?9)`,
            )
            .bind(
              input.organizationId,
              input.eventId,
              input.attemptId,
              input.failedAt,
              input.nextAvailableAt ?? null,
              input.errorCode,
              outcome,
              row.project_id,
              row.operation_id,
            ),
          guard(db, "claim_lost", "changes() = 0"),
          auditStatement(db, input.organizationId, {
            ...input.audit,
            billingEpochId: row.billing_epoch_id,
            payload: {
              ...input.audit.payload,
              eventId: input.eventId,
              attemptId: input.attemptId,
              attemptNumber: row.attempt_count,
              errorCode: input.errorCode,
              ...(input.nextAvailableAt === undefined
                ? {}
                : { nextAvailableAt: publicTimestamp(input.nextAvailableAt) }),
            },
          }),
        ],
        result: () => ({ outcome, attemptNumber: row.attempt_count }),
      };
    },
  };
}

export async function recordOutboxDeliveryFailure(
  context: CatalogContext,
  rawInput: unknown,
): Promise<OutboxDeliveryFailureResult | null> {
  const input = recordOutboxDeliveryFailureInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const result = await runCommand(shard.db, outboxDeliveryFailureCommand(shard.db, input));
  if (result?.outcome === "retry_scheduled" && input.nextAvailableAt !== undefined) {
    await ringDoorbell(context.directory, "outbox", shard.shardId, input.nextAvailableAt);
  }
  return result;
}

const redactedPayload = z
  .record(z.string().regex(/^[a-z][A-Za-z0-9]*(?:Id|Code)$/u), z.string().min(1).max(256))
  .refine(
    (payload) =>
      Object.keys(payload).length <= 16 &&
      Object.values(payload).every((value) => value.trim() === value && !/\s/u.test(value)),
    "payload must contain only redacted ID or code correlations",
  );

export const requireOutboxReconciliationInput = z.strictObject({
  organizationId: ulid,
  eventId: ulid,
  attemptId: ulid,
  errorCode,
  reconciledAt: instant,
  audit: auditRecordInput.extend({
    projectId: ulid,
    operationId: ulid,
    eventType: z.literal("OutboxReconciliationRequired"),
    payload: redactedPayload.default({}),
  }),
});

/** `requireOutboxReconciliationExact`: parks the exact claimed attempt for operator reconciliation. */
export async function requireOutboxReconciliation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<{ readonly attemptNumber: number } | null> {
  const input = requireOutboxReconciliationInput.parse(rawInput);
  if (input.audit.occurredAt !== input.reconciledAt) {
    throw new TypeError("Outbox reconciliation audit must use the reconciliation time");
  }
  const shard = await routeOrganization(context, input.organizationId);
  const command: Command<
    { row: AttemptRow | null; done: number | null },
    { readonly attemptNumber: number } | null
  > = {
    name: "operations.requireOutboxReconciliation",
    input,
    retryOn: ["claim_lost"],
    naturalKeyTables: ["audit_events"],
    read: async (reader) => {
      const [attempt, audit] = await reader.batch([
        reader
          .prepare(CURRENT_ATTEMPT_SQL)
          .bind(input.organizationId, input.eventId, input.attemptId),
        reader
          .prepare(
            "SELECT json_extract(payload, '$.attemptNumber') AS attempt FROM audit_events WHERE organization_id = ?1 AND audit_event_id = ?2",
          )
          .bind(input.organizationId, input.audit.auditEventId),
      ]);
      const done = (audit?.results as { attempt: number }[])[0];
      return { row: rowsOf<AttemptRow>(attempt)[0] ?? null, done: done?.attempt ?? null };
    },
    decide: ({ row, done }) => {
      if (done !== null) return { replay: { attemptNumber: done } };
      if (row === null) return { replay: null };
      if (
        input.audit.projectId !== row.project_id ||
        input.audit.operationId !== row.operation_id
      ) {
        return {
          reject: new TypeError("Outbox reconciliation audit must share the exact event scope"),
        };
      }
      if (input.reconciledAt < row.claimed_at) {
        return {
          reject: new RangeError("Outbox reconciliation time must not be before the claim time"),
        };
      }
      return {
        statements: [
          shard.db
            .prepare(
              `UPDATE outbox_events SET last_error_code = ?4, reconciliation_required_at = ?5, current_attempt_id = NULL, claimed_at = NULL, lease_expires_at = NULL, last_attempt_status = 'reconciliation_required'
               WHERE organization_id = ?1 AND event_id = ?2 AND current_attempt_id = ?3 AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL`,
            )
            .bind(
              input.organizationId,
              input.eventId,
              input.attemptId,
              input.errorCode,
              input.reconciledAt,
            ),
          guard(shard.db, "claim_lost", "changes() = 0"),
          shard.db
            .prepare(
              `UPDATE delivery_attempts SET failed_at=?4,next_available_at=NULL,error_code=?5,status='reconciliation_required'
             WHERE event_id=?2 AND attempt_id=?3 AND status='claimed' AND EXISTS (
               SELECT 1 FROM outbox_events WHERE organization_id=?1 AND event_id=?2 AND project_id=?6 AND operation_id=?7)`,
            )
            .bind(
              input.organizationId,
              input.eventId,
              input.attemptId,
              input.reconciledAt,
              input.errorCode,
              row.project_id,
              row.operation_id,
            ),
          guard(shard.db, "claim_lost", "changes() = 0"),
          auditStatement(shard.db, input.organizationId, {
            ...input.audit,
            billingEpochId: row.billing_epoch_id,
            payload: {
              ...input.audit.payload,
              eventId: input.eventId,
              attemptId: input.attemptId,
              attemptNumber: row.attempt_count,
              errorCode: input.errorCode,
            },
          }),
        ],
        result: () => ({ attemptNumber: row.attempt_count }),
      };
    },
  };
  return runCommand(shard.db, command);
}

export const acknowledgeOutboxEventInput = z.strictObject({
  organizationId: ulid,
  eventId: ulid,
  attemptId: ulid,
  now: instant,
});

type Acknowledgement = {
  organizationId: string;
  eventId: string;
  attemptId: string;
} & (
  | { kind: "provided"; now: string }
  | { kind: "recovery_terminal"; projectId: string; operationId: string }
);
const ACK_EXECUTION_TIME = "(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')";

/** Closed ACK planner shared with Recovery. Original event+attempt outcome is ONE transaction. */
export function outboxAcknowledgementCommand(
  db: D1Database,
  input: Acknowledgement,
): Command<boolean, boolean> {
  const selector = (includeTime: boolean) => {
    const values: unknown[] = [input.organizationId, input.eventId, input.attemptId];
    const stamp =
      input.kind === "provided" && includeTime ? `?${values.push(input.now)}` : ACK_EXECUTION_TIME;
    let extra = "";
    if (input.kind === "recovery_terminal") {
      const project = values.push(input.projectId),
        operation = values.push(input.operationId);
      extra = ` AND event.project_id=?${project} AND event.operation_id=?${operation}
        AND event.event_type='ProjectRecoveryRequestedV1' AND EXISTS (
          SELECT 1 FROM project_recovery_jobs job JOIN operations operation
            ON operation.organization_id=job.organization_id AND operation.project_id=job.project_id AND operation.operation_id=job.operation_id
          WHERE job.organization_id=event.organization_id AND job.project_id=event.project_id AND job.operation_id=event.operation_id
            AND operation.state IN ('succeeded','failed','cancelled'))`;
    }
    return {
      values,
      stamp,
      where: `event.organization_id=?1 AND event.event_id=?2 AND event.current_attempt_id=?3${extra}`,
    };
  };
  const read = selector(false),
    write = selector(true);
  return {
    name:
      input.kind === "provided"
        ? "operations.acknowledgeOutboxEvent"
        : "recovery.acknowledgeOutbox",
    input,
    retryOn: ["claim_lost"],
    read: async (reader) =>
      (await reader
        .prepare(
          `SELECT 1 FROM outbox_events event WHERE ${read.where}
      AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NULL
      AND EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.event_id=event.event_id
        AND attempt.attempt_id=event.current_attempt_id AND attempt.status='claimed')`,
        )
        .bind(...read.values)
        .first()) !== null,
    lookup: async (reader) => {
      const row = await reader
        .prepare(
          `SELECT 1 FROM outbox_events event JOIN delivery_attempts attempt
        ON attempt.event_id=event.event_id AND attempt.attempt_id=event.current_attempt_id
        WHERE ${read.where} AND event.acknowledged_at IS NOT NULL AND event.reconciliation_required_at IS NULL
          AND attempt.status='acknowledged' AND attempt.acknowledged_at=event.acknowledged_at`,
        )
        .bind(...read.values)
        .first();
      return row === null ? undefined : true;
    },
    decide: (eligible) =>
      !eligible
        ? { replay: false }
        : {
            statements: [
              db
                .prepare(
                  `UPDATE outbox_events AS event SET acknowledged_at=${write.stamp},last_attempt_status='acknowledged'
        WHERE ${write.where} AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NULL
          AND EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.event_id=event.event_id
            AND attempt.attempt_id=event.current_attempt_id AND attempt.status='claimed')`,
                )
                .bind(...write.values),
              guard(db, "claim_lost", "changes() = 0"),
              db
                .prepare(
                  `UPDATE delivery_attempts SET status='acknowledged',acknowledged_at=(
          SELECT acknowledged_at FROM outbox_events WHERE organization_id=?1 AND event_id=?2 AND current_attempt_id=?3)
        WHERE event_id=?2 AND attempt_id=?3 AND status='claimed'`,
                )
                .bind(input.organizationId, input.eventId, input.attemptId),
              guard(db, "claim_lost", "changes() = 0"),
            ],
            result: () => true,
          },
  };
}

/** `acknowledgeOutboxEvent`: true when this attempt was the claimed one and the event is now acknowledged. */
export async function acknowledgeOutboxEvent(
  context: CatalogContext,
  rawInput: unknown,
): Promise<boolean> {
  const input = acknowledgeOutboxEventInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  return runCommand(
    shard.db,
    outboxAcknowledgementCommand(shard.db, { ...input, kind: "provided" }),
  );
}

export const recoverExpiredFinalOutboxLeaseInput = z
  .strictObject({
    ...target,
    now: instant,
    auditEventId: ulid,
    actorType: z.string().trim().min(1),
    actorId: z.string().trim().min(1),
    supportedEventTypes: eventTypes.optional(),
  })
  .refine(exactlyOneTarget, TARGET_MESSAGE);

export interface ExpiredFinalOutboxLeaseRecovery {
  readonly eventId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly recoveredAt: string;
}

interface ExpiredRow {
  readonly organization_id: string;
  readonly event_id: string;
  readonly project_id: string;
  readonly operation_id: string;
  readonly billing_epoch_id: string;
  readonly current_attempt_id: string;
  readonly attempt_count: number;
  readonly lease_expires_at: string;
}

const FINAL_ATTEMPT_LEASE_EXPIRED = "FINAL_ATTEMPT_LEASE_EXPIRED";

/**
 * `recoverExpiredFinalOutboxLease`: an event whose last attempt's lease lapsed without an outcome may have
 * been delivered, so it is parked for reconciliation instead of being retried.
 */
export async function recoverExpiredFinalOutboxLease(
  context: CatalogContext,
  rawInput: unknown,
): Promise<ExpiredFinalOutboxLeaseRecovery | null> {
  const input = recoverExpiredFinalOutboxLeaseInput.parse(rawInput);
  const shard = await routeTarget(context, input);
  const scope = input.eventScope;
  const command: Command<
    { row: ExpiredRow | null; done: ExpiredFinalOutboxLeaseRecovery | null },
    ExpiredFinalOutboxLeaseRecovery | null
  > = {
    name: "operations.recoverExpiredFinalOutboxLease",
    input,
    retryOn: ["claim_lost"],
    // A scoped recovery is identified by its audit event id: when that row exists the recovery already
    // happened. A shard-wide sweep has no organization to look under; its next tick uses a fresh id.
    naturalKeyTables: scope === undefined ? [] : ["audit_events"],
    read: async (reader) => {
      const [candidate, audit] = await reader.batch([
        reader
          .prepare(
            `SELECT organization_id, event_id, project_id, operation_id, billing_epoch_id, current_attempt_id, attempt_count, lease_expires_at
             FROM outbox_events event
             WHERE acknowledged_at IS NULL AND reconciliation_required_at IS NULL AND attempt_count = max_attempts
               AND current_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?1
               AND EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.event_id=event.event_id
                 AND attempt.attempt_id=event.current_attempt_id AND attempt.status='claimed' AND attempt.attempt_number=event.attempt_count)
               AND ${notFencedOrganization("event.organization_id")}
               AND (?2 IS NULL OR event.event_type IN (SELECT value FROM json_each(?2)))
               AND (?3 IS NULL OR (event.organization_id = ?3 AND event.event_id = ?4 AND event.project_id = ?5 AND event.operation_id = ?6))
             ORDER BY lease_expires_at, created_at, event_id LIMIT 1`,
          )
          .bind(
            input.now,
            input.supportedEventTypes === undefined
              ? null
              : JSON.stringify(input.supportedEventTypes),
            scope?.organizationId ?? null,
            scope?.eventId ?? null,
            scope?.projectId ?? null,
            scope?.operationId ?? null,
          ),
        reader
          .prepare(
            "SELECT organization_id, project_id, operation_id, occurred_at, json_extract(payload, '$.eventId') AS event_id, json_extract(payload, '$.attemptId') AS attempt_id, json_extract(payload, '$.attemptNumber') AS attempt FROM audit_events WHERE organization_id = ?2 AND audit_event_id = ?1",
          )
          .bind(input.auditEventId, scope?.organizationId ?? ""),
      ]);
      const done = (
        audit?.results as {
          organization_id: string;
          project_id: string;
          operation_id: string;
          occurred_at: string;
          event_id: string;
          attempt_id: string;
          attempt: number;
        }[]
      )[0];
      return {
        row: rowsOf<ExpiredRow>(candidate)[0] ?? null,
        done:
          done === undefined
            ? null
            : {
                eventId: done.event_id,
                organizationId: done.organization_id,
                projectId: done.project_id,
                operationId: done.operation_id,
                attemptId: done.attempt_id,
                attemptNumber: done.attempt,
                recoveredAt: publicTimestamp(done.occurred_at),
              },
      };
    },
    decide: ({ row, done }) => {
      if (done !== null) return { replay: done };
      if (row === null) return { replay: null };
      return {
        statements: recoveryStatements(shard.db, input, row),
        result: () => ({
          eventId: row.event_id,
          organizationId: row.organization_id,
          projectId: row.project_id,
          operationId: row.operation_id,
          attemptId: row.current_attempt_id,
          attemptNumber: row.attempt_count,
          recoveredAt: publicTimestamp(input.now),
        }),
      };
    },
  };
  return runCommand(shard.db, command);
}

function recoveryStatements(
  db: D1Database,
  input: z.output<typeof recoverExpiredFinalOutboxLeaseInput>,
  row: ExpiredRow,
): D1PreparedStatement[] {
  return [
    fenceRaceGuard(db, "claim_lost", row.organization_id),
    db
      .prepare(
        `UPDATE outbox_events SET last_error_code = '${FINAL_ATTEMPT_LEASE_EXPIRED}', reconciliation_required_at = ?5,
           claimed_at = NULL, lease_expires_at = NULL, last_attempt_status = 'reconciliation_required'
         WHERE organization_id = ?1 AND event_id = ?2 AND current_attempt_id = ?3 AND lease_expires_at = ?4
           AND acknowledged_at IS NULL AND reconciliation_required_at IS NULL`,
      )
      .bind(
        row.organization_id,
        row.event_id,
        row.current_attempt_id,
        row.lease_expires_at,
        input.now,
      ),
    guard(db, "claim_lost", "changes() = 0"),
    db
      .prepare(
        `UPDATE delivery_attempts SET failed_at=?4,error_code='${FINAL_ATTEMPT_LEASE_EXPIRED}',status='reconciliation_required'
      WHERE event_id=?2 AND attempt_id=?3 AND status='claimed' AND EXISTS(
        SELECT 1 FROM outbox_events WHERE organization_id=?1 AND event_id=?2 AND project_id=?5 AND operation_id=?6)`,
      )
      .bind(
        row.organization_id,
        row.event_id,
        row.current_attempt_id,
        input.now,
        row.project_id,
        row.operation_id,
      ),
    guard(db, "claim_lost", "changes() = 0"),
    auditStatement(db, row.organization_id, {
      auditEventId: input.auditEventId,
      projectId: row.project_id,
      operationId: row.operation_id,
      billingEpochId: row.billing_epoch_id,
      eventType: "OutboxReconciliationRequired",
      actorType: input.actorType,
      actorId: input.actorId,
      payload: {
        eventId: row.event_id,
        attemptId: row.current_attempt_id,
        attemptNumber: row.attempt_count,
        errorCode: FINAL_ATTEMPT_LEASE_EXPIRED,
        leaseExpiresAt: publicTimestamp(row.lease_expires_at),
      },
      occurredAt: input.now,
    }),
  ];
}
