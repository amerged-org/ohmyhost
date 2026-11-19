import {
  parseUlid,
  rehydrateOperation,
  startOperation,
  failOperation,
  type Ulid,
} from "@ohmyhost/platform";
import type { D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { storedTimestamp } from "../../timestamps.js";
import { routeOrganization, type CatalogContext } from "../common.js";
import { runRecoveryDecision, type RecoveryReads } from "./queue-recovery-snapshot.js";
import {
  operationEventFromRow,
  storedOperation,
  type OperationRow,
  type OperationEventRow,
} from "./lost-command-values.js";
import { ABANDONED, LOST } from "./lost-command-queries.js";
const ABANDONED_EVENT = "ProductCommandAbandoned";
interface Scope {
  organizationId: Ulid;
  operationId: Ulid;
}
interface Lost {
  project_id: string;
  billing_epoch_id: string;
  event_id: string;
  workflow_id: string | null;
}
interface Abandon extends Scope {
  workflowId: string | null;
  reconciliationId: Ulid;
  actorId: string;
  abandonedAt: string;
  eventIds: readonly Ulid[];
}
async function abandoned(reader: RecoveryReads, i: Scope) {
  return (
    (await reader.select(ABANDONED, [i.organizationId, i.operationId, ABANDONED_EVENT]))
      .rowCount !== 0
  );
}
async function lost(reader: RecoveryReads, i: Scope): Promise<Lost | null> {
  const r = await reader.select<Lost>(LOST, [i.organizationId, i.operationId]);
  if (r.rowCount === 0) return null;
  if (r.rowCount !== 1 || !r.rows[0]) throw new Error("Lost product command is ambiguous");
  return r.rows[0];
}
export async function findLostProductCommand(
  context: CatalogContext,
  raw: unknown,
): Promise<Readonly<{ state: "abandoned" } | { state: "lost"; workflowId: string | null }> | null> {
  const i = raw as Scope;
  parseUlid(i.organizationId);
  parseUlid(i.operationId);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<Readonly<
    { state: "abandoned" } | { state: "lost"; workflowId: string | null }
  > | null>(db, "lostCommand.find", i, async (reader) => {
    if (await abandoned(reader, i))
      return { statements: [], value: { state: "abandoned" as const } };
    const row = await lost(reader, i);
    return {
      statements: [],
      value: row === null ? null : { state: "lost" as const, workflowId: row.workflow_id },
    };
  });
}
export async function abandonLostProductCommand(
  context: CatalogContext,
  raw: unknown,
): Promise<"abandoned" | "existing" | "changed"> {
  const i = raw as Abandon;
  parseUlid(i.reconciliationId);
  if (new Date(i.abandonedAt).toISOString() !== i.abandonedAt)
    throw new TypeError("Lost product command abandonment time is invalid");
  parseUlid(i.organizationId);
  parseUlid(i.operationId);
  const { db } = await routeOrganization(context, i.organizationId);
  return runRecoveryDecision<"abandoned" | "existing" | "changed">(
    db,
    "lostCommand.abandon",
    i,
    async (reader) => {
      if (await abandoned(reader, i)) return { statements: [], value: "existing" };
      const row = await lost(reader, i);
      if (row === null || row.workflow_id !== i.workflowId)
        return { statements: [], value: "changed" };
      const stored = (
        await reader.select<OperationRow>(
          "SELECT operation_id,project_id,state,failure,created_at,updated_at,billing_epoch_id FROM operations WHERE organization_id=?1 AND operation_id=?2",
          [i.organizationId, i.operationId],
        )
      ).rows[0];
      if (!stored) return { statements: [], value: "changed" };
      const events = await reader.select<OperationEventRow>(
        "SELECT event_id,operation_id,project_id,revision,event_type,idempotency_key,payload,occurred_at FROM operation_events WHERE organization_id=?1 AND operation_id=?2 ORDER BY revision",
        [i.organizationId, i.operationId],
      );
      const initial = storedOperation(
        stored,
        rehydrateOperation(
          events.rows.map((event, n) => {
            if (event.revision !== n)
              throw new Error("Operation event revisions must be contiguous and start at zero");
            return operationEventFromRow(event);
          }),
        ),
      );
      if (initial.state !== "queued") return { statements: [], value: "changed" };
      if (!Array.isArray(i.eventIds) || i.eventIds.length !== 4)
        throw new TypeError("Lost product command needs four local event identities");
      for (const id of i.eventIds) parseUlid(id);
      let cursor = 0;
      const next = () => {
        const id = i.eventIds[cursor++];
        if (id === undefined)
          throw new Error("Lost product command local event identity is missing");
        return id;
      };
      const dependencies = { clock: { now: () => new Date(i.abandonedAt) }, eventIds: { next } };
      let operation = initial;
      const statements: D1PreparedStatement[] = [];
      for (const transition of [
        (current: typeof initial) =>
          startOperation(
            current,
            { idempotencyKey: `lost-command:${i.operationId}:start` },
            dependencies,
          ),
        (current: typeof initial) =>
          failOperation(
            current,
            {
              idempotencyKey: `lost-command:${i.operationId}:fail`,
              failure: {
                code: "OPERATION_ABANDONED",
                message: "The command never reached its Workflow and was ended.",
              },
            },
            dependencies,
          ),
      ]) {
        const after = transition(operation),
          event = after.events.at(-1),
          auditId = next();
        if (!event || event.type === "OperationQueued")
          throw new Error("Lost product command transition is missing");
        if (i.actorId.trim() === "") throw new TypeError("Audit actor type and ID are required");
        const at = storedTimestamp(after.updatedAt),
          lease =
            after.state === "running" || after.state === "queued"
              ? storedTimestamp(
                  new Date(Date.parse(after.updatedAt) + 15 * 60 * 1000).toISOString(),
                )
              : null;
        statements.push(
          db
            .prepare(
              "UPDATE operations SET state=?3,failure=?4,updated_at=?5,lease_expires_at=?6 WHERE organization_id=?1 AND operation_id=?2 RETURNING 1",
            )
            .bind(
              i.organizationId,
              i.operationId,
              after.state,
              after.failure === undefined ? null : JSON.stringify(after.failure),
              at,
              lease,
            ),
          guard(db, "precondition_changed", "changes()<>1"),
          db
            .prepare(
              "INSERT INTO operation_events(organization_id,event_id,operation_id,project_id,event_type,revision,idempotency_key,payload,occurred_at)VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            )
            .bind(
              i.organizationId,
              event.eventId,
              event.operationId,
              event.projectId,
              event.type,
              operation.events.length,
              event.idempotencyKey,
              JSON.stringify(event.type === "OperationFailed" ? { failure: event.failure } : {}),
              storedTimestamp(event.occurredAt),
            ),
          db
            .prepare(
              "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id)VALUES(?1,?2,?3,?4,?5,'principal',?6,?7,?8,?9)",
            )
            .bind(
              i.organizationId,
              auditId,
              after.projectId,
              i.operationId,
              event.type,
              i.actorId,
              JSON.stringify({ reasonCode: "OPERATION_ABANDONED" }),
              storedTimestamp(i.abandonedAt),
              stored.billing_epoch_id,
            ),
        );
        operation = after;
      }
      const at = storedTimestamp(i.abandonedAt);
      statements.push(
        db
          .prepare(
            "UPDATE product_workflow_runs SET state='completed',terminal_evidence=?3,completed_at=?4,updated_at=?4 WHERE organization_id=?1 AND operation_id=?2 AND workflow_id=?5 AND state='queued'",
          )
          .bind(
            i.organizationId,
            i.operationId,
            JSON.stringify({ errorCode: "OPERATION_ABANDONED" }),
            at,
            i.workflowId,
          ),
        db
          .prepare(
            "UPDATE outbox_events SET acknowledged_at=?3,reconciliation_required_at=NULL WHERE organization_id=?1 AND operation_id=?2 AND event_id=?4 AND acknowledged_at IS NULL RETURNING 1",
          )
          .bind(i.organizationId, i.operationId, at, row.event_id),
        guard(db, "precondition_changed", "changes()<>1"),
        db
          .prepare(
            "INSERT INTO audit_events(organization_id,audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id)VALUES(?1,?2,?3,?4,'ProductCommandAbandoned','principal',?5,?6,?7,?8)",
          )
          .bind(
            i.organizationId,
            i.reconciliationId,
            row.project_id,
            i.operationId,
            i.actorId,
            JSON.stringify({ eventId: row.event_id, workflowId: i.workflowId }),
            at,
            row.billing_epoch_id,
          ),
      );
      return { statements, value: "abandoned" };
    },
  );
}
