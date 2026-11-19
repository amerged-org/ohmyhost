import { Buffer } from "node:buffer";
import { randomUUID, createHmac } from "node:crypto";
import { mkdir, open, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  FORMAT,
  canonical,
  columnKind,
  captureExpression,
  quoteIdentifier,
  sha256,
  seal,
  unseal,
  frameRow,
  fail,
} from "./control-d1-codec.mjs";

export async function writeExclusive(path, bytes) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function readPrivate(path) {
  const info = await lstat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) fail("FILE_PERMISSIONS");
  return readFile(path);
}

/** Captures all ordinary/partitioned source tables, in one snapshot also used by pg_dump. */
export async function capture({
  client,
  dump,
  expectedSource,
  targetPin,
  output,
  key,
  schema = "public",
  chunkRows = 128,
}) {
  if (
    !expectedSource ||
    typeof expectedSource.role !== "string" ||
    typeof expectedSource.database !== "string" ||
    Object.keys(expectedSource).some(
      (name) => !["role", "database", "host", "port", "schema", "environment"].includes(name),
    )
  )
    fail("SOURCE_SPEC");
  if (!Number.isSafeInteger(chunkRows) || chunkRows < 1 || chunkRows > 1000) fail("CHUNK_ROWS");
  if (typeof dump !== "function") fail("DUMP_REQUIRED");
  await mkdir(output, { mode: 0o700 }); // Never overwrite or resume a half-captured source snapshot.
  const captureId = randomUUID();
  let inTransaction = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTransaction = true;
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL DateStyle = 'ISO, YMD'");
    await client.query("SET LOCAL extra_float_digits = 3");
    const identity = (
      await client.query(
        "SELECT current_user AS role, current_database() AS database, current_setting('server_version_num') AS version",
      )
    ).rows[0];
    if (
      identity.role !== expectedSource.role ||
      identity.database !== expectedSource.database ||
      !/^18[0-9]{4}$/u.test(identity.version)
    )
      fail("SOURCE_IDENTITY");
    const snapshot = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0]
      .snapshot;
    const sourceSchema = (
      await client.query(
        `SELECT c.relname AS name, c.relkind AS kind, pg_get_partkeydef(c.oid) AS partition_key
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','p')
      AND NOT c.relispartition ORDER BY c.relname`,
        [schema],
      )
    ).rows;
    const manifest = {
      format: FORMAT,
      captureId,
      capturedAt: new Date().toISOString(),
      qualificationOnly: true,
      source: { ...identity, schema, expected: expectedSource },
      targetPin,
      tables: [],
      views: (
        await client.query(
          `SELECT c.relname AS name, pg_get_viewdef(c.oid,true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind='v' ORDER BY c.relname`,
          [schema],
        )
      ).rows,
      sequences: [],
      sequenceStateConsistency:
        "non-mvcc; final qualification requires source writer freeze and drain",
      recovery: null,
    };
    for (let tableIndex = 0; tableIndex < sourceSchema.length; tableIndex += 1) {
      const table = sourceSchema[tableIndex];
      const columns = (
        await client.query(
          `SELECT a.attname AS name,
        format_type(CASE WHEN t.typtype='d' THEN t.typbasetype ELSE a.atttypid END, CASE WHEN t.typtype='d' THEN t.typtypmod ELSE a.atttypmod END) AS "pgType",
        format_type(a.atttypid,a.atttypmod) AS "sourceType",
        a.attnotnull AS "notNull", pg_get_expr(d.adbin,d.adrelid) AS "default", a.attgenerated AS generated,
        a.attidentity AS identity FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
          [`${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`],
        )
      ).rows.map((column) => ({ ...column, kind: columnKind(column.pgType) }));
      const constraints = (
        await client.query(
          `SELECT conname AS name, contype AS type, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname`,
          [`${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`],
        )
      ).rows;
      const indexes = (
        await client.query(
          `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname=$1 AND tablename=$2 ORDER BY indexname`,
          [schema, table.name],
        )
      ).rows;
      const entry = { ...table, columns, constraints, indexes, chunks: [], rows: "0", sha256: "" };
      const hashes = [];
      const cursor = `omh_capture_${tableIndex}`;
      await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR SELECT ${columns.map((column) => `${captureExpression(column)} AS ${quoteIdentifier(column.name)}`).join(",")}
        FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`);
      for (;;) {
        const batch = (await client.query(`FETCH ${chunkRows} FROM ${cursor}`)).rows;
        if (batch.length === 0) break;
        const values = batch.map((row) => columns.map((column) => row[column.name]));
        for (const row of values) hashes.push(sha256(frameRow(columns, row)));
        const file = `table-${String(tableIndex).padStart(4, "0")}-${String(entry.chunks.length).padStart(6, "0")}.enc`;
        const bytes = seal(key, captureId, file, Buffer.from(canonical(values)));
        await writeExclusive(join(output, file), bytes);
        entry.chunks.push({ file, rows: String(values.length), sha256: sha256(bytes) });
      }
      await client.query(`CLOSE ${cursor}`);
      entry.rows = String(hashes.length);
      entry.sha256 = sha256(Buffer.from(hashes.sort().join("\n")));
      manifest.tables.push(entry);
    }
    const definitions = (
      await client.query(
        `SELECT c.relname AS name, format_type(s.seqtypid,NULL) AS data_type,
      s.seqstart::text AS start_value,s.seqincrement::text AS increment_by,s.seqmin::text AS min_value,
      s.seqmax::text AS max_value,s.seqcache::text AS cache_size,s.seqcycle AS cycle,
      owner.relname AS owned_table,a.attname AS owned_column
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_sequence s ON s.seqrelid=c.oid
      LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=c.oid AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
      LEFT JOIN pg_class owner ON owner.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
      WHERE n.nspname=$1 AND c.relkind='S' ORDER BY c.relname`,
        [schema],
      )
    ).rows;
    for (const definition of definitions) {
      const state = (
        await client.query(
          `SELECT last_value::text AS last_value,is_called FROM ${quoteIdentifier(schema)}.${quoteIdentifier(definition.name)}`,
        )
      ).rows[0];
      manifest.sequences.push({
        ...definition,
        state: { ...state, observed_at: new Date().toISOString() },
      });
    }
    // The resolver must produce PG18 custom format using exactly this still-live exported ROW snapshot.
    // Sequence state is not MVCC; final writer freeze, not --snapshot alone, makes it coherent.
    const recovery = Buffer.from(await dump({ snapshot, schema }));
    if (recovery.subarray(0, 5).toString() !== "PGDMP") fail("DUMP_FORMAT");
    const dumpFile = "recovery.pgcustom.enc";
    const dumpBytes = seal(key, captureId, dumpFile, recovery);
    await writeExclusive(join(output, dumpFile), dumpBytes);
    manifest.recovery = {
      file: dumpFile,
      sha256: sha256(dumpBytes),
      plaintextSha256: sha256(recovery),
    };
    manifest.sourceSchemaSha256 = sha256(
      Buffer.from(
        canonical({
          tables: manifest.tables.map((table) =>
            Object.fromEntries(
              Object.entries(table).filter(
                ([name]) => !["chunks", "rows", "sha256"].includes(name),
              ),
            ),
          ),
          views: manifest.views,
          sequences: manifest.sequences.map((sequence) =>
            Object.fromEntries(Object.entries(sequence).filter(([name]) => name !== "state")),
          ),
        }),
      ),
    );
    const bytes = seal(key, captureId, "manifest.enc", Buffer.from(canonical(manifest)));
    await writeExclusive(join(output, "manifest.enc"), bytes);
    await writeExclusive(
      join(output, "capture-index.json"),
      canonical({ format: FORMAT, captureId, sha256: sha256(bytes) }),
    );
    return {
      captureId,
      tables: manifest.tables.length,
      manifestSha256: sha256(bytes),
      qualificationOnly: true,
    };
  } finally {
    if (inTransaction) await client.query("ROLLBACK");
  }
}

/** An authenticated complete source image. Reading every chunk is required before any target write. */
export async function openCapture({ directory, key }) {
  const index = JSON.parse((await readPrivate(join(directory, "capture-index.json"))).toString());
  if (index.format !== FORMAT || !/^[a-f0-9-]{36}$/u.test(index.captureId)) fail("MANIFEST");
  const encrypted = await readPrivate(join(directory, "manifest.enc"));
  if (sha256(encrypted) !== index.sha256) fail("MANIFEST_DIGEST");
  const manifest = JSON.parse(unseal(key, index.captureId, "manifest.enc", encrypted).toString());
  if (
    manifest.format !== FORMAT ||
    manifest.captureId !== index.captureId ||
    !Array.isArray(manifest.tables) ||
    !Array.isArray(manifest.views) ||
    !Array.isArray(manifest.sequences)
  )
    fail("MANIFEST");
  const rows = new Map();
  for (const table of manifest.tables) {
    if (rows.has(table.name)) fail("TABLE_DUPLICATE");
    const values = [];
    for (const chunk of table.chunks) {
      if (!/^table-[0-9]{4}-[0-9]{6}\.enc$/u.test(chunk.file)) fail("CHUNK_PATH");
      const bytes = await readPrivate(join(directory, chunk.file));
      if (sha256(bytes) !== chunk.sha256) fail("CHUNK_DIGEST");
      const batch = JSON.parse(unseal(key, manifest.captureId, chunk.file, bytes).toString());
      if (!Array.isArray(batch) || String(batch.length) !== chunk.rows) fail("CHUNK_SHAPE");
      values.push(...batch);
    }
    const hashes = values.map((row) => sha256(frameRow(table.columns, row))).sort();
    if (
      String(values.length) !== table.rows ||
      sha256(Buffer.from(hashes.join("\n"))) !== table.sha256
    )
      fail("TABLE_PROOF");
    rows.set(
      table.name,
      values.map((row) =>
        Object.fromEntries(table.columns.map((column, position) => [column.name, row[position]])),
      ),
    );
  }
  const recovery = manifest.recovery;
  if (recovery.file !== "recovery.pgcustom.enc") fail("DUMP_FORMAT");
  const bytes = await readPrivate(join(directory, recovery.file));
  if (sha256(bytes) !== recovery.sha256) fail("DUMP_DIGEST");
  const plainDump = unseal(key, manifest.captureId, recovery.file, bytes);
  if (
    sha256(plainDump) !== recovery.plaintextSha256 ||
    plainDump.subarray(0, 5).toString() !== "PGDMP"
  )
    fail("DUMP_DIGEST");
  return { manifest, manifestSha256: index.sha256, rows, recoveryBytes: plainDump };
}

const JOURNAL_TAILS = new Map();
/** External, authenticated append-only journal; it remains usable when Control itself is unavailable. */
export async function appendJournal(path, key, event) {
  let prior = "0".repeat(64);
  let info = null;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tail = JOURNAL_TAILS.get(path);
  // A tail remembered from this process's own last append is trusted only while the file is byte-for-byte as left;
  // any other size or modification re-verifies the whole chain, so a forked appender still fails closed.
  if (info && tail && tail.size === info.size && tail.mtimeMs === info.mtimeMs) prior = tail.mac;
  else if (info) {
    const text = (await readPrivate(path)).toString();
    for (const line of text.split("\n").filter(Boolean)) {
      const item = JSON.parse(line);
      const expected = createHmac("sha256", key)
        .update(`${prior}\n${canonical(item.event)}`)
        .digest("hex");
      if (item.previous !== prior || item.mac !== expected) fail("JOURNAL");
      prior = item.mac;
    }
  }
  const mac = createHmac("sha256", key)
    .update(`${prior}\n${canonical(event)}`)
    .digest("hex");
  const file = await open(path, "a", 0o600);
  try {
    await file.writeFile(`${canonical({ previous: prior, event, mac })}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  const written = await lstat(path);
  JOURNAL_TAILS.set(path, { mac, size: written.size, mtimeMs: written.mtimeMs });
}
