import { z } from "zod";
import {
  FEEDBACK_HISTORY_PAGE_SIZE,
  parseFeedbackStatus,
  parseFeedbackSubmission,
  type FeedbackReceipt,
  type FeedbackStatus,
} from "@ohmyhost/contracts/feedback";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { generatedJsonb } from "../../jsonb-generated.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  ulid,
  instant,
  sha256Hex,
  hexBytes,
  publicTimestamp,
  type CatalogContext,
} from "../common.js";
type Row = Record<string, unknown>;
const inputSchema = z.strictObject({
  report: z.unknown().transform(parseFeedbackSubmission),
  actorId: z
    .string()
    .refine((v) => !v.includes("\0") && Array.from(v).length >= 1 && Array.from(v).length <= 256),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u),
  requestSha256: sha256Hex,
  feedbackId: ulid,
  submittedAt: instant,
});
type Input = z.output<typeof inputSchema>;
type Reply =
  | { outcome: "stored"; receipt: FeedbackReceipt }
  | { outcome: "resource_not_found" | "idempotency_key_reused" };
const SCOPE = `SELECT 1 FROM projects p WHERE p.organization_id=?1 AND p.project_id=?2 AND p.owner_state='active'
 AND (?3 IS NULL OR EXISTS(SELECT 1 FROM environments e WHERE e.organization_id=?1 AND e.project_id=?2 AND e.environment_id=?3))
 AND (?4 IS NULL OR EXISTS(SELECT 1 FROM operations o WHERE o.organization_id=?1 AND o.project_id=?2 AND o.operation_id=?4))`;
const scopeValues = (i: Input) => [
  i.report.organization_id,
  i.report.project_id ?? null,
  i.report.environment_id ?? null,
  i.report.operation_id ?? null,
];
const receipt = (row: Row): FeedbackReceipt => ({
  id: ulid.parse(row["feedback_id"]),
  organization_id: ulid.parse(row["organization_id"]),
  submitted_at: publicTimestamp(z.string().parse(row["submitted_at"])),
});
async function snapshot(db: D1Database, i: Input) {
  const result = await db.batch([
    db.prepare(`SELECT EXISTS(${SCOPE}) available`).bind(...scopeValues(i)),
    db
      .prepare(
        "SELECT feedback_id,organization_id,submitted_at,lower(hex(request_sha256)) digest FROM customer_feedback WHERE organization_id=? AND actor_id=? AND idempotency_key=?",
      )
      .bind(i.report.organization_id, i.actorId, i.idempotencyKey),
  ]);
  return {
    available: i.report.project_id === undefined || result[0]?.results[0]?.["available"] === 1,
    existing: result[1]?.results[0],
  };
}
/** Original current owner/environment/operation check, immutable report and natural-key reply in one guarded effect. */
export async function submitCustomerFeedback(
  context: CatalogContext,
  raw: unknown,
): Promise<Reply> {
  const i = inputSchema.parse(raw),
    db = (await context.router.routeOrganization(i.report.organization_id)).db,
    existing = (s: Awaited<ReturnType<typeof snapshot>>): Reply | undefined =>
      !s.available
        ? { outcome: "resource_not_found" }
        : s.existing
          ? s.existing["digest"] === i.requestSha256
            ? { outcome: "stored", receipt: receipt(s.existing) }
            : { outcome: "idempotency_key_reused" }
          : undefined,
    command: Command<Awaited<ReturnType<typeof snapshot>>, Reply> = {
      name: "public.submitFeedback",
      input: i,
      naturalKeyTables: ["customer_feedback"],
      read: (reader) => snapshot(reader, i),
      lookup: async (reader) => existing(await snapshot(reader, i)),
      decide: (s) => {
        const observed = existing(s);
        if (observed) return { replay: observed };
        return {
          statements: [
            ...(i.report.project_id === undefined
              ? []
              : [guard(db, "precondition_changed", `NOT EXISTS(${SCOPE})`, scopeValues(i))]),
            db
              .prepare(
                "INSERT INTO customer_feedback(feedback_id,organization_id,actor_id,idempotency_key,request_sha256,project_id,environment_id,operation_id,report,submitted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .bind(
                i.feedbackId,
                i.report.organization_id,
                i.actorId,
                i.idempotencyKey,
                hexBytes(i.requestSha256),
                i.report.project_id ?? null,
                i.report.environment_id ?? null,
                i.report.operation_id ?? null,
                generatedJsonb(i.report),
                i.submittedAt,
              ),
          ],
          result: () => ({
            outcome: "stored",
            receipt: {
              id: i.feedbackId,
              organization_id: i.report.organization_id,
              submitted_at: publicTimestamp(i.submittedAt),
            },
          }),
        };
      },
      retryOn: ["precondition_changed"],
    };
  return runCommand(db, command);
}
function update(row: Row) {
  return {
    id: ulid.parse(row["event_id"]),
    created_at: publicTimestamp(z.string().parse(row["recorded_at"])),
    ...(row["status"] === null ? {} : { status: row["status"] }),
    ...(row["release"] === null ? {} : { release: row["release"] }),
    ...(row["body"] === null ? {} : { reply: row["body"] }),
  };
}
/** One consistent customer-visible snapshot; original report and internal body are never selected. */
export async function readCustomerFeedbackStatus(context: CatalogContext, raw: unknown) {
  const i = z
      .strictObject({ feedbackId: ulid, organizationIds: z.array(ulid), cursor: ulid.optional() })
      .parse(raw),
    orgs = JSON.stringify(i.organizationIds),
    found = await context.directory
      .prepare(
        "SELECT organization_id FROM customer_feedback WHERE feedback_id=? AND organization_id IN(SELECT value FROM json_each(?))",
      )
      .bind(i.feedbackId, orgs)
      .first<{ organization_id: string }>();
  if (found === null) return null;
  const db = (await context.router.routeOrganization(found.organization_id)).db,
    result = await db.batch([
      db
        .prepare(
          `SELECT report.organization_id,report.project_id,report.environment_id,report.submitted_at,
    (SELECT status FROM customer_feedback_events WHERE feedback_id=report.feedback_id AND visibility='customer' AND status IS NOT NULL ORDER BY recorded_at DESC,event_id DESC LIMIT 1) status,
    (SELECT max(recorded_at) FROM customer_feedback_events WHERE feedback_id=report.feedback_id AND visibility='customer') updated_at
    FROM customer_feedback report WHERE report.feedback_id=?1 AND report.organization_id IN(SELECT value FROM json_each(?2))`,
        )
        .bind(i.feedbackId, orgs),
      db
        .prepare(
          "SELECT 1 FROM customer_feedback_events WHERE event_id=? AND feedback_id=? AND visibility='customer'",
        )
        .bind(i.cursor ?? null, i.feedbackId),
      db
        .prepare(
          `SELECT event_id,status,release,body,recorded_at FROM customer_feedback_events
    WHERE feedback_id=?1 AND visibility='customer' AND (?2 IS NULL OR(recorded_at,event_id)>(SELECT recorded_at,event_id FROM customer_feedback_events WHERE event_id=?2))
    ORDER BY recorded_at,event_id LIMIT ${FEEDBACK_HISTORY_PAGE_SIZE + 1}`,
        )
        .bind(i.feedbackId, i.cursor ?? null),
    ]),
    row = result[0]?.results[0];
  if (!row) return null;
  const scope = {
      organizationId: ulid.parse(row["organization_id"]),
      projectId: row["project_id"] === null ? null : ulid.parse(row["project_id"]),
      environmentId: row["environment_id"] === null ? null : ulid.parse(row["environment_id"]),
    },
    events = result[2]?.results ?? [],
    history = events.slice(0, FEEDBACK_HISTORY_PAGE_SIZE).map(update),
    submittedAt = publicTimestamp(z.string().parse(row["submitted_at"]));
  if (i.cursor !== undefined && result[1]?.results.length !== 1) return { ...scope, status: null };
  const status: FeedbackStatus = parseFeedbackStatus({
    id: i.feedbackId,
    organization_id: scope.organizationId,
    submitted_at: submittedAt,
    status: row["status"] ?? "received",
    updated_at:
      row["updated_at"] === null
        ? submittedAt
        : publicTimestamp(z.string().parse(row["updated_at"])),
    history,
    next_cursor: events.length > FEEDBACK_HISTORY_PAGE_SIZE ? (history.at(-1)?.id ?? null) : null,
  });
  return { ...scope, status };
}
