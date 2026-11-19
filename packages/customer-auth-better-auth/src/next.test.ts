import { describe, expect, it, vi } from "vitest";

import { createNextCustomerAuthHandler } from "./next.js";

describe("Next.js Better Auth route template", () => {
  it("exports the exact official Next.js method handlers", () => {
    const result = createNextCustomerAuthHandler({ handler: vi.fn() } as never);
    expect(Object.keys(result).sort()).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
    expect(Object.isFrozen(result)).toBe(true);
  });
});
