import { expect, it } from "vitest";
import { parseUlid } from "@ohmyhost/platform";
import type { PrepareProductProviderReconciliationInput } from "@ohmyhost/database";
import { SharedCoreRouter } from "../../src/router.js";
import { newUlid } from "../../src/catalog/common.js";
import { claimProductProviderMutation } from "../../src/catalog/provisioning/provider-claim.js";
import * as Core from "../../src/catalog/provisioning/provider-reconciliation.js";
import { activateProductProviderReconciliationAttempt } from "../../src/catalog/provisioning/attempt-activation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import { losingWriteResponses, beforeFirstWrite } from "../support/platform-fixtures.js";
import { workflowFixture } from "./workflow-fixture.js";
import { leaseOperation } from "../support/accepted-operation.js";
import type { D1Database } from "../../src/d1-types.js";

const context = (db: D1Database) => ({ directory: db, router: new SharedCoreRouter(db) });
const id = () => parseUlid(newUlid());
/** The Workflow of an accepted deployment stopped at an uncertain source observation: run and deployment need reconciliation. */
async function stopUncertain(c: TestControl, r: Awaited<ReturnType<typeof workflowFixture>>) {
  const at = "2026-10-28T11:00:10.000000Z";
  await c.core.batch([
    c.core
      .prepare(
        `UPDATE product_workflow_runs SET state='reconciliation_required',reconciliation_code='SOURCE_UNCERTAIN',intermediate_evidence='{"providerReconciliationHint": {"phase": "source"}}',updated_at=?2 WHERE workflow_id=?1`,
      )
      .bind(r.input.logicalWorkflowId, at),
    c.core
      .prepare(
        `UPDATE deployments SET status='reconciliation_required',updated_at=?2 WHERE deployment_id=?1`,
      )
      .bind(r.deployment, at),
  ]);
}

it("reads the provider context, replays lost prepare replies, recovers physical terminal attempts and abandons on confirmed absence", async () => {
  const c = await createTestControl();
  try {
    const r = await workflowFixture(c);
    const scope = {
        organizationId: parseUlid(r.input.organizationId),
        projectId: parseUlid(r.input.projectId),
        environmentId: parseUlid(r.input.environmentId),
        operationId: parseUlid(r.input.operationId),
        claimId: parseUlid(r.input.claimId),
      },
      claim = { ...r.input, ...scope, eventId: parseUlid(r.input.eventId) };
    const original = {
      version: 1,
      eventType: "DeploymentRequestedV1",
      eventId: r.input.eventId,
      organizationId: r.input.organizationId,
      projectId: r.input.projectId,
      billingEpochId: r.p.billingEpochId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      planId: r.plan,
    };
    expect(
      await Core.findProductProviderReconciliationClaim(context(c.core), scopeFind(scope)),
    ).toBeNull();
    expect(await claimProductProviderMutation(context(c.core), claim)).toBe("created");
    await stopUncertain(c, r);
    expect(await Core.readProductProviderReconciliationContext(context(c.core), scope)).toEqual({
      claimId: r.input.claimId,
      organizationId: r.input.organizationId,
      projectId: r.input.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      handle: r.p.projectHandle,
      environmentName: "dev",
      eventId: r.input.eventId,
      billingEpochId: r.p.billingEpochId,
      logicalWorkflowId: r.input.logicalWorkflowId,
      eventType: "DeploymentRequestedV1",
      acceptedLifecycleVersion: 1,
      originalMessage: original,
      knownDeployments: [],
      hasActiveGateway: false,
      wfpTarget: null,
      retainedWfpTarget: null,
      providerHint: { phase: "source" },
      sourceState: "absent",
      buildState: "absent",
    });
    expect(
      await Core.findProductProviderReconciliationClaim(context(c.core), scopeFind(scope)),
    ).toEqual({
      organizationId: r.input.organizationId,
      projectId: r.input.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      claimId: r.input.claimId,
      eventId: r.input.eventId,
      logicalWorkflowId: r.input.logicalWorkflowId,
      workflowState: "reconciliation_required",
      providerPhase: "source",
    });
    expect(
      await Core.findClaimlessProductProviderReconciliationCandidate(
        context(c.core),
        scopeFind(scope),
      ),
    ).toBeNull();
    const prepare = (
      mode: "retry" | "abandon",
      at: string,
      absent = false,
    ): PrepareProductProviderReconciliationInput => ({
      ...scope,
      attemptId: id(),
      observationId: id(),
      eventId: claim.eventId,
      logicalWorkflowId: claim.logicalWorkflowId,
      physicalWorkflowId: `provider-reconcile-v1-${newUlid()}`,
      mode,
      idempotencyDigest: new Uint8Array(32).fill(Number(at.slice(17, 19))),
      evidenceDigest: new Uint8Array(32).fill(9),
      gateway: { state: absent ? "absent" : "unknown", ...(absent ? { observedAt: at } : {}) },
      wfp: { state: absent ? "absent" : "unknown", ...(absent ? { observedAt: at } : {}) },
      actorId: "workflow-fixture",
      startedOperationEventId: id(),
      operationEventId: id(),
      auditEventId: id(),
      preparedAt: at,
    });
    const first = prepare("retry", "2026-10-28T11:00:11.000Z");
    const prepared = (input: PrepareProductProviderReconciliationInput) => ({
      outcome: "prepared",
      attemptId: input.attemptId,
      physicalWorkflowId: input.physicalWorkflowId,
      originalMessage: original,
    });
    const expected = prepared(first);
    expect(
      await Core.prepareProductProviderReconciliation(
        context(losingWriteResponses(c.core, 1)),
        first,
      ),
    ).toEqual(expected);
    expect(await Core.prepareProductProviderReconciliation(context(c.core), first)).toEqual(
      expected,
    );
    const read = {
      ...scopeFind(scope),
      attemptId: first.attemptId,
      actorId: first.actorId,
      idempotencyDigest: first.idempotencyDigest,
    };
    expect(await Core.readProductProviderReconciliationAttempt(context(c.core), read)).toEqual({
      ...expected,
      claimId: r.input.claimId,
    });
    await expect(
      Core.prepareProductProviderReconciliation(context(c.core), {
        ...first,
        physicalWorkflowId: "foreign",
      }),
    ).rejects.toThrow("replay changed");
    const recover = (input: PrepareProductProviderReconciliationInput, at: string) => ({
      ...scopeFind(scope),
      attemptId: input.attemptId,
      observationId: id(),
      auditEventId: id(),
      physicalWorkflowId: input.physicalWorkflowId,
      actorId: input.actorId,
      terminalStatus: "errored" as const,
      evidenceDigest: new Uint8Array(32).fill(7),
      recoveredAt: at,
    });
    const before = recover(first, "2026-10-28T11:00:12.000Z");
    expect(
      await Core.recoverTerminalProductProviderReconciliationAttempt(context(c.core), before),
    ).toBe("recovered");
    expect(
      await Core.recoverTerminalProductProviderReconciliationAttempt(context(c.core), before),
    ).toBe("existing");
    const second = prepare("retry", "2026-10-28T11:00:13.000Z");
    expect(await Core.prepareProductProviderReconciliation(context(c.core), second)).toEqual(
      prepared(second),
    );
    expect(
      await activateProductProviderReconciliationAttempt(context(c.core), {
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        operationId: scope.operationId,
        eventId: claim.eventId,
        eventType: "DeploymentRequestedV1",
        attemptId: second.attemptId,
        physicalWorkflowId: second.physicalWorkflowId,
      }),
    ).toBe("activated");
    const after = recover(second, "2026-10-28T11:00:14.000Z");
    expect(
      await Core.recoverTerminalProductProviderReconciliationAttempt(context(c.core), after),
    ).toBe("recovered");
    const absent = prepare("abandon", "2026-10-28T11:00:20.000Z", true);
    expect(await Core.prepareProductProviderReconciliation(context(c.core), absent)).toEqual({
      outcome: "unknown",
      attemptId: absent.attemptId,
    });
    const stable = prepare("abandon", "2026-10-28T11:00:26.000Z", true);
    // A Native Auth database create dispatched for this operation has an unknown outcome: the abandonment refuses it.
    await c.core
      .prepare(
        "INSERT INTO native_auth_database_operations(organization_id,project_id,environment_id,operation_id,claim_id,provider_project_id,name,region_id,size_class_id,idempotency_key,state,dispatched_at) VALUES(?1,?2,?3,?4,?5,'provider','name','eu-dev','r256-s500m','unresolved-create','dispatched','2026-10-28T11:00:21.000000Z')",
      )
      .bind(
        scope.organizationId,
        scope.projectId,
        scope.environmentId,
        scope.operationId,
        r.input.claimId,
      )
      .run();
    await expect(
      Core.prepareProductProviderReconciliation(context(c.core), stable),
    ).rejects.toThrow("Native Auth database create is unresolved");
    await c.core
      .prepare("DELETE FROM native_auth_database_operations WHERE operation_id=?1")
      .bind(scope.operationId)
      .run();
    // The running reconciliation Workflow holds the operation's lease when it abandons the attempt.
    await leaseOperation(c.core, scope.operationId);
    for (let replay = 0; replay < 2; replay++)
      expect(await Core.prepareProductProviderReconciliation(context(c.core), stable)).toEqual({
        outcome: "resolved_absent",
        attemptId: stable.attemptId,
      });
    expect(await Core.readProductProviderReconciliationAttempt(context(c.core), read)).toEqual({
      outcome: "completed",
      attemptId: first.attemptId,
    });
    expect(await Core.readProductProviderReconciliationContext(context(c.core), scope)).toBeNull();
    expect(
      await Core.findProductProviderReconciliationClaim(context(c.core), scopeFind(scope)),
    ).toBeNull();
    expect(
      await c.core
        .prepare(
          "SELECT state,failure,lease_expires_at FROM operations WHERE organization_id=?1 AND operation_id=?2",
        )
        .bind(scope.organizationId, scope.operationId)
        .first(),
    ).toEqual({
      state: "failed",
      failure:
        '{"code": "provider_state_absent", "message": "The deployment could not be completed."}',
      lease_expires_at: null,
    });
    expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const fresh = await workflowFixture(c);
    await claimProductProviderMutation(context(c.core), fresh.input);
    await c.core.batch([
      c.core
        .prepare(
          `UPDATE product_workflow_runs SET state='reconciliation_required',intermediate_evidence='{"providerReconciliationHint":{"phase":"source"}}' WHERE workflow_id=?1`,
        )
        .bind(fresh.input.logicalWorkflowId),
      c.core
        .prepare(`UPDATE deployments SET status='reconciliation_required' WHERE deployment_id=?1`)
        .bind(fresh.deployment),
    ]);
    const racing = {
      ...first,
      claimId: fresh.input.claimId,
      organizationId: fresh.input.organizationId,
      projectId: fresh.input.projectId,
      environmentId: fresh.input.environmentId,
      operationId: fresh.input.operationId,
      eventId: fresh.input.eventId,
      logicalWorkflowId: fresh.input.logicalWorkflowId,
      attemptId: id(),
      observationId: id(),
      idempotencyDigest: new Uint8Array(32).fill(8),
      physicalWorkflowId: "racing-fixture",
      startedOperationEventId: id(),
      operationEventId: id(),
      auditEventId: id(),
    };
    const boundary = beforeFirstWrite(c.core, async () => {
      await c.core
        .prepare("UPDATE projects SET lifecycle_version=lifecycle_version+1 WHERE project_id=?1")
        .bind(fresh.p.projectId)
        .run();
    });
    await expect(
      Core.prepareProductProviderReconciliation(context(boundary), racing),
    ).rejects.toThrow("scope changed");
    expect(
      await c.core
        .prepare(
          "SELECT count(*) count FROM product_provider_reconciliation_attempts WHERE attempt_id=?1",
        )
        .bind(racing.attemptId)
        .first(),
    ).toEqual({ count: 0 });
  } finally {
    await c.dispose();
  }
}, 60_000);
function scopeFind(input: {
  organizationId: ReturnType<typeof parseUlid>;
  operationId: ReturnType<typeof parseUlid>;
}) {
  return { organizationId: input.organizationId, operationId: input.operationId };
}
