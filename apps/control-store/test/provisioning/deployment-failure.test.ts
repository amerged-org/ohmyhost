import { createCoreDeploymentTerminalPort } from "../../../project-provisioning-worker/src/core-deployment-terminal.js";
import { completionCommon } from "../../../project-provisioning-worker/src/workflow-identities.js";
import { parseProductCommandMessageV1 } from "../../../orchestrator/src/product-command.js";
import { deterministicUlid } from "../../../project-provisioning-worker/src/deterministic-ulid.js";
import { recordRuntimeHealthDiagnostic } from "../../src/catalog/provisioning/health-diagnostic.js";
import { expect, it } from "vitest";
import { createTestControl } from "../support/control-d1.js";
import { accountOf, reserveBuild } from "../support/credit-fixtures.js";
import { beforeFirstWrite, losingWriteResponses } from "../support/platform-fixtures.js";
import { SharedCoreRouter } from "../../src/router.js";
import { newUlid } from "../../src/catalog/common.js";
import { workflowFixture } from "./workflow-fixture.js";
import { claimProductProviderMutation } from "../../src/catalog/provisioning/provider-claim.js";
import {
  deploymentFailureInput,
  failProductDeployment,
} from "../../src/catalog/provisioning/deployment-failure.js";
import type { z } from "zod";
const context = (db: Awaited<ReturnType<typeof createTestControl>>["core"]) => ({
  directory: db,
  router: new SharedCoreRouter(db),
});
function failure(
  r: Awaited<ReturnType<typeof workflowFixture>>,
  errorCode: z.infer<typeof deploymentFailureInput>["errorCode"] = "BUILD_NOT_STARTED",
) {
  return {
    workflowId: r.input.logicalWorkflowId,
    organizationId: r.input.organizationId,
    projectId: r.input.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
    outboxEventId: r.input.eventId,
    startedOperationEventId: newUlid(),
    operationEventId: newUlid(),
    auditEventId: newUlid(),
    actorId: "deployment-workflow" as const,
    errorCode,
    failedAt: new Date().toISOString(),
  };
}
function commandOf(r: Awaited<ReturnType<typeof workflowFixture>>) {
  const command = parseProductCommandMessageV1({
    version: 1,
    eventType: r.input.eventType,
    eventId: r.input.eventId,
    organizationId: r.input.organizationId,
    projectId: r.input.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
    billingEpochId: r.p.billingEpochId,
    planId: r.plan,
  });
  if (command.eventType !== "DeploymentRequestedV1")
    throw new Error("Fixture command kind differs");
  return command;
}
async function hold(
  db: Awaited<ReturnType<typeof createTestControl>>["core"],
  r: Awaited<ReturnType<typeof workflowFixture>>,
) {
  await reserveBuild(db, {
    organizationId: r.p.organizationId,
    projectId: r.p.projectId,
    operationId: r.accepted.operationId,
    amountMicros: 300000,
    now: "2026-10-28T11:00:00.000Z",
  });
}
const reservationOf = (
  db: Awaited<ReturnType<typeof createTestControl>>["core"],
  operationId: string,
) =>
  db
    .prepare("SELECT amount_micros FROM credit_reservation WHERE reservation_id=?")
    .bind(operationId)
    .first();
/** A running operation holds a lease that its terminal write must clear. */
const leaseOperation = (
  db: Awaited<ReturnType<typeof createTestControl>>["core"],
  operationId: string,
) =>
  db
    .prepare("UPDATE operations SET lease_expires_at=?2 WHERE operation_id=?1")
    .bind(operationId, "2999-01-01T00:00:00.000000Z")
    .run();
it("terminalizes run, deployment, history and diagnostic and releases an unstarted build reservation atomically, then observes lost replies under the same identity", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    await hold(c.core, r);
    await claimProductProviderMutation(context(c.core), r.input);
    await leaseOperation(c.core, r.input.operationId);
    const command = commandOf(r),
      clock = () => new Date("2026-10-29T04:00:00.000Z"),
      common = await completionCommon(
        r.input.logicalWorkflowId,
        r.input.logicalWorkflowId,
        command,
        clock,
      );
    const input = {
      ...failure(r),
      startedOperationEventId: common.startedOperationEventId,
      operationEventId: common.operationEventId,
      auditEventId: common.auditEventId,
      failedAt: common.completedAt,
    };
    const port = createCoreDeploymentTerminalPort(
      {
        failProductDeployment: (i) =>
          failProductDeployment(context(losingWriteResponses(c.core, 1)), i),
        recordRuntimeHealthDiagnostic: (i) => recordRuntimeHealthDiagnostic(context(c.core), i),
      },
      clock,
    );
    expect(
      await port.fail({
        workflowId: input.workflowId,
        executionId: input.workflowId,
        command,
        errorCode: input.errorCode,
      }),
    ).toBe("duplicate");

    expect(await failProductDeployment(context(c.core), input)).toBe("replayed");
    const failed = "2026-10-29T04:00:00.000000Z";
    expect(
      (
        await c.core
          .prepare(
            "SELECT event_id,event_type,revision,idempotency_key,payload,occurred_at FROM operation_events WHERE operation_id=? AND revision=2",
          )
          .bind(input.operationId)
          .all()
      ).results,
    ).toEqual([
      {
        event_id: input.operationEventId,
        event_type: "OperationFailed",
        revision: 2,
        idempotency_key: `${input.workflowId}:failed`,
        payload: JSON.stringify({
          failure: { code: "BUILD_NOT_STARTED", message: "The deployment could not be completed." },
        }),
        occurred_at: failed,
      },
    ]);
    expect(
      (
        await c.core
          .prepare(
            "SELECT audit_event_id,event_type,actor_type,actor_id,payload,occurred_at,billing_epoch_id FROM audit_events WHERE operation_id=? AND event_type='DeploymentRequestedV1Failed'",
          )
          .bind(input.operationId)
          .all()
      ).results,
    ).toEqual([
      {
        audit_event_id: input.auditEventId,
        event_type: "DeploymentRequestedV1Failed",
        actor_type: "system",
        actor_id: "deployment-workflow",
        payload: JSON.stringify({ code: "BUILD_NOT_STARTED" }),
        occurred_at: failed,
        billing_epoch_id: r.p.billingEpochId,
      },
    ]);
    expect(
      (
        await c.core
          .prepare(
            "SELECT state,terminal_evidence,active_reconciliation_attempt_id,completed_at FROM product_workflow_runs WHERE operation_id=?",
          )
          .bind(input.operationId)
          .all()
      ).results,
    ).toEqual([
      {
        state: "completed",
        terminal_evidence: '{"errorCode":"BUILD_NOT_STARTED"}',
        active_reconciliation_attempt_id: null,
        completed_at: failed,
      },
    ]);
    expect(
      (
        await c.core
          .prepare("SELECT status FROM deployments WHERE deployment_id=?")
          .bind(r.deployment)
          .all()
      ).results,
    ).toEqual([{ status: "failed" }]);
    expect(
      (
        await c.core
          .prepare(
            "SELECT diagnostic_event_id,code,catalog_message,source,excerpt,excerpt_truncated,status_code,occurred_at,recorded_at FROM deployment_diagnostics WHERE deployment_id=?",
          )
          .bind(r.deployment)
          .all()
      ).results,
    ).toEqual([
      {
        diagnostic_event_id: input.operationEventId,
        code: "BUILD_NOT_STARTED",
        catalog_message: "PLATFORM_BUILD_NOT_STARTED",
        source: "control",
        excerpt: null,
        excerpt_truncated: null,
        status_code: null,
        occurred_at: failed,
        recorded_at: failed,
      },
    ]);
    // An unstarted build is released without a charge: the reservation is gone and the account holds nothing.
    expect(await reservationOf(c.core, input.operationId)).toBeNull();
    expect(await accountOf(c.core, r.p.organizationId)).toMatchObject({ reserved_micros: 0 });
    expect(
      await c.core
        .prepare("SELECT kind,delta_micros FROM credit_log WHERE key=?")
        .bind(`release:${input.operationId}`)
        .first(),
    ).toEqual({ kind: "release", delta_micros: 0 });
    expect(
      await c.core
        .prepare("SELECT state,failure,lease_expires_at FROM operations WHERE operation_id=?")
        .bind(r.input.operationId)
        .first(),
    ).toEqual({
      state: "failed",
      failure: JSON.stringify({
        code: "BUILD_NOT_STARTED",
        message: "The deployment could not be completed.",
      }),
      lease_expires_at: null,
    });
    expect(
      await c.core
        .prepare("SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?")
        .bind(input.operationId)
        .first(),
    ).toEqual({ n: 0 });
    expect(
      (
        await c.core
          .prepare("SELECT event_type FROM operation_events WHERE operation_id=? ORDER BY revision")
          .bind(input.operationId)
          .all()
      ).results,
    ).toEqual([
      { event_type: "OperationQueued" },
      { event_type: "OperationStarted" },
      { event_type: "OperationFailed" },
    ]);
    expect(
      await c.core
        .prepare(
          "SELECT code,catalog_message FROM deployment_diagnostics WHERE diagnostic_event_id=?",
        )
        .bind(input.operationEventId)
        .first(),
    ).toEqual({ code: "BUILD_NOT_STARTED", catalog_message: "PLATFORM_BUILD_NOT_STARTED" });
    await expect(
      failProductDeployment(context(c.core), { ...input, errorCode: "BUILD_FAILED" }),
    ).rejects.toThrow();
    await expect(
      port.fail({
        workflowId: input.workflowId,
        executionId: input.workflowId,
        command,
        errorCode: "BUILD_FAILED",
      }),
    ).rejects.toMatchObject({ name: "DeploymentPersistenceConflictError" });
    const unknown = new Error("transport outcome unknown");
    const uncertain = createCoreDeploymentTerminalPort(
      {
        failProductDeployment: async () => {
          throw unknown;
        },
        recordRuntimeHealthDiagnostic: (i) => recordRuntimeHealthDiagnostic(context(c.core), i),
      },
      clock,
    );
    await expect(
      uncertain.fail({
        workflowId: input.workflowId,
        executionId: input.workflowId,
        command,
        errorCode: input.errorCode,
      }),
    ).rejects.toBe(unknown);
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  } finally {
    await c.dispose();
  }
}, 240_000);
it("rolls a late diagnostic failure back with the claim, operation, deployment and financial hold", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    await hold(c.core, r);
    await claimProductProviderMutation(context(c.core), r.input);
    const input = {
      ...failure(r, "BUILD_FAILED"),
      failure: { excerpt: "fixture output", truncated: false },
    };
    await c.core
      .prepare(
        "CREATE TRIGGER terminal_diagnostic_failure BEFORE INSERT ON deployment_diagnostics BEGIN SELECT RAISE(ABORT,'late diagnostic'); END",
      )
      .run();
    await expect(failProductDeployment(context(c.core), input)).rejects.toThrow("late diagnostic");
    expect(
      await c.core
        .prepare("SELECT state FROM operations WHERE operation_id=?")
        .bind(input.operationId)
        .first(),
    ).toEqual({ state: "running" });
    expect(
      await c.core
        .prepare("SELECT count(*) n FROM product_provider_mutation_claims WHERE operation_id=?")
        .bind(input.operationId)
        .first(),
    ).toEqual({ n: 1 });
    expect(await reservationOf(c.core, input.operationId)).toEqual({ amount_micros: 300000 });
    expect(await accountOf(c.core, r.p.organizationId)).toMatchObject({ reserved_micros: 300000 });
    await c.core.prepare("DROP TRIGGER terminal_diagnostic_failure").run();
    expect(await failProductDeployment(context(c.core), input)).toBe("failed");
    const migration = await workflowFixture(c);
    await claimProductProviderMutation(context(c.core), migration.input);
    expect(
      await failProductDeployment(context(c.core), {
        ...failure(migration, "DATABASE_MIGRATION_FAILED"),
        migration: {
          reason: "execution_failed",
          path: "db/20261028110000_expand.sql",
          statementIndex: 2,
          sqlstate: "42P01",
        },
      }),
    ).toBe("failed");
    const stored = await c.core
      .prepare(
        "SELECT json_extract(failure,'$.diagnostic') diagnostic FROM operations WHERE organization_id=?1 AND operation_id=?2",
      )
      .bind(migration.input.organizationId, migration.input.operationId)
      .first<{ diagnostic: string }>();
    if (!stored) throw new Error("Missing migration failure");
    expect(JSON.parse(stored.diagnostic)).toEqual({
      reason: "execution_failed",
      file: "db/20261028110000_expand.sql",
      statement_index: 2,
      sqlstate: "42P01",
    });
    const event = await c.core
      .prepare(
        "SELECT payload FROM operation_events WHERE organization_id=?1 AND operation_id=?2 AND event_type='OperationFailed'",
      )
      .bind(migration.input.organizationId, migration.input.operationId)
      .first<{ payload: string }>();
    if (!event) throw new Error("Missing migration failure event");
    expect(Object.keys(JSON.parse(event.payload).failure).sort()).toEqual(["code", "message"]);
    for (const detail of [
      { reason: "catalog_changed", path: null, statementIndex: 1 },
      { reason: "execution_failed", path: null, statementIndex: 1 },
      { reason: "execution_failed", path: "db/20261028110000_expand.sql", sqlstate: "42P01" },
      { reason: "execution_failed", path: "db/20261028110000_expand.sql", statementIndex: 2 },
      {
        reason: "execution_failed",
        path: "db/20261028110000_expand.sql",
        statementIndex: 2,
        sqlstate: "08007",
      },
      {
        reason: "execution_failed",
        path: "db/20261028110000_expand.sql",
        statementIndex: 2,
        sqlstate: "57P01",
      },
    ]) {
      expect(() =>
        deploymentFailureInput.parse({
          ...failure(migration, "DATABASE_MIGRATION_FAILED"),
          migration: detail,
        }),
      ).toThrow();
    }
  } finally {
    await c.dispose();
  }
}, 60_000);
it("retains the original runtime health verdict when it wins a race before terminal failure, and never releases an uncertain build", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    await hold(c.core, r);
    await claimProductProviderMutation(context(c.core), r.input);
    await r.store.build.claimBuildInput({
      scope: {
        projectId: r.p.projectId,
        environmentId: r.input.environmentId,
        operationId: r.input.operationId,
      },
      inputFingerprint: `sha256:${"ab".repeat(32)}`,
      claimId: crypto.randomUUID(),
      leaseMilliseconds: 30000,
    });
    const input = failure(r, "RUNTIME_CANDIDATE_FAILED"),
      id = await deterministicUlid(`${r.input.logicalWorkflowId}:runtime-health-diagnostic`),
      at = input.failedAt;
    const race = beforeFirstWrite(c.core, async () => {
      const healthInput = {
        workflowId: r.input.logicalWorkflowId,
        organizationId: r.p.organizationId,
        projectId: r.p.projectId,
        environmentId: r.input.environmentId,
        operationId: r.input.operationId,
        outboxEventId: r.input.eventId,
        diagnosticEventId: id,
        health: { status: 503, path: "/", excerpt: null, truncated: false },
        recordedAt: at,
      };
      expect(await recordRuntimeHealthDiagnostic(context(c.core), healthInput)).toBe("created");
      const healthPort = createCoreDeploymentTerminalPort(
        {
          failProductDeployment: (i) => failProductDeployment(context(c.core), i),
          recordRuntimeHealthDiagnostic: (i) =>
            recordRuntimeHealthDiagnostic(context(losingWriteResponses(c.core, 1)), i),
        },
        () => new Date(at),
      );
      expect(
        await healthPort.recordHealthFailure({
          workflowId: r.input.logicalWorkflowId,
          executionId: r.input.logicalWorkflowId,
          command: commandOf(r),
          health: healthInput.health,
        }),
      ).toBe("duplicate");
      expect(
        await recordRuntimeHealthDiagnostic(context(c.core), {
          ...healthInput,
          recordedAt: new Date(Date.parse(at) + 1000).toISOString(),
        }),
      ).toBe("existing");
      await expect(
        recordRuntimeHealthDiagnostic(context(c.core), {
          ...healthInput,
          health: { ...healthInput.health, status: 502 },
        }),
      ).rejects.toThrow("changed");
    });
    expect(await failProductDeployment(context(race), input)).toBe("failed");
    await expect(
      recordRuntimeHealthDiagnostic(context(c.core), {
        workflowId: r.input.logicalWorkflowId,
        organizationId: r.p.organizationId,
        projectId: r.p.projectId,
        environmentId: r.input.environmentId,
        operationId: r.input.operationId,
        outboxEventId: r.input.eventId,
        diagnosticEventId: id,
        health: { status: 503, path: "/", excerpt: null, truncated: false },
        recordedAt: at,
      }),
    ).rejects.toThrow("scope changed");
    expect(
      (
        await c.core
          .prepare("SELECT code FROM deployment_diagnostics WHERE deployment_id=?")
          .bind(r.deployment)
          .all()
      ).results,
    ).toEqual([{ code: "HEALTH_CHECK_FAILED" }]);
    expect(await reservationOf(c.core, input.operationId)).toEqual({ amount_micros: 300000 });
  } finally {
    await c.dispose();
  }
}, 240_000);
