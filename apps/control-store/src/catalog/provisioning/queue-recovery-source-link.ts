import { parseUlid } from "@ohmyhost/platform";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import * as S from "./queue-recovery-source-link-logic.js";
import * as R from "./queue-recovery-source-link-reads.js";
import {
  runRecoveryDecision,
  recoveryAudit,
  type RecoveryReads,
} from "./queue-recovery-snapshot.js";
const timestamp = (at: string) => at.replace(/\.(\d{3})Z$/u, ".$1000Z");
function audit(
  db: D1Database,
  c: S.RecoveryCandidate,
  i: S.SourceLinkQueueDeliveryRecoveryIdentityInput,
  final: boolean,
  at: string,
  payload: unknown,
) {
  return recoveryAudit(db, {
    organizationId: c.scope.organization_id,
    auditEventId: final ? i.finalAuditEventId : i.preparedAuditEventId,
    projectId: c.scope.project_id,
    operationId: c.scope.operation_id,
    billingEpochId: c.scope.billing_epoch_id,
    eventType: final
      ? S.SOURCE_LINK_QUEUE_DELIVERY_RECOVERED
      : S.SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED,
    actorId: i.actorId,
    payload,
    occurredAt: at,
  });
}
export async function prepareSourceLinkQueueDeliveryRecovery(
  context: CatalogContext,
  raw: unknown,
): Promise<S.SourceLinkQueueDeliveryRecoveryPreparation> {
  const i = raw as S.PrepareSourceLinkQueueDeliveryRecoveryInput;
  S.assertPreparationInput(i);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<S.SourceLinkQueueDeliveryRecoveryPreparation>(
    db,
    "queueRecovery.prepareSourceLink",
    i,
    async (reader) => {
      const project = await R.lockSourceLinkRecoveryProjectProviderTransaction(reader, i),
        replay = await R.readFinalSourceLinkQueueDeliveryRecovery(reader, i);
      if (replay) return { statements: [], value: replay };
      const scope = await R.lockRecoveryScope(reader, i);
      if (scope === undefined)
        return { statements: [], value: await R.classifyAbsentRecoveryScope(reader, i) };
      if (project !== null && scope.project_id !== project)
        throw new Error("SourceLink Queue recovery project scope changed");
      const c = await R.lockRecoveryCandidate(reader, scope),
        all = await R.loadRecoveryAuditsForScope(reader, scope),
        final = all.filter((a) => a.event_type === S.SOURCE_LINK_QUEUE_DELIVERY_RECOVERED),
        prepared = all.filter(
          (a) => a.event_type === S.SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED,
        );
      if (c === null || !S.isOpenFinalDelivery(c.event, c.attempt)) {
        if (final.length) {
          const closed = await R.readClosedSourceLinkQueueDeliveryRecoveryState(reader, {
            organizationId: i.organizationId,
            operationId: i.operationId,
          });
          return { statements: [], value: closed ?? { outcome: "not_applicable" as const } };
        }
        if (prepared.length)
          throw new Error("SourceLink Queue recovery prepared audit conflicts with its Outbox");
        if (c !== null && S.isUnacknowledgedReconciliationSignal(c.event))
          throw new Error(
            "SourceLink event is not an exact final Queue-delivery recovery candidate",
          );
        return { statements: [], value: { outcome: "not_applicable" as const } };
      }
      if (!S.isScopeIdentity(c))
        throw new Error("SourceLink event is not an exact final Queue-delivery recovery candidate");
      if (final.length)
        throw new Error("SourceLink Queue recovery final audit conflicts with its open Outbox");
      if (prepared.length) {
        if (prepared.length !== 1 || !prepared[0])
          throw new Error("SourceLink Queue recovery prepared audit is ambiguous");
        if (prepared[0].audit_event_id !== i.preparedAuditEventId)
          throw new Error("A different SourceLink Queue recovery is already prepared");
        S.assertPreparedAudit(prepared[0], c, i);
        return { statements: [], value: S.preparedRecovery(c, i) };
      }
      if (!S.isInitialRecoveryCandidate(c))
        throw new Error("SourceLink event is not an exact final Queue-delivery recovery candidate");
      if (
        S.parseTimestamp(i.preparedAt, "SourceLink Queue recovery preparation time") <
        S.requiredFailureAt(c)
      )
        throw new RangeError(
          "SourceLink Queue recovery preparation time must not predate the final delivery failure",
        );
      return {
        statements: [audit(db, c, i, false, i.preparedAt, S.preparedPayload(c, i))],
        value: S.preparedRecovery(c, i),
      };
    },
  );
}
async function terminalFailure(
  reader: RecoveryReads,
  db: D1Database,
  c: S.RecoveryCandidate,
  i: S.FinalizeSourceLinkQueueDeliveryRecoveryInput,
  errorCode: "SOURCE_LINK_WORKFLOW_ERRORED" | "SOURCE_LINK_WORKFLOW_TERMINATED",
) {
  if (
    !S.isFinalizationScope(c) ||
    !S.isOpenFinalDelivery(c.event, c.attempt) ||
    S.durableOutcome(c) !== "queued"
  )
    throw new Error("SourceLink Queue recovery terminal failure does not match its queued scope");
  const history = await reader.select<{ revision: number }>(
    "SELECT revision FROM operation_events WHERE organization_id=?1 AND operation_id=?2 ORDER BY revision",
    [c.scope.organization_id, c.scope.operation_id],
  );
  if (
    history.rowCount !== 1 ||
    history.rows[0]?.revision !== 0 ||
    i.reconciliationId === i.preparedAuditEventId ||
    i.reconciliationId === i.finalAuditEventId
  )
    throw new Error("SourceLink Queue recovery terminal failure history is invalid");
  const failure = { code: errorCode, message: "The source link could not be completed." },
    at = timestamp(i.recoveredAt);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE operations SET state='failed',failure=?4,updated_at=?5,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='queued' AND failure IS NULL RETURNING 1",
      )
      .bind(
        c.scope.organization_id,
        c.scope.project_id,
        c.scope.operation_id,
        JSON.stringify(failure),
        at,
      ),
    db
      .prepare(
        "UPDATE product_workflow_runs SET state='completed',terminal_evidence=?2,reconciliation_code=NULL,active_reconciliation_attempt_id=NULL,active_replay_attempt_id=NULL,updated_at=?3,completed_at=?3 WHERE workflow_id=?1 AND state='queued' AND terminal_evidence IS NULL AND intermediate_evidence IS NULL AND reconciliation_code IS NULL AND active_reconciliation_attempt_id IS NULL AND active_replay_attempt_id IS NULL RETURNING 1",
      )
      .bind(c.scope.workflow_id, JSON.stringify({ errorCode }), at),
    guard(
      db,
      "precondition_changed",
      "NOT EXISTS(SELECT 1 FROM operations WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='failed' AND failure=?4 AND updated_at=?5) OR NOT EXISTS(SELECT 1 FROM product_workflow_runs WHERE workflow_id=?6 AND state='completed' AND terminal_evidence=?7 AND completed_at=?5)",
      [
        c.scope.organization_id,
        c.scope.project_id,
        c.scope.operation_id,
        JSON.stringify(failure),
        at,
        c.scope.workflow_id,
        JSON.stringify({ errorCode }),
      ],
    ),
    db
      .prepare(
        "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at)VALUES(?1,?2,?4,?5,1,'OperationStarted',?6,'{}',?7),(?1,?3,?4,?5,2,'OperationFailed',?8,?9,?7)",
      )
      .bind(
        c.scope.organization_id,
        i.preparedAuditEventId,
        i.finalAuditEventId,
        c.scope.operation_id,
        c.scope.project_id,
        `${c.scope.workflow_id}:source-link-queue-recovery-start`,
        at,
        `${c.scope.workflow_id}:source-link-queue-recovery-failed`,
        JSON.stringify({ failure }),
      ),
    db
      .prepare(
        "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id)VALUES(?1,?2,?3,?4,'SourceLinkQueueDeliveryRecoveryFailureRecorded','system','source-link-queue-delivery-recovery',?5,?6,?7)",
      )
      .bind(
        c.scope.organization_id,
        i.reconciliationId,
        c.scope.project_id,
        c.scope.operation_id,
        JSON.stringify({ code: errorCode, workflowOutcome: i.workflowOutcome }),
        at,
        c.scope.billing_epoch_id,
      ),
  ];
  const after: S.RecoveryCandidate = {
    ...c,
    scope: {
      ...c.scope,
      operation_state: "failed",
      operation_failure: failure,
      workflow_state: "completed",
      workflow_terminal_evidence: { errorCode },
      workflow_reconciliation_code: null,
      active_reconciliation_attempt_id: null,
      active_replay_attempt_id: null,
    },
  };
  if (!S.isFinalizationScope(after))
    throw new Error("SourceLink Queue recovery terminal failure changed before Outbox close");
  return { statements, candidate: after };
}
export async function finalizeSourceLinkQueueDeliveryRecovery(
  context: CatalogContext,
  raw: unknown,
): Promise<S.FinalizeSourceLinkQueueDeliveryRecoveryResult> {
  const i = raw as S.FinalizeSourceLinkQueueDeliveryRecoveryInput;
  S.assertFinalizationInput(i);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<S.FinalizeSourceLinkQueueDeliveryRecoveryResult>(
    db,
    "queueRecovery.finalizeSourceLink",
    i,
    async (reader) => {
      const project = await R.lockSourceLinkRecoveryProjectProviderTransaction(reader, i),
        scope = await R.lockRecoveryScope(reader, i);
      if (scope === undefined) {
        const replay = await R.readFinalSourceLinkQueueDeliveryRecovery(reader, i);
        if (replay) return { statements: [], value: { ...replay, outcome: "duplicate" as const } };
        throw new Error("SourceLink Queue recovery scope is unavailable");
      }
      if (project !== null && scope.project_id !== project)
        throw new Error("SourceLink Queue recovery project scope changed");
      let c = await R.lockRecoveryCandidate(reader, scope);
      if (c === null || !S.isFinalizationScope(c)) {
        const replay = await R.readFinalSourceLinkQueueDeliveryRecovery(reader, i);
        if (replay) return { statements: [], value: { ...replay, outcome: "duplicate" as const } };
        throw new Error("SourceLink event is not an exact final Queue-delivery recovery candidate");
      }
      S.assertFinalizationScope(c, i);
      const all = await R.loadRecoveryAudits(reader, c),
        prepared = all.filter(
          (a) => a.event_type === S.SOURCE_LINK_QUEUE_DELIVERY_RECOVERY_PREPARED,
        );
      if (prepared.length !== 1 || !prepared[0])
        throw new Error("SourceLink Queue recovery requires one exact prepared audit");
      S.assertPreparedAudit(prepared[0], c, i);
      if (all.some((a) => a.event_type === S.SOURCE_LINK_QUEUE_DELIVERY_RECOVERED))
        throw new Error("SourceLink Queue recovery final audit conflicts with its open Outbox");
      const at = S.parseTimestamp(i.recoveredAt, "SourceLink Queue recovery completion time");
      if (at < S.requiredFailureAt(c))
        throw new RangeError(
          "SourceLink Queue recovery completion time must not predate the final delivery failure",
        );
      if (at < prepared[0].occurred_at)
        throw new RangeError(
          "SourceLink Queue recovery completion time must not predate the prepared recovery audit",
        );
      let resolution = S.resolveFinalization(c, i.workflowOutcome);
      if (resolution.state === "uncertain")
        return {
          statements: [],
          value: {
            outcome: "uncertain" as const,
            reconciliationId: parseUlid(i.reconciliationId),
            operationId: parseUlid(i.operationId),
            state: "uncertain" as const,
          },
        };
      const statements: D1PreparedStatement[] = [];
      if (resolution.recordQueuedTerminalFailure !== undefined) {
        const recorded = await terminalFailure(
          reader,
          db,
          c,
          i,
          resolution.recordQueuedTerminalFailure,
        );
        statements.push(...recorded.statements);
        c = recorded.candidate;
        resolution = S.resolveFinalization(c, i.workflowOutcome);
        if (
          resolution.state === "uncertain" ||
          resolution.recordQueuedTerminalFailure !== undefined
        )
          throw new Error("SourceLink Queue recovery terminal failure is not durable");
      }
      statements.push(
        db
          .prepare(
            "UPDATE outbox_events SET acknowledged_at=?2,reconciliation_required_at=NULL WHERE event_id=?1 RETURNING 1",
          )
          .bind(c.event.event_id, timestamp(i.recoveredAt)),
        guard(
          db,
          "precondition_changed",
          "NOT EXISTS(SELECT 1 FROM outbox_events WHERE event_id=?1 AND acknowledged_at=?2 AND reconciliation_required_at IS NULL)",
          [c.event.event_id, timestamp(i.recoveredAt)],
        ),
        audit(db, c, i, true, i.recoveredAt, S.finalPayload(c, i, resolution)),
      );
      return {
        statements,
        value: {
          outcome: "recovered" as const,
          reconciliationId: parseUlid(i.reconciliationId),
          operationId: parseUlid(i.operationId),
          state: resolution.state,
          ...(resolution.continueProductWorkflowReplay === true
            ? { continueProductWorkflowReplay: true as const }
            : {}),
        },
      };
    },
  );
}
export async function readClosedSourceLinkQueueDeliveryRecovery(
  context: CatalogContext,
  raw: unknown,
) {
  const i = raw as {
    organizationId: import("@ohmyhost/platform").Ulid;
    operationId: import("@ohmyhost/platform").Ulid;
  };
  parseUlid(i.organizationId);
  parseUlid(i.operationId);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision(db, "queueRecovery.readClosedSourceLink", i, async (r) => ({
    statements: [],
    value: await R.readClosedSourceLinkQueueDeliveryRecoveryState(r, i),
  }));
}
export async function readTerminalSourceLinkWorkflowReplayAttempt(
  context: CatalogContext,
  raw: unknown,
) {
  const i = raw as Parameters<typeof R.readTerminalSourceLinkWorkflowReplayAttemptState>[1];
  parseUlid(i.organizationId);
  parseUlid(i.operationId);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision(db, "queueRecovery.readTerminalSourceLinkReplay", i, async (r) => ({
    statements: [],
    value: await R.readTerminalSourceLinkWorkflowReplayAttemptState(r, i),
  }));
}
