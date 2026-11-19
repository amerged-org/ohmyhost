import process from "node:process";
import { expect, it, vi } from "vitest";

const observed = vi.hoisted(() => ({ starts: 0, closes: 0, parsed: 0 }));

vi.mock("../src/container-runtime.js", () => ({
  parseContainerRecoveryConfiguration() {
    observed.parsed++;
    return {};
  },
  createContainerRecoveryRuntime() {
    return async () => ({ status: "unavailable" });
  },
}));
vi.mock("../src/container-agent.js", () => ({
  createRecoveryAgentServer() {
    return {
      listen() {
        observed.starts++;
      },
      close() {
        observed.closes++;
      },
    };
  },
}));

it("starts the private recovery agent and closes its listener on SIGTERM", async () => {
  const original = {
    namespace: process.env["RESOURCE_NAMESPACE"],
    configuration: process.env["RECOVERY_CONFIGURATION"],
    token: process.env["RECOVERY_AGENT_TOKEN"],
  };
  process.env["RESOURCE_NAMESPACE"] = "production";
  process.env["RECOVERY_CONFIGURATION"] = "{}";
  process.env["RECOVERY_AGENT_TOKEN"] = "a".repeat(43);
  let terminate: (() => void) | undefined;
  const on = vi.spyOn(process, "on").mockImplementation((event, listener) => {
    if (event === "SIGTERM") terminate = listener as () => void;
    return process;
  });
  try {
    await import("../src/container-main.js");
    expect(observed.parsed).toBe(1);
    expect(observed.starts).toBe(1);
    expect(terminate).toBeTypeOf("function");
    terminate?.();
    expect(observed.closes).toBe(1);
  } finally {
    on.mockRestore();
    for (const [name, value] of [
      ["RESOURCE_NAMESPACE", original.namespace],
      ["RECOVERY_CONFIGURATION", original.configuration],
      ["RECOVERY_AGENT_TOKEN", original.token],
    ] as const) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
});
