import { newUlid } from "../../src/catalog/common.js";
import { runtimeRoleOf } from "../../src/catalog/database/contracts.js";
import {
  completeProductLifecycleCommand,
  retainProductDeletionTombstone,
} from "../../src/catalog/provisioning/lifecycle-completion.js";
import {
  deletionInventoryStatements,
  readDeletionInventoryPlan,
  recordLifecycleCleanupAttempt,
} from "../../src/catalog/provisioning/lifecycle-inventory.js";
import {
  acceptDeletion,
  lifecycleContext,
  lifecycleIdentity,
} from "../provisioning/lifecycle.fixture.js";
import { leaseOperation } from "../support/accepted-operation.js";
import type { TestControl } from "../support/control-d1.js";
import { bytes, STORED_NOW, type SeededProject } from "../support/platform-fixtures.js";
import { newOrganization } from "./support.js";

/*
 * Real rows for the registries the credit attribution reads: PGCF serving intervals (through the registration
 * triggers), R2 bucket receipts, WFP candidate cleanups, custom hostnames and a transfer of a project.
 */

export const exec = (control: TestControl, sql: string, ...binds: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...binds)
    .run();

/** The project of `p` changes hands at `at`: its epoch ends and the receiving organization opens a new one. */
export async function transferProject(
  control: TestControl,
  p: SeededProject,
  at: string,
): Promise<string> {
  const receiver = await newOrganization(control);
  const db = control.core;
  await db.batch([
    db
      .prepare("UPDATE billing_epochs SET ended_at = ?2 WHERE project_id = ?1 AND ended_at IS NULL")
      .bind(p.projectId, at),
    db
      .prepare(
        "UPDATE projects SET owner_state = 'transferred' WHERE organization_id = ?1 AND project_id = ?2",
      )
      .bind(p.organizationId, p.projectId),
    db
      .prepare(
        `INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode, region, dev_access_mode, created_at, updated_at)
         SELECT ?2, project_id, created_organization_id, name, created_event_id, handle || '-moved', handle_version, handle_attempt, lifecycle_state, lifecycle_version, 'active', ownership_version + 1, ?3, data_mode, region, dev_access_mode, created_at, updated_at
         FROM projects WHERE organization_id = ?1 AND project_id = ?4`,
      )
      .bind(p.organizationId, receiver.organizationId, newUlid(), p.projectId),
  ]);
  await exec(
    control,
    "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) SELECT ?1, active_billing_epoch_id, project_id, ?2, 'user:fixture' FROM projects WHERE organization_id = ?1 AND project_id = ?3",
    receiver.organizationId,
    at,
    p.projectId,
  );
  return receiver.organizationId;
}

let databases = 0;
/**
 * A PGCF database serving the project `p` from `activatedAt` (until `endedAt` when given) as a new physical
 * environment, which the listed logical environments (both by default) point at.
 */
export async function servePgcf(
  control: TestControl,
  p: SeededProject,
  options: {
    activatedAt: string;
    endedAt?: string;
    assigned?: string[];
    databaseId?: string;
  },
) {
  databases += 1;
  const physical = newUlid();
  const databaseId = options.databaseId ?? `d${String(databases).padStart(19, "q")}`;
  const providerProjectId = `prj_${"a".repeat(20)}`;
  await exec(
    control,
    "INSERT OR IGNORE INTO project_data_environments(organization_id, project_id, data_environment_id, created_at) VALUES (?1, ?2, ?3, ?4)",
    p.organizationId,
    p.projectId,
    physical,
    STORED_NOW,
  );
  for (const environmentId of options.assigned ?? [p.devEnvironmentId, p.prodEnvironmentId])
    await exec(
      control,
      "INSERT INTO environment_data_assignments(organization_id, project_id, environment_id, data_environment_id, assignment_version, assigned_at) VALUES (?1, ?2, ?3, ?4, (SELECT coalesce(max(assignment_version), 0) + 1 FROM environment_data_assignments WHERE organization_id = ?1 AND project_id = ?2 AND environment_id = ?3), ?5)",
      p.organizationId,
      p.projectId,
      environmentId,
      physical,
      STORED_NOW,
    );
  await exec(
    control,
    "INSERT INTO database_provider_target_revisions(organization_id, project_id, physical_environment_id, target_version, provider, provider_project_id, database_id, region_id, size_class_id, runtime_role, credential_reference, created_at) VALUES (?1, ?2, ?3, 1, 'pgcf', ?4, ?5, 'eu-dev', 'r512-s1g', ?6, 'sealed:fixture', ?7)",
    p.organizationId,
    p.projectId,
    physical,
    providerProjectId,
    databaseId,
    runtimeRoleOf(physical),
    STORED_NOW,
  );
  await exec(
    control,
    "INSERT INTO database_provider_target_heads(organization_id, project_id, physical_environment_id, target_version, state, activated_at, updated_at) VALUES (?1, ?2, ?3, 1, 'active', ?4, ?4)",
    p.organizationId,
    p.projectId,
    physical,
    options.activatedAt,
  );
  if (options.endedAt !== undefined)
    await exec(
      control,
      "UPDATE database_provider_target_heads SET state = 'retired', updated_at = ?4 WHERE organization_id = ?1 AND project_id = ?2 AND physical_environment_id = ?3",
      p.organizationId,
      p.projectId,
      physical,
      options.endedAt,
    );
  return { databaseId, physical, providerProjectId };
}

/** The platform owns the database: it is registered as a platform database, not as a customer's. */
export const markPlatformDatabase = (
  control: TestControl,
  database: { providerProjectId: string; databaseId: string },
) =>
  exec(
    control,
    "INSERT INTO pgcf_platform_database_activations(provider_project_id, database_id, activated_at, manifest_sha256, recorded_by, recorded_at) VALUES (?1, ?2, '2026-10-28T09:00:00.000000Z', ?3, 'fixture', ?4)",
    database.providerProjectId,
    database.databaseId,
    bytes(32, 5),
    STORED_NOW,
  );

let buckets = 0;
/** The R2 bucket of one environment of `p`; the name is the one the bucket receipt's check requires. */
export async function addBucket(
  control: TestControl,
  p: SeededProject,
  environmentId: string,
  options: { createdAt?: string; jurisdiction?: "eu" | "us" } = {},
): Promise<string> {
  buckets += 1;
  const name = `ohmyho-${p.projectId.toLowerCase()}-${environmentId.toLowerCase()}`;
  const at = options.createdAt ?? "2026-10-28T10:00:00.000000Z";
  await exec(
    control,
    "INSERT INTO project_r2_bucket_receipts(organization_id, project_id, environment_id, operation_id, claim_id, bucket_name, provider_bucket_id, jurisdiction, storage_class, public_access, observed_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'Standard', 0, ?9, ?9)",
    p.organizationId,
    p.projectId,
    environmentId,
    newUlid(),
    newUlid(),
    name,
    buckets.toString(16).padStart(32, "0"),
    options.jurisdiction ?? "eu",
    at,
  );
  return name;
}

/** The staged candidate was removed from the namespace at `observedAt`. */
export const cleanUpScript = (
  control: TestControl,
  p: SeededProject,
  candidateReceiptId: string,
  environmentId: string,
  observedAt: string,
) =>
  exec(
    control,
    "INSERT INTO wfp_candidate_cleanup_receipts(cleanup_receipt_id, candidate_receipt_id, organization_id, project_id, outcome, observed_provider_tag, observed_at, environment_id) VALUES (?1, ?2, ?3, ?4, 'removed', 'exact-fixture-tag', ?5, ?6)",
    newUlid(),
    candidateReceiptId,
    p.organizationId,
    p.projectId,
    observedAt,
    environmentId,
  );

/** An active custom hostname of `p` provisioned at `provisioned`, or a deleted one when `deletedAt` is given. */
export const addHostname = (
  control: TestControl,
  p: SeededProject,
  name: string,
  provisioned: string,
  deletedAt: string | null = null,
) =>
  exec(
    control,
    `INSERT INTO paid_project_domains(organization_id, project_id, hostname, gateway_script_name, state, configured_by_principal_id, apply_idempotency_sha256, apply_request_sha256, custom_hostname_receipt, worker_route_receipt, delete_idempotency_sha256, delete_request_sha256, created_at, updated_at, deleted_at, provisioning_started_at)
     VALUES (?1, ?2, ?3, 'ohmyho-gateway-production', ?4, 'user:fixture', zeroblob(32), zeroblob(32), '{}', '{}', ?5, ?5, ?6, ?6, ?7, ?6)`,
    p.organizationId,
    p.projectId,
    name,
    deletedAt === null ? "active" : "deleted",
    deletedAt === null ? null : bytes(32, 7),
    provisioned,
    deletedAt,
  );

/**
 * Deletes `p` through the Workflow's own commands: the accepted request, its inventory removed, the tombstone and the
 * terminal completion at `completedAt`. The completion stamps the project's `updated_at` with that instant.
 */
export async function completeDeletion(
  control: TestControl,
  p: SeededProject,
  completedAt: string,
): Promise<void> {
  const context = lifecycleContext(control.core);
  const deletion = await acceptDeletion(p);
  const recordedAt = "2026-10-28T11:00:00.000Z";
  const plan = await readDeletionInventoryPlan(control.core, {
    organizationId: p.organizationId,
    projectId: p.projectId,
    operationId: deletion.operationId,
    recordedAt,
  });
  await control.core.batch(deletionInventoryStatements(control.core, plan));
  for (const record of plan.records)
    await recordLifecycleCleanupAttempt(context, {
      organizationId: p.organizationId,
      projectId: p.projectId,
      operationId: deletion.operationId,
      cleanupAttemptId: newUlid(),
      provider: record.provider,
      resourceKind: record.resourceKind,
      externalRefHash: record.externalRefHash,
      outcome: "removed",
      attemptedAt: "2026-10-28T11:30:00.000Z",
    });
  const identity = lifecycleIdentity(p, p.devEnvironmentId, deletion, completedAt);
  await retainProductDeletionTombstone(context, {
    organizationId: identity.organizationId,
    projectId: identity.projectId,
    environmentId: identity.environmentId,
    operationId: identity.operationId,
    workflowId: identity.workflowId,
    outboxEventId: identity.outboxEventId,
    startedOperationEventId: identity.startedOperationEventId,
    recordedAt,
    tombstoneReceiptId: "tombstone-1",
  });
  // The running Workflow holds the operation's lease when its terminal command runs.
  await leaseOperation(control.core, deletion.operationId);
  await completeProductLifecycleCommand(context, {
    ...identity,
    eventType: "ProjectDeletionRequestedV1",
    expectedEnvironmentHeads: [
      { environmentId: p.devEnvironmentId, expectedHeadVersion: 0 },
      { environmentId: p.prodEnvironmentId, expectedHeadVersion: 0 },
    ],
    deletion: {
      tombstoneReceiptId: "tombstone-1",
      inventoryClean: true,
      consecutive404s: 3,
      gatewayAbsence: [null, null],
    },
  });
}
