import { z } from "zod";
import {
  routeOrganization,
  ulid,
  addMilliseconds,
  ringDoorbell,
  type CatalogContext,
} from "../common.js";
import { readSnapshot } from "../platform-support.js";
import { runCommand, type Plan } from "../../run-command.js";
import {
  acknowledgeOutboxEvent,
  outboxDeliveryFailureCommand,
  outboxFailureQueries,
  outboxFailureSnapshotOf,
  recordOutboxDeliveryFailureInput,
  type OutboxFailureSnapshot,
} from "../operations/outbox.js";
import {
  prepareRecoveryDispatchCommand,
  prepareRecoveryDispatchInput,
  type RecoveryDispatchResult,
} from "./jobs.js";
import { recoverySnapshotOf, recoverySnapshotQueries, type RecoverySnapshot } from "./shared.js";

const inputSchema = prepareRecoveryDispatchInput.omit({ failureCode: true }).extend({
  eventId: ulid,
  attemptId: ulid,
  deliveryAuditEventId: ulid,
  errorCode: z.enum(["RECOVERY_DISPATCH_INCOMPLETE", "RECOVERY_DISPATCH_UNAVAILABLE"]),
});
type Result = {
  outcome:
    | "waiting"
    | "acknowledged"
    | "claim_changed"
    | "retry_scheduled"
    | "reconciliation_required";
};
type PlannedResult = Result | { outcome: "needs_ack"; now: string };

/** Original exhausted-dispatch transaction: the claimed job's terminal transition AND its outbox failure are ONE
 * guarded batch. A live foreign capture returns waiting with no mutation. Already succeeded/cancelled means only
 * an ACK write is needed; no job write precedes that ACK. Nothing here publishes or invokes a provider. */
export async function recordRecoveryDispatchFailure(
  context: CatalogContext,
  raw: unknown,
): Promise<Result> {
  const input = inputSchema.parse(raw),
    route = await routeOrganization(context, input.organizationId),
    db = route.db;
  const result = await runCommand<
    { recovery: RecoverySnapshot; outbox: OutboxFailureSnapshot },
    PlannedResult
  >(db, {
    name: "recovery.recordDispatchFailure",
    input,
    retryOn: ["claim_lost", "operation_conflict", "precondition_changed", "row_version_conflict"],
    naturalKeyTables: ["audit_events"],
    read: async (reader) => {
      const rows = await readSnapshot(reader, [
        ...recoverySnapshotQueries(input),
        ...outboxFailureQueries({ ...input, auditEventId: input.deliveryAuditEventId }),
      ]);
      return {
        recovery: recoverySnapshotOf(rows.slice(0, 5)),
        outbox: outboxFailureSnapshotOf(rows.slice(5)),
      };
    },
    decide: (snapshot): Plan<PlannedResult> => {
      if (snapshot.outbox.done !== null)
        return { replay: { outcome: snapshot.outbox.done.outcome } };
      const row = snapshot.outbox.row;
      if (row === null) return { replay: { outcome: "claim_changed" } };
      if (row.project_id !== input.projectId || row.operation_id !== input.operationId)
        return { reject: new Error("Recovery dispatch event scope conflicts") };
      const now = input.clock === "execution" ? snapshot.recovery.dbNow : input.occurredAt;
      const exhausted = row.attempt_count >= row.max_attempts;
      const failure = recordOutboxDeliveryFailureInput.parse({
        organizationId: input.organizationId,
        eventId: input.eventId,
        attemptId: input.attemptId,
        errorCode: input.errorCode,
        failedAt: now,
        ...(!exhausted ? { nextAvailableAt: addMilliseconds(now, 60_000) } : {}),
        audit: {
          auditEventId: input.deliveryAuditEventId,
          projectId: input.projectId,
          operationId: input.operationId,
          eventType: exhausted ? "OutboxReconciliationRequired" : "OutboxRetryScheduled",
          actorType: "service",
          actorId: "project-recovery-dispatch",
          occurredAt: now,
          payload: {},
        },
      });
      const outbox = outboxDeliveryFailureCommand(db, failure).decide(snapshot.outbox);
      if ("reject" in outbox) return outbox;
      if ("replay" in outbox)
        return { replay: { outcome: outbox.replay?.outcome ?? "claim_changed" } };
      let preparation: Plan<RecoveryDispatchResult> | undefined;
      if (exhausted) {
        preparation = prepareRecoveryDispatchCommand(db, {
          organizationId: input.organizationId,
          projectId: input.projectId,
          operationId: input.operationId,
          claimId: input.claimId,
          operationEventId: input.operationEventId,
          auditEventId: input.auditEventId,
          terminalOperationEventId: input.terminalOperationEventId,
          terminalAuditEventId: input.terminalAuditEventId,
          clock: input.clock,
          occurredAt: now,
          failureCode: "RECOVERY_DISPATCH_FAILED",
        }).decide(snapshot.recovery);
        if ("reject" in preparation) return preparation;
        if ("replay" in preparation) {
          if (preparation.replay.status === "queued" || preparation.replay.status === "running")
            return { replay: { outcome: "waiting" } };
          if (
            preparation.replay.status === "succeeded" ||
            preparation.replay.status === "cancelled"
          )
            return { replay: { outcome: "needs_ack", now } };
        }
      }
      return {
        statements: [
          ...(preparation !== undefined && "statements" in preparation
            ? preparation.statements
            : []),
          ...outbox.statements,
        ],
        result: () => ({ outcome: exhausted ? "reconciliation_required" : "retry_scheduled" }),
      };
    },
  });
  if (result.outcome !== "needs_ack") {
    if (result.outcome === "retry_scheduled") {
      const event = await db
        .prepare("SELECT available_at FROM outbox_events WHERE organization_id=?1 AND event_id=?2")
        .bind(input.organizationId, input.eventId)
        .first<{ available_at: string }>();
      if (event !== null)
        await ringDoorbell(context.directory, "outbox", route.shardId, event.available_at);
    }
    return result;
  }
  const acknowledged = await acknowledgeOutboxEvent(context, {
    organizationId: input.organizationId,
    eventId: input.eventId,
    attemptId: input.attemptId,
    now: result.now,
  });
  return { outcome: acknowledged ? "acknowledged" : "claim_changed" };
}
