import { z } from "zod";
import { runCommand } from "../../run-command.js";
import { type CatalogContext, addMilliseconds, publicTimestamp } from "../common.js";
import { workosUserId } from "../identity/shared.js";
import { mailInput, mailTime } from "./auth.js";
import { unknownOutcome } from "../unknown-outcome.js";

const token = z.string().uuid();
const claimInput = z.strictObject({ now: mailTime });
const claimRef = { userId: workosUserId, claimToken: token };
const beginInput = z.strictObject({ ...claimRef, now: mailTime });
const finishInput = z
  .strictObject({
    ...claimRef,
    now: mailTime,
    state: z.enum(["pending", "skipped", "accepted", "uncertain"]),
    providerMessageId: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,256}$/u)
      .nullable(),
  })
  .refine((input) => (input.state === "accepted") === (input.providerMessageId !== null));
const ENABLED = "(SELECT enabled FROM signup_feedback_mail_settings WHERE singleton=1)=1";

/** Claim at most ten due users. Only a pre-send claim can be reclaimed after its lease expires. */
export async function claimSignupFeedback(context: CatalogContext, raw: unknown) {
  const input = mailInput(claimInput, raw);
  await context.router.assertLayout();
  const db = context.directory;
  const name = "mail.claimSignupFeedback";
  return runCommand<
    { workos_user_id: string; state: string; lease_until: string | null }[],
    { userId: string; claimToken: string; leaseUntil: string }[]
  >(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    read: async (reader) =>
      (
        await reader
          .prepare(
            `SELECT workos_user_id,state,lease_until FROM signup_feedback_mail WHERE ${ENABLED}
       AND ((state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?1)) OR (state='claimed' AND lease_until<=?1)) ORDER BY created_at,workos_user_id LIMIT 10`,
          )
          .bind(input.now)
          .all<{ workos_user_id: string; state: string; lease_until: string | null }>()
      ).results,
    decide: (due) => {
      const leaseUntil = addMilliseconds(input.now, 900_000);
      const claims = due.map((row) => ({ ...row, claimToken: crypto.randomUUID() }));
      return {
        statements: [
          db
            .prepare(
              `UPDATE signup_feedback_mail SET state='uncertain',claim_token=NULL,lease_until=NULL,updated_at=?1
           WHERE state='sending' AND lease_until<=?1 AND ${ENABLED}`,
            )
            .bind(input.now),
          ...claims.map((row) =>
            db
              .prepare(
                `UPDATE signup_feedback_mail SET state='claimed',claim_token=?3,lease_until=?4,updated_at=?5
           WHERE workos_user_id=?1 AND state=?2 AND lease_until IS ?6 AND ${ENABLED}`,
              )
              .bind(
                row.workos_user_id,
                row.state,
                row.claimToken,
                leaseUntil,
                input.now,
                row.lease_until,
              ),
          ),
        ],
        result: (results) =>
          claims
            .filter((_, index) => results[index + 1]?.meta.changes === 1)
            .map((row) => ({
              userId: row.workos_user_id,
              claimToken: row.claimToken,
              leaseUntil: publicTimestamp(leaseUntil),
            })),
      };
    },
  });
}

/** Permanently cross the send boundary before issuing the provider request. */
export async function beginSignupFeedback(context: CatalogContext, raw: unknown): Promise<boolean> {
  const input = mailInput(beginInput, raw);
  await context.router.assertLayout();
  const db = context.directory,
    name = "mail.beginSignupFeedback";
  return runCommand<undefined, boolean>(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    read: async () => undefined,
    decide: () => ({
      statements: [
        db
          .prepare(
            `UPDATE signup_feedback_mail SET state='sending',updated_at=?3
         WHERE workos_user_id=?1 AND claim_token=?2 AND state='claimed' AND lease_until>?3 AND ${ENABLED}`,
          )
          .bind(input.userId, input.claimToken, input.now),
      ],
      result: (results) => results[0]?.meta.changes === 1,
    }),
  });
}

/** Finishing after an unknown provider outcome is terminal; no stale send is automatically replayed. */
export async function finishSignupFeedback(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(finishInput, raw);
  await context.router.assertLayout();
  const db = context.directory,
    name = "mail.finishSignupFeedback";
  return runCommand<undefined, boolean>(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    read: async () => undefined,
    decide: () => ({
      statements: [
        db
          .prepare(
            `UPDATE signup_feedback_mail SET
         state=?3,
         next_attempt_at=CASE WHEN ?3='pending' THEN ?6 ELSE NULL END,
         provider_message_id=?4,updated_at=?5,claim_token=NULL,lease_until=NULL
         WHERE workos_user_id=?1 AND claim_token=?2 AND
         ((?3 IN ('pending','skipped') AND state='claimed' AND lease_until>?5) OR (?3 IN ('accepted','uncertain') AND state='sending'))`,
          )
          .bind(
            input.userId,
            input.claimToken,
            input.state,
            input.providerMessageId,
            input.now,
            addMilliseconds(input.now, 86_400_000),
          ),
      ],
      result: (results) => results[0]?.meta.changes === 1,
    }),
  });
}

/** Identity resolution is authorized only for a currently claimed user while the campaign is enabled. */
export async function isSignupFeedbackClaim(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = mailInput(z.strictObject(claimRef), raw);
  await context.router.assertLayout();
  const row = await context.directory
    .prepare(
      `SELECT 1 AS valid FROM signup_feedback_mail WHERE workos_user_id=?1 AND claim_token=?2
     AND state='claimed' AND lease_until>(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z') AND ${ENABLED}`,
    )
    .bind(input.userId, input.claimToken)
    .first<{ valid: number }>();
  return row?.valid === 1;
}
