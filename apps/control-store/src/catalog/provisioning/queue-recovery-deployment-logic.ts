// Literal original deployment-queue-delivery-recovery.ts contracts and pure decisions.
import { parseUlid, type Ulid } from "@ohmyhost/platform";

interface QueryResultRow {
  [column: string]: unknown;
}
export const DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED =
  "DeploymentQueueDeliveryRecoveryPrepared" as const;

export const DEPLOYMENT_QUEUE_DELIVERY_RECOVERED = "DeploymentQueueDeliveryRecovered" as const;

export const FINAL_ATTEMPT_LEASE_EXPIRED = "FINAL_ATTEMPT_LEASE_EXPIRED" as const;
/** The closed set of codes that end a Queue delivery after its fifth attempt; the event and its final attempt carry the same one. */
export const FINAL_DELIVERY_CODES = [
  FINAL_ATTEMPT_LEASE_EXPIRED,
  "PRODUCT_COMMAND_QUEUE_SEND_UNCERTAIN",
] as const;
export const isFinalDeliveryCode = (code: string | null): boolean =>
  code !== null && (FINAL_DELIVERY_CODES as readonly string[]).includes(code);

export type DeploymentRecoveryOperationState = "queued" | "running" | "succeeded" | "failed";

export type DeploymentRecoveryRunState = "queued" | "completed" | "reconciliation_required";

export type DeploymentRecoveryDeploymentState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "reconciliation_required";

export type RecoverySnapshot = "queued" | "provider_reconciliation" | "succeeded" | "failed";

export type DeploymentQueueDeliveryRecoveryEventType =
  | "DeploymentRequestedV1"
  | "DeploymentRollbackRequestedV1"
  | "DeploymentPromotionRequestedV1";

export type DeploymentQueueDeliveryRecoveryWorkflowOutcome =
  | "pending"
  | "complete"
  | "errored"
  | "terminated";

export interface DeploymentQueueDeliveryRecoveryIdentityInput {
  readonly organizationId: Ulid;
  readonly operationId: Ulid;
  readonly reconciliationId: Ulid;
  readonly preparedAuditEventId: Ulid;
  readonly finalAuditEventId: Ulid;
  readonly actorId: string;
  readonly idempotencySha256: `sha256:${string}`;
}

export interface PrepareDeploymentQueueDeliveryRecoveryInput
  extends DeploymentQueueDeliveryRecoveryIdentityInput {
  readonly preparedAt: string;
}

export interface FinalizeDeploymentQueueDeliveryRecoveryInput
  extends DeploymentQueueDeliveryRecoveryIdentityInput {
  readonly eventType: DeploymentQueueDeliveryRecoveryEventType;
  readonly projectId: Ulid;
  readonly environmentId: Ulid;
  readonly billingEpochId: Ulid;
  readonly requestEventId: Ulid;
  readonly deliveryAttemptId: Ulid;
  readonly planId: Ulid | null;
  readonly deploymentId: Ulid;
  readonly workflowId: string;
  readonly recoveredAt: string;
  readonly workflowOutcome: DeploymentQueueDeliveryRecoveryWorkflowOutcome;
}

export interface DeploymentQueueDeliveryRecoveryMessageBase {
  readonly version: 1;
  readonly eventId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly billingEpochId: Ulid;
  readonly environmentId: Ulid;
  readonly operationId: Ulid;
}

export type DeploymentQueueDeliveryRecoveryMessage =
  | (DeploymentQueueDeliveryRecoveryMessageBase & {
      readonly eventType: "DeploymentRequestedV1";
      readonly planId: Ulid;
    })
  | (DeploymentQueueDeliveryRecoveryMessageBase & {
      readonly eventType: "DeploymentRollbackRequestedV1" | "DeploymentPromotionRequestedV1";
    });

export type DeploymentQueueDeliveryRecoveryPreparation =
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
      planId: Ulid | null;
      deploymentId: Ulid;
      workflowId: string;
      originalMessage: DeploymentQueueDeliveryRecoveryMessage;
    }>
  | Readonly<{
      outcome: "recovered";
      reconciliationId: Ulid;
      operationId: Ulid;
      state: "pending" | "completed";
      readonly continueProviderReconciliation?: true;
    }>;

export type FinalizeDeploymentQueueDeliveryRecoveryResult = Readonly<{
  outcome: "recovered" | "duplicate" | "uncertain";
  reconciliationId: Ulid;
  operationId: Ulid;
  state: "pending" | "completed" | "uncertain";
  readonly continueProviderReconciliation?: true;
}>;

export interface RecoveryScopeRow extends QueryResultRow {
  organization_id: string;
  project_id: string;
  environment_id: string;
  operation_id: string;
  billing_epoch_id: string;
  event_id: string;
  event_type: string;
  plan_id: string | null;
  deployment_id: string;
  workflow_id: string;
  operation_state: string;
  workflow_state: string;
  workflow_terminal_evidence: unknown;
  workflow_intermediate_evidence: unknown;
  workflow_reconciliation_code: string | null;
  active_reconciliation_attempt_id: string | null;
  active_replay_attempt_id: string | null;
  deployment_state: string;
  deployment_active_revision_id: string | null;
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

export interface RecoveryCandidate {
  readonly scope: RecoveryScopeRow;
  readonly event: RecoveryOutboxRow;
  readonly attempt: RecoveryAttemptRow;
  readonly hasProviderClaim: boolean;
  readonly providerClaimMatchesScope: boolean;
  readonly hasProviderEvidence: boolean;
}

export function isInitialRecoveryCandidate(candidate: RecoveryCandidate): boolean {
  const { scope, event, attempt } = candidate;
  return (
    isScopeIdentity(scope, event) &&
    scope.operation_state === "queued" &&
    scope.workflow_state === "queued" &&
    scope.deployment_state === "queued" &&
    scope.workflow_terminal_evidence === null &&
    scope.workflow_intermediate_evidence === null &&
    scope.workflow_reconciliation_code === null &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
    scope.deployment_active_revision_id === null &&
    scope.ownership_state === "active" &&
    scope.lifecycle_state === "active" &&
    !candidate.hasProviderClaim &&
    !candidate.hasProviderEvidence &&
    isOpenFinalDelivery(event, attempt)
  );
}

export function isProviderContinuationRecoveryCandidate(candidate: RecoveryCandidate): boolean {
  return (
    isRecoveryScope(candidate) &&
    durableOutcome(candidate.scope) === "provider_reconciliation" &&
    candidate.hasProviderClaim &&
    candidate.providerClaimMatchesScope
  );
}

export function isRecoveryScope(candidate: RecoveryCandidate): boolean {
  const { scope, event, attempt } = candidate;
  return (
    isScopeIdentity(scope, event) &&
    isOperationState(scope.operation_state) &&
    isWorkflowState(scope.workflow_state) &&
    isDeploymentState(scope.deployment_state) &&
    (scope.deployment_state !== "running" ||
      (candidate.hasProviderClaim && candidate.providerClaimMatchesScope)) &&
    scope.ownership_state === "active" &&
    scope.lifecycle_state === "active" &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
    isOpenFinalDelivery(event, attempt)
  );
}

export function isOpenRecoveryDelivery(candidate: RecoveryCandidate): boolean {
  return isOpenFinalDelivery(candidate.event, candidate.attempt);
}

export function isUnacknowledgedReconciliationSignal(event: RecoveryOutboxRow): boolean {
  return event.acknowledged_at === null && event.reconciliation_required_at !== null;
}

export function isFinalRecoveryScope(candidate: RecoveryCandidate): boolean {
  const { scope, event, attempt } = candidate;
  return (
    isScopeIdentity(scope, event) &&
    isOperationState(scope.operation_state) &&
    isWorkflowState(scope.workflow_state) &&
    isDeploymentState(scope.deployment_state) &&
    (scope.deployment_state !== "running" ||
      (candidate.hasProviderClaim && candidate.providerClaimMatchesScope)) &&
    scope.ownership_state === "active" &&
    scope.lifecycle_state === "active" &&
    scope.active_reconciliation_attempt_id === null &&
    scope.active_replay_attempt_id === null &&
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
    attempt.attempt_number === 5 &&
    attempt.status === "reconciliation_required" &&
    attempt.error_code === event.last_error_code &&
    attempt.failed_at !== null &&
    attempt.next_available_at === null &&
    attempt.acknowledged_at === null
  );
}

export function isScopeIdentity(scope: RecoveryScopeRow, event: RecoveryOutboxRow): boolean {
  return (
    scope.organization_id === event.organization_id &&
    scope.project_id === event.project_id &&
    scope.operation_id === event.operation_id &&
    scope.billing_epoch_id === event.billing_epoch_id &&
    scope.event_id === event.event_id &&
    parseIdentity(scope.environment_id) &&
    ((scope.event_type === "DeploymentRequestedV1" &&
      scope.plan_id !== null &&
      parseIdentity(scope.plan_id)) ||
      (scope.event_type !== "DeploymentRequestedV1" && scope.plan_id === null)) &&
    parseIdentity(scope.deployment_id) &&
    isDeploymentQueueDeliveryRecoveryEventType(scope.event_type) &&
    scope.workflow_id ===
      productCommandWorkflowId(scope.event_type, scope.event_id, scope.operation_id) &&
    event.event_type === scope.event_type &&
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
    event.claimed_at === null &&
    event.lease_expires_at === null &&
    attempt.attempt_id === event.current_attempt_id &&
    attempt.event_id === event.event_id &&
    attempt.attempt_number === 5 &&
    attempt.status === "reconciliation_required" &&
    attempt.error_code === event.last_error_code &&
    attempt.failed_at !== null &&
    attempt.next_available_at === null &&
    attempt.acknowledged_at === null
  );
}

export function preparedRecovery(
  candidate: RecoveryCandidate,
  input: PrepareDeploymentQueueDeliveryRecoveryInput,
): Extract<DeploymentQueueDeliveryRecoveryPreparation, { outcome: "prepared" }> {
  const message = originalMessage(candidate);
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
    planId: candidate.scope.plan_id === null ? null : parseUlid(candidate.scope.plan_id),
    deploymentId: parseUlid(candidate.scope.deployment_id),
    workflowId: candidate.scope.workflow_id,
    originalMessage: message,
  });
}

export function originalMessage(
  candidate: RecoveryCandidate,
): DeploymentQueueDeliveryRecoveryMessage {
  const common = {
    version: 1,
    eventId: parseUlid(candidate.scope.event_id),
    organizationId: parseUlid(candidate.scope.organization_id),
    projectId: parseUlid(candidate.scope.project_id),
    billingEpochId: parseUlid(candidate.scope.billing_epoch_id),
    environmentId: parseUlid(candidate.scope.environment_id),
    operationId: parseUlid(candidate.scope.operation_id),
  } as const;
  if (candidate.scope.event_type === "DeploymentRequestedV1") {
    if (candidate.scope.plan_id === null) {
      throw new Error("Deployment Queue recovery plan is unavailable");
    }
    return Object.freeze({
      ...common,
      eventType: "DeploymentRequestedV1" as const,
      planId: parseUlid(candidate.scope.plan_id),
    });
  }
  if (
    candidate.scope.event_type !== "DeploymentRollbackRequestedV1" &&
    candidate.scope.event_type !== "DeploymentPromotionRequestedV1"
  ) {
    throw new Error("Deployment Queue recovery event is unsupported");
  }
  return Object.freeze({ ...common, eventType: candidate.scope.event_type });
}

export function preparedPayload(
  candidate: RecoveryCandidate,
  input: Pick<
    DeploymentQueueDeliveryRecoveryIdentityInput,
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
    planId: candidate.scope.plan_id ?? "",
    deploymentId: candidate.scope.deployment_id,
    finalAuditEventId: input.finalAuditEventId,
    idempotencySha256: input.idempotencySha256,
  } as const;
}

export function finalPayload(
  candidate: RecoveryCandidate,
  input: Pick<
    FinalizeDeploymentQueueDeliveryRecoveryInput,
    | "reconciliationId"
    | "preparedAuditEventId"
    | "finalAuditEventId"
    | "idempotencySha256"
    | "workflowOutcome"
  >,
  state: "pending" | "completed",
) {
  return {
    ...preparedPayload(candidate, input),
    preparedAuditEventId: input.preparedAuditEventId,
    outcomeCode: "WORKFLOW_ENSURED",
    workflowOutcome: input.workflowOutcome,
    operationStateAtRecovery: candidate.scope.operation_state,
    workflowStateAtRecovery: candidate.scope.workflow_state,
    deploymentStateAtRecovery: candidate.scope.deployment_state,
    state,
  } as const;
}

export function assertPreparedAudit(
  audit: RecoveryAuditRow,
  candidate: RecoveryCandidate,
  input: DeploymentQueueDeliveryRecoveryIdentityInput,
): void {
  if (
    audit.audit_event_id !== input.preparedAuditEventId ||
    audit.project_id !== candidate.scope.project_id ||
    audit.operation_id !== candidate.scope.operation_id ||
    audit.billing_epoch_id !== candidate.scope.billing_epoch_id ||
    audit.event_type !== DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED ||
    audit.actor_type !== "principal" ||
    audit.actor_id !== input.actorId ||
    !isValidTimestamp(audit.occurred_at) ||
    audit.occurred_at < requiredFailureAt(candidate) ||
    !exactRecord(audit.payload, preparedPayload(candidate, input))
  ) {
    throw new Error("Deployment Queue recovery prepared audit does not match the request");
  }
}

export function assertFinalizationScope(
  candidate: RecoveryCandidate,
  input: FinalizeDeploymentQueueDeliveryRecoveryInput,
): void {
  if (
    input.projectId !== candidate.scope.project_id ||
    input.environmentId !== candidate.scope.environment_id ||
    input.billingEpochId !== candidate.scope.billing_epoch_id ||
    input.requestEventId !== candidate.scope.event_id ||
    input.deliveryAttemptId !== candidate.attempt.attempt_id ||
    input.eventType !== candidate.scope.event_type ||
    input.planId !== candidate.scope.plan_id ||
    input.deploymentId !== candidate.scope.deployment_id ||
    input.workflowId !== candidate.scope.workflow_id
  ) {
    throw new Error("Deployment Queue recovery finalization does not match the prepared scope");
  }
}

export function resolveFinalization(
  candidate: RecoveryCandidate,
  workflowOutcome: DeploymentQueueDeliveryRecoveryWorkflowOutcome,
):
  | Readonly<{
      state: "pending" | "completed";
      operationState: DeploymentRecoveryOperationState;
      workflowState: DeploymentRecoveryRunState;
      deploymentState: DeploymentRecoveryDeploymentState;
      readonly continueProviderReconciliation?: true;
    }>
  | Readonly<{ state: "uncertain" }> {
  const state = durableOutcome(candidate.scope);
  if (state === "inconsistent") {
    throw new Error(
      "Deployment Queue recovery durable operation, Workflow, and deployment outcomes conflict",
    );
  }
  if (state === "provider_reconciliation") {
    if (
      workflowOutcome !== "complete" ||
      !candidate.hasProviderClaim ||
      !candidate.providerClaimMatchesScope
    ) {
      return Object.freeze({ state: "uncertain" });
    }
    return Object.freeze({
      state: "pending",
      operationState: "queued",
      workflowState: "reconciliation_required",
      deploymentState: "reconciliation_required",
      continueProviderReconciliation: true as const,
    });
  }
  if (workflowOutcome === "pending") {
    if (state !== "queued" || candidate.hasProviderClaim) {
      return Object.freeze({ state: "uncertain" });
    }
    return Object.freeze({
      state: "pending",
      operationState: candidate.scope.operation_state as DeploymentRecoveryOperationState,
      workflowState: candidate.scope.workflow_state as DeploymentRecoveryRunState,
      deploymentState: candidate.scope.deployment_state as DeploymentRecoveryDeploymentState,
    });
  }
  if (candidate.hasProviderClaim) return Object.freeze({ state: "uncertain" });
  if (state === "queued") return Object.freeze({ state: "uncertain" });
  if (
    (workflowOutcome === "complete" && state === "succeeded") ||
    ((workflowOutcome === "errored" || workflowOutcome === "terminated") && state === "failed")
  ) {
    return Object.freeze({
      state: "completed",
      operationState: candidate.scope.operation_state as DeploymentRecoveryOperationState,
      workflowState: candidate.scope.workflow_state as DeploymentRecoveryRunState,
      deploymentState: candidate.scope.deployment_state as DeploymentRecoveryDeploymentState,
    });
  }
  throw new Error("Deployment Queue recovery Workflow outcome does not match durable outcomes");
}

export function durableOutcome(
  scope: RecoveryScopeRow,
):
  | "queued"
  | "succeeded"
  | "failed"
  | "provider_running"
  | "provider_reconciliation"
  | "inconsistent" {
  if (
    scope.operation_state === "queued" &&
    scope.workflow_state === "queued" &&
    scope.deployment_state === "queued"
  ) {
    return "queued";
  }
  if (
    ["queued", "running"].includes(scope.operation_state) &&
    scope.workflow_state === "queued" &&
    scope.deployment_state === "running"
  ) {
    return "provider_running";
  }
  if (
    scope.operation_state === "succeeded" &&
    scope.workflow_state === "completed" &&
    scope.deployment_state === "succeeded"
  ) {
    return "succeeded";
  }
  if (
    scope.operation_state === "failed" &&
    scope.workflow_state === "completed" &&
    scope.deployment_state === "failed"
  ) {
    return "failed";
  }
  if (
    ["queued", "running"].includes(scope.operation_state) &&
    scope.workflow_state === "reconciliation_required" &&
    scope.deployment_state === "reconciliation_required" &&
    scope.workflow_reconciliation_code !== null
  ) {
    return "provider_reconciliation";
  }
  return "inconsistent";
}

export const preparedPayloadKeys = [
  "reconciliationId",
  "requestEventId",
  "deliveryAttemptId",
  "workflowId",
  "environmentId",
  "billingEpochId",
  "planId",
  "deploymentId",
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
  "deploymentStateAtRecovery",
  "state",
] as const;

export function parseFinalEvidence(value: Readonly<Record<string, string>>) {
  const workflowId = requiredPayloadString(value, "workflowId");
  const workflowOutcome = requiredPayloadString(value, "workflowOutcome");
  const operationState = requiredPayloadString(value, "operationStateAtRecovery");
  const workflowState = requiredPayloadString(value, "workflowStateAtRecovery");
  const deploymentState = requiredPayloadString(value, "deploymentStateAtRecovery");
  const state = requiredPayloadString(value, "state");
  const snapshot = recoverySnapshot(operationState, workflowState, deploymentState);
  if (
    value["outcomeCode"] !== "WORKFLOW_ENSURED" ||
    !isWorkflowOutcome(workflowOutcome) ||
    snapshot === null ||
    (state !== "pending" && state !== "completed") ||
    !isUlidString(value["reconciliationId"]) ||
    !isUlidString(value["requestEventId"]) ||
    !isUlidString(value["deliveryAttemptId"]) ||
    !isUlidString(value["environmentId"]) ||
    !isUlidString(value["billingEpochId"]) ||
    !(value["planId"] === "" || isUlidString(value["planId"])) ||
    !isUlidString(value["deploymentId"]) ||
    !isUlidString(value["finalAuditEventId"]) ||
    !isUlidString(value["preparedAuditEventId"]) ||
    !isDigest(value["idempotencySha256"])
  ) {
    throw new Error("Deployment Queue recovery final audit payload is invalid");
  }
  const initialResolution = resolveStoredFinalization(workflowOutcome, snapshot);
  if (state !== initialResolution) {
    throw new Error("Deployment Queue recovery final audit state is invalid");
  }
  return Object.freeze({
    reconciliationId: parseUlid(value["reconciliationId"]),
    requestEventId: parseUlid(value["requestEventId"]),
    deliveryAttemptId: parseUlid(value["deliveryAttemptId"]),
    workflowId,
    environmentId: parseUlid(value["environmentId"]),
    billingEpochId: parseUlid(value["billingEpochId"]),
    planId: value["planId"] === "" ? null : parseUlid(value["planId"]),
    deploymentId: parseUlid(value["deploymentId"]),
    finalAuditEventId: parseUlid(value["finalAuditEventId"]),
    preparedAuditEventId: parseUlid(value["preparedAuditEventId"]),
    idempotencySha256: value["idempotencySha256"] as `sha256:${string}`,
    workflowOutcome,
    operationState,
    workflowState,
    deploymentState,
    state,
    ...(snapshot === "provider_reconciliation"
      ? { continueProviderReconciliation: true as const }
      : {}),
  });
}

export function resolveStoredFinalization(
  workflowOutcome: DeploymentQueueDeliveryRecoveryWorkflowOutcome,
  snapshot: RecoverySnapshot,
): "pending" | "completed" {
  if (snapshot === "queued") {
    if (workflowOutcome !== "pending") {
      throw new Error("Deployment Queue recovery final audit state is invalid");
    }
    return "pending";
  }
  if (snapshot === "provider_reconciliation") {
    if (workflowOutcome !== "complete") {
      throw new Error("Deployment Queue recovery final audit state is invalid");
    }
    return "pending";
  }
  if (snapshot === "succeeded" && workflowOutcome === "complete") return "completed";
  if (
    snapshot === "failed" &&
    (workflowOutcome === "errored" || workflowOutcome === "terminated")
  ) {
    return "completed";
  }
  throw new Error("Deployment Queue recovery final audit state is invalid");
}

export function recoverySnapshot(
  operationState: string | undefined,
  workflowState: string | undefined,
  deploymentState: string | undefined,
): RecoverySnapshot | null {
  if (operationState === "queued" && workflowState === "queued" && deploymentState === "queued") {
    return "queued";
  }
  if (
    (operationState === "queued" || operationState === "running") &&
    workflowState === "reconciliation_required" &&
    deploymentState === "reconciliation_required"
  ) {
    return "provider_reconciliation";
  }
  if (
    operationState === "succeeded" &&
    workflowState === "completed" &&
    deploymentState === "succeeded"
  ) {
    return "succeeded";
  }
  if (
    operationState === "failed" &&
    workflowState === "completed" &&
    deploymentState === "failed"
  ) {
    return "failed";
  }
  return null;
}

export function assertFinalEvidence(
  finalAudit: RecoveryAuditRow,
  preparedAudit: RecoveryAuditRow,
  current: RecoveryCandidate,
  input: DeploymentQueueDeliveryRecoveryIdentityInput,
  evidence: ReturnType<typeof parseFinalEvidence>,
): void {
  const preparedPayload = preparedPayloadForEvidence(evidence, input);
  const finalPayloadValue = finalPayloadForEvidence(evidence, input);
  if (
    !isFinalRecoveryScope(current) ||
    (current.hasProviderClaim &&
      (!current.providerClaimMatchesScope ||
        !["queued", "provider_running", "provider_reconciliation"].includes(
          durableOutcome(current.scope),
        ))) ||
    current.event.acknowledged_at === null ||
    current.event.reconciliation_required_at !== null ||
    finalAudit.project_id !== current.scope.project_id ||
    finalAudit.operation_id !== current.scope.operation_id ||
    finalAudit.billing_epoch_id !== current.scope.billing_epoch_id ||
    finalAudit.actor_type !== "principal" ||
    finalAudit.actor_id !== input.actorId ||
    preparedAudit.audit_event_id !== evidence.preparedAuditEventId ||
    preparedAudit.project_id !== current.scope.project_id ||
    preparedAudit.operation_id !== current.scope.operation_id ||
    preparedAudit.billing_epoch_id !== current.scope.billing_epoch_id ||
    preparedAudit.event_type !== DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED ||
    preparedAudit.actor_type !== "principal" ||
    preparedAudit.actor_id !== input.actorId ||
    !isValidTimestamp(finalAudit.occurred_at) ||
    !isValidTimestamp(preparedAudit.occurred_at) ||
    preparedAudit.occurred_at > finalAudit.occurred_at ||
    preparedAudit.occurred_at < requiredFailureAt(current) ||
    finalAudit.occurred_at < requiredFailureAt(current) ||
    finalAudit.occurred_at.toISOString() !== current.event.acknowledged_at.toISOString() ||
    current.attempt.acknowledged_at !== null ||
    !exactRecord(preparedAudit.payload, preparedPayload) ||
    !exactRecord(finalAudit.payload, finalPayloadValue) ||
    evidence.workflowId !== current.scope.workflow_id ||
    evidence.environmentId !== current.scope.environment_id ||
    evidence.billingEpochId !== current.scope.billing_epoch_id ||
    evidence.planId !== current.scope.plan_id ||
    evidence.deploymentId !== current.scope.deployment_id ||
    !isMonotoneFromSnapshot(current, evidence)
  ) {
    throw new Error("Deployment Queue recovery final audit evidence is invalid");
  }
}

export function preparedPayloadForEvidence(
  evidence: ReturnType<typeof parseFinalEvidence>,
  input: DeploymentQueueDeliveryRecoveryIdentityInput,
) {
  return {
    reconciliationId: input.reconciliationId,
    requestEventId: evidence.requestEventId,
    deliveryAttemptId: evidence.deliveryAttemptId,
    workflowId: evidence.workflowId,
    environmentId: evidence.environmentId,
    billingEpochId: evidence.billingEpochId,
    planId: evidence.planId ?? "",
    deploymentId: evidence.deploymentId,
    finalAuditEventId: input.finalAuditEventId,
    idempotencySha256: input.idempotencySha256,
  } as const;
}

export function finalPayloadForEvidence(
  evidence: ReturnType<typeof parseFinalEvidence>,
  input: DeploymentQueueDeliveryRecoveryIdentityInput,
) {
  return {
    ...preparedPayloadForEvidence(evidence, input),
    preparedAuditEventId: input.preparedAuditEventId,
    outcomeCode: "WORKFLOW_ENSURED",
    workflowOutcome: evidence.workflowOutcome,
    operationStateAtRecovery: evidence.operationState,
    workflowStateAtRecovery: evidence.workflowState,
    deploymentStateAtRecovery: evidence.deploymentState,
    state: evidence.state,
  } as const;
}

export function isMonotoneFromSnapshot(
  candidate: RecoveryCandidate,
  evidence: ReturnType<typeof parseFinalEvidence>,
): boolean {
  const current = durableOutcome(candidate.scope);
  if (
    current === "provider_running" &&
    (!candidate.hasProviderClaim || !candidate.providerClaimMatchesScope)
  )
    return false;
  if (current === "inconsistent") return false;
  const snapshot = recoverySnapshot(
    evidence.operationState,
    evidence.workflowState,
    evidence.deploymentState,
  );
  if (snapshot === null) return false;
  if (snapshot === "queued") {
    return (
      current === "queued" ||
      current === "provider_running" ||
      current === "provider_reconciliation" ||
      current === "succeeded" ||
      current === "failed"
    );
  }
  if (snapshot === "provider_reconciliation") {
    return current === "provider_reconciliation" || current === "succeeded" || current === "failed";
  }
  return current === snapshot;
}

export function requiredFailureAt(candidate: RecoveryCandidate): Date {
  const failedAt = candidate.attempt.failed_at;
  if (failedAt === null || !isValidTimestamp(failedAt)) {
    throw new Error("Deployment Queue recovery final delivery failure is unavailable");
  }
  return failedAt;
}

export function assertPreparationInput(input: PrepareDeploymentQueueDeliveryRecoveryInput): void {
  assertIdentityInput(input);
  parseTimestamp(input.preparedAt, "Deployment Queue recovery preparation time");
}

export function assertFinalizationInput(input: FinalizeDeploymentQueueDeliveryRecoveryInput): void {
  assertIdentityInput(input);
  for (const id of [
    input.projectId,
    input.environmentId,
    input.billingEpochId,
    input.requestEventId,
    input.deliveryAttemptId,
    input.deploymentId,
  ]) {
    parseUlid(id);
  }
  if (input.planId !== null) parseUlid(input.planId);
  if (
    !isDeploymentQueueDeliveryRecoveryEventType(input.eventType) ||
    (input.eventType === "DeploymentRequestedV1") !== (input.planId !== null) ||
    input.workflowId !==
      productCommandWorkflowId(input.eventType, input.requestEventId, input.operationId) ||
    !isWorkflowOutcome(input.workflowOutcome)
  ) {
    throw new TypeError("Deployment Queue recovery finalization is invalid");
  }
  parseTimestamp(input.recoveredAt, "Deployment Queue recovery completion time");
}

export function assertIdentityInput(input: DeploymentQueueDeliveryRecoveryIdentityInput): void {
  for (const id of [
    input.organizationId,
    input.operationId,
    input.reconciliationId,
    input.preparedAuditEventId,
    input.finalAuditEventId,
  ]) {
    parseUlid(id);
  }
  if (!isPrincipal(input.actorId)) {
    throw new TypeError("Deployment Queue recovery actor is invalid");
  }
  if (!isDigest(input.idempotencySha256)) {
    throw new TypeError("Deployment Queue recovery idempotency digest is invalid");
  }
}

export function productCommandWorkflowId(
  eventType: DeploymentQueueDeliveryRecoveryEventType,
  eventId: string,
  operationId: string,
): string {
  const kind =
    eventType === "DeploymentRequestedV1"
      ? "deploy"
      : eventType === "DeploymentRollbackRequestedV1"
        ? "rollback"
        : "promotion";
  return `product-command-v1-${kind}-${eventId}-${operationId}`;
}

export function isDeploymentQueueDeliveryRecoveryEventType(
  value: string,
): value is DeploymentQueueDeliveryRecoveryEventType {
  return (
    value === "DeploymentRequestedV1" ||
    value === "DeploymentRollbackRequestedV1" ||
    value === "DeploymentPromotionRequestedV1"
  );
}

export function requirePayload(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, string>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Deployment Queue recovery audit payload is invalid");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    Object.values(record).some((field) => typeof field !== "string")
  ) {
    throw new Error("Deployment Queue recovery audit payload is invalid");
  }
  return record as Readonly<Record<string, string>>;
}

export function requiredPayloadString(
  value: Readonly<Record<string, string>>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw new Error("Deployment Queue recovery final audit payload is invalid");
  }
  return field;
}

export function exactRecord(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => record[key] === expected[key])
  );
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
): value is DeploymentQueueDeliveryRecoveryWorkflowOutcome {
  return (
    value === "pending" || value === "complete" || value === "errored" || value === "terminated"
  );
}

export function isOperationState(value: unknown): value is DeploymentRecoveryOperationState {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed";
}

export function isWorkflowState(value: unknown): value is DeploymentRecoveryRunState {
  return value === "queued" || value === "completed" || value === "reconciliation_required";
}

export function isDeploymentState(value: unknown): value is DeploymentRecoveryDeploymentState {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "reconciliation_required"
  );
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

export function parseIdentity(value: string): boolean {
  return isUlidString(value);
}
