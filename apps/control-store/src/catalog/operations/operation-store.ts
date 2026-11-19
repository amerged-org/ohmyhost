import { z } from "zod";

import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  OPERATION_LEASE_MILLISECONDS,
  addMilliseconds,
  auditRecordInput,
  auditStatement,
  conflict,
  hexBytes,
  instant,
  jsonRecord,
  parseJson,
  publicTimestamp,
  ringDoorbell,
  routeOrganization,
  rowsOf,
  ulid,
  type CatalogContext,
} from "../common.js";

export const loadOperationInput = z.strictObject({ organizationId: ulid, operationId: ulid });

export interface StoredOperationEvent {
  readonly revision: number;
  readonly eventId: string;
  readonly projectId: string;
  readonly type: string;
  readonly idempotencyKey: string | null;
  readonly payload: Record<string, unknown>;
  readonly occurredAt: string;
}

export interface StoredOperation {
  readonly organizationId: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly failure: { readonly code: string; readonly message: string } | null;
  /** The typed refusal an auto-deploy planning rejection stores beside the failure. */
  readonly failureDiagnostic: unknown;
  readonly billingEpochId: string;
  readonly leaseExpiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The ordered, contiguous event history; rehydrate it with the platform to obtain the aggregate. */
  readonly events: readonly StoredOperationEvent[];
}

interface OperationRow {
  readonly project_id: string;
  readonly state: StoredOperation["state"];
  readonly failure: string | null;
  readonly billing_epoch_id: string;
  readonly lease_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface EventRow {
  readonly revision: number;
  readonly event_id: string;
  readonly project_id: string;
  readonly event_type: string;
  readonly idempotency_key: string | null;
  readonly payload: string;
  readonly occurred_at: string;
}

/** One batch of two SELECTs is one transaction: the operation row and its events are a consistent snapshot. */
export async function readOperation(
  db: D1Database,
  organizationId: string,
  operationId: string,
): Promise<StoredOperation | null> {
  const [operation, events] = await db.batch([
    db
      .prepare(
        "SELECT project_id, state, failure, billing_epoch_id, lease_expires_at, created_at, updated_at FROM operations WHERE organization_id = ?1 AND operation_id = ?2",
      )
      .bind(organizationId, operationId),
    db
      .prepare(
        "SELECT revision, event_id, project_id, event_type, idempotency_key, payload, occurred_at FROM operation_events WHERE organization_id = ?1 AND operation_id = ?2 ORDER BY revision",
      )
      .bind(organizationId, operationId),
  ]);
  const row = rowsOf<OperationRow>(operation)[0];
  if (row === undefined) return null;
  const eventRows = rowsOf<EventRow>(events);
  eventRows.forEach((event, index) => {
    if (event.revision !== index) {
      throw new Error("Operation event revisions must be contiguous and start at zero");
    }
  });
  const failure = parseJson<{ code: string; message: string; diagnostic?: unknown }>(row.failure);
  return {
    organizationId,
    operationId,
    projectId: row.project_id,
    state: row.state,
    failure: failure === null ? null : { code: failure.code, message: failure.message },
    failureDiagnostic: failure?.diagnostic ?? null,
    billingEpochId: row.billing_epoch_id,
    leaseExpiresAt: row.lease_expires_at === null ? null : publicTimestamp(row.lease_expires_at),
    createdAt: publicTimestamp(row.created_at),
    updatedAt: publicTimestamp(row.updated_at),
    events: eventRows.map((event) => ({
      revision: event.revision,
      eventId: event.event_id,
      projectId: event.project_id,
      type: event.event_type,
      idempotencyKey: event.idempotency_key,
      payload: JSON.parse(event.payload) as Record<string, unknown>,
      occurredAt: publicTimestamp(event.occurred_at),
    })),
  };
}

/** `loadOperationForOrganization`: the operation and its event history, or null when it is not the organization's. */
export async function loadOperation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<StoredOperation | null> {
  const input = loadOperationInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  return readOperation(shard.db, input.organizationId, input.operationId);
}

const EVENT_STATE = {
  OperationStarted: "running",
  OperationSucceeded: "succeeded",
  OperationFailed: "failed",
  OperationCancelled: "cancelled",
} as const;

export const transitionOperationInput = z
  .strictObject({
    organizationId: ulid,
    operationId: ulid,
    /** The state and the number of events of the operation the caller decided on. */
    expected: z.strictObject({
      state: z.enum(["queued", "running"]),
      eventCount: z.number().int().min(1),
    }),
    event: z.strictObject({
      eventId: ulid,
      type: z.enum([
        "OperationStarted",
        "OperationSucceeded",
        "OperationFailed",
        "OperationCancelled",
      ]),
      idempotencyKey: z.string().min(1),
      occurredAt: instant,
      failure: z
        .strictObject({
          code: z.string().trim().min(1),
          message: z.string().trim().min(1),
        })
        .optional(),
      /** A deployment result also fills the operation's result columns; a data-change result stays in the event. */
      result: jsonRecord.optional(),
    }),
    audit: auditRecordInput,
  })
  .superRefine((value, context) => {
    const { event, audit } = value;
    if ((event.type === "OperationFailed") !== (event.failure !== undefined)) {
      context.addIssue({ code: "custom", message: "only a failed operation carries a failure" });
    }
    if (event.result !== undefined && event.type !== "OperationSucceeded") {
      context.addIssue({ code: "custom", message: "only a succeeded operation carries a result" });
    }
    if (audit.eventType !== event.type || audit.occurredAt !== event.occurredAt) {
      context.addIssue({
        code: "custom",
        message: "audit event must describe the persisted operation transition",
      });
    }
    if (audit.operationId !== value.operationId) {
      context.addIssue({ code: "custom", message: "audit event must share the operation scope" });
    }
  });

export type TransitionOperationInput = z.input<typeof transitionOperationInput>;

export interface TransitionOperationResult {
  readonly outcome: "applied" | "replayed";
  readonly state: StoredOperation["state"];
  readonly eventCount: number;
}

interface TransitionSnapshot {
  readonly operation: StoredOperation | null;
}

function deploymentResult(result: Record<string, unknown> | undefined) {
  if (
    result === undefined ||
    result["schemaVersion"] !== "ohmyhost.operation-deployment-result/v2"
  ) {
    return null;
  }
  return {
    deploymentId: result["deploymentId"] as string,
    url: result["url"] as string,
    artifactSha256: result["artifactSha256"] as string,
  };
}

/**
 * `persistOperationTransition`: appends exactly one event and moves the operation, in one batch. The
 * expected before-state is a compare-and-swap (`operation_conflict`), and the event revision is a primary
 * key, so two racing transitions of one operation cannot both commit; the loser re-reads, finds the new
 * state and is refused. A transition whose event already exists is a replay of a lost response.
 */
export async function transitionOperation(
  context: CatalogContext,
  rawInput: unknown,
): Promise<TransitionOperationResult> {
  const input = transitionOperationInput.parse(rawInput);
  const shard = await routeOrganization(context, input.organizationId);
  const db = shard.db;
  const target = EVENT_STATE[input.event.type];
  const terminal = target !== "running";
  const leaseExpiresAt = terminal
    ? null
    : addMilliseconds(input.event.occurredAt, OPERATION_LEASE_MILLISECONDS);
  const deployment = deploymentResult(input.event.result);
  const command: Command<TransitionSnapshot, TransitionOperationResult> = {
    name: "operations.transitionOperation",
    input,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["operation_events"],
    read: async (reader) => ({
      operation: await readOperation(reader, input.organizationId, input.operationId),
    }),
    decide: ({ operation }) => {
      if (operation === null) {
        return {
          reject: conflict("operation_not_found", "Operation does not exist in the organization"),
        };
      }
      const already = operation.events[input.expected.eventCount];
      if (
        already?.eventId === input.event.eventId &&
        operation.events.length === input.expected.eventCount + 1
      ) {
        return {
          replay: {
            outcome: "replayed",
            state: operation.state,
            eventCount: operation.events.length,
          },
        };
      }
      if (
        operation.state !== input.expected.state ||
        operation.events.length !== input.expected.eventCount
      ) {
        return {
          reject: conflict(
            "operation_conflict",
            "Locked operation state does not match the expected before state",
          ),
        };
      }
      if (input.audit.projectId !== operation.projectId) {
        return {
          reject: conflict("audit_scope_mismatch", "Audit event must share the operation scope"),
        };
      }
      return {
        statements: transitionStatements(db, input, operation, target, leaseExpiresAt, deployment),
        result: () => ({
          outcome: "applied",
          state: target,
          eventCount: input.expected.eventCount + 1,
        }),
      };
    },
  };
  const result = await runCommand(db, command);
  if (!terminal && leaseExpiresAt !== null) {
    await ringDoorbell(context.directory, "op_lease", shard.shardId, leaseExpiresAt);
  }
  return result;
}

function transitionStatements(
  db: D1Database,
  input: z.output<typeof transitionOperationInput>,
  operation: StoredOperation,
  target: StoredOperation["state"],
  leaseExpiresAt: string | null,
  deployment: ReturnType<typeof deploymentResult>,
): D1PreparedStatement[] {
  const { organizationId, operationId, event } = input;
  const payload =
    event.type === "OperationFailed"
      ? { failure: event.failure }
      : event.type === "OperationSucceeded" && event.result !== undefined
        ? { result: event.result }
        : {};
  return [
    db
      .prepare(
        "UPDATE operations SET state = ?3, failure = ?4, updated_at = ?5, lease_expires_at = ?6, result_deployment_id = ?7, result_url = ?8, result_artifact_sha256 = ?9 WHERE organization_id = ?1 AND operation_id = ?2 AND state = ?10",
      )
      .bind(
        organizationId,
        operationId,
        target,
        event.failure === undefined ? null : JSON.stringify(event.failure),
        event.occurredAt,
        leaseExpiresAt,
        deployment?.deploymentId ?? null,
        deployment?.url ?? null,
        deployment === null ? null : hexBytes(deployment.artifactSha256),
        operation.state,
      ),
    guard(db, "operation_conflict", "changes() = 0"),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id, operation_id, revision, event_id, project_id, event_type, idempotency_key, payload, occurred_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      )
      .bind(
        organizationId,
        operationId,
        input.expected.eventCount,
        event.eventId,
        operation.projectId,
        event.type,
        event.idempotencyKey,
        JSON.stringify(payload),
        event.occurredAt,
      ),
    auditStatement(db, organizationId, {
      ...input.audit,
      projectId: operation.projectId,
      billingEpochId: operation.billingEpochId,
    }),
  ];
}
