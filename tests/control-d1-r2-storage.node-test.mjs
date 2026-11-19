import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  R2_STORAGE_COLUMNS,
  R2_STORAGE_TYPES,
  R2_STORAGE_KEYS,
  R2_STORAGE_SCHEMA_PINS,
  mapR2Storage,
  r2StorageKind,
} from "../scripts/control-d1-r2-storage-mappings.mjs";
import { readR2StoragePages } from "../scripts/control-d1-r2-storage-readback.mjs";
const id = (n) => String(n).padStart(26, "0");
const domain = new Set([
  "organization_id",
  "project_id",
  "environment_id",
  "operation_id",
  "claim_id",
  "transfer_id",
  "deletion_id",
  "data_environment_id",
  "request_environment_id",
]);
function fixture() {
  const metadata = Object.entries(R2_STORAGE_COLUMNS).map(([name, fields]) => ({
    name,
    columns: fields.split(",").map((column) => ({
      name: column,
      pgType: R2_STORAGE_TYPES[name][column],
      sourceType: domain.has(column) ? "ulid" : R2_STORAGE_TYPES[name][column],
      notNull: column !== "create_started_at",
    })),
  }));
  const values = {
    organization_id: id(1),
    project_id: id(2),
    environment_id: id(3),
    operation_id: id(4),
    claim_id: id(5),
    transfer_id: id(6),
    deletion_id: id(7),
    data_environment_id: id(8),
    request_environment_id: id(3),
    bucket_name: `ohmyho-${id(2)}-${id(3)}`,
    jurisdiction: "eu",
    storage_class: "Standard",
    public_access: "false",
    reserved_at: "2026-10-28T12:00:00.123456Z",
    create_started_at: null,
    idempotency_key: "original-é",
    request_sha256: "ab".repeat(32),
    object_key: "object.bin",
    content_type: "application/octet-stream",
    expected_bytes: "3",
    size: "3",
    requested_at: "2026-10-28T12:00:00.123456Z",
    expires_at: "2026-10-28T12:05:00.123456Z",
    uploaded_at: "2026-10-28T12:00:01.654321Z",
    created_at: "2026-10-28T12:00:01.987654Z",
    deleted_at: "2026-10-29T12:00:00.000001Z",
    erased_at: "2026-10-29T12:00:00.000001Z",
    physical_object_key: `d/${id(8)}/object.bin`,
    logical_namespace_version: "2",
    object_was_observed: "true",
    etag: "a".repeat(32),
  };
  values.marker_sha256 = createHash("sha256")
    .update(
      [
        "ohmyhost.r2-erasure/v1",
        id(1),
        id(2),
        id(3),
        id(8),
        id(6),
        values.physical_object_key,
      ].join("\n"),
    )
    .digest("hex");
  const rows = new Map(
    Object.entries(R2_STORAGE_COLUMNS).map(([table, fields]) => [
      table,
      [Object.freeze(Object.fromEntries(fields.split(",").map((f) => [f, values[f]])))],
    ]),
  );
  return {
    rows,
    manifest: {
      tables: metadata,
      targetPin: {
        migrations: Object.entries(R2_STORAGE_SCHEMA_PINS).map(([name, sha256]) => ({
          name,
          sha256,
        })),
      },
    },
  };
}
test("six original typed families retain UTC6, marker bytes, nullable state and namespace without modifying captured rows", () => {
  const { rows, manifest } = fixture(),
    before = JSON.stringify([...rows]),
    mapped = mapR2Storage(rows, manifest, {});
  assert.equal(mapped.length, 6);
  assert.equal(JSON.stringify([...rows]), before);
  assert.equal(
    mapped.find((r) => r.table === "project_r2_upload_reservations").row.logical_namespace_version,
    "2",
  );
  assert.equal(
    mapped.find((r) => r.table === "project_r2_objects").row.uploaded_at,
    "2026-10-28T12:00:01.654321Z",
  );
  assert.equal(
    mapped.find((r) => r.table === "project_r2_bucket_reservations").row.create_started_at,
    null,
  );
  assert.equal(
    mapped.find((r) => r.table === "project_r2_delete_requests").row.object_was_observed,
    "1",
  );
  const infinite = new Map(rows);
  infinite.set("project_r2_objects", [
    { ...rows.get("project_r2_objects")[0], uploaded_at: "+infinity" },
  ]);
  assert.throws(() => mapR2Storage(infinite, manifest, {}), /R2_STORAGE_TIMESTAMP/);
  const bad = new Map(rows);
  bad.set("project_r2_erasure_barriers", [
    { ...rows.get("project_r2_erasure_barriers")[0], marker_sha256: "00".repeat(32) },
  ]);
  assert.throws(() => mapR2Storage(bad, manifest, {}), /R2_STORAGE_MARKER/);
  assert.throws(
    () => mapR2Storage(rows, { ...manifest, targetPin: { migrations: [] } }, {}),
    /R2_STORAGE_PREREQUISITE/,
  );
  const wrong = JSON.parse(JSON.stringify(manifest));
  wrong.tables[0].columns[0].sourceType = "text";
  assert.throws(() => mapR2Storage(rows, wrong, {}), /R2_STORAGE_SOURCE_TYPE/);
});
test("bounded raw pages reconstruct original typed strings with native PK searches including historical physical keys", async () => {
  const { rows, manifest } = fixture();
  for (let n = 0; n < 130; n++)
    rows.get("project_r2_objects").push({
      ...rows.get("project_r2_objects")[0],
      transfer_id: id(100 + n),
      physical_object_key: `d/${id(8)}/original-${String(n).padStart(3, "0")}.bin`,
    });
  const mapped = mapR2Storage(rows, manifest, {}),
    sqlite = new DatabaseSync(":memory:"),
    sql = [];
  try {
    for (const [table, fields] of Object.entries(R2_STORAGE_COLUMNS)) {
      const names = fields.split(",");
      sqlite.exec(
        `CREATE TABLE ${table}(${names.map((c) => `${c} ${["integer", "boolean"].includes(r2StorageKind(table, c)) ? "INTEGER" : r2StorageKind(table, c) === "bytea" ? "BLOB" : "TEXT"}`).join(",")},PRIMARY KEY(${R2_STORAGE_KEYS[table].join(",")})) WITHOUT ROWID`,
      );
      const insert = sqlite.prepare(
        `INSERT INTO ${table}(${fields})VALUES(${names.map(() => "?").join(",")})`,
      );
      for (const record of mapped.filter((r) => r.table === table))
        insert.run(
          ...names.map((c) =>
            r2StorageKind(table, c) === "bytea" ? Buffer.from(record.row[c], "hex") : record.row[c],
          ),
        );
    }
    const db = {
      prepare(query) {
        sql.push(query);
        const wrap = (bindings) => ({
          bind: (...v) => wrap(v),
          first: async () => sqlite.prepare(query).get(...bindings) ?? null,
          all: async () => ({ results: sqlite.prepare(query).all(...bindings) }),
        });
        return wrap([]);
      },
    };
    for (const table of Object.keys(R2_STORAGE_COLUMNS)) {
      const result = [];
      let pages = 0;
      for await (const page of readR2StoragePages(db, table)) {
        pages++;
        assert.ok(page.length <= 128);
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
        result.push(...page);
      }
      const canonical = (row) => JSON.stringify(row, Object.keys(row).sort());
      assert.deepEqual(result.map(canonical).sort(), rows.get(table).map(canonical).sort());
      if (table === "project_r2_objects") assert.equal(pages, 2);
    }
    assert.equal(
      sql.some((q) => q.includes("COLLATE")),
      false,
    );
    const seek = sql.find(
      (q) => q.includes("FROM project_r2_objects WHERE") && q.includes(" __bytes "),
    );
    assert.ok(seek);
    const plan = sqlite
      .prepare("EXPLAIN QUERY PLAN " + seek)
      .all(id(1), id(2), id(3), "d/" + id(8) + "/original-000.bin");
    assert.ok(
      plan.some((r) => String(r.detail).includes("SEARCH project_r2_objects USING PRIMARY KEY")),
    );
  } finally {
    sqlite.close();
  }
});
