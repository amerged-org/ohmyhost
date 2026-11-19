import { z } from "zod";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import { routeOrganization, ulid, fenceRaceGuard, type CatalogContext } from "../common.js";
import { ProductWorkflowContextConflictError } from "./context.js";
const scopeInput = z.strictObject({
  attemptId: ulid,
  physicalWorkflowId: z
    .string()
    .min(1)
    .max(255)
    .refine((v) => v.trim() === v),
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  eventId: ulid,
});
const providerInput = scopeInput.extend({
  eventType: z.enum([
    "DeploymentRequestedV1",
    "DeploymentRollbackRequestedV1",
    "DeploymentPromotionRequestedV1",
  ]),
});
const providerScope = `SELECT run.workflow_id,intent.deployment_id,run.state workflow_state,deployment.status deployment_state,run.active_reconciliation_attempt_id
 FROM product_provider_reconciliation_attempts attempt JOIN product_provider_mutation_claims claim ON claim.claim_id=attempt.claim_id AND claim.organization_id=attempt.organization_id AND claim.project_id=attempt.project_id AND claim.environment_id=attempt.environment_id AND claim.operation_id=attempt.operation_id AND claim.event_id=attempt.event_id AND claim.billing_epoch_id=attempt.billing_epoch_id AND claim.logical_workflow_id=attempt.logical_workflow_id AND claim.event_type=attempt.event_type AND claim.accepted_lifecycle_version=attempt.accepted_lifecycle_version
 JOIN product_command_intents intent ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id AND intent.environment_id=claim.environment_id AND intent.operation_id=claim.operation_id AND intent.billing_epoch_id=claim.billing_epoch_id AND intent.event_type=claim.event_type
 JOIN product_workflow_runs run ON run.workflow_id=claim.logical_workflow_id AND run.event_id=claim.event_id AND run.organization_id=claim.organization_id AND run.project_id=claim.project_id AND run.environment_id=claim.environment_id AND run.operation_id=claim.operation_id AND run.billing_epoch_id=claim.billing_epoch_id AND run.event_type=claim.event_type
 JOIN deployments deployment ON deployment.organization_id=claim.organization_id AND deployment.project_id=claim.project_id AND deployment.deployment_id=intent.deployment_id
 JOIN operations operation ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
 JOIN projects project ON project.organization_id=claim.organization_id AND project.project_id=claim.project_id
 WHERE attempt.attempt_id=?1 AND attempt.physical_workflow_id=?2 AND attempt.organization_id=?3 AND attempt.project_id=?4 AND attempt.environment_id=?5 AND attempt.operation_id=?6 AND attempt.event_id=?7 AND attempt.event_type=?8 AND attempt.mode='retry' AND attempt.outcome='prepared'
 AND operation.state IN('queued','running') AND project.lifecycle_state='active' AND project.lifecycle_version=claim.accepted_lifecycle_version AND project.owner_state='active'`;
const now = "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')";
type Row = Record<string, unknown>;
/** Activate only the exact original prepared reconciliation attempt. This grants no provider permission. */
export async function activateProductProviderReconciliationAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<"activated" | "existing"> {
  const i = providerInput.parse(raw),
    { db } = await routeOrganization(context, i.organizationId),
    values = [
      i.attemptId,
      i.physicalWorkflowId,
      i.organizationId,
      i.projectId,
      i.environmentId,
      i.operationId,
      i.eventId,
      i.eventType,
    ];
  const active = (r: Row | null) =>
    r?.["workflow_state"] === "queued" &&
    r["deployment_state"] === "running" &&
    r["active_reconciliation_attempt_id"] === i.attemptId;
  const conflict = () =>
    new ProductWorkflowContextConflictError("Provider reconciliation activation changed");
  const command: Command<Row | null, "activated" | "existing"> = {
    name: "provisioning.activateReconciliationAttempt",
    input: i,
    retryOn: ["operation_conflict"],
    read: (reader) =>
      reader
        .prepare(providerScope)
        .bind(...values)
        .first<Row>(),
    decide: (r) => {
      if (active(r)) return { replay: "existing" };
      if (
        !r ||
        r["workflow_state"] !== "reconciliation_required" ||
        r["deployment_state"] !== "reconciliation_required" ||
        r["active_reconciliation_attempt_id"] !== null
      )
        return { reject: conflict() };
      return {
        statements: [
          fenceRaceGuard(db, "operation_conflict", i.organizationId),
          guard(
            db,
            "operation_conflict",
            `NOT EXISTS(SELECT 1 FROM(${providerScope}) WHERE workflow_state='reconciliation_required' AND deployment_state='reconciliation_required' AND active_reconciliation_attempt_id IS NULL)`,
            values,
          ),
          db
            .prepare(
              `UPDATE product_workflow_runs SET state='queued',reconciliation_code=NULL,active_reconciliation_attempt_id=?2,updated_at=${now} WHERE workflow_id=?1 AND state='reconciliation_required' AND active_reconciliation_attempt_id IS NULL`,
            )
            .bind(r["workflow_id"], i.attemptId),
          guard(db, "operation_conflict", "changes()<>1"),
          db
            .prepare(
              `UPDATE deployments SET status='running',updated_at=${now} WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3 AND status='reconciliation_required'`,
            )
            .bind(i.organizationId, i.projectId, r["deployment_id"]),
          guard(db, "operation_conflict", "changes()<>1"),
        ],
        result: () => "activated",
      };
    },
    lookup: async (reader) =>
      active(
        await reader
          .prepare(providerScope)
          .bind(...values)
          .first<Row>(),
      )
        ? "existing"
        : undefined,
  };
  return runCommand(db, command);
}
const replayScope = `SELECT 1 FROM product_workflow_replay_attempts attempt
 JOIN product_workflow_runs run ON run.workflow_id=attempt.logical_workflow_id AND run.event_id=attempt.event_id AND run.organization_id=attempt.organization_id AND run.project_id=attempt.project_id AND run.environment_id=attempt.environment_id AND run.operation_id=attempt.operation_id AND run.billing_epoch_id=attempt.billing_epoch_id AND run.event_type=attempt.event_type
 JOIN operations operation ON operation.organization_id=attempt.organization_id AND operation.project_id=attempt.project_id AND operation.operation_id=attempt.operation_id
 JOIN projects project ON project.project_id=attempt.project_id AND project.owner_state<>'transferred'
 LEFT JOIN product_command_intents intent ON intent.organization_id=attempt.organization_id AND intent.project_id=attempt.project_id AND intent.environment_id=attempt.environment_id AND intent.operation_id=attempt.operation_id AND intent.billing_epoch_id=attempt.billing_epoch_id AND intent.event_type=attempt.event_type
 LEFT JOIN cleanup_runs cleanup ON cleanup.organization_id=intent.organization_id AND cleanup.project_id=intent.project_id AND cleanup.operation_id=intent.operation_id AND cleanup.cleanup_run_id=intent.cleanup_run_id
 WHERE attempt.attempt_id=?1 AND attempt.physical_workflow_id=?2 AND attempt.organization_id=?3 AND attempt.project_id=?4 AND attempt.environment_id=?5 AND attempt.operation_id=?6 AND attempt.event_id=?7
 AND run.state='queued' AND run.active_replay_attempt_id=attempt.attempt_id AND run.active_reconciliation_attempt_id IS NULL AND operation.state IN('queued','running') AND NOT EXISTS(SELECT 1 FROM product_workflow_replay_failures failure WHERE failure.attempt_id=attempt.attempt_id)
 AND((attempt.event_type IN('SourceLinkRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1') AND project.lifecycle_state='active') OR(attempt.event_type='ProjectDeletionRequestedV1' AND project.lifecycle_state='deleting' AND cleanup.state='running') OR(attempt.event_type='ProjectDataChangeRequestedV1' AND project.lifecycle_state='active' AND cleanup.state='running'))`;
/** Original replay activation is a read-only check of its immutable attempt and current active pointer. */
export async function activateProductWorkflowReplayAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<"active"> {
  const i = scopeInput.parse(raw);
  if (i.physicalWorkflowId !== `product-command-replay-v1-${i.attemptId}`)
    throw new TypeError("Product Workflow replay execution identity is invalid");
  const { db } = await routeOrganization(context, i.organizationId),
    row = await db
      .prepare(replayScope)
      .bind(
        i.attemptId,
        i.physicalWorkflowId,
        i.organizationId,
        i.projectId,
        i.environmentId,
        i.operationId,
        i.eventId,
      )
      .first();
  if (row === null)
    throw new ProductWorkflowContextConflictError("Product Workflow replay is no longer active");
  return "active";
}
