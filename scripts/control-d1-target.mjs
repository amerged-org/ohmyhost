import { Buffer } from "node:buffer";
import { readFile, readdir, mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { canonical, fail, integerText, quoteIdentifier, sha256 } from "./control-d1-codec.mjs";
import { appendJournal } from "./control-d1-artifacts.mjs";
import { importBatches } from "./control-d1-batches.mjs";
import { MAIL_MIRROR_IMPORT_HOOK, MAIL_IMPORT_HOOKS } from "./control-d1-mail-import-hooks.mjs";
import {
  CLOUDFLARE_CONTEXT_PIN,
  CLOUDFLARE_CONTEXT_TABLES,
} from "./control-d1-cloudflare-import-context.mjs";
import { GENERIC_DERIVED_TRIGGERS } from "./control-d1-generic-mappings.mjs";
import {
  PROVIDER_PARENT_PINS,
  PROVIDER_PARENT_DERIVED_TRIGGERS,
} from "./control-d1-provider-parent-mappings.mjs";
import {
  PUBLIC_ENTRY_SEQUENCE,
  publicEntrySequenceRow,
  readPublicEntrySequenceFacts,
} from "./control-d1-public-entry-sequence.mjs";
import {
  migrationHistorySequenceRow,
  readMigrationHistorySequenceFacts,
} from "./control-d1-source-history.mjs";

/** SQL statement boundaries, including trigger bodies, CASE, quoted strings and comments. */
export function splitSql(sql) {
  const result = [];
  let start = 0;
  let depth = 0;
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === "'" || character === '"') {
      index += 1;
      while (index < sql.length) {
        if (sql[index] === character) {
          if (sql[index + 1] === character) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
    } else if (sql.slice(index, index + 2) === "--") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end;
    } else if (sql.slice(index, index + 2) === "/*") {
      const end = sql.indexOf("*/", index + 2);
      if (end === -1) fail("SQL_COMMENT");
      index = end + 2;
    } else if (/[A-Za-z_]/u.test(character)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/u.test(sql[end])) end += 1;
      const word = sql.slice(index, end).toUpperCase();
      if (word === "BEGIN" || word === "CASE") depth += 1;
      else if (word === "END") depth -= 1;
      index = end;
    } else {
      if (character === ";" && depth === 0) {
        result.push(sql.slice(start, index).trim());
        start = index + 1;
      }
      index += 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail !== "") result.push(tail);
  return result.filter(
    (statement) => statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//gu, "").trim() !== "",
  );
}

export async function migrationSnapshot(repositoryRoot, sourceCommit) {
  const directory = join(repositoryRoot, "apps/control-store/migrations/core");
  if (sourceCommit !== undefined && !/^[a-f0-9]{40}$/u.test(sourceCommit)) fail("TARGET_PIN");
  const git = (args) =>
    execFileSync("git", args, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 });
  const revision = sourceCommit ?? git(["rev-parse", "HEAD"]).toString("utf8").trim();
  const names =
    sourceCommit === undefined
      ? await readdir(directory)
      : git(["ls-tree", "--name-only", `${sourceCommit}:apps/control-store/migrations/core`])
          .toString("utf8")
          .trim()
          .split("\n");
  // Freeze each byte once. Hosted targets use immutable commit objects, never later worktree reads.
  const migrations = [];
  for (const name of names.filter((item) => item.endsWith(".sql")).sort()) {
    const bytes =
      sourceCommit === undefined
        ? await readFile(join(directory, name))
        : git(["show", `${sourceCommit}:apps/control-store/migrations/core/${name}`]);
    migrations.push({ name, bytes });
  }
  return {
    pin: {
      layout: "shared-core-v1",
      revision,
      migrations: migrations.map(({ name, bytes }) => ({ name, sha256: sha256(bytes) })),
    },
    migrations,
  };
}

export async function targetPin(repositoryRoot) {
  return (await migrationSnapshot(repositoryRoot)).pin;
}

/** An explicitly local, unserved target. No route, provider resource or consumer binding is created. */
export async function openLocalTarget({ repositoryRoot, persistence }) {
  if (persistence !== undefined) {
    try {
      await mkdir(persistence, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(persistence);
    if (!info.isDirectory() || (info.mode & 0o077) !== 0) fail("TARGET_PERMISSIONS");
  }
  const runtime = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      compatibilityDate: "2026-08-24",
      script:
        "export default {fetch(){return new Response('unserved migration target',{status:503})}}",
      d1Databases: { CONTROL_CORE: "migration-core" },
    }),
    ...(persistence === undefined ? {} : { resourcePersistencePath: persistence }),
  });
  try {
    const db = await runtime.getD1Database("CONTROL_CORE");
    await initializeUnservedTargetSchema(db, repositoryRoot);
    return { db, dispose: () => runtime.dispose() };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

/** Operator schema bootstrap only. Partial/foreign schemas are refused; customer data is never overwritten. */
export async function initializeUnservedTargetSchema(db, repositoryRoot, { sourceCommit } = {}) {
  const exists = await db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='core_layout'")
    .first();
  const { pin, migrations } = await migrationSnapshot(repositoryRoot, sourceCommit);
  if (exists === null) {
    const foreign = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf*' LIMIT 1",
      )
      .first();
    if (foreign !== null) fail("TARGET_NOT_EMPTY");
    for (const migration of migrations) {
      await db.batch(
        splitSql(migration.bytes.toString("utf8")).map((statement) => db.prepare(statement)),
      );
    }
    await db
      .prepare(
        "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES ('control-d1.schema:v1','control-d1.schema',?,?,?)",
      )
      .bind(
        sha256(Buffer.from(canonical(pin))),
        canonical({ schemaSha256: await schemaFingerprint(db) }),
        Date.now(),
      )
      .run();
  }
  await assertSchema(db, pin);
  return pin;
}

export async function schemaFingerprint(db) {
  const rows = (
    await db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf*' ORDER BY type,name",
      )
      .all()
  ).results;
  return sha256(Buffer.from(canonical(rows)));
}

const TEMPORAL_TABLES = new Set([
  "wfp_candidate_receipts",
  "wfp_candidate_cleanup_receipts",
  "wfp_publish_receipts",
  "wfp_rollback_activation_receipts",
  "runtime_secret_delivery_stage_activations",
  "operations",
  "environment_data_assignments",
]);
function temporalTablesFor(pin) {
  const allowed = new Set(TEMPORAL_TABLES);
  const mail = pin.migrations.find((entry) => entry.name === MAIL_MIRROR_IMPORT_HOOK.migration),
    scoped = pin.migrations.find((entry) => entry.name === CLOUDFLARE_CONTEXT_PIN.name);
  if (mail && mail.sha256 !== MAIL_MIRROR_IMPORT_HOOK.migrationSha256)
    fail("CONTEXT_VERSION_UNQUALIFIED");
  if (scoped && scoped.sha256 !== CLOUDFLARE_CONTEXT_PIN.sha256)
    fail("CONTEXT_VERSION_UNQUALIFIED");
  if (mail || scoped) allowed.add("project_mail_domain_bindings");
  if (scoped) for (const name of CLOUDFLARE_CONTEXT_TABLES) allowed.add(name);
  return allowed;
}
const bytes = (hex) => {
  if (!/^[a-f0-9]{64}$/u.test(hex)) fail("CONTEXT_DIGEST");
  return Uint8Array.from(Buffer.from(hex, "hex"));
};

async function readContext(db) {
  return db
    .prepare(
      "SELECT import_id,lower(hex(manifest_sha256)) manifest_sha256,lower(hex(source_fingerprint_sha256)) source_fingerprint_sha256,lower(hex(expected_runtime_schema_sha256)) expected_runtime_schema_sha256,temporal_tables,closed_at FROM core_historical_import WHERE singleton=1",
    )
    .first();
}

/** The sole qualified0335 context, direct operator SQL only. It never closes or activates an incomplete import. */
async function openContext(db, plan, runtimeSchema, key, journal, temporalTables) {
  const allowedTemporal = temporalTablesFor(plan.targetPin);
  if (
    !Array.isArray(temporalTables) ||
    new Set(temporalTables).size !== temporalTables.length ||
    temporalTables.some((name) => !allowedTemporal.has(name))
  )
    fail("CONTEXT_TABLES");
  if (await db.prepare("SELECT singleton FROM core_authority_activation WHERE singleton=1").first())
    fail("IMPORT_EVER_ACTIVATED");
  const expected = {
    import_id: plan.captureId,
    manifest_sha256: plan.digest,
    source_fingerprint_sha256: plan.manifestSha256,
    expected_runtime_schema_sha256: runtimeSchema,
    temporal_tables: canonical([...temporalTables].sort()),
    closed_at: null,
  };
  const current = await readContext(db);
  if (plan.adoptContext) {
    // Later rounds belong to the context the first round opened; they never open it, and never against another schema.
    if (
      current === null ||
      current.closed_at !== null ||
      current.expected_runtime_schema_sha256 !== runtimeSchema ||
      current.temporal_tables !== expected.temporal_tables ||
      current.import_id !== plan.phaseInfo?.identity.captureId ||
      current.source_fingerprint_sha256 !== plan.phaseInfo.identity.manifestSha256
    )
      fail("IMPORT_CONTEXT_CONFLICT");
    return current;
  }
  if (current !== null) {
    if (canonical(current) !== canonical(expected)) fail("IMPORT_CONTEXT_CONFLICT");
    return expected;
  }
  await appendJournal(journal, key, {
    phase: "context_prepared",
    importId: plan.captureId,
    manifestSha256: plan.digest,
    sourceFingerprint: plan.manifestSha256,
    runtimeSchema,
  });
  let acknowledged = true;
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO core_historical_import(singleton,import_id,manifest_sha256,source_fingerprint_sha256,expected_runtime_schema_sha256,temporal_tables,started_at) VALUES(1,?,?,?,?,?,?)",
        )
        .bind(
          plan.captureId,
          bytes(plan.digest),
          bytes(plan.manifestSha256),
          bytes(runtimeSchema),
          expected.temporal_tables,
          new Date().toISOString().replace(/Z$/u, "000Z"),
        ),
    ]);
  } catch {
    acknowledged = false;
  }
  const observed = await readContext(db).catch(() => null);
  if (canonical(observed) !== canonical(expected))
    fail(acknowledged ? "IMPORT_CONTEXT_CONFLICT" : "IMPORT_CONTEXT_UNKNOWN");
  await appendJournal(journal, key, {
    phase: "context_confirmed",
    importId: plan.captureId,
    manifestSha256: plan.digest,
  });
  return expected;
}

export function contextGuard(db, context) {
  return db
    .prepare(
      "INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE NOT EXISTS(SELECT 1 FROM core_historical_import WHERE singleton=1 AND import_id=? AND manifest_sha256=? AND source_fingerprint_sha256=? AND expected_runtime_schema_sha256=? AND temporal_tables=? AND closed_at IS NULL) OR EXISTS(SELECT 1 FROM core_authority_activation)",
    )
    .bind(
      context.import_id,
      bytes(context.manifest_sha256),
      bytes(context.source_fingerprint_sha256),
      bytes(context.expected_runtime_schema_sha256),
      context.temporal_tables,
    );
}

/**
 * The closed set of derived triggers the importer drops while it writes (the captured facts are imported instead of
 * their derivations) and recreates afterwards. Each is qualified by the hash of its migration and of its exact SQL;
 * no prefix matching, and a trigger of the target that is not in the set is refused.
 */
export async function importOverlay(db, repositoryRoot, pin) {
  const providerArrays = pin.migrations.find(
    (entry) => entry.name === "0413_original_provider_parent_arrays.sql",
  );
  if (providerArrays && providerArrays.sha256 !== PROVIDER_PARENT_PINS[providerArrays.name])
    fail("OVERLAY_VERSION_UNQUALIFIED");
  const mailMirror = pin.migrations.find(
    (entry) => entry.name === MAIL_MIRROR_IMPORT_HOOK.migration,
  );
  if (mailMirror && mailMirror.sha256 !== MAIL_MIRROR_IMPORT_HOOK.migrationSha256)
    fail("OVERLAY_VERSION_UNQUALIFIED");
  const inventory = [
    ...(providerArrays ? PROVIDER_PARENT_DERIVED_TRIGGERS : []),
    ...(mailMirror ? MAIL_IMPORT_HOOKS : []),
    ...GENERIC_DERIVED_TRIGGERS,
  ];
  const qualified = new Map();
  for (const entry of inventory) {
    const source = pin.migrations.find((migration) => migration.name === entry.migration);
    if (source === undefined) continue;
    if (source.sha256 !== entry.migrationSha256) fail("OVERLAY_VERSION_UNQUALIFIED");
    if (qualified.has(entry.name)) fail("OVERLAY_TRIGGER_MISMATCH");
    qualified.set(entry.name, entry);
  }
  const expected = new Map();
  for (const name of new Set([...qualified.values()].map((entry) => entry.migration))) {
    const source = await readFile(
      join(repositoryRoot, "apps/control-store/migrations/core", name),
      "utf8",
    );
    if (sha256(Buffer.from(source)) !== pin.migrations.find((entry) => entry.name === name).sha256)
      fail("TARGET_PIN");
    for (const statement of splitSql(source)) {
      const match = /CREATE TRIGGER\s+([a-z0-9_]+)/iu.exec(statement);
      if (match && qualified.has(match[1])) {
        const sql = statement.slice(match.index).trim();
        if (
          !/^CREATE TRIGGER\s+[a-z0-9_]+\s+AFTER\b/iu.test(sql) ||
          sha256(Buffer.from(sql)) !== qualified.get(match[1]).sqlSha256
        )
          fail("OVERLAY_TRIGGER_MISMATCH");
        expected.set(match[1], sql);
      }
    }
  }
  if (expected.size !== qualified.size) fail("OVERLAY_TRIGGER_MISMATCH");
  const queriedNames = [...new Set(inventory.map((entry) => entry.name))];
  const actual = (
    await db
      .prepare(
        `SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${queriedNames.map(() => "?").join(",")}) ORDER BY name`,
      )
      .bind(...queriedNames)
      .all()
  ).results;
  if (actual.some((row) => !qualified.has(row.name))) fail("OVERLAY_VERSION_UNQUALIFIED");
  if (actual.length !== expected.size || actual.some((row) => row.sql !== expected.get(row.name)))
    fail("OVERLAY_TRIGGER_MISMATCH");
  return { triggers: actual, sha256: sha256(Buffer.from(canonical(actual))) };
}

const UPGRADE_RECEIPT = "control-d1.schema-upgrade:v1:";
/** The receipts that name the Core schema, read from command_log by every reader of the schema head. */
export const SCHEMA_RECEIPTS_SQL =
  "SELECT command_id,name,digest,result FROM command_log WHERE command_id='control-d1.schema:v1' OR command_id LIKE 'control-d1.schema-upgrade:v1:%'";

/** The single head of the schema receipts: the one receipt no other receipt upgrades from. */
export function schemaReceiptHeadOf(receipts) {
  const heads = receipts.filter(
    (receipt) =>
      !receipts.some(
        (other) => other !== receipt && JSON.parse(other.result).from === receipt.digest,
      ),
  );
  if (heads.length !== 1 || heads[0].name !== "control-d1.schema") fail("TARGET_UNATTESTED");
  return heads[0];
}

async function schemaReceiptHead(db) {
  return schemaReceiptHeadOf((await db.prepare(SCHEMA_RECEIPTS_SQL).all()).results);
}

/** A Core release refuses any schema head other than the one the source commit pins. */
export function requireSchemaHeadForPin(receipts, pin) {
  if (schemaReceiptHeadOf(receipts).digest !== sha256(Buffer.from(canonical(pin))))
    fail("TARGET_UNATTESTED");
}

async function assertSchema(db, pin) {
  const receipt = await schemaReceiptHead(db);
  if (receipt.digest !== sha256(Buffer.from(canonical(pin)))) fail("TARGET_UNATTESTED");
  if (JSON.parse(receipt.result).schemaSha256 !== (await schemaFingerprint(db)))
    fail("TARGET_SCHEMA_DRIFT");
}

async function attestedCommit(db) {
  const row = await db
    .prepare(
      "SELECT result FROM command_log WHERE name='omh.control-core.remote-target/v1' ORDER BY applied_at DESC LIMIT 1",
    )
    .first();
  try {
    return JSON.parse(row.result).sourceCommit;
  } catch {
    return undefined;
  }
}

/**
 * Forward-only schema upgrade of an existing Core, activated or not. The recorded schema head must belong to the
 * previous commit and match the live schema; the new commit's migration list must extend it unchanged. An identical
 * full inventory may re-attest only a Git descendant with an unchanged live schema. Each added migration runs in one
 * batch with its own receipt (a lost reply resumes by that receipt), then a new schema receipt names the new pin and
 * the recomputed fingerprint. A code-only receipt explicitly records no applied migrations; application rows stay put.
 */
export async function upgradeCoreSchema(db, repositoryRoot, { sourceCommit, previousCommit } = {}) {
  const head = await schemaReceiptHead(db),
    headResult = JSON.parse(head.result),
    next = await migrationSnapshot(repositoryRoot, sourceCommit),
    nextDigest = sha256(Buffer.from(canonical(next.pin)));
  if (head.digest === nextDigest) {
    await assertSchema(db, next.pin);
    return { pin: next.pin, applied: [] };
  }
  const base = await migrationSnapshot(
    repositoryRoot,
    headResult.sourceCommit ?? previousCommit ?? (await attestedCommit(db)),
  );
  if (sha256(Buffer.from(canonical(base.pin))) !== head.digest) fail("UPGRADE_BASE_MISMATCH");
  const added = next.migrations.slice(base.migrations.length);
  if (
    next.migrations.length < base.migrations.length ||
    base.pin.migrations.some(
      (entry, index) =>
        entry.name !== next.pin.migrations[index].name ||
        entry.sha256 !== next.pin.migrations[index].sha256,
    )
  )
    fail("UPGRADE_NOT_FORWARD");
  if (added.length === 0) {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", base.pin.revision, next.pin.revision], {
        cwd: repositoryRoot,
        stdio: "ignore",
      });
    } catch {
      fail("UPGRADE_NOT_FORWARD");
    }
  }
  const logged = [];
  for (const migration of added)
    logged.push(
      await db
        .prepare("SELECT digest FROM command_log WHERE command_id=?")
        .bind(`control-d1.schema-migration:v1:${migration.name}`)
        .first(),
    );
  // A fresh upgrade needs the live schema to equal the recorded head; a resumed one is evidenced by its receipts.
  if (
    logged.every((row) => row === null) &&
    (await schemaFingerprint(db)) !== headResult.schemaSha256
  )
    fail("TARGET_SCHEMA_DRIFT");
  for (const [index, migration] of added.entries()) {
    const digest = sha256(migration.bytes);
    if (logged[index] !== null) {
      if (logged[index].digest !== digest) fail("UPGRADE_CONFLICT");
      continue;
    }
    await db.batch([
      ...splitSql(migration.bytes.toString("utf8")).map((statement) => db.prepare(statement)),
      db
        .prepare(
          "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?,'control-d1.schema-migration',?,?,?)",
        )
        .bind(
          `control-d1.schema-migration:v1:${migration.name}`,
          digest,
          canonical({ migration: migration.name }),
          Date.now(),
        ),
    ]);
  }
  await db
    .prepare(
      "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?,'control-d1.schema',?,?,?)",
    )
    .bind(
      `${UPGRADE_RECEIPT}${nextDigest}`,
      nextDigest,
      canonical({
        from: head.digest,
        schemaSha256: await schemaFingerprint(db),
        sourceCommit: next.pin.revision,
        applied: added.map((migration) => migration.name),
      }),
      Date.now(),
    )
    .run();
  await assertSchema(db, next.pin);
  return { pin: next.pin, applied: added.map((migration) => migration.name) };
}

const SCHEMA_CACHE = new WeakMap();
export async function schemaOf(db, table) {
  if (!SCHEMA_CACHE.has(db)) SCHEMA_CACHE.set(db, new Map());
  const cache = SCHEMA_CACHE.get(db);
  if (!cache.has(table))
    cache.set(table, db.prepare(`PRAGMA table_xinfo(${quoteIdentifier(table)})`).all());
  try {
    const columns = (await cache.get(table)).results;
    if (columns.length === 0) fail("TARGET_TABLE");
    return columns;
  } catch (error) {
    cache.delete(table);
    throw error;
  }
}

function bound(column, value) {
  if (value === null) return { sql: "?", value: null };
  if (column.type === "INTEGER") return { sql: "CAST(? AS INTEGER)", value: integerText(value) };
  if (column.type === "BLOB") {
    if (typeof value !== "string" || !/^(?:[a-f0-9]{2})*$/u.test(value)) fail("BYTEA");
    return { sql: "?", value: Uint8Array.from(Buffer.from(value, "hex")) };
  }
  if (typeof value !== "string") fail("TARGET_VALUE");
  return { sql: "?", value };
}

/** `statement: false` validates the record against the target schema without preparing its read statement. */
export async function recordDescriptor(db, record, { statement = true } = {}) {
  const schema = await schemaOf(db, record.table);
  const writable = schema.filter((column) => column.hidden === 0);
  const names = Object.keys(record.row);
  if (names.some((name) => !writable.some((column) => column.name === name)))
    fail("TARGET_COLUMN_UNMAPPED");
  const columns = writable.filter((column) => nameInRow(column.name, record.row));
  if (columns.some((column) => record.row[column.name] === undefined))
    fail("TARGET_COLUMN_UNMAPPED");
  const keys = schema.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  if (keys.length === 0 || keys.some((column) => !nameInRow(column.name, record.row)))
    fail("TARGET_KEY");
  const params = columns.map((column) => bound(column, record.row[column.name]));
  const predicates = keys.map(
    (column) => `${quoteIdentifier(column.name)} IS ${bound(column, record.row[column.name]).sql}`,
  );
  if (!statement) return { columns, params };
  const projections = columns.map((column) =>
    column.type === "INTEGER"
      ? `CAST(${quoteIdentifier(column.name)} AS TEXT) AS ${quoteIdentifier(column.name)}`
      : column.type === "BLOB"
        ? `CASE WHEN ${quoteIdentifier(column.name)} IS NULL THEN NULL ELSE lower(hex(${quoteIdentifier(column.name)})) END AS ${quoteIdentifier(column.name)}`
        : quoteIdentifier(column.name),
  );
  const select = db
    .prepare(
      `SELECT ${projections.join(",")} FROM ${quoteIdentifier(record.table)} WHERE ${predicates.join(" AND ")}`,
    )
    .bind(...keys.map((column) => bound(column, record.row[column.name]).value));
  return { columns, params, select };
}

/** Exact existing rows by key, 128 reads per batch, all batches of one window in flight together. */
async function recordSnapshot(db, records) {
  const windows = [];
  for (let offset = 0; offset < records.length; offset += 128)
    windows.push(records.slice(offset, offset + 128));
  const parts = await Promise.all(
    windows.map(async (window) => {
      const descriptors = await Promise.all(window.map((record) => recordDescriptor(db, record)));
      const results = await db.batch(descriptors.map((descriptor) => descriptor.select));
      return descriptors.map((descriptor, index) => ({
        ...descriptor,
        existing: results[index].results[0] ?? null,
      }));
    }),
  );
  return parts.flat();
}

function nameInRow(name, row) {
  return Object.hasOwn(row, name);
}
/** Exact replay checks every mapped column as text/hex, not an imprecise int8 returned by D1. */
export async function compareRecords(db, records) {
  const mismatches = [];
  for (let offset = 0; offset < records.length; offset += 1024) {
    const selected = records.slice(offset, offset + 1024);
    const snapshot = await recordSnapshot(db, selected);
    for (let index = 0; index < selected.length; index += 1) {
      const { existing } = snapshot[index];
      if (existing === null || canonical(existing) !== canonical(selected[index].row))
        mismatches.push(offset + index);
    }
  }
  return mismatches;
}

/** Source allocator state is independent of row digests and must also survive second-target comparison. */
export async function compareSequences(db, restores) {
  const mismatches = [];
  for (const restore of restores) {
    if (restore.kind === "original-control-migrations-v1") {
      migrationHistorySequenceRow(restore);
      const actual = await readMigrationHistorySequenceFacts(db);
      if (actual.length !== 1 || canonical(actual[0]) !== canonical(restore))
        mismatches.push(restore.sourceName);
      continue;
    }
    if (restore.kind === PUBLIC_ENTRY_SEQUENCE.kind) {
      publicEntrySequenceRow(restore);
      const actual = await readPublicEntrySequenceFacts(db);
      if (actual.length !== 1 || canonical(actual[0]) !== canonical(restore))
        mismatches.push(restore.sourceName);
      continue;
    }
    fail("SEQUENCE_KIND");
  }
  return mismatches;
}

async function assertTarget(db, targetId) {
  if (typeof targetId !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(targetId))
    fail("TARGET_ID");
  const layout = await db
    .prepare("SELECT layout, command_namespace_version FROM core_layout WHERE singleton=1")
    .first();
  if (layout?.layout !== "shared-core-v1" || layout.command_namespace_version !== 1)
    fail("TARGET_LAYOUT");
}

/** One receipt per completed round: the digest of everything preloadable the target holds after that round. */
function phaseReceipt(plan, targetId, context) {
  return {
    commandId: `control-d1-phase:v1:${plan.captureId}:${targetId}`,
    digest: sha256(Buffer.from(canonical(plan.phaseInfo))),
    result: canonical({
      context: context.import_id,
      planDigest: plan.digest,
      info: plan.phaseInfo,
    }),
  };
}

async function readPhaseReceipt(db, captureId, targetId) {
  return db
    .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
    .bind(`control-d1-phase:v1:${captureId}:${targetId}`)
    .first();
}

/** The previous round must have completed and left exactly the content this round was derived against. */
async function requireBaselineRound(db, plan, targetId, context) {
  const baseline = plan.phaseInfo?.baseline;
  if (!baseline) return;
  const receipt = await readPhaseReceipt(db, baseline.captureId, targetId);
  const result = receipt?.name === "control-d1.phase" ? JSON.parse(receipt.result) : null;
  if (
    result?.context !== context.import_id ||
    result.info.phase !== "preload" ||
    result.info.content.sha256 !== baseline.sha256
  )
    fail("PHASE_BASELINE_UNPROVEN");
}

export async function comparePhase(db, plan, targetId) {
  if (!plan.phaseInfo) return [];
  const receipt = await readPhaseReceipt(db, plan.captureId, targetId);
  const result = receipt?.name === "control-d1.phase" ? JSON.parse(receipt.result) : null;
  const mismatches = [];
  if (
    receipt?.digest !== sha256(Buffer.from(canonical(plan.phaseInfo))) ||
    canonical(result?.info) !== canonical(plan.phaseInfo)
  )
    mismatches.push(plan.phaseInfo.phase);
  const baseline = plan.phaseInfo.baseline;
  if (baseline) {
    const previous = await readPhaseReceipt(db, baseline.captureId, targetId);
    if (
      previous?.name !== "control-d1.phase" ||
      JSON.parse(previous.result).info.content.sha256 !== baseline.sha256
    )
      mismatches.push("baseline");
  }
  return mismatches;
}

async function recordPhase(db, plan, targetId, context, key, journal) {
  const { commandId, digest, result } = phaseReceipt(plan, targetId, context);
  const settled = async () => {
    const observed = await readPhaseReceipt(db, plan.captureId, targetId);
    return (
      observed?.name === "control-d1.phase" &&
      observed.digest === digest &&
      observed.result === result
    );
  };
  if (await settled()) return;
  if (await db.prepare("SELECT 1 FROM command_log WHERE command_id=?").bind(commandId).first())
    fail("REPLAY_CONFLICT");
  await appendJournal(journal, key, { phase: "round_prepared", commandId, digest });
  try {
    await db.batch([
      contextGuard(db, context),
      db
        .prepare(
          "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?,'control-d1.phase',?,?,?)",
        )
        .bind(commandId, digest, result, Date.now()),
      contextGuard(db, context),
    ]);
  } catch {
    // A lost reply is resolved by the exact receipt readback below.
  }
  if (!(await settled().catch(() => false))) fail("PHASE_RECORD_UNKNOWN");
  await appendJournal(journal, key, { phase: "round_confirmed", commandId, digest });
}

/**
 * The statements that insert one batch of records exactly as the importer writes them.
 * `snapshot` carries each record's descriptor and its exact existing row; `parameterLimit` caps the bound values packed
 * into one multi-row INSERT (D1 allows 100 per statement; a rendered file packs one row per statement).
 */
export function recordStatements(db, records, snapshot, statements, { parameterLimit = 100 } = {}) {
  let buffered;
  const flush = () => {
    if (buffered) {
      statements.push(
        db
          .prepare(
            `INSERT INTO ${quoteIdentifier(buffered.table)} (${buffered.columns}) VALUES ${buffered.values.join(",")}`,
          )
          .bind(...buffered.parameters),
      );
      buffered = undefined;
    }
  };
  for (const [index, record] of records.entries()) {
    const facts = snapshot[index];
    if (facts.existing !== null) fail("TARGET_NOT_EMPTY");
    const columns = facts.columns.map((column) => quoteIdentifier(column.name)).join(","),
      values = `(${facts.params.map((param) => param.sql).join(",")})`;
    if (
      buffered &&
      (buffered.table !== record.table ||
        buffered.columns !== columns ||
        buffered.values[0] !== values ||
        buffered.parameters.length + facts.params.length > parameterLimit)
    )
      flush();
    if (!buffered) buffered = { table: record.table, columns, values: [], parameters: [] };
    buffered.values.push(values);
    buffered.parameters.push(...facts.params.map((param) => param.value));
  }
  flush();
}

/** No target DDL: receipts use the existing closed command_log namespace and share the import batch. */
export async function importPlan({
  db,
  plan,
  targetId,
  key,
  journal,
  batchRows = 128,
  currentPin,
  repositoryRoot = fileURLToPath(new URL("..", import.meta.url)),
  temporalTables = plan.requiredTemporalTables ?? [],
  bulk,
}) {
  if (
    plan.format !== "omh.control-d1.plan/v3" ||
    plan.atomicProtocol !== "contiguous-units-v1" ||
    plan.qualificationOnly !== true ||
    !Array.isArray(plan.unhandledSequences) ||
    !Array.isArray(plan.runtimeGates) ||
    !Array.isArray(plan.sequenceRestores)
  )
    fail("PLAN_FORMAT");
  const batches = importBatches(plan.records, batchRows);
  await assertTarget(db, targetId);
  if (canonical(currentPin) !== canonical(plan.targetPin)) fail("TARGET_PIN");
  await assertSchema(db, currentPin);
  const runtimeSchema = await schemaFingerprint(db);
  const context = await openContext(db, plan, runtimeSchema, key, journal, temporalTables);
  await requireBaselineRound(db, plan, targetId, context);
  const overlay = await importOverlay(db, repositoryRoot, currentPin);
  const applied = [];
  await appendJournal(journal, key, {
    phase: "started",
    captureId: plan.captureId,
    targetId,
    planDigest: plan.digest,
  });
  // The entire plan is validated against the target schema before a first insert.
  for (const record of plan.records) await recordDescriptor(db, record, { statement: false });
  /** One atomic batch with its own receipt: read the exact rows, write, read them back, confirm the schema. */
  const applyBatch = async (batch, { lean = false } = {}) => {
    const { offset, records } = batch;
    const digest = sha256(Buffer.from(canonical(records)));
    const commandId = `control-d1-import:v1:${plan.captureId}:${targetId}:${offset}:${batchRows}`;
    const result = canonical({
      captureId: plan.captureId,
      manifestSha256: plan.manifestSha256,
      planDigest: plan.digest,
      targetId,
      offset,
      rows: records.length,
      overlaySha256: overlay.sha256,
      ...(batch.groups.length === 0
        ? {}
        : { atomicGroups: batch.groups, deferredForeignKeys: batch.deferred }),
    });
    const receipt = await db
      .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
      .bind(commandId)
      .first();
    if (receipt !== null) {
      if (
        receipt.name !== "control-d1.import" ||
        receipt.digest !== digest ||
        receipt.result !== result ||
        (await compareRecords(db, records)).length > 0
      )
        fail("REPLAY_CONFLICT");
      applied.push({ offset, replayed: true });
      return;
    }
    const statements = [
      ...(batch.deferred ? [db.prepare("PRAGMA defer_foreign_keys=ON")] : []),
      contextGuard(db, context),
      ...overlay.triggers.map((trigger) =>
        db.prepare(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`),
      ),
    ];
    const snapshot = await recordSnapshot(db, records);
    recordStatements(db, records, snapshot, statements);
    statements.push(...overlay.triggers.map((trigger) => db.prepare(trigger.sql)));
    if (batch.deferred)
      statements.push(
        db.prepare(
          "INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
        ),
      );
    statements.push(
      db
        .prepare(
          "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES (?,'control-d1.import',?,?,?)",
        )
        .bind(commandId, digest, result, Date.now()),
    );
    statements.push(contextGuard(db, context));
    await appendJournal(journal, key, {
      phase: "prepared",
      commandId,
      digest,
      overlaySha256: overlay.sha256,
      runtimeSchema,
      ...(batch.groups.length === 0
        ? {}
        : { atomicGroups: batch.groups, deferredForeignKeys: batch.deferred }),
    });
    try {
      await db.batch(statements);
    } catch {
      const observed = await db
        .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
        .bind(commandId)
        .first()
        .catch(() => null);
      if (
        observed?.name !== "control-d1.import" ||
        observed.digest !== digest ||
        observed.result !== result
      ) {
        await appendJournal(journal, key, { phase: "unknown_or_rolled_back", commandId, digest });
        fail("IMPORT_UNCONFIRMED");
      }
    }
    if ((await compareRecords(db, records)).length > 0) fail("IMPORT_COMPARISON");
    // A lean batch (between files) leaves the schema check to the end of its run.
    if (!lean && (await schemaFingerprint(db)) !== runtimeSchema) fail("TARGET_SCHEMA_DRIFT");
    await appendJournal(journal, key, { phase: "confirmed", commandId, digest });
    applied.push({ offset, replayed: false });
  };
  if (bulk === undefined) for (const batch of batches) await applyBatch(batch);
  else
    await bulk.run({
      db,
      plan,
      targetId,
      key,
      journal,
      batchRows,
      context,
      overlay,
      runtimeSchema,
      applyBatch,
      applied,
    });
  const violations = (await db.prepare("PRAGMA foreign_key_check").all()).results;
  if (
    violations.length > 0 ||
    (await (bulk === undefined ? compareRecords : bulk.compare)(db, plan.records)).length > 0
  )
    fail("IMPORT_COMPARISON");
  await restoreSequences(db, plan, targetId, context, key, journal);
  await recordDispositions(db, plan, targetId, context, key, journal);
  if (
    (await compareDispositions(db, plan, targetId)).length > 0 ||
    (await compareSequences(db, plan.sequenceRestores)).length > 0
  )
    fail("IMPORT_COMPARISON");
  if (plan.phaseInfo) await recordPhase(db, plan, targetId, context, key, journal);
  return {
    verdict: plan.verdict,
    qualificationOnly: true,
    targetId,
    records: plan.records.length,
    applied,
    unhandled: plan.unhandled,
    unhandledViews: plan.unhandledViews,
    unhandledSequences: plan.unhandledSequences,
    runtimeGates: plan.runtimeGates,
    gaps: plan.gaps,
  };
}

/** Fixed0332 sqlite allocator restoration, under the SAME attested unserved context and immutable receipt. */
async function restoreMigrationHistorySequence(db, plan, targetId, context, key, journal, restore) {
  const row = migrationHistorySequenceRow(restore),
    commandId = `control-d1-sequence:v1:${plan.captureId}:${targetId}:${restore.sourceName}`,
    digest = sha256(Buffer.from(canonical(restore))),
    result = canonical({ context: context.import_id, planDigest: plan.digest, restore });
  const receipt = await db
    .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
    .bind(commandId)
    .first();
  const actual = await readMigrationHistorySequenceFacts(db);
  if (receipt) {
    if (
      receipt.name !== "control-d1.sequence" ||
      receipt.digest !== digest ||
      receipt.result !== result ||
      actual.length !== 1 ||
      canonical(actual[0]) !== canonical(restore)
    )
      fail("REPLAY_CONFLICT");
    return;
  }
  if (actual.length !== 0) fail("TARGET_NOT_EMPTY");
  await appendJournal(journal, key, { phase: "sequence_prepared", commandId, digest });
  try {
    await db.batch([
      contextGuard(db, context),
      db.prepare(
        "INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE EXISTS(SELECT 1 FROM control_source_migration_sequence)",
      ),
      db
        .prepare(
          "INSERT INTO control_source_migration_sequence(source_name,last_value,is_called) VALUES(?,CAST(? AS INTEGER),CAST(? AS INTEGER))",
        )
        .bind(row.source_name, row.last_value, row.is_called),
      db
        .prepare(
          "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?,'control-d1.sequence',?,?,?)",
        )
        .bind(commandId, digest, result, Date.now()),
      contextGuard(db, context),
    ]);
  } catch {
    const observed = await db
      .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
      .bind(commandId)
      .first()
      .catch(() => null);
    if (
      observed?.name !== "control-d1.sequence" ||
      observed.digest !== digest ||
      observed.result !== result
    )
      fail("SEQUENCE_RESTORE_UNKNOWN");
  }
  const restored = await readMigrationHistorySequenceFacts(db);
  if (restored.length !== 1 || canonical(restored[0]) !== canonical(restore))
    fail("SEQUENCE_RESTORE_UNKNOWN");
  await appendJournal(journal, key, { phase: "sequence_confirmed", commandId, digest });
}

/** Receipts of tables that are archived, expired or dropped instead of imported; same closed command_log namespace. */
function dispositionReceipt(plan, targetId, entry) {
  return {
    commandId: `control-d1-disposition:v1:${plan.captureId}:${targetId}:${entry.table}`,
    digest: sha256(Buffer.from(canonical(entry))),
    result: canonical({ context: plan.captureId, planDigest: plan.digest, disposition: entry }),
  };
}

export async function compareDispositions(db, plan, targetId) {
  const mismatches = [];
  for (const entry of plan.dispositions ?? []) {
    const expected = dispositionReceipt(plan, targetId, entry);
    const observed = await db
      .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
      .bind(expected.commandId)
      .first();
    if (
      observed?.name !== "control-d1.disposition" ||
      observed.digest !== expected.digest ||
      observed.result !== expected.result
    )
      mismatches.push(entry.table);
  }
  return mismatches;
}

async function recordDispositions(db, plan, targetId, context, key, journal) {
  for (const entry of plan.dispositions ?? []) {
    const { commandId, digest, result } = dispositionReceipt(plan, targetId, entry);
    if ((await compareDispositions(db, { ...plan, dispositions: [entry] }, targetId)).length === 0)
      continue;
    if (await db.prepare("SELECT 1 FROM command_log WHERE command_id=?").bind(commandId).first())
      fail("REPLAY_CONFLICT");
    await appendJournal(journal, key, { phase: "disposition_prepared", commandId, digest });
    try {
      await db.batch([
        contextGuard(db, context),
        db
          .prepare(
            "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?,'control-d1.disposition',?,?,?)",
          )
          .bind(commandId, digest, result, Date.now()),
        contextGuard(db, context),
      ]);
    } catch {
      // A lost reply is resolved by the exact receipt readback below.
    }
    if ((await compareDispositions(db, { ...plan, dispositions: [entry] }, targetId)).length > 0)
      fail("DISPOSITION_RECORD_UNKNOWN");
    await appendJournal(journal, key, { phase: "disposition_confirmed", commandId, digest });
  }
}

/** Original independent vote allocator: pristine seed (1, not called) to the captured state, once, under the import context. */
async function restorePublicEntrySequence(db, plan, targetId, context, key, journal, restore) {
  const row = publicEntrySequenceRow(restore),
    commandId = `control-d1-sequence:v1:${plan.captureId}:${targetId}:${restore.sourceName}`,
    digest = sha256(Buffer.from(canonical(restore))),
    result = canonical({ context: context.import_id, planDigest: plan.digest, restore });
  const receipt = await db
    .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
    .bind(commandId)
    .first();
  const actual = await readPublicEntrySequenceFacts(db);
  if (receipt) {
    if (
      receipt.name !== "control-d1.sequence" ||
      receipt.digest !== digest ||
      receipt.result !== result ||
      canonical(actual[0]) !== canonical(restore)
    )
      fail("REPLAY_CONFLICT");
    return;
  }
  if (actual[0].lastValue !== "1" || actual[0].isCalled !== false) fail("TARGET_NOT_EMPTY");
  await appendJournal(journal, key, { phase: "sequence_prepared", commandId, digest });
  try {
    await db.batch([
      contextGuard(db, context),
      db.prepare(
        "INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE NOT EXISTS(SELECT 1 FROM beta_feature_vote_allocator WHERE singleton=1 AND last_value=1 AND is_called=0)",
      ),
      db
        .prepare(
          "UPDATE beta_feature_vote_allocator SET last_value=CAST(? AS INTEGER),is_called=CAST(? AS INTEGER) WHERE singleton=1",
        )
        .bind(row.last_value, row.is_called),
      db
        .prepare(
          "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES(?,'control-d1.sequence',?,?,?)",
        )
        .bind(commandId, digest, result, Date.now()),
      contextGuard(db, context),
    ]);
  } catch {
    // A lost reply is resolved by the exact receipt and allocator readback below.
  }
  const observed = await db
    .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
    .bind(commandId)
    .first()
    .catch(() => null);
  const restored = await readPublicEntrySequenceFacts(db).catch(() => []);
  if (
    observed?.name !== "control-d1.sequence" ||
    observed.digest !== digest ||
    observed.result !== result ||
    restored.length !== 1 ||
    canonical(restored[0]) !== canonical(restore)
  )
    fail("SEQUENCE_RESTORE_UNKNOWN");
  await appendJournal(journal, key, { phase: "sequence_confirmed", commandId, digest });
}

async function restoreSequences(db, plan, targetId, context, key, journal) {
  for (const restore of plan.sequenceRestores) {
    if (restore.kind === "original-control-migrations-v1") {
      await restoreMigrationHistorySequence(db, plan, targetId, context, key, journal, restore);
      continue;
    }
    if (restore.kind === PUBLIC_ENTRY_SEQUENCE.kind) {
      await restorePublicEntrySequence(db, plan, targetId, context, key, journal, restore);
      continue;
    }
    fail("SEQUENCE_KIND");
  }
}
