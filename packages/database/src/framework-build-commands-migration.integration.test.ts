import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const ids = {
  organization: "01H00000000000000000000101",
  project: "01H00000000000000000000102",
  event: "01H00000000000000000000103",
  epoch: "01H00000000000000000000104",
  source: "01H00000000000000000000105",
  grant: "01H00000000000000000000106",
  oldPlan: "01H00000000000000000000107",
} as const;
const commandPairs = [
  ["bun install --frozen-lockfile --ignore-scripts", "bun run build"],
  ["npm ci --ignore-scripts", "npm run build"],
  ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm run build"],
  ["yarn install --immutable --mode=skip-build", "yarn run build"],
] as const;

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
let pool: Pool;

beforeAll(async () => {
  postgres = await startTestPostgres();
  pool = new Pool({
    connectionString: postgres.connectionString,
    options: `-c search_path=${postgres.schema}`,
  });
  await migrate(55);
  await seedProject();
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await postgres?.stop();
}, 60_000);

describe("portable framework build command cutover", () => {
  it("fails before schema mutation when a persisted old command row exists", async () => {
    await insertPlan(ids.oldPlan, edgePlan("pnpm install --frozen-lockfile", "pnpm build"));

    await expect(migrate(56)).rejects.toThrow(
      "persisted framework plan uses unsupported build commands",
    );
    await expect(
      pool.query("SELECT plan_id FROM deployment_plans WHERE plan_id=$1", [ids.oldPlan]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      pool.query<{ function_name: string | null }>(
        "SELECT to_regprocedure('valid_framework_build_commands(jsonb)')::text AS function_name",
      ),
    ).resolves.toMatchObject({ rows: [{ function_name: null }] });
  });

  it("installs a validated immutable predicate and accepts only exact secure pairs", async () => {
    await resetDatabase();
    await expect(migrate(56)).resolves.toBeUndefined();

    const requiredMajor = process.env["OHMYHOST_TEST_POSTGRES_MAJOR"];
    if (requiredMajor !== undefined) {
      await expect(
        pool.query<{ major: number }>(
          "SELECT current_setting('server_version_num')::int / 10000 AS major",
        ),
      ).resolves.toMatchObject({ rows: [{ major: Number.parseInt(requiredMajor, 10) }] });
    }

    await expect(
      pool.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint
         WHERE conname='deployment_plans_framework_plan_check'
           AND conrelid='deployment_plans'::regclass`,
      ),
    ).resolves.toMatchObject({ rows: [{ convalidated: true }] });
    await expect(
      pool.query<{ provolatile: string; proparallel: string }>(
        `SELECT provolatile,proparallel FROM pg_proc
         WHERE oid='valid_framework_build_commands(jsonb)'::regprocedure`,
      ),
    ).resolves.toMatchObject({ rows: [{ provolatile: "i", proparallel: "s" }] });

    for (const [index, [installCommand, buildCommand]] of commandPairs.entries()) {
      await expect(
        insertPlan(planId(index + 1), edgePlan(installCommand, buildCommand)),
      ).resolves.toMatchObject({ rowCount: 1 });
    }
    await expect(
      insertPlan(planId(20), staticPlan(...commandPairs[0]), "workers-static-v1"),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(insertPlan(planId(21), tanStackPlan(...commandPairs[1]))).resolves.toMatchObject({
      rowCount: 1,
    });
    await expect(insertPlan(planId(22), nextPlan(...commandPairs[2]))).resolves.toMatchObject({
      rowCount: 1,
    });

    for (const [index, [installCommand, buildCommand]] of (
      [
        ["npm ci --ignore-scripts", "pnpm run build"],
        ["pnpm install --frozen-lockfile", "pnpm build"],
        ["yarn install --immutable --mode=skip-builds", "yarn run build"],
        [
          "pnpm install --frozen-lockfile --ignore-scripts && curl https://evil.invalid",
          "pnpm run build",
        ],
      ] as const
    ).entries()) {
      await expect(
        insertPlan(planId(index + 10), edgePlan(installCommand, buildCommand)),
      ).rejects.toMatchObject({ code: "23514" });
    }

    await expect(migrateDownOne()).rejects.toThrow(
      "portable framework build commands prevent migration downgrade",
    );
    await expect(
      pool.query("SELECT plan_id FROM deployment_plans WHERE plan_id=$1", [planId(1)]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

async function resetDatabase(): Promise<void> {
  await pool.end();
  await postgres.stop();
  postgres = await startTestPostgres();
  pool = new Pool({
    connectionString: postgres.connectionString,
    options: `-c search_path=${postgres.schema}`,
  });
  await migrate(55);
  await seedProject();
}

async function seedProject(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO projects(project_id,created_organization_id,name,created_event_id,created_at)
       VALUES($1,$2,'framework-command-cutover',$3,'2026-08-25T09:00:00Z')`,
      [ids.project, ids.organization, ids.event],
    );
    await client.query(
      `INSERT INTO billing_epochs(
         billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)
       VALUES($1,$2,$3,'2026-08-25T09:00:00Z','user:test')`,
      [ids.epoch, ids.project, ids.organization],
    );
    await client.query(
      `INSERT INTO project_ownerships(
         project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)
       VALUES($1,$2,'active',1,$3,'2026-08-25T09:00:00Z')`,
      [ids.project, ids.organization, ids.epoch],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    `INSERT INTO github_source_connections(
       source_connection_id,organization_id,project_id,billing_epoch_id,provider,
       external_repository_id,created_at)
     VALUES($1,$2,$3,$4,'github','1339976528','2026-08-25T09:00:00Z')`,
    [ids.source, ids.organization, ids.project, ids.epoch],
  );
  await pool.query(
    `INSERT INTO repository_grants(
       grant_id,organization_id,project_id,source_connection_id,billing_epoch_id,provider,
       github_installation_id,external_repository_id,repository_owner,repository_name,
       permission,granted_at)
     VALUES($1,$2,$3,$4,$5,'github','154436098','1339976528','aixyte','trakkker',
       'contents:read','2026-08-25T09:00:00Z')`,
    [ids.grant, ids.organization, ids.project, ids.source, ids.epoch],
  );
}

async function insertPlan(
  planIdValue: string,
  frameworkPlan: unknown,
  runtime = "cloudflare_workers_edge_ssr",
) {
  return await pool.query(
    `INSERT INTO deployment_plans(
       plan_id,organization_id,project_id,source_connection_id,commit_sha,source_sha256,
       build_plan_sha256,runtime,impacts,risks,cost_estimate,created_at,expires_at,
       plan_sha256,framework_plan)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'[]','[]','{}',
       '2026-08-25T09:00:00Z','2026-08-25T09:15:00Z',$9,$10)`,
    [
      planIdValue,
      ids.organization,
      ids.project,
      ids.source,
      "a".repeat(40),
      Buffer.alloc(32, 0x11),
      Buffer.alloc(32, 0x22),
      runtime,
      Buffer.alloc(32, 0x33),
      JSON.stringify(frameworkPlan),
    ],
  );
}

function staticPlan(installCommand: string, buildCommand: string) {
  return {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "vite-static",
    runtime: "static",
    installCommand,
    buildCommand,
    outputDirectory: "dist",
    runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  };
}

function tanStackPlan(installCommand: string, buildCommand: string) {
  return {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "tanstack-start",
    runtime: "edge",
    installCommand,
    buildCommand,
    outputDirectory: "dist/client",
    serverOutputDirectory: "dist/server",
    serverEntryPoint: "dist/server/index.js",
    serverConfigPath: "dist/server/wrangler.json",
    compatibilityDate: "2026-08-25",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  };
}

function nextPlan(installCommand: string, buildCommand: string) {
  return {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "nextjs",
    runtime: "edge",
    installCommand,
    buildCommand,
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
}

function edgePlan(installCommand: string, buildCommand: string) {
  return {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "vite-static",
    runtime: "edge",
    installCommand,
    buildCommand,
    outputDirectory: "dist",
    serverOutputDirectory: ".ohmyhost/vite-companion",
    serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
    serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy: { healthCheckPath: "/api/health", egressAllowedOrigins: [] },
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
    functions: {
      delivery: "at-least-once",
      timeoutSeconds: 120,
      maxAttempts: 3,
      scheduled: [],
    },
  };
}

function planId(offset: number): string {
  return `01H00000000000000000000${String(offset).padStart(3, "0")}`;
}

async function migrate(target: number): Promise<void> {
  const selectedDirectory = await mkdtemp(resolve(tmpdir(), "ohmyhost-command-migrations-"));
  try {
    for (const file of await readdir(migrationsDirectory)) {
      const prefix = Number.parseInt(file.slice(0, 3), 10);
      if (Number.isSafeInteger(prefix) && prefix <= target) {
        await copyFile(resolve(migrationsDirectory, file), resolve(selectedDirectory, file));
      }
    }
    await runner({
      databaseUrl: postgres.connectionString,
      dir: selectedDirectory,
      direction: "up",
      schema: postgres.schema,
      migrationsSchema: postgres.schema,
      migrationsTable: "control_db_migrations",
      log: () => undefined,
    });
  } finally {
    await rm(selectedDirectory, { recursive: true, force: true });
  }
}

async function migrateDownOne(): Promise<void> {
  await runner({
    databaseUrl: postgres.connectionString,
    dir: migrationsDirectory,
    direction: "down",
    count: 1,
    schema: postgres.schema,
    migrationsSchema: postgres.schema,
    migrationsTable: "control_db_migrations",
    log: () => undefined,
  });
}

async function startTestPostgres(): Promise<{
  connectionString: string;
  schema: string;
  stop(): Promise<void>;
}> {
  const directory = await mkdtemp(resolve(tmpdir(), "ohmyhost-framework-command-cutover-"));
  const dataDirectory = resolve(directory, "data");
  const port = await freePort();
  const connectionString = `postgresql://postgres@127.0.0.1:${String(port)}/postgres`;
  try {
    await executeFile("initdb", ["-D", dataDirectory, "-A", "trust", "-U", "postgres"]);
    await executeFile("pg_ctl", [
      "-D",
      dataDirectory,
      "-l",
      resolve(directory, "postgres.log"),
      "-o",
      `-p ${String(port)} -h 127.0.0.1 -k ''`,
      "start",
    ]);
    const schema = `framework_commands_${process.pid}_${Date.now()}`;
    const admin = new Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    return {
      connectionString,
      schema,
      stop: async () => {
        await executeFile("pg_ctl", ["-D", dataDirectory, "stop", "-m", "fast"]);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate PostgreSQL test port"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}
