import { expect, it, vi } from "vitest";

import { normalizeRlsIdentity } from "./database-rls.js";
import { createPrivateDatabaseClient } from "./database.js";

it("normalizes explicit identities into bounded, detached plain JSON claims", async () => {
  expect(normalizeRlsIdentity(null)).toEqual({ sub: null, role: "anon" });
  const claims = { team: "team-1", nested: { allowed: [true, null, 2] } };
  const normalized = normalizeRlsIdentity({ subject: "user_workos_ä", claims });
  expect(normalized).toEqual({ ...claims, sub: "user_workos_ä", role: "authenticated" });
  claims.nested.allowed.push(false);
  expect(normalized["nested"]).toEqual({ allowed: [true, null, 2] });
  expect(Object.isFrozen(normalized)).toBe(true);
  expect(Object.isFrozen(normalized["nested"])).toBe(true);
  expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
  expect(normalizeRlsIdentity({ subject: "ä".repeat(256) })["sub"]).toHaveLength(256);
  expect(
    normalizeRlsIdentity({
      subject: "user_🚀",
      claims: { "team_🚀": ["🚀", "\\u0000", "line\nbreak"] },
    }),
  ).toEqual({ sub: "user_🚀", role: "authenticated", "team_🚀": ["🚀", "\\u0000", "line\nbreak"] });
  const openRls = vi.fn();
  const database = createPrivateDatabaseClient({ query: vi.fn(), transaction: vi.fn(), openRls });
  const invalidPostgresStrings = [
    "\u0000",
    "\ud800",
    "\udfff",
    "\ud800a",
    "a\udfff",
    "\ud800\ud800",
    "\udfff\udfff",
    "\udfff\ud800",
    "🚀\ud800",
  ];
  const cycle: Record<string, unknown> = {};
  cycle["cycle"] = cycle;
  const sparse = new Array(2);
  const accessor = Object.defineProperty({}, "private", { get: () => "secret", enumerable: true });
  for (const identity of [
    undefined,
    {},
    "user",
    { subject: "" },
    { subject: "ä".repeat(257) },
    { subject: "user\nprivate" },
    { subject: "user", extra: true },
    { subject: "user", claims: undefined },
    { subject: "user", claims: [] },
    { subject: "user", claims: { sub: "other" } },
    { subject: "user", claims: { role: "admin" } },
    { subject: "user", claims: Object.create(null) },
    ...invalidPostgresStrings.flatMap((value) => [
      { subject: value },
      { subject: "user", claims: { value } },
      { subject: "user", claims: { [value]: true } },
      { subject: "user", claims: { nested: [{ value }] } },
      { subject: "user", claims: { nested: [{ [value]: true }] } },
    ]),
    ...[
      new Date(),
      new Uint8Array(1),
      Infinity,
      undefined,
      BigInt(1),
      cycle,
      sparse,
      accessor,
      Object.create({ inherited: true }),
      Object.fromEntries([["__proto__", "bad"]]),
      { constructor: "bad" },
      { prototype: "bad" },
      { "": true },
      { "line\nbreak": true },
      { ["ä".repeat(65)]: true },
      { [Symbol("symbol")]: true },
    ].map((value) => ({ subject: "user", claims: { nested: value } })),
  ]) {
    expect(() => normalizeRlsIdentity(identity)).toThrow(TypeError);
    await expect(database.withRls(identity as never, async () => undefined)).rejects.toMatchObject({
      code: "database_rls_identity_invalid",
      retryable: false,
    });
  }
  expect(openRls).not.toHaveBeenCalled();
  const base = { subject: "user", claims: { value: "" } };
  const bytes = new TextEncoder().encode(JSON.stringify(normalizeRlsIdentity(base))).byteLength;
  expect(
    normalizeRlsIdentity({ ...base, claims: { value: "x".repeat(16_384 - bytes) } }),
  ).toHaveProperty("role", "authenticated");
  expect(() =>
    normalizeRlsIdentity({ ...base, claims: { value: "x".repeat(16_385 - bytes) } }),
  ).toThrow(TypeError);
  let nested: unknown = "leaf";
  for (let depth = 0; depth < 7; depth += 1) nested = { nested };
  expect(() => normalizeRlsIdentity({ subject: "user", claims: { nested } })).not.toThrow();
  expect(() => normalizeRlsIdentity({ subject: "user", claims: { nested: { nested } } })).toThrow(
    TypeError,
  );
  expect(() =>
    normalizeRlsIdentity({ subject: "user", claims: { many: new Array(996).fill(null) } }),
  ).not.toThrow();
  expect(() =>
    normalizeRlsIdentity({ subject: "user", claims: { many: new Array(997).fill(null) } }),
  ).toThrow(TypeError);
});
