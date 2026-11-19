import { parseUlid } from "@ohmyhost/platform";
import type * as Native from "@ohmyhost/database";
import type { D1Database } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { ProductWorkflowContextConflictError as Conflict } from "./context.js";
import { runRecoveryDecision, type RecoveryReads } from "./queue-recovery-snapshot.js";
import * as Q from "./workflow-replay-queries.js";
import { originalMessage, validateReplayInput } from "./workflow-replay-values.js";
type NativeModule = typeof Native;
type Input<K extends keyof NativeModule> = NativeModule[K] extends (...args: infer P) => unknown
  ? P[1]
  : never;
type Return<K extends keyof NativeModule> = NativeModule[K] extends (...args: never[]) => infer R
  ? Awaited<R>
  : never;
interface CandidateRow {
  project_id: string;
  environment_id: string;
  event_id: string;
  billing_epoch_id: string;
  logical_workflow_id: string;
  event_type: Q.ProductWorkflowReplayCandidate["eventType"];
  queue_handoff_pending: number;
  data_change: string | null;
}
async function candidate(
  reader: RecoveryReads,
  input: { organizationId: string; operationId: string },
) {
  const { rows } = await reader.select<CandidateRow>(Q.FIND, [
      input.organizationId,
      input.operationId,
    ]),
    row = rows[0];
  return row === undefined
    ? null
    : {
        organizationId: parseUlid(input.organizationId),
        projectId: parseUlid(row.project_id),
        environmentId: parseUlid(row.environment_id),
        operationId: parseUlid(input.operationId),
        eventId: parseUlid(row.event_id),
        billingEpochId: parseUlid(row.billing_epoch_id),
        logicalWorkflowId: row.logical_workflow_id,
        eventType: row.event_type,
        queueHandoffPending: row.queue_handoff_pending === 1,
        ...(row.event_type === "ProjectDataChangeRequestedV1"
          ? { dataChange: row.data_change }
          : {}),
      };
}
function audit(
  db: D1Database,
  input: {
    organizationId: string;
    projectId: string;
    operationId: string;
    billingEpochId: string;
    actorId: string;
  },
  id: string,
  type: string,
  payload: unknown,
  at: string,
) {
  return db
    .prepare(
      "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id)VALUES(?1,?2,?3,?4,?5,'user',?6,?7,?8,?9)",
    )
    .bind(
      input.organizationId,
      id,
      input.projectId,
      input.operationId,
      type,
      input.actorId,
      JSON.stringify(payload),
      storedTimestamp(at),
      input.billingEpochId,
    );
}
export async function findProductWorkflowReplayCandidate(
  context: CatalogContext,
  raw: unknown,
): Promise<Return<"findProductWorkflowReplayCandidate">> {
  const i = raw as Input<"findProductWorkflowReplayCandidate">;
  parseUlid(i.organizationId);
  parseUlid(i.operationId);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision(db, "workflowReplay.findCandidate", i, async (reader) => ({
    statements: [],
    value: await candidate(reader, i),
  }));
}
interface RunlessRow {
  project_id: string;
  environment_id: string;
  event_id: string;
  billing_epoch_id: string;
  event_type: Q.ProductWorkflowReplayCandidate["eventType"];
  attempt_id: string;
  plan_id: string | null;
  requested_handle: string | null;
  data_change: string | null;
}
async function runless(
  reader: RecoveryReads,
  input: { organizationId: string; operationId: string },
) {
  const { rows } = await reader.select<RunlessRow>(Q.RUNLESS_FIND, [
    input.organizationId,
    input.operationId,
  ]);
  const row = rows[0];
  return row === undefined
    ? null
    : {
        organizationId: parseUlid(input.organizationId),
        projectId: parseUlid(row.project_id),
        environmentId: parseUlid(row.environment_id),
        operationId: parseUlid(input.operationId),
        eventId: parseUlid(row.event_id),
        attemptId: parseUlid(row.attempt_id),
        billingEpochId: parseUlid(row.billing_epoch_id),
        eventType: row.event_type,
        planId: row.plan_id,
        requestedHandle: row.requested_handle,
        dataChange: row.data_change,
      };
}
/** The run-less candidate of an operation: an exhausted event of any Workflow run type that has no Workflow run row. */
export async function findRunlessProductDispatch(
  context: CatalogContext,
  raw: unknown,
): Promise<Return<"findRunlessProductDispatch">> {
  const i = raw as Input<"findRunlessProductDispatch">;
  parseUlid(i.organizationId);
  parseUlid(i.operationId);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision(db, "workflowReplay.findRunless", i, async (reader) => ({
    statements: [],
    value: await runless(reader, i),
  }));
}
export async function finalizeProjectDeletionQueueHandoff(
  context: CatalogContext,
  raw: unknown,
): Promise<"acknowledged" | "existing"> {
  const i = raw as Input<"finalizeProjectDeletionQueueHandoff">;
  for (const v of [
    i.auditEventId,
    i.organizationId,
    i.projectId,
    i.environmentId,
    i.operationId,
    i.eventId,
    i.billingEpochId,
  ])
    parseUlid(v);
  if (
    ![
      "SourceLinkRequestedV1",
      "DeploymentRollbackRequestedV1",
      "DeploymentPromotionRequestedV1",
      "ProjectDeletionRequestedV1",
      "ProjectDataChangeRequestedV1",
    ].includes(i.eventType) ||
    i.queueHandoffPending !== true ||
    i.actorId.trim() !== i.actorId ||
    i.actorId.length === 0 ||
    i.actorId.length > 255 ||
    new Date(i.acknowledgedAt).toISOString() !== i.acknowledgedAt
  )
    throw new TypeError("Queue handoff is invalid");
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<"acknowledged" | "existing">(
    db,
    "workflowReplay.finalizeDeletionHandoff",
    i,
    async (reader) => {
      const values = [
          i.eventId,
          i.organizationId,
          i.projectId,
          i.operationId,
          i.billingEpochId,
          i.logicalWorkflowId,
          i.environmentId,
          storedTimestamp(i.acknowledgedAt),
        ],
        eligible = await reader.select(Q.HANDOFF_ELIGIBLE, values.slice(0, 7));
      if (eligible.rowCount !== 1) {
        const old = await reader.select(Q.HANDOFF_REPLAY, [
          i.eventId,
          i.organizationId,
          i.projectId,
          i.operationId,
          i.billingEpochId,
          i.auditEventId,
        ]);
        if (old.rowCount === 1) return { statements: [], value: "existing" };
        throw new Conflict("Queue handoff changed");
      }
      return {
        statements: [
          db.prepare(Q.HANDOFF_UPDATE).bind(...values),
          guard(db, "precondition_changed", "changes()<>1"),
          audit(
            db,
            i,
            i.auditEventId,
            "ProjectDeletionQueueDeliveryRecovered",
            { workflowId: i.logicalWorkflowId, eventId: i.eventId },
            i.acknowledgedAt,
          ),
        ],
        value: "acknowledged",
      };
    },
  );
}
export async function prepareProductWorkflowReplay(
  context: CatalogContext,
  raw: unknown,
): Promise<"prepared" | "existing" | "exhausted"> {
  const i = raw as Input<"prepareProductWorkflowReplay">;
  validateReplayInput(i);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<"prepared" | "existing" | "exhausted">(
    db,
    "workflowReplay.prepare",
    i,
    async (reader) => {
      const existing = await reader.select<{ attempt_id: string }>(Q.EXISTING, [
        i.organizationId,
        i.operationId,
        i.idempotencyDigest,
      ]);
      if (existing.rows[0]?.attempt_id === i.attemptId)
        return { statements: [], value: "existing" };
      if (existing.rowCount > 0) throw new Conflict("Product Workflow replay identity changed");
      const current = await candidate(reader, i);
      if (
        !current ||
        current.projectId !== i.projectId ||
        current.environmentId !== i.environmentId ||
        current.eventId !== i.eventId ||
        current.billingEpochId !== i.billingEpochId ||
        current.logicalWorkflowId !== i.logicalWorkflowId ||
        current.eventType !== i.eventType
      )
        throw new Conflict("Product Workflow is no longer replayable");
      const latest = await reader.select<{ attempt_number: number }>(Q.LATEST, [
          i.logicalWorkflowId,
        ]),
        attemptNumber = (latest.rows[0]?.attempt_number ?? 0) + 1;
      if (attemptNumber > 32) return { statements: [], value: "exhausted" };
      const at = storedTimestamp(i.preparedAt),
        statements = [
          db
            .prepare(Q.INSERT_ATTEMPT)
            .bind(
              i.attemptId,
              i.organizationId,
              i.projectId,
              i.environmentId,
              i.operationId,
              i.eventId,
              i.billingEpochId,
              i.logicalWorkflowId,
              i.physicalWorkflowId,
              i.eventType,
              i.idempotencyDigest,
              attemptNumber,
              i.actorId,
              at,
            ),
          db.prepare(Q.ACTIVATE).bind(i.logicalWorkflowId, i.attemptId, at),
          guard(db, "precondition_changed", "changes()<>1"),
        ];
      if (
        i.eventType === "ProjectDeletionRequestedV1" ||
        i.eventType === "ProjectDataChangeRequestedV1"
      ) {
        const cleanup = await reader.select<{ state: string }>(Q.CLEANUP, [
          i.organizationId,
          i.projectId,
          i.operationId,
        ]);
        if (
          !cleanup.rows[0] ||
          !["pending", "running", "reconciliation_required"].includes(cleanup.rows[0].state)
        )
          throw new Conflict("Product deletion cleanup is no longer active");
        if (cleanup.rows[0].state !== "running")
          statements.push(
            db.prepare(Q.RESTART_CLEANUP).bind(i.organizationId, i.projectId, i.operationId, at),
          );
      }
      statements.push(
        audit(
          db,
          i,
          i.attemptId,
          "ProductWorkflowReplayPrepared",
          {
            attemptNumber,
            eventType: i.eventType,
            logicalWorkflowId: i.logicalWorkflowId,
            physicalWorkflowId: i.physicalWorkflowId,
          },
          i.preparedAt,
        ),
      );
      return { statements, value: "prepared" };
    },
  );
}
interface ReplayRow {
  attempt_id: string;
  physical_workflow_id: string;
  event_id: string;
  organization_id: string;
  project_id: string;
  environment_id: string;
  operation_id: string;
  billing_epoch_id: string;
  event_type: Q.ProductWorkflowReplayCandidate["eventType"];
  operation_state: string;
  run_state: string;
  active_reconciliation_attempt_id: string | null;
  active_replay_attempt_id: string | null;
  failure_id: string | null;
  data_change: string | null;
}
export async function readProductWorkflowReplayAttempt(
  context: CatalogContext,
  raw: unknown,
): Promise<Return<"readProductWorkflowReplayAttempt">> {
  const i = raw as Input<"readProductWorkflowReplayAttempt">;
  for (const v of [i.organizationId, i.operationId, i.attemptId]) parseUlid(v);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<Return<"readProductWorkflowReplayAttempt">>(
    db,
    "workflowReplay.readAttempt",
    i,
    async (reader) => {
      const row = (
        await reader.select<ReplayRow>(Q.READ_ATTEMPT, [
          i.organizationId,
          i.operationId,
          i.attemptId,
          i.actorId,
          i.idempotencyDigest,
        ])
      ).rows[0];
      if (!row) return { statements: [], value: null };
      const attemptId = parseUlid(row.attempt_id);
      if (
        row.failure_id !== null ||
        row.run_state === "completed" ||
        row.run_state === "reconciliation_required" ||
        ["succeeded", "failed"].includes(row.operation_state)
      ) {
        if (row.active_reconciliation_attempt_id !== null || row.active_replay_attempt_id !== null)
          throw new Conflict("Product Workflow replay state changed");
        return { statements: [], value: { outcome: "completed", attemptId } };
      }
      if (
        row.run_state !== "queued" ||
        row.active_reconciliation_attempt_id !== null ||
        row.active_replay_attempt_id !== row.attempt_id
      )
        throw new Conflict("Product Workflow replay state changed");
      return {
        statements: [],
        value: {
          outcome: "prepared",
          attemptId,
          physicalWorkflowId: row.physical_workflow_id,
          originalMessage: originalMessage(row),
        },
      };
    },
  );
}
export async function recoverTerminalProductWorkflowReplay(
  context: CatalogContext,
  raw: unknown,
): Promise<"recovered" | "existing"> {
  const i = raw as Input<"recoverTerminalProductWorkflowReplay">;
  for (const v of [i.failureId, i.attemptId, i.organizationId, i.operationId]) parseUlid(v);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<"recovered" | "existing">(
    db,
    "workflowReplay.recoverTerminal",
    i,
    async (reader) => {
      const prior = await reader.select(Q.FAILURE_REPLAY, [
        i.attemptId,
        i.organizationId,
        i.operationId,
        i.actorId,
      ]);
      if (prior.rowCount === 1) return { statements: [], value: "existing" };
      const eligible = await reader.select(Q.FAILURE_ELIGIBLE, [
        null,
        i.attemptId,
        i.organizationId,
        i.operationId,
        null,
        null,
        i.actorId,
      ]);
      if (eligible.rowCount !== 1) throw new Conflict("Product Workflow replay recovery changed");
      return {
        statements: [
          db
            .prepare(Q.INSERT_FAILURE)
            .bind(
              i.failureId,
              i.attemptId,
              i.organizationId,
              i.operationId,
              i.terminalStatus,
              i.evidenceDigest,
              i.actorId,
              storedTimestamp(i.recoveredAt),
            ),
          guard(db, "precondition_changed", "changes()<>1"),
          db
            .prepare(Q.RELEASE_FAILURE)
            .bind(i.organizationId, i.operationId, storedTimestamp(i.recoveredAt), i.attemptId),
          guard(db, "precondition_changed", "changes()<>1"),
        ],
        value: "recovered",
      };
    },
  );
}
