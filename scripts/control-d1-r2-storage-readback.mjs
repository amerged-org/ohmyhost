import { fail } from "./control-d1-codec.mjs";
import {
  R2_STORAGE_COLUMNS,
  R2_STORAGE_KEYS,
  r2StorageKind,
  assertR2StorageMarker,
} from "./control-d1-r2-storage-mappings.mjs";

/** Native original PK seeks. All six keys are non-NULL text; no expression/COLLATE wraps the seek. */
export async function* readR2StoragePages(db, table) {
  if (!Object.hasOwn(R2_STORAGE_COLUMNS, table)) fail("R2_STORAGE_READBACK_TABLE");
  const fields = R2_STORAGE_COLUMNS[table].split(","),
    keys = R2_STORAGE_KEYS[table];
  const projection = fields
    .map((column) => {
      const kind = r2StorageKind(table, column);
      return kind === "integer"
        ? `CAST(${column} AS TEXT) AS ${column}`
        : kind === "bytea"
          ? `lower(hex(${column})) AS ${column}`
          : kind === "boolean"
            ? `CASE ${column} WHEN 1 THEN 'true' WHEN 0 THEN 'false' END AS ${column}`
            : column;
    })
    .join(",");
  // Original ULID domain26,162 physical locator544bytes,197 provider4/account60 ASCII.
  // Six JSON bytes per key byte also bounds legal escaped keys in the candidate response.
  const keyBytes = keys.reduce(
    (sum, key) =>
      sum +
      key.length +
      10 +
      6 *
        (key === "physical_object_key"
          ? 544
          : key === "account_id"
            ? 60
            : key === "provider_kind"
              ? 4
              : 26),
    2,
  );
  const candidateLimit = Math.max(1, Math.min(128, Math.floor((256 * 1024) / keyBytes)));
  const overhead = fields.reduce((sum, field) => sum + field.length + 10, 2);
  // Six JSON bytes per original byte covers quotes, controls and UTF8 without touching captured text.
  const bytes = fields.map((field) => `6*coalesce(length(CAST(${field} AS BLOB)),0)`).join("+");
  const count = await db.prepare(`SELECT CAST(count(*) AS TEXT) n FROM ${table}`).first();
  if (typeof count?.n !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count.n))
    fail("R2_STORAGE_READBACK_COUNT");
  let after = null,
    seen = 0n;
  for (;;) {
    const where =
      after === null ? "" : ` WHERE (${keys.join(",")})>(${keys.map(() => "?").join(",")})`;
    const candidates = (
      await db
        .prepare(
          `SELECT ${keys.join(",")},${overhead}+${bytes} __bytes FROM ${table}${where} ORDER BY ${keys.join(",")} LIMIT ${candidateLimit}`,
        )
        .bind(...(after ?? []))
        .all()
    ).results;
    if (!Array.isArray(candidates)) fail("R2_STORAGE_READBACK_RESPONSE");
    if (!candidates.length) break;
    const chosen = [];
    let size = 0;
    for (const candidate of candidates) {
      if (
        !Number.isSafeInteger(candidate.__bytes) ||
        candidate.__bytes < 0 ||
        keys.some((key) => typeof candidate[key] !== "string")
      )
        fail("R2_STORAGE_READBACK_KEY");
      if (chosen.length && size + candidate.__bytes > 256 * 1024) break;
      chosen.push(candidate);
      size += candidate.__bytes;
    }
    const end = keys.map((key) => chosen.at(-1)[key]);
    const predicate = `${where}${where ? " AND" : " WHERE"} (${keys.join(",")})<=(${keys.map(() => "?").join(",")})`;
    const page = (
      await db
        .prepare(
          `SELECT ${projection} FROM ${table}${predicate} ORDER BY ${keys.join(",")} LIMIT ${chosen.length}`,
        )
        .bind(...(after ?? []), ...end)
        .all()
    ).results;
    if (
      !Array.isArray(page) ||
      page.length !== chosen.length ||
      JSON.stringify(after) === JSON.stringify(end) ||
      page.some(
        (row, index) =>
          keys.some((key) => row[key] !== chosen[index][key]) ||
          fields.some((field) => row[field] !== null && typeof row[field] !== "string"),
      )
    )
      fail("R2_STORAGE_READBACK_CURSOR");
    if (table === "project_r2_erasure_barriers") for (const row of page) assertR2StorageMarker(row);
    seen += BigInt(page.length);
    after = end;
    yield page;
  }
  if (
    seen !== BigInt(count.n) ||
    (await db.prepare(`SELECT CAST(count(*) AS TEXT) n FROM ${table}`).first())?.n !== count.n
  )
    fail("R2_STORAGE_READBACK_COUNT_CHANGED");
}

/** Small-fixture collector only; central frozen readback must use bounded pages above. */
export async function readR2StorageFacts(db) {
  const facts = new Map();
  for (const table of Object.keys(R2_STORAGE_COLUMNS)) {
    const rows = [];
    for await (const page of readR2StoragePages(db, table)) rows.push(...page);
    facts.set(table, rows);
  }
  return facts;
}
