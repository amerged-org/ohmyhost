import { organizationLines, ratesToCards, type Charge } from "./pricing.js";
import type { Dependencies, R2BucketDailyUsage, R2BucketScope, R2DailyUsage } from "./port.js";
import { HOUR_MS, isoOf } from "./time.js";
import { allPages, chunks, count, postOrganizations, type SourceReport } from "./source.js";
import { runDays } from "./daily.js";

export const R2_STORAGE_METER = "r2.storage.standard";
export const R2_CLASS_A_METER = "r2.class_a";
export const R2_CLASS_B_METER = "r2.class_b";
/** The provider's hourly analytics of the last hour of a day settle within an hour. */
export const R2_LAG_MS = HOUR_MS;
const BUCKET_PAGE = 200;
const COLLECT_CHUNK = 100;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

/** The collector answers over RPC: same day, same buckets in the same order, canonical quantities. */
export function parseR2Daily(
  value: unknown,
  day: string,
  requested: readonly R2BucketScope[],
): R2DailyUsage {
  const fail = (): never => {
    throw new TypeError("credit_service_r2_usage_invalid");
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  const buckets = body["buckets"];
  if (body["day"] !== day || !Array.isArray(buckets) || buckets.length !== requested.length)
    return fail();
  buckets.forEach((entry: unknown, index) => {
    const asked = requested[index] as R2BucketScope;
    const usage = (entry ?? {}) as Record<string, unknown>;
    if (
      usage["bucketName"] !== asked.bucketName ||
      usage["jurisdiction"] !== asked.jurisdiction ||
      ["storagePeakBytes", "classA", "classB"].some(
        (field) => typeof usage[field] !== "string" || !DECIMAL.test(usage[field]),
      ) ||
      typeof usage["inexactHours"] !== "number" ||
      !Number.isSafeInteger(usage["inexactHours"]) ||
      usage["inexactHours"] < 0
    )
      fail();
  });
  return value as R2DailyUsage;
}

async function billDay(deps: Dependencies, report: SourceReport, day: number): Promise<void> {
  const at = isoOf(day);
  const buckets = await allPages(async (after) => {
    const page = await deps.core.listR2Buckets({ day: at, after, limit: BUCKET_PAGE });
    return { items: page.buckets, next: page.next };
  });
  const charges: Charge[] = [];
  for (const part of chunks(buckets, COLLECT_CHUNK)) {
    const scopes = part.map(({ bucketName, jurisdiction }) => ({ bucketName, jurisdiction }));
    const usage = parseR2Daily(
      await deps.r2.collectUsage({ day: at, buckets: scopes }),
      at,
      scopes,
    );
    part.forEach((bucket, index) => {
      const used = usage.buckets[index] as R2BucketDailyUsage;
      count(report, "buckets");
      count(report, "hours_inexact", used.inexactHours);
      const scope = {
        organizationId: bucket.organizationId,
        projectId: bucket.projectId,
        environmentId: bucket.environmentId,
      };
      charges.push(
        {
          ...scope,
          meter: R2_STORAGE_METER,
          unit: "byte_peak_day",
          quantity: BigInt(used.storagePeakBytes),
        },
        { ...scope, meter: R2_CLASS_A_METER, unit: "request", quantity: BigInt(used.classA) },
        { ...scope, meter: R2_CLASS_B_METER, unit: "request", quantity: BigInt(used.classB) },
      );
    });
  }
  if (charges.length === 0) return;
  const cards = ratesToCards(await deps.core.readRates({ at }), at);
  const { byOrganization, unpriced } = organizationLines(charges, cards, at);
  for (const meter of unpriced) count(report, `unpriced:${meter}`);
  await postOrganizations(deps, report, at, byOrganization);
}

/** R2 storage and operations of the finished UTC days, from the r2-management collector. */
export const runR2 = (deps: Dependencies): Promise<SourceReport> =>
  runDays(deps, "r2", R2_LAG_MS, (day, report) => billDay(deps, report, day));
