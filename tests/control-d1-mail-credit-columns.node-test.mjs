/* global structuredClone */
import { Buffer } from "node:buffer";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { compareMailSourceProofs } from "../scripts/control-d1-migration.mjs";
import { tableProof } from "../scripts/control-d1-codec.mjs";
import {
  MAIL_COLUMNS,
  MAIL_KINDS,
  MAIL_REQUIRED_MIGRATIONS,
  MAIL_RETIRED_COLUMNS,
  MAIL_SOURCE_TYPES,
  mapMail,
} from "../scripts/control-d1-mail-mappings.mjs";
import { readMailSourceFacts } from "../scripts/control-d1-mail-readback.mjs";

const REQUESTS = "mail_send_requests";
const RETIRED = MAIL_RETIRED_COLUMNS[REQUESTS];
const request = {
  request_id: "01".padEnd(26, "0"),
  organization_id: "02".padEnd(26, "0"),
  project_id: "03".padEnd(26, "0"),
  idempotency_key: "key",
  request_sha256: "ab".repeat(32),
  recipient_sha256: "cd".repeat(32),
  content_sha256: "ef".repeat(32),
  credit_charge_micros: "30",
  state: "accepted",
  provider_started_at: "2026-10-29T08:00:00.123000Z",
  provider_message_id: "message",
  requested_at: "2026-10-29T08:00:00.123000Z",
  updated_at: "2026-10-29T08:00:01.123000Z",
  credit_reservation_id: "04".padEnd(26, "0"),
  credit_rate_card_id: "original-mail-card",
  credit_meter: "mail.sent",
  credit_provider_cost_micros: "1",
  mail_provider: "resend",
  mail_domain_id: null,
  mail_binding_revision: null,
  effective_from: null,
  effective_reply_to: null,
  request_input_sha256: null,
};

function source() {
  const tables = Object.entries(MAIL_COLUMNS).map(([name, columns]) => ({
    name,
    columns: columns
      .split(",")
      .map((column) => ({ name: column, ...MAIL_SOURCE_TYPES[name][column] })),
  }));
  const rows = new Map(tables.map((table) => [table.name, []]));
  rows.set(REQUESTS, [request]);
  for (const table of tables) {
    const values = rows
      .get(table.name)
      .map((row) => table.columns.map((column) => row[column.name]));
    Object.assign(table, tableProof(table.columns, values));
  }
  return {
    rows,
    manifest: {
      tables,
      targetPin: {
        migrations: Object.entries(MAIL_REQUIRED_MIGRATIONS).map(([name, sha256]) => ({
          name,
          sha256,
        })),
      },
    },
  };
}

test("mail send requests are converted without the credit columns the Core no longer has", async () => {
  assert.equal(
    RETIRED.every((column) => MAIL_COLUMNS[REQUESTS].split(",").includes(column)),
    true,
  );
  const image = source();
  const mapped = mapMail(image.rows, image.manifest, {});
  assert.equal(mapped.length, 1);
  assert.deepEqual(
    Object.keys(mapped[0].row).sort(),
    MAIL_COLUMNS[REQUESTS].split(",")
      .filter((column) => !RETIRED.includes(column))
      .sort(),
  );
  assert.equal(mapped[0].row.state, "accepted");
  // The source schema is still checked whole: a source without a retired column is not the original schema.
  const altered = structuredClone(image.manifest);
  altered.tables.find((table) => table.name === REQUESTS).columns.pop();
  assert.throws(() => mapMail(image.rows, altered, {}), /MAIL_SOURCE_FORMAT_UNHANDLED/u);

  // The independent readback proves the retained columns against the captured rows, and nothing else.
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const [table, columns] of Object.entries(MAIL_COLUMNS)) {
      const names = columns
        .split(",")
        .filter((column) => !(MAIL_RETIRED_COLUMNS[table] ?? []).includes(column));
      sqlite.exec(
        `CREATE TABLE ${table}(${names.map((name) => `${name} ${MAIL_KINDS[table][name] === "bytea" ? "BLOB" : "TEXT"}`).join(",")})`,
      );
    }
    sqlite
      .prepare(
        `INSERT INTO ${REQUESTS}(${Object.keys(mapped[0].row)})VALUES(${Object.keys(mapped[0].row)
          .map(() => "?")
          .join(",")})`,
      )
      .run(
        ...Object.entries(mapped[0].row).map(([column, value]) =>
          MAIL_KINDS[REQUESTS][column] === "bytea" && value !== null
            ? Buffer.from(value, "hex")
            : value,
        ),
      );
    const db = {
      prepare(query) {
        const wrap = (bindings) => ({
          bind: (...values) => wrap(values),
          all: async () => ({ results: sqlite.prepare(query).all(...bindings) }),
        });
        return wrap([]);
      },
    };
    assert.deepEqual(await compareMailSourceProofs(db, image, [REQUESTS]), []);
    // A retired value in the capture is not compared; a retained one is.
    image.rows.set(REQUESTS, [{ ...request, credit_charge_micros: "31" }]);
    assert.deepEqual(await compareMailSourceProofs(db, image, [REQUESTS]), []);
    image.rows.set(REQUESTS, [{ ...request, state: "failed" }]);
    assert.deepEqual(await compareMailSourceProofs(db, image, [REQUESTS]), [REQUESTS]);
    assert.equal((await readMailSourceFacts(db)).get(REQUESTS)[0].credit_meter, undefined);
  } finally {
    sqlite.close();
  }
});
