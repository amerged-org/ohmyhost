import type { D1Database } from "../../src/d1-types.js";
import { newUlid } from "../../src/catalog/common.js";
import { STORED_NOW, type ProjectScope, type SeededProject } from "./platform-fixtures.js";
import { seedDeploymentPlan, sourceFrameworkPlan } from "./provider-fixtures.js";

/**
 * The accepted-operation graph of the final schema. A provider mutation claim is only admitted over its
 * immutable `product_command_intents` row (with the event type's exact column shape) and its
 * `product_workflow_runs` row, which in turn needs the outbox event that started it. This is the single
 * place that writes that graph; every fixture that needs a claim, an intent or a Workflow run goes through it.
 */

export type IntentEventType =
  | "SourceLinkRequestedV1"
  | "DeploymentRequestedV1"
  | "DeploymentRollbackRequestedV1"
  | "DeploymentPromotionRequestedV1"
  | "ProjectDeletionRequestedV1"
  | "ProjectDataChangeRequestedV1"
  | "ProjectHandleChangeRequestedV1";

/** The event types a provider mutation claim may carry (CHECK of `product_provider_mutation_claims`). */
export type ClaimEventType = Exclude<
  IntentEventType,
  "SourceLinkRequestedV1" | "ProjectDeletionRequestedV1"
>;

/** The event-specific columns of `product_command_intents`; the per-type CHECK decides which must be set. */
export interface IntentColumns {
  installation_id?: string;
  repository_owner?: string;
  repository_name?: string;
  plan_id?: string;
  source_connection_id?: string;
  deployment_id?: string;
  target_deployment_id?: string;
  target_revision_id?: string;
  target_artifact_id?: string;
  expected_etag?: string;
  cleanup_run_id?: string;
  source_environment_id?: string;
  source_deployment_id?: string;
  source_revision_id?: string;
  source_artifact_id?: string;
  source_artifact_sha256?: Uint8Array;
  expected_source_head_version?: number;
  expected_target_head_version?: number;
  requested_handle?: string;
  data_change?: string;
  data_change_snapshot?: string;
  binding_refresh_snapshot?: string;
  binding_refresh_snapshot_sha256?: Uint8Array;
  source_generation?: number;
}

const INTENT_COLUMNS = [
  "installation_id",
  "repository_owner",
  "repository_name",
  "plan_id",
  "source_connection_id",
  "deployment_id",
  "target_deployment_id",
  "target_revision_id",
  "target_artifact_id",
  "expected_etag",
  "cleanup_run_id",
  "source_environment_id",
  "source_deployment_id",
  "source_revision_id",
  "source_artifact_id",
  "source_artifact_sha256",
  "expected_source_head_version",
  "expected_target_head_version",
  "requested_handle",
  "data_change",
  "data_change_snapshot",
  "binding_refresh_snapshot",
  "binding_refresh_snapshot_sha256",
  "source_generation",
] as const satisfies readonly (keyof IntentColumns)[];

export interface SeededClaim {
  readonly operationId: string;
  readonly claimId: string;
}

export interface AcceptedOperation extends SeededClaim {
  readonly eventId: string;
  readonly workflowId: string;
  readonly eventType: IntentEventType;
  /** The intent columns as written, including the parents the seed created for the event type. */
  readonly intent: IntentColumns;
}

/** An operation of the project (running unless said otherwise), without any workflow rows. */
export async function seedOperation(
  project: ProjectScope,
  options: { readonly state?: "queued" | "running"; readonly operationId?: string } = {},
): Promise<string> {
  const operationId = options.operationId ?? newUlid();
  await project.shard
    .prepare(
      "INSERT INTO operations(organization_id, operation_id, project_id, state, billing_epoch_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
    )
    .bind(
      project.organizationId,
      operationId,
      project.projectId,
      options.state ?? "running",
      project.billingEpochId,
      STORED_NOW,
    )
    .run();
  return operationId;
}

/** Defaults that satisfy the CHECK of one event type, with the real parents it references. */
async function defaultIntent(
  project: ProjectScope,
  environmentId: string,
  operationId: string,
  eventType: IntentEventType,
): Promise<IntentColumns> {
  switch (eventType) {
    case "SourceLinkRequestedV1":
      return { installation_id: "7", repository_owner: "o", repository_name: "r" };
    case "DeploymentRequestedV1":
      return deploymentIntent(project, operationId, environmentId);
    case "ProjectHandleChangeRequestedV1":
      return { expected_etag: `"${"a".repeat(64)}"`, requested_handle: "renamed-handle" };
    case "ProjectDeletionRequestedV1":
      return {
        expected_etag: `"${"a".repeat(64)}"`,
        cleanup_run_id: await seedCleanupRun(project, operationId),
      };
    case "ProjectDataChangeRequestedV1":
      return {
        expected_etag: `"${"a".repeat(64)}"`,
        cleanup_run_id: await seedCleanupRun(project, operationId),
        data_change: "reset_dev",
        data_change_snapshot: JSON.stringify({
          transition: { redeployEnvironments: ["dev"] },
          environmentHeads: [{}, {}],
          registrationGenerations: [],
        }),
      };
    case "DeploymentRollbackRequestedV1":
    case "DeploymentPromotionRequestedV1":
      throw new Error(
        `${eventType} intents need caller-owned parents: pass their columns as intent`,
      );
  }
}

/**
 * A queued deployment of `operationId` planned against a source connection (default: the project's first, or a
 * new one), and the intent columns that pin it. With `refresh`, the intent carries a binding refresh snapshot of
 * an earlier deployment of the same plan.
 */
export async function deploymentIntent(
  project: ProjectScope,
  operationId: string,
  environmentId: string,
  options: {
    readonly sourceConnectionId?: string;
    readonly refresh?: boolean;
    /** The plan's cost estimate, e.g. the build quote an accepted build settles against. */
    readonly costEstimate?: unknown;
  } = {},
): Promise<IntentColumns> {
  const refresh = options.refresh ?? false;
  const planId = newUlid();
  const deploymentId = newUlid();
  const { sourceConnectionId: connection } = await seedDeploymentPlan(
    project,
    planId,
    sourceFrameworkPlan(false),
    environmentId,
    { sourceConnectionId: options.sourceConnectionId, costEstimate: options.costEstimate },
  );
  await project.shard
    .prepare(
      "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,active_version,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'deploy','running',0,?6,?6)",
    )
    .bind(
      project.organizationId,
      deploymentId,
      project.projectId,
      environmentId,
      operationId,
      STORED_NOW,
    )
    .run();
  const earlier = newUlid();
  return {
    plan_id: planId,
    source_connection_id: connection,
    deployment_id: deploymentId,
    source_generation: 1,
    ...(refresh
      ? {
          binding_refresh_snapshot: JSON.stringify({
            sourceDeploymentId: earlier,
            sourceRevisionId: newUlid(),
            sourceCandidateReceiptId: newUlid(),
            sourceArtifactId: newUlid(),
            sourcePlanId: planId,
            sourceBuildExecutionId: newUlid(),
            sourceArtifactSha256: "ab".repeat(32),
            sourceNamespace: "fixture-ns",
            sourceScriptName: `p-${project.projectId.toLowerCase()}-dev-${earlier.toLowerCase()}`,
            sourceProviderTag: "cd".repeat(16),
            expectedHeadVersion: 1,
            expectedGatewayRevision: 1,
            dataEnvironmentId: newUlid(),
            assignmentVersion: 1,
            registrationVersion: 1,
          }),
        }
      : {}),
  };
}

/** A published revision (what `seedWfpPublication` returns) that a promotion copies or a rollback returns to. */
export interface PublishedRevision {
  readonly deploymentId: string;
  readonly revisionId: string;
  readonly artifactId: string;
}

/** The queued promotion deployment of `operationId` into `targetEnvironmentId` and the intent columns that pin it. */
export async function promotionIntent(
  project: ProjectScope,
  operationId: string,
  targetEnvironmentId: string,
  source: PublishedRevision & { readonly environmentId: string },
): Promise<IntentColumns> {
  const deploymentId = newUlid();
  await project.shard
    .prepare(
      "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,promotion_source_environment_id,promotion_source_deployment_id,promotion_source_revision_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'promotion','running',?6,?7,?8,?9,?9)",
    )
    .bind(
      project.organizationId,
      deploymentId,
      project.projectId,
      targetEnvironmentId,
      operationId,
      source.environmentId,
      source.deploymentId,
      source.revisionId,
      STORED_NOW,
    )
    .run();
  return {
    deployment_id: deploymentId,
    expected_etag: "accepted-etag",
    source_environment_id: source.environmentId,
    source_deployment_id: source.deploymentId,
    source_revision_id: source.revisionId,
    source_artifact_id: source.artifactId,
    source_artifact_sha256: new Uint8Array(32).fill(3),
    expected_source_head_version: 1,
    expected_target_head_version: 0,
  };
}

/** The queued rollback deployment of `operationId` onto `target` and the intent columns that pin it. */
export async function rollbackIntent(
  project: ProjectScope,
  operationId: string,
  environmentId: string,
  target: PublishedRevision,
): Promise<IntentColumns> {
  const deploymentId = newUlid();
  await project.shard
    .prepare(
      "INSERT INTO deployments(organization_id,deployment_id,project_id,environment_id,operation_id,kind,status,rollback_target_deployment_id,rollback_target_revision_id,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,'rollback','running',?6,?7,?8,?8)",
    )
    .bind(
      project.organizationId,
      deploymentId,
      project.projectId,
      environmentId,
      operationId,
      target.deploymentId,
      target.revisionId,
      STORED_NOW,
    )
    .run();
  return {
    deployment_id: deploymentId,
    expected_etag: "accepted-etag",
    target_deployment_id: target.deploymentId,
    target_revision_id: target.revisionId,
    target_artifact_id: target.artifactId,
  };
}

/** A running cleanup run of the operation: the parent of deletion and data-change intents. */
export async function seedCleanupRun(project: ProjectScope, operationId: string): Promise<string> {
  const cleanupRunId = newUlid();
  await project.shard
    .prepare(
      "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,'running',1,?5,?5)",
    )
    .bind(project.organizationId, cleanupRunId, project.projectId, operationId, STORED_NOW)
    .run();
  return cleanupRunId;
}

function intentStatement(
  project: ProjectScope,
  environmentId: string,
  operationId: string,
  eventType: IntentEventType,
  intent: IntentColumns,
  at: string,
) {
  const columns = INTENT_COLUMNS.filter((column) => intent[column] !== undefined);
  return project.shard
    .prepare(
      `INSERT INTO product_command_intents(organization_id,operation_id,event_type,project_id,environment_id,billing_epoch_id,${columns.join(",")},created_at) VALUES(?1,?2,?3,?4,?5,?6,${columns.map((_, index) => `?${index + 8}`).join(",")},?7)`,
    )
    .bind(
      project.organizationId,
      operationId,
      eventType,
      project.projectId,
      environmentId,
      project.billingEpochId,
      at,
      ...columns.map((column) => intent[column] ?? null),
    );
}

/**
 * Only the immutable intent of an operation the store already accepted (no Workflow run, no claim), over the
 * given complete columns.
 */
export async function seedIntent(
  project: ProjectScope,
  environmentId: string,
  operationId: string,
  eventType: IntentEventType,
  intent: IntentColumns,
  at: string = STORED_NOW,
): Promise<void> {
  await intentStatement(project, environmentId, operationId, eventType, intent, at).run();
}

/**
 * The accepted deletion of a project: its cleanup run (a running one unless `cleanupRunId` names the caller's)
 * and the immutable deletion intent, for an operation the store or the caller already created.
 */
export async function seedDeletionIntent(
  project: ProjectScope,
  environmentId: string,
  operationId: string,
  options: { readonly cleanupRunId?: string; readonly at?: string } = {},
): Promise<string> {
  const cleanupRunId = options.cleanupRunId ?? (await seedCleanupRun(project, operationId));
  await seedIntent(
    project,
    environmentId,
    operationId,
    "ProjectDeletionRequestedV1",
    { expected_etag: `"${"a".repeat(64)}"`, cleanup_run_id: cleanupRunId },
    options.at,
  );
  return cleanupRunId;
}

export interface AcceptedOperationOptions {
  /** Default `DeploymentRequestedV1`. */
  readonly eventType?: IntentEventType;
  /** An operation that already exists (accepted through the store or seeded); otherwise a running one is created. */
  readonly operationId?: string;
  /** The outbox event that started the Workflow: reused when the store already wrote it, otherwise created with this id. */
  readonly eventId?: string;
  /** Fixed identities of the Workflow run and the claim, for fixtures whose tests name them. */
  readonly workflowId?: string;
  readonly claimId?: string;
  /** Whether the operation holds the project's provider mutation claim. Default true. */
  readonly claim?: boolean;
  /** The stored timestamp of the intent, the Workflow run and the claim. */
  readonly at?: string;
  /** The complete event-specific columns instead of the defaults; the caller owns their parent rows. */
  readonly intent?:
    | IntentColumns
    | ((operationId: string) => Promise<IntentColumns> | IntentColumns);
}

/**
 * Writes the accepted-operation graph in the order the final schema requires: operation, intent parents, then
 * intent, outbox event, Workflow run and (unless `claim: false`) the provider mutation claim.
 */
export async function seedAcceptedOperation(
  project: ProjectScope,
  environmentId: string,
  options: AcceptedOperationOptions = {},
): Promise<AcceptedOperation> {
  const organization = project.organizationId;
  const database = project.shard;
  const eventType = options.eventType ?? "DeploymentRequestedV1";
  const operationId = options.operationId ?? (await seedOperation(project));
  const intent: IntentColumns =
    options.intent === undefined
      ? await defaultIntent(project, environmentId, operationId, eventType)
      : typeof options.intent === "function"
        ? await options.intent(operationId)
        : options.intent;
  const at = options.at ?? STORED_NOW;
  const eventId = options.eventId ?? newUlid();
  const eventExists =
    options.eventId !== undefined &&
    (await database
      .prepare(
        "SELECT 1 AS present FROM outbox_events WHERE organization_id = ?1 AND event_id = ?2",
      )
      .bind(organization, eventId)
      .first()) !== null;
  const workflowId = options.workflowId ?? newUlid();
  const claimId = options.claimId ?? newUlid();
  const statements = [
    intentStatement(project, environmentId, operationId, eventType, intent, at),
    ...(!eventExists
      ? [
          database
            .prepare(
              "INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,billing_epoch_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts) VALUES(?1,?2,?3,?4,?5,?6,'{}',?7,?7,?7,3)",
            )
            .bind(
              organization,
              eventId,
              project.projectId,
              operationId,
              project.billingEpochId,
              eventType,
              at,
            ),
        ]
      : []),
    database
      .prepare(
        "INSERT INTO product_workflow_runs(organization_id,operation_id,event_type,workflow_id,event_id,project_id,environment_id,billing_epoch_id,state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'queued',?9,?9)",
      )
      .bind(
        organization,
        operationId,
        eventType,
        workflowId,
        eventId,
        project.projectId,
        environmentId,
        project.billingEpochId,
        at,
      ),
    ...(options.claim === false
      ? []
      : [
          database
            .prepare(
              "INSERT INTO product_provider_mutation_claims(organization_id,project_id,claim_id,environment_id,operation_id,billing_epoch_id,event_id,logical_workflow_id,event_type,accepted_lifecycle_version,claimed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10)",
            )
            .bind(
              organization,
              project.projectId,
              claimId,
              environmentId,
              operationId,
              project.billingEpochId,
              eventId,
              workflowId,
              eventType,
              at,
            ),
        ]),
  ];
  await database.batch(statements);
  return { operationId, claimId, eventId, workflowId, eventType, intent };
}

/** A running operation that holds the project's provider mutation claim (the lock that authorizes platform writes). */
export async function seedProviderClaim(
  project: SeededProject,
  environmentId: string,
  eventType: ClaimEventType = "DeploymentRequestedV1",
  options: Pick<AcceptedOperationOptions, "intent"> = {},
): Promise<SeededClaim> {
  const { operationId, claimId } = await seedAcceptedOperation(project, environmentId, {
    ...options,
    eventType,
  });
  return { operationId, claimId };
}

/**
 * An accepted deployment that published: the operation exists first, `publish` writes its plan, deployment and
 * revision graph, and the claim's intent then pins exactly that plan and deployment.
 */
export async function seedPublishedClaim<T extends { planId: string; deploymentId: string }>(
  project: ProjectScope,
  environmentId: string,
  publish: (operationId: string) => Promise<T>,
): Promise<{ readonly claim: SeededClaim; readonly published: T }> {
  const operationId = await seedOperation(project);
  const published = await publish(operationId);
  const source = await project.shard
    .prepare(
      "SELECT source_connection_id FROM deployment_plans WHERE organization_id = ?1 AND plan_id = ?2",
    )
    .bind(project.organizationId, published.planId)
    .first<{ source_connection_id: string }>();
  if (source === null) throw new Error("published plan missing");
  const accepted = await seedAcceptedOperation(project, environmentId, {
    operationId,
    intent: {
      plan_id: published.planId,
      source_connection_id: source.source_connection_id,
      deployment_id: published.deploymentId,
      source_generation: 1,
    },
  });
  return { claim: { operationId, claimId: accepted.claimId }, published };
}

export async function releaseProviderClaim(project: ProjectScope): Promise<void> {
  const db: D1Database = project.shard;
  // Original claim deletion requires its exact operation to be terminal. This changes only
  // synthetic seeded operations; every native claim guard remains enabled in the race fixtures.
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND project_id=?2 AND state IN('queued','running') AND operation_id IN(SELECT operation_id FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2)",
      )
      .bind(project.organizationId, project.projectId),
    db
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id = ? AND project_id = ?",
      )
      .bind(project.organizationId, project.projectId),
  ]);
}

/**
 * Leases an operation the way its running Workflow does: every Workflow step renews the lease of its operation, so a
 * terminal Core command that runs inside the Workflow finds the lease set.
 */
export async function leaseOperation(shard: D1Database, operationId: string): Promise<void> {
  await shard
    .prepare(
      "UPDATE operations SET lease_expires_at='2999-01-01T00:00:00.000000Z' WHERE operation_id=?1",
    )
    .bind(operationId)
    .run();
}
