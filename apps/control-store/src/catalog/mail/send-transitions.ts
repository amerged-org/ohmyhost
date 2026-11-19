import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { runCommand, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import { type CatalogContext, routeOrganization, ulid } from "../common.js";
import { refundOrg } from "../credit/index.js";
import {
  mailInput,
  mailScope,
  mailTime,
  readSender,
  MailScopeError,
  MailReputationSuspended,
  SENDER_SQL,
} from "./auth.js";
import { mailChargeMicros, mailPriceSql, type MailPrice } from "./credit.js";
import { unknownOutcome } from "../unknown-outcome.js";

const scope = z.strictObject({ organizationId: ulid, projectId: ulid, requestId: ulid });
class MailSendConflict extends Error {
  readonly code = "mail_send_conflict";
  constructor() {
    super("mail_send_conflict");
  }
}
const requestSql = `SELECT request_id,state,provider_message_id,provider_started_at,requested_at FROM mail_send_requests WHERE organization_id=?1 AND project_id=?2 AND request_id=?3`;
interface Request {
  request_id: string;
  state: string;
  provider_message_id: string | null;
  provider_started_at: string | null;
  requested_at: string;
}
/** One request with the price its charge was booked at and whether the project still belongs to the organization. */
export interface TransitionSnapshot {
  request: Request | undefined;
  price: MailPrice | null;
  owned: boolean;
}
function requestOf(snapshot: TransitionSnapshot): Request {
  if (!snapshot.request) throw new MailSendConflict();
  return snapshot.request;
}
/** Original read/authorize provider-start boundary, never reconstructed after an ambiguous commit. */
export async function authorizeMailSend(context: CatalogContext, raw: unknown): Promise<boolean> {
  const input = mailInput(
      mailScope.extend({
        requestId: ulid,
        idempotencyKey: z.string().min(1).max(128),
        now: mailTime,
      }),
      raw,
    ),
    { db } = await routeOrganization(context, input.organizationId);
  let sender;
  try {
    sender = await readSender(db, input);
  } catch (error) {
    if (error instanceof MailScopeError || error instanceof MailReputationSuspended) return false;
    throw error;
  }
  const sql = `SELECT request_id FROM mail_send_requests r WHERE r.organization_id=?1 AND r.project_id=?2 AND r.request_id=?5 AND r.idempotency_key=?6 AND r.mail_provider='resend' AND r.state='reserved' AND r.provider_started_at IS NULL AND(r.mail_domain_id=?7 OR r.mail_domain_id IS NULL)
 AND EXISTS(SELECT 1 FROM mail_reputation_states p WHERE p.organization_id=r.organization_id AND p.project_id=r.project_id AND p.state='active')
 AND EXISTS(SELECT 1 FROM(${SENDER_SQL}) sender WHERE sender.domain_id=?7 AND sender.domain=?8 AND sender.registrableDomain IS ?9 AND sender.reputationState='active')`,
    values = [
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.now,
      input.requestId,
      input.idempotencyKey,
      sender.domainId,
      sender.domain,
      sender.registrableDomain,
    ];
  return runCommand<{ request_id: string } | null, boolean>(db, {
    name: "mail.authorizeSend",
    input,
    lookup: unknownOutcome("mail.authorizeSend"),
    retryOn: ["precondition_changed"],
    read: (reader) =>
      reader
        .prepare(sql)
        .bind(...values)
        .first<{ request_id: string }>(),
    decide: (row) =>
      row === null
        ? { replay: false }
        : {
            statements: [
              guard(db, "precondition_changed", `NOT EXISTS(${sql})`, values),
              db
                .prepare(
                  "UPDATE mail_send_requests SET provider_started_at=?,updated_at=? WHERE request_id=?",
                )
                .bind(input.now, input.now, input.requestId),
            ],
            result: () => true,
          },
  });
}
/** The request, the price of its charge and the project owner in ONE consistent read. */
async function readTransition(
  db: D1Database,
  input: z.output<typeof scope>,
): Promise<TransitionSnapshot> {
  const [request, price, owned] = await db.batch([
    db.prepare(requestSql).bind(input.organizationId, input.projectId, input.requestId),
    db
      .prepare(
        `SELECT ${mailPriceSql("mail.sent", `(SELECT requested_at FROM mail_send_requests WHERE organization_id=?1 AND project_id=?2 AND request_id=?3)`)} price`,
      )
      .bind(input.organizationId, input.projectId, input.requestId),
    db
      .prepare(
        "SELECT 1 owned FROM projects WHERE organization_id=? AND project_id=? AND owner_state='active'",
      )
      .bind(input.organizationId, input.projectId),
  ]);
  const quote = (price?.results[0] as { price: string | null } | undefined)?.price ?? null;
  return {
    request: request?.results[0] as Request | undefined,
    price: quote === null ? null : (JSON.parse(quote) as MailPrice),
    owned: owned?.results.length === 1,
  };
}

/** In-process signed Resend composition: the original existing request, never a second financial command. */
export function readMailSendIngressSnapshot(db: D1Database, input: z.output<typeof scope>) {
  return readTransition(db, input);
}
export function completeMailSendIngressStep(
  db: D1Database,
  input: z.output<typeof scope>,
  snapshot: TransitionSnapshot,
  providerMessageId: string,
  now: string,
): D1PreparedStatement[] {
  const row = requestOf(snapshot);
  if (row.state === "accepted" && row.provider_message_id === providerMessageId && snapshot.owned)
    return [requestGuard(db, input, row)];
  if (
    !/^[A-Za-z0-9._-]{1,256}$/u.test(providerMessageId) ||
    !["reserved", "uncertain"].includes(row.state) ||
    row.provider_started_at === null ||
    (row.provider_message_id !== null && row.provider_message_id !== providerMessageId)
  )
    throw new MailSendConflict();
  // The charge was booked at the claim: acceptance by the provider changes the request, never the credit.
  return [
    requestGuard(db, input, row),
    db
      .prepare(
        "UPDATE mail_send_requests SET state='accepted',provider_message_id=?,updated_at=? WHERE request_id=?",
      )
      .bind(providerMessageId, now, input.requestId),
  ];
}
function requestGuard(db: D1Database, input: z.output<typeof scope>, row: Request) {
  return guard(
    db,
    "precondition_changed",
    `NOT EXISTS(${requestSql} AND state=?4 AND provider_started_at IS ?5 AND provider_message_id IS ?6 AND requested_at=?7)`,
    [
      input.organizationId,
      input.projectId,
      input.requestId,
      row.state,
      row.provider_started_at,
      row.provider_message_id,
      row.requested_at,
    ],
  );
}
/** Gives back the charge of the claim (`mailrefund:<request>`): the price of the claim's instant, refunded once. */
function refundStep(
  db: D1Database,
  input: z.output<typeof scope>,
  snapshot: TransitionSnapshot,
  row: Request,
  now: string,
  reason: "reject" | "refused",
) {
  const charge = snapshot.price === null ? null : mailChargeMicros(snapshot.price.rate);
  if (charge === null) throw new MailSendConflict();
  return refundOrg(db, {
    organizationId: input.organizationId,
    key: `mailrefund:${input.requestId}`,
    chargeKey: `mail:${input.requestId}`,
    amountMicros: charge,
    now,
    projectId: input.projectId,
    detail: {
      source: "mail",
      requestId: row.request_id,
      projectId: input.projectId,
      meter: "mail.sent",
      reason,
      chargeMicros: charge,
    },
  }).statements;
}
export async function completeMailSend(
  context: CatalogContext,
  raw: unknown,
): Promise<"completed" | "existing"> {
  const input = mailInput(
    scope.extend({
      providerMessageId: z.string().regex(/^[A-Za-z0-9._-]{1,256}$/u),
      completedAt: mailTime,
    }),
    raw,
  );
  return transition(context, input, input.completedAt, "complete", input.providerMessageId);
}
export async function rejectMailSend(
  context: CatalogContext,
  raw: unknown,
): Promise<"released" | "existing"> {
  const input = mailInput(scope.extend({ rejectedAt: mailTime }), raw);
  return transition(context, input, input.rejectedAt, "reject");
}
export type MailAttemptReply =
  | { state: "accepted"; providerMessageId: string }
  | { state: "uncertain" | "rejected" };
export async function settleMailSendAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<MailAttemptReply> {
  const input = mailInput(scope.extend({ observedAt: mailTime, refused: z.boolean() }), raw);
  return transition(context, input, input.observedAt, input.refused ? "refused" : "uncertain");
}
function transition(
  context: CatalogContext,
  input: z.output<typeof scope>,
  now: string,
  mode: "complete",
  providerMessageId: string,
): Promise<"completed" | "existing">;
function transition(
  context: CatalogContext,
  input: z.output<typeof scope>,
  now: string,
  mode: "reject",
): Promise<"released" | "existing">;
function transition(
  context: CatalogContext,
  input: z.output<typeof scope>,
  now: string,
  mode: "refused" | "uncertain",
): Promise<MailAttemptReply>;
async function transition(
  context: CatalogContext,
  input: z.output<typeof scope>,
  now: string,
  mode: "complete" | "reject" | "refused" | "uncertain",
  providerMessageId?: string,
): Promise<"completed" | "existing" | "released" | MailAttemptReply> {
  const { db } = await routeOrganization(context, input.organizationId),
    name = `mail.${mode}Send`,
    deadline = Date.now() + 10000;
  const command: Command<
    TransitionSnapshot,
    "completed" | "existing" | "released" | MailAttemptReply
  > = {
    name,
    input: { ...input, now, mode, providerMessageId },
    lookup: unknownOutcome(name),
    retryOn: ["precondition_changed", "row_version_conflict"],
    naturalKeyTables: ["credit_log"],
    read: (reader) => readTransition(reader, input),
    decide: (snapshot) => {
      const row = requestOf(snapshot),
        owned = snapshot.owned;
      if (
        mode === "complete" &&
        row.state === "accepted" &&
        row.provider_message_id === providerMessageId &&
        owned
      )
        return { replay: "existing" };
      if (mode === "reject" && row.state === "rejected") return { replay: "existing" };
      if (
        mode === "complete" &&
        ((row.state !== "reserved" && row.state !== "uncertain") ||
          row.provider_started_at === null)
      )
        throw new MailSendConflict();
      if (mode === "reject" && row.state !== "reserved" && row.state !== "uncertain")
        throw new MailSendConflict();
      if (mode === "refused" || mode === "uncertain") {
        if (!owned) throw new MailSendConflict();
        if (row.state === "accepted" && row.provider_message_id !== null)
          return { replay: { state: "accepted", providerMessageId: row.provider_message_id } };
        if (row.state === "rejected" || row.state === "uncertain")
          return { replay: { state: row.state } };
        if (row.state !== "reserved" || (mode === "uncertain" && row.provider_started_at === null))
          throw new MailSendConflict();
      }
      const complete = mode === "complete",
        release = mode === "reject" || mode === "refused",
        state = complete ? "accepted" : release ? "rejected" : "uncertain",
        statements: D1PreparedStatement[] = [
          requestGuard(db, input, row),
          db
            .prepare(
              "UPDATE mail_send_requests SET state=?,provider_message_id=?,updated_at=? WHERE request_id=?",
            )
            .bind(state, complete ? providerMessageId : null, now, input.requestId),
        ];
      // A rejected send gives its charge back in the same batch; acceptance and uncertainty keep it.
      if (release) statements.push(...refundStep(db, input, snapshot, row, now, mode));
      if (complete || release)
        statements.push(
          guard(
            db,
            "precondition_changed",
            "CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)>?",
            [deadline],
          ),
        );
      return {
        statements,
        result: () =>
          complete
            ? "completed"
            : mode === "reject"
              ? "released"
              : { state: release ? "rejected" : "uncertain" },
      };
    },
  };
  return runCommand(db, command);
}
