import type { Dependencies, UsageSource } from "./port.js";
import { DAY_MS, floorDay, isoOf, parseBoundary } from "./time.js";
import { newReport, type SourceReport } from "./source.js";

/** A pass bills at most this many finished days. */
export const MAX_DAYS = 3;

/**
 * Bills the finished UTC days after the `source` cursor, oldest first. A day is finished once `lagMs` have passed
 * since it ended. `bill` posts the day and the cursor moves to the next day only after it returned.
 */
export async function runDays(
  deps: Dependencies,
  source: UsageSource,
  lagMs: number,
  bill: (day: number, report: SourceReport) => Promise<void>,
): Promise<SourceReport> {
  const report = newReport(source);
  const cursor = await deps.core.readCursor(source);
  if (cursor === null) {
    report.status = "skipped";
    return report;
  }
  const limit = floorDay(deps.now() - lagMs);
  for (
    let day = parseBoundary(cursor, DAY_MS);
    day < limit && report.windows < MAX_DAYS;
    day += DAY_MS
  ) {
    await bill(day, report);
    await deps.core.advanceCursor({ source, through: isoOf(day + DAY_MS) });
    report.windows++;
    report.status = "advanced";
  }
  return report;
}
