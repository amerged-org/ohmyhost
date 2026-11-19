import { parseUlid } from "@ohmyhost/platform";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Plan } from "../../run-command.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import * as P from "./queue-recovery-project-logic.js";
import {
  readRecoverySnapshot,
  recoveryRow,
  recoveryAudit,
  type RecoverySnapshot,
} from "./queue-recovery-snapshot.js";
interface Snapshot extends RecoverySnapshot {
  operation: P.QueueDeliveryRecoveryOperationRow | null;
  events: (P.QueueDeliveryRecoveryOutboxRow & { event_type: string; operation_state: string })[];
  attempts: P.QueueDeliveryRecoveryAttemptRow[];
  ownerships: P.QueueDeliveryRecoveryOwnershipRow[];
  claims: { project_id: string }[];
  audits: P.QueueDeliveryRecoveryAuditRow[];
  globalEvents: { organization_id: string }[];
}
async function read(
  db: D1Database,
  i: P.ProjectProvisioningQueueDeliveryRecoveryIdentityInput,
): Promise<Snapshot> {
  const values = [i.organizationId, i.operationId],
    s = await readRecoverySnapshot(db, [
      {
        sql: "SELECT organization_id,project_id,operation_id,billing_epoch_id,state FROM operations WHERE organization_id=?1 AND operation_id=?2",
        values,
      },
      {
        sql: "SELECT e.event_id,e.organization_id,e.project_id,e.operation_id,e.billing_epoch_id,e.event_type,e.payload,e.current_attempt_id,e.attempt_count,e.max_attempts,e.last_error_code,e.acknowledged_at,e.reconciliation_required_at,e.claimed_at,e.lease_expires_at,o.state operation_state FROM outbox_events e LEFT JOIN operations o ON o.organization_id=e.organization_id AND o.project_id=e.project_id AND o.operation_id=e.operation_id AND o.billing_epoch_id=e.billing_epoch_id WHERE e.organization_id=?1 AND e.operation_id=?2",
        values,
      },
      {
        sql: "SELECT a.attempt_id,a.event_id,a.attempt_number,a.status,a.error_code,a.failed_at,a.next_available_at,a.acknowledged_at FROM delivery_attempts a JOIN outbox_events e USING(event_id) WHERE e.organization_id=?1 AND e.operation_id=?2",
        values,
      },
      {
        sql: "SELECT p.organization_id,p.project_id,p.active_billing_epoch_id,p.owner_state state FROM projects p WHERE p.owner_state<>'transferred' AND p.project_id IN(SELECT project_id FROM operations WHERE organization_id=?1 AND operation_id=?2 UNION SELECT project_id FROM outbox_events WHERE organization_id=?1 AND operation_id=?2)",
        values,
      },
      {
        sql: "SELECT claim.project_id FROM product_provider_mutation_claims claim WHERE claim.organization_id=?1 AND claim.project_id IN(SELECT project_id FROM operations WHERE organization_id=?1 AND operation_id=?2 UNION SELECT project_id FROM outbox_events WHERE organization_id=?1 AND operation_id=?2)",
        values,
      },
      {
        sql: "SELECT audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,payload,occurred_at FROM audit_events WHERE organization_id=?1 AND(operation_id=?2 OR audit_event_id=?3 OR audit_event_id=?4)",
        values: [...values, i.preparedAuditEventId, i.finalAuditEventId],
      },
      {
        sql: "SELECT organization_id FROM outbox_events WHERE operation_id=?1 AND event_type='ProjectProvisioningRequested'",
        values: [i.operationId],
      },
    ]);
  const rows = <T>(n: number) => (s.rows[n] ?? []).map((row) => recoveryRow<T>(row));
  const operations = rows<P.QueueDeliveryRecoveryOperationRow>(0);
  if (operations.length > 1)
    throw new Error("Project provisioning Queue recovery operation is ambiguous");
  return {
    ...s,
    operation: operations[0] ?? null,
    events: rows(1),
    attempts: rows(2),
    ownerships: rows(3),
    claims: rows(4),
    audits: rows(5),
    globalEvents: rows(6),
  };
}
function candidate(s: Snapshot): P.QueueDeliveryRecoveryCandidateRow | null | undefined {
  const operation = s.operation;
  if (!operation) return null;
  const events = s.events.filter((e) => e.event_type === "ProjectProvisioningRequested");
  if (events.length === 0) return undefined;
  const event = events[0];
  if (events.length !== 1 || event === undefined)
    throw new Error("Project provisioning recovery requires one exact request event");
  const attempts =
      event.current_attempt_id === null
        ? []
        : s.attempts.filter(
            (a) => a.event_id === event.event_id && a.attempt_id === event.current_attempt_id,
          ),
    attempt = attempts[0];
  if (event.current_attempt_id !== null && attempts.length !== 1)
    throw new Error("Project provisioning Queue recovery delivery attempt is ambiguous");
  const owners = s.ownerships.filter((o) => o.project_id === event.project_id),
    owner = owners[0];
  if (owners.length !== 1 || !owner || s.claims.some((c) => c.project_id === event.project_id))
    return null;
  if (
    event.organization_id !== operation.organization_id ||
    event.project_id !== operation.project_id ||
    event.operation_id !== operation.operation_id ||
    event.billing_epoch_id !== operation.billing_epoch_id ||
    !P.recordsEqual(event.payload, {
      projectId: event.project_id,
      operationId: event.operation_id,
    }) ||
    event.acknowledged_at !== null ||
    event.reconciliation_required_at === null ||
    event.claimed_at !== null ||
    event.lease_expires_at !== null ||
    !P.isFinalProjectDeliveryCode(event.last_error_code) ||
    event.attempt_count !== event.max_attempts ||
    event.current_attempt_id === null ||
    !attempt ||
    attempt.attempt_number !== event.attempt_count ||
    attempt.status !== "reconciliation_required" ||
    !P.isFinalProjectDeliveryCode(attempt.error_code) ||
    attempt.error_code !== event.last_error_code ||
    attempt.failed_at === null ||
    attempt.next_available_at !== null ||
    attempt.acknowledged_at !== null ||
    owner.organization_id !== event.organization_id ||
    owner.active_billing_epoch_id !== event.billing_epoch_id ||
    owner.state !== "active" ||
    !P.isQueueDeliveryRecoveryOperationState(operation.state)
  )
    return null;
  return {
    ...event,
    current_attempt_id: event.current_attempt_id,
    last_error_code: event.last_error_code,
    operation_state: operation.state,
    delivery_attempt_id: attempt.attempt_id,
    delivery_attempt_number: attempt.attempt_number,
    delivery_status: attempt.status,
    delivery_error_code: attempt.error_code,
    delivery_failed_at: attempt.failed_at,
    delivery_next_available_at: attempt.next_available_at,
    delivery_acknowledged_at: attempt.acknowledged_at,
  };
}
function finalReplay(
  s: Snapshot,
  i: P.ProjectProvisioningQueueDeliveryRecoveryIdentityInput,
): Extract<P.ProjectProvisioningQueueDeliveryRecoveryPreparation, { outcome: "recovered" }> | null {
  const audit = s.audits.find((a) => a.audit_event_id === i.finalAuditEventId);
  if (!audit) return null;
  if (
    audit.event_type !== P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERED ||
    audit.operation_id !== i.operationId ||
    audit.actor_type !== "principal" ||
    audit.actor_id !== i.actorId
  )
    throw new Error("Project provisioning Queue recovery final audit does not match the request");
  const p = P.requireQueueRecoveryPayload(audit.payload, [
    "reconciliationId",
    "requestEventId",
    "deliveryAttemptId",
    "workflowId",
    "finalAuditEventId",
    "idempotencySha256",
    "preparedAuditEventId",
    "outcomeCode",
    "workflowOutcome",
    "operationStateAtRecovery",
    "state",
  ]);
  const request = parseUlid(String(p["requestEventId"])),
    delivery = parseUlid(String(p["deliveryAttemptId"])),
    prepared = parseUlid(String(p["preparedAuditEventId"])),
    workflow = P.queueRecoveryWorkflowOutcome(p["workflowOutcome"]),
    historical = P.queueRecoveryOperationState(p["operationStateAtRecovery"]),
    state = P.queueRecoveryApiState(p["state"]);
  const event = s.events.find(
      (e) =>
        e.event_id === request && e.project_id === audit.project_id && e.operation_state != null,
    ),
    attempt = event
      ? s.attempts.find(
          (a) => a.event_id === event.event_id && a.attempt_id === event.current_attempt_id,
        )
      : undefined;
  if (!event)
    throw new Error("Project provisioning Queue recovery final audit scope is unavailable");
  const preparedAudit = s.audits.find((a) => a.audit_event_id === prepared);
  if (!preparedAudit)
    throw new Error(
      "Project provisioning Queue recovery final replay requires one exact prepared audit",
    );
  const resolution = P.resolveQueueDeliveryRecoveryFinalization(
    { operation_state: historical },
    workflow,
  );
  if (resolution.state === "uncertain")
    throw new Error(
      "Project provisioning Queue recovery final audit cannot close a queued terminal Workflow",
    );
  if (state !== resolution.state)
    throw new Error("Project provisioning Queue recovery final audit state is invalid");
  P.assertQueueRecoveryOperationStateMonotonic(
    historical,
    P.queueRecoveryOperationState(event.operation_state),
  );
  P.assertFinalQueueDeliveryRecoveryEvidence(
    audit,
    preparedAudit,
    {
      ...event,
      delivery_attempt_id: attempt?.attempt_id ?? null,
      delivery_attempt_number: attempt?.attempt_number ?? null,
      delivery_status: attempt?.status ?? null,
      delivery_error_code: attempt?.error_code ?? null,
      delivery_failed_at: attempt?.failed_at ?? null,
      delivery_next_available_at: attempt?.next_available_at ?? null,
      delivery_acknowledged_at: attempt?.acknowledged_at ?? null,
    },
    i,
    delivery,
    workflow,
    historical,
    state,
  );
  return {
    outcome: "recovered",
    reconciliationId: parseUlid(i.reconciliationId),
    operationId: parseUlid(i.operationId),
    state,
  };
}
const audits = (s: Snapshot, c: P.QueueDeliveryRecoveryCandidateRow) =>
  s.audits.filter(
    (a) =>
      a.project_id === c.project_id &&
      a.operation_id === c.operation_id &&
      [
        P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERED,
        P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERY_PREPARED,
      ].includes(a.event_type as never),
  );
function audit(
  db: D1Database,
  c: P.QueueDeliveryRecoveryCandidateRow,
  i: P.ProjectProvisioningQueueDeliveryRecoveryIdentityInput,
  final: boolean,
  at: string,
  payload: unknown,
) {
  return recoveryAudit(db, {
    organizationId: c.organization_id,
    auditEventId: final ? i.finalAuditEventId : i.preparedAuditEventId,
    projectId: c.project_id,
    operationId: c.operation_id,
    billingEpochId: c.billing_epoch_id,
    eventType: final
      ? P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERED
      : P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERY_PREPARED,
    actorId: i.actorId,
    payload,
    occurredAt: at,
  });
}
export async function prepareProjectProvisioningQueueDeliveryRecovery(
  context: CatalogContext,
  raw: unknown,
): Promise<P.ProjectProvisioningQueueDeliveryRecoveryPreparation> {
  const i = raw as P.PrepareProjectProvisioningQueueDeliveryRecoveryInput;
  P.assertQueueDeliveryRecoveryPreparationInput(i);
  const { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "queueRecovery.prepareProject",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["audit_events"],
    read: (r) => read(r, i),
    decide(s): Plan<P.ProjectProvisioningQueueDeliveryRecoveryPreparation> {
      const guards = s.guards(db),
        replay = finalReplay(s, i);
      if (replay) return { statements: guards, result: () => replay };
      if (!s.operation) {
        if (!s.globalEvents.length)
          return { statements: guards, result: () => ({ outcome: "not_applicable" }) };
        if (s.globalEvents.length !== 1 || s.globalEvents[0]?.organization_id !== i.organizationId)
          throw new Error("Project provisioning request does not match the requested organization");
        throw new Error("Project provisioning recovery operation is unavailable");
      }
      const c = candidate(s);
      if (c === undefined)
        return { statements: guards, result: () => ({ outcome: "not_applicable" }) };
      if (!c)
        throw new Error(
          "Project provisioning event is not an exact final Queue-send recovery candidate",
        );
      const all = audits(s, c);
      if (all.some((a) => a.event_type === P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERED))
        throw new Error(
          "Project provisioning Queue recovery final audit conflicts with its open Outbox",
        );
      const prepared = all.filter(
        (a) => a.event_type === P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERY_PREPARED,
      );
      if (prepared.length) {
        if (prepared.length !== 1 || !prepared[0])
          throw new Error("Project provisioning Queue recovery prepared audit is ambiguous");
        if (prepared[0].audit_event_id !== i.preparedAuditEventId)
          throw new Error("A different Project provisioning Queue recovery is already prepared");
        P.assertPreparedQueueDeliveryRecoveryAudit(prepared[0], c, i);
        return { statements: guards, result: () => P.preparedQueueDeliveryRecovery(c, i) };
      }
      return {
        statements: [
          ...guards,
          audit(db, c, i, false, i.preparedAt, P.preparedQueueDeliveryRecoveryPayload(c, i)),
        ],
        result: () => P.preparedQueueDeliveryRecovery(c, i),
      };
    },
  });
}
export async function finalizeProjectProvisioningQueueDeliveryRecovery(
  context: CatalogContext,
  raw: unknown,
): Promise<P.FinalizeProjectProvisioningQueueDeliveryRecoveryResult> {
  const i = raw as P.FinalizeProjectProvisioningQueueDeliveryRecoveryInput;
  P.assertQueueDeliveryRecoveryFinalizationInput(i);
  const { db } = await routeOrganization(context, i.organizationId);
  return runCommand(db, {
    name: "queueRecovery.finalizeProject",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["audit_events"],
    read: (r) => read(r, i),
    decide(s): Plan<P.FinalizeProjectProvisioningQueueDeliveryRecoveryResult> {
      const guards = s.guards(db),
        c = candidate(s);
      if (c == null) {
        const replay = finalReplay(s, i);
        if (replay)
          return { statements: guards, result: () => ({ ...replay, outcome: "duplicate" }) };
        throw new Error(
          "Project provisioning event is not an exact final Queue-send recovery candidate",
        );
      }
      P.assertFinalizationMatchesCandidate(c, i);
      const all = audits(s, c),
        prepared = all.filter(
          (a) => a.event_type === P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERY_PREPARED,
        );
      if (prepared.length !== 1 || !prepared[0])
        throw new Error("Project provisioning Queue recovery requires one exact prepared audit");
      P.assertPreparedQueueDeliveryRecoveryAudit(prepared[0], c, i);
      if (all.some((a) => a.event_type === P.PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERED))
        throw new Error(
          "Project provisioning Queue recovery final audit conflicts with its open Outbox",
        );
      const resolution = P.resolveQueueDeliveryRecoveryFinalization(c, i.workflowOutcome);
      if (resolution.state === "uncertain")
        return {
          statements: guards,
          result: () => ({
            outcome: "uncertain",
            reconciliationId: i.reconciliationId,
            operationId: i.operationId,
            state: "uncertain",
          }),
        };
      const at = P.parseQueueRecoveryTimestamp(i.recoveredAt, "Queue recovery completion time");
      if (at < c.delivery_failed_at)
        throw new RangeError(
          "Queue recovery completion time must not predate the final delivery failure",
        );
      if (at < prepared[0].occurred_at)
        throw new RangeError(
          "Queue recovery completion time must not predate the prepared recovery audit",
        );
      return {
        statements: [
          ...guards,
          db
            .prepare(
              "UPDATE outbox_events SET acknowledged_at=?1,reconciliation_required_at=NULL WHERE event_id=?2 RETURNING 1",
            )
            .bind(i.recoveredAt.replace(/\.(\d{3})Z$/u, ".$1000Z"), c.event_id),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM outbox_events WHERE event_id=?1 AND acknowledged_at=?2 AND reconciliation_required_at IS NULL)",
            [c.event_id, i.recoveredAt.replace(/\.(\d{3})Z$/u, ".$1000Z")],
          ),
          audit(
            db,
            c,
            i,
            true,
            i.recoveredAt,
            P.finalQueueDeliveryRecoveryPayload(c, i, resolution.state),
          ),
        ],
        result: () => ({
          outcome: "recovered",
          reconciliationId: i.reconciliationId,
          operationId: i.operationId,
          state: resolution.state,
        }),
      };
    },
  });
}
