/* global AbortSignal, fetch, process, setTimeout */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { appendJournal } from "./control-d1-artifacts.mjs";
import { importBatches } from "./control-d1-batches.mjs";
import { canonical, fail, quoteIdentifier, sha256 } from "./control-d1-codec.mjs";
import {
  contextGuard,
  recordDescriptor,
  recordStatements,
  schemaFingerprint,
  schemaOf,
  splitSql,
} from "./control-d1-target.mjs";

/**
 * Import-API transport. The records of a round are rendered as SQL files and applied through
 * `POST /d1/database/<id>/import`, which takes a whole file or none of it. Each file is what `importPlan` writes for
 * a batch, only longer: the same context guard, the same overlay triggers dropped before and recreated after the
 * inserts, and ONE `command_log` receipt inserted by the file itself, so the receipt exists exactly when the rows do. A file that failed or whose reply was lost is re-run after the receipt says it did not land.
 *
 * Limits measured on a real EU D1: 1M rows (505 MB) in one file ingests at a flat 2.4 k rows/s; a statement over
 * 100 000 bytes is refused (SQLITE_TOOBIG); `PRAGMA defer_foreign_keys` and `BEGIN` are refused or ignored in a file,
 * so foreign-key parents come first and a cycle (`deferForeignKeys` unit) can only use the ordinary batch path.
 */
export const BULK_LIMITS = Object.freeze({
  recordsPerFile: 200_000,
  bytesPerFile: 100_000_000,
  statementBytes: 90_000,
  minimumRun: 1_000,
});

const LITERAL = "BULK_LITERAL";

/** Exact SQL literal of a bound value: int8 stays decimal text under CAST, bytes become X'..', text is quote-doubled. */
export function renderLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    if (value.includes("\u0000") || !value.isWellFormed()) fail(LITERAL);
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (value instanceof Uint8Array)
    return `X'${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("hex")}'`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return fail(LITERAL);
}

const TEMPLATES = new Map();
/** A statement split at its placeholders: literal text pieces and the parameter number each placeholder takes. */
function template(sql) {
  let parsed = TEMPLATES.get(sql);
  if (parsed) return parsed;
  const pieces = [],
    numbers = [];
  let max = 0,
    start = 0;
  for (let index = 0; index < sql.length; ) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === character) {
          if (sql[index + 1] === character) {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      index += 1;
    } else if (character === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
    } else if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
    } else if (character === "?") {
      let end = index + 1;
      while (end < sql.length && sql[end] >= "0" && sql[end] <= "9") end += 1;
      const number = end > index + 1 ? Number(sql.slice(index + 1, end)) : max + 1;
      max = Math.max(max, number);
      pieces.push(sql.slice(start, index));
      numbers.push(number);
      start = end;
      index = end;
    } else index += 1;
  }
  pieces.push(sql.slice(start));
  parsed = { pieces, numbers, max };
  if (TEMPLATES.size > 4096) TEMPLATES.clear();
  TEMPLATES.set(sql, parsed);
  return parsed;
}

/** `{sql, params}` as one executable statement. A statement without parameters is emitted byte for byte. */
export function renderStatement({ sql, params }) {
  if (params.length === 0) return sql;
  const { pieces, numbers, max } = template(sql);
  if (max !== params.length) fail(LITERAL);
  let text = pieces[0];
  for (let index = 0; index < numbers.length; index += 1)
    text += renderLiteral(params[numbers[index] - 1]) + pieces[index + 1];
  return text;
}

/** A `db` for `importPlan`'s statement builders that records `{sql, params}` instead of preparing anything. */
const rendering = Object.freeze({
  prepare(sql) {
    const bind = (...params) => ({ sql, params, bind });
    return { sql, params: [], bind };
  },
});

/** The records of a unit as far as their statements can be rendered: no NUL, no lone surrogate, every statement short. */
function renderable(records, limits) {
  for (const record of records) {
    let bytes = 200;
    for (const value of Object.values(record.row)) {
      if (value === null) continue;
      if (typeof value !== "string" || value.includes("\u0000") || !value.isWellFormed())
        return false;
      bytes +=
        Buffer.byteLength(value) + 30 + (value.length > 64 ? (value.match(/'/gu)?.length ?? 0) : 0);
    }
    if (bytes > limits.statementBytes) return false;
  }
  return true;
}

/** Consecutive units that can go into files, and the rest, which keeps the ordinary batch path and its read-back. */
export function bulkSegments(plan, batchRows, limits = BULK_LIMITS) {
  const units = importBatches(plan.records, 1);
  const kinds = units.map((unit) =>
    unit.deferred || !renderable(unit.records, limits) ? "batch" : "bulk",
  );
  const runs = [];
  for (let from = 0; from < units.length; ) {
    let to = from,
      rows = 0;
    while (to < units.length && kinds[to] === kinds[from]) rows += units[to++].records.length;
    runs.push({ kind: kinds[from], from, to, rows });
    from = to;
  }
  // A short run costs more as a file (about 1.2 s of fixed API time) than through the batch path.
  for (const run of runs)
    if (run.kind === "bulk" && run.rows < limits.minimumRun) run.kind = "batch";
  const segments = [];
  for (const run of runs) {
    const last = segments.at(-1);
    if (last && last.kind === run.kind && run.kind === "batch") {
      last.to = run.to;
      last.rows += run.rows;
    } else segments.push({ ...run });
  }
  return segments.map((segment) => ({
    kind: segment.kind,
    rows: segment.rows,
    units: units.slice(segment.from, segment.to),
    ...(segment.kind === "batch"
      ? {
          offset: units[segment.from].offset,
          batches: importBatches(
            units.slice(segment.from, segment.to).flatMap((unit) => unit.records),
            batchRows,
          ).map((batch) => ({ ...batch, offset: units[segment.from].offset + batch.offset })),
        }
      : {}),
  }));
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** The D1 import API as one function: init, upload, ingest, poll. Credentials and statements never reach an error. */
export function importApiClient({
  accountId,
  databaseId,
  token = process.env.CLOUDFLARE_API_TOKEN,
  fetch: fetcher = fetch,
  pause = sleep,
}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !/^[a-f0-9-]{36}$/u.test(databaseId ?? ""))
    fail("IMPORT_API_TARGET");
  if (typeof token !== "string" || token.length === 0) fail("IMPORT_API_CREDENTIAL");
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/import`;
  const post = async (body) => {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetcher(base, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(300_000),
      });
      if (response.status === 429 && attempt < 8) {
        await pause(15_000 * (attempt + 1));
        continue;
      }
      const envelope = await response.json().catch(() => null);
      if (!response.ok || envelope?.success !== true || !envelope.result)
        fail("IMPORT_API_REQUEST");
      return envelope.result;
    }
  };
  return async function applyFile(bytes) {
    const etag = createHash("md5").update(bytes).digest("hex");
    let state = await post({ action: "init", etag });
    if (state.upload_url) {
      const upload = await fetcher(state.upload_url, {
        method: "PUT",
        body: bytes,
        redirect: "error",
        signal: AbortSignal.timeout(600_000),
      });
      if (upload.status !== 200 || upload.headers.get("etag")?.replace(/^"|"$/gu, "") !== etag)
        fail("IMPORT_API_UPLOAD");
      state = await post({ action: "ingest", filename: state.filename, etag });
    }
    for (let polls = 0; polls < 3600; polls += 1) {
      if (state.success === false || state.status === "error") {
        const error = new Error("CONTROL_D1_IMPORT_FILE_FAILED");
        // The provider text names a constraint or a limit, never a row value.
        error.detail = {
          provider: String(state.error ?? state.errors?.join(" ") ?? "").slice(0, 200),
        };
        error.userCaused =
          state.isUserCaused === true || /constraint|too long|syntax/iu.test(error.detail.provider);
        throw error;
      }
      if (state.status === "complete") return state.result ?? {};
      if (typeof state.at_bookmark !== "string") fail("IMPORT_API_REQUEST");
      state = await post({ action: "poll", current_bookmark: state.at_bookmark });
    }
    return fail("IMPORT_API_TIMEOUT");
  };
}

/** Whole-table page reads through the REST query endpoint: one request carries a batch of statements. */
export function restQuery({
  accountId,
  databaseId,
  token = process.env.CLOUDFLARE_API_TOKEN,
  fetch: fetcher = fetch,
  pause = sleep,
}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !/^[a-f0-9-]{36}$/u.test(databaseId ?? ""))
    fail("IMPORT_API_TARGET");
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return async function query(statements) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetcher(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ batch: statements.map(({ sql, params }) => ({ sql, params })) }),
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if ((response.status === 429 || response.status >= 500) && attempt < 8) {
        await pause(5_000 * (attempt + 1));
        continue;
      }
      const envelope = await response.json().catch(() => null);
      if (
        !response.ok ||
        envelope?.success !== true ||
        envelope.result?.length !== statements.length
      )
        fail("IMPORT_API_REQUEST");
      return envelope.result.map((entry) => entry.results);
    }
  };
}

/** The same reads through a D1 binding, for a local target. */
export function bindingQuery(db) {
  return async (statements) =>
    (await db.batch(statements.map(({ sql, params }) => db.prepare(sql).bind(...params)))).map(
      (entry) => entry.results,
    );
}

/** A file applier for a local D1 binding: the same all-or-nothing, foreign keys immediate, as the import API. */
export function bindingApplier(db) {
  return async (bytes) => {
    await db.batch(splitSql(bytes.toString("utf8")).map((statement) => db.prepare(statement)));
    return {};
  };
}

const projection = (column) =>
  column.type === "INTEGER"
    ? `CAST(${quoteIdentifier(column.name)} AS TEXT) AS ${quoteIdentifier(column.name)}`
    : column.type === "BLOB"
      ? `CASE WHEN ${quoteIdentifier(column.name)} IS NULL THEN NULL ELSE lower(hex(${quoteIdentifier(column.name)})) END AS ${quoteIdentifier(column.name)}`
      : quoteIdentifier(column.name);

/**
 * Exact comparison by whole-table page scans. For every table the records name, the target is read once in key order and
 * each record must be found with every mapped column equal (int8 as text, bytes as hex). `exact` additionally refuses
 * rows the records do not name and compares count and SHA-256 multiset of the table. Returns the mismatching records'
 * indexes; `report` receives one `{table, rows, sha256}` proof per table.
 */
export async function comparePages(
  db,
  records,
  { query, exact = false, pageRows = 5000, parallel = 4, report } = {},
) {
  const read = query ?? bindingQuery(db);
  const tables = new Map();
  records.forEach((record, index) => {
    if (!tables.has(record.table)) tables.set(record.table, []);
    tables.get(record.table).push(index);
  });
  const plans = [];
  for (const [table, indexes] of tables) {
    const schema = await schemaOf(db, table);
    const names = new Set(indexes.flatMap((index) => Object.keys(records[index].row)));
    const columns = schema.filter((column) => column.hidden === 0 && names.has(column.name));
    const keys = schema.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const width = Math.ceil(
      indexes.reduce(
        (sum, index) =>
          sum +
          Object.values(records[index].row).reduce(
            (n, value) => n + (value === null ? 4 : value.length),
            40,
          ),
        0,
      ) / indexes.length,
    );
    plans.push({
      table,
      indexes,
      columns,
      keys,
      rows: Math.max(50, Math.min(pageRows, Math.floor(2_000_000 / width))),
    });
  }
  const counts = [];
  for (let from = 0; from < plans.length; from += 50) {
    const slice = plans.slice(from, from + 50);
    const answers = await read(
      slice.map((plan) => ({
        sql: `SELECT count(*) AS n FROM ${quoteIdentifier(plan.table)}`,
        params: [],
      })),
    );
    slice.forEach((plan, index) => counts.push(Number(answers[index][0].n)));
  }
  for (const [position, plan] of plans.entries()) plan.total = counts[position];
  const page = (plan, offset) => ({
    sql: `SELECT ${plan.columns.map(projection).join(",")} FROM ${quoteIdentifier(plan.table)} ORDER BY ${plan.keys.map((key) => quoteIdentifier(key.name)).join(",")} LIMIT ${plan.rows} OFFSET ${offset}`,
    params: [],
  });
  // A few requests in flight in all; a big table is read page by page, small tables share one request.
  let inFlight = 0;
  const waiting = [];
  const limited = async (statements) => {
    if (inFlight >= parallel) await new Promise((resolve) => waiting.push(resolve));
    inFlight += 1;
    try {
      return await read(statements);
    } finally {
      inFlight -= 1;
      waiting.shift()?.();
    }
  };
  const work = [];
  for (const plan of plans) {
    const small = plan.total <= plan.rows;
    const last = work.at(-1);
    if (small && last?.small && last.rows + plan.total <= 2 * pageRows && last.plans.length < 40) {
      last.plans.push(plan);
      last.rows += plan.total;
    } else work.push({ small, rows: plan.total, plans: [plan] });
  }
  const mismatches = [];
  const compareTable = (plan, pages) => {
    const found = new Map();
    for (const rows of pages)
      for (const row of rows) found.set(canonical(plan.keys.map((key) => row[key.name])), row);
    const expectedHashes = [],
      actualHashes = [];
    const matched = new Set();
    for (const index of plan.indexes) {
      const record = records[index];
      const key = canonical(plan.keys.map((column) => record.row[column.name]));
      const row = found.get(key);
      const expected = canonical(record.row);
      expectedHashes.push(sha256(Buffer.from(expected)));
      if (row === undefined) {
        mismatches.push(index);
        continue;
      }
      matched.add(key);
      const actual = canonical(
        Object.fromEntries(Object.keys(record.row).map((name) => [name, row[name]])),
      );
      actualHashes.push(sha256(Buffer.from(actual)));
      if (actual !== expected) mismatches.push(index);
    }
    const extra = found.size - matched.size;
    if (exact && (extra > 0 || plan.total !== plan.indexes.length))
      mismatches.push(...plan.indexes.slice(0, 1));
    report?.({
      table: plan.table,
      rows: plan.total,
      expected: plan.indexes.length,
      extra,
      sha256: sha256(Buffer.from(actualHashes.sort().join("\n"))),
      expectedSha256: sha256(Buffer.from(expectedHashes.sort().join("\n"))),
    });
  };
  let next = 0;
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      for (;;) {
        const item = work[next++];
        if (item === undefined) return;
        if (item.small) {
          const answers = await limited(item.plans.map((plan) => page(plan, 0)));
          item.plans.forEach((plan, index) => compareTable(plan, [answers[index]]));
        } else {
          const [plan] = item.plans;
          const pages = await Promise.all(
            Array.from({ length: Math.ceil(plan.total / plan.rows) }, (_, number) =>
              limited([page(plan, number * plan.rows)]).then(([rows]) => rows),
            ),
          );
          compareTable(plan, pages);
        }
      }
    }),
  );
  return [...new Set(mismatches)].sort((a, b) => a - b);
}

async function waitForDatabase(db, pause) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await db.prepare("SELECT 1 AS ok").first();
      return;
    } catch {
      await pause(Math.min(30_000, 2_000 * (attempt + 1)));
    }
  }
  fail("IMPORT_API_TIMEOUT");
}

/**
 * The transport object `importPlan` takes as `bulk`. `apply(bytes)` runs one file (the import API, or
 * `bindingApplier` on a local target); `query` reads pages for the exact comparison.
 */
export function importApiBulk({
  apply,
  query,
  limits = BULK_LIMITS,
  pause = sleep,
  attempts = 3,
  onFile,
  parallel = 4,
  compareOnImport = true,
}) {
  async function run(session) {
    const {
      db,
      plan,
      targetId,
      key,
      journal,
      batchRows,
      overlay,
      runtimeSchema,
      applied,
      context,
    } = session;
    const readReceipt = (commandId) =>
      db
        .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
        .bind(commandId)
        .first();

    /** A file under construction: the context guard and trigger drop first, units appended, the tail on `finish`. */
    const open = () => {
      const head = [contextGuard(rendering, context)];
      for (const trigger of overlay.triggers)
        head.push(rendering.prepare(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`));
      const inserts = [],
        hash = createHash("sha256");
      let rows = 0,
        bytes = 0,
        first;
      return {
        get rows() {
          return rows;
        },
        get bytes() {
          return bytes;
        },
        async add(unit) {
          first ??= unit.offset;
          const descriptors = await Promise.all(
            unit.records.map((record) => recordDescriptor(db, record, { statement: false })),
          );
          const built = [];
          recordStatements(
            rendering,
            unit.records,
            descriptors.map((descriptor) => ({ ...descriptor, existing: null })),
            built,
            { parameterLimit: 0 },
          );
          for (const statement of built) {
            const text = renderStatement(statement);
            if (Buffer.byteLength(text) > 99_000) fail("BULK_STATEMENT_TOO_LONG");
            hash.update(text).update(";\n");
            inserts.push(text);
            bytes += text.length + 2;
          }
          rows += unit.records.length;
        },
        finish() {
          const digest = hash.digest("hex");
          const commandId = `control-d1-import-file:v1:${plan.captureId}:${targetId}:${first}:${rows}`;
          const result = canonical({
            captureId: plan.captureId,
            manifestSha256: plan.manifestSha256,
            planDigest: plan.digest,
            targetId,
            offset: first,
            rows,
            overlaySha256: overlay.sha256,
          });
          const tail = [
            ...overlay.triggers.map((trigger) => rendering.prepare(trigger.sql)),
            rendering
              .prepare(
                "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES (?,'control-d1.import-file',?,?,?)",
              )
              .bind(commandId, digest, result, Date.now()),
            contextGuard(rendering, context),
          ];
          const parts = [...head.map(renderStatement), ...inserts, ...tail.map(renderStatement)];
          return {
            commandId,
            digest,
            result,
            rows,
            offset: first,
            bytes: Buffer.from(`${parts.join(";\n")};\n`),
          };
        },
      };
    };

    const landed = (receipt, file) =>
      receipt?.name === "control-d1.import-file" &&
      receipt.digest === file.digest &&
      receipt.result === file.result;

    const applyFile = async (file) => {
      const started = Date.now();
      const settled = await readReceipt(file.commandId);
      if (settled !== null) {
        if (!landed(settled, file)) fail("REPLAY_CONFLICT");
        applied.push({ offset: file.offset, rows: file.rows, file: true, replayed: true });
        return;
      }
      await appendJournal(journal, key, {
        phase: "file_prepared",
        commandId: file.commandId,
        digest: file.digest,
        rows: file.rows,
      });
      for (let attempt = 1; ; attempt += 1) {
        try {
          await apply(file.bytes);
          break;
        } catch (error) {
          // A lost reply and a rolled-back file look alike; the receipt written by the file itself decides.
          await waitForDatabase(db, pause);
          const observed = await readReceipt(file.commandId);
          if (landed(observed, file)) break;
          if (observed !== null) fail("REPLAY_CONFLICT");
          await appendJournal(journal, key, {
            phase: "file_rolled_back",
            commandId: file.commandId,
            digest: file.digest,
            attempt,
          });
          if (error.userCaused === true || attempt >= attempts) throw error;
        }
      }
      if (!landed(await readReceipt(file.commandId), file)) fail("IMPORT_UNCONFIRMED");
      if ((await schemaFingerprint(db)) !== runtimeSchema) fail("TARGET_SCHEMA_DRIFT");
      await appendJournal(journal, key, {
        phase: "file_confirmed",
        commandId: file.commandId,
        digest: file.digest,
      });
      applied.push({ offset: file.offset, rows: file.rows, file: true, replayed: false });
      onFile?.({
        rows: file.rows,
        bytes: file.bytes.byteLength,
        milliseconds: Date.now() - started,
        renderMilliseconds: file.renderMilliseconds,
      });
    };

    for (const segment of bulkSegments(plan, batchRows, limits)) {
      if (segment.kind === "batch") {
        for (const batch of segment.batches) await session.applyBatch(batch, { lean: true });
        if ((await schemaFingerprint(db)) !== runtimeSchema) fail("TARGET_SCHEMA_DRIFT");
        continue;
      }
      let cursor = 0;
      const take = async () => {
        if (cursor >= segment.units.length) return null;
        const renderStarted = Date.now();
        const file = open();
        while (
          cursor < segment.units.length &&
          (file.rows === 0 ||
            (file.rows + segment.units[cursor].records.length <= limits.recordsPerFile &&
              file.bytes < limits.bytesPerFile))
        )
          await file.add(segment.units[cursor++]);
        const built = file.finish();
        built.renderMilliseconds = Date.now() - renderStarted;
        return built;
      };
      // The next file renders while the previous one ingests.
      let following = take();
      for (;;) {
        const file = await following;
        if (file === null) break;
        following = take();
        following.catch(() => {});
        await applyFile(file);
      }
    }
  }

  // `compareOnImport: false` leaves the whole-Core comparison to `compare-remote`, which the stop runs right after.
  async function compare(db, records) {
    if (!compareOnImport) return [];
    return comparePages(db, records, { query: query ?? bindingQuery(db), parallel });
  }
  return { run, compare };
}
