import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  migrationsThrough,
  startTestPostgres,
  type TestPostgres,
} from "../../../apps/control-api/test/postgres.js";

const MIGRATION = "129_project_hosting_region";
const ids = {
  organization: "01H00000000000000000000401",
  project: "01H00000000000000000000402",
  epoch: "01H00000000000000000000403",
  connection: "01H00000000000000000000404",
  usOperation: "01H00000000000000000000405",
  euOperation: "01H00000000000000000000406",
  rejectedOperation: "01H00000000000000000000407",
} as const;
const digest = Buffer.alloc(32, 0x31);
const reference = (bucket: string): string =>
  `r2-version:${bucket}/runs/source.tar.gz#${"a".repeat(32)}`;

let database: TestPostgres;

beforeAll(async () => {
  database = await startTestPostgres();
  await database.migrate("down", await migrationsThrough(MIGRATION));
  await withoutReferentialChecks(async (client) => {
    await client.query(
      `INSERT INTO projects(project_id,created_organization_id,name,created_event_id,created_at,
         lifecycle_state,lifecycle_version,handle,handle_version,handle_attempt)
       VALUES($1,$2,'Region',$1,'2026-09-18T08:00:00Z','active',2,'calm-otter-region',
         'human-id-4.2.0-sha256-project-handle-words-v1',0)`,
      [ids.project, ids.organization],
    );
  });
}, 120_000);

afterAll(async () => {
  await database?.stop();
}, 60_000);

describe("project hosting region", () => {
  it("adds the immutable US-default region, widens the build object reference, and restores the former schema exactly on the way down", async () => {
    const before = await schemaSnapshot();

    await database.migrate("up", MIGRATION);

    const after = await schemaSnapshot();
    expect(after).not.toEqual(before);
    await expect(
      database.pool.query("SELECT region FROM projects WHERE project_id=$1", [ids.project]),
    ).resolves.toMatchObject({ rows: [{ region: "us" }] });

    // The trigger runs on an ordinary session; the checks below are not weakened by replica mode.
    await expect(
      database.pool.query("UPDATE projects SET region='eu' WHERE project_id=$1", [ids.project]),
    ).rejects.toThrow("project hosting region is chosen at creation and cannot change");
    await expect(
      database.pool.query("UPDATE projects SET region='apac' WHERE project_id=$1", [ids.project]),
    ).rejects.toThrow("project hosting region is chosen at creation and cannot change");
    await expect(
      database.pool.query(
        "UPDATE projects SET lifecycle_version=lifecycle_version+1 WHERE project_id=$1",
        [ids.project],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await withoutReferentialChecks(async (client) => {
      await expect(insertProject(client, "apac")).rejects.toThrow("projects_region_shape");

      await expect(
        insertSourceArchive(client, ids.rejectedOperation, reference("ohmyho-builds-staging")),
      ).rejects.toThrow("source_archives_content_check");
      await expect(
        insertSourceArchive(client, ids.rejectedOperation, reference("ohmyho-builds-eu")),
      ).rejects.toThrow("source_archives_content_check");
      await insertSourceArchive(client, ids.usOperation, reference("ohmyho-builds-development"));
      await insertSourceArchive(client, ids.euOperation, reference("ohmyho-builds-production-eu"));
    });

    await expect(database.migrate("down", 1)).rejects.toThrow(
      "EU hosting evidence prevents a lossless migration downgrade",
    );
    await withoutReferentialChecks(async (client) => {
      await client.query("DELETE FROM source_archives WHERE operation_id=$1", [ids.euOperation]);
      await insertProject(client, "eu");
    });
    await expect(database.migrate("down", 1)).rejects.toThrow(
      "EU hosting evidence prevents a lossless migration downgrade",
    );
    await withoutReferentialChecks(async (client) => {
      await client.query("DELETE FROM projects WHERE region='eu'");
    });

    await database.migrate("down", 1);
    await expect(schemaSnapshot()).resolves.toEqual(before);
    await withoutReferentialChecks(async (client) => {
      await expect(
        insertSourceArchive(client, ids.euOperation, reference("ohmyho-builds-production-eu")),
      ).rejects.toThrow("source_archives_content_check");
    });

    await database.migrate("up", MIGRATION);
    await expect(schemaSnapshot()).resolves.toEqual(after);
  }, 120_000);
});

/** Parent rows are irrelevant here, so foreign keys and append-only triggers stay out of the way. */
async function withoutReferentialChecks(
  work: (client: PoolClient) => Promise<void>,
): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query("SET session_replication_role=replica");
    await work(client);
  } finally {
    await client.query("SET session_replication_role=origin");
    client.release();
  }
}

async function insertProject(client: PoolClient, region: string): Promise<void> {
  await client.query(
    `INSERT INTO projects(project_id,created_organization_id,name,created_event_id,created_at,
       lifecycle_state,lifecycle_version,handle,handle_version,handle_attempt,region)
     VALUES('01H00000000000000000000408',$1,'Elsewhere','01H00000000000000000000408',
       '2026-09-18T08:00:00Z','active',2,'blue-raven-region',
       'human-id-4.2.0-sha256-project-handle-words-v1',0,$2)`,
    [ids.organization, region],
  );
}

async function insertSourceArchive(
  client: PoolClient,
  operationId: string,
  objectRef: string,
): Promise<void> {
  await client.query(
    `INSERT INTO source_archives(operation_id,organization_id,project_id,billing_epoch_id,provider,
       source_connection_id,external_repository_id,requested_commit_sha,resolved_commit_sha,
       archive_format,sha256,byte_length,object_ref,acquired_at)
     VALUES($1,$2,$3,$4,'github',$5,'42',repeat('a',40),repeat('a',40),'tar.gz',$6,42,$7,
       '2026-09-18T08:01:00Z')`,
    [operationId, ids.organization, ids.project, ids.epoch, ids.connection, digest, objectRef],
  );
}

interface SchemaSnapshot {
  readonly columns: readonly { table_name: string; column_name: string }[];
  readonly constraints: readonly { conname: string }[];
  readonly triggers: readonly { tgname: string }[];
  readonly functions: readonly { proname: string }[];
}

/** Every column, constraint, trigger and function of the schema. */
async function schemaSnapshot(): Promise<SchemaSnapshot> {
  const rows = async <Row>(sql: string): Promise<readonly Row[]> =>
    (await database.pool.query(sql)).rows as Row[];
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
