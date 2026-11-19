import { fail, integerText, columnKind } from "./control-d1-codec.mjs";

// Five original public/customer families, every37 column reconciled against BOTH baseline schemas+metadata.
export const PUBLIC_ENTRY_TYPES = Object.freeze({
  beta_feature_interests: {
    idempotency_key: ["uuid", true],
    feature: ["text", true],
    created_at: ["timestamp with time zone", true],
    voter_sha256: ["bytea", false],
    choice: ["text", false],
    position: ["bigint", true],
    expires_at: ["timestamp with time zone", true],
  },
  contact_requests: {
    request_id: ["uuid", true],
    payload_sha256: ["bytea", true],
    name: ["text", true],
    email: ["text", true],
    company: ["text", true],
    message: ["text", true],
    created_at: ["timestamp with time zone", true],
    expires_at: ["timestamp with time zone", true],
  },
  customer_feedback: {
    feedback_id: ["ulid", true],
    organization_id: ["ulid", true],
    actor_id: ["text", true],
    idempotency_key: ["text", true],
    request_sha256: ["bytea", true],
    project_id: ["ulid", false],
    environment_id: ["ulid", false],
    operation_id: ["ulid", false],
    report: ["jsonb", true],
    submitted_at: ["timestamp with time zone", true],
  },
  customer_feedback_events: {
    event_id: ["ulid", true],
    feedback_id: ["ulid", true],
    visibility: ["text", true],
    status: ["text", false],
    release: ["text", false],
    body: ["text", false],
    actor_id: ["text", true],
    recorded_at: ["timestamp with time zone", true],
  },
  beta_interests: {
    email: ["text", true],
    consent_version: ["text", true],
    created_at: ["timestamp with time zone", true],
    expires_at: ["timestamp with time zone", true],
  },
});
export const PUBLIC_ENTRY_KEYS = Object.freeze({
  beta_feature_interests: ["idempotency_key"],
  contact_requests: ["request_id"],
  customer_feedback: ["feedback_id"],
  customer_feedback_events: ["event_id"],
  beta_interests: ["email"],
});
export const PUBLIC_ENTRY_PARENTS = Object.freeze({
  beta_feature_interests: [],
  contact_requests: [],
  customer_feedback: ["projects", "operations"],
  customer_feedback_events: ["customer_feedback"],
  beta_interests: [],
});
export const PUBLIC_ENTRY_SCHEMA_PINS = Object.freeze({
  "0504_original_public_entry_feedback.sql":
    "0af6e6c9be412d4b70617e8e3f8ce889c2f3591115e120a12fee24f0d826bd83",
});
export const PUBLIC_ENTRY_COLUMNS = Object.freeze(
  Object.fromEntries(
    Object.entries(PUBLIC_ENTRY_TYPES).map(([table, fields]) => [
      table,
      Object.keys(fields).join(","),
    ]),
  ),
);
export const PUBLIC_ENTRY_TARGETS = Object.freeze(Object.keys(PUBLIC_ENTRY_TYPES));
export function publicEntryKind(table, field) {
  const declaration = PUBLIC_ENTRY_TYPES[table]?.[field];
  if (!declaration) fail("PUBLIC_ENTRY_COLUMN");
  return declaration[0] === "boolean"
    ? "integer"
    : columnKind(declaration[0] === "ulid" ? "text" : declaration[0]);
}
function timestamp(value) {
  if (
    !/^(?!0000-)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail("PUBLIC_ENTRY_TIMESTAMP_UNREPRESENTABLE");
}
/** Exact original public/feedback facts; historical text, votes, status and allocator values are never regenerated. */
export function mapPublicEntryFamily(rows, manifest, table) {
  if (
    !(rows instanceof Map) ||
    !Array.isArray(manifest?.tables) ||
    !Object.hasOwn(PUBLIC_ENTRY_TYPES, table)
  )
    fail("PUBLIC_ENTRY_MANIFEST");
  for (const [name, sha256] of Object.entries(PUBLIC_ENTRY_SCHEMA_PINS))
    if (
      !manifest.targetPin?.migrations?.some(
        (entry) => entry.name === name && entry.sha256 === sha256,
      )
    )
      fail("PUBLIC_ENTRY_SCHEMA_PREREQUISITE");
  const fields = PUBLIC_ENTRY_TYPES[table],
    names = Object.keys(fields),
    definition = manifest.tables.find((entry) => entry.name === table),
    source = rows.get(table);
  if (
    !definition ||
    definition.columns?.map((column) => column.name).join(",") !== PUBLIC_ENTRY_COLUMNS[table] ||
    !Array.isArray(source)
  )
    fail("PUBLIC_ENTRY_SOURCE_COLUMNS");
  for (const column of definition.columns) {
    const [sourceType, notNull] = fields[column.name],
      pgType = sourceType === "ulid" ? "text" : sourceType;
    if (
      column.pgType !== pgType ||
      (column.sourceType ?? column.pgType) !== sourceType ||
      column.kind !== columnKind(pgType) ||
      column.notNull !== notNull
    )
      fail("PUBLIC_ENTRY_SOURCE_TYPE");
  }
  const records = source.map((original) => {
    if (!original || Object.keys(original).sort().join(",") !== names.slice().sort().join(","))
      fail("PUBLIC_ENTRY_ROW_SHAPE");
    const row = { ...original };
    for (const field of names) {
      const value = original[field],
        [type, notNull] = fields[field];
      if (value === null) {
        if (notNull) fail("PUBLIC_ENTRY_NULL");
        continue;
      }
      if (typeof value !== "string") fail("PUBLIC_ENTRY_ROW_VALUE");
      if (type === "ulid" && !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(value))
        fail("PUBLIC_ENTRY_ULID");
      if (
        type === "uuid" &&
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)
      )
        fail("PUBLIC_ENTRY_UUID");
      if (type === "bytea") {
        if (!/^(?:[a-f0-9]{2})*$/u.test(value)) fail("PUBLIC_ENTRY_BYTEA");
      } else if (type === "integer" || type === "bigint") {
        integerText(value);
        if (type === "integer" && (BigInt(value) < -2147483648n || BigInt(value) > 2147483647n))
          fail("PUBLIC_ENTRY_INT4");
      } else if (type === "timestamp with time zone") timestamp(value);
      else if (type === "boolean") {
        if (value !== "true" && value !== "false") fail("PUBLIC_ENTRY_BOOLEAN");
        row[field] = value === "true" ? "1" : "0";
      } else if (value.includes("\0")) fail("PUBLIC_ENTRY_TEXT");
    }
    return { table, row };
  });
  return records;
}
export function mapPublicEntryFacts(rows, manifest) {
  return PUBLIC_ENTRY_TARGETS.flatMap((table) => mapPublicEntryFamily(rows, manifest, table));
}
