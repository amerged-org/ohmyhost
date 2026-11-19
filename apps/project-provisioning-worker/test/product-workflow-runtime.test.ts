import { parseProductCommandMessageV1 } from "@ohmyhost/orchestrator";
import { describe, expect, it, vi } from "vitest";

import {
  runDeploymentWorkflowEntrypoint,
  withOperationLease,
} from "../src/product-workflow-runtime.js";
import {
  PRODUCT_WORKFLOW_STEP_CONFIG,
  PRODUCT_BUILD_OBSERVATION_STEP_CONFIG,
} from "@ohmyhost/orchestrator";

const command = parseProductCommandMessageV1({
  version: 1,
  eventType: "SourceLinkRequestedV1",
  eventId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  billingEpochId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  operationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
});
const deployment = parseProductCommandMessageV1({
  ...command,
  eventType: "DeploymentRequestedV1",
  planId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
});

describe("DeploymentWorkflow runtime", () => {
  it("keeps bounded steps and durable waits leased and fences expired execution before work", async () => {
    const leases: number[] = [];
    let active = true,
      executions = 0;
    const step = withOperationLease(
      {
        async do(_name, _config, run) {
          return run();
        },
        async sleep() {},
      },
      async (duration) => {
        if (!active) throw new Error("lease expired");
        leases.push(duration);
      },
    );
    expect(await step.do("short", PRODUCT_WORKFLOW_STEP_CONFIG, async () => ++executions)).toBe(1);
    expect(
      await step.do("build", PRODUCT_BUILD_OBSERVATION_STEP_CONFIG, async () => ++executions),
    ).toBe(2);
    for (const duration of ["10 seconds", "10 minutes", "1 minute", "1 hour"] as const)
      await step.sleep("wait", duration);
    expect(leases).toEqual([
      1_020_000, 1_800_000, 910_000, 900_000, 1_500_000, 900_000, 960_000, 900_000, 4_500_000,
      900_000,
    ]);
    active = false;
    await expect(
      step.do("stale", PRODUCT_WORKFLOW_STEP_CONFIG, async () => ++executions),
    ).rejects.toThrow("lease expired");
    expect(executions).toBe(2);
  });
  it("passes strict payload, instance identity, durable step, and injected ports to core", async () => {
    const run = vi.fn(async () => ({
      status: "succeeded" as const,
      persistence: "applied" as const,
    }));
    const step = { do: vi.fn() };
    const ports = {} as never;
    const activate = vi.fn();
    const activateReplay = vi.fn();
    await expect(
      runDeploymentWorkflowEntrypoint(
        {
          payload: command,
          instanceId: `product-command-v1-source-link-${command.eventId}-${command.operationId}`,
        },
        step as never,
        ports,
        activate,
        activateReplay,
        run,
      ),
    ).resolves.toEqual({ status: "succeeded", persistence: "applied" });
    expect(run).toHaveBeenCalledWith(
      command,
      step,
      ports,
      expect.stringContaining(command.operationId),
      expect.stringContaining(command.operationId),
    );
    expect(activate).not.toHaveBeenCalled();
    expect(activateReplay).not.toHaveBeenCalled();
  });

  it("rejects invalid payload before any provider composition", async () => {
    const run = vi.fn();
    const activate = vi.fn();
    const activateReplay = vi.fn();
    await expect(
      runDeploymentWorkflowEntrypoint(
        { payload: { eventType: "DeploymentRequestedV1", token: "unsafe" }, instanceId: "wrong" },
        {} as never,
        {} as never,
        activate,
        activateReplay,
        run,
      ),
    ).rejects.toThrow(TypeError);
    expect(run).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    expect(activateReplay).not.toHaveBeenCalled();
  });

  it("runs a bounded new physical reconciliation instance under the original logical identity", async () => {
    const run = vi.fn(async () => ({ status: "reconciliation_required" as const }));
    const activate = vi.fn(async () => "activated" as const);
    const activateReplay = vi.fn();
    await runDeploymentWorkflowEntrypoint(
      {
        payload: { command: deployment, reconciliationAttemptId: command.eventId },
        instanceId: `product-provider-reconcile-v1-${command.eventId}`,
      },
      {} as never,
      {} as never,
      activate,
      activateReplay,
      run,
    );

    expect(activate).toHaveBeenCalledWith({
      attemptId: command.eventId,
      physicalWorkflowId: `product-provider-reconcile-v1-${command.eventId}`,
      command: deployment,
    });
    expect(activate.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0] ?? 0);
    expect(run).toHaveBeenCalledWith(
      deployment,
      expect.anything(),
      expect.anything(),
      `product-command-v1-deploy-${deployment.eventId}-${deployment.operationId}`,
      `product-provider-reconcile-v1-${command.eventId}`,
    );
  });

  it("runs an audited replay under a distinct physical identity", async () => {
    const run = vi.fn(async () => ({
      status: "succeeded" as const,
      persistence: "applied" as const,
    }));
    const activate = vi.fn();
    const activateReplay = vi.fn(async () => "active" as const);
    await runDeploymentWorkflowEntrypoint(
      {
        payload: { command, replayAttemptId: command.eventId },
        instanceId: `product-command-replay-v1-${command.eventId}`,
      },
      {} as never,
      {} as never,
      activate,
      activateReplay,
      run,
    );

    expect(activate).not.toHaveBeenCalled();
    expect(activateReplay).toHaveBeenCalledWith({
      attemptId: command.eventId,
      physicalWorkflowId: `product-command-replay-v1-${command.eventId}`,
      command,
    });
    expect(run).toHaveBeenCalledWith(
      command,
      expect.anything(),
      expect.anything(),
      `product-command-v1-source-link-${command.eventId}-${command.operationId}`,
      `product-command-replay-v1-${command.eventId}`,
    );
  });
});
