import { Client } from "pg";
import { afterEach, expect, it } from "vitest";
import type { IssuedProjectDatabaseAccess } from "@ohmyhost/database";
import {
  PROJECT_SQL_DEFINER_REVOKE_STATEMENT,
  projectSqlRoleGrants,
  projectSqlRoleName,
  projectSqlRuntimeGrants,
} from "@ohmyhost/platform";
import { startTestPostgres, type TestPostgres } from "../../control-api/test/postgres.js";
import { issuePgcfDatabaseAccess, type PgcfAccessProvider } from "../src/pgcf-access.js";
import { ensureProjectRoleGrants } from "../src/pgcf-role-grants.js";
import {
  PERSISTING_FUNCTIONS,
  applyPgcfBaseline,
  asSuperuser,
  createPgcfPlatformSchema,
  stripOwnerCreators,
} from "./support/pgcf-baseline.js";

const environmentId = "00000000000000000000000004",
  database = "abcdefghijklmnopqrst",
  host = `${database}.db.example.com`;
const names = {
  migration: projectSqlRoleName(environmentId, "migration"),
  runtime: projectSqlRoleName(environmentId, "runtime"),
  readonly: projectSqlRoleName(environmentId, "readonly"),
};
const readLogin = `ohmyho_da_${environmentId}_readonly`,
  writeLogin = `ohmyho_da_${environmentId}_writeacc`;
const clusters: TestPostgres[] = [];
afterEach(async () => {
  for (const pg of clusters.splice(0)) await pg.stop();
});

/** Outcome of each statement a login needs to leave data, volume or WAL behind; a refusal is SQLSTATE 42501. */
const PROBES = {
  temp: "CREATE TEMP TABLE probe_rows(n integer)",
  lo_create: "SELECT pg_catalog.lo_create(0)",
  lo_creat: "SELECT pg_catalog.lo_creat(393216)",
  lo_from_bytea: "SELECT pg_catalog.lo_from_bytea(0, '\\x00'::bytea)",
  emit_text: "SELECT pg_catalog.pg_logical_emit_message(true, 'omh', 'x'::text)",
  emit_bytea: "SELECT pg_catalog.pg_logical_emit_message(true, 'omh', '\\x00'::bytea)",
};
const outcomes = (value: string) =>
  Object.fromEntries(Object.keys(PROBES).map((name) => [name, value]));
const open = outcomes("ok");
const closed = outcomes("42501");

/** A PGCF database as the API leaves it: stock PostgreSQL defaults, the `app` owner and the three restricted roles. */
async function fixture() {
  const pg = await startTestPostgres();
  clusters.push(pg);
  const superuser = String(pg.pool.options.connectionString);
  const attributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
  const expiresAt = new Date(Math.floor((Date.now() + 3_600_000) / 1000) * 1000).toISOString();
  await pg.pool.query(`CREATE ROLE app ${attributes}`);
  for (const role of Object.values(names)) await pg.pool.query(`CREATE ROLE ${role} ${attributes}`);
  for (const [login, member] of [
    [readLogin, names.readonly],
    [writeLogin, names.runtime],
  ] as const) {
    await pg.pool.query(
      `CREATE ROLE ${login} ${attributes} CONNECTION LIMIT 5 VALID UNTIL '${expiresAt}'`,
    );
    await pg.pool.query(`GRANT ${member} TO ${login} WITH INHERIT TRUE, SET FALSE`);
  }
  await pg.pool.query(`CREATE DATABASE ${database} OWNER app`);
  // Every PGCF tenant database also carries PGCF's own platform schema, which the read proof scans like any other.
  await createPgcfPlatformSchema(superuser, database, "app");
  const connect = async (role: string) => {
    const url = new URL(superuser);
    url.username = role;
    url.pathname = `/${database}`;
    url.search = "";
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  };
  const as = async <T>(role: string, work: (client: Client) => Promise<T>) => {
    const client = await connect(role);
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };
  const attempt = async (client: Client, sql: string) => {
    await client.query("BEGIN");
    try {
      await client.query(sql);
      return "ok";
    } catch (error) {
      return String((error as { code?: unknown }).code);
    } finally {
      await client.query("ROLLBACK");
    }
  };
  const accepted = (mode: "read" | "write"): IssuedProjectDatabaseAccess =>
    Object.freeze({
      provider: "pgcf",
      accessId: "00000000000000000000000005",
      roleName: mode === "read" ? readLogin : writeLogin,
      memberRole: mode === "read" ? names.readonly : names.runtime,
      mode,
      environment: "dev",
      environmentId,
      dataEnvironmentId: environmentId,
      providerProjectId: "prj_abcdefghijklmnopqrst",
      databaseId: database,
      originHost: host,
      issuedAt: new Date().toISOString(),
      expiresAt,
      label: null,
    });
  /** What the provider and the connections saw: a role is created once per issue, and each connection names its login. */
  const calls = { createRole: 0, logins: [] as string[] };
  /** `loginFor` lets a test hand out another login than the one asked for, as a provider that returned the wrong credential. */
  const issue = async (mode: "read" | "write", loginFor = (role: string) => role) => {
    const grant = accepted(mode);
    // A role is issued once; the default a previous attempt gave this fixture role would make its setup read-only.
    await pg.pool.query(`ALTER ROLE ${grant.roleName} RESET default_transaction_read_only`);
    const view = {
      databaseId: database,
      name: grant.roleName,
      owner: false,
      bypassRls: false,
      passwordRevision: 1,
      connectionLimit: 5,
      validUntil: expiresAt,
      memberOf: [grant.memberRole],
      membershipOptions: { inherit: true, set: false },
    };
    const provider: PgcfAccessProvider = {
      projectId: grant.providerProjectId,
      createRole: async () => {
        calls.createRole++;
        return view;
      },
      readRoles: async () => [view],
      readConnection: async (_database, role) =>
        ({
          host,
          consume: async <T>(use: (uri: string) => Promise<T>) =>
            use(`postgresql://${role}:synthetic-fixture-password@${host}/${database}`),
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
    return issuePgcfDatabaseAccess({
      provider,
      accepted: grant,
      projectId: "00000000000000000000000002",
      recordOperation: async () => {
        throw new Error("Unexpected provider operation");
      },
      assertScope: async () => undefined,
      connect: async (_uri, target) => {
        calls.logins.push(target.role);
        const client = await connect(loginFor(target.role));
        return {
          client: {
            query: (text: string, values?: readonly unknown[]) =>
              client.query(text, values ? [...values] : []),
          },
          close: () => client.end(),
        };
      },
    });
  };
  return {
    calls,
    pool: pg.pool,
    superuser,
    expiresAt,
    issue,
    connect,
    as,
    probe: (role: string) =>
      as(role, async (client) => {
        const outcomes: Record<string, string> = {};
        for (const [name, sql] of Object.entries(PROBES))
          outcomes[name] = await attempt(client, sql);
        return outcomes;
      }),
    /** What every migration does through the owner: the production statements, minus the role settings the runtime login runs. */
    bootstrap: () =>
      as("app", async (client) => {
        for (const sql of projectSqlRoleGrants(environmentId, database).filter(
          (sql) => !sql.startsWith("ALTER ROLE") && !sql.startsWith("DO $omh_timeout$"),
        ))
          await client.query(sql);
      }),
    /** What a migration ran before the read proof existed: the same owner statements without the TEMPORARY and persisting-function ones. */
    legacyBootstrap: () =>
      as("app", async (client) => {
        for (const sql of projectSqlRoleGrants(environmentId, database).filter(
          (sql) =>
            !sql.startsWith("ALTER ROLE") &&
            !sql.startsWith("DO $omh_timeout$") &&
            !/TEMPORARY|omh_persisting_functions/u.test(sql),
        ))
          await client.query(sql);
      }),
    /** Customer relations of every kind, in the public schema and in a second one, with the grants the migration role gives them. */
    migrate: async () => {
      // A foreign table needs a foreign-data wrapper, which only a superuser creates; the migration role owns the table.
      await asSuperuser(superuser, database, [
        "CREATE FOREIGN DATA WRAPPER customer_wrapper",
        "CREATE SERVER customer_server FOREIGN DATA WRAPPER customer_wrapper",
        "CREATE FOREIGN TABLE public.customer_foreign(id integer) SERVER customer_server",
        `ALTER FOREIGN TABLE public.customer_foreign OWNER TO ${names.migration}`,
      ]);
      await as(names.migration, async (client) => {
        for (const statement of [
          "CREATE TABLE public.customer_rows(id serial PRIMARY KEY, value text)",
          "CREATE VIEW public.customer_view AS SELECT id, value FROM public.customer_rows",
          "CREATE MATERIALIZED VIEW public.customer_matview AS SELECT id, value FROM public.customer_rows",
          "CREATE TABLE public.customer_events(id integer, at date) PARTITION BY RANGE (at)",
          "CREATE SCHEMA ohmyhost; CREATE TABLE ohmyhost.schema_migrations(path text)",
          "CREATE SCHEMA private; CREATE TABLE private.records(id integer, value text)",
        ])
          await client.query(statement);
        for (const sql of projectSqlRuntimeGrants(environmentId, false, ["private"]))
          await client.query(sql);
      });
    },
  };
}

it("lets a read login create temporary tables, large objects and WAL messages on a stock database, and closes all of them once the bootstrap and the PGCF baseline are in place without taking them from the roles that write", async () => {
  const f = await fixture();
  // The finding: PostgreSQL's defaults give every role TEMPORARY and EXECUTE on the persisting functions.
  expect(await f.probe(readLogin)).toEqual(open);

  await f.bootstrap();
  await f.migrate();
  await f.bootstrap();
  // Before the PGCF baseline the owner's GRANT of the five functions is a no-op because PUBLIC still holds them.
  expect(await f.probe(readLogin)).toEqual({ ...open, temp: "42501" });
  expect(await f.probe(names.runtime)).toEqual(open);

  await applyPgcfBaseline(f.superuser, database, "app");
  await f.bootstrap();
  await f.bootstrap();
  for (const role of [names.readonly, readLogin]) expect(await f.probe(role)).toEqual(closed);
  for (const role of [names.runtime, names.migration, writeLogin])
    expect(await f.probe(role)).toEqual(open);
  // The session default is not the boundary: a login that switches it off still holds no write privilege.
  await f.as(readLogin, async (client) => {
    await client.query("SET default_transaction_read_only = off");
    for (const statement of [
      "INSERT INTO public.customer_rows(value) VALUES ('x')",
      "INSERT INTO private.records(value) VALUES ('x')",
      "UPDATE public.customer_rows SET value = 'x'",
      "DELETE FROM public.customer_rows",
      "TRUNCATE public.customer_rows",
      "SELECT nextval('public.customer_rows_id_seq')",
      "CREATE TABLE public.readers_table(n integer)",
      "CREATE SCHEMA readers_schema",
    ])
      await expect(client.query(statement)).rejects.toMatchObject({ code: "42501" });
    expect(
      (await client.query("SELECT count(*)::int AS n FROM public.customer_rows")).rows,
    ).toEqual([{ n: 0 }]);
  });

  // A database between baseline steps: PUBLIC lost the five functions but the owner holds none to pass on, so the
  // owner's GRANT fails with 42501 unless the bootstrap contains it. Every other grant still completes, however the
  // essential ones are ordered, and the write roles lack the functions until the owner holds them again.
  await asSuperuser(f.superuser, database, [
    `REVOKE USAGE, CREATE ON SCHEMA public FROM ${names.migration}`,
  ]);
  await stripOwnerCreators(f.superuser, database, "app");
  await f.bootstrap();
  const withoutFunctions = { ...closed, temp: "ok" };
  for (const role of [names.runtime, names.migration, writeLogin])
    expect(await f.probe(role)).toEqual(withoutFunctions);
  await f.as(names.migration, (client) => client.query("CREATE TABLE public.after_grants(n int)"));
  // The read role is still provably read-only there, so its credential is issued: only the write roles are affected.
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read" });
  // The owner holding the functions without a grant option is a warning as well, not an error.
  await asSuperuser(f.superuser, database, [
    `GRANT EXECUTE ON FUNCTION ${PERSISTING_FUNCTIONS.join(", ")} TO app`,
  ]);
  await f.bootstrap();
  expect(await f.probe(names.runtime)).toEqual(withoutFunctions);
  // Once the owner holds them WITH GRANT OPTION again, the next migration restores the write roles.
  await applyPgcfBaseline(f.superuser, database, "app");
  await f.bootstrap();
  for (const role of [names.runtime, names.migration, writeLogin])
    expect(await f.probe(role)).toEqual(open);
}, 120_000);

it("issues a read credential only for a login that provably cannot write, and a write credential regardless", async () => {
  const f = await fixture();
  const refused = (failed: string) =>
    expect(f.issue("read")).rejects.toMatchObject({
      name: "ProjectDatabaseAccessError",
      code: "scope",
      failed: [failed],
    });

  // A stock database leaves the read role able to write; the write credential is unchanged by that. The issue closes
  // TEMPORARY itself through the owner, so only the functions that PUBLIC still holds refuse the credential.
  await expect(f.issue("read")).rejects.toMatchObject({
    code: "scope",
    failed: ["persisting_function"],
  });
  const logins = f.calls.logins.length;
  await expect(f.issue("write")).resolves.toMatchObject({ mode: "write", role_name: writeLogin });
  // Only a read credential brings the owner grants up to date: a write credential never opens the owner connection.
  expect(f.calls.logins.slice(logins)).toEqual([writeLogin, writeLogin]);
  await f.bootstrap();
  await f.migrate();
  // The bootstrap closes the temporary tables, but PUBLIC still holds the five functions until the PGCF baseline.
  await refused("persisting_function");
  await applyPgcfBaseline(f.superuser, database, "app");
  await f.bootstrap();
  // The platform schema, relations of every kind and a second schema are all there, and the role still passes.
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read", role_name: readLogin });

  // Each privilege that would let the read role leave data or volume behind is refused on its own, in any schema and
  // on every kind of relation, and the refusal names the check that failed.
  for (const [failed, privilege, object] of [
    ["database_privilege", "TEMPORARY", `DATABASE ${database}`],
    ["database_privilege", "CREATE", `DATABASE ${database}`],
    ["schema_create", "CREATE", "SCHEMA public"],
    ["schema_create", "CREATE", "SCHEMA ohmyhost"],
    ["schema_create", "CREATE", "SCHEMA private"],
    ["schema_create", "CREATE", "SCHEMA pgcf"],
    ["data_write", "INSERT", "public.customer_rows"],
    ["data_write", "UPDATE (value)", "public.customer_rows"],
    ["data_write", "DELETE", "public.customer_rows"],
    ["data_write", "TRUNCATE", "public.customer_rows"],
    ["data_write", "INSERT", "private.records"],
    ["data_write", "INSERT", "pgcf.outbox"],
    ["data_write", "USAGE", "SEQUENCE public.customer_rows_id_seq"],
    ["data_write", "UPDATE", "SEQUENCE public.customer_rows_id_seq"],
    ["data_write", "INSERT", "public.customer_view"],
    ["data_write", "INSERT", "public.customer_matview"],
    ["data_write", "INSERT", "public.customer_events"],
    ["data_write", "INSERT", "public.customer_foreign"],
    ...PERSISTING_FUNCTIONS.map(
      (signature) => ["persisting_function", "EXECUTE", `FUNCTION ${signature}`] as const,
    ),
  ] as const) {
    await asSuperuser(f.superuser, database, [
      `GRANT ${privilege} ON ${object} TO ${names.readonly}`,
    ]);
    await refused(failed);
    await asSuperuser(f.superuser, database, [
      `REVOKE ${privilege} ON ${object} FROM ${names.readonly}`,
    ]);
  }
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read" });
}, 180_000);

it("issues the first read credential of an environment that has not migrated since the read proof by running the owner grants itself, in every PGCF state and as often as asked", async () => {
  const f = await fixture();
  // An existing environment: its last migration ran before the grants for TEMPORARY and the persisting functions existed.
  await f.legacyBootstrap();
  await f.migrate();
  expect(await f.probe(readLogin)).toEqual(open);

  // Before the PGCF baseline the issue closes TEMPORARY on its own; only the functions, which PUBLIC still holds, refuse it.
  await expect(f.issue("read")).rejects.toMatchObject({
    code: "scope",
    failed: ["persisting_function"],
    grants: "ensured",
  });
  expect(await f.probe(names.runtime)).toEqual(open);

  // The baseline takes the functions from the roles that write until the owner grants run again: the issue runs them.
  await applyPgcfBaseline(f.superuser, database, "app");
  expect(await f.probe(names.runtime)).toEqual({ ...closed, temp: "ok" });
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read", role_name: readLogin });
  for (const role of [names.runtime, names.migration, writeLogin])
    expect(await f.probe(role)).toEqual(open);
  expect(await f.probe(names.readonly)).toEqual(closed);

  // Idempotent, and a database between baseline steps never aborts the issue: the owner holds no function to pass on.
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read" });
  await stripOwnerCreators(f.superuser, database, "app");
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read" });
  expect(await f.probe(names.runtime)).toEqual({ ...closed, temp: "ok" });
  await applyPgcfBaseline(f.superuser, database, "app");
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read" });
  expect(await f.probe(names.runtime)).toEqual(open);
}, 120_000);

it("runs the owner grants only as the database owner, before any role exists, and leaves the database untouched while a migration holds the lock", async () => {
  const f = await fixture();
  await f.legacyBootstrap();
  const ensure = (login: string, originHost = host) =>
    ensureProjectRoleGrants({
      provider: {
        readConnection: async (_database, role) =>
          ({
            host,
            consume: async <T>(use: (uri: string) => Promise<T>) =>
              use(`postgresql://${role}:synthetic-fixture-password@${host}/${database}`),
          }) as Awaited<ReturnType<PgcfAccessProvider["readConnection"]>>,
      },
      connect: async () => {
        const client = await f.connect(login);
        return { client, close: () => client.end() };
      },
      databaseId: database,
      environmentId,
      originHost,
    });

  // A login that is not the owner, or an origin that is not the environment's, never runs them, whatever the provider
  // handed out; and the owner path fails before the new role exists, so there is no role to take back.
  await expect(ensure(names.migration)).rejects.toMatchObject({
    name: "DatabaseProviderConflictError",
  });
  await expect(ensure("app", "other.db.example.com")).rejects.toMatchObject({
    name: "DatabaseProviderConflictError",
  });
  await expect(
    f.issue("read", (role) => (role === "app" ? names.migration : role)),
  ).rejects.toMatchObject({ name: "DatabaseProviderConflictError" });
  expect(f.calls.createRole).toBe(0);
  expect(f.calls.logins).toEqual(["app"]);
  expect(await f.probe(names.readonly)).toEqual(open);

  // A migration holds the migrations lock: nothing changes, the fixed outcome says so, and a read credential that the
  // proof then refuses carries it, so the refusal is not mistaken for a missing PGCF baseline.
  const migration = await f.connect(names.migration);
  await migration.query("SELECT pg_advisory_lock(hashtextextended('ohmyhost:migrations', 0))");
  try {
    await expect(ensure("app")).resolves.toBe("busy");
    await expect(f.issue("read")).rejects.toMatchObject({
      code: "scope",
      failed: ["database_privilege", "persisting_function"],
      grants: "busy",
    });
  } finally {
    await migration.end();
  }
  expect(f.calls.createRole).toBe(1);
  expect(await f.probe(names.readonly)).toEqual(open);

  // Written once, under the lock; afterwards nothing is missing and the state is only read.
  await expect(ensure("app")).resolves.toBe("ensured");
  await expect(ensure("app")).resolves.toBe("current");
  expect(await f.probe(names.readonly)).toEqual({ ...open, temp: "42501" });
  expect(await f.probe(names.runtime)).toEqual(open);
}, 180_000);

it("refuses a read credential while its role can execute a customer security-definer function, and the owning migration role takes that execute from PUBLIC", async () => {
  const f = await fixture();
  await f.bootstrap();
  await f.migrate();
  await applyPgcfBaseline(f.superuser, database, "app");
  await f.bootstrap();
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read" });
  // A migration creates a definer function; PUBLIC gets EXECUTE on it by default, which a read login would inherit.
  await f.as(names.migration, (client) =>
    client.query(
      "CREATE FUNCTION public.customer_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT 1 $$",
    ),
  );
  await expect(f.issue("read")).rejects.toMatchObject({
    code: "scope",
    failed: ["definer_function"],
  });
  // The migration role owns the function, so it is the one that takes PUBLIC's execute away; the runtime keeps its own.
  await f.as(names.migration, (client) => client.query(PROJECT_SQL_DEFINER_REVOKE_STATEMENT));
  await expect(f.issue("read")).resolves.toMatchObject({ mode: "read" });
  expect(
    (await f.as(names.runtime, (client) => client.query("SELECT public.customer_definer() AS n")))
      .rows,
  ).toEqual([{ n: 1 }]);
  await expect(
    f.as(readLogin, (client) => client.query("SELECT public.customer_definer()")),
  ).rejects.toMatchObject({ code: "42501" });
}, 120_000);

it("re-applies the access login's statement and lock timeouts on every lease, so a tenant's ALTER ROLE ... SET is undone by the next one", async () => {
  const f = await fixture();
  await f.bootstrap();
  await f.migrate();
  await applyPgcfBaseline(f.superuser, database, "app");
  await f.bootstrap();
  await expect(f.issue("write")).resolves.toMatchObject({ mode: "write", role_name: writeLogin });
  // The tenant sets its own login's timeout to none; the login may change its own defaults.
  await f.as(writeLogin, (client) =>
    client.query("ALTER ROLE CURRENT_USER SET statement_timeout = 0"),
  );
  expect(
    await f.as(
      writeLogin,
      async (client) =>
        (await client.query("SHOW statement_timeout")).rows[0]?.["statement_timeout"],
    ),
  ).toBe("0");
  // The next lease applies the platform's default again before the credential is returned.
  await expect(f.issue("write")).resolves.toMatchObject({ mode: "write", role_name: writeLogin });
  expect(
    await f.as(
      writeLogin,
      async (client) =>
        (await client.query("SHOW statement_timeout")).rows[0]?.["statement_timeout"],
    ),
  ).toBe("1min");
}, 120_000);
