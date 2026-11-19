import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createUlidFactory, SystemClock, SystemEntropy, parseUlid } from "@ohmyhost/platform";
import { CloudflareDomainRuntime } from "../../control-store/src/worker-main.js";
import { newUlid } from "../../control-store/src/catalog/common.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import {
  seedDeletionIntent,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { seam } from "../../control-store/test/support/wire.js";
import {
  PaidDomainAlreadyConfiguredError,
  PaidDomainDeletingError,
  PaidDomainHostnameTakenError,
  PaidDomainKeyConflictError,
  PaidDomainProductionDeploymentRequiredError,
} from "../src/paid-domains.js";
import { createD1PaidDomainPersistence } from "../src/d1-paid-persistence.js";
import { cfFixture } from "../../control-store/test/support/cf-mail-fixture.js";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

const ids = createUlidFactory({ clock: new SystemClock(), entropy: new SystemEntropy() }),
  iso = (delta = 0) => new Date(Date.now() + delta).toISOString(),
  digest = (fill: number) => `sha256:${fill.toString(16).padStart(2, "0").repeat(32)}`;
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
}, 60_000);
afterAll(async () => control.dispose());

const customHostnameReceipt = (hostname: string, observedAt = new Date()) =>
  ({
    customHostnameId: "1".repeat(32),
    hostname,
    customerCnameTarget: "customers.omh.st",
    status: "active",
    providerCreatedAt: null,
    ownershipVerification: { type: "txt", name: `_cf.${hostname}`, value: "token" },
    ownershipVerificationHttp: { httpUrl: `https://${hostname}/.well-known/x`, httpBody: "b" },
    verificationErrors: [],
    ssl: {
      sslId: null,
      status: null,
      type: null,
      method: null,
      bundleMethod: null,
      certificateAuthority: null,
      validationRecords: [],
      dcvDelegationRecords: [],
    },
    ready: true,
    dnsRecords: [],
    observedAt,
  }) as never;
const workerRouteReceipt = (hostname: string, observedAt = new Date()) =>
  ({
    routeId: "2".repeat(32),
    hostname,
    scriptName: "ohmyho-gateway-production",
    pattern: `${hostname}/*`,
    observedAt,
  }) as never;

it("claims, activates, reads and retires a Paid domain connection through the actual Core", async () => {
  const fixture = await cfFixture(control),
    project = fixture.project,
    scope = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
    },
    wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
    paid = createD1PaidDomainPersistence(wire.binding as never, ids),
    hostname = "app.paid-one.example",
    mutation = {
      principalId: "user:owner",
      idempotencyKeySha256: digest(1),
      requestSha256: digest(2),
    };

  // Admission follows the organization's plan and credit; the target waits for a healthy Prod deployment.
  expect(await paid.accessReason({ ...scope, now: iso() })).toBe("paid_plan_required");
  await makePaid(control.core, project.organizationId);
  expect(await paid.accessReason({ ...scope, now: iso() })).toBeNull();
  expect(await paid.readTarget(scope)).toBe("production_deployment_required");
  expect(
    await paid.readTarget({
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(newUlid()),
    }),
  ).toBeNull();
  expect(await paid.read(scope)).toBeNull();

  const awaiting = await paid.claimApply({
    ...scope,
    ...mutation,
    hostname,
    gatewayScriptName: null,
    now: iso(),
  });
  expect(awaiting).toMatchObject({
    hostname,
    state: "awaiting_deployment",
    gatewayScriptName: null,
    customHostnameReceipt: null,
    gatewayRetarget: false,
  });
  // The same member's fresh key for the connection that already exists is the same request: it is answered with that
  // connection, which keeps its original key and writes nothing.
  expect(
    await paid.claimApply({
      ...scope,
      ...mutation,
      idempotencyKeySha256: digest(9),
      hostname,
      gatewayScriptName: null,
      now: iso(),
    }),
  ).toMatchObject({
    hostname,
    state: "awaiting_deployment",
    gatewayRetarget: false,
    sameConnection: true,
  });
  const rival = await seedProject(control);
  await expect(
    paid.claimApply({
      organizationId: parseUlid(rival.organizationId),
      projectId: parseUlid(rival.projectId),
      ...mutation,
      hostname,
      gatewayScriptName: null,
      now: iso(),
    }),
  ).rejects.toBeInstanceOf(PaidDomainHostnameTakenError);

  // The deployment appears: the same apply provisions the connection and the receipts become its record.
  await control.core
    .prepare(
      "UPDATE paid_project_domains SET gateway_script_name='ohmyho-gateway-production',state='pending',provisioning_started_at=?3 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(project.organizationId, project.projectId, iso().replace("Z", "000Z"))
    .run();
  const active = await paid.putActive({
    ...scope,
    hostname,
    gatewayScriptName: "ohmyho-gateway-production",
    idempotencyKeySha256: mutation.idempotencyKeySha256,
    requestSha256: mutation.requestSha256,
    customHostnameReceipt: customHostnameReceipt(hostname),
    workerRouteReceipt: workerRouteReceipt(hostname),
    now: iso(),
  });
  expect(active).toMatchObject({
    state: "active",
    customHostnameReceipt: { observedAt: expect.any(Date), ready: true },
    workerRouteReceipt: { routeId: "2".repeat(32), observedAt: expect.any(Date) },
  });
  expect(await paid.read(scope)).toMatchObject({ state: "active", hostname });
  // The same member's fresh key for the active connection is answered with it, and the connection stays as it was.
  expect(
    await paid.claimApply({
      ...scope,
      ...mutation,
      idempotencyKeySha256: digest(8),
      hostname,
      gatewayScriptName: "ohmyho-gateway-production",
      now: iso(),
    }),
  ).toMatchObject({ state: "active", hostname, gatewayRetarget: false, sameConnection: true });
  expect(await paid.read(scope)).toMatchObject({ state: "active", hostname });

  // Deleting is claimed by the command key, and the connection ends as deleted.
  await control.core
    .prepare(
      `INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','Fixture',?4,1,1)`,
    )
    .bind(
      project.organizationId,
      project.projectId,
      project.prodEnvironmentId,
      `https://${hostname}`,
    )
    .run();
  const targetAt = iso().replace("Z", "000Z"),
    hour = `${targetAt.slice(0, 13)}:00:00.000000Z`;
  await control.core
    .prepare(
      "INSERT INTO native_auth_database_targets(organization_id,project_id,provider_project_id,database_id,provider_operation_id,region_id,size_class_id,target_version,started_at,billable_from) VALUES(?1,?2,'provider-fixture',?3,'operation-fixture','eu-dev','r256-s500m',1,?4,?5)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      `other-env-${project.projectId.toLowerCase()}`,
      targetAt,
      hour,
    )
    .run();
  const removal = {
    ...scope,
    hostname,
    principalId: fixture.principalId,
    idempotencyKeySha256: digest(3),
    requestSha256: digest(4),
    now: iso(),
  };
  expect(await paid.claimDelete(removal)).toMatchObject({ state: "deleting" });
  await expect(
    control.core
      .prepare(
        "INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'provider-fixture','db-fixture','runtime-blocked','role.create:runtime-blocked',?6,'reserved')",
      )
      .bind(
        project.organizationId,
        project.projectId,
        project.prodEnvironmentId,
        newUlid(),
        newUlid(),
        `blocked-${project.projectId}`,
      )
      .run(),
  ).rejects.toThrow("native auth domain policy acknowledgement pending");
  await expect(
    control.core
      .prepare(
        "INSERT INTO native_auth_preparation_receipts(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,target_version,schema_name,runtime_role,migrator_role,backup_role,migration_digest,migration_version) VALUES(?1,?2,?3,?4,?5,'provider-fixture','db-fixture',1,'fixture','runtime','migrator','backup',?6,1)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        project.prodEnvironmentId,
        newUlid(),
        newUlid(),
        "a".repeat(64),
      )
      .run(),
  ).rejects.toThrow("native auth domain policy acknowledgement pending");
  await expect(
    control.core
      .prepare(
        "INSERT INTO native_auth_restore_realms(organization_id,project_id,restore_id,environment_id,revocation_epoch,configuration_revision) VALUES(?1,?2,?3,?4,2,2)",
      )
      .bind(project.organizationId, project.projectId, newUlid(), project.prodEnvironmentId)
      .run(),
  ).rejects.toThrow("native auth domain policy acknowledgement pending");
  await expect(
    paid.markDeleted({ ...scope, hostname, idempotencyKeySha256: digest(3), now: iso() }),
  ).rejects.toThrow();
  const syncScope = { ...scope, kind: "paid_delete", identity: digest(3).slice(7) };
  const pending = (await wire.binding.readDomainPolicySync(syncScope)) as Array<
    Record<string, unknown>
  >;
  expect(pending).toMatchObject([
    {
      environmentId: project.prodEnvironmentId,
      canonicalOrigin: null,
      configurationRevision: 2,
      revocationEpoch: 2,
      registryVersion: null,
    },
  ]);
  await expect(
    wire.binding.ackDomainPolicySync({
      ...syncScope,
      environmentId: project.prodEnvironmentId,
      configurationRevision: 2,
      revocationEpoch: 2,
      ownerEnabled: true,
      registryVersion: null,
      acknowledgement: "unprovisioned",
    }),
  ).resolves.toBe("acknowledged");
  await paid.markDeleted({ ...scope, hostname, idempotencyKeySha256: digest(3), now: iso() });
  expect(await paid.read(scope)).toMatchObject({ state: "deleted" });
  // A repeated delete of the deleted connection answers it as deleted, under its own key and under a fresh one, and
  // settles no native policy operation: the first delete's operation stays the only one.
  const policyOperations = async () =>
    (
      await control.core
        .prepare(
          "SELECT count(*) AS n FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2 AND kind='paid_delete'",
        )
        .bind(project.organizationId, project.projectId)
        .first<{ n: number }>()
    )?.n;
  const operations = await policyOperations();
  expect(await paid.claimDelete({ ...removal, now: iso() })).toMatchObject({
    state: "deleted",
    hostname,
  });
  expect(
    await paid.claimDelete({
      ...removal,
      idempotencyKeySha256: digest(13),
      requestSha256: digest(14),
      now: iso(),
    }),
  ).toMatchObject({ state: "deleted", hostname });
  expect(await policyOperations()).toBe(operations);
  await expect(
    paid.claimApply({ ...scope, ...mutation, hostname, gatewayScriptName: null, now: iso() }),
  ).rejects.toThrow();

  // A project deletion takes over its live connection in any live state.
  const doomed = await seedProject(control),
    doomedScope = {
      organizationId: parseUlid(doomed.organizationId),
      projectId: parseUlid(doomed.projectId),
    },
    operationId = await seedOperation(doomed);
  await paid.claimApply({
    ...doomedScope,
    ...mutation,
    hostname: "app.paid-two.example",
    gatewayScriptName: null,
    now: iso(),
  });
  await seedDeletionIntent(doomed, doomed.prodEnvironmentId, operationId);
  await control.core
    .prepare(
      "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(doomed.organizationId, doomed.projectId)
    .run();
  expect(
    await paid.claimProjectDeletion({
      ...doomedScope,
      operationId: parseUlid(operationId),
      now: iso(),
    }),
  ).toMatchObject({ state: "deleting", hostname: "app.paid-two.example" });
});

it("names a fresh key's conflict by the connection it meets, and keeps a reused key a key conflict", async () => {
  const fixture = await cfFixture(control),
    project = fixture.project,
    scope = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
    },
    wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
    paid = createD1PaidDomainPersistence(wire.binding as never, ids),
    live = "live.paid-three.example",
    other = "other.paid-three.example",
    mutation = {
      principalId: "user:owner",
      idempotencyKeySha256: digest(21),
      requestSha256: digest(22),
    };
  await makePaid(control.core, project.organizationId);
  await paid.claimApply({
    ...scope,
    ...mutation,
    hostname: live,
    gatewayScriptName: null,
    now: iso(),
  });
  // Another hostname, or another member's fresh key, meets the live connection of this project.
  await expect(
    paid.claimApply({
      ...scope,
      ...mutation,
      idempotencyKeySha256: digest(23),
      hostname: other,
      gatewayScriptName: null,
      now: iso(),
    }),
  ).rejects.toBeInstanceOf(PaidDomainAlreadyConfiguredError);
  await expect(
    paid.claimApply({
      ...scope,
      ...mutation,
      principalId: "user:member",
      idempotencyKeySha256: digest(24),
      hostname: live,
      gatewayScriptName: null,
      now: iso(),
    }),
  ).rejects.toBeInstanceOf(PaidDomainAlreadyConfiguredError);
  // The key that created the connection, reused for another hostname, is still a reused key.
  await expect(
    paid.claimApply({
      ...scope,
      ...mutation,
      hostname: other,
      gatewayScriptName: null,
      now: iso(),
    }),
  ).rejects.toBeInstanceOf(PaidDomainKeyConflictError);
  // A fresh delete of another hostname meets the live connection of this project as well.
  await expect(
    paid.claimDelete({
      ...scope,
      hostname: other,
      principalId: fixture.principalId,
      idempotencyKeySha256: digest(30),
      requestSha256: digest(31),
      now: iso(),
    }),
  ).rejects.toBeInstanceOf(PaidDomainAlreadyConfiguredError);
  // A deletion in progress is named to a fresh apply and to a fresh delete of the same connection.
  await paid.claimDelete({
    ...scope,
    hostname: live,
    principalId: fixture.principalId,
    idempotencyKeySha256: digest(25),
    requestSha256: digest(26),
    now: iso(),
  });
  await expect(
    paid.claimApply({
      ...scope,
      ...mutation,
      idempotencyKeySha256: digest(27),
      hostname: live,
      gatewayScriptName: null,
      now: iso(),
    }),
  ).rejects.toBeInstanceOf(PaidDomainDeletingError);
  await expect(
    paid.claimDelete({
      ...scope,
      hostname: live,
      principalId: fixture.principalId,
      idempotencyKeySha256: digest(28),
      requestSha256: digest(29),
      now: iso(),
    }),
  ).rejects.toBeInstanceOf(PaidDomainDeletingError);
});

it("lets a fresh current owner recover an interrupted Native domain withdrawal", async () => {
  const f = await cfFixture(control),
    p = f.project,
    hostname = "recover.paid.example",
    stamp = iso().replace("Z", "000Z"),
    nextPrincipal = "user:user_paidrecovery";
  const scope = { organizationId: parseUlid(p.organizationId), projectId: parseUlid(p.projectId) },
    wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
    paid = createD1PaidDomainPersistence(wire.binding as never, ids);
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO organization_memberships(organization_id,workos_user_id,role,state,mapping_revision,snapshot_sha256,effective_at,trigger_event_id) VALUES(?1,'user_paidrecovery','admin','active',1,?2,?3,'evt-recovery')",
      )
      .bind(p.organizationId, new Uint8Array(32).fill(1), stamp),
    control.core
      .prepare(
        "INSERT INTO local_authorization_grants(organization_id,grant_id,project_id,environment_id,principal_kind,principal_id,role,created_at) VALUES(?1,?2,NULL,NULL,'user',?3,'owner',?4)",
      )
      .bind(p.organizationId, newUlid(), nextPrincipal, stamp),
    control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,?3,'ohmyho-gateway-production','active',?4,?5,?5,?7,?7,?6,?6,?6)",
      )
      .bind(
        p.organizationId,
        p.projectId,
        hostname,
        f.principalId,
        new Uint8Array(32).fill(1),
        stamp,
        JSON.stringify({ observedAt: iso() }),
      ),
    control.core
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
      )
      .bind(p.organizationId, p.projectId, p.prodEnvironmentId, `https://${hostname}`),
  ]);
  await paid.claimDelete({
    ...scope,
    hostname,
    principalId: f.principalId,
    idempotencyKeySha256: digest(10),
    requestSha256: digest(11),
    now: iso(),
  });
  await control.core
    .prepare(
      "INSERT INTO revocations(kind,resource_id,source_event_id,effective_at) VALUES('user',?1,?2,?3)",
    )
    .bind(f.userId, newUlid(), stamp)
    .run();
  const old = { ...scope, kind: "paid_delete", identity: digest(10).slice(7) };
  await expect(wire.binding.readDomainPolicySync(old)).rejects.toThrow();
  const request = {
    ...scope,
    hostname,
    principalId: nextPrincipal,
    idempotencyKeySha256: digest(12),
    requestSha256: digest(13),
  };
  await expect(
    wire.binding.beginPaidDomainRecovery({ ...request, hostname: "other.paid.example" }),
  ).rejects.toThrow("Native domain recovery unavailable");
  await expect(
    wire.binding.beginPaidDomainRecovery({
      ...request,
      delegation: {
        grantId: "00000000-0000-4000-8000-000000000001",
        clientId: "restricted",
        consentHash: "a".repeat(64),
        action: "auth:manage",
      },
    }),
  ).rejects.toThrow();
  const recovery = await wire.binding.beginPaidDomainRecovery(request);
  expect(recovery).toMatchObject({ ...old, recoveryId: digest(12).slice(7) });
  expect(await wire.binding.readDomainPolicySync(recovery)).toMatchObject([
    { configurationRevision: 2, revocationEpoch: 2, registryVersion: null },
  ]);
  await expect(
    wire.binding.ackDomainPolicySync({
      ...recovery,
      environmentId: p.prodEnvironmentId,
      configurationRevision: 2,
      revocationEpoch: 2,
      ownerEnabled: true,
      registryVersion: null,
      acknowledgement: "applied",
    }),
  ).rejects.toThrow("Native domain policy synchronization unavailable");
  await wire.binding.ackDomainPolicySync({
    ...recovery,
    environmentId: p.prodEnvironmentId,
    configurationRevision: 2,
    revocationEpoch: 2,
    ownerEnabled: true,
    registryVersion: null,
    acknowledgement: "unprovisioned",
  });
  expect(await wire.binding.completePaidDomainRecovery(recovery)).toBe("completed");
  expect(await paid.claimDelete({ ...request, now: iso() })).toMatchObject({ state: "deleting" });
  await expect(
    paid.markDeleted({ ...scope, hostname, idempotencyKeySha256: digest(10), now: iso() }),
  ).rejects.toThrow();
  await paid.markDeleted({ ...scope, hostname, idempotencyKeySha256: digest(12), now: iso() });
  expect(await paid.read(scope)).toMatchObject({ state: "deleted" });
  const uncertain = await cfFixture(control),
    q = uncertain.project,
    uncertainHost = "uncertain.paid.example";
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,?3,'ohmyho-gateway-production','active',?4,?5,?5,?6,?6,?7,?7,?7)",
      )
      .bind(
        q.organizationId,
        q.projectId,
        uncertainHost,
        uncertain.principalId,
        new Uint8Array(32).fill(1),
        JSON.stringify({ observedAt: iso() }),
        stamp,
      ),
    control.core
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
      )
      .bind(q.organizationId, q.projectId, q.prodEnvironmentId, `https://${uncertainHost}`),
    control.core
      .prepare(
        "INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'provider-fixture','db-fixture','runtime-fixture','role.create:runtime-fixture',?6,'reserved')",
      )
      .bind(
        q.organizationId,
        q.projectId,
        q.prodEnvironmentId,
        newUlid(),
        newUlid(),
        `role-${q.projectId}`,
      ),
  ]);
  await expect(
    paid.claimDelete({
      organizationId: parseUlid(q.organizationId),
      projectId: parseUlid(q.projectId),
      hostname: uncertainHost,
      principalId: uncertain.principalId,
      idempotencyKeySha256: digest(14),
      requestSha256: digest(15),
      now: iso(),
    }),
  ).rejects.toThrow();
  expect(
    await control.core
      .prepare("SELECT state FROM paid_project_domains WHERE organization_id=?1 AND project_id=?2")
      .bind(q.organizationId, q.projectId)
      .first(),
  ).toEqual({ state: "active" });
  expect(
    await control.core
      .prepare(
        "SELECT canonical_origin,configuration_revision,revocation_epoch FROM native_auth_realms WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3",
      )
      .bind(q.organizationId, q.projectId, q.prodEnvironmentId)
      .first(),
  ).toEqual({
    canonical_origin: `https://${uncertainHost}`,
    configuration_revision: 1,
    revocation_epoch: 1,
  });
  expect(
    await control.core
      .prepare(
        "SELECT 1 FROM native_auth_domain_operations WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(q.organizationId, q.projectId)
      .first(),
  ).toBeNull();
  const concurrent = await cfFixture(control),
    c = concurrent.project,
    concurrentHost = "concurrent.paid.example";
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO paid_project_domains(organization_id,project_id,hostname,gateway_script_name,state,configured_by_principal_id,apply_idempotency_sha256,apply_request_sha256,custom_hostname_receipt,worker_route_receipt,created_at,updated_at,provisioning_started_at) VALUES(?1,?2,?3,'ohmyho-gateway-production','active',?4,?5,?5,?6,?6,?7,?7,?7)",
      )
      .bind(
        c.organizationId,
        c.projectId,
        concurrentHost,
        concurrent.principalId,
        new Uint8Array(32).fill(1),
        JSON.stringify({ observedAt: iso() }),
        stamp,
      ),
    control.core
      .prepare(
        "INSERT INTO native_auth_realms(organization_id,project_id,environment_id,enabled,signup_policy,app_name,canonical_origin,configuration_revision,revocation_epoch) VALUES(?1,?2,?3,1,'open','App',?4,1,1)",
      )
      .bind(c.organizationId, c.projectId, c.prodEnvironmentId, `https://${concurrentHost}`),
  ]);
  await paid.claimDelete({
    organizationId: parseUlid(c.organizationId),
    projectId: parseUlid(c.projectId),
    hostname: concurrentHost,
    principalId: concurrent.principalId,
    idempotencyKeySha256: digest(16),
    requestSha256: digest(17),
    now: iso(),
  });
  const concurrentDatabaseOperation = newUlid();
  await control.core
    .prepare(
      "INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'provider-fixture','concurrent-dev','eu-dev','r256-s500m',?6,'reserved')",
    )
    .bind(
      c.organizationId,
      c.projectId,
      c.devEnvironmentId,
      concurrentDatabaseOperation,
      newUlid(),
      `database-${c.projectId}`,
    )
    .run();
  await expect(
    control.core
      .prepare(
        "INSERT INTO native_auth_role_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,database_id,role_name,step,idempotency_key,state) VALUES(?1,?2,?3,?4,?5,'provider','database','runtime-concurrent','role.create:runtime-concurrent',?6,'reserved')",
      )
      .bind(
        c.organizationId,
        c.projectId,
        c.prodEnvironmentId,
        newUlid(),
        newUlid(),
        `concurrent-role-${c.projectId}`,
      )
      .run(),
  ).rejects.toThrow("native auth domain policy acknowledgement pending");
  const concurrentScope = {
    organizationId: c.organizationId,
    projectId: c.projectId,
    kind: "paid_delete",
    identity: digest(16).slice(7),
  };
  expect(await wire.binding.readDomainPolicySync(concurrentScope)).toMatchObject([
    { environmentId: c.prodEnvironmentId, registryVersion: null },
  ]);
  await control.core
    .prepare(
      "UPDATE native_auth_database_operations SET state='dispatched',dispatched_at=?2 WHERE operation_id=?1 AND state='reserved'",
    )
    .bind(concurrentDatabaseOperation, stamp)
    .run();
  await expect(
    wire.binding.ackDomainPolicySync({
      ...concurrentScope,
      environmentId: c.prodEnvironmentId,
      configurationRevision: 2,
      revocationEpoch: 2,
      ownerEnabled: true,
      registryVersion: null,
      acknowledgement: "unprovisioned",
    }),
  ).resolves.toBe("acknowledged");
});

it("maps the Core's named refusals and refuses malformed private answers", async () => {
  const project = await seedProject(control),
    scope = {
      organizationId: parseUlid(project.organizationId),
      projectId: parseUlid(project.projectId),
    },
    wire = seam(new CloudflareDomainRuntime({} as never, control.bindings as never)),
    paid = createD1PaidDomainPersistence(wire.binding as never, ids),
    apply = () =>
      paid.claimApply({
        ...scope,
        principalId: "user:owner",
        idempotencyKeySha256: digest(1),
        requestSha256: digest(2),
        hostname: "app.wire.example",
        gatewayScriptName: null,
        now: iso(),
      });
  for (const [name, expected] of [
    ["PaidDomainHostnameTakenError", PaidDomainHostnameTakenError],
    ["PaidDomainKeyConflictError", PaidDomainKeyConflictError],
    ["PaidDomainProductionDeploymentRequiredError", PaidDomainProductionDeploymentRequiredError],
  ] as const) {
    wire.refuse("claimPaidDomainApply", "refused", name);
    await expect(apply()).rejects.toBeInstanceOf(expected);
  }
  wire.refuse("claimPaidDomainApply", "private detail");
  await expect(apply()).rejects.toThrow("private detail");
  const record = {
    organizationId: project.organizationId,
    projectId: project.projectId,
    hostname: "app.wire.example",
    gatewayScriptName: null,
    state: "pending",
    customHostnameReceipt: null,
    workerRouteReceipt: null,
    hostnameProven: true,
  };
  for (const [name, reply, call, message] of [
    [
      "readPaidDomainTarget",
      { gatewayScriptName: 7 },
      () => paid.readTarget(scope),
      "Invalid Paid domain target",
    ],
    [
      "readPaidDomainTarget",
      "target",
      () => paid.readTarget(scope),
      "Invalid private Paid domain response",
    ],
    [
      "readPaidDomainRecord",
      { ...record, state: "unknown" },
      () => paid.read(scope),
      "Invalid private Paid domain record",
    ],
    [
      "readPaidDomainRecord",
      { ...record, customHostnameReceipt: { observedAt: "never" } },
      () => paid.read(scope),
      "Invalid Paid domain receipt time",
    ],
    [
      "readPaidDomainRecord",
      { ...record, workerRouteReceipt: { observedAt: 3 } },
      () => paid.read(scope),
      "Invalid Paid domain receipt time",
    ],
    ["claimPaidDomainApply", record, apply, "Invalid Paid domain apply response"],
    [
      "putPaidDomainActive",
      null,
      () =>
        paid.putActive({
          ...scope,
          hostname: "app.wire.example",
          gatewayScriptName: "ohmyho-gateway-production",
          idempotencyKeySha256: digest(1),
          requestSha256: digest(2),
          customHostnameReceipt: {} as never,
          workerRouteReceipt: {} as never,
          now: iso(),
        }),
      "Missing Paid domain active receipt",
    ],
  ] as const) {
    wire.reply(name, reply);
    await expect(call()).rejects.toThrow(message);
  }
});
