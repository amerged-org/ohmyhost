import { normalizeCrons } from "@ohmyhost/contracts/functions";
import type { ClaimedFunctionRun, EnvironmentFunctionSchedule } from "@ohmyhost/database";
import { z } from "zod";
import type { D1Database, D1PreparedStatement, D1Result } from "../d1-types.js";
import { guard } from "../guards.js";
import { runCommand, StoreOutcomeUnknownError } from "../run-command.js";
import { storedTimestamp } from "../timestamps.js";
import {
  addMilliseconds,
  publicTimestamp,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "./common.js";
import { readRuntimeDecision, type RuntimeDecision } from "./credit/index.js";

const timestamp = z
  .string()
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }, "Timestamp is not canonical")
  .transform(storedTimestamp);
const origins = z
  .array(z.string())
  .max(16)
  .transform((values) =>
    Object.freeze(
      values
        .map((value) => {
          if (new URL(value).origin !== value || !value.startsWith("https://"))
            throw new TypeError("Egress origins are invalid");
          return value;
        })
        .sort(),
    ),
  );
const run = z
  .strictObject({
    runId: ulid,
    organizationId: ulid,
    projectId: ulid,
    environmentId: ulid,
    deploymentId: ulid,
    immutableScriptName: z.string(),
    cron: z.string(),
    scheduledAt: timestamp,
    egressAllowedOrigins: origins,
  })
  .superRefine((value) => {
    normalizeCrons([value.cron]);
  });
const dueInput = z.strictObject({ runs: z.array(run), now: timestamp });
const claimInput = z.strictObject({
  now: timestamp,
  limit: z.number().int().min(1).max(100),
  leaseMilliseconds: z.array(z.number().int().min(1000).max(3_600_000)).max(100).optional(),
});
/** The lease of a claimed run that the caller did not size: one dispatch timeout and its outcome write. */
const DEFAULT_RUN_LEASE_MILLISECONDS = 150_000;
/** A due or retry run whose occurrence is more than this overdue is a missed occurrence: it is never dispatched. */
const STALE_RUN_MILLISECONDS = 60 * 60_000;
const finishInput = z.strictObject({
  runId: ulid,
  attempt: z.number().int().min(1).max(3),
  outcome: z.enum(["succeeded", "failed", "rejected"]),
  statusCode: z.number().int().min(100).max(599).nullable(),
  now: timestamp,
});

/** A lost mutation reply must not authorize a newly decided claim or repeat an unidentifiable effect. */
function mutation(
  db: D1Database,
  name: string,
  input: unknown,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  return runCommand(db, {
    name: `functionsScheduler.${name}`,
    input,
    read: async () => null,
    decide: () => ({
      statements: [
        guard(db, "bucket_fenced", "EXISTS(SELECT 1 FROM bucket_fences)"),
        ...statements,
      ],
      result: (results) => results.slice(1),
    }),
    lookup: async () => {
      throw new StoreOutcomeUnknownError(`functionsScheduler.${name}: store_outcome_unknown`);
    },
  });
}

/** Read the original global schedule inventory; no guessed current ownership or head filter. */
export async function readFunctionSchedules(
  context: CatalogContext,
  raw: unknown,
): Promise<readonly EnvironmentFunctionSchedule[]> {
  z.strictObject({}).parse(raw);
  const rows = (
    await context.directory
      .prepare(
        "SELECT organization_id,project_id,environment_id,deployment_id,candidate_receipt_id,immutable_script_name,crons,egress_allowed_origins,updated_at FROM environment_function_schedules ORDER BY organization_id,environment_id",
      )
      .all()
  ).results;
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        organizationId: row["organization_id"] as string,
        projectId: row["project_id"] as string,
        environmentId: row["environment_id"] as string,
        deploymentId: row["deployment_id"] as string,
        candidateReceiptId: row["candidate_receipt_id"] as string,
        immutableScriptName: row["immutable_script_name"] as string,
        crons: normalizeCrons(z.array(z.string()).parse(JSON.parse(row["crons"] as string))),
        egressAllowedOrigins: origins.parse(JSON.parse(row["egress_allowed_origins"] as string)),
        updatedAt: publicTimestamp(row["updated_at"] as string),
      }),
    ),
  );
}

/** Validate the whole original transaction before materializing its due-minute identities in one batch. */
export async function insertFunctionRuns(context: CatalogContext, raw: unknown): Promise<number> {
  const input = dueInput.parse(raw),
    db = context.directory;
  if (input.runs.length === 0) return 0;
  const results = await mutation(
    db,
    "insertDueRuns",
    input,
    input.runs.map((item) =>
      db
        .prepare(
          "INSERT INTO function_runs(run_id,organization_id,project_id,environment_id,deployment_id,immutable_script_name,cron,scheduled_at,state,attempt,egress_allowed_origins,created_at,updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,'due',0,?9,?10,?10 WHERE NOT EXISTS(SELECT 1 FROM function_runs open WHERE open.organization_id=?2 AND open.environment_id=?4 AND open.cron=?7 AND open.state IN ('due','retry','running')) ON CONFLICT(organization_id,environment_id,cron,scheduled_at) DO NOTHING",
        )
        .bind(
          item.runId,
          item.organizationId,
          item.projectId,
          item.environmentId,
          item.deploymentId,
          item.immutableScriptName,
          item.cron,
          item.scheduledAt,
          JSON.stringify(item.egressAllowedOrigins),
          input.now,
        ),
    ),
  );
  return results.reduce((total, result) => total + result.meta.changes, 0);
}

const claimColumns = [
  "run_id",
  "organization_id",
  "project_id",
  "environment_id",
  "deployment_id",
  "immutable_script_name",
  "cron",
  "scheduled_at",
  "attempt",
  "lease_until",
  "egress_allowed_origins",
  "state",
  "started_at",
] as const;
type RunRow = Readonly<Record<string, unknown>>;

/** A run's environment is the unit the shared gateway pauses: its organization, project and environment. */
const scopeOf = (row: RunRow) => `${row["organization_id"]}:${row["environment_id"]}`;

/** The status a paused run records, the answer the shared gateway gives HTTP: 404 for an unavailable project, else 402. */
const pausedStatus = (decision: RuntimeDecision) =>
  decision.reason === "project_unavailable" ? 404 : 402;

/** The claim reads five times its limit (at most 100) so paused environments inside the window are cleared, not leased. */
const claimWindow = (limit: number) => Math.min(limit * 5, 100);

/**
 * Expired-attempt terminalization and bounded lease acquisition are one guarded batch. The window is ranked per
 * organization: the oldest run of every organization comes before the second run of any, so one tenant's backlog or
 * retries cannot hold back another tenant's crons. Every environment in the window passes the serving decision of the
 * shared gateway (`readRuntimeDecision`, one read batch per distinct environment: at most five times the limit, 50 at
 * the tick's limit of ten, 100 at most). Only the first `limit` allowed runs are leased, so a paused run never takes a
 * slot of a live one. Every open run of every paused environment seen ends in this batch as `failed` with
 * `status_code` 402 (404 when not active), `finished_at` set, no lease and its attempt count unchanged, so no backlog
 * runs when credit or budget returns; its schedule stays and fires again at its next occurrence. Paused rows beyond
 * the window wait for a later claim, which always drains the window it sees.
 */
export async function claimScheduledFunctionRuns(
  context: CatalogContext,
  raw: unknown,
): Promise<readonly ClaimedFunctionRun[]> {
  const input = claimInput.parse(raw),
    db = context.directory;
  const columns = claimColumns.join(",");
  const staleBefore = addMilliseconds(input.now, -STALE_RUN_MILLISECONDS);
  return runCommand(db, {
    name: "functionsScheduler.claimRuns",
    input,
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      const rows = (
        await reader
          .prepare(
            `SELECT ${columns} FROM (SELECT ${columns},ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY scheduled_at,run_id) AS organization_rank FROM function_runs WHERE state IN ('due','retry','running') AND (state<>'running' OR lease_until<?1) AND attempt<3 AND (state='running' OR scheduled_at>=?3)) ORDER BY organization_rank,scheduled_at,run_id LIMIT ?2`,
          )
          .bind(input.now, claimWindow(input.limit), staleBefore)
          .all()
      ).results;
      // At most one decision read per environment; a failed read fails the claim, so nothing dispatches.
      const decisions = new Map<string, Promise<RuntimeDecision>>();
      const decisionOf = (row: RunRow) => {
        let decision = decisions.get(scopeOf(row));
        if (decision === undefined) {
          decision = routeOrganization(context, row["organization_id"] as string).then((route) =>
            readRuntimeDecision(route.db, {
              organizationId: row["organization_id"] as string,
              projectId: row["project_id"] as string,
              environmentId: row["environment_id"] as string,
              now: input.now,
            }),
          );
          decisions.set(scopeOf(row), decision);
        }
        return decision;
      };
      return Promise.all(rows.map(async (row) => ({ row, decision: await decisionOf(row) })));
    },
    decide: (scoped) => {
      // Parsing before any write preserves PostgreSQL's rollback when a stored origin cannot be decoded.
      const leased = scoped.filter(({ decision }) => decision.allowed).slice(0, input.limit);
      const leaseOf = (index: number) =>
        input.leaseMilliseconds?.[index] ?? DEFAULT_RUN_LEASE_MILLISECONDS;
      const claimed = Object.freeze(
        leased.map(({ row }, index) =>
          Object.freeze({
            runId: row["run_id"] as string,
            organizationId: row["organization_id"] as string,
            projectId: row["project_id"] as string,
            environmentId: row["environment_id"] as string,
            deploymentId: row["deployment_id"] as string,
            immutableScriptName: row["immutable_script_name"] as string,
            cron: row["cron"] as string,
            scheduledAt: publicTimestamp(row["scheduled_at"] as string),
            attempt: (row["attempt"] as number) + 1,
            leaseUntil: publicTimestamp(addMilliseconds(input.now, leaseOf(index))),
            egressAllowedOrigins: origins.parse(
              JSON.parse(row["egress_allowed_origins"] as string),
            ),
          }),
        ),
      );
      const statements = [
        guard(db, "bucket_fenced", "EXISTS(SELECT 1 FROM bucket_fences)"),
        db
          .prepare(
            "UPDATE function_runs SET state='failed',lease_until=NULL,finished_at=?1,status_code=NULL,updated_at=?1 WHERE state='running' AND lease_until<?1 AND attempt>=3",
          )
          .bind(input.now),
        // Missed occurrences end here, before any lease: they are recorded, never dispatched.
        db
          .prepare(
            "UPDATE function_runs SET state='skipped',lease_until=NULL,finished_at=?1,status_code=NULL,updated_at=?1 WHERE state IN ('due','retry') AND scheduled_at<?2",
          )
          .bind(input.now, staleBefore),
      ];
      for (const [index, { row }] of leased.entries())
        statements.push(
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM function_runs WHERE ${claimColumns.map((column, index) => `${column} IS ?${index + 1}`).join(" AND ")})`,
            claimColumns.map((column) => row[column]),
          ),
          db
            .prepare(
              "UPDATE function_runs SET state='running',attempt=attempt+1,lease_until=?2,started_at=COALESCE(started_at,?3),updated_at=?3 WHERE run_id=?1",
            )
            .bind(row["run_id"], addMilliseconds(input.now, leaseOf(index)), input.now),
        );
      // One statement per paused environment, whatever its rows in the window: it ends every open run of it.
      const paused = new Map<string, D1PreparedStatement>();
      for (const { row, decision } of scoped)
        if (!decision.allowed)
          paused.set(
            scopeOf(row),
            db
              .prepare(
                "UPDATE function_runs SET state='failed',lease_until=NULL,finished_at=?1,status_code=?2,updated_at=?1 WHERE organization_id=?3 AND environment_id=?4 AND (state IN ('due','retry') OR (state='running' AND lease_until<?1))",
              )
              .bind(
                input.now,
                pausedStatus(decision),
                row["organization_id"],
                row["environment_id"],
              ),
          );
      statements.push(...paused.values());
      return { statements, result: () => claimed };
    },
    lookup: async () => {
      throw new StoreOutcomeUnknownError("functionsScheduler.claimRuns: store_outcome_unknown");
    },
  });
}

/** Finish only the exact running attempt; stale completions remain harmless null results. */
export async function finishScheduledFunctionRun(
  context: CatalogContext,
  raw: unknown,
): Promise<"succeeded" | "retry" | "failed" | null> {
  const input = finishInput.parse(raw),
    db = context.directory;
  const state =
    input.outcome === "succeeded"
      ? "succeeded"
      : input.outcome === "rejected" || input.attempt >= 3
        ? "failed"
        : "retry";
  const results = await mutation(db, "finishRun", input, [
    db
      .prepare(
        "UPDATE function_runs SET state=?3,lease_until=NULL,status_code=?4,updated_at=?5,finished_at=CASE WHEN ?3 IN ('succeeded','failed') THEN ?5 ELSE NULL END WHERE run_id=?1 AND state='running' AND attempt=?2 RETURNING state",
      )
      .bind(input.runId, input.attempt, state, input.statusCode, input.now),
  ]);
  return results[0]?.results[0] ? state : null;
}

/** Seven-day cleanup touches terminal evidence only, preserving active and retry leases. */
export async function purgeScheduledFunctionRuns(
  context: CatalogContext,
  raw: unknown,
): Promise<number> {
  const input = z.strictObject({ before: timestamp }).parse(raw),
    db = context.directory;
  const results = await mutation(db, "purgeFinishedRuns", input, [
    db
      .prepare(
        "DELETE FROM function_runs WHERE state IN ('succeeded','failed','skipped') AND finished_at<?1",
      )
      .bind(input.before),
  ]);
  return results[0]?.meta.changes ?? 0;
}
