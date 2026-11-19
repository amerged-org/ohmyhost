import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ betterAuth: vi.fn(() => ({ handler: vi.fn() })) }));

vi.mock("better-auth", () => ({ betterAuth: state.betterAuth }));

import { createCustomerAuth } from "./runtime.js";

describe("Better Auth construction boundary", () => {
  it("passes only validated options to the official package", () => {
    const auth = createCustomerAuth({
      appName: "Portable App",
      publicOrigin: "https://app.example.test",
      database: { query: vi.fn() } as unknown as Pool,
      secret: "fixture-secret-value-fixture-secret-value",
      email: { send: vi.fn(async () => undefined) },
    });
    expect(auth).toMatchObject({ handler: expect.any(Function) });
    expect(state.betterAuth).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://app.example.test", basePath: "/api/auth" }),
    );
  });
});
