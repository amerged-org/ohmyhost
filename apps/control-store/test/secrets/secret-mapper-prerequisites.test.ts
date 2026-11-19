import { expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "../../src/d1-types.js";
import { guard } from "../../src/guards.js";
import { migrationFiles, createTestControl, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import { acceptedSecretFixture } from "./runtime-secret-fixture.js";
import { seedOriginalGateway } from "../gateway/pg-gateway.fixture.js";
import { newUlid } from "../../src/catalog/common.js";
import { startTestPostgres } from "../../../control-api/test/postgres.js";

async function legacy() {
  const engine = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('private')}}",
      d1Databases: { CONTROL_CORE: "secret-history" },
    }),
    db = (await engine.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  const migration = migrationFiles("core").find(
    (f) => f.name === "0373_environment_secret_request_history.sql",
  );
  if (!migration) throw new Error("Missing request migration");
  try {
    // This replays 0373 alone on the pre-0373 table; 0701 (the rotate receipt action) rebuilds that table later, so it stays out.
    for (const f of migrationFiles("core").filter(
      (f) => f.name !== migration.name && !f.name.startsWith("0701_"),
    ))
      await db.batch(splitStatements(f.sql).map((sql) => db.prepare(sql)));
    return {
      db,
      apply: () => splitStatements(migration.sql).map((sql) => db.prepare(sql)),
      control: {
        core: db,
        bindings: { CONTROL_CORE: db },
        directory: db,
        shards: { CONTROL_SHARD_0000: db },
        dispose: () => engine.dispose(),
      } satisfies TestControl,
    };
  } catch (e) {
    await engine.dispose();
    throw e;
  }
}
const at = "2026-10-28T10:01:00.123456Z",
  done = "2026-10-28T10:02:00.123456Z";
const requestSql =
  "INSERT INTO environment_secret_requests(organization_id,project_id,environment_id,action,name,idempotency_key,request_sha256,response,requested_at,completed_at) VALUES(?1,?2,?3,'set','OLD',?4,unhex(?5),?6,?7,?8)";
it("preserves populated request bytes/DDL on late rollback and admits exact original pending and unmapped historical scope", async () => {
  const l = await legacy(),
    pg = await startTestPostgres();
  try {
    const r = await acceptedSecretFixture(l.control);
    await seedOriginalGateway(pg, r);
    const original = [
      r.scope.organizationId,
      r.scope.projectId,
      r.scope.environmentId,
      "original",
      "03".repeat(32),
      '{"z":9007199254740993,"status":"deleted","name":"OLD"}',
      at,
      done,
    ];
    await l.db
      .prepare(requestSql)
      .bind(...original)
      .run();
    const before = (await l.db.prepare("SELECT * FROM environment_secret_requests").all()).results;
    await expect(
      l.db.batch([...l.apply(), guard(l.db, "precondition_changed", "1")]),
    ).rejects.toThrow("guard_precondition_changed");
    expect((await l.db.prepare("SELECT * FROM environment_secret_requests").all()).results).toEqual(
      before,
    );
    expect(
      (await l.db.prepare("PRAGMA table_info(environment_secret_requests)").all()).results.find(
        (c) => c["name"] === "response",
      )?.["notnull"],
    ).toBe(1);
    await l.db.batch(l.apply());
    expect((await l.db.prepare("SELECT * FROM environment_secret_requests").all()).results).toEqual(
      before,
    );
    const history = [
      newUlid(),
      r.scope.projectId,
      r.scope.environmentId,
      "retained-history",
      "04".repeat(32),
      null,
      at,
      null,
    ];
    await l.db
      .prepare(requestSql)
      .bind(...history)
      .run();
    const native = requestSql
      .replaceAll(/\?([0-9]+)/g, (_, n: string) => `$${n}`)
      .replace("unhex($5)", "decode($5,'hex')");
    await pg.pool.query(native, history);
    expect(
      await l.db
        .prepare(
          "SELECT organization_id,response,completed_at FROM environment_secret_requests WHERE idempotency_key='retained-history'",
        )
        .first(),
    ).toEqual({ organization_id: history[0], response: null, completed_at: null });
    for (const changed of [
      { index: 5, value: "[]" },
      { index: 5, value: "{}" },
      { index: 3, value: " padded " },
      { index: 7, value: done },
    ]) {
      const row = [...history];
      row[3] = newUlid();
      row[changed.index] = changed.value;
      await expect(
        l.db
          .prepare(requestSql)
          .bind(...row)
          .run(),
      ).rejects.toThrow();
      await expect(pg.pool.query(native, row)).rejects.toThrow();
    }
    expect((await l.db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await Promise.all([l.control.dispose(), pg.stop()]);
  }
}, 240000);
it("refuses source-invalid prototype response facts without deleting or normalizing them", async () => {
  const l = await legacy();
  try {
    const r = await acceptedSecretFixture(l.control),
      row = [
        r.scope.organizationId,
        r.scope.projectId,
        r.scope.environmentId,
        "invalid-prototype",
        "03".repeat(32),
        "[]",
        at,
        done,
      ];
    await l.db
      .prepare(requestSql)
      .bind(...row)
      .run();
    const before = (await l.db.prepare("SELECT * FROM environment_secret_requests").all()).results;
    await expect(l.db.batch(l.apply())).rejects.toThrow();
    expect((await l.db.prepare("SELECT * FROM environment_secret_requests").all()).results).toEqual(
      before,
    );
  } finally {
    await l.control.dispose();
  }
}, 120000);
it("retains the exact native immutable cleanup-resource expectation fields and static parents", async () => {
  const [control, pg] = await Promise.all([createTestControl(), startTestPostgres()]);
  try {
    const r = await acceptedSecretFixture(control);
    await seedOriginalGateway(pg, r);
    const request = newUlid();
    await control.core
      .prepare(
        "INSERT INTO wfp_candidate_cleanup_requests(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at) VALUES(?1,?2,?3,?4,?5,'failed',?6)",
      )
      .bind(
        request,
        r.published.candidateReceiptId,
        r.scope.organizationId,
        r.scope.projectId,
        r.operationId,
        at,
      )
      .run();
    await pg.pool.query(
      "INSERT INTO wfp_candidate_cleanup_requests(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,reason,requested_at) VALUES($1,$2,$3,$4,$5,'failed',$6)",
      [
        request,
        r.published.candidateReceiptId,
        r.scope.organizationId,
        r.scope.projectId,
        r.operationId,
        at,
      ],
    );
    const row = [
        request,
        r.published.candidateReceiptId,
        r.scope.organizationId,
        r.scope.projectId,
        r.operationId,
        "cloudflare",
        "build-artifact",
        "03".repeat(32),
      ],
      sql =
        "INSERT INTO wfp_candidate_cleanup_resource_expectations(cleanup_request_id,candidate_receipt_id,organization_id,project_id,operation_id,provider,resource_kind,resource_identity_sha256) VALUES(?1,?2,?3,?4,?5,?6,?7,unhex(?8))",
      native = sql
        .replaceAll(/\?([0-9]+)/g, (_, n: string) => `$${n}`)
        .replace("unhex($8)", "decode($8,'hex')");
    for (const [index, value] of [
      [5, "aws"],
      [6, "database"],
      [0, newUlid()],
      [7, "03".repeat(31)],
    ] as const) {
      const bad = [...row];
      bad[index] = value;
      await expect(
        control.core
          .prepare(sql)
          .bind(...bad)
          .run(),
      ).rejects.toThrow();
      await expect(pg.pool.query(native, bad)).rejects.toThrow();
    }
    await control.core
      .prepare(sql)
      .bind(...row)
      .run();
    await pg.pool.query(native, row);
    expect(
      await control.core
        .prepare(
          "SELECT lower(hex(resource_identity_sha256)) hash,provider,resource_kind FROM wfp_candidate_cleanup_resource_expectations",
        )
        .first(),
    ).toEqual(
      (
        await pg.pool.query(
          "SELECT encode(resource_identity_sha256,'hex') hash,provider,resource_kind FROM wfp_candidate_cleanup_resource_expectations",
        )
      ).rows[0],
    );
    await expect(
      control.core.prepare("DELETE FROM wfp_candidate_cleanup_resource_expectations").run(),
    ).rejects.toThrow("append-only");
    await expect(
      pg.pool.query("DELETE FROM wfp_candidate_cleanup_resource_expectations"),
    ).rejects.toThrow();
  } finally {
    await Promise.all([control.dispose(), pg.stop()]);
  }
}, 240000);
