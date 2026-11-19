import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { canonical, fail, sha256 } from "./control-d1-codec.mjs";

/**
 * Two-phase import. One historical-import context is loaded in rounds; every round is a fresh capture of the live
 * source. A `preload` round runs ONLINE and loads the families that cannot change after capture. The `final` round,
 * taken inside the technical write stop, adds what is new since the previous round plus the changing families.
 *
 * - A table is preloadable unless it is final-only or depends on one: through a foreign key, or because an INSERT trigger of
 *   it reads that table. The dependency must be loaded first and exactly once, because the importer never rewrites a row.
 * - A round imports a preloadable record only if the previous round did not already import the identical record.
 *   Every record of the previous round must still be in the new capture, byte for byte. If the source changed or
 *   removed one, the round is refused before any write (`PHASE_SUPERSEDED`), so nothing imported is ever superseded.
 */

/**
 * Target tables whose rows change in place or disappear after capture (cursors, work queues, counters, derived
 * aggregates): the union of the tables with a changed or removed record between three Development captures taken
 * 61 and 84 minutes apart. A table missing here is not a silent risk: the round proof above refuses it.
 */
export const FINAL_ONLY_TABLES = Object.freeze([
  "function_runs",
  "pgcf_database_entitlement_policies",
  "resend_mail_domains",
  "stripe_recharge_policies",
  "workspace_mail_domains",
]);

const hashOf = (record) =>
  createHash("sha256")
    .update(canonical({ table: record.table, row: record.row }))
    .digest("base64");

/**
 * What a row of each Core table needs in the target before it can be inserted: its foreign-key parents, and every table
 * an INSERT trigger of it reads. Read from the target schema itself.
 * `dropped` names the overlay triggers an import removes while it writes; they never run, so they create no dependency.
 */
export async function readInsertDependencies(db, dropped = new Set()) {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf*'",
      )
      .all()
  ).results.map((row) => row.name);
  const known = new Set(tables);
  const edges = await db.batch(
    tables.map((table) =>
      db.prepare(`SELECT "table" AS parent FROM pragma_foreign_key_list(?)`).bind(table),
    ),
  );
  const parents = new Map();
  const add = (table, parent) => {
    if (parent !== table) parents.set(table, [...new Set([...(parents.get(table) ?? []), parent])]);
  };
  tables.forEach((table, index) => {
    for (const row of edges[index].results) add(table, row.parent);
  });
  const triggers = (
    await db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger'").all()
  ).results;
  for (const { name, tbl_name: table, sql } of triggers) {
    if (dropped.has(name)) continue;
    if (!/^\s*CREATE\s+TRIGGER\s+\S+\s+(?:BEFORE|AFTER)\s+INSERT\b/iu.test(sql)) continue;
    const body = sql.replace(/'(?:[^']|'')*'/gu, "''");
    for (const match of body.matchAll(/\b(?:FROM|JOIN)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/giu))
      if (known.has(match[1])) add(table, match[1]);
  }
  return parents;
}

/** Final-only tables plus every table that depends on one of them, however indirectly. */
export function finalTables(parents, finalOnly = FINAL_ONLY_TABLES) {
  const closed = new Set(finalOnly);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [table, tableParents] of parents)
      if (!closed.has(table) && tableParents.some((parent) => closed.has(parent))) {
        closed.add(table);
        changed = true;
      }
  }
  return closed;
}

/** Contiguous atomic units, packed exactly like the importer packs them; a unit is preloadable as a whole or not at all. */
function classify(plan, closed) {
  const result = [];
  for (let offset = 0; offset < plan.records.length; ) {
    const group = plan.records[offset].atomicGroup;
    let end = offset + 1;
    if (group !== undefined)
      while (end < plan.records.length && plan.records[end].atomicGroup === group) end += 1;
    const records = plan.records.slice(offset, end);
    result.push({
      records,
      hashes: records.map(hashOf),
      preloadable: records.every((record) => !closed.has(record.table)),
    });
    offset = end;
  }
  return result;
}

function contentOf(captureId, units) {
  const hashes = new Map(); // record hash -> table
  for (const unit of units)
    if (unit.preloadable)
      unit.records.forEach((record, index) => hashes.set(unit.hashes[index], record.table));
  return {
    captureId,
    hashes,
    records: hashes.size,
    sha256: sha256(Buffer.from([...hashes.keys()].sort().join("\n"))),
  };
}

/** What the target holds after the round that imported this capture: its preloadable records, with one digest. */
export function preloadContent(plan, closed) {
  return contentOf(plan.captureId, classify(plan, closed));
}

/**
 * Every record the target holds once the round that imported this capture is complete, with the first round's
 * provenance. The exact page-scan comparison reads whole tables against exactly this.
 */
export function roundContent(plan, { phase, closed }) {
  return classify(plan, closed)
    .filter((unit) => unit.preloadable || phase === "final")
    .flatMap((unit) => unit.records);
}

/**
 * One round as a plan the importer already understands. `phase` is `preload` or `final`; `baseline` is the
 * `preloadContent` of the capture of the previous round (absent for the first round). `identity` is the capture id
 * and manifest digest of the first round, which opened the import context.
 */
export function phasePlan(plan, { phase, baseline, closed, identity }) {
  if (phase !== "preload" && phase !== "final") fail("PHASE");
  if (
    baseline === undefined &&
    (identity.captureId !== plan.captureId || identity.manifestSha256 !== plan.manifestSha256)
  )
    fail("PHASE_IDENTITY");
  const units = classify(plan, closed);
  const content = contentOf(plan.captureId, units);
  if (baseline) {
    const superseded = new Map();
    for (const [hash, table] of baseline.hashes)
      if (!content.hashes.has(hash)) superseded.set(table, (superseded.get(table) ?? 0) + 1);
    if (superseded.size > 0) {
      const error = new Error("CONTROL_D1_PHASE_SUPERSEDED");
      error.detail = Object.fromEntries([...superseded].sort());
      throw error;
    }
  }
  const records = [],
    hashes = [];
  let imported = 0,
    finalOnly = 0;
  for (const unit of units) {
    if (!unit.preloadable) {
      if (phase === "final") {
        records.push(...unit.records);
        hashes.push(...unit.hashes);
        finalOnly += unit.records.length;
      }
      continue;
    }
    const known = unit.hashes.filter((hash) => baseline?.hashes.has(hash)).length;
    if (known === unit.records.length) continue;
    // An atomic unit (a deferred foreign-key cycle) is never split across rounds.
    if (known !== 0) fail("PHASE_GROUP_SPLIT");
    records.push(...unit.records);
    hashes.push(...unit.hashes);
    imported += unit.records.length;
  }
  const info = {
    phase,
    captureId: plan.captureId,
    identity,
    baseline: baseline ? { captureId: baseline.captureId, sha256: baseline.sha256 } : null,
    content: { records: content.records, sha256: content.sha256 },
    imported,
    finalOnly,
  };
  return {
    ...plan,
    records,
    phaseInfo: info,
    adoptContext: baseline !== undefined,
    ...(phase === "final"
      ? {}
      : {
          sequenceRestores: [],
          dispositions: [],
        }),
    digest: sha256(
      Buffer.from(
        canonical({ parent: plan.digest, info, records: sha256(Buffer.from(hashes.join("\n"))) }),
      ),
    ),
  };
}
