import { readFile } from "node:fs/promises";

import type { PoolClient } from "pg";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";

import {
  DatabaseLanePool,
  WAKE_REFUSAL_BUDGET_MS,
  WAKE_REFUSAL_STATES,
  WAKE_RETRY_CAP_MS,
  wakeRetryDelayMs,
} from "../src/connection-pool.js";

const target = {
  provider: "pgcf" as const,
  host: "sql.pgcf.example",
  databaseId: "d1234567890123456789",
  role: "omh_pgcf_fixture",
};
const connectionString = `postgres://${target.role}:fixture-password@${target.host}/${target.databaseId}`;

function sqlstateError(code: string): Error {
  return Object.assign(new Error("the database is not accepting connections"), { code });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("retries a connection refused with 53300 once after one second and then connects", async () => {
  vi.useFakeTimers();
  const client = { release: vi.fn() } as unknown as PoolClient;
  const connect = vi
    .spyOn(Pool.prototype, "connect")
    .mockRejectedValueOnce(sqlstateError("53300"))
    .mockImplementationOnce(() => Promise.resolve(client));
  const pool = new DatabaseLanePool(connectionString, 1, target);

  const acquired = pool.connect();
  await vi.advanceTimersByTimeAsync(999);
  expect(connect).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);

  expect(await acquired).toBe(client);
  expect(connect).toHaveBeenCalledTimes(2);
});

it("never retries a rejected password (28P01) and fails at once", async () => {
  const connect = vi.spyOn(Pool.prototype, "connect").mockRejectedValue(sqlstateError("28P01"));
  const pool = new DatabaseLanePool(connectionString, 1, target);

  await expect(pool.connect()).rejects.toMatchObject({ code: "28P01" });
  expect(connect).toHaveBeenCalledTimes(1);
});

it("waits 1, 2, 4 and then 8 seconds between wake retries and stops within the 90 second budget", async () => {
  vi.useFakeTimers();
  const started = Date.now();
  const attempts: number[] = [];
  vi.spyOn(Pool.prototype, "connect").mockImplementation(() => {
    attempts.push(Date.now() - started);
    return Promise.reject(sqlstateError("57P03"));
  });
  const pool = new DatabaseLanePool(connectionString, 1, target);

  const settled = pool.connect().then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();

  expect(await settled).toMatchObject({ code: "57P03" });
  expect([0, 1, 2, 3, 4, 5].map(wakeRetryDelayMs)).toEqual([
    1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
  ]);
  expect(WAKE_RETRY_CAP_MS).toBe(8_000);
  expect(WAKE_REFUSAL_BUDGET_MS).toBe(90_000);
  expect(WAKE_REFUSAL_STATES).toEqual(new Set(["57P03", "08006", "53300"]));
  expect(attempts.slice(0, 6)).toEqual([0, 1_000, 3_000, 7_000, 15_000, 23_000]);
  // The last attempt is the final one whose retry delay still fits the budget: 87 s.
  expect(attempts.at(-1)).toBe(87_000);
  expect(attempts).toHaveLength(14);
});

it("documents every wake-refusal state and the 90 second budget of the lane pool in the database chapter", async () => {
  const chapter = await readFile(
    new URL("../../../docs/architecture/database.md", import.meta.url),
    "utf8",
  );
  const lanes = chapter
    .split("\n")
    .find((line) => line.includes("a connection that the gateway refuses"));
  expect(lanes).toBeDefined();
  for (const state of WAKE_REFUSAL_STATES) expect(lanes).toContain(`\`${state}\``);
  expect(lanes).toContain("WebSocket send() after close");
  expect(lanes).toContain(`${WAKE_REFUSAL_BUDGET_MS / 1_000} seconds`);
  expect(lanes).not.toContain("twenty seconds");
});
