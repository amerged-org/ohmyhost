import { newUlid } from "../../src/catalog/common.js";
import type { D1Database } from "../../src/d1-types.js";
import {
  prepareProductCandidateCleanup,
  recordProductCandidateCleanup,
} from "../../src/catalog/provisioning/deployment-cleanup.js";
import { SharedCoreRouter } from "../../src/router.js";
import { createControlStore } from "../../src/store.js";
import { seedAcceptedOperation, seedOperation } from "./accepted-operation.js";
import type { TestControl } from "./control-d1.js";
import { seedProject, type SeededProject } from "./platform-fixtures.js";
import {
  ATTEMPT_TABLES,
  insertAttemptCore,
  observation,
  reconciliation,
  type AttemptGraph,
  type AttemptRow,
} from "../provisioning/attempt-schema.fixture.js";
import { candidateResources, seedCandidate } from "./provisioning-cleanup-fixtures.js";

export const CLEANUP_REQUESTED_AT = "2026-10-28T12:00:00.000Z";
const LEASE = "2026-10-28T12:05:00.000Z";

type Candidate = Awaited<ReturnType<typeof seedCandidate>>;

/** The `prepareProductCandidateCleanup` input of `c`: a failed-candidate request with its first lease. */
export function cleanupPrepareInput(c: Candidate, extra: Record<string, unknown> = {}) {
  return {
    cleanupRequestId: newUlid(),
    candidate: c.candidate,
    reason: "failed" as const,
    requestedAt: CLEANUP_REQUESTED_AT,
    claimId: newUlid(),
    leaseExpiresAt: LEASE,
    ...extra,
  };
}

/** The `recordProductCandidateCleanup` input that settles the absence of `c` and both of its operation resources. */
export async function cleanupRecordInput(
  c: Candidate,
  claimId: string,
  extra: { gateway?: unknown; outcome?: "removed" | "not_found" } = {},
) {
  const scope = { organizationId: c.candidate.organizationId, projectId: c.candidate.projectId };
  const observedAt = "2026-10-28T12:02:00.000Z";
  return {
    receipt: {
      ...scope,
      cleanupReceiptId: newUlid(),
      candidateReceiptId: c.candidateReceiptId,
      claimId,
      outcome: extra.outcome ?? ("removed" as const),
      observedProviderTag: c.candidate.providerTag,
      observedAt,
    },
    gateway: extra.gateway ?? null,
    resources: (await candidateResources()).map((resource, index) => ({
      ...scope,
      operationCleanupReceiptId: newUlid(),
      candidateReceiptId: c.candidateReceiptId,
      operationId: c.operationId,
      provider: "cloudflare" as const,
      resourceKind: resource.resourceKind,
      resourceIdentityDigest: resource.resourceIdentityDigest,
      outcome: index === 0 ? ("removed" as const) : ("not_found" as const),
      observedAt,
    })),
  };
}

/** The auto-deploy configuration of `p` on `main`, bound to the source connection its plan named. */
async function seedAutoDeployConfig(control: TestControl, p: SeededProject): Promise<string> {
  const connection = (
    await control.core
      .prepare("SELECT source_connection_id FROM source_connections WHERE project_id=?")
      .bind(p.projectId)
      .first<{ source_connection_id: string }>()
  )?.source_connection_id as string;
  await control.core
    .prepare(
      "INSERT INTO github_auto_deploy_configs(organization_id,project_id,source_connection_id,branch_ref,generation,enabled,configured_at,updated_at) VALUES(?1,?2,?3,'refs/heads/main',1,1,?4,?4)",
    )
    .bind(p.organizationId, p.projectId, connection, "2026-10-28T10:00:00.000000Z")
    .run();
  return connection;
}

/** A webhook push of `p` on `main` for `commit`, reserved before any operation is attached to it. */
async function reservePush(
  control: TestControl,
  p: SeededProject,
  connection: string,
  commit: string,
): Promise<string> {
  const guid = crypto.randomUUID(),
    inboxEventId = newUlid();
  await control.core
    .prepare(
      "INSERT INTO webhook_inbox(inbox_event_id,provider,external_event_id,event_type,payload,body_sha256,received_at,state,max_attempts,available_at,organization_id) VALUES(?1,'github',?2,'push','{}',?3,?4,'pending',5,?4,?5)",
    )
    .bind(
      inboxEventId,
      guid,
      new Uint8Array(32).fill(1),
      "2026-10-28T10:00:00.000000Z",
      p.organizationId,
    )
    .run();
  const pushDeploymentId = newUlid();
  await createControlStore(control.bindings).github.reserveGithubPushDeployment({
    organizationId: p.organizationId,
    projectId: p.projectId,
    sourceConnectionId: connection,
    configGeneration: 1,
    branchRef: "refs/heads/main",
    inboxEventId,
    deliveryGuid: guid,
    installationId: "7",
    repositoryId: "42",
    ref: "refs/heads/main",
    commitSha: commit.repeat(40),
    claimedAt: "2026-10-28T10:00:00.000Z",
    pushDeploymentId,
  });
  return pushDeploymentId;
}

/**
 * A GitHub push of `p` attached to `operationId` and still `queued`: the state the push path leaves it in
 * before its Workflow runs. The candidate of `p` must exist first, because it plans the source connection.
 */
export async function seedAttachedPush(
  control: TestControl,
  p: SeededProject,
  operationId: string,
): Promise<string> {
  const pushDeploymentId = await reservePush(
    control,
    p,
    await seedAutoDeployConfig(control, p),
    "a",
  );
  await createControlStore(control.bindings).github.attachGithubPushOperation({
    organizationId: p.organizationId,
    projectId: p.projectId,
    pushDeploymentId,
    operationId,
    now: "2026-10-28T10:00:05.000Z",
  });
  return pushDeploymentId;
}

/**
 * A GitHub push whose candidate is cleaned up because a newer push superseded it, one command short of the terminal
 * batch (the push waits in `cleanup_pending`). With `claim`, the push is the accepted, running operation that holds the
 * project's provider mutation claim and Workflow run (`accepted`).
 */
export async function seedSupersededPush(
  control: TestControl,
  options: { readonly claim?: boolean } = {},
) {
  const store = createControlStore(control.bindings),
    db = control.core,
    context = { directory: db, router: new SharedCoreRouter(db) },
    p = await seedProject(control),
    operationId = await seedOperation(p, { state: options.claim ? "running" : "queued" }),
    c = await seedCandidate(p, { operationId }),
    connection = await seedAutoDeployConfig(control, p);
  let accepted: Awaited<ReturnType<typeof seedAcceptedOperation>> | null = null;
  if (options.claim) {
    const planned = await db
      .prepare("SELECT source_connection_id FROM deployment_plans WHERE plan_id=?")
      .bind(c.planId)
      .first<{ source_connection_id: string }>();
    accepted = await seedAcceptedOperation(p, c.environmentId, {
      operationId,
      intent: {
        plan_id: c.planId,
        source_connection_id: planned?.source_connection_id as string,
        deployment_id: c.deploymentId,
        source_generation: 1,
      },
    });
  }
  const first = await reservePush(control, p, connection, "a");
  await store.github.attachGithubPushOperation({
    organizationId: p.organizationId,
    projectId: p.projectId,
    pushDeploymentId: first,
    operationId,
    now: "2026-10-28T10:00:05.000Z",
  });
  const second = await reservePush(control, p, connection, "b");
  const prepared = cleanupPrepareInput(c, { reason: "superseded", supersededById: second });
  await prepareProductCandidateCleanup(context, prepared);
  const recorded = await cleanupRecordInput(c, prepared.claimId);
  if ((await recordProductCandidateCleanup(context, recorded)) !== "created")
    throw new Error("the candidate cleanup was not recorded");
  return {
    p,
    c,
    first,
    second,
    accepted,
    supersede: {
      organizationId: p.organizationId,
      projectId: p.projectId,
      operationId,
      candidateReceiptId: c.candidateReceiptId,
      cleanupReceiptId: recorded.receipt.cleanupReceiptId,
      supersededById: second,
      terminalAt: "2026-10-28T12:10:00.000Z",
    },
  };
}

type Accepted = NonNullable<Awaited<ReturnType<typeof seedSupersededPush>>["accepted"]>;
type Project = Awaited<ReturnType<typeof seedProject>>;

/**
 * A provider reconciliation attempt of the accepted operation's claim: `prepared` is a retry in flight, `unknown`
 * an attempt whose provider outcome stayed unknown. An `active` attempt is also the Workflow run's current one.
 */
export async function seedReconciliationAttempt(
  db: D1Database,
  project: Project,
  accepted: Accepted,
  options: { readonly outcome: "prepared" | "unknown"; readonly active: boolean },
): Promise<void> {
  const graph = { ...accepted, p: project } as unknown as AttemptGraph;
  const identity = { event_type: "DeploymentRequestedV1", accepted_lifecycle_version: 1 };
  const observed = { ...observation(graph), ...identity };
  const attempt: AttemptRow = {
    ...reconciliation(graph, observed),
    ...identity,
    outcome: options.outcome,
  };
  await insertAttemptCore(db, ATTEMPT_TABLES[0], observed);
  await insertAttemptCore(db, ATTEMPT_TABLES[1], attempt);
  if (options.active)
    await db
      .prepare(
        "UPDATE product_workflow_runs SET active_reconciliation_attempt_id=? WHERE operation_id=?",
      )
      .bind(attempt["attempt_id"], accepted.operationId)
      .run();
}

/** A Native Auth database create the operation reserved or dispatched, whose outcome is not known yet. */
export async function seedNativeDatabaseCreate(
  db: D1Database,
  project: Project,
  accepted: Accepted,
  environmentId: string,
  state: "reserved" | "dispatched",
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at) VALUES(?1,?2,?3,?4,?5,'provider-project','auth-db','us-dev','r256-s500m',?6,?7,?8)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      environmentId,
      accepted.operationId,
      accepted.claimId,
      `native-create-${accepted.operationId}`,
      state,
      state === "dispatched" ? "2026-10-28T10:00:00.000000Z" : null,
    )
    .run();
}

/** An unresolved Neon placement reservation (a historical Core row) that still references the operation's claim. */
export async function seedPlacementReservation(
  db: D1Database,
  project: Project,
  accepted: Accepted,
): Promise<void> {
  const physical = newUlid();
  await db.batch([
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,'2026-10-28T10:00:00.000000Z')",
      )
      .bind(project.organizationId, project.projectId, physical),
    db
      .prepare(
        "INSERT INTO neon_project_placement_reservations(organization_id,project_id,environment_id,operation_id,claim_id,project_name,region_id,postgres_version,reserved_at) VALUES(?1,?2,?3,?4,?5,?6,'aws-eu-central-1',17,'2026-10-28T10:00:00.000000Z')",
      )
      .bind(
        project.organizationId,
        project.projectId,
        physical,
        accepted.operationId,
        accepted.claimId,
        `ohmyho-${project.projectId.toLowerCase()}`,
      ),
  ]);
}

/** An R2 bucket reservation without its receipt, which still references the operation's claim. */
export async function seedBucketReservation(
  db: D1Database,
  project: Project,
  accepted: Accepted,
  environmentId: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO project_r2_bucket_reservations(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,jurisdiction,storage_class,public_access) VALUES(?1,?2,?3,?4,?5,'ohmyho-'||lower(?2)||'-'||lower(?3),'eu','Standard',0)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      environmentId,
      accepted.operationId,
      accepted.claimId,
    )
    .run();
}
