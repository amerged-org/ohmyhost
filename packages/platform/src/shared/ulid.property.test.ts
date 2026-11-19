import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { Clock } from "./clock.js";
import { DeterministicEntropy } from "./entropy.js";
import { createUlidFactory, parseUlid } from "./ulid.js";

const PROPERTY_SEED = 0x0a11d;
const PROPERTY_RUNS = 200;
const CANONICAL_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

class SequenceClock implements Clock {
  #index = 0;

  constructor(private readonly timestamps: readonly number[]) {}

  now(): Date {
    const timestamp = this.timestamps[Math.min(this.#index, this.timestamps.length - 1)];
    this.#index += 1;
    if (timestamp === undefined) {
      throw new Error("Sequence clock requires at least one timestamp");
    }
    return new Date(timestamp);
  }
}

describe("ULID factory properties", () => {
  it("keeps canonical, unique, lexicographically increasing IDs when clocks repeat or move back", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffffffff }),
        fc.integer({ min: 1, max: 64 }),
        fc.array(fc.integer({ min: -10_000, max: 0 }), { minLength: 1, maxLength: 64 }),
        (seed, count, backwardOffsets) => {
          const initialTimestamp = Date.UTC(2026, 0, 1);
          const timestamps = Array.from(
            { length: count },
            (_, index) => initialTimestamp + (backwardOffsets[index % backwardOffsets.length] ?? 0),
          );
          const factory = createUlidFactory({
            clock: new SequenceClock(timestamps),
            entropy: new DeterministicEntropy(seed),
          });

          const ids = Array.from({ length: count }, () => factory.next());

          expect(ids.every((id) => CANONICAL_ULID.test(id))).toBe(true);
          expect(ids.every((id) => parseUlid(id) === id)).toBe(true);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids).toEqual([...ids].sort());
          for (let index = 1; index < ids.length; index += 1) {
            const current = ids[index];
            const previous = ids[index - 1];
            if (current === undefined || previous === undefined) {
              throw new Error("Generated ULID sequence is unexpectedly sparse");
            }
            expect(current > previous).toBe(true);
          }
        },
      ),
      { seed: PROPERTY_SEED, numRuns: PROPERTY_RUNS },
    );
  });
});
