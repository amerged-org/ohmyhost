export interface ReturnQuery {
  asOf: string;
  days: 7 | 30;
  activations: { workspace: string; at: string }[];
  activities: { workspace: string; at: string; kind: string }[];
  historyComplete: boolean;
}
const DAY = 86_400_000;
const utcDay = (value: string): number => Math.floor(Date.parse(value) / DAY);

/** Counts distinct workspaces only once and only after the entire target UTC day. */
export function calculateReturnCohort(query: ReturnQuery) {
  const first = new Map<string, number>();
  for (const activation of query.activations) {
    const day = utcDay(activation.at);
    if (!Number.isFinite(day)) continue;
    first.set(activation.workspace, Math.min(first.get(activation.workspace) ?? day, day));
  }
  const asOfDay = utcDay(query.asOf);
  let mature = 0,
    pending = 0,
    numerator = 0;
  for (const [workspace, day] of first) {
    if (day + query.days >= asOfDay) {
      pending++;
      continue;
    }
    mature++;
    if (
      query.activities.some(
        (activity) =>
          activity.workspace === workspace &&
          utcDay(activity.at) === day + query.days &&
          (activity.kind === "source_change" || activity.kind === "deliberate_deployment"),
      )
    )
      numerator++;
  }
  return {
    numerator,
    denominator: mature,
    mature,
    pending,
    asOf: query.asOf,
    historyComplete: query.historyComplete,
    historyLimitDays: 180,
  };
}
