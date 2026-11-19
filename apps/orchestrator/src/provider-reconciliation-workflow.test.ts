import { describe, expect, it, vi } from "vitest";

import {
  deterministicProviderReconciliationWorkflowId,
  parseProductProviderReconciliationMessageV1,
  runProductProviderReconciliationWorkflow,
  type ProductProviderReconciliationPorts,
} from "./provider-reconciliation-workflow.js";

const message = parseProductProviderReconciliationMessageV1({
  version: 1,
  attemptId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  claimId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  actorId: "user:operator_1",
  idempotencySha256: `sha256:${"a".repeat(64)}`,
});

function ports(
  outcome: "prepared" | "unknown" | "resolved_absent" = "prepared",
): ProductProviderReconciliationPorts {
  return {
    load: vi.fn(async () => ({ claim: "exact" })),
    observe: vi.fn(async () => ({ gateway: "ready", wfp: "absent" })),
    prepare: vi.fn(async () =>
      outcome === "prepared"
        ? {
            outcome,
            attemptId: message.attemptId,
            physicalWorkflowId: `product-provider-reconcile-v1-${message.attemptId}-${message.operationId}-1`,
            originalMessage: { eventType: "DeploymentRequestedV1" },
          }
        : { outcome, attemptId: message.attemptId },
    ),
    resume: vi.fn(async () => "pending" as const),
  };
}

describe("provider reconciliation workflow", () => {
  it("observes and persists before resuming one new physical deployment Workflow", async () => {
    const dependencies = ports();
    const step = { do: vi.fn(async (_name, _config, run: () => Promise<unknown>) => run()) };

    await expect(
      runProductProviderReconciliationWorkflow(
        message,
        deterministicProviderReconciliationWorkflowId(message),
        step as never,
        dependencies,
      ),
    ).resolves.toMatchObject({ status: "pending", attemptId: message.attemptId });
    expect(step.do).toHaveBeenNthCalledWith(
      1,
      "load-provider-reconciliation",
      expect.anything(),
      expect.any(Function),
    );
    expect(step.do).toHaveBeenNthCalledWith(
      4,
      "resume-original-deployment",
      expect.anything(),
      expect.any(Function),
    );
  });

  it.each(["unknown", "resolved_absent"] as const)(
    "does not resume provider mutation after %s observation",
    async (outcome) => {
      const dependencies = ports(outcome);
      const step = { do: vi.fn(async (_name, _config, run: () => Promise<unknown>) => run()) };
      await expect(
        runProductProviderReconciliationWorkflow(
          message,
          deterministicProviderReconciliationWorkflowId(message),
          step as never,
          dependencies,
        ),
      ).resolves.toEqual({ status: outcome, attemptId: message.attemptId });
      expect(dependencies.resume).not.toHaveBeenCalled();
    },
  );

  it("rejects changed physical identity before any observation", async () => {
    const dependencies = ports();
    await expect(
      runProductProviderReconciliationWorkflow(message, "wrong", {} as never, dependencies),
    ).rejects.toThrow(TypeError);
    expect(dependencies.load).not.toHaveBeenCalled();
  });
});
