import process from "node:process";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationsThrough } from "../../../apps/control-api/test/postgres.js";
import { frameworkConstraint } from "../migrations/181_astro_framework_plan.mjs";
const executeFile = promisify(execFile);
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
let postgres;
let pool;
beforeAll(async () => {
  postgres = await startTestPostgres();
  pool = new Pool({
    connectionString: postgres.connectionString,
    options: `-c search_path=${postgres.schema}`,
  });
  await runner({
    databaseUrl: postgres.connectionString,
    dir: migrationsDirectory,
    direction: "up",
    schema: postgres.schema,
    migrationsSchema: postgres.schema,
    migrationsTable: "control_db_migrations",
    log: () => undefined,
  });
}, 60000);
afterAll(async () => {
  await pool?.end();
  await postgres?.stop();
}, 60000);
const base = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: ".",
  adapter: "astro",
  runtime: "static",
  installCommand: "npm ci --ignore-scripts",
  buildCommand: "npm run build",
  outputDirectory: "dist",
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
};
const edge = {
  ...base,
  runtime: "edge",
  outputDirectory: "dist/client",
  serverOutputDirectory: "dist/server",
  serverEntryPoint: "dist/server/entry.mjs",
  serverConfigPath: "dist/server/wrangler.json",
  compatibilityDate: "2026-10-12",
  compatibilityFlags: ["nodejs_compat"],
};
async function admits(plan) {
  const result = await pool.query(
    `SELECT (${frameworkConstraint}) IS NOT FALSE AS accepted FROM (SELECT $1::jsonb AS framework_plan, 'cloudflare_workers_edge_ssr'::text AS runtime) candidate`,
    [JSON.stringify(plan)],
  );
  return result.rows[0]?.accepted;
}
describe("Astro persisted plan constraint", () => {
  it("accepts strict static and SSR plans while retaining existing Vite admission", async () => {
    expect(await admits(base)).toBe(true);
    expect(await admits(edge)).toBe(true);
    expect(await admits({ ...base, adapter: "vite-static" })).toBe(true);
  });
  it("fails closed for missing and null entrypoints, stale dates and unsupported static capabilities", async () => {
    for (const field of [
      "serverEntryPoint",
      "compatibilityDate",
      "serverConfigPath",
      "compatibilityFlags",
    ]) {
      const missing = { ...edge };
      Reflect.deleteProperty(missing, field);
      expect(await admits(missing), field).toBe(false);
      expect(await admits({ ...edge, [field]: null }), `${field} null`).toBe(false);
    }
    for (const change of [
      { compatibilityDate: "2025-04-01" },
      { serverEntryPoint: "dist/private.mjs" },
      { outputDirectory: "dist" },
      { ssgCacheMaxBytes: 1048576 },
    ])
      expect(await admits({ ...edge, ...change })).toBe(false);
    for (const change of [
      { mail: { enabled: true } },
      { database: { enabled: true, migrations: "migrations" } },
      { storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: false } },
    ])
      expect(await admits({ ...base, ...change })).toBe(false);
  });
  it("installs a validated constraint and restores the previous constraint on an empty downgrade", async () => {
    const result = await pool.query(
      "SELECT convalidated FROM pg_constraint WHERE conname='deployment_plans_framework_plan_check' AND conrelid='deployment_plans'::regclass",
    );
    expect(result.rows[0]?.convalidated).toBe(true);
    await runner({
      databaseUrl: postgres.connectionString,
      dir: migrationsDirectory,
      direction: "down",
      count: await migrationsThrough("181_astro_framework_plan"),
      schema: postgres.schema,
      migrationsSchema: postgres.schema,
      migrationsTable: "control_db_migrations",
      log: () => undefined,
    });
    const old = await pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='deployment_plans_framework_plan_check' AND conrelid='deployment_plans'::regclass",
    );
    expect(old.rows[0]?.definition).not.toContain("astro");
  });
});
async function startTestPostgres() {
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
async function freePort() {
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
