import type { D1Database, D1PreparedStatement, D1Result } from "../../d1-types.js";
import { storedTimestamp } from "../../timestamps.js";
import { addMilliseconds } from "../common.js";

// The simple credit account of one organization (migration 0600). Money is INTEGER micro-credits (1 credit =
// 1_000_000 micros) held in JavaScript numbers, which are exact up to 2^53; it is bound with `CAST(? AS INTEGER)`
// because D1 binds a JavaScript number as REAL. Every write is ONE `db.batch` and every statement builder here
// returns its statements so a caller can compose them with its own writes; the batch is the transaction.

/** Micro-credits in one credit. */
export const MICROS_PER_CREDIT = 1_000_000;
/**
 * The most platform overrun one organization may book in a month: USD 50, which is 5000 credits of 1 cent. Once the month's
 * overrun reaches it, the organization is treated as having no balance, so serving stops, and the next renewal starts the
 * month again at zero.
 */
export const OVERRUN_CEILING_MICROS = 5_000 * MICROS_PER_CREDIT;
/** The Free allowance of one UTC month. */
export const FREE_MONTHLY_MICROS = 200 * MICROS_PER_CREDIT;
/** The Paid allowance of one period. */
export const PAID_MONTHLY_MICROS = 1_000 * MICROS_PER_CREDIT;
/** After the credit is exhausted the service keeps running this long before the runtime decision denies. */
export const CREDIT_GRACE_MS = 7 * 86_400_000;
/** The end of the monthly period of an account that was never written: its first write renews the Free allowance. */
export const NEVER = "1970-01-01T00:00:00.000000Z";

export type PaidSource = "stripe" | "granted" | "manual";

/** What a statement builder returns: the statements for the caller's batch and the reader of their results. */
export interface CreditPlan<Result> {
  readonly statements: D1PreparedStatement[];
  /** Reads the results of `statements`, in order; a caller that batched more passes the slice of the plan. */
  readonly read: (results: readonly D1Result[]) => Result;
}

/**
 * A statement over numbered parameters (`?1`, `?2`, ...) bound from one list of values: it takes the values up to the
 * highest index it mentions, so several statements of one plan can share the numbering of their common inputs.
 */
export function numbered(
  db: D1Database,
  sql: string,
  values: readonly unknown[],
): D1PreparedStatement {
  const highest = Math.max(0, ...[...sql.matchAll(/\?(\d+)/gu)].map((match) => Number(match[1])));
  return db.prepare(sql).bind(...values.slice(0, highest));
}

/** A non-negative safe integer of micro-credits; anything else is a programming error, never data. */
export function micros(value: number, what = "amount"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer of micro-credits`);
  }
  return value;
}

export const instantMs = (stored: string): number => Date.parse(`${stored.slice(0, 23)}Z`);

/** The first instant of the UTC month after `now` (stored form): where a monthly allowance ends. */
export function nextMonthStart(now: string): string {
  const date = new Date(instantMs(now));
  return storedTimestamp(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(),
  );
}

/** `YYYY-MM` of a stored instant: the period of `project_credit.used_micros`. */
export const monthPeriod = (stored: string): string => stored.slice(0, 7);

/** The stored columns of a credit account, read back by every plan. */
export interface AccountRow {
  readonly monthly_micros: number;
  readonly monthly_ends_at: string;
  readonly onetime_micros: number;
  readonly reserved_micros: number;
  readonly overrun_micros: number;
  /** The overrun as it stood when the current month began (see migration 0670); absent in rows written before it. */
  readonly overrun_base_micros?: number;
  readonly exhausted_at: string | null;
  readonly paid_until: string | null;
  readonly paid_source: PaidSource | null;
}

export const ACCOUNT_SELECT =
  "SELECT monthly_micros, monthly_ends_at, onetime_micros, reserved_micros, overrun_micros, overrun_base_micros, exhausted_at, paid_until, paid_source FROM credit_account WHERE organization_id = ?1";

/** The account as it stands at one instant, with the lazy renewal of a lapsed month already applied. */
export interface AccountView {
  readonly organizationId: string;
  readonly monthlyMicros: number;
  readonly monthlyEndsAt: string;
  readonly onetimeMicros: number;
  readonly reservedMicros: number;
  readonly overrunMicros: number;
  /** The overrun booked in the current month: zero while the month's renewal is pending. */
  readonly overrunMonthMicros: number;
  /** monthly + onetime: what usage is charged against (the `balance_micros` of the log). */
  readonly balanceMicros: number;
  /** balance - reserved, never below zero: what a new reservation may use. */
  readonly availableMicros: number;
  readonly exhaustedAt: string | null;
  readonly graceEndsAt: string | null;
  readonly graceLapsed: boolean;
  readonly paid: boolean;
  readonly paidUntil: string | null;
  readonly paidSource: PaidSource | null;
  /** The stored month has ended and the next write renews it. */
  readonly renewalPending: boolean;
}

const UNTOUCHED: AccountRow = {
  monthly_micros: 0,
  monthly_ends_at: NEVER,
  onetime_micros: 0,
  reserved_micros: 0,
  overrun_micros: 0,
  exhausted_at: null,
  paid_until: null,
  paid_source: null,
};

/**
 * `effectiveMonthly` of the money model: the stored month while it runs, the renewal amount once it has ended (Free
 * 200 credits until the next UTC month start, Paid 1000 credits until the earlier of the paid coverage and that
 * start). A row that does not exist yet is an untouched account.
 */
export function accountView(
  organizationId: string,
  stored: AccountRow | null,
  at: string,
): AccountView {
  const now = storedTimestamp(at);
  const row = stored ?? UNTOUCHED;
  const paidUntil = row.paid_until;
  const paid = paidUntil !== null && paidUntil > now;
  const lapsed = row.monthly_ends_at <= now;
  const monthEnd = nextMonthStart(now);
  const monthlyMicros = lapsed
    ? paid
      ? PAID_MONTHLY_MICROS
      : FREE_MONTHLY_MICROS
    : row.monthly_micros;
  const renewalEnd = paid && paidUntil < monthEnd ? paidUntil : monthEnd;
  const monthlyEndsAt = lapsed ? renewalEnd : row.monthly_ends_at;
  const exhaustedAt = lapsed ? null : row.exhausted_at;
  const graceEndsAt = exhaustedAt === null ? null : addMilliseconds(exhaustedAt, CREDIT_GRACE_MS);
  const balanceMicros = monthlyMicros + row.onetime_micros;
  return {
    organizationId,
    monthlyMicros,
    monthlyEndsAt,
    onetimeMicros: row.onetime_micros,
    reservedMicros: row.reserved_micros,
    overrunMicros: row.overrun_micros,
    overrunMonthMicros: lapsed
      ? 0
      : Math.max(row.overrun_micros - (row.overrun_base_micros ?? 0), 0),
    balanceMicros,
    availableMicros: Math.max(balanceMicros - row.reserved_micros, 0),
    exhaustedAt,
    graceEndsAt,
    graceLapsed: graceEndsAt !== null && graceEndsAt <= now,
    paid,
    paidUntil,
    paidSource: row.paid_source,
    renewalPending: lapsed,
  };
}

/** The account of an organization at `now`; an organization that was never written reads as an untouched account. */
export async function readAccount(
  db: D1Database,
  organizationId: string,
  now: string,
): Promise<AccountView> {
  const row = await db.prepare(ACCOUNT_SELECT).bind(organizationId).first<AccountRow>();
  return accountView(organizationId, row, now);
}

/** The SELECT every plan ends with: the account as the batch left it. */
export function snapshotStatement(db: D1Database, organizationId: string): D1PreparedStatement {
  return db.prepare(ACCOUNT_SELECT).bind(organizationId);
}

/** The account a plan's last statement read; null when the organization has no account (it does not exist). */
export function snapshotRow(result: D1Result | undefined): AccountRow | null {
  return (result?.results[0] as AccountRow | undefined) ?? null;
}

/**
 * Creates the account on first touch, only for an organization that exists (organizations are created by login).
 * A new account starts lapsed, so the renewal of the same batch gives it the Free allowance of the current month.
 */
export function ensureAccount(
  db: D1Database,
  input: { readonly organizationId: string; readonly now: string },
): CreditPlan<{ readonly created: boolean }> {
  const statements = [ensureStatement(db, input.organizationId, storedTimestamp(input.now))];
  return {
    statements,
    read: (results) => ({ created: (results[0]?.meta.changes ?? 0) === 1 }),
  };
}

/** Opens the zero account of an organization that is not deleted; a deleted one gets no account row from a write. */
export function ensureStatement(
  db: D1Database,
  organizationId: string,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO credit_account(organization_id, monthly_micros, monthly_ends_at, onetime_micros, reserved_micros, overrun_micros, exhausted_at, paid_until, paid_source, updated_at)
       SELECT organization_id, 0, '${NEVER}', 0, 0, 0, NULL, NULL, NULL, ?2 FROM organizations WHERE organization_id = ?1 AND state <> 'deleted'`,
    )
    .bind(organizationId, now);
}

// The end and the amount of the renewal, in SQL over the row as it is before the renewal (?2 now, ?3 the next UTC month
// start, ?4 the Free amount, ?5 the Paid amount). A Paid account renews for 1000 credits until its coverage ends or
// the month turns, whichever is first; every other account renews for the Free allowance until the month turns.
const NEW_ENDS = "CASE WHEN paid_until > ?2 THEN MIN(paid_until, ?3) ELSE ?3 END";
const NEW_AMOUNT =
  "CASE WHEN paid_until > ?2 THEN CAST(?5 AS INTEGER) ELSE CAST(?4 AS INTEGER) END";

/**
 * The lazy renewal every spending write starts with: when the stored month has ended, its unspent remainder expires
 * (`expire`), the renewal amount arrives (`renew`) and the exhaustion ends. Both log keys name the end of the new
 * period, which only ever grows, so a renewal is logged once and a later write of the same period renews nothing.
 */
export function renewalStatements(
  db: D1Database,
  organizationId: string,
  now: string,
): D1PreparedStatement[] {
  const month = nextMonthStart(now);
  const expire = db
    .prepare(
      `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
       SELECT 'expire:' || organization_id || ':' || ${NEW_ENDS}, ?2, organization_id, 'expire', -monthly_micros, onetime_micros, json_object('endedAt', monthly_ends_at)
       FROM credit_account WHERE organization_id = ?1 AND monthly_ends_at <= ?2 AND monthly_micros > 0`,
    )
    .bind(organizationId, now, month);
  const renew = db
    .prepare(
      `INSERT INTO credit_log(key, at, organization_id, kind, delta_micros, balance_micros, detail)
       SELECT 'renew:' || organization_id || ':' || ${NEW_ENDS}, ?2, organization_id, 'renew', ${NEW_AMOUNT}, ${NEW_AMOUNT} + onetime_micros,
         json_object('endsAt', ${NEW_ENDS}, 'paid', CASE WHEN paid_until > ?2 THEN json('true') ELSE json('false') END)
       FROM credit_account WHERE organization_id = ?1 AND monthly_ends_at <= ?2`,
    )
    .bind(organizationId, now, month, FREE_MONTHLY_MICROS, PAID_MONTHLY_MICROS);
  const apply = db
    .prepare(
      `UPDATE credit_account SET monthly_micros = ${NEW_AMOUNT}, monthly_ends_at = ${NEW_ENDS}, exhausted_at = NULL, overrun_base_micros = overrun_micros,
         paid_renewal_at = CASE WHEN paid_until > ?2 THEN ?2 ELSE NULL END, updated_at = ?2
       WHERE organization_id = ?1 AND monthly_ends_at <= ?2`,
    )
    .bind(organizationId, now, month, FREE_MONTHLY_MICROS, PAID_MONTHLY_MICROS);
  return [expire, renew, apply];
}

/** Renews the monthly allowance when its period has ended; a second call in the same period changes nothing. */
export function renewIfDue(
  db: D1Database,
  input: { readonly organizationId: string; readonly now: string },
): CreditPlan<{ readonly renewed: boolean; readonly account: AccountView | null }> {
  const now = storedTimestamp(input.now);
  const statements = [
    ensureStatement(db, input.organizationId, now),
    ...renewalStatements(db, input.organizationId, now),
    snapshotStatement(db, input.organizationId),
  ];
  return {
    statements,
    read: (results) => {
      const row = snapshotRow(results[4]);
      return {
        renewed: (results[3]?.meta.changes ?? 0) === 1,
        account: row === null ? null : accountView(input.organizationId, row, now),
      };
    },
  };
}

/**
 * Sets until when the organization is Paid (`paid_until > now`) and why. `extendOnly` keeps a later coverage in place,
 * so an invoice event that arrives out of order cannot shorten it; `paidUntil: null` ends the coverage. A coverage that is
 * set this way replaces the granted access that a Stripe invoice kept aside, so that access is dropped: a later
 * subscription end must not bring back what was changed by hand.
 */
export function setPaid(
  db: D1Database,
  input: {
    readonly organizationId: string;
    readonly paidUntil: string | null;
    readonly source: PaidSource | null;
    readonly now: string;
    readonly extendOnly?: boolean;
  },
): CreditPlan<{ readonly changed: boolean }> {
  const now = storedTimestamp(input.now);
  const paidUntil = input.paidUntil === null ? null : storedTimestamp(input.paidUntil);
  if ((paidUntil === null) !== (input.source === null)) {
    throw new TypeError("paidUntil and source are set together or cleared together");
  }
  const statements = [
    ensureStatement(db, input.organizationId, now),
    db
      .prepare(
        `UPDATE credit_account SET paid_until = ?2, paid_source = ?3, granted_until = NULL, granted_source = NULL, granted_captured_at = NULL, updated_at = ?4
         WHERE organization_id = ?1${
           input.extendOnly === true ? " AND (paid_until IS NULL OR paid_until < ?2)" : ""
         }`,
      )
      .bind(input.organizationId, paidUntil, input.source, now),
  ];
  return { statements, read: (results) => ({ changed: (results[1]?.meta.changes ?? 0) === 1 }) };
}
