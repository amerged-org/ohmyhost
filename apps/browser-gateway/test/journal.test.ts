import { expect, it, vi } from "vitest";
import type { DurableObjectStorage, DurableObjectTransaction } from "cloudflare:workers";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));
import { BrowserSettlementJournal } from "../src/journal.js";

it("persists only the exact measurement, rearms on a Core outage and clears it after a later idempotent settlement", async () => {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const tx: DurableObjectStorage = {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async setAlarm(value: number) {
      alarm = value;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async deleteAll() {
      data.clear();
      alarm = null;
    },
    async transaction<T>(work: (transaction: DurableObjectTransaction) => Promise<T>) {
      return work(tx);
    },
  };
  const settle = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary Core outage"))
    .mockResolvedValueOnce({ settled: true, chargedMicros: 6968 });
  const abort = vi.fn();
  const state = { id: { name: "01ARZ3NDEKTSV4RRFFQ69G5FAY" }, storage: tx, abort },
    env = { BROWSER_RUNTIME: { settle } };
  const journal = new BrowserSettlementJournal(state as never, env as never);
  const input = {
    scope: {
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    },
    reservationId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    browserMs: "1393.57373046875",
  };
  await journal.record(input);
  expect(data.get("measurement")).toEqual(input);
  expect(alarm).toEqual(expect.any(Number));
  await journal.alarm();
  expect(data.get("measurement")).toEqual(input);
  expect(alarm).toBeGreaterThan(Date.now() + 20_000);
  // Re-instantiation models hibernation/restart with the same durable storage.
  const resumed = new BrowserSettlementJournal(state as never, env as never);
  await resumed.alarm();
  expect(data.size).toBe(0);
  expect(settle).toHaveBeenCalledTimes(2);
  await expect(resumed.record({ ...input, html: "not allowed" })).rejects.toThrow();
  await resumed.record(input);
  settle.mockImplementationOnce(() => new Promise(() => undefined));
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    const pending = resumed.alarm();
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(data.get("measurement")).toEqual(input);
    expect(alarm).toBeGreaterThan(Date.now() + 19_000);
    expect(abort).toHaveBeenCalledWith("browser settlement timeout", { retryAlarm: false });
  } finally {
    vi.useRealTimers();
  }
});
