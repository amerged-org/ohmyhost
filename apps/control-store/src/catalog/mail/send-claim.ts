import { z } from "zod";
import { classifyCustomerMailDomain } from "@ohmyhost/platform";
import type { D1PreparedStatement } from "../../d1-types.js";
import { runCommand, StoreOutcomeUnknownError, type Command } from "../../run-command.js";
import { guard } from "../../guards.js";
import {
  type CatalogContext,
  routeOrganization,
  publicTimestamp,
  addMilliseconds,
  hexBytes,
  ulid,
} from "../common.js";
import {
  chargeOrg,
  readAccount,
  type AccountView,
  type ChargeResult,
  type ProjectBudget,
} from "../credit/index.js";
import {
  SENDER_SQL,
  senderOf,
  mailScope,
  mailHash,
  mailTime,
  mailInput,
  MailReputationSuspended,
} from "./auth.js";
import {
  mailChargeMicros,
  mailPriceSql,
  readMailProjectBudget,
  requireMailAccess,
  requireMailBudget,
  type MailPrice,
} from "./credit.js";

const inputSchema = mailScope.extend({
  provider: z.literal("resend"),
  requestId: ulid,
  idempotencyKey: z.string().min(1).max(128),
  requestSha256: mailHash,
  recipientSha256: mailHash,
  contentSha256: mailHash,
  requestInputSha256: mailHash.optional(),
  sender: z
    .strictObject({ from: z.string().optional(), replyTo: z.string().optional() })
    .optional(),
  paidAt: mailTime,
  requestedAt: mailTime,
});
class MailSendConflict extends Error {
  readonly code = "mail_send_conflict";
  constructor() {
    super("mail_send_conflict");
  }
}
class MailSendScope extends Error {
  readonly code = "mail_send_scope_unavailable";
  constructor() {
    super("mail_send_scope_unavailable");
  }
}
class MailSendLimit extends Error {
  readonly code = "mail_send_daily_limit";
  constructor() {
    super("mail_send_daily_limit");
  }
}
export interface MailClaimReply {
  outcome: "claimed" | "accepted" | "uncertain" | "rejected";
  requestId: string;
  remainingCreditMicros?: string;
  providerMessageId?: string;
  requestedAt?: string;
  providerStarted?: boolean;
  sender?: { domainId: string; bindingRevision: string; from: string; replyTo: string | null };
}
interface Request {
  id: string;
  requestHash: string;
  recipientHash: string;
  contentHash: string;
  inputHash: string | null;
  state: string;
  providerMessageId: string | null;
  requestedAt: string;
  providerStarted: string | null;
  domainId: string | null;
  bindingRevision: string | null;
  from: string | null;
  replyTo: string | null;
}
interface Data {
  request: Request | null;
  collision: number;
  project: { lifecycleState: string; ownerState: string } | null;
  environment: number;
  legacyReady: number;
  legacyName: string | null;
  legacyDomain: string | null;
  reputation: { state: string; warmup: string } | null;
  sender: Record<string, unknown> | null;
  quote: MailPrice | null;
  daily: string;
  eligible: string;
  bounced: string;
  complained: string;
}
const requestJson = `json_object('id',request_id,'requestHash',lower(hex(request_sha256)),'recipientHash',lower(hex(recipient_sha256)),'contentHash',lower(hex(content_sha256)),'inputHash',CASE WHEN request_input_sha256 IS NULL THEN NULL ELSE lower(hex(request_input_sha256)) END,'state',state,'providerMessageId',provider_message_id,'requestedAt',requested_at,'providerStarted',provider_started_at,'domainId',mail_domain_id,'bindingRevision',CAST(mail_binding_revision AS TEXT),'from',effective_from,'replyTo',effective_reply_to)`;
const senderFields = [
  "domain_id",
  "domain",
  "bindingRevision",
  "legacy",
  "senderAddresses",
  "defaultFrom",
  "defaultReplyTo",
  "keyOrganizationId",
  "keyProjectId",
  "keyEnvironmentId",
  "reputationState",
  "registrableDomain",
  "applicationHostname",
  "ciphertext",
  "nonce",
  "valueSha256",
  "keyVersion",
];
const senderJson = `json_object(${senderFields.flatMap((field) => [`'${field}'`, field]).join(",")})`;
const selectedDomain = `(SELECT domain_id FROM(${SENDER_SQL}))`;
function fingerprint() {
  return `json_object('request',(SELECT ${requestJson} FROM mail_send_requests WHERE organization_id=?1 AND project_id=?2 AND idempotency_key=?5),'collision',EXISTS(SELECT 1 FROM mail_send_requests WHERE request_id=?6),'project',(SELECT json_object('lifecycleState',lifecycle_state,'ownerState',owner_state) FROM projects WHERE organization_id=?1 AND project_id=?2),'environment',EXISTS(SELECT 1 FROM environments WHERE organization_id=?1 AND project_id=?2 AND environment_id=?3),'legacyReady',EXISTS(SELECT 1 FROM resend_mail_domains WHERE organization_id=?1 AND project_id=?2 AND sending=1 AND sending_status='ready' AND sending_key_id IS NOT NULL AND deleted_at IS NULL),'legacyName',(SELECT domain FROM resend_mail_domains WHERE organization_id=?1 AND project_id=?2 AND sending=1 AND sending_status='ready' AND sending_key_id IS NOT NULL AND deleted_at IS NULL),'legacyDomain',(SELECT w.domain_id FROM resend_mail_domains d JOIN workspace_mail_domains w ON w.legacy_domain_id=d.domain_id AND w.organization_id=d.organization_id AND w.status='active' JOIN projects p ON p.organization_id=d.organization_id AND p.project_id=d.project_id AND p.owner_state='active' AND p.lifecycle_state='active' WHERE d.organization_id=?1 AND d.project_id=?2 AND d.deleted_at IS NULL AND ?4>=d.configured_at),'reputation',(SELECT json_object('state',state,'warmup',warmup_started_at) FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2),'sender',(SELECT ${senderJson} FROM(${SENDER_SQL})),'quote',${mailPriceSql("mail.sent", "?4")},'daily',(SELECT CAST(COUNT(*) AS TEXT) FROM mail_send_requests WHERE organization_id=?1 AND project_id=?2 AND state<>'rejected' AND requested_at>=substr(?4,1,10)||'T00:00:00.000000Z'),'eligible',(SELECT CAST(COUNT(DISTINCT r.request_id) AS TEXT) FROM mail_send_requests r WHERE r.organization_id=?1 AND r.mail_domain_id=${selectedDomain} AND r.state='accepted' AND r.requested_at>?7 AND r.requested_at<=?4),'bounced',(SELECT CAST(COUNT(DISTINCT e.request_id) AS TEXT) FROM mail_send_events e JOIN mail_send_requests r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.request_id=e.request_id WHERE r.organization_id=?1 AND r.mail_domain_id=${selectedDomain} AND e.reputation_kind='hard_bounce' AND e.received_at>?7 AND e.received_at<=?4),'complained',(SELECT CAST(COUNT(DISTINCT e.request_id) AS TEXT) FROM mail_send_events e JOIN mail_send_requests r ON r.organization_id=e.organization_id AND r.project_id=e.project_id AND r.request_id=e.request_id WHERE r.organization_id=?1 AND r.mail_domain_id=${selectedDomain} AND e.reputation_kind='complaint' AND e.received_at>?7 AND e.received_at<=?4))`;
}
/** What one claim decides over: the fingerprint of the mail facts, and the credit account and budget at that instant. */
interface Snapshot {
  fingerprint: unknown;
  account: AccountView;
  budget: ProjectBudget | null;
}
function dataOf(snapshot: Snapshot) {
  const value = snapshot.fingerprint;
  if (typeof value !== "string") throw new Error("mail_unavailable");
  return { text: value, data: JSON.parse(value) as Data };
}
function replay(row: Request, input: z.output<typeof inputSchema>): MailClaimReply {
  if (
    (row.inputHash !== null && input.requestInputSha256 !== undefined
      ? row.inputHash !== input.requestInputSha256
      : row.requestHash !== input.requestSha256) ||
    row.recipientHash !== input.recipientSha256 ||
    row.contentHash !== input.contentSha256
  )
    throw new MailSendConflict();
  if (row.state === "accepted") {
    if (row.providerMessageId === null) throw new MailSendConflict();
    return { outcome: "accepted", requestId: row.id, providerMessageId: row.providerMessageId };
  }
  if (row.state === "rejected") return { outcome: "rejected", requestId: row.id };
  return {
    outcome: "uncertain",
    requestId: row.id,
    requestedAt: publicTimestamp(row.requestedAt),
    providerStarted: row.providerStarted !== null,
    ...(row.domainId !== null && row.from !== null && row.bindingRevision !== null
      ? {
          sender: {
            domainId: row.domainId,
            bindingRevision: row.bindingRevision,
            from: row.from,
            replyTo: row.replyTo,
          },
        }
      : {}),
  };
}
/** Paid-check, claim and the charge of one recipient in ONE Core batch; a rejected send is refunded by its transition. */
export async function claimMailSend(
  context: CatalogContext,
  raw: unknown,
): Promise<MailClaimReply> {
  const input = mailInput(inputSchema, raw),
    { db } = await routeOrganization(context, input.organizationId),
    sql = fingerprint(),
    values = [
      input.organizationId,
      input.projectId,
      input.environmentId,
      input.requestedAt,
      input.idempotencyKey,
      input.requestId,
      addMilliseconds(input.requestedAt, -30 * 86400000),
    ],
    deadline = Date.now() + 10000;
  const command: Command<Snapshot, MailClaimReply> = {
    name: "mail.claimSend",
    input,
    // The protocol invokes this hook on an ambiguous write. Abort without any observation/redecision;
    // a later caller owns the original retained-request observation, never a reconstructed permission.
    lookup: async () => {
      throw new StoreOutcomeUnknownError("store_outcome_unknown");
    },
    retryOn: ["precondition_changed"],
    naturalKeyTables: ["credit_log", "mail_send_requests"],
    read: async (reader) => {
      const [row, account, budget] = await Promise.all([
        reader
          .prepare(`SELECT ${sql} fingerprint`)
          .bind(...values)
          .first<{ fingerprint: unknown }>(),
        readAccount(reader, input.organizationId, input.paidAt),
        readMailProjectBudget(reader, input.organizationId, input.projectId),
      ]);
      return { fingerprint: row?.fingerprint, account, budget };
    },
    decide: (snapshot) => {
      requireMailAccess(snapshot.account);
      const { data, text } = dataOf(snapshot);
      if (data.request) return { replay: replay(data.request, input) };
      if (data.collision) throw new MailSendConflict();
      if (input.sender === undefined && data.legacyReady === 1) {
        try {
          classifyCustomerMailDomain(data.legacyName ?? "");
        } catch {
          throw new MailSendScope();
        }
      }
      const sender = input.sender === undefined ? null : senderOf(data.sender ?? undefined),
        from =
          sender === null
            ? null
            : (input.sender?.from ?? sender.defaultFrom ?? `no-reply@${sender.domain}`),
        replyTo = sender === null ? null : (input.sender?.replyTo ?? sender.defaultReplyTo);
      if (
        sender !== null &&
        (from === null ||
          from.slice(from.lastIndexOf("@") + 1) !== sender.domain ||
          !/^[A-Za-z0-9._%+-]+@[^\s<>@]+$/u.test(from) ||
          (sender.senderAddresses !== null && !sender.senderAddresses.includes(from)))
      )
        throw new TypeError("Sender address is not enabled for this project");
      if (
        !data.project ||
        data.project.lifecycleState !== "active" ||
        data.project.ownerState !== "active" ||
        !data.reputation ||
        data.environment !== 1 ||
        (sender === null && data.legacyReady !== 1)
      )
        throw new MailSendScope();
      if (data.reputation.state === "suspended") throw new MailReputationSuspended();
      if (data.reputation.state !== "active") throw new MailSendConflict();
      if (sender !== null) {
        const eligible = BigInt(data.eligible),
          complained = BigInt(data.complained),
          bounced = BigInt(data.bounced);
        if (eligible > 0n && (complained * 1000n > eligible || bounced * 20n > eligible))
          throw new MailReputationSuspended();
      }
      const age = Date.parse(input.requestedAt) - Date.parse(data.reputation.warmup);
      if (age < 0 || !Number.isFinite(age))
        throw new TypeError("Mail warm-up timestamps are invalid");
      const limit = age < 86400000 ? 10 : age < 3 * 86400000 ? 25 : age < 7 * 86400000 ? 50 : 100;
      if (BigInt(data.daily) >= BigInt(limit)) throw new MailSendLimit();
      if (!data.quote) throw new MailSendScope();
      const charge = mailChargeMicros(data.quote.rate);
      if (charge === null) throw new MailSendConflict();
      requireMailBudget(snapshot.account, snapshot.budget, input.paidAt);
      const charged = chargeOrg(db, {
        organizationId: input.organizationId,
        key: `mail:${input.requestId}`,
        amountMicros: charge,
        now: input.requestedAt,
        detail: {
          source: "mail",
          requestId: input.requestId,
          projectId: input.projectId,
          meter: "mail.sent",
          quantity: "1",
          unit: "recipient",
          rateCardId: data.quote.card,
          chargeMicros: charge,
          lines: [
            {
              projectId: input.projectId,
              environmentId: input.environmentId,
              meter: "mail.sent",
              unit: "recipient",
              rateCardId: data.quote.card,
              quantity: "1",
              chargeMicros: charge,
            },
          ],
        },
        projects: [{ projectId: input.projectId, amountMicros: charge }],
      });
      const body: D1PreparedStatement[] = [
        guard(db, "precondition_changed", `(${sql})<>?`, [...values, text]),
        db
          .prepare(
            `INSERT INTO mail_send_requests(request_id,organization_id,project_id,idempotency_key,request_sha256,recipient_sha256,content_sha256,state,requested_at,updated_at,mail_provider,mail_domain_id,mail_binding_revision,effective_from,effective_reply_to,request_input_sha256)VALUES(?,?,?,?,?,?,?, 'reserved',?,?,'resend',?,?,?,?,?)`,
          )
          .bind(
            input.requestId,
            input.organizationId,
            input.projectId,
            input.idempotencyKey,
            hexBytes(input.requestInputSha256 ?? input.requestSha256),
            hexBytes(input.recipientSha256),
            hexBytes(input.contentSha256),
            input.requestedAt,
            input.requestedAt,
            sender?.domainId ?? data.legacyDomain,
            sender?.bindingRevision ?? null,
            from,
            replyTo,
            input.requestInputSha256 === undefined ? null : hexBytes(input.requestInputSha256),
          ),
        ...charged.statements,
        guard(
          db,
          "precondition_changed",
          "CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)>?",
          [deadline],
        ),
      ];
      return {
        statements: body,
        result: (results) => {
          const spent: ChargeResult = charged.read(results.slice(2, 2 + charged.statements.length));
          return {
            outcome: "claimed",
            requestId: input.requestId,
            remainingCreditMicros: String(spent.account?.availableMicros ?? 0),
            ...(sender !== null && from !== null
              ? {
                  sender: {
                    domainId: sender.domainId,
                    bindingRevision: sender.bindingRevision,
                    from,
                    replyTo,
                  },
                }
              : {}),
          };
        },
      };
    },
  };
  // Claim success is never reconstructed after an unknown delivery; the retained request owns the next observation.
  return runCommand(db, command);
}
