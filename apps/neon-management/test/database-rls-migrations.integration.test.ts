import { createHash } from "node:crypto";
import { Client } from "pg";
import { afterEach, expect, it } from "vitest";
import {
  executeExpandOnlyMigrations,
  projectSqlRoleName,
  type DatabaseMigrationClient,
} from "@ohmyhost/platform";
import { startTestPostgres, type TestPostgres } from "../../control-api/test/postgres.js";

const databases: TestPostgres[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.end();
  for (const database of databases.splice(0)) await database.stop();
});
function migration(sequence: number, sql: string) {
  const body = new TextEncoder().encode(sql);
  return {
    path: `20261008${String(sequence).padStart(6, "0")}_rls.sql`,
    body,
    size: body.byteLength,
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}` as const,
  };
}
async function fixture() {
  const database = await startTestPostgres();
  databases.push(database);
  const owner = projectSqlRoleName("00000000000000000000000003", "migration");
  const runtime = projectSqlRoleName("00000000000000000000000003", "runtime");
  await database.pool.query(
    `CREATE ROLE ${owner} LOGIN NOBYPASSRLS; CREATE ROLE ${runtime} LOGIN NOBYPASSRLS; GRANT CREATE ON DATABASE postgres TO ${owner}; GRANT USAGE, CREATE ON SCHEMA public TO ${owner}`,
  );
  async function connect(role: string) {
    const url = new URL(String(database.pool.options.connectionString));
    url.username = role;
    const client = new Client({
      connectionString: url.toString(),
      options: "-c search_path=public",
    });
    await client.connect();
    clients.push(client);
    return client;
  }
  const migrator = await connect(owner);
  const application = await connect(runtime);
  return {
    database,
    migrator,
    application,
    runtime,
    port: migrator as unknown as DatabaseMigrationClient,
  };
}
it("installs the explicit extensions as the restricted project migrator and preserves the trigram index on replay", async () => {
  const { application, migrator, runtime, port } = await fixture();
  const search = migration(
    1,
    `CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA extensions;
CREATE TABLE public.products(id integer PRIMARY KEY, name text NOT NULL, label extensions.citext, path extensions.ltree);
CREATE INDEX products_name_trgm ON public.products USING gin (name extensions.gin_trgm_ops);`,
  );

  await expect(executeExpandOnlyMigrations(port, [search])).resolves.toMatchObject({
    appliedPaths: [search.path],
  });
  await migrator.query(`INSERT INTO public.products VALUES (1, 'Schmidt', 'Product', 'store.product'), (2, 'Kramer', 'Other', 'store.other');
GRANT USAGE ON SCHEMA extensions TO ${runtime};
GRANT SELECT ON public.products TO ${runtime}`);
  await application.query("SET enable_seqscan TO off");
  const query =
    "SELECT id FROM public.products WHERE name OPERATOR(extensions.%) 'Schmit' ORDER BY id";
  expect((await application.query(query)).rows).toEqual([{ id: 1 }]);
  expect(
    (
      await application.query(
        "SELECT id FROM public.products WHERE label OPERATOR(extensions.=) 'PRODUCT'::extensions.citext AND path OPERATOR(extensions.<@) 'store'::extensions.ltree",
      )
    ).rows,
  ).toEqual([{ id: 1 }]);
  const plan = await application.query<{ "QUERY PLAN": string }>(`EXPLAIN ${query}`);
  expect(plan.rows.map((row) => row["QUERY PLAN"]).join("\n")).toContain(
    "Bitmap Index Scan on products_name_trgm",
  );
  await expect(executeExpandOnlyMigrations(port, [search])).resolves.toMatchObject({
    appliedPaths: [],
  });
  expect((await application.query(query)).rows).toEqual([{ id: 1 }]);
});

const foundation = `CREATE TABLE public.documents(id integer PRIMARY KEY, owner_id text NOT NULL, note text);
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_policy ON public.documents FOR ALL TO PUBLIC
USING (owner_id = current_setting('test.actor', true)) WITH CHECK (owner_id = current_setting('test.actor', true));
CREATE POLICY visible_policy ON public.documents AS RESTRICTIVE FOR SELECT USING (note <> 'hidden');`;

it("enforces two actors, atomically changes policies, replays immutable files and permits default deny", async () => {
  const { database, application, migrator, runtime, port } = await fixture();
  const first = migration(1, foundation);
  await expect(executeExpandOnlyMigrations(port, [first])).resolves.toMatchObject({
    appliedPaths: [first.path],
  });
  await database.pool.query(
    `INSERT INTO public.documents VALUES (1,'alice','visible'),(2,'bob','visible'),(3,'alice','hidden'); GRANT USAGE ON SCHEMA public TO ${runtime}; GRANT SELECT,INSERT,UPDATE,DELETE ON public.documents TO ${runtime}`,
  );
  expect((await migrator.query("SELECT id FROM public.documents")).rows).toEqual([]);
  for (const [actor, id] of [
    ["alice", 1],
    ["bob", 2],
  ] as const) {
    await application.query("BEGIN");
    await application.query("SELECT set_config('test.actor',$1,true)", [actor]);
    expect((await application.query("SELECT id FROM public.documents ORDER BY id")).rows).toEqual([
      { id },
    ]);
    expect(
      (await application.query("UPDATE public.documents SET note='updated' RETURNING id")).rows,
    ).toEqual([{ id }]);
    await expect(
      application.query("INSERT INTO public.documents VALUES(9,'someone_else','bad')"),
    ).rejects.toMatchObject({ code: "42501" });
    await application.query("ROLLBACK");
  }
  const invalidReplacement = migration(
    2,
    "DROP POLICY visible_policy ON public.documents; CREATE POLICY visible_policy ON public.documents USING (missing_column = 1);",
  );
  await expect(
    executeExpandOnlyMigrations(port, [first, invalidReplacement]),
  ).rejects.toMatchObject({ reason: "execution_failed", path: invalidReplacement.path });
  expect(
    (
      await database.pool.query(
        "SELECT polname FROM pg_policy WHERE polname='visible_policy' AND polrelid='public.documents'::regclass",
      )
    ).rows,
  ).toEqual([{ polname: "visible_policy" }]);
  const replacement = migration(
    2,
    `ALTER POLICY owner_policy ON public.documents USING (owner_id = current_setting('test.actor', true)) WITH CHECK (owner_id = current_setting('test.actor', true));
DROP POLICY visible_policy ON public.documents RESTRICT;
CREATE POLICY visible_policy ON public.documents AS RESTRICTIVE FOR SELECT USING (true);`,
  );
  await executeExpandOnlyMigrations(port, [first, replacement]);
  await application.query("SELECT set_config('test.actor','alice',false)");
  expect((await application.query("SELECT id FROM public.documents ORDER BY id")).rows).toEqual([
    { id: 1 },
    { id: 3 },
  ]);
  await expect(executeExpandOnlyMigrations(port, [first, replacement])).resolves.toMatchObject({
    appliedPaths: [],
    replayedPaths: [first.path, replacement.path],
  });
  await expect(
    executeExpandOnlyMigrations(port, [migration(1, foundation + "\n-- changed"), replacement]),
  ).rejects.toMatchObject({ reason: "ledger_conflict", path: first.path });
  const deny = migration(
    3,
    "DROP POLICY IF EXISTS owner_policy ON public.documents; DROP POLICY visible_policy ON public.documents;",
  );
  await executeExpandOnlyMigrations(port, [first, replacement, deny]);
  expect((await application.query("SELECT id FROM public.documents")).rows).toEqual([]);
  expect(
    (
      await database.pool.query(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.documents'::regclass",
      )
    ).rows,
  ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
});

it("rolls back incomplete protection, invalid expressions and non-owned or nonordinary targets", async () => {
  const { database, port } = await fixture();
  const first = migration(
    1,
    "CREATE TABLE public.documents(id integer, owner_id text); CREATE VIEW public.document_view AS SELECT id FROM public.documents; CREATE TABLE public.partitioned(id integer) PARTITION BY RANGE(id);",
  );
  await executeExpandOnlyMigrations(port, [first]);
  await database.pool.query("CREATE TABLE public.foreign_table(id integer)");
  for (const sql of [
    "ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;",
    "CREATE POLICY p ON public.documents USING (true);",
    "ALTER TABLE public.document_view ENABLE ROW LEVEL SECURITY;",
    "ALTER TABLE public.partitioned ENABLE ROW LEVEL SECURITY;",
    "ALTER TABLE public.foreign_table ENABLE ROW LEVEL SECURITY;",
    "ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY; ALTER TABLE public.documents FORCE ROW LEVEL SECURITY; CREATE POLICY p ON public.documents USING (missing_column = 1);",
  ]) {
    const candidate = migration(2, sql);
    await expect(executeExpandOnlyMigrations(port, [first, candidate])).rejects.toMatchObject({
      path: candidate.path,
    });
    expect(
      (
        await database.pool.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.documents'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: false, relforcerowsecurity: false }]);
    expect(
      (await database.pool.query("SELECT path FROM ohmyhost.schema_migrations ORDER BY path")).rows,
    ).toEqual([{ path: first.path }]);
    expect(
      (
        await database.pool.query(
          "SELECT polname FROM pg_policy WHERE polrelid='public.documents'::regclass",
        )
      ).rows,
    ).toEqual([]);
  }
  const continuedEscape = migration(
    2,
    String.raw`CREATE TABLE public.escape_probe(note text DEFAULT E''
'\')'); COMMIT; -- '
;
CREATE TABLE public.failure AS SELECT 1/0;`,
  );
  const escapedResult = await executeExpandOnlyMigrations(port, [first, continuedEscape]).catch(
    (error: unknown) => error,
  );
  expect(
    (await database.pool.query("SELECT to_regclass('public.escape_probe') AS relation")).rows,
  ).toEqual([{ relation: null }]);
  expect(escapedResult).toMatchObject({ reason: "not_admitted", path: continuedEscape.path });
  const changedStringMode = migration(
    2,
    "CREATE TABLE public.string_mode AS SELECT set_config('standard_conforming_strings','off',true) AS mode;",
  );
  const ordinaryEscape = migration(
    3,
    String.raw`CREATE TABLE public.escape_probe(note text DEFAULT '\')'); COMMIT; -- '
;
CREATE TABLE public.failure AS SELECT 1/0;`,
  );
  const modeResult = await executeExpandOnlyMigrations(port, [
    first,
    changedStringMode,
    ordinaryEscape,
  ]).catch((error: unknown) => error);
  expect(
    (
      await database.pool.query(
        "SELECT to_regclass('public.escape_probe') AS relation,to_regclass('public.string_mode') AS settings",
      )
    ).rows,
  ).toEqual([{ relation: null, settings: null }]);
  expect(modeResult).toMatchObject({ reason: "execution_failed", path: ordinaryEscape.path });
});

it("rejects incidental policy or flag mutation outside the exact declared policy target", async () => {
  const { database, port, runtime, migrator } = await fixture();
  const first = migration(1, foundation);
  await executeExpandOnlyMigrations(port, [first]);
  for (const indirect of [
    "ALTER POLICY visible_policy ON public.documents USING (true)",
    "ALTER TABLE public.documents DISABLE ROW LEVEL SECURITY",
    `ALTER POLICY owner_policy ON public.documents TO ${runtime}`,
    "DELETE FROM ohmyhost.schema_migrations",
    "ALTER POLICY owner_policy ON public.documents USING (true)",
    "DROP POLICY owner_policy ON public.documents",
  ]) {
    // A pre-existing function can have effects that the SQL admission reader cannot infer.
    await migrator.query(
      `CREATE OR REPLACE FUNCTION public.mutate_policy() RETURNS integer LANGUAGE plpgsql AS $body$ BEGIN EXECUTE '${indirect}'; RETURN 1; END $body$;`,
    );
    const candidate = migration(
      2,
      `ALTER POLICY owner_policy ON public.documents USING (owner_id = current_setting('test.actor',true));
CREATE TABLE public.side_effect AS SELECT public.mutate_policy() AS value;`,
    );
    await expect(executeExpandOnlyMigrations(port, [first, candidate])).rejects.toMatchObject({
      reason: indirect.startsWith("DELETE") ? "ledger_conflict" : "catalog_changed",
      path: candidate.path,
    });
    expect(
      (
        await database.pool.query(
          "SELECT pg_get_expr(polqual,polrelid) AS expression FROM pg_policy WHERE polname='visible_policy' AND polrelid='public.documents'::regclass",
        )
      ).rows[0]?.expression,
    ).toBe("(note <> 'hidden'::text)");
    expect(
      (
        await database.pool.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='public.documents'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    expect(
      (await database.pool.query("SELECT to_regclass('public.side_effect') AS relation")).rows,
    ).toEqual([{ relation: null }]);
    if (
      indirect === "ALTER POLICY owner_policy ON public.documents USING (true)" ||
      indirect.startsWith("DROP POLICY")
    ) {
      const declared = migration(
        2,
        "ALTER POLICY owner_policy ON public.documents USING (owner_id = current_setting('test.actor',true));",
      );
      const later = migration(
        3,
        "CREATE TABLE public.side_effect AS SELECT public.mutate_policy() AS value;",
      );
      await expect(
        executeExpandOnlyMigrations(port, [first, declared, later]),
      ).rejects.toMatchObject({ reason: "catalog_changed", path: later.path });
      expect(
        (await database.pool.query("SELECT path FROM ohmyhost.schema_migrations ORDER BY path"))
          .rows,
      ).toEqual([{ path: first.path }]);
    }
  }
});
