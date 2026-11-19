import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import type { Command, Plan } from "../../run-command.js";
import { organizationLiveGuard } from "../common.js";
import { readSnapshot, type PlatformContext } from "../platform-support.js";
import { currentDataEnvironment, CURRENT_OPERATION_EPOCH } from "./authority.js";
import { DatabaseProviderConflictError, markServingInput } from "./contracts.js";
import { runOnOrganization, stale } from "./run.js";

export type Input = ReturnType<typeof markServingInput.parse>;

/** The database-enabled plan behind a published revision. ?1 organization, ?2 project, ?4 revision. */
const REVISION_PLAN_ENABLED = `EXISTS (SELECT 1 FROM deployment_revisions revision JOIN deployment_plans plan
        ON plan.organization_id = revision.organization_id AND plan.project_id = revision.project_id AND plan.plan_id = revision.plan_id
      WHERE revision.organization_id = e.organization_id AND revision.project_id = e.project_id AND revision.revision_id = ?4
        AND json_extract(plan.framework_plan, '$.database.enabled') IN (1, 'true'))`;
/** The database-enabled plan itself, before any revision of it exists. ?1 organization, ?2 project, ?4 plan. */
const PLAN_ENABLED = `EXISTS (SELECT 1 FROM deployment_plans plan
      WHERE plan.organization_id = e.organization_id AND plan.project_id = e.project_id AND plan.plan_id = ?4
        AND json_extract(plan.framework_plan, '$.database.enabled') IN (1, 'true'))`;

/**
 * The fresh PGCF target of an environment that has not started serving yet, for the plan condition given.
 * Parameters: ?1 organization, ?2 project, ?3 environment, ?4 revision or plan (per `planCondition`).
 */
const pendingTargetSql = (
  planCondition: string,
) => `SELECT h.physical_environment_id, h.target_version, t.database_id, t.provider_project_id, t.runtime_role,
       p.lifecycle_state = 'active' AND p.owner_state = 'active' AS current_owner
  FROM environments e
  JOIN projects p ON p.organization_id = e.organization_id AND p.project_id = e.project_id
  JOIN database_provider_target_heads h ON h.organization_id = e.organization_id AND h.project_id = e.project_id
   AND h.physical_environment_id = ${currentDataEnvironment("e.organization_id", "e.project_id", "e.environment_id")}
  JOIN database_provider_target_revisions t ON t.organization_id = h.organization_id AND t.project_id = h.project_id
   AND t.physical_environment_id = h.physical_environment_id AND t.target_version = h.target_version
 WHERE e.organization_id = ?1 AND e.project_id = ?2 AND e.environment_id = ?3 AND h.state = 'active'
   AND t.provider = 'pgcf' AND h.activated_at IS NULL
   AND ${planCondition}
   AND NOT EXISTS (SELECT 1 FROM database_provider_cutover_authorizations a WHERE a.organization_id = h.organization_id
        AND a.project_id = h.project_id AND a.physical_environment_id = h.physical_environment_id)`;

export const PENDING_TARGET_SQL = pendingTargetSql(REVISION_PLAN_ENABLED);
export const PENDING_TARGET_BY_PLAN_SQL = pendingTargetSql(PLAN_ENABLED);

/**
 * The accepted publication proves this exact registration may serve: the published WFP receipt is the active
 * revision of the active deployment, the operation still holds its claim under the current owner and billing
 * epoch, the latest registration of the physical environment is the active PGCF one for this target and was
 * observed before the candidate was staged, and the shared gateway route of this very candidate is the newest.
 * Parameters: ?1 organization, ?2 project, ?3 environment, ?4 operation, ?5 candidate receipt, ?6 WFP receipt,
 * ?7 revision, ?8 physical environment, ?9 provider project, ?10 database, ?11 runtime role.
 */
export const PUBLICATION_PROOF_SQL = `SELECT 1 FROM wfp_publish_receipts published
  JOIN wfp_candidate_receipts candidate ON candidate.organization_id = published.organization_id AND candidate.project_id = published.project_id AND candidate.candidate_receipt_id = published.candidate_receipt_id
  JOIN deployment_revisions revision ON revision.organization_id = published.organization_id AND revision.project_id = published.project_id AND revision.wfp_receipt_id = published.wfp_receipt_id
  JOIN environments e ON e.organization_id = published.organization_id AND e.project_id = published.project_id AND e.environment_id = published.environment_id
  JOIN deployments deployment ON deployment.organization_id = e.organization_id AND deployment.project_id = e.project_id AND deployment.deployment_id = e.active_deployment_id
  JOIN deployment_plans plan ON plan.organization_id = revision.organization_id AND plan.project_id = revision.project_id AND plan.plan_id = revision.plan_id
  JOIN operations op ON op.organization_id = revision.organization_id AND op.project_id = revision.project_id AND op.operation_id = revision.operation_id
  JOIN projects p ON p.organization_id = op.organization_id AND p.project_id = op.project_id
  JOIN product_provider_mutation_claims claim ON claim.organization_id = op.organization_id AND claim.project_id = op.project_id
   AND claim.operation_id = op.operation_id AND claim.environment_id = e.environment_id
  JOIN project_database_registration_receipts registration ON registration.organization_id = e.organization_id AND registration.project_id = e.project_id
   AND registration.physical_environment_id = ?8
 WHERE published.organization_id = ?1 AND published.project_id = ?2 AND published.environment_id = ?3
   AND revision.operation_id = ?4 AND published.candidate_receipt_id = ?5 AND published.wfp_receipt_id = ?6 AND revision.revision_id = ?7
   AND candidate.operation_id = op.operation_id AND candidate.environment_id = e.environment_id
   AND candidate.product_deployment_id = deployment.deployment_id AND published.product_deployment_id = deployment.deployment_id
   AND revision.deployment_id = deployment.deployment_id AND e.active_revision_id = revision.revision_id
   AND deployment.active_revision_id = revision.revision_id AND deployment.status = 'succeeded'
   AND json_extract(plan.framework_plan, '$.database.enabled') IN (1, 'true')
   AND op.state IN ('queued', 'running') AND p.owner_state = 'active' AND p.lifecycle_state = 'active'
   AND ${CURRENT_OPERATION_EPOCH} AND claim.billing_epoch_id = op.billing_epoch_id
   AND claim.accepted_lifecycle_version = p.lifecycle_version AND claim.event_type IN ('DeploymentRequestedV1', 'DeploymentPromotionRequestedV1')
   AND registration.status = 'active' AND json_extract(registration.metadata, '$.provider') = 'pgcf'
   AND json_extract(registration.metadata, '$.providerProjectId') = ?9 AND json_extract(registration.metadata, '$.databaseId') = ?10
   AND json_extract(registration.metadata, '$.originUser') = ?11
   AND EXISTS (SELECT 1 FROM json_each(registration.metadata, '$.authorizedEnvironmentIds') authorized WHERE authorized.value = e.environment_id)
   AND registration.observed_at <= candidate.staged_at
   AND NOT EXISTS (SELECT 1 FROM project_database_registration_receipts newer WHERE newer.organization_id = registration.organization_id
        AND newer.project_id = registration.project_id AND newer.physical_environment_id = registration.physical_environment_id
        AND newer.registration_version > registration.registration_version)
   AND NOT EXISTS (SELECT 1 FROM project_database_registration_reservations pending WHERE pending.organization_id = registration.organization_id
        AND pending.project_id = registration.project_id AND pending.physical_environment_id = registration.physical_environment_id
        AND pending.registration_version > registration.registration_version)
   AND EXISTS (SELECT 1 FROM shared_gateway_route_revisions route WHERE route.organization_id = e.organization_id
        AND route.project_id = e.project_id AND route.environment_id = e.environment_id AND route.revision = published.shared_gateway_revision
        AND route.operation_id = op.operation_id AND route.candidate_receipt_id = candidate.candidate_receipt_id AND route.active
        AND NOT EXISTS (SELECT 1 FROM shared_gateway_route_revisions newer WHERE newer.organization_id = route.organization_id
          AND newer.project_id = route.project_id AND newer.environment_id = route.environment_id AND newer.revision > route.revision))`;

interface ServingSnapshot {
  readonly pending: Record<string, unknown> | null;
  readonly proven: boolean;
}

export const proofParams = (input: Input, pending: Record<string, unknown>) => [
  input.organizationId,
  input.projectId,
  input.environmentId,
  input.operationId,
  input.candidateReceiptId,
  input.wfpReceiptId,
  input.revisionId,
  String(pending["physical_environment_id"]),
  String(pending["provider_project_id"]),
  String(pending["database_id"]),
  String(pending["runtime_role"]),
];

/**
 * A fresh PGCF target waiting for its first publication, as read BEFORE the publication batch. `null`: nothing to
 * start (already serving, a live cutover, a plan without a database): the publication batch then carries no serving
 * statement at all.
 */
export type ServingCandidate = Readonly<Record<string, unknown>>;

/** What the finalizer knows before it writes. The publication receipt, revision and head do not exist yet. */
export interface ServingCandidateScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly planId: string;
}

/**
 * Read-only decision input for the future publication-finalizer batch: the fresh PGCF target the plan's database
 * requirement will be served from. Read in the finalizer's own snapshot, re-proved by its batch guards.
 */
export async function readServingCandidate(
  db: D1Database,
  scope: ServingCandidateScope,
): Promise<ServingCandidate | null> {
  const [rows] = await readSnapshot(db, [
    [
      PENDING_TARGET_BY_PLAN_SQL,
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      scope.planId,
    ],
  ]);
  const candidate = rows?.[0] ?? null;
  if (candidate !== null && Number(candidate["current_owner"]) !== 1)
    throw new DatabaseProviderConflictError();
  return candidate;
}

/**
 * The PURE, guarded serving-start statements, to be spliced into the publication finalizer's single D1 batch AFTER
 * its writes of the publication receipt, the revision, the environment head and the succeeded deployment, and BEFORE
 * the operation is completed (the proof requires the operation still queued or running). Statements of one D1 batch
 * see each other's writes, so the proof guard re-checks the whole publication as just written; a failing guard
 * rolls the entire finalizer batch back. Nothing here performs I/O or a second RPC.
 *
 * 1. the publication proof must hold (guard), 2. the head moves to serving (its trigger opens the billable interval
 * in the same batch), 3. the head must have moved (guard).
 */
export function servingStartStatements(
  db: D1Database,
  input: Input,
  candidate: ServingCandidate,
): D1PreparedStatement[] {
  const scope = [
    input.organizationId,
    input.projectId,
    String(candidate["physical_environment_id"]),
    Number(candidate["target_version"]),
  ];
  return [
    stale(db, `NOT EXISTS (${PUBLICATION_PROOF_SQL})`, proofParams(input, candidate)),
    db
      .prepare(
        "UPDATE database_provider_target_heads SET activated_at = ?5, updated_at = ?5 WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND target_version = ?4 AND state = 'active' AND activated_at IS NULL",
      )
      .bind(...scope, input.activatedAt),
    stale(
      db,
      "NOT EXISTS (SELECT 1 FROM database_provider_target_heads WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3 AND target_version = ?4 AND state = 'active' AND activated_at = ?5)",
      [...scope, input.activatedAt],
    ),
  ];
}

function servingCommand(db: D1Database, input: Input): Command<ServingSnapshot, void> {
  return {
    name: "database.markProviderTargetServing",
    input,
    retryOn: ["precondition_changed"],
    async read() {
      const [pendingRows] = await readSnapshot(db, [
        [
          PENDING_TARGET_SQL,
          input.organizationId,
          input.projectId,
          input.environmentId,
          input.revisionId,
        ],
      ]);
      const pending = pendingRows?.[0] ?? null;
      if (pending === null) return { pending, proven: false };
      const [proof] = await readSnapshot(db, [
        [PUBLICATION_PROOF_SQL, ...proofParams(input, pending)],
      ]);
      return { pending, proven: (proof?.length ?? 0) === 1 };
    },
    decide(snapshot): Plan<void> {
      const pending = snapshot.pending;
      // No fresh PGCF target waiting for its first publication (already serving, a cutover or not a database
      // deployment): nothing to start. This is also the answer of a replay.
      if (pending === null) return { replay: undefined };
      if (Number(pending["current_owner"]) !== 1 || !snapshot.proven)
        return { reject: new DatabaseProviderConflictError() };
      return {
        statements: [
          organizationLiveGuard(db, input.organizationId),
          ...servingStartStatements(db, input, pending),
        ],
        result: () => undefined,
      };
    },
  };
}

/**
 * Starts the serving interval of a fresh PGCF target with the accepted publication. The interval (and its first
 * billable full UTC hour) opens in the same batch through the head's trigger, so a target can never serve without
 * one. Cutovers need the owner's release and are refused here by the missing-authorization condition.
 */
export async function markDatabaseProviderTargetServing(
  context: PlatformContext,
  input: unknown,
): Promise<void> {
  const parsed = markServingInput.parse(input);
  return runOnOrganization(context, parsed.organizationId, (db) => servingCommand(db, parsed));
}
