import type { GrowthD1 } from "./event-store.js";

const DAY = 86400000;
export interface AccountProjection {
  account_id: string;
  created_at: string;
  observed_at: string;
  source_kind: string;
  workspace_evidence_at: string | null;
}

/** Positive evidence is bounded by the original creation time and window end. Absence is unknown. */
export function accountWindow(accounts: AccountProjection[], now: Date, days: number) {
  let mature = 0,
    pending = 0,
    numerator = 0,
    unknown = 0;
  for (const account of accounts) {
    const start = Date.parse(account.created_at);
    if (start + days * DAY > now.getTime()) {
      pending++;
      continue;
    }
    mature++;
    const evidence = account.workspace_evidence_at && Date.parse(account.workspace_evidence_at);
    if (evidence && evidence >= start && evidence <= start + days * DAY) numerator++;
    else unknown++;
  }
  return { mature, pending, numerator, unknown, denominator: mature };
}

export async function readAccountProjection(db: GrowthD1, now: Date): Promise<AccountProjection[]> {
  return (
    await db
      .prepare(
        `SELECT p.account_id,p.created_at,p.observed_at,p.source_kind,
    CASE WHEN p.workspace_evidence_at IS NULL THEN o.observed_at WHEN o.observed_at IS NULL THEN p.workspace_evidence_at ELSE min(p.workspace_evidence_at,o.observed_at) END AS workspace_evidence_at
    FROM growth_account_projection p LEFT JOIN growth_workspace_observations o ON o.account_id=p.account_id
    WHERE p.created_at>=? ORDER BY p.created_at DESC LIMIT 10001`,
      )
      .bind(new Date(now.getTime() - 180 * DAY).toISOString())
      .all<AccountProjection>()
  ).results;
}

export interface AccountRollup {
  cohortDay: string;
  windowDays: number;
  mature: number;
  positive: number;
  unknown: number;
  incomplete: boolean;
  refreshedAt: string;
}

/** Only global, mature, non-sparse rows are exposed, within 13 calendar months. */
export async function readGrowthRollups(db: GrowthD1, now: Date): Promise<AccountRollup[]> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))
    .toISOString()
    .slice(0, 10);
  const rows = await db
    .prepare(
      `SELECT cohort_day,window_days,mature,positive,unknown,incomplete,refreshed_at
    FROM growth_daily_account_rollups WHERE cohort_day>=? AND cohort_day<=? AND window_days IN (1,7) AND mature>=5
    ORDER BY cohort_day DESC,window_days ASC LIMIT 806`,
    )
    .bind(cutoff, now.toISOString().slice(0, 10))
    .all<{
      cohort_day: string;
      window_days: number;
      mature: number;
      positive: number;
      unknown: number;
      incomplete: number;
      refreshed_at: string;
    }>();
  return rows.results
    .filter(
      (row) =>
        Date.parse(`${row.cohort_day}T00:00:00.000Z`) + (row.window_days + 1) * DAY <=
        now.getTime(),
    )
    .map((row) => ({
      cohortDay: row.cohort_day,
      windowDays: row.window_days,
      mature: row.mature,
      positive: row.positive,
      unknown: row.unknown,
      incomplete: Boolean(row.incomplete),
      refreshedAt: row.refreshed_at,
    }));
}

/** Recompute fixed daily global cohorts while their account-level evidence is retained. */
export async function refreshGrowthRollups(
  db: GrowthD1,
  now: Date,
): Promise<{ historicalCoverage: "unknown" }> {
  const accounts = await readAccountProjection(db, now);
  const groups = new Map<string, AccountProjection[]>();
  for (const account of accounts) {
    const day = account.created_at.slice(0, 10);
    groups.set(day, [...(groups.get(day) ?? []), account]);
  }
  for (const [day, members] of groups) {
    for (const days of [1, 7]) {
      const row = accountWindow(members, now, days);
      // Suppress sparse or immature cohorts entirely; never publish partial denominators.
      if (
        members.length < 5 ||
        row.pending ||
        row.mature < 5 ||
        accounts.length > 10000 ||
        Date.parse(`${day}T00:00:00.000Z`) + (days + 1) * DAY > now.getTime() ||
        Date.parse(`${day}T00:00:00.000Z`) < now.getTime() - 180 * DAY
      )
        continue;
      await db
        .prepare(
          `INSERT INTO growth_daily_account_rollups(cohort_day,window_days,mature,positive,unknown,incomplete,refreshed_at)
        VALUES(?,?,?,?,?,1,?) ON CONFLICT(cohort_day,window_days) DO UPDATE SET mature=excluded.mature,positive=excluded.positive,unknown=excluded.unknown,incomplete=1,refreshed_at=excluded.refreshed_at`,
        )
        .bind(day, days, row.mature, row.numerator, row.unknown, now.toISOString())
        .run();
    }
  }
  return { historicalCoverage: "unknown" };
}

export async function expireGrowthAccountData(db: GrowthD1, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 180 * DAY).toISOString();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1))
    .toISOString()
    .slice(0, 10);
  await db.batch([
    db.prepare("DELETE FROM growth_workspace_observations WHERE observed_at<?").bind(cutoff),
    db.prepare("DELETE FROM growth_account_projection WHERE created_at<?").bind(cutoff),
    db.prepare("DELETE FROM growth_daily_account_rollups WHERE cohort_day<?").bind(month),
  ]);
}
