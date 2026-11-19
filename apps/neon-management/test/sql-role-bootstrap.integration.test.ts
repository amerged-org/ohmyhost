import {
  DatabaseMigrationExecutionError,
  executeExpandOnlyMigrations,
  type DatabaseMigrationClient,
} from "@ohmyhost/platform";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { Client } from "pg";
import { startTestPostgres, type TestPostgres } from "../../control-api/test/postgres.js";
import {
  PROJECT_SQL_DEFINER_REVOKE_STATEMENT,
  projectSqlRoleName,
  projectSqlRoleGrants,
  projectSqlRuntimeGrants,
} from "@ohmyhost/platform";
import {
  adaptGeneratedServiceRolePredicate,
  prepareProjectRlsHelpers,
} from "../src/sql-role-bootstrap.js";
const scope = {
  organizationId: "00000000000000000000000001",
  projectId: "00000000000000000000000002",
  environmentId: "00000000000000000000000003",
};
const databases: TestPostgres[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.stop();
});
/** The three restricted roles exist as the PGCF API creates them; the grants are the production statements. */
async function fixture() {
  const db = await startTestPostgres();
  databases.push(db);
  await db.pool.query("CREATE ROLE foreign_owner LOGIN CREATEROLE CREATEDB BYPASSRLS");
  let disconnectAt: { role: string; statement: string } | null = null;
  const dependencies = {
    withRole: async <Result>(
      name: string,
      work: (client: {
        query(
          text: string,
          values?: readonly unknown[],
        ): Promise<{
          readonly rows: readonly Record<string, unknown>[];
          readonly rowCount: number | null;
        }>;
      }) => Promise<Result>,
    ): Promise<Result> => {
      const url = new URL(String(db.pool.options.connectionString));
      url.username = name;
      const client = new Client({
        connectionString: url.toString(),
        options: "-c search_path=public",
      });
      await client.connect();
      try {
        return await work({
          query: async (text, values) => {
            const result = await client.query(text, values ? [...values] : []);
            if (disconnectAt?.role === name && disconnectAt.statement === text) {
              disconnectAt = null;
              // Real transport disposal makes the next statement and its ROLLBACK fail.
              await client.end();
            }
            return result;
          },
        });
      } finally {
        await client.end();
      }
    },
  };
  for (const purpose of ["migration", "readonly", "runtime"] as const)
    await db.pool.query(
      `CREATE ROLE ${projectSqlRoleName(scope.environmentId, purpose)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
  const databaseName = String(
    (await db.pool.query("SELECT current_database() AS name")).rows[0]?.name,
  );
  for (const query of projectSqlRoleGrants(scope.environmentId, databaseName))
    await db.pool.query(query);
  return {
    db,
    dependencies,
    disconnectAfter: (role: string, statement: string) => {
      disconnectAt = { role, statement };
    },
  };
}
it("gives the three restricted roles exactly their privileges and survives a lost migration connection", async () => {
  const { db, dependencies, disconnectAfter } = await fixture();
  const names = {
    migration: `ohmyho_m_${scope.environmentId.toLowerCase()}`,
    readonly: `ohmyho_ro_${scope.environmentId.toLowerCase()}`,
    runtime: `ohmyho_rw_${scope.environmentId.toLowerCase()}`,
  };
  await dependencies.withRole(names["migration"], async (client) => {
    await client.query("CREATE TABLE public.role_proof(id integer PRIMARY KEY,value text)");
    await client.query(
      "CREATE SCHEMA ohmyhost; CREATE TABLE ohmyhost.schema_migrations(path text); INSERT INTO ohmyhost.schema_migrations VALUES('001.sql')",
    );
    await client.query("CREATE SCHEMA private; CREATE TABLE private.customer_data(id integer)");
    for (const query of projectSqlRuntimeGrants(scope.environmentId, false, ["private"]))
      await client.query(query);
  });
  await dependencies.withRole(names["runtime"], async (client) => {
    await client.query("INSERT INTO public.role_proof VALUES($1,$2)", [1, "customer data"]);
    await client.query("INSERT INTO private.customer_data VALUES(1)");
    await expect(client.query("DELETE FROM ohmyhost.schema_migrations")).rejects.toMatchObject({
      code: "42501",
    });
    expect(
      (await client.query("SELECT current_user AS role,value FROM public.role_proof")).rows,
    ).toEqual([{ role: names["runtime"], value: "customer data" }]);
    await expect(
      client.query("CREATE TABLE public.forbidden_runtime(id integer)"),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(client.query("CREATE ROLE forbidden_runtime")).rejects.toMatchObject({
      code: "42501",
    });
  });
  await dependencies.withRole(names["readonly"], async (client) => {
    expect(
      (await client.query("SELECT count(*)::int n FROM public.role_proof")).rows[0]?.["n"],
    ).toBe(1);
    await expect(client.query("DELETE FROM public.role_proof")).rejects.toMatchObject({
      code: "42501",
    });
    expect((await client.query("SELECT * FROM ohmyhost.schema_migrations")).rows).toEqual([
      { path: "001.sql" },
    ]);
    expect((await client.query("SELECT * FROM private.customer_data")).rows).toEqual([{ id: 1 }]);
  });
  disconnectAfter(names["migration"], "BEGIN");
  const migrationBody = new TextEncoder().encode(
    "CREATE TABLE public.disconnected_proof(id integer);",
  );
  const failure: unknown = await dependencies
    .withRole(names["migration"], (client) =>
      executeExpandOnlyMigrations(client as DatabaseMigrationClient, [
        {
          path: "20260914000000_disconnected_proof.sql",
          body: migrationBody,
          size: migrationBody.byteLength,
          digest: `sha256:${createHash("sha256").update(migrationBody).digest("hex")}`,
        },
      ]),
    )
    .then(
      () => {
        throw new Error("The disconnected migration unexpectedly succeeded");
      },
      (error: unknown) => error,
    );
  expect(failure).toBeInstanceOf(DatabaseMigrationExecutionError);
  if (!(failure instanceof DatabaseMigrationExecutionError)) throw new Error("Unexpected failure");
  expect(failure).toMatchObject({ reason: "uncertain", path: null });
  expect(failure.statementIndex).toBeUndefined();
  expect(failure.sqlstate).toBeUndefined();
  // The injected disconnect follows BEGIN, before customer SQL. This independent read checks the
  // local fixture without letting the unavailable migration connection claim a known outcome.
  expect(
    (await db.pool.query("SELECT to_regclass('public.disconnected_proof') AS relation")).rows,
  ).toEqual([{ relation: null }]);
  expect((await db.pool.query("SELECT value FROM public.role_proof WHERE id=1")).rows).toEqual([
    { value: "customer data" },
  ]);
}, 60_000);
it("prepares exact transaction-local RLS helpers without exposing the migration ledger or replacing custom functions", async () => {
  const { db, dependencies, disconnectAfter } = await fixture();
  const migration = projectSqlRoleName(scope.environmentId, "migration");
  const runtime = projectSqlRoleName(scope.environmentId, "runtime");
  const readonly = projectSqlRoleName(scope.environmentId, "readonly");
  await dependencies.withRole(migration, async (client) => {
    await prepareProjectRlsHelpers(client, scope.environmentId);
    await client.query(`CREATE TABLE ohmyhost.schema_migrations(path text);
      INSERT INTO ohmyhost.schema_migrations VALUES ('001.sql');
      CREATE TABLE public.helper_rows(id integer PRIMARY KEY, owner_id text);
      INSERT INTO public.helper_rows VALUES (1,'user-a'),(2,'user-b');
      ALTER TABLE public.helper_rows ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_rows ON public.helper_rows USING (owner_id=ohmyhost.user_id()) WITH CHECK (owner_id=ohmyhost.user_id())`);
    for (const query of projectSqlRuntimeGrants(scope.environmentId, false))
      await client.query(query);
    await prepareProjectRlsHelpers(client, scope.environmentId);
  });
  for (const role of [runtime, readonly])
    await dependencies.withRole(role, async (client) => {
      expect(
        (await client.query("SELECT ohmyhost.user_id() AS id,ohmyhost.claims() AS claims")).rows,
      ).toEqual([{ id: null, claims: {} }]);
      expect((await client.query("SELECT * FROM public.helper_rows")).rows).toEqual([]);
      for (const [sub, ending] of [
        ["user-a", "COMMIT"],
        ["user-b", "ROLLBACK"],
      ] as const) {
        const claims = { sub, role: "authenticated", tenant: "example" };
        await client.query("BEGIN");
        await client.query("SELECT set_config('ohmyhost.request_claims',$1,true)", [
          JSON.stringify(claims),
        ]);
        expect(
          (await client.query("SELECT ohmyhost.user_id() AS id,ohmyhost.claims() AS claims")).rows,
        ).toEqual([{ id: sub, claims }]);
        expect((await client.query("SELECT owner_id FROM public.helper_rows")).rows).toEqual([
          { owner_id: sub },
        ]);
        await client.query(ending);
        expect(
          (await client.query("SELECT ohmyhost.user_id() AS id,ohmyhost.claims() AS claims")).rows,
        ).toEqual([{ id: null, claims: {} }]);
      }
      await expect(
        client.query("CREATE TABLE ohmyhost.forbidden(id integer)"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        client.query("UPDATE ohmyhost.schema_migrations SET path='changed'"),
      ).rejects.toMatchObject({ code: "42501" });
    });
  await dependencies.withRole(runtime, async (client) => {
    await expect(client.query("SELECT * FROM ohmyhost.schema_migrations")).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      client.query("INSERT INTO public.helper_rows VALUES(3,'user-a')"),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("BEGIN");
    await client.query("SELECT set_config('ohmyhost.request_claims',$1,true)", [
      JSON.stringify({ sub: "user-a", role: "authenticated" }),
    ]);
    await client.query("INSERT INTO public.helper_rows VALUES(3,'user-a')");
    await expect(
      client.query("INSERT INTO public.helper_rows VALUES(4,'user-b')"),
    ).rejects.toMatchObject({ code: "42501" });
    await client.query("ROLLBACK");
  });
  await dependencies.withRole(readonly, async (client) => {
    expect((await client.query("SELECT * FROM ohmyhost.schema_migrations")).rows).toEqual([
      { path: "001.sql" },
    ]);
  });
  expect(
    (
      await db.pool
        .query(`SELECT proname,prosecdef,provolatile,proconfig,proowner::regrole::text AS owner,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl,acldefault('f',proowner))) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
      FROM pg_proc WHERE pronamespace='ohmyhost'::regnamespace ORDER BY proname`)
    ).rows,
  ).toEqual(
    ["claims", "user_id"].map((proname) => ({
      proname,
      prosecdef: false,
      provolatile: "s",
      proconfig: ["search_path=pg_catalog"],
      owner: migration,
      public_execute: false,
    })),
  );
  const definitions = (
    await db.pool.query(
      "SELECT proname,pg_get_functiondef(oid) AS sql FROM pg_proc WHERE pronamespace='ohmyhost'::regnamespace",
    )
  ).rows as { proname: string; sql: string }[];
  const claimsDefinition = definitions.find((row) => row.proname === "claims")?.sql;
  if (!claimsDefinition) throw new Error("Missing claims definition");
  for (const mutation of [
    'CREATE OR REPLACE FUNCTION ohmyhost.claims() RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$SELECT \'{"sub":"custom"}\'::jsonb$$',
    "ALTER FUNCTION ohmyhost.claims() SECURITY DEFINER",
    "ALTER FUNCTION ohmyhost.claims() SET search_path=public",
    "ALTER FUNCTION ohmyhost.claims() OWNER TO foreign_owner",
    "CREATE FUNCTION ohmyhost.claims(text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$",
  ]) {
    await db.pool.query(mutation);
    const before = (
      await db.pool.query(
        "SELECT oid,proowner,pg_get_functiondef(oid) AS sql FROM pg_proc WHERE pronamespace='ohmyhost'::regnamespace ORDER BY oid",
      )
    ).rows;
    await expect(
      dependencies.withRole(migration, (client) =>
        prepareProjectRlsHelpers(client, scope.environmentId),
      ),
    ).rejects.toMatchObject({ code: "sql_role_helper_conflict" });
    expect(
      (
        await db.pool.query(
          "SELECT oid,proowner,pg_get_functiondef(oid) AS sql FROM pg_proc WHERE pronamespace='ohmyhost'::regnamespace ORDER BY oid",
        )
      ).rows,
    ).toEqual(before);
    await db.pool.query(claimsDefinition);
    await db.pool.query(
      `ALTER FUNCTION ohmyhost.claims() OWNER TO ${migration}; DROP FUNCTION IF EXISTS ohmyhost.claims(text)`,
    );
  }
  await db.pool.query("ALTER SCHEMA ohmyhost OWNER TO foreign_owner");
  await expect(
    dependencies.withRole(migration, (client) =>
      prepareProjectRlsHelpers(client, scope.environmentId),
    ),
  ).rejects.toMatchObject({ code: "sql_role_helper_conflict" });
  expect(
    (
      await db.pool.query(
        "SELECT nspowner::regrole::text AS owner FROM pg_namespace WHERE nspname='ohmyhost'",
      )
    ).rows,
  ).toEqual([{ owner: "foreign_owner" }]);
  await db.pool.query(`ALTER SCHEMA ohmyhost OWNER TO ${migration}`);
  disconnectAfter(migration, "BEGIN");
  await expect(
    dependencies.withRole(migration, (client) =>
      prepareProjectRlsHelpers(client, scope.environmentId),
    ),
  ).rejects.toMatchObject({ code: "sql_role_helper_unavailable" });
}, 60_000);
it("adapts only the exact generated service-role predicate and refuses a custom one", async () => {
  const { dependencies } = await fixture();
  const target = projectSqlRoleName(scope.environmentId, "migration");
  await dependencies.withRole(target, async (client) => {
    await client.query(
      "CREATE FUNCTION public.is_service_role_request() RETURNS boolean LANGUAGE sql STABLE AS $$\n  SELECT current_user = 'ohmyho_runtime'\n    AND current_setting('app.service_request', true) = 'on'\n$$",
    );
    expect(await adaptGeneratedServiceRolePredicate(client)).toBe(true);
    expect(await adaptGeneratedServiceRolePredicate(client)).toBe(false);
    await client.query(
      "CREATE OR REPLACE FUNCTION public.is_service_role_request() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_user = 'ohmyho_runtime' OR true$$",
    );
    const before = (
      await client.query(
        "SELECT md5(prosrc) AS fingerprint FROM pg_proc WHERE oid='public.is_service_role_request()'::regprocedure",
      )
    ).rows;
    await expect(adaptGeneratedServiceRolePredicate(client)).rejects.toMatchObject({
      code: "sql_role_custom_predicate",
    });
    expect(
      (
        await client.query(
          "SELECT md5(prosrc) AS fingerprint FROM pg_proc WHERE oid='public.is_service_role_request()'::regprocedure",
        )
      ).rows,
    ).toEqual(before);
  });
}, 60_000);
it("lets a temporary access login assert ohmyhost.request_claims, so ohmyhost.user_id() follows the assertion", async () => {
  const { db, dependencies } = await fixture();
  const migration = projectSqlRoleName(scope.environmentId, "migration");
  const readonly = projectSqlRoleName(scope.environmentId, "readonly");
  const access = "ohmyho_da_01hz0000000000000000000000_abcdefgh";
  await dependencies.withRole(migration, (client) =>
    prepareProjectRlsHelpers(client, scope.environmentId),
  );
  await db.pool
    .query(`CREATE ROLE ${access} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT ${readonly} TO ${access}`);
  await dependencies.withRole(access, async (client) => {
    expect((await client.query("SELECT ohmyhost.user_id() AS id")).rows).toEqual([{ id: null }]);
    await client.query("BEGIN");
    await client.query("SELECT set_config('ohmyhost.request_claims',$1,true)", [
      JSON.stringify({ sub: "user-b", role: "authenticated" }),
    ]);
    expect((await client.query("SELECT ohmyhost.user_id() AS id")).rows).toEqual([
      { id: "user-b" },
    ]);
    await client.query("ROLLBACK");
    expect((await client.query("SELECT ohmyhost.user_id() AS id")).rows).toEqual([{ id: null }]);
  });
}, 60_000);

it("keeps the shared read-only role out of the customer auth schema, where password hashes and tokens live", async () => {
  const { dependencies } = await fixture();
  const names = {
    migration: projectSqlRoleName(scope.environmentId, "migration"),
    readonly: projectSqlRoleName(scope.environmentId, "readonly"),
    runtime: projectSqlRoleName(scope.environmentId, "runtime"),
  };
  await dependencies.withRole(names.migration, async (client) => {
    await client.query(
      `CREATE SCHEMA ohmyhost; CREATE TABLE ohmyhost.schema_migrations(path text);
      CREATE SCHEMA auth; CREATE TABLE auth."user"(id integer, password_hash text); INSERT INTO auth."user" VALUES (1,'hash')`,
    );
    for (const query of projectSqlRuntimeGrants(scope.environmentId, true))
      await client.query(query);
  });
  await dependencies.withRole(names.runtime, async (client) => {
    expect((await client.query('SELECT count(*)::int n FROM auth."user"')).rows[0]?.["n"]).toBe(1);
  });
  await dependencies.withRole(names.readonly, async (client) => {
    await expect(client.query('SELECT password_hash FROM auth."user"')).rejects.toMatchObject({
      code: "42501",
    });
  });
}, 60_000);

it("takes the read-only role's older auth-schema grants back when the current grants are applied to an existing database", async () => {
  const { dependencies } = await fixture();
  const names = {
    migration: projectSqlRoleName(scope.environmentId, "migration"),
    readonly: projectSqlRoleName(scope.environmentId, "readonly"),
    runtime: projectSqlRoleName(scope.environmentId, "runtime"),
  };
  await dependencies.withRole(names.migration, async (client) => {
    await client.query(
      `CREATE SCHEMA ohmyhost; CREATE TABLE ohmyhost.schema_migrations(path text);
      CREATE SCHEMA auth; CREATE TABLE auth."user"(id integer, password_hash text); INSERT INTO auth."user" VALUES (1,'hash')`,
    );
    // What a migration before this change granted the shared read-only role on the auth schema.
    for (const query of [
      `GRANT USAGE ON SCHEMA auth TO ${names.readonly}`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA auth TO ${names.readonly}`,
      `GRANT SELECT ON ALL SEQUENCES IN SCHEMA auth TO ${names.readonly}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON TABLES TO ${names.readonly}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA auth GRANT SELECT ON SEQUENCES TO ${names.readonly}`,
    ])
      await client.query(query);
    await client.query('CREATE TABLE auth."session"(id integer)');
  });
  await dependencies.withRole(names.readonly, async (client) => {
    expect((await client.query('SELECT count(*)::int n FROM auth."user"')).rows[0]?.["n"]).toBe(1);
  });
  await dependencies.withRole(names.migration, async (client) => {
    for (const query of projectSqlRuntimeGrants(scope.environmentId, true))
      await client.query(query);
    // A table the migration creates after the grants is not readable by the read-only role either.
    await client.query('CREATE TABLE auth."verification"(id integer)');
  });
  await dependencies.withRole(names.readonly, async (client) => {
    await expect(client.query('SELECT password_hash FROM auth."user"')).rejects.toMatchObject({
      code: "42501",
    });
    await expect(client.query('SELECT id FROM auth."session"')).rejects.toMatchObject({
      code: "42501",
    });
    await expect(client.query('SELECT id FROM auth."verification"')).rejects.toMatchObject({
      code: "42501",
    });
  });
  await dependencies.withRole(names.runtime, async (client) => {
    expect((await client.query('SELECT count(*)::int n FROM auth."user"')).rows[0]?.["n"]).toBe(1);
  });
}, 60_000);

it("lets the runtime call a security-definer function that a migration created in a customer schema, after the definer revoke", async () => {
  const { dependencies } = await fixture();
  const names = {
    migration: projectSqlRoleName(scope.environmentId, "migration"),
    readonly: projectSqlRoleName(scope.environmentId, "readonly"),
    runtime: projectSqlRoleName(scope.environmentId, "runtime"),
  };
  await dependencies.withRole(names.migration, async (client) => {
    await client.query(
      `CREATE SCHEMA ohmyhost; CREATE TABLE ohmyhost.schema_migrations(path text);
      CREATE SCHEMA private;
      CREATE FUNCTION private.is_member() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$ SELECT true $$`,
    );
    // The order of pgcf-runtime: the migration, the definer revoke, then the runtime grants.
    await client.query(PROJECT_SQL_DEFINER_REVOKE_STATEMENT);
    for (const query of projectSqlRuntimeGrants(scope.environmentId, false, ["private"]))
      await client.query(query);
  });
  await dependencies.withRole(names.runtime, async (client) => {
    expect((await client.query("SELECT private.is_member() AS member")).rows).toEqual([
      { member: true },
    ]);
  });
  await dependencies.withRole(names.readonly, async (client) => {
    await expect(client.query("SELECT private.is_member()")).rejects.toMatchObject({
      code: "42501",
    });
  });
}, 60_000);
