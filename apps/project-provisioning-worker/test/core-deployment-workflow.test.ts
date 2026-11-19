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

import { DeploymentPersistenceConflictError } from "@ohmyhost/database/provisioning-persistence";
import { parseProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import { newUlid } from "../../control-store/src/catalog/common.js";
import { FINAL_ATTEMPT_LEASE_EXPIRED } from "../../control-store/src/catalog/provisioning/queue-recovery-deployment-logic.js";
import { DeploymentWorkflowRuntime } from "../../control-store/src/worker-main.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import { seedAcceptedOperation } from "../../control-store/test/support/accepted-operation.js";
import { seedProject } from "../../control-store/test/support/platform-fixtures.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { readCoreDeploymentWorkflowBindings } from "../src/core-deployment-workflow.js";
import {
  DeploymentWorkflow,
  ProductProviderReconciliationService,
  ProviderReconciliationWorkflow,
} from "../src/deployment-workflow-main.js";

let c: TestControl;
let runtime: DeploymentWorkflowRuntime;
beforeEach(async () => {
  c = await createTestControl();
  runtime = new DeploymentWorkflowRuntime({} as never, c.bindings);
}, 60_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await c.dispose();
});

const instance = (status: string) => ({ status: async () => ({ status }) });
const workflow = (status = "running") => ({
  create: async () => instance(status),
  get: async () => instance(status),
});
/** The Cloudflare service bindings are the only fakes, and they answer nothing; the control-store binding is the real Core. */
const provider = new Proxy({}, { get: () => async () => undefined });
const env = () => ({
  RUNTIME_CONFIGURATION_STATE: "configured",
  DEPLOYMENT_WORKFLOW_RUNTIME: runtime,
  PROJECT_PROVISIONING_WORKFLOW: workflow(),
  DEPLOYMENT_WORKFLOW: workflow(),
  PROVIDER_RECONCILIATION_WORKFLOW: workflow(),
  SOURCE_FETCHER: provider,
  BUILD_RUNNER: provider,
  RECOVERY_INVOKER: provider,
  RUNTIME_SECRET_DELIVERY: provider,
  NEXT_CACHE_RETIREMENT: provider,
  NEON_MANAGEMENT: provider,
  NATIVE_AUTH_RESOURCE_RUNTIME: {
    readProvisioningPolicy: async () => undefined,
    readPendingNativePolicySync: async () => null,
    completeNativePolicySync: async () => undefined,
    readDomainPolicySync: async () => [],
    ackDomainPolicySync: async () => "acknowledged",
    beginHandleDomainRecovery: async () => null,
    completeHandleDomainRecovery: async () => "completed",
  },
  NATIVE_AUTH_ADMIN_US: provider,
  NATIVE_AUTH_ADMIN_EU: provider,
  R2_MANAGEMENT: provider,
  STORAGE_DATA_MANAGEMENT: provider,
  SES_MANAGEMENT: provider,
  CLOUDFLARE_DOMAIN_MANAGEMENT: provider,
  WFP_MANAGEMENT: provider,
});
const step = {
  do: async (_name: string, _config: unknown, run: () => Promise<unknown>) => run(),
  sleep: async () => undefined,
} as never;
const event = (payload: unknown, instanceId: string) =>
  ({ payload, instanceId, timestamp: new Date(), workflowName: "core" }) as never;
const ATTEMPT = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

function commands(r: Awaited<ReturnType<typeof workflowFixture>>) {
  const scope = {
    version: 1 as const,
    eventId: r.input.eventId,
    organizationId: r.p.organizationId,
    projectId: r.p.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
    billingEpochId: r.p.billingEpochId,
  };
  return {
    deployment: parseProductCommandMessageV1({
      ...scope,
      eventType: "DeploymentRequestedV1",
      planId: r.plan,
    }),
    sourceLink: parseProductCommandMessageV1({ ...scope, eventType: "SourceLinkRequestedV1" }),
  };
}

it("runs a Deployment Workflow on the real Core up to the provider boundary and records its reconciliation", async () => {
  const r = await workflowFixture(c),
    { deployment } = commands(r);
  const workflowInstance = new DeploymentWorkflow({} as ExecutionContext, env());
  await expect(
    workflowInstance.run(event(deployment, r.input.logicalWorkflowId), step),
  ).resolves.toEqual({ status: "reconciliation_required" });
  expect(
    await c.core
      .prepare(
        "SELECT run.state run,deployment.status deployment,(SELECT count(*) FROM product_provider_mutation_claims) claims FROM product_workflow_runs run JOIN deployments deployment ON deployment.deployment_id=?2 WHERE run.workflow_id=?1",
      )
      .bind(r.input.logicalWorkflowId, r.deployment)
      .first(),
  ).toEqual({ run: "reconciliation_required", deployment: "reconciliation_required", claims: 1 });

  // A recovery execution that the Core never activated is refused with the original domain error.
  const { sourceLink } = commands(r);
  await expect(
    workflowInstance.run(
      event(
        { command: deployment, reconciliationAttemptId: ATTEMPT },
        `product-provider-reconcile-v1-${ATTEMPT}`,
      ),
      step,
    ),
  ).rejects.toThrow(DeploymentPersistenceConflictError);
  await expect(
    workflowInstance.run(
      event(
        { command: sourceLink, replayAttemptId: ATTEMPT },
        `product-command-replay-v1-${ATTEMPT}`,
      ),
      step,
    ),
  ).rejects.toThrow("Product Workflow replay is no longer active");
  // The binding inventory is exact: an extra binding or a disabled configuration state is refused.
  expect(() => readCoreDeploymentWorkflowBindings({ ...env(), EXTRA_BINDING: provider })).toThrow(
    "Deployment Core persistence configuration differs",
  );
  expect(() =>
    readCoreDeploymentWorkflowBindings({ ...env(), RUNTIME_CONFIGURATION_STATE: "disabled" }),
  ).toThrow("Deployment Core persistence configuration differs");
}, 60_000);

it("loads, requests and logs provider reconciliation on the real Core", async () => {
  const info = vi.spyOn(console, "log").mockImplementation(() => undefined),
    failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const r = await workflowFixture(c),
    message = {
      version: 1,
      attemptId: ATTEMPT,
      claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      organizationId: r.p.organizationId,
      projectId: r.p.projectId,
      environmentId: r.input.environmentId,
      operationId: r.input.operationId,
      actorId: "user:operator",
      idempotencySha256: `sha256:${"a".repeat(64)}`,
    };
  // No such claim exists, so the Workflow stops at its first durable step.
  await expect(
    new ProviderReconciliationWorkflow({} as ExecutionContext, env()).run(
      event(message, `product-provider-reconciliation-v1-${ATTEMPT}`),
      step,
    ),
  ).rejects.toThrow("Provider reconciliation context is unavailable");

  const service = new ProductProviderReconciliationService({} as ExecutionContext, env()),
    request = {
      organizationId: r.p.organizationId,
      operationId: r.input.operationId,
      actorId: "user:operator",
      idempotencySha256: message.idempotencySha256,
    },
    rpc = (stage: string, extra: object = {}) =>
      JSON.stringify({
        event: "provider_reconciliation_rpc",
        operationId: r.input.operationId,
        stage,
        ...extra,
      });
  // An operation with no pending recovery is unmatched: a typed, non-retryable answer, not an outage.
  await expect(service.reconcile(request)).resolves.toMatchObject({ state: "unmatched" });
  expect(info.mock.calls).toEqual([[rpc("started")], [rpc("completed", { state: "unmatched" })]]);
  expect(failure).not.toHaveBeenCalled();

  // The operation now holds its claim and its original Workflow is still running: reconciliation waits.
  const fresh = await workflowFixture(c);
  await runtime.claimProductProviderMutation(fresh.input);
  info.mockClear();
  const waiting = {
    ...request,
    organizationId: fresh.p.organizationId,
    operationId: fresh.input.operationId,
  };
  await expect(service.reconcile(waiting)).resolves.toMatchObject({
    operationId: fresh.input.operationId,
    state: "pending",
  });
  expect(info.mock.calls.map(([line]) => JSON.parse(String(line)).stage)).toEqual([
    "started",
    "completed",
  ]);
}, 60_000);

it("hands a project deletion whose queue delivery was lost back to its Workflow and acknowledges the handoff", async () => {
  const project = await seedProject(c),
    deletion = await seedAcceptedOperation(project, project.devEnvironmentId, {
      eventType: "ProjectDeletionRequestedV1",
      claim: false,
    }),
    delivery = newUlid(),
    failedAt = "2026-10-28T12:05:00.000000Z";
  await c.core.batch([
    c.core
      .prepare(
        "UPDATE projects SET lifecycle_state='deleting',lifecycle_version=lifecycle_version+1 WHERE organization_id=?1 AND project_id=?2",
      )
      .bind(project.organizationId, project.projectId),
    c.core
      .prepare(
        "UPDATE outbox_events SET current_attempt_id=?2,attempt_count=5,max_attempts=5,last_error_code=?4,reconciliation_required_at=?3,claimed_at=NULL,lease_expires_at=NULL WHERE event_id=?1",
      )
      .bind(deletion.eventId, delivery, failedAt, FINAL_ATTEMPT_LEASE_EXPIRED),
    c.core
      .prepare(
        "INSERT INTO delivery_attempts(attempt_id,event_id,attempt_number,claimed_at,lease_expires_at,failed_at,status,error_code) VALUES(?1,?2,5,'2026-10-28T12:04:00.000000Z',?3,?3,'reconciliation_required',?4)",
      )
      .bind(delivery, deletion.eventId, failedAt, FINAL_ATTEMPT_LEASE_EXPIRED),
  ]);
  const started: unknown[] = [],
    bindings = {
      ...env(),
      DEPLOYMENT_WORKFLOW: {
        create: async (options: unknown) => {
          started.push(options);
          return instance("running");
        },
        get: async () => instance("running"),
      },
    };
  const service = new ProductProviderReconciliationService({} as ExecutionContext, bindings);
  await expect(
    service.reconcile({
      organizationId: project.organizationId,
      operationId: deletion.operationId,
      actorId: "user:operator",
      idempotencySha256: `sha256:${"b".repeat(64)}`,
    }),
  ).resolves.toMatchObject({ operationId: deletion.operationId, state: "pending" });
  expect(started).toHaveLength(1);
  expect(
    await c.core
      .prepare(
        "SELECT acknowledged_at IS NOT NULL acknowledged FROM outbox_events WHERE event_id=?",
      )
      .bind(deletion.eventId)
      .first(),
  ).toEqual({ acknowledged: 1 });
}, 60_000);
