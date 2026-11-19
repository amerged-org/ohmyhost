import { afterAll, beforeAll, expect, it } from "vitest";

import { newUlid } from "../../src/catalog/common.js";
import type { D1Database } from "../../src/d1-types.js";
import { createControlStore } from "../../src/store.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { bytes } from "../support/platform-fixtures.js";
import { seedProviderClaim, releaseProviderClaim } from "../support/accepted-operation.js";
import { gatewayFixture } from "../gateway/gateway-fixture.js";
import { projectInput, seedOrganization } from "../support/seed.js";
import { authenticateStorageGateway } from "../../src/catalog/storage-gateway/auth.js";
import { mutateEnvironmentSecretInput } from "../../src/catalog/secrets/environment-secrets.js";
import { INSTALLED_PLATFORM_KEY_NAMES } from "@ohmyhost/contracts/secret-names";
import { SharedCoreRouter } from "../../src/router.js";
import type { CatalogContext } from "../../src/catalog/common.js";

const WRITTEN = "2026-10-28T10:30:00.000Z";
const ROTATED = "2026-11-14T11:00:00.000Z";
const ROTATED_STORED = "2026-11-14T11:00:00.000000Z";

let control: TestControl;
let db: D1Database;
let store: ReturnType<typeof createControlStore>;
let organizationId: string;

beforeAll(async () => {
  control = await createTestControl(1);
  db = control.core;
  store = createControlStore(control.bindings);
  organizationId = await seedOrganization(store, 1, 0);
}, 120_000);
afterAll(async () => control.dispose());

/** A sealed value whose plain digest is `value` repeated, so the stored digest of each version is recognisable. */
const sealed = (value: number, writtenAt: string = WRITTEN) => ({
  ciphertext: bytes(32, value + 16),
  nonce: bytes(12, value),
  valueSha256: bytes(32, value),
  keyVersion: 1,
  writtenAt,
});
const hexOf = (value: number) => value.toString(16).padStart(2, "0").repeat(32);

async function projectFixture() {
  const p = projectInput(organizationId, `rotate-${newUlid().toLowerCase()}`, false);
  await store.projects.createInitialProject(p);
  return {
    project: p,
    scope: {
      organizationId,
      projectId: p.projectId,
      environmentId: p.productionEnvironmentId,
    },
  };
}

const rotation = (
  scope: { organizationId: string; projectId: string; environmentId: string },
  name: string,
  value: number,
  overrides: Record<string, unknown> = {},
) => ({
  ...scope,
  action: "rotate" as const,
  name,
  ...sealed(value, ROTATED),
  idempotencyKey: `rotate-${name}-${value}`,
  requestSha256: bytes(32, value + 0x40),
  requestedAt: ROTATED,
  ...overrides,
});

const generationOf = async (environmentId: string) =>
  (
    await db
      .prepare(
        "SELECT desired_generation AS g FROM runtime_secret_delivery_states WHERE environment_id = ?",
      )
      .bind(environmentId)
      .first<{ g: number }>()
  )?.g;

it("rotates an installed authentication secret: revision and digest change, the creation instant stays", async () => {
  const { scope } = await projectFixture();
  await store.secrets.putEnvironmentSecret({
    ...scope,
    name: "BETTER_AUTH_SECRET",
    ...sealed(1),
  });
  const before = await generationOf(scope.environmentId);
  const stored = await store.secrets.mutateEnvironmentSecret(
    rotation(scope, "BETTER_AUTH_SECRET", 2),
  );
  expect(stored).toEqual({
    status: "stored",
    secret: {
      name: "BETTER_AUTH_SECRET",
      revision: 2,
      keyVersion: 1,
      createdAt: WRITTEN,
      updatedAt: ROTATED,
    },
  });
  // The same request under the same idempotency key replays the stored answer and moves nothing.
  expect(
    await store.secrets.mutateEnvironmentSecret(rotation(scope, "BETTER_AUTH_SECRET", 2)),
  ).toEqual(stored);
  await expect(
    store.secrets.mutateEnvironmentSecret({
      ...rotation(scope, "BETTER_AUTH_SECRET", 2),
      requestSha256: bytes(32, 0x77),
    }),
  ).rejects.toMatchObject({ code: "environment_secret_idempotency_conflict" });
  expect(await generationOf(scope.environmentId)).toBe((before ?? 0) + 1);
  expect(
    await db
      .prepare(
        "SELECT lower(hex(value_sha256)) hash FROM environment_secrets WHERE environment_id = ? AND name = 'BETTER_AUTH_SECRET'",
      )
      .bind(scope.environmentId)
      .first(),
  ).toEqual({ hash: hexOf(2) });
});

it("refuses to rotate a name that is not an installed platform key, and an installed key that is absent", async () => {
  const { scope } = await projectFixture();
  await store.secrets.putEnvironmentSecret({ ...scope, name: "DATABASE_URL", ...sealed(1) });
  await expect(
    store.secrets.mutateEnvironmentSecret(rotation(scope, "DATABASE_URL", 2)),
  ).rejects.toThrow();
  await expect(
    store.secrets.mutateEnvironmentSecret(rotation(scope, "MY_APP_TOKEN", 2)),
  ).rejects.toThrow();
  await expect(
    store.secrets.mutateEnvironmentSecret(rotation(scope, "OHMYHOST_AI_KEY", 2)),
  ).rejects.toMatchObject({ code: "environment_secret_absent" });
});

it("is blocked while a deployment holds the project's provider claim", async () => {
  const r = await gatewayFixture(control);
  const scope = r.scope;
  await store.secrets.putEnvironmentSecret({
    ...scope,
    name: "BETTER_AUTH_SECRET",
    ...sealed(1),
  });
  await expect(
    store.secrets.mutateEnvironmentSecret(rotation(scope, "BETTER_AUTH_SECRET", 2)),
  ).rejects.toMatchObject({ code: "environment_secret_mutation_blocked" });
  await releaseProviderClaim(r.project);
  expect(
    await store.secrets.mutateEnvironmentSecret(rotation(scope, "BETTER_AUTH_SECRET", 2)),
  ).toMatchObject({ status: "stored", secret: { revision: 2 } });
});

it("rotates a storage key into a new version, and the ensure path then accepts the rotated key", async () => {
  const r = await gatewayFixture(control);
  const scope = r.scope;
  await db
    .prepare(
      "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
    )
    .bind(
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      r.accepted.operationId,
      r.accepted.claimId,
      `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`,
      "f".repeat(32),
      "2026-10-28T10:00:00.000000Z",
    )
    .run();
  const installed = await store.runtimeSecrets.ensureStorageGateway({
    ...scope,
    operationId: r.accepted.operationId,
    claimId: r.accepted.claimId,
    name: "OHMYHOST_STORAGE_KEY",
    ...sealed(1),
  });
  expect(installed).toMatchObject({ name: "OHMYHOST_STORAGE_KEY", revision: 1 });
  await releaseProviderClaim(r.project);
  expect(
    await store.secrets.mutateEnvironmentSecret(rotation(scope, "OHMYHOST_STORAGE_KEY", 2)),
  ).toMatchObject({ status: "stored", secret: { revision: 2 } });
  expect(
    (
      await db
        .prepare(
          "SELECT key_version, lower(hex(key_sha256)) hash, created_at FROM storage_gateway_keys WHERE project_id = ? ORDER BY key_version",
        )
        .bind(scope.projectId)
        .all()
    ).results,
  ).toEqual([
    { key_version: 1, hash: hexOf(1), created_at: "2026-10-28T10:30:00.000000Z" },
    { key_version: 2, hash: hexOf(2), created_at: ROTATED_STORED },
  ]);
  // A later deployment ensures the same stored key again: the rotated digest is the stored one, so it replays.
  const claim = await seedProviderClaim(r.project, scope.environmentId);
  expect(
    await store.runtimeSecrets.ensureStorageGateway({
      ...scope,
      operationId: claim.operationId,
      claimId: claim.claimId,
      name: "OHMYHOST_STORAGE_KEY",
      ...sealed(2, "2026-11-15T09:00:00.000Z"),
    }),
  ).toMatchObject({ name: "OHMYHOST_STORAGE_KEY", revision: 2, keyVersion: 1 });
});

it("rotates a mail key by replacing the environment secret alone: the Mail gateway key table keeps its one row", async () => {
  const { project, scope } = await projectFixture();
  await store.secrets.putEnvironmentSecret({ ...scope, name: "OHMYHOST_MAIL_KEY", ...sealed(1) });
  await db
    .prepare(
      "INSERT INTO mail_gateway_keys(organization_id,project_id,key_version,key_sha256,created_at) VALUES(?1,?2,1,?3,?4)",
    )
    .bind(organizationId, project.projectId, bytes(32, 1), "2026-10-28T10:30:00.000000Z")
    .run();
  const before = await generationOf(scope.environmentId);
  expect(
    await store.secrets.mutateEnvironmentSecret(rotation(scope, "OHMYHOST_MAIL_KEY", 2)),
  ).toMatchObject({ status: "stored", secret: { name: "OHMYHOST_MAIL_KEY", revision: 2 } });
  expect(await generationOf(scope.environmentId)).toBe((before ?? 0) + 1);
  expect(
    (
      await db
        .prepare(
          "SELECT key_version, lower(hex(key_sha256)) hash, created_at FROM mail_gateway_keys WHERE project_id = ? ORDER BY key_version",
        )
        .bind(project.projectId)
        .all()
    ).results,
  ).toEqual([{ key_version: 1, hash: hexOf(1), created_at: "2026-10-28T10:30:00.000000Z" }]);
});

it("keeps the mail ensure replaying a rotated key that the deployment already holds", async () => {
  const r = await gatewayFixture(control);
  const scope = r.scope;
  // Mail key digests are unique across projects, so this test uses digests no other test holds.
  // The Mail gateway key needs the environment's sending capability, which a mail domain binding provides.
  const domain = newUlid();
  const stamp = "2026-10-28T10:00:00.000000Z";
  await db.batch([
    db
      .prepare(
        "INSERT INTO workspace_mail_domains(organization_id,domain_id,domain,registrable_domain,custody_organization_id,custody_project_id,custody_environment_id,status,sending_status,configured_at) VALUES(?1,?2,'mail.example.test','example.test',?1,?3,?4,'active','ready',?5)",
      )
      .bind(scope.organizationId, domain, scope.projectId, scope.environmentId, stamp),
    db
      .prepare(
        "INSERT INTO project_mail_domain_bindings(organization_id,project_id,environment_id,mail_domain_id,revision,state,sending,legacy,sender_addresses,configured_at,updated_at) VALUES(?1,?2,?3,?4,1,'active',1,1,'[]',?5,?5)",
      )
      .bind(scope.organizationId, scope.projectId, scope.environmentId, domain, stamp),
  ]);
  expect(
    await store.runtimeSecrets.ensureMailGateway({
      ...scope,
      operationId: r.accepted.operationId,
      claimId: r.accepted.claimId,
      name: "OHMYHOST_MAIL_KEY",
      ...sealed(0x31),
    }),
  ).toMatchObject({ name: "OHMYHOST_MAIL_KEY", revision: 1 });
  await releaseProviderClaim(r.project);
  expect(
    await store.secrets.mutateEnvironmentSecret(rotation(scope, "OHMYHOST_MAIL_KEY", 0x32)),
  ).toMatchObject({ status: "stored", secret: { revision: 2 } });
  const claim = await seedProviderClaim(r.project, scope.environmentId);
  expect(
    await store.runtimeSecrets.ensureMailGateway({
      ...scope,
      operationId: claim.operationId,
      claimId: claim.claimId,
      name: "OHMYHOST_MAIL_KEY",
      ...sealed(0x32, "2026-11-15T09:00:00.000Z"),
    }),
  ).toMatchObject({ name: "OHMYHOST_MAIL_KEY", revision: 2, keyVersion: 1 });
  expect(
    (
      await db
        .prepare(
          "SELECT key_version, lower(hex(key_sha256)) hash FROM mail_gateway_keys WHERE project_id = ? ORDER BY key_version",
        )
        .bind(scope.projectId)
        .all()
    ).results,
  ).toEqual([{ key_version: 1, hash: hexOf(0x31) }]);
});

/** A sending binding for a project's mail, so the Mail gateway key ensure passes its readiness guard. */
async function mailBinding(
  project: { organizationId: string; projectId: string; environmentId: string },
  label: string,
) {
  const domain = newUlid();
  const stamp = "2026-10-28T10:00:00.000000Z";
  await control.core.batch([
    control.core
      .prepare(
        "INSERT INTO workspace_mail_domains(organization_id,domain_id,domain,registrable_domain,custody_organization_id,custody_project_id,custody_environment_id,status,sending_status,configured_at) VALUES(?1,?2,?3,?4,?1,?5,?6,'active','ready',?7)",
      )
      .bind(
        project.organizationId,
        domain,
        `${label}.example.test`,
        `${label}.example.test`,
        project.projectId,
        project.environmentId,
        stamp,
      ),
    control.core
      .prepare(
        "INSERT INTO project_mail_domain_bindings(organization_id,project_id,environment_id,mail_domain_id,revision,state,sending,legacy,sender_addresses,configured_at,updated_at) VALUES(?1,?2,?3,?4,1,'active',1,1,'[]',?5,?5)",
      )
      .bind(project.organizationId, project.projectId, project.environmentId, domain, stamp),
  ]);
}

const mailSealed = (value: number, writtenAt?: string) => ({
  ...sealed(value, writtenAt),
  name: "OHMYHOST_MAIL_KEY" as const,
});

it("installs the mail key of a second environment while the first environment already holds one", async () => {
  const r = await gatewayFixture(control);
  const prod = r.scope;
  const dev = { ...prod, environmentId: r.project.devEnvironmentId };
  await mailBinding(prod, `second-${newUlid().toLowerCase()}`);
  expect(
    await store.runtimeSecrets.ensureMailGateway({
      ...prod,
      operationId: r.accepted.operationId,
      claimId: r.accepted.claimId,
      ...mailSealed(0x41),
    }),
  ).toMatchObject({ name: "OHMYHOST_MAIL_KEY", revision: 1 });
  await releaseProviderClaim(r.project);
  const claim = await seedProviderClaim(r.project, dev.environmentId);
  await expect(
    store.runtimeSecrets.ensureMailGateway({
      ...dev,
      operationId: claim.operationId,
      claimId: claim.claimId,
      ...mailSealed(0x41),
    }),
  ).rejects.toThrow("Mail gateway key conflicts with durable state");
  expect(
    await store.runtimeSecrets.ensureMailGateway({
      ...dev,
      operationId: claim.operationId,
      claimId: claim.claimId,
      ...mailSealed(0x42),
    }),
  ).toMatchObject({ name: "OHMYHOST_MAIL_KEY", revision: 1 });
});

it("installs the mail key of a second environment after the first one was rotated", async () => {
  const r = await gatewayFixture(control);
  const prod = r.scope;
  const dev = { ...prod, environmentId: r.project.devEnvironmentId };
  await mailBinding(prod, `rotated-${newUlid().toLowerCase()}`);
  await store.runtimeSecrets.ensureMailGateway({
    ...prod,
    operationId: r.accepted.operationId,
    claimId: r.accepted.claimId,
    ...mailSealed(0x51),
  });
  await releaseProviderClaim(r.project);
  expect(
    await store.secrets.mutateEnvironmentSecret(rotation(prod, "OHMYHOST_MAIL_KEY", 0x52)),
  ).toMatchObject({ status: "stored", secret: { revision: 2 } });
  const claim = await seedProviderClaim(r.project, dev.environmentId);
  expect(
    await store.runtimeSecrets.ensureMailGateway({
      ...dev,
      operationId: claim.operationId,
      claimId: claim.claimId,
      ...mailSealed(0x53),
    }),
  ).toMatchObject({ name: "OHMYHOST_MAIL_KEY", revision: 1 });
});

it("stops the old storage key at the storage gateway after a rotation and admits the new one", async () => {
  const { scope } = await projectFixture();
  const context: CatalogContext = {
    directory: db,
    router: new SharedCoreRouter(db),
  };
  await db
    .prepare(
      "INSERT INTO project_r2_bucket_receipts(organization_id,project_id,environment_id,operation_id,claim_id,bucket_name,provider_bucket_id,jurisdiction,storage_class,public_access,observed_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'eu','Standard',0,?8,?8)",
    )
    .bind(
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      newUlid(),
      newUlid(),
      `ohmyho-${scope.projectId.toLowerCase()}-${scope.environmentId.toLowerCase()}`,
      "e".repeat(32),
      "2026-10-28T10:00:00.000000Z",
    )
    .run();
  await store.secrets.putEnvironmentSecret({
    ...scope,
    name: "OHMYHOST_STORAGE_KEY",
    ...sealed(1),
  });
  // The storage key row is the one a deployment installs with the secret: version 1 carries the installed digest.
  await db
    .prepare("INSERT INTO storage_gateway_keys VALUES(?1,?2,?3,1,?4,?5)")
    .bind(
      scope.organizationId,
      scope.projectId,
      scope.environmentId,
      bytes(32, 1),
      "2026-10-28T10:30:00.000000Z",
    )
    .run();
  const gateway = (value: number) =>
    authenticateStorageGateway(context, {
      scope: null,
      input: {
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        keySha256: bytes(32, value),
      },
    });
  expect(await gateway(1)).toMatchObject({ projectId: scope.projectId });
  expect(
    await store.secrets.mutateEnvironmentSecret(rotation(scope, "OHMYHOST_STORAGE_KEY", 2)),
  ).toMatchObject({ status: "stored", secret: { revision: 2 } });
  expect(await gateway(1)).toBeNull();
  expect(await gateway(2)).toMatchObject({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
  });
});

/**
 * A Core binding that lets a deployment claim appear after the command has read the environment and before its write
 * batch commits, the race the in-batch claim guard exists for. The hook runs once, on the write batch of a receipt.
 */
function racingCore(real: D1Database, beforeCommit: () => Promise<void>): D1Database {
  const sqlOf = new WeakMap<object, string>();
  let fired = false;
  return new Proxy(real, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) =>
          new Proxy(target.prepare(sql), {
            get(statement, method) {
              if (method === "bind")
                return (...values: unknown[]) => {
                  const bound = statement.bind(...values);
                  sqlOf.set(bound, sql);
                  return bound;
                };
              const value = Reflect.get(statement, method, statement);
              return typeof value === "function" ? value.bind(statement) : value;
            },
          });
      if (property === "batch")
        return async (statements: unknown[]) => {
          if (
            !fired &&
            statements.some((statement) =>
              (sqlOf.get(statement as object) ?? "").includes(
                "INSERT INTO environment_secret_requests",
              ),
            )
          ) {
            fired = true;
            await beforeCommit();
          }
          return target.batch(statements as never);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

it("refuses a rotation when a deployment claim appears between the read and the commit, and commits nothing", async () => {
  const r = await gatewayFixture(control);
  const scope = r.scope;
  await store.secrets.putEnvironmentSecret({ ...scope, name: "BETTER_AUTH_SECRET", ...sealed(1) });
  await releaseProviderClaim(r.project);
  const before = await generationOf(scope.environmentId);
  let raced = false;
  const racing = createControlStore({
    ...control.bindings,
    CONTROL_CORE: racingCore(control.core, async () => {
      raced = true;
      await seedProviderClaim(r.project, scope.environmentId);
    }),
  });
  await expect(
    racing.secrets.mutateEnvironmentSecret(rotation(scope, "BETTER_AUTH_SECRET", 2)),
  ).rejects.toMatchObject({ code: "environment_secret_mutation_blocked" });
  expect(raced).toBe(true);
  expect(
    await db
      .prepare(
        "SELECT revision, lower(hex(value_sha256)) hash FROM environment_secrets WHERE environment_id = ? AND name = 'BETTER_AUTH_SECRET'",
      )
      .bind(scope.environmentId)
      .first(),
  ).toEqual({ revision: 1, hash: hexOf(1) });
  expect(await generationOf(scope.environmentId)).toBe(before);
  expect(
    await db
      .prepare(
        "SELECT count(*) n FROM environment_secret_requests WHERE environment_id = ? AND action = 'rotate'",
      )
      .bind(scope.environmentId)
      .first(),
  ).toEqual({ n: 0 });
});

it("accepts a rotation of exactly the installed platform keys", () => {
  const request = (name: string) =>
    rotation({ organizationId, projectId: newUlid(), environmentId: newUlid() }, name, 1);
  for (const name of INSTALLED_PLATFORM_KEY_NAMES)
    expect(mutateEnvironmentSecretInput.safeParse(request(name)).success, name).toBe(true);
  for (const name of ["DATABASE_URL", "BETTER_AUTH_URL", "OHMYHOST_AI_BASE_URL", "MY_APP_TOKEN"])
    expect(mutateEnvironmentSecretInput.safeParse(request(name)).success, name).toBe(false);
});
