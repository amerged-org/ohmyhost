// Literal original source-link-queue-delivery-recovery.ts contracts and pure decisions.
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isFinalDeliveryCode } from "./queue-recovery-deployment-logic.js";
interface QueryResultRow {
  [column: string]: unknown;
}
export const SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED =
  "SourceLinkQueueDeliveryRecoveryPrepared" as const;

export const SOURCE_LINK_QUEUE_DELIVERY_RECOVERED = "SourceLinkQueueDeliveryRecovered" as const;

export type SourceLinkOperationState = "queued" | "succeeded" | "failed";

export type SourceLinkRunState = "queued" | "completed" | "reconciliation_required";

export type SourceLinkQueueDeliveryRecoveryWorkflowOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated";

export interface SourceLinkQueueDeliveryRecoveryIdentityInput {
  readonly organizationId: Ulid;
  readonly operationId: Ulid;
  readonly reconciliationId: Ulid;
  readonly preparedAuditEventId: Ulid;
  readonly finalAuditEventId: Ulid;
  readonly actorId: string;
  readonly idempotencySha256: `sha256:${string}`;
}

export interface PrepareSourceLinkQueueDeliveryRecoveryInput
  extends SourceLinkQueueDeliveryRecoveryIdentityInput {
  readonly preparedAt: string;
}

export interface FinalizeSourceLinkQueueDeliveryRecoveryInput
  extends SourceLinkQueueDeliveryRecoveryIdentityInput {
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly billingEpochId: Ulid;
  readonly requestEventId: Ulid;
  readonly deliveryAttemptId: Ulid;
  readonly workflowId: string;
  readonly recoveredAt: string;
  readonly workflowOutcome: SourceLinkQueueDeliveryRecoveryWorkflowOutcome;
}

export interface SourceLinkQueueDeliveryRecoveryMessage {
  readonly version: 1;
  readonly eventType: "SourceLinkRequestedV1";
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly billingEpochId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
}

export type SourceLinkQueueDeliveryRecoveryPreparation =
  | Readonly<{ outcome: "not_applicable" }>
  | Readonly<{
      outcome: "prepared";
      reconciliationId: Ulid;
      organizationId: Ulid;
      projectId: Ulid;
      environmentId: Ulid;
      operationId: Ulid;
      billingEpochId: Ulid;
      requestEventId: Ulid;
      deliveryAttemptId: Ulid;
      workflowId: string;
      originalMessage: SourceLinkQueueDeliveryRecoveryMessage;
    }>
  | Readonly<{
      outcome: "recovered";
      reconciliationId: Ulid;
      operationId: Ulid;
      state: "pending" | "completed";
      readonly continueProductWorkflowReplay?: true;
      readonly continueProductWorkflowReplayWithNewKey?: true;
      readonly continueProductWorkflowReplayAttemptIds?: readonly Ulid[];
      readonly completedProductWorkflowReplayAttemptIds?: readonly Ulid[];
    }>;

export type FinalizeSourceLinkQueueDeliveryRecoveryResult = Readonly<{
  outcome: "recovered" | "duplicate" | "uncertain";
  reconciliationId: Ulid;
  operationId: Ulid;
  state: "pending" | "completed" | "uncertain";
  readonly continueProductWorkflowReplay?: true;
  readonly continueProductWorkflowReplayWithNewKey?: true;
  readonly continueProductWorkflowReplayAttemptIds?: readonly Ulid[];
  readonly completedProductWorkflowReplayAttemptIds?: readonly Ulid[];
}>;

export interface RecoveryScopeRow extends QueryResultRow {
  organization_id: string;
  project_id: string;
  environment_id: string;
  operation_id: string;
  billing_epoch_id: string;
  event_id: string;
  workflow_id: string;
  installation_id: string | null;
  repository_owner: string | null;
  repository_name: string | null;
  operation_state: string;
  operation_failure: unknown;
  workflow_state: string;
  workflow_terminal_evidence: unknown;
  workflow_intermediate_evidence: unknown;
  workflow_reconciliation_code: string | null;
  active_reconciliation_attempt_id: string | null;
  active_replay_attempt_id: string | null;
  ownership_state: string;
  lifecycle_state: string;
}

export interface RecoveryOutboxRow extends QueryResultRow {
  event_id: string;
  organization_id: string;
  project_id: string;
  operation_id: string;
  billing_epoch_id: string;
  event_type: string;
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

export interface RecoveryAttemptRow extends QueryResultRow {
  attempt_id: string;
  event_id: string;
  attempt_number: number;
  claimed_at: Date;
  lease_expires_at: Date;
  status: string;
  error_code: string | null;
  failed_at: Date | null;
  next_available_at: Date | null;
  acknowledged_at: Date | null;
}

export interface RecoveryAuditRow extends QueryResultRow {
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

export interface SourceTerminalState extends QueryResultRow {
  connection_present: boolean;
  grant_present: boolean;
  source_present: boolean;
  exact_ready: boolean;
  source_external_repository_id: string | null;
}

export interface RecoveryCandidate {
  readonly scope: RecoveryScopeRow;
  readonly event: RecoveryOutboxRow;
  readonly attempt: RecoveryAttemptRow;
  readonly deliveryHistory: DeliveryHistory;
  readonly hasProviderClaim: boolean;
  readonly source: SourceTerminalState;
}

export interface DeliveryHistory {
  readonly attempts: readonly RecoveryAttemptRow[];
  readonly finalAttempt: RecoveryAttemptRow;
  readonly sha256: `sha256:${string}`;
}

export type SourceLinkWorkflowReplayContinuation = Readonly<{
  readonly kind: "active" | "terminal";
  readonly hasTerminalFailure: boolean;
  readonly isTerminalRetryable: boolean;
  readonly replayAttemptIds: readonly Ulid[];
  readonly completedReplayAttemptIds: readonly Ulid[];
}>;

export interface SourceLinkWorkflowReplayChainRow extends QueryResultRow {
  attempt_id: string;
  attempt_number: number;
  physical_workflow_id: string;
  actor_id: string;
  idempotency_sha256: Buffer;
  terminal_retryable_evidence_present: boolean;
}

export interface SourceLinkWorkflowReplayRow extends QueryResultRow {
  attempt_id: string;
  physical_workflow_id: string;
  operation_state: string;
  workflow_state: string;
  active_reconciliation_attempt_id: string | null;
  active_replay_attempt_id: string | null;
  workflow_reconciliation_code: string | null;
  workflow_terminal_evidence: unknown;
  workflow_intermediate_evidence: unknown;
  failure_id: string | null;
  failure_terminal_status: string | null;
  failure_physical_workflow_id: string | null;
  failure_actor_id: string | null;
  reconciliation_evidence_present: boolean;
}

export interface ProductWorkflowReplayRouting {
  readonly continueOriginalKey: boolean;
  readonly continueWithNewKey: boolean;
  readonly readableReplayAttemptIds: readonly Ulid[];
  readonly completedReplayAttemptIds: readonly Ulid[];
}

export function parseExactSourceLinkDeliveryHistory(
  event: RecoveryOutboxRow,
  attempts: readonly RecoveryAttemptRow[],
): DeliveryHistory {
  const first = attempts[0];
  const second = attempts[1];
  const third = attempts[2];
  const fourth = attempts[3];
  const finalAttempt = attempts[4];
  if (
    attempts.length !== 5 ||
    first === undefined ||
    second === undefined ||
    third === undefined ||
    fourth === undefined ||
    finalAttempt === undefined ||
    attempts.some(
      (attempt, index) =>
        !isUlidString(attempt.attempt_id) ||
        attempt.event_id !== event.event_id ||
        attempt.attempt_number !== index + 1 ||
        !isValidTimestamp(attempt.claimed_at) ||
        !isValidTimestamp(attempt.lease_expires_at) ||
        attempt.claimed_at >= attempt.lease_expires_at,
    ) ||
    new Set(attempts.map((attempt) => attempt.attempt_id)).size !== attempts.length ||
    !isRetryScheduledInitialAttempt(first) ||
    !isExpiredHistoricalClaim(second, finalAttempt.failed_at) ||
    !isExpiredHistoricalClaim(third, finalAttempt.failed_at) ||
    !isExpiredHistoricalClaim(fourth, finalAttempt.failed_at) ||
    !isFinalSourceLinkDeliveryAttempt(finalAttempt) ||
    first.next_available_at === null ||
    first.next_available_at > second.claimed_at ||
    second.lease_expires_at > third.claimed_at ||
    third.lease_expires_at > fourth.claimed_at ||
    fourth.lease_expires_at > finalAttempt.claimed_at
  ) {
    throw new Error("SourceLink Queue recovery delivery history is invalid");
  }
  const immutableAttempts = Object.freeze([...attempts]);
  return Object.freeze({
    attempts: immutableAttempts,
    finalAttempt,
    sha256: deliveryHistorySha256(immutableAttempts),
  });
}

export function isRetryScheduledInitialAttempt(attempt: RecoveryAttemptRow | undefined): boolean {
  if (attempt === undefined || attempt.failed_at === null || attempt.next_available_at === null)
    return false;
  return (
    attempt.status === "retry_scheduled" &&
    attempt.error_code === "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN" &&
    isValidTimestamp(attempt.failed_at) &&
    isValidTimestamp(attempt.next_available_at) &&
    attempt.failed_at >= attempt.claimed_at &&
    attempt.next_available_at > attempt.failed_at &&
    attempt.acknowledged_at === null
  );
}

export function isExpiredHistoricalClaim(
  attempt: RecoveryAttemptRow | undefined,
  finalFailedAt: Date | null,
): boolean {
  if (attempt === undefined || finalFailedAt === null || !isValidTimestamp(finalFailedAt))
    return false;
  return (
    attempt.status === "claimed" &&
    attempt.failed_at === null &&
    attempt.next_available_at === null &&
    attempt.error_code === null &&
    attempt.acknowledged_at === null &&
    attempt.lease_expires_at <= finalFailedAt
  );
}

export function isFinalSourceLinkDeliveryAttempt(attempt: RecoveryAttemptRow): boolean {
  if (attempt.failed_at === null) return false;
  return (
    attempt.attempt_number === 5 &&
    attempt.status === "reconciliation_required" &&
    isFinalDeliveryCode(attempt.error_code) &&
    isValidTimestamp(attempt.failed_at) &&
    attempt.failed_at >= attempt.claimed_at &&
    attempt.failed_at >= attempt.lease_expires_at &&
    attempt.next_available_at === null &&
    attempt.acknowledged_at === null
  );
}

export function deliveryHistorySha256(attempts: readonly RecoveryAttemptRow[]): `sha256:${string}` {
  const canonical = canonicalJson(
    attempts.map((attempt) => ({
      acknowledgedAt: attempt.acknowledged_at?.toISOString() ?? null,
      attemptId: attempt.attempt_id,
      attemptNumber: attempt.attempt_number,
      claimedAt: attempt.claimed_at.toISOString(),
      errorCode: attempt.error_code,
      eventId: attempt.event_id,
      failedAt: attempt.failed_at?.toISOString() ?? null,
      leaseExpiresAt: attempt.lease_expires_at.toISOString(),
      nextAvailableAt: attempt.next_available_at?.toISOString() ?? null,
      status: attempt.status,
    })),
  );
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function isInitialRecoveryCandidate(candidate: RecoveryCandidate): boolean {
  const { scope } = candidate;
  return (
    isScopeIdentity(candidate) &&
    scope.operation_state === "queued" &&
    scope.operation_failure === null &&
    scope.workflow_state === "queued" &&
    scope.workflow_terminal_evidence === null &&
    scope.workflow_intermediate_evidence === null &&
    scope.workflow_reconciliation_code === null &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
    scope.ownership_state === "active" &&
    scope.lifecycle_state === "active" &&
    !candidate.hasProviderClaim &&
    !hasTerminalSourceState(candidate.source) &&
    isOpenFinalDelivery(candidate.event, candidate.attempt)
  );
}

export function isFinalizationScope(candidate: RecoveryCandidate): boolean {
  const { scope } = candidate;
  return (
    isScopeIdentity(candidate) &&
    isOperationState(scope.operation_state) &&
    isWorkflowState(scope.workflow_state) &&
    scope.ownership_state === "active" &&
    scope.lifecycle_state === "active" &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
    !candidate.hasProviderClaim &&
    isOpenFinalDelivery(candidate.event, candidate.attempt)
  );
}

export function isScopeIdentity(candidate: RecoveryCandidate): boolean {
  const { scope, event } = candidate;
  return (
    scope.organization_id === event.organization_id &&
    scope.project_id === event.project_id &&
    scope.operation_id === event.operation_id &&
    scope.billing_epoch_id === event.billing_epoch_id &&
    scope.event_id === event.event_id &&
    isUlidString(scope.environment_id) &&
    isUlidString(scope.billing_epoch_id) &&
    scope.installation_id !== null &&
    scope.repository_owner !== null &&
    scope.repository_name !== null &&
    scope.workflow_id === sourceLinkWorkflowId(scope.event_id, scope.operation_id) &&
    event.event_type === "SourceLinkRequestedV1" &&
    exactRecord(event.payload, { environmentId: scope.environment_id })
  );
}

export function isOpenFinalDelivery(
  event: RecoveryOutboxRow,
  attempt: RecoveryAttemptRow,
): boolean {
  return (
    event.current_attempt_id !== null &&
    event.attempt_count === 5 &&
    event.max_attempts === 5 &&
    isFinalDeliveryCode(event.last_error_code) &&
    event.acknowledged_at === null &&
    event.reconciliation_required_at !== null &&
    isValidTimestamp(event.reconciliation_required_at) &&
    event.claimed_at === null &&
    event.lease_expires_at === null &&
    attempt.attempt_id === event.current_attempt_id &&
    attempt.event_id === event.event_id &&
    attempt.attempt_number === 5 &&
    attempt.status === "reconciliation_required" &&
    attempt.error_code === event.last_error_code &&
    isFinalSourceLinkDeliveryAttempt(attempt) &&
    attempt.failed_at !== null &&
    event.reconciliation_required_at.toISOString() === attempt.failed_at.toISOString() &&
    attempt.next_available_at === null &&
    attempt.acknowledged_at === null
  );
}

export function isClosedFinalDelivery(
  event: RecoveryOutboxRow,
  attempt: RecoveryAttemptRow,
): boolean {
  return (
    event.current_attempt_id !== null &&
    event.attempt_count === 5 &&
    event.max_attempts === 5 &&
    isFinalDeliveryCode(event.last_error_code) &&
    event.acknowledged_at !== null &&
    event.reconciliation_required_at === null &&
    event.claimed_at === null &&
    event.lease_expires_at === null &&
    attempt.attempt_id === event.current_attempt_id &&
    attempt.event_id === event.event_id &&
    isFinalSourceLinkDeliveryAttempt(attempt) &&
    attempt.failed_at !== null &&
    attempt.next_available_at === null &&
    attempt.acknowledged_at === null
  );
}

export function isUnacknowledgedReconciliationSignal(event: RecoveryOutboxRow): boolean {
  return event.acknowledged_at === null && event.reconciliation_required_at !== null;
}

export function hasTerminalSourceState(source: SourceTerminalState): boolean {
  return source.connection_present || source.grant_present || source.source_present;
}

export function preparedRecovery(
  candidate: RecoveryCandidate,
  input: PrepareSourceLinkQueueDeliveryRecoveryInput,
): Extract<SourceLinkQueueDeliveryRecoveryPreparation, { outcome: "prepared" }> {
  return Object.freeze({
    outcome: "prepared",
    reconciliationId: parseUlid(input.reconciliationId),
    organizationId: parseUlid(candidate.scope.organization_id),
    projectId: parseUlid(candidate.scope.project_id),
    environmentId: parseUlid(candidate.scope.environment_id),
    operationId: parseUlid(candidate.scope.operation_id),
    billingEpochId: parseUlid(candidate.scope.billing_epoch_id),
    requestEventId: parseUlid(candidate.scope.event_id),
    deliveryAttemptId: parseUlid(candidate.attempt.attempt_id),
    workflowId: candidate.scope.workflow_id,
    originalMessage: originalMessage(candidate),
  });
}

export function originalMessage(
  candidate: RecoveryCandidate,
): SourceLinkQueueDeliveryRecoveryMessage {
  return Object.freeze({
    version: 1,
    eventType: "SourceLinkRequestedV1",
    eventId: parseUlid(candidate.scope.event_id),
    organizationId: parseUlid(candidate.scope.organization_id),
    projectId: parseUlid(candidate.scope.project_id),
    billingEpochId: parseUlid(candidate.scope.billing_epoch_id),
    environmentId: parseUlid(candidate.scope.environment_id),
    operationId: parseUlid(candidate.scope.operation_id),
  });
}

export const preparedPayloadKeys = [
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
] as const;

export const finalPayloadKeys = [
  ...preparedPayloadKeys,
  "preparedAuditEventId",
  "outcomeCode",
  "workflowOutcome",
  "operationStateAtRecovery",
  "workflowStateAtRecovery",
  "sourceStateAtRecovery",
  "reconciliationCodeAtRecovery",
  "state",
] as const;

export function preparedPayload(
  candidate: RecoveryCandidate,
  input: Pick<
    SourceLinkQueueDeliveryRecoveryIdentityInput,
    "reconciliationId" | "finalAuditEventId" | "idempotencySha256"
  >,
) {
  return {
    reconciliationId: input.reconciliationId,
    requestEventId: candidate.scope.event_id,
    deliveryAttemptId: candidate.attempt.attempt_id,
    workflowId: candidate.scope.workflow_id,
    environmentId: candidate.scope.environment_id,
    billingEpochId: candidate.scope.billing_epoch_id,
    sourceConnectionId: candidate.scope.operation_id,
    grantId: candidate.scope.operation_id,
    sourceId: candidate.scope.operation_id,
    deliveryHistorySha256: candidate.deliveryHistory.sha256,
    reconciliationRequiredAt: requiredOpenReconciliationTimestamp(candidate),
    finalAuditEventId: input.finalAuditEventId,
    idempotencySha256: input.idempotencySha256,
  } as const;
}

export function finalPayload(
  candidate: RecoveryCandidate,
  input: Pick<
    FinalizeSourceLinkQueueDeliveryRecoveryInput,
    | "reconciliationId"
    | "preparedAuditEventId"
    | "finalAuditEventId"
    | "idempotencySha256"
    | "workflowOutcome"
  >,
  resolution: Extract<ReturnType<typeof resolveFinalization>, { state: "pending" | "completed" }>,
) {
  return {
    ...preparedPayload(candidate, input),
    preparedAuditEventId: input.preparedAuditEventId,
    outcomeCode: "WORKFLOW_ENSURED",
    workflowOutcome: input.workflowOutcome,
    operationStateAtRecovery: candidate.scope.operation_state,
    workflowStateAtRecovery: candidate.scope.workflow_state,
    sourceStateAtRecovery: resolution.kind,
    reconciliationCodeAtRecovery: candidate.scope.workflow_reconciliation_code ?? "none",
    state: resolution.state,
  } as const;
}

export function assertPreparedAudit(
  audit: RecoveryAuditRow,
  candidate: RecoveryCandidate,
  input: SourceLinkQueueDeliveryRecoveryIdentityInput,
): void {
  if (
    audit.audit_event_id !== input.preparedAuditEventId ||
    audit.project_id !== candidate.scope.project_id ||
    audit.operation_id !== candidate.scope.operation_id ||
    audit.billing_epoch_id !== candidate.scope.billing_epoch_id ||
    audit.event_type !== SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED ||
    audit.actor_type !== "principal" ||
    audit.actor_id !== input.actorId ||
    !isValidTimestamp(audit.occurred_at) ||
    audit.occurred_at < requiredFailureAt(candidate) ||
    !exactRecord(audit.payload, preparedPayload(candidate, input))
  ) {
    throw new Error("SourceLink Queue recovery prepared audit does not match the request");
  }
}

export function assertFinalizationScope(
  candidate: RecoveryCandidate,
  input: FinalizeSourceLinkQueueDeliveryRecoveryInput,
): void {
  if (
    input.projectId !== candidate.scope.project_id ||
    input.environmentId !== candidate.scope.environment_id ||
    input.billingEpochId !== candidate.scope.billing_epoch_id ||
    input.requestEventId !== candidate.scope.event_id ||
    input.deliveryAttemptId !== candidate.attempt.attempt_id ||
    input.workflowId !== candidate.scope.workflow_id
  ) {
    throw new Error("SourceLink Queue recovery finalization does not match the prepared scope");
  }
}

export function resolveFinalization(
  candidate: RecoveryCandidate,
  workflowOutcome: SourceLinkQueueDeliveryRecoveryWorkflowOutcome,
):
  | Readonly<{
      state: "pending" | "completed";
      kind: "pending" | "success" | "failure" | "reconciliation_required";
      readonly continueProductWorkflowReplay?: true;
      readonly recordQueuedTerminalFailure?:
        | "SOURCE_LINK_WORKFLOW_ERRORED"
        | "SOURCE_LINK_WORKFLOW_TERMINATED";
    }>
  | Readonly<{ state: "uncertain" }> {
  const durable = durableOutcome(candidate);
  if (durable === "inconsistent") {
    throw new Error(
      "SourceLink Queue recovery durable operation, Workflow, and source outcomes conflict",
    );
  }
  if (workflowOutcome === "pending") {
    if (durable !== "queued") return Object.freeze({ state: "uncertain" });
    return Object.freeze({ state: "pending", kind: "pending" as const });
  }
  if (durable === "reconciliation_required") {
    if (workflowOutcome !== "complete") {
      throw new Error("SourceLink Queue recovery Workflow outcome does not match durable outcomes");
    }
    return Object.freeze({
      state: "pending",
      kind: "reconciliation_required" as const,
      continueProductWorkflowReplay: true as const,
    });
  }
  if (durable === "queued") {
    if (workflowOutcome === "errored" || workflowOutcome === "terminated") {
      return Object.freeze({
        state: "completed",
        kind: "failure" as const,
        recordQueuedTerminalFailure:
          workflowOutcome === "errored"
            ? "SOURCE_LINK_WORKFLOW_ERRORED"
            : "SOURCE_LINK_WORKFLOW_TERMINATED",
      });
    }
    return Object.freeze({ state: "uncertain" });
  }
  if (
    (workflowOutcome === "complete" && durable === "succeeded") ||
    ((workflowOutcome === "errored" || workflowOutcome === "terminated") && durable === "failed")
  ) {
    return Object.freeze({
      state: "completed",
      kind: durable === "succeeded" ? ("success" as const) : ("failure" as const),
    });
  }
  throw new Error("SourceLink Queue recovery Workflow outcome does not match durable outcomes");
}

export function durableOutcome(
  candidate: RecoveryCandidate,
): "queued" | "succeeded" | "failed" | "reconciliation_required" | "inconsistent" {
  const { scope, source } = candidate;
  if (
    scope.operation_state === "queued" &&
    scope.operation_failure === null &&
    scope.workflow_state === "queued" &&
    scope.workflow_terminal_evidence === null &&
    scope.workflow_intermediate_evidence === null &&
    scope.workflow_reconciliation_code === null &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
    !hasTerminalSourceState(source)
  ) {
    return "queued";
  }
  if (
    scope.operation_state === "succeeded" &&
    scope.workflow_state === "completed" &&
    isSuccessfulTerminalEvidence(scope.workflow_terminal_evidence, source) &&
    source.exact_ready
  ) {
    return "succeeded";
  }
  if (
    scope.operation_state === "failed" &&
    scope.workflow_state === "completed" &&
    isFailureTerminalEvidence(scope.workflow_terminal_evidence, scope.operation_failure) &&
    !hasTerminalSourceState(source)
  ) {
    return "failed";
  }
  if (
    scope.operation_state === "queued" &&
    scope.operation_failure === null &&
    scope.workflow_state === "reconciliation_required" &&
    scope.workflow_terminal_evidence === null &&
    scope.workflow_reconciliation_code === "PROVIDER_OBSERVATION_UNCERTAIN" &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
    !hasTerminalSourceState(source)
  ) {
    return "reconciliation_required";
  }
  return "inconsistent";
}

export function isSuccessfulTerminalEvidence(value: unknown, source: SourceTerminalState): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "externalRepositoryId")
    return false;
  return (
    typeof value["externalRepositoryId"] === "string" &&
    value["externalRepositoryId"] === source.source_external_repository_id
  );
}

export function isFailureTerminalEvidence(terminalEvidence: unknown, failure: unknown): boolean {
  if (
    !isRecord(terminalEvidence) ||
    Object.keys(terminalEvidence).sort().join(",") !== "errorCode" ||
    typeof terminalEvidence["errorCode"] !== "string" ||
    terminalEvidence["errorCode"].length === 0 ||
    !isRecord(failure)
  ) {
    return false;
  }
  return failure["code"] === terminalEvidence["errorCode"];
}

export function parseFinalEvidence(value: Readonly<Record<string, string>>) {
  const workflowId = requiredPayloadString(value, "workflowId");
  const workflowOutcome = value["workflowOutcome"];
  const operationState = value["operationStateAtRecovery"];
  const workflowState = value["workflowStateAtRecovery"];
  const sourceState = value["sourceStateAtRecovery"];
  const reconciliationCode = requiredPayloadString(value, "reconciliationCodeAtRecovery");
  const reconciliationRequiredAt = requiredPayloadString(value, "reconciliationRequiredAt");
  const reconciliationRequiredTimestamp = new Date(reconciliationRequiredAt);
  const state = value["state"];
  if (
    value["outcomeCode"] !== "WORKFLOW_ENSURED" ||
    !isWorkflowOutcome(workflowOutcome) ||
    !isOperationState(operationState) ||
    !isWorkflowState(workflowState) ||
    (sourceState !== "pending" &&
      sourceState !== "success" &&
      sourceState !== "failure" &&
      sourceState !== "reconciliation_required") ||
    (sourceState === "reconciliation_required"
      ? reconciliationCode !== "PROVIDER_OBSERVATION_UNCERTAIN"
      : reconciliationCode !== "none") ||
    (state !== "pending" && state !== "completed") ||
    !isUlidString(value["reconciliationId"]) ||
    !isUlidString(value["requestEventId"]) ||
    !isUlidString(value["deliveryAttemptId"]) ||
    !isUlidString(value["environmentId"]) ||
    !isUlidString(value["billingEpochId"]) ||
    !isUlidString(value["sourceConnectionId"]) ||
    !isUlidString(value["grantId"]) ||
    !isUlidString(value["sourceId"]) ||
    !isUlidString(value["finalAuditEventId"]) ||
    !isUlidString(value["preparedAuditEventId"]) ||
    !isDigest(value["idempotencySha256"]) ||
    !isDigest(value["deliveryHistorySha256"]) ||
    !isValidTimestamp(reconciliationRequiredTimestamp) ||
    reconciliationRequiredTimestamp.toISOString() !== reconciliationRequiredAt
  ) {
    throw new Error("SourceLink Queue recovery final audit payload is invalid");
  }
  const expectedState = storedFinalState(
    workflowOutcome,
    operationState,
    workflowState,
    sourceState,
  );
  if (state !== expectedState) {
    throw new Error("SourceLink Queue recovery final audit state is invalid");
  }
  return Object.freeze({
    reconciliationId: parseUlid(value["reconciliationId"]),
    requestEventId: parseUlid(value["requestEventId"]),
    deliveryAttemptId: parseUlid(value["deliveryAttemptId"]),
    workflowId,
    environmentId: parseUlid(value["environmentId"]),
    billingEpochId: parseUlid(value["billingEpochId"]),
    sourceConnectionId: parseUlid(value["sourceConnectionId"]),
    grantId: parseUlid(value["grantId"]),
    sourceId: parseUlid(value["sourceId"]),
    finalAuditEventId: parseUlid(value["finalAuditEventId"]),
    preparedAuditEventId: parseUlid(value["preparedAuditEventId"]),
    idempotencySha256: value["idempotencySha256"] as `sha256:${string}`,
    deliveryHistorySha256: value["deliveryHistorySha256"] as `sha256:${string}`,
    reconciliationRequiredAt,
    workflowOutcome,
    operationState,
    workflowState,
    sourceState,
    reconciliationCode,
    state,
  });
}

export function storedFinalState(
  workflowOutcome: SourceLinkQueueDeliveryRecoveryWorkflowOutcome,
  operationState: SourceLinkOperationState,
  workflowState: SourceLinkRunState,
  sourceState: "pending" | "success" | "failure" | "reconciliation_required",
): "pending" | "completed" {
  if (sourceState === "pending") {
    if (
      workflowOutcome === "pending" &&
      operationState === "queued" &&
      workflowState === "queued"
    ) {
      return "pending";
    }
    throw new Error("SourceLink Queue recovery final audit state is invalid");
  }
  if (sourceState === "success") {
    if (
      workflowOutcome === "complete" &&
      operationState === "succeeded" &&
      workflowState === "completed"
    ) {
      return "completed";
    }
    throw new Error("SourceLink Queue recovery final audit state is invalid");
  }
  if (sourceState === "reconciliation_required") {
    if (
      workflowOutcome === "complete" &&
      operationState === "queued" &&
      workflowState === "reconciliation_required"
    ) {
      return "pending";
    }
    throw new Error("SourceLink Queue recovery final audit state is invalid");
  }
  if (
    (workflowOutcome === "errored" || workflowOutcome === "terminated") &&
    operationState === "failed" &&
    workflowState === "completed"
  ) {
    return "completed";
  }
  throw new Error("SourceLink Queue recovery final audit state is invalid");
}

export function assertFinalEvidence(
  finalAudit: RecoveryAuditRow,
  preparedAudit: RecoveryAuditRow,
  candidate: RecoveryCandidate,
  input: SourceLinkQueueDeliveryRecoveryIdentityInput,
  evidence: ReturnType<typeof parseFinalEvidence>,
  workflowReplay: SourceLinkWorkflowReplayContinuation | null,
): void {
  const current = durableOutcome(candidate);
  if (
    !isScopeIdentity(candidate) ||
    !isClosedFinalDelivery(candidate.event, candidate.attempt) ||
    finalAudit.project_id !== candidate.scope.project_id ||
    finalAudit.operation_id !== candidate.scope.operation_id ||
    finalAudit.billing_epoch_id !== candidate.scope.billing_epoch_id ||
    finalAudit.event_type !== SOURCE_LINK_QUEUE_DELIVERY_RECOVERED ||
    finalAudit.actor_type !== "principal" ||
    finalAudit.actor_id !== input.actorId ||
    preparedAudit.audit_event_id !== evidence.preparedAuditEventId ||
    preparedAudit.project_id !== candidate.scope.project_id ||
    preparedAudit.operation_id !== candidate.scope.operation_id ||
    preparedAudit.billing_epoch_id !== candidate.scope.billing_epoch_id ||
    preparedAudit.event_type !== SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED ||
    preparedAudit.actor_type !== "principal" ||
    preparedAudit.actor_id !== input.actorId ||
    !isValidTimestamp(finalAudit.occurred_at) ||
    !isValidTimestamp(preparedAudit.occurred_at) ||
    preparedAudit.occurred_at > finalAudit.occurred_at ||
    preparedAudit.occurred_at < requiredFailureAt(candidate) ||
    finalAudit.occurred_at < requiredFailureAt(candidate) ||
    finalAudit.occurred_at.toISOString() !== candidate.event.acknowledged_at?.toISOString() ||
    candidate.attempt.acknowledged_at !== null ||
    !exactRecord(preparedAudit.payload, preparedPayloadForEvidence(evidence, input)) ||
    !exactRecord(finalAudit.payload, finalPayloadForEvidence(evidence, input)) ||
    evidence.workflowId !== candidate.scope.workflow_id ||
    evidence.environmentId !== candidate.scope.environment_id ||
    evidence.billingEpochId !== candidate.scope.billing_epoch_id ||
    evidence.sourceConnectionId !== candidate.scope.operation_id ||
    evidence.grantId !== candidate.scope.operation_id ||
    evidence.sourceId !== candidate.scope.operation_id ||
    evidence.deliveryHistorySha256 !== candidate.deliveryHistory.sha256 ||
    evidence.reconciliationRequiredAt !== requiredFailureAt(candidate).toISOString() ||
    !isAllowedClosedFinalState(evidence, current, workflowReplay)
  ) {
    throw new Error("SourceLink Queue recovery final audit evidence is invalid");
  }
}

export function isAllowedClosedFinalState(
  evidence: ReturnType<typeof parseFinalEvidence>,
  current: ReturnType<typeof durableOutcome>,
  workflowReplay: SourceLinkWorkflowReplayContinuation | null,
): boolean {
  if (isMonotoneFinalState(evidence, current)) return true;
  if (!isReplayContinuationEligibleEvidence(evidence) || workflowReplay === null) return false;
  if (workflowReplay.kind === "active") return current === "inconsistent";
  return (
    evidence.sourceState === "reconciliation_required" &&
    workflowReplay.hasTerminalFailure &&
    current === "queued"
  );
}

export function productWorkflowReplayRouting(
  candidate: RecoveryCandidate,
  evidence: ReturnType<typeof parseFinalEvidence>,
  workflowReplay: SourceLinkWorkflowReplayContinuation | null,
): ProductWorkflowReplayRouting {
  const { scope } = candidate;
  if (isQueuedOrReconciliationSourceLinkScope(candidate) && candidate.hasProviderClaim) {
    return Object.freeze({
      continueOriginalKey: false,
      continueWithNewKey: false,
      readableReplayAttemptIds: Object.freeze([]),
      completedReplayAttemptIds:
        workflowReplay === null
          ? Object.freeze([])
          : workflowReplay.kind === "terminal"
            ? workflowReplay.replayAttemptIds
            : workflowReplay.completedReplayAttemptIds,
    });
  }
  if (isReplayContinuationEligibleEvidence(evidence) && workflowReplay !== null) {
    const latestReplayAttemptId = workflowReplay.replayAttemptIds.at(-1);
    if (latestReplayAttemptId === undefined) {
      throw new Error("SourceLink Queue recovery Workflow replay chain is empty");
    }
    return Object.freeze({
      continueOriginalKey: true,
      continueWithNewKey:
        workflowReplay.kind === "terminal" &&
        workflowReplay.isTerminalRetryable &&
        workflowReplay.replayAttemptIds.length < 5,
      readableReplayAttemptIds: Object.freeze([latestReplayAttemptId]),
      completedReplayAttemptIds: workflowReplay.completedReplayAttemptIds,
    });
  }
  const noTerminalSource = !hasTerminalSourceState(candidate.source);
  const pendingContinuation =
    evidence.sourceState === "pending" &&
    scope.operation_state === "queued" &&
    scope.operation_failure === null &&
    scope.workflow_terminal_evidence === null &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
    noTerminalSource &&
    (scope.workflow_state === "queued" ||
      (scope.workflow_state === "reconciliation_required" &&
        scope.workflow_reconciliation_code === "PROVIDER_OBSERVATION_UNCERTAIN"));
  if (pendingContinuation) {
    return Object.freeze({
      continueOriginalKey: true,
      continueWithNewKey: false,
      readableReplayAttemptIds: Object.freeze([]),
      completedReplayAttemptIds: Object.freeze([]),
    });
  }
  if (
    evidence.sourceState === "reconciliation_required" &&
    durableOutcome(candidate) === "reconciliation_required"
  ) {
    return Object.freeze({
      continueOriginalKey: true,
      continueWithNewKey: false,
      readableReplayAttemptIds: Object.freeze([]),
      completedReplayAttemptIds: Object.freeze([]),
    });
  }
  return Object.freeze({
    continueOriginalKey: false,
    continueWithNewKey: false,
    readableReplayAttemptIds: Object.freeze([]),
    completedReplayAttemptIds: Object.freeze([]),
  });
}

export function isReplayContinuationEligibleEvidence(
  evidence: ReturnType<typeof parseFinalEvidence>,
): boolean {
  return evidence.sourceState === "pending" || evidence.sourceState === "reconciliation_required";
}

export function isQueuedOrReconciliationSourceLinkScope(candidate: RecoveryCandidate): boolean {
  return (
    candidate.scope.operation_state === "queued" &&
    (candidate.scope.workflow_state === "queued" ||
      candidate.scope.workflow_state === "reconciliation_required")
  );
}

export function preparedPayloadForEvidence(
  evidence: ReturnType<typeof parseFinalEvidence>,
  input: SourceLinkQueueDeliveryRecoveryIdentityInput,
) {
  return {
    reconciliationId: input.reconciliationId,
    requestEventId: evidence.requestEventId,
    deliveryAttemptId: evidence.deliveryAttemptId,
    workflowId: evidence.workflowId,
    environmentId: evidence.environmentId,
    billingEpochId: evidence.billingEpochId,
    sourceConnectionId: evidence.sourceConnectionId,
    grantId: evidence.grantId,
    sourceId: evidence.sourceId,
    deliveryHistorySha256: evidence.deliveryHistorySha256,
    reconciliationRequiredAt: evidence.reconciliationRequiredAt,
    finalAuditEventId: input.finalAuditEventId,
    idempotencySha256: input.idempotencySha256,
  } as const;
}

export function finalPayloadForEvidence(
  evidence: ReturnType<typeof parseFinalEvidence>,
  input: SourceLinkQueueDeliveryRecoveryIdentityInput,
) {
  return {
    ...preparedPayloadForEvidence(evidence, input),
    preparedAuditEventId: input.preparedAuditEventId,
    outcomeCode: "WORKFLOW_ENSURED",
    workflowOutcome: evidence.workflowOutcome,
    operationStateAtRecovery: evidence.operationState,
    workflowStateAtRecovery: evidence.workflowState,
    sourceStateAtRecovery: evidence.sourceState,
    reconciliationCodeAtRecovery: evidence.reconciliationCode,
    state: evidence.state,
  } as const;
}

export function isMonotoneFinalState(
  evidence: ReturnType<typeof parseFinalEvidence>,
  current: ReturnType<typeof durableOutcome>,
): boolean {
  if (current === "inconsistent") return false;
  if (evidence.sourceState === "pending") {
    return (
      current === "queued" ||
      current === "reconciliation_required" ||
      current === "succeeded" ||
      current === "failed"
    );
  }
  if (evidence.sourceState === "success") return current === "succeeded";
  if (evidence.sourceState === "reconciliation_required") {
    return current === "reconciliation_required" || current === "succeeded" || current === "failed";
  }
  return current === "failed";
}

export function requiredFailureAt(candidate: RecoveryCandidate): Date {
  const failedAt = candidate.attempt.failed_at;
  if (failedAt === null || !isValidTimestamp(failedAt)) {
    throw new Error("SourceLink Queue recovery final delivery failure is unavailable");
  }
  return failedAt;
}

export function requiredOpenReconciliationTimestamp(candidate: RecoveryCandidate): string {
  const reconciliationRequiredAt = candidate.event.reconciliation_required_at;
  const failedAt = requiredFailureAt(candidate);
  if (
    reconciliationRequiredAt === null ||
    !isValidTimestamp(reconciliationRequiredAt) ||
    reconciliationRequiredAt.toISOString() !== failedAt.toISOString()
  ) {
    throw new Error("SourceLink Queue recovery final delivery reconciliation timestamp is invalid");
  }
  return reconciliationRequiredAt.toISOString();
}

export function assertPreparationInput(input: PrepareSourceLinkQueueDeliveryRecoveryInput): void {
  assertIdentityInput(input);
  parseTimestamp(input.preparedAt, "SourceLink Queue recovery preparation time");
}

export function assertFinalizationInput(input: FinalizeSourceLinkQueueDeliveryRecoveryInput): void {
  assertIdentityInput(input);
  for (const id of [
    input.projectId,
    input.environmentId,
    input.billingEpochId,
    input.requestEventId,
    input.deliveryAttemptId,
  ]) {
    parseUlid(id);
  }
  if (
    input.workflowId !== sourceLinkWorkflowId(input.requestEventId, input.operationId) ||
    !isWorkflowOutcome(input.workflowOutcome)
  ) {
    throw new TypeError("SourceLink Queue recovery finalization is invalid");
  }
  parseTimestamp(input.recoveredAt, "SourceLink Queue recovery completion time");
}

export function assertIdentityInput(input: SourceLinkQueueDeliveryRecoveryIdentityInput): void {
  for (const id of [
    input.organizationId,
    input.operationId,
    input.reconciliationId,
    input.preparedAuditEventId,
    input.finalAuditEventId,
  ]) {
    parseUlid(id);
  }
  if (input.preparedAuditEventId === input.finalAuditEventId) {
    throw new TypeError("SourceLink Queue recovery audit IDs must differ");
  }
  if (
    input.reconciliationId === input.preparedAuditEventId ||
    input.reconciliationId === input.finalAuditEventId
  ) {
    throw new TypeError("SourceLink Queue recovery reconciliation and audit IDs must differ");
  }
  if (!isPrincipal(input.actorId)) {
    throw new TypeError("SourceLink Queue recovery actor is invalid");
  }
  if (!isDigest(input.idempotencySha256)) {
    throw new TypeError("SourceLink Queue recovery idempotency digest is invalid");
  }
}

export function sourceLinkWorkflowId(eventId: string, operationId: string): string {
  return `product-command-v1-source-link-${eventId}-${operationId}`;
}

export function requirePayload(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new Error("SourceLink Queue recovery audit payload is invalid");
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    Object.values(value).some((field) => typeof field !== "string")
  ) {
    throw new Error("SourceLink Queue recovery audit payload is invalid");
  }
  return value as Readonly<Record<string, string>>;
}

export function requiredPayloadString(
  value: Readonly<Record<string, string>>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error("SourceLink Queue recovery final audit payload is invalid");
  }
  return field;
}

export function exactRecord(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => value[key] === expected[key])
  );
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function parseTimestamp(value: string, label: string): Date {
  const timestamp = new Date(value);
  if (!isValidTimestamp(timestamp) || timestamp.toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO 8601 UTC`);
  }
  return timestamp;
}

export function isValidTimestamp(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

export function isWorkflowOutcome(
  value: unknown,
): value is SourceLinkQueueDeliveryRecoveryWorkflowOutcome {
  return (
    value === "pending" || value === "complete" || value === "errored" || value === "terminated"
  );
}

export function isOperationState(value: unknown): value is SourceLinkOperationState {
  return value === "queued" || value === "succeeded" || value === "failed";
}

export function isWorkflowState(value: unknown): value is SourceLinkRunState {
  return value === "queued" || value === "completed" || value === "reconciliation_required";
}

export function isPrincipal(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("user:") &&
    value.trim() === value &&
    value.length >= 6 &&
    value.length <= 255 &&
    !/\s/u.test(value)
  );
}

export function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function isUlidString(value: unknown): value is Ulid {
  if (typeof value !== "string") return false;
  try {
    parseUlid(value);
    return true;
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
