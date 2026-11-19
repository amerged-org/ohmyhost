import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { Buffer } from "node:buffer";
import { startTestPostgres, type TestPostgres } from "../../../control-api/test/postgres.js";
import type { D1Database } from "../../src/d1-types.js";
import { newUlid } from "../../src/catalog/common.js";
import { guard } from "../../src/guards.js";
import { createTestControl, migrationFiles, type TestControl } from "../support/control-d1.js";
import { splitStatements } from "../support/sql.js";
import {
  ATTEMPT_TABLES,
  AT,
  hash,
  attemptColumns,
  attemptFacts,
  seedAttemptGraph,
  observation,
  reconciliation,
  replay,
  failure,
  insertAttemptBoth,
  insertAttemptCore,
  insertAttemptNative,
  type AttemptGraph,
  type AttemptRow,
  type AttemptTable,
} from "./attempt-schema.fixture.js";

let pg: TestPostgres, control: TestControl, r: AttemptGraph;
beforeAll(async () => {
  [pg, control] = await Promise.all([startTestPostgres(), createTestControl()]);
  r = await seedAttemptGraph(control, pg);
}, 60_000);
afterAll(async () => {
  await Promise.allSettled([control?.dispose(), pg?.stop()]);
});

async function paired(r: AttemptGraph, table: AttemptTable, row: AttemptRow, accepted: boolean) {
  let native = true,
    core = true;
  try {
    await insertAttemptNative(r.pg, table, row);
  } catch {
    native = false;
  }
  try {
    await insertAttemptCore(r.db, table, row);
  } catch {
    core = false;
  }
  expect(
    { native, core },
    table + ":" + String(row["observation_id"] ?? row["attempt_id"] ?? row["failure_id"]),
  ).toEqual({ native: accepted, core: accepted });
}

it("preserves all four original table shapes, native32 budgets, byte/int4/domain semantics and immutable historical evidence", async () => {
  for (const [index, table] of ATTEMPT_TABLES.entries()) {
    const source = await attemptColumns(pg, table),
      target = (await r.db.prepare(`PRAGMA table_info(${table})`).all()).results;
    expect(source.length).toBe([30, 19, 14, 9][index]);
    expect(target.map((column) => column["name"])).toEqual(
      source.map((column) => column.column_name),
    );
    const nativeKeys = (
      await pg.pool.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u')",
        [table],
      )
    ).rows.map((row) =>
      row.definition
        .slice(row.definition.indexOf("(") + 1, row.definition.indexOf(")"))
        .replaceAll(" ", ""),
    );
    const coreKeys = [];
    for (const key of (await r.db.prepare(`PRAGMA index_list(${table})`).all()).results.filter(
      (index) => index["unique"] === 1,
    ))
      coreKeys.push(
        (await r.db.prepare(`PRAGMA index_info(${String(key["name"])})`).all()).results
          .map((column) => column["name"])
          .join(","),
      );
    expect(coreKeys.sort()).toEqual(nativeKeys.sort());
    const foreign = (await r.db.prepare(`PRAGMA foreign_key_list(${table})`).all()).results;
    expect(
      foreign.some(
        (fk) =>
          fk["table"] === "product_provider_mutation_claims" ||
          fk["table"] === "product_workflow_runs",
      ),
    ).toBe(false);
  }
  const original = observation(r);
  await insertAttemptBoth(r, ATTEMPT_TABLES[0], original);
  await insertAttemptBoth(r, ATTEMPT_TABLES[1], reconciliation(r, original));
  for (const [index, mode] of ["retry", "abandon"].entries())
    await insertAttemptBoth(r, ATTEMPT_TABLES[1], {
      ...reconciliation(r, original),
      mode,
      outcome: "unknown",
      idempotency_sha256: hash(11 + index),
    });
  const replayed = replay(r);
  await insertAttemptBoth(r, ATTEMPT_TABLES[2], replayed);
  await insertAttemptBoth(r, ATTEMPT_TABLES[3], failure(r, replayed));
  await paired(r, ATTEMPT_TABLES[0], observation(r, 32), true);
  // Preserve native CHECK's three-valued NULL semantics; unknown may carry opaque historical facts.
  await paired(
    r,
    ATTEMPT_TABLES[0],
    {
      ...observation(r, 1),
      wfp_state: "ready",
      wfp_provider_tag: "opaque",
      wfp_product_deployment_id: newUlid(),
      wfp_artifact_sha256: null,
    },
    true,
  );
  await paired(
    r,
    ATTEMPT_TABLES[0],
    {
      ...observation(r, 2),
      wfp_artifact_sha256: new Uint8Array([1]),
      gateway_provider_tag: "opaque retained tag",
    },
    true,
  );
  let number = 3;
  for (const phase of [
    "source",
    "build",
    "database",
    "runtime-secrets",
    "storage",
    "gateway",
    "wfp",
  ])
    await paired(r, ATTEMPT_TABLES[0], { ...observation(r, number++), hint_phase: phase }, true);
  for (const patch of [
    { attempt_number: 0 },
    { attempt_number: 33 },
    { mode: "invented" },
    { outcome: "invented" },
    { mode: "retry", outcome: "resolved_absent" },
    { mode: "abandon", outcome: "prepared" },
    { idempotency_sha256: new Uint8Array(31) },
    { physical_workflow_id: " leading-space" },
  ])
    await paired(
      r,
      ATTEMPT_TABLES[1],
      { ...reconciliation(r, original), idempotency_sha256: hash(40), ...patch },
      false,
    );
  for (const patch of [
    { attempt_number: 33 },
    { attempt_number: -1 },
    { accepted_lifecycle_version: 2147483648 },
    { accepted_lifecycle_version: 0 },
    { evidence_sha256: new Uint8Array(31) },
    { expected_artifact_sha256: new Uint8Array(33) },
    { observation_kind: "invented" },
    { hint_phase: "container" },
    { source_state: "invented" },
    { build_state: "invented" },
    { gateway_state: "ready", gateway_provider_tag: null },
    { wfp_state: "absent", wfp_provider_tag: "still exists" },
    {
      wfp_state: "ready",
      wfp_provider_tag: "tag",
      wfp_product_deployment_id: newUlid(),
      wfp_artifact_sha256: new Uint8Array(31),
    },
    { actor_id: " leading-space" },
    { actor_id: "x".repeat(256) },
    { actor_id: "x\0tail" },
    { hint_product_deployment_id: "8" + "0".repeat(25) },
    { hint_product_deployment_id: "0".repeat(26) + "\0" },
    { created_at: "2026-13-28T12:00:00.123456Z" },
    { created_at: "2026-02-30T12:00:00.123456Z" },
    { created_at: "2026-10-28T12:00:00.abc456Z" },
    { created_at: "2026-10-28T1x:00:00.000001Z" },
    { created_at: "2026-10-28T12:2x:00.000001Z" },
  ])
    await paired(r, ATTEMPT_TABLES[0], { ...observation(r, 20), ...patch }, false);
  // PostgreSQL accepts this literal alias, but captures render its stored instant as canonical UTC6.
  const alias: AttemptRow = { ...observation(r, 21), created_at: "2026-10-28T12:00:4x.000001Z" };
  await insertAttemptNative(pg, ATTEMPT_TABLES[0], alias);
  const canonical = (
    await pg.pool.query<{ stamp: string }>(
      "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS stamp FROM product_provider_mutation_observations WHERE observation_id=$1",
      [alias["observation_id"]],
    )
  ).rows[0]?.stamp;
  if (canonical === undefined) throw new Error("Native canonical instant missing");
  expect(canonical).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u);
  await expect(insertAttemptCore(r.db, ATTEMPT_TABLES[0], alias)).rejects.toThrow();
  await insertAttemptCore(r.db, ATTEMPT_TABLES[0], { ...alias, created_at: canonical });
  for (const patch of [
    { attempt_number: 0 },
    { attempt_number: 33 },
    { event_type: "DeploymentRequestedV1" },
    { idempotency_sha256: new Uint8Array(31) },
    { logical_workflow_id: " trailing " },
    { actor_id: "" },
  ])
    await paired(
      r,
      ATTEMPT_TABLES[2],
      { ...replay(r), idempotency_sha256: hash(41), ...patch },
      false,
    );
  for (const table of ATTEMPT_TABLES) {
    const facts = await attemptFacts(r, table);
    expect(facts.core).toEqual(facts.native);
    const key = table.endsWith("observations")
      ? "observation_id"
      : table.endsWith("failures")
        ? "failure_id"
        : "attempt_id";
    for (const sql of [
      `UPDATE ${table} SET created_at=created_at WHERE ${key}=?`,
      `DELETE FROM ${table} WHERE ${key}=?`,
    ]) {
      const id = facts.core[0]?.[key];
      expect(id).toBeTypeOf("string");
      await expect(r.db.prepare(sql).bind(id).run()).rejects.toThrow("append-only");
      await expect(pg.pool.query(sql.replace("?", "$1"), [id])).rejects.toThrow("append-only");
    }
  }
}, 120_000);

it("retains exact11/9/5-part identities, global uniqueness and original terminal or exact-abandon claim deletion", async () => {
  const nine = [
    "active_replay_attempt_id",
    "workflow_id",
    "event_id",
    "organization_id",
    "project_id",
    "environment_id",
    "operation_id",
    "billing_epoch_id",
    "event_type",
  ];
  for (const kind of ["replay", "reconciliation"]) {
    const fks = (await r.db.prepare("PRAGMA foreign_key_list(product_workflow_runs)").all()).results
      .filter(
        (fk) =>
          fk["table"] ===
          `product_${kind === "replay" ? "workflow_replay" : "provider_reconciliation"}_attempts`,
      )
      .sort((a, b) => Number(a["seq"]) - Number(b["seq"]));
    expect(fks.map((fk) => fk["from"])).toEqual(
      nine.map((field) =>
        field === "active_replay_attempt_id" ? `active_${kind}_attempt_id` : field,
      ),
    );
    expect(fks.every((fk) => fk["on_delete"] === "RESTRICT")).toBe(true);
  }
  const observationKey = (
    await r.db.prepare("PRAGMA foreign_key_list(product_provider_reconciliation_attempts)").all()
  ).results.sort((a, b) => Number(a["seq"]) - Number(b["seq"]));
  expect(observationKey.map((fk) => fk["from"])).toEqual([
    "observation_id",
    "claim_id",
    "organization_id",
    "project_id",
    "environment_id",
    "operation_id",
    "event_id",
    "billing_epoch_id",
    "logical_workflow_id",
    "event_type",
    "accepted_lifecycle_version",
  ]);
  expect(
    observationKey.every(
      (fk) =>
        fk["table"] === "product_provider_mutation_observations" && fk["on_delete"] === "RESTRICT",
    ),
  ).toBe(true);
  const replayRow = replay(r);
  const physicalWorkflowId = replayRow["physical_workflow_id"];
  if (typeof physicalWorkflowId !== "string")
    throw new Error("Actual replay physical identity missing");
  await insertAttemptBoth(r, ATTEMPT_TABLES[2], { ...replayRow, idempotency_sha256: hash(20) });
  for (const [index, column] of [
    "logical_workflow_id",
    "event_id",
    "organization_id",
    "project_id",
    "environment_id",
    "operation_id",
    "billing_epoch_id",
    "event_type",
  ].entries()) {
    const row = {
      ...replay(r),
      idempotency_sha256: hash(30 + index),
      [column]:
        column === "logical_workflow_id"
          ? "different-logical"
          : column === "event_type"
            ? "SourceLinkRequestedV1"
            : newUlid(),
    };
    await insertAttemptBoth(r, ATTEMPT_TABLES[2], row);
    await expect(
      r.db
        .prepare("UPDATE product_workflow_runs SET active_replay_attempt_id=? WHERE workflow_id=?")
        .bind(row["attempt_id"], r.workflowId)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
    await expect(
      pg.pool.query(
        "UPDATE product_workflow_runs SET active_replay_attempt_id=$1 WHERE workflow_id=$2",
        [row["attempt_id"], r.workflowId],
      ),
    ).rejects.toThrow("foreign key");
  }
  await r.db
    .prepare("UPDATE product_workflow_runs SET active_replay_attempt_id=? WHERE workflow_id=?")
    .bind(replayRow["attempt_id"], r.workflowId)
    .run();
  await pg.pool.query(
    "UPDATE product_workflow_runs SET active_replay_attempt_id=$1 WHERE workflow_id=$2",
    [replayRow["attempt_id"], r.workflowId],
  );
  await paired(
    r,
    ATTEMPT_TABLES[2],
    {
      ...replay(r),
      physical_workflow_id: physicalWorkflowId,
      idempotency_sha256: hash(55),
    },
    false,
  );
  const failed = failure(r, replayRow);
  for (const field of [
    "attempt_id",
    "organization_id",
    "operation_id",
    "physical_workflow_id",
    "actor_id",
  ])
    await paired(
      r,
      ATTEMPT_TABLES[3],
      {
        ...failed,
        failure_id: newUlid(),
        [field]:
          field === "actor_id"
            ? "wrong actor"
            : field === "physical_workflow_id"
              ? "wrong physical"
              : newUlid(),
      },
      false,
    );
  await insertAttemptBoth(r, ATTEMPT_TABLES[3], failed);
  await paired(r, ATTEMPT_TABLES[3], { ...failed, failure_id: newUlid() }, false);
  await expect(
    r.db
      .prepare(
        "UPDATE product_provider_mutation_claims SET accepted_lifecycle_version=accepted_lifecycle_version WHERE claim_id=?",
      )
      .bind(r.claimId)
      .run(),
  ).rejects.toThrow("append-only");
  await expect(
    pg.pool.query(
      "UPDATE product_provider_mutation_claims SET accepted_lifecycle_version=accepted_lifecycle_version WHERE claim_id=$1",
      [r.claimId],
    ),
  ).rejects.toThrow("append-only");
  for (const state of ["running", "cancelled"]) {
    await r.db
      .prepare("UPDATE operations SET state=? WHERE operation_id=?")
      .bind(state, r.operationId)
      .run();
    await pg.pool.query("UPDATE operations SET state=$1 WHERE operation_id=$2", [
      state,
      r.operationId,
    ]);
    await expect(
      r.db
        .prepare("DELETE FROM product_provider_mutation_claims WHERE claim_id=?")
        .bind(r.claimId)
        .run(),
    ).rejects.toThrow("active product provider");
    await expect(
      pg.pool.query("DELETE FROM product_provider_mutation_claims WHERE claim_id=$1", [r.claimId]),
    ).rejects.toThrow("active product provider");
  }
  await r.db
    .prepare("UPDATE operations SET state='failed' WHERE operation_id=?")
    .bind(r.operationId)
    .run();
  await pg.pool.query("UPDATE operations SET state='failed' WHERE operation_id=$1", [
    r.operationId,
  ]);
  await r.db
    .prepare("DELETE FROM product_provider_mutation_claims WHERE claim_id=?")
    .bind(r.claimId)
    .run();
  await pg.pool.query("DELETE FROM product_provider_mutation_claims WHERE claim_id=$1", [
    r.claimId,
  ]);
  const abandoned = await seedAttemptGraph(control, pg),
    obs = observation(abandoned);
  await insertAttemptBoth(abandoned, ATTEMPT_TABLES[0], obs);
  await insertAttemptBoth(abandoned, ATTEMPT_TABLES[1], {
    ...reconciliation(abandoned, obs),
    mode: "abandon",
    outcome: "resolved_absent",
  });
  const priorClaim = await abandoned.db
    .prepare("SELECT * FROM product_provider_mutation_claims WHERE claim_id=?")
    .bind(abandoned.claimId)
    .first();
  if (priorClaim === null) throw new Error("Actual abandon claim missing");
  await abandoned.db
    .prepare("DELETE FROM product_provider_mutation_claims WHERE claim_id=?")
    .bind(abandoned.claimId)
    .run();
  await pg.pool.query("DELETE FROM product_provider_mutation_claims WHERE claim_id=$1", [
    abandoned.claimId,
  ]);
  // Old abandon evidence may not authorize a later current claim with a changed immutable identity field.
  const later = { ...priorClaim, accepted_lifecycle_version: 1 },
    keys = Object.keys(later),
    values = keys.map((key) => later[key as keyof typeof later]);
  await abandoned.db
    .prepare(
      `INSERT INTO product_provider_mutation_claims(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
    )
    .bind(...values)
    .run();
  await pg.pool.query(
    `INSERT INTO product_provider_mutation_claims(${keys.join(",")}) VALUES(${keys.map((_, index) => "$" + String(index + 1)).join(",")})`,
    values,
  );
  await expect(
    abandoned.db
      .prepare("DELETE FROM product_provider_mutation_claims WHERE claim_id=?")
      .bind(abandoned.claimId)
      .run(),
  ).rejects.toThrow("active product provider");
  await expect(
    pg.pool.query("DELETE FROM product_provider_mutation_claims WHERE claim_id=$1", [
      abandoned.claimId,
    ]),
  ).rejects.toThrow("active product provider");
  await abandoned.db
    .prepare("UPDATE operations SET state='succeeded' WHERE operation_id=?")
    .bind(abandoned.operationId)
    .run();
  await pg.pool.query("UPDATE operations SET state='succeeded' WHERE operation_id=$1", [
    abandoned.operationId,
  ]);
  await abandoned.db
    .prepare("DELETE FROM product_provider_mutation_claims WHERE claim_id=?")
    .bind(abandoned.claimId)
    .run();
  await pg.pool.query("DELETE FROM product_provider_mutation_claims WHERE claim_id=$1", [
    abandoned.claimId,
  ]);
  for (const table of ATTEMPT_TABLES)
    expect((await attemptFacts(r, table)).core).toEqual((await attemptFacts(r, table)).native);
}, 120_000);

it("preserves populated run/claim bytes and physical children through atomic late rollback and imports actual claim-free native history", async () => {
  const mf = new Miniflare({
      modules: true,
      script: "export default {fetch(){return new Response('unserved')}}",
      d1Databases: { CONTROL_CORE: "attempt-forward" },
    }),
    db = (await mf.getD1Database("CONTROL_CORE")) as unknown as D1Database;
  try {
    for (const file of migrationFiles("core").filter((file) => file.name < "0453"))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    const old: TestControl = {
        core: db,
        directory: db,
        bindings: { CONTROL_CORE: db },
        shards: { CONTROL_SHARD_0000: db },
        dispose: () => mf.dispose(),
      },
      source = await seedAttemptGraph(old, pg),
      obs = observation(source),
      recon = reconciliation(source, obs),
      replayed = replay(source),
      failed = failure(source, replayed);
    //0353 requires the real physical data identity. Retain the native environment-initializer
    // fact instead of treating the logical Dev ID as its physical parent.
    const physical = (
      await pg.pool.query<{ data_environment_id: string; created_at: string }>(
        `SELECT data.data_environment_id,to_char(data.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at
       FROM project_data_environments data JOIN environment_data_assignments assignment USING(organization_id,project_id,data_environment_id)
       WHERE data.organization_id=$1 AND data.project_id=$2 AND assignment.environment_id=$3 ORDER BY assignment.assignment_version DESC LIMIT 1`,
        [source.p.organizationId, source.p.projectId, source.p.devEnvironmentId],
      )
    ).rows[0];
    if (!physical) throw new Error("Native physical environment initialization missing");
    await db
      .prepare(
        "INSERT INTO project_data_environments(organization_id,project_id,data_environment_id,created_at) VALUES(?,?,?,?)",
      )
      .bind(
        source.p.organizationId,
        source.p.projectId,
        physical.data_environment_id,
        physical.created_at,
      )
      .run();
    const placement = [
      source.p.organizationId,
      source.p.projectId,
      physical.data_environment_id,
      source.operationId,
      source.claimId,
      `ohmyho-${source.claimId.toLowerCase()}`,
      "aws-us-east-1",
      18,
      AT,
    ];
    await db
      .prepare(
        "INSERT INTO neon_project_placement_reservations(organization_id,project_id,environment_id,operation_id,claim_id,project_name,region_id,postgres_version,reserved_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .bind(...placement)
      .run();
    // Preserve the existing Core physical child, without qualifying or rebuilding its separate legacy domain.
    await insertAttemptNative(pg, ATTEMPT_TABLES[0], obs);
    await insertAttemptNative(pg, ATTEMPT_TABLES[1], recon);
    await insertAttemptNative(pg, ATTEMPT_TABLES[2], replayed);
    await insertAttemptNative(pg, ATTEMPT_TABLES[3], failed);
    const before = await db.prepare("SELECT * FROM product_workflow_runs").all(),
      claims = await db.prepare("SELECT * FROM product_provider_mutation_claims").all(),
      organizations = await db.prepare("SELECT * FROM organizations").all();
    const childBefore = await db.prepare("SELECT * FROM neon_project_placement_reservations").all(),
      childSchema = await db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='neon_project_placement_reservations' OR name='product_provider_mutation_claims_neon_identity' ORDER BY type,name",
        )
        .all();
    const ddl = migrationFiles("core").find((file) => file.name.startsWith("0453"));
    if (!ddl) throw new Error("Missing actual0453 migration");
    const statements = splitStatements(ddl.sql);
    await expect(
      db.batch([
        ...statements.map((sql) => db.prepare(sql)),
        guard(db, "precondition_changed", "1"),
      ]),
    ).rejects.toThrow("guard_precondition_changed");
    expect(
      (
        await db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='product_provider_mutation_observations'",
          )
          .all()
      ).results,
    ).toEqual([]);
    expect((await db.prepare("SELECT * FROM product_workflow_runs").all()).results).toEqual(
      before.results,
    );
    expect(
      (await db.prepare("SELECT * FROM product_provider_mutation_claims").all()).results,
    ).toEqual(claims.results);
    await db.batch(statements.map((sql) => db.prepare(sql)));
    expect((await db.prepare("SELECT * FROM product_workflow_runs").all()).results).toEqual(
      before.results,
    );
    expect(
      (await db.prepare("SELECT * FROM product_provider_mutation_claims").all()).results,
    ).toEqual(claims.results);
    expect((await db.prepare("SELECT * FROM organizations").all()).results).toEqual(
      organizations.results,
    );
    expect(
      (await db.prepare("SELECT * FROM neon_project_placement_reservations").all()).results,
    ).toEqual(childBefore.results);
    expect(
      (
        await db
          .prepare(
            "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name='neon_project_placement_reservations' OR name='product_provider_mutation_claims_neon_identity' ORDER BY type,name",
          )
          .all()
      ).results,
    ).toEqual(childSchema.results);
    for (const [index, row] of [obs, recon, replayed, failed].entries())
      await insertAttemptCore(db, ATTEMPT_TABLES[index] as AttemptTable, row);
    for (const table of ATTEMPT_TABLES) {
      const facts = await attemptFacts(source, table, source.p.organizationId);
      expect(facts.core).toEqual(facts.native);
    }
    // Actual native evidence from the prior legal terminal release has no claim or run parent here.
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM product_provider_mutation_claims WHERE claim_id=?")
        .bind(r.claimId)
        .first(),
    ).toEqual({ n: 0 });
    for (const table of ATTEMPT_TABLES) {
      const columns = await attemptColumns(pg, table),
        facts = await attemptFacts(r, table, r.p.organizationId);
      for (const row of facts.native) {
        const converted: AttemptRow = {};
        for (const column of columns) {
          const value: unknown = row[column.column_name];
          if (value !== null && typeof value !== "string")
            throw new Error("Native history must retain typed text/NULL");
          converted[column.column_name] =
            value === null
              ? null
              : column.data_type === "bytea"
                ? Buffer.from(value, "hex")
                : value;
        }
        await insertAttemptCore(db, table, converted);
      }
      expect((await attemptFacts(source, table, r.p.organizationId)).core).toEqual(facts.native);
    }
    await db
      .prepare(
        "UPDATE product_workflow_runs SET active_reconciliation_attempt_id=?,active_replay_attempt_id=? WHERE workflow_id=?",
      )
      .bind(recon["attempt_id"], replayed["attempt_id"], source.workflowId)
      .run();
    await pg.pool.query(
      "UPDATE product_workflow_runs SET active_reconciliation_attempt_id=$1,active_replay_attempt_id=$2 WHERE workflow_id=$3",
      [recon["attempt_id"], replayed["attempt_id"], source.workflowId],
    );
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await db.prepare("SELECT * FROM organizations").all()).results).toEqual(
      organizations.results,
    );
  } finally {
    await mf.dispose();
  }
}, 120_000);
