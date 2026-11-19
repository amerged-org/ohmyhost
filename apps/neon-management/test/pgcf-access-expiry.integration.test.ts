import { expect, it, vi } from "vitest";
import { Pool } from "pg";
import { startTestPostgres } from "../../control-api/test/postgres.js";
import { issuePgcfDatabaseAccess, type PgcfAccessProvider } from "../src/pgcf-access.js";
import type { IssuedProjectDatabaseAccess, PgcfPostgresTarget } from "@ohmyhost/database";
import { applyPgcfBaseline } from "./support/pgcf-baseline.js";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { seedProductRuntimeFixture } from "../../control-store/test/support/product-runtime-fixture.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import { NOW, ulidOf } from "../../control-store/test/support/platform-fixtures.js";
import { CORE_DATABASE_ID } from "./support/d1-pgcf-scope.js";
import { createD1ProjectDatabaseAccessManager } from "../src/d1-product-database.js";
import { createD1PgcfEntitlementPersistence } from "../src/d1-pgcf-entitlements.js";
import { createPgcfEntitlementReconciler } from "../src/pgcf-entitlements.js";
import type { PgcfProjectProvider } from "@ohmyhost/provider-pgcf";
import { SystemClock, SystemEntropy, createUlidFactory } from "@ohmyhost/platform";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; the product runtime and Core commands are the production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));

it("verifies the exact PGCF whole-second SQL deadline without changing nominal expiry or accepting adjacent seconds", async () => {
  const pg = await startTestPostgres();
  try {
    const data = "00000000000000000000000004",
      member = `ohmyho_ro_${data}`,
      role = `ohmyho_da_${data}_expiry00`,
      database = "abcdefghijklmnopqrst",
      host = `${database}.db.example.com`;
    const future = new Date(Date.now() + 3600000);
    future.setUTCMilliseconds(606);
    const nominal = future.toISOString(),
      effective = new Date(Math.floor(future.getTime() / 1000) * 1000).toISOString();
    // The three environment roles exist before any credential: the owner grants of a read credential name all of them.
    for (const purpose of ["m", "rw"])
      await pg.pool.query(`CREATE ROLE ohmyho_${purpose}_${data} NOLOGIN`);
    await pg.pool.query(`CREATE ROLE ${member} NOLOGIN`);
    await pg.pool.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5 VALID UNTIL '${effective}'`,
    );
    await pg.pool.query(`GRANT ${member} TO ${role} WITH INHERIT TRUE, SET FALSE`);
    await pg.pool.query("CREATE ROLE app LOGIN NOSUPERUSER");
    await pg.pool.query(`CREATE DATABASE ${database} OWNER app`);
    // A read credential needs a hardened database: PGCF's baseline moves the persisting functions to the owner, and
    // issuing the credential closes TEMPORARY through that owner.
    await applyPgcfBaseline(String(pg.pool.options.connectionString), database, "app");
    const accepted: IssuedProjectDatabaseAccess = Object.freeze({
      provider: "pgcf",
      accessId: "00000000000000000000000005",
      roleName: role,
      memberRole: member,
      mode: "read",
      environment: "dev",
      environmentId: data,
      dataEnvironmentId: data,
      providerProjectId: "prj_abcdefghijklmnopqrst",
      databaseId: database,
      originHost: host,
      issuedAt: new Date().toISOString(),
      expiresAt: nominal,
      label: "native expiry",
    });
    const uriOf = (login: string) =>
      `postgresql://${login}:synthetic-fixture-password@${host}/${database}?sslmode=require`;
    const view = {
      databaseId: database,
      name: role,
      owner: false,
      bypassRls: false,
      passwordRevision: 1,
      connectionLimit: 5,
      validUntil: nominal,
      memberOf: [member],
      membershipOptions: { inherit: true, set: false },
    };
    const provider: PgcfAccessProvider = {
      projectId: accepted.providerProjectId,
      createRole: async () => view,
      readRoles: async () => [view],
      readConnection: async (_database, login) =>
        ({
          host,
          consume: async <T>(consume: (value: string) => Promise<T>) => consume(uriOf(login)),
        }) as Awaited<ReturnType<PgcfAccessProvider["readConnection"]>>,
      readDatabase: async () =>
        ({ id: database, generation: 1, observedGeneration: 1 }) as Awaited<
          ReturnType<PgcfAccessProvider["readDatabase"]>
        >,
      deleteRole: async () => {
        throw new Error("Unexpected role deletion");
      },
      readOperation: async () => {
        throw new Error("Unexpected async role creation");
      },
    };
    let scopeChecks = 0;
    const logins: string[] = [];
    const input = {
      provider,
      accepted,
      projectId: "00000000000000000000000002",
      recordOperation: async () => {
        throw new Error("Unexpected provider operation");
      },
      assertScope: async () => {
        scopeChecks++;
      },
      connect: async (value: string, target?: PgcfPostgresTarget) => {
        // A read credential first runs the owner grants as the database owner, then its own login proves the role.
        const login = target?.role === "app" ? "app" : role;
        logins.push(login);
        expect(target).toEqual({ provider: "pgcf", host, databaseId: database, role: login });
        expect(new URL(value).username).toBe(login);
        const local = new URL(String(pg.pool.options.connectionString));
        local.username = login;
        local.pathname = "/" + database;
        local.search = "";
        const pool = new Pool({ connectionString: local.toString(), max: 1 });
        const client = await pool.connect();
        return {
          client: {
            query: (text: string, values?: readonly unknown[]) =>
              client.query(text, values ? [...values] : []),
          },
          close: async () => {
            client.release();
            await pool.end();
          },
        };
      },
    };
    const credential = await issuePgcfDatabaseAccess(input);
    expect(credential.expires_at).toBe(nominal);
    expect(accepted.expiresAt).toBe(nominal);
    expect(scopeChecks).toBe(2);
    expect(logins).toEqual(["app", role, role]);
    expect(
      (
        await pg.pool.query<{ valid: Date }>(
          "SELECT rolvaliduntil valid FROM pg_roles WHERE rolname=$1",
          [role],
        )
      ).rows[0]?.valid.toISOString(),
    ).toBe(effective);
    for (const offset of [-1000, 1000]) {
      const wrong = new Date(Date.parse(effective) + offset).toISOString();
      await pg.pool.query(`ALTER ROLE ${role} RESET default_transaction_read_only`);
      await pg.pool.query(`ALTER ROLE ${role} VALID UNTIL '${wrong}'`);
      await expect(issuePgcfDatabaseAccess(input)).rejects.toThrow("scope");
    }
  } finally {
    await pg.stop();
  }
}, 120000);

const unexpected = () => {
  throw new Error("Unexpected provider call");
};
type Runtime = Parameters<typeof createD1ProjectDatabaseAccessManager>[0]["runtime"];

it("leaves the role of an expired credential of a suspended database to the sweep after its resume, so the resume is not lost", async () => {
  const control = await createTestControl();
  try {
    const f = await seedProductRuntimeFixture(control);
    const coreBindings = {
      CONTROL_CORE: control.core,
      CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
      CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
    };
    host.env = coreBindings;
    const entry = await import("../../control-store/src/worker-main.js");
    const product = new entry.DatabaseProductRuntime({}, coreBindings) as unknown as Runtime;
    const accessId = ulidOf("resume-access", f.n);
    expect(
      await product.issueProductDatabaseAccess({
        organizationId: f.organizationId,
        projectId: f.projectId,
        environment: "dev",
        mode: "read",
        ttlSeconds: 3600,
        label: "resume fixture",
        principalId: "user:fixture",
        now: NOW,
        roleSuffix: "00000000",
        accessId,
        auditEventId: ulidOf("resume-issue", f.n),
      }),
    ).toMatchObject({ status: "accepted" });

    // PGCF as the fixture reports it: an above-Free database at generation 1, running. A role deletion on a suspended
    // database succeeds at once and raises its generation, which is what ends the entitlement's automatic resume.
    const PROJECT = f.provider,
      DATABASE = f.database;
    let database = {
      id: DATABASE,
      projectId: PROJECT,
      regionId: "eu-dev",
      name: "fixture",
      sizeClassId: "r512-s1g",
      resources: { memoryMiB: 512, cpuMillicores: 1000, storageMiB: 1024 },
      desiredState: "running" as "running" | "suspended",
      suspensionReason: null as "manual" | null,
      observedState: "ready",
      generation: 1,
      observedGeneration: 1,
      sleepAfterSeconds: null,
    };
    const operations = new Map<string, unknown>();
    const changes: string[] = [];
    const deletions: string[] = [];
    const provider = {
      projectId: PROJECT,
      readDatabase: async () => structuredClone(database),
      readOperation: async (id: string) => {
        const found = operations.get(id);
        if (found === undefined) throw new Error("Unexpected operation read");
        return found;
      },
      changeDatabase: async (
        _databaseId: string,
        action: "suspend" | "resume",
        _key: string,
        _sizeClassId: undefined,
        expectedGeneration: number,
      ) => {
        changes.push(action);
        const generation = expectedGeneration + 1;
        database =
          action === "suspend"
            ? {
                ...database,
                generation,
                observedGeneration: generation,
                desiredState: "suspended",
                suspensionReason: "manual",
                observedState: "hibernated",
              }
            : {
                ...database,
                generation,
                observedGeneration: generation,
                desiredState: "running",
                suspensionReason: null,
                observedState: "ready",
              };
        const operation = {
          id: `op_${(action === "suspend" ? "s" : "r").repeat(20)}`,
          projectId: PROJECT,
          databaseId: DATABASE,
          generation,
          kind: action === "suspend" ? "database.suspend" : "database.resume",
          status: "succeeded",
          errorCode: null,
        };
        operations.set(operation.id, operation);
        return { database, operation };
      },
      deleteRole: async (_databaseId: string, roleName: string) => {
        deletions.push(roleName);
        if (database.desiredState === "suspended")
          database = {
            ...database,
            generation: database.generation + 1,
            observedGeneration: database.generation + 1,
          };
        const operation = {
          id: `op_${"d".repeat(20)}`,
          projectId: PROJECT,
          databaseId: DATABASE,
          generation: database.generation,
          kind: "database.role.delete",
          status: "succeeded",
          errorCode: null,
        };
        operations.set(operation.id, operation);
        return { operation };
      },
      readRoles: async () => [],
      readConnection: unexpected,
      createRole: unexpected,
    } as unknown as PgcfProjectProvider;

    let tick = Date.parse(NOW);
    const clock = { now: () => new Date(tick) };
    const ids = createUlidFactory({ clock: new SystemClock(), entropy: new SystemEntropy() });
    const reconciler = createPgcfEntitlementReconciler({
      persistence: createD1PgcfEntitlementPersistence(product),
      provider,
      clock,
      ids,
    });
    const manager = createD1ProjectDatabaseAccessManager({
      runtime: product,
      provider,
      connect: unexpected,
      clock: new SystemClock(),
      entropy: new SystemEntropy(),
      ids,
    });

    // Paid coverage has lapsed: the reconciler suspends the database at generation 2.
    expect(await reconciler.reconcile()).toMatchObject({ accepted: 1, failed: 0 });
    expect(database).toMatchObject({ desiredState: "suspended", generation: 2 });

    // The credential expires while the database is suspended: its role waits, and PGCF is not asked to delete it.
    tick = Date.parse("2026-10-28T12:00:00.000Z");
    expect(await manager.sweep(new Date(tick))).toEqual({
      expired: 0,
      budget: 0,
      dropped: 0,
      failed: 0,
    });
    expect(deletions).toEqual([]);
    expect(database.generation).toBe(2);

    // Paid coverage returns: the reconciler resumes the database it still owns.
    await makePaid(control.core, f.organizationId);
    expect(await reconciler.reconcile()).toMatchObject({ accepted: 1, failed: 0 });
    expect(changes).toEqual(["suspend", "resume"]);
    expect(database).toMatchObject({ desiredState: "running", generation: 3 });

    // Once the database runs again the sweep drops the expired role.
    expect(await manager.sweep(new Date(tick))).toEqual({
      expired: 1,
      budget: 0,
      dropped: 0,
      failed: 0,
    });
    expect(deletions).toHaveLength(1);
    expect(
      await control.core
        .prepare(
          "SELECT role_dropped_at IS NOT NULL dropped FROM project_database_access WHERE access_id=?",
        )
        .bind(accessId)
        .first(),
    ).toEqual({ dropped: 1 });
  } finally {
    await control.dispose();
  }
}, 120000);
