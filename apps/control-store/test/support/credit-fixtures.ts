import { expect } from "vitest";

import type { D1Database } from "../../src/d1-types.js";
import { runGrantCredit, runReserve, setPaid } from "../../src/catalog/credit/index.js";

/** The reservation of one build: the quote of `quoteBuildCost`, 16.86912 credits. */
export const BUILD_QUOTE_MICROS = 16_869_120;
/** The instant the fixtures write their credit at: inside the Free month of late October 2026. */
export const FIXTURE_NOW = "2026-10-28T10:00:00.000Z";

export interface FixtureAccount {
  readonly monthly_micros: number;
  readonly onetime_micros: number;
  readonly reserved_micros: number;
  readonly overrun_micros: number;
  readonly exhausted_at: string | null;
  readonly paid_until: string | null;
}

export async function accountOf(db: D1Database, organizationId: string): Promise<FixtureAccount> {
  const row = await db
    .prepare(
      "SELECT monthly_micros, onetime_micros, reserved_micros, overrun_micros, exhausted_at, paid_until FROM credit_account WHERE organization_id = ?",
    )
    .bind(organizationId)
    .first<FixtureAccount>();
  if (row === null) throw new Error(`no credit account for ${organizationId}`);
  return row;
}

/** One-time credit that never expires; the first grant also creates the account and its Free month. */
export async function grantOneTime(
  db: D1Database,
  organizationId: string,
  amountMicros: number,
  key = `topup:fixture-${organizationId}-${amountMicros}`,
  now = FIXTURE_NOW,
): Promise<void> {
  const granted = await runGrantCredit(db, {
    organizationId,
    key,
    kind: "onetime",
    amountMicros,
    now,
  });
  expect(granted.granted).toBe(true);
}

/** Paid until the end of 2099, the entitlement of a Mail plan and of the paid compute sizes. */
export async function makePaid(
  db: D1Database,
  organizationId: string,
  paidUntil = "2099-01-01T00:00:00.000Z",
  now = FIXTURE_NOW,
  source: "granted" | "manual" = "granted",
): Promise<void> {
  const plan = setPaid(db, { organizationId, paidUntil, source, now });
  await db.batch(plan.statements);
}

/** Ends the Paid coverage of the organization at once, the way an expired subscription does. */
export async function endPaid(
  db: D1Database,
  organizationId: string,
  now = FIXTURE_NOW,
): Promise<void> {
  const plan = setPaid(db, { organizationId, paidUntil: null, source: null, now });
  await db.batch(plan.statements);
}

/** Spends the whole balance and leaves the account exhausted since `exhaustedAt` (the 7-day grace runs from there). */
export async function exhaust(
  db: D1Database,
  organizationId: string,
  exhaustedAt: string,
  now = FIXTURE_NOW,
): Promise<void> {
  // The first grant creates the account and its Free month; a repeated exhaustion keeps them.
  await runGrantCredit(db, {
    organizationId,
    key: `topup:ensure-${organizationId}`,
    kind: "onetime",
    amountMicros: 1,
    now,
  });
  await db
    .prepare(
      "UPDATE credit_account SET monthly_micros = 0, onetime_micros = 0, exhausted_at = ?2 WHERE organization_id = ?1",
    )
    .bind(organizationId, exhaustedAt)
    .run();
}

/** Opens the build reservation of an operation, the way an accepted deployment does. */
export async function reserveBuild(
  db: D1Database,
  input: {
    readonly organizationId: string;
    readonly projectId: string;
    readonly operationId: string;
    readonly amountMicros?: number;
    readonly now?: string;
  },
): Promise<void> {
  const reserved = await runReserve(db, {
    organizationId: input.organizationId,
    reservationId: input.operationId,
    projectId: input.projectId,
    amountMicros: input.amountMicros ?? BUILD_QUOTE_MICROS,
    now: input.now ?? FIXTURE_NOW,
    detail: { operationId: input.operationId },
  });
  expect(reserved.reserved).toBe(true);
}
