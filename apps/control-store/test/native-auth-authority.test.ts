import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createControlStore } from "../src/store.js";
import { resolveNativeAuthAtomicSnapshot } from "../src/catalog/identity/native-auth-authority.js";
import { SharedCoreRouter, bucketOf } from "../src/router.js";
import type { D1Database } from "../src/d1-types.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { gatewayFixture } from "./gateway/gateway-fixture.js";
import { sourceFrameworkPlan } from "./support/provider-fixtures.js";
import { seedOperation } from "./support/accepted-operation.js";
import { seedDevAccessProject } from "./support/dev-access-fixture.js";
import { mailFixture, fundMailFixture } from "./mail/mail-fixture.js";
import {
  NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
  NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
} from "@ohmyhost/contracts/native-auth";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control?.dispose());

async function markPrepared(scope: {
  organizationId: string;
  projectId: string;
  environmentId: string;
}) {
  const databaseId = `d${newUlid().toLowerCase().slice(-19)}`,
    provider = `prj_${newUlid().toLowerCase().slice(-20)}`,
    operation = newUlid(),
    claim = newUlid(),
    schema = `omh_auth_${scope.environmentId.toLowerCase()}`,
    role = `omh_ar_${scope.environmentId.toLowerCase()}`;
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,?3,?4,'op_fixture','eu-dev','r256-s500m',1,'2026-10-28T09:20:00.000000Z','2026-10-28T09:00:00.000000Z')",
      )
      .bind(scope.organizationId, scope.projectId, provider, databaseId),
    control.core
      .prepare(
        "INSERT INTO native_auth_registrations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,region_id,origin_host,schema_name,role_name,target_version,registry_version,registry_reference,state) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu-dev','db.example',?8,?9,1,1,?10,'active')",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        operation,
        claim,
        provider,
        databaseId,
        schema,
        role,
        `${scope.projectId}:${scope.environmentId}`,
      ),
    control.core
      .prepare(
        "INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?9,?10,?11,?12,?13)",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        operation,
        claim,
        provider,
        databaseId,
        schema,
        role,
        `omh_am_${scope.environmentId.toLowerCase()}`,
        `omh_ab_${scope.projectId.toLowerCase()}`,
        NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      ),
  ]);
  return { databaseId, schema, role };
}

it("resolves current source, owner, origin and Paid admission and fences source rollback", async () => {
  const plan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const fixture = await gatewayFixture(control, { frameworkPlan: plan });
  const { organizationId, projectId, environmentId } = fixture.scope;
  const scope = { projectId, environmentId };
  expect(await fixture.store.gateway.lookup.resolve({ hostname: fixture.hostname })).toMatchObject({
    nativeAuth: { realmGeneration: null, configurationRevision: null, region: "eu" },
  });
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
      )
      .bind(organizationId, projectId, environmentId, `https://${fixture.hostname}`),
    control.core
      .prepare(
        "INSERT INTO credit_account(organization_id,monthly_micros,monthly_ends_at,paid_until,paid_source,updated_at) VALUES(?1,1000000000,'2999-01-01T00:00:00.000000Z','2999-01-01T00:00:00.000000Z','manual','2026-10-28T10:00:00.000000Z') ON CONFLICT(organization_id) DO UPDATE SET monthly_micros=1000000000,monthly_ends_at='2999-01-01T00:00:00.000000Z',paid_until='2999-01-01T00:00:00.000000Z',paid_source='manual'",
      )
      .bind(organizationId),
  ]);
  const store = createControlStore(control.bindings);
  expect(await store.gateway.lookup.resolve({ hostname: fixture.hostname })).toMatchObject({
    nativeAuth: { realmGeneration: 1, configurationRevision: 1, region: "eu" },
  });
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET enabled=0 WHERE organization_id=?1 AND environment_id=?2",
    )
    .bind(organizationId, environmentId)
    .run();
  expect(await store.gateway.lookup.resolve({ hostname: fixture.hostname })).toMatchObject({
    nativeAuth: { realmGeneration: 1, configurationRevision: 1 },
  });
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET enabled=1 WHERE organization_id=?1 AND environment_id=?2",
    )
    .bind(organizationId, environmentId)
    .run();
  for (const policy of [
    undefined,
    "not-json",
    '{"mode":"disabled"}',
    '{"mode":"password-general-availability","extra":true}',
    JSON.stringify({ mode: "allowlist", projects: [{ organizationId: newUlid(), projectId }] }),
    JSON.stringify({ mode: "allowlist", projects: [{ organizationId, projectId: newUlid() }] }),
  ]) {
    const denied = createControlStore({
      CONTROL_CORE: control.core,
      ...(policy === undefined ? {} : { CONTROL_NATIVE_AUTH_LAUNCH_POLICY: policy }),
    });
    expect(await denied.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
      enabled: false,
      sourceCapable: false,
      runtimeAllowed: false,
    });
  }
  const allowlisted = createControlStore({
    CONTROL_CORE: control.core,
    CONTROL_NATIVE_AUTH_LAUNCH_POLICY: JSON.stringify({
      mode: "allowlist",
      projects: [{ organizationId, projectId }],
    }),
  });
  expect(await allowlisted.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    enabled: true,
    sourceCapable: true,
  });
  const initial = await store.identity.resolveNativeAuthAuthority(scope);
  expect(initial).toMatchObject({
    organizationId,
    enabled: true,
    sourceCapable: true,
    paidAllowed: true,
    runtimeAllowed: false,
    realm: {
      ...scope,
      canonicalOrigin: `https://${fixture.hostname}`,
      realmGeneration: 1,
      configurationRevision: 1,
    },
  });
  await markPrepared({ organizationId, projectId, environmentId });
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    runtimeAllowed: true,
    storageReady: true,
  });
  if (initial.deploymentId === null) throw new Error("Missing deployment");
  const atomicScope = { ...scope, deploymentId: initial.deploymentId };
  const snapshot = await store.identity.resolveNativeAuthAtomicSnapshot(atomicScope);
  expect(snapshot.authority).toEqual(await store.identity.resolveNativeAuthAuthority(atomicScope));
  expect(snapshot.registration).toEqual(await store.identity.readNativeAuthRegistration(scope));
  expect(
    await store.identity.resolveNativeAuthAtomicSnapshot({
      ...atomicScope,
      organizationHint: organizationId,
    }),
  ).toEqual(snapshot);
  await expect(
    store.identity.resolveNativeAuthAtomicSnapshot({ ...atomicScope, organizationHint: newUlid() }),
  ).rejects.toThrow("auth_unavailable");
  const otherOwner = await seedDevAccessProject(control);
  await expect(
    store.identity.resolveNativeAuthAtomicSnapshot({
      ...atomicScope,
      organizationHint: otherOwner.project.organizationId,
    }),
  ).rejects.toThrow("auth_unavailable");
  await expect(
    store.identity.resolveNativeAuthAtomicSnapshot({ ...atomicScope, organizationHint: "invalid" }),
  ).rejects.toThrow();
  for (const invalid of [
    { ...atomicScope, environmentId: newUlid() },
    { ...atomicScope, deploymentId: newUlid() },
    { ...atomicScope, unexpected: newUlid() },
  ])
    await expect(store.identity.resolveNativeAuthAtomicSnapshot(invalid)).rejects.toThrow();
  const router = new SharedCoreRouter(control.core);
  const racingRouter = {
    routeOrganization: async (id: string) => {
      await control.core
        .prepare(
          "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(organizationId, projectId)
        .run();
      return router.routeOrganization(id);
    },
    routeBucket: (id: number) => router.routeBucket(id),
    routeShard: (id: number) => router.routeShard(id),
    assertLayout: () => router.assertLayout(),
    invalidate: () => router.invalidate(),
  };
  for (const candidate of [atomicScope, { ...atomicScope, organizationHint: organizationId }]) {
    try {
      await expect(
        resolveNativeAuthAtomicSnapshot(
          { directory: control.core, router: racingRouter },
          candidate,
        ),
      ).rejects.toThrow("auth_unavailable");
    } finally {
      await control.core
        .prepare(
          "UPDATE projects SET owner_state='active' WHERE organization_id=?1 AND project_id=?2",
        )
        .bind(organizationId, projectId)
        .run();
    }
  }
  // A stale routing hint must be rejected by the actual owner reread in the real fenced batch.
  const staleDirectory = {
    prepare: () => ({
      bind: () => ({ all: async () => ({ results: [{ organization_id: newUlid() }] }) }),
    }),
  } as unknown as D1Database;
  await expect(
    resolveNativeAuthAtomicSnapshot({ directory: staleDirectory, router }, atomicScope),
  ).rejects.toThrow("auth_unavailable");
  const bucket = await bucketOf(organizationId);
  await control.core
    .prepare(
      "INSERT INTO bucket_fences(bucket,state,move_id,fenced_at) VALUES(?1,'moved',?2,'2030-01-01T00:00:00.000000Z')",
    )
    .bind(bucket, newUlid())
    .run();
  try {
    await expect(
      resolveNativeAuthAtomicSnapshot({ directory: control.core, router }, atomicScope),
    ).rejects.toThrow("fenced");
  } finally {
    await control.core.prepare("DELETE FROM bucket_fences WHERE bucket=?1").bind(bucket).run();
  }
  const instant = Date.parse("2030-01-15T12:00:00.000Z");
  await control.core
    .prepare(
      "UPDATE credit_account SET paid_until='2030-01-15T12:00:00.001000Z' WHERE organization_id=?1",
    )
    .bind(organizationId)
    .run();
  const clock = vi.spyOn(Date, "now").mockReturnValue(instant);
  try {
    await expect(store.identity.resolveNativeAuthAtomicSnapshot(atomicScope)).rejects.toThrow(
      "auth_unavailable",
    );
    await control.core
      .prepare(
        "UPDATE credit_account SET paid_until='2030-01-15T12:00:00.001001Z' WHERE organization_id=?1",
      )
      .bind(organizationId)
      .run();
    expect(
      (await store.identity.resolveNativeAuthAtomicSnapshot(atomicScope)).authority.paidAllowed,
    ).toBe(true);
    await control.core
      .prepare(
        "UPDATE credit_account SET paid_until='2999-01-01T00:00:00.000000Z',monthly_ends_at='2030-01-15T11:59:59.999999Z' WHERE organization_id=?1",
      )
      .bind(organizationId)
      .run();
    await expect(store.identity.resolveNativeAuthAtomicSnapshot(atomicScope)).rejects.toThrow(
      "auth_unavailable",
    );
    await control.core
      .prepare(
        "UPDATE credit_account SET monthly_ends_at='2999-01-01T00:00:00.000000Z',exhausted_at='2030-01-08T12:00:00.000999Z' WHERE organization_id=?1",
      )
      .bind(organizationId)
      .run();
    await expect(store.identity.resolveNativeAuthAtomicSnapshot(atomicScope)).rejects.toThrow(
      "auth_unavailable",
    );
    await control.core
      .prepare("UPDATE credit_account SET exhausted_at=NULL WHERE organization_id=?1")
      .bind(organizationId)
      .run();
    clock.mockReturnValueOnce(instant).mockReturnValue(instant - 1);
    await expect(store.identity.resolveNativeAuthAtomicSnapshot(atomicScope)).rejects.toThrow(
      "auth_unavailable",
    );
    clock.mockReturnValueOnce(instant).mockReturnValue(instant - 1);
    await expect(
      store.identity.resolveNativeAuthAtomicSnapshot({
        ...atomicScope,
        organizationHint: organizationId,
      }),
    ).rejects.toThrow("auth_unavailable");
    await control.core
      .prepare(
        "UPDATE credit_account SET paid_until='2030-01-15T12:00:00.500000Z' WHERE organization_id=?1",
      )
      .bind(organizationId)
      .run();
    clock.mockReturnValueOnce(instant).mockReturnValue(instant + 1_000);
    await expect(store.identity.resolveNativeAuthAtomicSnapshot(atomicScope)).rejects.toThrow(
      "auth_unavailable",
    );
    await control.core
      .prepare(
        "UPDATE credit_account SET paid_until='2999-01-01T00:00:00.000000Z' WHERE organization_id=?1",
      )
      .bind(organizationId)
      .run();
    clock.mockReturnValue(Date.parse("2030-02-01T00:00:00.000Z"));
    await expect(store.identity.resolveNativeAuthAtomicSnapshot(atomicScope)).rejects.toThrow(
      "auth_unavailable",
    );
  } finally {
    clock.mockRestore();
  }
  await control.core
    .prepare(
      "UPDATE credit_account SET paid_until='2999-01-01T00:00:00.000000Z' WHERE organization_id=?1",
    )
    .bind(organizationId)
    .run();
  await control.core
    .prepare(
      "INSERT INTO native_auth_providers(organization_id,project_id,environment_id,provider,enabled,client_id) VALUES(?1,?2,?3,'google',1,'client')",
    )
    .bind(organizationId, projectId, environmentId)
    .run();
  expect(
    await store.identity.resolveNativeAuthProviderPolicy({
      organizationId,
      projectId,
      environmentId,
      provider: "google",
    }),
  ).toMatchObject({ enabled: false });
  const flow = {
    organizationId,
    projectId,
    environmentId,
    deploymentId: initial.deploymentId,
    provider: "google" as const,
    configurationRevision: 1,
    revocationEpoch: 1,
  };
  await store.identity.recordNativeAuthProviderSuccess(flow);
  expect(
    await control.core
      .prepare(
        "SELECT last_success_at FROM native_auth_providers WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND provider='google'",
      )
      .bind(organizationId, projectId, environmentId)
      .first(),
  ).toMatchObject({ last_success_at: expect.any(String) });
  await expect(
    store.identity.recordNativeAuthProviderSuccess({ ...flow, configurationRevision: 2 }),
  ).rejects.toThrow();
  await expect(
    store.identity.recordNativeAuthProviderSuccess({ ...flow, revocationEpoch: 2 }),
  ).rejects.toThrow();
  await control.core
    .prepare(
      "UPDATE native_auth_providers SET enabled=0 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND provider='google'",
    )
    .bind(organizationId, projectId, environmentId)
    .run();
  await expect(store.identity.recordNativeAuthProviderSuccess(flow)).rejects.toThrow();
  await control.core
    .prepare("UPDATE credit_account SET paid_until=NULL,paid_source=NULL WHERE organization_id=?1")
    .bind(organizationId)
    .run();
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    paidAllowed: false,
  });
  await control.core
    .prepare(
      "UPDATE credit_account SET paid_until='2999-01-01T00:00:00.000000Z',paid_source='manual' WHERE organization_id=?1",
    )
    .bind(organizationId)
    .run();
  await expect(
    store.identity.resolveNativeAuthAuthority({ ...scope, environmentId: newUlid() }),
  ).rejects.toThrow("auth_unavailable");
  const head = await control.core
    .prepare(
      "SELECT active_deployment_id,active_revision_id FROM environments WHERE organization_id=?1 AND environment_id=?2",
    )
    .bind(organizationId, environmentId)
    .first<{ active_deployment_id: string; active_revision_id: string }>();
  if (!head) throw new Error("Missing fixture head");
  await control.core
    .prepare(
      "UPDATE environments SET active_deployment_id=NULL,active_revision_id=NULL,head_version=head_version+1 WHERE organization_id=?1 AND environment_id=?2",
    )
    .bind(organizationId, environmentId)
    .run();
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    sourceCapable: false,
    revocationEpoch: 2,
  });
  await control.core
    .prepare(
      "UPDATE environments SET active_deployment_id=?3,active_revision_id=?4,head_version=head_version+1 WHERE organization_id=?1 AND environment_id=?2",
    )
    .bind(organizationId, environmentId, head.active_deployment_id, head.active_revision_id)
    .run();
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    sourceCapable: true,
    revocationEpoch: 2,
  });
  await control.core
    .prepare(
      "UPDATE cloudflare_project_domains SET deleted_at=configured_at WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(organizationId, projectId)
    .run();
  await expect(store.identity.resolveNativeAuthAuthority(scope)).rejects.toThrow(
    "auth_unavailable",
  );
  expect(
    await store.identity.resolveNativeAuthAdminAuthority({ ...scope, organizationId }),
  ).toMatchObject({ ownerEnabled: true, enabled: false, realm: { canonicalOrigin: null } });
});

it("admits Native mail only after storage proof and while the sender remains authorized", async () => {
  const plan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const mail = await mailFixture(control, true, plan);
  await fundMailFixture(control, mail);
  const { organizationId, projectId, environmentId } = mail.scope;
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(organizationId, projectId, environmentId, `https://${mail.fixture.hostname}`)
    .run();
  const store = createControlStore(control.bindings);
  expect(await store.identity.authorizeNativeMail(mail.scope)).toBeNull();
  await markPrepared(mail.scope);
  expect(await store.identity.authorizeNativeMail(mail.scope)).toMatchObject({
    ...mail.scope,
    domain: mail.domain,
    canonicalOrigin: `https://${mail.fixture.hostname}`,
    applicationName: "App",
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  });
  expect(
    await store.identity.authorizeNativeMail({ ...mail.scope, environmentId: newUlid() }),
  ).toBeNull();
  await mail.update(
    "UPDATE project_mail_domain_bindings SET state='detached',sending=0,revision=revision+1,updated_at=?1 WHERE project_id=?2",
    [new Date().toISOString(), projectId],
  );
  expect(await store.identity.authorizeNativeMail(mail.scope)).toBeNull();
});

it("does not reuse pre-import storage proof after a restore", async () => {
  const plan = {
    ...sourceFrameworkPlan(false),
    auth: { provider: "omh-native", routePath: "/api/auth/v1", bindingName: "OHMYHOST_AUTH" },
  };
  const f = await gatewayFixture(control, { frameworkPlan: plan }),
    { organizationId, projectId, environmentId } = f.scope;
  await control.core
    .prepare(
      "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
    )
    .bind(organizationId, projectId, environmentId, `https://${f.hostname}`)
    .run();
  const prepared = await markPrepared(f.scope),
    store = createControlStore(control.bindings),
    scope = { projectId, environmentId };
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    storageReady: true,
  });
  const exportId = await seedOperation(f.project),
    restoreId = newUlid();
  const manifest = JSON.stringify({
    schemaVersion: "ohmyhost.native-auth-inventory/v1",
    organizationId,
    projectId,
    databaseId: prepared.databaseId,
    migrationVersion: NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
    migrationDigest: NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
    realms: [
      { environmentId, schemaName: prepared.schema, revocationEpoch: 1, configurationRevision: 1 },
    ],
  });
  await control.core.batch([
    control.core
      .prepare(
        `INSERT INTO project_recovery_jobs(organization_id,operation_id,project_id,environment_id,input_expires_at,requested_at,archive_bucket,archive_bytes,archive_sha256,sql_files,native_manifest,native_manifest_sha256,captured_at,archive_expires_at,verified_at,finished_at) VALUES(?1,?2,?3,?4,'2026-10-28T11:00:00.000000Z','2026-10-28T10:00:00.000000Z','ohmyho-development-backups',123,?5,'["auth.sql"]',?6,?7,'2026-10-28T10:00:00.000000Z','2026-11-04T10:00:00.000000Z','2026-10-28T10:00:00.000000Z','2026-10-28T10:00:00.000000Z')`,
      )
      .bind(
        organizationId,
        exportId,
        projectId,
        environmentId,
        new Uint8Array(32).fill(2),
        manifest,
        new Uint8Array(32).fill(3),
      ),
    control.core
      .prepare(
        `INSERT INTO native_auth_restore_jobs(organization_id,project_id,restore_id,export_operation_id,archive_sha256,principal_id,input_ciphertext,input_nonce,input_key_version,input_digest,created_at,input_expires_at,claim_id,state) VALUES(?1,?2,?3,?4,?5,'user:fixture',?6,?7,1,?8,'2026-10-28T10:00:00.000000Z','2026-10-28T11:00:00.000000Z','00000000-0000-4000-8000-000000000001','claimed')`,
      )
      .bind(
        organizationId,
        projectId,
        restoreId,
        exportId,
        new Uint8Array(32).fill(2),
        new Uint8Array(17),
        new Uint8Array(12),
        new Uint8Array(32),
      ),
    control.core
      .prepare(
        `INSERT INTO native_auth_restore_pins(organization_id,project_id,restore_id,export_operation_id,claim_id,bucket,object_key,archive_bytes,archive_sha256,manifest_sha256,state) VALUES(?1,?2,?3,?4,'00000000-0000-4000-8000-000000000001','ohmyho-development-backups','restore-pins/'||?1||'/'||?2||'/'||?3||'.zip',123,?5,?6,'verified')`,
      )
      .bind(
        organizationId,
        projectId,
        restoreId,
        exportId,
        new Uint8Array(32).fill(2),
        new Uint8Array(32).fill(3),
      ),
    control.core
      .prepare(
        "INSERT INTO native_auth_restores(organization_id,project_id,restore_id,export_operation_id,database_id,archive_sha256,principal_id,restore_generation,captured_at,state) VALUES(?1,?2,?3,?4,?5,?6,'user:fixture',1,'2026-10-28T10:00:00.000000Z','restoring')",
      )
      .bind(
        organizationId,
        projectId,
        restoreId,
        exportId,
        prepared.databaseId,
        new Uint8Array(32).fill(2),
      ),
    control.core
      .prepare(
        "INSERT INTO native_auth_restore_realms(organization_id,project_id,restore_id,environment_id,revocation_epoch,configuration_revision) VALUES(?1,?2,?3,?4,1,1)",
      )
      .bind(organizationId, projectId, restoreId, environmentId),
    control.core
      .prepare(
        "INSERT INTO native_auth_restore_acknowledgements(organization_id,project_id,restore_id,environment_id,kind,revocation_epoch,configuration_revision) VALUES(?1,?2,?3,?4,'offline',1,1)",
      )
      .bind(organizationId, projectId, restoreId, environmentId),
    control.core
      .prepare(
        "INSERT INTO native_auth_restore_import_realms(organization_id,project_id,restore_id,environment_id,imported_at) VALUES(?1,?2,?3,?4,'2026-10-28T10:00:00.000000Z')",
      )
      .bind(organizationId, projectId, restoreId, environmentId),
    control.core
      .prepare(
        "INSERT INTO native_auth_restore_imports(organization_id,project_id,restore_id,imported_at) VALUES(?1,?2,?3,'2026-10-28T10:00:00.000000Z')",
      )
      .bind(organizationId, projectId, restoreId),
    control.core
      .prepare(
        "INSERT INTO native_auth_restore_acknowledgements(organization_id,project_id,restore_id,environment_id,kind,revocation_epoch,configuration_revision) VALUES(?1,?2,?3,?4,'sanitized',1,1)",
      )
      .bind(organizationId, projectId, restoreId, environmentId),
  ]);
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    storageReady: false,
  });
  const verify = (version: number) =>
    control.core
      .prepare(
        "INSERT INTO native_auth_restore_verifications(organization_id,project_id,restore_id,environment_id,target_version,registry_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version,verified_at) VALUES(?1,?2,?3,?4,1,?5,?6,?7,?8,?9,?10,?11,'2026-10-28T10:00:00.000000Z')",
      )
      .bind(
        organizationId,
        projectId,
        restoreId,
        environmentId,
        version,
        prepared.schema,
        prepared.role,
        `omh_am_${environmentId.toLowerCase()}`,
        `omh_ab_${projectId.toLowerCase()}`,
        NATIVE_AUTH_SCHEMA_MIGRATION_SHA256,
        NATIVE_AUTH_SCHEMA_MIGRATION_VERSION,
      );
  await verify(2).run();
  await expect(
    control.core
      .prepare(
        "UPDATE native_auth_restores SET state='complete' WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
      )
      .bind(organizationId, projectId, restoreId)
      .run(),
  ).rejects.toThrow("native auth restore proof missing");
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    storageReady: false,
  });
  await verify(1).run();
  await control.core
    .prepare(
      "UPDATE native_auth_restores SET state='complete' WHERE organization_id=?1 AND project_id=?2 AND restore_id=?3",
    )
    .bind(organizationId, projectId, restoreId)
    .run();
  expect(await store.identity.resolveNativeAuthAuthority(scope)).toMatchObject({
    storageReady: true,
  });
});
