import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => {
  class Entrypoint {
    protected readonly env: unknown;
    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  }
  return { WorkerEntrypoint: Entrypoint, WorkflowEntrypoint: Entrypoint };
});

import { runProductProviderReconciliationWorkflow } from "@ohmyhost/orchestrator";
import { parseUlid } from "@ohmyhost/platform";
import { createControlStore } from "../../control-store/src/store.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { recordingStep } from "./support/deployment-chain-providers.js";
import type { Fixture } from "./support/deployment-chain-runs.js";
import {
  coreWorkflowBindings,
  recordingWorkflow,
  runCoreWorkflow,
} from "./support/chain-workflows.js";
import {
  acknowledge,
  chainHandlers,
  deployRun,
  gatewayActivation,
  seedProjectDomain,
} from "./support/deployment-chain-runs.js";
import {
  createCoreProviderReconciliationPorts,
  requestCoreProviderReconciliation,
} from "../src/provider-reconciliation-composition.js";

let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await c.dispose();
});

it("resolves a stuck deployment as absent through the Worker reconciliation path on the real D1 Core", async () => {
  const r = await workflowFixture(c),
    run = deployRun(r),
    store = createControlStore(c.bindings),
    handlers = chainHandlers(run.chain, gatewayActivation(store, run.chain));
  await seedProjectDomain(c, r);
  await acknowledge(c, r.input.eventId);
  // The gateway activation fails after the candidate was staged: the deployment is left for reconciliation.
  const stuck = await runCoreWorkflow(c, run, {
    ...handlers,
    WFP_MANAGEMENT: {
      ...handlers.WFP_MANAGEMENT,
      activateCandidate: async () => {
        throw new Error("The WFP activation request was lost");
      },
    },
  });
  expect(stuck.failures.map((failure) => failure.step)).toEqual([
    "activate-project-gateway-candidate",
  ]);
  const leased = await c.core
    .prepare("SELECT state,lease_expires_at FROM operations WHERE operation_id=?1")
    .bind(r.input.operationId)
    .first<{ state: string; lease_expires_at: string | null }>();
  expect(leased).toMatchObject({ state: "running" });
  expect(leased?.lease_expires_at).not.toBeNull();

  // The first absence is not yet proof: the Core resolves an absence only once an earlier preflight observed it too.
  const first = await reconcileAt(c, r, "2026-11-01T11:00:00.000Z", "a");
  expect(first).toEqual({ status: "unknown", failures: [] });
  expect(
    await c.core
      .prepare("SELECT state,lease_expires_at FROM operations WHERE operation_id=?1")
      .bind(r.input.operationId)
      .first(),
  ).toEqual({ state: "running", lease_expires_at: expect.any(String) });

  const second = await reconcileAt(c, r, "2026-11-01T11:00:10.000Z", "b");
  expect(second.failures).toEqual([]);
  expect(second.status).toBe("resolved_absent");

  expect(
    await c.core
      .prepare("SELECT state,failure,lease_expires_at FROM operations WHERE operation_id=?1")
      .bind(r.input.operationId)
      .first(),
  ).toEqual({
    state: "failed",
    failure:
      '{"code": "provider_state_absent", "message": "The deployment could not be completed."}',
    lease_expires_at: null,
  });
  expect(
    await c.core
      .prepare("SELECT status FROM deployments WHERE deployment_id=?1")
      .bind(r.deployment)
      .first(),
  ).toEqual({ status: "failed" });
  expect(
    await c.core
      .prepare("SELECT state FROM product_workflow_runs WHERE workflow_id=?1")
      .bind(r.input.logicalWorkflowId)
      .first(),
  ).toEqual({ state: "completed" });
  expect(
    await c.core
      .prepare("SELECT count(*) AS n FROM product_provider_mutation_claims WHERE operation_id=?1")
      .bind(r.input.operationId)
      .first(),
  ).toEqual({ n: 0 });
  expect((await c.core.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
}, 60_000);

/** The WFP observation of a candidate whose metadata is gone (the composition's metadata_absent shape). */
function metadataAbsent(input: unknown, observedAt: string) {
  const candidate = (input as { candidate: { scriptName: string } }).candidate;
  return {
    state: "metadata_absent",
    scriptName: candidate.scriptName,
    providerTag: null,
    productDeploymentId: null,
    artifactDigest: null,
    observedAt,
  };
}

/**
 * One reconciliation pass: the request starts the reconciliation Workflow, whose recorded params run through the real
 * Workflow with the candidate and the gateway absent. The clock fixes when the observation was taken.
 */
async function reconcileAt(control: TestControl, r: Fixture, at: string, idempotency: string) {
  const clock = { now: () => new Date(at) },
    requested = recordingWorkflow(),
    request = coreWorkflowBindings(
      control,
      {},
      { PROVIDER_RECONCILIATION_WORKFLOW: requested.binding },
    );
  const reply = await requestCoreProviderReconciliation(
    request.bindings,
    request.bindings.DEPLOYMENT_WORKFLOW_RUNTIME,
    {
      organizationId: parseUlid(r.p.organizationId),
      operationId: parseUlid(r.input.operationId),
      actorId: "user:fixture",
      idempotencySha256: `sha256:${idempotency.repeat(64)}`,
    },
    clock,
  );
  expect(reply).toMatchObject({ operationId: r.input.operationId, state: "pending" });
  const started = requested.created.at(-1);
  if (started === undefined) throw new Error("The reconciliation Workflow was not started");
  const observed = coreWorkflowBindings(control, {
      WFP_MANAGEMENT: {
        observeCandidate: (input) => metadataAbsent(input, at),
        observeActivation: () => ({ status: "absent" }),
      },
    }),
    recorder = recordingStep();
  const status = await runProductProviderReconciliationWorkflow(
    started.params,
    started.id,
    recorder.step,
    createCoreProviderReconciliationPorts(
      observed.bindings,
      observed.bindings.DEPLOYMENT_WORKFLOW_RUNTIME,
      clock,
    ),
  ).then((result) => result.status);
  return { status, failures: recorder.failures };
}
