import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { runner } from "node-pg-migrate";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const migrationsDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const ids = {
  organization: "01H00000000000000000000301",
  project: "01H00000000000000000000302",
  development: "01H00000000000000000000303",
  production: "01H00000000000000000000304",
  event: "01H00000000000000000000305",
  epoch: "01H00000000000000000000306",
  artifact: "01H00000000000000000000307",
  buildExecution: "01H00000000000000000000308",
  legacyGatewayReceipt: "01H00000000000000000000309",
  developmentGatewayReceipt: "01H0000000000000000000030A",
  productionGatewayReceipt: "01H0000000000000000000030B",
  invalidGatewayReceipt: "01H0000000000000000000030C",
} as const;

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
let pool: Pool;

beforeAll(async () => {
  await resetDatabase(57);
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await postgres?.stop();
}, 60_000);

describe("project handle and environment cutover", () => {
  it("fails closed when a pre-cutover project has no truthful handle and dev/prod evidence", async () => {
    await insertLegacyProject();

    await expect(migrate(58)).rejects.toThrow(
      "project handle cutover requires truthful staged evidence",
    );
    await expect(
      pool.query("SELECT name FROM control_db_migrations WHERE name LIKE '058_%'"),
    ).resolves.toMatchObject({ rowCount: 0 });
    await expect(
      pool.query("SELECT name FROM environments WHERE project_id=$1", [ids.project]),
    ).resolves.toMatchObject({ rows: [{ name: "sandbox" }] });
  });

  it("commits only an immutable handle with exact dev and prod environments", async () => {
    await resetDatabase(58);
    await insertCurrentProject();

    await expect(
      pool.query(`SELECT handle,handle_version,handle_attempt FROM projects WHERE project_id=$1`, [
        ids.project,
      ]),
    ).resolves.toMatchObject({
      rows: [
        {
          handle: "calm-raven-builds",
          handle_version: "human-id-4.2.0-sha256-project-handle-words-v1",
          handle_attempt: 0,
        },
      ],
    });
    await expect(
      pool.query(
        `SELECT environment_id,name FROM environments
         WHERE project_id=$1 ORDER BY name`,
        [ids.project],
      ),
    ).resolves.toMatchObject({
      rows: [
        { environment_id: ids.development, name: "dev" },
        { environment_id: ids.production, name: "prod" },
      ],
    });

    await expect(
      pool.query("UPDATE projects SET handle='other-raven-builds' WHERE project_id=$1", [
        ids.project,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query("UPDATE environments SET name='stage' WHERE environment_id=$1", [ids.development]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query("DELETE FROM environments WHERE environment_id=$1", [ids.production]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        `INSERT INTO environments(
           organization_id,environment_id,project_id,name,desired_state,created_at,updated_at)
         VALUES($1,$2,$3,'qa','{}','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z')`,
        [ids.organization, "01H00000000000000000000307", ids.project],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "environments_poc_name_check" });
    await expect(
      pool.query(
        `INSERT INTO projects(
           project_id,created_organization_id,name,handle,handle_version,handle_attempt,
           created_event_id,created_at)
         VALUES('01H00000000000000000000308',$1,'forged-version','rapid-otter-shines',
           'invented-version',0,'01H00000000000000000000309','2026-08-25T12:00:00Z')`,
        [ids.organization],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "projects_handle_evidence_check" });
  });

  it("blocks legacy gateway receipts instead of inventing environment-specific evidence", async () => {
    await resetDatabase(57);
    await stageCurrentProjectBeforeCutover();
    await insertArtifactFixture();
    await insertLegacyGatewayReceipt();

    await expect(migrate(58)).rejects.toThrow(
      "project gateway cutover requires fresh environment-specific provider receipts",
    );
    await expect(
      pool.query("SELECT gateway_contract_version FROM wfp_publish_receipts"),
    ).resolves.toMatchObject({
      rows: [{ gateway_contract_version: "ohmyhost.project-gateway/v1" }],
    });
  });

  it("accepts only exact dev and prod handle gateways at the root origin", async () => {
    await resetDatabase(58);
    await insertCurrentProject();
    await insertArtifactFixture();

    await expect(insertCurrentGatewayReceipt("dev")).resolves.toBeUndefined();
    await expect(insertCurrentGatewayReceipt("prod")).resolves.toBeUndefined();
    await expect(
      pool.query(
        `SELECT gateway_script_name,gateway_target_script_name,deployment_url,
                octet_length(gateway_egress_policy_sha256) AS egress_bytes
         FROM wfp_publish_receipts ORDER BY gateway_script_name`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          gateway_script_name: "calm-raven-builds",
          gateway_target_script_name: `p-${ids.project.toLowerCase()}-prod`,
          deployment_url: "https://calm-raven-builds.sandboxaccount.workers.dev",
          egress_bytes: 32,
        },
        {
          gateway_script_name: "dev-calm-raven-builds",
          gateway_target_script_name: `p-${ids.project.toLowerCase()}-dev`,
          deployment_url: "https://dev-calm-raven-builds.sandboxaccount.workers.dev",
          egress_bytes: 32,
        },
      ],
    });
    await expect(
      pool.query("UPDATE wfp_publish_receipts SET gateway_public_origin='https://changed.invalid'"),
    ).rejects.toThrow("is append-only");
  });

  it("rejects legacy g-prefixed gateways and project base paths after cutover", async () => {
    await resetDatabase(58);
    await insertCurrentProject();
    await insertArtifactFixture();

    await expect(insertInvalidCurrentGatewayReceipt("legacy-script")).rejects.toMatchObject({
      code: "23514",
      constraint: "wfp_publish_receipts_gateway_shape_check",
    });
    await expect(insertInvalidCurrentGatewayReceipt("base-path")).rejects.toMatchObject({
      code: "23514",
      constraint: "wfp_publish_receipts_gateway_shape_check",
    });
  });

  it("rejects a project transaction that omits the production environment", async () => {
    await resetDatabase(58);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await insertCurrentIdentity(client);
      await client.query(
        `INSERT INTO environments(
           organization_id,environment_id,project_id,name,desired_state,created_at,updated_at)
         VALUES($1,$2,$3,'dev','{}','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z')`,
        [ids.organization, ids.development, ids.project],
      );
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "environments_exact_poc_set",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("rejects an environment that reuses its project identity", async () => {
    await resetDatabase(58);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await insertCurrentIdentity(client);
      await expect(
        client.query(
          `INSERT INTO environments(
             organization_id,environment_id,project_id,name,desired_state,created_at,updated_at)
           VALUES($1,$2,$2,'dev','{}','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z')`,
          [ids.organization, ids.project],
        ),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "environments_project_id_distinct_check",
      });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("refuses a lossy downgrade while current projects exist", async () => {
    await resetDatabase(58);
    await insertCurrentProject();

    await expect(migrateDownOne()).rejects.toThrow(
      "project handle cutover cannot be downgraded while projects exist",
    );
    await expect(
      pool.query("SELECT handle FROM projects WHERE project_id=$1", [ids.project]),
    ).resolves.toMatchObject({ rows: [{ handle: "calm-raven-builds" }] });
  });
});

async function insertLegacyProject(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO projects(project_id,created_organization_id,name,created_event_id,created_at)
       VALUES($1,$2,'legacy-project',$3,'2026-08-25T12:00:00Z')`,
      [ids.project, ids.organization, ids.event],
    );
    await insertOwnership(client);
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function insertCurrentProject(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await insertCurrentIdentity(client);
    await client.query(
      `INSERT INTO environments(
         organization_id,environment_id,project_id,name,desired_state,created_at,updated_at)
       VALUES
         ($1,$2,$4,'dev','{}','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z'),
         ($1,$3,$4,'prod','{}','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z')`,
      [ids.organization, ids.development, ids.production, ids.project],
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function stageCurrentProjectBeforeCutover(): Promise<void> {
  await pool.query(
    `ALTER TABLE projects
       ADD COLUMN handle text,
       ADD COLUMN handle_version text,
       ADD COLUMN handle_attempt integer`,
  );
  await insertLegacyProject();
  await pool.query(
    `UPDATE projects SET
       handle='calm-raven-builds',
       handle_version='human-id-4.2.0-sha256-project-handle-words-v1',
       handle_attempt=0
     WHERE project_id=$1`,
    [ids.project],
  );
  await pool.query("SET session_replication_role='replica'");
  try {
    await pool.query("DELETE FROM runtime_secret_delivery_states WHERE project_id=$1", [
      ids.project,
    ]);
    await pool.query(
      `UPDATE environments
       SET environment_id=$2,name='dev',updated_at='2026-08-25T12:00:01Z'
       WHERE project_id=$1`,
      [ids.project, ids.development],
    );
  } finally {
    await pool.query("SET session_replication_role='origin'");
  }
  await pool.query(
    `INSERT INTO environments(
       organization_id,environment_id,project_id,name,desired_state,created_at,updated_at,is_default)
     VALUES($1,$2,$3,'prod','{}','2026-08-25T12:00:00Z','2026-08-25T12:00:00Z',false)`,
    [ids.organization, ids.production, ids.project],
  );
}

async function insertArtifactFixture(): Promise<void> {
  await pool.query("SET session_replication_role='replica'");
  try {
    await pool.query(
      `INSERT INTO build_artifacts(
         artifact_id,organization_id,project_id,build_execution_id,artifact_sha256,
         manifest_sha256,sbom_sha256,object_version_ref,created_at)
       VALUES($1,$2,$3,$4,decode(repeat('11',32),'hex'),decode(repeat('22',32),'hex'),
         decode(repeat('33',32),'hex'),'fixture-version','2026-08-25T12:00:00Z')`,
      [ids.artifact, ids.organization, ids.project, ids.buildExecution],
    );
  } finally {
    await pool.query("SET session_replication_role='origin'");
  }
}

async function insertLegacyGatewayReceipt(): Promise<void> {
  const project = ids.project.toLowerCase();
  await pool.query(
    `INSERT INTO wfp_publish_receipts(
       wfp_receipt_id,organization_id,project_id,artifact_id,dispatch_namespace,script_name,
       provider_version_id,deployment_url,published_at,environment_id,gateway_contract_version,
       gateway_script_name,gateway_target_script_name,gateway_workers_dev_subdomain,
       gateway_provider_tag,gateway_module_sha256,gateway_public_origin,
       gateway_compatibility_date,gateway_observed_at)
     VALUES($1,$2,$3,$4,'sandbox',$5,'legacy-version',$6,'2026-08-25T12:00:00Z',$7,
       'ohmyhost.project-gateway/v1',$8,$5,'sandboxaccount',decode(repeat('44',32),'hex'),
       decode(repeat('55',32),'hex'),$9,'2026-08-25','2026-08-25T12:00:00Z')`,
    [
      ids.legacyGatewayReceipt,
      ids.organization,
      ids.project,
      ids.artifact,
      `p-${project}`,
      `https://g-${project}.sandboxaccount.workers.dev/p/${ids.project}`,
      ids.development,
      `g-${project}`,
      `https://g-${project}.sandboxaccount.workers.dev`,
    ],
  );
}

async function insertCurrentGatewayReceipt(environment: "dev" | "prod"): Promise<void> {
  const project = ids.project.toLowerCase();
  const isDevelopment = environment === "dev";
  const gatewayScript = isDevelopment ? "dev-calm-raven-builds" : "calm-raven-builds";
  const targetScript = `p-${project}-${environment}`;
  const publicOrigin = `https://${gatewayScript}.sandboxaccount.workers.dev`;
  await pool.query(
    `INSERT INTO wfp_publish_receipts(
       wfp_receipt_id,organization_id,project_id,artifact_id,dispatch_namespace,script_name,
       provider_version_id,deployment_url,published_at,environment_id,gateway_contract_version,
       gateway_script_name,gateway_target_script_name,gateway_workers_dev_subdomain,
       gateway_provider_tag,gateway_module_sha256,gateway_egress_policy_sha256,
       gateway_dev_access_service,gateway_dev_access_entrypoint,gateway_dev_access_key_id,
       gateway_dev_access_public_key_sha256,
       gateway_public_origin,gateway_compatibility_date,gateway_observed_at)
     VALUES($1,$2,$3,$4,'sandbox',$5,$6,$7,'2026-08-25T12:00:00Z',$8,
       'ohmyhost.project-gateway/v5',$9,$5,'sandboxaccount',decode(repeat('44',32),'hex'),
       decode(repeat('55',32),'hex'),decode(repeat('66',32),'hex'),$10,$11,$12,$12,$7,'2026-08-25',
       '2026-08-25T12:00:00Z')`,
    [
      isDevelopment ? ids.developmentGatewayReceipt : ids.productionGatewayReceipt,
      ids.organization,
      ids.project,
      ids.artifact,
      targetScript,
      `${environment}-version`,
      publicOrigin,
      isDevelopment ? ids.development : ids.production,
      gatewayScript,
      isDevelopment ? "ohmyho-control-api-sandbox" : null,
      isDevelopment ? "DevAccessService" : null,
      isDevelopment ? Buffer.alloc(32, 0x77) : null,
    ],
  );
}

async function insertInvalidCurrentGatewayReceipt(
  defect: "legacy-script" | "base-path",
): Promise<void> {
  const project = ids.project.toLowerCase();
  const gatewayScript = defect === "legacy-script" ? `g-${project}` : "dev-calm-raven-builds";
  const publicOrigin = `https://${gatewayScript}.sandboxaccount.workers.dev`;
  const deploymentUrl = defect === "base-path" ? `${publicOrigin}/p/${ids.project}` : publicOrigin;
  await pool.query(
    `INSERT INTO wfp_publish_receipts(
       wfp_receipt_id,organization_id,project_id,artifact_id,dispatch_namespace,script_name,
       provider_version_id,deployment_url,published_at,environment_id,gateway_contract_version,
       gateway_script_name,gateway_target_script_name,gateway_workers_dev_subdomain,
       gateway_provider_tag,gateway_module_sha256,gateway_egress_policy_sha256,
       gateway_public_origin,gateway_compatibility_date,gateway_observed_at)
     VALUES($1,$2,$3,$4,'sandbox',$5,$6,$7,'2026-08-25T12:00:00Z',$8,
       'ohmyhost.project-gateway/v5',$9,$5,'sandboxaccount',decode(repeat('44',32),'hex'),
       decode(repeat('55',32),'hex'),decode(repeat('66',32),'hex'),$10,'2026-08-25',
       '2026-08-25T12:00:00Z')`,
    [
      ids.invalidGatewayReceipt,
      ids.organization,
      ids.project,
      ids.artifact,
      `p-${project}-dev`,
      `invalid-${defect}`,
      deploymentUrl,
      ids.development,
      gatewayScript,
      publicOrigin,
    ],
  );
}

async function insertCurrentIdentity(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO projects(
       project_id,created_organization_id,name,handle,handle_version,handle_attempt,
       created_event_id,created_at)
     VALUES($1,$2,'current-project','calm-raven-builds',
       'human-id-4.2.0-sha256-project-handle-words-v1',0,$3,'2026-08-25T12:00:00Z')`,
    [ids.project, ids.organization, ids.event],
  );
  await insertOwnership(client);
}

async function insertOwnership(client: PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO billing_epochs(
       billing_epoch_id,project_id,organization_id,started_at,created_by_principal_id)
     VALUES($1,$2,$3,'2026-08-25T12:00:00Z','user:test')`,
    [ids.epoch, ids.project, ids.organization],
  );
  await client.query(
    `INSERT INTO project_ownerships(
       project_id,organization_id,state,ownership_version,active_billing_epoch_id,updated_at)
     VALUES($1,$2,'active',1,$3,'2026-08-25T12:00:00Z')`,
    [ids.project, ids.organization, ids.epoch],
  );
}

async function resetDatabase(target: number): Promise<void> {
  await pool?.end();
  await postgres?.stop();
  postgres = await startTestPostgres();
  pool = new Pool({
    connectionString: postgres.connectionString,
    options: `-c search_path=${postgres.schema}`,
  });
  await migrate(target);
}

async function migrate(target: number): Promise<void> {
  const selectedDirectory = await mkdtemp(resolve(tmpdir(), "ohmyhost-handle-migrations-"));
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
  const directory = await mkdtemp(resolve(tmpdir(), "ohmyhost-project-handle-cutover-"));
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
    const schema = `project_handle_${process.pid}_${Date.now()}`;
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
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else reject(error);
      });
    });
  });
}
