import { fail } from "./control-d1-codec.mjs";
import { readFixedProjectionPages } from "./control-d1-readback-pages.mjs";
import {
  PUBLIC_ENTRY_TYPES,
  PUBLIC_ENTRY_COLUMNS,
  PUBLIC_ENTRY_KEYS,
} from "./control-d1-public-entry-mappings.mjs";
export function publicEntryProjection(table) {
  if (!Object.hasOwn(PUBLIC_ENTRY_TYPES, table)) fail("PUBLIC_ENTRY_READBACK_TABLE");
  const fields = PUBLIC_ENTRY_TYPES[table],
    columns = PUBLIC_ENTRY_COLUMNS[table].split(",");
  return {
    sql: `SELECT ${columns.map((field) => (fields[field][0] === "bytea" ? `CASE WHEN ${field} IS NULL THEN NULL ELSE lower(hex(${field})) END AS ${field}` : fields[field][0] === "bigint" || fields[field][0] === "integer" ? `CAST(${field} AS TEXT) AS ${field}` : field)).join(",")} FROM ${table}`,
    columns,
    keys: PUBLIC_ENTRY_KEYS[table].map((column) => ({
      column,
      kind: "text",
      maxBytes:
        fields[column][0] === "ulid"
          ? 26
          : fields[column][0] === "uuid"
            ? 36
            : column === "email"
              ? 1016
              : 256,
    })),
    keyProof: {
      kind: "primary-key",
      source:
        "Original UUID/ULID primary keys and beta_interests.email<=254 PostgreSQL characters, at most4 UTF8 bytes each; retained by exact native0504. Identity position is not a key and never drives a rowid/MAX allocator.",
    },
  };
}
export function readPublicEntryPages(db, table) {
  return readFixedProjectionPages(db, publicEntryProjection(table));
}
