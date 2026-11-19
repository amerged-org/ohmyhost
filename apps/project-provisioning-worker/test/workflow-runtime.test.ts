import type { WorkflowStep } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { runProjectProvisioningWorkflow } from "../src/workflow-runtime.js";
import { message } from "./fixtures.js";

const workflowId = `project-provisioning-v1-${message.eventId}-${message.operationId}`;

describe("project provisioning Workflow execution", () => {
  it.each(["applied", "duplicate"] as const)(
    "persists completion replay outcome %s inside an explicit idempotent step",
    async (persistence) => {
      const completeAtomic = vi.fn(async () => persistence);
      const failAtomic = vi.fn(async () => "applied" as const);
      const stepDo = vi.fn(async (_name: string, _config: unknown, run: () => Promise<unknown>) =>
        run(),
      );
      const step = { do: stepDo } as unknown as Pick<WorkflowStep, "do">;
      await expect(
        runProjectProvisioningWorkflow({ payload: message, instanceId: workflowId }, step, {
          completion: { completeAtomic },
          failure: { failAtomic },
        }),
      ).resolves.toEqual({ status: "completed", persistence });
      expect(stepDo).toHaveBeenCalledWith(
        "persist-project-provisioning-completion",
        {
          retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
          timeout: "30 seconds",
        },
        expect.any(Function),
      );
      expect(completeAtomic).toHaveBeenCalledWith({ workflowId, message });
      expect(failAtomic).not.toHaveBeenCalled();
    },
  );

  it("persists definitive step failure safely and rethrows the original error", async () => {
    const failure = new Error("completion failed");
    const failAtomic = vi.fn(async () => "applied" as const);
    const stepDo = vi.fn(async (name: string, _config: unknown, run: () => Promise<unknown>) => {
      if (name === "persist-project-provisioning-completion") throw failure;
      return run();
    });
    const step = { do: stepDo } as unknown as Pick<WorkflowStep, "do">;
    await expect(
      runProjectProvisioningWorkflow({ payload: message, instanceId: workflowId }, step, {
        completion: { completeAtomic: vi.fn() },
        failure: { failAtomic },
      }),
    ).rejects.toBe(failure);
    expect(failAtomic).toHaveBeenCalledWith({ workflowId, message });
    expect(stepDo).toHaveBeenCalledWith(
      "persist-project-provisioning-failure",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "30 seconds",
      },
      expect.any(Function),
    );
  });

  it("does not mask the original terminal error when failure persistence also fails", async () => {
    const original = new Error("completion failed");
    const stepDo = vi.fn(async (name: string, _config: unknown, run: () => Promise<unknown>) => {
      if (name === "persist-project-provisioning-completion") throw original;
      return run();
    });
    const step = { do: stepDo } as unknown as Pick<WorkflowStep, "do">;
    await expect(
      runProjectProvisioningWorkflow({ payload: message, instanceId: workflowId }, step, {
        completion: { completeAtomic: vi.fn() },
        failure: {
          failAtomic: vi.fn(async () => Promise.reject(new Error("failure write failed"))),
        },
      }),
    ).rejects.toBe(original);
  });

  it("rejects a mismatched instance id before any persistence", async () => {
    const completeAtomic = vi.fn();
    const stepDo = vi.fn();
    const step = { do: stepDo } as unknown as Pick<WorkflowStep, "do">;
    await expect(
      runProjectProvisioningWorkflow({ payload: message, instanceId: "wrong" }, step, {
        completion: { completeAtomic },
        failure: { failAtomic: vi.fn() },
      }),
    ).rejects.toThrow("instance ID");
    expect(stepDo).not.toHaveBeenCalled();
    expect(completeAtomic).not.toHaveBeenCalled();
  });
});
