import { describe, expect, it } from "vitest";

import { FixedClock, SystemClock } from "./clock.js";

describe("clocks", () => {
  it("returns defensive date copies from an injected fixed clock", () => {
    const clock = new FixedClock("2026-01-02T03:04:05.000Z");

    const first = clock.now();
    first.setUTCFullYear(2000);

    expect(clock.now().toISOString()).toBe("2026-01-02T03:04:05.000Z");
  });

  it("reads the current system time", () => {
    const before = Date.now();
    const actual = new SystemClock().now().getTime();
    const after = Date.now();

    expect(actual).toBeGreaterThanOrEqual(before);
    expect(actual).toBeLessThanOrEqual(after);
  });
});
