import { Buffer } from "node:buffer";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { URL, fileURLToPath } from "node:url";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { testPostgresEnvironment } from "../../scripts/test-postgres-path.mjs";
import {
  capture,
  openCapture,
  openLocalTarget,
  targetPin,
  buildPlan,
  importPlan,
} from "../../scripts/control-d1-migration.mjs";
import { schemaFingerprint, splitSql } from "../../scripts/control-d1-target.mjs";
import { canonical, sha256 } from "../../scripts/control-d1-codec.mjs";

const require = createRequire(new URL("../../packages/database/package.json", import.meta.url));
const { Pool, Client } = require("pg"),
  { runner } = require("node-pg-migrate"),
  execute = promisify(execFile);
export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Exact disposable prior Core SQL, for populated forward-migration evidence; never activated. */
export async function coreFixtureThrough(last) {
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script: "export default {fetch(){return new Response('unserved',{status:503})}}",
      d1Databases: { CONTROL_CORE: "prior-core" },
    }),
  });
  try {
    const db = await runtime.getD1Database("CONTROL_CORE"),
      pin = await targetPin(repositoryRoot);
    pin.migrations = pin.migrations.filter((entry) => entry.name <= last);
    for (const entry of pin.migrations) {
      const sql = await readFile(
        join(repositoryRoot, "apps/control-store/migrations/core", entry.name),
        "utf8",
      );
      await db.batch(splitSql(sql).map((statement) => db.prepare(statement)));
    }
    const schema = await schemaFingerprint(db);
    await db
      .prepare(
        "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES('control-d1.schema:v1','control-d1.schema',?,?,0)",
      )
      .bind(sha256(Buffer.from(canonical(pin))), canonical({ schemaSha256: schema }))
      .run();
    return { db, pin, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/** Isolated PG18 only: never reads TEST_DATABASE_URL or opens an ambient database connection. */
export async function originalControlFixture(label) {
  let environment = testPostgresEnvironment(),
    started = false,
    pool,
    client,
    local;
  const directory = await mkdtemp(join(tmpdir(), `omh-control-${label}-`)),
    data = join(directory, "pg"),
    key = randomBytes(32);
  await chmod(directory, 0o700);
  const dispose = async () => {
    await local?.dispose();
    await client?.end();
    await pool?.end();
    if (started)
      await execute("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], {
        env: environment,
      }).catch(() => {});
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    await execute("initdb", ["-D", data, "-A", "trust", "-U", "postgres"], { env: environment });
    await execute(
      "pg_ctl",
      [
        "-D",
        data,
        "-l",
        join(directory, "pg.log"),
        "-o",
        `-F -p ${port} -h 127.0.0.1 -k ''`,
        "-w",
        "start",
      ],
      { env: environment },
    );
    started = true;
    const uri = `postgresql://postgres@127.0.0.1:${port}/postgres`;
    await runner({
      databaseUrl: uri,
      dir: join(repositoryRoot, "packages/database/migrations"),
      direction: "up",
      migrationsTable: "control_db_migrations",
      schema: "public",
      migrationsSchema: "public",
      log: () => {},
    });
    pool = new Pool({ connectionString: uri, max: 2 });
    client = new Client({ connectionString: uri });
    await client.connect();
    environment = {
      ...environment,
      PGHOST: "127.0.0.1",
      PGPORT: String(port),
      PGUSER: "postgres",
      PGDATABASE: "postgres",
    };
    local = await openLocalTarget({ repositoryRoot });
    return {
      directory,
      pool,
      client,
      db: local.db,
      key,
      dispose,
      async image(name) {
        const pin = await targetPin(repositoryRoot),
          output = join(directory, name);
        await capture({
          client,
          expectedSource: { role: "postgres", database: "postgres" },
          targetPin: pin,
          output,
          key,
          dump: async ({ snapshot, schema }) =>
            (
              await execute(
                "pg_dump",
                ["--format=custom", `--snapshot=${snapshot}`, `--schema=${schema}`],
                { env: environment, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
              )
            ).stdout,
        });
        return openCapture({ directory: output, key });
      },
      async import(image, name) {
        const plan = buildPlan(image, image.manifest.targetPin, {
          role: "postgres",
          database: "postgres",
        });
        let failure;
        const observed = {
          prepare: (sql) => local.db.prepare(sql),
          batch: async (statements) => {
            try {
              return await local.db.batch(statements);
            } catch (error) {
              failure = error;
              throw error;
            }
          },
        };
        try {
          await importPlan({
            db: observed,
            plan,
            targetId: name,
            key,
            journal: join(directory, `${name}.journal`),
            currentPin: image.manifest.targetPin,
          });
        } catch (error) {
          throw new AggregateError(
            [error, ...(failure ? [failure] : [])],
            "Local conversion fixture import failed",
          );
        }
        return plan;
      },
      async activate(scope) {
        const runtime = await schemaFingerprint(local.db),
          proof = sha256(Buffer.from(canonical({ scope: `LOCAL-TEST-ONLY:${scope}`, runtime }))),
          now = new Date().toISOString().replace(/Z$/u, "000Z"),
          binary = (value) => Uint8Array.from(Buffer.from(value, "hex"));
        const context = await local.db
          .prepare("SELECT import_id FROM core_historical_import WHERE singleton=1")
          .first();
        if (context)
          await local.db
            .prepare(
              "UPDATE core_historical_import SET closed_at=?,comparison_sha256=?,restored_runtime_schema_sha256=? WHERE singleton=1",
            )
            .bind(now, binary(proof), binary(runtime))
            .run();
        await local.db
          .prepare(
            "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,import_id,qualification_sha256,runtime_schema_sha256) VALUES(1,?,?,?,?,?)",
          )
          .bind(randomUUID(), now, context?.import_id ?? null, binary(proof), binary(runtime))
          .run();
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
