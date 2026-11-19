import { Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import type { D1Database } from "../../src/d1-types.js";
import { createTestControl, migrationFiles, type TestControl } from "../support/control-d1.js";
import { seedProject, STORED_NOW, ulidOf } from "../support/platform-fixtures.js";
import { splitStatements } from "../support/sql.js";

const FIELDS = {
  project_database_access: [
    "access_id",
    "organization_id",
    "project_id",
    "environment_id",
    "data_environment_id",
  ],
  project_database_writes: [
    "operation_id",
    "organization_id",
    "project_id",
    "environment_id",
    "data_environment_id",
    "billing_epoch_id",
  ],
  pgcf_database_compute_changes: [
    "operation_id",
    "organization_id",
    "project_id",
    "environment_id",
    "data_environment_id",
    "billing_epoch_id",
    "claim_id",
  ],
} as const;
const migration = migrationFiles("core").find((file) => file.name.startsWith("0401_"));
if (!migration) throw new Error("Original product ULID migration is missing");
let control: TestControl;
let postgres: TestPostgres;
beforeAll(async () => {
  [control, postgres] = await Promise.all([createTestControl(), startTestPostgres()]);
}, 120_000);
afterAll(async () => {
  await Promise.all([control?.dispose(), postgres?.stop()]);
});

async function fixture(current: TestControl, physical?: string) {
  const project = await seedProject(current);
  const operation = ulidOf("ulid-job", Number(project.handle.split("-")[1]));
  const data = physical ?? project.devEnvironmentId;
  const provider = `prj_${"a".repeat(20)}`;
  const database = `d${"b".repeat(19)}`;
  await current.core.batch([
    current.core
      .prepare(
        "INSERT INTO operations(organization_id,operation_id,project_id,state,billing_epoch_id,created_at,updated_at) VALUES(?1,?2,?3,'running',?4,?5,?5)",
      )
      .bind(
        project.organizationId,
        operation,
        project.projectId,
        project.billingEpochId,
        STORED_NOW,
      ),
    current.core
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?1,?2,?3,?4)",
      )
      .bind(project.organizationId, project.projectId, data, STORED_NOW),
    current.core
      .prepare(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,1,'pgcf',?4,?5,'us-dev','omh-512',?6,'sealed:synthetic',?7)",
      )
      .bind(
        project.organizationId,
        project.projectId,
        data,
        provider,
        database,
        `ohmyho_rw_${data.toLowerCase()}`,
        STORED_NOW,
      ),
  ]);
  const scope = {
    organization_id: project.organizationId,
    project_id: project.projectId,
    environment_id: project.devEnvironmentId,
    data_environment_id: data,
  };
  const rows: Record<keyof typeof FIELDS, Record<string, string | number | null | Uint8Array>> = {
    project_database_access: {
      ...scope,
      access_id: ulidOf("ulid-access", Number(project.handle.split("-")[1])),
      environment: "dev",
      provider_project_id: provider,
      default_branch_id: null,
      role_name: `ohmyho_da_${data.toLowerCase()}_native00`,
      mode: "read",
      label: null,
      principal_id: "user:fixture",
      origin_host: "db.example.com",
      issued_at: STORED_NOW,
      expires_at: "2026-10-29T10:00:00.000000Z",
      provider: "pgcf",
      database_id: database,
    },
    project_database_writes: {
      ...scope,
      operation_id: operation,
      environment: "dev",
      billing_epoch_id: project.billingEpochId,
      provider_project_id: provider,
      default_branch_id: null,
      principal_id: "user:fixture",
      idempotency_key: operation,
      request_sha256: new Uint8Array(32),
      started_at: STORED_NOW,
      deadline_at: "2026-10-28T10:01:00.000000Z",
      provider: "pgcf",
      database_id: database,
    },
    pgcf_database_compute_changes: {
      ...scope,
      operation_id: operation,
      billing_epoch_id: project.billingEpochId,
      provider_project_id: provider,
      database_id: database,
      target_version: 1,
      memory_mib: 512,
      size_class_id: "opaque historical class",
      accepted_lifecycle_version: -2147483648,
      requested_at: STORED_NOW,
      claim_id: null,
    },
  };
  return { project, rows };
}
function insert(
  db: D1Database,
  table: string,
  row: Record<string, string | number | null | Uint8Array>,
) {
  const names = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`)
    .bind(...Object.values(row));
}

it("enforces every original ULID field on INSERT and UPDATE against the native PG18 domain while preserving valid facts", async () => {
  const { rows } = await fixture(control);
  const invalids = [
    "I".repeat(26),
    "8" + "0".repeat(25),
    "0".repeat(25) + "i",
    "0".repeat(25),
    "0".repeat(26) + "\0suffix",
  ];
  for (const invalid of invalids) {
    await expect(postgres.pool.query("SELECT $1::ulid", [invalid])).rejects.toMatchObject({
      code: invalid.includes("\0") ? "22021" : "23514",
    });
    for (const [table, fields] of Object.entries(FIELDS)) {
      for (const field of fields) {
        await expect(
          insert(control.core, table, {
            ...rows[table as keyof typeof FIELDS],
            [field]: invalid,
          }).run(),
          `${table}.${field}`,
        ).rejects.toThrow(/Original product database ULID domain/u);
      }
    }
  }
  for (const table of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
    await insert(control.core, table, rows[table]).run();
    const before = await control.core.prepare(`SELECT * FROM ${table}`).all();
    for (const field of FIELDS[table]) {
      await expect(
        control.core.prepare(`UPDATE ${table} SET ${field}=?`).bind("I".repeat(26)).run(),
        `${table}.${field}`,
      ).rejects.toThrow(/Original product database ULID domain/u);
    }
    expect((await control.core.prepare(`SELECT * FROM ${table}`).all()).results).toEqual(
      before.results,
    );
  }
  expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("rejects a compute child whose invalid physical ULID has real matching Core parents, with late-batch rollback", async () => {
  const { project, rows } = await fixture(control, "I".repeat(26));
  expect(
    (
      await control.core
        .prepare(
          "SELECT physical_environment_id FROM database_provider_target_revisions WHERE project_id=?",
        )
        .bind(project.projectId)
        .first()
    )?.["physical_environment_id"],
  ).toBe("I".repeat(26));
  await expect(
    control.core.batch([
      control.core
        .prepare("UPDATE environments SET desired_state=? WHERE project_id=?")
        .bind('{"must":"rollback"}', project.projectId),
      insert(control.core, "pgcf_database_compute_changes", rows.pgcf_database_compute_changes),
    ]),
  ).rejects.toThrow(/Original product database ULID domain/u);
  expect(
    (
      await control.core
        .prepare("SELECT desired_state FROM environments WHERE project_id=? LIMIT 1")
        .bind(project.projectId)
        .first()
    )?.["desired_state"],
  ).toBe("{}");
  expect(
    await control.core
      .prepare("SELECT operation_id FROM pgcf_database_compute_changes WHERE project_id=?")
      .bind(project.projectId)
      .first(),
  ).toBeNull();
  expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});

it("refuses invalid existing forward facts without repairs and rolls back earlier writes and trigger creation", async () => {
  const local = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('local')}}",
    d1Databases: { CONTROL_CORE: "core" },
  });
  try {
    const db = (await local.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    for (const file of migrationFiles("core").filter((file) => file.name < migration.name))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    const legacy = {
      core: db,
      directory: db,
      shards: { CONTROL_SHARD_0000: db },
      bindings: { CONTROL_CORE: db },
      dispose: async () => {},
    };
    const { project, rows } = await fixture(legacy, "I".repeat(26));
    await insert(db, "pgcf_database_compute_changes", rows.pgcf_database_compute_changes).run();
    const before = (await db.prepare("SELECT * FROM pgcf_database_compute_changes").all()).results;
    await expect(
      db.batch([
        db
          .prepare("UPDATE environments SET desired_state=? WHERE project_id=?")
          .bind('{"must":"rollback"}', project.projectId),
        ...splitStatements(migration.sql).map((sql) => db.prepare(sql)),
      ]),
    ).rejects.toThrow(/precondition_changed/u);
    expect((await db.prepare("SELECT * FROM pgcf_database_compute_changes").all()).results).toEqual(
      before,
    );
    expect(
      (
        await db
          .prepare("SELECT desired_state FROM environments WHERE project_id=? LIMIT 1")
          .bind(project.projectId)
          .first()
      )?.["desired_state"],
    ).toBe("{}");
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE '%_ulid_insert'",
          )
          .all()
      ).results,
    ).toEqual([]);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await local.dispose();
  }
});
