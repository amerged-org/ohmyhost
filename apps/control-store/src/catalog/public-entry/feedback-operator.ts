import { z } from "zod";
import {
  FEEDBACK_EXPLANATION_MIN_LENGTH,
  FEEDBACK_REPLY_MAX_LENGTH,
  FEEDBACK_UPDATE_STATES,
  parseFeedbackReceipt,
  type FeedbackReceipt,
  type FeedbackState,
} from "@ohmyhost/contracts/feedback";
import type { D1Database } from "../../d1-types.js";
import { classifyFailure, guard } from "../../guards.js";
import { CommandConflictError, runCommand, type Command } from "../../run-command.js";
import { storedTimestamp } from "../../timestamps.js";
import { publicTimestamp, ulid, type CatalogContext } from "../common.js";

const environment = z.enum(["development", "production"]);
const state = z.enum(["received", "in_review", "planned", "in_progress", "resolved", "closed"]);
const updateState = z.enum(
  FEEDBACK_UPDATE_STATES as [
    Exclude<FeedbackState, "received">,
    ...Exclude<FeedbackState, "received">[],
  ],
);
const receiptSchema = z.unknown().transform(parseFeedbackReceipt);
const previewInput = z.strictObject({ feedbackId: ulid, runtimeEnvironment: environment });
const updateInput = z
  .strictObject({
    receipt: receiptSchema,
    expectedEnvironment: environment,
    runtimeEnvironment: environment,
    expectedStatus: state,
    expectedLastEventId: ulid.nullable(),
    eventId: ulid,
    actorId: z.string().regex(/^user:user_[A-Za-z0-9_]{1,123}$/u),
    status: updateState,
    release: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,63}$/u)
      .optional(),
    reply: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const text = value.reply;
    if (
      value.runtimeEnvironment !== value.expectedEnvironment ||
      (value.status === "resolved") !== (value.release !== undefined)
    )
      ctx.addIssue({ code: "custom", message: "feedback operator target or release is invalid" });
    if (
      text !== undefined &&
      (text !== text.trim() ||
        Array.from(text).length < 1 ||
        Array.from(text).length > FEEDBACK_REPLY_MAX_LENGTH ||
        /\p{Cs}/u.test(text) ||
        Array.from(text).some((character) => {
          const code = character.charCodeAt(0);
          return (
            (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159)
          );
        }))
    )
      ctx.addIssue({ code: "custom", message: "feedback reply is invalid" });
    if (
      (value.status === "resolved" || value.status === "closed") &&
      (text === undefined || Array.from(text).length < FEEDBACK_EXPLANATION_MIN_LENGTH)
    )
      ctx.addIssue({ code: "custom", message: "feedback explanation is too short" });
  });
type Input = z.output<typeof updateInput>;
type Snapshot = {
  receipt: FeedbackReceipt;
  currentStatus: FeedbackState;
  lastEventId: string | null;
  lastRecordedAt: string | null;
};
type Result = {
  outcome: "recorded";
  receipt: FeedbackReceipt;
  eventId: string;
  status: Exclude<FeedbackState, "received">;
  recordedAt: string;
};
const resultSchema = z.strictObject({
  outcome: z.literal("recorded"),
  receipt: receiptSchema,
  eventId: ulid,
  status: updateState,
  recordedAt: z.iso.datetime({ precision: 3 }),
});

/** Exact report and event head from one database snapshot; neither report contents nor internal bodies are returned. */
async function snapshot(
  db: D1Database,
  feedbackId: string,
  organizationId: string,
): Promise<Snapshot | null> {
  const row = await db
    .prepare(
      `SELECT report.feedback_id,report.organization_id,report.submitted_at,
    (SELECT event_id FROM customer_feedback_events WHERE feedback_id=report.feedback_id ORDER BY recorded_at DESC,event_id DESC LIMIT 1) last_event_id,
    (SELECT recorded_at FROM customer_feedback_events WHERE feedback_id=report.feedback_id ORDER BY recorded_at DESC,event_id DESC LIMIT 1) last_recorded_at,
    coalesce((SELECT status FROM customer_feedback_events WHERE feedback_id=report.feedback_id AND visibility='customer' AND status IS NOT NULL ORDER BY recorded_at DESC,event_id DESC LIMIT 1),'received') current_status
    FROM customer_feedback report WHERE report.feedback_id=?1 AND report.organization_id=?2`,
    )
    .bind(feedbackId, organizationId)
    .first();
  if (row === null) return null;
  return {
    receipt: parseFeedbackReceipt({
      id: row["feedback_id"],
      organization_id: row["organization_id"],
      submitted_at: publicTimestamp(z.string().parse(row["submitted_at"])),
    }),
    currentStatus: state.parse(row["current_status"]),
    lastEventId: ulid.nullable().parse(row["last_event_id"]),
    lastRecordedAt: z.string().nullable().parse(row["last_recorded_at"]),
  };
}

/** A named receipt's current customer status and exact latest event, including internal events as a write fence. */
export async function readFeedbackOperatorPreview(context: CatalogContext, raw: unknown) {
  const input = previewInput.parse(raw);
  const found = await context.directory
    .prepare("SELECT organization_id FROM customer_feedback WHERE feedback_id=?")
    .bind(input.feedbackId)
    .first<{ organization_id: string }>();
  if (found === null) return null;
  const db = (await context.router.routeOrganization(ulid.parse(found.organization_id))).db;
  const current = await snapshot(db, input.feedbackId, found.organization_id);
  return current === null
    ? null
    : {
        environment: input.runtimeEnvironment,
        receipt: current.receipt,
        currentStatus: current.currentStatus,
        lastEventId: current.lastEventId,
      };
}

function changed(): CommandConflictError {
  return new CommandConflictError("feedback_state_changed");
}
function same(snapshot: Snapshot | null, input: Input, recordedAt: string): boolean {
  return (
    snapshot !== null &&
    snapshot.receipt.id === input.receipt.id &&
    snapshot.receipt.organization_id === input.receipt.organization_id &&
    snapshot.receipt.submitted_at === input.receipt.submitted_at &&
    snapshot.currentStatus === input.expectedStatus &&
    snapshot.lastEventId === input.expectedLastEventId &&
    (snapshot.lastRecordedAt === null || snapshot.lastRecordedAt < recordedAt) &&
    storedTimestamp(snapshot.receipt.submitted_at) <= recordedAt
  );
}

/** Append one status, audit and replay receipt together only while the reviewed head remains current. */
export async function applyFeedbackOperatorUpdate(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = updateInput.parse(raw);
  const db = (await context.router.routeOrganization(input.receipt.organization_id)).db;
  // This is execution time, not a caller clock. It is excluded from the replay digest and retained in the log result.
  const now = new Date(),
    recordedAt = storedTimestamp(now.toISOString());
  const result: Result = {
    outcome: "recorded",
    receipt: input.receipt,
    eventId: input.eventId,
    status: input.status,
    recordedAt: publicTimestamp(recordedAt),
  };
  const command: Command<Snapshot | null, Result> = {
    name: "feedback.operator.status",
    commandId: `feedback-operator:${input.eventId}`,
    input,
    now: now.getTime(),
    read: (reader) => snapshot(reader, input.receipt.id, input.receipt.organization_id),
    decide: (current) => {
      if (!same(current, input, recordedAt)) return { reject: changed() };
      return {
        statements: [
          guard(
            db,
            "precondition_changed",
            `NOT EXISTS(SELECT 1 FROM customer_feedback WHERE feedback_id=?1 AND organization_id=?2 AND substr(submitted_at,1,23)=substr(?3,1,23))
            OR (SELECT event_id FROM customer_feedback_events WHERE feedback_id=?1 ORDER BY recorded_at DESC,event_id DESC LIMIT 1) IS NOT ?4
            OR coalesce((SELECT status FROM customer_feedback_events WHERE feedback_id=?1 AND visibility='customer' AND status IS NOT NULL ORDER BY recorded_at DESC,event_id DESC LIMIT 1),'received')<>?5
            OR EXISTS(SELECT 1 FROM customer_feedback_events WHERE feedback_id=?1 AND recorded_at>=?6)`,
            [
              input.receipt.id,
              input.receipt.organization_id,
              storedTimestamp(input.receipt.submitted_at),
              input.expectedLastEventId,
              input.expectedStatus,
              recordedAt,
            ],
          ),
          db
            .prepare(
              "INSERT INTO customer_feedback_events(event_id,feedback_id,visibility,status,release,body,actor_id,recorded_at) VALUES(?,?,'customer',?,?,?,?,?)",
            )
            .bind(
              input.eventId,
              input.receipt.id,
              input.status,
              input.release ?? null,
              input.reply ?? null,
              input.actorId,
              recordedAt,
            ),
          db
            .prepare(
              "INSERT INTO organization_audit_events(organization_id,audit_event_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES(?,?,'CustomerFeedbackStatusChangedV1','operator',?,?,?)",
            )
            .bind(
              input.receipt.organization_id,
              input.eventId,
              input.actorId,
              JSON.stringify({
                feedbackId: input.receipt.id,
                environment: input.runtimeEnvironment,
                status: input.status,
                expectedStatus: input.expectedStatus,
                expectedLastEventId: input.expectedLastEventId,
                ...(input.release === undefined ? {} : { release: input.release }),
              }),
              recordedAt,
            ),
        ],
        result: () => result,
        logResult: result,
      };
    },
    fromLog: (logged) => resultSchema.parse(logged),
  };
  try {
    return await runCommand(db, command);
  } catch (error) {
    const failure = classifyFailure(error);
    if (failure.kind === "guard" && failure.code === "precondition_changed") throw changed();
    if (failure.kind === "unique" && failure.table === "customer_feedback_events")
      throw new CommandConflictError("feedback_event_id_conflict");
    throw error;
  }
}
