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
  environment: "01H00000000000000000000203",
  operation: "01H00000000000000000000204",
  lease: "01H00000000000000000000205",
  receipt: "01H00000000000000000000206",
} as const;
const removedTables = [
  "container_application_receipts",
  "container_artifact_objects",
  "container_worker_receipts",
  "ecr_image_receipts",
  "oci_assembly_input_reservations",
  "oci_assembly_receipts",
] as const;
const removedColumns = [
  ["deployment_revisions", "runtime_provider"],
  ["deployment_revisions", "container_application_id"],
  ["deployment_revisions", "container_health_status"],
  ["deployment_revisions", "container_health_observed_at"],
  ["product_provider_mutation_observations", "container_state"],
  ["product_provider_mutation_observations", "container_application_id"],
  ["product_provider_mutation_observations", "container_product_deployment_id"],
  ["product_provider_mutation_observations", "container_image_sha256"],
  ["product_provider_mutation_observations", "container_health_status"],
  ["product_provider_mutation_observations", "container_observed_at"],
  ["runtime_secret_delivery_receipts", "runtime_provider"],
  ["runtime_secret_delivery_states", "runtime_provider"],
  ["runtime_secret_delivery_states", "claimed_runtime_provider"],
] as const;

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
let pool: Pool;

beforeAll(async () => {
  postgres = await startTestPostgres();
  pool = new Pool({
    connectionString: postgres.connectionString,
    options: `-c search_path=${postgres.schema}`,
  });
  await migrate(124);
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await postgres?.stop();
}, 60_000);

describe("customer container runtime removal", () => {
  it("refuses to drop recorded container evidence and leaves the schema untouched", async () => {
    await withoutReferentialChecks(async (client) => {
      await client.query(
        `INSERT INTO container_worker_receipts(
           organization_id,project_id,created_operation_id,script_name,module_digest,
           durable_object_namespace_id,created_at)
         VALUES($1,$2,$3,$4,$5,'4b0c8a5e-6f0d-4d52-9a35-1f6f0a6f7b11','2026-09-17T08:00:00Z')`,
        [
          ids.organization,
          ids.project,
          ids.operation,
          `r-${ids.project.toLowerCase()}`,
          Buffer.alloc(32, 0x11),
        ],
      );
    });

    await expect(migrate(125)).rejects.toThrow(
      "customer container runtime evidence prevents its removal",
    );
    await expect(existingTables()).resolves.toEqual([...removedTables]);

    await withoutReferentialChecks(async (client) => {
      await client.query("DELETE FROM container_worker_receipts");
    });
  }, 120_000);

  it("removes the container schema, restores it exactly on the way down and removes it again", async () => {
    await withoutReferentialChecks(seedRuntimeSecretDelivery);
    const before = await schemaSnapshot();
    expect(JSON.stringify(before)).toMatch(/container_application_receipts/u);

    await migrate(125);
    await expect(existingTables()).resolves.toEqual([]);
    await expect(existingColumns()).resolves.toEqual([]);
    expect(JSON.stringify(await schemaSnapshot())).not.toMatch(/container|oci_|ecr_/iu);
    await expect(
      pool.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name='deployment_revisions'
           AND column_name='wfp_receipt_id'`,
      ),
    ).resolves.toMatchObject({ rows: [{ is_nullable: "NO" }] });
    await expect(
      pool.query(
        `SELECT state.applied_release_sequence::int AS applied,
                state.claimed_release_sequence::int AS claimed,
                receipt.release_sequence::int AS released
         FROM runtime_secret_delivery_states state
         INNER JOIN runtime_secret_delivery_receipts receipt USING (environment_id)`,
      ),
    ).resolves.toMatchObject({ rows: [{ applied: 1, claimed: 2, released: 1 }] });

    await migrateDownOne();
    await expect(existingTables()).resolves.toEqual([...removedTables]);
    await expect(existingColumns()).resolves.toEqual(
      removedColumns.map(([table, column]) => `${table}.${column}`).sort(),
    );
    await expect(schemaSnapshot()).resolves.toEqual(before);
    await expect(
      pool.query(
        `SELECT state.runtime_provider,state.claimed_runtime_provider,
                receipt.runtime_provider AS receipt_runtime_provider
         FROM runtime_secret_delivery_states state
         INNER JOIN runtime_secret_delivery_receipts receipt USING (environment_id)`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          runtime_provider: "wfp",
          claimed_runtime_provider: "wfp",
          receipt_runtime_provider: "wfp",
        },
      ],
    });

    await migrate(125);
    await expect(existingTables()).resolves.toEqual([]);
    await expect(existingColumns()).resolves.toEqual([]);
  }, 120_000);
});

/** Parent rows are irrelevant here, so foreign keys and append-only triggers stay out of the way. */
async function withoutReferentialChecks(
  work: (client: {
    query(sql: string, values?: readonly unknown[]): Promise<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SET session_replication_role=replica");
    await work({ query: async (sql, values) => await client.query(sql, values as unknown[]) });
  } finally {
    await client.query("SET session_replication_role=origin");
    client.release();
  }
}

async function seedRuntimeSecretDelivery(client: {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}): Promise<void> {
  // The downgrade backfills the delivery state, which re-checks its environment reference.
  await client.query(
    `INSERT INTO environments(
       organization_id,environment_id,project_id,name,desired_state,created_at,updated_at)
     VALUES($1,$2,$3,'prod','{}','2026-09-17T07:00:00Z','2026-09-17T07:00:00Z')`,
    [ids.organization, ids.environment, ids.project],
  );
  await client.query(
    `INSERT INTO runtime_secret_delivery_states(
       organization_id,project_id,environment_id,desired_generation,applied_generation,
       active_lease_id,claimed_generation,claimed_trigger,claimed_at,lease_expires_at,
       provider_tag,applied_secret_names,applied_manifest_sha256,applied_secret_count,
       created_at,updated_at,runtime_provider,claimed_runtime_provider,
       next_release_sequence,claimed_release_sequence,applied_release_sequence)
     VALUES($1,$2,$3,2,1,$4,2,'deploy','2026-09-17T08:00:00Z','2026-09-17T08:05:00Z',
       'secrets-generation-1',ARRAY['API_TOKEN'],$5,1,
       '2026-09-17T07:00:00Z','2026-09-17T08:00:00Z','wfp','wfp',3,2,1)`,
    [ids.organization, ids.project, ids.environment, ids.lease, Buffer.alloc(32, 0x22)],
  );
  await client.query(
    `INSERT INTO runtime_secret_delivery_receipts(
       receipt_id,organization_id,project_id,environment_id,lease_id,generation,trigger,
       provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,completed_at,
       runtime_provider,release_sequence)
     VALUES($1,$2,$3,$4,$5,1,'deploy','secrets-generation-1',ARRAY['API_TOKEN'],$6,1,
       '2026-09-17T07:30:00Z','wfp',1)`,
    [
      ids.receipt,
      ids.organization,
      ids.project,
      ids.environment,
      ids.operation,
      Buffer.alloc(32, 0x22),
    ],
  );
}

async function existingTables(): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name`,
    [[...removedTables]],
  );
  return result.rows.map((row) => row.table_name);
}

async function existingColumns(): Promise<string[]> {
  const result = await pool.query<{ name: string }>(
    `SELECT table_name||'.'||column_name AS name FROM information_schema.columns
     WHERE table_schema=current_schema() AND table_name||'.'||column_name=ANY($1::text[])
     ORDER BY name`,
    [removedColumns.map(([table, column]) => `${table}.${column}`)],
  );
  return result.rows.map((row) => row.name);
}

/**
 * Every column, constraint, index, trigger and function of the schema. Column positions are
 * left out on purpose: a re-added column is appended, which no statement depends on.
 */
async function schemaSnapshot(): Promise<Record<string, readonly unknown[]>> {
  const rows = async (sql: string): Promise<readonly unknown[]> => (await pool.query(sql)).rows;
  return {
    columns: await rows(
      `SELECT table_name,column_name,data_type,udt_name,is_nullable,column_default
       FROM information_schema.columns WHERE table_schema=current_schema()
       ORDER BY table_name,column_name`,
    ),
    constraints: await rows(
      `SELECT relation.relname,constraint_row.conname,constraint_row.contype,
              constraint_row.convalidated,pg_get_constraintdef(constraint_row.oid) AS definition
       FROM pg_constraint constraint_row
       INNER JOIN pg_class relation ON relation.oid=constraint_row.conrelid
       WHERE relation.relnamespace=current_schema()::regnamespace
       ORDER BY relation.relname,constraint_row.conname`,
    ),
    indexes: await rows(
      `SELECT tablename,indexname,indexdef FROM pg_indexes
       WHERE schemaname=current_schema() ORDER BY tablename,indexname`,
    ),
    triggers: await rows(
      `SELECT relation.relname,trigger_row.tgname,pg_get_triggerdef(trigger_row.oid) AS definition
       FROM pg_trigger trigger_row
       INNER JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
       WHERE relation.relnamespace=current_schema()::regnamespace AND NOT trigger_row.tgisinternal
       ORDER BY relation.relname,trigger_row.tgname`,
    ),
    functions: await rows(
      `SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
       WHERE pronamespace=current_schema()::regnamespace AND prokind='f'
       ORDER BY proname,definition`,
    ),
  };
}

async function migrate(target: number): Promise<void> {
  const selectedDirectory = await mkdtemp(resolve(tmpdir(), "ohmyhost-container-removal-"));
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
  const directory = await mkdtemp(resolve(tmpdir(), "ohmyhost-container-removal-postgres-"));
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
    const schema = `runtime_removal_${process.pid}_${Date.now()}`;
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
