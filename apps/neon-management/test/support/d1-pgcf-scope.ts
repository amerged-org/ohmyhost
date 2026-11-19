import {
  parseProjectDataChangeSnapshot,
  planProjectDataChangeTransition,
} from "../../../control-store/src/catalog/provisioning/context-snapshots.js";
import type { D1Database } from "../../../control-store/src/d1-types.js";
import {
  seedAcceptedOperation,
  seedOperation,
} from "../../../control-store/test/support/accepted-operation.js";
import { id } from "../pgcf-runtime-fixture.js";
export const CORE_DATABASE_ID = "10000000-0000-4000-8000-000000000001";
export const MANAGEMENT_SCOPE = { organizationId: id(1), projectId: id(2), environmentId: id(4) };
export const MANAGEMENT_CLAIM = { ...MANAGEMENT_SCOPE, operationId: id(30), claimId: id(31) };
const AT = "2026-09-01T00:00:00.000000Z";
/** Only current project identities and an accepted claim are fixture inputs; all provider/runtime work uses real commands. */
export async function seedManagementScope(
  db: D1Database,
  options: { readonly historicalOnly?: boolean } = {},
) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_directory(organization_id,workos_organization_id,bucket,state,created_at,updated_at) VALUES(?1,'org_management_fixture',0,'active',?2,?2)",
      )
      .bind(id(1), AT),
    db
      .prepare(
        "INSERT INTO organizations(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,created_at,updated_at,bucket) VALUES(?1,'org_management_fixture','active',1,?2,?3,?3,?3,?3,0)",
      )
      .bind(id(1), new Uint8Array(32), AT),
    db
      .prepare(
        "INSERT INTO project_directory(project_id,organization_id,handle,state,created_at) VALUES(?1,?2,'calm-otter-imports','active',?3)",
      )
      .bind(id(2), id(1), AT),
    db
      .prepare(
        "INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at) VALUES(?1,?2,?1,'Cutover',?3,'calm-otter-imports','human-id-4.2.0-sha256-project-handle-words-v1',0,'active',1,'active',1,?4,'shared','us','protected',?5,?5)",
      )
      .bind(id(1), id(2), id(9), id(3), AT),
    db
      .prepare(
        "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?1,?2,?3,?4,'user:fixture')",
      )
      .bind(id(1), id(3), id(2), AT),
    ...(options.historicalOnly
      ? [
          ...[
            [id(4), "dev"],
            [id(5), "prod"],
          ].map(([env, name]) =>
            db
              .prepare(
                "INSERT INTO environment_identities(environment_id,project_id,name,created_at) VALUES(?1,?2,?3,?4)",
              )
              .bind(env, id(2), name, AT),
          ),
        ]
      : [
          ...[
            [id(4), "dev"],
            [id(5), "prod"],
          ].map(([env, name]) =>
            db
              .prepare(
                "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at) VALUES(?1,?2,?3,?4,'{}',0,1,?5,?5)",
              )
              .bind(id(1), id(2), env, name, AT),
          ),
        ]),
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(id(1), id(2), id(4), AT),
    ...(options.historicalOnly
      ? []
      : [
          ...[id(4), id(5)].map((env) =>
            db
              .prepare(
                "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,1,?5)",
              )
              .bind(id(1), id(2), env, id(4), AT),
          ),
        ]),
  ]);
  if (options.historicalOnly) return;
  const scope = { organizationId: id(1), projectId: id(2), billingEpochId: id(3), shard: db };
  await seedAcceptedOperation(scope, id(4), {
    operationId: await seedOperation(scope, { operationId: id(30) }),
    claimId: id(31),
    eventId: id(35),
    workflowId: id(36),
    at: AT,
  });
}

export async function seedManagementReauthorization(db: D1Database) {
  const at = new Date().toISOString().slice(0, 23) + "000Z";
  const scope = { organizationId: id(1), projectId: id(2), billingEpochId: id(3), shard: db };
  const before = {
    dataMode: "shared" as const,
    dev: {
      environmentId: id(4),
      environment: "dev" as const,
      dataEnvironmentId: id(4),
      assignmentVersion: 1,
      assignedAt: "2026-09-01T00:00:00.000Z",
    },
    prod: {
      environmentId: id(5),
      environment: "prod" as const,
      dataEnvironmentId: id(4),
      assignmentVersion: 1,
      assignedAt: "2026-09-01T00:00:00.000Z",
    },
  };
  const snapshot = parseProjectDataChangeSnapshot({
    transition: planProjectDataChangeTransition({
      change: "isolate_prod_keeps_data",
      assignments: before,
      newDataEnvironmentId: id(42),
      prodDatabaseReady: true,
    }),
    environmentHeads: [
      { environmentId: id(4), expectedHeadVersion: 0 },
      { environmentId: id(5), expectedHeadVersion: 0 },
    ],
    registrationGenerations: [{ dataEnvironmentId: id(4), registrationVersion: 1 }],
  });
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND project_id=?2 AND state IN('queued','running') AND operation_id IN(SELECT operation_id FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2)",
      )
      .bind(id(1), id(2)),
    db
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id=? AND project_id=?",
      )
      .bind(id(1), id(2)),
    db
      .prepare(
        "INSERT INTO operations(organization_id,project_id,operation_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
      )
      .bind(id(1), id(2), id(40), id(3), at),
    db
      .prepare(
        "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,'running',1,?5,?5)",
      )
      .bind(id(1), id(43), id(2), id(40), at),
  ]);
  await seedAcceptedOperation(scope, id(4), {
    eventType: "ProjectDataChangeRequestedV1",
    operationId: id(40),
    claimId: id(41),
    eventId: id(45),
    workflowId: id(46),
    at,
    intent: {
      expected_etag: '"' + "a".repeat(64) + '"',
      cleanup_run_id: id(43),
      data_change: "isolate_prod_keeps_data",
      data_change_snapshot: JSON.stringify(snapshot),
    },
  });
  return {
    ...MANAGEMENT_SCOPE,
    operationId: id(40),
    claimId: id(41),
    physicalEnvironmentId: id(4),
    authorizedEnvironmentIds: [id(5)],
  };
}
export async function seedManagementDeletion(db: D1Database, databaseId: string) {
  const at = new Date().toISOString().slice(0, 23) + "000Z";
  const project = await db
    .prepare(
      "SELECT active_billing_epoch_id epoch FROM projects WHERE organization_id=? AND project_id=?",
    )
    .bind(id(1), id(2))
    .first<{ epoch: string }>();
  if (project === null) throw new Error("fixture project missing");
  await db.batch([
    db
      .prepare(
        "UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND project_id=?2 AND state IN('queued','running') AND operation_id IN(SELECT operation_id FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2)",
      )
      .bind(id(1), id(2)),
    db
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id=? AND project_id=?",
      )
      .bind(id(1), id(2)),
    db
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=2,updated_at=?3 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(id(1), id(2), at),
    db
      .prepare(
        "INSERT INTO operations(organization_id,project_id,operation_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
      )
      .bind(id(1), id(2), id(50), project.epoch, at),
    db
      .prepare(
        "INSERT INTO cleanup_runs(organization_id,cleanup_run_id,project_id,operation_id,state,revision,created_at,updated_at) VALUES(?1,?2,?3,?4,'running',1,?5,?5)",
      )
      .bind(id(1), id(51), id(2), id(50), at),
    db
      .prepare(
        "INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,cleanup_run_id,expected_etag,created_at) VALUES(?1,?2,?3,?4,?5,'ProjectDeletionRequestedV1',?6,?7,?8)",
      )
      .bind(id(1), id(2), id(4), id(50), project.epoch, id(51), '"' + "a".repeat(64) + '"', at),
    db
      .prepare(
        "INSERT INTO run_resource_inventory(organization_id,resource_record_id,project_id,operation_id,provider,resource_kind,external_ref_hash,recorded_at,cleanup_locator) VALUES(?1,?2,?3,?4,'pgcf','database',?5,?6,?7)",
      )
      .bind(
        id(1),
        id(52),
        id(2),
        id(50),
        new Uint8Array(32),
        at,
        "encoded/" + Buffer.from(databaseId).toString("base64url"),
      ),
  ]);
  return {
    organizationId: id(1),
    projectId: id(2),
    operationId: id(50),
    physicalEnvironmentId: id(4),
    databaseId,
    registrationVersion: 2,
  };
}

export async function seedOtherProviderOperation(db: D1Database) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at) SELECT organization_id,?1,created_organization_id,name,?2,'other-provider-project',handle_version,0,'active',1,'active',1,?3,'shared','us','protected',created_at,updated_at FROM projects WHERE project_id=?4",
      )
      .bind(id(80), id(81), id(82), id(2)),
    db
      .prepare(
        "INSERT INTO billing_epochs(organization_id,billing_epoch_id,project_id,started_at,created_by_principal_id) VALUES(?,?,?,'2026-09-01T00:00:00.000000Z','user:fixture')",
      )
      .bind(id(1), id(82), id(80)),
    db
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?,?,?,'running',?,'2026-09-01T00:00:00.000000Z','2026-09-01T00:00:00.000000Z')",
      )
      .bind(id(1), id(83), id(80), id(82)),
  ]);
}
