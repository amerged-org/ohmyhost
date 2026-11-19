import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseUlid } from "@ohmyhost/platform";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    protected readonly env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
import { DeploymentWorkflowRuntime } from "../../control-store/src/worker-main.js";
import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import { createCoreProviderReconciliationDataPort } from "../src/core-provider-reconciliation.js";
import {
  PROVIDER_RECONCILIATION_FIELDS,
  PROVIDER_RECONCILIATION_METHODS,
  type ProviderReconciliationRuntimeBinding,
} from "../src/provider-reconciliation-data-port.js";

let c: TestControl;
beforeEach(async () => {
  c = await createTestControl();
});
afterEach(async () => c.dispose());

it("claims and finds a provider mutation through the deployed Control entrypoint", async () => {
  const r = await workflowFixture(c),
    port = createCoreProviderReconciliationDataPort(
      new DeploymentWorkflowRuntime(
        {} as never,
        c.bindings as never,
      ) as unknown as ProviderReconciliationRuntimeBinding,
    ),
    scope = {
      organizationId: parseUlid(r.input.organizationId),
      operationId: parseUlid(r.input.operationId),
    },
    claim = {
      claimId: parseUlid(r.input.claimId),
      organizationId: scope.organizationId,
      projectId: parseUlid(r.input.projectId),
      environmentId: parseUlid(r.input.environmentId),
      operationId: scope.operationId,
      eventId: parseUlid(r.input.eventId),
      logicalWorkflowId: r.input.logicalWorkflowId,
      eventType: r.input.eventType,
      acceptedLifecycleVersion: r.input.acceptedLifecycleVersion,
    };
  expect(await port.claimProductProviderMutation(() => ({ ...claim, leak: true }) as never)).toBe(
    "created",
  );
  expect(await port.claimProductProviderMutation(() => claim)).toBe("existing");
  expect(await port.findProductProviderReconciliationClaim(() => scope)).toMatchObject({
    claimId: claim.claimId,
  });
  expect(await port.findLostProductCommand(() => scope)).toBeNull();
});

it("generates one method per native operation that forwards exactly its native fields", async () => {
  const seen: { method: string; input: unknown; receiver: unknown }[] = [],
    binding = Object.fromEntries(
      PROVIDER_RECONCILIATION_METHODS.map((method) => [
        method,
        function (this: unknown, input: unknown) {
          seen.push({ method, input, receiver: this });
          return method === "findLostProductCommand"
            ? Promise.reject(new Error("Network connection lost"))
            : Promise.resolve(`reply:${method}`);
        },
      ]),
    ) as unknown as ProviderReconciliationRuntimeBinding,
    port = createCoreProviderReconciliationDataPort(binding);
  expect(Object.isFrozen(port)).toBe(true);
  expect(Object.keys(port).sort()).toEqual([...PROVIDER_RECONCILIATION_METHODS].sort());

  for (const method of PROVIDER_RECONCILIATION_METHODS) {
    const native = Object.fromEntries(
        PROVIDER_RECONCILIATION_FIELDS[method].map((field) => [field, `${method}/${field}`]),
      ),
      produce = vi.fn(() => ({ ...native, widened: "never crosses the private RPC" }) as never),
      outcome = port[method](produce);
    expect(produce).toHaveBeenCalledOnce();
    if (method === "findLostProductCommand")
      await expect(outcome).rejects.toThrow("Network connection lost");
    else expect(await outcome).toBe(`reply:${method}`);
    expect(seen.at(-1)).toEqual({ method, input: native, receiver: binding });
  }
  expect(seen).toHaveLength(PROVIDER_RECONCILIATION_METHODS.length);

  expect(() => createCoreProviderReconciliationDataPort({} as never)).toThrow(
    "Provider reconciliation capability is incomplete",
  );
});
