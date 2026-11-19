import { expect, it } from "vitest";
import { readUsageCalls, parseUsageCursor } from "../src/usage-reader.js";
import { handleGrowthOperatorRequest } from "../src/operator-routes.js";
import type { GrowthD1 } from "../src/event-store.js";

const started = {
  schema_version: 1,
  record_id: "11111111-1111-4111-8111-111111111111",
  invocation_id: "22222222-2222-4222-8222-222222222222",
  parent_invocation_id: null,
  phase: "started",
  occurred_at: "2026-11-16T10:00:00.000Z",
  started_at: "2026-11-16T10:00:00.000Z",
  platform_environment: "production",
  transport: "rest",
  operation: "createProject",
  account_id: "user_1",
  organization_id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
  project_id: null,
  operation_id: null,
  operation_status: null,
  outcome: "started",
  duration_ms: null,
  http_status: null,
  error_code: null,
  platform_version: null,
};
const finished = {
  ...started,
  record_id: "33333333-3333-4333-8333-333333333333",
  phase: "finished",
  occurred_at: "2026-11-16T10:00:01.000Z",
  outcome: "accepted",
  duration_ms: 1000,
  http_status: 202,
  operation_status: "queued",
};
function db(hot: unknown[], indexes: unknown[] = [], deleted: string[] = []): GrowthD1 {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...input: unknown[]) {
          values = input;
          return this;
        },
        async all() {
          if (sql.startsWith("SELECT subject_key FROM growth_subject_suppression"))
            return { results: deleted.map((subject_key) => ({ subject_key })) };
          if (sql.includes("growth_usage_records"))
            return {
              results: (hot as Array<{ seq: number }>)
                .filter((r) => r.seq < (values.at(-2) as number))
                .sort((a, b) => b.seq - a.seq)
                .slice(0, values.at(-1) as number),
            };
          return {
            results: (indexes as Array<{ object_key: string }>)
              .filter((r) => r.object_key > (values.at(-1) as string))
              .sort((a, b) => a.object_key.localeCompare(b.object_key))
              .slice(0, 2),
          };
        },
        async first() {
          return null;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
    },
    async batch() {
      return [];
    },
  } as unknown as GrowthD1;
}

it("folds duplicate starts and finishes and distinguishes acceptance from job status", async () => {
  const hot = [
    { seq: 1, subject_key: "subject", body: JSON.stringify(started) },
    { seq: 2, subject_key: "subject", body: JSON.stringify(finished) },
  ];
  const page = await readUsageCalls(
    db(hot, [{ object_key: "key", subject_key: "subject" }]),
    { read: async () => JSON.stringify(finished) + "\n" },
    { day: "2026-11-16", accountId: null },
  );
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({ result: "Accepted", operation_status: "queued" });
  expect(page.partial).toBe(false);
  const pending = await readUsageCalls(db([hot[0]]), undefined, {
    day: "2026-11-16",
    accountId: null,
  });
  expect(pending.rows[0]?.result).toBe("Completion unobserved in this page/day");
  const deleted: string[] = [];
  const erased = await readUsageCalls(
    db(hot, [{ object_key: "key", subject_key: "subject" }], deleted),
    {
      read: async () => {
        deleted.push("subject");
        return JSON.stringify(finished) + "\n";
      },
    },
    { day: "2026-11-16", accountId: null },
  );
  expect(erased.rows).toEqual([]);
});
it("pages through every buffered record and archive shard and retries unavailable objects", async () => {
  const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const row = (n: number) => ({ ...started, record_id: uid(n), invocation_id: uid(n) });
  const hot = Array.from({ length: 205 }, (_, i) => ({
    seq: i + 1,
    subject_key: "subject",
    body: JSON.stringify(row(i + 1)),
  }));
  const indexes = Array.from({ length: 51 }, (_, i) => ({
    object_key: `usage/v1/subject=${"a".repeat(64)}/day=2026-11-16/${String(i + 1).padStart(64, "0")}.ndjson`,
    subject_key: "subject",
  }));
  const map = new Map(indexes.map((e, i) => [e.object_key, JSON.stringify(row(1000 + i)) + "\n"]));
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 60; page++) {
    const result = await readUsageCalls(
      db(hot, indexes),
      { read: async (key) => map.get(key) ?? null },
      { day: "2026-11-16", accountId: null, cursor },
    );
    result.rows.forEach((r) => seen.add(r.record_id));
    cursor = result.nextCursor ?? null;
    if (!cursor) break;
  }
  expect(cursor).toBeNull();
  expect(seen.size).toBe(256);
  const missing = await readUsageCalls(db([], indexes), undefined, {
    day: "2026-11-16",
    accountId: null,
  });
  expect(missing.partial).toBe(true);
  expect(parseUsageCursor(missing.nextCursor).archive).toBe("");
  expect(() => parseUsageCursor("not-json")).toThrow();
  expect(() => parseUsageCursor('{"hot":-1,"archive":""}')).toThrow();
});

it("requires identity permission and returns no-store calls", async () => {
  const deps = {
    environment: "production" as const,
    authorize: async () => ({ subject: "op", permissions: ["growth.read_aggregate"] }),
    readDashboard: async () => ({ cohorts: [], sources: [] }),
    readUsageCalls: async () => ({ rows: [], partial: false }),
  };
  const request = new Request("https://ops.example/growth/calls?day=2026-11-16");
  expect((await handleGrowthOperatorRequest(request, deps)).status).toBe(403);
  const result = await handleGrowthOperatorRequest(request, {
    ...deps,
    authorize: async () => ({
      subject: "op",
      permissions: ["growth.read_aggregate", "growth.read_identity"],
    }),
  });
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.text()).toContain("job status is separate");
});
