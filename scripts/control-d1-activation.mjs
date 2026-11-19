import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { canonical, fail } from "./control-d1-codec.mjs";
import { schemaFingerprint } from "./control-d1-target.mjs";

/**
 * Closing the historical import and activating the Core, the last operator steps before a Core serves.
 *
 * `compare-remote` of the final round leaves one `control-d1.compare` receipt: the comparison digest of the whole Core
 * against the full capture. `closeImport` accepts only that digest, only for the import context that is open, only while
 * nothing was imported after the comparison and only while the schema is the one the import started with. `activateAuthority`
 * then writes the one immutable `core_authority_activation` row from the closed context. Both commands are idempotent.
 */
export const COMPARE_RECEIPT = "control-d1.compare";
/** Receipts of everything that writes Core content; none may be newer than the comparison that is being attested. */
const CONTENT_RECEIPTS = [
  "control-d1.import",
  "control-d1.import-file",
  "control-d1.phase",
  "control-d1.sequence",
  "control-d1.state",
  "control-d1.disposition",
];
const DIGEST = /^[a-f0-9]{64}$/u;
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));
const micros = (now) => now().toISOString().replace(/Z$/u, "000Z");
const hexOf = (column) => `CASE WHEN ${column} IS NULL THEN NULL ELSE lower(hex(${column})) END`;

async function readImport(db) {
  return db
    .prepare(
      `SELECT import_id, ${hexOf("expected_runtime_schema_sha256")} expected, closed_at,
        ${hexOf("comparison_sha256")} comparison, ${hexOf("restored_runtime_schema_sha256")} restored
        FROM core_historical_import WHERE singleton=1`,
    )
    .first();
}

const ACTIVATION = `SELECT a.activation_id, a.activated_at, a.import_id, lower(hex(a.qualification_sha256)) qualification_sha256,
  lower(hex(a.runtime_schema_sha256)) runtime_schema_sha256
  FROM core_layout layout JOIN core_authority_activation a ON a.singleton=layout.singleton
  WHERE layout.singleton=1 AND layout.layout='shared-core-v1' AND layout.command_namespace_version=1
  AND NOT EXISTS(SELECT 1 FROM core_historical_import WHERE closed_at IS NULL)`;

/** The activation, read through any `query(statements)` reader: the D1 REST API still answers once the Core is activated. */
export async function readActivation(query) {
  const [rows] = await query([{ sql: ACTIVATION, params: [] }]);
  return rows.length === 0 ? null : rows[0];
}

/** The receipt `closeImport` consumes: written once, by the compare of the round that completes the import. */
export async function recordComparison(
  db,
  { captureId, targetId, planDigest, comparisonSha256, tables, now = () => new Date() },
) {
  if (!DIGEST.test(comparisonSha256 ?? "")) fail("COMPARISON_DIGEST");
  const context = await readImport(db);
  if (context === null) fail("IMPORT_CONTEXT_MISSING");
  const commandId = `control-d1-compare:v1:${captureId}:${targetId}`;
  const result = canonical({
    context: context.import_id,
    captureId,
    targetId,
    planDigest,
    tables,
    comparisonSha256,
  });
  const settled = async () => {
    const receipt = await db
      .prepare("SELECT name,digest,result FROM command_log WHERE command_id=?")
      .bind(commandId)
      .first();
    if (receipt === null) return false;
    if (
      receipt.name !== COMPARE_RECEIPT ||
      receipt.digest !== comparisonSha256 ||
      receipt.result !== result
    )
      fail("REPLAY_CONFLICT");
    return true;
  };
  if (await settled()) return;
  if (context.closed_at !== null) fail("IMPORT_CONTEXT_CLOSED");
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO guard_fail(code) SELECT 'precondition_changed' WHERE NOT EXISTS(SELECT 1 FROM core_historical_import WHERE singleton=1 AND import_id=? AND closed_at IS NULL)",
        )
        .bind(context.import_id),
      db
        .prepare(
          "INSERT INTO command_log(command_id,name,digest,result,applied_at) VALUES (?,?,?,?,?)",
        )
        .bind(commandId, COMPARE_RECEIPT, comparisonSha256, result, now().getTime()),
    ]);
  } catch {
    // A lost reply is resolved by the exact receipt readback below.
  }
  if (!(await settled().catch(() => false))) fail("COMPARISON_RECORD_UNKNOWN");
}

const summary = (context, extra) => ({
  importId: context.import_id,
  comparisonSha256: context.comparison,
  closedAt: context.closed_at,
  ...extra,
});

export async function closeImport(db, { comparisonSha256, now = () => new Date() }) {
  if (!DIGEST.test(comparisonSha256 ?? "")) fail("COMPARISON_DIGEST");
  const context = await readImport(db);
  if (context === null) fail("IMPORT_CONTEXT_MISSING");
  if (context.closed_at !== null) {
    if (context.comparison !== comparisonSha256) fail("IMPORT_ALREADY_CLOSED");
    return summary(context, { replayed: true });
  }
  const receipts = (
    await db
      .prepare("SELECT result, applied_at FROM command_log WHERE name=? AND digest=?")
      .bind(COMPARE_RECEIPT, comparisonSha256)
      .all()
  ).results;
  if (receipts.length !== 1) fail("COMPARISON_RECEIPT_MISSING");
  const proof = JSON.parse(receipts[0].result);
  if (proof.context !== context.import_id) fail("COMPARISON_RECEIPT_UNPROVEN");
  const round = await db
    .prepare("SELECT name FROM command_log WHERE command_id=?")
    .bind(`control-d1-phase:v1:${proof.captureId}:${proof.targetId}`)
    .first();
  if (round?.name !== "control-d1.phase") fail("COMPARISON_ROUND_INCOMPLETE");
  const later = await db
    .prepare(
      `SELECT count(*) n FROM command_log WHERE applied_at>? AND name IN (${CONTENT_RECEIPTS.map(() => "?").join(",")})`,
    )
    .bind(receipts[0].applied_at, ...CONTENT_RECEIPTS)
    .first();
  if (later.n !== 0) fail("IMPORT_CHANGED_AFTER_COMPARISON");
  if ((await schemaFingerprint(db)) !== context.expected) fail("TARGET_SCHEMA_DRIFT");
  try {
    await db.batch([
      db
        .prepare(
          "UPDATE core_historical_import SET closed_at=?,comparison_sha256=?,restored_runtime_schema_sha256=expected_runtime_schema_sha256 WHERE singleton=1 AND import_id=? AND closed_at IS NULL",
        )
        .bind(micros(now), bytes(comparisonSha256), context.import_id),
    ]);
  } catch {
    // A lost reply is resolved by the readback below.
  }
  const closed = await readImport(db);
  if (
    closed?.closed_at == null ||
    closed.comparison !== comparisonSha256 ||
    closed.restored !== context.expected
  )
    fail("IMPORT_CLOSE_UNCONFIRMED");
  return summary(closed, { replayed: false });
}

export async function activateAuthority(db, { now = () => new Date(), newId = randomUUID } = {}) {
  const context = await readImport(db);
  if (context === null || context.closed_at === null) fail("IMPORT_NOT_CLOSED");
  const existing = await db.prepare(ACTIVATION).first();
  if (existing !== null) {
    if (existing.import_id !== context.import_id) fail("ACTIVATION_CONFLICT");
    return { ...existing, replayed: true };
  }
  if ((await schemaFingerprint(db)) !== context.expected) fail("TARGET_SCHEMA_DRIFT");
  const activationId = newId();
  const activatedAt = micros(now);
  if (activatedAt < context.closed_at) fail("ACTIVATION_CLOCK");
  try {
    await db.batch([
      db
        .prepare(
          "INSERT INTO core_authority_activation(singleton,activation_id,activated_at,import_id,qualification_sha256,runtime_schema_sha256) VALUES(1,?,?,?,?,?)",
        )
        .bind(
          activationId,
          activatedAt,
          context.import_id,
          bytes(context.comparison),
          bytes(context.expected),
        ),
    ]);
  } catch {
    // A lost reply is resolved by the readback below.
  }
  const activated = await db.prepare(ACTIVATION).first();
  if (activated === null || activated.activation_id !== activationId)
    fail("ACTIVATION_UNCONFIRMED");
  return { ...activated, replayed: false };
}
