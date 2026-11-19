import type { GrowthEventV1, GrowthFactV1 } from "@ohmyhost/contracts/growth-events";
import { subjectSuppressionKey, type GrowthD1 } from "./event-store.js";

export interface ObservedExperimentVersions {
  observedResponseVersions?: string[];
}
export interface ExperimentInput {
  hypothesis: string;
  evidence_basis: "observed_technical" | "user_reported" | "hypothesis";
  evidence_reference: string | null;
  segment: "all" | "new_accounts_7d";
  primary_metric: "workspace_ready_7d" | "healthy_deployment_7d";
  guardrails: string[];
  horizon_start: string;
  horizon_end: string;
  baseline_version: string;
  variant_version: string;
  surface: "authorized_product_response";
  exposure_mode: "before_after";
}
export interface Exposure {
  subject: string;
  variant: string;
  version: string;
  delivered_at: string;
}
export interface ExperimentStore {
  registerExperiment(input: ExperimentInput): Promise<{ id: string } & ExperimentInput>;
}
export function configured(x: ExperimentInput): boolean {
  return (
    x.exposure_mode === "before_after" &&
    x.surface === "authorized_product_response" &&
    !!x.baseline_version &&
    !!x.variant_version &&
    x.baseline_version !== x.variant_version &&
    ["all", "new_accounts_7d"].includes(x.segment) &&
    ["workspace_ready_7d", "healthy_deployment_7d"].includes(x.primary_metric) &&
    Number.isFinite(Date.parse(x.horizon_start)) &&
    Number.isFinite(Date.parse(x.horizon_end)) &&
    Date.parse(x.horizon_start) < Date.parse(x.horizon_end)
  );
}
export function evaluateExperiment(input: {
  experiment: ExperimentInput;
  asOf: string;
  exposures: Exposure[];
  events: GrowthEventV1[];
  facts: GrowthFactV1[];
  complete: boolean;
}) {
  const { experiment: x } = input;
  if (!configured(x))
    return {
      sampleSize: 0,
      mature: false,
      conclusion: "pending / unconfigured",
      comparison: "descriptive",
      limitations: ["Registration lacks a supported measurement configuration"],
    };
  const groups = ["baseline", "variant"] as const;
  const both = new Set(
    input.exposures
      .filter((e) =>
        input.exposures.some((other) => other.subject === e.subject && other.variant !== e.variant),
      )
      .map((e) => e.subject),
  );
  const detail = groups.map((group) => {
    let exposed = 0,
      mature = 0,
      pending = 0,
      converted = 0,
      unknown = 0;
    for (const e of input.exposures.filter((e) => e.variant === group && !both.has(e.subject))) {
      const start = Date.parse(e.delivered_at),
        end = start + 7 * 86400000;
      exposed++;
      if (x.segment === "new_accounts_7d") {
        const created = input.events.find(
          (v) =>
            v.account_id === e.subject &&
            v.event_name === "account_created" &&
            v.producer === "workos" &&
            v.outcome === "succeeded" &&
            Date.parse(v.occurred_at) <= start &&
            Date.parse(v.occurred_at) >= start - 7 * 86400000,
        );
        if (!created) {
          unknown++;
          continue;
        }
      }
      if (Date.parse(input.asOf) < end) {
        pending++;
        continue;
      }
      mature++;
      const success =
        x.primary_metric === "workspace_ready_7d"
          ? input.events.some(
              (v) =>
                v.account_id === e.subject &&
                v.event_name === "workspace_ready" &&
                v.evidence_kind === "event" &&
                Date.parse(v.occurred_at) >= start &&
                Date.parse(v.occurred_at) <= end,
            )
          : input.facts.some(
              (v) =>
                v.fact_type === "deployment" &&
                v.account_id === e.subject &&
                v.status === "succeeded" &&
                v.health_status === "passed" &&
                !!v.succeeded_at &&
                Date.parse(v.succeeded_at) >= start &&
                Date.parse(v.succeeded_at) <= end,
            );
      if (success) converted++;
      else unknown++;
    }
    return { group, exposed, mature, pending, converted, unknown };
  });
  const [baseline, variant] = detail;
  const difference =
    baseline && variant && baseline.mature > 0 && variant.mature > 0
      ? `${((variant.converted / variant.mature - baseline.converted / baseline.mature) * 100).toFixed(1)} percentage points between observed proportions; incomplete coverage`
      : "unavailable";
  const description = detail
    .map(
      (d) =>
        `${d.group}: ${d.exposed} exposed, ${d.mature} mature, ${d.pending} pending, ${d.converted} converted, ${d.unknown} unknown; observed conversions ${d.mature ? ((100 * d.converted) / d.mature).toFixed(1) + "%" : "unavailable"}`,
    )
    .join("; ");
  return {
    sampleSize: detail.reduce((n, d) => n + d.exposed, 0),
    mature: detail.some((d) => d.mature > 0) && detail.every((d) => d.pending === 0),
    conclusion: `${description}; difference ${difference}`,
    comparison: "descriptive before / after",
    limitations: [
      `${both.size} cross-exposed accounts excluded`,
      "Missing outcome or actor coverage is unknown; observed conversion proportions are lower bounds, not causal effects",
      "Exposure observation begins at registration; earlier delivery is not reconstructed",
      input.complete ? "Source completeness unverified" : "Bounded source reads incomplete",
    ],
  };
}
export function createExperimentStore(db: GrowthD1): ExperimentStore {
  return {
    async registerExperiment(input) {
      if (!configured(input)) throw new Error("Unsupported experiment configuration");
      const id = crypto.randomUUID();
      await db
        .prepare("INSERT INTO growth_experiments(experiment_id,body,created_at) VALUES(?,?,?)")
        .bind(id, JSON.stringify(input), new Date().toISOString())
        .run();
      return { id, ...input };
    },
  };
}
/** Only authenticated, actually delivered Control API responses establish exposure. */
export async function observeDeliveredExperiment(
  db: GrowthD1,
  event: GrowthEventV1,
): Promise<void> {
  const version = (event as GrowthEventV1 & { platform_version?: string }).platform_version;
  if (
    event.producer !== "control_api" ||
    event.evidence_kind !== "event" ||
    event.event_name !== "product_call_succeeded" ||
    event.outcome !== "succeeded" ||
    !event.account_id ||
    !version
  )
    return;
  const rows = await db
    .prepare("SELECT experiment_id, body, created_at FROM growth_experiments")
    .all<{ experiment_id: string; body: string; created_at: string }>();
  const subjectKey = await subjectSuppressionKey(event.account_id);
  for (const row of rows.results) {
    const x = JSON.parse(row.body) as ExperimentInput;
    if (
      !configured(x) ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      Date.parse(event.occurred_at) < Date.parse(row.created_at) ||
      Date.parse(event.occurred_at) < Date.parse(x.horizon_start) ||
      Date.parse(event.occurred_at) >= Date.parse(x.horizon_end)
    )
      continue;
    const variant =
      version === x.baseline_version
        ? "baseline"
        : version === x.variant_version
          ? "variant"
          : null;
    if (!variant) continue;
    await db
      .prepare(
        "INSERT OR IGNORE INTO growth_exposures(experiment_id,subject_id,variant,version,delivered_at) SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM growth_subject_suppression WHERE subject_key=?)",
      )
      .bind(row.experiment_id, event.account_id, variant, version, event.occurred_at, subjectKey)
      .run();
  }
}
