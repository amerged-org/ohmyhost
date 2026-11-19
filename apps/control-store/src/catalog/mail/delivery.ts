import { z } from "zod";
import { classifyCustomerMailDomain, mailDeliveryDecision } from "@ohmyhost/platform";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, StoreOutcomeUnknownError } from "../../run-command.js";
import { type CatalogContext, routeOrganization, publicTimestamp, ulid } from "../common.js";
import { shiftStored } from "../../timestamps.js";
import { mailInput, mailScope, mailTime } from "./auth.js";
const scoped = mailScope.extend({ messageId: ulid, now: mailTime }),
  clocked = z.strictObject({ now: mailTime });
const ACTIVE = `JOIN resend_mail_domains d ON d.domain_id=m.domain_id AND d.deleted_at IS NULL AND d.receiving=1 AND d.webhook_url IS NOT NULL AND d.webhook_verified_at IS NOT NULL
 JOIN projects p ON p.organization_id=m.organization_id AND p.project_id=m.project_id AND p.owner_state='active' AND p.lifecycle_state='active'`;
const SELECT = `SELECT m.*,d.domain,d.webhook_url,d.webhook_secret_generation FROM mail_received_messages m ${ACTIVE}`;
const EXACT = `${SELECT} WHERE m.organization_id=?1 AND m.project_id=?2 AND m.environment_id=?3 AND m.message_id=?4`;
const ADMIT = `${EXACT} AND d.receiving_suspended=0 AND d.receiving_status IN('pending','ready')`;
export interface ReceivedRow {
  message_id: string;
  provider_message_id: string;
  domain_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  received_at: string;
  expires_at: string;
  state: string;
  attempts: number;
  first_attempt_at: string | null;
  lease_until: string | null;
  next_attempt_at: string;
  last_http_status: number | null;
  billed_at: string | null;
  domain: string;
  webhook_url: string;
  webhook_secret_generation: number;
}
const values = (input: z.output<typeof scoped>) => [
  input.organizationId,
  input.projectId,
  input.environmentId,
  input.messageId,
];
function wire(row: ReceivedRow): ReceivedRow {
  return {
    ...row,
    received_at: publicTimestamp(row.received_at),
    expires_at: publicTimestamp(row.expires_at),
    first_attempt_at: row.first_attempt_at === null ? null : publicTimestamp(row.first_attempt_at),
    lease_until: row.lease_until === null ? null : publicTimestamp(row.lease_until),
    next_attempt_at: publicTimestamp(row.next_attempt_at),
    billed_at: row.billed_at === null ? null : publicTimestamp(row.billed_at),
  };
}
function unknown(name: string): never {
  throw new StoreOutcomeUnknownError(`${name}: store_outcome_unknown`);
}
/** Original owner/lifecycle/receiving read. Outbound detachment does not remove original inbound access. */
export async function readReceivedMail(
  context: CatalogContext,
  raw: unknown,
): Promise<ReceivedRow | null> {
  const input = mailInput(scoped, raw),
    { db } = await routeOrganization(context, input.organizationId),
    row = await db
      .prepare(EXACT)
      .bind(...values(input))
      .first<ReceivedRow>();
  return row === null
    ? null
    : wire({
        ...row,
        state: Date.parse(input.now) >= Date.parse(row.expires_at) ? "expired" : row.state,
      });
}
/** Original one initial plus three retries, two-minute lease and optional retry-command claim in ONE batch. */
export async function claimReceivedMailAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<ReceivedRow | null> {
  const input = mailInput(
      scoped.extend({
        manual: z.boolean().optional(),
        commandKey: z.string().min(1).max(128).optional(),
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId),
    name = "mail.claimReceivedAttempt";
  type Snapshot = {
    row: ReceivedRow | null;
    command: { claimed_attempt: number | null; response: string | null } | null;
  };
  return runCommand<Snapshot, ReceivedRow | null>(db, {
    name,
    input,
    lookup: async () => unknown(name),
    retryOn: ["precondition_changed"],
    read: async (reader) => {
      const queries = [reader.prepare(ADMIT).bind(...values(input))];
      if (input.commandKey !== undefined)
        queries.push(
          reader
            .prepare(
              "SELECT claimed_attempt,response FROM resend_mail_commands WHERE organization_id=? AND project_id=? AND environment_id=? AND idempotency_key=?",
            )
            .bind(input.organizationId, input.projectId, input.environmentId, input.commandKey),
        );
      const results = await reader.batch(queries);
      return {
        row: (results[0]?.results[0] ?? null) as ReceivedRow | null,
        command: (results[1]?.results[0] ?? null) as Snapshot["command"],
      };
    },
    decide: (snapshot) => {
      const row = snapshot.row;
      if (!row) return { replay: null };
      try {
        classifyCustomerMailDomain(row.domain);
      } catch {
        return { replay: null };
      }
      const decision = mailDeliveryDecision({
        receivedAt: Date.parse(row.received_at),
        firstAttemptAt: row.first_attempt_at === null ? null : Date.parse(row.first_attempt_at),
        attempts: row.attempts,
        delivered: row.state === "delivered",
        now: Date.parse(input.now),
      });
      const fence = guard(
        db,
        "precondition_changed",
        `NOT EXISTS(${ADMIT} AND m.attempts=?5 AND m.state=?6 AND m.first_attempt_at IS ?7 AND m.lease_until IS ?8 AND m.next_attempt_at IS ?9)`,
        [
          ...values(input),
          row.attempts,
          row.state,
          row.first_attempt_at,
          row.lease_until,
          row.next_attempt_at,
        ],
      );
      // A live lease is an attempt in flight: a second claim during it must not expire or fail the message, or the
      // in-flight attempt's answer would be lost.
      if (row.lease_until !== null && Date.parse(row.lease_until) > Date.parse(input.now))
        return { replay: null };
      if (decision.state === "expired" || decision.state === "delivery_failed")
        return {
          statements: [
            fence,
            db
              .prepare(
                "UPDATE mail_received_messages SET state=?,lease_until=NULL WHERE message_id=?",
              )
              .bind(decision.state, input.messageId),
          ],
          result: () => null,
        };
      // A deferral moves the stored due time past now; only the owner's manual retry bypasses it, as it bypasses a schedule.
      if (
        decision.state === "delivered" ||
        (!input.manual && Date.parse(row.next_attempt_at) > Date.parse(input.now)) ||
        (decision.state === "waiting" && !input.manual)
      )
        return { replay: null };
      const attempt = row.attempts + 1,
        first = row.first_attempt_at ?? input.now;
      if (
        input.commandKey !== undefined &&
        (!snapshot.command ||
          snapshot.command.claimed_attempt !== null ||
          snapshot.command.response !== null)
      )
        throw new Error("Mail retry command already claimed");
      const statements = [
        fence,
        db
          .prepare(
            "UPDATE mail_received_messages SET attempts=?,first_attempt_at=COALESCE(first_attempt_at,?),lease_until=?,state='delivering',next_attempt_at=? WHERE message_id=?",
          )
          .bind(
            attempt,
            input.now,
            shiftStored(input.now, 120000),
            shiftStored(first, (attempt === 1 ? 1 : attempt === 2 ? 24 : 71) * 3600000),
            input.messageId,
          ),
      ];
      if (input.commandKey !== undefined)
        statements.push(
          guard(
            db,
            "precondition_changed",
            "NOT EXISTS(SELECT 1 FROM resend_mail_commands WHERE organization_id=? AND project_id=? AND environment_id=? AND idempotency_key=? AND claimed_attempt IS NULL AND response IS NULL)",
            [input.organizationId, input.projectId, input.environmentId, input.commandKey],
          ),
          db
            .prepare(
              "UPDATE resend_mail_commands SET claimed_attempt=? WHERE organization_id=? AND project_id=? AND environment_id=? AND idempotency_key=?",
            )
            .bind(
              attempt,
              input.organizationId,
              input.projectId,
              input.environmentId,
              input.commandKey,
            ),
        );
      // Original return is the PRE-update row, with only attempts and initial first_attempt_at replaced.
      return {
        statements,
        result: () => wire({ ...row, attempts: attempt, first_attempt_at: first }),
      };
    },
  });
}
const nextAttempt = `strftime('%Y-%m-%dT%H:%M:%S',substr(first_attempt_at,1,19)||'Z',CASE attempts WHEN 1 THEN '+1 hours' WHEN 2 THEN '+24 hours' ELSE '+71 hours' END)||substr(first_attempt_at,20)`;
/** Original completion is idempotent on one delivering attempt; no provider HTTP spans this batch. */
export async function completeReceivedMailAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(
    z.strictObject({
      messageId: ulid,
      attempt: z.number().int().min(1).max(4),
      now: mailTime,
      status: z.number().int().min(100).max(599).nullable(),
    }),
    raw,
  );
  await context.router.assertLayout();
  const db = context.directory,
    name = "mail.completeReceivedAttempt";
  await runCommand(db, {
    name,
    input,
    lookup: async () => unknown(name),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            `UPDATE mail_received_messages SET lease_until=NULL,last_http_status=?4,state=CASE WHEN expires_at<=?3 THEN 'expired' WHEN ?4 BETWEEN 200 AND 299 THEN 'delivered' WHEN attempts>=4 THEN 'delivery_failed' ELSE 'pending' END,next_attempt_at=${nextAttempt} WHERE message_id=?1 AND attempts=?2 AND state='delivering'`,
          )
          .bind(input.messageId, input.attempt, input.now, input.status),
      ],
      result: () => undefined,
    }),
  });
}
export async function listReceivedMail(context: CatalogContext, raw: unknown) {
  const input = mailInput(mailScope.extend({ now: mailTime, after: ulid.optional() }), raw),
    { db } = await routeOrganization(context, input.organizationId),
    rows = await db
      .prepare(
        `SELECT m.message_id,m.received_at,m.state,m.attempts FROM mail_received_messages m ${ACTIVE} WHERE m.organization_id=?1 AND m.project_id=?2 AND m.environment_id=?3 AND m.expires_at>?4 AND(?5 IS NULL OR m.message_id<?5) ORDER BY m.message_id DESC LIMIT 50`,
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.environmentId,
        input.now,
        input.after ?? null,
      )
      .all<{ message_id: string; received_at: string; state: string; attempts: number }>();
  return rows.results.map((row) => ({ ...row, received_at: publicTimestamp(row.received_at) }));
}
/**
 * Due messages of the global queue, one share per organization: the oldest due message of every organization comes
 * before the second of any, so one tenant's undeliverable backlog cannot hold back another tenant's mail.
 */
export async function listDueReceivedMail(context: CatalogContext, raw: unknown) {
  const input = mailInput(clocked, raw);
  await context.router.assertLayout();
  return (
    await context.directory
      .prepare(
        `SELECT message_id,organization_id,project_id,environment_id FROM (SELECT m.message_id,m.organization_id,m.project_id,m.environment_id,m.next_attempt_at,ROW_NUMBER() OVER (PARTITION BY m.organization_id ORDER BY m.next_attempt_at,m.message_id) organization_rank FROM mail_received_messages m ${ACTIVE} WHERE d.domain<>'ohmyho.st' AND d.domain NOT LIKE '%.ohmyho.st' AND d.domain<>'omh.st' AND d.domain NOT LIKE '%.omh.st' AND d.domain NOT LIKE '%.poc.aixyte.com' AND m.state IN('pending','delivering') AND d.receiving_suspended=0 AND d.receiving_status IN('pending','ready') AND attempts<4 AND expires_at>?1 AND next_attempt_at<=?1 AND(lease_until IS NULL OR lease_until<=?1)) ORDER BY organization_rank,next_attempt_at,message_id LIMIT 20`,
      )
      .bind(input.now)
      .all<{
        message_id: string;
        organization_id: string;
        project_id: string;
        environment_id: string;
      }>()
  ).results.map((row) => ({
    messageId: row.message_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    environmentId: row.environment_id,
  }));
}
/** Automatic attempts wait this long after a prerequisite (webhook host or content) failed; attempts do not change. */
export const PREREQUISITE_DEFERRAL_MILLISECONDS = 300_000;
const deferInput = scoped.extend({ attempt: z.number().int().min(0).max(3) });
/**
 * A failed prerequisite is not a customer attempt: the due message moves one deferral forward and keeps its attempt
 * count and first attempt time. Fenced on the due, unleased, pending row the caller read.
 */
export async function deferReceivedMailAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<void> {
  const input = mailInput(deferInput, raw);
  await context.router.assertLayout();
  const db = context.directory,
    name = "mail.deferReceivedAttempt";
  await runCommand(db, {
    name,
    input,
    lookup: async () => unknown(name),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE mail_received_messages SET next_attempt_at=?5 WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3 AND message_id=?4 AND attempts=?6 AND state IN('pending','delivering') AND (lease_until IS NULL OR lease_until<=?7) AND next_attempt_at<=?7",
          )
          .bind(
            input.organizationId,
            input.projectId,
            input.environmentId,
            input.messageId,
            shiftStored(input.now, PREREQUISITE_DEFERRAL_MILLISECONDS),
            input.attempt,
            input.now,
          ),
      ],
      result: () => undefined,
    }),
  });
}
/** Both original housekeeping writes remain one global Mail-only batch, including the fourth-attempt lease expiry. */
export async function expireReceivedMail(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(clocked, raw);
  await context.router.assertLayout();
  const db: D1Database = context.directory,
    name = "mail.expireReceived";
  await runCommand(db, {
    name,
    input,
    lookup: async () => unknown(name),
    read: async () => null,
    decide: () => ({
      statements: [
        db
          .prepare(
            "UPDATE mail_received_messages SET state='expired',lease_until=NULL WHERE expires_at<=? AND state<>'expired'",
          )
          .bind(input.now),
        db
          .prepare(
            "UPDATE mail_received_messages SET state='delivery_failed',lease_until=NULL WHERE state='delivering' AND attempts=4 AND lease_until<=?",
          )
          .bind(input.now),
      ],
      result: () => undefined,
    }),
  });
}
