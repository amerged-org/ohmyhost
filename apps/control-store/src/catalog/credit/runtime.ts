import { z } from "zod";

import type { D1Database } from "../../d1-types.js";
import { classifyFailure, guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import {
  addMilliseconds,
  instant,
  publicTimestamp,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { CREDIT_GRACE_MS, OVERRUN_CEILING_MICROS, monthPeriod, readAccount } from "./account.js";
import { createAttributionCommands } from "./attribution.js";
import { runChargeOrg } from "./spend.js";

/** The usage sources whose cursors the credit service keeps. */
export const USAGE_SOURCES = ["wfp", "pgcf", "r2", "resources"] as const;
const source = z.enum(USAGE_SOURCES);

const usageLineFields = {
  projectId: ulid,
  meter: z.string().min(1).max(128),
  quantity: z.string().regex(/^\d{1,30}(\.\d{1,12})?$/u),
  unit: z.string().min(1).max(64),
  rateCardId: z.string().min(1).max(128),
  chargeMicros: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
};
const usageLine = z.union([
  z.strictObject({ ...usageLineFields, environmentId: ulid }),
  z.strictObject({
    ...usageLineFields,
    environmentId: z.null(),
    resourceKind: z.literal("native_auth_database"),
  }),
]);

/**
 * One posting is the usage of an organization in a window, whole or one part of it. A window is booked in ONE layout:
 * whole (the key `usage:<source>:<org>:<window>`, which every row posted before parts existed has, and no part or layout
 * in the posting) or split by the credit service into parts 0 to 255 (`split: true`; the key of a part above 0 adds
 * `:p<part>`). The layout of the first posting of a window is the layout of the window.
 */
const postingFields = {
  organizationId: ulid,
  source,
  window: instant,
  part: z.number().int().min(0).max(255).default(0),
  split: z.boolean().default(false),
};
const partNeedsSplit = (posting: { part: number; split: boolean }) =>
  posting.part === 0 || posting.split;
const postUsageInput = z
  .strictObject({ ...postingFields, lines: z.array(usageLine).max(2000) })
  .refine(partNeedsSplit, { message: "a part above 0 belongs to a split window" });
/** A posting the service could not book. Its lines are kept as they were sent: they may be the reason it failed. */
const usageFailureInput = z
  .strictObject({
    ...postingFields,
    lines: z.array(z.unknown()).max(2000),
    reason: z.string().min(1).max(200),
    /** Attempts after which the posting is dead: the cursor may pass it and the replay takes over. */
    limit: z.number().int().min(1).max(1000),
    /** A posting that cannot succeed by repeating it is dead at once. */
    immediate: z.boolean(),
  })
  .refine(partNeedsSplit, { message: "a part above 0 belongs to a split window" });
const replayInput = z.strictObject({
  minAttempts: z.number().int().min(1).max(1000),
  limit: z.number().int().min(1).max(100),
});

type UsagePosting = z.infer<typeof postUsageInput>;
type Layout = "whole" | "split";

/** The `credit_log.key` of one posting: part 0 keeps the key of a window posted whole. */
const usageKey = (posting: Pick<UsagePosting, "source" | "organizationId" | "window" | "part">) =>
  `usage:${posting.source}:${posting.organizationId}:${posting.window}${posting.part > 0 ? `:p${String(posting.part)}` : ""}`;

const failureReason = (error: unknown): string =>
  (error instanceof Error ? error.message : "unknown").slice(0, 200) || "unknown";

/** The keys of one window are `base` and `base:p<part>`; ";" is the character after ":". */
type WindowOf = Pick<UsagePosting, "source" | "organizationId" | "window">;
const windowKeys = (posting: WindowOf): readonly [string, string] => {
  const base = usageKey({ ...posting, part: 0 });
  return [base, `${base};`];
};

/** True when a booked row of the window has another layout than `split` (1 split, 0 whole); the keys bound to `from` and `to`. */
const otherLayoutBooked = (from: string, to: string, split: string): string =>
  `EXISTS (SELECT 1 FROM credit_log WHERE key >= ${from} AND key < ${to}
    AND COALESCE(json_extract(detail, '$.split'), 0) <> CAST(${split} AS INTEGER))`;

/** The Core refuses a native Auth line anywhere but in the PGCF memory meter. */
const invalidNativeUsage = (posting: UsagePosting): boolean =>
  posting.lines.some(
    (line) =>
      "resourceKind" in line &&
      (posting.source !== "pgcf" ||
        line.meter !== "pgcf.memory.active" ||
        line.unit !== "memory_mib_milliseconds"),
  );

/** Whether `postUsage` would refuse the lines of a kept posting, whatever the error the caller saw looked like. */
const refusedPosting = (posting: Omit<UsagePosting, "lines"> & { lines: unknown[] }): boolean => {
  const { organizationId, source, window, part, split, lines } = posting;
  const parsed = postUsageInput.safeParse({ organizationId, source, window, part, split, lines });
  return !parsed.success || invalidNativeUsage(parsed.data);
};

/** A kept posting that failed a replay waits 30 minutes, then twice as long each time, at most a day. */
const REPLAY_BACKOFF_MS = 30 * 60_000;
const REPLAY_BACKOFF_MAX_MS = 24 * 60 * 60_000;
/** The kept postings looked at per replay, oldest failure first, and the most one call books. */
const REPLAY_SCAN = 500;
const REPLAY_MAX = 100;
const replayDelay = (failedReplays: number): number =>
  failedReplays <= 0
    ? 0
    : Math.min(REPLAY_BACKOFF_MS * 2 ** (failedReplays - 1), REPLAY_BACKOFF_MAX_MS);

const afterInput = z.strictObject({
  beforeAt: instant,
  afterSeq: z.number().int().min(0),
  limit: z.number().int().min(1).max(5000),
});

export interface LogRow {
  readonly seq: number;
  readonly key: string;
  readonly at: string;
  readonly organizationId: string;
  readonly kind: string;
  readonly deltaMicros: number;
  readonly balanceMicros: number;
  readonly detail: unknown;
}

interface LogRecord {
  readonly seq: number;
  readonly key: string;
  readonly at: string;
  readonly organization_id: string;
  readonly kind: string;
  readonly delta_micros: number;
  readonly balance_micros: number;
  readonly detail: string;
}

const LOG_SELECT =
  "SELECT seq, key, at, organization_id, kind, delta_micros, balance_micros, detail FROM credit_log";

/** A row as the credit service reads it: every instant crossing the binding is a `Date.toISOString()` string. */
const logRow = (row: LogRecord): LogRow => ({
  seq: row.seq,
  key: row.key,
  at: publicTimestamp(row.at),
  organizationId: row.organization_id,
  kind: row.kind,
  deltaMicros: row.delta_micros,
  balanceMicros: row.balance_micros,
  detail: JSON.parse(row.detail) as unknown,
});

/** Store-owned layout and bucket fence; each command below keeps its own input contract. */
export type BindCreditCommand = <Result>(
  command: (context: CatalogContext, input: unknown) => Promise<Result>,
) => (input?: unknown) => Promise<Result>;

const SCRIPT_CHUNK = 500;

/** The most projects one sweep of the stop budgets asks the platform to disable; the rest follow on later passes. */
export const STOP_BUDGET_PROJECT_LIMIT = 50;
/** The most projects one sweep asks the platform to disable because their organization is past its credit grace. */
export const CREDIT_DENIED_PROJECT_LIMIT = 50;

const defaultClock = () => storedTimestamp(new Date().toISOString());

/**
 * The commands of the `CreditRuntime` entrypoint, the credit service's whole view of the Core: post the usage of a
 * window, keep the cursor of every source, resolve scripts to their owner, read the prices in force and page the
 * credit log out for rotation. Time is the Core's own clock; a caller cannot name it.
 */
export function createCreditCommands(bind: BindCreditCommand, clock: () => string = defaultClock) {
  /** The layout the first posting of the window gave it; null while nothing of it is booked. */
  async function bookedLayout(db: D1Database, posting: WindowOf): Promise<Layout | null> {
    const [from, to] = windowKeys(posting);
    const row = await db
      .prepare(
        "SELECT json_extract(detail, '$.split') AS split FROM credit_log WHERE key >= ?1 AND key < ?2 LIMIT 1",
      )
      .bind(from, to)
      .first<{ split: number | null }>();
    return row === null ? null : row.split === 1 ? "split" : "whole";
  }

  /**
   * Books one validated posting; `replay` files it at the Core's clock instead of under its window. A window is booked
   * in ONE layout. The check in the booking batch itself (a guard on the booked rows of the window) is what makes it
   * so: two invocations that overlap cannot both book, because the second batch sees the first one's rows and fails
   * on the guard; the read before it is only the fast path. A posting of the other layout books nothing and names the
   * booked layout. The same batch removes the failure kept for the key and the failures kept for the other layout of
   * the window, so a kept posting is never in another layout than the booked one and never for a key that is booked:
   * that holds also after the rows of the window have been rotated away, which is why a replay long after the
   * rotation cannot book a window a second time.
   */
  async function postPart(
    context: CatalogContext,
    input: UsagePosting,
    replay: boolean,
  ): Promise<{ posted: boolean; balanceMicros: number; layout?: Layout }> {
    if (invalidNativeUsage(input)) throw new TypeError("invalid_native_auth_usage");
    const db = (await routeOrganization(context, input.organizationId)).db;
    const now = clock();
    const key = usageKey(input);
    const layout: Layout = input.split ? "split" : "whole";
    // The kept failures are the credit service's own bookkeeping, not the organization's account: they are written on the
    // raw Core route, never behind the bucket fence of the organization, or a quarantined bucket would stop them.
    const kept = async () => (await context.router.routeShard(0)).db;
    const drop = async () => {
      await (await kept()).prepare("DELETE FROM usage_post_failure WHERE key = ?1").bind(key).run();
    };
    const refuse = async (booked: Layout) => {
      const account = await readAccount(db, input.organizationId, now);
      await drop();
      return { posted: false, balanceMicros: account.balanceMicros, layout: booked };
    };
    if (input.lines.length === 0) {
      const account = await readAccount(db, input.organizationId, now);
      await drop();
      return { posted: false, balanceMicros: account.balanceMicros };
    }
    const booked = await bookedLayout(db, input);
    if (booked !== null && booked !== layout) return refuse(booked);
    const perProject = new Map<string, number>();
    let total = 0;
    for (const line of input.lines) {
      total += line.chargeMicros;
      perProject.set(line.projectId, (perProject.get(line.projectId) ?? 0) + line.chargeMicros);
    }
    const [from, to] = windowKeys(input);
    let result;
    try {
      result = await runChargeOrg(db, {
        organizationId: input.organizationId,
        key,
        amountMicros: total,
        now,
        at: replay ? now : input.window,
        detail: {
          source: input.source,
          window: publicTimestamp(input.window),
          ...(input.split ? { split: true, part: input.part } : {}),
          ...(replay ? { replayed: true } : {}),
          lines: input.lines,
        },
        projects: [...perProject].map(([projectId, amountMicros]) => ({ projectId, amountMicros })),
        // `precondition_changed`: the layout read before the batch no longer holds
        guards: [
          guard(db, "precondition_changed", otherLayoutBooked("?1", "?2", "?3"), [
            from,
            to,
            input.split ? 1 : 0,
          ]),
        ],
        after: [
          db
            .prepare(
              `DELETE FROM usage_post_failure WHERE organization_id = ?1 AND source = ?2 AND window_start = ?3
               AND (key = ?4 OR split <> CAST(?5 AS INTEGER)) AND EXISTS (SELECT 1 FROM credit_log WHERE key = ?4)`,
            )
            .bind(input.organizationId, input.source, input.window, key, input.split ? 1 : 0),
        ],
      });
    } catch (error) {
      const failure = classifyFailure(error);
      if (failure.kind === "guard" && failure.code === "precondition_changed") {
        const now = await bookedLayout(db, input);
        if (now !== null && now !== layout) return refuse(now);
      }
      throw error;
    }
    // booked now or before (the key is in the log), not merely answered without a booking
    await (await kept())
      .prepare(
        "DELETE FROM usage_post_failure WHERE key = ?1 AND EXISTS (SELECT 1 FROM credit_log WHERE key = ?1)",
      )
      .bind(key)
      .run();
    return { posted: result.posted, balanceMicros: result.balanceMicros };
  }

  return Object.freeze({
    ...createAttributionCommands(bind),

    /**
     * Posts one posting of a window of one source for one organization once; the log key makes a repeat change nothing.
     * The row is filed under the START of the window (`at`), the time the usage happened, so that the report and the
     * rotation by day see it on the right day; its `seq` is the order of posting, which is not the order of `at`.
     * A posting of the other layout than the one booked for the window books nothing and answers with `layout`.
     */
    postUsage: bind(async (context, raw) => postPart(context, postUsageInput.parse(raw), false)),

    /**
     * Keeps a posting the service could not book, with the lines of its latest attempt, and counts the attempt. The
     * posting is dead (its `attempts` is at least `limit`) when it cannot succeed by repeating it, and when the
     * organization already has a dead posting for the source: its later windows then do not wait again. The Core
     * judges the lines itself (`immediate` is only the caller's own word), because the identity of the error is lost
     * on its way over the binding. The service lets the cursor pass a dead posting, so this row is what keeps it from
     * being lost. A posting is not kept when its key is booked (`settled: "booked"`) or the window is booked in
     * another layout (`settled: "superseded"`): there is nothing left to replay, and a replay after the rotation of
     * the window's rows could not tell.
     */
    recordUsageFailure: bind(async (context, raw) => {
      const input = usageFailureInput.parse(raw);
      // on the raw Core route: the failure of an organization whose bucket is fenced must still be kept, or it would
      // hold the cursor of every other organization. The statements read `credit_log` of the same database.
      const db = (await context.router.routeShard(0)).db;
      const key = usageKey(input);
      const [from, to] = windowKeys(input);
      const dead =
        input.immediate ||
        refusedPosting(input) ||
        (await db
          .prepare(
            `SELECT 1 AS found FROM usage_post_failure
             WHERE organization_id = ?1 AND source = ?2 AND attempts >= CAST(?3 AS INTEGER) AND key <> ?4 LIMIT 1`,
          )
          .bind(input.organizationId, input.source, input.limit, key)
          .first()) !== null;
      const row = await db
        .prepare(
          `INSERT INTO usage_post_failure(key, organization_id, source, window_start, part, split, attempts, reason, lines, first_failed_at, last_failed_at)
           SELECT ?1, ?2, ?3, ?4, CAST(?5 AS INTEGER), CAST(?6 AS INTEGER), MAX(CAST(?7 AS INTEGER), 1), ?8, ?9, ?10, ?10
           WHERE NOT EXISTS (SELECT 1 FROM credit_log WHERE key = ?1)
             AND NOT ${otherLayoutBooked("?11", "?12", "?6")}
           ON CONFLICT(key) DO UPDATE SET attempts = MAX(CAST(?7 AS INTEGER), attempts + 1), reason = excluded.reason,
             lines = excluded.lines, split = excluded.split, last_failed_at = excluded.last_failed_at
           RETURNING attempts`,
        )
        .bind(
          key,
          input.organizationId,
          input.source,
          input.window,
          input.part,
          input.split ? 1 : 0,
          dead ? input.limit : 0,
          input.reason,
          JSON.stringify(input.lines),
          clock(),
          from,
          to,
        )
        .first<{ attempts: number }>();
      if (row !== null) return { attempts: row.attempts, dead: row.attempts >= input.limit };
      await db.prepare("DELETE FROM usage_post_failure WHERE key = ?1").bind(key).run();
      const booked = await bookedLayout(db, input);
      return {
        attempts: 0,
        dead: false,
        settled:
          booked !== null && booked !== (input.split ? "split" : "whole") ? "superseded" : "booked",
      } as const;
    }),

    /**
     * Books the kept postings that reached `minAttempts`, filed at the Core's clock because the day of their window may
     * have been rotated already; the key is the original one, so a posting that was booked after all is not charged
     * twice. The oldest failure goes first and a posting that fails again goes to the back and waits (30 minutes,
     * doubling to a day), so postings that fail for good cannot keep a healthy one from being tried. A call books at
     * most `limit` postings, more while many are due (a fifth of them, at most 100). A posting without lines cannot be
     * booked and stays for an operator. `remaining` counts every kept posting at or beyond the limit.
     */
    replayUsageFailures: bind(async (context, raw) => {
      const input = replayInput.parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const now = Date.parse(publicTimestamp(clock()));
      const kept = await db
        .prepare(
          `SELECT key, attempts, last_failed_at FROM usage_post_failure
           WHERE attempts >= CAST(?1 AS INTEGER) AND lines <> '[]'
           ORDER BY last_failed_at, key LIMIT ${String(REPLAY_SCAN)}`,
        )
        .bind(input.minAttempts)
        .all<{ key: string; attempts: number; last_failed_at: string }>();
      const due = kept.results.filter(
        (row) =>
          Date.parse(publicTimestamp(row.last_failed_at)) +
            replayDelay(row.attempts - input.minAttempts) <=
          now,
      );
      let replayed = 0;
      for (const { key } of due.slice(
        0,
        Math.min(REPLAY_MAX, Math.max(input.limit, Math.ceil(due.length / 5))),
      )) {
        try {
          const row = await db
            .prepare(
              "SELECT organization_id, source, window_start, part, split, lines FROM usage_post_failure WHERE key = ?1",
            )
            .bind(key)
            .first<{
              organization_id: string;
              source: string;
              window_start: string;
              part: number;
              split: number;
              lines: string;
            }>();
          if (row === null) continue;
          await postPart(
            context,
            postUsageInput.parse({
              organizationId: row.organization_id,
              source: row.source,
              window: row.window_start,
              part: row.part,
              split: row.split === 1,
              lines: JSON.parse(row.lines) as unknown,
            }),
            true,
          );
          replayed++;
        } catch (error) {
          await db
            .prepare(
              "UPDATE usage_post_failure SET attempts = attempts + 1, reason = ?2, last_failed_at = ?3 WHERE key = ?1",
            )
            .bind(key, failureReason(error), clock())
            .run();
        }
      }
      const open = await db
        .prepare(
          "SELECT count(*) AS n FROM usage_post_failure WHERE attempts >= CAST(?1 AS INTEGER)",
        )
        .bind(input.minAttempts)
        .first<{ n: number }>();
      return { replayed, remaining: open?.n ?? 0 };
    }),

    /** Everything before the returned instant is billed; null before the first advance. */
    readCursor: bind(async (context, raw) => {
      const name = source.parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const row = await db
        .prepare("SELECT through FROM usage_cursor WHERE source = ?1")
        .bind(name)
        .first<{ through: string }>();
      return row === null ? null : publicTimestamp(row.through);
    }),

    /** Moves a cursor forward; a cursor never moves back, and an older instant changes nothing. */
    advanceCursor: bind(async (context, raw) => {
      const input = z.strictObject({ source, through: instant }).parse(raw);
      const db = (await context.router.routeShard(0)).db;
      await db
        .prepare(
          `INSERT INTO usage_cursor(source, through) VALUES (?1, ?2)
           ON CONFLICT(source) DO UPDATE SET through = excluded.through WHERE excluded.through > usage_cursor.through`,
        )
        .bind(input.source, input.through)
        .run();
    }),

    /** The owner now of each script that belongs to a project; a script nobody owns is left out. */
    resolveScripts: bind(async (context, raw) => {
      const input = z
        .strictObject({ scriptNames: z.array(z.string().min(1).max(128)).max(10_000) })
        .parse(raw);
      const names = [...new Set(input.scriptNames)];
      const db = (await context.router.routeShard(0)).db;
      const chunks: string[][] = [];
      for (let start = 0; start < names.length; start += SCRIPT_CHUNK) {
        chunks.push(names.slice(start, start + SCRIPT_CHUNK));
      }
      const results =
        chunks.length === 0
          ? []
          : await db.batch(
              chunks.map((chunk) =>
                db
                  .prepare(
                    `SELECT receipt.immutable_script_name AS script_name, project.organization_id AS organization_id,
                 project.project_id AS project_id, receipt.environment_id AS environment_id
               FROM wfp_candidate_receipts receipt
                 JOIN projects project ON project.project_id = receipt.project_id AND project.owner_state <> 'transferred'
               WHERE receipt.immutable_script_name IN (SELECT value FROM json_each(?1))
               GROUP BY receipt.immutable_script_name
               HAVING count(DISTINCT receipt.project_id || ':' || receipt.environment_id) = 1
               ORDER BY receipt.immutable_script_name`,
                  )
                  .bind(JSON.stringify(chunk)),
              ),
            );
      return results.flatMap((result) =>
        (
          result.results as {
            script_name: string;
            organization_id: string;
            project_id: string;
            environment_id: string;
          }[]
        ).map((row) => ({
          scriptName: row.script_name,
          organizationId: row.organization_id,
          projectId: row.project_id,
          environmentId: row.environment_id,
        })),
      );
    }),

    /**
     * The published cards that have an activation in force at `at`, with the rates of the activated meters. A meter
     * has a timeline of activations: the one in force is the latest that started by `at`, so a meter is priced by
     * exactly one card and a later activation replaces the earlier one from its own start time.
     */
    readRates: bind(async (context, raw) => {
      const input = z.strictObject({ at: instant }).parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const rows = await db
        .prepare(
          `SELECT activation.rate_card_id AS rate_card_id, activation.meter AS meter, activation.starts_at AS starts_at, card.rates AS rates
           FROM usage_meter_activations activation
             JOIN published_credit_rate_cards card ON card.rate_card_id = activation.rate_card_id
           WHERE card.published_at <= ?1
             AND activation.starts_at = (
               SELECT max(later.starts_at) FROM usage_meter_activations later
               WHERE later.meter = activation.meter AND later.starts_at <= ?1)
           ORDER BY activation.rate_card_id, activation.meter`,
        )
        .bind(input.at)
        .all<{ rate_card_id: string; meter: string; starts_at: string; rates: string }>();
      const cards = new Map<string, unknown[]>();
      for (const row of rows.results) {
        const rate = (JSON.parse(row.rates) as { meter: string }[]).find(
          (candidate) => candidate.meter === row.meter,
        );
        if (rate === undefined) continue;
        const rates = cards.get(row.rate_card_id) ?? [];
        rates.push({ ...rate, starts_at: publicTimestamp(row.starts_at) });
        cards.set(row.rate_card_id, rates);
      }
      return [...cards].map(([rateCardId, rates]) => ({ rateCardId, rates }));
    }),

    /** The next page of log rows older than `beforeAt`, in sequence order after `afterSeq`. */
    readLogPage: bind(async (context, raw) => {
      const input = afterInput.parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const page = await db
        .prepare(
          `${LOG_SELECT} WHERE seq > CAST(?1 AS INTEGER) AND at < ?2 ORDER BY seq LIMIT CAST(?3 AS INTEGER)`,
        )
        .bind(input.afterSeq, input.beforeAt, input.limit)
        .all<LogRecord>();
      const rows = page.results.map(logRow);
      return { rows, lastSeq: rows.at(-1)?.seq ?? input.afterSeq };
    }),

    /**
     * Deletes the rotated rows: `seq <= seq` AND `at < beforeAt`, the same two bounds the rotation read them by. `seq`
     * alone is not enough because usage rows are filed under their window start but numbered in posting order: a
     * window of today that was posted before a late window of yesterday has the smaller `seq` and must stay.
     */
    deleteLogThrough: bind(async (context, raw) => {
      const input = z.strictObject({ seq: z.number().int().min(0), beforeAt: instant }).parse(raw);
      const db = (await context.router.routeShard(0)).db;
      const result = await db
        .prepare("DELETE FROM credit_log WHERE seq <= CAST(?1 AS INTEGER) AND at < ?2")
        .bind(input.seq, input.beforeAt)
        .run();
      return { deleted: result.meta.changes };
    }),

    /**
     * The projects whose `stop` budget is reached in the current month: the use of the month plus the open reservations
     * is at least the budget. The rule is `runtimeDecision` in decision.ts, in SQL for the whole table. The project join
     * keeps a deleted or deleting project out, because its scope can no longer be read. The order is random, so a
     * capped pass still reaches every project over successive passes.
     */
    listStopBudgetProjects: bind(async (context) => {
      const db = (await context.router.routeShard(0)).db;
      const rows = await db
        .prepare(
          `SELECT credit.organization_id, credit.project_id
           FROM project_credit credit
             JOIN projects project ON project.organization_id = credit.organization_id AND project.project_id = credit.project_id
           WHERE credit.budget_mode = 'stop' AND credit.budget_micros IS NOT NULL
             AND project.owner_state = 'active' AND project.lifecycle_state = 'active'
             AND (CASE WHEN credit.period = ?1 THEN credit.used_micros ELSE 0 END)
               + (SELECT COALESCE(SUM(reservation.amount_micros), 0) FROM credit_reservation reservation
                  WHERE reservation.organization_id = credit.organization_id AND reservation.project_id = credit.project_id)
               >= credit.budget_micros
           ORDER BY random()
           LIMIT ?2`,
        )
        .bind(monthPeriod(clock()), STOP_BUDGET_PROJECT_LIMIT)
        .all<{ organization_id: string; project_id: string }>();
      return rows.results.map((row) => ({
        organizationId: row.organization_id,
        projectId: row.project_id,
      }));
    }),

    /**
     * The projects of organizations that the serving decision denies for credit: no renewal is pending, and either the grace
     * after exhaustion has lapsed (`exhausted_at` is at least seven days old) with the balance minus the open reservations at
     * nothing, or the month's platform overrun is at its ceiling. The rule is `runtimeDecision` in decision.ts. A deleted or deleting project is left out, as for the budgets.
     * Random order and a cap, so a capped pass still reaches every project over successive passes.
     */
    listCreditDeniedProjects: bind(async (context) => {
      const db = (await context.router.routeShard(0)).db;
      const now = storedTimestamp(clock());
      const rows = await db
        .prepare(
          `SELECT account.organization_id, project.project_id
           FROM credit_account account
             JOIN organizations organization ON organization.organization_id = account.organization_id AND organization.state = 'active'
             JOIN projects project ON project.organization_id = account.organization_id
           WHERE project.owner_state = 'active' AND project.lifecycle_state = 'active'
             AND account.monthly_ends_at > ?1
             AND account.monthly_micros + account.onetime_micros - account.reserved_micros <= 0
             AND ((account.exhausted_at IS NOT NULL AND account.exhausted_at <= ?2)
                  OR MAX(account.overrun_micros - account.overrun_base_micros, 0) >= ?4)
           ORDER BY random()
           LIMIT ?3`,
        )
        .bind(
          now,
          addMilliseconds(now, -CREDIT_GRACE_MS),
          CREDIT_DENIED_PROJECT_LIMIT,
          OVERRUN_CEILING_MICROS,
        )
        .all<{ organization_id: string; project_id: string }>();
      return rows.results.map((row) => ({
        organizationId: row.organization_id,
        projectId: row.project_id,
      }));
    }),

    cursorsThrough: bind(async (context) => {
      const db = (await context.router.routeShard(0)).db;
      const rows = await db
        .prepare("SELECT source, through FROM usage_cursor ORDER BY source")
        .all<{ source: string; through: string }>();
      return rows.results.map((row) => ({
        source: row.source,
        through: publicTimestamp(row.through),
      }));
    }),

    /**
     * Every log row of the organization that is still in the Core, oldest posting first: the rows of today and any
     * older row the rotation has not archived yet (a rotation waits for the cursors, so yesterday's rows are here until
     * it ran). The usage report merges them by key with the rotated shards, so a row must never be missing from both.
     */
    readLogsToday: bind(async (context, raw) => {
      const input = z.strictObject({ organizationId: ulid }).parse(raw);
      const db = (await routeOrganization(context, input.organizationId)).db;
      const page = await db
        .prepare(`${LOG_SELECT} WHERE organization_id = ?1 ORDER BY seq`)
        .bind(input.organizationId)
        .all<LogRecord>();
      return page.results.map(logRow);
    }),
  });
}
