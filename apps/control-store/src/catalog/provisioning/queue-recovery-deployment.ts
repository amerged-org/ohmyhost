import { parseUlid } from "@ohmyhost/platform";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { readProductProviderReconciliationPlan } from "./provider-reconciliation.js";
import * as D from "./queue-recovery-deployment-logic.js";
import * as R from "./queue-recovery-deployment-reads.js";
import {
  runRecoveryDecision,
  recoveryAudit,
  type RecoveryReads,
} from "./queue-recovery-snapshot.js";
const timestamp = (at: string) => at.replace(/\.(\d{3})Z$/u, ".$1000Z");
function audit(
  db: D1Database,
  c: D.RecoveryCandidate,
  i: D.DeploymentQueueDeliveryRecoveryIdentityInput,
  final: boolean,
  at: string,
  payload: unknown,
) {
  return recoveryAudit(db, {
    organizationId: c.scope.organization_id,
    auditEventId: final ? i.finalAuditEventId : i.preparedAuditEventId,
    projectId: c.scope.project_id,
    operationId: c.scope.operation_id,
    billingEpochId: c.scope.billing_epoch_id,
    eventType: final
      ? D.DEPLOYMENT_QUEUE_DELIVERY_RECOVERED
      : D.DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED,
    actorId: i.actorId,
    payload,
    occurredAt: at,
  });
}
export async function prepareDeploymentQueueDeliveryRecovery(
  context: CatalogContext,
  raw: unknown,
): Promise<D.DeploymentQueueDeliveryRecoveryPreparation> {
  const i = raw as D.PrepareDeploymentQueueDeliveryRecoveryInput;
  D.assertPreparationInput(i);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<D.DeploymentQueueDeliveryRecoveryPreparation>(
    db,
    "queueRecovery.prepareDeployment",
    i,
    async (reader) => {
      const replay = await R.readFinalDeploymentQueueDeliveryRecovery(reader, i);
      if (replay) return { statements: [], value: replay };
      const scope = await R.lockRecoveryScope(reader, i);
      if (scope === undefined)
        return { statements: [], value: await R.classifyAbsentRecoveryScope(reader, i) };
      const c = await R.lockRecoveryCandidate(reader, scope),
        all = await R.loadRecoveryAuditsForScope(reader, scope),
        final = all.filter((a) => a.event_type === D.DEPLOYMENT_QUEUE_DELIVERY_RECOVERED),
        prepared = all.filter(
          (a) => a.event_type === D.DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED,
        );
      if (c === null || !D.isOpenRecoveryDelivery(c)) {
        if (final.length) return { statements: [], value: { outcome: "not_applicable" } };
        if (prepared.length)
          throw new Error("Deployment Queue recovery prepared audit conflicts with its Outbox");
        if (c !== null && D.isUnacknowledgedReconciliationSignal(c.event))
          throw new Error(
            "Deployment event is not an exact final Queue-delivery recovery candidate",
          );
        return { statements: [], value: { outcome: "not_applicable" } };
      }
      if (!D.isScopeIdentity(c.scope, c.event))
        throw new Error("Deployment event is not an exact final Queue-delivery recovery candidate");
      if (final.length)
        throw new Error("Deployment Queue recovery final audit conflicts with its open Outbox");
      if (prepared.length) {
        if (prepared.length !== 1 || !prepared[0])
          throw new Error("Deployment Queue recovery prepared audit is ambiguous");
        if (prepared[0].audit_event_id !== i.preparedAuditEventId)
          throw new Error("A different Deployment Queue recovery is already prepared");
        D.assertPreparedAudit(prepared[0], c, i);
        return { statements: [], value: D.preparedRecovery(c, i) };
      }
      if (c.hasProviderClaim) {
        if (!c.providerClaimMatchesScope)
          throw new Error(
            "Deployment event is not an exact final Queue-delivery recovery candidate",
          );
        if (!D.isProviderContinuationRecoveryCandidate(c))
          return { statements: [], value: { outcome: "not_applicable" } };
      } else if (!D.isInitialRecoveryCandidate(c))
        throw new Error("Deployment event is not an exact final Queue-delivery recovery candidate");
      if (
        D.parseTimestamp(i.preparedAt, "Deployment Queue recovery preparation time") <
        D.requiredFailureAt(c)
      )
        throw new RangeError(
          "Deployment Queue recovery preparation time must not predate the final delivery failure",
        );
      return {
        statements: [audit(db, c, i, false, i.preparedAt, D.preparedPayload(c, i))],
        value: D.preparedRecovery(c, i),
      };
    },
  );
}
/** Same original context, plus its fixed guard plan in this batch. A prior DTO never authorizes the close. */
async function providerContinuation(
  context: CatalogContext,
  reader: RecoveryReads,
  c: D.RecoveryCandidate,
) {
  if (
    D.durableOutcome(c.scope) !== "provider_reconciliation" ||
    !c.hasProviderClaim ||
    !c.providerClaimMatchesScope
  )
    return null;
  const claim = await reader.select<{ claim_id: string }>(
    "SELECT claim_id FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND billing_epoch_id=?5 AND event_id=?6 AND logical_workflow_id=?7 AND event_type=?8",
    [
      c.scope.organization_id,
      c.scope.project_id,
      c.scope.environment_id,
      c.scope.operation_id,
      c.scope.billing_epoch_id,
      c.scope.event_id,
      c.scope.workflow_id,
      c.scope.event_type,
    ],
  );
  const claimId = claim.rows[0]?.claim_id;
  if (claim.rowCount !== 1 || claimId === undefined) return null;
  try {
    const proof = await readProductProviderReconciliationPlan(context, {
        organizationId: parseUlid(c.scope.organization_id),
        projectId: parseUlid(c.scope.project_id),
        environmentId: parseUlid(c.scope.environment_id),
        operationId: parseUlid(c.scope.operation_id),
        claimId: parseUlid(claimId),
      }),
      value = proof.value;
    if (
      !value ||
      typeof proof.guards !== "function" ||
      value.claimId !== claimId ||
      value.organizationId !== c.scope.organization_id ||
      value.projectId !== c.scope.project_id ||
      value.environmentId !== c.scope.environment_id ||
      value.operationId !== c.scope.operation_id ||
      value.eventId !== c.scope.event_id ||
      value.billingEpochId !== c.scope.billing_epoch_id ||
      value.logicalWorkflowId !== c.scope.workflow_id ||
      value.eventType !== c.scope.event_type
    )
      return null;
    return proof;
  } catch {
    return null;
  }
}
export async function finalizeDeploymentQueueDeliveryRecovery(
  context: CatalogContext,
  raw: unknown,
): Promise<D.FinalizeDeploymentQueueDeliveryRecoveryResult> {
  const i = raw as D.FinalizeDeploymentQueueDeliveryRecoveryInput;
  D.assertFinalizationInput(i);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<D.FinalizeDeploymentQueueDeliveryRecoveryResult>(
    db,
    "queueRecovery.finalizeDeployment",
    i,
    async (reader) => {
      const scope = await R.lockRecoveryScope(reader, i),
        c = scope === undefined ? null : await R.lockRecoveryCandidate(reader, scope);
      if (c === null || !D.isRecoveryScope(c)) {
        const replay = await R.readFinalDeploymentQueueDeliveryRecovery(reader, i);
        if (replay) return { statements: [], value: { ...replay, outcome: "duplicate" } };
        throw new Error("Deployment event is not an exact final Queue-delivery recovery candidate");
      }
      D.assertFinalizationScope(c, i);
      const all = await R.loadRecoveryAudits(reader, c),
        prepared = all.filter(
          (a) => a.event_type === D.DEPLOYMENT_QUEUE_DELIVERY_RECOVERY_PREPARED,
        );
      if (prepared.length !== 1 || !prepared[0])
        throw new Error("Deployment Queue recovery requires one exact prepared audit");
      D.assertPreparedAudit(prepared[0], c, i);
      if (all.some((a) => a.event_type === D.DEPLOYMENT_QUEUE_DELIVERY_RECOVERED))
        throw new Error("Deployment Queue recovery final audit conflicts with its open Outbox");
      const resolution = D.resolveFinalization(c, i.workflowOutcome),
        uncertain = {
          outcome: "uncertain" as const,
          reconciliationId: parseUlid(i.reconciliationId),
          operationId: parseUlid(i.operationId),
          state: "uncertain" as const,
        };
      if (resolution.state === "uncertain") return { statements: [], value: uncertain };
      const proof =
        resolution.continueProviderReconciliation === true
          ? await providerContinuation(context, reader, c)
          : null;
      if (resolution.continueProviderReconciliation === true && !proof)
        return { statements: [], value: uncertain };
      const at = D.parseTimestamp(i.recoveredAt, "Deployment Queue recovery completion time");
      if (at < D.requiredFailureAt(c))
        throw new RangeError(
          "Deployment Queue recovery completion time must not predate the final delivery failure",
        );
      if (at < prepared[0].occurred_at)
        throw new RangeError(
          "Deployment Queue recovery completion time must not predate the prepared recovery audit",
        );
      return {
        statements: [
          ...(proof?.guards(db) ?? []),
          db
            .prepare(
              "UPDATE outbox_events SET acknowledged_at=?2,reconciliation_required_at=NULL WHERE event_id=?1 RETURNING 1",
            )
            .bind(c.event.event_id, timestamp(i.recoveredAt)),
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM outbox_events WHERE event_id=?1 AND acknowledged_at=?2 AND reconciliation_required_at IS NULL)",
            [c.event.event_id, timestamp(i.recoveredAt)],
          ),
          audit(db, c, i, true, i.recoveredAt, D.finalPayload(c, i, resolution.state)),
        ],
        value: {
          outcome: "recovered",
          reconciliationId: parseUlid(i.reconciliationId),
          operationId: parseUlid(i.operationId),
          state: resolution.state,
          ...(resolution.continueProviderReconciliation === true
            ? { continueProviderReconciliation: true as const }
            : {}),
        },
      };
    },
  );
}
