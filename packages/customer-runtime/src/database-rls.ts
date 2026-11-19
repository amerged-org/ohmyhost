import type { CustomerDatabaseJson } from "./database.js";

export interface CustomerDatabaseRlsIdentity {
  readonly subject: string;
  readonly claims?: Readonly<Record<string, CustomerDatabaseJson>>;
}

export type CustomerDatabaseRlsClaims = Readonly<Record<string, CustomerDatabaseJson>> & {
  readonly sub: string | null;
  readonly role: "authenticated" | "anon";
};

/** Shared SDK/service validation. Identity is asserted by the trusted application backend. */
export function normalizeRlsIdentity(input: unknown): CustomerDatabaseRlsClaims {
  let subject: string | null = null;
  const document: Record<string, unknown> = {};
  if (input !== null) {
    const identity = plainProperties(input);
    if (
      Object.keys(identity).sort().join(",") !== "subject" &&
      Object.keys(identity).sort().join(",") !== "claims,subject"
    )
      invalidIdentity();
    const value: unknown = identity["subject"]?.value;
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      new TextEncoder().encode(value).byteLength > 512 ||
      /\p{Cc}/u.test(value)
    )
      invalidIdentity();
    subject = value;
    if (Object.hasOwn(identity, "claims")) {
      const claims = plainProperties(identity["claims"]?.value);
      for (const [key, descriptor] of Object.entries(claims)) {
        if (key === "sub" || key === "role") invalidIdentity();
        validateKey(key);
        document[key] = descriptor.value;
      }
    }
  }
  document["sub"] = subject;
  document["role"] = subject === null ? "anon" : "authenticated";
  return cloneJson(document, { nodes: 0, bytes: 0 }, 0) as CustomerDatabaseRlsClaims;
}

function cloneJson(
  value: unknown,
  budget: { nodes: number; bytes: number },
  depth: number,
): CustomerDatabaseJson {
  budget.nodes += 1;
  if (budget.nodes > 1_000 || depth > 8) invalidIdentity();
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) invalidIdentity();
    if (typeof value === "string") validateJsonString(value);
    consume(budget, JSON.stringify(value));
    return value;
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length !== 0 ||
      Object.getOwnPropertyNames(value).length !== value.length + 1
    )
      invalidIdentity();
    consume(budget, "[]");
    const output: CustomerDatabaseJson[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (property === undefined || !Object.hasOwn(property, "value") || !property.enumerable)
        invalidIdentity();
      if (index > 0) consume(budget, ",");
      output.push(cloneJson(property.value, budget, depth + 1));
    }
    return Object.freeze(output);
  }
  const properties = plainProperties(value);
  consume(budget, "{}");
  const output: Record<string, CustomerDatabaseJson> = {};
  for (const [index, [key, property]] of Object.entries(properties).entries()) {
    validateKey(key);
    consume(budget, `${index > 0 ? "," : ""}${JSON.stringify(key)}:`);
    output[key] = cloneJson(property.value, budget, depth + 1);
  }
  return Object.freeze(output);
}

function plainProperties(value: unknown): Record<string, PropertyDescriptor> {
  if (
    typeof value !== "object" ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  )
    invalidIdentity();
  const properties = Object.getOwnPropertyDescriptors(value);
  for (const property of Object.values(properties)) {
    if (!Object.hasOwn(property, "value") || !property.enumerable) invalidIdentity();
  }
  return properties;
}

function validateKey(key: string): void {
  validateJsonString(key);
  if (
    key.length === 0 ||
    new TextEncoder().encode(key).byteLength > 128 ||
    /\p{Cc}/u.test(key) ||
    key === "__proto__" ||
    key === "constructor" ||
    key === "prototype"
  )
    invalidIdentity();
}

function validateJsonString(value: string): void {
  // PostgreSQL jsonb rejects NUL and lone UTF-16 surrogates even when JSON.stringify escapes them.
  if (!value.isWellFormed() || value.includes("\u0000")) invalidIdentity();
}

function consume(budget: { bytes: number }, text: string): void {
  budget.bytes += new TextEncoder().encode(text).byteLength;
  if (budget.bytes > 16 * 1024) invalidIdentity();
}

function invalidIdentity(): never {
  throw new TypeError("Invalid database RLS identity");
}
