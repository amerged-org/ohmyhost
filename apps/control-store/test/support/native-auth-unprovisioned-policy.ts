import { expect } from "vitest";
import { createControlStore } from "../../src/store.js";
import { newUlid } from "../../src/catalog/common.js";
import type { TestControl } from "./control-d1.js";
import { seedDevAccessProject } from "./dev-access-fixture.js";

/** Shared real-D1 proof matrix; called by the first-configuration integration test. */
export async function assertNativeAuthUnprovisionedPolicy(control: TestControl): Promise<void> {
  {
    const { project, principalId } = await seedDevAccessProject(control);
    await control.core
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
      .bind(project.organizationId)
      .run();
    const store = createControlStore(control.bindings);
    const scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
      principalId,
    };
    const current = await store.identity.updateNativeAuthConfig({
      ...scope,
      expectedRevision: 0,
      operationId: newUlid(),
      enabled: true,
      signupPolicy: "open",
      appName: "Canary",
    });
    const proof = {
      ...scope,
      configurationRevision: current.configurationRevision,
      revocationEpoch: current.revocationEpoch,
      enabled: current.enabled,
      canonicalOrigin: current.canonicalOrigin,
    };
    expect(await store.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(true);
    for (const changed of [
      { organizationId: newUlid() },
      { projectId: newUlid() },
      { environmentId: newUlid() },
      { principalId: "user:foreign" },
      { configurationRevision: current.configurationRevision + 1 },
      { revocationEpoch: current.revocationEpoch + 1 },
      { enabled: false },
      { canonicalOrigin: "https://foreign.example" },
    ])
      await expect(
        store.identity.proveNativeAuthUnprovisionedPolicy({ ...proof, ...changed }),
      ).rejects.toThrow();
    const operationId = newUlid(),
      claimId = newUlid();
    await control.core.batch([
      control.core
        .prepare(
          `INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'prj_12345678901234567890','a1234567890123456789','op_fixture','eu-dev','r256-s500m',1,'2026-10-28T09:20:00.000000Z','2026-10-28T09:00:00.000000Z')`,
        )
        .bind(scope.organizationId, scope.projectId),
      control.core
        .prepare(
          `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at,provider_operation_id,database_id) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','fixture','eu-dev','r256-s500m','fixture-db','observed','2026-10-28T09:20:00.000000Z','op_fixture','a1234567890123456789')`,
        )
        .bind(scope.organizationId, scope.projectId, scope.environmentId, operationId, claimId),
      control.core
        .prepare(
          `INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','a1234567890123456789','eu-dev','pgcf.example','schema_dev','role_dev',1,1,'fixture-dev','active')`,
        )
        .bind(scope.organizationId, scope.projectId, scope.environmentId, operationId, claimId),
    ]);
    expect(await store.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(false);
    // A shared Auth database and Dev registration do not imply Prod's schema exists.
    const prodScope = { ...scope, environmentId: project.prodEnvironmentId };
    const prod = await store.identity.updateNativeAuthConfig({
      ...prodScope,
      expectedRevision: 0,
      operationId: newUlid(),
      enabled: true,
      signupPolicy: "open",
      appName: "Canary",
    });
    const prodProof = {
      ...prodScope,
      configurationRevision: prod.configurationRevision,
      revocationEpoch: prod.revocationEpoch,
      enabled: prod.enabled,
      canonicalOrigin: prod.canonicalOrigin,
    };
    expect(await store.identity.proveNativeAuthUnprovisionedPolicy(prodProof)).toBe(true);
    await control.core
      .prepare(
        `INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','a1234567890123456789','prod_role','role.create:prod_role','fixture-role','reserved')`,
      )
      .bind(
        prodScope.organizationId,
        prodScope.projectId,
        prodScope.environmentId,
        newUlid(),
        newUlid(),
      )
      .run();
    expect(await store.identity.proveNativeAuthUnprovisionedPolicy(prodProof)).toBe(false);
  }
  {
    // Scope rows retain old-organization history under globally stable project/environment IDs.
    const live = await seedDevAccessProject(control);
    const former = await seedDevAccessProject(control);
    await control.core
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
      .bind(live.project.organizationId)
      .run();
    const ownerStore = createControlStore(control.bindings);
    const ownerScope = {
      organizationId: live.project.organizationId,
      projectId: live.project.projectId,
      environmentId: live.project.devEnvironmentId,
      principalId: live.principalId,
    };
    const cfg = await ownerStore.identity.updateNativeAuthConfig({
      ...ownerScope,
      expectedRevision: 0,
      operationId: newUlid(),
      enabled: true,
      signupPolicy: "open",
      appName: "Canary",
    });
    const ownerProof = {
      ...ownerScope,
      configurationRevision: cfg.configurationRevision,
      revocationEpoch: cfg.revocationEpoch,
      enabled: cfg.enabled,
      canonicalOrigin: cfg.canonicalOrigin,
    };
    expect(await ownerStore.identity.proveNativeAuthUnprovisionedPolicy(ownerProof)).toBe(true);
    await control.core
      .prepare(
        `INSERT INTO projects(organization_id,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,owner_state,ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at) SELECT ?3,project_id,created_organization_id,name,created_event_id,handle,handle_version,handle_attempt,lifecycle_state,lifecycle_version,'transferred',ownership_version,active_billing_epoch_id,data_mode,region,dev_access_mode,created_at,updated_at FROM projects WHERE organization_id=?1 AND project_id=?2`,
      )
      .bind(ownerScope.organizationId, ownerScope.projectId, former.project.organizationId)
      .run();
    await control.core
      .prepare(
        `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','fixture','eu-dev','r256-s500m',?4,'cancelled')`,
      )
      .bind(
        former.project.organizationId,
        ownerScope.projectId,
        ownerScope.environmentId,
        newUlid(),
        newUlid(),
      )
      .run();
    expect(await ownerStore.identity.proveNativeAuthUnprovisionedPolicy(ownerProof)).toBe(false);

    for (const kind of ["database", "role"] as const) {
      const { project, principalId } = await seedDevAccessProject(control);
      await control.core
        .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
        .bind(project.organizationId)
        .run();
      const store = createControlStore(control.bindings);
      const scope = {
        organizationId: project.organizationId,
        projectId: project.projectId,
        environmentId: project.devEnvironmentId,
        principalId,
      };
      const current = await store.identity.updateNativeAuthConfig({
        ...scope,
        expectedRevision: 0,
        operationId: newUlid(),
        enabled: true,
        signupPolicy: "open",
        appName: "Canary",
      });
      const proof = {
        ...scope,
        configurationRevision: current.configurationRevision,
        revocationEpoch: current.revocationEpoch,
        enabled: current.enabled,
        canonicalOrigin: current.canonicalOrigin,
      };
      expect(await store.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(true);
      await expect(
        store.identity.proveNativeAuthUnprovisionedPolicy({
          ...proof,
          handoffDelegation: {
            grantId: crypto.randomUUID(),
            clientId: "foreign",
            consentHash: "00".repeat(32),
            action: "auth:manage",
          },
        }),
      ).rejects.toThrow();
      const operation = newUlid();
      if (kind === "database") {
        await control.core
          .prepare(
            `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','fixture','eu-dev','r256-s500m',?4,'reserved')`,
          )
          .bind(scope.organizationId, scope.projectId, scope.environmentId, operation, newUlid())
          .run();
        for (const state of ["reserved", "cancelled", "dispatched", "observed"]) {
          await control.core
            .prepare(
              `UPDATE native_auth_database_operations SET state=?3,dispatched_at=CASE WHEN ?3 IN('dispatched','observed') THEN '2026-10-28T09:20:00.000000Z' ELSE NULL END,provider_operation_id=CASE WHEN ?3='observed' THEN 'operation' ELSE NULL END,database_id=CASE WHEN ?3='observed' THEN 'b1234567890123456789' ELSE NULL END WHERE organization_id=?1 AND project_id=?2`,
            )
            .bind(scope.organizationId, scope.projectId, state)
            .run();
          expect(await store.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(false);
        }
      } else {
        await control.core
          .prepare(
            `INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'prj_12345678901234567890','b1234567890123456789','realm_role','role.create:realm_role',?4,'reserved')`,
          )
          .bind(scope.organizationId, scope.projectId, scope.environmentId, operation, newUlid())
          .run();
        for (const state of ["reserved", "dispatched", "failed", "succeeded"]) {
          await control.core
            .prepare(
              "UPDATE native_auth_role_operations SET state=?3 WHERE organization_id=?1 AND project_id=?2",
            )
            .bind(scope.organizationId, scope.projectId, state)
            .run();
          expect(await store.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(false);
        }
      }
    }
  }
}
