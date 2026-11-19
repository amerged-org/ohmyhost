import { fail, integerText } from "./control-d1-codec.mjs";

export const MIGRATION_HISTORY_COLUMNS = Object.freeze({ control_db_migrations: "id,name,run_on" });
export const MIGRATION_HISTORY_TARGETS = Object.freeze(["control_source_migrations"]);
export const MIGRATION_HISTORY_SCHEMA_SHA256 =
  "be234832838729548e30993c59256af44a29d19a9c325fbf4638efefaa92867d";
const SOURCE_SEQUENCE = "control_db_migrations_id_seq";

/** Original runner evidence only; the captured Z suffix is a transport decoration for timezone-free components. */
export function mapMigrationHistory(rows, manifest) {
  if (
    !manifest.targetPin.migrations.some(
      (entry) =>
        entry.name === "0411_original_migration_history.sql" &&
        entry.sha256 === MIGRATION_HISTORY_SCHEMA_SHA256,
    )
  )
    fail("MIGRATION_HISTORY_SCHEMA_PREREQUISITE");
  const definition = manifest.tables.find((table) => table.name === "control_db_migrations"),
    types = Object.fromEntries(
      (definition?.columns ?? []).map((column) => [column.name, column.pgType]),
    );
  if (
    definition?.columns
      .map((column) => column.name)
      .sort()
      .join(",") !== MIGRATION_HISTORY_COLUMNS.control_db_migrations
  )
    fail("MIGRATION_HISTORY_SOURCE_COLUMNS");
  if (
    types.id !== "integer" ||
    types.name !== "character varying(255)" ||
    types.run_on !== "timestamp without time zone"
  )
    fail("MIGRATION_HISTORY_SOURCE_TYPE");
  if (!Array.isArray(rows.get("control_db_migrations"))) fail("MIGRATION_HISTORY_SOURCE_REQUIRED");
  return rows.get("control_db_migrations").map((row) => {
    if (
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).sort().join(",") !== MIGRATION_HISTORY_COLUMNS.control_db_migrations
    )
      fail("MIGRATION_HISTORY_SOURCE_COLUMNS");
    const id = BigInt(integerText(row.id));
    if (id < -2147483648n || id > 2147483647n) fail("MIGRATION_HISTORY_ID_RANGE");
    if (
      typeof row.run_on !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(row.run_on)
    )
      fail("MIGRATION_HISTORY_TIMESTAMP_UNREPRESENTABLE");
    return { table: "control_source_migrations", row };
  });
}

/** A CLOSED historical snapshot, never sqlite_sequence and never the Core migration allocator. */
export function migrationHistorySequenceRow(restore) {
  if (
    restore.kind !== "original-control-migrations-v1" ||
    restore.sourceName !== SOURCE_SEQUENCE ||
    restore.targetName !== "control_source_migration_sequence" ||
    typeof restore.isCalled !== "boolean"
  )
    fail("SEQUENCE_MAPPING");
  const last = BigInt(integerText(restore.lastValue));
  if (last < 1n || last > 2147483647n) fail("SEQUENCE_STATE_UNREPRESENTABLE");
  return {
    source_name: SOURCE_SEQUENCE,
    last_value: restore.lastValue,
    is_called: restore.isCalled ? "1" : "0",
  };
}

export function migrationHistorySequences(capture, mapped) {
  const restores = [],
    gaps = [];
  if (!mapped.includes("control_db_migrations")) return { restores, gaps };
  const sequences = capture.manifest.sequences.filter(
    (sequence) => sequence.name === SOURCE_SEQUENCE,
  );
  if (sequences.length !== 1)
    return {
      restores,
      gaps: [{ group: "migration-history-sequence", code: "CONTROL_D1_SEQUENCE_REQUIRED" }],
    };
  try {
    const sequence = sequences[0];
    if (
      sequence.owned_table !== "control_db_migrations" ||
      sequence.owned_column !== "id" ||
      sequence.data_type !== "integer" ||
      sequence.start_value !== "1" ||
      sequence.increment_by !== "1" ||
      sequence.min_value !== "1" ||
      sequence.max_value !== "2147483647" ||
      sequence.cache_size !== "1" ||
      sequence.cycle !== false ||
      !sequence.state ||
      typeof sequence.state.is_called !== "boolean"
    )
      fail("SEQUENCE_DEFINITION_UNREPRESENTABLE");
    const restore = {
      kind: "original-control-migrations-v1",
      sourceName: SOURCE_SEQUENCE,
      targetName: "control_source_migration_sequence",
      lastValue: sequence.state.last_value,
      isCalled: sequence.state.is_called,
    };
    migrationHistorySequenceRow(restore);
    // Rewound, uncalled and gap states are representable historical facts, independent of remaining row IDs.
    restores.push(restore);
  } catch (error) {
    if (!/^CONTROL_D1_/u.test(error.message)) throw error;
    gaps.push({ group: "migration-history-sequence", code: error.message });
  }
  return { restores, gaps };
}

export async function readMigrationHistorySourceFacts(db) {
  return new Map([
    [
      "control_db_migrations",
      (
        await db
          .prepare("SELECT CAST(id AS TEXT) id,name,run_on FROM control_source_migrations")
          .all()
      ).results,
    ],
  ]);
}

export async function readMigrationHistorySequenceFacts(db) {
  const rows = (
    await db
      .prepare(
        "SELECT source_name,CAST(last_value AS TEXT) last_value,CASE is_called WHEN 1 THEN 'true' WHEN 0 THEN 'false' END is_called FROM control_source_migration_sequence",
      )
      .all()
  ).results;
  return rows.map((row) => {
    if (row.is_called !== "true" && row.is_called !== "false") fail("SEQUENCE_TARGET_INVALID");
    const restore = {
      kind: "original-control-migrations-v1",
      sourceName: row.source_name,
      targetName: "control_source_migration_sequence",
      lastValue: row.last_value,
      isCalled: row.is_called === "true",
    };
    migrationHistorySequenceRow(restore);
    return restore;
  });
}
