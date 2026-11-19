import { WFP_DISPATCH_LIMITS } from "@ohmyhost/contracts/wfp-dispatch";
import type { ClaimedFunctionRun } from "@ohmyhost/database";
import { describe, expect, it, vi } from "vitest";

import { createScheduledDispatch } from "../src/dispatch.js";

const run: ClaimedFunctionRun = {
  runId: "01H00000000000000000000710",
  organizationId: "01H00000000000000000000701",
  projectId: "01H00000000000000000000702",
  environmentId: "01H00000000000000000000704",
  deploymentId: "01H00000000000000000000707",
  immutableScriptName: "p-01h00000000000000000000702-dev-01h00000000000000000000707",
  cron: "0 3 * * *",
  scheduledAt: "2026-09-15T03:00:00.000Z",
  egressAllowedOrigins: ["https://api.example.test"],
  attempt: 1,
  leaseUntil: "2026-09-15T03:02:30.000Z",
};

function binding(status: number | Error) {
  const fetch = vi.fn(async (request: Request) => {
    void request;
    if (status instanceof Error) throw status;
    return new Response(null, { status });
  });
  const get = vi.fn(() => ({ fetch }));
  return { get, fetch };
}

describe("scheduled Dynamic Dispatch", () => {
  it("posts the cron invocation to the internal scheduler origin of the immutable script", async () => {
    for (const environment of ["dev", "prod"] as const) {
      const target = {
        ...run,
        immutableScriptName: `p-${run.projectId.toLowerCase()}-${environment}-${run.deploymentId.toLowerCase()}`,
      };
      const dispatch = binding(204);

      await expect(createScheduledDispatch(dispatch).execute(target)).resolves.toEqual({
        outcome: "succeeded",
        statusCode: 204,
      });

      expect(dispatch.get).toHaveBeenCalledWith(
        target.immutableScriptName,
        {},
        {
          limits: WFP_DISPATCH_LIMITS,
          outbound: {
            EGRESS_CONTEXT: {
              version: 1,
              projectId: run.projectId,
              allowedOrigins: ["https://api.example.test"],
            },
          },
        },
      );
      const request = dispatch.fetch.mock.calls[0]?.[0];
      expect(request?.url).toBe("https://scheduled.ohmyhost.internal/.ohmyhost/scheduled");
      expect(request?.method).toBe("POST");
      expect(request?.headers.get("content-type")).toBe("application/json");
      expect(request?.headers.get("authorization")).toBeNull();
      expect(request?.signal).toBeInstanceOf(AbortSignal);
      await expect(request?.json()).resolves.toEqual({
        cron: "0 3 * * *",
        scheduledTime: Date.UTC(2026, 8, 15, 3, 0, 0),
        immutableScriptName: target.immutableScriptName,
      });
    }

    const invalid: readonly [string, ClaimedFunctionRun][] = [
      ["lowercase project", { ...run, projectId: run.projectId.toLowerCase() }],
      ["lowercase deployment", { ...run, deploymentId: run.deploymentId.toLowerCase() }],
      ["malformed project", { ...run, projectId: "bad" }],
      ["malformed deployment", { ...run, deploymentId: "bad" }],
      [
        "project newline with a matching script",
        {
          ...run,
          projectId: `${run.projectId}\n`,
          immutableScriptName: `p-${run.projectId.toLowerCase()}\n-dev-${run.deploymentId.toLowerCase()}`,
        },
      ],
      [
        "deployment newline with a matching script",
        {
          ...run,
          deploymentId: `${run.deploymentId}\n`,
          immutableScriptName: `${run.immutableScriptName}\n`,
        },
      ],
      [
        "noncanonical project with a matching script",
        {
          ...run,
          projectId: "8".repeat(26),
          immutableScriptName: `p-${"8".repeat(26)}-dev-${run.deploymentId.toLowerCase()}`,
        },
      ],
      [
        "foreign project",
        {
          ...run,
          immutableScriptName: `p-01h00000000000000000000712-dev-${run.deploymentId.toLowerCase()}`,
        },
      ],
      [
        "wrong deployment",
        {
          ...run,
          immutableScriptName: `p-${run.projectId.toLowerCase()}-dev-01h00000000000000000000713`,
        },
      ],
      [
        "invalid environment label",
        { ...run, immutableScriptName: run.immutableScriptName.replace("-dev-", "-preview-") },
      ],
      [
        "noncanonical script",
        { ...run, immutableScriptName: run.immutableScriptName.toUpperCase() },
      ],
      ["trailing newline", { ...run, immutableScriptName: `${run.immutableScriptName}\n` }],
      ["malformed script", { ...run, immutableScriptName: "not-a-candidate" }],
    ];
    for (const [label, target] of invalid) {
      const dispatch = binding(204);
      expect(await createScheduledDispatch(dispatch).execute(target), label).toEqual({
        outcome: "rejected",
        statusCode: 400,
      });
      expect(dispatch.get, label).not.toHaveBeenCalled();
      expect(dispatch.fetch, label).not.toHaveBeenCalled();
    }
  });

  it("retries provider and transport failures but rejects refused invocations", async () => {
    await expect(createScheduledDispatch(binding(500)).execute(run)).resolves.toEqual({
      outcome: "failed",
      statusCode: 500,
    });
    await expect(createScheduledDispatch(binding(503)).execute(run)).resolves.toEqual({
      outcome: "failed",
      statusCode: 503,
    });
    await expect(createScheduledDispatch(binding(429)).execute(run)).resolves.toEqual({
      outcome: "failed",
      statusCode: 429,
    });
    await expect(
      createScheduledDispatch(binding(new DOMException("timeout", "TimeoutError"))).execute(run),
    ).resolves.toEqual({ outcome: "failed", statusCode: null });
    for (const status of [200, 400, 404, 405, 422, 501]) {
      await expect(createScheduledDispatch(binding(status)).execute(run)).resolves.toEqual({
        outcome: "rejected",
        statusCode: status,
      });
    }
  });

  it("aborts an invocation that outlives its deadline", async () => {
    const fetch = vi.fn(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason));
        }),
    );
    const dispatch = createScheduledDispatch({ get: () => ({ fetch }) }, 5);
    await expect(dispatch.execute(run)).resolves.toEqual({ outcome: "failed", statusCode: null });
    expect(() => createScheduledDispatch({ get: () => ({ fetch }) }, 0)).toThrow(
      "timeout is invalid",
    );
  });
});
