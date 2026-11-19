import { z } from "zod";
import { runCommand } from "../../run-command.js";
import { guard } from "../../guards.js";
import { shiftStored } from "../../timestamps.js";
import type { CatalogContext } from "../common.js";
import { routeOrganization, ulid, instant } from "../common.js";
import { reserve, releaseReservation, chargeOrg, stopBudgetGuard } from "../credit/index.js";
import { previewMailMetadataStatements } from "../runtime-secrets/platform.js";
import { authorizePreviewRuntime } from "./runtime.js";
import { fail, nowOf, rowById, runtimeFence, runtimeGuard, type PreviewRow } from "./common.js";

const intervalId = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/u);
const reservationInput = runtimeFence.extend({
  expectedRowVersion: z.number().int().positive().safe(),
  intervalId,
  applicationId: z
    .string()
    .regex(/^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u),
  seconds: z.number().int().min(1).max(60),
  holdSequence: z.number().int().positive().safe(),
  start: z.boolean(),
});
const closeInput = z.strictObject({
  previewId: ulid,
  runtimeGeneration: z.number().int().positive().safe(),
  intervalId,
  activeMilliseconds: z.number().int().nonnegative().safe(),
  containerStartAttempted: z.boolean(),
  now: instant.optional(),
  clock: z.literal("execution").optional(),
});
const settlementInput = closeInput
  .omit({ activeMilliseconds: true, containerStartAttempted: true })
  .extend({
    cpuMilliseconds: z.number().int().nonnegative().safe(),
    providerFactId: z.string().regex(/^[0-9a-f]{64}$/u),
    observedAt: instant,
  });
const METER = "preview.container.standard-3",
  RATE = "cloudflare-preview-standard-3-2026-11-09-v1";
// An internal shared query budget, not a statement of a provider's account-wide quota.
const RECONCILIATION_QUERIES_PER_MINUTE = 20;
const MINUTE = 60_000,
  HOUR = 60 * MINUTE;

function revisionDelay(now: string, closedAt: string): number {
  const age = Date.parse(now) - Date.parse(closedAt);
  return age < HOUR ? 5 * MINUTE : age < 24 * HOUR ? HOUR : 24 * HOUR;
}

function reconciliationDelay(row: PreviewRow, now: string): number {
  const pending = row["state"] === "awaiting_provider",
    base = pending ? MINUTE : revisionDelay(now, String(row["closed_at"])),
    ceiling = (pending ? 6 : 24) * HOUR;
  return Math.min(ceiling, base * 2 ** Math.min(Number(row["reconciliation_attempts"]), 16));
}
const PRICE = `SELECT c.rate_card_id,r.value rate FROM usage_meter_activations a
 JOIN published_credit_rate_cards c ON c.rate_card_id=a.rate_card_id,json_each(c.rates) r
 WHERE a.meter=?1 AND a.starts_at<=?2 AND c.published_at<=?2 AND c.effective_from<=?2
 AND a.starts_at=(SELECT MAX(latest.starts_at) FROM usage_meter_activations latest WHERE latest.meter=?1 AND latest.starts_at<=?2)
 AND json_extract(r.value,'$.meter')=?1 AND json_extract(r.value,'$.unit')='usd_pico'`;

/** Exact fixed provider tariff and the W41 credit conversion; only the final charge rounds up. */
export function previewChargeMicros(wallMs: number, cpuMs: number): number {
  const pico = BigInt(wallMs) * 21120n + BigInt(cpuMs) * 20000n;
  const result = (pico * 2300n + 6999999n) / 7000000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("preview_usage_out_of_range");
  return Number(result);
}
function quote(seconds: number) {
  return Math.max(1, previewChargeMicros(seconds * 1000, seconds * 2000));
}
async function price(db: CatalogContext["directory"], now: string) {
  const rows = (
      await db.prepare(PRICE).bind(METER, now).all<{ rate_card_id: string; rate: string }>()
    ).results,
    row = rows[0];
  const rate = row ? (JSON.parse(row.rate) as Record<string, unknown>) : null;
  if (
    rows.length !== 1 ||
    row?.rate_card_id !== RATE ||
    rate?.["units_per_charge"] !== "7000000" ||
    rate["credit_micros"] !== "2300" ||
    rate["provider_cost_micros"] !== "7"
  )
    fail("price_unavailable");
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(SELECT 1 FROM (${PRICE}) price WHERE price.rate_card_id=?3 AND price.rate=?4)`,
    [METER, now, RATE, row.rate],
  );
}
async function interval(db: CatalogContext["directory"], previewId: string, id: string) {
  return db
    .prepare("SELECT * FROM project_preview_usage_intervals WHERE preview_id=?1 AND interval_id=?2")
    .bind(previewId, id)
    .first<PreviewRow>();
}

/** One provider-labeled run; each rolling hold replaces its predecessor atomically. */
export async function reservePreviewUsage(context: CatalogContext, raw: unknown) {
  const i = reservationInput.parse(raw),
    now = nowOf(i),
    db = context.directory;
  const result = await runCommand(db, {
    name: "projectPreview.reserveUsage",
    input: {
      previewId: i.previewId,
      runtimeGeneration: i.runtimeGeneration,
      tokenGeneration: i.tokenGeneration,
      intervalId: i.intervalId,
      applicationId: i.applicationId,
      seconds: i.seconds,
      holdSequence: i.holdSequence,
      start: i.start,
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["project_preview_usage_intervals", "credit_reservation", "credit_log"],
    read: async (reader) => {
      const row = await rowById(reader, i.previewId);
      if (!row) fail("scope_unavailable");
      await routeOrganization(context, String(row["organization_id"]));
      return {
        row,
        existing: await interval(reader, i.previewId, i.intervalId),
        run: await reader
          .prepare(
            "SELECT application_id FROM project_preview_runs WHERE preview_id=?1 AND runtime_generation=?2",
          )
          .bind(i.previewId, i.runtimeGeneration + (i.start ? 1 : 0))
          .first<PreviewRow>(),
        priceGuard: await price(reader, now),
      };
    },
    decide: ({ row, existing, run, priceGuard }) => {
      if (existing && (!run || run["application_id"] !== i.applicationId))
        fail("usage_identity_conflict");
      const gen = i.runtimeGeneration + (i.start ? 1 : 0),
        amount = quote(i.seconds);
      if (
        existing &&
        Number(existing["runtime_generation"]) === gen &&
        Number(existing["hold_sequence"]) === i.holdSequence &&
        existing["state"] === "reserved"
      ) {
        if (Number(existing["seconds"]) !== i.seconds) fail("usage_identity_conflict");
        return {
          replay: {
            intervalId: i.intervalId,
            seconds: i.seconds,
            quotedMicros: Number(existing["quoted_micros"]),
          },
        };
      }
      if (
        (i.start && Number(row["row_version"]) !== i.expectedRowVersion) ||
        Number(row["runtime_generation"]) !== i.runtimeGeneration ||
        Number(row["token_generation"]) !== i.tokenGeneration ||
        row["retirement"] !== "none"
      )
        fail("version_conflict");
      if (
        i.start
          ? existing !== null ||
            i.holdSequence !== 1 ||
            !["cold", "sleeping"].includes(String(row["state"]))
          : !existing ||
            existing["state"] !== "reserved" ||
            Number(existing["runtime_generation"]) !== gen ||
            i.holdSequence !== Number(existing["hold_sequence"]) + 1 ||
            !["starting", "ready"].includes(String(row["state"]))
      )
        fail("usage_identity_conflict");
      const totalQuote = Number(existing?.["quoted_micros"] ?? 0) + amount;
      if (!Number.isSafeInteger(totalQuote)) fail("usage_out_of_range");
      const org = String(row["organization_id"]),
        project = String(row["project_id"]),
        reservationId = `project-preview:${i.previewId}:${gen}:${i.intervalId}:${i.holdSequence}`;
      const hold = reserve(db, {
        organizationId: org,
        projectId: project,
        reservationId,
        amountMicros: totalQuote,
        now,
        detail: {
          kind: "project_preview",
          previewId: i.previewId,
          intervalId: i.intervalId,
          holdSequence: i.holdSequence,
          seconds: i.seconds,
          rateCardId: RATE,
        },
      });
      const prior = existing
        ? releaseReservation(db, {
            organizationId: org,
            reservationId: String(existing["reservation_id"]),
            now,
            detail: {
              kind: "project_preview",
              previewId: i.previewId,
              intervalId: i.intervalId,
              holdSequence: Number(existing["hold_sequence"]),
            },
          }).statements
        : [];
      return {
        statements: [
          runtimeGuard(db, row, now, true),
          priceGuard,
          ...(existing
            ? [
                guard(
                  db,
                  "precondition_changed",
                  "NOT EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND interval_id=?2 AND runtime_generation=?3 AND state='reserved' AND hold_sequence=?4 AND reservation_id=?5)",
                  [
                    i.previewId,
                    i.intervalId,
                    gen,
                    existing["hold_sequence"],
                    existing["reservation_id"],
                  ],
                ),
              ]
            : [
                guard(
                  db,
                  "precondition_changed",
                  "EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND state='reserved')",
                  [i.previewId],
                ),
              ]),
          ...prior,
          stopBudgetGuard(db, { organizationId: org, projectId: project }, now, totalQuote),
          ...hold.statements,
          ...(i.start
            ? previewMailMetadataStatements(db, {
                organizationId: org,
                projectId: project,
                environmentId: String(row["environment_id"]),
              })
            : []),
          ...(i.start
            ? [
                db
                  .prepare(
                    "UPDATE project_previews SET state='starting',runtime_generation=?2,row_version=row_version+1,updated_at=?3 WHERE preview_id=?1",
                  )
                  .bind(i.previewId, gen, now),
                db
                  .prepare(
                    "INSERT INTO project_preview_runs(preview_id,runtime_generation,organization_id,project_id,environment_id,billing_epoch_id,application_id,started_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                  )
                  .bind(
                    i.previewId,
                    gen,
                    org,
                    project,
                    row["environment_id"],
                    row["billing_epoch_id"],
                    i.applicationId,
                    now,
                  ),
                db
                  .prepare(
                    "INSERT INTO project_preview_usage_intervals(preview_id,runtime_generation,interval_id,reservation_id,seconds,hold_sequence,quoted_micros,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'reserved',?8)",
                  )
                  .bind(
                    i.previewId,
                    gen,
                    i.intervalId,
                    reservationId,
                    i.seconds,
                    i.holdSequence,
                    amount,
                    now,
                  ),
              ]
            : [
                db
                  .prepare(
                    "UPDATE project_preview_usage_intervals SET reservation_id=?3,seconds=?4,hold_sequence=?5,quoted_micros=quoted_micros+?6 WHERE preview_id=?1 AND interval_id=?2 AND state='reserved'",
                  )
                  .bind(
                    i.previewId,
                    i.intervalId,
                    reservationId,
                    i.seconds,
                    i.holdSequence,
                    amount,
                  ),
              ]),
        ],
        result: () => ({ intervalId: i.intervalId, seconds: i.seconds, quotedMicros: totalQuote }),
      };
    },
    lookup: async (reader) => {
      const r = await interval(reader, i.previewId, i.intervalId);
      const run = await reader
        .prepare(
          "SELECT application_id FROM project_preview_runs WHERE preview_id=?1 AND runtime_generation=?2",
        )
        .bind(i.previewId, i.runtimeGeneration + (i.start ? 1 : 0))
        .first<PreviewRow>();
      return r &&
        run?.["application_id"] === i.applicationId &&
        Number(r["runtime_generation"]) === i.runtimeGeneration + (i.start ? 1 : 0) &&
        Number(r["hold_sequence"]) === i.holdSequence &&
        Number(r["seconds"]) === i.seconds &&
        r["state"] === "reserved"
        ? { intervalId: i.intervalId, seconds: i.seconds, quotedMicros: Number(r["quoted_micros"]) }
        : undefined;
    },
  });
  const preview = await authorizePreviewRuntime(context, {
    previewId: i.previewId,
    runtimeGeneration: i.runtimeGeneration + (i.start ? 1 : 0),
    tokenGeneration: i.tokenGeneration,
    ...(i.now ? { now: i.now } : {}),
    ...(i.clock ? { clock: i.clock } : {}),
  });
  if (!preview) fail("scope_unavailable");
  return { ...result, preview };
}

/** Charge trusted awake wall time and release the hold; missing provider CPU stays unknown. */
export async function closePreviewUsage(context: CatalogContext, raw: unknown) {
  const i = closeInput.parse(raw),
    now = nowOf(i),
    db = context.directory;
  if (!i.containerStartAttempted && i.activeMilliseconds !== 0) fail("usage_invalid");
  await runCommand(db, {
    name: "projectPreview.closeUsage",
    input: {
      previewId: i.previewId,
      runtimeGeneration: i.runtimeGeneration,
      intervalId: i.intervalId,
      activeMilliseconds: i.activeMilliseconds,
      containerStartAttempted: i.containerStartAttempted,
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["credit_log"],
    read: async (reader) => {
      const r = await interval(reader, i.previewId, i.intervalId);
      if (!r || Number(r["runtime_generation"]) !== i.runtimeGeneration) fail("usage_unknown");
      const run = await reader
        .prepare("SELECT * FROM project_preview_runs WHERE preview_id=?1 AND runtime_generation=?2")
        .bind(i.previewId, i.runtimeGeneration)
        .first<PreviewRow>();
      if (!run) fail("usage_unknown");
      await routeOrganization(context, String(run["organization_id"]));
      return { r, run };
    },
    decide: ({ r, run }) => {
      if (r["state"] !== "reserved") {
        if (
          Number(r["active_milliseconds"]) !== i.activeMilliseconds ||
          Number(r["container_start_attempted"]) !== Number(i.containerStartAttempted)
        )
          fail("usage_identity_conflict");
        return { replay: true };
      }
      const release = releaseReservation(db, {
        organizationId: String(run["organization_id"]),
        reservationId: String(r["reservation_id"]),
        now,
        detail: {
          kind: "project_preview",
          previewId: i.previewId,
          intervalId: i.intervalId,
          awaitingProvider: i.containerStartAttempted,
        },
      });
      const observedWall = i.containerStartAttempted
          ? previewChargeMicros(i.activeMilliseconds, 0)
          : 0,
        chargedWall = Math.min(observedWall, Number(r["quoted_micros"]));
      const wallCharge =
        chargedWall === 0
          ? []
          : chargeOrg(db, {
              organizationId: String(run["organization_id"]),
              key: `project-preview:wall:${i.previewId}:${i.runtimeGeneration}:${i.intervalId}`,
              amountMicros: chargedWall,
              now,
              projects: [{ projectId: String(run["project_id"]), amountMicros: chargedWall }],
              detail: {
                kind: "project_preview",
                previewId: i.previewId,
                intervalId: i.intervalId,
                activeMilliseconds: i.activeMilliseconds,
                cpuMilliseconds: null,
                providerQuantityPicoUsd: (BigInt(i.activeMilliseconds) * 21120n).toString(),
                platformOverrunMicros: observedWall - chargedWall,
                rateCardId: RATE,
              },
            }).statements;
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3 AND state='reserved')",
            [i.previewId, i.runtimeGeneration, i.intervalId],
          ),
          ...release.statements,
          ...wallCharge,
          db
            .prepare(
              "UPDATE project_preview_usage_intervals SET state=CASE WHEN ?6=1 THEN 'awaiting_provider' ELSE 'unstarted' END,container_start_attempted=?6,active_milliseconds=?4,charged_micros=?7,closed_at=?5,resolved_at=CASE WHEN ?6=1 THEN NULL ELSE ?5 END,reconciliation_next_at=CASE WHEN ?6=1 THEN ?5 ELSE NULL END WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3 AND state='reserved'",
            )
            .bind(
              i.previewId,
              i.runtimeGeneration,
              i.intervalId,
              i.activeMilliseconds,
              now,
              Number(i.containerStartAttempted),
              chargedWall,
            ),
        ],
        result: () => true,
      };
    },
    lookup: async (reader) => {
      const r = await interval(reader, i.previewId, i.intervalId);
      return r &&
        r["state"] !== "reserved" &&
        Number(r["runtime_generation"]) === i.runtimeGeneration &&
        Number(r["active_milliseconds"]) === i.activeMilliseconds &&
        Number(r["container_start_attempted"]) === Number(i.containerStartAttempted)
        ? true
        : undefined;
    },
  });
}

/**
 * Atomically claim due provider reads and advance their durable retry time before any provider I/O.
 * Pending facts get four of every five budget slots; revisions get the fifth, with idle shares reused.
 * Oldest due work wins within each queue. A failed/missing read needs no completion RPC to be retried.
 */
export async function listPreviewUsageForReconciliation(context: CatalogContext, raw: unknown) {
  const i = z
    .strictObject({
      limit: z.number().int().min(1).max(100),
      after: z
        .strictObject({
          previewId: ulid,
          runtimeGeneration: z.number().int().positive().safe(),
          intervalId,
        })
        .optional(),
      now: instant.optional(),
      clock: z.literal("execution").optional(),
    })
    .parse(raw);
  const now = nowOf(i),
    minute = `${now.slice(0, 16)}:00.000000Z`,
    db = context.directory;
  // The old pagination hint is accepted during this unpublished migration; due ordering owns fairness.
  return runCommand(db, {
    name: "projectPreview.claimUsageReconciliation",
    input: i,
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      const budget = await reader
        .prepare(
          "SELECT reconciliation_budget_minute,reconciliation_budget_used FROM project_preview_usage_cursor WHERE singleton=1",
        )
        .first<PreviewRow>();
      if (!budget) fail("usage_unknown");
      const budgetMinute = budget["reconciliation_budget_minute"],
        used =
          budgetMinute === minute
            ? Number(budget["reconciliation_budget_used"])
            : budgetMinute === null || String(budgetMinute) < minute
              ? 0
              : RECONCILIATION_QUERIES_PER_MINUTE,
        capacity = Math.min(i.limit, RECONCILIATION_QUERIES_PER_MINUTE - used);
      const due = async (state: string) =>
        capacity === 0
          ? []
          : (
              await reader
                .prepare(
                  `SELECT u.*,r.organization_id,r.project_id,r.application_id
          FROM project_preview_usage_intervals u JOIN project_preview_runs r USING(preview_id,runtime_generation)
          WHERE u.state=?1 AND u.state IN ('awaiting_provider','settled') AND u.reconciliation_next_at<=?2
          ORDER BY u.reconciliation_next_at,u.preview_id,u.runtime_generation,u.interval_id LIMIT ?3`,
                )
                .bind(state, now, capacity)
                .all<PreviewRow>()
            ).results;
      const [pending, settled] = await Promise.all([due("awaiting_provider"), due("settled")]);
      return { budget, used, capacity, pending, settled };
    },
    decide: ({ budget, used, capacity, pending, settled }) => {
      const revisionSlots = Math.floor((used + capacity) / 5) - Math.floor(used / 5),
        pendingCount = Math.min(pending.length, capacity - revisionSlots),
        revisions = settled.slice(0, capacity - pendingCount),
        rows = [
          ...pending.slice(0, pendingCount),
          ...revisions,
          ...pending.slice(pendingCount, capacity - revisions.length),
        ];
      const result = rows.map((r) => ({
        previewId: String(r["preview_id"]),
        runtimeGeneration: Number(r["runtime_generation"]),
        intervalId: String(r["interval_id"]),
        applicationId: String(r["application_id"]),
        organizationId: String(r["organization_id"]),
        projectId: String(r["project_id"]),
        activeMilliseconds: Number(r["active_milliseconds"]),
        startedAt: String(r["created_at"]),
        closedAt: String(r["closed_at"]),
        state: r["state"] as "awaiting_provider" | "settled",
        cpuMilliseconds: r["cpu_milliseconds"] === null ? null : Number(r["cpu_milliseconds"]),
        providerFactId: r["provider_fact_id"] === null ? null : String(r["provider_fact_id"]),
        observedAt: r["provider_observed_at"] === null ? null : String(r["provider_observed_at"]),
      }));
      if (rows.length === 0) return { replay: result };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_preview_usage_cursor WHERE singleton=1 AND reconciliation_budget_minute IS ?1 AND reconciliation_budget_used=?2)",
            [budget["reconciliation_budget_minute"], budget["reconciliation_budget_used"]],
          ),
          ...rows.map((r) =>
            guard(
              db,
              "precondition_changed",
              "NOT EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3 AND state=?4 AND reconciliation_next_at=?5 AND reconciliation_attempts=?6)",
              [
                r["preview_id"],
                r["runtime_generation"],
                r["interval_id"],
                r["state"],
                r["reconciliation_next_at"],
                r["reconciliation_attempts"],
              ],
            ),
          ),
          db
            .prepare(
              "UPDATE project_preview_usage_cursor SET reconciliation_budget_minute=?1,reconciliation_budget_used=?2 WHERE singleton=1",
            )
            .bind(minute, used + rows.length),
          ...rows.map((r) =>
            db
              .prepare(
                "UPDATE project_preview_usage_intervals SET reconciliation_next_at=?4,last_reconciliation_at=?5,reconciliation_attempts=min(reconciliation_attempts+1,32) WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3",
              )
              .bind(
                r["preview_id"],
                r["runtime_generation"],
                r["interval_id"],
                shiftStored(now, reconciliationDelay(r, now)),
                now,
              ),
          ),
        ],
        result: () => result,
      };
    },
  });
}

/** Provider reports cumulative CPU for one labeled run; only a positive correction is charged. */
export async function observePreviewUsage(context: CatalogContext, raw: unknown) {
  const i = settlementInput.parse(raw),
    now = nowOf(i),
    db = context.directory;
  if (Date.parse(i.observedAt) > Date.parse(now)) fail("usage_observation_time_invalid");
  return runCommand(db, {
    name: "projectPreview.observeProviderUsage",
    input: i,
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["credit_log", "project_preview_usage_observations"],
    read: async (reader) => {
      const r = await interval(reader, i.previewId, i.intervalId);
      if (!r || Number(r["runtime_generation"]) !== i.runtimeGeneration) fail("usage_unknown");
      const run = await reader
        .prepare("SELECT * FROM project_preview_runs WHERE preview_id=?1 AND runtime_generation=?2")
        .bind(i.previewId, i.runtimeGeneration)
        .first<PreviewRow>();
      if (!run) fail("usage_unknown");
      const observation = await reader
        .prepare(
          "SELECT cpu_milliseconds,observed_at FROM project_preview_usage_observations WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3 AND provider_fact_id=?4",
        )
        .bind(i.previewId, i.runtimeGeneration, i.intervalId, i.providerFactId)
        .first<PreviewRow>();
      await routeOrganization(context, String(run["organization_id"]));
      return { r, run, observation };
    },
    decide: ({ r, run, observation }) => {
      if (r["state"] === "reserved") fail("usage_not_closed");
      if (r["state"] === "unstarted") fail("usage_unstarted");
      const activeMilliseconds = Number(r["active_milliseconds"]),
        priorCpu = r["cpu_milliseconds"] === null ? null : Number(r["cpu_milliseconds"]),
        priorCharge = Number(r["charged_micros"]);
      if (observation) {
        if (
          Number(observation["cpu_milliseconds"]) !== i.cpuMilliseconds ||
          observation["observed_at"] !== i.observedAt
        )
          fail("usage_identity_conflict");
        if (priorCpu === null) fail("usage_identity_conflict");
        return {
          replay: {
            intervalId: i.intervalId,
            activeMilliseconds,
            cpuMilliseconds: priorCpu,
            chargedMicros: priorCharge,
          },
        };
      }
      const nextCpu = Math.max(priorCpu ?? i.cpuMilliseconds, i.cpuMilliseconds),
        observed = previewChargeMicros(activeMilliseconds, nextCpu),
        charged = Math.min(observed, Number(r["quoted_micros"])),
        delta = Math.max(0, charged - priorCharge);
      const charge =
        delta === 0
          ? []
          : chargeOrg(db, {
              organizationId: String(run["organization_id"]),
              key: `project-preview:observe:${i.previewId}:${i.runtimeGeneration}:${i.intervalId}:${i.providerFactId}`,
              amountMicros: delta,
              now,
              projects: [{ projectId: String(run["project_id"]), amountMicros: delta }],
              detail: {
                kind: "project_preview",
                previewId: i.previewId,
                intervalId: i.intervalId,
                activeMilliseconds,
                cpuMilliseconds: nextCpu,
                providerFactId: i.providerFactId,
                providerQuantityPicoUsd: (
                  BigInt(activeMilliseconds) * 21120n +
                  BigInt(nextCpu) * 20000n
                ).toString(),
                platformOverrunMicros: observed - charged,
                rateCardId: RATE,
              },
            }).statements;
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM project_preview_usage_intervals WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3 AND state=?4 AND cpu_milliseconds IS ?5 AND charged_micros IS ?6)",
            [
              i.previewId,
              i.runtimeGeneration,
              i.intervalId,
              r["state"],
              r["cpu_milliseconds"],
              r["charged_micros"],
            ],
          ),
          ...charge,
          db
            .prepare(
              "INSERT INTO project_preview_usage_observations(preview_id,runtime_generation,interval_id,provider_fact_id,cpu_milliseconds,observed_at,charged_delta_micros) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            )
            .bind(
              i.previewId,
              i.runtimeGeneration,
              i.intervalId,
              i.providerFactId,
              i.cpuMilliseconds,
              i.observedAt,
              delta,
            ),
          db
            .prepare(
              "UPDATE project_preview_usage_intervals SET reconciliation_attempts=0,reconciliation_next_at=?4,last_reconciliation_at=?5 WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3",
            )
            .bind(
              i.previewId,
              i.runtimeGeneration,
              i.intervalId,
              shiftStored(now, revisionDelay(now, String(r["closed_at"]))),
              now,
            ),
          ...(priorCpu === null || i.cpuMilliseconds > priorCpu
            ? [
                db
                  .prepare(
                    "UPDATE project_preview_usage_intervals SET state='settled',cpu_milliseconds=?4,charged_micros=?5,provider_fact_id=?6,provider_observed_at=?7,resolved_at=?8 WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3",
                  )
                  .bind(
                    i.previewId,
                    i.runtimeGeneration,
                    i.intervalId,
                    nextCpu,
                    charged,
                    i.providerFactId,
                    i.observedAt,
                    now,
                  ),
              ]
            : []),
        ],
        result: () => ({
          intervalId: i.intervalId,
          activeMilliseconds,
          cpuMilliseconds: nextCpu,
          chargedMicros: charged,
        }),
      };
    },
    lookup: async (reader) => {
      const observation = await reader
          .prepare(
            "SELECT cpu_milliseconds,observed_at FROM project_preview_usage_observations WHERE preview_id=?1 AND runtime_generation=?2 AND interval_id=?3 AND provider_fact_id=?4",
          )
          .bind(i.previewId, i.runtimeGeneration, i.intervalId, i.providerFactId)
          .first<PreviewRow>(),
        r = await interval(reader, i.previewId, i.intervalId);
      return observation &&
        Number(observation["cpu_milliseconds"]) === i.cpuMilliseconds &&
        observation["observed_at"] === i.observedAt &&
        r
        ? {
            intervalId: i.intervalId,
            activeMilliseconds: Number(r["active_milliseconds"]),
            cpuMilliseconds: Number(r["cpu_milliseconds"]),
            chargedMicros: Number(r["charged_micros"]),
          }
        : undefined;
    },
  });
}

const cursor = z.strictObject({
  previewId: ulid,
  runtimeGeneration: z.number().int().positive().safe(),
  intervalId,
});
/** Retained pagination receipt; due-work claims now own periodic reconciliation fairness. */
export async function getPreviewUsageReconciliationCursor(context: CatalogContext, raw: unknown) {
  z.undefined().parse(raw);
  const r = await context.directory
    .prepare(
      "SELECT preview_id,runtime_generation,interval_id FROM project_preview_usage_cursor WHERE singleton=1",
    )
    .first<PreviewRow>();
  if (!r || r["preview_id"] === null) return null;
  return {
    previewId: String(r["preview_id"]),
    runtimeGeneration: Number(r["runtime_generation"]),
    intervalId: String(r["interval_id"]),
  };
}
export async function setPreviewUsageReconciliationCursor(context: CatalogContext, raw: unknown) {
  const i = z.strictObject({ expected: cursor.nullable(), next: cursor.nullable() }).parse(raw),
    db = context.directory;
  await db.batch([
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM project_preview_usage_cursor WHERE singleton=1 AND preview_id IS ?1 AND runtime_generation IS ?2 AND interval_id IS ?3)",
      [
        i.expected?.previewId ?? null,
        i.expected?.runtimeGeneration ?? null,
        i.expected?.intervalId ?? null,
      ],
    ),
    db
      .prepare(
        "UPDATE project_preview_usage_cursor SET preview_id=?1,runtime_generation=?2,interval_id=?3 WHERE singleton=1",
      )
      .bind(
        i.next?.previewId ?? null,
        i.next?.runtimeGeneration ?? null,
        i.next?.intervalId ?? null,
      ),
  ]);
}
