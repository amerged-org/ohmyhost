import { z } from "zod";
import { runCommand } from "../../run-command.js";
import { type CatalogContext, routeOrganization, ulid } from "../common.js";
import { readRuntimeDecision } from "../credit/index.js";
import { mailInput, mailScope, mailTime } from "./auth.js";
import { unknownOutcome } from "../unknown-outcome.js";
export async function listReceivingAdmission(context: CatalogContext, raw: unknown) {
  mailInput(z.strictObject({}), raw);
  await context.router.assertLayout();
  return (
    await context.directory
      .prepare(
        `SELECT d.domain_id,d.organization_id,d.project_id,d.environment_id,d.domain,d.provider_domain_id,d.receiving_status,d.receiving_suspended,d.sending FROM resend_mail_domains d
 JOIN projects p ON p.organization_id=d.organization_id AND p.project_id=d.project_id AND p.owner_state='active' AND p.lifecycle_state='active'
 WHERE d.receiving=1 AND d.deleted_at IS NULL AND d.provider_domain_id IS NOT NULL AND d.webhook_verified_at IS NOT NULL
 ORDER BY d.last_entitlement_check_at,d.domain_id LIMIT 20`,
      )
      .all<Record<string, unknown>>()
  ).results.map((row) => ({
    ...row,
    sending: row["sending"] === 1,
    receiving_suspended: row["receiving_suspended"] === 1,
  }));
}
/** The serving decision of the credit core for the receiving project: Paid, grace and budget, read only. */
export async function readReceivingAdmission(context: CatalogContext, raw: unknown) {
  const input = mailInput(mailScope.extend({ now: mailTime }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    decision = await readRuntimeDecision(db, input);
  return { allowed: decision.allowed, paidAllowed: decision.paidAllowed };
}
/** Separate original local metadata writes; disable is committed before the shared provider writer. */
export async function changeReceivingAdmission(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(
    z.strictObject({
      domainId: ulid,
      phase: z.enum(["disable", "suspend", "resume", "observed", "checked"]),
      now: mailTime.optional(),
      ready: z.boolean().optional(),
    }),
    raw,
  );
  await context.router.assertLayout();
  const db = context.directory,
    name = "mail.changeReceivingAdmission";
  if ((input.phase === "observed" || input.phase === "checked") && input.now === undefined)
    throw new TypeError("Invalid admission clock");
  const sql =
    input.phase === "disable"
      ? "UPDATE resend_mail_domains SET receiving_status='disabled' WHERE domain_id=?1 AND receiving=1 AND deleted_at IS NULL"
      : input.phase === "suspend"
        ? "UPDATE resend_mail_domains SET receiving_suspended=1 WHERE domain_id=?1 AND receiving=1 AND deleted_at IS NULL"
        : input.phase === "resume"
          ? "UPDATE resend_mail_domains SET receiving_suspended=0 WHERE domain_id=?1 AND receiving=1 AND deleted_at IS NULL"
          : input.phase === "observed"
            ? "UPDATE resend_mail_domains SET receiving_suspended=0,receiving_status=?2,observed_at=?3 WHERE domain_id=?1 AND receiving=1 AND deleted_at IS NULL"
            : "UPDATE resend_mail_domains SET last_entitlement_check_at=?2 WHERE domain_id=?1";
  await runCommand(db, {
    name,
    input,
    lookup: unknownOutcome(name),
    read: async () => null,
    decide: () => ({
      statements: [
        input.phase === "observed"
          ? db.prepare(sql).bind(input.domainId, input.ready ? "ready" : "pending", input.now)
          : input.phase === "checked"
            ? db.prepare(sql).bind(input.domainId, input.now)
            : db.prepare(sql).bind(input.domainId),
      ],
      result: () => undefined,
    }),
  });
}
