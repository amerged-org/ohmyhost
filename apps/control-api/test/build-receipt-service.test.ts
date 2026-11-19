import { quoteBuildCost } from "@ohmyhost/platform";
import { BuildCapacityReachedError } from "@ohmyhost/database";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { buildRig, cid, fundBuild } from "../../control-store/test/support/build-fixtures.js";
import {
  deploymentIntent,
  seedAcceptedOperation,
} from "../../control-store/test/support/accepted-operation.js";

const workerState = vi.hoisted(() => ({ env: undefined as unknown }));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    readonly adapter = true;
  },
  WorkerEntrypoint: class {
    public readonly env = workerState.env;
  },
}));

describe("build receipt persistence Service Binding", () => {
  beforeEach(() => {
    workerState.env = {};
  });

  it("exports only claim/authorize/put receipt RPC methods and no HTTP handler", async () => {
    const { BuildReceiptPersistenceService } = await import("../src/worker-main.js");
    const service = new BuildReceiptPersistenceService({} as never, workerState.env as never);
    expect(typeof service.claimBuildInput).toBe("function");
    expect(typeof service.authorizeBuildStart).toBe("function");
    expect(typeof service.putBuildReceipt).toBe("function");
    expect("fetch" in service).toBe(false);
    await expect(
      service.claimBuildInput({
        scope: { projectId: "invalid", environmentId: "invalid", operationId: "invalid" },
        inputFingerprint: `sha256:${"a".repeat(64)}`,
        claimId: "00000000-0000-4000-8000-000000000001",
        leaseMilliseconds: 30_000,
      }),
    ).rejects.toThrow("Build receipt persistence is unavailable");
    await expect(
      service.authorizeBuildStart(
        { projectId: "invalid", environmentId: "invalid", operationId: "invalid" },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).rejects.toThrow("Build receipt persistence is unavailable");
    await expect(
      service.putBuildReceipt({
        receipt: {
          buildId: "build",
          projectName: "project",
          scope: { projectId: "invalid", environmentId: "invalid", operationId: "invalid" },
        },
        inputFingerprint: `sha256:${"a".repeat(64)}`,
        claimId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("Build receipt persistence is unavailable");

    // Node-side function coverage of the actual classes/adapter, in addition to the independent real workerd RPC test.
    // Only the cloudflare:workers constructor above is substituted; every command still executes against real D1.
    const control = await createTestControl();
    try {
      const r = await buildRig(control);
      await fundBuild(r);
      workerState.env = control.bindings;
      const { ControlRuntime } = await import("../../control-store/src/worker-main.js");
      const runtime = new ControlRuntime({} as never, control.bindings);
      workerState.env = { CONTROL_RUNTIME: runtime };
      const d1 = new BuildReceiptPersistenceService({} as never, workerState.env as never);
      expect(await d1.claimBuildInput(r.claim as never)).toMatchObject({ status: "claimed" });
      expect(await d1.authorizeBuildStart(r.scope, r.claim.claimId)).toBe(true);
      await d1.putBuildReceipt(r.envelope as never);
      const measured = {
        receipt: r.receipt,
        usage: {
          runner: "cloudflare-build-sandbox" as const,
          instanceType: "standard-3",
          status: "SUCCEEDED",
          startedAt: "2026-10-28T12:00:00.000Z",
          provisioningStartedAt: "2026-10-28T12:00:00.800Z",
          completedAt: "2026-10-28T12:01:57.286Z",
        },
      };
      await d1.putBuildUsage(measured);
      await expect(
        d1.claimBuildInput({ ...r.claim, inputFingerprint: `sha256:${"cd".repeat(32)}` } as never),
      ).rejects.toMatchObject({ code: "build_input_conflict" });
      await expect(
        d1.putBuildUsage({
          ...measured,
          usage: { ...measured.usage, completedAt: "2026-10-28T12:02:00.000Z" },
        }),
      ).rejects.toThrow("Build usage persistence is unavailable");
      await expect(d1.authorizeBuildStart(r.scope, "bad-claim")).rejects.toThrow(
        "Build receipt persistence is unavailable",
      );
      await expect(d1.putBuildReceipt({ ...r.envelope, claimId: "bad" } as never)).rejects.toThrow(
        "Build receipt persistence is unavailable",
      );
      workerState.env = {};
      const missing = new BuildReceiptPersistenceService({} as never, workerState.env as never);
      await expect(missing.claimBuildInput(r.claim as never)).rejects.toThrow(
        "Build receipt persistence is unavailable",
      );
    } finally {
      await control.dispose();
    }
  }, 60_000);

  it("refuses the fifth open build of one organization with the typed capacity error", async () => {
    const control = await createTestControl();
    try {
      const r = await buildRig(control);
      const claims = [r.claim];
      for (let index = 1; index < 5; index += 1) {
        // Five accepted deployments of one organization: each one is a separate open build of that tenant.
        const operation = await seedAcceptedOperation(r.project, r.project.devEnvironmentId, {
          claim: false,
          intent: (operationId) =>
            deploymentIntent(r.project, operationId, r.project.devEnvironmentId, {
              costEstimate: quoteBuildCost("2026-10-28T10:00:00.000Z"),
            }),
        });
        claims.push({
          ...r.claim,
          claimId: cid(),
          scope: {
            projectId: r.project.projectId,
            environmentId: r.project.devEnvironmentId,
            operationId: operation.operationId,
          },
        });
      }
      const { BuildReceiptPersistenceService } = await import("../src/worker-main.js");
      workerState.env = control.bindings;
      const { ControlRuntime } = await import("../../control-store/src/worker-main.js");
      const runtime = new ControlRuntime({} as never, control.bindings);
      workerState.env = { CONTROL_RUNTIME: runtime };
      const d1 = new BuildReceiptPersistenceService({} as never, workerState.env as never);
      for (const claim of claims.slice(0, 4)) {
        await expect(d1.claimBuildInput(claim as never)).resolves.toMatchObject({
          status: "claimed",
        });
      }
      const fifth = claims[4];
      if (fifth === undefined) throw new Error("fixture seeds five operations");
      const refusal = d1.claimBuildInput(fifth as never);
      await expect(refusal).rejects.toBeInstanceOf(BuildCapacityReachedError);
      await expect(refusal).rejects.toMatchObject({ code: "build_capacity_reached" });
    } finally {
      await control.dispose();
    }
  }, 120_000);
});
