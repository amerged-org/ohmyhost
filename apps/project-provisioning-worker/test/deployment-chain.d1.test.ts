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

import {
  deterministicProductCommandWorkflowId,
  parseProductCommandMessageV1,
} from "@ohmyhost/orchestrator";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { createControlStore } from "../../control-store/src/store.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import {
  promotionIntent,
  rollbackIntent,
  seedAcceptedOperation,
  seedOperation,
} from "../../control-store/test/support/accepted-operation.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { runCoreWorkflow } from "./support/chain-workflows.js";
import {
  acknowledge,
  chainHandlers,
  deployRun,
  gatewayActivation,
  seedProjectDomain,
  type ChainRun,
} from "./support/deployment-chain-runs.js";
import {
  CHAIN_HEX,
  chainScope,
  stagedCandidate,
  wfpReceipt,
  type Handlers,
} from "./support/deployment-chain-providers.js";

/** The Workflow steps of a deployment that publishes: each one ran on the real Core and the providers. */
const DEPLOY_STEPS = [
  "fetch-exact-source-archive",
  "start-isolated-build",
  "observe-build-artifact-2",
  "ensure-project-database",
  "stage-immutable-wfp-candidate",
  "persist-immutable-wfp-candidate",
  "record-runtime-secret-candidate-stage",
  "authorize-candidate-activation",
  "activate-project-gateway-candidate",
  "authorize-candidate-finalization",
  "record-runtime-secret-candidate-activation",
  "finalize-immutable-wfp-candidate",
];

let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await c.dispose();
});

/**
 * An accepted promotion of the Dev revision that the real deployment chain publishes first. The promotion holds the
 * project's claim next, so the deployment's own (released by its finalization) is gone when it starts.
 */
async function promotionRun(): Promise<ChainRun & { readonly eventId: string }> {
  const r = await workflowFixture(c),
    store = createControlStore(c.bindings),
    source = deployRun(r);
  await seedProjectDomain(c, r);
  await acknowledge(c, r.input.eventId);
  const published = await runChain(
    source,
    chainHandlers(source.chain, gatewayActivation(store, source.chain)),
  );
  expect(published.failures).toEqual([]);
  expect(published.result).toEqual({ status: "succeeded", persistence: "applied" });
  const revision = await c.core
    .prepare("SELECT revision_id,artifact_id FROM deployment_revisions WHERE deployment_id=?1")
    .bind(r.deployment)
    .first<{ revision_id: string; artifact_id: string }>();
  if (revision === null) throw new Error("The Dev deployment has no published revision");
  const project = {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      billingEpochId: r.p.billingEpochId,
      shard: c.core,
    },
    eventId = newUlid(),
    operationId = await seedOperation(project),
    command = parseProductCommandMessageV1({
      version: 1,
      eventType: "DeploymentPromotionRequestedV1",
      eventId,
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      billingEpochId: r.p.billingEpochId,
      environmentId: r.p.productionEnvironmentId,
      operationId,
    });
  await seedAcceptedOperation(project, r.p.productionEnvironmentId, {
    eventType: "DeploymentPromotionRequestedV1",
    operationId,
    eventId,
    // The Workflow acquires the project's provider mutation claim itself; acceptance does not hold one.
    claim: false,
    workflowId: deterministicProductCommandWorkflowId(command),
    // Accepting a promotion pins the source binding generation it was accepted against (here the linked one).
    intent: async (operation) => ({
      ...(await promotionIntent(project, operation, r.p.productionEnvironmentId, {
        deploymentId: r.deployment,
        revisionId: revision.revision_id,
        artifactId: revision.artifact_id,
        environmentId: r.input.environmentId,
      })),
      source_generation: 1,
    }),
  });
  await acknowledge(c, eventId);
  const promotion = await c.core
    .prepare("SELECT deployment_id FROM deployments WHERE operation_id=?1 AND kind='promotion'")
    .bind(operationId)
    .first<{ deployment_id: string }>();
  if (promotion === null) throw new Error("The promotion deployment is missing");
  return {
    eventId,
    command,
    workflowId: deterministicProductCommandWorkflowId(command),
    chain: {
      organizationId: r.p.organizationId,
      billingEpochId: r.p.billingEpochId,
      projectId: r.p.projectId,
      environmentId: r.p.productionEnvironmentId,
      environmentName: "prod",
      operationId,
      deploymentId: promotion.deployment_id,
      buildId: "build-1",
    },
  };
}

/** Runs the real deployment Workflow on the real D1 Core; only the provider bindings are answers. */
function runChain(run: ChainRun, handlers: Handlers) {
  return runCoreWorkflow(c, run, handlers);
}

it("deploys a plain static project end to end on the real D1 Core", async () => {
  const r = await workflowFixture(c),
    run = deployRun(r),
    store = createControlStore(c.bindings);
  await seedProjectDomain(c, r);
  await acknowledge(c, r.input.eventId);
  const outcome = await runChain(
    run,
    chainHandlers(run.chain, gatewayActivation(store, run.chain)),
  );
  // A failing step is reported first: the Workflow would otherwise turn it into a reconciliation.
  expect(outcome.failures).toEqual([]);
  expect(outcome.result).toEqual({ status: "succeeded", persistence: "applied" });
  expect(outcome.steps).toEqual(expect.arrayContaining(DEPLOY_STEPS));
  expect(outcome.steps.filter((name) => /reconcile|fail/u.test(name))).toEqual([]);
  expect(outcome.calls.map(([name]) => name)).toEqual([
    "SOURCE_FETCHER.acquireExact",
    "BUILD_RUNNER.startBuild",
    "BUILD_RUNNER.readBuild",
    "BUILD_RUNNER.readBuild",
    "BUILD_RUNNER.readBuildArtifact",
    "RUNTIME_SECRET_DELIVERY.stageCandidate",
    "RUNTIME_SECRET_DELIVERY.recordStagedCandidate",
    "WFP_MANAGEMENT.activateCandidate",
    "RUNTIME_SECRET_DELIVERY.recordActivatedCandidate",
    "CLOUDFLARE_DOMAIN_MANAGEMENT.ensureEnvironment",
  ]);
  const started = outcome.calls.find(([name]) => name === "BUILD_RUNNER.startBuild")?.[1] as Record<
    string,
    unknown
  >;
  expect(started).toMatchObject({
    scope: chainScope(run.chain),
    buildPlanSha256: CHAIN_HEX,
    deploymentId: r.deployment,
  });
  expect(started["frameworkPlan"]).toBeDefined();
  // Core state after the chain: the environment serves the new deployment, and nothing is left running.
  const operation = await c.core
    .prepare("SELECT state,result_url FROM operations WHERE operation_id=?1")
    .bind(r.input.operationId)
    .first<{ state: string; result_url: string }>();
  expect(operation).toMatchObject({ state: "succeeded" });
  expect(operation?.result_url).toMatch(/^https:\/\//u);
  const environment = await c.core
    .prepare("SELECT head_version,active_deployment_id FROM environments WHERE environment_id=?1")
    .bind(r.input.environmentId)
    .first<{ head_version: number; active_deployment_id: string }>();
  expect(environment).toEqual({ head_version: 1, active_deployment_id: r.deployment });
  const deployment = await c.core
    .prepare("SELECT status FROM deployments WHERE deployment_id=?1")
    .bind(r.deployment)
    .first<{ status: string }>();
  expect(deployment).toEqual({ status: "succeeded" });
  const publications = await c.core
    .prepare("SELECT count(*) AS n FROM wfp_publish_receipts WHERE product_deployment_id=?1")
    .bind(r.deployment)
    .first<{ n: number }>();
  expect(publications?.n).toBe(1);
  const workflow = await c.core
    .prepare("SELECT state FROM product_workflow_runs WHERE workflow_id=?1")
    .bind(r.input.logicalWorkflowId)
    .first<{ state: string }>();
  expect(workflow).toEqual({ state: "completed" });
  const claim = await c.core
    .prepare("SELECT count(*) AS n FROM product_provider_mutation_claims WHERE operation_id=?1")
    .bind(r.input.operationId)
    .first<{ n: number }>();
  expect(claim?.n).toBe(0);
}, 60_000);

it("fails a deployment whose build fails and records the failure on the real Core", async () => {
  const r = await workflowFixture(c),
    run = deployRun(r),
    store = createControlStore(c.bindings),
    handlers = chainHandlers(run.chain, gatewayActivation(store, run.chain));
  await seedProjectDomain(c, r);
  await acknowledge(c, r.input.eventId);
  const outcome = await runChain(run, {
    ...handlers,
    BUILD_RUNNER: {
      ...handlers.BUILD_RUNNER,
      readBuild: () => ({
        status: "failed",
        failure: { excerpt: "Build failed: missing lockfile", truncated: false },
      }),
    },
  });
  expect(outcome.failures).toEqual([]);
  expect(outcome.result).toEqual({ status: "failed", persistence: "applied" });
  expect(outcome.steps).toContain("fail-isolated-build");
  expect(outcome.steps).not.toContain("finalize-immutable-wfp-candidate");
  // The build is the last provider call: a failed build never stages, activates or publishes anything.
  expect(outcome.calls.at(-1)?.[0]).toBe("BUILD_RUNNER.readBuild");
  const operation = await c.core
    .prepare("SELECT state FROM operations WHERE operation_id=?1")
    .bind(r.input.operationId)
    .first<{ state: string }>();
  expect(operation).toEqual({ state: "failed" });
  const workflow = await c.core
    .prepare("SELECT state FROM product_workflow_runs WHERE workflow_id=?1")
    .bind(r.input.logicalWorkflowId)
    .first<{ state: string }>();
  expect(workflow).toEqual({ state: "completed" });
}, 60_000);

/**
 * An accepted rollback of the Dev environment onto the revision that the real deployment chain published first. The
 * rolled-back-to revision is the active one, which the Core accepts as a rollback target.
 */
async function rollbackRun(): Promise<ChainRun> {
  const r = await workflowFixture(c),
    store = createControlStore(c.bindings),
    source = deployRun(r);
  await seedProjectDomain(c, r);
  await acknowledge(c, r.input.eventId);
  const published = await runChain(
    source,
    chainHandlers(source.chain, gatewayActivation(store, source.chain)),
  );
  expect(published.failures).toEqual([]);
  expect(published.result).toEqual({ status: "succeeded", persistence: "applied" });
  const revision = await c.core
    .prepare("SELECT revision_id,artifact_id FROM deployment_revisions WHERE deployment_id=?1")
    .bind(r.deployment)
    .first<{ revision_id: string; artifact_id: string }>();
  if (revision === null) throw new Error("The Dev deployment has no published revision");
  const project = {
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      billingEpochId: r.p.billingEpochId,
      shard: c.core,
    },
    eventId = newUlid(),
    operationId = await seedOperation(project),
    command = parseProductCommandMessageV1({
      version: 1,
      eventType: "DeploymentRollbackRequestedV1",
      eventId,
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      billingEpochId: r.p.billingEpochId,
      environmentId: r.input.environmentId,
      operationId,
    });
  await seedAcceptedOperation(project, r.input.environmentId, {
    eventType: "DeploymentRollbackRequestedV1",
    operationId,
    eventId,
    workflowId: deterministicProductCommandWorkflowId(command),
    claim: false,
    intent: async (operation) => ({
      ...(await rollbackIntent(project, operation, r.input.environmentId, {
        deploymentId: r.deployment,
        revisionId: revision.revision_id,
        artifactId: revision.artifact_id,
      })),
      source_generation: 1,
    }),
  });
  await acknowledge(c, eventId);
  const rollback = await c.core
    .prepare("SELECT deployment_id FROM deployments WHERE operation_id=?1 AND kind='rollback'")
    .bind(operationId)
    .first<{ deployment_id: string }>();
  if (rollback === null) throw new Error("The rollback deployment is missing");
  return {
    command,
    workflowId: deterministicProductCommandWorkflowId(command),
    chain: {
      organizationId: r.p.organizationId,
      billingEpochId: r.p.billingEpochId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
      environmentName: "dev",
      operationId,
      // The retained revision's candidate is reused, so its script names the rolled-back-to deployment.
      deploymentId: r.deployment,
      buildId: "build-1",
    },
  };
}

it("rolls Dev back to a retained published deployment end to end", async () => {
  const run = await rollbackRun(),
    store = createControlStore(c.bindings);
  const handlers = chainHandlers(run.chain, gatewayActivation(store, run.chain));
  const outcome = await runChain(run, {
    ...handlers,
    RUNTIME_SECRET_DELIVERY: {
      ...handlers.RUNTIME_SECRET_DELIVERY,
      prepareExistingCandidate: () => ({
        ...stagedCandidate(run.chain),
        status: "replayed",
        candidate: { ...wfpReceipt(run.chain), buildReused: true },
        priorGateway: undefined,
        deploymentUrl: undefined,
      }),
    },
  });
  expect(outcome.failures).toEqual([]);
  expect(outcome.result).toEqual({ status: "succeeded", persistence: "applied" });
  expect(outcome.steps).toContain("finalize-immutable-rollback");
  const environment = await c.core
    .prepare("SELECT head_version,active_deployment_id FROM environments WHERE environment_id=?1")
    .bind(run.chain.environmentId)
    .first<{ head_version: number; active_deployment_id: string }>();
  expect(environment).toEqual({ head_version: 2, active_deployment_id: run.chain.deploymentId });
  const activation = await c.core
    .prepare("SELECT count(*) AS n FROM wfp_rollback_activation_receipts WHERE operation_id=?1")
    .bind(run.chain.operationId)
    .first<{ n: number }>();
  expect(activation?.n).toBe(1);
}, 60_000);

it("promotes a published Dev deployment into Production end to end", async () => {
  const run = await promotionRun(),
    store = createControlStore(c.bindings);
  const outcome = await runChain(
    run,
    chainHandlers(run.chain, gatewayActivation(store, run.chain), "stagePromotionCandidate"),
  );
  expect(outcome.failures).toEqual([]);
  expect(outcome.result).toEqual({ status: "succeeded", persistence: "applied" });
  expect(outcome.steps).toContain("finalize-immutable-wfp-candidate");
  const environment = await c.core
    .prepare("SELECT head_version,active_deployment_id FROM environments WHERE environment_id=?1")
    .bind(run.chain.environmentId)
    .first<{ head_version: number; active_deployment_id: string }>();
  expect(environment).toEqual({ head_version: 1, active_deployment_id: run.chain.deploymentId });
}, 60_000);
