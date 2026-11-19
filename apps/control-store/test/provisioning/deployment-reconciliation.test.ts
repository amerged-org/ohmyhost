import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SharedCoreRouter } from "../../src/router.js";
import { newUlid } from "../../src/catalog/common.js";
import { ProductWorkflowContextConflictError } from "../../src/catalog/provisioning/context.js";
import { reconcileProductWorkflow } from "../../src/catalog/provisioning/deployment-reconciliation.js";
import { reconcileRecoveredProductWorkflow } from "../../src/catalog/provisioning/recovered-workflow-reconciliation.js";
import { createTestControl, type TestControl } from "../support/control-d1.js";
import {
  losingWriteResponses,
  seedProject,
  type SeededProject,
} from "../support/platform-fixtures.js";
import { seedAcceptedOperation, type AcceptedOperation } from "../support/accepted-operation.js";
import type { D1Database } from "../../src/d1-types.js";

let control: TestControl;
beforeAll(async () => {
  control = await createTestControl();
});
afterAll(async () => control.dispose());

const context = (db: D1Database) => ({ directory: db, router: new SharedCoreRouter(db) });
const AT = "2026-10-28T12:00:00.000Z";
const first = async <T>(sql: string, ...values: unknown[]) =>
  control.core
    .prepare(sql)
    .bind(...values)
    .first<T>();

function scopeInput(p: SeededProject, op: AcceptedOperation) {
  return {
    workflowId: op.workflowId,
    organizationId: p.organizationId,
    projectId: p.projectId,
    environmentId: p.devEnvironmentId,
    operationId: op.operationId,
    outboxEventId: op.eventId,
    auditEventId: newUlid(),
    reconciledAt: AT,
  };
}
function reconcileInput<Extra extends Record<string, unknown>>(
  p: SeededProject,
  op: AcceptedOperation,
  extra: Extra,
) {
  return { ...scopeInput(p, op), bindingsOutdated: false, ...extra };
}

const evidence = () => ({
  observationId: newUlid(),
  evidenceDigest: new Uint8Array(32).fill(1),
  hint: {
    phase: "gateway" as const,
    expectedArtifactDigest: `sha256:${"ab".repeat(32)}`,
    currentProviderTag: "tag-1",
    currentProductDeploymentId: newUlid(),
    activationRuntimePolicy: {
      healthCheckPath: "/health",
      egressAllowedOrigins: ["https://a.example", "https://b.example"],
    },
  },
});

describe("provider mutation Workflow", () => {
  it("records the uncertain outcome with its immutable observation in one batch, replays it and observes a lost reply", async () => {
    const p = await seedProject(control);
    const op = await seedAcceptedOperation(p, p.devEnvironmentId);
    const input = reconcileInput(p, op, { providerReconciliation: evidence() });

    // the batch commits, its response is lost: the lookup recognizes the exact stored outcome
    expect(
      await reconcileProductWorkflow(context(losingWriteResponses(control.core, 1)), input),
    ).toBe("replayed");
    expect(await reconcileProductWorkflow(context(control.core), input)).toBe("replayed");

    const run = await first<Record<string, unknown>>(
      "SELECT state,reconciliation_code,active_reconciliation_attempt_id,active_replay_attempt_id,intermediate_evidence FROM product_workflow_runs WHERE workflow_id=?",
      op.workflowId,
    );
    expect(run).toMatchObject({
      state: "reconciliation_required",
      reconciliation_code: "PROVIDER_OBSERVATION_UNCERTAIN",
      active_reconciliation_attempt_id: null,
      active_replay_attempt_id: null,
    });
    expect(JSON.parse(String(run?.["intermediate_evidence"]))).toEqual({
      providerReconciliationHint: input.providerReconciliation.hint,
    });
    expect(
      await first("SELECT status FROM deployments WHERE deployment_id=?", op.intent.deployment_id),
    ).toEqual({ status: "reconciliation_required" });
    expect(
      await first(
        "SELECT observation_kind,hint_phase,hint_provider_tag,source_state,actor_id,created_at FROM product_provider_mutation_observations WHERE observation_id=?",
        input.providerReconciliation.observationId,
      ),
    ).toEqual({
      observation_kind: "uncertainty",
      hint_phase: "gateway",
      hint_provider_tag: "tag-1",
      source_state: "unknown",
      actor_id: "deployment-workflow",
      created_at: "2026-10-28T12:00:00.000000Z",
    });
    expect(
      await first(
        "SELECT event_type,actor_id FROM audit_events WHERE audit_event_id=?",
        input.auditEventId,
      ),
    ).toEqual({
      event_type: "ProductWorkflowReconciliationRequired",
      actor_id: "deployment-workflow",
    });

    // a different outcome for the already reconciled run is not a replay and is refused
    await expect(
      reconcileProductWorkflow(context(control.core), {
        ...input,
        auditEventId: newUlid(),
        providerReconciliation: evidence(),
      }),
    ).rejects.toThrow("Product Workflow attempt is still active");
    // an unknown run is refused before anything is written
    await expect(
      reconcileProductWorkflow(context(control.core), { ...input, workflowId: "unknown-workflow" }),
    ).rejects.toBeInstanceOf(ProductWorkflowContextConflictError);
  });

  it("requires provider evidence for a provider mutation, forbids it elsewhere and records an outdated candidate diagnostic", async () => {
    const p = await seedProject(control);
    const deploy = await seedAcceptedOperation(p, p.devEnvironmentId);
    await expect(
      reconcileProductWorkflow(context(control.core), reconcileInput(p, deploy, {})),
    ).rejects.toThrow("Provider reconciliation evidence is required");
    await expect(
      reconcileProductWorkflow(
        context(control.core),
        reconcileInput(p, deploy, { providerReconciliation: evidence(), bindingsOutdated: true }),
      ),
    ).rejects.toThrow("Provider reconciliation reason is invalid");
    await expect(
      reconcileProductWorkflow(
        context(control.core),
        reconcileInput(p, deploy, {
          providerReconciliation: {
            ...evidence(),
            hint: {
              phase: "source",
              activationRuntimePolicy: evidence().hint.activationRuntimePolicy,
            },
          },
        }),
      ),
    ).rejects.toThrow();

    const diagnosticId = newUlid();
    expect(
      await reconcileProductWorkflow(
        context(control.core),
        reconcileInput(p, deploy, {
          providerReconciliation: evidence(),
          bindingsOutdated: true,
          diagnosticId,
        }),
      ),
    ).toBe("reconciliation_required");
    expect(
      await first(
        "SELECT code,catalog_message,deployment_id FROM deployment_diagnostics WHERE diagnostic_event_id=?",
        diagnosticId,
      ),
    ).toEqual({
      code: "WFP_CANDIDATE_OUTDATED",
      catalog_message: "FINISH_CANDIDATE_RECONCILIATION_THEN_REDEPLOY_CURRENT_SOURCE",
      deployment_id: deploy.intent.deployment_id,
    });
  });
});

describe("non-provider Workflow recovery", () => {
  it("reconciles a deletion run and its cleanup run under the recovery authority and refuses provider evidence", async () => {
    const p = await seedProject(control);
    const op = await seedAcceptedOperation(p, p.devEnvironmentId, {
      eventType: "ProjectDeletionRequestedV1",
      claim: false,
    });
    const recovered = (extra: Record<string, unknown> = {}) => {
      return {
        ...scopeInput(p, op),
        actorId: "workflow-recovery",
        errorCode: "WORKFLOW_TERMINAL_BEFORE_RECONCILIATION",
        ...extra,
      };
    };
    // the recovery caller fixes both authority and code: neither can be chosen freely (the schema is checked synchronously)
    expect(() =>
      reconcileRecoveredProductWorkflow(context(control.core), recovered({ errorCode: "OTHER" })),
    ).toThrow();
    expect(() =>
      reconcileRecoveredProductWorkflow(context(control.core), recovered({ attemptId: newUlid() })),
    ).toThrow();
    await expect(
      reconcileRecoveredProductWorkflow(
        context(control.core),
        recovered({ providerReconciliation: evidence() }),
      ),
    ).rejects.toThrow("Provider reconciliation evidence is not allowed for this command");

    const input = recovered();
    expect(
      await reconcileRecoveredProductWorkflow(
        context(losingWriteResponses(control.core, 1)),
        input,
      ),
    ).toBe("replayed");
    expect(await reconcileRecoveredProductWorkflow(context(control.core), input)).toBe("replayed");
    expect(
      await first(
        "SELECT state,reconciliation_code FROM product_workflow_runs WHERE workflow_id=?",
        op.workflowId,
      ),
    ).toEqual({
      state: "reconciliation_required",
      reconciliation_code: "WORKFLOW_TERMINAL_BEFORE_RECONCILIATION",
    });
    expect(
      await first(
        "SELECT state,revision,reconciliation_code FROM cleanup_runs WHERE cleanup_run_id=?",
        op.intent.cleanup_run_id,
      ),
    ).toEqual({
      state: "reconciliation_required",
      revision: 2,
      reconciliation_code: "WORKFLOW_TERMINAL_BEFORE_RECONCILIATION",
    });
    expect(
      await first("SELECT actor_id FROM audit_events WHERE audit_event_id=?", input.auditEventId),
    ).toEqual({ actor_id: "workflow-recovery" });
  });
});
