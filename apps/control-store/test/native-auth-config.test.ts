import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, type TestControl } from "./support/control-d1.js";
import { seedDevAccessProject } from "./support/dev-access-fixture.js";
import { losingWriteResponses } from "./support/platform-fixtures.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 120_000);
afterAll(async () => control?.dispose());

it("activates OAuth only for an approved project with its own credentials in that environment", async () => {
  const { project, principalId } = await seedDevAccessProject(control);
  const { organizationId, projectId, devEnvironmentId: environmentId } = project;
  const scope = { organizationId, projectId, environmentId, principalId };
  const allowlistStore = createControlStore({
    ...control.bindings,
    CONTROL_NATIVE_AUTH_LAUNCH_POLICY: JSON.stringify({
      mode: "allowlist",
      projects: [{ organizationId, projectId }],
    }),
  });
  const passwordStore = createControlStore(control.bindings);
  const realm = await allowlistStore.identity.updateNativeAuthConfig({
    ...scope,
    expectedRevision: 0,
    operationId: newUlid(),
    enabled: true,
    signupPolicy: "open",
    appName: "Example",
  });
  let revision = realm.configurationRevision;
  const encryptedSecret = {
    ciphertext: new Uint8Array(20).fill(7),
    nonce: new Uint8Array(12).fill(8),
    valueSha256: new Uint8Array(32).fill(9),
    keyVersion: 1,
  };
  for (const provider of ["google", "github"] as const) {
    const publicScope = { ...scope, provider };
    const providerScope = { organizationId, projectId, environmentId, provider };
    const enable = {
      ...publicScope,
      expectedRevision: revision,
      operationId: newUlid(),
      enabled: true,
      clientId: `example-${provider}`,
    };
    await expect(allowlistStore.identity.updateNativeAuthProvider(enable)).rejects.toMatchObject({
      code: "native_auth_provider_incomplete",
    });
    const credentials = { ...enable, encryptedSecret };
    await expect(
      passwordStore.identity.updateNativeAuthProvider(credentials),
    ).rejects.toMatchObject({
      code: "native_auth_provider_unavailable",
    });
    const enabled = await allowlistStore.identity.updateNativeAuthProvider(credentials);
    revision += 1;
    expect(enabled).toMatchObject({
      enabled: true,
      secretPresent: true,
      configurationRevision: revision,
    });
    expect(
      await allowlistStore.identity.resolveNativeAuthProviderPolicy(providerScope),
    ).toMatchObject({
      enabled: true,
      configurationRevision: revision,
    });
    expect(
      await passwordStore.identity.resolveNativeAuthProviderPolicy(providerScope),
    ).toMatchObject({
      enabled: false,
    });
    const privateScope = { ...providerScope, configurationRevision: revision };
    expect(
      await allowlistStore.identity.readNativeAuthProviderEnvelope(privateScope),
    ).toMatchObject({
      clientId: enable.clientId,
      ciphertext: encryptedSecret.ciphertext,
    });
    expect(await passwordStore.identity.readNativeAuthProviderEnvelope(privateScope)).toBeNull();
    expect(
      await allowlistStore.identity.readNativeAuthProviderEnvelope({
        ...privateScope,
        environmentId: project.prodEnvironmentId,
      }),
    ).toBeNull();
    await allowlistStore.identity.updateNativeAuthProvider({
      ...enable,
      expectedRevision: revision,
      operationId: newUlid(),
      enabled: false,
    });
    revision += 1;
    expect(
      await allowlistStore.identity.resolveNativeAuthProviderPolicy(providerScope),
    ).toMatchObject({
      enabled: false,
      configurationRevision: revision,
    });
    expect(
      await allowlistStore.identity.readNativeAuthProviderEnvelope({
        ...privateScope,
        configurationRevision: revision,
      }),
    ).toBeNull();
  }
});

it("stores owner policy with revision fences, replay and pause revocation", async () => {
  const { project, principalId, origin } = await seedDevAccessProject(control);
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
  const first = {
    ...scope,
    expectedRevision: 0,
    operationId: newUlid(),
    enabled: true,
    signupPolicy: "open" as const,
    appName: "Example",
  };
  const created = await store.identity.updateNativeAuthConfig(first);
  expect(created).toEqual({
    configurationRevision: 1,
    revocationEpoch: 1,
    enabled: true,
    signupPolicy: "open",
    appName: "Example",
    canonicalOrigin: origin,
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation"],
    resetPasswordPath: "/reset-password",
    invitationPath: "/accept-invitation",
  });
  expect(await store.identity.updateNativeAuthConfig(first)).toEqual(created);
  const deniedStore = createControlStore({ CONTROL_CORE: control.core });
  await expect(
    deniedStore.identity.updateNativeAuthConfig({
      ...first,
      operationId: newUlid(),
      expectedRevision: 1,
    }),
  ).rejects.toMatchObject({ code: "native_auth_launch_unavailable" });

  expect(await store.identity.readNativeAuthReadiness(scope)).toEqual({
    paid: false,
    sender: false,
    origin: true,
    storage: false,
  });
  await expect(
    store.identity.updateNativeAuthConfig({ ...first, appName: "Different" }),
  ).rejects.toMatchObject({ code: "native_auth_idempotency_conflict" });
  await expect(
    store.identity.updateNativeAuthConfig({ ...first, operationId: newUlid() }),
  ).rejects.toMatchObject({ code: "native_auth_revision_conflict" });
  const losingStore = createControlStore({
    ...control.bindings,
    CONTROL_CORE: losingWriteResponses(control.core, 1),
  });
  const edited = await losingStore.identity.updateNativeAuthConfig({
    ...first,
    expectedRevision: 1,
    operationId: newUlid(),
    appName: "Renamed",
  });
  expect(edited).toMatchObject({ configurationRevision: 2, revocationEpoch: 1 });
  const paused = await deniedStore.identity.updateNativeAuthConfig({
    ...first,
    expectedRevision: 2,
    operationId: newUlid(),
    enabled: false,
  });
  expect(paused).toMatchObject({ configurationRevision: 3, revocationEpoch: 2 });
  expect(await store.identity.readNativeAuthConfig(scope)).toEqual(paused);
  const provider = {
    ...scope,
    provider: "google" as const,
    expectedRevision: 3,
    operationId: newUlid(),
    enabled: false,
    clientId: "client",
    encryptedSecret: {
      ciphertext: new Uint8Array(20).fill(7),
      nonce: new Uint8Array(12).fill(8),
      valueSha256: new Uint8Array(32).fill(9),
      keyVersion: 1,
    },
  };
  await expect(
    store.identity.updateNativeAuthProvider({ ...provider, enabled: true }),
  ).rejects.toMatchObject({ code: "native_auth_provider_unavailable" });
  // A committed provider update whose D1 response is lost must recover the original receipt.
  const providerLosingStore = createControlStore({
    ...control.bindings,
    CONTROL_CORE: losingWriteResponses(control.core, 1),
  });
  const configured = await providerLosingStore.identity.updateNativeAuthProvider(provider);
  expect(configured).toEqual({
    provider: "google",
    enabled: false,
    clientId: "client",
    secretPresent: true,
    configurationRevision: 4,
    lastSuccessfulFlowAt: null,
  });
  expect(
    await store.identity.updateNativeAuthProvider({
      ...provider,
      encryptedSecret: {
        ...provider.encryptedSecret,
        nonce: new Uint8Array(12).fill(5),
        ciphertext: new Uint8Array(20).fill(6),
        keyVersion: 2,
      },
    }),
  ).toEqual(configured);
  const audit = await control.core
    .prepare(
      "SELECT payload FROM audit_events WHERE organization_id=?1 AND event_type='NativeAuthProviderChanged'",
    )
    .bind(scope.organizationId)
    .all<{ payload: string }>();
  expect(audit.results).toHaveLength(1);
  expect(JSON.parse(audit.results[0]?.payload ?? "{}")).toEqual({
    environmentId: scope.environmentId,
    provider: "google",
    enabled: false,
    configurationRevision: 4,
    secretPresent: true,
  });
  expect(await store.identity.readNativeAuthProvider({ ...scope, provider: "google" })).toEqual(
    configured,
  );
  expect(await store.identity.readNativeAuthConfig(scope)).toMatchObject({
    revocationEpoch: 2,
    configurationRevision: 4,
  });
  const privateScope = {
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    provider: "google" as const,
    configurationRevision: 4,
  };
  expect(await store.identity.readNativeAuthProviderEnvelope(privateScope)).toBeNull();
  await store.identity.updateNativeAuthConfig({
    ...first,
    expectedRevision: 4,
    operationId: newUlid(),
    enabled: true,
  });
  expect(await store.identity.readNativeAuthProviderEnvelope(privateScope)).toBeNull();
  expect(
    await store.identity.readNativeAuthProviderEnvelope({
      ...privateScope,
      configurationRevision: 5,
    }),
  ).toBeNull();
  expect(
    await store.identity.readNativeAuthProviderEnvelope({
      ...privateScope,
      environmentId: newUlid(),
      configurationRevision: 5,
    }),
  ).toBeNull();
  await expect(
    store.identity.updateNativeAuthConfig({
      ...first,
      expectedRevision: 5,
      operationId: newUlid(),
      handoffDelegation: {
        grantId: "00000000-0000-4000-8000-000000000001",
        clientId: "client",
        consentHash: "ab".repeat(32),
        action: "auth:manage",
      },
    }),
  ).rejects.toThrow();
  expect(await store.identity.readNativeAuthConfig(scope)).toMatchObject({
    configurationRevision: 5,
  });
  const raced = await Promise.allSettled([
    store.identity.updateNativeAuthConfig({
      ...first,
      expectedRevision: 5,
      operationId: newUlid(),
      appName: "First",
    }),
    store.identity.updateNativeAuthConfig({
      ...first,
      expectedRevision: 5,
      operationId: newUlid(),
      appName: "Second",
    }),
  ]);
  expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
  await control.core
    .prepare(
      "UPDATE native_auth_providers SET last_success_at='2026-10-28T10:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND provider='google'",
    )
    .bind(scope.organizationId, scope.projectId, scope.environmentId)
    .run();
  expect(
    await store.identity.readNativeAuthProvider({ ...scope, provider: "google" }),
  ).toMatchObject({ lastSuccessfulFlowAt: "2026-10-28T10:00:00.000Z" });
  const disableProvider = {
    ...scope,
    provider: "google" as const,
    expectedRevision: 6,
    operationId: newUlid(),
    enabled: false,
  };
  const disabled = await store.identity.updateNativeAuthProvider(disableProvider);
  expect(disabled).toMatchObject({
    clientId: "client",
    secretPresent: true,
    configurationRevision: 7,
    lastSuccessfulFlowAt: null,
  });
  expect(
    await store.identity.resolveNativeAuthProviderPolicy({
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      provider: "google",
    }),
  ).toMatchObject({
    provider: "google",
    enabled: false,
    configurationRevision: 7,
    revocationEpoch: 2,
    realmEnabled: true,
    canonicalOrigin: origin,
  });
  await store.identity.updateNativeAuthProvider({
    ...disableProvider,
    expectedRevision: 7,
    operationId: newUlid(),
    clientId: "new-client",
  });
  expect(await store.identity.updateNativeAuthProvider(disableProvider)).toEqual(disabled);
  await expect(
    store.identity.updateNativeAuthConfig({
      ...first,
      expectedRevision: 8,
      operationId: newUlid(),
      canonicalOrigin: "https://foreign.example",
    }),
  ).rejects.toMatchObject({ code: "native_auth_origin_unapproved" });
  await expect(
    store.identity.updateNativeAuthConfig({
      ...first,
      expectedRevision: 8,
      operationId: newUlid(),
      allowedRedirectPaths: ["/login"],
    }),
  ).rejects.toMatchObject({ code: "native_auth_paths_invalid" });
  await expect(
    store.identity.updateNativeAuthConfig({
      ...first,
      expectedRevision: 8,
      operationId: newUlid(),
      resetPasswordPath: "/../bad",
    }),
  ).rejects.toThrow();
  const paths = await store.identity.updateNativeAuthConfig({
    ...first,
    expectedRevision: 8,
    operationId: newUlid(),
    allowedRedirectPaths: ["/", "/login", "/reset-password", "/accept-invitation", "/welcome"],
  });
  expect(paths).toMatchObject({ configurationRevision: 9, revocationEpoch: 2 });
  await control.core
    .prepare(
      "UPDATE native_auth_providers SET last_success_at='2026-10-28T10:00:00.000000Z' WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND provider='google'",
    )
    .bind(scope.organizationId, scope.projectId, scope.environmentId)
    .run();
  const domains = await control.core
    .prepare(
      "SELECT handle,production_domain,development_domain FROM cloudflare_project_domains WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(scope.organizationId, scope.projectId)
    .first<{ handle: string; production_domain: string; development_domain: string }>();
  if (!domains) throw new Error("Missing domains");
  const newHandle = `${domains.handle}-new`;
  await control.core
    .prepare(
      "UPDATE cloudflare_project_domains SET handle=?3,production_domain=?4,development_domain=?5 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(
      scope.organizationId,
      scope.projectId,
      newHandle,
      `${newHandle}${domains.production_domain.slice(domains.handle.length)}`,
      `dev-${newHandle}${domains.development_domain.slice(domains.handle.length + 4)}`,
    )
    .run();
  expect(await store.identity.readNativeAuthConfig(scope)).toMatchObject({
    canonicalOrigin: null,
    configurationRevision: 10,
    revocationEpoch: 3,
  });
  expect(
    await store.identity.readNativeAuthProvider({ ...scope, provider: "google" }),
  ).toMatchObject({ lastSuccessfulFlowAt: null });
  await control.core
    .prepare(
      "UPDATE cloudflare_project_domains SET handle=?3,production_domain=?4,development_domain=?5 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(
      scope.organizationId,
      scope.projectId,
      domains.handle,
      domains.production_domain,
      domains.development_domain,
    )
    .run();
  expect(await store.identity.readNativeAuthConfig(scope)).toMatchObject({
    canonicalOrigin: null,
    configurationRevision: 10,
    revocationEpoch: 3,
  });
  const cleared = await store.identity.updateNativeAuthConfig({
    ...first,
    expectedRevision: 10,
    operationId: newUlid(),
    canonicalOrigin: null,
  });
  expect(cleared).toMatchObject({
    canonicalOrigin: origin,
    configurationRevision: 11,
    revocationEpoch: 4,
  });
  const adminScope = { ...scope, requestId: "request", intent: "users-list" as const };
  expect(await store.identity.authorizeNativeAuthOwnerOperation(adminScope)).toBe(true);
  expect(
    await store.identity.authorizeNativeAuthOwnerOperation({
      ...adminScope,
      principalId: "user:user_other",
    }),
  ).toBe(false);
  expect(
    await store.identity.authorizeNativeAuthOwnerOperation({
      ...adminScope,
      delegation: {
        grantId: "00000000-0000-4000-8000-000000000001",
        clientId: "client",
        consentHash: "ab".repeat(32),
        action: "auth:read",
      },
    }),
  ).toBe(false);
  await control.core
    .prepare(
      "UPDATE native_auth_realms SET revocation_epoch=2147483647 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(scope.organizationId, scope.projectId, scope.environmentId)
    .run();
  await expect(
    store.identity.updateNativeAuthConfig({
      ...first,
      expectedRevision: 11,
      operationId: newUlid(),
      enabled: false,
    }),
  ).rejects.toMatchObject({ code: "native_auth_epoch_exhausted" });
  expect(
    await store.identity.readNativeAuthConfig({ ...scope, environmentId: newUlid() }),
  ).toBeNull();
  expect(
    await store.identity.readNativeAuthConfig({ ...scope, principalId: "user:user_other" }),
  ).toBeNull();
  await control.core
    .prepare("UPDATE organization_memberships SET state='revoked' WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  await expect(store.identity.updateNativeAuthConfig(first)).rejects.toMatchObject({
    code: "native_auth_owner_required",
  });
});

it("freezes a realm after an origin-loss transition until its exact policy acknowledgement", async () => {
  const { project, principalId, origin } = await seedDevAccessProject(control);
  await control.core
    .prepare("UPDATE organizations SET beta_admitted_at=created_at WHERE organization_id=?1")
    .bind(project.organizationId)
    .run();
  const store = createControlStore(control.bindings),
    scope = {
      organizationId: project.organizationId,
      projectId: project.projectId,
      environmentId: project.devEnvironmentId,
      principalId,
    };
  const create = {
    ...scope,
    expectedRevision: 0,
    operationId: newUlid(),
    enabled: true,
    signupPolicy: "open" as const,
    appName: "App",
  };
  await store.identity.updateNativeAuthConfig(create);
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO native_auth_domain_operations(organization_id,project_id,kind,identity,original_input,state) VALUES(?1,?2,'handle_change','identity','{}','pending')",
      )
      .bind(scope.organizationId, scope.projectId),
    control.core
      .prepare(
        "INSERT INTO native_auth_domain_policy_syncs(organization_id,project_id,kind,identity,environment_id,old_origin,head_version,configuration_revision,revocation_epoch,owner_enabled,state) VALUES(?1,?2,'handle_change','identity',?3,?4,0,2,2,1,'pending')",
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId, origin),
    control.core
      .prepare(
        "UPDATE native_auth_realms SET canonical_origin=NULL,configuration_revision=configuration_revision+1,revocation_epoch=revocation_epoch+1 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId),
  ]);
  await expect(
    store.identity.updateNativeAuthConfig({
      ...create,
      expectedRevision: 2,
      operationId: newUlid(),
      appName: "Changed",
    }),
  ).rejects.toThrow("native auth domain policy acknowledgement pending");
  await control.core
    .prepare(
      "UPDATE native_auth_domain_policy_syncs SET state='acknowledged',acknowledgement='{}' WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
    )
    .bind(scope.organizationId, scope.projectId, scope.environmentId)
    .run();
  expect(
    await store.identity.updateNativeAuthConfig({
      ...create,
      expectedRevision: 2,
      operationId: newUlid(),
      appName: "Changed",
    }),
  ).toMatchObject({ configurationRevision: 3 });
});
