import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import {
  readProductWorkflowDatabaseTarget,
  parseWorkflowDatabaseRegistration,
} from "../../src/catalog/provisioning/context.js";
import { SharedCoreRouter, bucketOf } from "../../src/router.js";
import type { D1Database } from "../../src/d1-types.js";
import { createTestControl } from "../support/control-d1.js";

const id = (n: number) => parseUlid(String(n).padStart(26, "0"));
const databaseId = "abcdefghijklmnopqrst",
  projectId = "prj_abcdefghijklmnopqrst";
const scope = { organizationId: id(1), projectId: id(2), physicalEnvironmentId: id(4) };
const AT = "2026-09-01T00:00:00.000000Z";
const OBSERVED = new Date("2026-09-01T00:00:00.000Z");
const RUNTIME_ROLE = `ohmyho_rw_${id(4).toLowerCase()}`;
/** The retired Neon registration the legacy projects still carry as cleanup evidence. */
const source = {
  organizationId: id(1),
  projectId: id(2),
  physicalEnvironmentId: id(4),
  operationId: id(10),
  registrationVersion: 1,
  region: "us" as const,
  providerProjectId: "source-neon",
  branchId: "br-source",
  originHost: "ep-source-pooler.us-east-1.aws.neon.tech",
  originDatabase: "neondb",
  originUser: RUNTIME_ROLE,
  authorizedEnvironmentIds: [id(4), id(5)],
  status: "active" as const,
};
const pgcfMetadata = {
  provider: "pgcf" as const,
  databaseId,
  ...scope,
  operationId: id(10),
  registrationVersion: 2,
  region: "us" as const,
  providerProjectId: projectId,
  originHost: "sql.pgcf.example",
  originDatabase: databaseId,
  originUser: RUNTIME_ROLE,
  authorizedEnvironmentIds: [id(4), id(5)],
  status: "active" as const,
};
const INSERT_RESERVATION =
  "INSERT INTO project_database_registration_reservations(organization_id,project_id,physical_environment_id,operation_id,claim_id,registration_version,metadata) VALUES(?1,?2,?3,?4,?5,?6,?7)";

/** The project, its two environments sharing one data environment, and the operation the records point at. */
async function seedScope(db: D1Database) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO org_directory(organization_id,workos_organization_id,bucket,state,created_at,updated_at) VALUES(?1,'org_target_fixture',0,'active',?2,?2)",
      )
      .bind(id(1), AT),
    db
      .prepare(
        "INSERT INTO organizations(organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,created_at,updated_at,bucket) VALUES(?1,'org_target_fixture','active',1,?2,?3,?3,?3,?3,0)",
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
    ...(
      [
        [id(4), "dev"],
        [id(5), "prod"],
      ] as const
    ).map(([environmentId, name]) =>
      db
        .prepare(
          "INSERT INTO environments(organization_id,project_id,environment_id,name,desired_state,head_version,dev_access_epoch,created_at,updated_at) VALUES(?1,?2,?3,?4,'{}',0,1,?5,?5)",
        )
        .bind(id(1), id(2), environmentId, name, AT),
    ),
    db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(id(1), id(2), id(4), AT),
    ...[id(4), id(5)].map((environmentId) =>
      db
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,data_environment_id,assignment_version,assigned_at) VALUES(?1,?2,?3,?4,1,?5)",
        )
        .bind(id(1), id(2), environmentId, id(4), AT),
    ),
    db
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'succeeded',?4,?5,?5)",
      )
      .bind(id(1), id(10), id(2), id(3), AT),
  ]);
}
/** A legacy project: its retired Neon placement, target revision 1 (head retired: the shared Core forbids an active
 * Neon head) and the Neon registration receipt. */
async function seedLegacyNeon(db: D1Database) {
  await db.batch([
    db
      .prepare(
        "INSERT INTO neon_project_placement_receipts(organization_id,project_id,environment_id,operation_id,claim_id,project_name,region_id,postgres_version,provider_project_id,default_branch_id,operation_ids,state,observed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,'aws-us-east-1',17,'source-neon','br-source','[]','ready',?7,?7)",
      )
      .bind(id(1), id(2), id(4), id(10), id(11), `ohmyho-${id(2).toLowerCase()}`, AT),
    db
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,branch_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) VALUES(?1,?2,?3,1,'neon','source-neon',NULL,'br-source','aws-us-east-1',NULL,?4,?5,NULL,?6)",
      )
      .bind(id(1), id(2), id(4), RUNTIME_ROLE, `registry:${id(4)}`, AT),
    db
      .prepare(
        "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'retired',NULL,?4)",
      )
      .bind(id(1), id(2), id(4), AT),
    db
      .prepare(
        "INSERT INTO project_database_registration_receipts(organization_id,project_id,physical_environment_id,operation_id,claim_id,registration_version,status,metadata,observed_at) VALUES(?1,?2,?3,?4,?5,1,'active',?6,?7)",
      )
      .bind(id(1), id(2), id(4), id(10), id(11), JSON.stringify(source), AT),
  ]);
}
async function fixture(legacy: boolean) {
  const control = await createTestControl();
  try {
    await seedScope(control.core);
    if (legacy) await seedLegacyNeon(control.core);
    return {
      core: control.core,
      context: { directory: control.core, router: new SharedCoreRouter(control.core) },
      dispose: () => control.dispose(),
    };
  } catch (error) {
    await control.dispose();
    throw error;
  }
}

it("reads absent and legacy metadata, retains retired cleanup identity and enforces the authoritative bucket fence", async () => {
  const absent = await fixture(false);
  try {
    expect(await readProductWorkflowDatabaseTarget(absent.context, scope)).toEqual({
      dataEnvironmentId: id(4),
      providerTarget: null,
      neonPlacement: null,
      databaseRegistration: null,
    });
  } finally {
    await absent.dispose();
  }
  const r = await fixture(true);
  try {
    const retired = await readProductWorkflowDatabaseTarget(r.context, scope);
    expect(retired).toEqual({
      dataEnvironmentId: id(4),
      providerTarget: {
        ...scope,
        providerProjectId: "source-neon",
        targetVersion: 1,
        state: "retired",
        provider: "neon",
        branchId: "br-source",
      },
      neonPlacement: {
        organizationId: id(1),
        projectId: id(2),
        environmentId: id(4),
        operationId: id(10),
        claimId: id(11),
        projectName: `ohmyho-${id(2).toLowerCase()}`,
        regionId: "aws-us-east-1",
        postgresVersion: 17,
        providerProjectId: "source-neon",
        defaultBranchId: "br-source",
        operationIds: [],
        state: "ready",
        observedAt: OBSERVED,
      },
      databaseRegistration: { ...source, claimId: id(11), observedAt: OBSERVED },
    });
    await r.core
      .prepare("INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?,'moved',?,?)")
      .bind(await bucketOf(scope.organizationId), id(98), AT)
      .run();
    await expect(readProductWorkflowDatabaseTarget(r.context, scope)).rejects.toThrow();
    await expect(
      readProductWorkflowDatabaseTarget(r.context, { ...scope, unexpected: true }),
    ).rejects.toThrow();
  } finally {
    await r.dispose();
  }
}, 240000);

it("refuses malformed prototype metadata at the read boundary without relaxing the source constraints", async () => {
  const r = await fixture(true);
  try {
    for (const [version, change] of [
      [2, { authorizedEnvironmentIds: [id(4), id(4)] }],
      [3, { provider: null }],
      [4, { originHost: "unqualified.example" }],
    ] as const) {
      const invalid = { ...source, registrationVersion: version, ...change };
      const write = r.core
        .prepare(INSERT_RESERVATION)
        .bind(id(1), id(2), id(4), id(10), id(11), version, JSON.stringify(invalid))
        .run();
      if (version === 3) {
        await expect(write).rejects.toThrow("unexpected key set");
        continue;
      }
      await write;
      // These shape-valid prototype rows still require the semantic validator at the read boundary.
      await expect(readProductWorkflowDatabaseTarget(r.context, scope)).rejects.toMatchObject({
        code: "deployment_persistence_conflict",
      });
    }
    const tooLarge = "9223372036854775807";
    await r.core
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,branch_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) SELECT organization_id,project_id,physical_environment_id,?4,provider,provider_project_id,database_id,branch_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at FROM database_provider_target_revisions WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3 AND target_version=1",
      )
      .bind(...Object.values(scope), tooLarge)
      .run();
    await r.core
      .prepare(
        "UPDATE database_provider_target_heads SET target_version=?4 WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3",
      )
      .bind(...Object.values(scope), tooLarge)
      .run();
    await expect(readProductWorkflowDatabaseTarget(r.context, scope)).rejects.toMatchObject({
      code: "deployment_persistence_conflict",
    });
  } finally {
    await r.dispose();
  }
}, 240000);

it("refuses a PGCF registration whose origin database differs from its physical database", async () => {
  const r = await fixture(false);
  try {
    const { branchId, ...base } = source;
    void branchId;
    const invalid = {
      ...base,
      provider: "pgcf",
      providerProjectId: projectId,
      databaseId,
      originHost: "sql.pgcf.example",
      originDatabase: "bbcdefghijklmnopqrst",
    };
    expect(() => parseWorkflowDatabaseRegistration(JSON.stringify(invalid))).toThrow(
      "Workflow database registration target conflicts",
    );
    await expect(
      r.core
        .prepare(INSERT_RESERVATION)
        .bind(id(1), id(2), id(4), id(10), id(11), 1, JSON.stringify(invalid))
        .run(),
    ).rejects.toThrow();
  } finally {
    await r.dispose();
  }
}, 240000);

it("reads the latest pending or observed PGCF registration and refuses target-mismatched metadata", async () => {
  const r = await fixture(true);
  try {
    await r.core.batch([
      r.core
        .prepare(
          "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,branch_id,region_id,size_class_id,runtime_role,credential_reference,operation_id,created_at) VALUES(?1,?2,?3,2,'pgcf',?4,?5,NULL,'us-dev','r512-s1g',?6,'registry:test',?7,?8)",
        )
        .bind(id(1), id(2), id(4), projectId, databaseId, RUNTIME_ROLE, id(10), AT),
      r.core
        .prepare(
          "UPDATE database_provider_target_heads SET target_version=2,state='active' WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3",
        )
        .bind(...Object.values(scope)),
      r.core
        .prepare(INSERT_RESERVATION)
        .bind(id(1), id(2), id(4), id(10), id(11), 2, JSON.stringify(pgcfMetadata)),
    ]);
    const pgcfTarget = {
      ...scope,
      providerProjectId: projectId,
      targetVersion: 2,
      state: "active" as const,
      provider: "pgcf" as const,
      databaseId,
    };
    // A pending reservation is the latest registration; the retired Neon placement is not reported for a PGCF target.
    expect(await readProductWorkflowDatabaseTarget(r.context, scope)).toEqual({
      dataEnvironmentId: id(4),
      providerTarget: pgcfTarget,
      neonPlacement: null,
      databaseRegistration: { ...pgcfMetadata, claimId: id(11), observedAt: null, pending: true },
    });
    const observed = "2026-09-01T01:02:03.123456Z";
    await r.core
      .prepare(
        "INSERT INTO project_database_registration_receipts(organization_id,project_id,physical_environment_id,operation_id,claim_id,registration_version,status,metadata,observed_at) VALUES(?1,?2,?3,?4,?5,2,'active',?6,?7)",
      )
      .bind(id(1), id(2), id(4), id(10), id(11), JSON.stringify(pgcfMetadata), observed)
      .run();
    expect(await readProductWorkflowDatabaseTarget(r.context, scope)).toEqual({
      dataEnvironmentId: id(4),
      providerTarget: pgcfTarget,
      neonPlacement: null,
      databaseRegistration: {
        ...pgcfMetadata,
        claimId: id(11),
        observedAt: new Date("2026-09-01T01:02:03.123Z"),
      },
    });
    const mismatched = {
      ...pgcfMetadata,
      registrationVersion: 3,
      databaseId: "bbcdefghijklmnopqrst",
      originDatabase: "bbcdefghijklmnopqrst",
    };
    await r.core
      .prepare(INSERT_RESERVATION)
      .bind(id(1), id(2), id(4), id(10), id(11), 3, JSON.stringify(mismatched))
      .run();
    await expect(readProductWorkflowDatabaseTarget(r.context, scope)).rejects.toMatchObject({
      code: "deployment_persistence_conflict",
    });
  } finally {
    await r.dispose();
  }
}, 240000);
