import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { classifyFailure, guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import {
  accountView,
  ensureStatement,
  micros,
  numbered,
  PAID_MONTHLY_MICROS,
  readAccount,
  renewalStatements,
  snapshotRow,
  snapshotStatement,
  type AccountView,
  type CreditPlan,
} from "./account.js";
import { isDuplicate, spendAssignments } from "./spend.js";

/** Keys of grants that fill the monthly allowance (a paid invoice); every other grant is one-time credit. */
const MONTHLY_GRANT_PREFIX = "invoice:";

export interface GrantInput {
  readonly organizationId: string;
  /** The `credit_grant.key`: `invoice:<in_>`, `topup:<pi_>`, `recharge:<pi_>`, `signup_bonus:<user>`, `referral_*`. */
  readonly key: string;
  /** `onetime` adds credit that never expires; `monthly` sets the monthly allowance until `monthlyEndsAt`. */
  readonly kind: "onetime" | "monthly";
  readonly amountMicros: number;
  /** What was paid for it in minor currency units, for a proportional reversal; null when nothing was paid. */
  readonly paidMinor?: number | null;
  /** The end of the period a monthly grant covers. */
  readonly monthlyEndsAt?: string;
  /** The start of the period a monthly grant covers: a Paid renewal that began at or after it is netted. */
  readonly periodStart?: string;
  /** The end of the Paid coverage an invoice gives; a full return of the grant hands it back. */
  readonly coversUntil?: string;
  readonly now: string;
  readonly at?: string;
  readonly detail?: Record<string, unknown>;
}

export interface GrantResult {
  /** False for an organization that does not exist; a key that was granted before aborts the batch instead. */
  readonly granted: boolean;
  readonly balanceMicros: number;
  readonly account: AccountView | null;
}

/**
 * Grants credit once per key. The `credit_grant` key is the idempotency of the grant and the log key `grant:<key>`
 * is the double-posting guard: a second call aborts the whole batch. A lapsed month is renewed first. A one-time grant
 * adds to the balance; a monthly grant (a paid invoice) replaces the monthly allowance, unless it covers an older
 * period than the one that is stored. A monthly allowance that a Paid renewal began within the invoice's period is
 * netted: what that renewal already spent of it is taken off the period's allowance. Either ends the exhaustion.
 */
export function grantCredit(db: D1Database, input: GrantInput): CreditPlan<GrantResult> {
  const amount = micros(input.amountMicros);
  if (amount === 0) throw new RangeError("a grant grants at least one micro-credit");
  const paidMinor = input.paidMinor ?? null;
  if (paidMinor !== null) micros(paidMinor, "paid amount");
  const now = storedTimestamp(input.now);
  const at = storedTimestamp(input.at ?? input.now);
  if (input.kind === "monthly" && input.monthlyEndsAt === undefined) {
    throw new TypeError("a monthly grant needs the end of its period");
  }
  if (input.kind === "monthly" && input.periodStart === undefined) {
    throw new TypeError("a monthly grant needs the start of its period");
  }
  const endsAt = input.monthlyEndsAt === undefined ? null : storedTimestamp(input.monthlyEndsAt);
  const periodStart = input.periodStart === undefined ? null : storedTimestamp(input.periodStart);
  const coversUntil = input.coversUntil === undefined ? null : storedTimestamp(input.coversUntil);
  // The allowance after this invoice: a period that is not newer than the stored month keeps it; a Paid renewal that began
  // within the period is netted by what it spent (the renewal's allowance is the period's, so it is not granted twice);
  // any other newer period replaces it.
  const monthly = `CASE WHEN ?4 < monthly_ends_at THEN monthly_micros
      WHEN paid_renewal_at >= ?5 THEN MAX(CAST(?2 AS INTEGER) - (CAST(?6 AS INTEGER) - monthly_micros), 0)
      ELSE CAST(?2 AS INTEGER) END`;
  const apply =
    input.kind === "monthly"
      ? db
          .prepare(
            `UPDATE credit_account SET
               monthly_micros = ${monthly},
               monthly_ends_at = MAX(monthly_ends_at, ?4),
               paid_renewal_at = CASE WHEN ?4 >= monthly_ends_at THEN NULL ELSE paid_renewal_at END,
               exhausted_at = CASE WHEN (${monthly}) + onetime_micros > 0 THEN NULL ELSE exhausted_at END,
               updated_at = ?3
             WHERE organization_id = ?1`,
          )
          .bind(input.organizationId, amount, now, endsAt, periodStart, PAID_MONTHLY_MICROS)
      : db
          .prepare(
            "UPDATE credit_account SET onetime_micros = onetime_micros + CAST(?2 AS INTEGER), exhausted_at = NULL, updated_at = ?3 WHERE organization_id = ?1",
          )
          .bind(input.organizationId, amount, now);
  const statements: D1PreparedStatement[] = [
    ensureStatement(db, input.organizationId, now),
    ...renewalStatements(db, input.organizationId, now),
    db
      .prepare(
        `INSERT INTO credit_grant(key, organization_id, amount_micros, paid_minor, reversed_micros, granted_at, covers_until)
         SELECT ?2, organization_id, CAST(?3 AS INTEGER), CAST(?4 AS INTEGER), 0, ?5, ?6 FROM credit_account WHERE organization_id = ?1`,
      )
      .bind(input.organizationId, input.key, amount, paidMinor, now, coversUntil),
    apply,
    db
      .prepare(
        `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
         SELECT 'grant:' || ?2, ?3, organization_id, 'grant', CAST(?4 AS INTEGER), monthly_micros + onetime_micros, ?5
         FROM credit_account WHERE organization_id = ?1`,
      )
      .bind(
        input.organizationId,
        input.key,
        at,
        amount,
        JSON.stringify({
          ...input.detail,
          grantKey: input.key,
          kind: input.key.split(":")[0],
          bucket: input.kind,
        }),
      ),
    snapshotStatement(db, input.organizationId),
  ];
  return {
    statements,
    read: (results) => {
      const row = snapshotRow(results[statements.length - 1]);
      const account = row === null ? null : accountView(input.organizationId, row, now);
      return {
        granted: (results[4]?.meta.changes ?? 0) === 1,
        balanceMicros: account?.balanceMicros ?? 0,
        account,
      };
    },
  };
}

/** Runs a grant; a key that was granted before leaves everything unchanged and reads `granted: false`. */
export async function runGrantCredit(db: D1Database, input: GrantInput): Promise<GrantResult> {
  const plan = grantCredit(db, input);
  try {
    return plan.read(await db.batch(plan.statements));
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const account = await readAccount(db, input.organizationId, input.now);
    return { granted: false, balanceMicros: account.balanceMicros, account };
  }
}

export interface ReverseInput {
  readonly organizationId: string;
  /** The key of the grant to take back. */
  readonly grantKey: string;
  /**
   * What has been refunded of the payment so far, cumulative, in minor currency units. The grant is taken back in
   * proportion (`amount * refunded / paid`, at most the whole grant); omitted, or for a grant nothing was paid for,
   * the whole grant goes. The same cumulative amount reverses nothing a second time.
   */
  readonly refundedMinor?: number;
  readonly now: string;
  readonly at?: string;
  readonly detail?: Record<string, unknown>;
}

export interface ReverseResult {
  /** What this call took back; zero for a replay. */
  readonly reversedMicros: number;
  readonly balanceMicros: number;
  readonly account: AccountView | null;
}

// How much of the grant is reversed in total for the refund so far (?2 NULL: all of it), in SQL over `credit_grant` g.
const REVERSED_TARGET =
  "CASE WHEN ?2 IS NULL OR g.paid_minor IS NULL OR g.paid_minor <= 0 THEN g.amount_micros ELSE CAST(g.amount_micros * MIN(CAST(?2 AS INTEGER), g.paid_minor) / g.paid_minor AS INTEGER) END";
const REVERSED_NOW = `MAX(${REVERSED_TARGET} - g.reversed_micros, 0)`;

/**
 * Takes a grant back in proportion to a refund: from the monthly allowance first for an invoice, from the one-time
 * credit for every other grant, and what no balance covers goes to overrun (the platform absorbs it). Idempotent: the
 * grant remembers what it has reversed, and the log key `reverse:<grant key>:<refunded>` names the refund.
 */
export function reverseGrant(db: D1Database, input: ReverseInput): CreditPlan<ReverseResult> {
  const now = storedTimestamp(input.now);
  const at = storedTimestamp(input.at ?? input.now);
  const refunded = input.refundedMinor === undefined ? null : micros(input.refundedMinor, "refund");
  const values = [
    input.grantKey,
    refunded,
    now,
    input.organizationId,
    at,
    refunded === null ? "full" : String(refunded),
    JSON.stringify({ ...input.detail, grantKey: input.grantKey, refundedMinor: refunded }),
  ];
  const delta = `(SELECT ${REVERSED_NOW} FROM credit_grant g WHERE g.key = ?1)`;
  const spend = input.grantKey.startsWith(MONTHLY_GRANT_PREFIX)
    ? spendAssignments("d.delta", "?3")
    : `onetime_micros = onetime_micros - MIN(onetime_micros, d.delta),
    overrun_micros = overrun_micros + MAX(d.delta - onetime_micros, 0),
    exhausted_at = CASE WHEN monthly_micros + onetime_micros - MIN(onetime_micros, d.delta) <= 0 THEN COALESCE(exhausted_at, ?3) ELSE NULL END,
    updated_at = ?3`;
  const statements: D1PreparedStatement[] = [
    numbered(db, `SELECT ${delta} AS delta`, values),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS (SELECT 1 FROM credit_grant WHERE key = ?1 AND organization_id = ?2)",
      [input.grantKey, input.organizationId],
    ),
    ...renewalStatements(db, input.organizationId, now),
    numbered(
      db,
      `UPDATE credit_account SET ${spend}
       FROM (SELECT ${REVERSED_NOW} AS delta FROM credit_grant g WHERE g.key = ?1) AS d
       WHERE credit_account.organization_id = ?4 AND d.delta > 0`,
      values,
    ),
    numbered(
      db,
      `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
       SELECT 'reverse:' || ?1 || ':' || ?6, ?5, a.organization_id, 'reverse', -${REVERSED_NOW}, a.monthly_micros + a.onetime_micros, ?7
       FROM credit_grant g JOIN credit_account a ON a.organization_id = g.organization_id
       WHERE g.key = ?1 AND ${REVERSED_NOW} > 0`,
      values,
    ),
    numbered(
      db,
      `UPDATE credit_grant AS g SET reversed_micros = MAX(g.reversed_micros, ${REVERSED_TARGET}) WHERE g.key = ?1`,
      values,
    ),
    snapshotStatement(db, input.organizationId),
  ];
  return {
    statements,
    read: (results) => {
      const row = snapshotRow(results[statements.length - 1]);
      const reversed = (results[0]?.results[0] as { delta: number } | undefined)?.delta ?? 0;
      return {
        reversedMicros: reversed,
        balanceMicros: row === null ? 0 : row.monthly_micros + row.onetime_micros,
        account: row === null ? null : accountView(input.organizationId, row, now),
      };
    },
  };
}

export type ReverseOutcome =
  | ReverseResult
  | { readonly reversedMicros: 0; readonly unknownGrant: true };

export async function runReverseGrant(
  db: D1Database,
  input: ReverseInput,
): Promise<ReverseOutcome> {
  const plan = reverseGrant(db, input);
  try {
    return plan.read(await db.batch(plan.statements));
  } catch (error) {
    const failure = classifyFailure(error);
    if (failure.kind === "guard" && failure.code === "precondition_changed") {
      return { reversedMicros: 0, unknownGrant: true };
    }
    throw error;
  }
}
