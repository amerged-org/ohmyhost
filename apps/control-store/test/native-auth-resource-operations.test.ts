import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createCreditCommands } from "../src/catalog/credit/index.js";
import {
  createNativeAuthPlacementPersistence,
  type NativeAuthResourceRuntime,
} from "../../neon-management/src/native-auth-persistence.js";
import { placeNativeAuthDatabase } from "../../neon-management/src/native-auth-placement.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { sourceFrameworkPlan } from "./support/provider-fixtures.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";
import { fundMailFixture, mailFixture } from "./mail/mail-fixture.js";
import { readNativeAuthProvisioningPolicy } from "../src/catalog/identity/native-auth-provisioning-policy.js";
import {
  beginNativeAuthDatabaseOperation,
  beginNativeAuthRoleOperation,
  recordNativeAuthDatabaseObservation,
  recordNativeAuthRoleObservation,
  recordNativeAuthPreparation,
  initializeNativeAuthRealm,
  nativeAuthEffectGuards,
  reserveNativeAuthDatabaseOperation,
  reserveNativeAuthRoleOperation,
} from "../src/catalog/identity/native-auth-resource-operations.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control.dispose());

it("fences placement before dispatch and accounts for an observed resource after claim loss", async () => {
  const f = await mailFixture(control, true, {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  });
  await fundMailFixture(control, f);
  await control.core.batch([
    control.core
      .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
      .bind(f.scope.organizationId),
    control.core
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_nativeproof','admin','active',1,zeroblob(32),'2026-10-28T10:00:00.000000Z','evt')",
      )
      .bind(f.scope.organizationId),
    control.core
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user','user:user_nativeproof','owner','2026-10-28T10:00:00.000000Z')",
      )
      .bind(f.scope.organizationId, newUlid()),
  ]);
  const ownerStore = createControlStore(control.bindings);
  const ownerScope = { ...f.scope, principalId: "user:user_nativeproof" };

  const input = {
    ...f.scope,
    ...f.fixture.accepted,
    providerProjectId: "prj_12345678901234567890",
    name: `ohmyho-auth-${f.scope.projectId.toLowerCase()}`,
    regionId: "eu-dev" as const,
    sizeClassId: "r256-s500m" as const,
  };
  const claim = { ...f.scope, ...f.fixture.accepted };
  await initializeNativeAuthRealm(f.context, claim);
  const reputationBefore = await control.core
    .prepare("SELECT * FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2")
    .bind(f.scope.organizationId, f.scope.projectId)
    .first();
  expect(reputationBefore).not.toBeNull();
  for (const denied of [
    { ...claim, claimId: newUlid() },
    { ...claim, organizationId: newUlid() },
    { ...claim, projectId: newUlid() },
  ]) {
    await expect(initializeNativeAuthRealm(f.context, denied)).rejects.toThrow();
  }
  expect(
    await control.core
      .prepare("SELECT * FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2")
      .bind(f.scope.organizationId, f.scope.projectId)
      .first(),
  ).toEqual(reputationBefore);
  const beforeReservation = await ownerStore.identity.readNativeAuthConfig(ownerScope);
  if (!beforeReservation) throw new Error("missing_config");
  const beforeProof = {
    ...ownerScope,
    configurationRevision: beforeReservation.configurationRevision,
    revocationEpoch: beforeReservation.revocationEpoch,
    enabled: beforeReservation.enabled,
    canonicalOrigin: beforeReservation.canonicalOrigin,
  };
  expect(await ownerStore.identity.proveNativeAuthUnprovisionedPolicy(beforeProof)).toBe(true);

  await expect(
    reserveNativeAuthDatabaseOperation(
      { directory: control.core, router: f.context.router },
      input,
    ),
  ).rejects.toThrow("native_auth_launch_unavailable");

  await expect(
    reserveNativeAuthDatabaseOperation(f.context, { ...input, regionId: "us-dev" }),
  ).rejects.toThrow();
  await control.core
    .prepare("UPDATE credit_account SET paid_until=NULL WHERE organization_id=?1")
    .bind(f.scope.organizationId)
    .run();
  await expect(reserveNativeAuthDatabaseOperation(f.context, input)).rejects.toThrow();
  await control.core
    .prepare(
      "UPDATE credit_account SET paid_until='2099-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    )
    .bind(f.scope.organizationId)
    .run();
  await control.core
    .prepare(
      "UPDATE credit_account SET monthly_micros=0,onetime_micros=0,reserved_micros=0,monthly_ends_at='2020-01-01T00:00:00.000000Z',exhausted_at='2020-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    )
    .bind(f.scope.organizationId)
    .run();
  expect(await reserveNativeAuthDatabaseOperation(f.context, input)).toMatchObject({
    state: "reserved",
  });
  await control.core
    .prepare(
      "UPDATE credit_account SET monthly_ends_at='2099-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    )
    .bind(f.scope.organizationId)
    .run();
  await expect(reserveNativeAuthDatabaseOperation(f.context, input)).rejects.toThrow();
  await control.core
    .prepare(
      "UPDATE credit_account SET monthly_micros=100000000,monthly_ends_at='2099-01-01T00:00:00.000000Z',exhausted_at=NULL WHERE organization_id=?1",
    )
    .bind(f.scope.organizationId)
    .run();
  await control.core
    .prepare("UPDATE project_mail_domain_bindings SET state='suspended' WHERE project_id=?1")
    .bind(f.scope.projectId)
    .run();
  await expect(reserveNativeAuthDatabaseOperation(f.context, input)).rejects.toThrow();
  await control.core
    .prepare("UPDATE project_mail_domain_bindings SET state='active' WHERE project_id=?1")
    .bind(f.scope.projectId)
    .run();
  const initialized = await initializeNativeAuthRealm(f.context, claim);
  expect(initialized).toMatchObject({
    enabled: true,
    configurationRevision: 1,
    revocationEpoch: 1,
  });
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET enabled=0 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(f.scope.organizationId, f.scope.projectId, f.scope.environmentId)
    .run();
  expect(await initializeNativeAuthRealm(f.context, claim)).toMatchObject({
    enabled: false,
    configurationRevision: 1,
    revocationEpoch: 1,
  });
  expect(await readNativeAuthProvisioningPolicy(f.context, claim)).toMatchObject({
    organizationId: f.scope.organizationId,
    ownerEnabled: false,
    realm: {
      projectId: f.scope.projectId,
      environmentId: f.scope.environmentId,
      configurationRevision: 1,
    },
  });
  await expect(
    readNativeAuthProvisioningPolicy(f.context, {
      ...claim,
      claimId: "00000000000000000000000001",
    }),
  ).rejects.toThrow();
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET enabled=1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(f.scope.organizationId, f.scope.projectId, f.scope.environmentId)
    .run();
  await expect(
    reserveNativeAuthDatabaseOperation(f.context, {
      ...input,
      organizationId: "00000000000000000000000001",
    }),
  ).rejects.toThrow();
  const reserved = await reserveNativeAuthDatabaseOperation(f.context, input);
  expect(reserved).toMatchObject({
    state: "reserved",
    databaseId: null,
    providerOperationId: null,
  });
  expect(await reserveNativeAuthDatabaseOperation(f.context, input)).toEqual(reserved);
  const config = await ownerStore.identity.readNativeAuthConfig(ownerScope);
  if (!config) throw new Error("missing_config");
  const proof = {
    ...ownerScope,
    configurationRevision: config.configurationRevision,
    revocationEpoch: config.revocationEpoch,
    enabled: config.enabled,
    canonicalOrigin: config.canonicalOrigin,
  };
  // A real reserved effect remains ineligible through dispatch, uncertainty and observation.
  expect(await ownerStore.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(false);

  await expect(
    control.core
      .prepare(
        `INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'other-key','reserved')`,
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.environmentId,
        "00000000000000000000000002",
        "00000000000000000000000003",
        input.providerProjectId,
        input.name,
        input.regionId,
        input.sizeClassId,
      )
      .run(),
  ).rejects.toThrow();
  expect(await beginNativeAuthDatabaseOperation(f.context, claim)).toBe("dispatch");
  expect(await beginNativeAuthDatabaseOperation(f.context, claim)).toBe("observe");
  expect(await ownerStore.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(false);
  await expect(
    control.core
      .prepare("UPDATE operations SET state='failed' WHERE organization_id=?1 AND operation_id=?2")
      .bind(claim.organizationId, claim.operationId)
      .run(),
  ).rejects.toThrow();
  await expect(
    control.core
      .prepare(
        "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND claim_id=?3",
      )
      .bind(claim.organizationId, claim.projectId, claim.claimId)
      .run(),
  ).rejects.toThrow();
  await control.core
    .prepare(
      "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(f.scope.organizationId, f.scope.projectId)
    .run();
  await expect(beginNativeAuthDatabaseOperation(f.context, claim)).rejects.toThrow();
  await expect(readNativeAuthProvisioningPolicy(f.context, claim)).rejects.toThrow();
  const observation = {
    ...claim,
    providerProjectId: input.providerProjectId,
    databaseId: "a1234567890123456789",
    providerOperationId: "op_12345678901234567890",
  };
  const target = await recordNativeAuthDatabaseObservation(f.context, observation);
  expect(target).toMatchObject({
    databaseId: observation.databaseId,
    providerOperationId: observation.providerOperationId,
    targetVersion: 1,
  });
  expect(await recordNativeAuthDatabaseObservation(f.context, observation)).toEqual(target);
  expect(
    await control.core
      .prepare(
        "SELECT state FROM native_auth_database_operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3",
      )
      .bind(claim.organizationId, claim.projectId, claim.operationId)
      .first(),
  ).toEqual({ state: "observed" });
  await expect(
    recordNativeAuthDatabaseObservation(f.context, {
      ...observation,
      databaseId: "b1234567890123456789",
    }),
  ).rejects.toThrow();
  const row = await control.core
    .prepare(
      "SELECT database_id,region_id,size_class_id,billable_from,started_at FROM native_auth_database_targets WHERE project_id=?1",
    )
    .bind(f.scope.projectId)
    .first<Record<string, string>>();
  expect(row).toMatchObject({
    database_id: observation.databaseId,
    region_id: "eu-dev",
    size_class_id: "r256-s500m",
  });
  expect(Date.parse(row?.["billable_from"] ?? "")).toBeLessThanOrEqual(
    Date.parse(row?.["started_at"] ?? ""),
  );
  await control.core
    .prepare("UPDATE projects SET owner_state='active' WHERE organization_id=?1 AND project_id=?2")
    .bind(f.scope.organizationId, f.scope.projectId)
    .run();
  await control.core
    .prepare("UPDATE project_mail_domain_bindings SET state='active',sending=1 WHERE project_id=?1")
    .bind(f.scope.projectId)
    .run();
  expect(await reserveNativeAuthDatabaseOperation(f.context, input)).toMatchObject({
    state: "observed",
    databaseId: observation.databaseId,
    idempotencyKey: reserved.idempotencyKey,
  });
  const role = {
    ...claim,
    providerProjectId: input.providerProjectId,
    databaseId: observation.databaseId,
    roleName: `omh_ab_${f.scope.projectId.toLowerCase()}`,
  };
  const roleReservation = await reserveNativeAuthRoleOperation(f.context, role);
  expect(roleReservation.state).toBe("reserved");
  expect(await beginNativeAuthRoleOperation(f.context, role)).toBe("dispatch");
  expect(await beginNativeAuthRoleOperation(f.context, role)).toBe("observe");
  expect(
    await control.core
      .prepare(
        "SELECT environment_id,state,idempotency_key FROM native_auth_role_operations WHERE project_id=?1 AND role_name=?2",
      )
      .bind(f.scope.projectId, role.roleName)
      .first(),
  ).toEqual({
    environment_id: f.scope.environmentId,
    state: "dispatched",
    idempotency_key: roleReservation.idempotencyKey,
  });
  await control.core
    .prepare(
      "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(f.scope.organizationId, f.scope.projectId)
    .run();
  const roleResult = {
    ...role,
    idempotencyKey: roleReservation.idempotencyKey,
    providerOperationId: null,
    state: "succeeded" as const,
  };
  expect(await recordNativeAuthRoleObservation(f.context, roleResult)).toEqual({
    status: "recorded",
  });
  await control.core
    .prepare("UPDATE projects SET owner_state='active' WHERE organization_id=?1 AND project_id=?2")
    .bind(f.scope.organizationId, f.scope.projectId)
    .run();
  await control.core
    .prepare("UPDATE project_mail_domain_bindings SET state='active',sending=1 WHERE project_id=?1")
    .bind(f.scope.projectId)
    .run();
  const requestId = newUlid();
  const eventId = crypto.randomUUID();
  await control.core.batch([
    control.core
      .prepare(
        `INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,requested_at,updated_at) VALUES(?1,?2,?3,'fixture',zeroblob(32),zeroblob(32),zeroblob(32),?4,?4)`,
      )
      .bind(requestId, f.scope.organizationId, f.scope.projectId, "2099-01-01T00:00:00.000000Z"),
    control.core
      .prepare(
        `INSERT INTO mail_send_events(provider_event_id,organization_id,project_id,request_id,provider_message_id,event_type,outcome,detail_sha256,occurred_at,sent_at,received_at,reputation_kind) VALUES(?1,?2,?3,?4,'message','Bounce','bounced',zeroblob(32),?5,?5,?5,'hard_bounce')`,
      )
      .bind(
        eventId,
        f.scope.organizationId,
        f.scope.projectId,
        requestId,
        "2099-01-01T00:00:00.000000Z",
      ),
    control.core
      .prepare(
        `UPDATE mail_reputation_states SET state='suspended',suspended_at=?3,suspension_reason='bounce_rate',triggering_event_id=?4,version=version+1,updated_at=?3 WHERE organization_id=?1 AND project_id=?2`,
      )
      .bind(f.scope.organizationId, f.scope.projectId, "2099-01-01T00:00:00.000000Z", eventId),
  ]);
  const suspended = await control.core
    .prepare("SELECT * FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2")
    .bind(f.scope.organizationId, f.scope.projectId)
    .first();
  await initializeNativeAuthRealm(f.context, claim);
  expect(
    await control.core
      .prepare("SELECT * FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2")
      .bind(f.scope.organizationId, f.scope.projectId)
      .first(),
  ).toEqual(suspended);
  expect(await ownerStore.identity.proveNativeAuthUnprovisionedPolicy(proof)).toBe(false);
  expect(
    await control.core
      .prepare(
        "SELECT environment_id,state,idempotency_key FROM native_auth_role_operations WHERE project_id=?1 AND role_name=?2",
      )
      .bind(f.scope.projectId, role.roleName)
      .first(),
  ).toEqual({
    environment_id: f.scope.environmentId,
    state: "succeeded",
    idempotency_key: roleReservation.idempotencyKey,
  });
  const environment = f.scope.environmentId.toLowerCase();
  for (const roleName of [`omh_ar_${environment}`, `omh_am_${environment}`]) {
    const nextRole = { ...role, roleName };
    const nextReservation = await reserveNativeAuthRoleOperation(f.context, nextRole);
    await beginNativeAuthRoleOperation(f.context, nextRole);
    await recordNativeAuthRoleObservation(f.context, {
      ...nextRole,
      idempotencyKey: nextReservation.idempotencyKey,
      providerOperationId: null,
      state: "succeeded",
    });
  }
  const prep = {
    ...claim,
    providerProjectId: input.providerProjectId,
    databaseId: observation.databaseId,
    targetVersion: 1,
    schema: `omh_auth_${environment}`,
    runtimeRole: `omh_ar_${environment}`,
    migratorRole: `omh_am_${environment}`,
    backupRole: role.roleName,
    migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
    migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
  };
  await expect(
    recordNativeAuthPreparation(f.context, { ...prep, migrationDigest: "0".repeat(64) }),
  ).rejects.toThrow();
  expect(await recordNativeAuthPreparation(f.context, prep)).toEqual({ status: "recorded" });
  await control.core
    .prepare(
      "UPDATE cloudflare_project_domains SET deleted_at='2026-01-01T00:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(f.scope.organizationId, f.scope.projectId)
    .run();
  expect(await initializeNativeAuthRealm(f.context, claim)).toMatchObject({
    status: "origin_pending",
    canonicalOrigin: null,
  });
  expect(await recordNativeAuthPreparation(f.context, prep)).toEqual({ status: "recorded" });
  expect(await recordNativeAuthRoleObservation(f.context, roleResult)).toEqual({
    status: "recorded",
  });
  // A normal, non-MCP effect keeps the original source-generation fence in its own commit batch.
  expect(
    await control.core
      .prepare("SELECT 1 FROM operation_mcp_delegations WHERE operation_id=?")
      .bind(claim.operationId)
      .first(),
  ).toBeNull();
  const { db: fenced } = await f.context.router.routeOrganization(claim.organizationId);
  const sourceGuards = await nativeAuthEffectGuards(f.context, fenced, claim);
  const realmBeforeRace = await control.core
    .prepare("SELECT app_name FROM native_auth_realms WHERE project_id=? AND environment_id=?")
    .bind(claim.projectId, claim.environmentId)
    .first();
  const changed = await control.core
    .prepare(
      "UPDATE project_source_bindings SET generation=generation+1 WHERE organization_id=? AND project_id=?",
    )
    .bind(claim.organizationId, claim.projectId)
    .run();
  expect(changed.meta.changes).toBe(1);
  await expect(
    fenced.batch([
      ...sourceGuards,
      fenced
        .prepare(
          "UPDATE native_auth_realms SET app_name='raced' WHERE project_id=? AND environment_id=?",
        )
        .bind(claim.projectId, claim.environmentId),
    ]),
  ).rejects.toThrow("source_head_conflict");
  expect(
    await control.core
      .prepare("SELECT app_name FROM native_auth_realms WHERE project_id=? AND environment_id=?")
      .bind(claim.projectId, claim.environmentId)
      .first(),
  ).toEqual(realmBeforeRace);
  await control.core
    .prepare("UPDATE operations SET state='succeeded' WHERE organization_id=?1 AND operation_id=?2")
    .bind(claim.organizationId, claim.operationId)
    .run();
  await control.core
    .prepare(
      "DELETE FROM product_provider_mutation_claims WHERE organization_id=?1 AND project_id=?2 AND claim_id=?3",
    )
    .bind(claim.organizationId, claim.projectId, claim.claimId)
    .run();
});

it("reconciles the PGCF placement through the actual Core resource commands", async () => {
  for (const admissionLoss of ["none", "paid", "sender", "launch"] as const) {
    const f = await mailFixture(control, true, {
      ...sourceFrameworkPlan(false),
      auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
    });
    await fundMailFixture(control, f);
    const scope = { ...f.scope, ...f.fixture.accepted },
      providerProjectId = "prj_12345678901234567890",
      databaseId = `b${admissionLoss === "none" ? "1" : admissionLoss === "paid" ? "2" : admissionLoss === "sender" ? "3" : "4"}234567890123456789`;
    const database = {
      id: databaseId,
      projectId: providerProjectId,
      name: `ohmyho-auth-${scope.projectId.toLowerCase()}`,
      regionId: "eu-dev",
      sizeClassId: "r256-s500m",
      resources: { memoryMiB: 256, cpuMillicores: 250, storageMiB: 500 },
      desiredState: "running" as const,
      observedState: "ready" as const,
      generation: 1,
      observedGeneration: 1,
      sleepAfterSeconds: 300,
    };
    const operation = {
      id: "op_12345678901234567890",
      projectId: providerProjectId,
      databaseId,
      generation: 1,
      kind: "database.create",
      status: "succeeded" as const,
      errorCode: null,
    };
    const provider = {
      projectId: providerProjectId,
      createDatabase: vi
        .fn()
        .mockRejectedValueOnce(new Error("lost reply"))
        .mockResolvedValue({ database, operation }),
      readDatabase: vi.fn().mockResolvedValue(database),
      readOperation: vi.fn().mockResolvedValue(operation),
    } as unknown as Parameters<typeof placeNativeAuthDatabase>[0];
    let core = createControlStore(control.bindings)
      .identity as unknown as NativeAuthResourceRuntime;
    let persistence = createNativeAuthPlacementPersistence(core);
    expect(await core.readNativeAuthDatabaseReconciliation(scope)).toBeNull();
    await expect(placeNativeAuthDatabase(provider, persistence, scope)).rejects.toThrow(
      "lost reply",
    );
    const dispatched = await core.readNativeAuthDatabaseReconciliation(scope);
    expect(dispatched).toMatchObject({
      claim: { ...scope, regionId: "eu-dev" },
      providerProjectId,
      operation: { databaseId: null, providerOperationId: null },
    });
    expect(
      await core.readNativeAuthDatabaseReconciliation({
        ...scope,
        claimId: "00000000000000000000000001",
      }),
    ).toBeNull();
    expect(
      await core.readNativeAuthDatabaseReconciliation({
        ...scope,
        environmentId: "00000000000000000000000001",
      }),
    ).toBeNull();
    const credit = createCreditCommands((command) => (input) => command(f.context, input));
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    const window = {
      from: hour.toISOString(),
      to: new Date(hour.getTime() + 3600000).toISOString(),
    };
    expect(await credit.readPendingNativeDatabaseCreates(window)).toEqual({
      holdFrom: window.from,
    });
    if (admissionLoss === "paid")
      await control.core
        .prepare("UPDATE credit_account SET paid_until=NULL WHERE organization_id=?1")
        .bind(scope.organizationId)
        .run();
    if (admissionLoss === "sender")
      await control.core
        .prepare("UPDATE project_mail_domain_bindings SET state='suspended' WHERE project_id=?1")
        .bind(scope.projectId)
        .run();
    if (admissionLoss === "launch") {
      core = createControlStore({ CONTROL_CORE: control.core })
        .identity as unknown as NativeAuthResourceRuntime;
      persistence = createNativeAuthPlacementPersistence(core);
      expect(await core.readNativeAuthDatabaseReconciliation(scope)).toEqual(dispatched);
    }
    expect(await placeNativeAuthDatabase(provider, persistence, scope)).toMatchObject({
      status: admissionLoss === "none" ? "ready" : "reconciliation_required",
      target: { databaseId, projectId: scope.projectId, regionId: "eu-dev" },
    });
    expect(await core.readNativeAuthDatabaseReconciliation(scope)).toBeNull();
    expect(await credit.readPendingNativeDatabaseCreates(window)).toEqual({ holdFrom: null });
    if (admissionLoss !== "none") {
      await expect(core.initializeNativeAuthRealm(scope)).rejects.toThrow();
      await expect(
        core.reserveNativeAuthDatabaseOperation({
          ...scope,
          providerProjectId,
          name: database.name,
          regionId: "eu-dev",
          sizeClassId: "r256-s500m",
        }),
      ).rejects.toThrow();
      await expect(
        core.reserveNativeAuthRoleOperation({
          ...scope,
          providerProjectId,
          databaseId,
          roleName: `omh_ar_${scope.environmentId.toLowerCase()}`,
        }),
      ).rejects.toThrow();
      await expect(placeNativeAuthDatabase(provider, persistence, scope)).rejects.toThrow();
      expect(provider.createDatabase).toHaveBeenCalledTimes(2);
    }
    expect(vi.mocked(provider.createDatabase).mock.calls[0]?.[0].idempotencyKey).toBe(
      vi.mocked(provider.createDatabase).mock.calls[1]?.[0].idempotencyKey,
    );
  }
});
