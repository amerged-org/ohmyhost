import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { StreamingSha256 } from "./sha256.js";

describe("streaming SHA-256", () => {
  it("matches the standard implementation across partial and full blocks", () => {
    const bytes = new Uint8Array(10_000);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const hasher = new StreamingSha256();
    hasher.update(bytes.slice(0, 7));
    hasher.update(bytes.slice(7, 4_123));
    hasher.update(bytes.slice(4_123));
    expect(hasher.digestHex()).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(() => hasher.digestHex()).toThrow("already finalized");
    expect(() => hasher.update(new Uint8Array())).toThrow("already finalized");
  });
});
