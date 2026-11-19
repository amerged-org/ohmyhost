import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand } from "../../run-command.js";
import {
  type CatalogContext,
  publicTimestamp,
  addMilliseconds,
  hexBytes,
  ulid,
} from "../common.js";
import { storedTimestamp } from "../../timestamps.js";
import { mailInput, mailHash, mailTime } from "./auth.js";
import { readMailSendIngressSnapshot, completeMailSendIngressStep } from "./send-transitions.js";
import {
  receivedIngressReads,
  receivedIngressStep,
  type ReceivingDomainFacts,
  type ExistingReceivedFacts,
} from "./received-ingress-step.js";
import { unknownOutcome } from "../unknown-outcome.js";

const eventId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
  status = z.enum(["pending", "ready", "failed"]),
  inputSchema = z.strictObject({
    eventId,
    type: z.string(),
    occurredAt: z.string().nullable(),
    providerMessageId: z.string().nullable(),
    digest: mailHash,
    now: mailTime,
    domain: z
      .strictObject({
        providerDomainId: z.string(),
        domain: z.string(),
        valid: z.boolean(),
        sending: status.nullable(),
        receiving: status.nullable(),
        workspaceSending: status,
      })
      .nullable(),
    delivery: z
      .strictObject({
        requestId: ulid.nullable(),
        projectId: ulid.nullable(),
        permanentBounce: z.boolean(),
      })
      .nullable(),
    received: z
      .strictObject({
        recipientDomains: z.array(z.string()).min(1).max(100),
        receivedAt: z.string().nullable(),
        messageId: ulid.nullable(),
      })
      .nullable(),
  });
type Input = z.output<typeof inputSchema>;
type Row = Record<string, unknown>;
const OUTCOMES: Record<string, { type: string; outcome: string; rank: number }> = {
    "email.sent": { type: "Send", outcome: "accepted", rank: 1 },
    "email.delivered": { type: "Delivery", outcome: "delivered", rank: 3 },
    "email.delivery_delayed": { type: "DeliveryDelay", outcome: "delayed", rank: 2 },
    "email.bounced": { type: "Bounce", outcome: "bounced", rank: 5 },
    "email.complained": { type: "Complaint", outcome: "complained", rank: 6 },
    "email.failed": { type: "Reject", outcome: "failed", rank: 4 },
    "email.suppressed": { type: "Reject", outcome: "failed", rank: 4 },
  },
  RANK: Record<string, number> = {
    accepted: 1,
    delayed: 2,
    delivered: 3,
    failed: 4,
    bounced: 5,
    complained: 6,
  };
async function rows(db: D1Database, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (
    await db
      .prepare(sql)
      .bind(...params)
      .all<Row>()
  ).results;
}
/** Exact fixed-query snapshot guards; only Core-produced column names form these local statements. */
function fingerprint(
  db: D1Database,
  sql: string,
  params: unknown[],
  facts: readonly Row[],
): D1PreparedStatement {
  if (!facts.length) return guard(db, "precondition_changed", `EXISTS(${sql})`, params);
  const keys = Object.keys(facts[0] ?? {});
  if (keys.some((key) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key)))
    throw new Error("mail_snapshot_invalid");
  const json = `SELECT json_group_array(json_object(${keys.flatMap((key) => [`'${key}'`, key]).join(",")})) FROM(${sql})`;
  return guard(db, "precondition_changed", `(${json})<>?${params.length + 1}`, [
    ...params,
    JSON.stringify(facts.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])))),
  ]);
}
async function providerEventUuid(name: string) {
  const namespace = hexBytes("3e9d67756b4b5846800c4c1464571c34"),
    text = new TextEncoder().encode(name),
    bytes = new Uint8Array(namespace.length + text.length);
  bytes.set(namespace);
  bytes.set(text, namespace.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes));
  digest[6] = ((digest[6] ?? 0) & 15) | 80;
  digest[8] = ((digest[8] ?? 0) & 63) | 128;
  const h = Array.from(digest.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export async function readResendReceipt(context: CatalogContext, raw: unknown) {
  const input = mailInput(z.strictObject({ eventId }), raw);
  await context.router.assertLayout();
  const row = await context.directory
    .prepare("SELECT lower(hex(payload_sha256)) digest FROM resend_event_receipts WHERE event_id=?")
    .bind(input.eventId)
    .first<{ digest: string }>();
  return row === null ? null : { eventId: input.eventId, digest: row.digest };
}

const LEGACY_DOMAIN = `SELECT d.domain_id,d.organization_id,d.sending,d.receiving,d.receiving_suspended,d.observed_at,EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=d.domain_id AND w.status='active') shared FROM resend_mail_domains d WHERE d.provider_domain_id=?1 AND d.domain=?2 AND d.deleted_at IS NULL`,
  WORKSPACE_DOMAIN =
    "SELECT domain_id,organization_id,observed_at FROM workspace_mail_domains WHERE provider_domain_id=?1 AND domain=?2 AND legacy_domain_id IS NULL AND status='active'",
  REQUEST =
    "SELECT organization_id,project_id,request_id,state,provider_started_at,provider_message_id,requested_at,mail_domain_id FROM mail_send_requests WHERE project_id=?1 AND request_id=?2 AND mail_provider='resend' AND provider_started_at IS NOT NULL",
  EVENT =
    "SELECT provider_event_id,organization_id,project_id,request_id,provider_message_id,event_type,outcome,lower(hex(detail_sha256)) digest,occurred_at,sent_at,received_at,reputation_kind FROM mail_send_events WHERE provider_event_id=?1",
  OUTCOME =
    "SELECT outcome,provider_event_id,occurred_at,CAST(version AS TEXT) version FROM mail_send_outcomes WHERE organization_id=?1 AND project_id=?2 AND request_id=?3";
interface Query {
  sql: string;
  params: unknown[];
  facts: Row[];
}
interface Snapshot {
  receipt: { digest: string } | null;
  queries: Query[];
  legacy: Row[];
  workspace: Row[];
  request: Row | undefined;
  event: Row | undefined;
  outcome: Row | undefined;
  transition: Awaited<ReturnType<typeof readMailSendIngressSnapshot>> | undefined;
  receiverRows: ReceivingDomainFacts[];
  existingReceived: ExistingReceivedFacts | undefined;
  reputation: ReputationSnapshot | undefined;
}
interface ReputationSnapshot {
  project: Row | undefined;
  workspace: Row | undefined;
  projectMetrics: Row;
  workspaceMetrics: Row | undefined;
  seen: Row;
}

async function reputationSnapshot(
  db: D1Database,
  request: Row,
  input: Input,
  query: (sql: string, params: unknown[]) => Promise<Row[]>,
): Promise<ReputationSnapshot> {
  const org = String(request["organization_id"]),
    project = String(request["project_id"]),
    domain = request["mail_domain_id"],
    lower = addMilliseconds(input.now, -30 * 86400000),
    projectState = (
      await query(
        "SELECT state,CAST(version AS TEXT) version FROM mail_reputation_states WHERE organization_id=?1 AND project_id=?2",
        [org, project],
      )
    )[0],
    metrics = (
      await query(
        `SELECT CAST((SELECT COUNT(*) FROM mail_send_requests WHERE organization_id=?1 AND project_id=?2 AND state='accepted' AND requested_at>?3 AND requested_at<=?4) AS TEXT) eligible,CAST((SELECT COUNT(DISTINCT request_id) FROM mail_send_events WHERE organization_id=?1 AND project_id=?2 AND reputation_kind='hard_bounce' AND received_at>?3 AND received_at<=?4) AS TEXT) bounce,CAST((SELECT COUNT(DISTINCT request_id) FROM mail_send_events WHERE organization_id=?1 AND project_id=?2 AND reputation_kind='complaint' AND received_at>?3 AND received_at<=?4) AS TEXT) complaint`,
        [org, project, lower, input.now],
      )
    )[0],
    seen = (
      await query(
        "SELECT EXISTS(SELECT 1 FROM mail_send_events WHERE organization_id=?1 AND project_id=?2 AND request_id=?3 AND reputation_kind='hard_bounce' AND received_at>?4 AND received_at<=?5) bounce,EXISTS(SELECT 1 FROM mail_send_events WHERE organization_id=?1 AND project_id=?2 AND request_id=?3 AND reputation_kind='complaint' AND received_at>?4 AND received_at<=?5) complaint",
        [org, project, request["request_id"], lower, input.now],
      )
    )[0];
  if (!metrics || !seen) throw new Error("mail_reputation_conflict");
  let workspace: Row | undefined, workspaceMetrics: Row | undefined;
  if (domain !== null) {
    workspace = (
      await query(
        "SELECT domain_id,reputation_state state,CAST(reputation_version AS TEXT) version FROM workspace_mail_domains WHERE organization_id=?1 AND domain_id=?2",
        [org, domain],
      )
    )[0];
    workspaceMetrics = (
      await query(
        `SELECT CAST(COUNT(DISTINCT CASE WHEN r.state='accepted' AND r.requested_at>?3 AND r.requested_at<=?4 THEN r.request_id END) AS TEXT) eligible,CAST(COUNT(DISTINCT CASE WHEN e.reputation_kind='hard_bounce' AND e.received_at>?3 AND e.received_at<=?4 THEN e.request_id END) AS TEXT) bounce,CAST(COUNT(DISTINCT CASE WHEN e.reputation_kind='complaint' AND e.received_at>?3 AND e.received_at<=?4 THEN e.request_id END) AS TEXT) complaint FROM mail_send_requests r LEFT JOIN mail_send_events e ON e.organization_id=r.organization_id AND e.project_id=r.project_id AND e.request_id=r.request_id WHERE r.organization_id=?1 AND r.mail_domain_id=?2`,
        [org, domain, lower, input.now],
      )
    )[0];
  }
  void db;
  return { project: projectState, workspace, projectMetrics: metrics, workspaceMetrics, seen };
}
function reputationStep(
  db: D1Database,
  request: Row,
  facts: ReputationSnapshot,
  impact: string,
  input: Input,
  id: string,
): D1PreparedStatement[] {
  const org = String(request["organization_id"]),
    project = String(request["project_id"]),
    fresh =
      request["state"] !== "accepted" &&
      String(request["requested_at"]) > addMilliseconds(input.now, -30 * 86400000) &&
      String(request["requested_at"]) <= input.now,
    counts = (row: Row) => ({
      eligible: BigInt(String(row["eligible"])) + (fresh ? 1n : 0n),
      bounce:
        BigInt(String(row["bounce"])) +
        (impact === "hard_bounce" && facts.seen["bounce"] === 0 ? 1n : 0n),
      complaint:
        BigInt(String(row["complaint"])) +
        (impact === "complaint" && facts.seen["complaint"] === 0 ? 1n : 0n),
    }),
    threshold = (c: ReturnType<typeof counts>) =>
      c.eligible === 0n
        ? null
        : c.complaint * 1000n > c.eligible
          ? "complaint_rate"
          : c.bounce * 20n > c.eligible
            ? "bounce_rate"
            : null,
    statements: D1PreparedStatement[] = [];
  if (facts.workspace && facts.workspace["state"] !== "suspended" && facts.workspaceMetrics) {
    const c = counts(facts.workspaceMetrics),
      reason = threshold(c);
    if (reason)
      statements.push(
        db
          .prepare(
            "INSERT INTO workspace_mail_reputation_decisions(decision_id,domain_id,organization_id,project_id,action,reason,triggering_event_id,eligible_send_count,hard_bounce_count,complaint_count,actor_id,occurred_at)VALUES(?,?,?,?,'suspend',?,?,CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER),'system:shared-mail-reputation',?) ON CONFLICT DO NOTHING",
          )
          .bind(
            id,
            request["mail_domain_id"],
            org,
            project,
            reason,
            id,
            c.eligible.toString(),
            c.bounce.toString(),
            c.complaint.toString(),
            input.now,
          ),
        db
          .prepare(
            "UPDATE workspace_mail_domains SET reputation_state='suspended',reputation_suspended_at=?,reputation_suspension_reason=?,reputation_triggering_event_id=?,reputation_version=reputation_version+1 WHERE organization_id=? AND domain_id=? AND reputation_state='active'",
          )
          .bind(input.now, reason, id, org, request["mail_domain_id"]),
      );
  }
  if (!facts.project) throw new Error("mail_reputation_conflict");
  if (facts.project["state"] !== "suspended") {
    const c = counts(facts.projectMetrics),
      reason = threshold(c);
    if (reason)
      statements.push(
        db
          .prepare(
            "INSERT INTO mail_reputation_decisions(decision_id,organization_id,project_id,action,reason,triggering_event_id,eligible_send_count,hard_bounce_count,complaint_count,actor_id,occurred_at)VALUES(?,?,?,'suspend',?,?,CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER),'system:ses-reputation',?)",
          )
          .bind(
            id,
            org,
            project,
            reason,
            id,
            c.eligible.toString(),
            c.bounce.toString(),
            c.complaint.toString(),
            input.now,
          ),
        db
          .prepare(
            "UPDATE mail_reputation_states SET state='suspended',suspended_at=?,suspension_reason=?,triggering_event_id=?,version=version+1,updated_at=? WHERE organization_id=? AND project_id=? AND state='active' AND version=CAST(? AS INTEGER)",
          )
          .bind(input.now, reason, id, input.now, org, project, facts.project["version"]),
      );
  }
  return statements;
}

/** Original signed Resend transaction: receipt first, all owned effects, receipt last, one atomic Core batch. */
export async function ingestResendEvent(context: CatalogContext, raw: unknown): Promise<void> {
  const input = mailInput(inputSchema, raw);
  await context.router.assertLayout();
  const db = context.directory,
    id = await providerEventUuid(input.eventId),
    deadline = Date.now() + 15000,
    name = "mail.ingestResend";
  await runCommand<Snapshot, undefined>(db, {
    name,
    input,
    retryOn: ["precondition_changed", "row_version_conflict"],
    naturalKeyTables: ["resend_event_receipts", "mail_send_events", "mail_received_messages"],
    lookup: unknownOutcome(name),
    read: async (reader) => {
      const receipt = await reader
          .prepare(
            "SELECT lower(hex(payload_sha256)) digest FROM resend_event_receipts WHERE event_id=?",
          )
          .bind(input.eventId)
          .first<{ digest: string }>(),
        s: Snapshot = {
          receipt,
          queries: [],
          legacy: [],
          workspace: [],
          request: undefined,
          event: undefined,
          outcome: undefined,
          transition: undefined,
          receiverRows: [],
          existingReceived: undefined,
          reputation: undefined,
        };
      if (receipt) return s;
      if (input.occurredAt === null || !mailTime.safeParse(input.occurredAt).success)
        throw new TypeError("Invalid event time");
      const query = async (sql: string, params: unknown[]) => {
        const facts = await rows(reader, sql, params);
        s.queries.push({ sql, params, facts });
        return facts;
      };
      if (input.domain && ["domain.updated", "domain.deleted"].includes(input.type)) {
        s.legacy = await query(LEGACY_DOMAIN, [input.domain.providerDomainId, input.domain.domain]);
        s.workspace = await query(WORKSPACE_DOMAIN, [
          input.domain.providerDomainId,
          input.domain.domain,
        ]);
        if ((s.legacy.length || s.workspace.length) && !input.domain.valid)
          throw new TypeError("Invalid domain observation");
      }
      if (input.delivery && OUTCOMES[input.type] && input.providerMessageId !== null) {
        const d = input.delivery;
        if (d.requestId !== null && d.projectId !== null) {
          s.request = (await query(REQUEST, [d.projectId, d.requestId]))[0];
          if (s.request) {
            if (
              !/^[A-Za-z0-9._-]{1,256}$/u.test(input.providerMessageId) ||
              input.now < storedTimestamp(publicTimestamp(String(s.request["requested_at"])))
            )
              throw new TypeError("SES mail event input is invalid");
            if (
              s.request["provider_message_id"] !== null &&
              s.request["provider_message_id"] !== input.providerMessageId
            )
              throw new Error("mail_send_event_conflict");
            s.event = (await query(EVENT, [id]))[0];
            s.outcome = (
              await query(OUTCOME, [s.request["organization_id"], d.projectId, d.requestId])
            )[0];
            if (s.request["state"] !== "accepted")
              s.transition = await readMailSendIngressSnapshot(reader, {
                organizationId: String(s.request["organization_id"]),
                projectId: d.projectId,
                requestId: d.requestId,
              });
            if (
              !s.event &&
              (input.type === "email.complained" ||
                (input.type === "email.bounced" && d.permanentBounce))
            )
              s.reputation = await reputationSnapshot(reader, s.request, input, query);
          }
        }
      }
      if (input.type === "email.received" && input.received && input.providerMessageId !== null) {
        if (input.received.receivedAt === null || input.received.messageId === null)
          throw new TypeError("Invalid received timestamp");
        const receivedAt = mailTime.parse(input.received.receivedAt),
          r = {
            messageId: input.received.messageId,
            providerMessageId: input.providerMessageId,
            recipientDomains: input.received.recipientDomains,
            receivedAt,
            observedAt: input.now,
          },
          statements = receivedIngressReads(reader, r),
          result = await reader.batch(statements);
        s.receiverRows = (result[0]?.results ?? []) as unknown as ReceivingDomainFacts[];
        s.existingReceived = result[1]?.results[0] as unknown as ExistingReceivedFacts | undefined;
      }
      return s;
    },
    decide: (s) => {
      if (s.receipt) {
        if (s.receipt.digest !== input.digest) throw new Error("Resend event identity conflict");
        return { replay: undefined };
      }
      const occurred = mailTime.parse(input.occurredAt),
        preconditions = s.queries.map((q) => fingerprint(db, q.sql, q.params, q.facts)),
        statements: D1PreparedStatement[] = [];
      let concerned = false;
      if (
        input.domain &&
        ["domain.updated", "domain.deleted"].includes(input.type) &&
        (s.legacy.length || s.workspace.length)
      ) {
        concerned = true;
        const d =
          input.type === "domain.deleted"
            ? {
                ...input.domain,
                sending: "failed",
                receiving: "failed",
                workspaceSending: "failed",
              }
            : input.domain;
        statements.push(
          db
            .prepare(
              `UPDATE resend_mail_domains SET sending_status=CASE WHEN EXISTS(SELECT 1 FROM workspace_mail_domains w WHERE w.legacy_domain_id=resend_mail_domains.domain_id AND w.status='active') THEN ?6 WHEN sending=1 THEN COALESCE(?3,sending_status) ELSE 'disabled' END,receiving_status=CASE WHEN receiving=1 AND receiving_suspended=0 THEN COALESCE(?4,receiving_status) ELSE 'disabled' END,observed_at=?5 WHERE provider_domain_id=?1 AND domain=?2 AND deleted_at IS NULL AND(observed_at IS NULL OR observed_at<=?5)`,
            )
            .bind(
              d.providerDomainId,
              d.domain,
              d.sending,
              d.receiving,
              occurred,
              d.workspaceSending,
            ),
          db
            .prepare(
              "UPDATE workspace_mail_domains SET sending_status=?3,receiving_status=COALESCE(?4,receiving_status),observed_at=?5 WHERE provider_domain_id=?1 AND domain=?2 AND legacy_domain_id IS NULL AND status='active' AND(observed_at IS NULL OR observed_at<=?5)",
            )
            .bind(d.providerDomainId, d.domain, d.workspaceSending, d.receiving, occurred),
        );
      }
      const outcome = OUTCOMES[input.type];
      if (s.request && outcome && input.providerMessageId !== null) {
        concerned = true;
        const r = s.request,
          org = String(r["organization_id"]),
          project = String(r["project_id"]),
          request = String(r["request_id"]),
          sent = storedTimestamp(publicTimestamp(String(r["requested_at"]))),
          impact =
            input.type === "email.complained"
              ? "complaint"
              : input.type === "email.bounced" && input.delivery?.permanentBounce
                ? "hard_bounce"
                : null;
        if (s.event) {
          const expected: Row = {
            provider_event_id: id,
            organization_id: org,
            project_id: project,
            request_id: request,
            provider_message_id: input.providerMessageId,
            event_type: outcome.type,
            outcome: outcome.outcome,
            digest: input.digest,
            occurred_at: occurred,
            sent_at: sent,
            received_at: input.now,
            reputation_kind: impact,
          };
          if (
            Object.keys(expected).some((key) =>
              key.endsWith("_at")
                ? publicTimestamp(String(s.event?.[key])) !== publicTimestamp(String(expected[key]))
                : s.event?.[key] !== expected[key],
            )
          )
            throw new Error("mail_send_event_conflict");
        }
        if (s.transition)
          statements.push(
            ...completeMailSendIngressStep(
              db,
              { organizationId: org, projectId: project, requestId: request },
              s.transition,
              input.providerMessageId,
              input.now,
            ),
          );
        if (!s.event)
          statements.push(
            db
              .prepare(
                "INSERT INTO mail_send_events(provider_event_id,organization_id,project_id,request_id,provider_message_id,event_type,outcome,detail_sha256,occurred_at,sent_at,received_at,reputation_kind)VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .bind(
                id,
                org,
                project,
                request,
                input.providerMessageId,
                outcome.type,
                outcome.outcome,
                hexBytes(input.digest),
                occurred,
                sent,
                input.now,
                impact,
              ),
          );
        if (s.reputation && impact !== null)
          statements.push(...reputationStep(db, r, s.reputation, impact, input, id));
        const previous = s.outcome,
          projected =
            !previous ||
            outcome.rank > (RANK[String(previous["outcome"])] ?? 0) ||
            (outcome.rank === RANK[String(previous["outcome"])] &&
              `${publicTimestamp(occurred)}\n${id}` >
                `${publicTimestamp(String(previous["occurred_at"]))}\n${String(previous["provider_event_id"])}`);
        if (!previous)
          statements.push(
            db
              .prepare(
                "INSERT INTO mail_send_outcomes(organization_id,project_id,request_id,outcome,provider_event_id,occurred_at,version,updated_at)VALUES(?,?,?,?,?,?,1,?)",
              )
              .bind(org, project, request, outcome.outcome, id, occurred, input.now),
          );
        else if (projected)
          statements.push(
            db
              .prepare(
                "UPDATE mail_send_outcomes SET outcome=?,provider_event_id=?,occurred_at=?,version=version+1,updated_at=? WHERE organization_id=? AND project_id=? AND request_id=?",
              )
              .bind(outcome.outcome, id, occurred, input.now, org, project, request),
          );
      }
      if (
        input.type === "email.received" &&
        input.received &&
        input.providerMessageId !== null &&
        input.received.messageId !== null &&
        input.received.receivedAt !== null
      ) {
        const step = receivedIngressStep(
          db,
          {
            messageId: input.received.messageId,
            providerMessageId: input.providerMessageId,
            recipientDomains: input.received.recipientDomains,
            receivedAt: mailTime.parse(input.received.receivedAt),
            observedAt: input.now,
          },
          s.receiverRows,
          s.existingReceived,
        );
        concerned ||= step.concerned;
        preconditions.push(...step.preconditions);
        statements.push(...step.statements);
      }
      if (!concerned) return { replay: undefined };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            "EXISTS(SELECT 1 FROM resend_event_receipts WHERE event_id=?)",
            [input.eventId],
          ),
          ...preconditions,
          ...statements,
          guard(
            db,
            "precondition_changed",
            "CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER)>?",
            [deadline],
          ),
          db
            .prepare(
              "INSERT INTO resend_event_receipts(event_id,event_type,provider_message_id,payload_sha256,received_at)VALUES(?,?,?,?,?)",
            )
            .bind(
              input.eventId,
              input.type,
              input.providerMessageId,
              hexBytes(input.digest),
              input.now,
            ),
        ],
        result: () => undefined,
      };
    },
  });
}
