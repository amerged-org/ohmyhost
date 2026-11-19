import { generatedJsonb } from "../../jsonb-generated.js";
import { guard } from "../../guards.js";
type Row = Record<string, unknown>;
// Server-local fixed Workflow history plan. No SQL, callback or arbitrary terminal mutation is exposed by RPC.
const canonical = (v: unknown): string =>
  v !== null && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ":" + canonical((v as Row)[k]))
          .join(",")}}`
    : JSON.stringify(v);
export const RUN = `SELECT run.*,operation.state operation_state FROM product_workflow_runs run JOIN operations operation ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id AND operation.operation_id=run.operation_id WHERE run.workflow_id=?1 AND run.event_id=?2 AND run.organization_id=?3 AND run.project_id=?4 AND run.environment_id=?5 AND run.operation_id=?6 AND run.event_type=?7`;
export const terminalIdentity = (
  s: { organizationId: string; projectId: string; environmentId: string; operationId: string },
  c: {
    workflowId: string;
    outboxEventId: string;
    reconciliationAttemptId?: string | undefined;
    replayAttemptId?: string | undefined;
  },
  eventType: string,
) => [
  c.workflowId,
  c.outboxEventId,
  s.organizationId,
  s.projectId,
  s.environmentId,
  s.operationId,
  eventType,
];
export function terminalMatches(run: Row | null, evidence: unknown): boolean {
  return (
    run?.["state"] === "completed" &&
    run["active_reconciliation_attempt_id"] === null &&
    run["active_replay_attempt_id"] === null &&
    typeof run["terminal_evidence"] === "string" &&
    canonical(JSON.parse(run["terminal_evidence"])) === canonical(evidence)
  );
}
export function workflowTerminalStatements(
  db: import("../../d1-types.js").D1Database,
  s: { organizationId: string; projectId: string; environmentId: string; operationId: string },
  c: {
    workflowId: string;
    outboxEventId: string;
    startedOperationEventId: string;
    operationEventId: string;
    auditEventId: string;
    reconciliationAttemptId?: string | undefined;
    replayAttemptId?: string | undefined;
  },
  eventType: string,
  run: Row,
  evidence: unknown,
  completedAt: string,
  result: unknown,
  failure: { code: string; message: string } | null = null,
) {
  const values = terminalIdentity(s, c, eventType),
    replay = c.replayAttemptId ?? run["active_replay_attempt_id"];
  return [
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(SELECT 1 FROM(${RUN}) WHERE state='queued' AND active_reconciliation_attempt_id IS ?8 AND active_replay_attempt_id IS ?9)`,
      [...values, c.reconciliationAttemptId ?? null, replay],
    ),
    guard(
      db,
      "operation_conflict",
      "NOT EXISTS(SELECT 1 FROM outbox_events WHERE event_id=?1 AND organization_id=?2 AND project_id=?3 AND operation_id=?4 AND acknowledged_at IS NOT NULL)",
      [c.outboxEventId, s.organizationId, s.projectId, s.operationId],
    ),
    // The source append helper compares pg Date public milliseconds and preserves an existing start row.
    guard(
      db,
      "operation_conflict",
      "EXISTS(SELECT 1 FROM operation_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND revision=1 AND(event_type<>'OperationStarted' OR substr(occurred_at,1,23)>substr(?4,1,23)))",
      [s.organizationId, s.projectId, s.operationId, completedAt],
    ),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) SELECT ?1,?2,?3,?4,1,'OperationStarted',?5,'{}',?6 WHERE NOT EXISTS(SELECT 1 FROM operation_events WHERE organization_id=?1 AND project_id=?4 AND operation_id=?3 AND revision=1)",
      )
      .bind(
        s.organizationId,
        c.startedOperationEventId,
        s.operationId,
        s.projectId,
        `${c.workflowId}:start`,
        completedAt,
      ),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,2,?8,?5,?6,?7)",
      )
      .bind(
        s.organizationId,
        c.operationEventId,
        s.operationId,
        s.projectId,
        `${c.workflowId}:complete`,
        failure === null
          ? generatedJsonb(result === null ? {} : { result })
          : generatedJsonb({ failure }),
        completedAt,
        failure === null ? "OperationSucceeded" : "OperationFailed",
      ),
    db
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,?5,'system','deployment-workflow','{}',?6,?7)",
      )
      .bind(
        s.organizationId,
        c.auditEventId,
        s.projectId,
        s.operationId,
        `${eventType}${failure === null ? "Completed" : "Failed"}`,
        completedAt,
        run["billing_epoch_id"],
      ),
    db
      .prepare(
        "UPDATE product_workflow_runs SET state='completed',terminal_evidence=?2,active_reconciliation_attempt_id=NULL,active_replay_attempt_id=NULL,updated_at=?3,completed_at=?3 WHERE workflow_id=?1 AND state='queued' AND active_reconciliation_attempt_id IS ?4 AND active_replay_attempt_id IS ?5",
      )
      .bind(
        c.workflowId,
        generatedJsonb(evidence),
        completedAt,
        c.reconciliationAttemptId ?? null,
        replay,
      ),
    guard(db, "operation_conflict", "changes()<>1"),
  ];
}
