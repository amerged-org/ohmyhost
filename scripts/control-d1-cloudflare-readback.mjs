import { Buffer } from "node:buffer";
import { fail, integerText, quoteIdentifier } from "./control-d1-codec.mjs";
import { CLOUDFLARE_COLUMNS, CLOUDFLARE_TYPES } from "./control-d1-cloudflare-mappings.mjs";

const KEYS = Object.freeze({
  cloudflare_project_domains: ["organization_id", "project_id"],
  cloudflare_project_authorization_states: ["organization_id", "authorization_id"],
  cloudflare_project_dns_grants: ["organization_id", "project_id"],
  cloudflare_project_oauth_revocations: ["organization_id", "project_id"],
  cloudflare_project_domain_receipts: ["organization_id", "receipt_id"],
  scoped_customer_dns_authorizations: ["authorization_id"],
  scoped_customer_dns_grants: ["organization_id", "purpose", "resource_id"],
  scoped_customer_dns_revocations: [
    "organization_id",
    "purpose",
    "resource_id",
    "idempotency_key_sha256",
  ],
});
const numeric = (type) => ["integer", "bigint"].includes(type);
const WIDTHS = Object.freeze({ purpose: 20, idempotency_key_sha256: 64 });

/** Native PKs stay unwrapped in candidate WHERE/ORDER BY; only returned source values are text/hex projected. */
export async function* readCloudflarePages(db, table) {
  if (!Object.hasOwn(KEYS, table)) fail("CLOUDFLARE_READBACK_TABLE");
  const columns = CLOUDFLARE_COLUMNS[table].split(","),
    keys = KEYS[table],
    types = CLOUDFLARE_TYPES[table],
    stored = columns,
    names = keys.map(quoteIdentifier),
    order = names.join(","),
    parameters = keys.map((field, index) =>
      numeric(types[field])
        ? `CAST(?${index + 1} AS INTEGER)`
        : types[field] === "bytea"
          ? `unhex(?${index + 1})`
          : `?${index + 1}`,
    ),
    selected = columns.map((field) => {
      const name = `facts.${quoteIdentifier(field)}`,
        type = types[field];
      return (
        (table === "cloudflare_project_dns_grants" && field === "scopes"
          ? `CASE WHEN ${name}='["dns.write","zone.read"]' THEN '{dns.write,zone.read}' ELSE '!invalid_scope' END`
          : type === "boolean"
            ? `CASE WHEN ${name} IS NULL THEN NULL WHEN ${name}=1 THEN 'true' WHEN ${name}=0 THEN 'false' ELSE '!invalid_boolean' END`
            : numeric(type)
              ? `CAST(${name} AS TEXT)`
              : type === "bytea"
                ? `CASE WHEN ${name} IS NULL THEN NULL ELSE lower(hex(${name})) END`
                : name) + ` AS ${quoteIdentifier(field)}`
      );
    });
  const estimate = stored
      .map(
        (field) =>
          (types[field] === "bytea" ? 12 : 6) +
          `*coalesce(length(CAST(${quoteIdentifier(field)} AS BLOB)),0)`,
      )
      .join("+"),
    overhead =
      2 +
      stored.reduce(
        (size, field) => size + Buffer.byteLength(JSON.stringify(field), "utf8") + 10,
        0,
      ),
    countSql = `SELECT CAST(count(*) AS TEXT) n FROM ${quoteIdentifier(table)}`;
  const count = (await db.prepare(countSql).first())?.n;
  if (typeof count !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(count))
    fail("CLOUDFLARE_READBACK_COUNT");
  let after = null,
    observed = 0n;
  for (;;) {
    const sql = `WITH candidates AS (SELECT ${order},${overhead}+${estimate} AS __bytes FROM ${quoteIdentifier(table)} AS stored${after === null ? "" : ` WHERE (${order})>(${parameters.join(",")})`} ORDER BY ${order} LIMIT 128),sized AS (SELECT *,row_number() OVER(ORDER BY ${order}) AS __row,sum(__bytes) OVER(ORDER BY ${order} ROWS UNBOUNDED PRECEDING) AS __total FROM candidates),chosen AS (SELECT ${order} FROM sized WHERE __row=1 OR __total<=262144) SELECT ${selected.join(",")} FROM ${quoteIdentifier(table)} AS facts JOIN chosen ON ${keys.map((field) => `facts.${quoteIdentifier(field)} IS chosen.${quoteIdentifier(field)}`).join(" AND ")} ORDER BY ${keys.map((field) => `facts.${quoteIdentifier(field)}`).join(",")} LIMIT 129`;
    let page;
    try {
      page = (
        await db
          .prepare(sql)
          .bind(...(after ?? []))
          .all()
      ).results;
    } catch (cause) {
      throw new Error("CONTROL_D1_CLOUDFLARE_READBACK_UNREPRESENTABLE", { cause });
    }
    if (!Array.isArray(page) || page.length > 128) fail("CLOUDFLARE_READBACK_RESPONSE");
    if (page.length === 0) break;
    for (const row of page) {
      for (const column of columns)
        if (row[column] !== null && typeof row[column] !== "string")
          fail("CLOUDFLARE_READBACK_VALUE");
      for (const field of keys) {
        const value = row[field];
        if (typeof value !== "string") fail("CLOUDFLARE_READBACK_KEY");
        if (numeric(types[field])) integerText(value);
        else if (Buffer.byteLength(value, "utf8") > (WIDTHS[field] ?? 26))
          fail("CLOUDFLARE_READBACK_KEY_WIDTH");
      }
      if (table === "cloudflare_project_dns_grants" && row.scopes !== "{dns.write,zone.read}")
        fail("CLOUDFLARE_SCOPE_ARRAY_TARGET");
      for (const field of columns)
        if (
          types[field] === "boolean" &&
          row[field] !== null &&
          row[field] !== "true" &&
          row[field] !== "false"
        )
          fail("CLOUDFLARE_BOOLEAN_TARGET");
    }
    const next = keys.map((field) => page.at(-1)[field]);
    if (JSON.stringify(next) === JSON.stringify(after)) fail("CLOUDFLARE_READBACK_CURSOR");
    after = next;
    observed += BigInt(page.length);
    if (observed > BigInt(count)) fail("CLOUDFLARE_READBACK_COUNT_CHANGED");
    yield page;
  }
  if (observed !== BigInt(count) || (await db.prepare(countSql).first())?.n !== count)
    fail("CLOUDFLARE_READBACK_COUNT_CHANGED");
}

/** Fixture collector only; whole-source proof consumes readCloudflarePages directly. */
export async function readCloudflareFacts(db) {
  const facts = new Map();
  for (const table of Object.keys(CLOUDFLARE_COLUMNS)) {
    const rows = [];
    for await (const page of readCloudflarePages(db, table)) rows.push(...page);
    facts.set(table, rows);
  }
  return facts;
}
