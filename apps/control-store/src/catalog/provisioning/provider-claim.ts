import { z } from "zod";
import { guard } from "../../guards.js";
import {
  runMapped,
  conflict,
  fenceRaceGuard,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import type { Command } from "../../run-command.js";
import { assertOperationDelegationCurrent } from "../identity/operation-delegations.js";
import { ProductWorkflowContextConflictError } from "./context.js";
import { readWorkflowDelegation, workflowExecutionGuards } from "./authority.js";
import { nativeDomainPreparationGuard } from "../identity/native-auth-domain-snapshot.js";

export const claimProviderMutationInput = z.strictObject({
  claimId: ulid,
  organizationId: ulid,
  projectId: ulid,
  environmentId: ulid,
  operationId: ulid,
  eventId: ulid,
  logicalWorkflowId: z
    .string()
    .min(1)
    .max(255)
    .refine((value) => value.trim() === value),
  eventType: z.enum([
    "DeploymentRequestedV1",
    "DeploymentRollbackRequestedV1",
    "DeploymentPromotionRequestedV1",
    "ProjectHandleChangeRequestedV1",
    "ProjectDataChangeRequestedV1",
  ]),
  acceptedLifecycleVersion: z.number().int().min(1).max(2147483647),
});
const AUTHORIZED = `SELECT intent.billing_epoch_id,run.created_at AS started_at,operation.state AS operation_state,
 (SELECT count(*) FROM operation_events event WHERE event.organization_id=operation.organization_id AND event.operation_id=operation.operation_id) AS event_count
 FROM product_command_intents intent JOIN operations operation ON operation.organization_id=intent.organization_id AND operation.project_id=intent.project_id AND operation.operation_id=intent.operation_id
 JOIN projects project ON project.organization_id=intent.organization_id AND project.project_id=intent.project_id AND project.owner_state='active' AND project.active_billing_epoch_id=intent.billing_epoch_id
 JOIN billing_epochs epoch ON epoch.organization_id=intent.organization_id AND epoch.project_id=intent.project_id AND epoch.billing_epoch_id=intent.billing_epoch_id AND epoch.ended_at IS NULL
 JOIN environments environment ON environment.organization_id=intent.organization_id AND environment.project_id=intent.project_id AND environment.environment_id=intent.environment_id
 JOIN product_workflow_runs run ON run.workflow_id=?7 AND run.event_id=?8 AND run.organization_id=intent.organization_id AND run.project_id=intent.project_id
  AND run.environment_id=intent.environment_id AND run.operation_id=intent.operation_id AND run.billing_epoch_id=intent.billing_epoch_id AND run.event_type=intent.event_type
 WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?4 AND intent.event_type=?5
  AND operation.state IN('queued','running') AND project.lifecycle_state='active' AND project.lifecycle_version=?6 AND run.state IN('queued','reconciliation_required')`;
const PROMOTION = `SELECT 1 FROM product_command_intents intent
 JOIN environments source ON source.organization_id=intent.organization_id AND source.project_id=intent.project_id AND source.environment_id=intent.source_environment_id AND source.name='dev'
  AND source.active_deployment_id=intent.source_deployment_id AND source.active_revision_id=intent.source_revision_id AND source.head_version=intent.expected_source_head_version
 JOIN environments target ON target.organization_id=intent.organization_id AND target.project_id=intent.project_id AND target.environment_id=intent.environment_id AND target.name='prod' AND target.head_version=intent.expected_target_head_version
 JOIN deployments deployment ON deployment.organization_id=intent.organization_id AND deployment.project_id=intent.project_id AND deployment.environment_id=intent.source_environment_id AND deployment.deployment_id=intent.source_deployment_id AND deployment.active_revision_id=intent.source_revision_id AND deployment.status='succeeded'
 JOIN deployment_revisions revision ON revision.organization_id=intent.organization_id AND revision.project_id=intent.project_id AND revision.deployment_id=intent.source_deployment_id AND revision.revision_id=intent.source_revision_id AND revision.artifact_id=intent.source_artifact_id
 JOIN build_artifacts artifact ON artifact.organization_id=intent.organization_id AND artifact.project_id=intent.project_id AND artifact.artifact_id=intent.source_artifact_id AND artifact.artifact_sha256=intent.source_artifact_sha256
 JOIN wfp_publish_receipts receipt ON receipt.organization_id=intent.organization_id AND receipt.project_id=intent.project_id AND receipt.environment_id=intent.source_environment_id AND receipt.wfp_receipt_id=revision.wfp_receipt_id AND receipt.artifact_id=intent.source_artifact_id
 WHERE intent.organization_id=?1 AND intent.project_id=?2 AND intent.environment_id=?3 AND intent.operation_id=?4 AND intent.event_type='DeploymentPromotionRequestedV1'`;
const SOURCE_REPLAY = `SELECT 1 FROM product_workflow_runs WHERE organization_id=?1 AND project_id=?2 AND event_type='SourceLinkRequestedV1' AND active_replay_attempt_id IS NOT NULL`;
const NOW = `(strftime('%Y-%m-%dT%H:%M:%f','now') || '000Z')`;
interface Authorized {
  billing_epoch_id: string;
  started_at: string;
  operation_state: "queued" | "running";
  event_count: number;
}
type Row = Record<string, unknown>;
/** Original claim, operation start/audit and deployment start form ONE fenced batch. No provider call or generic state write. */
export async function claimProductProviderMutation(
  context: CatalogContext,
  raw: unknown,
): Promise<"created" | "existing"> {
  const input = claimProviderMutationInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  await assertOperationDelegationCurrent(context, {
    organizationId: input.organizationId,
    operationId: input.operationId,
  });
  const values = [
    input.organizationId,
    input.projectId,
    input.environmentId,
    input.operationId,
    input.eventType,
    input.acceptedLifecycleVersion,
    input.logicalWorkflowId,
    input.eventId,
  ];
  const error = (message: string) => new ProductWorkflowContextConflictError(message);
  const command: Command<
    {
      authorized: Authorized | undefined;
      claim: Row | undefined;
      sourceReplay: boolean;
      promotion: boolean;
      foreignClaim: boolean;
      delegation: Awaited<ReturnType<typeof readWorkflowDelegation>>;
    },
    "created" | "existing"
  > = {
    name: "provisioning.claimProviderMutation",
    input,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["product_provider_mutation_claims", "operation_events", "audit_events"],
    read: async (reader) => {
      const [scope, claim, replay, promotion, foreign] = await reader.batch([
        reader.prepare(AUTHORIZED).bind(...values),
        reader
          .prepare(
            "SELECT * FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2",
          )
          .bind(input.organizationId, input.projectId),
        reader.prepare(SOURCE_REPLAY).bind(input.organizationId, input.projectId),
        reader
          .prepare(input.eventType === "DeploymentPromotionRequestedV1" ? PROMOTION : "SELECT 1")
          .bind(
            ...(input.eventType === "DeploymentPromotionRequestedV1" ? values.slice(0, 4) : []),
          ),
        reader
          .prepare(
            "SELECT 1 FROM product_provider_mutation_claims WHERE claim_id=?1 AND NOT(organization_id=?2 AND project_id=?3)",
          )
          .bind(input.claimId, input.organizationId, input.projectId),
      ]);
      return {
        authorized: scope?.results[0] as unknown as Authorized | undefined,
        claim: claim?.results[0],
        sourceReplay: (replay?.results.length ?? 0) !== 0,
        promotion: (promotion?.results.length ?? 0) === 1,
        foreignClaim: (foreign?.results.length ?? 0) !== 0,
        delegation: await readWorkflowDelegation(reader, input),
      };
    },
    decide: (s) => {
      const accepted = s.authorized;
      if (s.foreignClaim) return { reject: error("Another product provider mutation is active") };
      if (s.sourceReplay) return { reject: error("SourceLink Workflow replay is active") };
      if (!s.promotion)
        return { reject: error("Promotion source or target is no longer claimable") };
      if (!accepted) return { reject: error("Product provider mutation is no longer claimable") };
      const expected = {
        claim_id: input.claimId,
        organization_id: input.organizationId,
        project_id: input.projectId,
        environment_id: input.environmentId,
        operation_id: input.operationId,
        event_type: input.eventType,
        accepted_lifecycle_version: input.acceptedLifecycleVersion,
        event_id: input.eventId,
        logical_workflow_id: input.logicalWorkflowId,
        billing_epoch_id: accepted.billing_epoch_id,
      };
      if (s.claim && Object.entries(expected).some(([key, value]) => s.claim?.[key] !== value))
        return { reject: error("Another product provider mutation is active") };
      const insert = s.claim === undefined;
      const statements = [
        fenceRaceGuard(db, "operation_conflict", input.organizationId),
        ...(input.eventType === "ProjectHandleChangeRequestedV1"
          ? [
              nativeDomainPreparationGuard(db, {
                organizationId: input.organizationId,
                projectId: input.projectId,
                originPredicate:
                  "realm.canonical_origin IN (SELECT 'https://'||production_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>(SELECT requested_handle FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1') UNION SELECT 'https://'||development_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2 AND deleted_at IS NULL AND zone_name='omh.st' AND handle<>(SELECT requested_handle FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectHandleChangeRequestedV1'))",
                originValues: [input.operationId],
              }),
            ]
          : []),
        ...workflowExecutionGuards(db, input, s.delegation),
        guard(db, "operation_conflict", `NOT EXISTS(${AUTHORIZED})`, values),
        guard(db, "operation_conflict", `EXISTS(${SOURCE_REPLAY})`, values.slice(0, 2)),
        guard(
          db,
          "operation_conflict",
          "EXISTS(SELECT 1 FROM project_preview_native_preparations WHERE organization_id=?1 AND project_id=?2 AND state='running')",
          values.slice(0, 2),
        ),
        ...(input.eventType === "DeploymentPromotionRequestedV1"
          ? [guard(db, "operation_conflict", `NOT EXISTS(${PROMOTION})`, values.slice(0, 4))]
          : []),
      ];
      if (s.claim && accepted.operation_state === "running")
        return { statements, result: () => "existing" };
      if (insert)
        statements.push(
          db
            .prepare(
              `INSERT INTO product_provider_mutation_claims(claim_id,organization_id,project_id,environment_id,operation_id,event_type,accepted_lifecycle_version,billing_epoch_id,event_id,logical_workflow_id,claimed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,${NOW})`,
            )
            .bind(
              input.claimId,
              input.organizationId,
              input.projectId,
              input.environmentId,
              input.operationId,
              input.eventType,
              input.acceptedLifecycleVersion,
              accepted.billing_epoch_id,
              input.eventId,
              input.logicalWorkflowId,
            ),
        );
      if (accepted.operation_state === "queued")
        statements.push(
          db
            .prepare(
              `UPDATE operations SET state='running',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='queued' AND (SELECT count(*) FROM operation_events WHERE organization_id=?1 AND operation_id=?3)=?5`,
            )
            .bind(
              input.organizationId,
              input.projectId,
              input.operationId,
              accepted.started_at,
              accepted.event_count,
            ),
          guard(db, "operation_conflict", "changes()<>1"),
          db
            .prepare(
              `INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,event_type,revision,idempotency_key,payload,occurred_at) VALUES(?1,?2,?3,?4,'OperationStarted',?5,?6,'{}',?7)`,
            )
            .bind(
              input.organizationId,
              input.claimId,
              input.operationId,
              input.projectId,
              accepted.event_count,
              `${input.logicalWorkflowId}:start`,
              accepted.started_at,
            ),
          db
            .prepare(
              `INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id) VALUES(?1,?2,?3,?4,'OperationStarted','system','deployment-workflow','{}',?5,?6)`,
            )
            .bind(
              input.organizationId,
              input.claimId,
              input.projectId,
              input.operationId,
              accepted.started_at,
              accepted.billing_epoch_id,
            ),
        );
      if (
        insert &&
        [
          "DeploymentRequestedV1",
          "DeploymentPromotionRequestedV1",
          "DeploymentRollbackRequestedV1",
        ].includes(input.eventType)
      )
        statements.push(
          db
            .prepare(
              `UPDATE deployments SET status='running',updated_at=max(updated_at,${NOW}) WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND status='queued' AND deployment_id=(SELECT deployment_id FROM product_command_intents WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND operation_id=?4 AND event_type=?5) AND kind=CASE ?5 WHEN 'DeploymentRequestedV1' THEN 'deploy' WHEN 'DeploymentPromotionRequestedV1' THEN 'promotion' WHEN 'DeploymentRollbackRequestedV1' THEN 'rollback' END`,
            )
            .bind(...values.slice(0, 5)),
        );
      return { statements, result: () => (insert ? "created" : "existing") };
    },
    lookup: async (reader) => {
      // A committed claim is not a fresh permission after a revoked consent or changed owner/source.
      await assertOperationDelegationCurrent(context, {
        organizationId: input.organizationId,
        operationId: input.operationId,
      });
      const proof = await readWorkflowDelegation(reader, input);
      const outcomes = await reader.batch([
        ...workflowExecutionGuards(reader, input, proof),
        guard(reader, "operation_conflict", `NOT EXISTS(${AUTHORIZED})`, values),
        reader
          .prepare(
            `SELECT 1 FROM product_provider_mutation_claims claim JOIN operations operation USING(organization_id,project_id,operation_id)
          WHERE claim.claim_id=?1 AND claim.organization_id=?2 AND claim.project_id=?3 AND claim.environment_id=?4 AND claim.operation_id=?5 AND claim.event_id=?6 AND claim.logical_workflow_id=?7 AND claim.event_type=?8 AND claim.accepted_lifecycle_version=?9 AND operation.state='running'`,
          )
          .bind(
            input.claimId,
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.operationId,
            input.eventId,
            input.logicalWorkflowId,
            input.eventType,
            input.acceptedLifecycleVersion,
          ),
      ]);
      return (outcomes.at(-1)?.results.length ?? 0) === 0 ? undefined : "existing";
    },
  };
  const authorizationChanged = () => {
    const error = conflict(
      "operation_authorization_changed",
      "Queued operation authorization or source generation changed",
    );
    error.name = "OperationAuthorizationConflictError";
    return error;
  };
  return runMapped(db, command, {
    consent_changed: authorizationChanged,
    source_head_conflict: authorizationChanged,
  });
}
