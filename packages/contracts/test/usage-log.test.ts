import { expect, it } from "vitest";
import { parseUsageLogRecord, safeUsageErrorCode, type UsageLogRecord } from "../src/usage-log.js";

it("keeps call metadata closed and distinguishes accepted work from a failed asynchronous job", () => {
  const start: UsageLogRecord = {
    schema_version: 1,
    record_id: crypto.randomUUID(),
    invocation_id: crypto.randomUUID(),
    parent_invocation_id: null,
    phase: "started",
    occurred_at: "2026-11-16T00:00:00.000Z",
    started_at: "2026-11-16T00:00:00.000Z",
    platform_environment: "development",
    transport: "remote_mcp",
    operation: "deployment_create",
    account_id: "user_one",
    organization_id: "00000000000000000000000001",
    project_id: null,
    operation_id: null,
    operation_status: null,
    outcome: "started",
    duration_ms: null,
    http_status: null,
    error_code: null,
    platform_version: null,
  };
  expect(parseUsageLogRecord(start)).toEqual(start);
  const read = {
    ...start,
    phase: "finished",
    outcome: "succeeded",
    duration_ms: 10,
    http_status: 200,
    operation_id: "00000000000000000000000002",
    operation_status: "failed",
  };
  expect(parseUsageLogRecord(read)).toMatchObject({
    outcome: "succeeded",
    operation_status: "failed",
  });
  expect(
    parseUsageLogRecord({
      ...read,
      outcome: "accepted",
      http_status: 202,
      operation_status: "queued",
    }),
  ).toMatchObject({ outcome: "accepted" });
  for (const forbidden of [
    { arguments: { password: "private" } },
    { results: { email: "private@example.test" } },
    { url: "https://example.test/?token=private" },
  ])
    expect(() => parseUsageLogRecord({ ...start, ...forbidden })).toThrow();
  expect(() =>
    parseUsageLogRecord({ ...read, error_code: "private@example.test", outcome: "failed" }),
  ).toThrow();
  expect(() => parseUsageLogRecord({ ...start, organization_id: "org_unverified" })).toThrow();
  expect(() => parseUsageLogRecord({ ...start, duration_ms: 10 })).toThrow();
  expect(safeUsageErrorCode("forbidden")).toBe("forbidden");
  expect(safeUsageErrorCode("private@example.test")).toBe("unknown");
});
