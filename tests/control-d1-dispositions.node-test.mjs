import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWS_ARCHIVED_TABLES,
  DISPOSITION_PINS,
  REMOVED_SOURCE_TABLES,
  configuredArchives,
  qualifyDispositions,
} from "../scripts/control-d1-dispositions.mjs";

test("stale Neon placement reservations of Production are archived with a digest receipt, never a gap or a silent drop", () => {
  const table = "neon_project_placement_reservations",
    columns = DISPOSITION_PINS[table].split(",").map((entry) => {
      const [name, pgType] = entry.split(":");
      return { name, pgType };
    }),
    value = (column) =>
      column.pgType.startsWith("timestamp")
        ? "2026-10-13T01:11:13.884785Z"
        : column.pgType === "smallint"
          ? "16"
          : "x",
    row = Object.fromEntries(columns.map((column) => [column.name, value(column)])),
    capture = {
      manifest: {
        captureId: "00000000-0000-4000-8000-000000000000",
        capturedAt: "2026-10-30T05:19:01.000Z",
        source: { expected: { environment: "production" } },
        tables: [{ name: table, columns, rows: "2", sha256: "ab".repeat(32) }],
      },
      rows: new Map([[table, [row, { ...row, claim_id: "y" }]]]),
    };
  const { entries, gaps } = qualifyDispositions(capture, new Set());
  assert.deepEqual(gaps, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "archive");
  assert.match(entries[0].ndjsonSha256, /^[a-f0-9]{64}$/u);
  assert.equal(
    entries[0].archiveKey,
    `archive/production/${table}/00000000-0000-4000-8000-000000000000.ndjson.gz`,
  );
});

const captureOf = (tables) => ({
  manifest: {
    captureId: "00000000-0000-4000-8000-000000000001",
    capturedAt: "2026-10-30T05:19:01.000Z",
    source: { expected: { environment: "production" } },
    tables: tables.map(([name, columns, rows]) => ({
      name,
      columns,
      rows: String(rows.length),
      sha256: "cd".repeat(32),
    })),
  },
  rows: new Map(tables.map(([name, , rows]) => [name, rows])),
});

test("AWS history is archived with a digest receipt and never imported", () => {
  assert.deepEqual(AWS_ARCHIVED_TABLES.slice().sort(), [
    "legacy_aws_mail_absence",
    "route53_dkim_change_receipts",
    "route53_dkim_receipts",
    "ses_event_destination_receipts",
    "ses_project_mail_resource_receipts",
    "ses_tenant_receipts",
  ]);
  const columns = (table) =>
    DISPOSITION_PINS[table].split(",").map((entry) => {
      const [name, pgType] = entry.split(":");
      return { name, pgType };
    });
  const table = "route53_dkim_change_receipts",
    row = Object.fromEntries(columns(table).map((column) => [column.name, "x"]));
  const { entries, gaps } = qualifyDispositions(
    captureOf([[table, columns(table), [row]]]),
    new Set(),
  );
  assert.deepEqual(gaps, []);
  assert.equal(entries[0].kind, "archive");
  assert.match(entries[0].gzipSha256, /^[a-f0-9]{64}$/u);
});

test("configured archives drop only tables that are not user relations, and say so in the plan", () => {
  const column = [{ name: "id", pgType: "text" }],
    capture = captureOf([
      ["function_runs", column, [{ id: "1" }, { id: "2" }]],
      ["projects", column, [{ id: "p" }]],
      ["neon_project_migration_receipts", column, []],
    ]);
  const { entries, gaps } = configuredArchives(capture, [
    "function_runs",
    "projects",
    "neon_project_migration_receipts",
    "no_such_table",
  ]);
  assert.deepEqual(
    entries.map((entry) => [entry.table, entry.kind, entry.configured, entry.rows]),
    [["function_runs", "archive", true, "2"]],
  );
  assert.deepEqual(
    gaps.map((gap) => [gap.code, gap.tables[0]]),
    [
      ["CONTROL_D1_ARCHIVE_TABLE_ACCOUNTED", "neon_project_migration_receipts"],
      ["CONTROL_D1_ARCHIVE_TABLE_UNKNOWN", "no_such_table"],
      ["CONTROL_D1_ARCHIVE_TABLE_PROTECTED", "projects"],
    ],
  );
  assert.throws(() => configuredArchives(capture, "function_runs"), /ARCHIVE_CONFIG/u);
});

test("a removed credit table is accounted with its row count and digest, whatever its columns, and cannot be archived", () => {
  const table = "stripe_credit_payments",
    capture = captureOf([[table, [{ name: "any", pgType: "text" }], [{ any: "1" }, { any: "2" }]]]);
  assert.ok(REMOVED_SOURCE_TABLES.includes(table));
  const { entries, gaps } = qualifyDispositions(capture, new Set());
  assert.deepEqual(gaps, []);
  assert.deepEqual(entries, [{ table, kind: "removed", rows: "2", sourceSha256: "cd".repeat(32) }]);
  assert.deepEqual(
    configuredArchives(capture, [table]).gaps.map((gap) => gap.code),
    ["CONTROL_D1_ARCHIVE_TABLE_ACCOUNTED"],
  );
});
