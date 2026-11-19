import type { Operation } from "@ohmyhost/platform";
import { expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { USAGE_OPERATIONS } from "../src/usage-operation-map.js";
import {
  usageOperation,
  setUsageParent,
  createUsageReporter,
  type UsageParent,
} from "../src/usage-log.js";
import { parseUsageLogRecord, type UsageLogRecord } from "@ohmyhost/contracts/usage-log";
import { createControlApi } from "../src/app.js";
import {
  API,
  BEARER,
  ORGANIZATION_ID,
  PROJECT_ID,
  PRINCIPAL,
  OPERATION_ID,
  EVENT_ID,
  NOW,
  FOREIGN_ORGANIZATION_ID,
  routeDependencies,
} from "./helpers/app-routes-fixture.js";

it("records authenticated REST calls with trusted authorized scope and a bounded error without changing the response", async () => {
  const openapi = JSON.parse(
    await readFile(
      new URL("../../../packages/contracts/generated/openapi.json", import.meta.url),
      "utf8",
    ),
  ) as { paths: Record<string, Record<string, { operationId?: string }>> };
  const expected = Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.entries(methods).flatMap(([method, operation]) =>
      operation.operationId ? [[method.toUpperCase(), path, operation.operationId]] : [],
    ),
  );
  expect(USAGE_OPERATIONS).toEqual(expected);
  for (const [method, path, operation] of USAGE_OPERATIONS)
    expect(usageOperation(method, path.replace(/\{[^}]+\}/gu, "00000000000000000000000001"))).toBe(
      operation,
    );
  const records: UsageLogRecord[] = [];
  const deps = routeDependencies({
    usageLog: {
      report: (record) => records.push(record),
      environment: "development",
      version: null,
    },
  });
  const app = createControlApi(deps);
  const response = await app.request(`${API}/v1/projects/${PROJECT_ID}`, { headers: BEARER });
  expect(response.status).toBe(200);
  expect(records).toHaveLength(2);
  records.forEach(parseUsageLogRecord);
  expect(records[1]).toMatchObject({
    operation: "getProject",
    phase: "finished",
    account_id: "user_1",
    organization_id: ORGANIZATION_ID,
    project_id: PROJECT_ID,
    outcome: "succeeded",
  });
  expect(records[0]?.invocation_id).toBe(records[1]?.invocation_id);
  expect(records[0]?.record_id).not.toBe(records[1]?.record_id);
  const fail = createControlApi(
    routeDependencies({
      authorization: { check: async () => "deny" },
      usageLog: {
        report: (record) => records.push(record),
        environment: "development",
        version: null,
      },
    }),
  );
  expect((await fail.request(`${API}/v1/projects/${PROJECT_ID}`, { headers: BEARER })).status).toBe(
    404,
  );
  expect(records.at(-1)).toMatchObject({
    outcome: "failed",
    organization_id: null,
    project_id: null,
    error_code: "resource_not_found",
  });
  const parent: UsageParent = {
    invocation: crypto.randomUUID(),
    scope: { accountId: "user_1", organizationId: ORGANIZATION_ID, projectId: PROJECT_ID },
    ambiguous: false,
    accepted: false,
  };
  const multi = new Request(`${API}/v1/projects`, { headers: BEARER });
  setUsageParent(multi, parent);
  const multiApp = createControlApi(
    routeDependencies({
      authentication: {
        authenticate: async () => ({
          ...PRINCIPAL,
          organizationIds: [ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID],
        }),
      },
      usageLog: { report: (r) => records.push(r), environment: "development", version: null },
    }),
  );
  expect((await multiApp.fetch(multi)).status).toBe(200);
  expect(parent).toMatchObject({
    ambiguous: true,
    scope: { organizationId: null, projectId: null },
  });
  const operationApp = createControlApi(
    routeDependencies({
      persistence: {
        ...deps.persistence,
        getOperation: async () =>
          ({
            operationId: OPERATION_ID,
            projectId: PROJECT_ID,
            state: "failed",
            createdAt: NOW,
            updatedAt: "2026-09-10T10:02:00.000Z",
            failure: { code: "BUILD_FAILED", message: "private-provider-message" },
            events: [
              {
                eventId: EVENT_ID,
                type: "OperationQueued",
                operationId: OPERATION_ID,
                projectId: PROJECT_ID,
                occurredAt: NOW,
              },
              {
                eventId: "0000000000000000000000000A",
                type: "OperationStarted",
                operationId: OPERATION_ID,
                projectId: PROJECT_ID,
                occurredAt: "2026-09-10T10:01:00.000Z",
                idempotencyKey: "start",
              },
              {
                eventId: "0000000000000000000000000B",
                type: "OperationFailed",
                operationId: OPERATION_ID,
                projectId: PROJECT_ID,
                occurredAt: "2026-09-10T10:02:00.000Z",
                idempotencyKey: "fail",
                failure: { code: "BUILD_FAILED", message: "private-provider-message" },
              },
            ],
          }) as unknown as Operation,
      },
      usageLog: { report: (r) => records.push(r), environment: "development", version: null },
    }),
  );
  expect(
    (await operationApp.request(`${API}/v1/operations/${OPERATION_ID}`, { headers: BEARER }))
      .status,
  ).toBe(200);
  expect(records.at(-1)).toMatchObject({
    outcome: "succeeded",
    http_status: 200,
    operation_id: OPERATION_ID,
    operation_status: "failed",
  });
  expect(JSON.stringify(records)).not.toContain("private-provider-message");
  expect(JSON.stringify(records)).not.toContain("Bearer");
  const disabled = createControlApi(
    routeDependencies({
      usageLog: {
        report: () => {
          throw new Error("telemetry offline");
        },
        environment: "development",
        version: null,
      },
    }),
  );
  expect(
    (await disabled.request(`${API}/v1/projects/${PROJECT_ID}`, { headers: BEARER })).status,
  ).toBe(200);
});

it("keeps product work independent of missing, rejected and timed-out usage delivery", async () => {
  const seed: UsageLogRecord[] = [];
  await createControlApi(
    routeDependencies({
      usageLog: { report: (r) => seed.push(r), environment: "development", version: null },
    }),
  ).request(`${API}/v1/projects/${PROJECT_ID}`, { headers: BEARER });
  const captured = seed[0];
  if (!captured) throw new Error("Authenticated observation missing");
  const record: UsageLogRecord = captured;
  async function publish(collector: Parameters<typeof createUsageReporter>[0]) {
    const pending: Promise<unknown>[] = [];
    const counts: string[] = [];
    createUsageReporter(
      collector,
      { waitUntil: (p) => pending.push(p) },
      {
        record: async (input) => {
          counts.push(input.outcome);
        },
      },
    )(record);
    await Promise.all(pending);
    return counts;
  }
  expect(await publish({ collectUsage: async () => ({ accepted: true }) })).toEqual(["offered"]);
  expect(await publish({ collectUsage: async () => ({ accepted: false }) })).toEqual([
    "offered",
    "gap",
  ]);
  expect(await publish(undefined)).toEqual(["offered", "gap"]);
  expect(
    await publish({
      collectUsage: async () => {
        throw new Error("offline");
      },
    }),
  ).toEqual(["offered", "gap"]);
  const pending: Promise<unknown>[] = [];
  const counts: string[] = [];
  vi.useFakeTimers();
  try {
    createUsageReporter(
      { collectUsage: () => new Promise(() => {}) },
      { waitUntil: (p) => pending.push(p) },
      {
        record: async (input) => {
          counts.push(input.outcome);
        },
      },
    )(record);
    await vi.advanceTimersByTimeAsync(2001);
    await Promise.all(pending);
    expect(counts).toEqual(["offered", "gap"]);
  } finally {
    vi.useRealTimers();
  }
  expect(() =>
    createUsageReporter(undefined, {
      waitUntil() {
        throw new Error("closed");
      },
    })(record),
  ).not.toThrow();
  const failedCounts: Promise<unknown>[] = [];
  createUsageReporter(
    undefined,
    { waitUntil: (p) => failedCounts.push(p) },
    {
      record: async () => {
        throw new Error("counter offline");
      },
    },
  )(record);
  await Promise.all(failedCounts);
});
