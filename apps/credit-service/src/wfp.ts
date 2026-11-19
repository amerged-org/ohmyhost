import {
  InvalidUsageObject,
  listWindowObjects,
  readUsageObject,
  type ObjectUsage,
  type ScriptUsage,
} from "./logpush.js";
import { organizationLines, ratesToCards, type Charge } from "./pricing.js";
import type { Dependencies, ResolvedScript } from "./port.js";
import { HOUR_MS, floorHour, isoOf, parseBoundary } from "./time.js";
import { chunks, count, newReport, postOrganizations, type SourceReport } from "./source.js";

export const WFP_REQUESTS_METER = "wfp.requests";
export const WFP_CPU_METER = "wfp.cpu";
/** Logpush flushes every 30 seconds; five minutes after the hour every object of the hour has been delivered. */
export const WFP_LAG_MS = 5 * 60_000;
/** A pass bills at most this many windows, so catching up after an outage never exceeds the invocation budget. */
export const WFP_MAX_WINDOWS = 12;
const RESOLVE_CHUNK = 100;

/** Bills every complete hourly window after the `wfp` cursor, oldest first, and stops at the first failure. */
export async function runWfp(deps: Dependencies): Promise<SourceReport> {
  const report = newReport("wfp");
  const cursor = await deps.core.readCursor("wfp");
  if (cursor === null) {
    report.status = "skipped";
    return report;
  }
  const limit = floorHour(deps.now() - WFP_LAG_MS);
  for (
    let start = parseBoundary(cursor, HOUR_MS);
    start < limit && report.windows < WFP_MAX_WINDOWS;
    start += HOUR_MS
  ) {
    await billWindow(deps, report, start);
    report.windows++;
    report.status = "advanced";
  }
  return report;
}

async function billWindow(deps: Dependencies, report: SourceReport, start: number): Promise<void> {
  const at = isoOf(start);
  const totals = new Map<string, ScriptUsage>();
  const seen = new Set<string>();
  for (const listed of await listWindowObjects(deps.usageLogs, start)) {
    const stored = await deps.usageLogs.get(listed.key);
    if (stored === null) {
      count(report, "objects_missing");
      continue;
    }
    let usage: ObjectUsage;
    try {
      usage = await readUsageObject(stored, deps.namespace);
    } catch (error) {
      if (!(error instanceof InvalidUsageObject)) throw error;
      count(report, "objects_rejected");
      report.problems.push(`wfp_object_rejected:${listed.key}:${error.reason}`);
      continue;
    }
    // The same batch delivered under a second name must not be billed twice.
    if (seen.has(usage.digest)) {
      count(report, "objects_duplicate");
      continue;
    }
    seen.add(usage.digest);
    count(report, "objects");
    count(report, "events_foreign", usage.foreign);
    for (const [script, used] of usage.scripts) {
      const total = totals.get(script) ?? { requests: 0, cpuMs: 0 };
      total.requests += used.requests;
      total.cpuMs += used.cpuMs;
      totals.set(script, total);
    }
  }
  const names = [...totals.keys()].sort();
  const owners = new Map<string, ResolvedScript>();
  for (const part of chunks(names, RESOLVE_CHUNK))
    for (const owner of await deps.core.resolveScripts({ scriptNames: part }))
      owners.set(owner.scriptName, owner);
  const charges: Charge[] = [];
  for (const name of names) {
    const used = totals.get(name) as ScriptUsage;
    const owner = owners.get(name);
    if (owner === undefined) {
      count(report, "requests_unowned", used.requests);
      continue;
    }
    const scope = {
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      environmentId: owner.environmentId,
    };
    charges.push(
      { ...scope, meter: WFP_REQUESTS_METER, unit: "request", quantity: BigInt(used.requests) },
      { ...scope, meter: WFP_CPU_METER, unit: "cpu_ms", quantity: BigInt(used.cpuMs) },
    );
  }
  if (charges.length > 0) {
    const cards = ratesToCards(await deps.core.readRates({ at }), at);
    const { byOrganization, unpriced } = organizationLines(charges, cards, at);
    for (const meter of unpriced) count(report, `unpriced:${meter}`);
    await postOrganizations(deps, report, at, byOrganization);
  }
  await deps.core.advanceCursor({ source: "wfp", through: isoOf(start + HOUR_MS) });
}
