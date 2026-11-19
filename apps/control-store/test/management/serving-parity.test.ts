import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import type { D1Database } from "../../src/d1-types.js";
import { splitStatements } from "../support/sql.js";
import { expect, it } from "vitest";
import { pgcfFixture, id } from "../../../neon-management/test/pgcf-runtime-fixture.js";
import {
  activateTestCore,
  createTestControl,
  migrationFiles,
  type TestControl,
} from "../support/control-d1.js";
import { rig } from "../support/pgcf-rig.js";

it("retains the original PGCF serving episode on a version-only change and preserves native microsecond/deletion semantics", async () => {
  const [control, pg] = await Promise.all([createTestControl(), pgcfFixture(false)]);
  try {
    const r = await rig(control, undefined, null),
      scope = [r.project.organizationId, r.project.projectId, r.physical];
    await pg.control.pool.query(
      "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference) VALUES($1,$2,$3,1,'pgcf',$4,$5,'us-dev','r512-s1g','ohmyho_rw_'||lower($3::ulid::text),'registry:fixture')",
      [id(1), id(2), id(4), r.providerProjectId, r.databaseId],
    );
    await pg.control.pool.query(
      "INSERT INTO database_provider_target_heads VALUES($1,$2,$3,1,'active','2026-10-28T09:20:00Z','2026-10-28T09:20:00Z')",
      [id(1), id(2), id(4)],
    );
    const nativeRows = async () =>
      (
        await pg.control.pool.query(
          "SELECT target_version::integer,provider_project_id,database_id,to_char(started_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') started_at,to_char(billable_from AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') billable_from,to_char(ended_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') ended_at FROM pgcf_database_serving_intervals ORDER BY started_at",
        )
      ).rows;
    const coreRows = async () =>
      (
        await control.core
          .prepare(
            "SELECT target_version,provider_project_id,database_id,started_at,billable_from,ended_at FROM pgcf_database_serving_intervals ORDER BY started_at",
          )
          .all()
      ).results;
    expect(await coreRows()).toEqual(await nativeRows());
    for (const [version, database, start] of [
      [2, r.databaseId, "2026-10-28T09:20:00.000000Z"],
      [3, "e" + "z".repeat(19), "2026-10-28T10:59:59.999999Z"],
    ] as const) {
      await pg.control.pool.query(
        "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference) VALUES($1,$2,$3,$4,'pgcf',$5,$6,'us-dev','r1g-s2g','ohmyho_rw_'||lower($3::ulid::text),'registry:fixture')",
        [id(1), id(2), id(4), version, r.providerProjectId, database],
      );
      await control.core
        .prepare(
          "INSERT INTO database_provider_target_revisions(organization_id,project_id,physical_environment_id,target_version,provider,provider_project_id,database_id,region_id,size_class_id,runtime_role,credential_reference,created_at) VALUES(?1,?2,?3,?4,'pgcf',?5,?6,'us-dev','r1g-s2g','ohmyho_rw_'||lower(?3),'registry:fixture',?7)",
        )
        .bind(...scope, version, r.providerProjectId, database, start)
        .run();
      await pg.control.pool.query(
        "UPDATE database_provider_target_heads SET target_version=$4,activated_at=$5,updated_at=$5 WHERE organization_id=$1 AND project_id=$2 AND physical_environment_id=$3",
        [id(1), id(2), id(4), version, start],
      );
      await control.core
        .prepare(
          "UPDATE database_provider_target_heads SET target_version=?4,activated_at=?5,updated_at=?5 WHERE organization_id=?1 AND project_id=?2 AND physical_environment_id=?3",
        )
        .bind(...scope, version, start)
        .run();
      expect(await coreRows()).toEqual(await nativeRows());
      if (version === 2) expect(await coreRows()).toHaveLength(1);
      else
        expect((await coreRows())[1]).toMatchObject({
          billable_from: "2026-10-28T11:00:00.000000Z",
        });
    }
    await pg.control.pool.query("DELETE FROM database_provider_target_heads");
    await control.core.prepare("DELETE FROM database_provider_target_heads").run();
    const native = await nativeRows(),
      core = await coreRows();
    expect(core.map((row) => ({ ...row, ended_at: typeof row["ended_at"] === "string" }))).toEqual(
      native.map((row) => ({ ...row, ended_at: typeof row["ended_at"] === "string" })),
    );
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
    await pg.control.stop();
  }
}, 120000);

it("applies the forward serving migration over populated history without changing facts or weakening foreign keys", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('ok')}}",
    d1Databases: { CONTROL_CORE: "serving-forward" },
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    for (const file of migrationFiles("core").filter((file) => file.name < "0351"))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    await activateTestCore(db);
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db },
      dispose: async () => undefined,
    };
    const r = await rig(control, undefined, null);
    const before = (
      await db.prepare("SELECT * FROM pgcf_database_serving_intervals ORDER BY started_at").all()
    ).results;
    await db.batch(
      splitStatements(
        readFileSync(
          new URL("../../migrations/core/0351_pgcf_serving_parity.sql", import.meta.url),
          "utf8",
        ),
      ).map((sql) => db.prepare(sql)),
    );
    expect(
      (await db.prepare("SELECT * FROM pgcf_database_serving_intervals ORDER BY started_at").all())
        .results,
    ).toEqual(before);
    expect(
      (await db.prepare("PRAGMA foreign_key_list(pgcf_database_serving_intervals)").all()).results,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "database_provider_target_revisions",
          from: "target_version",
          to: "target_version",
        }),
      ]),
    );
    await expect(
      db
        .prepare(
          "UPDATE pgcf_database_serving_intervals SET target_version=2 WHERE provider_project_id=?",
        )
        .bind(r.providerProjectId)
        .run(),
    ).rejects.toThrow("history is immutable");
    await expect(db.prepare("DELETE FROM pgcf_database_serving_intervals").run()).rejects.toThrow(
      "history is immutable",
    );
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 120000);
