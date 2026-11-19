import { accountWindow, readAccountProjection, readGrowthRollups } from "./account-projection.js";
import type { GrowthD1 } from "./event-store.js";
import type { GrowthEventV1, GrowthFactV1 } from "@ohmyhost/contracts/growth-events";
import { calculateReturnCohort } from "./retention-metrics.js";
import { calculateNetReceipts } from "./payment-projections.js";
import {
  evaluateExperiment,
  type ExperimentInput,
  type ObservedExperimentVersions,
} from "./experiments.js";
import { setSegment, type SegmentFilter } from "./segments.js";
import type { Dashboard, TimelinePage } from "./metrics.js";

const MAX = 10000;
const asOfTime = (now: () => Date) => now().toISOString();
type Body = { body: string };
const parse = <T>(row: Body): T => JSON.parse(row.body) as T;
const offset = (cursor: string | null) => (cursor && /^\d{1,6}$/.test(cursor) ? Number(cursor) : 0);
const sourceNames = [
  "onboarding",
  "memberships",
  "projects",
  "source_publications",
  "deployments",
  "billing",
  "identity",
  "identity_snapshot",
  "attribution",
  "billing_open_disputes",
];

/** Fixed, bounded reads of the private projection. No caller-supplied SQL. */
export function createOperatorData(db: GrowthD1, now: () => Date = () => new Date()) {
  return {
    async readDashboard({
      limit,
      cursor,
      segment = "all",
    }: {
      limit: number;
      cursor: string | null;
      segment?: SegmentFilter;
    }): Promise<Dashboard & ObservedExperimentVersions> {
      const [
        eventRows,
        factRows,
        activityRows,
        cursorRows,
        experiments,
        disputes,
        ingest,
        tagRows,
      ] = await Promise.all([
        db
          .prepare(
            "SELECT body FROM growth_events ORDER BY occurred_at DESC, event_id DESC LIMIT ?",
          )
          .bind(MAX + 1)
          .all<Body>(),
        db
          .prepare("SELECT body FROM growth_facts ORDER BY occurred_at DESC, fact_id DESC LIMIT ?")
          .bind(MAX + 1)
          .all<Body>(),
        db
          .prepare(
            "SELECT organization_id, occurred_at FROM growth_activity ORDER BY occurred_at DESC LIMIT ?",
          )
          .bind(MAX + 1)
          .all<{ organization_id: string | null; occurred_at: string }>(),
        db
          .prepare(
            "SELECT s.source, c.source_watermark, c.history_floor, s.error_class, s.last_attempt_at, s.last_success_at, s.completed_scan_at, s.quality_flags FROM growth_source_status s LEFT JOIN growth_cursors c ON c.source=s.source",
          )
          .all<{
            source: string;
            source_watermark: string | null;
            history_floor: string | null;
            error_class: string | null;
            last_attempt_at: string | null;
            last_success_at: string | null;
            completed_scan_at: string | null;
            quality_flags: string;
          }>(),
        db
          .prepare(
            "SELECT experiment_id, body FROM growth_experiments ORDER BY created_at DESC LIMIT ? OFFSET ?",
          )
          .bind(Math.min(limit, 50) + 1, offset(cursor))
          .all<{ experiment_id: string; body: string }>(),
        db
          .prepare("SELECT body FROM growth_open_disputes LIMIT ?")
          .bind(MAX + 1)
          .all<Body>(),
        db
          .prepare("SELECT producer,outcome,count FROM growth_ingest_health")
          .all<{ producer: string; outcome: string; count: number }>(),
        db
          .prepare("SELECT entity_type,entity_id,segment FROM growth_segment_tags LIMIT ?")
          .bind(MAX + 1)
          .all<{
            entity_type: "account" | "organization";
            entity_id: string;
            segment: "test" | "non_test" | "unknown";
          }>(),
      ]);
      const events = eventRows.results.slice(0, MAX).map(parse<GrowthEventV1>);
      const facts = factRows.results.slice(0, MAX).map(parse<GrowthFactV1>);
      const partial =
        eventRows.results.length > MAX ||
        factRows.results.length > MAX ||
        activityRows.results.length > MAX;
      const sources = sourceNames.map((source) => {
        const state = cursorRows.results.find((x) => x.source === source);
        return {
          source,
          watermark: state?.source_watermark ?? null,
          historyFloor: state?.history_floor ?? null,
          status: state?.error_class
            ? `error: ${state.error_class}`
            : state?.last_success_at
              ? Date.parse(asOfTime(now)) - Date.parse(state.last_success_at) > 15 * 60000
                ? "stale"
                : "available"
              : "unavailable",
          lastAttempt: state?.last_attempt_at ?? null,
          lastSuccess: state?.last_success_at ?? null,
          completedScan: state?.completed_scan_at ?? null,
          qualityFlags: state?.quality_flags ? (JSON.parse(state.quality_flags) as string[]) : [],
        };
      });
      const asOf = now().toISOString();
      if (segment !== "all" && tagRows.results.length > MAX)
        throw new Error("Segment filter unavailable: tag read limit reached");
      const tags = new Map(
        tagRows.results.map((row) => [`${row.entity_type}:${row.entity_id}`, row.segment]),
      );
      const matches = (type: "account" | "organization", id: string | null) =>
        segment === "all" || (!!id && (tags.get(`${type}:${id}`) ?? "unknown") === segment);
      const allAccounts = await readAccountProjection(db, now());
      const accounts = allAccounts.filter((a) => matches("account", a.account_id));
      const windows = [1, 7].map((days) => ({ days, ...accountWindow(accounts, now(), days) }));
      const membership = sources.find((s) => s.source === "memberships");
      const watermark = membership?.watermark ?? null;
      const deployments = facts.filter(
        (f): f is Extract<GrowthFactV1, { fact_type: "deployment" }> =>
          f.fact_type === "deployment" &&
          f.status === "succeeded" &&
          f.health_status === "passed" &&
          !!f.organization_id &&
          matches("organization", f.organization_id) &&
          !!f.succeeded_at,
      );
      const activations = deployments.flatMap((f) =>
        f.organization_id && f.succeeded_at
          ? [{ workspace: f.organization_id, at: f.succeeded_at }]
          : [],
      );
      const activities = activityRows.results
        .slice(0, MAX)
        .flatMap((x) =>
          x.organization_id && matches("organization", x.organization_id)
            ? [{ workspace: x.organization_id, at: x.occurred_at, kind: "source_change" }]
            : [],
        );
      const returns = ([7, 30] as const).map((days) => ({
        days,
        ...calculateReturnCohort({ asOf, days, activations, activities, historyComplete: false }),
      }));
      const money = calculateNetReceipts(
        [
          ...facts,
          ...(sources.some((s) => s.source === "billing_open_disputes" && s.completedScan)
            ? disputes.results.slice(0, MAX).map(parse<GrowthFactV1>)
            : []),
        ].filter(
          (f): f is Extract<GrowthFactV1, { fact_type: "payment" }> =>
            f.fact_type === "payment" &&
            !!f.organization_id &&
            matches("organization", f.organization_id),
        ),
      );
      const experimentResults = await Promise.all(
        experiments.results.slice(0, Math.min(limit, 50)).map(async (row) => {
          const experiment = JSON.parse(row.body) as ExperimentInput;
          const exposureRows = await db
            .prepare(
              "SELECT subject_id, variant, version, delivered_at FROM growth_exposures WHERE experiment_id=? LIMIT ?",
            )
            .bind(row.experiment_id, MAX + 1)
            .all<{ subject_id: string; variant: string; version: string; delivered_at: string }>();
          const result = evaluateExperiment({
            experiment,
            asOf,
            events,
            facts,
            complete: !partial && exposureRows.results.length <= MAX,
            exposures: exposureRows.results.slice(0, MAX).map((x) => ({
              subject: x.subject_id,
              variant: x.variant,
              version: x.version,
              delivered_at: x.delivered_at,
            })),
          });
          return {
            id: row.experiment_id,
            hypothesis: experiment.hypothesis,
            evidence: experiment.evidence_basis,
            segment: experiment.segment,
            metric: experiment.primary_metric,
            horizon: `${experiment.horizon_start ?? "unconfigured"} to ${experiment.horizon_end ?? "unconfigured"}`,
            guardrails: experiment.guardrails ?? [],
            evidenceReference: experiment.evidence_reference,
            versions: [...new Set(exposureRows.results.map((x) => x.version))],
            ...result,
          };
        }),
      );
      return {
        cohorts:
          sources.some((s) => s.source === "identity" && s.lastSuccess) && membership?.lastSuccess
            ? windows.map((row) => ({
                label: `Account → workspace within ${row.days === 1 ? "24 hours" : "7 days"}`,
                numerator: row.numerator,
                denominator: row.denominator,
                mature: row.mature,
                pending: row.pending,
                unknown: row.unknown,
                anchor: "Account created; UTC",
                watermark,
                segment: `account: ${segment}`,
              }))
            : [],
        sources,
        accountRollups: segment === "all" ? await readGrowthRollups(db, now()) : [],
        errors: [
          ...events.reduce((map, event) => {
            if (event.error_class)
              map.set(event.error_class, (map.get(event.error_class) ?? 0) + 1);
            return map;
          }, new Map<string, number>()),
        ].map(([error, count]) => ({ error, count })),
        returns: sources.some((s) => s.source === "deployments" && s.lastSuccess) ? returns : [],
        money: sources.some((s) => s.source === "billing" && s.lastSuccess) ? money : [],
        experiments: experimentResults,
        observedResponseVersions: [
          ...new Set(
            events
              .filter(
                (e) =>
                  e.producer === "control_api" &&
                  e.evidence_kind === "event" &&
                  e.event_name === "product_call_succeeded" &&
                  e.outcome === "succeeded" &&
                  e.account_id &&
                  e.platform_version,
              )
              .flatMap((e) => (e.platform_version ? [e.platform_version] : [])),
          ),
        ].slice(0, 20),
        nextCursor:
          experiments.results.length > Math.min(limit, 50)
            ? String(offset(cursor) + Math.min(limit, 50))
            : null,
        limitations: [
          `Segment ${segment}: account cohorts use account tags; return and money use organization tags. Untagged entities are unknown; all includes test and unknown.`,
          "Historical identity and membership coverage is unknown; absent workspace evidence is unknown. Actor coverage may be unknown.",
          ...(allAccounts.length > MAX
            ? ["Account projection read limit reached; cohort counts are partial."]
            : []),
          "D7/D30 activity history and source completeness are not yet established.",
          "Payment evidence may be unavailable or incomplete; open disputes do not reduce receipts.",
          ...(sources.some((s) => s.source === "billing_open_disputes" && s.completedScan)
            ? []
            : ["Open dispute scan unavailable or incomplete."]),
          ...ingest.results
            .filter((x) => x.outcome !== "accepted")
            .map((x) => `Ingest ${x.producer}: ${x.outcome} ${x.count}`),
          ...(facts.some((f) => f.fact_type === "payment" && !f.organization_id)
            ? ["Payment facts with unknown workspace are excluded; their scope is unassigned."]
            : []),
          ...(partial ? ["Read limit reached: counts are partial, not population totals."] : []),
        ],
      };
    },
    async setSegment(input: Parameters<typeof setSegment>[1]) {
      return setSegment(db, input);
    },
    async readAttribution({ subject, operator }: { subject: string; operator: string }) {
      await db
        .prepare(
          "INSERT INTO growth_identity_audit(operator_id,subject_id,accessed_at) VALUES(?,?,?)",
        )
        .bind(operator, subject, now().toISOString())
        .run();
      const row = await db
        .prepare(
          "SELECT body FROM growth_campaigns WHERE json_extract(body,'$.account_id')=? AND expires_at>? ORDER BY json_extract(body,'$.observed_at') DESC LIMIT 1",
        )
        .bind(subject, now().toISOString())
        .first<Body>();
      if (!row) return null;
      return parse<{ observed_at: string; r: string | null; utm: Record<string, string> }>(row);
    },
    async readAccounts({ limit, cursor }: { limit: number; cursor: string | null }) {
      const n = Math.min(50, Math.max(1, limit));
      const rows = await db
        .prepare(
          `SELECT account_id, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen FROM (SELECT account_id,created_at AS first_seen,observed_at AS last_seen FROM growth_account_projection WHERE created_at>=? UNION ALL SELECT account_id,occurred_at,occurred_at FROM growth_events WHERE account_id IS NOT NULL) GROUP BY account_id ORDER BY account_id LIMIT ? OFFSET ?`,
        )
        .bind(new Date(now().getTime() - 180 * 86400000).toISOString(), n + 1, offset(cursor))
        .all<{ account_id: string; first_seen: string; last_seen: string }>();
      return {
        accounts: rows.results
          .slice(0, n)
          .map((x) => ({ subject: x.account_id, firstSeen: x.first_seen, lastSeen: x.last_seen })),
        nextCursor: rows.results.length > n ? String(offset(cursor) + n) : null,
      };
    },
    async readTimeline({
      subject,
      scope,
      limit,
      cursor,
    }: {
      subject: string;
      scope: string;
      limit: number;
      cursor: string | null;
    }): Promise<TimelinePage> {
      const n = Math.min(50, Math.max(1, limit)),
        skip = offset(cursor);
      const rows = await db
        .prepare(
          "SELECT body FROM growth_events WHERE account_id=? AND (?='account' OR organization_id=? OR organization_id IS NULL) ORDER BY occurred_at DESC,event_id DESC LIMIT ? OFFSET ?",
        )
        .bind(subject, scope, scope, n + 1, skip)
        .all<Body>();
      const events = rows.results.slice(0, n).map(parse<GrowthEventV1>);
      const factRows = await db
        .prepare(
          "SELECT body FROM growth_facts WHERE account_id=? AND (?='account' OR organization_id=?) ORDER BY occurred_at DESC LIMIT ?",
        )
        .bind(subject, scope, scope, 50)
        .all<Body>();
      const facts = factRows.results.map(parse<GrowthFactV1>);
      const activity = await db
        .prepare(
          "SELECT MAX(occurred_at) AS at FROM growth_activity WHERE account_id=? AND (?='account' OR organization_id=?)",
        )
        .bind(subject, scope, scope)
        .first<{ at: string | null }>();
      const stages = [
        "account_created",
        "workspace_ready",
        "product_call_succeeded",
        "source_version_saved",
      ];
      const observed = new Set(events.map((e) => e.event_name));
      const first = events.at(-1)?.occurred_at,
        last = events[0]?.occurred_at;
      return {
        items: events.map((e) => {
          const fact = facts.find(
            (f) => f.fact_type === "deployment" && f.deployment_id === e.deployment_id,
          );
          return {
            at: e.occurred_at,
            stage: e.event_name,
            error: e.error_class,
            actor: e.account_id,
            client: e.client_class,
            clientTrust: e.client_class_trust,
            transport: e.transport,
            country: e.request_country,
            campaign: e.campaign_key,
            environment: fact?.fact_type === "deployment" ? fact.target_environment : null,
            kind: fact?.fact_type === "deployment" ? fact.kind : null,
            health: fact?.fact_type === "deployment" ? fact.health_status : null,
          };
        }),
        nextCursor: rows.results.length > n ? String(skip + n) : null,
        nextMissingStage: stages.find((s) => !observed.has(s as GrowthEventV1["event_name"]))
          ? `Not observed in this page: ${stages.find((s) => !observed.has(s as GrowthEventV1["event_name"]))}`
          : "No missing observed stage in this page",
        lastActivity: activity?.at ?? null,
        elapsed:
          first && last
            ? `${Math.max(0, Math.round((Date.parse(last) - Date.parse(first)) / 1000))} seconds across this page`
            : null,
      };
    },
  };
}

/** Write the access audit durably before invoking the private identity resolver. */
export function auditIdentityRead(
  db: GrowthD1,
  resolve: (subject: string) => Promise<{ name: string | null; email: string | null }>,
) {
  return async ({ subject, operator }: { subject: string; operator: string }) => {
    await db
      .prepare(
        "INSERT INTO growth_identity_audit(operator_id,subject_id,accessed_at) VALUES(?,?,?)",
      )
      .bind(operator, subject, new Date().toISOString())
      .run();
    return resolve(subject);
  };
}
