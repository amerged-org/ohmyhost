import { PGCF_MEMORY_METER, PGCF_MEMORY_UNIT } from "@ohmyhost/platform/shared";
import { organizationLines, ratesToCards, type Charge } from "./pricing.js";
import type {
  Dependencies,
  PgcfHourlyRollup,
  PgcfPendingRow,
  PgcfUsageRollups,
  StopBudgetProject,
} from "./port.js";
import { HOUR_MS, floorHour, isoOf, parseBoundary } from "./time.js";
import { chunks, count, newReport, postOrganizations, type SourceReport } from "./source.js";

/** A provider hour is final two hours after it ended. */
export const PGCF_LAG_MS = 2 * HOUR_MS;
/** A pass collects at most one day of hours. */
export const PGCF_MAX_HOURS = 24;
const RESOLVE_CHUNK = 100;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

/** The collector answers over RPC; its shape is checked before a single microcredit depends on it. */
export function parsePgcfRollups(value: unknown, from: number, to: number): PgcfUsageRollups {
  const fail = (): never => {
    throw new TypeError("credit_service_pgcf_rollups_invalid");
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  const rows = body["rollups"],
    pending = body["pending"],
    unbillable = body["unbillableHours"];
  const inRange = (text: unknown): number => {
    const ms = typeof text === "string" ? Date.parse(text) : Number.NaN;
    return Number.isFinite(ms) && isoOf(ms) === text && ms % HOUR_MS === 0 && ms >= from && ms < to
      ? ms
      : fail();
  };
  if (
    body["from"] !== isoOf(from) ||
    body["to"] !== isoOf(to) ||
    !Array.isArray(rows) ||
    !Array.isArray(pending) ||
    typeof unbillable !== "number" ||
    !Number.isSafeInteger(unbillable) ||
    unbillable < 0
  )
    return fail();
  for (const row of pending as unknown[]) {
    if (row === null || typeof row !== "object") return fail();
    const notFinal = row as Record<string, unknown>;
    inRange(notFinal["hourStart"]);
    if (typeof notFinal["databaseId"] !== "string" || notFinal["databaseId"] === "") return fail();
  }
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== "object") return fail();
    const rollup = row as Record<string, unknown>;
    inRange(rollup["hourStart"]);
    if (
      typeof rollup["databaseId"] !== "string" ||
      typeof rollup["memoryMibMilliseconds"] !== "string" ||
      !DECIMAL.test(rollup["memoryMibMilliseconds"])
    )
      return fail();
  }
  return value as PgcfUsageRollups;
}

/**
 * The `pgcf` pass: bills the final hours after the cursor, then disables the schedules of the projects whose stop
 * budget is reached. The sweep runs even when billing fails, and it never throws, so a failed sweep cannot hold back
 * the billing and a failed billing does not stop the sweep.
 */
export async function runPgcf(deps: Dependencies): Promise<SourceReport> {
  const report = newReport("pgcf");
  try {
    await billFinalHours(deps, report);
  } finally {
    await stopReachedBudgets(deps, report);
  }
  return report;
}

/**
 * Bills the final hours after the `pgcf` cursor, up to the first hour in which a database that bills in that hour is
 * not final at the provider yet. A row the provider never finalizes (a retired database) holds nothing back.
 */
async function billFinalHours(deps: Dependencies, report: SourceReport): Promise<void> {
  const cursor = await deps.core.readCursor("pgcf");
  if (cursor === null) {
    report.status = "skipped";
    return;
  }
  const from = parseBoundary(cursor, HOUR_MS);
  const limit = floorHour(deps.now()) - PGCF_LAG_MS;
  if (from >= limit) return;
  const to = Math.min(limit, from + PGCF_MAX_HOURS * HOUR_MS);
  const rollups = parsePgcfRollups(
    await deps.neon.collectUsage({ from: isoOf(from), to: isoOf(to) }),
    from,
    to,
  );
  const pendingNative = await deps.core.readPendingNativeDatabaseCreates({
    from: isoOf(from),
    to: isoOf(to),
  });
  const nativeHold =
    pendingNative.holdFrom === null ? to : parseBoundary(pendingNative.holdFrom, HOUR_MS);
  if (nativeHold < from || (nativeHold >= to && pendingNative.holdFrom !== null))
    throw new TypeError("credit_service_native_hold_invalid");
  const stop = await firstHeldHour(
    deps,
    report,
    rollups.pending.filter((row) => Date.parse(row.hourStart) < nativeHold),
    nativeHold,
  );
  if (stop === from) {
    report.status = "waiting";
    return;
  }
  // The provider counts unbillable hours per window, not per hour: they are counted only when the whole window is
  // passed. A held pass drops them and the next pass sees them again, so counting them there would double them.
  if (stop === to) count(report, "hours_unbillable", rollups.unbillableHours);
  const byHour = new Map<number, PgcfHourlyRollup[]>();
  for (const rollup of rollups.rollups) {
    const hour = Date.parse(rollup.hourStart);
    if (hour >= stop) continue;
    byHour.set(hour, [...(byHour.get(hour) ?? []), rollup]);
  }
  for (const hour of [...byHour.keys()].sort((left, right) => left - right)) {
    await billHour(deps, report, hour, byHour.get(hour) as PgcfHourlyRollup[]);
    await deps.core.advanceCursor({ source: "pgcf", through: isoOf(hour + HOUR_MS) });
  }
  await deps.core.advanceCursor({ source: "pgcf", through: isoOf(stop) });
  report.windows = (stop - from) / HOUR_MS;
  report.status = "advanced";
}

/**
 * Disables the enabled schedules of the projects whose `stop` budget is reached, and of the projects whose organization
 * is past its credit grace with nothing left (their database would otherwise run on the platform's cost). Each list is
 * read on its own, so an unreadable list does not hold back the other; a project in both is stopped once. A project that
 * fails is counted and named as a problem, and the next one is still tried; the next hourly pass repeats whatever is
 * still enabled.
 */
async function stopReachedBudgets(deps: Dependencies, report: SourceReport): Promise<void> {
  const projects = new Map<string, StopBudgetProject>();
  for (const read of [
    () => deps.core.listStopBudgetProjects(),
    () => deps.core.listCreditDeniedProjects(),
  ]) {
    try {
      for (const project of await read())
        projects.set(`${project.organizationId}:${project.projectId}`, project);
    } catch {
      report.problems.push("budget_projects_unreadable");
    }
  }
  for (const project of projects.values()) {
    try {
      const { stopped } = await deps.neon.stopSchedules(project);
      if (!Number.isSafeInteger(stopped) || stopped < 0)
        throw new TypeError("credit_service_stop_answer_invalid");
      if (stopped > 0) count(report, "schedules_stopped", stopped);
    } catch {
      count(report, "schedule_stops_failed");
      report.problems.push(`schedule_stop_failed:${project.projectId}`);
    }
  }
}

/**
 * The first hour that still has a non-final row of a database the Core attributes in that hour, else `to`. Billing the
 * hour would lose that usage, so the cursor stops before it. A row the Core cannot attribute for its hour (retired,
 * platform, unknown, not yet billable, several owners) would not be billed even when final, so it is only counted.
 * Hours after the first held one are not examined.
 */
async function firstHeldHour(
  deps: Dependencies,
  report: SourceReport,
  pending: readonly PgcfPendingRow[],
  to: number,
): Promise<number> {
  const byHour = new Map<number, Set<string>>();
  for (const row of pending) {
    const hour = Date.parse(row.hourStart);
    byHour.set(hour, (byHour.get(hour) ?? new Set<string>()).add(row.databaseId));
  }
  for (const hour of [...byHour.keys()].sort((left, right) => left - right)) {
    const ids = [...(byHour.get(hour) as Set<string>)].sort();
    const owners = await resolveOwners(deps, ids, isoOf(hour));
    count(report, "pending_ignored", ids.filter((id) => !owners.has(id)).length);
    if (owners.size > 0) return hour;
  }
  return to;
}

async function resolveOwners(deps: Dependencies, ids: readonly string[], at: string) {
  const owners = new Map<
    string,
    | { organizationId: string; projectId: string; environmentId: string }
    | { organizationId: string; projectId: string; resourceKind: "native_auth_database" }
  >();
  for (const part of chunks(ids, RESOLVE_CHUNK))
    for (const owner of await deps.core.resolvePgcfDatabases({ databaseIds: part, at }))
      owners.set(owner.databaseId, owner);
  return owners;
}

async function billHour(
  deps: Dependencies,
  report: SourceReport,
  hour: number,
  rows: readonly PgcfHourlyRollup[],
): Promise<void> {
  const at = isoOf(hour);
  const owners = await resolveOwners(
    deps,
    [...new Set(rows.map((row) => row.databaseId))].sort(),
    at,
  );
  const charges: Charge[] = [];
  for (const row of rows) {
    const owner = owners.get(row.databaseId);
    if (owner === undefined) {
      count(report, "databases_unowned");
      continue;
    }
    charges.push({
      organizationId: owner.organizationId,
      projectId: owner.projectId,
      ...("environmentId" in owner
        ? { environmentId: owner.environmentId }
        : { environmentId: null, resourceKind: owner.resourceKind }),
      meter: PGCF_MEMORY_METER,
      unit: PGCF_MEMORY_UNIT,
      quantity: BigInt(row.memoryMibMilliseconds),
    });
  }
  if (charges.length === 0) return;
  const cards = ratesToCards(await deps.core.readRates({ at }), at);
  const { byOrganization, unpriced } = organizationLines(charges, cards, at);
  for (const meter of unpriced) count(report, `unpriced:${meter}`);
  await postOrganizations(deps, report, at, byOrganization);
}
