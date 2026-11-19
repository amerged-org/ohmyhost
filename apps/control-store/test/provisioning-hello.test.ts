import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlStore } from "../src/store.js";
import { newUlid } from "../src/catalog/common.js";
import { createTestControl, losingNthResponse, type TestControl } from "./support/control-d1.js";
import { projectInput, seedOrganization } from "./support/seed.js";
let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());
async function fixture(handle: string) {
  const store = createControlStore(control.bindings);
  const org = await seedOrganization(store, 2, 0);
  const p = projectInput(org, handle);
  p.outbox.eventType = "ProjectProvisioningRequested";
  await store.projects.createInitialProject(p);
  return {
    store,
    p,
    input: {
      organizationId: org,
      projectId: p.projectId,
      operationId: p.operation.operationId,
      requestEventId: p.outbox.eventId,
      workflowId: `project-provisioning-v1-${p.outbox.eventId}-${p.operation.operationId}`,
      serviceActorId: "project-provisioning-worker",
      started: {
        eventId: newUlid(),
        auditEventId: newUlid(),
        occurredAt: "2026-10-28T10:01:00.000Z",
      },
      succeeded: {
        eventId: newUlid(),
        auditEventId: newUlid(),
        occurredAt: "2026-10-28T10:01:00.001Z",
      },
    },
  };
}
it("commits original two-transition hello history and audits atomically, replays lost replies and refuses foreign/changed terminal provenance", async () => {
  const { store, p, input } = await fixture("provision-hello");
  // Losing a write response is resolved under the same immutable event/Workflow identity.
  const lossy = createControlStore({ CONTROL_CORE: losingNthResponse(control.core, 3) });
  expect(await lossy.provisioning.completeHello(input)).toBe("duplicate");
  expect(
    await store.provisioning.completeHello({
      ...input,
      started: { ...input.started, eventId: newUlid() },
      succeeded: { ...input.succeeded, eventId: newUlid() },
    }),
  ).toBe("duplicate");
  const op = await store.operations.loadOperation({
    organizationId: p.organizationId,
    operationId: p.operation.operationId,
  });
  expect(op?.state).toBe("succeeded");
  expect(op?.events.map((e) => [e.type, e.idempotencyKey])).toEqual([
    ["OperationQueued", null],
    ["OperationStarted", `${input.workflowId}:started`],
    ["OperationSucceeded", `${input.workflowId}:succeeded`],
  ]);
  await expect(
    store.provisioning.completeHello({
      ...input,
      organizationId: await seedOrganization(store, 2, 1),
    }),
  ).rejects.toThrow();
  await expect(
    store.provisioning.completeHello({ ...input, serviceActorId: "another" }),
  ).rejects.toThrow();
  await expect(
    store.provisioning.completeHello({ ...input, workflowId: "other" }),
  ).rejects.toThrow();
  await expect(
    store.provisioning.failHello({
      ...input,
      succeeded: undefined,
      failed: input.succeeded,
      failure: { code: "FAILED", message: "Failed" },
    }),
  ).rejects.toThrow();
});
it("rolls a late audit error back with both operation events and supports exact failure and uncertain-outcome audits", async () => {
  const { store, p, input } = await fixture("provision-failure");
  await control.core
    .prepare(
      `CREATE TRIGGER reject_provisioning_audit BEFORE INSERT ON audit_events WHEN NEW.event_type='OperationSucceeded' BEGIN SELECT RAISE(ABORT,'late audit error'); END`,
    )
    .run();
  await expect(store.provisioning.completeHello(input)).rejects.toThrow("late audit error");
  expect(
    (
      await store.operations.loadOperation({
        organizationId: p.organizationId,
        operationId: p.operation.operationId,
      })
    )?.state,
  ).toBe("queued");
  await control.core.prepare("DROP TRIGGER reject_provisioning_audit").run();
  const { succeeded, ...common } = input;
  const reconciliation = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    operationId: input.operationId,
    requestEventId: input.requestEventId,
    workflowId: input.workflowId,
    serviceActorId: input.serviceActorId,
    auditEventId: newUlid(),
    occurredAt: input.started.occurredAt,
  };
  expect(await store.provisioning.reconcileHello(reconciliation)).toBe("applied");
  expect(
    await store.provisioning.reconcileHello({ ...reconciliation, auditEventId: newUlid() }),
  ).toBe("duplicate");
  expect(
    await store.provisioning.failHello({
      ...common,
      failed: succeeded,
      failure: {
        code: "PROJECT_PROVISIONING_WORKFLOW_FAILED",
        message: "Project provisioning workflow failed",
      },
    }),
  ).toBe("applied");
  expect(
    await store.provisioning.failHello({
      ...common,
      failed: succeeded,
      failure: {
        code: "PROJECT_PROVISIONING_WORKFLOW_FAILED",
        message: "Project provisioning workflow failed",
      },
    }),
  ).toBe("duplicate");
  await expect(store.provisioning.completeHello(input)).rejects.toThrow();
});

it("preserves populated accepted Workflow bytes through0450 and rolls a late migration failure back with native FKs enabled", async () => {
  const { Miniflare } = await import("miniflare");
  const { migrationFiles, activateTestCore, createCreditAccountTable } = await import(
    "./support/control-d1.js"
  );
  const { splitStatements } = await import("./support/sql.js");
  const { guard } = await import("../src/guards.js");
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('fixture')}}",
    d1Databases: { CONTROL_CORE: "prior-workflow" },
  });
  try {
    const db = (await runtime.getD1Database("CONTROL_CORE")) as unknown as TestControl["core"];
    const next = migrationFiles("core").find(
      (f) => f.name === "0450_original_workflow_identity.sql",
    );
    if (!next) throw new Error("0450 migration missing");
    for (const file of migrationFiles("core").filter((f) => f.name < next.name))
      await db.batch(splitStatements(file.sql).map((sql) => db.prepare(sql)));
    // Project creation reads the handle quarantine that migration 0690 adds; the fixture applies it as setup only.
    const releases = migrationFiles("core").find(
      (f) => f.name === "0690_project_handle_releases.sql",
    );
    if (!releases) throw new Error("0690 migration missing");
    await db.batch(splitStatements(releases.sql).map((sql) => db.prepare(sql)));
    await activateTestCore(db);
    await createCreditAccountTable(db);
    const store = createControlStore({ CONTROL_CORE: db }),
      org = await seedOrganization(store, 2, 0),
      p = projectInput(org, "prior-workflow");
    p.outbox.eventType = "SourceLinkRequestedV1";
    p.outbox.payload = { environmentId: p.developmentEnvironmentId };
    await store.projects.createInitialProject(p);
    const workflow = newUlid(),
      stamp = p.createdAt.replace(/Z$/u, "000Z");
    await db
      .prepare(
        `INSERT INTO product_command_intents(organization_id,project_id,environment_id,operation_id,billing_epoch_id,event_type,installation_id,repository_owner,repository_name,created_at) VALUES(?,?,?,?,?,'SourceLinkRequestedV1','7','fixture-owner','fixture-repo',?)`,
      )
      .bind(
        org,
        p.projectId,
        p.developmentEnvironmentId,
        p.operation.operationId,
        p.billingEpochId,
        stamp,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO product_workflow_runs(organization_id,operation_id,event_type,workflow_id,event_id,project_id,environment_id,billing_epoch_id,state,terminal_evidence,intermediate_evidence,created_at,updated_at,completed_at) VALUES(?,?,'SourceLinkRequestedV1',?,?,?,?,?,'completed','{"opaque": ["ß", null, 1]}','{"original":true}',?,?,?)`,
      )
      .bind(
        org,
        p.operation.operationId,
        workflow,
        p.outbox.eventId,
        p.projectId,
        p.developmentEnvironmentId,
        p.billingEpochId,
        stamp,
        stamp,
        stamp,
      )
      .run();
    const before = await db.prepare("SELECT * FROM product_workflow_runs").all();
    await expect(
      db.batch([
        ...splitStatements(next.sql).map((sql) => db.prepare(sql)),
        guard(db, "precondition_changed", "1"),
      ]),
    ).rejects.toThrow("guard_precondition_changed");
    expect((await db.prepare("SELECT * FROM product_workflow_runs").all()).results).toEqual(
      before.results,
    );
    expect(
      await db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name GLOB '*0450*'").first(),
    ).toEqual({ n: 0 });
    await db.batch(splitStatements(next.sql).map((sql) => db.prepare(sql)));
    expect((await db.prepare("SELECT * FROM product_workflow_runs").all()).results).toEqual(
      before.results,
    );
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(
      db
        .prepare("UPDATE product_workflow_runs SET environment_id=? WHERE workflow_id=?")
        .bind(p.productionEnvironmentId, workflow)
        .run(),
    ).rejects.toThrow("FOREIGN KEY");
  } finally {
    await runtime.dispose();
  }
});
