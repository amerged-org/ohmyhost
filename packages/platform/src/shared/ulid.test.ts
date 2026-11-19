import { describe, expect, it } from "vitest";

import { FixedClock } from "./clock.js";
import { DeterministicEntropy } from "./entropy.js";
import { createUlidFactory, parseUlid } from "./ulid.js";

describe("ULID factory", () => {
  it("is deterministic for injected time and entropy", () => {
    const first = createUlidFactory({
      clock: new FixedClock("2026-01-02T03:04:05.006Z"),
      entropy: new DeterministicEntropy(7),
    });
    const second = createUlidFactory({
      clock: new FixedClock("2026-01-02T03:04:05.006Z"),
      entropy: new DeterministicEntropy(7),
    });

    expect(first.next()).toBe(second.next());
  });

  it("creates unique, lexicographically increasing IDs within one millisecond", () => {
    const factory = createUlidFactory({
      clock: new FixedClock("2026-01-02T03:04:05.006Z"),
      entropy: new DeterministicEntropy(1),
    });

    const first = factory.next();
    const second = factory.next();

    expect(first).toHaveLength(26);
    expect(second > first).toBe(true);
    expect(new Set([first, second])).toHaveLength(2);
  });

  it("rejects malformed and overflowing ULIDs", () => {
    expect(() => parseUlid("not-a-ulid")).toThrow(/ULID/);
    expect(() => parseUlid("8ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toThrow(/ULID/);
  });
});
