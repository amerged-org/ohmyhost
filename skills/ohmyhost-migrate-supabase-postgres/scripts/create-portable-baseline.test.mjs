import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, URL } from "node:url";

import { createPortableBaseline, splitPortableBaseline } from "./create-portable-baseline.mjs";

test("default conversion rejects Supabase Auth and RLS policy dependencies", () => {
  const source = [
    "CREATE TABLE public.profiles (id uuid REFERENCES auth.users(id));",
    "CREATE POLICY own_profile ON public.profiles USING (id = auth.uid());",
  ].join("\n");

  assert.throws(
    () => createPortableBaseline(source),
    /Portable baseline generation failed: unsafe statement/u,
  );
});

test("explicit Better Auth/server authorization mode converts exact identity references and reports omitted policies", () => {
  const source = [
    "CREATE SCHEMA private;",
    "CREATE TABLE public.profiles (id uuid REFERENCES auth.users(id));",
    "ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;",
    "CREATE POLICY own_profile ON public.profiles USING (id = auth.uid());",
    "CREATE FUNCTION public.profile_owner() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT auth.uid() $$;",
    "CREATE FUNCTION public.is_service_role_request() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_user = 'service_role' $$;",
    "CREATE CONSTRAINT TRIGGER profile_guard AFTER INSERT ON public.profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.profile_owner();",
  ].join("\n");

  const result = createPortableBaseline(source, {
    authMode: "better-auth-uuid",
    authorizationMode: "server",
  });

  assert.equal(result.omittedPolicyCount, 1);
  assert.equal(result.convertedAuthReferenceCount, 3);
  assert.match(result.sql, /REFERENCES auth\."user"\(id\)/u);
  assert.match(result.sql, /CREATE SCHEMA IF NOT EXISTS private/u);
  assert.match(result.sql, /public\.current_actor_id\(\)/u);
  assert.ok(result.sql.includes("current_user ~ '^ohmyho_rw_[0-7][0-9a-hjkmnp-tv-z]{25}$'"));
  assert.match(result.sql, /current_setting\('app\.service_request', true\) = 'on'/u);
  assert.match(result.sql, /SET check_function_bodies = false/u);
  assert.match(result.sql, /CREATE CONSTRAINT TRIGGER profile_guard/u);
  assert.doesNotMatch(result.sql, /auth\.users|auth\.uid|CREATE POLICY|ROW LEVEL SECURITY/u);
  const literals = createPortableBaseline(
    `CREATE TABLE public.messages(note text DEFAULT E'auth.uid(); \\'quoted\\''); CREATE FUNCTION public.message() RETURNS text LANGUAGE sql AS $$ SELECT 'auth.uid()' $$;`,
    { authMode: "better-auth-uuid", authorizationMode: "server" },
  );
  assert.equal(literals.convertedAuthReferenceCount, 0);
  assert.ok(literals.sql.includes("SELECT 'auth.uid()'"));
  assert.ok(literals.sql.includes("DEFAULT E'auth.uid(); \\'quoted\\''"));
});

test("conversion still rejects other Auth schemas, Storage, role DDL, writes, and destructive statements", () => {
  for (const statement of [
    "CREATE TABLE public.bad (id uuid REFERENCES auth.sessions(id));",
    "CREATE TABLE public.bad (id uuid REFERENCES storage.objects(id));",
    "CREATE ROLE attacker;",
    "INSERT INTO public.bad VALUES (1);",
    "DROP TABLE public.bad;",
  ]) {
    assert.throws(
      () =>
        createPortableBaseline(statement, {
          authMode: "better-auth-uuid",
          authorizationMode: "server",
        }),
      /Portable baseline generation failed/u,
    );
  }
});

test("splits canonical statements into ordered admission-sized migration files", () => {
  const baseline = createPortableBaseline(
    Array.from(
      { length: 8 },
      (_, index) => `CREATE TABLE public.table_${index} (id uuid primary key)`,
    ).join(";\n"),
  );
  const files = splitPortableBaseline(baseline, "20260823000000_portable_baseline", 240);

  assert.ok(files.length > 1);
  assert.deepEqual(
    files.map(({ path }) => path),
    files.map(
      (_, index) => `20260823000000_portable_baseline_${String(index + 1).padStart(3, "0")}.sql`,
    ),
  );
  assert.equal(
    files.reduce((sum, file) => sum + file.statementCount, 0),
    baseline.statements.length,
  );
  assert.ok(files.every(({ byteLength }) => byteLength <= 240));
  assert.throws(
    () => splitPortableBaseline(baseline, "../invalid", 240),
    /split migration input is invalid/u,
  );
});

const rlsOptions = {
  authorizationMode: "preserve-rls",
  backendRlsTables: ["public.profiles"],
  userIdMapping: "uuid",
  claimMappings: [
    {
      sourcePath: ["app_metadata", "organization_id"],
      targetPath: ["organization_id"],
      trust: "server-verified",
    },
    { sourcePath: ["role"], targetPath: ["role"], trust: "server-verified" },
  ],
};

test("an ordinary ALTER TABLE on a column named security is not an RLS change", () => {
  const result = createPortableBaseline(
    `
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, security uuid);
    ALTER TABLE ONLY public.profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ONLY public.profiles ADD CONSTRAINT profiles_security_fkey FOREIGN KEY (security) REFERENCES public.profiles(id);
  `,
    rlsOptions,
  );
  assert.ok(
    result.statements.some((statement) =>
      /ADD CONSTRAINT profiles_security_fkey FOREIGN KEY \(security\)/u.test(statement),
    ),
  );
});

test("a function precedes the tables, defaults, checks and domains that call it", () => {
  const result = createPortableBaseline(`
    CREATE FUNCTION public.f() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;
    CREATE TABLE public.t (id integer DEFAULT public.f() CHECK (id > public.f()));
    CREATE DOMAIN public.positive AS integer CHECK (VALUE > public.f());
  `);
  const position = (pattern) => result.statements.findIndex((statement) => pattern.test(statement));
  const fn = position(/^CREATE FUNCTION public\.f\b/u);
  assert.ok(fn >= 0);
  assert.ok(fn < position(/^CREATE TABLE public\.t\b/u));
  assert.ok(fn < position(/^CREATE DOMAIN public\.positive\b/u));
});

test("omitted clauses of a permissive policy grant nothing, as in PostgreSQL", () => {
  const result = createPortableBaseline(
    `
    CREATE TABLE public.profiles (id uuid, organization_id text);
    ALTER TABLE ONLY public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY profile_update ON public.profiles FOR UPDATE TO authenticated WITH CHECK (id = (SELECT auth.uid()));
    CREATE POLICY profile_read ON public.profiles FOR SELECT TO authenticated;
    CREATE POLICY profile_insert ON public.profiles FOR INSERT TO authenticated;
  `,
    rlsOptions,
  );
  assert.equal(result.emittedPolicyCount, 3);
  assert.doesNotMatch(result.sql, /\btrue\b/u);
  assert.match(result.sql, /\bfalse\b/u);
});

test("reviewed RLS conversion preserves policy identities, role semantics, default checks and literal bytes", () => {
  const result = createPortableBaseline(
    `
    SELECT pg_catalog.set_config('search_path', '', false);
    CREATE TABLE public.profiles (id uuid, organization_id text, note text DEFAULT 'auth.uid(); -- literal', "auth.uid()" text DEFAULT $$auth.jwt(); -- literal$$);
    ALTER TABLE ONLY public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Owner -- policy" ON public.profiles FOR ALL TO authenticated
      USING ((SELECT auth.uid()) = id AND auth.jwt()->'app_metadata'->>'organization_id' = organization_id);
    CREATE POLICY anonymous_restriction ON public.profiles AS RESTRICTIVE FOR UPDATE TO anon
      USING (note <> 'auth.uid()');
    CREATE POLICY public_read ON public.profiles FOR SELECT TO PUBLIC USING (true);
    create or replace view public.marker as select 'CREATE OR REPLACE VIEW'::text AS note;
  `,
    rlsOptions,
  );
  assert.equal(result.omittedPolicyCount, 0);
  assert.equal(result.inputPolicyCount, 3);
  assert.equal(result.emittedPolicyCount, 3);
  assert.equal(result.translatedPolicyCount, 2);
  assert.deepEqual(result.normalizedForceRlsTables, ["public.profiles"]);
  assert.match(result.sql, /"Owner -- policy"/u);
  assert.match(result.sql, /ohmyhost\.user_id\(\)::uuid/u);
  assert.match(result.sql, /ohmyhost\.claims\(\) ->> 'organization_id'/u);
  assert.match(result.sql, /AS RESTRICTIVE FOR UPDATE TO PUBLIC USING \(NOT /u);
  assert.match(result.sql, /WITH CHECK \(NOT /u);
  assert.match(result.sql, /DEFAULT 'auth\.uid\(\); -- literal'/u);
  assert.ok(result.sql.includes('"auth.uid()" text DEFAULT $$auth.jwt(); -- literal$$'));
  assert.match(result.sql, /note <> 'auth\.uid\(\)'/u);
  assert.match(result.sql, /ENABLE ROW LEVEL SECURITY/u);
  assert.match(result.sql, /FORCE ROW LEVEL SECURITY/u);
  assert.ok(
    result.sql.includes(
      "create view public.marker as select 'CREATE OR REPLACE VIEW'::text AS note",
    ),
  );
  assert.doesNotMatch(result.sql, /current_actor_id/u);
  const quoted = createPortableBaseline(
    `\\restrict abc123
    CREATE TABLE "public"."profiles" (id uuid, note text DEFAULT E'semi; \\'quote\\'');
    /* outer /* inner */ comment */ ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "public"."profiles" FORCE ROW LEVEL SECURITY;
    CREATE POLICY "quoted""policy" ON "public"."profiles" FOR INSERT TO anon, authenticated WITH CHECK (id = "auth"."uid"());
    \\unrestrict abc123
    -- trailing comment`,
    rlsOptions,
  );
  assert.deepEqual(quoted.normalizedForceRlsTables, []);
  assert.match(quoted.sql, /"quoted""policy"/u);
  assert.match(quoted.sql, /IN \('anon', 'authenticated'\)/u);
  assert.ok(quoted.sql.includes("E'semi; \\'quote\\''"));
  assert.match(quoted.sql, /FOR INSERT TO PUBLIC WITH CHECK/u);
  const ordinaryData = createPortableBaseline(
    `SET standard_conforming_strings = 'on'; CREATE TABLE public.profiles (id uuid, "user" text, note text); ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY; CREATE POLICY ordinary_data ON public.profiles USING ((auth.jwt()->>'role' IN ('anon', 'authenticated')) AND "user" = 'authenticated' AND note = 'service_role');`,
    rlsOptions,
  );
  assert.ok(ordinaryData.sql.includes("\"user\" = 'authenticated'"));
  assert.ok(ordinaryData.sql.includes("note = 'service_role'"));
});

test("RLS conversion refuses incomplete reviews and unsupported authorization instead of omitting policies", () => {
  const table =
    "CREATE TABLE public.profiles(id uuid, note text); ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY; ";
  for (const [source, options, error] of [
    [
      table + "CREATE POLICY p ON public.profiles USING (id=auth.uid());",
      { ...rlsOptions, userIdMapping: undefined },
      /userIdMapping/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles TO service_role USING (true);",
      rlsOptions,
      /role.*service_role/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles TO administrator USING (true);",
      rlsOptions,
      /role.*administrator/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (auth.jwt()->>'organization_id' = note);",
      rlsOptions,
      /claim mapping/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (public.is_service_role_request());",
      rlsOptions,
      /function/u,
    ],
    [table + "ALTER POLICY p ON public.profiles USING (true);", rlsOptions, /policy lifecycle/u],
    [table + "DROP POLICY p ON public.profiles;", rlsOptions, /policy lifecycle/u],
    [
      table + "CREATE POLICY p ON public.profiles FOR SELECT WITH CHECK (true);",
      rlsOptions,
      /WITH CHECK/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (true);",
      { ...rlsOptions, backendRlsTables: [] },
      /backendRlsTables/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (true);",
      {
        ...rlsOptions,
        claimMappings: [
          {
            sourcePath: ["user_metadata", "admin"],
            targetPath: ["admin"],
            trust: "server-verified",
          },
        ],
      },
      /user-editable/u,
    ],
    [table + "CREATE POLICY p ON public.profiles USING (true) trailing;", rlsOptions, /policy/u],
    [
      table +
        "CREATE POLICY p ON public.profiles USING ((auth.jwt()->>'role' = 'service_role') OR id = auth.uid());",
      rlsOptions,
      /service_role/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (USER = 'authenticated');",
      rlsOptions,
      /physical database-role/u,
    ],
    [
      table +
        "CREATE POLICY p ON public.profiles USING (auth.jwt()->>'role' IN ('anon', 'service_role'));",
      rlsOptions,
      /service_role/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING ('service_role' = (auth.jwt()->>'role'));",
      rlsOptions,
      /service_role/u,
    ],
    [
      table +
        "CREATE POLICY p ON public.profiles USING (auth.jwt()->>'role' = ('service' || '_role'));",
      rlsOptions,
      /dynamic role/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (auth.jwt()->>'role' = note);",
      rlsOptions,
      /dynamic role/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (auth.jwt()->>'role'\n'_suffix' = note);",
      rlsOptions,
      /concatenated/u,
    ],
    ...["false", "no", "0", "'off'", "DEFAULT"].map((setting) => [
      table +
        `CREATE POLICY p ON public.profiles USING (note = 'a\\b'); SET standard_conforming_strings = ${setting};`,
      rlsOptions,
      /standard_conforming_strings/u,
    ]),
    ...["E'standard_conforming_strings'", "'STANDARD_CONFORMING_STRINGS'"].map((setting) => [
      table +
        `SELECT pg_catalog.set_config(${setting}, 'off', false); CREATE POLICY p ON public.profiles USING (note = 'a\\b');`,
      rlsOptions,
      /set_config/u,
    ]),
    ...["", "SESSION ", "LOCAL "].map((scope) => [
      table +
        `SET ${scope}"STANDARD_CONFORMING_STRINGS" = off; CREATE POLICY p ON public.profiles USING (note = 'a\\b');`,
      rlsOptions,
      /standard_conforming_strings/u,
    ]),
    ...["RESET standard_conforming_strings", "RESET ALL"].map((statement) => [
      table + `${statement}; CREATE POLICY p ON public.profiles USING (true);`,
      rlsOptions,
      /unsupported portable statement/u,
    ]),
    ...[
      ["constructor"],
      ["prototype"],
      ["__proto__"],
      ["nested", "constructor"],
      ["x".repeat(129)],
    ].map((targetPath) => [
      table +
        "CREATE POLICY p ON public.profiles USING (auth.jwt()->'app_metadata'->>'organization_id' = note);",
      {
        ...rlsOptions,
        claimMappings: [
          { sourcePath: ["app_metadata", "organization_id"], targetPath, trust: "server-verified" },
        ],
      },
      /target claim/u,
    ]),
    [
      table + "CREATE POLICY p ON public.profiles FOR 'SELECT' USING (true);",
      rlsOptions,
      /policy FOR/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles AS 'RESTRICTIVE' USING (true);",
      rlsOptions,
      /policy AS/u,
    ],
    [table + "CREATE POLICY p ON public.profiles USING '(' true );", rlsOptions, /parentheses/u],
    [
      table + 'CREATE POLICY p ON public.profiles USING ("coalesce"(true, false));',
      rlsOptions,
      /function/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (auth.uid '(' ')' = id);",
      rlsOptions,
      /literal/u,
    ],
    [
      table + "CREATE POLICY p ON public.profiles USING (true); /* unterminated",
      rlsOptions,
      /unterminated/u,
    ],
    [
      table +
        "CREATE POLICY p ON public.profiles USING (true); CREATE FUNCTION public.provider() RETURNS uuid LANGUAGE sql AS $$ SELECT auth.uid() $$;",
      rlsOptions,
      /function body/u,
    ],
    [
      table +
        "CREATE POLICY p ON public.profiles USING (true); SET standard_conforming_strings = off;",
      rlsOptions,
      /standard_conforming_strings/u,
    ],
    [
      table +
        "CREATE POLICY p ON public.profiles USING (true); ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;",
      rlsOptions,
      /DISABLE/u,
    ],
  ])
    assert.throws(() => createPortableBaseline(source, options), error);
  assert.throws(() => createPortableBaseline(table), /RLS requires explicit/u);
  const mapped = createPortableBaseline(
    table.replace("id uuid", "id uuid REFERENCES auth.users(id)") +
      "CREATE POLICY p ON public.profiles USING (true);",
    { ...rlsOptions, authMode: "better-auth-uuid" },
  );
  assert.match(mapped.sql, /REFERENCES auth\."user"/u);
  assert.throws(
    () =>
      createPortableBaseline(
        table.replace("id uuid", "id uuid REFERENCES auth.users(id)"),
        rlsOptions,
      ),
    /authMode/u,
  );
});

test("report-only counts every policy, redacts unsupported expressions, and leaves the source directory unchanged", async () => {
  const report = await runRlsReport(`
    CREATE TABLE public.profiles (id uuid, note text);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Member read" ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
    CREATE POLICY public_read ON public.profiles FOR SELECT USING (true);
    CREATE POLICY custom_guard ON public.profiles FOR UPDATE USING (private.secret_check('lit-private-value'));
    CREATE POLICY missing_mapping ON public.profiles FOR INSERT WITH CHECK (auth.jwt()->>'not_reviewed' = note);
  `);
  assert.equal(report.status, 1);
  assert.equal(report.stderr, "");
  assert.doesNotMatch(report.stdout, /secret_check|lit-private-value|not_reviewed|CREATE POLICY/u);
  assert.deepEqual(report.summary, {
    version: 1,
    completeInventory: true,
    canGenerate: false,
    sourcePolicies: 4,
    preserved: 1,
    translated: 1,
    blocked: 2,
    requiredExtensions: [],
    blockers: [],
    policies: [
      { table: "public.profiles", policy: "Member read", command: "SELECT", status: "translated" },
      { table: "public.profiles", policy: "public_read", command: "SELECT", status: "preserved" },
      {
        table: "public.profiles",
        policy: "custom_guard",
        command: "UPDATE",
        status: "blocked",
        reason: "unsupported_policy_function",
      },
      {
        table: "public.profiles",
        policy: "missing_mapping",
        command: "INSERT",
        status: "blocked",
        reason: "claim_mapping_required",
      },
    ],
  });
});

test("report-only agrees with successful generation and rejects output options and incomplete inventory", async () => {
  const source = `
    CREATE TABLE public.profiles (id uuid);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
  `;
  const report = await runRlsReport(source);
  const generated = createPortableBaseline(source, rlsOptions);
  assert.equal(report.status, 0);
  assert.equal(report.summary.canGenerate, true);
  assert.equal(report.summary.sourcePolicies, generated.inputPolicyCount);
  assert.equal(report.summary.translated, generated.translatedPolicyCount);
  const blockedSchema = await runRlsReport(
    source + "ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;",
  );
  assert.equal(blockedSchema.status, 1);
  assert.equal(blockedSchema.summary.completeInventory, true);
  assert.equal(blockedSchema.summary.canGenerate, false);
  assert.deepEqual(blockedSchema.summary.blockers, ["schema_not_portable"]);
  const ambiguous = await runRlsReport(source, ["--output", "unexpected.sql"]);
  assert.equal(ambiguous.status, 1);
  assert.equal(ambiguous.summary, undefined);
  // A missing option value must not consume a later report-only flag.
  const missingOperand = await runRlsReport(source, [
    "--output",
    "unexpected.sql",
    "--unexpected-flag",
  ]);
  assert.equal(missingOperand.status, 1);
  assert.equal(missingOperand.summary, undefined);
  const incomplete = await runRlsReport(source + "'unterminated private value");
  assert.equal(incomplete.status, 1);
  assert.equal(incomplete.summary.completeInventory, false);
  assert.equal(incomplete.summary.canGenerate, false);
  assert.deepEqual(incomplete.summary.blockers, ["inventory_incomplete"]);
  assert.doesNotMatch(incomplete.stdout + incomplete.stderr, /private value/u);
});

test("retains opt-in trigram search from a schema dump and reports unknown extensions", async () => {
  const source = `
    CREATE SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
    COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement';
    CREATE TABLE public.profiles (id uuid, name text);
    CREATE INDEX profiles_name_trgm ON public.profiles USING gin (name extensions.gin_trgm_ops);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
  `;
  const report = await runRlsReport(source);
  assert.equal(report.status, 0);
  assert.deepEqual(report.summary.requiredExtensions, ["pg_trgm"]);
  const generated = createPortableBaseline(source, rlsOptions);
  assert.equal(generated.statements.filter((s) => s.includes("pg_trgm")).length, 1);
  assert.match(generated.sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;/u);
  assert.doesNotMatch(generated.sql, /COMMENT ON EXTENSION/u);

  const unknown = source + "CREATE EXTENSION pg_unsupported WITH SCHEMA extensions;";
  const blocked = await runRlsReport(unknown);
  assert.equal(blocked.status, 1);
  assert.deepEqual(blocked.summary.blockers, ["unsupported_extension_declaration"]);
  assert.throws(
    () => createPortableBaseline(unknown, rlsOptions),
    /unsupported extension declaration/u,
  );
});

test("preserves explicit citext and ltree declarations without installing them by default", async () => {
  const source = `
    CREATE SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;
    CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA extensions;
    CREATE TABLE public.profiles (id uuid, name extensions.citext, path extensions.ltree);
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner ON public.profiles FOR SELECT TO authenticated USING (id = auth.uid());
  `;
  const report = await runRlsReport(source);
  assert.equal(report.status, 0);
  assert.deepEqual(report.summary.requiredExtensions, ["citext", "ltree"]);
  const generated = createPortableBaseline(source, rlsOptions);
  assert.match(generated.sql, /CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;/u);
  assert.match(generated.sql, /CREATE EXTENSION IF NOT EXISTS ltree WITH SCHEMA extensions;/u);
  const withoutExtensions = source.replace(/.*CREATE EXTENSION[^;]*;\s*/gu, "");
  const plain = createPortableBaseline(
    withoutExtensions
      .replaceAll("extensions.citext", "text")
      .replaceAll("extensions.ltree", "text"),
    rlsOptions,
  );
  assert.doesNotMatch(plain.sql, /(?:citext|ltree)/u);
});

async function runRlsReport(source, extra = []) {
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-rls-report-"));
  const script = fileURLToPath(new URL("./create-portable-baseline.mjs", import.meta.url));
  try {
    await writeFile(join(root, "schema.sql"), source, { mode: 0o600 });
    const { authorizationMode, ...review } = rlsOptions;
    await writeFile(join(root, "review.json"), JSON.stringify(review), { mode: 0o600 });
    const args = [
      script,
      "--input",
      "schema.sql",
      "--authorization-mode",
      authorizationMode,
      "--rls-options",
      "review.json",
      ...extra,
      "--report-only",
    ];
    const result = await promisify(execFile)(process.execPath, args, { cwd: root }).then(
      (result) => ({ ...result, status: 0 }),
      (error) => ({ stdout: error.stdout, stderr: error.stderr, status: error.code }),
    );
    assert.deepEqual((await readdir(root)).sort(), ["review.json", "schema.sql"]);
    return { ...result, summary: result.stdout ? JSON.parse(result.stdout) : undefined };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("original Supabase policies and converted policies have equal PostgreSQL row and write outcomes", async () => {
  const execute = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "ohmyhost-rls-converter-"));
  const data = join(root, "data");
  const port = await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: available } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(available)));
    });
  });
  const env = {
    ...process.env,
    ...(process.env.OHMYHOST_TEST_POSTGRES_BIN
      ? { PATH: `${process.env.OHMYHOST_TEST_POSTGRES_BIN}:${process.env.PATH ?? ""}` }
      : {}),
    PGHOST: "127.0.0.1",
    PGPORT: String(port),
    PGUSER: "postgres",
    PGDATABASE: "postgres",
    PGPASSWORD: "",
    PGSSLMODE: "disable",
    PGCONNECT_TIMEOUT: "5",
  };
  const run = (command, args) => execute(command, args, { env, timeout: 30_000 });
  const sql = async (database, statement) =>
    (
      await execute(
        "psql",
        ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", statement],
        { env, timeout: 10_000 },
      )
    ).stdout.trim();
  let started = false;
  try {
    await run("initdb", ["-D", data, "-A", "trust", "-U", "postgres"]);
    await run("pg_ctl", [
      "-D",
      data,
      "-l",
      join(root, "postgres.log"),
      "-o",
      `-F -p ${port} -h 127.0.0.1 -k ''`,
      "-w",
      "start",
    ]);
    started = true;
    await sql(
      "postgres",
      "CREATE ROLE anon NOBYPASSRLS; CREATE ROLE authenticated NOBYPASSRLS; CREATE ROLE app_runtime NOBYPASSRLS;",
    );
    await sql("postgres", "CREATE DATABASE original");
    await sql("postgres", "CREATE DATABASE converted");
    const original = `
      CREATE TABLE public.profiles(id uuid, organization_id text, note text);
      ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_row ON public.profiles FOR ALL TO authenticated USING (id = (SELECT auth.uid()));
      CREATE POLICY organization ON public.profiles AS RESTRICTIVE TO authenticated USING (organization_id = auth.jwt()->'app_metadata'->>'organization_id');
      CREATE POLICY public_read ON public.profiles FOR SELECT TO anon USING (note = 'public');
      CREATE POLICY anonymous_update ON public.profiles AS RESTRICTIVE FOR UPDATE TO anon USING (false);
      CREATE POLICY visible ON public.profiles AS RESTRICTIVE FOR SELECT USING (note <> 'hidden');
      CREATE POLICY insert_guard ON public.profiles AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (note <> 'blocked' AND auth.jwt()->>'role' = 'authenticated');
      CREATE POLICY delete_guard ON public.profiles AS RESTRICTIVE FOR DELETE TO authenticated USING (note <> 'public');
    `;
    const inputPath = join(root, "input.sql");
    const optionsPath = join(root, "review.json");
    const outputPath = join(root, "output.sql");
    await writeFile(inputPath, original);
    await writeFile(
      optionsPath,
      JSON.stringify({
        backendRlsTables: rlsOptions.backendRlsTables,
        userIdMapping: rlsOptions.userIdMapping,
        claimMappings: rlsOptions.claimMappings,
      }),
    );
    const generate = (input, outputArguments, startupArguments = []) =>
      run(process.execPath, [
        ...startupArguments,
        fileURLToPath(new URL("./create-portable-baseline.mjs", import.meta.url)),
        "--input",
        input,
        ...outputArguments,
        "--authorization-mode",
        "preserve-rls",
        "--rls-options",
        optionsPath,
      ]);
    const cli = await generate(inputPath, ["--output", outputPath]);
    const report = JSON.parse(cli.stdout);
    assert.equal(report.omittedPolicyCount, 0);
    assert.equal(report.inputPolicyCount, 7);
    assert.equal(report.emittedPolicyCount, 7);
    assert.equal(
      await readFile(outputPath, "utf8"),
      createPortableBaseline(original, rlsOptions).sql,
    );
    const originalOutputBytes = await readFile(outputPath);
    await assert.rejects(generate(inputPath, ["--output", outputPath]), /output.*exists|EEXIST/u);
    assert.deepEqual(await readFile(outputPath), originalOutputBytes);
    const linkedOutput = join(root, "linked-output.sql");
    await symlink(inputPath, linkedOutput);
    await assert.rejects(generate(inputPath, ["--output", linkedOutput]), /output.*exists|EEXIST/u);
    assert.equal(await readFile(inputPath, "utf8"), original);
    assert.equal(await readlink(linkedOutput), inputPath);
    const racingOutput = join(root, "racing-output.sql");
    const raceHook = join(root, "output-race.mjs");
    // Create the competing symlink only after preflight reaches writeFile.
    // This hook belongs solely to the disposable child CLI process.
    await writeFile(
      raceHook,
      `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFile;
fs.writeFile = async (...args) => {
  if (args[0] === ${JSON.stringify(racingOutput)}) await fs.symlink(${JSON.stringify(inputPath)}, ${JSON.stringify(racingOutput)});
  return write(...args);
};
syncBuiltinESMExports();
`,
    );
    await assert.rejects(
      generate(inputPath, ["--output", racingOutput], ["--import", raceHook]),
      /output.*exists|EEXIST/u,
    );
    assert.equal(await readFile(inputPath, "utf8"), original);
    assert.equal(await readlink(racingOutput), inputPath);

    const splitInput = join(root, "split-input.sql");
    const splitSource =
      original +
      ["one", "two"]
        .map(
          (suffix) =>
            `CREATE TABLE public.payload_${suffix} (value text DEFAULT '${"x".repeat(140_000)}');`,
        )
        .join("\n");
    const splitBaseline = createPortableBaseline(splitSource, rlsOptions);
    const prefix = "20261009000000_reviewed";
    const splitFiles = splitPortableBaseline(splitBaseline, prefix);
    assert.ok(splitFiles.length > 1);
    await writeFile(splitInput, splitSource);
    const outputDirectory = join(root, "migrations");
    await mkdir(outputDirectory);
    const collisionPath = join(outputDirectory, splitFiles[1].path);
    await writeFile(collisionPath, "Previously reviewed migration bytes.\n");
    const collisionBytes = await readFile(collisionPath);
    await assert.rejects(
      generate(splitInput, ["--output-directory", outputDirectory, "--migration-prefix", prefix]),
      /output.*exists|EEXIST/u,
    );
    assert.deepEqual(await readFile(collisionPath), collisionBytes);
    assert.deepEqual(await readdir(outputDirectory), [splitFiles[1].path]);
    const freshPrefix = "20261009000001_reviewed";
    const freshFiles = splitPortableBaseline(splitBaseline, freshPrefix);
    const splitCli = await generate(splitInput, [
      "--output-directory",
      outputDirectory,
      "--migration-prefix",
      freshPrefix,
    ]);
    assert.equal(JSON.parse(splitCli.stdout).files.length, freshFiles.length);
    for (const file of freshFiles)
      assert.equal(await readFile(join(outputDirectory, file.path), "utf8"), file.sql);
    await assert.rejects(
      generate(splitInput, [
        "--output-directory",
        outputDirectory,
        "--migration-prefix",
        freshPrefix,
      ]),
      /output.*exists|EEXIST/u,
    );
    for (const file of freshFiles)
      assert.equal(await readFile(join(outputDirectory, file.path), "utf8"), file.sql);
    assert.deepEqual(await readFile(collisionPath), collisionBytes);
    await sql(
      "original",
      `CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user_id', true), '')::uuid $$;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT current_setting('test.claims', true)::jsonb $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated;
      ${original}`,
    );
    await sql(
      "converted",
      `CREATE SCHEMA ohmyhost;
      CREATE FUNCTION ohmyhost.user_id() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user_id', true), '') $$;
      CREATE FUNCTION ohmyhost.claims() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT current_setting('test.claims', true)::jsonb $$;
      GRANT USAGE ON SCHEMA ohmyhost TO app_runtime;
      ${createPortableBaseline(original, rlsOptions).sql}`,
    );
    const owner = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    const seed = `INSERT INTO public.profiles VALUES ('${owner}','org-a','owned'), ('${other}','org-b','other'), ('${other}','org-a','public'), ('${owner}','org-a','hidden');`;
    await sql(
      "original",
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO anon, authenticated; ${seed}`,
    );
    await sql(
      "converted",
      `GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO app_runtime; ${seed}`,
    );
    const cases = [
      [null, "org-a", "SELECT note FROM public.profiles ORDER BY note", "public"],
      [owner, "org-a", "SELECT note FROM public.profiles ORDER BY note", "owned"],
      [owner, "org-b", "SELECT note FROM public.profiles ORDER BY note", ""],
      [
        owner,
        "org-a",
        "UPDATE public.profiles SET note='updated' WHERE note='owned' RETURNING note",
        "updated",
      ],
      [
        owner,
        "org-a",
        "UPDATE public.profiles SET organization_id='org-b' WHERE note='owned' RETURNING note",
        "denied",
      ],
      [
        owner,
        "org-a",
        `INSERT INTO public.profiles VALUES ('${owner}', 'org-a', 'inserted') RETURNING note`,
        "inserted",
      ],
      [
        owner,
        "org-a",
        `INSERT INTO public.profiles VALUES ('${other}', 'org-a', 'forbidden') RETURNING note`,
        "denied",
      ],
      [owner, "org-a", "DELETE FROM public.profiles WHERE note='owned' RETURNING note", "owned"],
      [
        owner,
        "org-a",
        `INSERT INTO public.profiles VALUES ('${owner}', 'org-a', 'blocked') RETURNING note`,
        "denied",
      ],
      [null, "org-a", "UPDATE public.profiles SET note='forbidden' RETURNING note", ""],
    ];
    for (const [subject, organization, query, expected] of cases) {
      const role = subject === null ? "anon" : "authenticated";
      const outcome = async (database) => {
        const claims =
          database === "original"
            ? { role, app_metadata: { organization_id: organization } }
            : { role, sub: subject, organization_id: organization };
        try {
          return await sql(
            database,
            `BEGIN; SET LOCAL ROLE ${database === "original" ? role : "app_runtime"};
            DO $$ BEGIN PERFORM set_config('test.user_id', '${subject ?? ""}', true); PERFORM set_config('test.claims', '${JSON.stringify(claims)}', true); END $$;
            ${query}; ROLLBACK;`,
          );
        } catch (error) {
          if (error.stderr?.includes("violates row-level security policy")) return "denied";
          throw error;
        }
      };
      assert.equal(await outcome("original"), expected, `original: ${query}`);
      assert.equal(await outcome("converted"), expected, `converted: ${query}`);
    }
    assert.equal(
      await sql(
        "converted",
        "SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.profiles'::regclass",
      ),
      "t",
    );
  } finally {
    if (started) await run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    await rm(root, { recursive: true, force: true });
  }
});
