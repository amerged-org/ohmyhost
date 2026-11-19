import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;

    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {
    protected readonly env: unknown;

    constructor(_context: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

import consumer from "../src/consumer-main.js";
import publisher, { OperationPublisherService } from "../src/publisher-main.js";
import { ProjectProvisioningWorkflow } from "../src/workflow-main.js";
import {
  DeploymentWorkflow,
  ProductProviderReconciliationService,
  ProviderReconciliationWorkflow,
} from "../src/deployment-workflow-main.js";
import { message } from "./fixtures.js";

const disabled = { RUNTIME_CONFIGURATION_STATE: "disabled" };

/** Every private binding answers any method; the Worker's own reader judges the complete inventory. */
const callable = new Proxy({}, { get: () => () => undefined });
const configured = {
  RUNTIME_CONFIGURATION_STATE: "configured",
  DEPLOYMENT_WORKFLOW_RUNTIME: callable,
  PROJECT_PROVISIONING_WORKFLOW: callable,
  DEPLOYMENT_WORKFLOW: callable,
  PROVIDER_RECONCILIATION_WORKFLOW: callable,
  SOURCE_FETCHER: callable,
  BUILD_RUNNER: callable,
  RECOVERY_INVOKER: callable,
  RUNTIME_SECRET_DELIVERY: callable,
  NEXT_CACHE_RETIREMENT: callable,
  NEON_MANAGEMENT: callable,
  NATIVE_AUTH_RESOURCE_RUNTIME: callable,
  NATIVE_AUTH_ADMIN_US: callable,
  NATIVE_AUTH_ADMIN_EU: callable,
  R2_MANAGEMENT: callable,
  STORAGE_DATA_MANAGEMENT: callable,
  SES_MANAGEMENT: callable,
  CLOUDFLARE_DOMAIN_MANAGEMENT: callable,
  WFP_MANAGEMENT: callable,
};
const timestamp = new Date("2026-08-19T00:00:00.000Z");

describe("checked-in Cloudflare main modules", () => {
  it("fail closed before reading any Core capability while the configuration state is disabled", async () => {
    await expect(publisher.scheduled({}, disabled)).rejects.toThrow("configuration state");
    await expect(
      new OperationPublisherService({} as ExecutionContext, disabled as never).wake(),
    ).rejects.toThrow("configuration state");
    await expect(consumer.queue({ messages: [] }, disabled)).rejects.toThrow("configuration state");
    const workflow = new ProjectProvisioningWorkflow({} as ExecutionContext, disabled);
    const deployment = new DeploymentWorkflow({} as ExecutionContext, disabled);
    const reconciliation = new ProviderReconciliationWorkflow({} as ExecutionContext, disabled);
    const service = new ProductProviderReconciliationService({} as ExecutionContext, disabled);
    await expect(
      workflow.run(
        {
          payload: message,
          instanceId: `project-provisioning-v1-${message.eventId}-${message.operationId}`,
          timestamp,
          workflowName: "ohmyhost-project-provisioning-v1",
        },
        {} as never,
      ),
    ).rejects.toThrow("configuration state");
    const event = (workflowName: string) => ({
      payload: {},
      instanceId: "disabled",
      timestamp,
      workflowName,
    });
    await expect(
      deployment.run(event("ohmyhost-deployment-workflow-v1"), {} as never),
    ).rejects.toThrow("Deployment Core persistence configuration differs");
    await expect(
      reconciliation.run(event("ohmyhost-provider-reconciliation-v1"), {} as never),
    ).rejects.toThrow("Deployment Core persistence configuration differs");
    await expect(service.reconcile({})).rejects.toThrow(
      "Deployment Core persistence configuration differs",
    );
  });

  it("rejects a malformed command or reconciliation request before touching the Core", async () => {
    const deployment = new DeploymentWorkflow({} as ExecutionContext, configured);
    await expect(
      deployment.run(
        {
          payload: {},
          instanceId: "not-started",
          timestamp,
          workflowName: "ohmyhost-deployment-workflow-v1",
        },
        {} as never,
      ),
    ).rejects.toThrow("version must be 1");

    const service = new ProductProviderReconciliationService({} as ExecutionContext, configured);
    await expect(service.reconcile({})).rejects.toThrow("request is invalid");
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    await expect(
      service.reconcile({
        organizationId: ulid,
        operationId: ulid,
        actorId: "service:untrusted",
        idempotencySha256: `sha256:${"a".repeat(64)}`,
      }),
    ).rejects.toThrow("actor identity is invalid");
    await expect(
      service.reconcile({
        organizationId: ulid,
        operationId: ulid,
        actorId: "user:operator",
        idempotencySha256: "sha256:short",
      }),
    ).rejects.toThrow("idempotency digest is invalid");
  });
});
