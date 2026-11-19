import { expect, it, vi } from "vitest";
import { connectWithWakeRetry, type WakeRetryClock } from "../src/capture.js";

function refusal(code: string): Error {
  return Object.assign(new Error(`connect refused ${code}`), { code });
}

function fakeConnection(outcomes: readonly (Error | "ok")[]) {
  let connectionCalls = 0;
  return {
    connect: vi.fn(async () => {
      const outcome = outcomes[connectionCalls++];
      if (outcome === undefined || outcome === "ok") return;
      throw outcome;
    }),
    end: vi.fn(async () => undefined),
  };
}

function virtualClock(): WakeRetryClock & { readonly sleeps: number[] } {
  let time = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
  };
}

it("retries wake refusals on fresh connections within the 90 second budget and stops when aborted", async () => {
  // Two wake refusals, then success: fresh connections, each failed one discarded, 1 s and 2 s waits.
  const clock = virtualClock();
  const attempts = [
    fakeConnection([refusal("57P03")]),
    fakeConnection([refusal("57P03")]),
    fakeConnection(["ok"]),
  ];
  const opened: (typeof attempts)[number][] = [];
  const discard = vi.fn(async (failed: (typeof attempts)[number]) => {
    await failed.end();
  });
  const connected = await connectWithWakeRetry(
    () => {
      const next = attempts[opened.length];
      if (next === undefined) throw new Error("unexpected extra attempt");
      opened.push(next);
      return next;
    },
    discard,
    { signal: new AbortController().signal, clock },
  );
  expect(connected).toBe(attempts[2]);
  expect(opened).toHaveLength(3);
  expect(new Set(opened).size).toBe(3);
  expect(clock.sleeps).toEqual([1000, 2000]);
  expect(discard.mock.calls.map(([failed]) => failed)).toEqual([attempts[0], attempts[1]]);
  expect(attempts[0]?.end).toHaveBeenCalledTimes(1);
  expect(attempts[1]?.end).toHaveBeenCalledTimes(1);
  expect(attempts[2]?.end).not.toHaveBeenCalled();

  // Delays 1, 2, 4 and 8 s, then 8 s steps: 15 s after four sleeps, 87 s after thirteen. The next
  // 8 s step would reach 95 s, past the 90 s budget. That is 13 sleeps and 14 attempts.
  const budgetClock = virtualClock();
  const budgetOpened: ReturnType<typeof fakeConnection>[] = [];
  const last = refusal("53300");
  await expect(
    connectWithWakeRetry(
      () => {
        const connection = fakeConnection([last]);
        budgetOpened.push(connection);
        return connection;
      },
      async () => undefined,
      { signal: new AbortController().signal, clock: budgetClock },
    ),
  ).rejects.toBe(last);
  expect(budgetClock.sleeps).toEqual([1000, 2000, 4000, ...Array.from({ length: 10 }, () => 8000)]);
  expect(budgetClock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(87_000);
  expect(budgetOpened).toHaveLength(14);

  // The system clock really sleeps: an abort during a backoff rejects at once with an AbortError
  // whose cause is the capture's reason, instead of sleeping on and throwing the reason afterwards.
  const controller = new AbortController();
  const reason = new Error("capture cancelled");
  const failing = fakeConnection([refusal("08006")]);
  const pending = connectWithWakeRetry(
    () => failing,
    async () => undefined,
    {
      signal: controller.signal,
    },
  );
  setTimeout(() => controller.abort(reason), 10);
  const error: unknown = await pending.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({ name: "AbortError", cause: reason });
});

it("keeps retrying a granted wake budget past the 90 second default, polling at most every 8 seconds", async () => {
  // A database the platform suspended needs its resume first: 30 refusals in a row must be waited out.
  const granted = virtualClock();
  const attempts = Array.from({ length: 30 }, () => fakeConnection([refusal("57P03")]));
  const opened: (typeof attempts)[number][] = [];
  const connected = await connectWithWakeRetry(
    () => {
      const next = attempts[opened.length];
      if (next === undefined) {
        const ready = fakeConnection(["ok"]);
        opened.push(ready);
        return ready;
      }
      opened.push(next);
      return next;
    },
    async () => undefined,
    { signal: new AbortController().signal, clock: granted, budgetMilliseconds: 600_000 },
  );
  expect(connected).toBe(opened.at(-1));
  expect(opened).toHaveLength(31);
  expect(granted.now()).toBeGreaterThan(90_000);
  expect(Math.max(...granted.sleeps)).toBe(8000);

  // With the granted 10 minute budget the last delay that fits is 8 s after 599 s: 78 attempts, 77 sleeps.
  const exhausted = virtualClock();
  const exhaustedOpened: ReturnType<typeof fakeConnection>[] = [];
  const last = refusal("57P03");
  await expect(
    connectWithWakeRetry(
      () => {
        const connection = fakeConnection([last]);
        exhaustedOpened.push(connection);
        return connection;
      },
      async () => undefined,
      { signal: new AbortController().signal, clock: exhausted, budgetMilliseconds: 600_000 },
    ),
  ).rejects.toBe(last);
  expect(exhausted.sleeps).toHaveLength(77);
  expect(exhausted.sleeps.reduce((total, ms) => total + ms, 0)).toBe(599_000);
  expect(exhaustedOpened).toHaveLength(78);
});
