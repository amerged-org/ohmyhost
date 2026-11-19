// Literal original project-provisioning-hello.ts recovery contracts and pure decisions.
import { parseUlid, type Ulid } from "@ohmyhost/platform";
interface QueryResultRow {
  [column: string]: unknown;
}
export const PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERY_PREPARED =
  "ProjectProvisioningQueueDeliveryRecoveryPrepared" as const;

export const PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERED =
  "ProjectProvisioningQueueDeliveryRecovered" as const;

export const PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN =
  "PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN" as const;

export const PROJECT_PROVISIONING_QUEUE_SEND_TIMEOUT =
  "PROJECT_PROVISIONING_QUEUE_SEND_TIMEOUT" as const;

const FINAL_ATTEMPT_LEASE_EXPIRED = "FINAL_ATTEMPT_LEASE_EXPIRED" as const;

/**
 * The codes a provisioning request is parked with after its final failed delivery: the Queue send was uncertain or timed
 * out, or the final lease expired. The event and its final attempt carry the same one of them.
 */
export type ProjectProvisioningFinalDeliveryCode =
  | typeof PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN
  | typeof PROJECT_PROVISIONING_QUEUE_SEND_TIMEOUT
  | typeof FINAL_ATTEMPT_LEASE_EXPIRED;

export function isFinalProjectDeliveryCode(
  code: unknown,
): code is ProjectProvisioningFinalDeliveryCode {
  return (
    code === PROJECT_PROVISIONING_QUEUE_SEND_UNCERTAIN ||
    code === PROJECT_PROVISIONING_QUEUE_SEND_TIMEOUT ||
    code === FINAL_ATTEMPT_LEASE_EXPIRED
  );
}

export interface ProjectProvisioningQueueDeliveryRecoveryIdentityInput {
  readonly organizationId: Ulid;
  readonly operationId: Ulid;
  readonly reconciliationId: Ulid;
  readonly preparedAuditEventId: Ulid;
  readonly finalAuditEventId: Ulid;
  readonly actorId: string;
  readonly idempotencySha256: `sha256:${string}`;
}

export interface PrepareProjectProvisioningQueueDeliveryRecoveryInput
  extends ProjectProvisioningQueueDeliveryRecoveryIdentityInput {
  readonly preparedAt: string;
}

export interface FinalizeProjectProvisioningQueueDeliveryRecoveryInput
  extends ProjectProvisioningQueueDeliveryRecoveryIdentityInput {
  readonly projectId: Ulid;
  readonly requestEventId: Ulid;
  readonly deliveryAttemptId: Ulid;
  readonly workflowId: string;
  readonly recoveredAt: string;
  readonly workflowOutcome: ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome;
}

export type ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated";

export type ProjectProvisioningQueueDeliveryRecoveryPreparation =
  | Readonly<{ outcome: "not_applicable" }>
  | Readonly<{
      outcome: "prepared";
      reconciliationId: Ulid;
      organizationId: Ulid;
      projectId: Ulid;
      operationId: Ulid;
      requestEventId: Ulid;
      deliveryAttemptId: Ulid;
      workflowId: string;
      /** Advisory snapshot only; finalization reloads the operation under lock. */
      operationState: "queued" | "succeeded" | "failed";
    }>
  | Readonly<{
      outcome: "recovered";
      reconciliationId: Ulid;
      operationId: Ulid;
      state: "pending" | "completed";
    }>;

export type FinalizeProjectProvisioningQueueDeliveryRecoveryResult = Readonly<{
  outcome: "recovered" | "duplicate" | "uncertain";
  reconciliationId: Ulid;
  operationId: Ulid;
  state: "pending" | "completed" | "uncertain";
}>;

export interface QueueDeliveryRecoveryCandidateRow extends QueryResultRow {
  event_id: string;
  organization_id: string;
  project_id: string;
  operation_id: string;
  billing_epoch_id: string;
  payload: unknown;
  current_attempt_id: string;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string;
  operation_state: "queued" | "succeeded" | "failed";
  delivery_attempt_id: string;
  delivery_attempt_number: number;
  delivery_status: string;
  delivery_error_code: string;
  delivery_failed_at: Date;
  delivery_next_available_at: Date | null;
  delivery_acknowledged_at: Date | null;
}

export interface QueueDeliveryRecoveryOperationRow extends QueryResultRow {
  organization_id: string;
  project_id: string;
  operation_id: string;
  billing_epoch_id: string;
  state: string;
}

export interface QueueDeliveryRecoveryOutboxRow extends QueryResultRow {
  event_id: string;
  organization_id: string;
  project_id: string;
  operation_id: string;
  billing_epoch_id: string;
  payload: unknown;
  current_attempt_id: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
  acknowledged_at: Date | null;
  reconciliation_required_at: Date | null;
  claimed_at: Date | null;
  lease_expires_at: Date | null;
}

export interface QueueDeliveryRecoveryAttemptRow extends QueryResultRow {
  attempt_id: string;
  event_id: string;
  attempt_number: number;
  status: string;
  error_code: string | null;
  failed_at: Date | null;
  next_available_at: Date | null;
  acknowledged_at: Date | null;
}

export interface QueueDeliveryRecoveryOwnershipRow extends QueryResultRow {
  organization_id: string;
  project_id: string;
  active_billing_epoch_id: string;
  state: string;
}

export interface QueueDeliveryRecoveryAuditRow extends QueryResultRow {
  audit_event_id: string;
  project_id: string;
  operation_id: string | null;
  billing_epoch_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  payload: unknown;
  occurred_at: Date;
}

export interface QueueDeliveryRecoveryFinalOutboxRow extends QueryResultRow {
  event_id: string;
  organization_id: string;
  project_id: string;
  operation_id: string;
  billing_epoch_id: string;
  operation_state: string;
  event_type: string;
  payload: unknown;
  current_attempt_id: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
  acknowledged_at: Date | null;
  reconciliation_required_at: Date | null;
  delivery_attempt_id: string | null;
  delivery_attempt_number: number | null;
  delivery_status: string | null;
  delivery_error_code: string | null;
  delivery_failed_at: Date | null;
  delivery_next_available_at: Date | null;
  delivery_acknowledged_at: Date | null;
}

export function preparedQueueDeliveryRecovery(
  candidate: QueueDeliveryRecoveryCandidateRow,
  input: PrepareProjectProvisioningQueueDeliveryRecoveryInput,
): Extract<ProjectProvisioningQueueDeliveryRecoveryPreparation, { outcome: "prepared" }> {
  return Object.freeze({
    outcome: "prepared",
    reconciliationId: parseUlid(input.reconciliationId),
    organizationId: parseUlid(candidate.organization_id),
    projectId: parseUlid(candidate.project_id),
    operationId: parseUlid(candidate.operation_id),
    requestEventId: parseUlid(candidate.event_id),
    deliveryAttemptId: parseUlid(candidate.delivery_attempt_id),
    workflowId: projectProvisioningWorkflowId(candidate.event_id, candidate.operation_id),
    operationState: candidate.operation_state,
  });
}

export function preparedQueueDeliveryRecoveryPayload(
  candidate: QueueDeliveryRecoveryCandidateRow,
  input: Pick<
    ProjectProvisioningQueueDeliveryRecoveryIdentityInput,
    "reconciliationId" | "finalAuditEventId" | "idempotencySha256"
  >,
) {
  return {
    reconciliationId: input.reconciliationId,
    requestEventId: candidate.event_id,
    deliveryAttemptId: candidate.delivery_attempt_id,
    workflowId: projectProvisioningWorkflowId(candidate.event_id, candidate.operation_id),
    finalAuditEventId: input.finalAuditEventId,
    idempotencySha256: input.idempotencySha256,
  } as const;
}

export function finalQueueDeliveryRecoveryPayload(
  candidate: QueueDeliveryRecoveryCandidateRow,
  input: Pick<
    FinalizeProjectProvisioningQueueDeliveryRecoveryInput,
    | "reconciliationId"
    | "preparedAuditEventId"
    | "finalAuditEventId"
    | "idempotencySha256"
    | "workflowOutcome"
  >,
  state: "pending" | "completed",
) {
  return {
    ...preparedQueueDeliveryRecoveryPayload(candidate, input),
    preparedAuditEventId: input.preparedAuditEventId,
    outcomeCode: "WORKFLOW_ENSURED",
    workflowOutcome: input.workflowOutcome,
    operationStateAtRecovery: candidate.operation_state,
    state,
  } as const;
}

export function assertPreparedQueueDeliveryRecoveryAudit(
  audit: QueueDeliveryRecoveryAuditRow,
  candidate: QueueDeliveryRecoveryCandidateRow,
  input: ProjectProvisioningQueueDeliveryRecoveryIdentityInput,
): void {
  if (
    audit.audit_event_id !== input.preparedAuditEventId ||
    audit.project_id !== candidate.project_id ||
    audit.operation_id !== candidate.operation_id ||
    audit.billing_epoch_id !== candidate.billing_epoch_id ||
    audit.event_type !== PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERY_PREPARED ||
    audit.actor_type !== "principal" ||
    audit.actor_id !== input.actorId ||
    !Number.isFinite(audit.occurred_at.getTime()) ||
    !isFinalProjectDeliveryCode(candidate.last_error_code) ||
    candidate.delivery_error_code !== candidate.last_error_code ||
    !recordsEqual(audit.payload, preparedQueueDeliveryRecoveryPayload(candidate, input))
  ) {
    throw new Error(
      "Project provisioning Queue recovery prepared audit does not match the request",
    );
  }
}

export function assertFinalQueueDeliveryRecoveryEvidence(
  audit: QueueDeliveryRecoveryAuditRow,
  preparedAudit: QueueDeliveryRecoveryAuditRow,
  event: QueueDeliveryRecoveryFinalOutboxRow,
  input: ProjectProvisioningQueueDeliveryRecoveryIdentityInput,
  deliveryAttemptId: Ulid,
  workflowOutcome: ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome,
  operationStateAtRecovery: "queued" | "succeeded" | "failed",
  state: "pending" | "completed",
): void {
  if (
    event.organization_id !== input.organizationId ||
    event.operation_id !== input.operationId ||
    audit.project_id !== event.project_id ||
    audit.operation_id !== event.operation_id ||
    audit.billing_epoch_id !== event.billing_epoch_id ||
    audit.event_type !== PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERED ||
    audit.actor_type !== "principal" ||
    audit.actor_id !== input.actorId ||
    preparedAudit.audit_event_id !== input.preparedAuditEventId ||
    preparedAudit.project_id !== event.project_id ||
    preparedAudit.operation_id !== event.operation_id ||
    preparedAudit.billing_epoch_id !== event.billing_epoch_id ||
    preparedAudit.event_type !== PROJECT_PROVISIONING_QUEUE_DELIVERY_RECOVERY_PREPARED ||
    preparedAudit.actor_type !== "principal" ||
    preparedAudit.actor_id !== input.actorId ||
    !Number.isFinite(preparedAudit.occurred_at.getTime()) ||
    !Number.isFinite(audit.occurred_at.getTime()) ||
    preparedAudit.occurred_at > audit.occurred_at ||
    event.event_type !== "ProjectProvisioningRequested" ||
    !recordsEqual(event.payload, {
      projectId: event.project_id,
      operationId: event.operation_id,
    }) ||
    event.current_attempt_id !== deliveryAttemptId ||
    event.attempt_count !== event.max_attempts ||
    !isFinalProjectDeliveryCode(event.last_error_code) ||
    event.acknowledged_at === null ||
    event.reconciliation_required_at !== null ||
    audit.occurred_at.toISOString() !== event.acknowledged_at.toISOString() ||
    event.delivery_attempt_id !== deliveryAttemptId ||
    event.delivery_attempt_number !== event.attempt_count ||
    event.delivery_status !== "reconciliation_required" ||
    event.delivery_error_code !== event.last_error_code ||
    event.delivery_failed_at === null ||
    audit.occurred_at < event.delivery_failed_at ||
    event.delivery_next_available_at !== null ||
    event.delivery_acknowledged_at !== null ||
    !recordsEqual(preparedAudit.payload, {
      reconciliationId: input.reconciliationId,
      requestEventId: event.event_id,
      deliveryAttemptId,
      workflowId: projectProvisioningWorkflowId(event.event_id, event.operation_id),
      finalAuditEventId: input.finalAuditEventId,
      idempotencySha256: input.idempotencySha256,
    }) ||
    !recordsEqual(audit.payload, {
      reconciliationId: input.reconciliationId,
      requestEventId: event.event_id,
      deliveryAttemptId,
      workflowId: projectProvisioningWorkflowId(event.event_id, event.operation_id),
      finalAuditEventId: input.finalAuditEventId,
      idempotencySha256: input.idempotencySha256,
      preparedAuditEventId: input.preparedAuditEventId,
      outcomeCode: "WORKFLOW_ENSURED",
      workflowOutcome,
      operationStateAtRecovery,
      state,
    })
  ) {
    throw new Error("Project provisioning Queue recovery final audit evidence is invalid");
  }
}

export function assertQueueRecoveryOperationStateMonotonic(
  historicalState: "queued" | "succeeded" | "failed",
  currentState: "queued" | "succeeded" | "failed",
): void {
  if (historicalState === "queued" || historicalState === currentState) return;
  throw new Error("Project provisioning Queue recovery operation state changed non-monotonically");
}

export function assertFinalizationMatchesCandidate(
  candidate: QueueDeliveryRecoveryCandidateRow,
  input: FinalizeProjectProvisioningQueueDeliveryRecoveryInput,
): void {
  if (
    input.projectId !== candidate.project_id ||
    input.requestEventId !== candidate.event_id ||
    input.deliveryAttemptId !== candidate.delivery_attempt_id ||
    input.workflowId !== projectProvisioningWorkflowId(candidate.event_id, candidate.operation_id)
  ) {
    throw new Error(
      "Project provisioning Queue recovery finalization does not match the prepared scope",
    );
  }
}

export function assertQueueDeliveryRecoveryPreparationInput(
  input: PrepareProjectProvisioningQueueDeliveryRecoveryInput,
): void {
  assertQueueDeliveryRecoveryIdentityInput(input);
  parseQueueRecoveryTimestamp(input.preparedAt, "Queue recovery preparation time");
}

export function assertQueueDeliveryRecoveryIdentityInput(
  input: ProjectProvisioningQueueDeliveryRecoveryIdentityInput,
): void {
  parseUlid(input.organizationId);
  parseUlid(input.operationId);
  parseUlid(input.reconciliationId);
  parseUlid(input.preparedAuditEventId);
  parseUlid(input.finalAuditEventId);
  assertQueueRecoveryPrincipal(input.actorId);
  assertQueueRecoveryDigest(input.idempotencySha256);
}

export function assertQueueDeliveryRecoveryFinalizationInput(
  input: FinalizeProjectProvisioningQueueDeliveryRecoveryInput,
): void {
  assertQueueDeliveryRecoveryIdentityInput(input);
  parseUlid(input.projectId);
  parseUlid(input.requestEventId);
  parseUlid(input.deliveryAttemptId);
  if (
    input.workflowId !== projectProvisioningWorkflowId(input.requestEventId, input.operationId) ||
    !isQueueDeliveryRecoveryWorkflowOutcome(input.workflowOutcome)
  ) {
    throw new TypeError("Project provisioning Queue recovery finalization is invalid");
  }
  parseQueueRecoveryTimestamp(input.recoveredAt, "Queue recovery completion time");
}

export function resolveQueueDeliveryRecoveryFinalization(
  candidate: Pick<QueueDeliveryRecoveryCandidateRow, "operation_state">,
  workflowOutcome: ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome,
):
  | Readonly<{ state: "pending" | "completed"; operationState: "queued" | "succeeded" | "failed" }>
  | Readonly<{ state: "uncertain" }> {
  if (workflowOutcome === "pending") {
    return Object.freeze({
      state: candidate.operation_state === "queued" ? "pending" : "completed",
      operationState: candidate.operation_state,
    });
  }
  if (candidate.operation_state === "queued") return Object.freeze({ state: "uncertain" });
  if (
    (workflowOutcome === "complete" && candidate.operation_state === "succeeded") ||
    ((workflowOutcome === "errored" || workflowOutcome === "terminated") &&
      candidate.operation_state === "failed")
  ) {
    return Object.freeze({ state: "completed", operationState: candidate.operation_state });
  }
  throw new Error(
    "Project provisioning Queue recovery Workflow outcome does not match its durable operation outcome",
  );
}

export function isQueueDeliveryRecoveryWorkflowOutcome(
  value: unknown,
): value is ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome {
  return (
    value === "pending" || value === "complete" || value === "errored" || value === "terminated"
  );
}

export function isQueueDeliveryRecoveryOperationState(
  value: unknown,
): value is "queued" | "succeeded" | "failed" {
  return value === "queued" || value === "succeeded" || value === "failed";
}

export function assertQueueRecoveryPrincipal(actorId: string): void {
  if (
    typeof actorId !== "string" ||
    !actorId.startsWith("user:") ||
    actorId.trim() !== actorId ||
    actorId.length < 6 ||
    actorId.length > 255 ||
    /\s/u.test(actorId)
  ) {
    throw new TypeError("Project provisioning Queue recovery actor is invalid");
  }
}

export function assertQueueRecoveryDigest(value: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Project provisioning Queue recovery idempotency digest is invalid");
  }
}

export function parseQueueRecoveryTimestamp(value: string, label: string): Date {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO 8601 UTC`);
  }
  return timestamp;
}

export function requireQueueRecoveryPayload(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Project provisioning Queue recovery audit payload is invalid");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    Object.values(record).some((field) => typeof field !== "string")
  ) {
    throw new Error("Project provisioning Queue recovery audit payload is invalid");
  }
  return record;
}

export function queueRecoveryApiState(value: unknown): "pending" | "completed" {
  if (value !== "pending" && value !== "completed") {
    throw new Error("Project provisioning Queue recovery final state is invalid");
  }
  return value;
}

export function queueRecoveryWorkflowOutcome(
  value: unknown,
): ProjectProvisioningQueueDeliveryRecoveryWorkflowOutcome {
  if (!isQueueDeliveryRecoveryWorkflowOutcome(value)) {
    throw new Error("Project provisioning Queue recovery final Workflow outcome is invalid");
  }
  return value;
}

export function queueRecoveryOperationState(value: unknown): "queued" | "succeeded" | "failed" {
  if (!isQueueDeliveryRecoveryOperationState(value)) {
    throw new Error("Project provisioning Queue recovery final operation state is invalid");
  }
  return value;
}

export function projectProvisioningWorkflowId(eventId: string, operationId: string): string {
  return `project-provisioning-v1-${eventId}-${operationId}`;
}

export function recordsEqual(left: unknown, right: Readonly<Record<string, unknown>>): boolean {
  if (typeof left !== "object" || left === null || Array.isArray(left)) {
    return false;
  }
  const record = left as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(record[key], right[key]))
  );
}
