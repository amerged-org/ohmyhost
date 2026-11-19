import { coreRouter, type TestControl } from "./control-d1.js";
import { seedProject, ulidOf, STORED_NOW } from "./platform-fixtures.js";
import { canonicalJson } from "../../src/catalog/database/contracts.js";
let sequence = 0;
/** The Core rows of a registered product database. */
export async function seedProductRuntimeFixture(control: TestControl) {
  const p = await seedProject(control),
    n = ++sequence,
    physical = p.devEnvironmentId,
    provider = `prj_${"a".repeat(16)}${String(n).padStart(4, "0")}`,
    database = `d${"b".repeat(15)}${String(n).padStart(4, "0")}`,
    operation = ulidOf("registered", n),
    claim = ulidOf("registered-claim", n);
  const metadata = {
    provider: "pgcf",
    databaseId: database,
    operationId: operation,
    organizationId: p.organizationId,
    projectId: p.projectId,
    physicalEnvironmentId: physical,
    registrationVersion: 1,
    region: "eu",
    providerProjectId: provider,
    originHost: "fixture.pgcf.example",
    originDatabase: database,
    originUser: `ohmyho_rw_${physical.toLowerCase()}`,
    authorizedEnvironmentIds: [p.devEnvironmentId, p.prodEnvironmentId].sort(),
    status: "active",
  };
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(p.organizationId, p.projectId, physical, STORED_NOW),
    ...[p.devEnvironmentId, p.prodEnvironmentId].map((e) =>
      control.core
        .prepare(
          "INSERT INTO environment_data_assignments(organization_id,project_id,environment_id,assignment_version,data_environment_id,assigned_at) VALUES(?1,?2,?3,1,?4,?5)",
        )
        .bind(p.organizationId, p.projectId, e, physical, STORED_NOW),
    ),
    control.core
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
      )
      .bind(p.organizationId, operation, p.projectId, p.billingEpochId, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'eu-dev','r512-s1g',?6,'sealed:synthetic',?7)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        physical,
        provider,
        database,
        metadata.originUser,
        STORED_NOW,
      ),
    control.core
      .prepare(
        "INSERT INTO database_provider_target_heads(organization_id,project_id,physical_environment_id,target_version,state,activated_at,updated_at) VALUES(?1,?2,?3,1,'active',?4,?4)",
      )
      .bind(p.organizationId, p.projectId, physical, STORED_NOW),
    control.core
      .prepare(
        "INSERT INTO project_database_registration_receipts(organization_id,project_id,physical_environment_id,operation_id,claim_id,registration_version,status,metadata,observed_at) VALUES(?1,?2,?3,?4,?5,1,'active',?6,?7)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        physical,
        operation,
        claim,
        canonicalJson(metadata),
        STORED_NOW,
      ),
  ]);
  return {
    ...p,
    n,
    physical,
    provider,
    database,
    context: { directory: control.core, router: coreRouter(control) },
  };
}
