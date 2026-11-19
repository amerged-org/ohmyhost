// Original SourceLink recovery read/evidence control flow; fixed native SQL with atomic observation guards.
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import type { RecoveryReads } from "./queue-recovery-snapshot.js";
import {
  DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED,
  DEPLOYMENT_QUEUE_DELIVERY_RECOVERED,
  type DeploymentQueueDeliveryRecoveryIdentityInput,
  type DeploymentQueueDeliveryRecoveryPreparation,
  type RecoveryScopeRow,
  type RecoveryOutboxRow,
  type RecoveryAttemptRow,
  type RecoveryAuditRow,
  type RecoveryCandidate,
  finalPayloadKeys,
  parseFinalEvidence,
  assertFinalEvidence,
  requirePayload,
} from "./queue-recovery-deployment-logic.js";
export async function lockRecoveryScope(
  client: RecoveryReads,
  input: Pick<DeploymentQueueDeliveryRecoveryIdentityInput, "organizationId" | "operationId">,
): Promise<RecoveryScopeRow | undefined> {
  const result = await client.select<RecoveryScopeRow>(
    `SELECT run.organization_id,run.project_id,run.environment_id,run.operation_id,
            run.billing_epoch_id,run.event_id,run.event_type,intent.plan_id,intent.deployment_id,run.workflow_id,
            operation.state AS operation_state,run.state AS workflow_state,
            run.terminal_evidence AS workflow_terminal_evidence,
            run.intermediate_evidence AS workflow_intermediate_evidence,
            run.reconciliation_code AS workflow_reconciliation_code,
            run.active_reconciliation_attempt_id,run.active_replay_attempt_id,
            deployment.status AS deployment_state,deployment.active_revision_id AS deployment_active_revision_id,
            ownership.state AS ownership_state,project.lifecycle_state
       FROM product_workflow_runs run
       INNER JOIN product_command_intents intent
         ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
        AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
        AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
       INNER JOIN operations operation
         ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id
        AND operation.operation_id=run.operation_id AND operation.billing_epoch_id=run.billing_epoch_id
       INNER JOIN deployments deployment
         ON deployment.organization_id=run.organization_id AND deployment.project_id=run.project_id
        AND deployment.environment_id=run.environment_id AND deployment.operation_id=run.operation_id
        AND deployment.deployment_id=intent.deployment_id
       INNER JOIN environments environment
         ON environment.organization_id=run.organization_id AND environment.project_id=run.project_id
        AND environment.environment_id=run.environment_id
       INNER JOIN projects project ON project.project_id=run.project_id AND project.owner_state<>'transferred'
       INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
         ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
        AND ownership.active_billing_epoch_id=run.billing_epoch_id
       WHERE run.organization_id=?1 AND run.operation_id=?2
         AND run.event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1')`,
    [input.organizationId, input.operationId],
  );
  if (result.rowCount === 0) return undefined;
  if (result.rowCount !== 1 || result.rows[0] === undefined) {
    throw new Error("Deployment Queue recovery scope is ambiguous");
  }
  return result.rows[0];
}

export async function classifyAbsentRecoveryScope(
  client: RecoveryReads,
  input: Pick<DeploymentQueueDeliveryRecoveryIdentityInput, "organizationId" | "operationId">,
): Promise<Extract<DeploymentQueueDeliveryRecoveryPreparation, { outcome: "not_applicable" }>> {
  const events = await client.select<{ organization_id: string }>(
    `SELECT organization_id FROM outbox_events
      WHERE operation_id=?1
        AND event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1')`,
    [input.operationId],
  );
  if (events.rowCount === 0) return Object.freeze({ outcome: "not_applicable" });
  if (events.rowCount !== 1 || events.rows[0]?.organization_id !== input.organizationId) {
    throw new Error("Deployment request does not match the requested organization");
  }
  throw new Error("Deployment Queue recovery scope is unavailable");
}

export async function lockRecoveryCandidate(
  client: RecoveryReads,
  scope: RecoveryScopeRow,
): Promise<RecoveryCandidate | null> {
  const eventResult = await client.select<RecoveryOutboxRow>(
    `SELECT event_id,organization_id,project_id,operation_id,billing_epoch_id,event_type,payload,
            current_attempt_id,attempt_count,max_attempts,last_error_code,acknowledged_at,
            reconciliation_required_at,claimed_at,lease_expires_at
       FROM outbox_events
      WHERE organization_id=?1 AND operation_id=?2 AND event_type=?3`,
    [scope.organization_id, scope.operation_id, scope.event_type],
  );
  if (eventResult.rowCount !== 1 || eventResult.rows[0] === undefined) return null;
  const event = eventResult.rows[0];
  const attemptResult =
    event.current_attempt_id === null
      ? null
      : await client.select<RecoveryAttemptRow>(
          `SELECT attempt_id,event_id,attempt_number,status,error_code,failed_at,next_available_at,
                  acknowledged_at
             FROM delivery_attempts
            WHERE event_id=?1 AND attempt_id=?2`,
          [event.event_id, event.current_attempt_id],
        );
  const attempt = attemptResult?.rows[0];
  if (attemptResult === null || attemptResult.rowCount !== 1 || attempt === undefined) return null;
  const claims = await client.select<{ present: boolean; matches_scope: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM product_provider_mutation_claims
        WHERE organization_id=?1 AND project_id=?2
     ) AS present,
     EXISTS(
       SELECT 1 FROM product_provider_mutation_claims
        WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4
          AND billing_epoch_id=?5 AND event_id=?6 AND logical_workflow_id=?7
          AND event_type=?8
     ) AS matches_scope`,
    [
      scope.organization_id,
      scope.project_id,
      scope.environment_id,
      scope.operation_id,
      scope.billing_epoch_id,
      scope.event_id,
      scope.workflow_id,
      scope.event_type,
    ],
  );
  const evidence = await client.select<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM provider_resources
        WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3
     ) AS present`,
    [scope.organization_id, scope.project_id, scope.operation_id],
  );
  return Object.freeze({
    scope,
    event,
    attempt,
    hasProviderClaim: claims.rows[0]?.present === true,
    providerClaimMatchesScope: claims.rows[0]?.matches_scope === true,
    hasProviderEvidence: evidence.rows[0]?.present === true,
  });
}

export async function loadRecoveryAudits(
  client: RecoveryReads,
  candidate: RecoveryCandidate,
): Promise<RecoveryAuditRow[]> {
  return loadRecoveryAuditsForScope(client, candidate.scope);
}

export async function loadRecoveryAuditsForScope(
  client: RecoveryReads,
  scope: Pick<RecoveryScopeRow, "organization_id" | "project_id" | "operation_id">,
): Promise<RecoveryAuditRow[]> {
  const result = await client.select<RecoveryAuditRow>(
    `SELECT audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,
            payload,occurred_at
       FROM audit_events
      WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3
        AND event_type IN (?4,?5)`,
    [
      scope.organization_id,
      scope.project_id,
      scope.operation_id,
      DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED,
      DEPLOYMENT_QUEUE_DELIVERY_RECOVERED,
    ],
  );
  return result.rows;
}

export async function readFinalDeploymentQueueDeliveryRecovery(
  client: RecoveryReads,
  input: DeploymentQueueDeliveryRecoveryIdentityInput,
): Promise<Extract<DeploymentQueueDeliveryRecoveryPreparation, { outcome: "recovered" }> | null> {
  const finalAuditResult = await client.select<RecoveryAuditRow>(
    `SELECT audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,
            payload,occurred_at
       FROM audit_events
      WHERE organization_id=?1 AND audit_event_id=?2`,
    [input.organizationId, input.finalAuditEventId],
  );
  if (finalAuditResult.rowCount === 0) return null;
  if (finalAuditResult.rowCount !== 1 || finalAuditResult.rows[0] === undefined) {
    throw new Error("Deployment Queue recovery final audit is ambiguous");
  }
  const finalAudit = finalAuditResult.rows[0];
  if (
    finalAudit.event_type !== DEPLOYMENT_QUEUE_DELIVERY_RECOVERED ||
    finalAudit.operation_id !== input.operationId ||
    finalAudit.actor_type !== "principal" ||
    finalAudit.actor_id !== input.actorId
  ) {
    throw new Error("Deployment Queue recovery final audit does not match the request");
  }
  const payload = requirePayload(finalAudit.payload, finalPayloadKeys);
  const finalEvidence = parseFinalEvidence(payload);
  if (
    finalEvidence.reconciliationId !== input.reconciliationId ||
    finalEvidence.finalAuditEventId !== input.finalAuditEventId ||
    finalEvidence.idempotencySha256 !== input.idempotencySha256
  ) {
    throw new Error("Deployment Queue recovery final audit does not match the request");
  }
  const current = await readFinalRecoveryCandidate(client, {
    organizationId: input.organizationId,
    operationId: input.operationId,
    projectId: finalAudit.project_id,
    requestEventId: finalEvidence.requestEventId,
  });
  if (current === null)
    throw new Error("Deployment Queue recovery final audit scope is unavailable");
  const preparedAuditResult = await client.select<RecoveryAuditRow>(
    `SELECT audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,
            payload,occurred_at
       FROM audit_events
      WHERE organization_id=?1 AND audit_event_id=?2`,
    [input.organizationId, finalEvidence.preparedAuditEventId],
  );
  if (preparedAuditResult.rowCount !== 1 || preparedAuditResult.rows[0] === undefined) {
    throw new Error("Deployment Queue recovery final replay requires one exact prepared audit");
  }
  const preparedAudit = preparedAuditResult.rows[0];
  assertFinalEvidence(finalAudit, preparedAudit, current, input, finalEvidence);
  return Object.freeze({
    outcome: "recovered",
    reconciliationId: parseUlid(input.reconciliationId),
    operationId: parseUlid(input.operationId),
    state: finalEvidence.state,
    ...(finalEvidence.continueProviderReconciliation === true
      ? { continueProviderReconciliation: true as const }
      : {}),
  });
}

export async function readFinalRecoveryCandidate(
  client: RecoveryReads,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly projectId: string;
    readonly requestEventId: Ulid;
  },
): Promise<RecoveryCandidate | null> {
  const scopeResult = await client.select<RecoveryScopeRow>(
    `SELECT run.organization_id,run.project_id,run.environment_id,run.operation_id,
            run.billing_epoch_id,run.event_id,run.event_type,intent.plan_id,intent.deployment_id,run.workflow_id,
            operation.state AS operation_state,run.state AS workflow_state,
            run.terminal_evidence AS workflow_terminal_evidence,
            run.intermediate_evidence AS workflow_intermediate_evidence,
            run.reconciliation_code AS workflow_reconciliation_code,
            run.active_reconciliation_attempt_id,run.active_replay_attempt_id,
            deployment.status AS deployment_state,deployment.active_revision_id AS deployment_active_revision_id,
            ownership.state AS ownership_state,project.lifecycle_state
       FROM product_workflow_runs run
       INNER JOIN product_command_intents intent
         ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
        AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
        AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
       INNER JOIN operations operation
         ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id
        AND operation.operation_id=run.operation_id AND operation.billing_epoch_id=run.billing_epoch_id
       INNER JOIN deployments deployment
         ON deployment.organization_id=run.organization_id AND deployment.project_id=run.project_id
        AND deployment.environment_id=run.environment_id AND deployment.operation_id=run.operation_id
        AND deployment.deployment_id=intent.deployment_id
       INNER JOIN environments environment
         ON environment.organization_id=run.organization_id AND environment.project_id=run.project_id
        AND environment.environment_id=run.environment_id
       INNER JOIN projects project ON project.project_id=run.project_id AND project.owner_state<>'transferred'
       INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
         ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
        AND ownership.active_billing_epoch_id=run.billing_epoch_id
       WHERE run.organization_id=?1 AND run.project_id=?2 AND run.operation_id=?3 AND run.event_id=?4
         AND run.event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1')`,
    [input.organizationId, input.projectId, input.operationId, input.requestEventId],
  );
  const scope = scopeResult.rows[0];
  if (scopeResult.rowCount !== 1 || scope === undefined) return null;
  const eventResult = await client.select<RecoveryOutboxRow>(
    `SELECT event_id,organization_id,project_id,operation_id,billing_epoch_id,event_type,payload,
            current_attempt_id,attempt_count,max_attempts,last_error_code,acknowledged_at,
            reconciliation_required_at,claimed_at,lease_expires_at
       FROM outbox_events
      WHERE event_id=?1 AND organization_id=?2 AND project_id=?3 AND operation_id=?4`,
    [input.requestEventId, input.organizationId, input.projectId, input.operationId],
  );
  const event = eventResult.rows[0];
  if (eventResult.rowCount !== 1 || event === undefined || event.current_attempt_id === null)
    return null;
  const attemptResult = await client.select<RecoveryAttemptRow>(
    `SELECT attempt_id,event_id,attempt_number,status,error_code,failed_at,next_available_at,acknowledged_at
       FROM delivery_attempts WHERE event_id=?1 AND attempt_id=?2`,
    [event.event_id, event.current_attempt_id],
  );
  const attempt = attemptResult.rows[0];
  if (attemptResult.rowCount !== 1 || attempt === undefined) return null;
  const claims = await client.select<{ present: boolean; matches_scope: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM product_provider_mutation_claims
        WHERE organization_id=?1 AND project_id=?2
     ) AS present,
     EXISTS(
       SELECT 1 FROM product_provider_mutation_claims
        WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4
          AND billing_epoch_id=?5 AND event_id=?6 AND logical_workflow_id=?7
          AND event_type=?8
     ) AS matches_scope`,
    [
      scope.organization_id,
      scope.project_id,
      scope.environment_id,
      scope.operation_id,
      scope.billing_epoch_id,
      scope.event_id,
      scope.workflow_id,
      scope.event_type,
    ],
  );
  const evidence = await client.select<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM provider_resources
        WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3
     ) AS present`,
    [scope.organization_id, scope.project_id, scope.operation_id],
  );
  return Object.freeze({
    scope,
    event,
    attempt,
    hasProviderClaim: claims.rows[0]?.present === true,
    providerClaimMatchesScope: claims.rows[0]?.matches_scope === true,
    hasProviderEvidence: evidence.rows[0]?.present === true,
  });
}
