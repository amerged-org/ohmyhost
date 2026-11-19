import { afterAll, beforeAll, expect, it } from "vitest";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { sourceFrameworkPlan } from "./support/provider-fixtures.js";
import { fundMailFixture, mailFixture } from "./mail/mail-fixture.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  NATIVE_AUTH_SCHEMA_V1_SHA256,
} from "@ohmyhost/contracts/native-auth";
import {
  reserveNativeAuthRegistration,
  authorizeNativeAuthRegistration,
  confirmNativeAuthRegistration,
  readNativeAuthRegistration,
  fenceNativeAuthRegistrationRevocation,
  authorizeNativeAuthRegistrationRevocation,
  resolveNativeAuthRegistrationGeneration,
  readNativeAuthDatabaseEnvironments,
} from "../src/catalog/identity/native-auth-registration.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control?.dispose());

it("fences the exact Native target, current claim and owner through reserve, confirm and read", async () => {
  const f = await mailFixture(control, true, {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  });
  await fundMailFixture(control, f);
  const { organizationId, projectId, environmentId } = f.scope;
  const { operationId, claimId } = f.fixture.accepted;
  expect(
    (
      await readNativeAuthDatabaseEnvironments(f.context, {
        organizationId,
        projectId,
        environmentId,
        operationId,
        claimId,
      })
    ).environmentIds,
  ).toContain(environmentId);
  const databaseId = "a1234567890123456789",
    providerProjectId = "prj_12345678901234567890";
  await control.core
    .prepare(
      `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',1,1)`,
    )
    .bind(organizationId, projectId, environmentId)
    .run();
  await control.core
    .prepare(
      `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,?3,?4,'op_12345678901234567890','eu-dev','r256-s500m',1,'2026-01-01T00:00:00.000000Z','2026-01-01T00:00:00.000000Z')`,
    )
    .bind(organizationId, projectId, providerProjectId, databaseId)
    .run();
  const role = `omh_ar_${environmentId.toLowerCase()}`;
  const descriptor = {
    organizationId,
    projectId,
    environmentId,
    operationId,
    claimId,
    providerProjectId,
    databaseId,
    regionId: "eu-dev" as const,
    originHost: "pgcf.example.com",
    schema: `omh_auth_${environmentId.toLowerCase()}`,
    role,
    targetVersion: 1,
    registryVersion: 1,
    registryReference: `${projectId}:${environmentId}`,
    status: "active" as const,
  };
  const generationScope = {
    organizationId,
    projectId,
    environmentId,
    operationId,
    claimId,
    providerProjectId,
    databaseId,
    regionId: "eu-dev" as const,
    targetVersion: 1,
  };
  expect(await resolveNativeAuthRegistrationGeneration(f.context, generationScope)).toEqual({
    registryVersion: 1,
    registryReference: `${projectId}:${environmentId}`,
  });
  await expect(reserveNativeAuthRegistration(f.context, descriptor)).rejects.toThrow();
  await control.core
    .prepare(
      `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,1)`,
    )
    .bind(
      organizationId,
      projectId,
      environmentId,
      operationId,
      claimId,
      providerProjectId,
      databaseId,
      descriptor.schema,
      role,
      `omh_am_${environmentId.toLowerCase()}`,
      `omh_ab_${projectId.toLowerCase()}`,
      NATIVE_AUTH_SCHEMA_V1_SHA256,
    )
    .run();
  await expect(reserveNativeAuthRegistration(f.context, descriptor)).rejects.toThrow();
  for (const [index, name] of [
    role,
    `omh_am_${environmentId.toLowerCase()}`,
    `omh_ab_${projectId.toLowerCase()}`,
  ].entries()) {
    await control.core
      .prepare(
        `INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'role.create:'||?8,?9,'succeeded')`,
      )
      .bind(
        organizationId,
        projectId,
        environmentId,
        operationId,
        claimId,
        providerProjectId,
        databaseId,
        name,
        `role-${index}`,
      )
      .run();
  }
  await expect(reserveNativeAuthRegistration(f.context, descriptor)).rejects.toThrow();
  await control.core
    .prepare(
      `INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13)`,
    )
    .bind(
      organizationId,
      projectId,
      environmentId,
      operationId,
      claimId,
      providerProjectId,
      databaseId,
      descriptor.schema,
      role,
      `omh_am_${environmentId.toLowerCase()}`,
      `omh_ab_${projectId.toLowerCase()}`,
      NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
      NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
    )
    .run();
  await expect(
    reserveNativeAuthRegistration(f.context, { ...descriptor, registryVersion: 2 }),
  ).rejects.toThrow();
  expect(await reserveNativeAuthRegistration(f.context, descriptor)).toEqual(descriptor);
  expect(await resolveNativeAuthRegistrationGeneration(f.context, generationScope)).toEqual({
    registryVersion: 1,
    registryReference: `${projectId}:${environmentId}`,
  });
  expect(await reserveNativeAuthRegistration(f.context, descriptor)).toEqual(descriptor);
  await expect(
    reserveNativeAuthRegistration(f.context, { ...descriptor, originHost: "other.example.com" }),
  ).rejects.toThrow();
  expect(await authorizeNativeAuthRegistration(f.context, descriptor)).toBe(true);
  expect(await confirmNativeAuthRegistration(f.context, descriptor)).toEqual(descriptor);
  expect(await confirmNativeAuthRegistration(f.context, descriptor)).toEqual(descriptor);
  expect(await readNativeAuthRegistration(f.context, { projectId, environmentId })).toEqual(
    descriptor,
  );
  const revoke = { receipt: descriptor, operationId, claimId, registryVersion: 2 };
  expect(await fenceNativeAuthRegistrationRevocation(f.context, revoke)).toEqual({
    outcome: "fenced",
  });
  expect(await fenceNativeAuthRegistrationRevocation(f.context, revoke)).toEqual({
    outcome: "fenced",
  });
  expect(await authorizeNativeAuthRegistrationRevocation(f.context, revoke)).toBe(true);
  await expect(
    resolveNativeAuthRegistrationGeneration(f.context, generationScope),
  ).rejects.toThrow();
  expect(await readNativeAuthRegistration(f.context, { projectId, environmentId })).toBeNull();
  await expect(authorizeNativeAuthRegistration(f.context, descriptor)).rejects.toThrow();
  await expect(
    reserveNativeAuthRegistration(f.context, { ...descriptor, registryVersion: 2 }),
  ).rejects.toThrow();
  expect(
    await reserveNativeAuthRegistration(f.context, { ...descriptor, registryVersion: 3 }),
  ).toEqual({ ...descriptor, registryVersion: 3 });
  await expect(
    fenceNativeAuthRegistrationRevocation(f.context, { ...revoke, registryVersion: 3 }),
  ).rejects.toThrow();
  await control.core
    .prepare("UPDATE projects SET owner_state='security_frozen' WHERE project_id=?1")
    .bind(projectId)
    .run();
  await expect(authorizeNativeAuthRegistration(f.context, descriptor)).rejects.toThrow();
  expect(await readNativeAuthRegistration(f.context, { projectId, environmentId })).toBeNull();
});
