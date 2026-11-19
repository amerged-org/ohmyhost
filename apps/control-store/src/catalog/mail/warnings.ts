import { z } from "zod";
import { runCommand } from "../../run-command.js";
import {
  type CatalogContext,
  routeOrganization,
  publicTimestamp,
  addMilliseconds,
  ulid,
} from "../common.js";
import { mailInput, mailTime } from "./auth.js";
import { unknownOutcome } from "../unknown-outcome.js";

// The exhaustion warning of the credit account: one email per exhaustion episode. An episode is the `exhausted_at` of
// `credit_account`; `warned_for_exhausted_at` remembers the episode whose warning went out, so a top-up and a later
// exhaustion warn again and nothing else does. `warning_next_attempt_at` is the lease of a claim and, after a send that
// reached nobody, the time of the next try.

/** A claimed period belongs to its claimant this long; a send that never reports back is tried again afterwards. */
const LEASE_MS = 900_000;
/** A period whose warning reached nobody is tried again after this. */
const RETRY_MS = 300_000;

// Exhausted accounts whose month has not renewed lazily yet, whose episode was not warned and that are not leased.
const DUE = `SELECT a.organization_id, a.exhausted_at, a.warning_next_attempt_at FROM credit_account a
 JOIN organizations m ON m.organization_id = a.organization_id
 WHERE a.exhausted_at IS NOT NULL AND a.monthly_ends_at > ?1 AND a.warned_for_exhausted_at IS NOT a.exhausted_at
 AND (a.warning_next_attempt_at IS NULL OR a.warning_next_attempt_at <= ?1)
 AND m.state = 'active' AND m.beta_admitted_at IS NOT NULL
 ORDER BY COALESCE(a.warning_next_attempt_at, a.exhausted_at), a.organization_id LIMIT 2`;
interface Period {
  organization_id: string;
  exhausted_at: string;
  warning_next_attempt_at: string | null;
}

/**
 * Leases the two oldest due warnings. The lease is a compare-and-set on the account, so of two concurrent claimers
 * exactly one gets a period; the claim of a period whose lease runs out is taken over by the next run.
 */
export async function claimCreditWarningPeriods(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ now: mailTime }), raw);
  await context.router.assertLayout();
  const db = context.directory,
    name = "mail.claimWarningPeriods";
  return runCommand<
    Period[],
    { organizationId: string; exhaustedAt: string; leaseUntil: string }[]
  >(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    read: async (reader) => (await reader.prepare(DUE).bind(input.now).all<Period>()).results,
    decide: (due) => {
      if (due.length === 0) return { replay: [] };
      const lease = addMilliseconds(input.now, LEASE_MS);
      return {
        statements: due.map((row) =>
          db
            .prepare(
              `UPDATE credit_account SET warning_next_attempt_at = ?3
               WHERE organization_id = ?1 AND exhausted_at = ?2 AND warned_for_exhausted_at IS NOT exhausted_at AND warning_next_attempt_at IS ?4`,
            )
            .bind(row.organization_id, row.exhausted_at, lease, row.warning_next_attempt_at),
        ),
        result: (results) =>
          due
            .filter((_, index) => results[index]?.meta.changes === 1)
            .map((row) => ({
              organizationId: row.organization_id,
              exhaustedAt: publicTimestamp(row.exhausted_at),
              leaseUntil: publicTimestamp(lease),
            })),
      };
    },
  });
}

/**
 * Ends a claimed period: `delivered` records the episode as warned, otherwise the period is due again after the retry
 * interval. Only the holder of the lease (`leaseUntil` is still the stored value) of the same episode changes anything;
 * the answer says whether it did.
 */
export async function finishCreditWarningPeriod(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(
      z.strictObject({
        organizationId: ulid,
        exhaustedAt: mailTime,
        leaseUntil: mailTime,
        now: mailTime,
        delivered: z.boolean(),
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.finishWarningPeriod";
  return runCommand<undefined, boolean>(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    read: async () => undefined,
    decide: () => ({
      statements: [
        db
          .prepare(
            `UPDATE credit_account SET
               warned_for_exhausted_at = CASE WHEN ?4 = 1 THEN exhausted_at ELSE warned_for_exhausted_at END,
               warning_next_attempt_at = CASE WHEN ?4 = 1 THEN NULL ELSE ?5 END
             WHERE organization_id = ?1 AND exhausted_at = ?2 AND warning_next_attempt_at = ?3`,
          )
          .bind(
            input.organizationId,
            input.exhaustedAt,
            input.leaseUntil,
            input.delivered ? 1 : 0,
            addMilliseconds(input.now, RETRY_MS),
          ),
      ],
      result: (results) => results[0]?.meta.changes === 1,
    }),
  });
}
