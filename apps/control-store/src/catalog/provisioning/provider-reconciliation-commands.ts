import { z } from "zod";
import { parseUlid } from "@ohmyhost/platform";
import type {
  PrepareProductProviderReconciliationInput,
  PreparedProductProviderReconciliation,
  ProductProviderReconciliationAttemptReplay,
  ProductProviderReconciliationHint,
  ProductProviderMutationEvent,
} from "@ohmyhost/database";
import { generatedJsonb } from "../../jsonb-generated.js";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  routeOrganization,
  ulid,
  hexBytes,
  publicTimestamp,
  type CatalogContext,
} from "../common.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import {
  readProductProviderReconciliationPlan,
  snapshotGuards,
} from "./provider-reconciliation.js";
import { readContextSnapshot, type ContextRead, type ContextRows } from "./context-queries.js";
import { hex, integer, text, type Row } from "./context-values.js";
const identity = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => value.trim() === value);
const digest = z.custom<Uint8Array>(
  (value) => value instanceof Uint8Array && value.byteLength === 32,
);
const millisecond = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const findInput = z.strictObject({ organizationId: ulid, operationId: ulid });
const replayInput = findInput.extend({
  attemptId: ulid,
  actorId: identity,
  idempotencyDigest: digest,
});
const observation = z.strictObject({
  state: z.enum(["unknown", "absent", "ready"]),
  providerTag: z.string().optional(),
  observedAt: z.string().optional(),
});
const prepareInput = z.strictObject({
  attemptId: ulid,
  observationId: ulid,
  claimId: ulid,
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  eventId: ulid,
  logicalWorkflowId: identity,
  physicalWorkflowId: identity,
  mode: z.enum(["retry", "abandon"]),
  idempotencyDigest: digest,
  evidenceDigest: digest,
  gateway: observation,
  wfp: observation.extend({
    productDeploymentId: ulid.optional(),
    artifactDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/u)
      .optional(),
  }),
  actorId: identity,
  startedOperationEventId: ulid,
  operationEventId: ulid,
  auditEventId: ulid,
  preparedAt: millisecond,
});
const terminalInput = z.strictObject({
  attemptId: ulid,
  observationId: ulid,
  auditEventId: ulid,
  physicalWorkflowId: identity,
  organizationId: ulid,
  operationId: ulid,
  actorId: identity,
  terminalStatus: z.enum(["errored", "terminated"]),
  evidenceDigest: digest,
  recoveredAt: millisecond,
});
const fail = (message: string) => new ProductWorkflowContextConflictError(message);

const READ_ATTEMPT = `SELECT attempt.claim_id,attempt.attempt_id,attempt.physical_workflow_id,attempt.outcome,
            attempt.event_id,attempt.project_id,attempt.environment_id,attempt.billing_epoch_id,
            attempt.event_type,intent.plan_id,operation.state operation_state
     FROM product_provider_reconciliation_attempts attempt
     INNER JOIN product_command_intents intent
       ON intent.organization_id=attempt.organization_id AND intent.project_id=attempt.project_id
      AND intent.environment_id=attempt.environment_id AND intent.operation_id=attempt.operation_id
      AND intent.billing_epoch_id=attempt.billing_epoch_id AND intent.event_type=attempt.event_type
     INNER JOIN operations operation
       ON operation.organization_id=attempt.organization_id
      AND operation.project_id=attempt.project_id AND operation.operation_id=attempt.operation_id
     WHERE attempt.organization_id=?1 AND attempt.operation_id=?2 AND attempt.attempt_id=?3
       AND attempt.actor_id=?4 AND attempt.idempotency_sha256=?5`;

const REPLAY = `SELECT attempt.attempt_id,attempt.claim_id,attempt.physical_workflow_id,attempt.mode,
            attempt.outcome,attempt.idempotency_sha256,intent.event_type,intent.plan_id,
            attempt.billing_epoch_id
     FROM product_provider_reconciliation_attempts attempt
     LEFT JOIN product_command_intents intent
       ON intent.organization_id=attempt.organization_id AND intent.project_id=attempt.project_id
      AND intent.environment_id=attempt.environment_id AND intent.operation_id=attempt.operation_id
     WHERE attempt.attempt_id=?1 OR (attempt.claim_id=?2 AND attempt.idempotency_sha256=?3)`;

const PREPARE_AUTH = `SELECT claim.billing_epoch_id,claim.event_type,claim.accepted_lifecycle_version,
            intent.plan_id,intent.deployment_id,
            run.intermediate_evidence
     FROM product_provider_mutation_claims claim
     INNER JOIN product_workflow_runs run
       ON run.workflow_id=claim.logical_workflow_id AND run.event_id=claim.event_id
      AND run.organization_id=claim.organization_id AND run.project_id=claim.project_id
      AND run.environment_id=claim.environment_id AND run.operation_id=claim.operation_id
      AND run.billing_epoch_id=claim.billing_epoch_id AND run.event_type=claim.event_type
     INNER JOIN product_command_intents intent
       ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id
      AND intent.environment_id=claim.environment_id AND intent.operation_id=claim.operation_id
      AND intent.billing_epoch_id=claim.billing_epoch_id AND intent.event_type=claim.event_type
     INNER JOIN deployments deployment
       ON deployment.organization_id=claim.organization_id AND deployment.project_id=claim.project_id
      AND deployment.operation_id=claim.operation_id AND deployment.deployment_id=intent.deployment_id
     INNER JOIN operations operation
       ON operation.organization_id=claim.organization_id AND operation.project_id=claim.project_id
      AND operation.operation_id=claim.operation_id
     INNER JOIN projects project ON project.project_id=claim.project_id
     WHERE claim.claim_id=?1 AND claim.organization_id=?2 AND claim.project_id=?3
       AND claim.environment_id=?4 AND claim.operation_id=?5 AND claim.event_id=?6
       AND claim.logical_workflow_id=?7 AND run.state='reconciliation_required'
       AND run.active_reconciliation_attempt_id IS NULL
       AND deployment.status='reconciliation_required' AND operation.state IN ('queued','running')
       AND project.lifecycle_state='active'
       AND project.lifecycle_version=claim.accepted_lifecycle_version AND project.owner_state='active'`;

const FIND_CLAIM = `SELECT claim.project_id,claim.environment_id,claim.claim_id,claim.event_id,
            claim.logical_workflow_id,run.state workflow_state,
            CASE
              WHEN EXISTS (
                SELECT 1 FROM neon_project_placement_reservations placement
                WHERE placement.claim_id=claim.claim_id
                  AND placement.organization_id=claim.organization_id
                  AND placement.project_id=claim.project_id
                  AND placement.environment_id=claim.environment_id
                  AND placement.operation_id=claim.operation_id
              ) THEN 'database'
              WHEN EXISTS (
                SELECT 1 FROM build_receipts build
                WHERE build.organization_id=claim.organization_id
                  AND build.project_id=claim.project_id
                  AND build.environment_id=claim.environment_id
                  AND build.operation_id=claim.operation_id
              ) THEN 'build'
              ELSE 'source'
            END provider_phase
     FROM product_provider_mutation_claims claim
     INNER JOIN product_workflow_runs run
       ON run.workflow_id=claim.logical_workflow_id AND run.event_id=claim.event_id
      AND run.organization_id=claim.organization_id AND run.project_id=claim.project_id
      AND run.environment_id=claim.environment_id AND run.operation_id=claim.operation_id
     WHERE claim.organization_id=?1 AND claim.operation_id=?2
       AND claim.event_type<>'ProjectDataChangeRequestedV1'
       AND run.state IN ('queued','reconciliation_required')`;

const FIND_CLAIMLESS = `SELECT run.project_id,run.environment_id,run.event_id,run.workflow_id logical_workflow_id,
            run.event_type,project.lifecycle_version AS accepted_lifecycle_version
     FROM product_workflow_runs run
     INNER JOIN product_command_intents intent
       ON intent.organization_id=run.organization_id AND intent.project_id=run.project_id
      AND intent.environment_id=run.environment_id AND intent.operation_id=run.operation_id
      AND intent.billing_epoch_id=run.billing_epoch_id AND intent.event_type=run.event_type
     INNER JOIN operations operation
       ON operation.organization_id=run.organization_id AND operation.project_id=run.project_id
      AND operation.operation_id=run.operation_id
     INNER JOIN deployments deployment
       ON deployment.organization_id=intent.organization_id AND deployment.project_id=intent.project_id
      AND deployment.operation_id=intent.operation_id AND deployment.deployment_id=intent.deployment_id
     INNER JOIN projects project ON project.project_id=run.project_id
     WHERE run.organization_id=?1 AND run.operation_id=?2
       AND run.event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1')
       AND run.state='reconciliation_required' AND run.active_reconciliation_attempt_id IS NULL
       AND operation.state IN ('queued','running') AND deployment.status='reconciliation_required'
       AND project.lifecycle_state='active'
       AND project.owner_state='active'
       AND NOT EXISTS (
         SELECT 1 FROM product_provider_mutation_claims claim
         WHERE claim.organization_id=run.organization_id AND claim.operation_id=run.operation_id
       )`;

const TERMINAL = `SELECT attempt.claim_id,attempt.project_id,attempt.environment_id,attempt.event_id,
            attempt.billing_epoch_id,attempt.logical_workflow_id,attempt.event_type,
            attempt.accepted_lifecycle_version,attempt.attempt_number,run.state workflow_state,
            deployment.status deployment_state,run.active_reconciliation_attempt_id,
            observation.hint_phase,observation.expected_artifact_sha256,
            observation.hint_provider_tag,observation.hint_product_deployment_id
     FROM product_provider_reconciliation_attempts attempt
     INNER JOIN product_provider_mutation_observations observation
       ON observation.observation_id=attempt.observation_id
      AND observation.claim_id=attempt.claim_id
     INNER JOIN product_provider_mutation_claims claim
       ON claim.claim_id=attempt.claim_id AND claim.organization_id=attempt.organization_id
      AND claim.project_id=attempt.project_id AND claim.environment_id=attempt.environment_id
      AND claim.operation_id=attempt.operation_id AND claim.event_id=attempt.event_id
      AND claim.billing_epoch_id=attempt.billing_epoch_id
      AND claim.logical_workflow_id=attempt.logical_workflow_id
      AND claim.event_type=attempt.event_type
      AND claim.accepted_lifecycle_version=attempt.accepted_lifecycle_version
     INNER JOIN product_workflow_runs run
       ON run.workflow_id=claim.logical_workflow_id AND run.event_id=claim.event_id
      AND run.organization_id=claim.organization_id AND run.project_id=claim.project_id
      AND run.environment_id=claim.environment_id AND run.operation_id=claim.operation_id
      AND run.billing_epoch_id=claim.billing_epoch_id AND run.event_type=claim.event_type
     INNER JOIN product_command_intents intent
       ON intent.organization_id=claim.organization_id AND intent.project_id=claim.project_id
      AND intent.environment_id=claim.environment_id AND intent.operation_id=claim.operation_id
      AND intent.billing_epoch_id=claim.billing_epoch_id AND intent.event_type=claim.event_type
     INNER JOIN deployments deployment
       ON deployment.organization_id=claim.organization_id
      AND deployment.project_id=claim.project_id AND deployment.deployment_id=intent.deployment_id
     INNER JOIN operations operation
       ON operation.organization_id=claim.organization_id
      AND operation.project_id=claim.project_id AND operation.operation_id=claim.operation_id
     WHERE attempt.attempt_id=?1 AND attempt.physical_workflow_id=?2
       AND attempt.organization_id=?3 AND attempt.operation_id=?4 AND attempt.actor_id=?5
       AND attempt.mode='retry' AND attempt.outcome='prepared' AND operation.state IN ('queued','running')`;

const TERMINAL_REPLAY = `SELECT 1 FROM product_provider_mutation_observations observation
       INNER JOIN audit_events audit
         ON audit.organization_id=observation.organization_id
        AND audit.project_id=observation.project_id AND audit.operation_id=observation.operation_id
       WHERE observation.observation_id=?1 AND observation.claim_id=?2
         AND observation.observation_kind='execution_failure'
         AND observation.attempt_number=?3 AND observation.evidence_sha256=?4
         AND audit.audit_event_id=?5 AND audit.event_type='ProductProviderReconciliationExecutionFailed'
         AND audit.actor_id=?6`;

const KNOWN_ARTIFACT = `SELECT 1 FROM wfp_publish_receipts receipt
             INNER JOIN deployment_revisions revision
               ON revision.organization_id=receipt.organization_id
              AND revision.project_id=receipt.project_id
              AND revision.wfp_receipt_id=receipt.wfp_receipt_id
             INNER JOIN build_artifacts artifact
               ON artifact.organization_id=revision.organization_id
              AND artifact.project_id=revision.project_id AND artifact.artifact_id=revision.artifact_id
             WHERE receipt.organization_id=?1 AND receipt.project_id=?2 AND receipt.environment_id=?3
               AND revision.deployment_id=?4 AND artifact.artifact_sha256=?5`;

const CURRENT_DEPLOYMENT = `SELECT 1 FROM product_command_intents intent
             WHERE intent.organization_id=?1 AND intent.project_id=?2
               AND intent.environment_id=?3 AND intent.operation_id=?4
               AND intent.event_type IN ('DeploymentRequestedV1','DeploymentRollbackRequestedV1','DeploymentPromotionRequestedV1')
               AND intent.deployment_id=?5`;

const RETAINED_ABSENCE = `SELECT 1 FROM product_command_intents intent
       JOIN environments environment ON environment.organization_id=intent.organization_id
         AND environment.project_id=intent.project_id AND environment.environment_id=intent.environment_id
       JOIN deployment_revisions revision ON revision.organization_id=environment.organization_id
         AND revision.project_id=environment.project_id AND revision.deployment_id=environment.active_deployment_id
         AND revision.revision_id=environment.active_revision_id
       JOIN wfp_publish_receipts receipt ON receipt.organization_id=revision.organization_id
         AND receipt.project_id=revision.project_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id
       WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3
         AND intent.operation_id=?4 AND intent.event_type='DeploymentRollbackRequestedV1'
         AND environment.active_deployment_id<>intent.target_deployment_id
         AND 'sha256:'||lower(hex(receipt.gateway_provider_tag))=?5
         AND EXISTS (SELECT 1 FROM product_provider_mutation_observations observation
           WHERE observation.claim_id=?6 AND observation.observation_kind='preflight'
             AND observation.gateway_state='ready' AND observation.gateway_provider_tag=?5
             AND observation.wfp_state='absent'
             AND observation.created_at<=?7)`;

const PRIOR_ABSENCE = `SELECT 1 FROM product_provider_mutation_observations
         WHERE claim_id=?1 AND observation_kind='preflight'
           AND gateway_state='absent' AND wfp_state='absent'
           AND created_at<=?2
         ORDER BY attempt_number DESC LIMIT 1`;

/** All original claim candidates; the fixed read projects original provider-phase precedence. */
export async function findProductProviderReconciliationClaim(
  context: CatalogContext,
  raw: unknown,
) {
  const input = findInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db.prepare(FIND_CLAIM).bind(input.organizationId, input.operationId).first<Row>();
  return row === null
    ? null
    : {
        organizationId: parseUlid(input.organizationId),
        projectId: parseUlid(text(row, "project_id")),
        environmentId: parseUlid(text(row, "environment_id")),
        operationId: parseUlid(input.operationId),
        claimId: parseUlid(text(row, "claim_id")),
        eventId: parseUlid(text(row, "event_id")),
        logicalWorkflowId: text(row, "logical_workflow_id"),
        workflowState: row["workflow_state"] as "queued" | "reconciliation_required",
        providerPhase: row["provider_phase"] as "source" | "build" | "database",
      };
}
export async function findClaimlessProductProviderReconciliationCandidate(
  context: CatalogContext,
  raw: unknown,
) {
  const input = findInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(FIND_CLAIMLESS)
      .bind(input.organizationId, input.operationId)
      .first<Row>();
  return row === null
    ? null
    : {
        organizationId: parseUlid(input.organizationId),
        projectId: parseUlid(text(row, "project_id")),
        environmentId: parseUlid(text(row, "environment_id")),
        operationId: parseUlid(input.operationId),
        eventId: parseUlid(text(row, "event_id")),
        logicalWorkflowId: text(row, "logical_workflow_id"),
        eventType: text(row, "event_type") as ProductProviderMutationEvent,
        acceptedLifecycleVersion: integer(row["accepted_lifecycle_version"], 1),
      };
}
function original(
  input: {
    organizationId: string;
    operationId: string;
    eventId?: string;
    projectId?: string;
    environmentId?: string;
  },
  row: Row,
): Readonly<Record<string, unknown>> {
  return {
    version: 1,
    eventType: row["event_type"],
    eventId: input.eventId ?? row["event_id"],
    organizationId: input.organizationId,
    projectId: input.projectId ?? row["project_id"],
    billingEpochId: row["billing_epoch_id"],
    environmentId: input.environmentId ?? row["environment_id"],
    operationId: input.operationId,
    ...(row["event_type"] === "DeploymentRequestedV1" && row["plan_id"] !== null
      ? { planId: row["plan_id"] }
      : {}),
  };
}
export async function readProductProviderReconciliationAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<ProductProviderReconciliationAttemptReplay | null> {
  const input = replayInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(READ_ATTEMPT)
      .bind(
        input.organizationId,
        input.operationId,
        input.attemptId,
        input.actorId,
        input.idempotencyDigest,
      )
      .first<Row>();
  if (row === null) return null;
  const attemptId = parseUlid(text(row, "attempt_id"));
  return row["outcome"] !== "prepared" ||
    !["queued", "running"].includes(String(row["operation_state"]))
    ? { outcome: "completed", attemptId }
    : {
        outcome: "prepared",
        attemptId,
        claimId: parseUlid(text(row, "claim_id")),
        physicalWorkflowId: text(row, "physical_workflow_id"),
        originalMessage: original(input, row),
      };
}
async function facts(db: D1Database, reads: readonly ContextRead[]) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const rows = await readContextSnapshot(db, reads);
    if (rows !== null)
      return { rows, guards: (target: D1Database) => snapshotGuards(target, reads, rows) };
  }
  throw fail("Provider reconciliation facts changed while reading");
}
type Facts = Awaited<ReturnType<typeof facts>>;
function replay(
  input: PrepareProductProviderReconciliationInput,
  row: Row | undefined,
): PreparedProductProviderReconciliation | null {
  if (row === undefined) return null;
  if (
    row["claim_id"] !== input.claimId ||
    row["physical_workflow_id"] !== input.physicalWorkflowId ||
    row["mode"] !== input.mode ||
    hex(row["idempotency_sha256"]) !== hex(input.idempotencyDigest)
  )
    throw fail("Provider reconciliation replay changed");
  const attemptId = parseUlid(text(row, "attempt_id"));
  return row["outcome"] === "resolved_absent"
    ? { outcome: "resolved_absent", attemptId }
    : row["outcome"] === "unknown"
      ? { outcome: "unknown", attemptId }
      : {
          outcome: "prepared",
          attemptId,
          physicalWorkflowId: text(row, "physical_workflow_id"),
          originalMessage: original(input, row),
        };
}
function preflightSafe(
  input: PrepareProductProviderReconciliationInput,
  hint: ProductProviderReconciliationHint,
  eventType: ProductProviderMutationEvent,
  rows: readonly ContextRows[],
): boolean {
  const exists = (index: number) => (rows[index]?.length ?? 0) === 1;
  const gatewayAllowed =
    input.gateway.state === "ready" ||
    input.gateway.state === "absent" ||
    (input.gateway.state === "unknown" &&
      input.gateway.providerTag !== undefined &&
      hint.currentProviderTag !== null &&
      input.gateway.providerTag === hint.currentProviderTag);
  const knownArtifact = exists(4),
    currentDeployment =
      input.wfp.state === "ready" &&
      input.wfp.providerTag !== undefined &&
      input.wfp.productDeploymentId !== undefined &&
      input.wfp.artifactDigest !== undefined &&
      exists(5) &&
      (hint.currentProviderTag === undefined ||
        hint.currentProviderTag === null ||
        input.wfp.providerTag === hint.currentProviderTag) &&
      (hint.currentProductDeploymentId === undefined ||
        input.wfp.productDeploymentId === hint.currentProductDeploymentId) &&
      (hint.expectedArtifactDigest === undefined ||
        input.wfp.artifactDigest === hint.expectedArtifactDigest);
  const wfpAllowed =
    input.wfp.state === "absent" ||
    (input.wfp.state === "ready" && (knownArtifact || currentDeployment)) ||
    (input.wfp.state === "unknown" &&
      input.wfp.providerTag !== undefined &&
      input.wfp.providerTag === hint.currentProviderTag &&
      input.wfp.productDeploymentId !== undefined &&
      input.wfp.productDeploymentId === hint.currentProductDeploymentId &&
      input.wfp.artifactDigest !== undefined &&
      hint.expectedArtifactDigest !== undefined &&
      input.wfp.artifactDigest === hint.expectedArtifactDigest);
  if (input.mode === "retry") {
    if (["source", "build", "database", "runtime-secrets", "storage"].includes(hint.phase))
      return true;
    if (hint.phase === "gateway") return gatewayAllowed;
    const unstagedArtifactReuse =
      (eventType === "DeploymentPromotionRequestedV1" ||
        eventType === "DeploymentRollbackRequestedV1") &&
      input.gateway.state === "unknown" &&
      input.wfp.state === "unknown" &&
      hint.currentProviderTag === undefined &&
      hint.currentProductDeploymentId === undefined &&
      hint.expectedArtifactDigest === undefined;
    const unstagedCandidate =
      (hint.currentProviderTag === undefined || hint.currentProviderTag === null) &&
      (hint.currentProductDeploymentId === undefined || hint.currentProductDeploymentId === null) &&
      !exists(6);
    return unstagedArtifactReuse || unstagedCandidate || (gatewayAllowed && wfpAllowed);
  }
  if (
    eventType === "DeploymentRollbackRequestedV1" &&
    input.gateway.state === "ready" &&
    input.wfp.state === "absent" &&
    input.gateway.observedAt !== undefined &&
    input.wfp.observedAt !== undefined &&
    input.gateway.providerTag !== undefined
  )
    return exists(7);
  return (
    input.gateway.state === "absent" &&
    input.wfp.state === "absent" &&
    input.gateway.observedAt !== undefined &&
    input.wfp.observedAt !== undefined &&
    exists(8)
  );
}
function preparedReads(input: PrepareProductProviderReconciliationInput): ContextRead[] {
  const values = [input.organizationId, input.projectId, input.environmentId, input.operationId],
    before = storedTimestamp(new Date(Date.parse(input.preparedAt) - 5000).toISOString());
  const optional = (
    condition: boolean,
    sql: string,
    parameters: readonly unknown[],
  ): ContextRead => (condition ? { sql, parameters } : { sql: "SELECT 1 WHERE 0", parameters: [] });
  return [
    {
      sql: PREPARE_AUTH,
      parameters: [input.claimId, ...values, input.eventId, input.logicalWorkflowId],
    },
    {
      sql: `SELECT 1 FROM product_provider_reconciliation_attempts attempt WHERE attempt.claim_id=?1 AND attempt.outcome='prepared' AND NOT EXISTS(SELECT 1 FROM product_provider_mutation_observations observation WHERE observation.claim_id=attempt.claim_id AND observation.attempt_number=attempt.attempt_number AND observation.observation_kind IN('uncertainty','execution_failure')) LIMIT 1`,
      parameters: [input.claimId],
    },
    {
      sql: "SELECT CAST(count(*)+1 AS TEXT) next_attempt FROM product_provider_reconciliation_attempts WHERE claim_id=?1",
      parameters: [input.claimId],
    },
    {
      sql: "SELECT event_type,occurred_at FROM operation_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND revision=1",
      parameters: [input.organizationId, input.projectId, input.operationId],
    },
    optional(
      input.wfp.productDeploymentId !== undefined && input.wfp.artifactDigest !== undefined,
      KNOWN_ARTIFACT,
      [
        ...values.slice(0, 3),
        input.wfp.productDeploymentId ?? null,
        input.wfp.artifactDigest === undefined ? null : hexBytes(input.wfp.artifactDigest.slice(7)),
      ],
    ),
    optional(
      input.wfp.state === "ready" &&
        input.wfp.providerTag !== undefined &&
        input.wfp.productDeploymentId !== undefined &&
        input.wfp.artifactDigest !== undefined,
      CURRENT_DEPLOYMENT,
      [...values, input.wfp.productDeploymentId ?? null],
    ),
    {
      sql: "SELECT 1 FROM wfp_candidate_receipts WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 LIMIT 1",
      parameters: values,
    },
    optional(
      input.gateway.state === "ready" &&
        input.wfp.state === "absent" &&
        input.gateway.observedAt !== undefined &&
        input.wfp.observedAt !== undefined &&
        input.gateway.providerTag !== undefined,
      RETAINED_ABSENCE,
      [...values, input.gateway.providerTag ?? null, input.claimId, before],
    ),
    optional(
      input.gateway.observedAt !== undefined && input.wfp.observedAt !== undefined,
      PRIOR_ABSENCE,
      [input.claimId, before],
    ),
    // Appended last: the index of every read above stays fixed. A dispatched Native Auth create has an unknown outcome.
    {
      sql: "SELECT 1 FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?4 AND state='dispatched' LIMIT 1",
      parameters: values,
    },
  ];
}
/** Original preflight observation + attempt + optional abandonment are one guarded batch. */
export async function prepareProductProviderReconciliation(
  context: CatalogContext,
  raw: unknown,
): Promise<PreparedProductProviderReconciliation> {
  const parsed = prepareInput.parse(raw),
    input = parsed as PrepareProductProviderReconciliationInput;
  validatePreparedReconciliation(input);
  const { db } = await routeOrganization(context, input.organizationId);
  type Snapshot = {
    replay: Row | undefined;
    proof: Awaited<ReturnType<typeof readProductProviderReconciliationPlan>> | null;
    facts: Facts | null;
  };
  const command: Command<Snapshot, PreparedProductProviderReconciliation> = {
    name: "provisioning.prepareProviderReconciliation",
    input,
    retryOn: ["operation_conflict"],
    naturalKeyTables: [
      "product_provider_mutation_observations",
      "product_provider_reconciliation_attempts",
      "operation_events",
      "audit_events",
    ],
    read: async (reader) => {
      const replayRow = await reader
        .prepare(REPLAY)
        .bind(input.attemptId, input.claimId, input.idempotencyDigest)
        .first<Row>();
      if (replayRow !== null) return { replay: replayRow, proof: null, facts: null };
      return {
        replay: undefined,
        proof: await readProductProviderReconciliationPlan(context, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          environmentId: input.environmentId,
          operationId: input.operationId,
          claimId: input.claimId,
        }),
        facts: await facts(reader, preparedReads(input)),
      };
    },
    decide: (s) => {
      const existing = replay(input, s.replay);
      if (existing !== null) return { replay: existing };
      const proof = s.proof,
        current = proof?.value,
        f = s.facts,
        authorized = f?.rows[0]?.[0];
      if (
        !proof ||
        !current ||
        !f ||
        !authorized ||
        current.eventId !== input.eventId ||
        current.logicalWorkflowId !== input.logicalWorkflowId
      )
        return { reject: fail("Provider reconciliation scope changed") };
      if ((f.rows[1]?.length ?? 0) !== 0)
        return { reject: fail("A prepared provider reconciliation attempt is still active") };
      // Abandoning a create whose outcome is unknown would fail an operation whose database may exist: refuse it.
      const nativeCreateUnresolved = (f.rows[9]?.length ?? 0) !== 0;
      const attemptNumber = integer(f.rows[2]?.[0]?.["next_attempt"], 1);
      if (attemptNumber > 32)
        return { reject: fail("Provider reconciliation attempts are exhausted") };
      const safe = preflightSafe(input, current.providerHint, current.eventType, f.rows),
        outcome = safe ? (input.mode === "retry" ? "prepared" : "resolved_absent") : "unknown";
      if (outcome === "resolved_absent" && nativeCreateUnresolved)
        return { reject: fail("Native Auth database create is unresolved") };
      const now = storedTimestamp(input.preparedAt),
        hint = current.providerHint;
      const statements: D1PreparedStatement[] = [
        ...proof.guards(db),
        ...f.guards(db),
        db
          .prepare(
            `INSERT INTO product_provider_mutation_observations(observation_id,claim_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,logical_workflow_id,event_type,accepted_lifecycle_version,observation_kind,attempt_number,evidence_sha256,hint_phase,expected_artifact_sha256,hint_provider_tag,hint_product_deployment_id,source_state,build_state,gateway_state,gateway_provider_tag,gateway_observed_at,wfp_state,wfp_provider_tag,wfp_product_deployment_id,wfp_artifact_sha256,wfp_observed_at,actor_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'preflight',?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29)`,
          )
          .bind(
            input.observationId,
            input.claimId,
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.operationId,
            input.eventId,
            current.billingEpochId,
            input.logicalWorkflowId,
            current.eventType,
            current.acceptedLifecycleVersion,
            attemptNumber,
            input.evidenceDigest,
            hint.phase,
            hint.expectedArtifactDigest === undefined
              ? null
              : hexBytes(hint.expectedArtifactDigest.slice(7)),
            hint.currentProviderTag ?? null,
            hint.currentProductDeploymentId ?? null,
            current.sourceState,
            current.buildState,
            input.gateway.state,
            input.gateway.providerTag ?? null,
            input.gateway.observedAt === undefined
              ? null
              : storedTimestamp(input.gateway.observedAt),
            input.wfp.state,
            input.wfp.providerTag ?? null,
            input.wfp.productDeploymentId ?? null,
            input.wfp.artifactDigest === undefined
              ? null
              : hexBytes(input.wfp.artifactDigest.slice(7)),
            input.wfp.observedAt === undefined ? null : storedTimestamp(input.wfp.observedAt),
            input.actorId,
            now,
          ),
        db
          .prepare(
            `INSERT INTO product_provider_reconciliation_attempts(attempt_id,observation_id,claim_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,logical_workflow_id,event_type,accepted_lifecycle_version,physical_workflow_id,mode,outcome,idempotency_sha256,attempt_number,actor_id,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)`,
          )
          .bind(
            input.attemptId,
            input.observationId,
            input.claimId,
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.operationId,
            input.eventId,
            current.billingEpochId,
            input.logicalWorkflowId,
            current.eventType,
            current.acceptedLifecycleVersion,
            input.physicalWorkflowId,
            input.mode,
            outcome,
            input.idempotencyDigest,
            attemptNumber,
            input.actorId,
            now,
          ),
      ];
      if (outcome === "resolved_absent") {
        const start = f.rows[3]?.[0];
        if (
          start !== undefined &&
          (start["event_type"] !== "OperationStarted" ||
            publicTimestamp(text(start, "occurred_at")) > input.preparedAt)
        )
          return { reject: fail("Operation start evidence conflicts") };
        statements.push(
          db
            .prepare(
              `UPDATE deployments SET status='failed',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND deployment_id=?3 AND status='reconciliation_required'`,
            )
            .bind(input.organizationId, input.projectId, authorized["deployment_id"], now),
          db
            .prepare(
              `UPDATE operations SET state='failed',failure=?4,updated_at=?5,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state IN('queued','running')`,
            )
            .bind(
              input.organizationId,
              input.projectId,
              input.operationId,
              generatedJsonb({
                code: "provider_state_absent",
                message: "The deployment could not be completed.",
              }),
              now,
            ),
          db
            .prepare(
              `UPDATE product_workflow_runs SET state='completed',reconciliation_code=NULL,active_reconciliation_attempt_id=NULL,terminal_evidence=?2,updated_at=?3,completed_at=?3 WHERE workflow_id=?1 AND state='reconciliation_required'`,
            )
            .bind(
              input.logicalWorkflowId,
              generatedJsonb({ resolution: "abandoned", attemptId: input.attemptId }),
              now,
            ),
        );
        if (start === undefined)
          statements.push(
            db
              .prepare(
                `INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,1,'OperationStarted',?5,'{}',?6)`,
              )
              .bind(
                input.organizationId,
                input.startedOperationEventId,
                input.operationId,
                input.projectId,
                `${input.physicalWorkflowId}:start`,
                now,
              ),
          );
        statements.push(
          db
            .prepare(
              `INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,2,'OperationFailed',?5,?6,?7)`,
            )
            .bind(
              input.organizationId,
              input.operationEventId,
              input.operationId,
              input.projectId,
              `provider-reconciliation:${input.attemptId}`,
              generatedJsonb({
                failure: {
                  code: "provider_state_absent",
                  message: "The deployment could not be completed.",
                },
              }),
              now,
            ),
          db
            .prepare(
              `INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'ProductProviderReconciliationAbandoned','system',?5,?6,?7,?8)`,
            )
            .bind(
              input.organizationId,
              input.auditEventId,
              input.projectId,
              input.operationId,
              input.actorId,
              generatedJsonb({ attemptId: input.attemptId }),
              now,
              current.billingEpochId,
            ),
          db
            .prepare("DELETE FROM product_provider_mutation_claims WHERE claim_id=?1")
            .bind(input.claimId),
        );
      }
      const value: PreparedProductProviderReconciliation =
        outcome === "prepared"
          ? {
              outcome: "prepared",
              attemptId: input.attemptId,
              physicalWorkflowId: input.physicalWorkflowId,
              originalMessage: current.originalMessage,
            }
          : { outcome, attemptId: input.attemptId };
      return { statements, result: () => value };
    },
  };
  // operation_conflict is a retried guard: the end of the budget is store_busy, never a mapped domain error
  return runCommand(db, command);
}

function validatePreparedReconciliation(input: PrepareProductProviderReconciliationInput): void {
  for (const id of [
    input.attemptId,
    input.observationId,
    input.claimId,
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.operationId,
    input.eventId,
    input.startedOperationEventId,
    input.operationEventId,
    input.auditEventId,
  ])
    parseUlid(id);
  for (const value of [input.logicalWorkflowId, input.physicalWorkflowId, input.actorId])
    if (value.trim() !== value || value.length === 0 || value.length > 255)
      throw new TypeError("Provider reconciliation identity is invalid");
  if (
    (input.mode !== "retry" && input.mode !== "abandon") ||
    input.idempotencyDigest.byteLength !== 32 ||
    input.evidenceDigest.byteLength !== 32 ||
    new Date(input.preparedAt).toISOString() !== input.preparedAt
  )
    throw new TypeError("Provider reconciliation input is invalid");
  for (const observation of [input.gateway]) {
    const keys = Object.keys(observation).sort().join(",");
    if (
      !["observedAt,providerTag,state", "observedAt,state", "providerTag,state", "state"].includes(
        keys,
      ) ||
      !["unknown", "absent", "ready"].includes(observation.state) ||
      (observation.state === "ready" && observation.providerTag === undefined) ||
      (observation.state === "absent" && observation.providerTag !== undefined) ||
      (observation.observedAt !== undefined &&
        new Date(observation.observedAt).toISOString() !== observation.observedAt)
    )
      throw new TypeError("Provider observation is invalid");
  }
  const wfpKeys = Object.keys(input.wfp).sort().join(",");
  if (
    ![
      "artifactDigest,observedAt,productDeploymentId,providerTag,state",
      "artifactDigest,productDeploymentId,providerTag,state",
      "observedAt,state",
      "state",
    ].includes(wfpKeys) ||
    !["unknown", "absent", "ready"].includes(input.wfp.state) ||
    (input.wfp.state === "ready" &&
      (input.wfp.providerTag === undefined ||
        input.wfp.productDeploymentId === undefined ||
        input.wfp.artifactDigest === undefined)) ||
    (input.wfp.state === "absent" &&
      (input.wfp.providerTag !== undefined ||
        input.wfp.productDeploymentId !== undefined ||
        input.wfp.artifactDigest !== undefined)) ||
    (input.wfp.productDeploymentId !== undefined && !parseUlid(input.wfp.productDeploymentId)) ||
    (input.wfp.artifactDigest !== undefined &&
      !/^sha256:[0-9a-f]{64}$/u.test(input.wfp.artifactDigest)) ||
    (input.wfp.observedAt !== undefined &&
      new Date(input.wfp.observedAt).toISOString() !== input.wfp.observedAt)
  )
    throw new TypeError("WFP provider observation is invalid");
}

/** Physical terminal observation, original claim/run state and audit remain one atomic effect. */
export async function recoverTerminalProductProviderReconciliationAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<"recovered" | "existing"> {
  const input = terminalInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const values = [
    input.attemptId,
    input.physicalWorkflowId,
    input.organizationId,
    input.operationId,
    input.actorId,
  ];
  type Snapshot = { scope: Facts; prior: Facts | null };
  const command: Command<Snapshot, "recovered" | "existing"> = {
    name: "provisioning.recoverTerminalProviderReconciliation",
    input,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["product_provider_mutation_observations", "audit_events"],
    read: async (reader) => {
      const scope = await facts(reader, [{ sql: TERMINAL, parameters: values }]),
        row = scope.rows[0]?.[0];
      return {
        scope,
        prior:
          row === undefined
            ? null
            : await facts(reader, [
                {
                  sql: TERMINAL_REPLAY,
                  parameters: [
                    input.observationId,
                    row["claim_id"],
                    row["attempt_number"],
                    input.evidenceDigest,
                    input.auditEventId,
                    input.actorId,
                  ],
                },
              ]),
      };
    },
    decide: (snapshot) => {
      const row = snapshot.scope.rows[0]?.[0];
      if (row === undefined) return { reject: fail("Terminal reconciliation scope changed") };
      const before =
          row["workflow_state"] === "reconciliation_required" &&
          row["deployment_state"] === "reconciliation_required" &&
          row["active_reconciliation_attempt_id"] === null,
        after =
          row["workflow_state"] === "queued" &&
          ["queued", "running"].includes(String(row["deployment_state"])) &&
          row["active_reconciliation_attempt_id"] === input.attemptId;
      if (before && (snapshot.prior?.rows[0]?.length ?? 0) === 1) return { replay: "existing" };
      if (!before && !after) return { reject: fail("Terminal reconciliation state changed") };
      const now = storedTimestamp(input.recoveredAt),
        statements: D1PreparedStatement[] = [
          ...snapshot.scope.guards(db),
          ...(snapshot.prior?.guards(db) ?? []),
          db
            .prepare(
              `INSERT INTO product_provider_mutation_observations(observation_id,claim_id,organization_id,project_id,environment_id,operation_id,event_id,billing_epoch_id,logical_workflow_id,event_type,accepted_lifecycle_version,observation_kind,attempt_number,evidence_sha256,hint_phase,expected_artifact_sha256,hint_provider_tag,hint_product_deployment_id,source_state,build_state,gateway_state,wfp_state,actor_id,created_at)
          VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'execution_failure',?12,?13,?14,?15,?16,?17,'unknown','unknown','unknown','unknown',?18,?19)`,
            )
            .bind(
              input.observationId,
              row["claim_id"],
              input.organizationId,
              row["project_id"],
              row["environment_id"],
              input.operationId,
              row["event_id"],
              row["billing_epoch_id"],
              row["logical_workflow_id"],
              row["event_type"],
              row["accepted_lifecycle_version"],
              row["attempt_number"],
              input.evidenceDigest,
              row["hint_phase"],
              row["expected_artifact_sha256"],
              row["hint_provider_tag"],
              row["hint_product_deployment_id"],
              input.actorId,
              now,
            ),
          db
            .prepare(
              `INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id)
          VALUES(?1,?2,?3,?4,'ProductProviderReconciliationExecutionFailed','principal',?5,?6,?7,?8)`,
            )
            .bind(
              input.organizationId,
              input.auditEventId,
              row["project_id"],
              input.operationId,
              input.actorId,
              generatedJsonb({
                attemptId: input.attemptId,
                physicalWorkflowId: input.physicalWorkflowId,
                terminalStatus: input.terminalStatus,
              }),
              now,
              row["billing_epoch_id"],
            ),
        ];
      if (after)
        statements.push(
          db
            .prepare(
              `UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='PHYSICAL_WORKFLOW_TERMINAL',active_reconciliation_attempt_id=NULL,updated_at=?3 WHERE workflow_id=?1 AND state='queued' AND active_reconciliation_attempt_id=?2`,
            )
            .bind(row["logical_workflow_id"], input.attemptId, now),
          guard(db, "operation_conflict", "changes()<>1"),
          db
            .prepare(
              `UPDATE deployments SET status='reconciliation_required',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND status='running'`,
            )
            .bind(input.organizationId, row["project_id"], input.operationId, now),
          guard(db, "operation_conflict", "changes()<>1"),
        );
      return { statements, result: () => "recovered" };
    },
  };
  return runCommand(db, command);
}
