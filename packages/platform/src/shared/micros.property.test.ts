import fc from "fast-check";
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
import { roundIntegerDivision, type IntegerRoundingMode } from "./rate-card.js";

const PROPERTY_SEED = 0x51c405;
const PROPERTY_RUNS = 250;
const int8 = fc.bigInt({ min: POSTGRES_INT8_MIN, max: POSTGRES_INT8_MAX });
const safeOperand = fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n });

function referenceRound(numerator: bigint, denominator: bigint, mode: IntegerRoundingMode): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (mode === "floor" || remainder === 0n) return quotient;
  if (mode === "ceil") return quotient + 1n;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

describe("micros properties", () => {
  it("round-trips every PostgreSQL int8 value through canonical decimal JSON", () => {
    fc.assert(
      fc.property(int8, (value) => {
        const usd = usdMicros(value);
        const credits = creditMicros(value);
        const encoded = microsToJson(usd);

        expect(encoded).toMatch(/^(?:0|-?[1-9][0-9]*)$/);
        expect(usdMicrosFromJson(encoded)).toBe(value);
        expect(creditMicrosFromJson(microsToJson(credits))).toBe(value);
      }),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });

  it("accepts exactly the PostgreSQL int8 range", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          int8,
          fc.bigInt({ min: POSTGRES_INT8_MIN - 1024n, max: POSTGRES_INT8_MIN - 1n }),
          fc.bigInt({ min: POSTGRES_INT8_MAX + 1n, max: POSTGRES_INT8_MAX + 1024n }),
        ),
        (value) => {
          const isInt8 = value >= POSTGRES_INT8_MIN && value <= POSTGRES_INT8_MAX;
          if (isInt8) {
            expect(usdMicros(value)).toBe(value);
            expect(creditMicros(value)).toBe(value);
          } else {
            expect(() => usdMicros(value)).toThrow(RangeError);
            expect(() => creditMicros(value)).toThrow(RangeError);
          }
        },
      ),
      { seed: PROPERTY_SEED + 1, numRuns: PROPERTY_RUNS },
    );
  });

  it("preserves commutative and associative addition inside the valid range", () => {
    fc.assert(
      fc.property(safeOperand, safeOperand, safeOperand, (a, b, c) => {
        const ab = addCreditMicros(creditMicros(a), creditMicros(b));
        const ba = addCreditMicros(creditMicros(b), creditMicros(a));
        const left = addCreditMicros(ab, creditMicros(c));
        const right = addCreditMicros(
          creditMicros(a),
          addCreditMicros(creditMicros(b), creditMicros(c)),
        );

        expect(ab).toBe(ba);
        expect(left).toBe(right);
        expect(left).toBe(a + b + c);
      }),
      { seed: PROPERTY_SEED + 2, numRuns: PROPERTY_RUNS },
    );
  });

  it("matches exact BigInt rounding for every supported mode", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.constantFrom<IntegerRoundingMode>("floor", "ceil", "half-up"),
        (numerator, denominator, mode) => {
          expect(roundIntegerDivision(numerator, denominator, mode)).toBe(
            referenceRound(numerator, denominator, mode),
          );
        },
      ),
      { seed: PROPERTY_SEED + 3, numRuns: PROPERTY_RUNS },
    );
  });
});
