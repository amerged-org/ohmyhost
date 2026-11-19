import { expect, it, vi } from "vitest";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProductRuntimeFixture } from "../../control-store/test/support/product-runtime-fixture.js";
import { NOW, STORED_NOW, ulidOf } from "../../control-store/test/support/platform-fixtures.js";
import { CORE_DATABASE_ID } from "./support/d1-pgcf-scope.js";
import { createD1ProjectDatabaseAccessManager } from "../src/d1-product-database.js";
import type { PgcfAccessProvider } from "../src/pgcf-access.js";
import { PgcfProviderError, type PgcfOperation } from "@ohmyhost/provider-pgcf";
import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; the product runtime and Core commands are the production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));

type Runtime = Parameters<typeof createD1ProjectDatabaseAccessManager>[0]["runtime"];
const unexpected = () => {
  throw new Error("Unexpected provider call");
};

async function fixture() {
  const control = await createTestControl();
  const entry = await import("../../control-store/src/worker-main.js");
  const f = await seedProductRuntimeFixture(control);
  const coreBindings = {
    CONTROL_CORE: control.core,
    CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
    CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
  };
  host.env = coreBindings;
  // The product Worker binding is a service stub; the Delegated class differs only in branded ULID types.
  const product = new entry.DatabaseProductRuntime({}, coreBindings) as unknown as Runtime;
  return { control, f, product };
}

function managerFor(runtime: Runtime, provider: PgcfAccessProvider) {
  const clock = new SystemClock(),
    entropy = new SystemEntropy();
  return createD1ProjectDatabaseAccessManager({
    runtime,
    provider,
    connect: unexpected,
    clock,
    entropy,
    ids: createUlidFactory({ clock, entropy }),
  });
}

/** PGCF answers each new role deletion key with the next planned status; a repeated key returns its operation. */
function deletingProvider(
  f: { provider: string; database: string },
  statuses: PgcfOperation["status"][],
  createRole: PgcfAccessProvider["createRole"],
) {
  const operationOf = (index: number, status: PgcfOperation["status"]): PgcfOperation => ({
    id: `op_${String.fromCharCode(97 + index).repeat(20)}`,
    projectId: f.provider,
    databaseId: f.database,
    generation: 1,
    kind: "database.role.delete",
    status,
    errorCode: null,
  });
  const operations = new Map<string, PgcfOperation>();
  const byKey = new Map<string, PgcfOperation>();
  const keys: string[] = [];
  const provider = {
    projectId: f.provider,
    createRole,
    readDatabase: unexpected,
    readConnection: unexpected,
    readRoles: async () => [],
    deleteRole: async (_databaseId: string, _roleName: string, key: string) => {
      keys.push(key);
      const existing = byKey.get(key);
      if (existing) return { operation: existing };
      const planned = statuses[byKey.size];
      if (planned === undefined) throw new Error("Unexpected role deletion");
      const created = operationOf(byKey.size, planned);
      byKey.set(key, created);
      operations.set(created.id, created);
      return { operation: created };
    },
    readOperation: async (id: string) => {
      const found = operations.get(id);
      if (!found) throw new Error("Unexpected operation read");
      return found;
    },
  } as unknown as PgcfAccessProvider;
  return { provider, keys };
}

it("re-issues a failed role deletion from the newest failed id through the real manager and product runtime", async () => {
  const { control, f, product } = await fixture();
  const accessId = ulidOf("replacement-access", f.n);
  const issued = await product.issueProductDatabaseAccess({
    organizationId: f.organizationId,
    projectId: f.projectId,
    environment: "dev",
    mode: "read",
    ttlSeconds: 3600,
    label: "replacement fixture",
    principalId: "user:fixture",
    now: NOW,
    roleSuffix: "00000000",
    accessId,
    auditEventId: ulidOf("replacement-issue", f.n),
  });
  expect(issued).toMatchObject({ status: "accepted" });

  // PGCF refuses the first two role deletions and completes the third; each key is idempotent.
  const { provider, keys } = deletingProvider(f, ["failed", "failed", "succeeded"], unexpected);
  const manager = managerFor(product, provider);
  const request = {
    organizationId: f.organizationId,
    projectId: f.projectId,
    principalId: "user:fixture",
    accessId,
  };

  await expect(manager.revoke(request)).rejects.toThrow("PGCF role revocation is not complete");
  await expect(manager.revoke(request)).rejects.toThrow("PGCF role revocation is not complete");
  expect(await manager.revoke(request)).toMatchObject({ state: "revoked" });

  expect(
    await control.core
      .prepare(
        "SELECT provider_delete_operation_id,role_dropped_at FROM project_database_access WHERE access_id=?",
      )
      .bind(accessId)
      .first(),
  ).toEqual({
    provider_delete_operation_id: `op_${"c".repeat(20)}`,
    role_dropped_at: expect.any(String),
  });
  expect(new Set(keys).size).toBe(3);
});

it("heals an access whose creation failed and whose revocation was lost after its first failed deletion", async () => {
  const { control, f, product } = await fixture();
  // The role is never created, so the access is revoked by the creation-failure path. The first deletion fails,
  // and the store call that revokes the access is lost, as after a transient store error.
  const { provider } = deletingProvider(f, ["failed", "succeeded"], async () => {
    throw new Error("PGCF unavailable");
  });
  const lost = new Proxy(product, {
    get: (target, property) => {
      if (property === "revokeProductDatabaseAccess")
        return async () => {
          throw new Error("store unavailable");
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const issued = await managerFor(lost, provider).issue({
    organizationId: f.organizationId,
    projectId: f.projectId,
    principalId: "user:fixture",
    requestId: "replacement-request",
    environment: "dev",
    mode: "read",
    ttlSeconds: 3600,
    label: "replacement fixture",
  });
  expect(issued).toEqual({ status: "rejected", code: "unavailable" });

  const found = await control.core
    .prepare("SELECT access_id FROM project_database_access WHERE project_id=?")
    .bind(f.projectId)
    .first<{ access_id: string }>();
  expect(found).not.toBeNull();
  const accessId = found?.access_id ?? "";
  // The failed deletion is stored together with the revocation, so the access is revoking, not active.
  expect(
    await control.core
      .prepare(
        "SELECT provider_delete_operation_id,revoked_at,role_dropped_at FROM project_database_access WHERE access_id=?",
      )
      .bind(accessId)
      .first(),
  ).toEqual({
    provider_delete_operation_id: `op_${"a".repeat(20)}`,
    revoked_at: expect.any(String),
    role_dropped_at: null,
  });

  // The next pass re-issues the deletion from the failed id and heals the access.
  expect(
    await managerFor(product, provider).revoke({
      organizationId: f.organizationId,
      projectId: f.projectId,
      principalId: "user:fixture",
      accessId,
    }),
  ).toMatchObject({ state: "revoked" });
  expect(
    await control.core
      .prepare(
        "SELECT provider_delete_operation_id,role_dropped_at FROM project_database_access WHERE access_id=?",
      )
      .bind(accessId)
      .first(),
  ).toEqual({
    provider_delete_operation_id: `op_${"b".repeat(20)}`,
    role_dropped_at: expect.any(String),
  });
});

type Control = Awaited<ReturnType<typeof createTestControl>>;
type Fixture = Awaited<ReturnType<typeof seedProductRuntimeFixture>>;

/** Mirrors `SWEEP_TENANT_SHARE` in apps/control-store/src/catalog/database/product-access.ts: rows one tenant may contribute per sweep and list. */
const TENANT_SHARE = 5;

/** A role deletion that PGCF reports as succeeded at once. */
function succeededRoleDelete(projectId: string, databaseId: string): PgcfOperation {
  return {
    id: `op_${"s".repeat(20)}`,
    projectId,
    databaseId,
    generation: 1,
    kind: "database.role.delete",
    status: "succeeded",
    errorCode: null,
  };
}

const microExpiry = (minute: string, index: number) =>
  `2026-10-28T09:${minute}:00.${String(index).padStart(6, "0")}Z`;

/** Seeds read credentials that expired before NOW; each call gets its own access id and role name. */
function seedExpiredAccess(control: Control, providerProjectId: string) {
  let serial = 0;
  return (owner: Fixture, databaseId: string, expiresAt: string) => {
    serial += 1;
    return control.core
      .prepare(
        `INSERT INTO project_database_access(access_id,organization_id,project_id,environment_id,environment,data_environment_id,provider_project_id,role_name,mode,principal_id,origin_host,issued_at,expires_at,provider,database_id)
         VALUES(?1,?2,?3,?4,'dev',?5,?6,?7,'read','user:fixture','fixture.pgcf.example','2026-10-28T08:00:00.000000Z',?8,'pgcf',?9)`,
      )
      .bind(
        ulidOf("sweep-access", serial),
        owner.organizationId,
        owner.projectId,
        owner.devEnvironmentId,
        owner.physical,
        providerProjectId,
        `ohmyho_da_${owner.physical.toLowerCase()}_${serial.toString(36).padStart(8, "0")}`,
        expiresAt,
        databaseId,
      );
  };
}

/**
 * A second project of the same organization whose owner is frozen, so the budget check refuses its credentials while the
 * organization's running project is still admitted.
 */
async function seedFrozenProject(f: Fixture) {
  const projectId = ulidOf("frozen-project", f.n),
    environmentId = ulidOf("frozen-dev", f.n),
    billingEpochId = ulidOf("frozen-epoch", f.n);
  await f.shard.batch([
    f.shard
      .prepare(
        "INSERT INTO projects(organization_id, project_id, created_organization_id, name, created_event_id, handle, handle_version, handle_attempt, lifecycle_state, lifecycle_version, owner_state, ownership_version, active_billing_epoch_id, data_mode, region, dev_access_mode, created_at, updated_at) VALUES (?1, ?2, ?1, 'Frozen', ?3, ?4, 'customer-chosen-v1', 0, 'active', 1, 'active', 1, ?5, 'shared', 'eu', 'protected', ?6, ?6)",
      )
      .bind(
        f.organizationId,
        projectId,
        ulidOf("frozen-event", f.n),
        `frozen-${f.n}`,
        billingEpochId,
        STORED_NOW,
      ),
    f.shard
      .prepare(
        "INSERT INTO billing_epochs(organization_id, billing_epoch_id, project_id, started_at, created_by_principal_id) VALUES (?1, ?2, ?3, ?4, 'user:fixture')",
      )
      .bind(f.organizationId, billingEpochId, projectId, STORED_NOW),
    f.shard
      .prepare(
        "INSERT INTO environments(organization_id, environment_id, project_id, name, desired_state, head_version, dev_access_epoch, created_at, updated_at) VALUES (?1, ?2, ?3, 'dev', '{}', 0, 1, ?4, ?4)",
      )
      .bind(f.organizationId, environmentId, projectId, STORED_NOW),
  ]);
  // Frozen after its environment exists: the trigger on environments requires an actively owned project.
  await f.shard
    .prepare(
      "UPDATE projects SET owner_state='security_frozen' WHERE organization_id=?1 AND project_id=?2",
    )
    .bind(f.organizationId, projectId)
    .run();
  return { ...f, projectId, devEnvironmentId: environmentId, physical: environmentId };
}

/** Credentials of one database that are not yet fully retired (revoked and role dropped). */
async function pendingOf(control: Control, databaseId: string) {
  return (
    (
      await control.core
        .prepare(
          "SELECT count(*) AS n FROM project_database_access WHERE database_id=?1 AND (revoked_at IS NULL OR role_dropped_at IS NULL)",
        )
        .bind(databaseId)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

async function countRows(control: Control, where: string) {
  return (
    await control.core
      .prepare(`SELECT count(*) AS n FROM project_database_access WHERE ${where}`)
      .first<{ n: number }>()
  )?.n;
}

it("retires a deleted database's credentials at one tenant share per sweep and retires another tenant's credential in the first sweep", async () => {
  const { control, f, product } = await fixture();
  const other = await seedProductRuntimeFixture(control);
  const goneDatabase = "g".repeat(20);
  // PGCF answers every role call of a deleted database with 404 but still reports the database itself as deleted.
  const provider = {
    projectId: f.provider,
    readConnection: unexpected,
    readOperation: unexpected,
    deleteRole: async (databaseId: string) => {
      if (databaseId === goneDatabase) throw new PgcfProviderError("rejected", 404);
      return { operation: succeededRoleDelete(f.provider, databaseId) };
    },
    readRoles: async (databaseId: string) => {
      if (databaseId === goneDatabase) throw new PgcfProviderError("rejected", 404);
      return [];
    },
    readDatabase: async (databaseId: string) => ({
      id: databaseId,
      projectId: f.provider,
      desiredState: databaseId === goneDatabase ? "deleted" : "running",
      observedState: databaseId === goneDatabase ? "deleted" : "ready",
    }),
  } as unknown as PgcfAccessProvider;
  const insert = seedExpiredAccess(control, f.provider);
  // Fifty expired credentials of one tenant, oldest expiry first, then one credential of another tenant that expired later.
  await control.core.batch([
    ...Array.from({ length: 50 }, (_, index) => insert(f, goneDatabase, microExpiry("00", index))),
    insert(other, other.database, microExpiry("30", 0)),
  ]);
  const manager = managerFor(product, provider);
  const now = new Date(NOW);

  // The first sweep takes one share of the tenant's rows and the other tenant's row, which is not behind them.
  expect(await manager.sweep(now)).toEqual({
    expired: TENANT_SHARE + 1,
    budget: 0,
    dropped: 0,
    failed: 0,
  });
  expect(await pendingOf(control, other.database)).toBe(0);

  // Each later sweep takes at most one share, until the tenant's 50 rows are all retired.
  for (let pass = 2; pass <= 10; pass += 1) {
    const before = await pendingOf(control, goneDatabase);
    const result = await manager.sweep(now);
    const retired = before - (await pendingOf(control, goneDatabase));
    expect(retired).toBe(Math.min(TENANT_SHARE, before));
    expect(result).toEqual({ expired: retired, budget: 0, dropped: 0, failed: 0 });
  }
  expect(await pendingOf(control, goneDatabase)).toBe(0);
  expect(
    await countRows(
      control,
      `database_id='${goneDatabase}' AND revocation_reason='expired' AND role_dropped_at IS NOT NULL`,
    ),
  ).toBe(50);
  // Nothing is left: a further sweep finds no expired credential.
  expect(await manager.sweep(now)).toEqual({ expired: 0, budget: 0, dropped: 0, failed: 0 });
});

it("keeps a tenant's failing credentials from holding back another tenant, and retries every failing credential in turn", async () => {
  const { control, f, product } = await fixture();
  const other = await seedProductRuntimeFixture(control);
  const failingDatabase = "h".repeat(20);
  // PGCF answers the role calls of a live database with 404, so no pass can finish these credentials.
  const provider = {
    projectId: f.provider,
    readConnection: unexpected,
    readOperation: unexpected,
    deleteRole: async (databaseId: string) => {
      if (databaseId === failingDatabase) throw new PgcfProviderError("rejected", 404);
      return { operation: succeededRoleDelete(f.provider, databaseId) };
    },
    readRoles: async (databaseId: string) => {
      if (databaseId === failingDatabase) throw new PgcfProviderError("rejected", 404);
      return [];
    },
    readDatabase: async (databaseId: string) => ({
      id: databaseId,
      projectId: f.provider,
      desiredState: "running",
      observedState: "ready",
    }),
  } as unknown as PgcfAccessProvider;
  const insert = seedExpiredAccess(control, f.provider);
  await control.core.batch([
    ...Array.from({ length: 51 }, (_, index) =>
      insert(f, failingDatabase, microExpiry("00", index)),
    ),
    insert(other, other.database, microExpiry("30", 0)),
  ]);
  const manager = managerFor(product, provider);
  const at = (pass: number) => new Date(Date.parse(NOW) + pass * 60_000);

  // The first sweep tries one share of the failing tenant's rows, and the other tenant's credential is retired.
  expect(await manager.sweep(at(1))).toEqual({
    expired: 1,
    budget: 0,
    dropped: 0,
    failed: TENANT_SHARE,
  });
  expect(await pendingOf(control, other.database)).toBe(0);
  // A row that failed is stamped, so the next sweeps try the rows not yet tried first: 51 rows need 11 sweeps.
  for (let pass = 2; pass <= 11; pass += 1) {
    expect(await manager.sweep(at(pass))).toEqual({
      expired: 0,
      budget: 0,
      dropped: 0,
      failed: TENANT_SHARE,
    });
  }
  expect(
    await countRows(control, `database_id='${failingDatabase}' AND sweep_attempted_at IS NULL`),
  ).toBe(0);
  // The failing credentials stay open and keep being retried.
  expect(await countRows(control, `database_id='${failingDatabase}' AND revoked_at IS NULL`)).toBe(
    51,
  );
  expect(await manager.sweep(at(12))).toEqual({
    expired: 0,
    budget: 0,
    dropped: 0,
    failed: TENANT_SHARE,
  });
});

it("reaches a credential the budget check refuses once the admitted credentials of its tenant have been tried", async () => {
  const { control, f, product } = await fixture();
  const frozen = await seedFrozenProject(f);
  const provider = {
    projectId: f.provider,
    readConnection: unexpected,
    readOperation: unexpected,
    readDatabase: unexpected,
    readRoles: async () => [],
    deleteRole: async (databaseId: string) => ({
      operation: succeededRoleDelete(f.provider, databaseId),
    }),
  } as unknown as PgcfAccessProvider;
  const insert = seedExpiredAccess(control, f.provider);
  // Five live credentials of the running project expire first; the frozen project's credential expires last.
  await control.core.batch([
    ...Array.from({ length: TENANT_SHARE }, (_, index) =>
      insert(f, f.database, `2026-10-28T13:0${index}:00.000000Z`),
    ),
    insert(frozen, f.database, "2026-10-28T14:00:00.000000Z"),
  ]);
  // The budget check admits the running project and refuses the frozen one, so the pass must reach it to revoke it.
  const decide = (projectId: string, environmentId: string) =>
    product.readProductAccessCreditAdmission({
      organizationId: f.organizationId,
      projectId,
      environmentId,
      now: NOW,
    });
  expect(await decide(f.projectId, f.devEnvironmentId)).toMatchObject({ allowed: true });
  expect(await decide(frozen.projectId, frozen.devEnvironmentId)).toMatchObject({ allowed: false });
  const manager = managerFor(product, provider);
  const at = (pass: number) => new Date(Date.parse(NOW) + pass * 60_000);

  // The first pass lists the five admitted credentials of the tenant, which the budget check keeps; the frozen one is not listed.
  expect(await manager.sweep(at(1))).toEqual({ expired: 0, budget: 0, dropped: 0, failed: 0 });
  // The kept credentials were tried, so the next pass reaches the refused credential and revokes it.
  expect(await manager.sweep(at(2))).toEqual({ expired: 0, budget: 1, dropped: 0, failed: 0 });
  expect(
    await countRows(
      control,
      `project_id='${frozen.projectId}' AND revocation_reason='budget' AND revoked_at IS NOT NULL`,
    ),
  ).toBe(1);
});

it("revokes a credential that expired after the budget pass kept it ahead of failing expired rows with older stamps", async () => {
  const { control, f, product } = await fixture();
  const failingDatabase = "k".repeat(20);
  // PGCF answers the role calls of one database with 404, so its expired credentials can never be revoked.
  const provider = {
    projectId: f.provider,
    readConnection: unexpected,
    readOperation: unexpected,
    readDatabase: async (databaseId: string) => ({
      id: databaseId,
      projectId: f.provider,
      desiredState: "running",
      observedState: "ready",
    }),
    readRoles: async (databaseId: string) => {
      if (databaseId === failingDatabase) throw new PgcfProviderError("rejected", 404);
      return [];
    },
    deleteRole: async (databaseId: string) => {
      if (databaseId === failingDatabase) throw new PgcfProviderError("rejected", 404);
      return { operation: succeededRoleDelete(f.provider, databaseId) };
    },
  } as unknown as PgcfAccessProvider;
  const insert = seedExpiredAccess(control, f.provider);
  await control.core.batch([
    // Five expired credentials of one tenant that keep failing, each stamped by an earlier failed pass.
    ...Array.from({ length: TENANT_SHARE }, (_, index) =>
      insert(f, failingDatabase, microExpiry("00", index)),
    ),
    // A credential the budget pass kept while it was still active, stamped at 10:00, which expires at 10:30.
    insert(f, f.database, "2026-10-28T10:30:00.000000Z"),
  ]);
  await control.core
    .prepare("UPDATE project_database_access SET sweep_attempted_at=?1 WHERE database_id=?2")
    .bind("2026-10-28T09:50:00.000000Z", failingDatabase)
    .run();
  await control.core
    .prepare("UPDATE project_database_access SET sweep_attempted_at=?1 WHERE database_id=?2")
    .bind("2026-10-28T10:00:00.000000Z", f.database)
    .run();
  const manager = managerFor(product, provider);

  // At 10:31 the kept credential is expired. Its budget stamp was written while it was active, so it is never tried
  // as an expired row and it is listed ahead of the failing rows, which took one share of the tenant.
  expect(await manager.sweep(new Date("2026-10-28T10:31:00.000Z"))).toEqual({
    expired: 1,
    budget: 0,
    dropped: 0,
    failed: TENANT_SHARE - 1,
  });
  expect(
    await countRows(
      control,
      `database_id='${f.database}' AND revocation_reason='expired' AND revoked_at IS NOT NULL`,
    ),
  ).toBe(1);
});
