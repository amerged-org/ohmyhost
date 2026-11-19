import { describe, expect, it } from "vitest";

import {
  POSTGRES_INT8_MAX,
  POSTGRES_INT8_MIN,
  addCreditMicros,
  creditMicros,
  creditMicrosFromJson,
  microsToJson,
  usdMicros,
  usdMicrosFromJson,
} from "./micros.js";

describe("BigInt micros", () => {
  it("accepts both PostgreSQL int8 boundaries", () => {
    expect(usdMicros(POSTGRES_INT8_MIN)).toBe(POSTGRES_INT8_MIN);
    expect(creditMicros(POSTGRES_INT8_MAX)).toBe(POSTGRES_INT8_MAX);
  });

  it("rejects values outside PostgreSQL int8", () => {
    expect(() => usdMicros(POSTGRES_INT8_MAX + 1n)).toThrow(/int8/);
    expect(() => creditMicros(POSTGRES_INT8_MIN - 1n)).toThrow(/int8/);
  });

  it("uses canonical decimal strings at JSON boundaries", () => {
    expect(microsToJson(usdMicros(-1234567n))).toBe("-1234567");
    expect(usdMicrosFromJson("-1234567")).toBe(-1234567n);
    expect(creditMicrosFromJson("0")).toBe(0n);
    expect(() => usdMicrosFromJson("01")).toThrow(/decimal/);
    expect(() => creditMicrosFromJson(1 as never)).toThrow(/decimal/);
  });

  it("checks overflow when adding same-unit values", () => {
    expect(addCreditMicros(creditMicros(20n), creditMicros(-3n))).toBe(17n);
    expect(() => addCreditMicros(creditMicros(POSTGRES_INT8_MAX), creditMicros(1n))).toThrow(
      /int8/,
    );
  });
});
