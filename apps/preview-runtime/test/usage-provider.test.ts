import { expect, it } from "vitest";
import { observePreviewUsage, resolvePreviewApplication } from "../src/usage-provider.js";

it("selects exactly one scoped application and never turns absent usage into zero", async () => {
  const accountId = "a".repeat(32);
  const application = {
    id: "d".repeat(32),
    account_id: accountId,
    name: "live-preview",
    scheduling_policy: "durable_object",
    durable_objects: { namespace_id: "b".repeat(32) },
  };
  const config = {
    accountId,
    token: "synthetic-test-token",
    applicationName: "live-preview",
    fetch: async () => Response.json({ success: true, result: [application], result_info: {} }),
  };
  expect(await resolvePreviewApplication(config)).toBe("d".repeat(32));
  await expect(
    resolvePreviewApplication({
      ...config,
      fetch: async () =>
        Response.json({ success: true, result: [application, application], result_info: {} }),
    }),
  ).rejects.toThrow("preview_usage_provider_unavailable");
  const run = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 2,
    intervalId: "local-run",
    instanceId: "c".repeat(64),
    startedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T00:00:10.000Z",
  };
  const provider = {
    accountId,
    token: "synthetic-test-token",
    applicationId: "d".repeat(32),
    fetch: async () =>
      Response.json({ data: { viewer: { accounts: [{ containersUsageAdaptiveGroups: [] }] } } }),
  };
  expect(await observePreviewUsage(provider, run)).toEqual({ status: "pending" });
  const dimensions = {
    instanceId: run.instanceId,
    applicationId: provider.applicationId,
    preview: run.previewId,
    runtime: "2",
    run: run.intervalId,
  };
  const observation = await observePreviewUsage(
    {
      ...provider,
      now: () => new Date("2026-01-01T00:01:00.000Z"),
      fetch: async () =>
        Response.json({
          data: {
            viewer: {
              accounts: [
                { containersUsageAdaptiveGroups: [{ dimensions, sum: { cpuTimeSec: 0.1234 } }] },
              ],
            },
          },
        }),
    },
    run,
  );
  expect(observation).toMatchObject({
    status: "observed",
    cpuMilliseconds: 124,
    providerFactId: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
});

it("normalizes REST and telemetry application IDs only at the usage provider boundary", async () => {
  const restId = "245c6f1c55434180915fa7e78470fc10";
  const telemetryId = "245c6f1c-5543-4180-915f-a7e78470fc10";
  const accountId = "a".repeat(32);
  const run = {
    previewId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    runtimeGeneration: 2,
    intervalId: "normalized-run",
    instanceId: "c".repeat(64),
    startedAt: "2026-01-01T00:00:00.000Z",
    closedAt: "2026-01-01T00:00:10.000Z",
  };
  const observedAt = "2026-01-01T00:01:00.000Z";
  for (const [applicationId, returnedId] of [
    [restId, telemetryId],
    [telemetryId, restId],
  ] as const) {
    const observation = await observePreviewUsage(
      {
        accountId,
        applicationId,
        token: "synthetic-test-token",
        now: () => new Date(observedAt),
        fetch: async (request) => {
          const body = await request.json();
          expect(body.variables.application).toBe(telemetryId);
          return Response.json({
            data: {
              viewer: {
                accounts: [
                  {
                    containersUsageAdaptiveGroups: [
                      {
                        dimensions: {
                          applicationId: returnedId,
                          instanceId: run.instanceId,
                          preview: run.previewId,
                          runtime: String(run.runtimeGeneration),
                          run: run.intervalId,
                        },
                        sum: { cpuTimeSec: 0.1234 },
                      },
                    ],
                  },
                ],
              },
            },
          });
        },
      },
      run,
    );
    const pinnedFact = new TextEncoder().encode(
      JSON.stringify([
        "cloudflare.containers-usage/v1",
        accountId,
        applicationId,
        run.instanceId,
        run.previewId,
        run.runtimeGeneration,
        run.intervalId,
        124,
        observedAt,
      ]),
    );
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", pinnedFact));
    expect(observation).toEqual({
      status: "observed",
      cpuMilliseconds: 124,
      observedAt,
      providerFactId: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    });
  }
});
