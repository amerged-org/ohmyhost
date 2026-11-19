import { describe, expect, it } from "vitest";

import { DeterministicEntropy, SystemEntropy } from "./entropy.js";

describe("entropy sources", () => {
  it("replays the same deterministic byte stream for the same seed", () => {
    const first = new Uint8Array(12);
    const second = new Uint8Array(12);

    new DeterministicEntropy(42).fill(first);
    new DeterministicEntropy(42).fill(second);

    expect(second).toEqual(first);
    expect(first.some((value) => value !== 0)).toBe(true);
  });

  it("fills a supplied buffer with system entropy", () => {
    const bytes = new Uint8Array(32);

    new SystemEntropy().fill(bytes);

    expect(bytes.some((value) => value !== 0)).toBe(true);
  });
});
