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
  organization: "01H00000000000000000000201",
  project: "01H00000000000000000000202",
  event: "01H00000000000000000000203",
  epoch: "01H00000000000000000000204",
  source: "01H00000000000000000000205",
  grant: "01H00000000000000000000206",
  oldPlan: "01H00000000000000000000207",
  nonePlan: "01H00000000000000000000208",
  newPlan: "01H00000000000000000000209",
  rejectedPlan: "01H00000000000000000000210",
  forgedPlan: "01H00000000000000000000211",
} as const;

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
let pool: Pool;

beforeAll(async () => {
  await resetDatabase();
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await postgres?.stop();
}, 60_000);

describe("customer database binding cutover", () => {
  it("rewrites Better Auth plans, preserves exact no-auth plans, and enforces the new binding", async () => {
    await insertPlan(ids.oldPlan, betterAuthPlan("HYPERDRIVE"));
    await insertPlan(ids.nonePlan, noAuthPlan());

    await expect(migrate(57)).resolves.toBeUndefined();

    const requiredVersion = process.env["OHMYHOST_TEST_POSTGRES_VERSION"];
    if (requiredVersion !== undefined) {
      const version = await pool.query<{ version: string }>(
        "SELECT current_setting('server_version') AS version",
      );
      expect(version.rows[0]?.version).toMatch(new RegExp(`^${requiredVersion}(?:\\s|$)`, "u"));
    }

    await expect(readAuth(ids.oldPlan)).resolves.toEqual({
      provider: "better-auth",
      version: "1.7.1",
      deployment: "companion",
      routePath: "/api/auth",
      databaseSchema: "auth",
      databaseBindingName: "OHMYHOST_DATABASE",
      authSecretName: "BETTER_AUTH_SECRET",
    });
    await expect(readAuth(ids.nonePlan)).resolves.toEqual({ provider: "none" });
    await expect(
      pool.query<{ valid: boolean }>(
        `SELECT bool_and(valid_customer_auth_requirement(framework_plan->'auth')) AS valid
         FROM deployment_plans WHERE framework_plan IS NOT NULL`,
      ),
    ).resolves.toMatchObject({ rows: [{ valid: true }] });
    await expect(
      pool.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint
         WHERE conname='deployment_plans_framework_plan_check'
           AND conrelid='deployment_plans'::regclass`,
      ),
    ).resolves.toMatchObject({ rows: [{ convalidated: true }] });

    await expect(insertPlan(ids.rejectedPlan, betterAuthPlan("HYPERDRIVE"))).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      insertPlan(ids.newPlan, betterAuthPlan("OHMYHOST_DATABASE")),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(migrateDownOne()).rejects.toThrow(
      "customer database binding cutover cannot restore live HYPERDRIVE plans",
    );
    await expect(
      pool.query("SELECT name FROM control_db_migrations WHERE name=$1", [
        "057_customer_database_binding",
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(readAuth(ids.newPlan)).resolves.toMatchObject({
      databaseBindingName: "OHMYHOST_DATABASE",
    });
  });

  it("aborts before partial mutation when any persisted auth requirement is forged", async () => {
    await resetDatabase();
    await insertPlan(ids.oldPlan, betterAuthPlan("HYPERDRIVE"));
    await insertPlan(ids.nonePlan, noAuthPlan());
    await pool.query(
      "ALTER TABLE deployment_plans DROP CONSTRAINT deployment_plans_framework_plan_check",
    );
    await pool.query(
      "ALTER TABLE deployment_plans DISABLE TRIGGER deployment_plans_framework_plan_insert_v5",
    );
    await insertPlan(ids.forgedPlan, betterAuthPlan("FORGED_DATABASE"));
    await pool.query(
      "ALTER TABLE deployment_plans ENABLE TRIGGER deployment_plans_framework_plan_insert_v5",
    );
    await pool.query(
      `ALTER TABLE deployment_plans ADD CONSTRAINT deployment_plans_framework_plan_check
       CHECK (true)`,
    );

    await expect(migrate(57)).rejects.toThrow(
      "persisted customer auth plan is not canonical for database binding cutover",
    );

    await expect(readAuth(ids.oldPlan)).resolves.toMatchObject({
      databaseBindingName: "HYPERDRIVE",
    });
    await expect(readAuth(ids.nonePlan)).resolves.toEqual({ provider: "none" });
    await expect(readAuth(ids.forgedPlan)).resolves.toMatchObject({
      databaseBindingName: "FORGED_DATABASE",
    });
    await expect(
      pool.query<{ old_valid: boolean; new_valid: boolean }>(
        `SELECT
          valid_customer_auth_requirement($1::jsonb) AS old_valid,
          valid_customer_auth_requirement($2::jsonb) AS new_valid`,
        [
          JSON.stringify(betterAuthRequirement("HYPERDRIVE")),
          JSON.stringify(betterAuthRequirement("OHMYHOST_DATABASE")),
        ],
      ),
    ).resolves.toMatchObject({ rows: [{ old_valid: true, new_valid: false }] });
    await expect(
      pool.query("SELECT name FROM control_db_migrations WHERE name LIKE '057_%'"),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
});

async function resetDatabase(): Promise<void> {
  await pool?.end();
  await postgres?.stop();
  postgres = await startTestPostgres();
  pool = new Pool({
    connectionString: postgres.connectionString,
    options: `-c search_path=${postgres.schema}`,
  });
  await migrate(56);
  await seedProject();
}

async function seedProject(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO projects(project_id,created_organization_id,name,created_event_id,created_at)
       VALUES($1,$2,'database-binding-cutover',$3,'2026-08-25T10:00:00Z')`,
      [ids.project, ids.organization, ids.event],
    );
    await client.query(
      `INSERT INTO billing_epochs(
         billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)
       VALUES($1,$2,$3,'2026-08-25T10:00:00Z','user:test')`,
      [ids.epoch, ids.project, ids.organization],
    );
    await client.query(
      `INSERT INTO project_ownerships(
         project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)
       VALUES($1,$2,'active',1,$3,'2026-08-25T10:00:00Z')`,
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
     VALUES($1,$2,$3,$4,'github','1339976528','2026-08-25T10:00:00Z')`,
    [ids.source, ids.organization, ids.project, ids.epoch],
  );
  await pool.query(
    `INSERT INTO repository_grants(
       grant_id,organization_id,project_id,source_connection_id,billing_epoch_id,provider,
       github_installation_id,external_repository_id,repository_owner,repository_name,
       permission,granted_at)
     VALUES($1,$2,$3,$4,$5,'github','154436098','1339976528','aixyte','trakkker',
       'contents:read','2026-08-25T10:00:00Z')`,
    [ids.grant, ids.organization, ids.project, ids.source, ids.epoch],
  );
}

async function insertPlan(planId: string, frameworkPlan: unknown) {
  return await pool.query(
    `INSERT INTO deployment_plans(
       plan_id,organization_id,project_id,source_connection_id,commit_sha,source_sha256,
       build_plan_sha256,runtime,impacts,risks,cost_estimate,created_at,expires_at,
       plan_sha256,framework_plan)
     VALUES($1,$2,$3,$4,$5,$6,$7,'cloudflare_workers_edge_ssr','[]','[]','{}',
       '2026-08-25T10:00:00Z','2026-08-25T10:15:00Z',$8,$9)`,
    [
      planId,
      ids.organization,
      ids.project,
      ids.source,
      "b".repeat(40),
      Buffer.alloc(32, 0x41),
      Buffer.alloc(32, 0x42),
      Buffer.alloc(32, 0x43),
      JSON.stringify(frameworkPlan),
    ],
  );
}

async function readAuth(planId: string): Promise<Record<string, unknown>> {
  const result = await pool.query<{ auth: Record<string, unknown> }>(
    "SELECT framework_plan->'auth' AS auth FROM deployment_plans WHERE plan_id=$1",
    [planId],
  );
  if (result.rows[0] === undefined) {
    throw new Error(`Missing deployment plan ${planId}`);
  }
  return result.rows[0].auth;
}

function betterAuthRequirement(databaseBindingName: string) {
  return {
    provider: "better-auth",
    version: "1.7.1",
    deployment: "companion",
    routePath: "/api/auth",
    databaseSchema: "auth",
    databaseBindingName,
    authSecretName: "BETTER_AUTH_SECRET",
  };
}

function betterAuthPlan(databaseBindingName: string) {
  return frameworkPlan(
    { enabled: true, migrations: "migrations" },
    betterAuthRequirement(databaseBindingName),
  );
}

function noAuthPlan() {
  return frameworkPlan({ enabled: false }, { provider: "none" });
}

function frameworkPlan(database: unknown, auth: unknown) {
  return {
    schemaVersion: "ohmyhost.framework-plan/v5",
    applicationRoot: ".",
    adapter: "vite-static",
    runtime: "edge",
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputDirectory: "dist",
    serverOutputDirectory: ".ohmyhost/vite-companion",
    serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
    serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
    compatibilityDate: "2025-01-01",
    compatibilityFlags: ["nodejs_compat"],
    runtimePolicy: { healthCheckPath: "/api/health", egressAllowedOrigins: [] },
    database,
    auth,
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

async function migrate(target: number): Promise<void> {
  const selectedDirectory = await mkdtemp(resolve(tmpdir(), "ohmyhost-binding-migrations-"));
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
  const directory = await mkdtemp(resolve(tmpdir(), "ohmyhost-database-binding-cutover-"));
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
    const schema = `database_binding_${process.pid}_${Date.now()}`;
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
