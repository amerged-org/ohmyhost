import { Buffer } from "node:buffer";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const FORMAT = "omh.control-d1.capture/v2";
const MAGIC = Buffer.from("OMHD1E2\n");

export function fail(code) {
  throw new Error(`CONTROL_D1_${code}`);
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable metadata encoding; source JSON/text values are strings and are never parsed here. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  if (["string", "boolean", "number"].includes(typeof value) || value === null)
    return JSON.stringify(value);
  return fail("ENCODING");
}

/** Explicit type/null/byte-length framing, including the original PostgreSQL type identity. */
export function frameRow(columns, values) {
  if (columns.length !== values.length) fail("ROW_SHAPE");
  const parts = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index];
    const value = values[index];
    if (value !== null && typeof value !== "string") fail("ROW_VALUE");
    const type = Buffer.from(
      `${column.name}\0${column.sourceType ?? column.pgType}\0${column.pgType}\0${column.kind}`,
    );
    const body =
      value === null ? null : Buffer.from(value, column.kind === "bytea" ? "hex" : "utf8");
    if (column.kind === "bytea" && value !== null && !/^(?:[a-f0-9]{2})*$/u.test(value))
      fail("BYTEA");
    const header = Buffer.alloc(8);
    header.writeUInt32BE(type.length, 0);
    header.writeInt32BE(body === null ? -1 : body.length, 4);
    parts.push(header, type);
    if (body !== null) parts.push(body);
  }
  return Buffer.concat(parts);
}

/** Sorted row hashes retain multiplicity, unlike a Set or a commutative truncated checksum. */
export function tableProof(columns, rows) {
  const hashes = rows.map((row) => sha256(frameRow(columns, row))).sort();
  return { rows: String(rows.length), sha256: sha256(Buffer.from(hashes.join("\n"))) };
}

export function seal(key, captureId, name, bytes) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail("KEY");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${FORMAT}\0${captureId}\0${name}`));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function unseal(key, captureId, name, bytes) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) fail("KEY");
  try {
    if (bytes.length < 36 || !bytes.subarray(0, 8).equals(MAGIC)) fail("CIPHER");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(8, 20));
    decipher.setAAD(Buffer.from(`${FORMAT}\0${captureId}\0${name}`));
    decipher.setAuthTag(bytes.subarray(20, 36));
    return Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]);
  } catch {
    return fail("CIPHER");
  }
}

export function columnKind(pgType) {
  if (pgType.endsWith("[]")) return "array";
  if (["smallint", "integer", "bigint"].includes(pgType)) return "integer";
  if (pgType.startsWith("numeric")) return "numeric";
  if (["real", "double precision"].includes(pgType)) return "float";
  if (pgType === "bytea") return "bytea";
  if (pgType.startsWith("timestamp")) return "timestamp";
  return "text";
}

export function quoteIdentifier(value) {
  if (typeof value !== "string" || value.includes("\0")) fail("IDENTIFIER");
  return `"${value.replaceAll('"', '""')}"`;
}

/** Everything is transported as PostgreSQL-rendered text, so neither pg nor JSON can round an int8. */
export function captureExpression(column) {
  const name = quoteIdentifier(column.name);
  if (column.kind === "bytea") return `encode(${name}, 'hex')`;
  if (column.kind === "timestamp") {
    const utc = column.pgType.includes("with time zone") ? `${name} AT TIME ZONE 'UTC'` : name;
    return `CASE WHEN ${name} IS NULL THEN NULL WHEN ${name} = 'infinity' THEN '+infinity' WHEN ${name} = '-infinity' THEN '-infinity' WHEN extract(year FROM ${utc}) < 1 OR extract(year FROM ${utc}) > 9999 THEN 'postgres:' || ${name}::text ELSE to_char(${utc}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END`;
  }
  // PostgreSQL's array text includes explicit lower bounds whenever they differ from one. JSON would lose them.
  return `${name}::text`;
}

/** Stored int8 values enter D1 as decimal text, never a JavaScript number. */
export function integerText(value) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) fail("INTEGER");
  const parsed = BigInt(value);
  if (parsed < -9223372036854775808n || parsed > 9223372036854775807n) fail("INTEGER_RANGE");
  return value;
}
