// Original SourceLink recovery read/evidence control flow; fixed native SQL with atomic observation guards.
import { parseUlid, type Ulid } from "@ohmyhost/platform";
import { Buffer } from "node:buffer";
import type { RecoveryReads } from "./queue-recovery-snapshot.js";
import { isFinalDeliveryCode } from "./queue-recovery-deployment-logic.js";
import {
  SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED,
  SOURCE_LINK_QUEUE_DELIVERY_RECOVERED,
  type SourceLinkQueueDeliveryRecoveryIdentityInput,
  type SourceLinkQueueDeliveryRecoveryPreparation,
  type RecoveryScopeRow,
  type RecoveryOutboxRow,
  type RecoveryAttemptRow,
  type RecoveryAuditRow,
  type SourceTerminalState,
  type RecoveryCandidate,
  type DeliveryHistory,
  type SourceLinkWorkflowReplayContinuation,
  type SourceLinkWorkflowReplayChainRow,
  type SourceLinkWorkflowReplayRow,
  parseExactSourceLinkDeliveryHistory,
  hasTerminalSourceState,
  finalPayloadKeys,
  parseFinalEvidence,
  assertFinalEvidence,
  productWorkflowReplayRouting,
  isReplayContinuationEligibleEvidence,
  sourceLinkWorkflowId,
  requirePayload,
  isOperationState,
  isWorkflowState,
  isPrincipal,
  isUlidString,
} from "./queue-recovery-source-link-logic.js";
export async function lockSourceLinkRecoveryProjectProviderTransaction(
  client: RecoveryReads,
  input: Pick<SourceLinkQueueDeliveryRecoveryIdentityInput, "organizationId" | "operationId">,
): Promise<Ulid | null> {
  const result = await client.select<{ project_id: string }>(
    `SELECT run.project_id
       FROM product_workflow_runs run
       INNER JOIN product_command_intents intent
         ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
        AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
        AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
      WHERE run.organization_id=?1 AND run.operation_id=?2
        AND run.event_type='SourceLinkRequestedV1' AND intent.event_type='SourceLinkRequestedV1'`,
    [input.organizationId, input.operationId],
  );
  const projectId = result.rows[0]?.project_id;
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1 || projectId === undefined) {
    throw new Error("SourceLink Queue recovery operation scope is ambiguous");
  }
  const parsedProjectId = parseUlid(projectId);

  return parsedProjectId;
}

export async function lockRecoveryScope(
  client: RecoveryReads,
  input: Pick<SourceLinkQueueDeliveryRecoveryIdentityInput, "organizationId" | "operationId">,
): Promise<RecoveryScopeRow | undefined> {
  const result = await client.select<RecoveryScopeRow>(
    `SELECT run.organization_id,run.project_id,run.environment_id,run.operation_id,
            run.billing_epoch_id,run.event_id,run.workflow_id,intent.installation_id,
            intent.repository_owner,intent.repository_name,operation.state AS operation_state,
            operation.failure AS operation_failure,run.state AS workflow_state,
            run.terminal_evidence AS workflow_terminal_evidence,
            run.intermediate_evidence AS workflow_intermediate_evidence,
            run.reconciliation_code AS workflow_reconciliation_code,
            run.active_reconciliation_attempt_id,run.active_replay_attempt_id,
            ownership.state AS ownership_state,project.lifecycle_state
       FROM product_workflow_runs run
       INNER JOIN product_command_intents intent
         ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
        AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
        AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
       INNER JOIN operations operation
         ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id
        AND operation.operation_id=run.operation_id AND operation.billing_epoch_id=run.billing_epoch_id
       INNER JOIN environments environment
         ON environment.organization_id=run.organization_id AND environment.project_id=run.project_id
        AND environment.environment_id=run.environment_id
       INNER JOIN projects project ON project.project_id=run.project_id AND project.owner_state<>'transferred'
       INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
         ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
        AND ownership.active_billing_epoch_id=run.billing_epoch_id
       WHERE run.organization_id=?1 AND run.operation_id=?2
         AND run.event_type='SourceLinkRequestedV1' AND intent.event_type='SourceLinkRequestedV1'`,
    [input.organizationId, input.operationId],
  );
  if (result.rowCount === 0) return undefined;
  if (result.rowCount !== 1 || result.rows[0] === undefined) {
    throw new Error("SourceLink Queue recovery scope is ambiguous");
  }
  return result.rows[0];
}

export async function classifyAbsentRecoveryScope(
  client: RecoveryReads,
  input: Pick<SourceLinkQueueDeliveryRecoveryIdentityInput, "organizationId" | "operationId">,
): Promise<Extract<SourceLinkQueueDeliveryRecoveryPreparation, { outcome: "not_applicable" }>> {
  const events = await client.select<{ organization_id: string }>(
    `SELECT organization_id FROM outbox_events
      WHERE operation_id=?1 AND event_type='SourceLinkRequestedV1'`,
    [input.operationId],
  );
  if (events.rowCount === 0) return Object.freeze({ outcome: "not_applicable" });
  if (events.rowCount !== 1 || events.rows[0]?.organization_id !== input.organizationId) {
    throw new Error("SourceLink request does not match the requested organization");
  }
  throw new Error("SourceLink Queue recovery scope is unavailable");
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
      WHERE organization_id=?1 AND operation_id=?2 AND event_type='SourceLinkRequestedV1'`,
    [scope.organization_id, scope.operation_id],
  );
  if (eventResult.rowCount !== 1 || eventResult.rows[0] === undefined) return null;
  const event = eventResult.rows[0];
  // Acknowledged or never-parked history is ordinary: the prepare answers not applicable.
  if (event.acknowledged_at !== null || event.reconciliation_required_at === null) return null;
  // A parked signal must be the exact final delivery, as the project path requires: any other count or code is refused.
  if (event.attempt_count !== event.max_attempts || !isFinalDeliveryCode(event.last_error_code))
    throw new Error("SourceLink event is not an exact final Queue-delivery recovery candidate");
  const deliveryHistory = await lockExactSourceLinkDeliveryHistory(client, event);
  const attempt = deliveryHistory.finalAttempt;
  const claim = await client.select<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM product_provider_mutation_claims
        WHERE organization_id=?1 AND project_id=?2
     ) AS present`,
    [scope.organization_id, scope.project_id],
  );
  const source = await readSourceTerminalState(client, scope);
  return Object.freeze({
    scope,
    event,
    attempt,
    deliveryHistory,
    hasProviderClaim: claim.rows[0]?.present === true,
    source,
  });
}

export async function lockExactSourceLinkDeliveryHistory(
  client: RecoveryReads,
  event: RecoveryOutboxRow,
): Promise<DeliveryHistory> {
  const attempts = await client.select<RecoveryAttemptRow>(
    `SELECT attempt_id,event_id,attempt_number,status,error_code,failed_at,next_available_at,
            acknowledged_at,claimed_at,lease_expires_at
       FROM delivery_attempts
      WHERE event_id=?1
      ORDER BY attempt_number`,
    [event.event_id],
  );
  return parseExactSourceLinkDeliveryHistory(event, attempts.rows);
}

export async function readSourceTerminalState(
  client: RecoveryReads,
  scope: Pick<
    RecoveryScopeRow,
    | "organization_id"
    | "project_id"
    | "billing_epoch_id"
    | "operation_id"
    | "installation_id"
    | "repository_owner"
    | "repository_name"
  >,
): Promise<SourceTerminalState> {
  const result = await client.select<SourceTerminalState>(
    `SELECT
       EXISTS(
         SELECT 1 FROM github_source_connections connection
          WHERE connection.organization_id=?1 AND connection.project_id=?2
            AND connection.source_connection_id=?4
       ) AS connection_present,
       EXISTS(
         SELECT 1 FROM repository_grants grant_record
          WHERE grant_record.organization_id=?1 AND grant_record.project_id=?2
            AND (grant_record.grant_id=?4 OR grant_record.source_connection_id=?4)
       ) AS grant_present,
       EXISTS(
         SELECT 1 FROM project_sources source
          WHERE source.organization_id=?1 AND source.project_id=?2
            AND (source.source_id=?4 OR source.grant_id=?4)
       ) AS source_present,
       EXISTS(
         SELECT 1 FROM github_source_connections connection
          INNER JOIN repository_grants grant_record
            ON grant_record.organization_id=connection.organization_id
           AND grant_record.project_id=connection.project_id
           AND grant_record.billing_epoch_id=connection.billing_epoch_id
           AND grant_record.source_connection_id=connection.source_connection_id
          INNER JOIN project_sources source
            ON source.organization_id=grant_record.organization_id
           AND source.project_id=grant_record.project_id
           AND source.billing_epoch_id=grant_record.billing_epoch_id
           AND source.grant_id=grant_record.grant_id
          WHERE connection.organization_id=?1 AND connection.project_id=?2
            AND connection.billing_epoch_id=?3 AND connection.source_connection_id=?4
            AND connection.provider='github' AND grant_record.grant_id=?4
            AND grant_record.provider='github' AND grant_record.permission='contents:read'
            AND grant_record.github_installation_id=?5 AND grant_record.repository_owner=?6
            AND grant_record.repository_name=?7 AND source.source_id=?4 AND source.provider='github'
            AND source.state='ready' AND source.failure_code IS NULL AND source.revision=1
            AND source.installation_id=?5 AND source.repository_owner=?6 AND source.repository_name=?7
            AND grant_record.external_repository_id=connection.external_repository_id
            AND source.external_repository_id=connection.external_repository_id
       ) AS exact_ready,
       (
         SELECT source.external_repository_id FROM project_sources source
          WHERE source.organization_id=?1 AND source.project_id=?2 AND source.source_id=?4
       ) AS source_external_repository_id`,
    [
      scope.organization_id,
      scope.project_id,
      scope.billing_epoch_id,
      scope.operation_id,
      scope.installation_id,
      scope.repository_owner,
      scope.repository_name,
    ],
  );
  const row = result.rows[0];
  if (result.rowCount !== 1 || row === undefined) {
    throw new Error("SourceLink Queue recovery source state is unavailable");
  }
  return row;
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
      SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED,
      SOURCE_LINK_QUEUE_DELIVERY_RECOVERED,
    ],
  );
  return result.rows;
}

export async function readFinalSourceLinkQueueDeliveryRecovery(
  client: RecoveryReads,
  input: SourceLinkQueueDeliveryRecoveryIdentityInput,
): Promise<Extract<SourceLinkQueueDeliveryRecoveryPreparation, { outcome: "recovered" }> | null> {
  const finalAuditResult = await client.select<RecoveryAuditRow>(
    `SELECT audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,
            payload,occurred_at
       FROM audit_events
      WHERE organization_id=?1 AND audit_event_id=?2`,
    [input.organizationId, input.finalAuditEventId],
  );
  if (finalAuditResult.rowCount === 0) return null;
  if (finalAuditResult.rowCount !== 1 || finalAuditResult.rows[0] === undefined) {
    throw new Error("SourceLink Queue recovery final audit is ambiguous");
  }
  const finalAudit = finalAuditResult.rows[0];
  if (
    finalAudit.event_type !== SOURCE_LINK_QUEUE_DELIVERY_RECOVERED ||
    finalAudit.operation_id !== input.operationId ||
    finalAudit.actor_type !== "principal" ||
    finalAudit.actor_id !== input.actorId
  ) {
    throw new Error("SourceLink Queue recovery final audit does not match the request");
  }
  const evidence = parseFinalEvidence(requirePayload(finalAudit.payload, finalPayloadKeys));
  if (
    evidence.reconciliationId !== input.reconciliationId ||
    evidence.finalAuditEventId !== input.finalAuditEventId ||
    evidence.idempotencySha256 !== input.idempotencySha256
  ) {
    throw new Error("SourceLink Queue recovery final audit does not match the request");
  }
  const stored = await readClosedSourceLinkQueueDeliveryRecoveryState(client, {
    organizationId: input.organizationId,
    operationId: input.operationId,
  });
  if (
    stored === null ||
    stored.reconciliationId !== evidence.reconciliationId ||
    stored.state !== evidence.state
  ) {
    throw new Error("SourceLink Queue recovery final audit does not match the request");
  }
  return stored;
}

export async function readClosedSourceLinkQueueDeliveryRecoveryState(
  client: RecoveryReads,
  input: { readonly organizationId: Ulid; readonly operationId: Ulid },
): Promise<Extract<SourceLinkQueueDeliveryRecoveryPreparation, { outcome: "recovered" }> | null> {
  parseUlid(input.organizationId);
  parseUlid(input.operationId);

  const lockedProjectId = await lockSourceLinkRecoveryProjectProviderTransaction(client, input);
  const finalAudits = await client.select<RecoveryAuditRow>(
    `SELECT audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,
            payload,occurred_at
       FROM audit_events
      WHERE organization_id=?1 AND operation_id=?2 AND event_type=?3`,
    [input.organizationId, input.operationId, SOURCE_LINK_QUEUE_DELIVERY_RECOVERED],
  );
  if (finalAudits.rowCount === 0) return null;
  const finalAudit = finalAudits.rows[0];
  if (finalAudits.rowCount !== 1 || finalAudit === undefined) {
    throw new Error("SourceLink Queue recovery final audit is ambiguous");
  }
  const preparedAudits = await client.select<RecoveryAuditRow>(
    `SELECT audit_event_id,project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,
            payload,occurred_at
       FROM audit_events
      WHERE organization_id=?1 AND operation_id=?2 AND event_type=?3`,
    [input.organizationId, input.operationId, SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED],
  );
  const preparedAudit = preparedAudits.rows[0];
  if (preparedAudits.rowCount !== 1 || preparedAudit === undefined) {
    throw new Error("SourceLink Queue recovery prepared audit is ambiguous");
  }
  if (
    finalAudit.operation_id !== input.operationId ||
    finalAudit.event_type !== SOURCE_LINK_QUEUE_DELIVERY_RECOVERED ||
    finalAudit.actor_type !== "principal" ||
    !isPrincipal(finalAudit.actor_id)
  ) {
    throw new Error("SourceLink Queue recovery final audit is invalid");
  }
  const evidence = parseFinalEvidence(requirePayload(finalAudit.payload, finalPayloadKeys));
  if (
    evidence.finalAuditEventId !== finalAudit.audit_event_id ||
    evidence.reconciliationId === evidence.preparedAuditEventId ||
    evidence.reconciliationId === evidence.finalAuditEventId ||
    evidence.preparedAuditEventId === evidence.finalAuditEventId
  ) {
    throw new Error("SourceLink Queue recovery final audit is invalid");
  }
  const candidate = await readFinalRecoveryCandidate(client, {
    organizationId: input.organizationId,
    operationId: input.operationId,
    projectId: finalAudit.project_id,
    requestEventId: evidence.requestEventId,
  });
  if (candidate === null) {
    throw new Error("SourceLink Queue recovery final audit scope is unavailable");
  }
  if (lockedProjectId !== null && candidate.scope.project_id !== lockedProjectId) {
    throw new Error("SourceLink Queue recovery project scope changed");
  }
  if (preparedAudit.audit_event_id !== evidence.preparedAuditEventId) {
    throw new Error("SourceLink Queue recovery final replay requires one exact prepared audit");
  }
  const storedInput: SourceLinkQueueDeliveryRecoveryIdentityInput = {
    organizationId: input.organizationId,
    operationId: input.operationId,
    reconciliationId: evidence.reconciliationId,
    preparedAuditEventId: evidence.preparedAuditEventId,
    finalAuditEventId: evidence.finalAuditEventId,
    actorId: finalAudit.actor_id,
    idempotencySha256: evidence.idempotencySha256,
  };
  const workflowReplay = await readExactSourceLinkWorkflowReplayContinuation(
    client,
    candidate,
    evidence,
    finalAudit.actor_id,
  );
  assertFinalEvidence(finalAudit, preparedAudit, candidate, storedInput, evidence, workflowReplay);
  const replayRouting = productWorkflowReplayRouting(candidate, evidence, workflowReplay);
  return Object.freeze({
    outcome: "recovered",
    reconciliationId: evidence.reconciliationId,
    operationId: parseUlid(input.operationId),
    state: evidence.state,
    ...(replayRouting.continueOriginalKey ? { continueProductWorkflowReplay: true as const } : {}),
    ...(replayRouting.continueWithNewKey
      ? { continueProductWorkflowReplayWithNewKey: true as const }
      : {}),
    ...(replayRouting.readableReplayAttemptIds.length > 0
      ? { continueProductWorkflowReplayAttemptIds: replayRouting.readableReplayAttemptIds }
      : {}),
    ...(replayRouting.completedReplayAttemptIds.length > 0
      ? { completedProductWorkflowReplayAttemptIds: replayRouting.completedReplayAttemptIds }
      : {}),
  });
}

export async function readTerminalSourceLinkWorkflowReplayAttemptState(
  client: RecoveryReads,
  input: {
    readonly organizationId: Ulid;
    readonly operationId: Ulid;
    readonly attemptId: Ulid;
    readonly actorId: string;
    readonly idempotencyDigest: Uint8Array;
  },
): Promise<Readonly<{ outcome: "completed"; attemptId: Ulid }> | null> {
  for (const value of [input.organizationId, input.operationId, input.attemptId]) parseUlid(value);
  if (!isPrincipal(input.actorId) || input.idempotencyDigest.byteLength !== 32) {
    throw new TypeError("SourceLink terminal Workflow replay identity is invalid");
  }

  const replay = await client.select<{
    attempt_id: string;
    event_id: string;
    logical_workflow_id: string;
  }>(
    `SELECT attempt.attempt_id,attempt.event_id,attempt.logical_workflow_id
       FROM product_workflow_replay_attempts attempt
      WHERE attempt.attempt_id=?1 AND attempt.organization_id=?2 AND attempt.operation_id=?3
        AND attempt.actor_id=?4 AND attempt.idempotency_sha256=?5
        AND attempt.event_type='SourceLinkRequestedV1'
        AND attempt.physical_workflow_id='product-command-replay-v1-' || attempt.attempt_id
        AND (
          EXISTS(
            SELECT 1 FROM product_workflow_replay_failures failure
             WHERE failure.attempt_id=attempt.attempt_id
               AND failure.organization_id=attempt.organization_id
               AND failure.operation_id=attempt.operation_id
               AND failure.physical_workflow_id=attempt.physical_workflow_id
               AND failure.actor_id=attempt.actor_id
               AND failure.terminal_status IN ('errored','terminated')
          )
          OR EXISTS(
            SELECT 1 FROM audit_events audit
             WHERE audit.organization_id=attempt.organization_id
               AND audit.project_id=attempt.project_id AND audit.operation_id=attempt.operation_id
               AND audit.billing_epoch_id=attempt.billing_epoch_id
               AND audit.event_type='ProductWorkflowReconciliationRequired'
               AND audit.actor_type='system' AND audit.occurred_at>=attempt.created_at
               AND (json_type(audit.payload)='object' AND (SELECT count(*) FROM json_each(audit.payload))=3 AND json_extract(audit.payload, '$.errorCode') IS ('PROVIDER_OBSERVATION_UNCERTAIN') AND json_extract(audit.payload, '$.workflowId') IS (attempt.logical_workflow_id) AND json_extract(audit.payload, '$.replayAttemptId') IS (attempt.attempt_id))
          )
        )`,
    [
      input.attemptId,
      input.organizationId,
      input.operationId,
      input.actorId,
      Buffer.from(input.idempotencyDigest),
    ],
  );
  const row = replay.rows[0];
  if (replay.rowCount === 0 || row === undefined) return null;
  if (
    replay.rowCount !== 1 ||
    row.attempt_id !== input.attemptId ||
    !isUlidString(row.event_id) ||
    row.logical_workflow_id !== sourceLinkWorkflowId(row.event_id, input.operationId)
  ) {
    throw new Error("SourceLink terminal Workflow replay evidence is invalid");
  }
  return Object.freeze({ outcome: "completed", attemptId: parseUlid(row.attempt_id) });
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
            run.billing_epoch_id,run.event_id,run.workflow_id,intent.installation_id,
            intent.repository_owner,intent.repository_name,operation.state AS operation_state,
            operation.failure AS operation_failure,run.state AS workflow_state,
            run.terminal_evidence AS workflow_terminal_evidence,
            run.intermediate_evidence AS workflow_intermediate_evidence,
            run.reconciliation_code AS workflow_reconciliation_code,
            run.active_reconciliation_attempt_id,run.active_replay_attempt_id,
            ownership.state AS ownership_state,project.lifecycle_state
       FROM product_workflow_runs run
       INNER JOIN product_command_intents intent
         ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
        AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
        AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
       INNER JOIN operations operation
         ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id
        AND operation.operation_id=run.operation_id AND operation.billing_epoch_id=run.billing_epoch_id
       INNER JOIN environments environment
         ON environment.organization_id=run.organization_id AND environment.project_id=run.project_id
        AND environment.environment_id=run.environment_id
       INNER JOIN projects project ON project.project_id=run.project_id AND project.owner_state<>'transferred'
       INNER JOIN (SELECT organization_id,project_id,active_billing_epoch_id,owner_state AS state FROM projects WHERE owner_state<>'transferred') ownership
         ON ownership.organization_id=run.organization_id AND ownership.project_id=run.project_id
        AND ownership.active_billing_epoch_id=run.billing_epoch_id
       WHERE run.organization_id=?1 AND run.project_id=?2 AND run.operation_id=?3 AND run.event_id=?4
         AND run.event_type='SourceLinkRequestedV1'`,
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
  const deliveryHistory = await lockExactSourceLinkDeliveryHistory(client, event);
  const attempt = deliveryHistory.finalAttempt;
  const claim = await client.select<{ present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM product_provider_mutation_claims
        WHERE organization_id=?1 AND project_id=?2
     ) AS present`,
    [scope.organization_id, scope.project_id],
  );
  const source = await readSourceTerminalState(client, scope);
  return Object.freeze({
    scope,
    event,
    attempt,
    deliveryHistory,
    hasProviderClaim: claim.rows[0]?.present === true,
    source,
  });
}

export async function readExactSourceLinkWorkflowReplayContinuation(
  client: RecoveryReads,
  candidate: RecoveryCandidate,
  evidence: ReturnType<typeof parseFinalEvidence>,
  actorId: string,
): Promise<SourceLinkWorkflowReplayContinuation | null> {
  if (!isReplayContinuationEligibleEvidence(evidence)) return null;
  const chain = await loadExactSourceLinkWorkflowReplayChain(client, candidate);
  const first = chain[0];
  const latest = chain.at(-1);
  const expectedDigest = Buffer.from(evidence.idempotencySha256.slice("sha256:".length), "hex");
  if (first === undefined || latest === undefined) return null;
  if (
    first.attempt_id !== evidence.reconciliationId ||
    first.actor_id !== actorId ||
    !Buffer.isBuffer(first.idempotency_sha256) ||
    !first.idempotency_sha256.equals(expectedDigest)
  ) {
    return null;
  }
  for (const [index, attempt] of chain.entries()) {
    if (
      !isUlidString(attempt.attempt_id) ||
      attempt.attempt_number !== index + 1 ||
      attempt.physical_workflow_id !== `product-command-replay-v1-${attempt.attempt_id}` ||
      attempt.actor_id.trim() !== attempt.actor_id ||
      attempt.actor_id.length === 0 ||
      attempt.actor_id.length > 255 ||
      !Buffer.isBuffer(attempt.idempotency_sha256) ||
      attempt.idempotency_sha256.byteLength !== 32
    ) {
      throw new Error("SourceLink Queue recovery Workflow replay chain is invalid");
    }
    if (index < chain.length - 1 && attempt.terminal_retryable_evidence_present !== true) {
      throw new Error("SourceLink Queue recovery Workflow replay chain is not retryable");
    }
  }
  const continuation = await readSourceLinkWorkflowReplayContinuationStatus(
    client,
    candidate,
    latest,
  );
  if (continuation === null) return null;
  const replayAttemptIds = chain.map((attempt) => parseUlid(attempt.attempt_id));
  return Object.freeze({
    ...continuation,
    replayAttemptIds: Object.freeze(replayAttemptIds),
    completedReplayAttemptIds: Object.freeze(replayAttemptIds.slice(0, -1)),
  });
}

export async function loadExactSourceLinkWorkflowReplayChain(
  client: RecoveryReads,
  candidate: RecoveryCandidate,
): Promise<readonly SourceLinkWorkflowReplayChainRow[]> {
  const { scope } = candidate;
  const chain = await client.select<SourceLinkWorkflowReplayChainRow>(
    `SELECT attempt.attempt_id,attempt.attempt_number,attempt.physical_workflow_id,attempt.actor_id,
            lower(hex(attempt.idempotency_sha256)) AS idempotency_sha256,
            (
              EXISTS(
                SELECT 1 FROM product_workflow_replay_failures failure
                 WHERE failure.attempt_id=attempt.attempt_id
                   AND failure.organization_id=attempt.organization_id
                   AND failure.operation_id=attempt.operation_id
                   AND failure.physical_workflow_id=attempt.physical_workflow_id
                   AND failure.actor_id=attempt.actor_id
                   AND failure.terminal_status IN ('errored','terminated')
              )
              OR EXISTS(
                SELECT 1 FROM audit_events audit
                 WHERE audit.organization_id=attempt.organization_id
                   AND audit.project_id=attempt.project_id AND audit.operation_id=attempt.operation_id
                   AND audit.billing_epoch_id=attempt.billing_epoch_id
                   AND audit.event_type='ProductWorkflowReconciliationRequired'
                   AND audit.actor_type='system' AND audit.occurred_at>=attempt.created_at
                   AND (json_type(audit.payload)='object' AND (SELECT count(*) FROM json_each(audit.payload))=3 AND json_extract(audit.payload, '$.errorCode') IS ('PROVIDER_OBSERVATION_UNCERTAIN') AND json_extract(audit.payload, '$.workflowId') IS (attempt.logical_workflow_id) AND json_extract(audit.payload, '$.replayAttemptId') IS (attempt.attempt_id))
              )
            ) AS terminal_retryable_evidence_present
       FROM product_workflow_replay_attempts attempt
      WHERE attempt.organization_id=?1 AND attempt.project_id=?2 AND attempt.environment_id=?3
        AND attempt.operation_id=?4 AND attempt.event_id=?5 AND attempt.billing_epoch_id=?6
        AND attempt.logical_workflow_id=?7 AND attempt.event_type='SourceLinkRequestedV1'
      ORDER BY attempt.attempt_number`,
    [
      scope.organization_id,
      scope.project_id,
      scope.environment_id,
      scope.operation_id,
      scope.event_id,
      scope.billing_epoch_id,
      scope.workflow_id,
    ],
  );
  return Object.freeze([...chain.rows]);
}

export async function readSourceLinkWorkflowReplayContinuationStatus(
  client: RecoveryReads,
  candidate: RecoveryCandidate,
  attempt: SourceLinkWorkflowReplayChainRow,
): Promise<Omit<
  SourceLinkWorkflowReplayContinuation,
  "replayAttemptIds" | "completedReplayAttemptIds"
> | null> {
  const { scope } = candidate;
  const expectedPhysicalWorkflowId = `product-command-replay-v1-${attempt.attempt_id}`;
  const replay = await client.select<SourceLinkWorkflowReplayRow>(
    `SELECT attempt.attempt_id,attempt.physical_workflow_id,operation.state AS operation_state,
            run.state AS workflow_state,run.active_reconciliation_attempt_id,
            run.active_replay_attempt_id,run.reconciliation_code AS workflow_reconciliation_code,
            run.terminal_evidence AS workflow_terminal_evidence,
            run.intermediate_evidence AS workflow_intermediate_evidence,failure.failure_id,
            failure.terminal_status AS failure_terminal_status,
            failure.physical_workflow_id AS failure_physical_workflow_id,
            failure.actor_id AS failure_actor_id,
            EXISTS(
              SELECT 1 FROM audit_events audit
               WHERE audit.organization_id=attempt.organization_id
                 AND audit.project_id=attempt.project_id AND audit.operation_id=attempt.operation_id
                 AND audit.billing_epoch_id=attempt.billing_epoch_id
                 AND audit.event_type='ProductWorkflowReconciliationRequired'
                 AND audit.actor_type='system' AND audit.occurred_at>=attempt.created_at
                 AND (json_type(audit.payload)='object' AND (SELECT count(*) FROM json_each(audit.payload))=3 AND json_extract(audit.payload, '$.errorCode') IS ('PROVIDER_OBSERVATION_UNCERTAIN') AND json_extract(audit.payload, '$.workflowId') IS (attempt.logical_workflow_id) AND json_extract(audit.payload, '$.replayAttemptId') IS (attempt.attempt_id))
            ) AS reconciliation_evidence_present
       FROM product_workflow_replay_attempts attempt
       INNER JOIN product_workflow_runs run
         ON run.workflow_id=attempt.logical_workflow_id AND run.event_id=attempt.event_id
        AND run.organization_id=attempt.organization_id AND run.project_id=attempt.project_id
        AND run.environment_id=attempt.environment_id AND run.operation_id=attempt.operation_id
        AND run.billing_epoch_id=attempt.billing_epoch_id AND run.event_type=attempt.event_type
       INNER JOIN operations operation
         ON operation.organization_id=attempt.organization_id AND operation.project_id=attempt.project_id
        AND operation.operation_id=attempt.operation_id AND operation.billing_epoch_id=attempt.billing_epoch_id
       LEFT JOIN product_workflow_replay_failures failure
         ON failure.attempt_id=attempt.attempt_id
        AND failure.organization_id=attempt.organization_id AND failure.operation_id=attempt.operation_id
        AND failure.physical_workflow_id=attempt.physical_workflow_id AND failure.actor_id=attempt.actor_id
      WHERE attempt.attempt_id=?1 AND attempt.organization_id=?2 AND attempt.project_id=?3
        AND attempt.environment_id=?4 AND attempt.operation_id=?5 AND attempt.event_id=?6
        AND attempt.billing_epoch_id=?7 AND attempt.logical_workflow_id=?8
        AND attempt.event_type='SourceLinkRequestedV1' AND attempt.actor_id=?9
        AND attempt.idempotency_sha256=?10`,
    [
      attempt.attempt_id,
      scope.organization_id,
      scope.project_id,
      scope.environment_id,
      scope.operation_id,
      scope.event_id,
      scope.billing_epoch_id,
      scope.workflow_id,
      attempt.actor_id,
      attempt.idempotency_sha256,
    ],
  );
  const row = replay.rows[0];
  if (replay.rowCount === 0 || row === undefined) return null;
  if (
    replay.rowCount !== 1 ||
    row.attempt_id !== attempt.attempt_id ||
    row.physical_workflow_id !== expectedPhysicalWorkflowId ||
    !isOperationState(row.operation_state) ||
    !isWorkflowState(row.workflow_state)
  ) {
    throw new Error("SourceLink Queue recovery Workflow replay evidence is invalid");
  }
  const hasTerminalFailure =
    row.failure_id !== null &&
    isUlidString(row.failure_id) &&
    (row.failure_terminal_status === "errored" || row.failure_terminal_status === "terminated") &&
    row.failure_physical_workflow_id === expectedPhysicalWorkflowId &&
    row.failure_actor_id === attempt.actor_id;
  if (row.failure_id !== null && !hasTerminalFailure) {
    throw new Error("SourceLink Queue recovery Workflow replay failure is invalid");
  }
  const hasRetryableTerminalFailure =
    hasTerminalFailure &&
    row.operation_state === "queued" &&
    scope.operation_failure === null &&
    row.workflow_state === "queued" &&
    row.workflow_terminal_evidence === null &&
    row.workflow_intermediate_evidence === null &&
    row.workflow_reconciliation_code === null &&
    row.active_reconciliation_attempt_id === null &&
    row.active_replay_attempt_id === null &&
    !hasTerminalSourceState(candidate.source);
  const hasRetryableReconciliationEvidence =
    row.reconciliation_evidence_present === true &&
    row.operation_state === "queued" &&
    scope.operation_failure === null &&
    row.workflow_state === "reconciliation_required" &&
    row.workflow_terminal_evidence === null &&
    row.workflow_intermediate_evidence === null &&
    row.workflow_reconciliation_code === "PROVIDER_OBSERVATION_UNCERTAIN" &&
    row.active_reconciliation_attempt_id === null &&
    row.active_replay_attempt_id === null &&
    !hasTerminalSourceState(candidate.source);
  if (
    row.operation_state === "queued" &&
    scope.operation_failure === null &&
    row.workflow_state === "queued" &&
    scope.workflow_terminal_evidence === null &&
    scope.workflow_intermediate_evidence === null &&
    scope.workflow_reconciliation_code === null &&
    row.active_reconciliation_attempt_id === null &&
    row.active_replay_attempt_id === attempt.attempt_id &&
    !hasTerminalFailure &&
    !hasTerminalSourceState(candidate.source)
  ) {
    return Object.freeze({
      kind: "active",
      hasTerminalFailure: false,
      isTerminalRetryable: false,
    });
  }
  if (
    row.active_reconciliation_attempt_id === null &&
    row.active_replay_attempt_id === null &&
    (hasTerminalFailure ||
      row.workflow_state === "completed" ||
      row.workflow_state === "reconciliation_required" ||
      row.operation_state === "succeeded" ||
      row.operation_state === "failed")
  ) {
    return Object.freeze({
      kind: "terminal",
      hasTerminalFailure,
      isTerminalRetryable: hasRetryableTerminalFailure || hasRetryableReconciliationEvidence,
    });
  }
  return null;
}
