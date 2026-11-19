import { z } from "zod";
import { ulid, notFencedOrganization, type CatalogContext } from "../common.js";
import {
  claimOutboxEvent,
  recoverExpiredFinalOutboxLease,
  outboxAcknowledgementCommand,
} from "../operations/outbox.js";
import { runCommand } from "../../run-command.js";
import { discardRecoveryInputs, readUnfinishedExpiredRecoveries } from "./jobs.js";
import { DB_NOW } from "./shared.js";
import { expireNativeRestoreInputs } from "../identity/native-auth-restore-job.js";

const exact = z.strictObject({
  organizationId: ulid,
  projectId: ulid,
  operationId: ulid,
  eventId: ulid,
  attemptId: ulid,
});
export type RecoveryAttempt = z.output<typeof exact>;
async function clock(context: CatalogContext) {
  const { db } = await context.router.routeShard(0);
  const row = await db.prepare(`SELECT ${DB_NOW} AS now`).first<{ now: string }>();
  if (row === null) throw new Error("Recovery maintenance clock unavailable");
  return row.now;
}

/** Only the existing global recovery housekeeping capability, not a Node/executor or ordinary tenant command. */
export async function prepareRecoveryMaintenance(context: CatalogContext, raw: unknown) {
  const { auditEventId } = z.strictObject({ auditEventId: ulid }).parse(raw),
    now = await clock(context);
  // Original discard clears ALL expired/terminal envelopes, including a terminal row with finished_at already set.
  const cleared = await discardRecoveryInputs(context, { shardId: 0, now, clock: "execution" });
  // The same scheduled recovery tick also removes expired sealed Native restore inputs.
  await expireNativeRestoreInputs(context, { limit: 1000 });
  const { db } = await context.router.routeShard(0);
  // Only one exact expired effect is offered per scheduler tick. The executor must re-check this Core clock
  // and identity before reading the provider or recording retirement.
  const due = await db
    .prepare(
      `UPDATE native_export_effects SET next_attempt_at=(strftime('%Y-%m-%dT%H:%M:%f',substr(${DB_NOW},1,23),'+5 minutes')||'000Z')
    WHERE (organization_id,operation_id)=(SELECT e.organization_id,e.operation_id FROM native_export_effects e
      WHERE e.state IN ('reserved','dispatched','verified') AND e.expires_at <= ${DB_NOW}
        AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ${DB_NOW}) AND ${notFencedOrganization("e.organization_id")}
      ORDER BY e.expires_at,e.organization_id,e.operation_id LIMIT 1)
    RETURNING organization_id,project_id,operation_id`,
    )
    .first<{ organization_id: string; project_id: string; operation_id: string }>();
  const dueNativeArchivePurges =
    due === null
      ? []
      : [
          {
            organizationId: due.organization_id,
            projectId: due.project_id,
            operationId: due.operation_id,
            exportId: due.operation_id,
          },
        ];
  const terminal = await db
    .prepare(
      `SELECT event.organization_id,event.project_id,event.operation_id,event.event_id,event.current_attempt_id AS attempt_id
    FROM outbox_events event JOIN project_recovery_jobs job ON job.organization_id=event.organization_id AND job.project_id=event.project_id AND job.operation_id=event.operation_id
    JOIN operations operation ON operation.organization_id=event.organization_id AND operation.project_id=event.project_id AND operation.operation_id=event.operation_id
    WHERE event.event_type='ProjectRecoveryRequestedV1' AND event.acknowledged_at IS NULL AND event.reconciliation_required_at IS NULL
      AND event.current_attempt_id IS NOT NULL AND operation.state IN ('succeeded','failed','cancelled')
      AND EXISTS(SELECT 1 FROM delivery_attempts attempt WHERE attempt.event_id=event.event_id
        AND attempt.attempt_id=event.current_attempt_id AND attempt.status='claimed')
      AND ${notFencedOrganization("event.organization_id")}
    ORDER BY event.created_at,event.event_id LIMIT 1`,
    )
    .first<{
      organization_id: string;
      project_id: string;
      operation_id: string;
      event_id: string;
      attempt_id: string;
    }>();
  if (terminal !== null)
    return {
      cleared,
      terminal: {
        organizationId: terminal.organization_id,
        projectId: terminal.project_id,
        operationId: terminal.operation_id,
        eventId: terminal.event_id,
        attemptId: terminal.attempt_id,
      },
      expired: [],
      dueNativeArchivePurges,
    };
  await recoverExpiredFinalOutboxLease(context, {
    shardId: 0,
    now: await clock(context),
    auditEventId,
    actorType: "service",
    actorId: "project-recovery-dispatch",
    supportedEventTypes: ["ProjectRecoveryRequestedV1"],
  });
  return {
    cleared,
    terminal: null,
    dueNativeArchivePurges,
    expired: await readUnfinishedExpiredRecoveries(context, {
      shardId: 0,
      now,
      clock: "execution",
    }),
  };
}

/** The scheduler chooses neither a time, event kind nor lease policy; these are the original recovery constants. */
export async function claimRecoveryOutbox(context: CatalogContext, raw: unknown) {
  const { attemptId } = z.strictObject({ attemptId: ulid }).parse(raw);
  return claimOutboxEvent(context, {
    shardId: 0,
    attemptId,
    now: await clock(context),
    leaseMilliseconds: 840_000,
    supportedEventTypes: ["ProjectRecoveryRequestedV1"],
  });
}

/** One exact terminal job and current delivery attempt, checked in the ACK statement itself. */
export async function acknowledgeRecoveryOutbox(
  context: CatalogContext,
  raw: unknown,
): Promise<boolean> {
  const input = exact.parse(raw),
    { db } = await context.router.routeOrganization(input.organizationId);
  return runCommand(db, outboxAcknowledgementCommand(db, { ...input, kind: "recovery_terminal" }));
}
