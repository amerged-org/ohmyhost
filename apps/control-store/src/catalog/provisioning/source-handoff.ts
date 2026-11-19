import { createHash } from "node:crypto";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { ULID_PATTERN } from "../common.js";
type Row = Record<string, unknown>;
export interface SourceHandoffScope {
  workflowId: string;
  eventId: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  operationId: string;
}
export interface SourceHandoffSnapshot {
  scope: Row | null;
  event: Row | null;
  attempts: Row[];
  audits: Row[];
  terminal: boolean;
  claim: boolean;
}
const PREPARED = "SourceLinkQueueDeliveryRecoveryPrepared",
  EXPIRED = "FINAL_ATTEMPT_LEASE_EXPIRED";
const keys = [
  "reconciliationId",
  "requestEventId",
  "deliveryAttemptId",
  "workflowId",
  "environmentId",
  "billingEpochId",
  "sourceConnectionId",
  "grantId",
  "sourceId",
  "deliveryHistorySha256",
  "reconciliationRequiredAt",
  "finalAuditEventId",
  "idempotencySha256",
].sort();
const columns =
  "attempt_id,event_id,attempt_number,status,error_code,failed_at,next_available_at,acknowledged_at,claimed_at,lease_expires_at".split(
    ",",
  );
const terminal = `SELECT EXISTS(SELECT 1 FROM github_source_connections WHERE organization_id=?1 AND project_id=?2 AND source_connection_id=?3) OR EXISTS(SELECT 1 FROM repository_grants WHERE organization_id=?1 AND project_id=?2 AND(grant_id=?3 OR source_connection_id=?3)) OR EXISTS(SELECT 1 FROM project_sources WHERE organization_id=?1 AND project_id=?2 AND(source_id=?3 OR grant_id=?3)) present`;
const HANDOFF_SCOPE = `SELECT run.*,operation.state operation_state,operation.failure,project.owner_state,project.lifecycle_state,intent.installation_id,intent.repository_owner,intent.repository_name FROM product_workflow_runs run JOIN product_command_intents intent ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type JOIN operations operation ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id AND operation.operation_id=run.operation_id AND operation.billing_epoch_id=run.billing_epoch_id JOIN environments environment ON environment.organization_id=run.organization_id AND environment.project_id=run.project_id AND environment.environment_id=run.environment_id JOIN projects project ON project.organization_id=run.organization_id AND project.project_id=run.project_id AND project.active_billing_epoch_id=run.billing_epoch_id WHERE run.workflow_id=?1 AND run.event_id=?2 AND run.organization_id=?3 AND run.project_id=?4 AND run.environment_id=?5 AND run.operation_id=?6 AND run.event_type='SourceLinkRequestedV1'`;
/** Exact five-attempt recovery profile; LIMIT6/2 detects invalid extra history/audits, not a history projection cap. */
export async function readSourceHandoff(
  db: D1Database,
  i: SourceHandoffScope,
): Promise<SourceHandoffSnapshot> {
  const results = await db.batch([
    db
      .prepare(HANDOFF_SCOPE)
      .bind(i.workflowId, i.eventId, i.organizationId, i.projectId, i.environmentId, i.operationId),
    db
      .prepare(
        "SELECT * FROM outbox_events WHERE event_id=?1 AND organization_id=?2 AND project_id=?3 AND operation_id=?4 AND event_type='SourceLinkRequestedV1'",
      )
      .bind(i.eventId, i.organizationId, i.projectId, i.operationId),
    db
      .prepare(
        `SELECT ${columns} FROM delivery_attempts WHERE event_id=?1 ORDER BY attempt_number LIMIT 6`,
      )
      .bind(i.eventId),
    db
      .prepare(
        "SELECT * FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type=?4 LIMIT 2",
      )
      .bind(i.organizationId, i.projectId, i.operationId, PREPARED),
    db.prepare(terminal).bind(i.organizationId, i.projectId, i.operationId),
    db
      .prepare(
        "SELECT 1 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 LIMIT 1",
      )
      .bind(i.organizationId, i.projectId),
  ]);
  return {
    scope: results[0]?.results[0] ?? null,
    event: results[1]?.results[0] ?? null,
    attempts: results[2]?.results ?? [],
    audits: results[3]?.results ?? [],
    terminal: results[4]?.results[0]?.["present"] === 1,
    claim: (results[5]?.results.length ?? 0) > 0,
  };
}
const timestamp = (v: unknown): string | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const time = (v: unknown) => (typeof v === "string" ? Date.parse(v) : NaN);
function object(v: unknown): Row | null {
  let parsed: unknown = v;
  if (typeof v === "string") {
    try {
      parsed = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Row)
    : null;
}
function jsonNull(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "string") return false;
  try {
    return JSON.parse(v) === null;
  } catch {
    return false;
  }
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Row)[k])}`)
    .join(",")}}`;
}
/** Original SourceLink recovery handoff proof: exact immutable audit, all five original attempts and no source effect. */
export function sourceHandoffPrepared(i: SourceHandoffScope, s: SourceHandoffSnapshot): boolean {
  const scope = s.scope,
    event = s.event,
    a = s.attempts,
    final = a[4],
    first = a[0],
    audit = s.audits[0];
  if (
    !scope ||
    !event ||
    !first ||
    !final ||
    a.length !== 5 ||
    s.audits.length !== 1 ||
    !audit ||
    s.claim ||
    s.terminal
  )
    return false;
  if (
    i.workflowId !== `product-command-v1-source-link-${i.eventId}-${i.operationId}` ||
    typeof scope["environment_id"] !== "string" ||
    !ULID_PATTERN.test(scope["environment_id"]) ||
    typeof scope["billing_epoch_id"] !== "string" ||
    !ULID_PATTERN.test(scope["billing_epoch_id"]) ||
    scope["operation_state"] !== "queued" ||
    !jsonNull(scope["failure"]) ||
    scope["state"] !== "queued" ||
    !jsonNull(scope["terminal_evidence"]) ||
    !jsonNull(scope["intermediate_evidence"]) ||
    scope["reconciliation_code"] !== null ||
    scope["active_reconciliation_attempt_id"] !== null ||
    scope["active_replay_attempt_id"] !== null ||
    scope["owner_state"] !== "active" ||
    scope["lifecycle_state"] !== "active" ||
    scope["installation_id"] === null ||
    scope["repository_owner"] === null ||
    scope["repository_name"] === null
  )
    return false;
  for (const k of ["organization_id", "project_id", "operation_id", "billing_epoch_id", "event_id"])
    if (scope[k] !== event[k]) return false;
  const payload = object(event["payload"]);
  if (
    !payload ||
    Object.keys(payload).join(",") !== "environmentId" ||
    payload["environmentId"] !== i.environmentId
  )
    return false;
  if (
    a.some(
      (row, index) =>
        typeof row["attempt_id"] !== "string" ||
        !ULID_PATTERN.test(row["attempt_id"]) ||
        row["event_id"] !== i.eventId ||
        row["attempt_number"] !== index + 1 ||
        timestamp(row["claimed_at"]) === null ||
        timestamp(row["lease_expires_at"]) === null ||
        time(row["claimed_at"]) >= time(row["lease_expires_at"]),
    ) ||
    new Set(a.map((row) => row["attempt_id"])).size !== 5
  )
    return false;
  if (
    first["status"] !== "retry_scheduled" ||
    first["error_code"] !== "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN" ||
    timestamp(first["failed_at"]) === null ||
    timestamp(first["next_available_at"]) === null ||
    time(first["failed_at"]) < time(first["claimed_at"]) ||
    time(first["next_available_at"]) <= time(first["failed_at"]) ||
    first["acknowledged_at"] !== null
  )
    return false;
  if (
    final["status"] !== "reconciliation_required" ||
    final["error_code"] !== EXPIRED ||
    timestamp(final["failed_at"]) === null ||
    time(final["failed_at"]) < time(final["claimed_at"]) ||
    time(final["failed_at"]) < time(final["lease_expires_at"]) ||
    final["next_available_at"] !== null ||
    final["acknowledged_at"] !== null
  )
    return false;
  for (const row of a.slice(1, 4))
    if (
      row["status"] !== "claimed" ||
      row["failed_at"] !== null ||
      row["next_available_at"] !== null ||
      row["error_code"] !== null ||
      row["acknowledged_at"] !== null ||
      time(row["lease_expires_at"]) > time(final["failed_at"])
    )
      return false;
  if (
    time(first["next_available_at"]) > time(a[1]?.["claimed_at"]) ||
    a
      .slice(1, 4)
      .some((row, index) => time(row["lease_expires_at"]) > time(a[index + 2]?.["claimed_at"]))
  )
    return false;
  if (
    event["current_attempt_id"] !== final["attempt_id"] ||
    event["attempt_count"] !== 5 ||
    event["max_attempts"] !== 5 ||
    event["last_error_code"] !== EXPIRED ||
    event["acknowledged_at"] !== null ||
    event["claimed_at"] !== null ||
    event["lease_expires_at"] !== null ||
    timestamp(event["reconciliation_required_at"]) === null ||
    timestamp(event["reconciliation_required_at"]) !== timestamp(final["failed_at"])
  )
    return false;
  const evidence = object(audit["payload"]);
  if (
    !evidence ||
    Object.keys(evidence).sort().join(",") !== keys.join(",") ||
    Object.values(evidence).some((v) => typeof v !== "string")
  )
    return false;
  const expected = {
    requestEventId: i.eventId,
    deliveryAttemptId: final["attempt_id"],
    workflowId: i.workflowId,
    environmentId: i.environmentId,
    billingEpochId: scope["billing_epoch_id"],
    sourceConnectionId: i.operationId,
    grantId: i.operationId,
    sourceId: i.operationId,
    reconciliationRequiredAt: timestamp(final["failed_at"]),
  };
  if (Object.entries(expected).some(([k, v]) => evidence[k] !== v)) return false;
  const history = a.map((row) => ({
    acknowledgedAt: timestamp(row["acknowledged_at"]),
    attemptId: row["attempt_id"],
    attemptNumber: row["attempt_number"],
    claimedAt: timestamp(row["claimed_at"]),
    errorCode: row["error_code"],
    eventId: row["event_id"],
    failedAt: timestamp(row["failed_at"]),
    leaseExpiresAt: timestamp(row["lease_expires_at"]),
    nextAvailableAt: timestamp(row["next_available_at"]),
    status: row["status"],
  }));
  const digest = `sha256:${createHash("sha256").update(canonical(history)).digest("hex")}`;
  return (
    audit["project_id"] === i.projectId &&
    audit["operation_id"] === i.operationId &&
    audit["billing_epoch_id"] === scope["billing_epoch_id"] &&
    audit["event_type"] === PREPARED &&
    audit["actor_type"] === "principal" &&
    typeof audit["actor_id"] === "string" &&
    audit["actor_id"].startsWith("user:") &&
    audit["actor_id"].length >= 6 &&
    audit["actor_id"].length <= 255 &&
    !/\s/u.test(audit["actor_id"]) &&
    timestamp(audit["occurred_at"]) !== null &&
    time(audit["occurred_at"]) >= time(final["failed_at"]) &&
    typeof evidence["reconciliationId"] === "string" &&
    ULID_PATTERN.test(evidence["reconciliationId"]) &&
    typeof evidence["finalAuditEventId"] === "string" &&
    ULID_PATTERN.test(evidence["finalAuditEventId"]) &&
    typeof evidence["idempotencySha256"] === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(evidence["idempotencySha256"]) &&
    evidence["deliveryHistorySha256"] === digest
  );
}
/** Native PG locks become exact row/count/absence fences in the parent's single Core effect batch. */
export function sourceHandoffGuards(
  db: D1Database,
  i: SourceHandoffScope,
  s: SourceHandoffSnapshot,
): D1PreparedStatement[] {
  const event = s.event;
  if (!event) return [guard(db, "operation_conflict", "1")];
  const fields = [
    "current_attempt_id",
    "attempt_count",
    "max_attempts",
    "last_error_code",
    "acknowledged_at",
    "reconciliation_required_at",
    "claimed_at",
    "lease_expires_at",
  ];
  return [
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(SELECT 1 FROM(${HANDOFF_SCOPE}) WHERE billing_epoch_id=?7 AND operation_state='queued' AND (failure IS NULL OR json_type(failure)='null') AND state='queued' AND (terminal_evidence IS NULL OR json_type(terminal_evidence)='null') AND (intermediate_evidence IS NULL OR json_type(intermediate_evidence)='null') AND reconciliation_code IS NULL AND active_reconciliation_attempt_id IS NULL AND active_replay_attempt_id IS NULL AND owner_state='active' AND lifecycle_state='active')`,
      [
        i.workflowId,
        i.eventId,
        i.organizationId,
        i.projectId,
        i.environmentId,
        i.operationId,
        s.scope?.["billing_epoch_id"] ?? null,
      ],
    ),
    guard(
      db,
      "operation_conflict",
      `NOT EXISTS(SELECT 1 FROM outbox_events WHERE event_id=?1 AND ${fields.map((k, n) => `${k} IS ?${n + 2}`).join(" AND ")})`,
      [i.eventId, ...fields.map((k) => event[k])],
    ),
    guard(
      db,
      "operation_conflict",
      "(SELECT count(*) FROM delivery_attempts WHERE event_id=?1)<>5",
      [i.eventId],
    ),
    ...s.attempts.map((row) =>
      guard(
        db,
        "operation_conflict",
        `NOT EXISTS(SELECT 1 FROM delivery_attempts WHERE ${columns.map((k, n) => `${k} IS ?${n + 1}`).join(" AND ")})`,
        columns.map((k) => row[k]),
      ),
    ),
    guard(
      db,
      "operation_conflict",
      "(SELECT count(*) FROM audit_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type=?4)<>1",
      [i.organizationId, i.projectId, i.operationId, PREPARED],
    ),
    guard(db, "operation_conflict", `EXISTS(SELECT 1 FROM(${terminal}) WHERE present=1)`, [
      i.organizationId,
      i.projectId,
      i.operationId,
    ]),
    guard(
      db,
      "operation_conflict",
      "EXISTS(SELECT 1 FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2)",
      [i.organizationId, i.projectId],
    ),
  ];
}
