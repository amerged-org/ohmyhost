import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { classifyFailure, guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { organizationLiveGuard } from "../common.js";
import {
  accountView,
  ensureStatement,
  micros,
  monthPeriod,
  readAccount,
  renewalStatements,
  snapshotRow,
  snapshotStatement,
  type AccountView,
  type CreditPlan,
} from "./account.js";

/**
 * The spend order of the money model, in SQL over the row as it is before the update (SQLite evaluates every
 * right-hand side against the old row): monthly first, then one-time, and what no balance covers goes to
 * `overrun_micros`, which the platform absorbs, so the customer's balance never goes negative. `exhausted_at` is set
 * once when the balance reaches zero and cleared while it is positive.
 */
export function spendAssignments(amount: string, now: string): string {
  return `monthly_micros = monthly_micros - MIN(monthly_micros, ${amount}),
    onetime_micros = onetime_micros - MIN(onetime_micros, MAX(${amount} - monthly_micros, 0)),
    overrun_micros = overrun_micros + MAX(${amount} - monthly_micros - onetime_micros, 0),
    exhausted_at = CASE WHEN monthly_micros + onetime_micros <= ${amount} THEN COALESCE(exhausted_at, ${now}) ELSE NULL END,
    updated_at = ${now}`;
}

/** Adds a charge to the use of a project in a UTC month; a later month restarts the count, an older one is ignored. */
const PROJECT_USE_CONFLICT = `ON CONFLICT(project_id) DO UPDATE SET
    used_micros = CASE WHEN excluded.period > project_credit.period THEN excluded.used_micros
      WHEN excluded.period = project_credit.period THEN project_credit.used_micros + excluded.used_micros
      ELSE project_credit.used_micros END,
    period = MAX(project_credit.period, excluded.period),
    organization_id = excluded.organization_id`;

const jsonText = (value: Record<string, unknown> | undefined) => JSON.stringify(value ?? {});

/** A violated unique key of the credit tables: the batch was applied before and rolled back as a whole. */
export function isDuplicate(error: unknown): boolean {
  const failure = classifyFailure(error);
  return (
    failure.kind === "unique" &&
    (failure.table === "credit_log" ||
      failure.table === "credit_grant" ||
      failure.table === "credit_reservation")
  );
}

export interface ChargeInput {
  readonly organizationId: string;
  /** The `credit_log.key`, the double-posting guard: `usage:<source>:<org>:<window>`, `mail:<sendRequestId>`. */
  readonly key: string;
  readonly amountMicros: number;
  /** The Core clock: renewal, exhaustion and `updated_at`. */
  readonly now: string;
  /** The event time the log row is filed under (default `now`). */
  readonly at?: string;
  readonly detail?: Record<string, unknown>;
  /** The charge per project, for `project_credit.used_micros`; the amounts add up to at most `amountMicros`. */
  readonly projects?: readonly { readonly projectId: string; readonly amountMicros: number }[];
  /** Guard statements that open the batch: one that fires aborts it, so nothing of the charge persists. */
  readonly guards?: readonly D1PreparedStatement[];
  /** Statements that run in the batch after the log row, so that they persist exactly when the charge does. */
  readonly after?: readonly D1PreparedStatement[];
}

export interface ChargeResult {
  /** False when the organization has no account (it does not exist); a duplicate key aborts the batch instead. */
  readonly posted: boolean;
  readonly balanceMicros: number;
  readonly account: AccountView | null;
}

/**
 * Charges usage to the organization: renews a lapsed month, spends monthly then one-time then overrun, logs the
 * change under `key` (with the monthly, one-time and overrun parts it spent in `detail.spent`, for `refundOrg`) and
 * counts it against its projects. The log key is UNIQUE, so a second call with the same key aborts the whole batch and
 * changes nothing.
 */
export function chargeOrg(db: D1Database, input: ChargeInput): CreditPlan<ChargeResult> {
  const amount = micros(input.amountMicros);
  const now = storedTimestamp(input.now);
  const at = storedTimestamp(input.at ?? input.now);
  const statements: D1PreparedStatement[] = [
    ...(input.guards ?? []),
    ensureStatement(db, input.organizationId, now),
    ...renewalStatements(db, input.organizationId, now),
  ];
  // The log row is written before the spend, so that its split is computed from the balances the charge is spent
  // from (SQL reads the row as it is when the statement runs). Its balance is the one the spend leaves behind.
  const logged = statements.length;
  statements.push(
    db
      .prepare(
        `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
         SELECT ?2, ?3, organization_id, 'usage', -CAST(?4 AS INTEGER), MAX(monthly_micros + onetime_micros - CAST(?4 AS INTEGER), 0),
           json_patch(?5, json_object('spent', json_object(
             'monthly', MIN(monthly_micros, CAST(?4 AS INTEGER)),
             'onetime', MIN(onetime_micros, MAX(CAST(?4 AS INTEGER) - monthly_micros, 0)),
             'overrun', MAX(CAST(?4 AS INTEGER) - monthly_micros - onetime_micros, 0))))
         FROM credit_account WHERE organization_id = ?1`,
      )
      .bind(input.organizationId, input.key, at, amount, jsonText(input.detail)),
    db
      .prepare(
        `UPDATE credit_account SET ${spendAssignments("CAST(?3 AS INTEGER)", "?2")} WHERE organization_id = ?1`,
      )
      .bind(input.organizationId, now, amount),
  );
  statements.push(...(input.after ?? []));
  const projects = (input.projects ?? []).filter((project) => micros(project.amountMicros) > 0);
  if (projects.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO project_credit(project_id, organization_id, period, used_micros)
           SELECT json_extract(value, '$.p'), ?1, ?2, json_extract(value, '$.m') FROM json_each(?3)
           WHERE EXISTS (SELECT 1 FROM credit_account WHERE organization_id = ?1)
           ${PROJECT_USE_CONFLICT}`,
        )
        .bind(
          input.organizationId,
          monthPeriod(at),
          JSON.stringify(projects.map((p) => ({ p: p.projectId, m: p.amountMicros }))),
        ),
    );
  }
  statements.push(snapshotStatement(db, input.organizationId));
  return {
    statements,
    read: (results) => {
      const row = snapshotRow(results[statements.length - 1]);
      const account = row === null ? null : accountView(input.organizationId, row, now);
      return {
        posted: (results[logged]?.meta.changes ?? 0) === 1,
        balanceMicros: account?.balanceMicros ?? 0,
        account,
      };
    },
  };
}

/** Runs a charge; a key that was posted before leaves everything unchanged and reads `posted: false`. */
export async function runChargeOrg(db: D1Database, input: ChargeInput): Promise<ChargeResult> {
  const plan = chargeOrg(db, input);
  try {
    return plan.read(await db.batch(plan.statements));
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const account = await readAccount(db, input.organizationId, input.now);
    return { posted: false, balanceMicros: account.balanceMicros, account };
  }
}

export interface RefundInput {
  readonly organizationId: string;
  /** The `credit_log.key`, e.g. `mailrefund:<sendRequestId>`. */
  readonly key: string;
  readonly amountMicros: number;
  readonly now: string;
  readonly at?: string;
  readonly detail?: Record<string, unknown>;
  /** The project whose use in the month of `at` the refund takes back. */
  readonly projectId?: string;
  /**
   * The `credit_log.key` of the charge this refund gives back. Its logged split returns the monthly part to monthly,
   * the one-time part to one-time and the overrun part out of overrun; a charge without a split is refunded as before.
   */
  readonly chargeKey?: string;
}

/**
 * Gives a charge back (a send that failed after it was charged). With `chargeKey`, each part returns to the bucket it
 * was spent from: monthly to the current monthly allowance (so it expires with that month, even when the month was
 * renewed in between), one-time to one-time, overrun out of overrun. Without a recorded split (a charge written before
 * the split was logged, no `chargeKey`, or a charge row that the daily log rotation has already moved to R2) it is the
 * old rule: first against overrun, the rest as one-time credit.
 * Logged as `refund` under `key`; a duplicate key aborts the batch.
 */
export function refundOrg(db: D1Database, input: RefundInput): CreditPlan<ChargeResult> {
  const amount = micros(input.amountMicros);
  const now = storedTimestamp(input.now);
  const at = storedTimestamp(input.at ?? input.now);
  // The charge's detail as chargeOrg logged it: NULL when there is no such charge row of this organization.
  const charge = `(SELECT detail FROM credit_log WHERE key = ?4 AND organization_id = ?1)`;
  const known = `json_extract(${charge}, '$.spent.monthly') IS NOT NULL`;
  const part = (name: string) =>
    `CAST(COALESCE(json_extract(${charge}, '$.spent.${name}'), 0) AS INTEGER)`;
  const legacyOnetime = `MAX(CAST(?3 AS INTEGER) - overrun_micros, 0)`;
  const statements: D1PreparedStatement[] = [
    ensureStatement(db, input.organizationId, now),
    ...renewalStatements(db, input.organizationId, now),
    db
      .prepare(
        `UPDATE credit_account SET
           monthly_micros = monthly_micros + CASE WHEN ${known} THEN ${part("monthly")} ELSE 0 END,
           onetime_micros = onetime_micros + CASE WHEN ${known} THEN ${part("onetime")} ELSE ${legacyOnetime} END,
           overrun_micros = overrun_micros - MIN(overrun_micros, CASE WHEN ${known} THEN ${part("overrun")} ELSE CAST(?3 AS INTEGER) END),
           exhausted_at = CASE WHEN monthly_micros + onetime_micros + CASE WHEN ${known} THEN ${part("monthly")} + ${part("onetime")} ELSE ${legacyOnetime} END > 0 THEN NULL ELSE exhausted_at END,
           updated_at = ?2
         WHERE organization_id = ?1`,
      )
      .bind(input.organizationId, now, amount, input.chargeKey ?? null),
    db
      .prepare(
        `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
         SELECT ?2, ?3, organization_id, 'refund', CAST(?4 AS INTEGER), monthly_micros + onetime_micros, ?5
         FROM credit_account WHERE organization_id = ?1`,
      )
      .bind(input.organizationId, input.key, at, amount, jsonText(input.detail)),
  ];
  const logged = statements.length - 1;
  if (input.projectId !== undefined && amount > 0) {
    statements.push(
      db
        .prepare(
          `UPDATE project_credit SET used_micros = MAX(used_micros - CAST(?3 AS INTEGER), 0)
           WHERE project_id = ?1 AND organization_id = ?4 AND period = ?2`,
        )
        .bind(input.projectId, monthPeriod(at), amount, input.organizationId),
    );
  }
  statements.push(snapshotStatement(db, input.organizationId));
  return {
    statements,
    read: (results) => {
      const row = snapshotRow(results[statements.length - 1]);
      const account = row === null ? null : accountView(input.organizationId, row, now);
      return {
        posted: (results[logged]?.meta.changes ?? 0) === 1,
        balanceMicros: account?.balanceMicros ?? 0,
        account,
      };
    },
  };
}

export async function runRefundOrg(db: D1Database, input: RefundInput): Promise<ChargeResult> {
  const plan = refundOrg(db, input);
  try {
    return plan.read(await db.batch(plan.statements));
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const account = await readAccount(db, input.organizationId, input.now);
    return { posted: false, balanceMicros: account.balanceMicros, account };
  }
}

export interface ReserveInput {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly projectId: string | null;
  readonly amountMicros: number;
  readonly now: string;
  readonly detail?: Record<string, unknown>;
}

export interface ReserveResult {
  readonly reserved: true;
  readonly balanceMicros: number;
  readonly availableMicros: number;
}

/**
 * Reserves credit for a build. The guard `insufficient_credits` aborts the batch when `available = monthly + onetime -
 * reserved` is smaller than the amount (after the lazy renewal); `organization_inactive` when the organization does not
 * exist or is deleted. The reservation row lives until it is settled or released.
 */
export function reserve(db: D1Database, input: ReserveInput): CreditPlan<ReserveResult> {
  const amount = micros(input.amountMicros);
  if (amount === 0) throw new RangeError("a reservation reserves at least one micro-credit");
  const now = storedTimestamp(input.now);
  const statements: D1PreparedStatement[] = [
    organizationLiveGuard(db, input.organizationId),
    ensureStatement(db, input.organizationId, now),
    ...renewalStatements(db, input.organizationId, now),
    guard(
      db,
      "insufficient_credits",
      "NOT EXISTS (SELECT 1 FROM credit_account WHERE organization_id = ?1 AND monthly_micros + onetime_micros - reserved_micros >= CAST(?2 AS INTEGER))",
      [input.organizationId, amount],
    ),
    db
      .prepare(
        "UPDATE credit_account SET reserved_micros = reserved_micros + CAST(?3 AS INTEGER), updated_at = ?2 WHERE organization_id = ?1",
      )
      .bind(input.organizationId, now, amount),
    db
      .prepare(
        "INSERT INTO credit_reservation(reservation_id, organization_id, project_id, amount_micros, created_at) VALUES (?1, ?2, ?3, CAST(?4 AS INTEGER), ?5)",
      )
      .bind(input.reservationId, input.organizationId, input.projectId, amount, now),
    db
      .prepare(
        `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
         SELECT 'reserve:' || ?2, ?3, organization_id, 'reserve', 0, monthly_micros + onetime_micros, ?4
         FROM credit_account WHERE organization_id = ?1`,
      )
      .bind(
        input.organizationId,
        input.reservationId,
        now,
        jsonText({
          ...input.detail,
          projectId: input.projectId,
          reservedMicros: amount,
        }),
      ),
    snapshotStatement(db, input.organizationId),
  ];
  return {
    statements,
    read: (results) => {
      const account = accountView(
        input.organizationId,
        snapshotRow(results[statements.length - 1]),
        now,
      );
      return {
        reserved: true,
        balanceMicros: account.balanceMicros,
        availableMicros: account.availableMicros,
      };
    },
  };
}

/** `reserved: false` is a refusal that changed nothing; a duplicate reservation id is answered the same way. */
export type ReserveOutcome =
  | ReserveResult
  | { readonly reserved: false; readonly reason: "insufficient_credits" | "duplicate" };

export async function runReserve(db: D1Database, input: ReserveInput): Promise<ReserveOutcome> {
  const plan = reserve(db, input);
  try {
    return plan.read(await db.batch(plan.statements));
  } catch (error) {
    if (isDuplicate(error)) return { reserved: false, reason: "duplicate" };
    const failure = classifyFailure(error);
    if (failure.kind === "guard" && failure.code === "insufficient_credits") {
      return { reserved: false, reason: "insufficient_credits" };
    }
    throw error;
  }
}

export interface SettleInput {
  readonly organizationId: string;
  readonly reservationId: string;
  /** What the build actually cost; the rest of the reservation is released. */
  readonly chargedMicros: number;
  readonly now: string;
  readonly at?: string;
  readonly detail?: Record<string, unknown>;
}

export interface SettleResult {
  readonly settled: true;
  readonly reservedMicros: number;
  readonly chargedMicros: number;
  readonly releasedMicros: number;
  readonly balanceMicros: number;
}

const RESERVATION_SELECT =
  "SELECT amount_micros, project_id FROM credit_reservation WHERE reservation_id = ?1 AND organization_id = ?2";
const RESERVATION_MISSING =
  "NOT EXISTS (SELECT 1 FROM credit_reservation WHERE reservation_id = ?1 AND organization_id = ?2)";

/**
 * Settles a reservation: charges the actual cost like usage, gives back the reservation and deletes its row, logged
 * as `settle:<reservationId>`. The guard `precondition_changed` aborts the batch when the reservation is not (or no
 * longer) there.
 */
export function settleReservation(db: D1Database, input: SettleInput): CreditPlan<SettleResult> {
  const charged = micros(input.chargedMicros, "charge");
  const now = storedTimestamp(input.now);
  const at = storedTimestamp(input.at ?? input.now);
  const statements: D1PreparedStatement[] = [
    db.prepare(RESERVATION_SELECT).bind(input.reservationId, input.organizationId),
    guard(db, "precondition_changed", RESERVATION_MISSING, [
      input.reservationId,
      input.organizationId,
    ]),
    ...renewalStatements(db, input.organizationId, now),
    db
      .prepare(
        `UPDATE credit_account SET ${spendAssignments("CAST(?3 AS INTEGER)", "?2")},
           reserved_micros = reserved_micros - (SELECT amount_micros FROM credit_reservation WHERE reservation_id = ?4)
         WHERE organization_id = ?1`,
      )
      .bind(input.organizationId, now, charged, input.reservationId),
    db
      .prepare(
        `INSERT INTO project_credit(project_id, organization_id, period, used_micros)
         SELECT project_id, organization_id, ?2, CAST(?3 AS INTEGER) FROM credit_reservation
         WHERE reservation_id = ?1 AND project_id IS NOT NULL AND CAST(?3 AS INTEGER) > 0
         ${PROJECT_USE_CONFLICT}`,
      )
      .bind(input.reservationId, monthPeriod(at), charged),
    db
      .prepare(
        `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
         SELECT 'settle:' || ?1, ?2, a.organization_id, 'settle', -CAST(?3 AS INTEGER), a.monthly_micros + a.onetime_micros,
           json_patch(?4, json_object('projectId', r.project_id, 'reservedMicros', r.amount_micros, 'chargedMicros', CAST(?3 AS INTEGER),
             'releasedMicros', MAX(r.amount_micros - CAST(?3 AS INTEGER), 0)))
         FROM credit_reservation r JOIN credit_account a ON a.organization_id = r.organization_id WHERE r.reservation_id = ?1`,
      )
      .bind(input.reservationId, at, charged, jsonText(input.detail)),
    db
      .prepare("DELETE FROM credit_reservation WHERE reservation_id = ?1")
      .bind(input.reservationId),
    snapshotStatement(db, input.organizationId),
  ];
  return {
    statements,
    read: (results) => {
      const reserved = (results[0]?.results[0] as { amount_micros: number } | undefined)
        ?.amount_micros;
      const account = accountView(
        input.organizationId,
        snapshotRow(results[statements.length - 1]),
        now,
      );
      return {
        settled: true,
        reservedMicros: reserved ?? 0,
        chargedMicros: charged,
        releasedMicros: Math.max((reserved ?? 0) - charged, 0),
        balanceMicros: account.balanceMicros,
      };
    },
  };
}

export type SettleOutcome =
  | SettleResult
  | { readonly settled: false; readonly reason: "already_resolved" | "unknown_reservation" };

/** Why a reservation could not be resolved: its settle or release was logged before, or it never existed. */
async function resolvedBefore(
  db: D1Database,
  reservationId: string,
): Promise<"already_resolved" | "unknown_reservation"> {
  const row = await db
    .prepare("SELECT 1 AS found FROM credit_log WHERE key IN ('settle:' || ?1, 'release:' || ?1)")
    .bind(reservationId)
    .first();
  return row === null ? "unknown_reservation" : "already_resolved";
}

export async function runSettleReservation(
  db: D1Database,
  input: SettleInput,
): Promise<SettleOutcome> {
  const plan = settleReservation(db, input);
  try {
    return plan.read(await db.batch(plan.statements));
  } catch (error) {
    const failure = classifyFailure(error);
    if (
      !isDuplicate(error) &&
      !(failure.kind === "guard" && failure.code === "precondition_changed")
    )
      throw error;
    return { settled: false, reason: await resolvedBefore(db, input.reservationId) };
  }
}

export interface ReleaseInput {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly now: string;
  readonly detail?: Record<string, unknown>;
}

export interface ReleaseResult {
  readonly released: true;
  readonly releasedMicros: number;
  readonly balanceMicros: number;
}

/** Releases a reservation without a charge, logged as `release:<reservationId>`. */
export function releaseReservation(db: D1Database, input: ReleaseInput): CreditPlan<ReleaseResult> {
  const now = storedTimestamp(input.now);
  const statements: D1PreparedStatement[] = [
    db.prepare(RESERVATION_SELECT).bind(input.reservationId, input.organizationId),
    guard(db, "precondition_changed", RESERVATION_MISSING, [
      input.reservationId,
      input.organizationId,
    ]),
    db
      .prepare(
        `UPDATE credit_account SET reserved_micros = reserved_micros - (SELECT amount_micros FROM credit_reservation WHERE reservation_id = ?3), updated_at = ?2
         WHERE organization_id = ?1`,
      )
      .bind(input.organizationId, now, input.reservationId),
    db
      .prepare(
        `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
         SELECT 'release:' || ?1, ?2, a.organization_id, 'release', 0, a.monthly_micros + a.onetime_micros,
           json_patch(?3, json_object('projectId', r.project_id, 'releasedMicros', r.amount_micros))
         FROM credit_reservation r JOIN credit_account a ON a.organization_id = r.organization_id WHERE r.reservation_id = ?1`,
      )
      .bind(input.reservationId, now, jsonText(input.detail)),
    db
      .prepare("DELETE FROM credit_reservation WHERE reservation_id = ?1")
      .bind(input.reservationId),
    snapshotStatement(db, input.organizationId),
  ];
  return {
    statements,
    read: (results) => {
      const reserved = (results[0]?.results[0] as { amount_micros: number } | undefined)
        ?.amount_micros;
      const account = accountView(
        input.organizationId,
        snapshotRow(results[statements.length - 1]),
        now,
      );
      return {
        released: true,
        releasedMicros: reserved ?? 0,
        balanceMicros: account.balanceMicros,
      };
    },
  };
}

export type ReleaseOutcome =
  | ReleaseResult
  | { readonly released: false; readonly reason: "already_resolved" | "unknown_reservation" };

export async function runReleaseReservation(
  db: D1Database,
  input: ReleaseInput,
): Promise<ReleaseOutcome> {
  const plan = releaseReservation(db, input);
  try {
    return plan.read(await db.batch(plan.statements));
  } catch (error) {
    const failure = classifyFailure(error);
    if (
      !isDuplicate(error) &&
      !(failure.kind === "guard" && failure.code === "precondition_changed")
    )
      throw error;
    return { released: false, reason: await resolvedBefore(db, input.reservationId) };
  }
}
