import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const migrationsDirectory = resolve(packageDirectory, "migrations");

describe("node-pg-migrate CLI configuration", () => {
  it("persists bounded Next cache plans without changing legacy plans or other adapters", async () => {
    const postgres = await startDisposablePostgres();
    const pool = new Pool({ connectionString: postgres.connectionString, max: 1 });
    const client = await pool.connect();
    const options = {
      databaseUrl: postgres.connectionString,
      dir: migrationsDirectory,
      migrationsTable: "control_db_migrations",
      migrationsSchema: "public",
      schema: "public",
      log: () => undefined,
    };
    const legacy = {
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: ".",
      adapter: "nextjs",
      runtime: "edge",
      installCommand: "npm ci --ignore-scripts",
      buildCommand: "npm run build",
      outputDirectory: ".open-next/assets",
      serverOutputDirectory: ".ohmyhost-worker",
      serverEntryPoint: ".ohmyhost-worker/worker.js",
      serverConfigPath: "wrangler.jsonc",
      compatibilityDate: "2024-09-23",
      compatibilityFlags: ["nodejs_compat"],
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
    };
    let sequence = 1;
    const insert = async (plan: Record<string, unknown>) =>
      await client.query(
        `INSERT INTO deployment_plans(plan_id,organization_id,project_id,source_connection_id,
          commit_sha,source_sha256,build_plan_sha256,plan_sha256,runtime,framework_plan,
          impacts,risks,cost_estimate,created_at,expires_at,environment_id)
         VALUES($1,'00000000000000000000000101','00000000000000000000000102',
          '00000000000000000000000103',$2,$3,$3,$3,'cloudflare_workers_edge_ssr',$4,
          '[]','[]','{}','2026-09-30T12:00:00Z','2026-09-30T12:15:00Z',
          '00000000000000000000000104')`,
        [
          `00000000000000000000000${String(sequence++).padStart(3, "0")}`,
          "a".repeat(40),
          Buffer.alloc(32, 1),
          JSON.stringify(plan),
        ],
      );
    try {
      const baselineCount = (await readdir(migrationsDirectory)).filter(
        (name) => /^\d{3}_.+\.mjs$/u.test(name) && Number(name.slice(0, 3)) < 170,
      ).length;
      await runner({ ...options, direction: "up", count: baselineCount });
      // Foreign references are outside this schema regression; CHECK constraints stay active.
      await client.query("SET session_replication_role=replica");
      await insert(legacy);
      const before = (await client.query("SELECT framework_plan FROM deployment_plans")).rows;
      await expect(insert({ ...legacy, ssgCacheMaxBytes: 64 * 1024 * 1024 })).rejects.toMatchObject(
        {
          code: "23514",
          constraint: "deployment_plans_framework_plan_check",
        },
      );
      await runner({ ...options, direction: "up", count: 1 });
      expect((await client.query("SELECT framework_plan FROM deployment_plans")).rows).toEqual(
        before,
      );
      await runner({ ...options, direction: "down", count: 1 });
      await runner({ ...options, direction: "up", count: 1 });
      for (const mib of [1, 32, 64]) {
        await expect(
          insert({ ...legacy, ssgCacheMaxBytes: mib * 1024 * 1024 }),
        ).resolves.toMatchObject({
          rowCount: 1,
        });
      }
      await expect(
        insert({
          ...legacy,
          ssgCacheMaxBytes: 32 * 1024 * 1024,
          functions: { crons: ["*/5 * * * *"] },
        }),
      ).resolves.toMatchObject({ rowCount: 1 });
      for (const value of [null, "33554432", 0, -1, 1024 * 1024 + 1, 65 * 1024 * 1024, {}, []]) {
        await expect(insert({ ...legacy, ssgCacheMaxBytes: value })).rejects.toMatchObject({
          code: "23514",
          constraint: "deployment_plans_framework_plan_check",
        });
      }
      const tanstack = {
        ...legacy,
        adapter: "tanstack-start",
        outputDirectory: "dist/client",
        serverOutputDirectory: "dist/server",
        serverEntryPoint: "dist/server/index.js",
        serverConfigPath: "dist/server/wrangler.json",
        compatibilityDate: "2025-04-01",
      };
      await expect(insert(tanstack)).resolves.toMatchObject({ rowCount: 1 });
      for (const plan of [
        { ...tanstack, ssgCacheMaxBytes: 1024 * 1024 },
        { ...legacy, ssgCacheMaxBytes: 1024 * 1024, extra: true },
        { ...legacy, ssgCacheMaxBytes: 1024 * 1024, adapter: null },
        { ...legacy, ssgCacheMaxBytes: 1024 * 1024, runtime: "static" },
      ]) {
        await expect(insert(plan)).rejects.toMatchObject({ code: "23514" });
      }
      await expect(runner({ ...options, direction: "down", count: 1 })).rejects.toThrow(
        "persisted Next cache plans prevent migration downgrade",
      );
      expect(
        (await client.query("SELECT framework_plan FROM deployment_plans ORDER BY plan_id LIMIT 1"))
          .rows,
      ).toEqual(before);
    } finally {
      client.release();
      await pool.end();
      await postgres.stop();
    }
  }, 60_000);

  it("renames populated Paid access sources and restores the append-only guard in both directions", async () => {
    const postgres = await startDisposablePostgres();
    const pool = new Pool({ connectionString: postgres.connectionString, max: 1 });
    const options = {
      databaseUrl: postgres.connectionString,
      dir: migrationsDirectory,
      migrationsTable: "control_db_migrations",
      migrationsSchema: "public",
      schema: "public",
      log: () => undefined,
    };
    try {
      const baselineCount = (await readdir(migrationsDirectory)).filter(
        (name) => /^\d{3}_.+\.mjs$/u.test(name) && Number(name.slice(0, 3)) < 136,
      ).length;
      await runner({ ...options, direction: "up", count: baselineCount });
      expect(
        (await pool.query("SELECT name FROM control_db_migrations ORDER BY id DESC LIMIT 1"))
          .rows[0]?.name,
      ).toBe("135_github_organization_connections");
      await pool.query(`INSERT INTO workos_organization_mappings
        (organization_id,workos_organization_id,state,mapping_revision,snapshot_sha256,snapshot_fetched_at,synchronized_at,updated_at)
        VALUES('00000000000000000000000001','org_paid_source','active',1,decode(repeat('aa',32),'hex'),'2026-09-21','2026-09-21','2026-09-21');
        INSERT INTO organization_paid_access(organization_id,enabled,source,reason,updated_at)
        VALUES('00000000000000000000000001',true,'beta','Existing operator grant','2026-09-21');
        INSERT INTO organization_paid_access_events(event_id,organization_id,enabled,source,reason,actor_id,occurred_at)
        VALUES('00000000000000000000000002','00000000000000000000000001',true,'beta','Existing operator grant','operator:test','2026-09-21'),
        ('00000000000000000000000003','00000000000000000000000001',false,'manual','Manual control','operator:test','2026-09-20');`);
      const original = (
        await pool.query(
          "SELECT to_jsonb(t) data FROM organization_paid_access_events t ORDER BY event_id",
        )
      ).rows;
      await runner({ ...options, direction: "up", count: 1 });
      expect(
        (await pool.query("SELECT enabled,source,revision FROM organization_paid_access")).rows,
      ).toEqual([{ enabled: true, source: "granted", revision: "1" }]);
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(t) data FROM organization_paid_access_events t ORDER BY event_id",
          )
        ).rows,
      ).toEqual(
        original.map(({ data }) => ({
          data: { ...data, source: data.source === "beta" ? "granted" : data.source },
        })),
      );
      await expect(
        pool.query("UPDATE organization_paid_access_events SET reason='unexpected change'"),
      ).rejects.toThrow("append-only");
      await runner({ ...options, direction: "down", count: 1 });
      expect(
        (
          await pool.query(
            "SELECT to_jsonb(t) data FROM organization_paid_access_events t ORDER BY event_id",
          )
        ).rows,
      ).toEqual(original);
      expect(
        (await pool.query("SELECT enabled,source,revision FROM organization_paid_access")).rows,
      ).toEqual([{ enabled: true, source: "beta", revision: "1" }]);
      await expect(pool.query("DELETE FROM organization_paid_access_events")).rejects.toThrow(
        "append-only",
      );
      expect(
        (
          await pool.query(
            "SELECT tgenabled FROM pg_trigger WHERE tgname='organization_paid_access_events_append_only'",
          )
        ).rows,
      ).toEqual([{ tgenabled: "O" }]);
    } finally {
      await pool.end();
      await postgres.stop();
    }
  }, 60_000);

  it("uses the exact node-pg-migrate 9 config-file option and ledger keys", async () => {
    const configUrl = pathToFileURL(resolve(packageDirectory, "node-pg-migrate.config.mjs")).href;
    const configModule = (await import(configUrl)) as {
      readonly default: Readonly<Record<string, unknown>>;
    };
    const config = configModule.default;
    const packageJson = JSON.parse(
      await readFile(resolve(packageDirectory, "package.json"), "utf8"),
    ) as { readonly scripts?: Readonly<Record<string, unknown>> };

    expect(config).toEqual({
      "migrations-dir": "migrations",
      "migrations-schema": "public",
      "migrations-table": "control_db_migrations",
      schema: ["public"],
    });
    expect(packageJson.scripts?.["migrate"]).toBe(
      "node-pg-migrate --config-file node-pg-migrate.config.mjs",
    );
  });

  it("uses public.control_db_migrations through the real package command", async () => {
    const postgres = await startDisposablePostgres();
    const pool = new Pool({ connectionString: postgres.connectionString, max: 1 });
    try {
      await runner({
        databaseUrl: postgres.connectionString,
        dir: migrationsDirectory,
        direction: "up",
        count: 5,
        migrationsTable: "control_db_migrations",
        migrationsSchema: "public",
        schema: "public",
        log: () => undefined,
      });
      await expect(ledgerState(pool)).resolves.toEqual({ count: "5", accidental: null });

      await runPackageMigration(postgres.connectionString, ["up"]);
      const migrationCount = (await readdir(migrationsDirectory)).filter((name) =>
        /^\d{3}_.+\.mjs$/u.test(name),
      ).length;
      await expect(ledgerState(pool)).resolves.toEqual({
        count: String(migrationCount),
        accidental: null,
      });
      await expect(
        pool.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE connamespace='public'::regnamespace
             AND conname='product_provider_mutation_observations_shape_check'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            definition: expect.stringMatching(/attempt_number.*<= 32.*'database'::text/isu),
          },
        ],
      });
      await expect(
        pool.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE connamespace='public'::regnamespace AND conname='ses_tenant_receipts_shape'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ definition: expect.stringContaining("'unknown'::text") }],
      });
      await expect(
        pool.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE connamespace='public'::regnamespace
             AND conname='product_provider_reconciliation_attempts_shape_check'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            definition: expect.stringMatching(/attempt_number.*<= 32/isu),
          },
        ],
      });
      await expect(
        pool.query<{ relation: string | null }>(
          `SELECT to_regclass('public.product_provider_mutation_claims')::text relation`,
        ),
      ).resolves.toMatchObject({ rows: [{ relation: "product_provider_mutation_claims" }] });
      await expect(
        pool.query<{ column_name: string; reservations: string | null }>(
          `SELECT column_name,
                  to_regclass('public.build_input_reservations')::text reservations
           FROM information_schema.columns
           WHERE table_schema='public' AND table_name='build_receipts'
             AND column_name='input_fingerprint'`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            column_name: "input_fingerprint",
            reservations: "build_input_reservations",
          },
        ],
      });
      await expect(
        pool.query<{ relation: string | null }>(
          "SELECT to_regclass('public.workos_terminal_revocations')::text AS relation",
        ),
      ).resolves.toMatchObject({ rows: [{ relation: "workos_terminal_revocations" }] });

      // Below migration 127 the build tables carry their former provider names.
      await runPackageMigration(postgres.connectionString, ["down", String(migrationCount - 17)]);
      await expect(ledgerState(pool)).resolves.toEqual({ count: "17", accidental: null });
      await expect(
        pool.query<{ relation: string | null }>(
          `SELECT to_regclass('public.product_provider_mutation_claims')::text relation`,
        ),
      ).resolves.toMatchObject({ rows: [{ relation: null }] });
      await expect(
        pool.query<{ column_name: string; reservations: string | null }>(
          `SELECT column_name,
                  to_regclass('public.aws_build_input_reservations')::text reservations
           FROM (VALUES ('input_fingerprint')) expected(column_name)
           WHERE EXISTS (
             SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='aws_build_receipts'
               AND column_name=expected.column_name
           )`,
        ),
      ).resolves.toMatchObject({ rows: [] });
      await expect(
        pool.query<{ reservations: string | null }>(
          `SELECT to_regclass('public.aws_build_input_reservations')::text reservations`,
        ),
      ).resolves.toMatchObject({ rows: [{ reservations: null }] });
      await expect(
        pool.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE connamespace='public'::regnamespace
             AND conname='deployment_plans_framework_plan_check'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ definition: expect.not.stringContaining("schemaVersion") }],
      });

      await runPackageMigration(postgres.connectionString, ["down", "1"]);
      await expect(ledgerState(pool)).resolves.toEqual({ count: "16", accidental: null });
      await expect(
        pool.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE connamespace='public'::regnamespace
             AND conname='deployment_plans_framework_plan_check'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ definition: expect.not.stringContaining("nextjs") }],
      });

      await runPackageMigration(postgres.connectionString, ["down", "1"]);
      await expect(ledgerState(pool)).resolves.toEqual({ count: "15", accidental: null });
      await expect(
        pool.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE connamespace='public'::regnamespace
             AND conname='deployment_plans_framework_plan_check'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ definition: expect.not.stringContaining("tanstack-start") }],
      });

      await runPackageMigration(postgres.connectionString, ["down", "1"]);
      await expect(ledgerState(pool)).resolves.toEqual({ count: "14", accidental: null });
      await expect(
        pool.query<{ state: string | null; receipts: string | null }>(
          `SELECT to_regclass('public.runtime_secret_delivery_states')::text AS state,
                  to_regclass('public.runtime_secret_delivery_receipts')::text AS receipts`,
        ),
      ).resolves.toMatchObject({ rows: [{ state: null, receipts: null }] });
      await expect(
        pool.query<{ relation: string | null }>(
          "SELECT to_regclass('public.environment_secrets')::text AS relation",
        ),
      ).resolves.toMatchObject({ rows: [{ relation: "environment_secrets" }] });

      await runPackageMigration(postgres.connectionString, ["down", "1"]);
      await expect(ledgerState(pool)).resolves.toEqual({ count: "13", accidental: null });
      await expect(
        pool.query<{ relation: string | null }>(
          "SELECT to_regclass('public.environment_secrets')::text AS relation",
        ),
      ).resolves.toMatchObject({ rows: [{ relation: null }] });

      await runPackageMigration(postgres.connectionString, ["down", "1"]);
      await expect(ledgerState(pool)).resolves.toEqual({ count: "12", accidental: null });
      await expect(
        pool.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
           WHERE connamespace='public'::regnamespace AND conname='environments_head_shape_check'`,
        ),
      ).resolves.toMatchObject({
        rows: [{ definition: expect.stringContaining("head_version = 0") }],
      });

      await runPackageMigration(postgres.connectionString, ["down", "1"]);
      await expect(ledgerState(pool)).resolves.toEqual({ count: "11", accidental: null });
      await expect(
        pool.query<{ relation: string | null }>(
          "SELECT to_regclass('public.wfp_publish_receipts_provider_tag_idx')::text AS relation",
        ),
      ).resolves.toMatchObject({ rows: [{ relation: null }] });

      await runPackageMigration(postgres.connectionString, ["up"]);
      await expect(ledgerState(pool)).resolves.toEqual({
        count: String(migrationCount),
        accidental: null,
      });
      await expect(
        pool.query<{ state: string | null; receipts: string | null }>(
          `SELECT to_regclass('public.runtime_secret_delivery_states')::text AS state,
                  to_regclass('public.runtime_secret_delivery_receipts')::text AS receipts`,
        ),
      ).resolves.toMatchObject({
        rows: [
          {
            state: "runtime_secret_delivery_states",
            receipts: "runtime_secret_delivery_receipts",
          },
        ],
      });
    } finally {
      await pool.end();
      await postgres.stop();
    }
  }, 60_000);
});

async function ledgerState(pool: Pool): Promise<{ count: string; accidental: string | null }> {
  const result = await pool.query<{ count: string; accidental: string | null }>(
    `SELECT (SELECT count(*)::text FROM public.control_db_migrations) AS count,
            to_regclass('public.pgmigrations')::text AS accidental`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Migration ledger state is absent");
  return row;
}

async function runPackageMigration(
  connectionString: string,
  args: readonly string[],
): Promise<void> {
  await executeFile("pnpm", ["--filter", "@ohmyhost/database", "migrate", ...args], {
    cwd: repositoryDirectory,
    env: { ...process.env, DATABASE_URL: connectionString },
    maxBuffer: 10 * 1024 * 1024,
  });
}

async function startDisposablePostgres(): Promise<{
  readonly connectionString: string;
  stop(): Promise<void>;
}> {
  const directory = await mkdtemp(resolve(tmpdir(), "ohmyhost-migration-cli-postgres-"));
  const dataDirectory = resolve(directory, "data");
  let started = false;
  try {
    const port = await availablePort();
    const connectionString = `postgresql://postgres@127.0.0.1:${String(port)}/postgres`;
    await executeFile("initdb", ["-D", dataDirectory, "-A", "trust", "-U", "postgres"]);
    await executeFile("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      resolve(directory, "postgres.log"),
      "-o",
      `-F -p ${String(port)} -h 127.0.0.1 -k ''`,
      "-w",
      "start",
    ]);
    started = true;
    return {
      connectionString,
      async stop() {
        await executeFile("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (started) {
      await executeFile("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
    }
    await rm(directory, { recursive: true, force: true });
    throw new Error("Migration CLI regression requires a disposable local PostgreSQL", {
      cause: error,
    });
  }
}

async function availablePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a PostgreSQL test port"));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else reject(error);
      });
    });
  });
}
