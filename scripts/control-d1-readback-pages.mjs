import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fail, frameRow, integerText, quoteIdentifier, sha256 } from "./control-d1-codec.mjs";

const PAGE_ROWS = 128;
const PAGE_BYTES = 256 * 1024;

function keyExpression(key, qualifier) {
  const name =
    (qualifier === undefined ? "" : quoteIdentifier(qualifier) + ".") + quoteIdentifier(key.column);
  return key.kind === "integer" ? `CAST(${name} AS INTEGER)` : `${name} COLLATE BINARY`;
}

function validateSpec(spec) {
  if (
    spec === null ||
    typeof spec !== "object" ||
    typeof spec.sql !== "string" ||
    !/^\s*(?:SELECT|WITH)\b/iu.test(spec.sql) ||
    !Array.isArray(spec.columns) ||
    spec.columns.length === 0 ||
    spec.columns.some((column) => typeof column !== "string" || column === "") ||
    new Set(spec.columns).size !== spec.columns.length ||
    !Array.isArray(spec.keys) ||
    spec.keys.length === 0 ||
    new Set(spec.keys.map((key) => key?.column)).size !== spec.keys.length ||
    spec.keys.some(
      (key) =>
        !spec.columns.includes(key?.column) ||
        !["text", "integer", "bytea-hex"].includes(key?.kind) ||
        (key.maxBytes !== undefined && (!Number.isSafeInteger(key.maxBytes) || key.maxBytes < 0)),
    ) ||
    !["primary-key", "unique-not-null", "owner-qualified"].includes(spec.keyProof?.kind) ||
    typeof spec.keyProof?.source !== "string" ||
    spec.keyProof.source.trim() === "" ||
    spec.columns.some((column) => column.startsWith("__omh_readback_"))
  )
    fail("READBACK_KEY_PROOF_REQUIRED");
}

async function query(db, sql, bindings = []) {
  try {
    const result = await db
      .prepare(sql)
      .bind(...bindings)
      .all();
    if (!Array.isArray(result?.results)) fail("READBACK_RESPONSE");
    return result.results;
  } catch (cause) {
    throw new Error("CONTROL_D1_READBACK_PROJECTION_UNREPRESENTABLE", { cause });
  }
}

function cursor(row, spec) {
  if (
    row === null ||
    typeof row !== "object" ||
    spec.columns.some((column) => row[column] !== null && typeof row[column] !== "string")
  )
    fail("READBACK_ROW_VALUE");
  return spec.keys.map((key) => {
    const value = row[key.column];
    if (value === null) fail("READBACK_CURSOR_NULL");
    if (key.maxBytes !== undefined && Buffer.byteLength(value, "utf8") > key.maxBytes)
      fail("READBACK_CURSOR_WIDTH_PROOF");
    if (key.kind === "integer" && BigInt(integerText(value)).toString() !== value)
      fail("READBACK_CURSOR_INTEGER");
    if (key.kind === "bytea-hex" && !/^(?:[a-f0-9]{2})*$/u.test(value))
      fail("READBACK_CURSOR_BYTEA");
    return value;
  });
}

/**
 * Local fixed domain projections only. The owner must qualify actual unique/non-NULL key provenance against
 * its schema and native fixtures before registration. Read the frozen, unserved target; this is no live
 * snapshot or RPC/SQL endpoint. Values are original source-shaped strings/NULL, never rounded JS integers.
 */
export async function* readFixedProjectionPages(db, spec) {
  validateSpec(spec);
  const keyColumns = spec.keys.map((key) => quoteIdentifier(key.column)).join(","),
    order = spec.keys.map((key) => keyExpression(key)).join(","),
    countSql = `SELECT CAST(count(*) AS TEXT) AS n FROM (${spec.sql}) AS original`,
    count = (await query(db, countSql))[0]?.n;
  if (typeof count !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count)) fail("READBACK_COUNT");
  const expected = BigInt(count);
  // A width is original schema/owner proof, never a new value cap. Opaque unbounded keys use one candidate.
  const widths = spec.keys.map((key) => (key.kind === "integer" ? 20 : key.maxBytes)),
    keyRowBytes = widths.some((width) => width === undefined)
      ? undefined
      : widths.reduce((size, width) => Math.min(PAGE_BYTES + 1, size + width), 0),
    candidates =
      keyRowBytes === undefined
        ? 1
        : Math.max(1, Math.min(PAGE_ROWS, Math.floor(PAGE_BYTES / Math.max(1, keyRowBytes))));
  // Six bytes per original UTF8 byte bounds JSON control/quote escaping without SQL json_quote expansion.
  const bytes =
    2 +
    spec.columns.reduce(
      (size, column) => size + Buffer.byteLength(JSON.stringify(column), "utf8") + 8,
      0,
    );
  const estimate = spec.columns
    .map((column) => `6*coalesce(length(CAST(${quoteIdentifier(column)} AS BLOB)),0)`)
    .join("+");
  let after = null,
    observed = 0n;
  for (;;) {
    const predicates = spec.keys.map((key, index) =>
      key.kind === "integer" ? `CAST(?${index + 1} AS INTEGER)` : `?${index + 1} COLLATE BINARY`,
    );
    // Window state holds only keys/lengths; full values are fetched only for the chosen keys.
    const page = await query(
      db,
      candidates === 1
        ? `SELECT ${spec.columns.map(quoteIdentifier).join(",")} FROM (${spec.sql}) AS original${after === null ? "" : ` WHERE (${order})>(${predicates.join(",")})`} ORDER BY ${order} LIMIT 1`
        : `WITH candidates AS (SELECT ${keyColumns},${bytes}+${estimate} AS __omh_readback_bytes FROM (${spec.sql}) AS original${after === null ? "" : ` WHERE (${order})>(${predicates.join(",")})`} ORDER BY ${order} LIMIT ${candidates}), sized AS (SELECT *,row_number() OVER (ORDER BY ${order}) AS __omh_readback_row,sum(__omh_readback_bytes) OVER (ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS __omh_readback_total FROM candidates), chosen AS (SELECT ${keyColumns} FROM sized WHERE __omh_readback_row=1 OR __omh_readback_total<=${PAGE_BYTES}) SELECT ${spec.columns.map((column) => `facts.${quoteIdentifier(column)}`).join(",")} FROM (${spec.sql}) AS facts JOIN chosen ON ${spec.keys.map((key) => `${keyExpression(key, "facts")} IS ${keyExpression(key, "chosen")}`).join(" AND ")} ORDER BY ${spec.keys.map((key) => keyExpression(key, "facts")).join(",")} LIMIT ${candidates + 1}`,
      after ?? [],
    );
    if (page.length === 0) break;
    if (page.length > candidates) fail("READBACK_CURSOR_DUPLICATE");
    let previous = after;
    for (const row of page) {
      const next = cursor(row, spec);
      if (previous !== null && JSON.stringify(previous) === JSON.stringify(next))
        fail("READBACK_CURSOR_DUPLICATE");
      previous = next;
    }
    observed += BigInt(page.length);
    if (observed > expected) fail("READBACK_COUNT_CHANGED");
    after = previous;
    yield page;
  }
  // A duplicate key at a byte/row boundary must fail, rather than silently skipping its remaining rows.
  if (observed !== expected || (await query(db, countSql))[0]?.n !== count)
    fail("READBACK_COUNT_CHANGED");
}

async function writeSortedRun(path, hashes) {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(hashes.sort().join("\n") + "\n");
  } finally {
    await file.close();
  }
}

async function* sortedLines(path) {
  const stream = createReadStream(path, { encoding: "utf8", highWaterMark: 4096 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function mergeRuns(leftPath, rightPath, output) {
  const left = sortedLines(leftPath),
    right = sortedLines(rightPath),
    file = await open(output, "wx", 0o600);
  try {
    let a = await left.next(),
      b = await right.next();
    while (!a.done || !b.done) {
      if (b.done || (!a.done && a.value <= b.value)) {
        await file.writeFile(a.value + "\n");
        a = await left.next();
      } else {
        await file.writeFile(b.value + "\n");
        b = await right.next();
      }
    }
  } finally {
    await Promise.all([left.return(), right.return(), file.close()]);
  }
  await Promise.all([rm(leftPath), rm(rightPath)]);
}

/** Same typed framing and sorted hash multiplicity as tableProof, with bounded rows/hashes/merge streams. */
export async function proveFixedProjectionPages(columns, pages) {
  if (
    !Array.isArray(columns) ||
    columns.length === 0 ||
    new Set(columns.map((column) => column?.name)).size !== columns.length
  )
    fail("READBACK_PROOF_COLUMNS");
  const directory = await mkdtemp(join(tmpdir(), "omh-readback-proof-")),
    levels = [];
  let rows = 0n,
    fileNumber = 0n;
  try {
    for await (const page of pages) {
      if (!Array.isArray(page) || page.length === 0 || page.length > PAGE_ROWS)
        fail("READBACK_PAGE_SHAPE");
      const hashes = page.map((row) => {
        if (
          row === null ||
          typeof row !== "object" ||
          Object.keys(row).length !== columns.length ||
          columns.some((column) => !Object.hasOwn(row, column.name))
        )
          fail("READBACK_PROOF_ROW");
        return sha256(
          frameRow(
            columns,
            columns.map((column) => row[column.name]),
          ),
        );
      });
      rows += BigInt(page.length);
      let run = join(directory, String(fileNumber++)),
        level = 0;
      await writeSortedRun(run, hashes);
      while (levels[level] !== undefined) {
        const merged = join(directory, String(fileNumber++));
        await mergeRuns(levels[level], run, merged);
        levels[level++] = undefined;
        run = merged;
      }
      levels[level] = run;
    }
    let result;
    for (const run of levels) {
      if (run === undefined) continue;
      if (result === undefined) result = run;
      else {
        const merged = join(directory, String(fileNumber++));
        await mergeRuns(result, run, merged);
        result = merged;
      }
    }
    const digest = createHash("sha256");
    let first = true;
    if (result !== undefined)
      for await (const line of sortedLines(result)) {
        digest.update((first ? "" : "\n") + line);
        first = false;
      }
    return { rows: rows.toString(), sha256: digest.digest("hex") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
