import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { guard } from "../../src/guards.js";
import { migrationFiles, type TestControl } from "../support/control-d1.js";
import { seedProject } from "../support/platform-fixtures.js";
import { seedProviderClaim } from "../support/accepted-operation.js";
import { seedWfpPublication } from "../support/provider-fixtures.js";
import { splitStatements } from "../support/sql.js";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";

const id = (value: number) => String(value).padStart(26, "0");
const at = "2026-10-29T00:00:00.000000Z";
const run = {
  organization_id: id(1),
  run_id: id(2),
  project_id: id(3),
  environment_id: id(4),
  deployment_id: id(5),
  immutable_script_name: `p-${id(3)}-dev-${id(5)}`,
  cron: "*/5 * * * *",
  scheduled_at: at,
  state: "succeeded",
  attempt: 2,
  lease_until: null,
  started_at: at,
  finished_at: at,
  status_code: 200,
  egress_allowed_origins: '["https://api.example.com"]',
  created_at: at,
  updated_at: at,
};
const names = Object.keys(run);

/** Every real Core migration except the one under test, never a test-created parent-table stand-in. */
async function legacyControl() {
  const engine = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('private')}}",
    d1Databases: { CONTROL_CORE: "schedule-migration" },
  });
  const db = (await engine.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  const migration = migrationFiles("core").find(
    (file) => file.name === "0361_function_schedule_source_shape.sql",
  );
  if (migration === undefined) throw new Error("Schedule migration missing");
  try {
    // The legacy shape is the one before 0361; the later run-state rebuild (0651) would already replace that shape.
    for (const file of migrationFiles("core").filter(
      (file) => file.name !== migration.name && file.name !== "0651_function_run_skipped_state.sql",
    ))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    return { db, migration, stop: () => engine.dispose() };
  } catch (error) {
    await engine.dispose();
    throw error;
  }
}

async function oldSchedule(db: D1Database, cron = "*/5 * * * *") {
  const control: TestControl = {
    core: db,
    bindings: { CONTROL_CORE: db },
    directory: db,
    shards: { CONTROL_SHARD_0000: db },
    dispose: async () => undefined,
  };
  const project = await seedProject(control),
    claim = await seedProviderClaim(project, project.prodEnvironmentId),
    publication = await seedWfpPublication(project, { operationId: claim.operationId });
  await db
    .prepare(
      "INSERT INTO environment_function_schedules(organization_id,project_id,environment_id,deployment_id,candidate_receipt_id,immutable_script_name,crons,egress_allowed_origins,next_fire_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
    )
    .bind(
      project.organizationId,
      project.projectId,
      project.prodEnvironmentId,
      publication.deploymentId,
      publication.candidateReceiptId,
      `p-${project.projectId.toLowerCase()}-prod-${publication.deploymentId.toLowerCase()}`,
      JSON.stringify([cron]),
      '["https://z.example.test","https://a.example.test"]',
      "2026-10-28T11:00:00.123456Z",
      "2026-10-28T10:00:00.000000Z",
    )
    .run();
  return (await db.prepare("SELECT * FROM environment_function_schedules").all()).results;
}

it("preserves populated valid function-run bytes and rolls a late migration failure back with its schema", async () => {
  const control = await legacyControl();
  try {
    const { db } = control;
    const schedulesBefore = await oldSchedule(db);
    await db
      .prepare(
        `INSERT INTO function_runs(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
      )
      .bind(...Object.values(run))
      .run();
    const before = (await db.prepare("SELECT * FROM function_runs").all()).results;
    const statements = () => splitStatements(control.migration.sql).map((sql) => db.prepare(sql));
    await expect(
      db.batch([...statements(), guard(db, "precondition_changed", "1")]),
    ).rejects.toThrow("guard_precondition_changed");
    expect((await db.prepare("SELECT * FROM function_runs").all()).results).toEqual(before);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM sqlite_schema WHERE name='function_runs_global_id' OR name GLOB '*_0361*'",
        )
        .first(),
    ).toEqual({ n: 0 });
    expect(
      (await db.prepare("PRAGMA table_info(environment_function_schedules)").all()).results.find(
        (column) => column["name"] === "next_fire_at",
      )?.["notnull"],
    ).toBe(1);
    await db.batch(statements());
    expect((await db.prepare("SELECT * FROM function_runs").all()).results).toEqual(before);
    expect(
      (await db.prepare("SELECT * FROM environment_function_schedules").all()).results,
    ).toEqual(schedulesBefore);
    const columns = (await db.prepare("PRAGMA table_info(environment_function_schedules)").all())
      .results;
    expect(columns.find((column) => column["name"] === "next_fire_at")?.["notnull"]).toBe(0);
    await expect(
      db
        .prepare(
          `INSERT INTO function_runs(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
        )
        .bind(...Object.values({ ...run, organization_id: id(99) }))
        .run(),
    ).rejects.toThrow("UNIQUE");
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.stop();
  }
}, 120_000);

it("retains original PG18 run-shape refusals and refuses an invalid legacy row without erasing it", async () => {
  const control = await legacyControl();
  let pg: TestPostgres | undefined;
  try {
    pg = await startTestPostgres();
    const { db } = control;
    await db.batch(splitStatements(control.migration.sql).map((sql) => db.prepare(sql)));
    let counter = 20;
    for (const change of [
      { state: "running", lease_until: null, finished_at: null },
      { state: "succeeded", finished_at: null },
      { state: "due", finished_at: at },
      { attempt: 4 },
      { organization_id: "x".repeat(26) },
      { deployment_id: "not-an-ulid" },
      { egress_allowed_origins: '{"not":"an array"}' },
    ]) {
      const row = {
        ...run,
        ...change,
        run_id: id(++counter),
        scheduled_at: `2026-10-29T00:${String(counter).padStart(2, "0")}:00.000000Z`,
      };
      await expect(
        pg.pool.query(
          `INSERT INTO function_runs(${names.join(",")}) VALUES(${names.map((_, index) => `$${index + 1}`).join(",")})`,
          Object.values(row),
        ),
      ).rejects.toThrow();
      await expect(
        db
          .prepare(
            `INSERT INTO function_runs(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
          )
          .bind(...Object.values(row))
          .run(),
      ).rejects.toThrow();
    }
    await pg.pool.query(
      `INSERT INTO function_runs(${names.join(",")}) VALUES(${names.map((_, index) => `$${index + 1}`).join(",")})`,
      Object.values(run),
    );
    await db
      .prepare(
        `INSERT INTO function_runs(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
      )
      .bind(...Object.values(run))
      .run();
    expect(await db.prepare("SELECT count(*) n FROM function_runs").first()).toEqual({ n: 1 });
  } finally {
    await Promise.all([control.stop(), pg?.stop()]);
  }
  const invalid = await legacyControl();
  try {
    const row = { ...run, state: "running", lease_until: null, finished_at: null };
    await invalid.db
      .prepare(
        `INSERT INTO function_runs(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
      )
      .bind(...Object.values(row))
      .run();
    await expect(
      invalid.db.batch(
        splitStatements(invalid.migration.sql).map((sql) => invalid.db.prepare(sql)),
      ),
    ).rejects.toThrow("guard_precondition_changed");
    expect(
      await invalid.db.prepare("SELECT state,lease_until,finished_at FROM function_runs").first(),
    ).toEqual({ state: "running", lease_until: null, finished_at: null });
  } finally {
    await invalid.stop();
  }
}, 240_000);

it("refuses a prototype cron that original120 never admitted, without erasing its retained cursor or parents", async () => {
  const control = await legacyControl();
  try {
    const before = await oldSchedule(control.db, "* * * * *");
    await expect(
      control.db.batch(
        splitStatements(control.migration.sql).map((sql) => control.db.prepare(sql)),
      ),
    ).rejects.toThrow("guard_precondition_changed");
    expect(
      (await control.db.prepare("SELECT * FROM environment_function_schedules").all()).results,
    ).toEqual(before);
    expect(
      (
        await control.db.prepare("PRAGMA table_info(environment_function_schedules)").all()
      ).results.find((c) => c["name"] === "next_fire_at")?.["notnull"],
    ).toBe(1);
  } finally {
    await control.stop();
  }
}, 120000);
