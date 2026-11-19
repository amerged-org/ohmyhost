import { describe, expect, it } from "vitest";

import { R2ManagementReadinessError, requireR2ManagementBindings } from "../src/bindings.js";

const bindings = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured",
  R2_MANAGEMENT_RUNTIME: {},
  CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000001",
  CLOUDFLARE_R2_API_TOKEN: "token-" + "x".repeat(32),
  CLOUDFLARE_R2_ANALYTICS_TOKEN: "analytics-" + "a".repeat(32),
});

describe("R2 management bindings", () => {
  it("accepts only the exact private management inventory", () => {
    expect(requireR2ManagementBindings(bindings())).toEqual(bindings());
    expect(() =>
      requireR2ManagementBindings({ ...bindings(), CLOUDFLARE_R2_ANALYTICS_TOKEN: "short" }),
    ).toThrow("CLOUDFLARE_R2_ANALYTICS_TOKEN");
  });

  it.each([
    { ...bindings(), RUNTIME_CONFIGURATION_STATE: "disabled" },
    { ...bindings(), CLOUDFLARE_ACCOUNT_ID: "bad" },
    { ...bindings(), CLOUDFLARE_R2_API_TOKEN: "short" },
    { ...bindings(), SOURCE_FETCHER: {} },
    { ...bindings(), CONTROL_DIRECTORY: {} },
    { ...bindings(), CONTROL_SHARD_0000: {} },
    Object.fromEntries(
      Object.entries(bindings()).filter(([name]) => name !== "R2_MANAGEMENT_RUNTIME"),
    ),
  ])("rejects missing, disabled, or widened authority %#", (value) => {
    expect(() => requireR2ManagementBindings(value)).toThrow(TypeError);
  });

  it("reports the exact missing capability without exposing credential values", () => {
    const secret = `must-not-leak-${"x".repeat(32)}`;
    try {
      requireR2ManagementBindings({ ...bindings(), CLOUDFLARE_R2_API_TOKEN: secret.slice(0, 8) });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(R2ManagementReadinessError);
      expect(error).toMatchObject({
        code: "r2_management_provider_not_ready",
        binding: "CLOUDFLARE_R2_API_TOKEN",
      });
      expect(String(error)).not.toContain(secret);
    }
  });
});
