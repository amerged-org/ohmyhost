import { describe, expect, it } from "vitest";

import {
  createD1DeploymentDiagnosticsPort,
  createD1FunctionRunsPort,
} from "../src/d1-customer-reads.js";

const org = "0".repeat(26),
  project = "1".repeat(26),
  deployment = "2".repeat(26),
  id = "3".repeat(26);

describe("Core customer reads", () => {
  it("maps runs to the public shape and round-trips the diagnostic cursor in its original form", async () => {
    const calls: unknown[] = [];
    const runtime = {
      readEnvironmentFunctionRuns: async () => [
        {
          runId: id,
          deploymentId: deployment,
          cron: "0 4 * * *",
          scheduledAt: "2026-10-29T04:00:00.000Z",
          state: "succeeded",
          attempt: 1,
          statusCode: 204,
          startedAt: null,
          finishedAt: "2026-10-29T04:00:01.000Z",
        },
      ],
      readDeploymentDiagnostics: async (input: unknown) => {
        calls.push(input);
        return {
          items: [
            {
              id,
              source: "control",
              code: "DEPLOYMENT_FAILED",
              catalogMessage: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
              exceptionClass: null,
              sourceFile: null,
              sourceLine: null,
              sourceColumn: null,
              routeTemplate: null,
              requestId: null,
              traceId: null,
              durationMs: null,
              excerpt: null,
              excerptTruncated: null,
              statusCode: null,
              occurredAt: "2026-10-28T10:59:00.123Z",
            },
          ],
          nextBefore: { occurredAt: "2026-10-28T10:59:00.123Z", id },
        };
      },
    };
    expect(
      await createD1FunctionRunsPort(runtime).list({
        organizationId: org,
        projectId: project,
        environmentId: deployment,
        limit: 5,
      } as never),
    ).toEqual({
      items: [
        {
          id,
          deployment_id: deployment,
          cron: "0 4 * * *",
          scheduled_at: "2026-10-29T04:00:00.000Z",
          state: "succeeded",
          attempt: 1,
          status_code: 204,
          started_at: null,
          finished_at: "2026-10-29T04:00:01.000Z",
        },
      ],
    });
    const port = createD1DeploymentDiagnosticsPort(
      runtime,
      () => new Date("2026-10-29T00:00:00.000Z"),
    );
    const first = await port.list({
      organizationId: org,
      projectId: project,
      deploymentId: deployment,
      limit: 1,
    } as never);
    expect(first.items).toEqual([
      {
        id,
        source: "control",
        code: "DEPLOYMENT_FAILED",
        message: "DEPLOYMENT_FAILED_SEE_OPERATION_ERROR",
        occurred_at: "2026-10-28T10:59:00.123Z",
      },
    ]);
    expect(JSON.parse(Buffer.from(first.nextCursor as string, "base64url").toString())).toEqual({
      occurredAt: "2026-10-28T10:59:00.123Z",
      id,
    });
    await port.list({
      organizationId: org,
      projectId: project,
      deploymentId: deployment,
      limit: 1,
      cursor: first.nextCursor,
    } as never);
    expect(calls[1]).toMatchObject({
      now: "2026-10-29T00:00:00.000Z",
      before: { occurredAt: "2026-10-28T10:59:00.123Z", id },
    });
    await expect(
      port.list({
        organizationId: org,
        projectId: project,
        deploymentId: deployment,
        limit: 1,
        cursor: "e30",
      } as never),
    ).rejects.toThrow("Invalid diagnostic cursor");
  });
});
