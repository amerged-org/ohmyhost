import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  migrationsThrough,
  startTestPostgres,
  type TestPostgres,
} from "../../../apps/control-api/test/postgres.js";

const MIGRATION = "127_provider_neutral_build_tables";
const CLEANUP_MIGRATION = "128_build_cleanup_provider_cloudflare";
const ids = {
  organization: "01H00000000000000000000301",
  activeProject: "01H00000000000000000000302",
  deletedProject: "01H00000000000000000000303",
  deletingProject: "01H00000000000000000000304",
  environment: "01H00000000000000000000305",
  epoch: "01H00000000000000000000306",
  connection: "01H00000000000000000000307",
  builtOperation: "01H00000000000000000000308",
  abortedOperation: "01H00000000000000000000309",
  deletingOperation: "01H0000000000000000000030A",
  activeOperation: "01H0000000000000000000030B",
  builtUpload: "01H0000000000000000000030C",
  abortedUpload: "01H0000000000000000000030D",
  activeUpload: "01H0000000000000000000030E",
  buildExecution: "01H0000000000000000000030F",
  claim: "01H0000000000000000000030G",
  opaqueArchiveOperation: "01H0000000000000000000030H",
} as const;
const renamedTables = [
  ["aws_build_input_reservations", "build_input_reservations"],
  ["aws_build_receipts", "build_receipts"],
  ["aws_build_usage", "build_usage"],
  ["aws_source_upload_parts", "build_source_upload_parts"],
  ["aws_source_uploads", "build_source_uploads"],
] as const;
const digest = Buffer.alloc(32, 0x31);
const s3Reference = (operationId: string): string =>
  `s3-version:ohmyho-sandbox-builds/runs/${operationId}/input/source.tar.gz#3HL4kqtJlcpXroDTDmJ.rK`;

let database: TestPostgres;

beforeAll(async () => {
  database = await startTestPostgres();
  await database.migrate("down", await migrationsThrough(MIGRATION));
  await withoutReferentialChecks(async (client) => {
    for (const [projectId, state, handle] of [
      [ids.activeProject, "active", "calm-otter-builds"],
      [ids.deletedProject, "deleted", "blue-raven-builds"],
      [ids.deletingProject, "deleting", "green-heron-builds"],
    ] as const) {
      await client.query(
        `INSERT INTO projects(project_id,created_organization_id,name,created_event_id,created_at,
           lifecycle_state,lifecycle_version,handle,handle_version,handle_attempt)
         VALUES($1,$2,'Build history',$1,'2026-09-17T08:00:00Z',$3,2,$4,
           'human-id-4.2.0-sha256-project-handle-words-v1',0)`,
        [projectId, ids.organization, state, handle],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await database?.stop();
}, 60_000);

describe("provider-neutral build tables", () => {
  it("refuses to run while an active project still has build history and leaves the schema untouched", async () => {
    const activeHistory: readonly [string, (client: PoolClient) => Promise<void>][] = [
      ["aws_build_receipts", (client) => insertReceipt(client, ids.activeProject)],
      ["aws_build_input_reservations", (client) => insertReservation(client, ids.activeProject)],
      ["aws_build_usage", (client) => insertUsage(client, ids.activeProject)],
      [
        "aws_source_uploads",
        (client) =>
          insertUpload(client, ids.activeProject, ids.activeUpload, ids.activeOperation, "aborted"),
      ],
      [
        "source_archives",
        (client) =>
          insertSourceArchive(
            client,
            ids.activeProject,
            ids.activeOperation,
            s3Reference(ids.activeOperation),
          ),
      ],
    ];
    for (const [table, insert] of activeHistory) {
      await withoutReferentialChecks(insert);
      await expect(database.migrate("up", MIGRATION), table).rejects.toThrow(
        "build history of an active project prevents the provider-neutral build tables",
      );
      await expect(existingTables()).resolves.toEqual(renamedTables.map(([before]) => before));
      await withoutReferentialChecks(async (client) => {
        await client.query(`DELETE FROM ${table} WHERE project_id=$1`, [ids.activeProject]);
      });
    }
  }, 120_000);

  it("removes the build history of deleted projects, renames the schema, restores it exactly on the way down and renames it again", async () => {
    await withoutReferentialChecks(seedDeletedHistory);
    const before = await schemaSnapshot();
    expect(identifiersNamingTheFormerProvider(before)).not.toEqual([]);

    await database.migrate("up", MIGRATION);

    await expect(existingTables()).resolves.toEqual(renamedTables.map(([, after]) => after).sort());
    const after = await schemaSnapshot();
    expect(identifiersNamingTheFormerProvider(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toMatch(/aws_build|aws_source|codebuild|s3-version/iu);
    await expect(rowCounts()).resolves.toEqual({
      build_input_reservations: 0,
      build_receipts: 0,
      build_usage: 0,
      // The upload that a retained build execution references stays with its parts.
      build_source_uploads: 1,
      build_source_upload_parts: 1,
      build_executions: 1,
      source_archives: 1,
      organization_credit_reservations: 1,
    });
    await expect(
      database.pool.query(
        `SELECT upload.upload_id::text,build.build_project_name,archive.object_ref,credit.kind
         FROM build_source_uploads upload
         INNER JOIN build_executions build ON build.source_upload_id=upload.upload_id
         CROSS JOIN source_archives archive
         CROSS JOIN organization_credit_reservations credit`,
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          upload_id: ids.builtUpload,
          build_project_name: "ohmyho-sandbox-build",
          object_ref: `archive_${ids.opaqueArchiveOperation}_${ids.opaqueArchiveOperation}`,
          kind: "codebuild",
        },
      ],
    });

    await withoutReferentialChecks(async (client) => {
      await expect(insertBuildUsage(client, "aws-codebuild", "standard-3")).rejects.toThrow(
        "build_usage_runner_check",
      );
      await expect(insertBuildUsage(client, "cloudflare-build-sandbox", "")).rejects.toThrow(
        "build_usage_instance_type_check",
      );
      await expect(
        insertSourceArchive(
          client,
          ids.deletedProject,
          ids.builtOperation,
          s3Reference(ids.builtOperation),
        ),
      ).rejects.toThrow("source_archives_content_check");
      await expect(
        insertSourceArchive(
          client,
          ids.deletedProject,
          ids.builtOperation,
          `r2-version:ohmyho-builds-staging/runs/source.tar.gz#${"a".repeat(32)}`,
        ),
      ).rejects.toThrow("source_archives_content_check");
      await insertBuildUsage(client, "cloudflare-build-sandbox", "standard-3");
      await insertSourceArchive(
        client,
        ids.deletedProject,
        ids.builtOperation,
        `r2-version:ohmyho-builds-development/runs/source.tar.gz#${"a".repeat(32)}`,
      );
    });
    await expect(database.migrate("down", 1)).rejects.toThrow(
      "build sandbox history prevents a lossless migration downgrade",
    );
    await withoutReferentialChecks(async (client) => {
      await client.query("DELETE FROM build_usage");
    });
    await expect(database.migrate("down", 1)).rejects.toThrow(
      "build sandbox history prevents a lossless migration downgrade",
    );
    await withoutReferentialChecks(async (client) => {
      await client.query("DELETE FROM source_archives WHERE object_ref LIKE 'r2-version:%'");
    });

    await database.migrate("down", 1);
    await expect(existingTables()).resolves.toEqual(renamedTables.map(([name]) => name));
    await expect(schemaSnapshot()).resolves.toEqual(before);

    await database.migrate("up", MIGRATION);
    await expect(schemaSnapshot()).resolves.toEqual(after);
  }, 120_000);
});

describe("build cleanup evidence names Cloudflare", () => {
  const cleanupTables = [
    "wfp_candidate_operation_cleanup_receipts",
    "wfp_candidate_cleanup_resource_expectations",
  ] as const;

  it("refuses to run while an active project still has build cleanup evidence", async () => {
    for (const table of cleanupTables) {
      await withoutReferentialChecks((client) =>
        insertCleanupEvidence(client, table, ids.activeProject, "aws"),
      );
      await expect(database.migrate("up", CLEANUP_MIGRATION), table).rejects.toThrow(
        "build cleanup evidence of an active project prevents the provider change",
      );
      await withoutReferentialChecks(async (client) => {
        await client.query(`DELETE FROM ${table} WHERE project_id=$1`, [ids.activeProject]);
      });
    }
  }, 120_000);

  it("removes the cleanup evidence of deleted projects, accepts only Cloudflare afterwards and restores the former checks exactly", async () => {
    await withoutReferentialChecks(async (client) => {
      for (const projectId of [ids.deletedProject, ids.deletingProject]) {
        for (const table of cleanupTables)
          await insertCleanupEvidence(client, table, projectId, "aws");
      }
    });
    const before = await schemaSnapshot();

    await database.migrate("up", CLEANUP_MIGRATION);

    const after = await schemaSnapshot();
    expect(after).not.toEqual(before);
    await withoutReferentialChecks(async (client) => {
      for (const table of cleanupTables) {
        await expect(
          client.query(`SELECT count(*)::int count FROM ${table}`),
        ).resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(
          insertCleanupEvidence(client, table, ids.deletedProject, "aws"),
        ).rejects.toThrow(`${table}_shape_check`);
        await insertCleanupEvidence(client, table, ids.deletedProject, "cloudflare");
        await expect(database.migrate("down", 1), table).rejects.toThrow(
          "build cleanup evidence prevents a lossless migration downgrade",
        );
        await client.query(`DELETE FROM ${table}`);
      }
    });

    await database.migrate("down", 1);
    await expect(schemaSnapshot()).resolves.toEqual(before);
    await database.migrate("up", CLEANUP_MIGRATION);
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

async function seedDeletedHistory(client: PoolClient): Promise<void> {
  await insertUpload(client, ids.deletedProject, ids.builtUpload, ids.builtOperation, "completed");
  await insertUpload(
    client,
    ids.deletedProject,
    ids.abortedUpload,
    ids.abortedOperation,
    "aborted",
  );
  for (const uploadId of [ids.builtUpload, ids.abortedUpload]) {
    await client.query(
      `INSERT INTO aws_source_upload_parts(upload_id,part_number,etag,byte_length,sha256,recorded_at)
       VALUES($1,1,'"9b2cf535f27731c974343645a3985328"',42,$2,'2026-09-17T08:01:00Z')`,
      [uploadId, digest],
    );
  }
  await client.query(
    `INSERT INTO build_executions(build_execution_id,organization_id,project_id,operation_id,
       source_upload_id,build_plan_sha256,codebuild_project_name,provider_build_id,state,
       attempt_number,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,'ohmyho-sandbox-build','ohmyho-sandbox-build:one','succeeded',1,
       '2026-09-17T08:02:00Z','2026-09-17T08:05:00Z')`,
    [
      ids.buildExecution,
      ids.organization,
      ids.deletedProject,
      ids.builtOperation,
      ids.builtUpload,
      digest,
    ],
  );
  await insertReservation(client, ids.deletedProject);
  await insertReceipt(client, ids.deletedProject);
  await insertUsage(client, ids.deletedProject);
  await insertReservation(client, ids.deletingProject);
  await insertReceipt(client, ids.deletingProject);
  await insertSourceArchive(
    client,
    ids.deletedProject,
    ids.builtOperation,
    s3Reference(ids.builtOperation),
  );
  await insertSourceArchive(
    client,
    ids.deletedProject,
    ids.opaqueArchiveOperation,
    `archive_${ids.opaqueArchiveOperation}_${ids.opaqueArchiveOperation}`,
  );
  // The ledger keeps its history: the hold of a former build stays readable by its old kind.
  await client.query(
    `INSERT INTO organization_credit_reservations(reservation_id,organization_id,project_id,
       environment_id,billing_epoch_id,kind,source_reference,amount_micros,reserved_at)
     VALUES($1,$2,$3,$4,$5,'codebuild',$6,23000000,'2026-09-17T08:00:00Z')`,
    [
      ids.builtOperation,
      ids.organization,
      ids.deletedProject,
      ids.environment,
      ids.epoch,
      ids.builtOperation,
    ],
  );
}

async function insertUpload(
  client: PoolClient,
  projectId: string,
  uploadId: string,
  operationId: string,
  state: "completed" | "aborted",
): Promise<void> {
  await client.query(
    `INSERT INTO aws_source_uploads(upload_id,organization_id,project_id,operation_id,
       source_connection_id,commit_sha,bucket_name,object_key,object_version_id,state,claim_id,
       claimed_at,lease_expires_at,attempt_number,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,repeat('a',40),'ohmyho-sandbox-builds','runs/source.tar.gz',$6,$7,$8,
       '2026-09-17T08:00:00Z','2026-09-17T08:05:00Z',1,'2026-09-17T08:00:00Z','2026-09-17T08:01:00Z')`,
    [
      uploadId,
      ids.organization,
      projectId,
      operationId,
      ids.connection,
      state === "completed" ? "3HL4kqtJlcpXroDTDmJ.rK" : null,
      state,
      ids.claim,
    ],
  );
}

async function insertReservation(client: PoolClient, projectId: string): Promise<void> {
  await client.query(
    `INSERT INTO aws_build_input_reservations(organization_id,project_id,environment_id,
       operation_id,input_fingerprint,claim_id,claim_mode,claimed_at,lease_expires_at,
       attempt_number,created_at,start_allowed_until)
     VALUES($1,$2,$3,$4,$5,gen_random_uuid()::text,'start','2026-09-17T08:00:00Z',
       '2026-09-17T08:02:00Z',1,'2026-09-17T08:00:00Z','2026-09-17T08:04:00Z')`,
    [ids.organization, projectId, ids.environment, operationOf(projectId), digest],
  );
}

async function insertReceipt(client: PoolClient, projectId: string): Promise<void> {
  await client.query(
    `INSERT INTO aws_build_receipts(organization_id,project_id,environment_id,operation_id,
       provider_build_id,codebuild_project_name)
     VALUES($1,$2,$3,$4,$5,'ohmyho-sandbox-build')`,
    [
      ids.organization,
      projectId,
      ids.environment,
      operationOf(projectId),
      `ohmyho-sandbox-build:${projectId}`,
    ],
  );
}

async function insertUsage(client: PoolClient, projectId: string): Promise<void> {
  await client.query(
    `INSERT INTO aws_build_usage(organization_id,project_id,environment_id,operation_id,
       billing_epoch_id,provider_build_id,codebuild_project_name,arn,status,started_at,
       provisioning_started_at,completed_at,environment_type,compute_type)
     VALUES($1,$2,$3,$4,$5,$6,'ohmyho-sandbox-build',
       'arn:aws:codebuild:us-east-1:123456789012:build/'||$6,'SUCCEEDED','2026-09-17T08:00:00Z',
       '2026-09-17T08:00:30Z','2026-09-17T08:03:00Z','LINUX_CONTAINER','BUILD_GENERAL1_SMALL')`,
    [
      ids.organization,
      projectId,
      ids.environment,
      operationOf(projectId),
      ids.epoch,
      `ohmyho-sandbox-build:${projectId}`,
    ],
  );
}

async function insertBuildUsage(
  client: PoolClient,
  runner: string,
  instanceType: string,
): Promise<void> {
  await client.query(
    `INSERT INTO build_usage(organization_id,project_id,environment_id,operation_id,
       billing_epoch_id,provider_build_id,build_project_name,runner,instance_type,status,
       started_at,provisioning_started_at,completed_at)
     VALUES($1,$2,$3,$4,$5,'ohmyho-builds:one','ohmyho-builds',$6,$7,'SUCCEEDED',
       '2026-09-17T09:00:00Z','2026-09-17T09:00:04Z','2026-09-17T09:01:40Z')`,
    [
      ids.organization,
      ids.deletedProject,
      ids.environment,
      ids.builtOperation,
      ids.epoch,
      runner,
      instanceType,
    ],
  );
}

async function insertSourceArchive(
  client: PoolClient,
  projectId: string,
  operationId: string,
  objectRef: string,
): Promise<void> {
  await client.query(
    `INSERT INTO source_archives(operation_id,organization_id,project_id,billing_epoch_id,provider,
       source_connection_id,external_repository_id,requested_commit_sha,resolved_commit_sha,
       archive_format,sha256,byte_length,object_ref,acquired_at)
     VALUES($1,$2,$3,$4,'github',$5,'42',repeat('a',40),repeat('a',40),'tar.gz',$6,42,$7,
       '2026-09-17T08:01:00Z')`,
    [operationId, ids.organization, projectId, ids.epoch, ids.connection, digest, objectRef],
  );
}

async function insertCleanupEvidence(
  client: PoolClient,
  table: string,
  projectId: string,
  provider: string,
): Promise<void> {
  const receipt = table === "wfp_candidate_operation_cleanup_receipts";
  await client.query(
    `INSERT INTO ${table}(${receipt ? "operation_cleanup_receipt_id,outcome,observed_at," : ""}
       cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,
       resource_kind,resource_identity_sha256)
     VALUES(${receipt ? "$1,'not_found','2026-09-17T08:06:00Z'," : ""}
       $1,$1,$2,$1,$3,$4,'build-artifact',$5)`,
    [projectId, ids.organization, operationOf(projectId), provider, digest],
  );
}

function operationOf(projectId: string): string {
  if (projectId === ids.activeProject) return ids.activeOperation;
  return projectId === ids.deletingProject ? ids.deletingOperation : ids.builtOperation;
}

async function existingTables(): Promise<string[]> {
  const result = await database.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name`,
    [renamedTables.flat()],
  );
  return result.rows.map((row) => row.table_name);
}

async function rowCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of [
    "build_input_reservations",
    "build_receipts",
    "build_usage",
    "build_source_uploads",
    "build_source_upload_parts",
    "build_executions",
    "source_archives",
    "organization_credit_reservations",
  ]) {
    const result = await database.pool.query<{ count: number }>(
      `SELECT count(*)::int count FROM ${table}`,
    );
    counts[table] = result.rows[0]?.count ?? -1;
  }
  return counts;
}

/**
 * Every table, column, constraint, index, trigger and function name that still names the former
 * build provider. The SES tenant's `aws_managed_status` is that provider's own field and stays.
 */
function identifiersNamingTheFormerProvider(snapshot: SchemaSnapshot): string[] {
  return [
    ...snapshot.columns.flatMap((row) => [row.table_name, row.column_name]),
    ...snapshot.constraints.map((row) => row.conname),
    ...snapshot.indexes.map((row) => row.indexname),
    ...snapshot.triggers.map((row) => row.tgname),
    ...snapshot.functions.map((row) => row.proname),
  ].filter((name) => /aws|codebuild/iu.test(name) && !name.includes("aws_managed_status"));
}

interface SchemaSnapshot {
  readonly columns: readonly { table_name: string; column_name: string }[];
  readonly constraints: readonly { conname: string }[];
  readonly indexes: readonly { indexname: string }[];
  readonly triggers: readonly { tgname: string }[];
  readonly functions: readonly { proname: string }[];
}

/**
 * Every column, constraint, index, trigger and function of the schema. Column positions are
 * left out on purpose: a re-created table lists its columns in the same order anyway.
 */
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
