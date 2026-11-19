/* global structuredClone */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import { originalControlFixture, repositoryRoot } from "./support/control-conversion-fixture.mjs";
import { buildPlan, importPlan, openLocalTarget } from "../scripts/control-d1-migration.mjs";
import { compareSequences } from "../scripts/control-d1-target.mjs";
import {
  mapMigrationHistory,
  migrationHistorySequences,
  migrationHistorySequenceRow,
  readMigrationHistorySourceFacts,
  readMigrationHistorySequenceFacts,
} from "../scripts/control-d1-source-history.mjs";
import { canonical, sha256, tableProof } from "../scripts/control-d1-codec.mjs";

const sequenceName = "control_db_migrations_id_seq";
let fixture, image, plan;
const historyRestores = (value) =>
  value.sequenceRestores.filter((restore) => restore.sourceName === sequenceName);
const options = (db, value, name) => ({
  db,
  plan: value,
  key: fixture.key,
  targetId: name,
  journal: join(fixture.directory, `${name}.journal`),
  currentPin: value.targetPin,
  repositoryRoot,
});
function observeSequence(db, onBatch, onReceiptRead) {
  const receipts = new WeakSet();
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      if (onReceiptRead && sql === "SELECT name,digest,result FROM command_log WHERE command_id=?")
        return {
          bind(...values) {
            const bound = statement.bind(...values);
            return String(values[0]).endsWith(sequenceName)
              ? { first: () => onReceiptRead(bound) }
              : bound;
          },
        };
      if (!sql.includes("'control-d1.sequence'")) return statement;
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          if (String(values[0]).endsWith(sequenceName)) receipts.add(bound);
          return bound;
        },
      };
    },
    async batch(statements) {
      return onBatch(
        statements,
        statements.some((statement) => receipts.has(statement)),
      );
    },
  };
}
async function proveHistory(db, captured) {
  const columns = captured.manifest.tables.find(
      (table) => table.name === "control_db_migrations",
    ).columns,
    values = (rows) => rows.map((row) => columns.map((column) => row[column.name])),
    facts = await readMigrationHistorySourceFacts(db);
  assert.deepEqual(
    tableProof(columns, values(facts.get("control_db_migrations"))),
    tableProof(columns, values(captured.rows.get("control_db_migrations"))),
  );
}
before(
  async () => {
    fixture = await originalControlFixture("source-history");
    await fixture.pool.query(
      "INSERT INTO control_db_migrations(id,name,run_on) VALUES(-11,'','2026-12-31 23:59:59.123456'),(0,'original Über 😀','2027-01-01 12:34:56.654321')",
    );
    await fixture.pool.query("SELECT setval('control_db_migrations_id_seq',1000000,true)");
    image = await fixture.image("history-called-gap");
    plan = await fixture.import(image, "history-called-gap");
  },
  { timeout: 240_000 },
);
after(async () => fixture?.dispose());

test("original runner rows and int4 called gap state survive exact readback, replay and second restore after a lost committed reply", async () => {
  assert.deepEqual(plan.gaps, []);
  assert.equal(plan.mapped.includes("control_db_migrations"), true);
  assert.equal(plan.verdict, "MAPPED_QUALIFICATION_ONLY");
  await proveHistory(fixture.db, image);
  const restore = historyRestores(plan)[0];
  assert.equal(restore.lastValue, "1000000");
  assert.equal(restore.isCalled, true);
  assert.deepEqual(await readMigrationHistorySequenceFacts(fixture.db), [restore]);
  assert.equal(
    (await fixture.db.prepare("SELECT run_on FROM control_source_migrations WHERE id=-11").first())
      .run_on,
    "2026-12-31T23:59:59.123456Z",
  );
  assert.equal(
    (
      await fixture.db
        .prepare("SELECT CAST(id AS TEXT) id FROM control_source_migrations WHERE id=0")
        .first()
    ).id,
    "0",
  );
  const target = await openLocalTarget({ repositoryRoot });
  try {
    assert.deepEqual(await compareSequences(target.db, [restore]), [sequenceName]);
    let lost = false;
    const observed = observeSequence(target.db, async (statements, sequence) => {
      const result = await target.db.batch(statements);
      if (sequence && !lost) {
        lost = true;
        throw new Error("Network connection lost");
      }
      return result;
    });
    const input = options(observed, plan, "history-second-restore");
    await importPlan(input);
    assert.equal(lost, true);
    await importPlan({ ...input, db: target.db });
    await proveHistory(target.db, image);
    assert.deepEqual(await readMigrationHistorySequenceFacts(target.db), [restore]);
    assert.deepEqual(await compareSequences(target.db, plan.sequenceRestores), []);
    assert.equal(
      (
        await target.db
          .prepare("SELECT name FROM sqlite_sequence WHERE name='control_source_migrations'")
          .all()
      ).results.length,
      0,
    );
    assert.equal((await target.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
  } finally {
    await target.dispose();
  }
});

test("uncalled and rewound original sequence state is historical evidence independent of MAX rows and cannot feed Core's allocator", async () => {
  await fixture.pool.query("SELECT setval('control_db_migrations_id_seq',17,false)");
  const captured = await fixture.image("history-uncalled-rewound"),
    value = buildPlan(captured, captured.manifest.targetPin, {
      role: "postgres",
      database: "postgres",
    }),
    restore = historyRestores(value)[0],
    target = await openLocalTarget({ repositoryRoot });
  try {
    assert.equal(restore.lastValue, "17");
    assert.equal(restore.isCalled, false);
    assert.equal(
      captured.rows.get("control_db_migrations").some((row) => BigInt(row.id) > 17n),
      true,
    );
    await importPlan(options(target.db, value, "history-uncalled-rewound"));
    await proveHistory(target.db, captured);
    assert.deepEqual(await readMigrationHistorySequenceFacts(target.db), [restore]);
    for (const sql of [
      "UPDATE control_source_migrations SET run_on='2027-01-01T00:00:00.000000Z'",
      "DELETE FROM control_source_migrations",
      "UPDATE control_source_migration_sequence SET last_value=18",
      "DELETE FROM control_source_migration_sequence",
    ])
      await assert.rejects(target.db.prepare(sql).run(), /read-only source evidence/u);
    assert.equal((await target.db.prepare("PRAGMA foreign_keys").first()).foreign_keys, 1);
  } finally {
    await target.dispose();
  }
});

test("late snapshot/receipt rollback resumes exactly and missing, changed or unusual source types/states remain explicit gaps", async () => {
  const target = await openLocalTarget({ repositoryRoot });
  try {
    let failed = false;
    const observed = observeSequence(target.db, (statements, sequence) => {
      if (sequence && !failed) {
        failed = true;
        return target.db.batch([
          ...statements,
          target.db.prepare("INSERT INTO guard_fail(code) VALUES('precondition_changed')"),
        ]);
      }
      return target.db.batch(statements);
    });
    const input = options(observed, plan, "history-rolled-back");
    await assert.rejects(importPlan(input), /SEQUENCE_RESTORE_UNKNOWN/u);
    assert.equal(failed, true);
    assert.deepEqual(await readMigrationHistorySequenceFacts(target.db), []);
    assert.equal(
      await target.db
        .prepare("SELECT command_id FROM command_log WHERE command_id LIKE ?")
        .bind(`%${sequenceName}`)
        .first(),
      null,
    );
    await importPlan({ ...input, db: target.db });
    assert.deepEqual(await compareSequences(target.db, historyRestores(plan)), []);
  } finally {
    await target.dispose();
  }
  const uncertain = await openLocalTarget({ repositoryRoot });
  try {
    let committed = false,
      unavailable = true;
    const observed = observeSequence(
      uncertain.db,
      async (statements, sequence) => {
        const result = await uncertain.db.batch(statements);
        if (sequence && !committed) {
          committed = true;
          throw new Error("Network connection lost");
        }
        return result;
      },
      (bound) => {
        if (committed && unavailable) {
          unavailable = false;
          return Promise.reject(new Error("Receipt read temporarily unavailable"));
        }
        return bound.first();
      },
    );
    const input = options(observed, plan, "history-committed-unobserved");
    await assert.rejects(importPlan(input), /SEQUENCE_RESTORE_UNKNOWN/u);
    assert.equal(committed, true);
    assert.deepEqual(await readMigrationHistorySequenceFacts(uncertain.db), historyRestores(plan));
    await importPlan({ ...input, db: uncertain.db });
    assert.equal(
      (
        await uncertain.db
          .prepare(
            "SELECT count(*) n FROM command_log WHERE name='control-d1.sequence' AND command_id LIKE ?",
          )
          .bind(`%${sequenceName}`)
          .first()
      ).n,
      1,
    );
  } finally {
    await uncertain.dispose();
  }
  assert.deepEqual(migrationHistorySequences(image, []), { restores: [], gaps: [] });
  const missing = structuredClone(image.manifest);
  missing.sequences = missing.sequences.filter((sequence) => sequence.name !== sequenceName);
  assert.equal(
    migrationHistorySequences({ manifest: missing }, ["control_db_migrations"]).gaps[0].code,
    "CONTROL_D1_SEQUENCE_REQUIRED",
  );
  const source = image.manifest.sequences.find((sequence) => sequence.name === sequenceName);
  for (const changed of [
    { ...source, owned_table: "other" },
    { ...source, owned_column: "other" },
    { ...source, data_type: "bigint" },
    { ...source, start_value: "2" },
    { ...source, increment_by: "2" },
    { ...source, min_value: "0" },
    { ...source, max_value: "9223372036854775807" },
    { ...source, cache_size: "2" },
    { ...source, cycle: true },
    { ...source, state: undefined },
    { ...source, state: { last_value: "1", is_called: null } },
    { ...source, state: { last_value: "0", is_called: false } },
    { ...source, state: { last_value: "2147483648", is_called: true } },
  ]) {
    const result = migrationHistorySequences({ manifest: { sequences: [changed] } }, [
      "control_db_migrations",
    ]);
    assert.deepEqual(result.restores, []);
    assert.equal(result.gaps.length, 1);
  }
  for (const changed of [
    { ...historyRestores(plan)[0], kind: "unknown" },
    { ...historyRestores(plan)[0], sourceName: "other" },
    { ...historyRestores(plan)[0], targetName: "sqlite_sequence" },
    { ...historyRestores(plan)[0], isCalled: null },
  ])
    assert.throws(() => migrationHistorySequenceRow(changed), /SEQUENCE_MAPPING/u);
  for (const pgType of ["text", "timestamp with time zone"]) {
    const manifest = structuredClone(image.manifest);
    manifest.tables
      .find((table) => table.name === "control_db_migrations")
      .columns.find((column) => column.name === "run_on").pgType = pgType;
    assert.throws(
      () => mapMigrationHistory(image.rows, manifest),
      /MIGRATION_HISTORY_SOURCE_TYPE/u,
    );
  }
  const noSchema = structuredClone(image.manifest);
  noSchema.targetPin.migrations = [];
  assert.throws(
    () => mapMigrationHistory(image.rows, noSchema),
    /MIGRATION_HISTORY_SCHEMA_PREREQUISITE/u,
  );
  const extraColumn = structuredClone(image.manifest);
  extraColumn.tables
    .find((table) => table.name === "control_db_migrations")
    .columns.push({ name: "unexpected_source_field", pgType: "text" });
  assert.throws(
    () => mapMigrationHistory(image.rows, extraColumn),
    /MIGRATION_HISTORY_SOURCE_COLUMNS/u,
  );
  for (const row of [
    { ...image.rows.get("control_db_migrations")[0], unexpected_source_field: "opaque" },
    { id: "1", name: "missing original clock" },
  ]) {
    const changed = new Map(image.rows);
    changed.set("control_db_migrations", [row]);
    assert.throws(
      () => mapMigrationHistory(changed, image.manifest),
      /MIGRATION_HISTORY_SOURCE_COLUMNS/u,
    );
  }
  const absent = new Map(image.rows);
  absent.delete("control_db_migrations");
  assert.throws(
    () => mapMigrationHistory(absent, image.manifest),
    /MIGRATION_HISTORY_SOURCE_REQUIRED/u,
  );
  const invalidId = new Map(image.rows);
  invalidId.set("control_db_migrations", [
    { ...image.rows.get("control_db_migrations")[0], id: "2147483648" },
  ]);
  assert.throws(
    () => mapMigrationHistory(invalidId, image.manifest),
    /MIGRATION_HISTORY_ID_RANGE/u,
  );
  await fixture.pool.query(
    "INSERT INTO control_db_migrations(id,name,run_on) VALUES(-13,'infinite-source-clock','infinity')",
  );
  const captured = await fixture.image("history-unrepresentable-time"),
    incomplete = buildPlan(captured, captured.manifest.targetPin, {
      role: "postgres",
      database: "postgres",
    });
  assert.equal(incomplete.unhandled.includes("control_db_migrations"), true);
  assert.equal(incomplete.unhandledSequences.includes(sequenceName), true);
  assert.equal(
    incomplete.gaps.some(
      (gap) => gap.code === "CONTROL_D1_MIGRATION_HISTORY_TIMESTAMP_UNREPRESENTABLE",
    ),
    true,
  );
  assert.equal(incomplete.verdict, "INCOMPLETE");
  const { digest, ...body } = incomplete;
  assert.equal(digest, sha256(Buffer.from(canonical(body))));
});
