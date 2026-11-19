import { describe, expect, it, vi } from "vitest";

import { requireSchedulerBindings } from "../src/bindings.js";

const runtime = Object.fromEntries(
  ["readSchedules", "insertDueRuns", "claimRuns", "finishRun", "purgeFinishedRuns"].map((name) => [
    name,
    vi.fn(),
  ]),
);
const configured = {
  RUNTIME_CONFIGURATION_STATE: "configured",
  CONTROL_FUNCTIONS_RUNTIME: runtime,
  CUSTOMER_DISPATCH: { get: vi.fn() },
} as const;

describe("functions scheduler bindings", () => {
  it("admits only the configured Core capability and Dynamic Dispatch pair", () => {
    expect(requireSchedulerBindings(configured)).toEqual(configured);
    expect(() =>
      requireSchedulerBindings({ ...configured, CONTROL_FUNCTIONS_RUNTIME: {} }),
    ).toThrow("capability");
    expect(() =>
      requireSchedulerBindings({ ...configured, CONTROL_FUNCTIONS_RUNTIME: null }),
    ).toThrow("capability");
    for (const name of [
      "CONTROL_CORE",
      "CONTROL_GLOBAL",
      "CONTROL_DIRECTORY",
      "CONTROL_SHARD_0000",
      "CONTROL_SHARD_custom",
    ]) {
      expect(() => requireSchedulerBindings({ ...configured, [name]: {} })).toThrow("ambiguous");
      const hidden = { ...configured };
      Object.defineProperty(hidden, name, { enumerable: false, value: {} });
      expect(() => requireSchedulerBindings(hidden)).toThrow("ambiguous");
    }
  });

  it("fails closed when the runtime is disabled or a capability is missing", () => {
    expect(() =>
      requireSchedulerBindings({ ...configured, RUNTIME_CONFIGURATION_STATE: "disabled" }),
    ).toThrow("not configured");
    expect(() => requireSchedulerBindings(null)).toThrow("not configured");
    expect(() =>
      requireSchedulerBindings({ ...configured, CONTROL_FUNCTIONS_RUNTIME: undefined }),
    ).toThrow("capability");
    expect(() => requireSchedulerBindings({ ...configured, CUSTOMER_DISPATCH: {} })).toThrow(
      "Dynamic Dispatch",
    );
  });
});
