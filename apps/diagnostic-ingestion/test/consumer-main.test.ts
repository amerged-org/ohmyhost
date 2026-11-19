import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ consume: vi.fn() }));

vi.mock("../src/runtime.js", () => ({
  createConsumer: vi.fn(() => state.consume),
}));

import worker from "../src/consumer-main.js";

const common = {
  RUNTIME_CONFIGURATION_STATE: "configured",
  DIAGNOSTIC_PRODUCER_ID: "producer-a",
  DIAGNOSTIC_QUEUE_SIGNING_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
} as const;
type Purge = (input: { cutoff: string; limit: number }) => Promise<number>;
const privateRuntime = (purge = vi.fn<Purge>(async () => 0)) => ({
  recordDiagnostic: vi.fn(),
  purgeDiagnostics: purge,
});

describe("diagnostic consumer entrypoint", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => state.consume.mockReset());

  it("consumes one private Queue batch through the private runtime", async () => {
    const batch = { messages: [] };
    const env = { ...common, DIAGNOSTIC_CONSUMER_RUNTIME: privateRuntime() };
    await worker.queue(batch, env);
    expect(state.consume).toHaveBeenCalledWith(batch);
    state.consume.mockRejectedValueOnce(new Error("consumer fixture failed"));
    await expect(worker.queue(batch, env)).rejects.toThrow("fixture failed");
  });

  it("physically purges bounded retention batches", async () => {
    const origin = Date.now();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(origin);
    const purge = vi.fn<Purge>(async () => 0);
    purge.mockResolvedValueOnce(1000).mockResolvedValueOnce(12);
    const env = { ...common, DIAGNOSTIC_CONSUMER_RUNTIME: privateRuntime(purge) };
    await expect(worker.scheduled({}, env)).resolves.toEqual({ removed: 1012 });
    expect(purge).toHaveBeenCalledTimes(2);
    expect(purge.mock.calls[0]?.[0]).toEqual({
      cutoff: new Date(origin - 7 * 86400000).toISOString(),
      limit: 1000,
    });
    const full = privateRuntime(vi.fn<Purge>(async () => 1000));
    await expect(
      worker.scheduled({}, { ...common, DIAGNOSTIC_CONSUMER_RUNTIME: full }),
    ).resolves.toEqual({ removed: 10000 });
    expect(full.purgeDiagnostics).toHaveBeenCalledTimes(10);
    full.purgeDiagnostics.mockRejectedValueOnce(new Error("unknown purge"));
    await expect(
      worker.scheduled({}, { ...common, DIAGNOSTIC_CONSUMER_RUNTIME: full }),
    ).rejects.toThrow("unknown purge");
  });

  it("fails closed when disabled, bound directly to Core or missing the private runtime", async () => {
    const runtime = privateRuntime();
    const disabled = {
      ...common,
      RUNTIME_CONFIGURATION_STATE: "disabled",
      DIAGNOSTIC_CONSUMER_RUNTIME: runtime,
    };
    await expect(worker.queue({ messages: [] }, disabled)).rejects.toThrow("disabled");
    await expect(worker.scheduled({}, disabled)).rejects.toThrow("disabled");
    for (const enumerable of [true, false])
      for (const raw of [
        "CONTROL_CORE",
        "CONTROL_GLOBAL",
        "CONTROL_DIRECTORY",
        "CONTROL_SHARD_0000",
        "CONTROL_SHARD_unexpected",
        "CONTROL_SHARD_",
      ]) {
        const configured = {
          RUNTIME_CONFIGURATION_STATE: "configured",
          DIAGNOSTIC_CONSUMER_RUNTIME: runtime,
        };
        Object.defineProperty(configured, raw, {
          enumerable,
          get() {
            throw new Error("Raw binding getter must not run");
          },
        });
        await expect(worker.scheduled({}, configured)).rejects.toThrow("mixed Control authority");
      }
    for (const configured of [
      { RUNTIME_CONFIGURATION_STATE: "configured" },
      { RUNTIME_CONFIGURATION_STATE: "configured", DIAGNOSTIC_CONSUMER_RUNTIME: {} },
    ])
      await expect(worker.scheduled({}, configured)).rejects.toThrow("private runtime missing");
    expect(runtime.purgeDiagnostics).not.toHaveBeenCalled();
  });
});
