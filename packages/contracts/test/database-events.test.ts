import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse } from "yaml";
import {
  assertDatabaseExecutionUsagePage,
  assertDatabaseSchedule,
  assertDatabaseSchedulePage,
  assertDatabaseScheduleDeleted,
  assertDatabaseScheduleRunAccepted,
  assertDatabaseScheduleRunPage,
  assertDatabaseWebhook,
  assertDatabaseWebhookCreated,
  assertDatabaseWebhookDelivery,
  assertDatabaseWebhookDeliveryPage,
  assertDatabaseWebhookDeleted,
  assertDatabaseWebhookPage,
  assertDatabaseWebhookReplayAccepted,
  assertDatabaseWatch,
  assertDatabaseWatchDeleted,
  assertDatabaseWatchPage,
  assertDatabaseWebhookTest,
  assertDatabaseWebhookSubscription,
  assertDatabaseWebhookSubscriptionActivation,
  dataEventTopic,
  isDatabaseWebhookEventTypes,
  parseDatabaseCursor,
  parseDatabaseDeliveryId,
  parseDatabaseEnvironment,
  parseDatabaseListLimit,
  parseDatabaseScheduleName,
  parseDatabaseScheduleSetRequest,
  parseDatabaseUsageWindow,
  parseDatabaseWebhookCreateRequest,
  parseDatabaseWatchCreateRequest,
  parseDatabaseWatchId,
  parseDatabaseWatchTarget,
  parseDatabaseWebhookId,
  parseDatabaseWebhookSubscriptionId,
  parseDatabaseWebhookGeneration,
  DATABASE_EXECUTION_METRICS,
  DATABASE_SCHEDULE_DEFAULT_TIMEOUT_MS,
  DATABASE_WEBHOOK_EVENT_TYPES,
  DATABASE_WEBHOOK_LIMIT,
} from "../src/database-events.js";
import { PROBLEM_POLICY } from "../src/problem-policy.js";

const WEBHOOK_ID = "whk_0123456789abcdefghij";
const DELIVERY_ID = "dlv_0123456789abcdef0123";
const EVENT_ID = "evt_0123456789abcdef0123";
const NOW = "2026-10-30T10:00:00.000Z";
const URL_VALUE = "https://hooks.example.com/ohmyhost";

const webhook = {
  id: WEBHOOK_ID,
  environment: "dev",
  url: URL_VALUE,
  event_types: ["database.ready", "database.deleted"],
  header_names: ["X-Signature-Key"],
  created_at: NOW,
};

it("validates subscription identities, generations and secret-bearing activation shapes", () => {
  const id = "00000000000000000000000001";
  expect(parseDatabaseWebhookSubscriptionId(id)).toBe(id);
  expect(parseDatabaseWebhookGeneration("2")).toBe(2);
  for (const value of ["0", "01", "-1", "9007199254740992", 1, "1e2"])
    expect(() => parseDatabaseWebhookGeneration(value)).toThrow();
  expect(() => parseDatabaseWebhookSubscriptionId("not-an-id")).toThrow();
  const active = {
    id,
    environment: "dev",
    state: "active",
    generation: 1,
    provider_id: WEBHOOK_ID,
  };
  expect(() => assertDatabaseWebhookSubscription(active)).not.toThrow();
  expect(() =>
    assertDatabaseWebhookSubscriptionActivation({ ...active, secret: `whsec_${"s".repeat(43)}` }),
  ).not.toThrow();
  for (const invalid of [
    { ...active, state: "creating" },
    { ...active, state: "deactivating", provider_id: null },
    { ...active, secret: "private" },
    { ...active, extra: true },
  ])
    expect(() => assertDatabaseWebhookSubscription(invalid)).toThrow();
  expect(() =>
    assertDatabaseWebhookSubscriptionActivation({ ...active, secret: "short" }),
  ).toThrow();
});

const delivery = {
  id: DELIVERY_ID,
  event_id: EVENT_ID,
  event_type: "database.ready",
  webhook_id: WEBHOOK_ID,
  state: "dead_lettered",
  attempts: 6,
  created_at: NOW,
  next_attempt_at: null,
  delivered_at: null,
  last_status: 503,
  last_error: "http",
};

const schedule = {
  name: "nightly-report",
  environment: "prod",
  cron: null,
  every_seconds: 3600,
  statements: ["INSERT INTO reports(day) SELECT now()::date"],
  timeout_ms: 10_000,
  enabled: true,
  next_run_at: NOW,
  created_at: NOW,
};

const metrics = Object.fromEntries(DATABASE_EXECUTION_METRICS.map((name) => [name, 0]));

const run = {
  id: 7,
  schedule: "nightly-report",
  scheduled_at: NOW,
  started_at: NOW,
  finished_at: NOW,
  outcome: "succeeded",
  sqlstate: null,
  attempts: 1,
  manual: false,
};

it("parses the webhook create request and rejects project, database, role and unknown keys", () => {
  expect(
    parseDatabaseWebhookCreateRequest({
      url: URL_VALUE,
      event_types: ["database.ready", "database.deleted"],
      headers: { "X-Signature-Key": "abc" },
    }),
  ).toEqual({
    url: URL_VALUE,
    event_types: ["database.ready", "database.deleted"],
    headers: { "X-Signature-Key": "abc" },
  });
  expect(
    parseDatabaseWebhookCreateRequest({ url: URL_VALUE, event_types: ["database.woke"] }),
  ).toEqual({ url: URL_VALUE, event_types: ["database.woke"], headers: {} });
  expect(DATABASE_WEBHOOK_LIMIT).toBe(5);
  for (const candidate of [
    { url: "http://hooks.example.com/x", event_types: ["database.ready"] },
    { url: `https://a.example/${"x".repeat(2048)}`, event_types: ["database.ready"] },
    { url: URL_VALUE, event_types: ["*"] },
    { url: URL_VALUE, event_types: ["operation.failed"] },
    { url: URL_VALUE, event_types: ["database.ready", "database.ready"] },
    { url: URL_VALUE, event_types: [] },
    { url: URL_VALUE, event_types: ["database.ready"], headers: { host: "a" } },
    { url: URL_VALUE, event_types: ["database.ready"], headers: { "pgcf-x": "a" } },
    { url: URL_VALUE, event_types: ["database.ready"], headers: { "X-A": "a\u0001" } },
    { url: URL_VALUE, event_types: ["database.ready"], headers: { "X-A": "a", "x-a": "b" } },
    {
      url: URL_VALUE,
      event_types: ["database.ready"],
      headers: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`X-H${index}`, "v"])),
    },
    { url: URL_VALUE, event_types: ["database.ready"], project_id: "01h00000000000000000000001" },
    { url: URL_VALUE, event_types: ["database.ready"], database_ids: ["a"] },
    { url: URL_VALUE, event_types: ["database.ready"], role: "ohmyho_rw_dev" },
  ])
    expect(() => parseDatabaseWebhookCreateRequest(candidate)).toThrow(TypeError);
  expect(DATABASE_WEBHOOK_EVENT_TYPES).toHaveLength(7);
});

it("parses the schedule request with exactly one cadence and bounded statements", () => {
  expect(
    parseDatabaseScheduleSetRequest({
      cron: "*/5 * * * *",
      statements: ["SELECT 1"],
      confirm: true,
    }),
  ).toEqual({
    cron: "*/5 * * * *",
    every_seconds: null,
    statements: ["SELECT 1"],
    timeout_ms: DATABASE_SCHEDULE_DEFAULT_TIMEOUT_MS,
    enabled: true,
  });
  expect(
    parseDatabaseScheduleSetRequest({
      every_seconds: 60,
      statements: ["SELECT 1"],
      timeout_ms: 30_000,
      enabled: false,
      confirm: true,
    }),
  ).toEqual({
    cron: null,
    every_seconds: 60,
    statements: ["SELECT 1"],
    timeout_ms: 30_000,
    enabled: false,
  });
  const long = "x".repeat(14_000);
  for (const candidate of [
    { cron: "*/5 * * * *", statements: ["SELECT 1"] },
    { cron: "*/5 * * * *", statements: ["SELECT 1"], confirm: false },
    { cron: "*/5 * * * *", every_seconds: 60, statements: ["SELECT 1"], confirm: true },
    { statements: ["SELECT 1"], confirm: true },
    { cron: "*/5 *", statements: ["SELECT 1"], confirm: true },
    { every_seconds: 59, statements: ["SELECT 1"], confirm: true },
    { every_seconds: 2_678_401, statements: ["SELECT 1"], confirm: true },
    { every_seconds: 60, statements: ["SELECT 1"], timeout_ms: 999, confirm: true },
    { every_seconds: 60, statements: ["SELECT 1"], timeout_ms: 30_001, confirm: true },
    { every_seconds: 60, statements: Array(21).fill("SELECT 1"), confirm: true },
    { every_seconds: 60, statements: ["   "], confirm: true },
    { every_seconds: 60, statements: ["x".repeat(16_385)], confirm: true },
    { every_seconds: 60, statements: Array(5).fill(long), confirm: true },
    { every_seconds: 60, statements: ["SELECT\u0000"], confirm: true },
    { every_seconds: 60, statements: ["SELECT 1"], enabled: "yes", confirm: true },
    { every_seconds: 60, statements: ["SELECT 1"], enabled: null, confirm: true },
    { every_seconds: 60, statements: ["SELECT 1"], enabled: 0, confirm: true },
    { every_seconds: 60, statements: ["SELECT 1"], confirm: true, role: "ohmyho_rw_dev" },
    { every_seconds: 60, statements: ["SELECT 1"], confirm: true, database_ids: ["a"] },
  ])
    expect(() => parseDatabaseScheduleSetRequest(candidate)).toThrow(TypeError);
});

it("parses ids, the environment, list limits, cursors and usage windows", () => {
  expect(parseDatabaseEnvironment("dev")).toBe("dev");
  expect(() => parseDatabaseEnvironment("preview")).toThrow(TypeError);
  expect(parseDatabaseWebhookId(WEBHOOK_ID)).toBe(WEBHOOK_ID);
  expect(() => parseDatabaseWebhookId("whk_short")).toThrow(TypeError);
  expect(parseDatabaseDeliveryId(DELIVERY_ID)).toBe(DELIVERY_ID);
  expect(() => parseDatabaseDeliveryId("dlv_0123456789ABCDEF0123")).toThrow(TypeError);
  expect(parseDatabaseScheduleName("nightly-report")).toBe("nightly-report");
  expect(() => parseDatabaseScheduleName("1st")).toThrow(TypeError);

  expect(parseDatabaseListLimit(undefined, 100, 50)).toBe(50);
  expect(parseDatabaseListLimit("20", 50, 20)).toBe(20);
  expect(parseDatabaseListLimit(100, 100, 50)).toBe(100);
  for (const candidate of ["0", "01", "51", 0, 101, "abc"])
    expect(() => parseDatabaseListLimit(candidate, 50, 20)).toThrow(TypeError);

  expect(parseDatabaseCursor(undefined)).toBeNull();
  expect(parseDatabaseCursor(null)).toBeNull();
  expect(parseDatabaseCursor("whk_0123|2026-10-30T10:00:00.000Z")).toBe(
    "whk_0123|2026-10-30T10:00:00.000Z",
  );
  expect(() => parseDatabaseCursor("has space")).toThrow(TypeError);

  expect(
    parseDatabaseUsageWindow("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "day"),
  ).toEqual({
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-11-01T00:00:00.000Z",
    granularity: "day",
  });
  for (const [from, to, granularity] of [
    ["2026-10-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z", "hour"],
    ["2026-10-01T00:00:00.000Z", "2026-10-01T00:30:00.000Z", "hour"],
    ["2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "hour"],
    ["2026-10-01T00:00:00.000Z", "2026-10-01T06:00:00.000Z", "week"],
    ["2026-10-01T00:00:00", "2026-10-01T06:00:00.000Z", "hour"],
    ["2026-10-01T10:00:00.000Z", "2026-10-01T12:00:00.000Z", "day"],
  ])
    expect(() => parseDatabaseUsageWindow(from, to, granularity)).toThrow(TypeError);
});

it("asserts the webhook wire shapes and rejects project scope or unknown events", () => {
  expect(() => assertDatabaseWebhook(webhook)).not.toThrow();
  expect(() =>
    assertDatabaseWebhookCreated({ ...webhook, secret: "whsec_example_secret" }),
  ).not.toThrow();
  expect(() => assertDatabaseWebhookPage({ items: [webhook] })).not.toThrow();
  expect(() => assertDatabaseWebhookDeleted({ id: WEBHOOK_ID, deleted: true })).not.toThrow();
  expect(() => assertDatabaseWebhookDelivery(delivery)).not.toThrow();
  expect(() =>
    assertDatabaseWebhookDeliveryPage({ items: [delivery], next_cursor: null }),
  ).not.toThrow();
  expect(() =>
    assertDatabaseWebhookTest({ delivered: false, status: 500, error: "http", duration_ms: 12 }),
  ).not.toThrow();
  expect(() =>
    assertDatabaseWebhookReplayAccepted({ delivery_id: DELIVERY_ID, state: "pending" }),
  ).not.toThrow();

  for (const candidate of [
    { ...webhook, project_id: "01h00000000000000000000001" },
    { ...webhook, event_types: ["operation.failed"] },
    { ...webhook, url: "http://hooks.example.com" },
    { ...webhook, created_at: "2026-10-30" },
    { ...webhook, environment: "preview" },
    { ...webhook, header_names: ["bad name"] },
  ])
    expect(() => assertDatabaseWebhook(candidate)).toThrow(TypeError);
  expect(() => assertDatabaseWebhookCreated(webhook)).toThrow(TypeError);
  expect(() => assertDatabaseWebhookCreated({ ...webhook, secret: "" })).toThrow(TypeError);
  expect(() => assertDatabaseWebhookPage({ items: Array(101).fill(webhook) })).toThrow(TypeError);
  expect(() => assertDatabaseWebhookDelivery({ ...delivery, event_type: "webhook.test" })).toThrow(
    TypeError,
  );
  expect(() => assertDatabaseWebhookDelivery({ ...delivery, last_error: "boom" })).toThrow(
    TypeError,
  );
  expect(() =>
    assertDatabaseWebhookTest({ delivered: true, status: 200, error: null, duration_ms: -1 }),
  ).toThrow(TypeError);
  expect(() =>
    assertDatabaseWebhookDeliveryPage({ items: [delivery], next_cursor: "bad cursor" }),
  ).toThrow(TypeError);
  expect(() =>
    assertDatabaseWebhookTest({ delivered: true, status: 200, error: "permanent", duration_ms: 1 }),
  ).toThrow(TypeError);
  expect(() => assertDatabaseWebhookDeleted({ id: WEBHOOK_ID, deleted: false })).toThrow(TypeError);
  expect(() =>
    assertDatabaseWebhookReplayAccepted({ delivery_id: DELIVERY_ID, state: "delivered" }),
  ).toThrow(TypeError);
});

it("asserts the schedule, run and execution usage wire shapes", () => {
  expect(() => assertDatabaseSchedule(schedule)).not.toThrow();
  expect(() =>
    assertDatabaseSchedule({ ...schedule, cron: "0 3 * * *", every_seconds: null }),
  ).not.toThrow();
  expect(() => assertDatabaseSchedulePage({ items: [schedule] })).not.toThrow();
  expect(() =>
    assertDatabaseScheduleDeleted({ name: "nightly-report", deleted: true }),
  ).not.toThrow();
  expect(() => assertDatabaseScheduleRunPage({ items: [run] })).not.toThrow();
  expect(() =>
    assertDatabaseScheduleRunPage({
      items: [{ ...run, outcome: "failed", sqlstate: "40001", attempts: 2, manual: true }],
    }),
  ).not.toThrow();
  for (const candidate of [
    { ...run, outcome: "weird" },
    { ...run, sqlstate: 5 },
    { ...run, extra: true },
  ])
    expect(() => assertDatabaseScheduleRunPage({ items: [candidate] })).toThrow(TypeError);
  expect(() => assertDatabaseScheduleRunPage({ items: {} })).toThrow(TypeError);

  const invalidPages: readonly (readonly [(value: unknown) => void, unknown])[] = [
    [assertDatabaseWebhookPage, { items: [{ ...webhook, url: "http://hooks.example.com" }] }],
    [
      assertDatabaseWebhookDeliveryPage,
      { items: [{ ...delivery, state: "queued" }], next_cursor: null },
    ],
    [assertDatabaseSchedulePage, { items: [{ ...schedule, every_seconds: 59 }] }],
    [assertDatabaseScheduleRunPage, { items: [{ ...run, outcome: "weird" }] }],
  ];
  for (const [assertPage, page] of invalidPages) expect(() => assertPage(page)).toThrow(TypeError);
  expect(() =>
    assertDatabaseScheduleRunAccepted({ schedule: "nightly-report", state: "queued" }),
  ).not.toThrow();
  expect(() =>
    assertDatabaseExecutionUsagePage({
      items: [{ start: NOW, end: NOW, final: true, metrics: { ...metrics, events_emitted: 3 } }],
      next_cursor: null,
    }),
  ).not.toThrow();

  for (const candidate of [
    { ...schedule, cron: "0 3 * * *" },
    { ...schedule, every_seconds: null },
    { ...schedule, every_seconds: 59 },
    { ...schedule, timeout_ms: 30_001 },
    { ...schedule, statements: [1] },
    { ...schedule, role: "ohmyho_rw_prod" },
    { ...schedule, environment: "preview" },
  ])
    expect(() => assertDatabaseSchedule(candidate)).toThrow(TypeError);
  expect(() => assertDatabaseScheduleDeleted({ name: "Nightly", deleted: true })).toThrow(
    TypeError,
  );
  expect(() =>
    assertDatabaseScheduleRunAccepted({ schedule: "nightly-report", state: "running" }),
  ).toThrow(TypeError);
  expect(() =>
    assertDatabaseExecutionUsagePage({
      items: [{ start: NOW, end: NOW, final: false, metrics: { ...metrics, events_emitted: -1 } }],
      next_cursor: null,
    }),
  ).toThrow(TypeError);
  expect(() =>
    assertDatabaseExecutionUsagePage({
      items: [{ start: NOW, end: NOW, final: false, metrics: { events_emitted: 1 } }],
      next_cursor: null,
    }),
  ).toThrow(TypeError);
});

it("publishes the database problem codes as 409 and never retryable, so replays are not resent", () => {
  expect(PROBLEM_POLICY.database_webhook_limit).toMatchObject({ status: 409, retryable: false });
  expect(PROBLEM_POLICY.database_schedule_limit).toMatchObject({ status: 409, retryable: false });
  expect(PROBLEM_POLICY.database_schedule_not_runnable).toMatchObject({
    status: 409,
    retryable: false,
  });
  expect(PROBLEM_POLICY.database_webhook_delivery_pending).toMatchObject({
    status: 409,
    retryable: false,
  });
  for (const code of [
    "database_watch_limit",
    "database_watch_table_unavailable",
    "database_watch_column_unavailable",
    "database_watch_events_unavailable",
    "database_watch_conflict",
  ] as const) {
    const policy = PROBLEM_POLICY[code];
    expect(policy).toMatchObject({ status: 409, retryable: false });
    expect(policy.title.length).toBeGreaterThan(0);
    expect(policy.title.length).toBeLessThanOrEqual(160);
    expect(policy.action.length).toBeGreaterThan(0);
    expect(policy.action.length).toBeLessThanOrEqual(480);
  }
});

it("parses the watch id and refuses anything but a pgcf_watch_ trigger name", () => {
  expect(parseDatabaseWatchId("pgcf_watch_0a1b2c3d")).toBe("pgcf_watch_0a1b2c3d");
  for (const value of [
    "pgcf_watch_0A1B2C3D",
    "pgcf_watch_0a1b2c3",
    "whk_abcdefghij0123456789",
    undefined,
  ])
    expect(() => parseDatabaseWatchId(value)).toThrow(TypeError);
});

it("accepts only non-empty, bounded, unique lists of webhook event patterns", () => {
  expect(isDatabaseWebhookEventTypes(["data.orders", "data.*", "database.woke"])).toBe(true);
  for (const value of [
    ["*"],
    [],
    Array.from({ length: 17 }, (_, index) => `data.t${index}`),
    ["data.orders", "data.orders"],
    ["data.Orders"],
    "data.orders",
    undefined,
  ])
    expect(isDatabaseWebhookEventTypes(value)).toBe(false);
});

it("derives the data event topic exactly as pgcf.capture does in SQL", () => {
  const vectors: [string, string][] = [
    ["orders", "orders"],
    ["Orders", "orders"],
    ["order items", "order_items"],
    ["order-items", "order_items"],
    ["Order  Items", "order__items"],
    ["2024_sales", "t_2024_sales"],
    ["_tmp", "t__tmp"],
    ["a".repeat(60), "a".repeat(48)],
    ["1" + "a".repeat(59), "t_1" + "a".repeat(45)],
    ["Café", "caf_"],
    ["日本語", "t____"],
    ["😀orders", "t__orders"],
    // PostgreSQL's builtin C.UTF-8 lower() maps these by simple Unicode lowercasing
    // (check: SELECT lower(U&'\0130'), lower(U&'\212A') answers 'i' and 'k').
    ["\u0130stanbul", "istanbul"],
    ["\u212A", "k"],
    ["a".repeat(48), "a".repeat(48)],
    ["1" + "a".repeat(46), "t_" + "1" + "a".repeat(45)],
  ];
  for (const [table, topic] of vectors) {
    expect(dataEventTopic(table)).toBe(topic);
    expect(topic).toMatch(/^[a-z][a-z0-9_]{0,47}$/u);
  }
});

it("accepts data.* and data.<topic> subscriptions and refuses everything else", () => {
  expect(
    parseDatabaseWebhookCreateRequest({
      url: URL_VALUE,
      event_types: ["data.*", "data.orders"],
    }).event_types,
  ).toEqual(["data.*", "data.orders"]);
  expect(
    parseDatabaseWebhookCreateRequest({
      url: URL_VALUE,
      event_types: ["data.t_2024_sales", "database.woke"],
    }).event_types,
  ).toEqual(["data.t_2024_sales", "database.woke"]);
  for (const eventType of [
    "*",
    "data.",
    "data.Orders",
    "data.1x",
    "data.a-b",
    "data." + "a".repeat(49),
    "data.**",
    "data.*.x",
    "database.*",
    "operation.failed",
  ])
    expect(() =>
      parseDatabaseWebhookCreateRequest({ url: URL_VALUE, event_types: [eventType] }),
    ).toThrow(TypeError);
  expect(() => assertDatabaseWebhook({ ...webhook, event_types: ["*"] })).toThrow(TypeError);
  expect(() =>
    assertDatabaseWebhook({ ...webhook, event_types: ["data.*", "database.ready"] }),
  ).not.toThrow();
  expect(DATABASE_WEBHOOK_EVENT_TYPES).toHaveLength(7);
});

it("accepts data deliveries with the PGCF data event id and refuses wildcards and malformed ids", () => {
  const data = { ...delivery, event_type: "data.orders", event_id: "aaaaaaaaaaaaaaaaaaaa:3:17" };
  expect(() => assertDatabaseWebhookDelivery(data)).not.toThrow();
  for (const override of [
    { event_type: "webhook.test" },
    { event_type: "data.*" },
    { event_id: "aaaaaaaaaaaaaaaaaaaa:03:17" },
    { event_id: "aaaaaaaaaaaaaaaaaaaa:3" },
    { event_id: "AAAAAAAAAAAAAAAAAAAA:3:17" },
    { event_id: "evt_0123456789abcdef012" },
  ])
    expect(() => assertDatabaseWebhookDelivery({ ...data, ...override })).toThrow(TypeError);
});

it("parses the watch create request with schema, columns and canonical operations", () => {
  expect(parseDatabaseWatchCreateRequest({ table: "orders", columns: ["id"] })).toEqual({
    schema: "public",
    table: "orders",
    columns: ["id"],
    operations: ["insert", "update", "delete"],
  });
  expect(
    parseDatabaseWatchCreateRequest({
      table: "orders",
      columns: ["id"],
      operations: ["delete", "insert"],
    }).operations,
  ).toEqual(["insert", "delete"]);
  expect(
    parseDatabaseWatchCreateRequest({
      table: "orders",
      columns: Array.from({ length: 32 }, (_, index) => `c${index}`),
    }).columns,
  ).toHaveLength(32);
  const refused: unknown[] = [
    { table: "orders" },
    { table: "orders", columns: [] },
    { table: "orders", columns: Array.from({ length: 33 }, (_, index) => `c${index}`) },
    { table: "orders", columns: ["id", "id"] },
    { table: "orders", columns: ['a"b'] },
    { table: "orders", columns: ["a.b"] },
    { table: "orders", columns: ["a b"] },
    { table: "orders", columns: ["1a"] },
    { table: "orders", columns: ["a".repeat(64)] },
    { table: "orders", columns: ["é"] },
    { table: "", columns: ["id"] },
    { table: "orders", columns: ["id"], operations: [] },
    { table: "orders", columns: ["id"], operations: ["truncate"] },
    { table: "orders", columns: ["id"], operations: ["insert", "insert"] },
    { table: "orders", columns: ["id"], schema: "pg_catalog" },
    { table: "orders", columns: ["id"], schema: "PG_temp" },
    { table: "orders", columns: ["id"], schema: "information_schema" },
    { table: "orders", columns: ["id"], schema: "pgcf" },
    { table: "orders", columns: ["id"], schema: "PGCF" },
    { table: "orders", columns: ["id"], schema: "ohmyhost" },
    { table: "orders", columns: ["id"], project_id: "p" },
    { table: "orders", columns: ["id"], database_id: "d" },
    { table: "orders", columns: ["id"], role: "app" },
    { table: "orders", columns: ["id"], trigger: "t" },
    { table: "orders", columns: ["id"], environment: "dev" },
    { table: "orders", columns: ["id"], confirm: true },
  ];
  for (const request of refused)
    expect(() => parseDatabaseWatchCreateRequest(request)).toThrow(TypeError);
});

it("parses the watch target and refuses forbidden schemas and extra keys", () => {
  expect(parseDatabaseWatchTarget({ table: "orders" })).toEqual({
    schema: "public",
    table: "orders",
  });
  expect(() => parseDatabaseWatchTarget({ table: "orders", schema: "pgcf" })).toThrow(TypeError);
  expect(() => parseDatabaseWatchTarget({ table: "orders", role: "app" })).toThrow(TypeError);
});

it("asserts the watch wire shapes, the topic binding and the page and deletion limits", () => {
  const watch = {
    id: "pgcf_watch_0a1b2c3d",
    environment: "dev",
    schema: "public",
    table: "orders",
    columns: ["id", "total"],
    operations: ["insert", "update", "delete"],
    topic: "orders",
    event_type: "data.orders",
  };
  expect(() => assertDatabaseWatch(watch)).not.toThrow();
  const refused: unknown[] = [
    { ...watch, topic: "order_items" },
    { ...watch, event_type: "database.orders" },
    { ...watch, id: "pgcf_watch_0A1B2C3D" },
    { ...watch, operations: ["update", "insert", "delete"] },
    { ...watch, operations: ["insert", "insert"] },
    { ...watch, extra: true },
  ];
  for (const value of refused) expect(() => assertDatabaseWatch(value)).toThrow(TypeError);
  expect(() =>
    assertDatabaseWatchPage({ items: Array.from({ length: 101 }, () => watch) }),
  ).toThrow(TypeError);
  expect(() => assertDatabaseWatchPage({ items: [watch] })).not.toThrow();
  expect(() =>
    assertDatabaseWatchDeleted({ id: "pgcf_watch_0a1b2c3d", deleted: true }),
  ).not.toThrow();
  expect(() => assertDatabaseWatchDeleted({ id: "pgcf_watch_0a1b2c3d", deleted: false })).toThrow(
    TypeError,
  );
});

const OPENAPI_CONTRACT_ID = "https://openapi.test/database-events.json";
const openApiDocument = parse(
  readFileSync(fileURLToPath(new URL("../openapi.yaml", import.meta.url)), "utf8"),
) as Record<string, unknown>;

function openApiSchemaValidator(name: string) {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  ajv.addSchema({ $id: OPENAPI_CONTRACT_ID, ...openApiDocument });
  const validate = ajv.getSchema(`${OPENAPI_CONTRACT_ID}#/components/schemas/${name}`);
  if (validate === undefined) throw new Error(`OpenAPI schema ${name} is missing`);
  return validate;
}

it("keeps the OpenAPI watch, webhook and delivery schemas aligned with the runtime assertions", () => {
  const watch = {
    id: "pgcf_watch_0a1b2c3d",
    environment: "dev",
    schema: "public",
    table: "orders",
    columns: ["id", "total"],
    operations: ["insert", "update", "delete"],
    topic: "orders",
    event_type: "data.orders",
  };
  const watchSchema = openApiSchemaValidator("DatabaseWatch");
  expect(watchSchema(watch)).toBe(true);
  expect(() => assertDatabaseWatch(watch)).not.toThrow();
  for (const value of [
    { ...watch, extra: true },
    { ...watch, id: "pgcf_watch_XYZ" },
    { ...watch, topic: "Orders" },
  ]) {
    expect(watchSchema(value)).toBe(false);
    expect(() => assertDatabaseWatch(value)).toThrow(TypeError);
  }
  expect(openApiSchemaValidator("DatabaseWatchPage")({ items: [watch] })).toBe(true);
  expect(
    openApiSchemaValidator("DatabaseWatchDeleted")({ id: "pgcf_watch_0a1b2c3d", deleted: true }),
  ).toBe(true);
  expect(
    openApiSchemaValidator("DatabaseWatchCreateRequest")({
      environment: "dev",
      table: "orders",
      columns: ["id", "total"],
    }),
  ).toBe(true);

  const webhookCreate = openApiSchemaValidator("DatabaseWebhookCreateRequest");
  expect(
    webhookCreate({
      url: URL_VALUE,
      event_types: ["data.orders", "data.*"],
      headers: {},
    }),
  ).toBe(true);
  expect(webhookCreate({ url: URL_VALUE, event_types: ["*"], headers: {} })).toBe(false);
  expect(webhookCreate({ url: URL_VALUE, event_types: ["data.Orders"], headers: {} })).toBe(false);

  const deliverySchema = openApiSchemaValidator("DatabaseWebhookDelivery");
  const dataDelivery = {
    ...delivery,
    event_type: "data.orders",
    event_id: "aaaaaaaaaaaaaaaaaaaa:3:17",
  };
  expect(deliverySchema(dataDelivery)).toBe(true);
  expect(() => assertDatabaseWebhookDelivery(dataDelivery)).not.toThrow();
});

it("documents the watch operations with their scope and idempotency parameters", () => {
  const paths = openApiDocument["paths"] as Record<string, Record<string, unknown>>;
  const watchPath = paths["/v1/projects/{project_id}/database/watches"] as Record<string, unknown>;
  const watchItemPath = paths["/v1/projects/{project_id}/database/watches/{watch_id}"] as Record<
    string,
    unknown
  >;
  const operationIds = (pathItem: Record<string, unknown> | undefined) =>
    Object.values(pathItem ?? {}).map(
      (operation) => (operation as { operationId?: string }).operationId,
    );
  expect(operationIds(watchPath)).toEqual(
    expect.arrayContaining(["createProjectDatabaseWatch", "listProjectDatabaseWatches"]),
  );
  expect(operationIds(watchItemPath)).toContain("deleteProjectDatabaseWatch");
  const parameterRefs = (pathItem: Record<string, unknown>, method: string) =>
    (pathItem[method] as { parameters?: { $ref?: string }[] }).parameters?.map(
      (parameter) => parameter.$ref,
    );
  expect(parameterRefs(watchPath, "get")).toContain(
    "#/components/parameters/DatabaseEnvironmentRead",
  );
  expect(parameterRefs(watchItemPath, "delete")).toEqual(
    expect.arrayContaining([
      "#/components/parameters/DatabaseEnvironment",
      "#/components/parameters/IdempotencyKey",
    ]),
  );
});

it("documents the table create operation with its scope and idempotency parameters", () => {
  const paths = openApiDocument["paths"] as Record<string, Record<string, unknown>>;
  const tablePath = paths["/v1/projects/{project_id}/database/tables"] as Record<string, unknown>;
  expect(Object.keys(tablePath)).toEqual(["post"]);
  expect((tablePath["post"] as { operationId?: string }).operationId).toBe(
    "createProjectDatabaseTable",
  );
  expect(
    (tablePath["post"] as { parameters?: { $ref?: string }[] }).parameters?.map(
      (parameter) => parameter.$ref,
    ),
  ).toContain("#/components/parameters/IdempotencyKey");
});

it("requires and replays the Idempotency-Key of the four retried database routes, and keeps the two secret routes unreplayed with an optional header", () => {
  const paths = openApiDocument["paths"] as Record<
    string,
    Record<
      string,
      {
        parameters?: unknown[];
        responses?: Record<string, unknown>;
        "x-ohmyhost-idempotency"?: { identicalRequest?: string; changedRequest?: string };
      }
    >
  >;
  const replaying: [string, string][] = [
    ["/v1/projects/{project_id}/database/webhooks/{webhook_id}", "delete"],
    ["/v1/projects/{project_id}/database/webhooks/{webhook_id}/test", "post"],
    ["/v1/projects/{project_id}/database/webhook-deliveries/{delivery_id}/replay", "post"],
    ["/v1/projects/{project_id}/database/schedules/{name}/run", "post"],
  ];
  for (const [path, method] of replaying) {
    const operation = paths[path]?.[method];
    expect(operation?.parameters, `${method} ${path}`).toContainEqual({
      $ref: "#/components/parameters/IdempotencyKey",
    });
    expect(operation?.responses, `${method} ${path}`).toHaveProperty("409");
    expect(operation?.["x-ohmyhost-idempotency"], `${method} ${path}`).toEqual({
      canonicalRequestVersion: "v1",
      identicalRequest: "replay-stored-response",
      changedRequest: "409-idempotency-key-reused",
    });
  }
  for (const [path, method] of [
    ["/v1/projects/{project_id}/database/access", "post"],
    ["/v1/projects/{project_id}/dev-access-tickets", "post"],
  ] as const) {
    const parameters = paths[path]?.[method]?.parameters ?? [];
    expect(parameters, `${method} ${path}`).not.toContainEqual({
      $ref: "#/components/parameters/IdempotencyKey",
    });
    expect(parameters, `${method} ${path}`).toContainEqual(
      expect.objectContaining({ name: "Idempotency-Key", in: "header", required: false }),
    );
    expect(paths[path]?.[method], `${method} ${path}`).not.toHaveProperty("x-ohmyhost-idempotency");
  }
});
