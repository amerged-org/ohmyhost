/* global URL */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { testPostgresEnvironment } from "../scripts/test-postgres-path.mjs";
import { captureExpression, columnKind, tableProof } from "../scripts/control-d1-codec.mjs";
import {
  readFixedProjectionPages,
  proveFixedProjectionPages,
} from "../scripts/control-d1-readback-pages.mjs";

const require = createRequire(new URL("../packages/database/package.json", import.meta.url)),
  { Pool } = require("pg"),
  execute = promisify(execFile);
let directory, environment, pool, runtime, db, source, columns;
const fields = ["id", "part", "label", "note", "optional_blob", "opaque", "at"];
const sql =
  "SELECT CAST(id AS TEXT) AS id,lower(hex(part)) AS part,label,note,CASE WHEN optional_blob IS NULL THEN NULL ELSE lower(hex(optional_blob)) END AS optional_blob,opaque,at FROM paging_source";
const spec = Object.freeze({
  sql,
  columns: fields,
  keys: [{ column: "id", kind: "integer" }],
  keyProof: {
    kind: "primary-key",
    source: "native PostgreSQL18 paging_source_pkey and Core INTEGER PRIMARY KEY fixture",
  },
});

before(async () => {
  environment = testPostgresEnvironment();
  directory = await mkdtemp(join(tmpdir(), "omh-readback-native-"));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const data = join(directory, "pg");
  await execute("initdb", ["-D", data, "-A", "trust", "-U", "postgres"], { env: environment });
  await execute(
    "pg_ctl",
    [
      "-D",
      data,
      "-l",
      join(directory, "pg.log"),
      "-o",
      `-F -p ${port} -h 127.0.0.1 -k ''`,
      "-w",
      "start",
    ],
    { env: environment },
  );
  pool = new Pool({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres` });
  await pool.query(
    "CREATE TABLE paging_source(id bigint PRIMARY KEY,part bytea NOT NULL,label text NOT NULL,note text,optional_blob bytea,opaque json NOT NULL,at timestamptz NOT NULL,UNIQUE(part,label),CHECK(octet_length(part)=2 AND octet_length(label)<=16))",
  );
  const types = (
    await pool.query(
      "SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid='paging_source'::regclass AND a.attnum>0 ORDER BY a.attnum",
    )
  ).rows;
  columns = types.map((column) => ({
    name: column.name,
    pgType: column.type,
    kind: columnKind(column.type),
  }));
  const constraints = (
    await pool.query(
      "SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='paging_source'::regclass ORDER BY conname",
    )
  ).rows;
  assert.ok(constraints.some((row) => row.definition === "PRIMARY KEY (id)"));
  assert.ok(constraints.some((row) => row.definition === "UNIQUE (part, label)"));
  assert.ok(constraints.some((row) => row.definition.includes("octet_length(part) = 2")));
  for (let index = 0; index < 706; index += 1) {
    const id =
      index === 0
        ? "-9223372036854775808"
        : index === 705
          ? "9223372036854775807"
          : String(9007199254740992n + BigInt(index));
    await pool.query("INSERT INTO paging_source VALUES($1,$2,$3,$4,$5,$6,$7)", [
      id,
      Buffer.from(index.toString(16).padStart(4, "0"), "hex"),
      index === 0 ? "" : "label-" + index,
      index === 300
        ? "\u0001".repeat(50000)
        : index % 3 === 0
          ? null
          : 'quotes"\\\n\u0001é'.repeat(80),
      index % 2 === 0 ? null : Buffer.from("00ff", "hex"),
      '{ "opaque" : [1,1, null, "\\u0001", "é"] }',
      "2026-10-28T12:00:00.123456Z",
    ]);
  }
  source = (
    await pool.query(
      `SELECT ${columns.map((column) => `${captureExpression(column)} AS "${column.name}"`).join(",")} FROM paging_source`,
    )
  ).rows;
  runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script:
        "export default {fetch(){return new Response('unserved readback fixture',{status:503})}}",
      d1Databases: { READBACK: "readback-native" },
    }),
  });
  db = await runtime.getD1Database("READBACK");
  await db
    .prepare(
      "CREATE TABLE paging_source(id INTEGER PRIMARY KEY,part BLOB NOT NULL,label TEXT NOT NULL,note TEXT,optional_blob BLOB,opaque TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(part,label),CHECK(length(part)=2 AND length(CAST(label AS BLOB))<=16))",
    )
    .run();
  for (let start = 0; start < source.length; start += 128)
    await db.batch(
      source
        .slice(start, start + 128)
        .map((row) =>
          db
            .prepare(
              "INSERT INTO paging_source VALUES(CAST(? AS INTEGER),unhex(?),?,?,unhex(?),?,?)",
            )
            .bind(...fields.map((field) => row[field])),
        ),
    );
});

after(async () => {
  await Promise.allSettled([runtime?.dispose(), pool?.end()]);
  if (directory !== undefined) {
    try {
      await execute("pg_ctl", ["-D", join(directory, "pg"), "-m", "immediate", "-w", "stop"], {
        env: environment,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("reads actual PG18/Core typed facts with numeric/hex keysets, bounded escaped pages and a streamed exact proof", async () => {
  let count = 0,
    pages = 0,
    oversized = 0;
  for await (const page of readFixedProjectionPages(db, spec)) {
    assert.ok(page.length <= 128);
    const bytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    if (bytes > 256 * 1024) {
      assert.equal(page.length, 1);
      oversized += 1;
    }
    count += page.length;
    pages += 1;
  }
  assert.equal(count, 706);
  assert.ok(pages > 6);
  assert.equal(oversized, 1);
  const expected = tableProof(
    columns,
    source.map((row) => fields.map((field) => row[field])),
  );
  assert.deepEqual(
    await proveFixedProjectionPages(columns, readFixedProjectionPages(db, spec)),
    expected,
  );
  const composite = {
    ...spec,
    keys: [
      { column: "part", kind: "bytea-hex" },
      { column: "label", kind: "text" },
    ],
    keyProof: {
      kind: "unique-not-null",
      source: "actual native UNIQUE(part,label), both NOT NULL",
    },
  };
  assert.deepEqual(
    await proveFixedProjectionPages(columns, readFixedProjectionPages(db, composite)),
    expected,
  );
  const boundedComposite = {
    ...composite,
    keys: [
      { column: "part", kind: "bytea-hex", maxBytes: 4 },
      { column: "label", kind: "text", maxBytes: 16 },
    ],
    keyProof: {
      kind: "unique-not-null",
      source: "native UNIQUE(part,label), NOT NULL and original fixture octet-length CHECK",
    },
  };
  assert.deepEqual(
    await proveFixedProjectionPages(columns, readFixedProjectionPages(db, boundedComposite)),
    expected,
  );
  const empty = { ...spec, sql: sql + " WHERE 0" };
  assert.deepEqual(
    await proveFixedProjectionPages(columns, readFixedProjectionPages(db, empty)),
    tableProof(columns, []),
  );
  // Candidate/window state contains only keys and byte counts: 128 large values must not be retained there.
  await db.prepare("CREATE TABLE paging_large(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)").run();
  for (let index = 1; index <= 128; index += 1)
    await db.prepare("INSERT INTO paging_large VALUES(?,hex(zeroblob(1048576)))").bind(index).run();
  const large = {
    sql: "SELECT CAST(id AS TEXT) AS id,payload FROM paging_large",
    columns: ["id", "payload"],
    keys: [{ column: "id", kind: "integer" }],
    keyProof: { kind: "primary-key", source: "native Core paging_large INTEGER PRIMARY KEY" },
  };
  let largeRows = 0;
  for await (const page of readFixedProjectionPages(db, large)) {
    assert.equal(page.length, 1);
    assert.equal(Buffer.byteLength(page[0].payload), 2 * 1024 * 1024);
    largeRows += 1;
  }
  assert.equal(largeRows, 128);
  await db.prepare("DROP TABLE paging_large").run();
  await db
    .prepare("CREATE TABLE paging_large_keys(id TEXT NOT NULL PRIMARY KEY,payload TEXT)")
    .run();
  await db.batch([
    db.prepare("INSERT INTO paging_large_keys VALUES('a'||hex(zeroblob(1048575)),NULL)"),
    db.prepare("INSERT INTO paging_large_keys VALUES('b'||hex(zeroblob(1048575)),NULL)"),
  ]);
  let opaqueKeys = 0;
  for await (const page of readFixedProjectionPages(db, {
    ...large,
    sql: "SELECT id,payload FROM paging_large_keys",
    keys: [{ column: "id", kind: "text" }],
    keyProof: {
      kind: "primary-key",
      source: "native nonnull paging_large_keys PK; no width bound",
    },
  })) {
    assert.equal(page.length, 1);
    assert.equal(Buffer.byteLength(page[0].id), 2 * 1024 * 1024 - 1);
    opaqueKeys += 1;
  }
  assert.equal(opaqueKeys, 2);
  await db.prepare("DROP TABLE paging_large_keys").run();
});

test("refuses missing key proof, NULL, invalid or duplicate cursors and a count change instead of silently skipping rows", async () => {
  const collect = async (candidate) => {
    const result = [];
    for await (const page of readFixedProjectionPages(db, candidate)) result.push(...page);
    return result;
  };
  await assert.rejects(collect({ ...spec, keyProof: undefined }), /READBACK_KEY_PROOF_REQUIRED/u);
  await assert.rejects(collect({ ...spec, keys: [] }), /READBACK_KEY_PROOF_REQUIRED/u);
  await assert.rejects(
    collect({ ...spec, keys: [{ column: "id", kind: "integer", maxBytes: -1 }] }),
    /READBACK_KEY_PROOF_REQUIRED/u,
  );
  await assert.rejects(
    collect({
      ...spec,
      sql: "SELECT 'long' AS id",
      columns: ["id"],
      keys: [{ column: "id", kind: "text", maxBytes: 3 }],
    }),
    /CURSOR_WIDTH_PROOF/u,
  );
  await assert.rejects(
    collect({ ...spec, columns: [...fields, fields[0]] }),
    /READBACK_KEY_PROOF_REQUIRED/u,
  );
  await assert.rejects(
    collect({ ...spec, sql: "SELECT missing FROM not_a_source" }),
    /PROJECTION_UNREPRESENTABLE/u,
  );
  await assert.rejects(
    collect({ ...spec, sql: "SELECT NULL AS id", columns: ["id"] }),
    /CURSOR_NULL/u,
  );
  await assert.rejects(collect({ ...spec, sql: "SELECT 1 AS id", columns: ["id"] }), /ROW_VALUE/u);
  await assert.rejects(
    collect({ ...spec, sql: "SELECT '01' AS id", columns: ["id"] }),
    /CONTROL_D1_INTEGER/u,
  );
  await assert.rejects(
    collect({ ...spec, sql: "SELECT '-0' AS id", columns: ["id"] }),
    /CURSOR_INTEGER/u,
  );
  await assert.rejects(
    collect({ ...spec, sql: "SELECT '9223372036854775808' AS id", columns: ["id"] }),
    /INTEGER_RANGE/u,
  );
  await assert.rejects(
    collect({
      ...spec,
      sql: "SELECT 'xx' AS id",
      columns: ["id"],
      keys: [{ column: "id", kind: "bytea-hex" }],
    }),
    /CURSOR_BYTEA/u,
  );
  await assert.rejects(
    collect({ ...spec, sql: "SELECT '1' AS id UNION ALL SELECT '1' AS id", columns: ["id"] }),
    /CURSOR_DUPLICATE/u,
  );
  await assert.rejects(
    collect({
      ...spec,
      sql: "WITH RECURSIVE n(i) AS(SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<129) SELECT '1' AS id FROM n",
      columns: ["id"],
    }),
    /CURSOR_DUPLICATE/u,
  );
  await assert.rejects(
    collect({ ...spec, sql: "SELECT hex(zeroblob(2147483647)) AS id", columns: ["id"] }),
    /PROJECTION_UNREPRESENTABLE/u,
  );
  // The chosen key is rejoined to its actual projection: duplicate byte-boundary facts refuse proof too.
  await assert.rejects(
    collect({
      ...spec,
      sql: "SELECT '1' AS id,replace(hex(zeroblob(50000)),'0','x') AS payload UNION ALL SELECT '1',replace(hex(zeroblob(50000)),'0','x')",
      columns: ["id", "payload"],
    }),
    /CURSOR_DUPLICATE/u,
  );
  const changing = readFixedProjectionPages(db, {
    ...spec,
    sql: "SELECT CAST(id AS TEXT) AS id FROM paging_source",
    columns: ["id"],
  });
  const first = await changing.next();
  assert.equal(first.value.length, 128);
  await db
    .prepare(
      "INSERT INTO paging_source VALUES(0,x'ffff','late',NULL,NULL,'null','2026-10-28T12:00:00.123456Z')",
    )
    .run();
  await assert.rejects(async () => {
    for await (const page of changing) assert.ok(page.length > 0);
  }, /COUNT_CHANGED/u);
  await db.prepare("DELETE FROM paging_source WHERE id=0").run();
});

test("retains duplicate row hashes and source-type/null framing while gating no-PK facts and invalid proof pages", async () => {
  await pool.query(
    "CREATE TABLE paging_no_pk(value text); INSERT INTO paging_no_pk VALUES('same'),('same'),(NULL),('')",
  );
  const duplicates = (await pool.query("SELECT value FROM paging_no_pk")).rows;
  const metadata = [{ name: "value", sourceType: "source_alias", pgType: "text", kind: "text" }];
  const proof = await proveFixedProjectionPages(metadata, [
    duplicates.slice(0, 2),
    duplicates.slice(2),
  ]);
  assert.deepEqual(
    proof,
    tableProof(
      metadata,
      duplicates.map((row) => [row.value]),
    ),
  );
  assert.notDeepEqual(proof, tableProof(metadata, [["same"], [null], [""]]));
  await assert.rejects(proveFixedProjectionPages(metadata, [[{ value: 1 }]]), /ROW_VALUE/u);
  await assert.rejects(proveFixedProjectionPages(metadata, [[{ other: "same" }]]), /PROOF_ROW/u);
  await assert.rejects(proveFixedProjectionPages(metadata, [[]]), /PAGE_SHAPE/u);
  await assert.rejects(
    proveFixedProjectionPages(metadata, [Array.from({ length: 129 }, () => ({ value: "same" }))]),
    /PAGE_SHAPE/u,
  );
  await assert.rejects(proveFixedProjectionPages([], []), /PROOF_COLUMNS/u);
  await assert.rejects(proveFixedProjectionPages([...metadata, ...metadata], []), /PROOF_COLUMNS/u);
  const unproven = readFixedProjectionPages(db, {
    sql: "SELECT value FROM paging_no_pk",
    columns: ["value"],
    keys: [],
  });
  await assert.rejects(unproven.next(), /KEY_PROOF_REQUIRED/u);
});
