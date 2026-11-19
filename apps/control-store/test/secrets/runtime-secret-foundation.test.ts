import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { createTestControl, migrationFiles, type TestControl } from "../support/control-d1.js";
import { seedProject, ulidOf, STORED_NOW } from "../support/platform-fixtures.js";
import { splitStatements } from "../support/sql.js";
import type { D1Database } from "../../src/d1-types.js";
import { pgcfFixture, id } from "../../../neon-management/test/pgcf-runtime-fixture.js";

it("preserves original secret-state and receipt columns and state constraints on real PostgreSQL18 and D1", async () => {
  const [control, pg] = await Promise.all([createTestControl(), pgcfFixture(false)]);
  try {
    const p = await seedProject(control);
    for (const table of ["runtime_secret_delivery_states", "runtime_secret_delivery_receipts"]) {
      const source = await pg.control.pool.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",
        [table],
      );
      const target = (await control.core.prepare(`PRAGMA table_info(${table})`).all()).results;
      // The sweeper's attempt stamp is the one column added on Core only (migration 0650); every other column keeps its original shape.
      const addedOnCore = new Set(["last_attempted_at"]);
      expect(target.map((r) => r["name"]).filter((name) => !addedOnCore.has(String(name)))).toEqual(
        source.rows.map((r) => r.column_name),
      );
    }
    const target = async (assignment: string) =>
      control.core
        .prepare(
          `UPDATE runtime_secret_delivery_states SET ${assignment} WHERE organization_id=?1 AND environment_id=?2`,
        )
        .bind(p.organizationId, p.devEnvironmentId)
        .run();
    const source = async (assignment: string) =>
      pg.control.pool.query(
        `UPDATE runtime_secret_delivery_states SET ${assignment} WHERE organization_id=$1 AND environment_id=$2`,
        [id(1), id(4)],
      );
    for (const assignment of [
      "applied_generation=1",
      "next_release_sequence=0",
      "provider_tag='bad tag'",
      "active_lease_id='not-a-ulid'",
    ])
      for (const update of [target, source]) await expect(update(assignment)).rejects.toThrow();
    for (const update of [target, source]) {
      await update("desired_generation=3,next_release_sequence=5");
      await expect(update("desired_generation=2")).rejects.toThrow("monotonic");
      // The original trigger protects generations, not the next release sequence. Preserve that distinction.
      await update("next_release_sequence=4");
    }
    const lease = ulidOf("secret-lease", 1);
    await expect(
      target(
        `active_lease_id='${lease}',claimed_release_sequence=1,claimed_generation=NULL,claimed_trigger='deploy',claimed_at='${STORED_NOW}',lease_expires_at='2026-10-28T10:02:00.000000Z'`,
      ),
    ).rejects.toThrow();
    await expect(
      source(
        `active_lease_id='${lease}',claimed_release_sequence=1,claimed_generation=NULL,claimed_trigger='deploy',claimed_at='${STORED_NOW}',lease_expires_at='2026-10-28T10:02:00.000000Z'`,
      ),
    ).rejects.toThrow();
    const receipt = ulidOf("receipt-domain", 1),
      receiptLease = ulidOf("receipt-domain-lease", 1);
    const writeTarget = (organization: string) =>
      control.core
        .prepare(
          `INSERT INTO runtime_secret_delivery_receipts(receipt_id,organization_id,project_id,environment_id,lease_id,generation,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,completed_at,release_sequence) VALUES(?1,?2,?3,?4,?5,0,'deploy','source','[]',zeroblob(32),0,?6,1)`,
        )
        .bind(receipt, organization, p.projectId, p.devEnvironmentId, receiptLease, STORED_NOW)
        .run();
    const writeSource = (organization: string) =>
      pg.control.pool.query(
        "INSERT INTO runtime_secret_delivery_receipts(receipt_id,organization_id,project_id,environment_id,lease_id,generation,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,completed_at,release_sequence) VALUES($1,$2,$3,$4,$5,0,'deploy','source','{}',decode(repeat('00',32),'hex'),0,$6,1)",
        [receipt, organization, id(2), id(4), receiptLease, STORED_NOW],
      );
    for (const write of [writeTarget, writeSource]) {
      await expect(write("not-a-ulid")).rejects.toThrow();
      // A valid historical organization is not forced to be the environment's current owner or a current mapping.
      await write(ulidOf("historical-receipt-organization", 1));
    }
    expect((await control.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await control.dispose();
    await pg.control.stop();
  }
}, 120_000);

it("upgrades populated secret states byte-exactly and rolls back both data and DDL on a late failure", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('private')}}",
    d1Databases: { CONTROL_CORE: "secrets-forward" },
  });
  try {
    const db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database;
    const files = migrationFiles("core"),
      migration = files.find((f) => f.name.startsWith("0370_"));
    if (!migration) throw new Error("Secret foundation migration missing");
    for (const f of files.filter((f) => f.name < migration.name))
      await db.batch(splitStatements(f.sql).map((s) => db.prepare(s)));
    const control: TestControl = {
      core: db,
      directory: db,
      bindings: { CONTROL_CORE: db },
      shards: { CONTROL_SHARD_0000: db },
      dispose: async () => undefined,
    };
    const p = await seedProject(control);
    // The prototype admitted an original-invalid sequence. Refuse it atomically; never repair retained data.
    await db.prepare("UPDATE runtime_secret_delivery_states SET next_release_sequence=0").run();
    await expect(
      db.batch(splitStatements(migration.sql).map((s) => db.prepare(s))),
    ).rejects.toThrow("CHECK");
    expect(
      await db
        .prepare("SELECT min(next_release_sequence) n FROM runtime_secret_delivery_states")
        .first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM sqlite_schema WHERE name='runtime_secret_delivery_receipts'",
        )
        .first(),
    ).toEqual({ n: 0 });
    // A separate valid fixture continues the populated byte-preservation proof.
    await db.prepare("UPDATE runtime_secret_delivery_states SET next_release_sequence=1").run();

    await db
      .prepare(
        "UPDATE runtime_secret_delivery_states SET desired_generation=CAST(?1 AS INTEGER),next_release_sequence=CAST(?2 AS INTEGER) WHERE organization_id=?3",
      )
      .bind("9007199254740993", "9007199254740994", p.organizationId)
      .run();
    const rows = async () =>
      (
        await db
          .prepare(
            "SELECT environment_id,CAST(desired_generation AS TEXT) desired,CAST(next_release_sequence AS TEXT) next,hex(applied_manifest_sha256) digest,applied_secret_names,created_at,updated_at FROM runtime_secret_delivery_states ORDER BY environment_id",
          )
          .all()
      ).results;
    const before = await rows();
    await expect(
      db.batch([
        ...splitStatements(migration.sql).map((s) => db.prepare(s)),
        db.prepare("INSERT INTO guard_fail(code) VALUES('claim_lost')"),
      ]),
    ).rejects.toThrow();
    expect(await rows()).toEqual(before);
    expect(
      await db
        .prepare(
          "SELECT count(*) n FROM sqlite_schema WHERE name='runtime_secret_delivery_receipts'",
        )
        .first(),
    ).toEqual({ n: 0 });
    await db.batch(splitStatements(migration.sql).map((s) => db.prepare(s)));
    expect(await rows()).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await mf.dispose();
  }
}, 120_000);

it("keeps delivery receipt identity global, preserves bytes and restricts deletion of the stable environment", async () => {
  const control = await createTestControl();
  try {
    const p = await seedProject(control),
      other = await seedProject(control),
      db = control.core;
    const insert = (
      scope: typeof p,
      receipt: string,
      lease: string,
      environment = scope.devEnvironmentId,
    ) =>
      db
        .prepare(
          `INSERT INTO runtime_secret_delivery_receipts(receipt_id,organization_id,project_id,environment_id,lease_id,generation,trigger,provider_tag,applied_secret_names,manifest_sha256,manifest_secret_count,completed_at,release_sequence) VALUES(?1,?2,?3,?4,?5,0,'deploy','source:exact','["A","B"]',x'${"ab".repeat(32)}',2,?6,1)`,
        )
        .bind(receipt, scope.organizationId, scope.projectId, environment, lease, STORED_NOW)
        .run();
    const receipt = ulidOf("secret-receipt", 1);
    await insert(p, receipt, ulidOf("secret-lease", 1));
    await expect(insert(other, receipt, ulidOf("secret-lease", 2))).rejects.toThrow("UNIQUE");
    await expect(
      insert(other, ulidOf("secret-receipt", 2), ulidOf("secret-lease", 3), p.devEnvironmentId),
    ).rejects.toThrow("FOREIGN KEY");
    expect(
      await db
        .prepare(
          "SELECT lower(hex(manifest_sha256)) digest,applied_secret_names FROM runtime_secret_delivery_receipts WHERE receipt_id=?",
        )
        .bind(receipt)
        .first(),
    ).toEqual({ digest: "ab".repeat(32), applied_secret_names: '["A","B"]' });
    await expect(
      db
        .prepare("DELETE FROM runtime_secret_delivery_receipts WHERE receipt_id=?")
        .bind(receipt)
        .run(),
    ).rejects.toThrow("append-only");
    await expect(
      db
        .prepare(
          "UPDATE runtime_secret_delivery_receipts SET provider_tag='changed' WHERE receipt_id=?",
        )
        .bind(receipt)
        .run(),
    ).rejects.toThrow("append-only");
    await expect(
      db
        .prepare("DELETE FROM environment_identities WHERE environment_id=?")
        .bind(p.devEnvironmentId)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
  } finally {
    await control.dispose();
  }
});
