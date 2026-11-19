import { z } from "zod";
import type { D1Database, D1PreparedStatement } from "../../d1-types.js";
import { guard } from "../../guards.js";
import { runCommand, type Command } from "../../run-command.js";
import {
  auditStatement,
  conflict,
  fenceRaceGuard,
  instant,
  routeOrganization,
  ulid,
  type CatalogContext,
} from "../common.js";
import { readOperation, type StoredOperation } from "../operations/operation-store.js";

const step = z.strictObject({ eventId: ulid, auditEventId: ulid, occurredAt: instant });
const request = z
  .strictObject({
    organizationId: ulid,
    projectId: ulid,
    operationId: ulid,
    requestEventId: ulid,
    workflowId: z.string().min(1),
    serviceActorId: z.string().trim().min(1),
  })
  .refine(
    (v) => v.workflowId === `project-provisioning-v1-${v.requestEventId}-${v.operationId}`,
    "Provisioning Workflow identity differs",
  );
export const completeProvisioningInput = request.safeExtend({ started: step, succeeded: step });
export const failProvisioningInput = request.safeExtend({
  started: step,
  failed: step,
  failure: z.strictObject({ code: z.string().trim().min(1), message: z.string().trim().min(1) }),
});
export const reconcileProvisioningInput = request.safeExtend({
  auditEventId: ulid,
  occurredAt: instant,
});
type Scope = z.output<typeof request>;
type Transition = z.output<typeof step>;
type Terminal = {
  state: "succeeded" | "failed";
  first: Transition;
  last: Transition;
  failure?: { code: string; message: string };
};
type Row = Record<string, unknown>;
const payload = (workflowId: string, state: string) => ({
  state,
  trigger: "ProjectProvisioningRequested",
  workflowId,
});
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const bad = () =>
  conflict("provisioning_conflict", "Provisioning operation or durable evidence differs");
const requestSql = `SELECT 1 FROM outbox_events WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_id=?4 AND event_type='ProjectProvisioningRequested'`;
const scopeValues = (v: Scope) => [v.organizationId, v.projectId, v.operationId, v.requestEventId];

function assertOperation(
  operation: StoredOperation | null,
  input: Scope,
): asserts operation is StoredOperation {
  if (operation === null || operation.projectId !== input.projectId) throw bad();
  const first = operation.events[0],
    last = operation.events.at(-1);
  if (
    !first ||
    !last ||
    first.type !== "OperationQueued" ||
    first.projectId !== input.projectId ||
    first.idempotencyKey !== null ||
    Object.keys(first.payload).length !== 0 ||
    operation.createdAt !== first.occurredAt ||
    operation.updatedAt !== last.occurredAt
  )
    throw bad();
  for (const [index, event] of operation.events.entries())
    if (
      event.projectId !== input.projectId ||
      event.occurredAt < (operation.events[index - 1]?.occurredAt ?? event.occurredAt)
    )
      throw bad();
}
function replayTerminal(
  operation: StoredOperation,
  audits: Row[],
  input: Scope,
  terminal: Terminal,
): boolean {
  if (operation.state !== terminal.state) return false;
  const [queued, started, ended, extra] = operation.events;
  const endType = terminal.state === "succeeded" ? "OperationSucceeded" : "OperationFailed";
  if (
    queued?.type !== "OperationQueued" ||
    started?.type !== "OperationStarted" ||
    ended?.type !== endType ||
    extra !== undefined ||
    started.projectId !== input.projectId ||
    ended.projectId !== input.projectId ||
    started.idempotencyKey !== `${input.workflowId}:started` ||
    ended.idempotencyKey !== `${input.workflowId}:${terminal.state}` ||
    Object.keys(started.payload).length !== 0 ||
    (terminal.state === "succeeded"
      ? Object.keys(ended.payload).length !== 0
      : !equal(ended.payload, { failure: terminal.failure })) ||
    (terminal.state === "failed" && !equal(operation.failure, terminal.failure)) ||
    audits.length !== 2
  )
    throw bad();
  for (const [event, state] of [
    [started, "running"],
    [ended, terminal.state],
  ] as const) {
    const audit = audits.find((v) => v["event_type"] === event.type);
    if (
      !audit ||
      audit["project_id"] !== input.projectId ||
      audit["operation_id"] !== input.operationId ||
      audit["actor_type"] !== "service" ||
      audit["actor_id"] !== input.serviceActorId ||
      new Date(String(audit["occurred_at"])).toISOString() !== event.occurredAt ||
      !equal(JSON.parse(String(audit["payload"])), payload(input.workflowId, state))
    )
      throw bad();
  }
  return true;
}
function initializationStatements(
  db: D1Database,
  input: Scope,
  terminal: Terminal,
): D1PreparedStatement[] {
  const values = [
    input.organizationId,
    input.projectId,
    input.operationId,
    terminal.last.occurredAt,
  ];
  if (terminal.state === "failed")
    return [
      db
        .prepare(
          `UPDATE managed_source_initializations SET state='failed',error_code='PROJECT_CREATION_FAILED',updated_at=?4
    WHERE organization_id=?1 AND project_id=?2 AND parent_operation_id=?3 AND state IN ('waiting','queued')`,
        )
        .bind(...values),
    ];
  const eligible = `SELECT recipe.initialization_event_id,recipe.billing_epoch_id,environment.environment_id FROM managed_source_initializations recipe
    JOIN operations operation ON operation.organization_id=recipe.organization_id AND operation.project_id=recipe.project_id AND operation.operation_id=recipe.parent_operation_id AND operation.state='succeeded'
    JOIN projects project ON project.organization_id=recipe.organization_id AND project.project_id=recipe.project_id
      AND project.active_billing_epoch_id=recipe.billing_epoch_id AND project.owner_state='active' AND project.lifecycle_state='active'
    JOIN environments environment ON environment.organization_id=recipe.organization_id AND environment.project_id=recipe.project_id AND environment.name=CASE WHEN EXISTS(SELECT 1 FROM environments preferred WHERE preferred.organization_id=project.organization_id AND preferred.project_id=project.project_id AND preferred.name='dev') THEN 'dev' ELSE 'prod' END
    WHERE recipe.organization_id=?1 AND recipe.project_id=?2 AND recipe.parent_operation_id=?3 AND recipe.state='waiting'`;
  return [
    db
      .prepare(
        `INSERT INTO outbox_events(organization_id,event_id,project_id,operation_id,event_type,payload,created_at,initial_available_at,available_at,max_attempts,billing_epoch_id)
    SELECT ?1,recipe.initialization_event_id,?2,?3,'ManagedSourceInitializationRequestedV1',json_object('environmentId',recipe.environment_id),?4,?4,?4,5,recipe.billing_epoch_id
    FROM (${eligible}) recipe WHERE true ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(...values),
    db
      .prepare(
        `UPDATE managed_source_initializations SET state='queued',updated_at=?4 WHERE organization_id=?1 AND project_id=?2 AND parent_operation_id=?3 AND state='waiting'
      AND EXISTS(SELECT 1 FROM (${eligible}))`,
      )
      .bind(...values),
  ];
}
async function persistTerminal(
  context: CatalogContext,
  input: Scope,
  terminal: Terminal,
): Promise<"applied" | "duplicate"> {
  const { db } = await routeOrganization(context, input.organizationId);
  const read = async (reader: D1Database) => {
    const operation = await readOperation(reader, input.organizationId, input.operationId);
    const [request, audits] = await reader.batch([
      reader.prepare(requestSql).bind(...scopeValues(input)),
      reader
        .prepare(
          `SELECT project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at FROM audit_events
        WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type IN ('OperationStarted','OperationSucceeded','OperationFailed')`,
        )
        .bind(...scopeValues(input).slice(0, 3)),
    ]);
    return { operation, exists: request?.results.length === 1, audits: audits?.results ?? [] };
  };
  const command: Command<Awaited<ReturnType<typeof read>>, "applied" | "duplicate"> = {
    name: terminal.state === "succeeded" ? "provisioning.completeHello" : "provisioning.failHello",
    input: { ...input, terminal },
    read,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["operation_events", "audit_events"],
    lookup: async (reader) => {
      const s = await read(reader);
      assertOperation(s.operation, input);
      return s.exists && replayTerminal(s.operation, s.audits, input, terminal)
        ? "duplicate"
        : undefined;
    },
    decide: (s) => {
      assertOperation(s.operation, input);
      const operation = s.operation;
      if (!s.exists) return { reject: bad() };
      if (replayTerminal(s.operation, s.audits, input, terminal)) {
        // The original duplicate path also repairs the idempotent managed-source handoff.
        return {
          statements: [
            fenceRaceGuard(db, "operation_conflict", input.organizationId),
            ...initializationStatements(db, input, {
              ...terminal,
              last: {
                ...terminal.last,
                occurredAt: operation.updatedAt.slice(0, 23) + "000Z",
              },
            }),
          ],
          result: () => "duplicate",
        };
      }
      if (
        s.operation.state !== "queued" ||
        s.operation.events.length !== 1 ||
        s.operation.events[0]?.type !== "OperationQueued"
      )
        return { reject: bad() };
      if (
        Date.parse(terminal.first.occurredAt) < Date.parse(s.operation.updatedAt) ||
        terminal.last.occurredAt < terminal.first.occurredAt
      )
        return { reject: bad() };
      const event = (
        transition: Transition,
        revision: number,
        type: string,
        suffix: string,
        body: unknown,
      ) =>
        db
          .prepare(
            `INSERT INTO operation_events(organization_id,operation_id,revision,event_id,project_id,event_type,idempotency_key,payload,occurred_at)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
          )
          .bind(
            input.organizationId,
            input.operationId,
            revision,
            transition.eventId,
            input.projectId,
            type,
            `${input.workflowId}:${suffix}`,
            JSON.stringify(body),
            transition.occurredAt,
          );
      const audit = (transition: Transition, type: string, state: string) =>
        auditStatement(db, input.organizationId, {
          auditEventId: transition.auditEventId,
          projectId: input.projectId,
          operationId: input.operationId,
          billingEpochId: operation.billingEpochId,
          eventType: type,
          actorType: "service",
          actorId: input.serviceActorId,
          payload: payload(input.workflowId, state),
          occurredAt: transition.occurredAt,
        });
      const endType = terminal.state === "succeeded" ? "OperationSucceeded" : "OperationFailed";
      return {
        statements: [
          fenceRaceGuard(db, "operation_conflict", input.organizationId),
          guard(db, "operation_conflict", `NOT EXISTS (${requestSql})`, scopeValues(input)),
          db
            .prepare(
              `UPDATE operations SET state=?4,failure=?5,updated_at=?6,lease_expires_at=NULL WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND state='queued'
          AND (SELECT count(*) FROM operation_events WHERE organization_id=?1 AND operation_id=?3)=1`,
            )
            .bind(
              input.organizationId,
              input.projectId,
              input.operationId,
              terminal.state,
              terminal.failure ? JSON.stringify(terminal.failure) : null,
              terminal.last.occurredAt,
            ),
          guard(db, "operation_conflict", "changes()<>1"),
          event(terminal.first, 1, "OperationStarted", "started", {}),
          audit(terminal.first, "OperationStarted", "running"),
          event(
            terminal.last,
            2,
            endType,
            terminal.state,
            terminal.failure ? { failure: terminal.failure } : {},
          ),
          audit(terminal.last, endType, terminal.state),
          ...initializationStatements(db, input, terminal),
        ],
        result: () => "applied",
      };
    },
  };
  return runCommand(db, command);
}
/** The two operation transitions, their original audits and managed-source handoff commit as one command. */
export async function completeProvisioningHello(context: CatalogContext, raw: unknown) {
  const input = completeProvisioningInput.parse(raw);
  return persistTerminal(context, input, {
    state: "succeeded",
    first: input.started,
    last: input.succeeded,
  });
}
export async function failProvisioningHello(context: CatalogContext, raw: unknown) {
  const input = failProvisioningInput.parse(raw);
  return persistTerminal(context, input, {
    state: "failed",
    first: input.started,
    last: input.failed,
    failure: input.failure,
  });
}
/** An uncertain Workflow observation records its original service audit; it does not change operation state. */
export async function reconcileProvisioningHello(
  context: CatalogContext,
  raw: unknown,
): Promise<"applied" | "duplicate"> {
  const input = reconcileProvisioningInput.parse(raw),
    { db } = await routeOrganization(context, input.organizationId);
  const body = {
    workflowId: input.workflowId,
    requestEventId: input.requestEventId,
    reasonCode: "WORKFLOW_OUTCOME_UNCERTAIN",
  };
  const command: Command<
    { operation: StoredOperation | null; request: boolean; audits: Row[] },
    "applied" | "duplicate"
  > = {
    name: "provisioning.reconcileHello",
    input,
    retryOn: ["operation_conflict"],
    naturalKeyTables: ["audit_events"],
    read: async (reader) => {
      const operation = await readOperation(reader, input.organizationId, input.operationId);
      const [request, audits] = await reader.batch([
        reader.prepare(requestSql).bind(...scopeValues(input)),
        reader
          .prepare(
            `SELECT project_id,operation_id,billing_epoch_id,event_type,actor_type,actor_id,payload FROM audit_events
        WHERE organization_id=?1 AND project_id=?2 AND operation_id=?3 AND event_type='ProjectProvisioningReconciliationRequired'`,
          )
          .bind(...scopeValues(input).slice(0, 3)),
      ]);
      return { operation, request: request?.results.length === 1, audits: audits?.results ?? [] };
    },
    decide: (s) => {
      assertOperation(s.operation, input);
      const operation = s.operation;
      if (!s.request) return { reject: bad() };
      if (s.audits.length) {
        const a = s.audits[0];
        if (
          s.audits.length !== 1 ||
          a === undefined ||
          a["billing_epoch_id"] !== operation.billingEpochId ||
          a["actor_type"] !== "service" ||
          a["actor_id"] !== input.serviceActorId ||
          !equal(JSON.parse(String(a["payload"])), body)
        )
          return { reject: bad() };
        return { replay: "duplicate" };
      }
      if (operation.state !== "queued") return { reject: bad() };
      return {
        statements: [
          fenceRaceGuard(db, "operation_conflict", input.organizationId),
          guard(db, "operation_conflict", `NOT EXISTS (${requestSql})`, scopeValues(input)),
          guard(
            db,
            "operation_conflict",
            `NOT EXISTS(SELECT 1 FROM operations WHERE organization_id=?1 AND operation_id=?2 AND state='queued')`,
            [input.organizationId, input.operationId],
          ),
          auditStatement(db, input.organizationId, {
            auditEventId: input.auditEventId,
            projectId: input.projectId,
            operationId: input.operationId,
            billingEpochId: operation.billingEpochId,
            eventType: "ProjectProvisioningReconciliationRequired",
            actorType: "service",
            actorId: input.serviceActorId,
            payload: body,
            occurredAt: input.occurredAt,
          }),
        ],
        result: () => "applied",
      };
    },
  };
  return runCommand(db, command);
}
