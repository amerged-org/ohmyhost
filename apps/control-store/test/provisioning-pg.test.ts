import { expect, it } from "vitest";
import { createTestControl } from "./support/control-d1.js";
import { createControlStore } from "../src/store.js";
import { projectInput, seedOrganization } from "./support/seed.js";
import { newUlid } from "../src/catalog/common.js";
import { parseUlid } from "@ohmyhost/platform";
const AT = "2026-10-28T10:00:00.000000Z",
  STARTED = "2026-10-28T10:01:00.000000Z",
  FINISHED = "2026-10-28T10:01:00.001000Z",
  json = (rows: Record<string, unknown>[]) =>
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          key === "payload" && typeof value === "string" ? JSON.parse(value) : value,
        ]),
      ),
    );
it("answers the hello next-actions applied then duplicate and writes the exact operation, audit, managed-source and outbox handoff evidence with the Core guards enabled", async () => {
  const c = await createTestControl();
  try {
    const store = createControlStore(c.bindings);
    for (const terminal of ["succeeded", "failed", "reconciliation"] as const) {
      const org = await seedOrganization(store, 2, 0),
        p = projectInput(org, `pg-hello-${terminal}`),
        at = p.createdAt;
      p.outbox.eventType = "ProjectProvisioningRequested";
      p.outbox.payload = { projectId: p.projectId, operationId: p.operation.operationId };
      await store.projects.createInitialProject(p);
      const source = newUlid(),
        initializationEvent = newUlid(),
        stored = at.replace(/Z$/u, "000Z");
      await c.core
        .prepare(
          `INSERT INTO managed_source_initializations(organization_id,parent_operation_id,project_id,billing_epoch_id,source_connection_id,initialization_event_id,principal_id,template,region,request_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,'user:fixture','empty','eu','pg-fixture','waiting',?,?)`,
        )
        .bind(
          org,
          p.operation.operationId,
          p.projectId,
          p.billingEpochId,
          source,
          initializationEvent,
          stored,
          stored,
        )
        .run();
      const common = {
        organizationId: parseUlid(org),
        projectId: parseUlid(p.projectId),
        operationId: parseUlid(p.operation.operationId),
        requestEventId: parseUlid(p.outbox.eventId),
        workflowId: `project-provisioning-v1-${p.outbox.eventId}-${p.operation.operationId}`,
        serviceActorId: "project-provisioning-worker",
      };
      const steps = {
        started: {
          eventId: parseUlid(newUlid()),
          auditEventId: parseUlid(newUlid()),
          occurredAt: "2026-10-28T10:01:00.000Z",
        },
        succeeded: {
          eventId: parseUlid(newUlid()),
          auditEventId: parseUlid(newUlid()),
          occurredAt: "2026-10-28T10:01:00.001Z",
        },
      };
      const run = async () => {
        if (terminal === "succeeded")
          return store.provisioning.completeHello({ ...common, ...steps });
        if (terminal === "failed")
          return store.provisioning.failHello({
            ...common,
            started: steps.started,
            failed: steps.succeeded,
            failure: {
              code: "PROJECT_PROVISIONING_WORKFLOW_FAILED",
              message: "Project provisioning workflow failed",
            },
          });
        return store.provisioning.reconcileHello({
          ...common,
          auditEventId: steps.started.auditEventId,
          occurredAt: steps.started.occurredAt,
        });
      };
      expect(await run()).toBe("applied");
      expect(await run()).toBe("duplicate");
      const rows = async (table: string, columns: string, order: string, where = "") =>
        json(
          (
            await c.core
              .prepare(
                `SELECT ${columns} FROM ${table} WHERE organization_id=?1 AND ${table === "managed_source_initializations" ? "parent_operation_id" : "operation_id"}=?2 ${where} ORDER BY ${order}`,
              )
              .bind(org, p.operation.operationId)
              .all()
          ).results,
        );
      const operation = {
        operation_id: p.operation.operationId,
        project_id: p.projectId,
      };
      const queued = {
        event_id: p.operation.eventId,
        ...operation,
        event_type: "OperationQueued",
        revision: 0,
        idempotency_key: null,
        payload: {},
        occurred_at: AT,
      };
      const event = (
        type: string,
        revision: number,
        id: string,
        key: string,
        payload: object,
        at: string,
      ) => ({
        event_id: id,
        ...operation,
        event_type: type,
        revision,
        idempotency_key: `${common.workflowId}:${key}`,
        payload,
        occurred_at: at,
      });
      const audit = (type: string, id: string, state: string, at: string) => ({
        audit_event_id: id,
        project_id: p.projectId,
        operation_id: p.operation.operationId,
        event_type: type,
        actor_type: "service",
        actor_id: "project-provisioning-worker",
        payload: { state, trigger: "ProjectProvisioningRequested", workflowId: common.workflowId },
        occurred_at: at,
        billing_epoch_id: p.billingEpochId,
      });
      const outbox = (id: string, type: string, payload: object, at: string) => ({
        event_id: id,
        event_type: type,
        payload,
        created_at: at,
        initial_available_at: at,
        available_at: at,
        attempt_count: 0,
        max_attempts: 5,
        billing_epoch_id: p.billingEpochId,
      });
      const requested = outbox(
        p.outbox.eventId,
        "ProjectProvisioningRequested",
        { projectId: p.projectId, operationId: p.operation.operationId },
        AT,
      );
      const expected = {
        succeeded: {
          events: [
            queued,
            event("OperationStarted", 1, steps.started.eventId, "started", {}, STARTED),
            event("OperationSucceeded", 2, steps.succeeded.eventId, "succeeded", {}, FINISHED),
          ],
          audits: [
            audit("OperationStarted", steps.started.auditEventId, "running", STARTED),
            audit("OperationSucceeded", steps.succeeded.auditEventId, "succeeded", FINISHED),
          ],
          source: {
            state: "queued",
            error_code: null,
            child_operation_id: null,
            updated_at: FINISHED,
          },
          outbox: [
            requested,
            outbox(
              initializationEvent,
              "ManagedSourceInitializationRequestedV1",
              { environmentId: p.developmentEnvironmentId },
              FINISHED,
            ),
          ],
        },
        failed: {
          events: [
            queued,
            event("OperationStarted", 1, steps.started.eventId, "started", {}, STARTED),
            event(
              "OperationFailed",
              2,
              steps.succeeded.eventId,
              "failed",
              {
                failure: {
                  code: "PROJECT_PROVISIONING_WORKFLOW_FAILED",
                  message: "Project provisioning workflow failed",
                },
              },
              FINISHED,
            ),
          ],
          audits: [
            audit("OperationStarted", steps.started.auditEventId, "running", STARTED),
            audit("OperationFailed", steps.succeeded.auditEventId, "failed", FINISHED),
          ],
          source: {
            state: "failed",
            error_code: "PROJECT_CREATION_FAILED",
            child_operation_id: null,
            updated_at: FINISHED,
          },
          outbox: [requested],
        },
        reconciliation: {
          events: [queued],
          audits: [
            {
              audit_event_id: steps.started.auditEventId,
              project_id: p.projectId,
              operation_id: p.operation.operationId,
              event_type: "ProjectProvisioningReconciliationRequired",
              actor_type: "service",
              actor_id: "project-provisioning-worker",
              payload: {
                workflowId: common.workflowId,
                requestEventId: p.outbox.eventId,
                reasonCode: "WORKFLOW_OUTCOME_UNCERTAIN",
              },
              occurred_at: STARTED,
              billing_epoch_id: p.billingEpochId,
            },
          ],
          source: { state: "waiting", error_code: null, child_operation_id: null, updated_at: AT },
          outbox: [requested],
        },
      }[terminal];
      expect(
        await rows(
          "operation_events",
          "event_id,operation_id,project_id,event_type,revision,idempotency_key,payload,occurred_at",
          "revision",
        ),
        `${terminal} operation_events`,
      ).toEqual(expected.events);
      expect(
        await rows(
          "audit_events",
          "audit_event_id,project_id,operation_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id",
          "occurred_at",
          "AND event_type<>'ProjectCreated'",
        ),
        `${terminal} audit_events`,
      ).toEqual(expected.audits);
      expect(
        await rows(
          "managed_source_initializations",
          "state,error_code,child_operation_id,updated_at",
          "created_at",
        ),
        `${terminal} managed_source_initializations`,
      ).toEqual([expected.source]);
      expect(
        await rows(
          "outbox_events",
          "event_id,event_type,payload,created_at,initial_available_at,available_at,attempt_count,max_attempts,billing_epoch_id",
          "created_at",
        ),
        `${terminal} outbox_events`,
      ).toEqual(expected.outbox);
    }
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 60_000);
