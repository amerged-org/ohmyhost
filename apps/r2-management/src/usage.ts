import {
  R2UsageCapacityError,
  type R2UsageBatchInput,
  type R2UsageBucketResult,
  type R2UsageRecord,
} from "@ohmyhost/provider-cloudflare";

export interface R2BucketScope {
  readonly bucketName: string;
  readonly jurisdiction: "eu" | "us";
}

export interface R2BucketDailyUsage extends R2BucketScope {
  /** Confirmed peak payload bytes of the UTC day from the Core's managed-file tables ("0" when none). */
  readonly storagePeakBytes: string;
  /** Sum of the hourly r2.class_a records of the day (exact hours as measured, sampled hours by their sample). */
  readonly classA: string;
  /** Sum of the hourly r2.class_b records of the day (exact hours as measured, sampled hours by their sample). */
  readonly classB: string;
  /** Hourly class A/B records of the day that were sampled: charged by their sampled count, and counted here. */
  readonly inexactHours: number;
}

export interface R2DailyUsage {
  readonly day: string;
  readonly buckets: readonly R2BucketDailyUsage[];
}

interface Provider {
  readUsageBatch(input: R2UsageBatchInput): Promise<R2UsageBucketResult[]>;
}
interface ConfirmedStorageCore {
  confirmedStorage(input: {
    readonly bucketName: string;
    readonly jurisdiction: "eu" | "us";
    readonly from: string;
    readonly to: string;
    readonly deadline: string;
  }): Promise<unknown>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BATCH = 25;
const MAX_BUCKETS = 100;
const MAX_BUDGET_MS = 45_000;
/** The provider's own bucket-name check: unknown names never reach a provider query. */
const BUCKET = /^ohmyho-[0-7][0-9a-hjkmnp-tv-z]{25}-[0-7][0-9a-hjkmnp-tv-z]{25}$/u;
const NATURAL = /^(0|[1-9][0-9]*)$/u;

/**
 * Final daily R2 usage of the named buckets for one finished UTC day, as a pure read: provider
 * operation counts (exact hourly class A/B records only; r2.storage.observed is a gauge and never
 * charged) and the Core's confirmed storage peak. Nothing is persisted; any failure throws so the
 * caller retries the whole day.
 */
export async function collectR2DailyUsage(input: {
  readonly provider: Provider;
  readonly core: ConfirmedStorageCore;
  readonly request: unknown;
  readonly now: Date;
  readonly signal?: AbortSignal;
  readonly budgetMs?: number;
}): Promise<R2DailyUsage> {
  const budget = input.budgetMs ?? MAX_BUDGET_MS;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > MAX_BUDGET_MS)
    throw new TypeError("Invalid R2 usage budget");
  const { day, buckets } = parseRequest(input.request, input.now);
  const from = day,
    to = new Date(Date.parse(day) + DAY).toISOString(),
    deadline = new Date(Date.now() + budget).toISOString();
  const timeout = AbortSignal.timeout(budget);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);

  /** One provider batch; a batch the provider cannot answer is halved until it fits. */
  const read = async (requested: readonly R2BucketScope[]): Promise<R2UsageBucketResult[]> => {
    let responses: R2UsageBucketResult[];
    try {
      responses = await within(signal, () =>
        input.provider.readUsageBatch({ buckets: requested, from, to, signal }),
      );
    } catch (error) {
      if (!(error instanceof R2UsageCapacityError) || requested.length < 2) throw error;
      const middle = Math.ceil(requested.length / 2);
      return [
        ...(await read(requested.slice(0, middle))),
        ...(await read(requested.slice(middle))),
      ];
    }
    if (
      responses.length !== requested.length ||
      requested.some(
        (scope, index) =>
          responses[index]?.bucketName !== scope.bucketName ||
          responses[index]?.jurisdiction !== scope.jurisdiction,
      )
    )
      throw new Error("R2 provider returned foreign or duplicate scope");
    return responses;
  };

  const result: R2BucketDailyUsage[] = [];
  for (let offset = 0; offset < buckets.length; offset += BATCH) {
    for (const { bucketName, jurisdiction, records } of await read(
      buckets.slice(offset, offset + BATCH),
    )) {
      const stored = await within(signal, () =>
        input.core.confirmedStorage({ bucketName, jurisdiction, from, to, deadline }),
      );
      result.push({
        bucketName,
        jurisdiction,
        storagePeakBytes: confirmedPeak(stored, from, to),
        ...operationsOf(records),
      });
    }
  }
  return { day, buckets: result };
}

/**
 * A sampled hour is charged by its sampled count, never zero, because the sample is a lower bound of the requests that
 * happened; the hour is also counted so that repeated sampling can be seen. The storage gauge is never charged.
 */
function operationsOf(records: readonly R2UsageRecord[]) {
  let classA = 0n,
    classB = 0n,
    inexactHours = 0;
  for (const record of records) {
    if (record.meter === "r2.storage.observed") continue;
    if (!record.exact) inexactHours++;
    if (record.meter === "r2.class_a") classA += BigInt(record.quantity);
    else classB += BigInt(record.quantity);
  }
  return { classA: classA.toString(), classB: classB.toString(), inexactHours };
}

function strictObject(
  value: unknown,
  keys: readonly string[],
  message: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new TypeError(message);
  return value as Record<string, unknown>;
}

function parseRequest(value: unknown, now: Date): { day: string; buckets: R2BucketScope[] } {
  const request = strictObject(value, ["day", "buckets"], "R2 usage request is invalid");
  const day = request["day"],
    list = request["buckets"];
  if (typeof day !== "string") throw new TypeError("R2 usage day is invalid");
  const start = Date.parse(day);
  if (!Number.isFinite(start) || start % DAY !== 0 || new Date(start).toISOString() !== day)
    throw new TypeError("R2 usage day is invalid");
  // Provider analytics settle within the hour after a day ends; only then is the day final.
  if (start + DAY + HOUR > now.getTime()) throw new TypeError("R2 usage day is not finished");
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_BUCKETS)
    throw new TypeError("R2 usage buckets are invalid");
  const seen = new Set<string>();
  const buckets = list.map((item: unknown) => {
    const bucket = strictObject(item, ["bucketName", "jurisdiction"], "R2 usage bucket is invalid");
    const bucketName = bucket["bucketName"],
      jurisdiction = bucket["jurisdiction"];
    if (
      typeof bucketName !== "string" ||
      !BUCKET.test(bucketName) ||
      (jurisdiction !== "eu" && jurisdiction !== "us")
    )
      throw new TypeError("R2 usage bucket is invalid");
    const scope: R2BucketScope = { bucketName, jurisdiction };
    const key = `${jurisdiction}/${bucketName}`;
    if (seen.has(key)) throw new TypeError("R2 usage buckets are not distinct");
    seen.add(key);
    return scope;
  });
  return { day, buckets };
}

/** The Core answers through RPC: every record is checked before any byte count is trusted. */
function confirmedPeak(value: unknown, from: string, to: string): string {
  if (!Array.isArray(value)) throw new Error("Invalid confirmed storage response");
  let peak = 0n;
  for (const item of value as unknown[]) {
    const fields =
      typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const quantity = fields["quantity"];
    if (
      fields["meter"] !== "r2.storage.standard" ||
      fields["unit"] !== "byte_peak_day" ||
      fields["from"] !== from ||
      fields["to"] !== to ||
      typeof quantity !== "string" ||
      !NATURAL.test(quantity)
    )
      throw new Error("Invalid confirmed storage response");
    peak += BigInt(quantity);
  }
  return peak.toString();
}

/** One bounded step: an injected provider or Core need not honor the signal. */
async function within<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error("R2 usage collection deadline reached");
  let onAbort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("R2 usage collection deadline reached"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([call(), stopped]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
