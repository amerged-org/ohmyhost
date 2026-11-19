/* global structuredClone */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  PUBLIC_ENTRY_TYPES,
  PUBLIC_ENTRY_KEYS,
  PUBLIC_ENTRY_SCHEMA_PINS,
  mapPublicEntryFacts,
} from "../scripts/control-d1-public-entry-mappings.mjs";
import { readPublicEntryPages } from "../scripts/control-d1-public-entry-readback.mjs";
import {
  PUBLIC_ENTRY_SEQUENCE,
  publicEntrySequences,
  publicEntrySequenceRow,
  readPublicEntrySequenceFacts,
} from "../scripts/control-d1-public-entry-sequence.mjs";
import { columnKind, tableProof } from "../scripts/control-d1-codec.mjs";
import { proveFixedProjectionPages } from "../scripts/control-d1-readback-pages.mjs";
test("all37 original public/feedback fields round-trip independently while exact sequence state never derives from or repairs row positions", async () => {
  const rows = new Map(),
    tables = Object.entries(PUBLIC_ENTRY_TYPES).map(([name, fields]) => {
      const row = {},
        columns = Object.entries(fields).map(([field, [type, notNull]]) => {
          row[field] =
            type === "ulid"
              ? "0".repeat(25) + "1"
              : type === "uuid"
                ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
                : type === "bytea"
                  ? "a1".repeat(32)
                  : type === "bigint"
                    ? "9223372036854775807"
                    : type === "timestamp with time zone"
                      ? "2026-10-29T12:13:14.123456Z"
                      : type === "jsonb"
                        ? '{"opaque": 9007199254740993, "escaped": "\\u00e4", "utf8": "文😀"}'
                        : notNull
                          ? "original utf8文😀"
                          : null;
          return {
            name: field,
            pgType: type === "ulid" ? "text" : type,
            sourceType: type,
            kind: columnKind(type === "ulid" ? "text" : type),
            notNull,
          };
        });
      rows.set(name, [row]);
      return { name, columns };
    }),
    manifest = {
      tables,
      targetPin: {
        migrations: Object.entries(PUBLIC_ENTRY_SCHEMA_PINS).map(([name, sha256]) => ({
          name,
          sha256,
        })),
      },
    },
    sqlite = new DatabaseSync(":memory:");
  assert.equal(Object.keys(PUBLIC_ENTRY_TYPES).length, 5);
  assert.equal(
    tables.reduce((n, t) => n + t.columns.length, 0),
    37,
  );
  try {
    for (const { table, row } of mapPublicEntryFacts(rows, manifest)) {
      const fields = Object.keys(row),
        types = PUBLIC_ENTRY_TYPES[table];
      sqlite.exec(
        `CREATE TABLE ${table}(${fields.map((field) => `${field} ${types[field][0] === "bytea" ? "BLOB" : types[field][0] === "bigint" ? "INTEGER" : "TEXT"}`).join(",")},PRIMARY KEY(${PUBLIC_ENTRY_KEYS[table].join(",")})) STRICT, WITHOUT ROWID`,
      );
      sqlite
        .prepare(
          `INSERT INTO ${table}(${fields.join(",")})VALUES(${fields.map(() => "?").join(",")})`,
        )
        .run(
          ...fields.map((field) =>
            row[field] === null
              ? null
              : types[field][0] === "bigint"
                ? BigInt(row[field])
                : types[field][0] === "bytea"
                  ? Uint8Array.from(Buffer.from(row[field], "hex"))
                  : row[field],
          ),
        );
    }
    sqlite.exec(
      "CREATE TABLE beta_feature_vote_allocator(singleton INTEGER PRIMARY KEY,last_value INTEGER,is_called INTEGER);INSERT INTO beta_feature_vote_allocator VALUES(1,1,0)",
    );
    const db = {
      prepare(sql) {
        const native = sqlite.prepare(sql),
          args = (v) =>
            /\?[1-9][0-9]*/u.test(sql)
              ? [Object.fromEntries(v.map((value, n) => [`?${n + 1}`, value]))]
              : v;
        return {
          bind(...v) {
            return {
              async all() {
                return { results: native.all(...args(v)) };
              },
              async first() {
                return native.get(...args(v)) ?? null;
              },
            };
          },
          async first() {
            return native.get() ?? null;
          },
        };
      },
    };
    for (const { name, columns } of tables)
      assert.deepEqual(
        await proveFixedProjectionPages(columns, readPublicEntryPages(db, name)),
        tableProof(
          columns,
          rows.get(name).map((row) => columns.map((column) => row[column.name])),
        ),
      );
    const spec = PUBLIC_ENTRY_SEQUENCE,
      sequence = {
        name: spec.sourceName,
        owned_table: spec.ownedTable,
        owned_column: spec.ownedColumn,
        data_type: spec.dataType,
        increment_by: spec.increment,
        min_value: spec.minimum,
        max_value: spec.maximum,
        cycle: false,
        state: { last_value: "1", is_called: false },
      },
      selected = publicEntrySequences({ manifest: { sequences: [sequence] }, rows }, [
        "beta_feature_interests",
      ]);
    // Original position is not unique: a rewound/uncalled allocator stays1 despite a MAX-int64 row.
    assert.deepEqual(selected.gaps, []);
    assert.equal(selected.restores[0].lastValue, "1");
    assert.equal(selected.restores[0].isCalled, false);
    assert.deepEqual(publicEntrySequenceRow(selected.restores[0]), {
      singleton: "1",
      last_value: "1",
      is_called: "0",
    });
    assert.deepEqual(await readPublicEntrySequenceFacts(db), selected.restores);
    assert.equal(
      publicEntrySequences(
        {
          manifest: {
            sequences: [
              { ...sequence, state: { last_value: "9223372036854775808", is_called: true } },
            ],
          },
        },
        ["beta_feature_interests"],
      ).gaps.length,
      1,
    );
    for (const patch of [
      (m) => m.targetPin.migrations.pop(),
      (m) => (m.tables[0].columns[0].sourceType = "text"),
      (m) => (m.tables[0].columns[0].notNull = false),
    ]) {
      const changed = structuredClone(manifest);
      patch(changed);
      assert.throws(() =>
        mapPublicEntryFacts(new Map([...rows].map(([name]) => [name, []])), changed),
      );
    }
  } finally {
    sqlite.close();
  }
});
