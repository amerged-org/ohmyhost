import {
  R2UsageCapacityError,
  R2UsageRateLimitError,
  type R2UsageBatchInput,
  type R2UsageBucketResult,
  type R2UsageRecord,
} from "@ohmyhost/provider-cloudflare";
import { describe, expect, it, vi } from "vitest";

import { collectR2DailyUsage, type R2BucketScope } from "../src/usage.js";

const DAY = "2026-09-08T00:00:00.000Z";
const NEXT = "2026-09-09T00:00:00.000Z";
/** The first instant the day is final: one hour after it ended. */
const NOW = new Date("2026-09-09T01:00:00.000Z");

const part = (n: number) => `0${String(n).padStart(25, "0")}`;
const bucket = (n: number, jurisdiction: "eu" | "us" = "eu"): R2BucketScope => ({
  bucketName: `ohmyho-${part(n)}-${part(n + 1)}`,
  jurisdiction,
});
const keyOf = (scope: R2BucketScope) => `${scope.jurisdiction}/${scope.bucketName}`;
const hour = (h: number) => new Date(Date.parse(DAY) + h * 3_600_000).toISOString();
const operation = (
  meter: "r2.class_a" | "r2.class_b",
  h: number,
  quantity: string,
  exact = true,
): R2UsageRecord => ({ meter, unit: "request", from: hour(h), to: hour(h + 1), quantity, exact });
const observed: R2UsageRecord = {
  meter: "r2.storage.observed",
  unit: "byte_peak_day",
  from: DAY,
  to: NEXT,
  quantity: "999999999999",
  exact: false,
};
const peak = (quantity: unknown, overrides: Record<string, unknown> = {}) => ({
  meter: "r2.storage.standard",
  unit: "byte_peak_day",
  from: DAY,
  to: NEXT,
  quantity,
  exact: true,
  ...overrides,
});

/** The Cloudflare analytics boundary: records per bucket, every request kept. */
function providerOf(
  rows: Record<string, R2UsageRecord[]> = {},
  answer?: (input: R2UsageBatchInput) => R2UsageBucketResult[] | Promise<R2UsageBucketResult[]>,
) {
  const calls: R2UsageBatchInput[] = [];
  return {
    calls,
    readUsageBatch: async (input: R2UsageBatchInput) => {
      calls.push(input);
      return (
        answer?.(input) ??
        input.buckets.map((scope) => ({ ...scope, records: rows[keyOf(scope)] ?? [] }))
      );
    },
  };
}
/** The Core RPC boundary: confirmed peak payload bytes per bucket name. */
function coreOf(peaks: Record<string, string> = {}) {
  return {
    confirmedStorage: vi.fn(async (input: R2BucketScope) => {
      const quantity = peaks[input.bucketName];
      return quantity === undefined ? [] : [peak(quantity)];
    }),
  };
}
const collect = (
  input: Partial<Parameters<typeof collectR2DailyUsage>[0]> & {
    provider?: ReturnType<typeof providerOf>;
    core?: ReturnType<typeof coreOf>;
  },
) =>
  collectR2DailyUsage({
    provider: providerOf(),
    core: coreOf(),
    request: { day: DAY, buckets: [bucket(1)] },
    now: NOW,
    ...input,
  });

describe("R2 daily usage", () => {
  it("sums exact class A/B hours, charges sampled hours by their sample and ignores the storage gauge", async () => {
    const [a, b] = [bucket(1), bucket(10, "us")] as [R2BucketScope, R2BucketScope];
    const provider = providerOf({
      [keyOf(a)]: [
        observed,
        operation("r2.class_a", 0, "9007199254740991"),
        operation("r2.class_a", 1, "9007199254740991"),
        operation("r2.class_a", 2, "5", false),
        operation("r2.class_b", 0, "3"),
        operation("r2.class_b", 3, "100", false),
        operation("r2.class_b", 4, "100", false),
      ],
    });
    const core = coreOf({ [a.bucketName]: "123456789012" });
    const usage = await collect({ provider, core, request: { day: DAY, buckets: [a, b] } });
    expect(usage).toEqual({
      day: DAY,
      buckets: [
        {
          ...a,
          storagePeakBytes: "123456789012",
          classA: "18014398509481987",
          classB: "203",
          inexactHours: 3,
        },
        { ...b, storagePeakBytes: "0", classA: "0", classB: "0", inexactHours: 0 },
      ],
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({ buckets: [a, b], from: DAY, to: NEXT });
    expect(provider.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    const deadlines = core.confirmedStorage.mock.calls.map(([call]) => {
      const { deadline, ...rest } = call as R2BucketScope & { deadline: string };
      expect(rest).toEqual({ ...rest, from: DAY, to: NEXT });
      return Date.parse(deadline);
    });
    expect(
      core.confirmedStorage.mock.calls.map(([call]) => (call as R2BucketScope).bucketName),
    ).toEqual([a.bucketName, b.bucketName]);
    for (const deadline of deadlines) {
      expect(deadline).toBeGreaterThan(Date.now());
      expect(deadline).toBeLessThanOrEqual(Date.now() + 45_000);
    }
  });

  it("sums the Core's records of the day and reports zero when it has none", async () => {
    const core = {
      confirmedStorage: vi.fn(async () => [peak("2"), peak("3")]),
    };
    expect((await collect({ core })).buckets[0]?.storagePeakBytes).toBe("5");
    expect(
      (await collect({ core: { confirmedStorage: async () => [] } as never })).buckets[0]
        ?.storagePeakBytes,
    ).toBe("0");
  });

  it("asks the provider for at most 25 buckets at a time and keeps request order", async () => {
    const buckets = Array.from({ length: 100 }, (_, n) => bucket(n * 2, n % 2 ? "us" : "eu"));
    const rows = Object.fromEntries(
      buckets.map((scope, n) => [keyOf(scope), [operation("r2.class_a", n % 24, String(n + 1))]]),
    );
    const provider = providerOf(rows);
    const usage = await collect({ provider, request: { day: DAY, buckets } });
    expect(provider.calls.map((call) => call.buckets.length)).toEqual([25, 25, 25, 25]);
    expect(usage.buckets.map((entry) => entry.bucketName)).toEqual(
      buckets.map((scope) => scope.bucketName),
    );
    expect(usage.buckets.map((entry) => entry.classA)).toEqual(
      buckets.map((_, n) => String(n + 1)),
    );
  });

  it("splits a batch the provider cannot answer until it fits", async () => {
    const buckets = Array.from({ length: 25 }, (_, n) => bucket(n * 2));
    const provider = providerOf({}, (input) => {
      if (input.buckets.length > 7) throw new R2UsageCapacityError("row_limit");
      return input.buckets.map((scope) => ({
        ...scope,
        records: [operation("r2.class_b", 5, "2")],
      }));
    });
    const usage = await collect({ provider, request: { day: DAY, buckets } });
    expect(provider.calls.map((call) => call.buckets.length)).toEqual([25, 13, 7, 6, 12, 6, 6]);
    expect(usage.buckets).toHaveLength(25);
    expect(usage.buckets.map((entry) => entry.bucketName)).toEqual(
      buckets.map((scope) => scope.bucketName),
    );
    expect(usage.buckets.every((entry) => entry.classB === "2")).toBe(true);
  });

  it("fails the whole call on a provider error, a rate limit or an unsplittable batch", async () => {
    for (const error of [
      new R2UsageRateLimitError(429, 60),
      new R2UsageCapacityError("body_limit"),
      new Error("R2 usage request failed"),
    ]) {
      const provider = providerOf({}, () => {
        throw error;
      });
      const core = coreOf();
      await expect(collect({ provider, core })).rejects.toBe(error);
      expect(provider.calls).toHaveLength(1);
      expect(core.confirmedStorage).not.toHaveBeenCalled();
    }
  });

  it("fails the whole call when the Core read fails or answers anything but this day's standard storage", async () => {
    const failure = new Error("core down");
    await expect(
      collect({ core: { confirmedStorage: vi.fn(() => Promise.reject(failure)) } as never }),
    ).rejects.toBe(failure);
    for (const reply of [
      "peak",
      {},
      [null],
      [peak("1", { meter: "r2.storage.observed" })],
      [peak("1", { unit: "request" })],
      [peak("1", { from: NEXT })],
      [peak("1", { to: DAY })],
      [peak("01")],
      [peak(1)],
      [peak("-1")],
      [peak("1"), peak("1.5")],
    ])
      await expect(
        collect({ core: { confirmedStorage: async () => reply } as never }),
      ).rejects.toThrow("Invalid confirmed storage response");
  });

  it("rejects a provider answer with a foreign, duplicate, missing, surplus or reordered scope", async () => {
    const [a, b] = [bucket(1), bucket(10)] as [R2BucketScope, R2BucketScope];
    const result = (scope: R2BucketScope): R2UsageBucketResult => ({ ...scope, records: [] });
    for (const answer of [
      [result(a), result(bucket(20))],
      [result(a), result(a)],
      [result(a)],
      [result(a), result(b), result(bucket(20))],
      [result(a), result({ ...b, jurisdiction: "us" })],
      [result(b), result(a)],
    ]) {
      const core = coreOf();
      await expect(
        collect({
          provider: providerOf({}, () => answer),
          core,
          request: { day: DAY, buckets: [a, b] },
        }),
      ).rejects.toThrow("R2 provider returned foreign or duplicate scope");
      expect(core.confirmedStorage).not.toHaveBeenCalled();
    }
  });
});

describe("R2 daily usage input", () => {
  const valid = () => ({ day: DAY, buckets: [bucket(1)] });
  it.each([
    ["no object", null],
    ["an array", []],
    ["a missing key", { day: DAY }],
    ["an extra key", { ...valid(), extra: true }],
    ["a day that is not text", { ...valid(), day: Date.parse(DAY) }],
    ["a day without UTC midnight", { ...valid(), day: "2026-09-08T01:00:00.000Z" }],
    ["a day that is not canonical", { ...valid(), day: "2026-09-08T00:00:00Z" }],
    ["a day that is no date", { ...valid(), day: "yesterday" }],
    ["buckets that are no list", { ...valid(), buckets: bucket(1) }],
    ["no bucket", { ...valid(), buckets: [] }],
    [
      "more than 100 buckets",
      { ...valid(), buckets: Array.from({ length: 101 }, (_, n) => bucket(n * 2)) },
    ],
    ["a duplicate bucket", { ...valid(), buckets: [bucket(1), bucket(1)] }],
    ["a bucket that is no object", { ...valid(), buckets: [null] }],
    ["a bucket with an extra key", { ...valid(), buckets: [{ ...bucket(1), id: "x" }] }],
    [
      "a bucket without jurisdiction",
      { ...valid(), buckets: [{ bucketName: bucket(1).bucketName }] },
    ],
    [
      "a bucket name that is not ours",
      { ...valid(), buckets: [{ ...bucket(1), bucketName: "other" }] },
    ],
    ["a bucket name that is no text", { ...valid(), buckets: [{ ...bucket(1), bucketName: 1 }] }],
    ["an unknown jurisdiction", { ...valid(), buckets: [{ ...bucket(1), jurisdiction: "asia" }] }],
  ])("rejects %s before any read", async (_name, request) => {
    const provider = providerOf(),
      core = coreOf();
    await expect(collect({ provider, core, request })).rejects.toBeInstanceOf(TypeError);
    expect(provider.calls).toHaveLength(0);
    expect(core.confirmedStorage).not.toHaveBeenCalled();
  });

  it("serves a day only one hour after it ended", async () => {
    const early = new Date(NOW.getTime() - 1);
    await expect(collect({ now: early })).rejects.toThrow("R2 usage day is not finished");
    await expect(collect({ now: NOW })).resolves.toMatchObject({ day: DAY });
  });

  it("treats the same bucket name in two jurisdictions as two buckets", async () => {
    const request = { day: DAY, buckets: [bucket(1), bucket(1, "us")] };
    await expect(collect({ request })).resolves.toMatchObject({
      buckets: [{ jurisdiction: "eu" }, { jurisdiction: "us" }],
    });
  });

  it.each([0, 1.5, 45_001])("rejects the time budget %s", async (budgetMs) => {
    await expect(collect({ budgetMs })).rejects.toThrow("Invalid R2 usage budget");
  });
});

describe("R2 daily usage deadline", () => {
  it("gives up on a provider that does not answer within the budget", async () => {
    const provider = providerOf({}, () => new Promise<never>(() => undefined));
    await expect(collect({ provider, budgetMs: 20 })).rejects.toThrow(
      "R2 usage collection deadline reached",
    );
    expect(provider.calls[0]?.signal?.aborted).toBe(true);
  });

  it("gives up on a Core that does not answer within the budget", async () => {
    const core = { confirmedStorage: () => new Promise<never>(() => undefined) };
    await expect(collect({ core: core as never, budgetMs: 20 })).rejects.toThrow(
      "R2 usage collection deadline reached",
    );
  });

  it("stops at the caller's abort, before or during a read", async () => {
    const provider = providerOf();
    await expect(collect({ provider, signal: AbortSignal.abort() })).rejects.toThrow(
      "R2 usage collection deadline reached",
    );
    expect(provider.calls).toHaveLength(0);
    const controller = new AbortController();
    const pending = providerOf({}, () => {
      queueMicrotask(() => controller.abort());
      return new Promise<never>(() => undefined);
    });
    await expect(collect({ provider: pending, signal: controller.signal })).rejects.toThrow(
      "R2 usage collection deadline reached",
    );
  });
});
