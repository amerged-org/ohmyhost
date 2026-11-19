import { createHash } from "node:crypto";
import { PROBLEM_POLICY } from "@ohmyhost/contracts/problem-policy";
import { parseUlid } from "@ohmyhost/platform";
import { describe, expect, it } from "vitest";

import {
  createControlApi,
  createProjectDatabaseEventsPort,
  createUnavailableEnvironmentSecretsPort,
  createUnavailableProductSurfacePort,
  createUnavailableProjectMailDomainsPort,
  createUnavailableProviderReconciliationPort,
  ProjectDatabaseEventsError,
  type ControlApiDependencies,
  type ProjectDatabaseEventsBinding,
} from "../src/index.js";
import type { ProjectDatabaseAdmissionRuntime } from "../src/project-database-events.js";
import { parseDatabaseEventsQuery } from "../src/project-database-events.js";

const ORGANIZATION_ID = parseUlid("00000000000000000000000001");
const PROJECT_ID = parseUlid("00000000000000000000000002");
const EVENT_ID = parseUlid("00000000000000000000000003");
const NOW = "2026-10-31T10:00:00.000Z";
const LATER = "2026-10-31T10:05:00.000Z";
const WEBHOOK_ID = "whk_abcdefghij0123456789";
const OTHER_WEBHOOK_ID = "whk_zzzzzzzzzzzzzzzzzzzz";
const DELIVERY_ID = "dlv_0123456789abcdef0123";
const WATCH_ID = "pgcf_watch_0a1b2c3d";
const OTHER_WATCH_ID = "pgcf_watch_ffffffff";
const OTHER_DELIVERY_ID = "dlv_ffffffffffffffffffff";
const SECRET = `whsec_${"s".repeat(43)}`;
const PATH = `https://api.test/v1/projects/${PROJECT_ID}/database`;
const JSON_HEADERS = { Authorization: "Bearer valid", "Content-Type": "application/json" };
const READ_HEADERS = { Authorization: "Bearer valid" };
const WRITE_HEADERS = { ...JSON_HEADERS, "Idempotency-Key": "events-key-0001" };
const METRIC_NAMES = [
  "schedule_runs_succeeded",
  "schedule_runs_failed",
  "schedule_runs_timed_out",
  "schedule_runs_outcome_unknown",
  "schedule_runs_rejected",
  "schedule_runs_skipped",
  "events_emitted",
  "event_bytes",
  "webhook_attempts",
  "webhook_deliveries_delivered",
  "webhook_deliveries_dead_lettered",
];
const METRICS = Object.fromEntries(METRIC_NAMES.map((name) => [name, 0]));

/** Wire shapes copied from the PGCF-derived contract in @ohmyhost/contracts/database-events. */
const WEBHOOK = {
  id: WEBHOOK_ID,
  environment: "dev",
  url: "https://hooks.example.com/ohmyhost",
  event_types: ["database.woke"],
  header_names: ["x-team"],
  created_at: NOW,
};
const CREATED = { ...WEBHOOK, secret: SECRET };
const DELIVERY = {
  id: DELIVERY_ID,
  event_id: "evt_0123456789abcdef0123",
  event_type: "database.woke",
  webhook_id: WEBHOOK_ID,
  state: "dead_lettered",
  attempts: 3,
  created_at: NOW,
  next_attempt_at: null,
  delivered_at: null,
  last_status: 500,
  last_error: "http",
};
const WATCH = {
  id: WATCH_ID,
  environment: "dev",
  schema: "public",
  table: "orders",
  columns: ["id", "total"],
  operations: ["insert", "update", "delete"],
  topic: "orders",
  event_type: "data.orders",
};
const SCHEDULE = {
  name: "nightly_cleanup",
  environment: "dev",
  cron: null,
  every_seconds: 60,
  statements: ["delete from events where created_at < now() - interval '1 day'"],
  timeout_ms: 10_000,
  enabled: true,
  next_run_at: LATER,
  created_at: NOW,
};
const RUN = {
  id: 7,
  schedule: "nightly_cleanup",
  scheduled_at: NOW,
  started_at: NOW,
  finished_at: LATER,
  outcome: "succeeded",
  sqlstate: null,
  attempts: 1,
  manual: false,
};
const USAGE_ROW = { start: NOW, end: LATER, final: true, metrics: METRICS };

type Answer = (input: Readonly<Record<string, unknown>>) => unknown;

/** The RPC answers the neon-management service gives, one per operation. */
const DEFAULT_ANSWERS: Readonly<Record<string, Answer>> = {
  "webhook.create": () => ok(CREATED),
  "webhook.list": () => ok({ items: [WEBHOOK] }),
  "webhook.get": () => ok(WEBHOOK),
  "webhook.delete": () => ok({ id: WEBHOOK_ID, deleted: true }),
  "webhook.test": () => ok({ delivered: true, status: 200, error: null, duration_ms: 12 }),
  "delivery.list": () => ok({ items: [DELIVERY], next_cursor: null }),
  "delivery.replay": () => ok({ delivery_id: DELIVERY_ID, state: "pending" }),
  "schedule.set": () => ok(SCHEDULE),
  "schedule.list": () => ok({ items: [SCHEDULE] }),
  "schedule.get": () => ok(SCHEDULE),
  "schedule.delete": () => ok({ name: "nightly_cleanup", deleted: true }),
  "schedule.runs": () => ok({ items: [RUN] }),
  "schedule.run": () => ok({ schedule: "nightly_cleanup", state: "queued" }),
  "usage.get": () => ok({ items: [USAGE_ROW], next_cursor: null }),
  "watch.create": () => ok(WATCH),
  "watch.list": () => ok({ items: [WATCH] }),
  "watch.delete": () => ok({ id: WATCH_ID, deleted: true }),
};

function ok(value: unknown): { status: "ok"; value: unknown } {
  return { status: "ok", value };
}

const CLOCK = { now: () => new Date(NOW) };
const WATCH_REQUEST = {
  schema: "public",
  table: "orders",
  columns: ["id", "total"],
  operations: ["insert", "update", "delete"],
} as const;

/** The Core's admission answer, admitted unless a test names another; every question the port asks is recorded. */
function admissionOf(answer: unknown = { status: "admitted" }) {
  const questions: Record<string, unknown>[] = [];
  const admission: ProjectDatabaseAdmissionRuntime = {
    readProjectDatabaseAdmission: async (input) => {
      questions.push(input as Record<string, unknown>);
      return answer;
    },
    recordProjectDatabaseEventAudit: async () => ({ recorded: true }),
  };
  return { admission, questions };
}

function eventsBinding(overrides: Readonly<Record<string, Answer>> = {}): {
  binding: ProjectDatabaseEventsBinding;
  inputs: Record<string, unknown>[];
} {
  const inputs: Record<string, unknown>[] = [];
  const answers = { ...DEFAULT_ANSWERS, ...overrides };
  const call = async (input: unknown) => {
    const record = input as Record<string, unknown>;
    inputs.push(record);
    const answer = answers[String(record["operation"])];
    if (answer === undefined) throw new Error("Unexpected database events operation");
    return answer(record);
  };
  return { inputs, binding: { databaseEvents: call, createDatabaseTable: call } };
}

function appWith(
  overrides: Readonly<Record<string, Answer>> = {},
  admission: ProjectDatabaseAdmissionRuntime = admissionOf().admission,
): {
  app: ReturnType<typeof createControlApi>;
  inputs: Record<string, unknown>[];
  reported: { code: string; route: string }[];
} {
  const { binding, inputs } = eventsBinding(overrides);
  const reported: { code: string; route: string }[] = [];
  const app = createControlApi(
    dependencies({
      projectDatabaseEvents: createProjectDatabaseEventsPort(binding, admission, CLOCK),
      reporter: {
        report: (report) => {
          reported.push({ code: report.code, route: report.route });
        },
      },
    }),
  );
  return { app, inputs, reported };
}

describe("Control API project database events", () => {
  it("scopes subscription activation, retry, deactivation and status while keeping the secret out of reads", async () => {
    const subscription = {
        id: EVENT_ID,
        environment: "dev",
        state: "active",
        generation: 1,
        provider_id: WEBHOOK_ID,
      },
      answers = {
        "subscription.activate": () => ok({ ...subscription, secret: SECRET }),
        "subscription.status": () => ok(subscription),
        "subscription.deactivate": () => ok({ ...subscription, state: "inactive" }),
      },
      { app, inputs } = appWith(answers),
      statusPath = `${PATH}/webhook-subscriptions/${EVENT_ID}?environment=dev`,
      activatePath = `${PATH}/webhook-subscriptions/${EVENT_ID}/activations/1?environment=dev`,
      body = JSON.stringify({
        url: "https://hooks.example.com/ohmyhost",
        event_types: ["data.*"],
        headers: { "x-team": "private" },
      });
    for (let i = 0; i < 2; i++) {
      const response = await app.request(activatePath, {
        method: "PUT",
        headers: WRITE_HEADERS,
        body,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ ...subscription, secret: SECRET });
    }
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[0]).toMatchObject({
      operation: "subscription.activate",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      subscriptionId: EVENT_ID,
      generation: 1,
      idempotencyKey: "events-key-0001",
      eventTypes: ["data.*"],
    });
    const read = await app.request(statusPath, { headers: READ_HEADERS });
    expect(await read.json()).toEqual(subscription);
    const malicious = appWith({
      "subscription.status": () => ok({ ...subscription, secret: SECRET }),
    }).app;
    const refused = await malicious.request(statusPath, { headers: READ_HEADERS });
    expect(refused.status).toBe(503);
    expect(await refused.text()).not.toContain(SECRET);
    const deleted = await app.request(activatePath, { method: "DELETE", headers: WRITE_HEADERS });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ...subscription, state: "inactive" });
    const beforeInvalid = inputs.length;
    for (const path of [
      `${PATH}/webhook-subscriptions/${EVENT_ID}/activations/0?environment=dev`,
      `${PATH}/webhook-subscriptions/${EVENT_ID}/activations/01?environment=dev`,
      `${PATH}/webhook-subscriptions/${EVENT_ID}/activations/9007199254740992?environment=dev`,
      `${PATH}/webhook-subscriptions/not-a-ulid/activations/1?environment=dev`,
    ])
      expect(
        (await app.request(path, { method: "PUT", headers: WRITE_HEADERS, body })).status,
      ).toBe(400);
    expect(
      (
        await app.request(activatePath, {
          method: "PUT",
          headers: WRITE_HEADERS,
          body: JSON.stringify({
            url: "https://hooks.example.com/ohmyhost",
            event_types: ["data.*"],
            database_ids: ["foreign"],
          }),
        })
      ).status,
    ).toBe(400);
    expect(
      (await app.request(activatePath, { method: "PUT", headers: JSON_HEADERS, body })).status,
    ).toBe(400);
    expect(inputs).toHaveLength(beforeInvalid);
    const binding = eventsBinding(answers),
      denied = createControlApi(
        dependencies({
          authorization: { check: async () => "deny" },
          projectDatabaseEvents: createProjectDatabaseEventsPort(
            binding.binding,
            admissionOf().admission,
            CLOCK,
          ),
        }),
      );
    expect(
      (await denied.request(activatePath, { method: "PUT", headers: WRITE_HEADERS, body })).status,
    ).toBe(404);
    expect((await denied.request(statusPath, { headers: READ_HEADERS })).status).toBe(404);
    expect(binding.inputs).toEqual([]);
    const foreign = appWith({ "subscription.status": () => ({ status: "absent" }) }).app;
    expect((await foreign.request(statusPath, { headers: READ_HEADERS })).status).toBe(404);
  });

  it("calls the management boundary once per operation with the scope and the request fields", async () => {
    const { binding, inputs } = eventsBinding();
    const port = createProjectDatabaseEventsPort(binding, admissionOf().admission, CLOCK);
    const scope = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:1",
      requestId: "request",
    };
    const request = {
      url: "https://hooks.example.com/ohmyhost",
      event_types: ["database.woke" as const],
      headers: { "x-team": "ops" },
    };

    expect(
      await port.createWebhook({
        ...scope,
        environment: "dev",
        idempotencyKey: "events-key-0001",
        request,
      }),
    ).toEqual(CREATED);
    expect(inputs.at(-1)).toEqual({
      operation: "webhook.create",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      url: request.url,
      eventTypes: ["database.woke"],
      headers: { "x-team": "ops" },
      idempotencyKey: "events-key-0001",
    });
    expect(
      await port.createWebhook({
        ...scope,
        environment: "dev",
        idempotencyKey: "events-key-0002",
        request: { ...request, headers: {} },
      }),
    ).toEqual(CREATED);
    expect(inputs.at(-1)).not.toHaveProperty("headers");

    expect(await port.listWebhooks({ ...scope, environment: "dev" })).toEqual({
      items: [WEBHOOK],
    });
    expect(await port.getWebhook({ ...scope, environment: "dev", webhookId: WEBHOOK_ID })).toEqual(
      WEBHOOK,
    );
    expect(
      await port.deleteWebhook({
        ...scope,
        idempotencyKey: "events-key-0001",
        environment: "dev",
        webhookId: WEBHOOK_ID,
      }),
    ).toEqual({ id: WEBHOOK_ID, deleted: true });
    expect(
      await port.testWebhook({
        ...scope,
        idempotencyKey: "events-key-0001",
        environment: "dev",
        webhookId: WEBHOOK_ID,
      }),
    ).toMatchObject({ delivered: true, status: 200 });
    expect(
      await port.listDeliveries({
        ...scope,
        environment: "dev",
        webhookId: null,
        limit: 50,
        cursor: null,
      }),
    ).toEqual({ items: [DELIVERY], next_cursor: null });
    expect(inputs.at(-1)).toEqual({
      operation: "delivery.list",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      limit: 50,
    });
    expect(
      await port.listDeliveries({
        ...scope,
        environment: "dev",
        webhookId: WEBHOOK_ID,
        limit: 5,
        cursor: "cursor-1",
      }),
    ).toEqual({ items: [DELIVERY], next_cursor: null });
    expect(inputs.at(-1)).toMatchObject({ webhookId: WEBHOOK_ID, limit: 5, cursor: "cursor-1" });
    expect(
      await port.replayDelivery({
        ...scope,
        idempotencyKey: "events-key-0001",
        environment: "dev",
        deliveryId: DELIVERY_ID,
      }),
    ).toEqual({ delivery_id: DELIVERY_ID, state: "pending" });

    expect(
      await port.setSchedule({
        ...scope,
        environment: "dev",
        name: "nightly_cleanup",
        request: {
          cron: null,
          every_seconds: 60,
          statements: ["select 1"],
          timeout_ms: 10_000,
          enabled: true,
        },
      }),
    ).toEqual(SCHEDULE);
    expect(inputs.at(-1)).toEqual({
      operation: "schedule.set",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      name: "nightly_cleanup",
      everySeconds: 60,
      statements: ["select 1"],
      timeoutMs: 10_000,
      enabled: true,
    });
    expect(await port.listSchedules({ ...scope, environment: "dev" })).toEqual({
      items: [SCHEDULE],
    });
    expect(
      await port.getSchedule({ ...scope, environment: "dev", name: "nightly_cleanup" }),
    ).toEqual(SCHEDULE);
    expect(
      await port.deleteSchedule({ ...scope, environment: "dev", name: "nightly_cleanup" }),
    ).toEqual({ name: "nightly_cleanup", deleted: true });
    expect(
      await port.listScheduleRuns({
        ...scope,
        environment: "dev",
        name: "nightly_cleanup",
        limit: 20,
      }),
    ).toEqual({ items: [RUN] });
    expect(
      await port.runSchedule({
        ...scope,
        idempotencyKey: "events-key-0001",
        environment: "dev",
        name: "nightly_cleanup",
      }),
    ).toEqual({ schedule: "nightly_cleanup", state: "queued" });
    expect(
      await port.readExecutionUsage({
        ...scope,
        environment: "dev",
        window: { from: NOW, to: LATER, granularity: "hour" },
        limit: 50,
        cursor: null,
      }),
    ).toEqual({ items: [USAGE_ROW], next_cursor: null });
    expect(inputs.at(-1)).toEqual({
      operation: "usage.get",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      from: NOW,
      to: LATER,
      granularity: "hour",
      limit: 50,
    });
    await port.readExecutionUsage({
      ...scope,
      environment: "dev",
      window: { from: NOW, to: LATER, granularity: "hour" },
      limit: 50,
      cursor: "cursor-2",
    });
    expect(inputs.at(-1)).toMatchObject({ operation: "usage.get", cursor: "cursor-2" });
  });

  it("answers every absent scope with null and every refusal with its code", async () => {
    const absent = Object.fromEntries(
      Object.keys(DEFAULT_ANSWERS).map((operation) => [operation, () => ({ status: "absent" })]),
    );
    const port = createProjectDatabaseEventsPort(
      eventsBinding(absent).binding,
      admissionOf().admission,
      CLOCK,
    );
    const scope = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:1",
      requestId: "request",
      environment: "prod" as const,
    };
    const calls: Array<() => Promise<unknown>> = [
      () =>
        port.createWebhook({
          ...scope,
          idempotencyKey: "events-key-0001",
          request: {
            url: "https://hooks.example.com/x",
            event_types: ["database.woke"],
            headers: {},
          },
        }),
      () => port.listWebhooks(scope),
      () => port.createWatch({ ...scope, request: WATCH_REQUEST }),
      () => port.listWatches(scope),
      () => port.deleteWatch({ ...scope, watchId: WATCH_ID }),
      () => port.getWebhook({ ...scope, webhookId: WEBHOOK_ID }),
      () =>
        port.deleteWebhook({ ...scope, idempotencyKey: "events-key-0001", webhookId: WEBHOOK_ID }),
      () =>
        port.testWebhook({ ...scope, idempotencyKey: "events-key-0001", webhookId: WEBHOOK_ID }),
      () => port.listDeliveries({ ...scope, webhookId: null, limit: 50, cursor: null }),
      () =>
        port.replayDelivery({
          ...scope,
          idempotencyKey: "events-key-0001",
          deliveryId: DELIVERY_ID,
        }),
      () =>
        port.setSchedule({
          ...scope,
          name: "nightly_cleanup",
          request: {
            cron: null,
            every_seconds: 60,
            statements: ["select 1"],
            timeout_ms: 10_000,
            enabled: true,
          },
        }),
      () => port.listSchedules(scope),
      () => port.getSchedule({ ...scope, name: "nightly_cleanup" }),
      () => port.deleteSchedule({ ...scope, name: "nightly_cleanup" }),
      () => port.listScheduleRuns({ ...scope, name: "nightly_cleanup", limit: 20 }),
      () =>
        port.runSchedule({ ...scope, idempotencyKey: "events-key-0001", name: "nightly_cleanup" }),
      () =>
        port.readExecutionUsage({
          ...scope,
          window: { from: NOW, to: LATER, granularity: "hour" },
          limit: 50,
          cursor: null,
        }),
    ];
    for (const call of calls) expect(await call()).toBeNull();

    for (const code of ["webhook_limit", "throttled", "pending"] as const) {
      const refusing = createProjectDatabaseEventsPort(
        eventsBinding({ "webhook.test": () => ({ status: "rejected", code }) }).binding,
        admissionOf().admission,
        CLOCK,
      );
      const failure = await refusing
        .testWebhook({ ...scope, idempotencyKey: "events-key-0001", webhookId: WEBHOOK_ID })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProjectDatabaseEventsError);
      expect(failure).toMatchObject({ code });
    }
  });

  it("rejects an answer whose shape, scope or rejection code is not the contract", async () => {
    const scope = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:1",
      requestId: "request",
    };
    const cases: ReadonlyArray<readonly [Answer, "get" | "list"]> = [
      [() => ({ status: "rejected", code: "unknown_code" }), "get"],
      [() => ({ status: "ok", value: WEBHOOK, extra: true }), "get"],
      [() => ({ status: "ok", value: { ...WEBHOOK, environment: "prod" } }), "get"],
      [() => ({ status: "ok", value: { items: [WEBHOOK] } }), "get"],
      [() => ({ status: "ok", value: WEBHOOK }), "list"],
      [() => ["not", "a", "record"], "list"],
    ];
    for (const [answer, kind] of cases) {
      const port = createProjectDatabaseEventsPort(
        eventsBinding({ "webhook.get": answer, "webhook.list": answer }).binding,
        admissionOf().admission,
        CLOCK,
      );
      const call =
        kind === "get"
          ? port.getWebhook({ ...scope, environment: "dev", webhookId: WEBHOOK_ID })
          : port.listWebhooks({ ...scope, environment: "dev" });
      await expect(call).rejects.toThrow(TypeError);
    }

    // An answer about another object or environment than the one asked for is a scope mismatch.
    const dev = { ...scope, environment: "dev" as const };
    const otherWebhook = { ...WEBHOOK, id: OTHER_WEBHOOK_ID };
    const wrongScope: ReadonlyArray<
      readonly [
        string,
        Answer,
        (port: ReturnType<typeof createProjectDatabaseEventsPort>) => Promise<unknown>,
      ]
    > = [
      [
        "webhook.create",
        () => ok({ ...CREATED, environment: "prod" }),
        (port) =>
          port.createWebhook({
            ...dev,
            idempotencyKey: "events-key-0001",
            request: { url: WEBHOOK.url, event_types: ["database.woke"], headers: {} },
          }),
      ],
      [
        "webhook.list",
        () => ok({ items: [{ ...WEBHOOK, environment: "prod" }] }),
        (port) => port.listWebhooks(dev),
      ],
      [
        "webhook.get",
        () => ok(otherWebhook),
        (port) => port.getWebhook({ ...dev, webhookId: WEBHOOK_ID }),
      ],
      [
        "webhook.delete",
        () => ok({ id: OTHER_WEBHOOK_ID, deleted: true }),
        (port) =>
          port.deleteWebhook({ ...dev, idempotencyKey: "events-key-0001", webhookId: WEBHOOK_ID }),
      ],
      [
        "delivery.list",
        () => ok({ items: [{ ...DELIVERY, webhook_id: OTHER_WEBHOOK_ID }], next_cursor: null }),
        (port) => port.listDeliveries({ ...dev, webhookId: WEBHOOK_ID, limit: 50, cursor: null }),
      ],
      [
        "delivery.replay",
        () => ok({ delivery_id: OTHER_DELIVERY_ID, state: "pending" }),
        (port) =>
          port.replayDelivery({
            ...dev,
            idempotencyKey: "events-key-0001",
            deliveryId: DELIVERY_ID,
          }),
      ],
      [
        "schedule.set",
        () => ok({ ...SCHEDULE, name: "other_schedule" }),
        (port) =>
          port.setSchedule({
            ...dev,
            name: "nightly_cleanup",
            request: {
              cron: null,
              every_seconds: 60,
              statements: ["select 1"],
              timeout_ms: 10_000,
              enabled: true,
            },
          }),
      ],
      [
        "schedule.list",
        () => ok({ items: [{ ...SCHEDULE, environment: "prod" }] }),
        (port) => port.listSchedules(dev),
      ],
      [
        "schedule.get",
        () => ok({ ...SCHEDULE, environment: "prod" }),
        (port) => port.getSchedule({ ...dev, name: "nightly_cleanup" }),
      ],
      [
        "schedule.delete",
        () => ok({ name: "other_schedule", deleted: true }),
        (port) => port.deleteSchedule({ ...dev, name: "nightly_cleanup" }),
      ],
      [
        "schedule.runs",
        () => ok({ items: [{ ...RUN, schedule: "other_schedule" }] }),
        (port) => port.listScheduleRuns({ ...dev, name: "nightly_cleanup", limit: 20 }),
      ],
      [
        "schedule.run",
        () => ok({ schedule: "other_schedule", state: "queued" }),
        (port) =>
          port.runSchedule({ ...dev, idempotencyKey: "events-key-0001", name: "nightly_cleanup" }),
      ],
    ];
    for (const [operation, answer, call] of wrongScope) {
      const port = createProjectDatabaseEventsPort(
        eventsBinding({ [operation]: answer }).binding,
        admissionOf().admission,
        CLOCK,
      );
      await expect(call(port)).rejects.toThrow("Database events scope mismatch");
    }
    expect(() =>
      createProjectDatabaseEventsPort(
        {} as ProjectDatabaseEventsBinding,
        admissionOf().admission,
        CLOCK,
      ),
    ).toThrow("Project database events binding is invalid");
    expect(() =>
      createProjectDatabaseEventsPort(
        eventsBinding().binding,
        {} as ProjectDatabaseAdmissionRuntime,
        CLOCK,
      ),
    ).toThrow("Project database events binding is invalid");
  });

  it("parses the route query only with its own keys, one value each, and defaults the environment to dev", () => {
    expect(
      parseDatabaseEventsQuery(
        new URLSearchParams("environment=prod&limit=5"),
        ["environment", "limit"],
        "optional",
      ),
    ).toEqual({ environment: "prod", values: { limit: "5" } });
    expect(parseDatabaseEventsQuery(new URLSearchParams(), ["limit"], "optional")).toEqual({
      environment: "dev",
      values: {},
    });
    expect(() =>
      parseDatabaseEventsQuery(new URLSearchParams("state=active"), ["environment"], "optional"),
    ).toThrow(TypeError);
    expect(() =>
      parseDatabaseEventsQuery(new URLSearchParams("limit=1&limit=2"), ["limit"], "optional"),
    ).toThrow(TypeError);
    expect(() => parseDatabaseEventsQuery(new URLSearchParams(), [], "required")).toThrow(
      "Database environment is required",
    );
    expect(() =>
      parseDatabaseEventsQuery(new URLSearchParams("environment=staging"), [], "optional"),
    ).toThrow(TypeError);
  });

  it("creates a webhook once with its idempotency key, and shows the secret only in that answer", async () => {
    const { app, inputs } = appWith();
    const response = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        url: "https://hooks.example.com/ohmyhost",
        event_types: ["database.woke"],
        headers: { "x-team": "ops" },
      }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Pragma")).toBe("no-cache");
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.json()).toEqual(CREATED);
    expect(inputs.at(-1)).toMatchObject({
      operation: "webhook.create",
      environment: "dev",
      idempotencyKey: "events-key-0001",
      eventTypes: ["database.woke"],
    });

    const replay = await appWith().app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        url: "https://hooks.example.com/ohmyhost",
        event_types: ["database.woke"],
      }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "invalid_request" });
  });

  it("refuses a create without a key, an environment, a valid body or a platform-side limit", async () => {
    const { app, inputs } = appWith({
      "webhook.create": () => ({ status: "rejected", code: "webhook_limit" }),
    });
    const body = JSON.stringify({
      url: "https://hooks.example.com/ohmyhost",
      event_types: ["database.woke"],
    });
    const noKey = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(noKey.status).toBe(400);
    const noEnvironment = await app.request(`${PATH}/webhooks`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body,
    });
    expect(noEnvironment.status).toBe(400);
    const plainHttp = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ url: "http://hooks.example.com/x", event_types: ["database.woke"] }),
    });
    expect(plainHttp.status).toBe(400);
    const projectField = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        url: "https://hooks.example.com/x",
        event_types: ["database.woke"],
        database_ids: ["x"],
      }),
    });
    expect(projectField.status).toBe(400);
    expect(inputs).toEqual([]);

    const limited = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body,
    });
    expect(limited.status).toBe(409);
    expect(await limited.json()).toMatchObject({
      code: "database_webhook_limit",
      retryable: false,
    });
  });

  it("lists, reads and deletes webhooks by identity and answers an absent one with not found", async () => {
    const { app } = appWith({
      "webhook.get": (input) =>
        input["webhookId"] === WEBHOOK_ID ? ok(WEBHOOK) : { status: "absent" },
      "webhook.delete": (input) =>
        input["webhookId"] === WEBHOOK_ID
          ? ok({ id: WEBHOOK_ID, deleted: true })
          : { status: "absent" },
    });
    const list = await app.request(`${PATH}/webhooks`, { headers: READ_HEADERS });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [WEBHOOK] });

    const one = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`, {
      headers: READ_HEADERS,
    });
    expect(one.status).toBe(200);
    expect(await one.json()).toEqual(WEBHOOK);

    const malformed = await app.request(`${PATH}/webhooks/not-a-webhook`, {
      headers: READ_HEADERS,
    });
    expect(malformed.status).toBe(400);
    const foreign = await app.request(`${PATH}/webhooks/whk_zzzzzzzzzzzzzzzzzzzz`, {
      headers: READ_HEADERS,
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ code: "resource_not_found" });

    const deleted = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: WEBHOOK_ID, deleted: true });
    const withoutEnvironment = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(withoutEnvironment.status).toBe(400);
  });

  it("never returns the signing secret from any answer other than the create", async () => {
    const { app } = appWith({
      "webhook.list": () => ok({ items: [CREATED] }),
      "webhook.get": () => ok(CREATED),
    });
    const list = await app.request(`${PATH}/webhooks`, { headers: READ_HEADERS });
    expect(list.status).toBe(503);
    expect(await list.text()).not.toContain(SECRET);
    const one = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}`, { headers: READ_HEADERS });
    expect(one.status).toBe(503);
    expect(await one.text()).not.toContain(SECRET);
  });

  it("shows a receiver URL whole only to a caller with projects:write, its origin to every other caller and 503 when the check is unavailable", async () => {
    const stored = { ...WEBHOOK, url: "https://hooks.example.com/catch/SECRETTOKEN?k=SECRET2" };
    const appAs = (decide: (action: string) => "allow" | "deny" | "unavailable") => {
      const { binding } = eventsBinding({
        "webhook.list": () => ok({ items: [stored] }),
        "webhook.get": () => ok(stored),
      });
      return createControlApi(
        dependencies({
          authorization: {
            check: async ({ action }) => {
              const decision = decide(action);
              if (decision === "unavailable") throw new Error("Authorization store is down");
              return decision;
            },
          },
          projectDatabaseEvents: createProjectDatabaseEventsPort(
            binding,
            admissionOf().admission,
            CLOCK,
          ),
        }),
      );
    };
    const reader = appAs((action) => (action === "projects:write" ? "deny" : "allow"));
    for (const path of [`${PATH}/webhooks`, `${PATH}/webhooks/${WEBHOOK_ID}`]) {
      const response = await reader.request(path, { headers: READ_HEADERS });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain("SECRETTOKEN");
      expect(text).not.toContain("SECRET2");
      expect(text).toContain('"url":"https://hooks.example.com/"');
    }

    const owner = appAs(() => "allow");
    for (const path of [`${PATH}/webhooks`, `${PATH}/webhooks/${WEBHOOK_ID}`]) {
      const response = await owner.request(path, { headers: READ_HEADERS });
      expect(await response.text()).toContain(`"url":"${stored.url}"`);
    }

    const unavailable = appAs((action) => (action === "projects:write" ? "unavailable" : "allow"));
    const refused = await unavailable.request(`${PATH}/webhooks`, { headers: READ_HEADERS });
    expect(refused.status).toBe(503);
  });

  it("tests a webhook, paces a throttled test with a retry and keeps every other failure opaque", async () => {
    const { app } = appWith({
      "webhook.test": (input) =>
        input["webhookId"] === WEBHOOK_ID
          ? ok({ delivered: false, status: null, error: "timeout", duration_ms: 10_000 })
          : { status: "rejected", code: "throttled" },
    });
    const tested = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}/test?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(tested.status).toBe(200);
    expect(await tested.json()).toEqual({
      delivered: false,
      status: null,
      error: "timeout",
      duration_ms: 10_000,
    });

    const untargeted = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}/test`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(untargeted.status).toBe(400);

    const throttled = await app.request(
      `${PATH}/webhooks/whk_zzzzzzzzzzzzzzzzzzzz/test?environment=dev`,
      { method: "POST", headers: WRITE_HEADERS },
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("5");
    expect(await throttled.json()).toMatchObject({ code: "rate_limited", retry_after_seconds: 5 });
  });

  it("lists deliveries, filters by an owned webhook and bounds the page", async () => {
    const { app, inputs } = appWith();
    const page = await app.request(
      `${PATH}/webhook-deliveries?environment=dev&webhook_id=${WEBHOOK_ID}&limit=10&cursor=c-1`,
      { headers: READ_HEADERS },
    );
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ items: [DELIVERY], next_cursor: null });
    expect(inputs.at(-1)).toMatchObject({
      operation: "delivery.list",
      webhookId: WEBHOOK_ID,
      limit: 10,
      cursor: "c-1",
    });

    const defaults = await app.request(`${PATH}/webhook-deliveries`, { headers: READ_HEADERS });
    expect(defaults.status).toBe(200);
    expect(inputs.at(-1)).toMatchObject({ environment: "dev", limit: 50 });
    expect(inputs.at(-1)).not.toHaveProperty("webhookId");
    expect(inputs.at(-1)).not.toHaveProperty("cursor");

    for (const query of [
      "limit=0",
      "limit=101",
      "limit=abc",
      "webhook_id=bad",
      "cursor=%20",
      "state=x",
    ]) {
      const invalid = await app.request(`${PATH}/webhook-deliveries?${query}`, {
        headers: READ_HEADERS,
      });
      expect(invalid.status).toBe(400);
    }
  });

  it("reports a reused idempotency key and a refusal the boundary calls invalid as their own problems", async () => {
    const { app } = appWith({
      "webhook.create": () => ({ status: "rejected", code: "idempotency_key_reused" }),
      "webhook.delete": () => ({ status: "rejected", code: "invalid" }),
    });
    const body = JSON.stringify({
      url: "https://hooks.example.com/ohmyhost",
      event_types: ["database.woke"],
    });
    const reused = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body,
    });
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "idempotency_key_reused" });

    const invalid = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_request" });
  });

  it("replays a dead-lettered delivery as an accepted request without a location to poll", async () => {
    const { app } = appWith({
      "delivery.replay": (input) =>
        input["deliveryId"] === DELIVERY_ID
          ? ok({ delivery_id: DELIVERY_ID, state: "pending" })
          : { status: "absent" },
    });
    const accepted = await app.request(
      `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay?environment=dev`,
      { method: "POST", headers: WRITE_HEADERS },
    );
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get("Location")).toBeNull();
    expect(await accepted.json()).toEqual({ delivery_id: DELIVERY_ID, state: "pending" });

    const withoutEnvironment = await app.request(
      `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay`,
      { method: "POST", headers: WRITE_HEADERS },
    );
    expect(withoutEnvironment.status).toBe(400);

    const missing = await app.request(
      `${PATH}/webhook-deliveries/dlv_ffffffffffffffffffff/replay?environment=dev`,
      { method: "POST", headers: WRITE_HEADERS },
    );
    expect(missing.status).toBe(404);
  });

  it("maps the delivery still being retried to its own conflict and a pending request to a retryable unavailable", async () => {
    const { app } = appWith({
      "delivery.replay": () => ({ status: "rejected", code: "delivery_pending" }),
    });
    const conflict = await app.request(
      `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay?environment=dev`,
      { method: "POST", headers: WRITE_HEADERS },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "database_webhook_delivery_pending" });

    const busy = createControlApi(
      dependencies({
        projectDatabaseEvents: createProjectDatabaseEventsPort(
          eventsBinding({ "delivery.replay": () => ({ status: "rejected", code: "pending" }) })
            .binding,
          admissionOf().admission,
          CLOCK,
        ),
      }),
    );
    const retry = await busy.request(
      `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay?environment=dev`,
      { method: "POST", headers: WRITE_HEADERS },
    );
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  });

  it("sets, reads, lists, runs and deletes schedules, and refuses an invalid schedule before the boundary", async () => {
    const { app, inputs } = appWith();
    const put = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ every_seconds: 60, statements: ["select 1"], confirm: true }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(SCHEDULE);
    expect(inputs.at(-1)).toMatchObject({
      operation: "schedule.set",
      name: "nightly_cleanup",
      everySeconds: 60,
      timeoutMs: 10_000,
      enabled: true,
    });
    const cron = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ cron: "*/5 * * * *", statements: ["select 1"], confirm: true }),
    });
    expect(cron.status).toBe(200);
    expect(inputs.at(-1)).toMatchObject({ operation: "schedule.set", cron: "*/5 * * * *" });
    expect(inputs.at(-1)).not.toHaveProperty("everySeconds");
    const putWithoutEnvironment = await app.request(`${PATH}/schedules/nightly_cleanup`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ every_seconds: 60, statements: ["select 1"], confirm: true }),
    });
    expect(putWithoutEnvironment.status).toBe(400);

    const badTimeout = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        every_seconds: 60,
        statements: ["select 1"],
        timeout_ms: 90_000,
        confirm: true,
      }),
    });
    expect(badTimeout.status).toBe(400);
    const unconfirmed = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ every_seconds: 60, statements: ["select 1"] }),
    });
    expect(unconfirmed.status).toBe(400);

    const list = await app.request(`${PATH}/schedules`, { headers: READ_HEADERS });
    expect(await list.json()).toEqual({ items: [SCHEDULE] });
    const one = await app.request(`${PATH}/schedules/nightly_cleanup`, { headers: READ_HEADERS });
    expect(await one.json()).toEqual(SCHEDULE);
    const runs = await app.request(`${PATH}/schedules/nightly_cleanup/runs?limit=5`, {
      headers: READ_HEADERS,
    });
    expect(runs.status).toBe(200);
    expect(await runs.json()).toEqual({ items: [RUN] });
    expect(inputs.at(-1)).toMatchObject({ operation: "schedule.runs", limit: 5 });
    const badName = await app.request(`${PATH}/schedules/Nightly`, { headers: READ_HEADERS });
    expect(badName.status).toBe(400);

    const run = await app.request(`${PATH}/schedules/nightly_cleanup/run?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(run.status).toBe(202);
    expect(run.headers.get("Location")).toBeNull();
    expect(await run.json()).toEqual({ schedule: "nightly_cleanup", state: "queued" });

    const deleted = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "DELETE",
      headers: READ_HEADERS,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ name: "nightly_cleanup", deleted: true });
    const deletedWithoutEnvironment = await app.request(`${PATH}/schedules/nightly_cleanup`, {
      method: "DELETE",
      headers: READ_HEADERS,
    });
    expect(deletedWithoutEnvironment.status).toBe(400);
    const runWithoutEnvironment = await app.request(`${PATH}/schedules/nightly_cleanup/run`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(runWithoutEnvironment.status).toBe(400);
  });

  it("maps schedule limits, a schedule that cannot run now and an absent schedule to their answers", async () => {
    const limited = appWith({
      "schedule.set": () => ({ status: "rejected", code: "schedule_limit" }),
    }).app;
    const setLimit = await limited.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ every_seconds: 60, statements: ["select 1"], confirm: true }),
    });
    expect(setLimit.status).toBe(409);
    expect(await setLimit.json()).toMatchObject({ code: "database_schedule_limit" });

    const { app } = appWith({
      "schedule.run": () => ({ status: "rejected", code: "schedule_not_runnable" }),
      "schedule.get": () => ({ status: "absent" }),
    });
    const notRunnable = await app.request(`${PATH}/schedules/nightly_cleanup/run?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(notRunnable.status).toBe(409);
    expect(await notRunnable.json()).toMatchObject({ code: "database_schedule_not_runnable" });
    const absent = await app.request(`${PATH}/schedules/nightly_cleanup`, {
      headers: READ_HEADERS,
    });
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ code: "resource_not_found" });
  });

  it("reads execution usage in a bounded UTC window and rejects a window that is not aligned or too long", async () => {
    const { app, inputs } = appWith();
    const usage = await app.request(
      `${PATH}/execution-usage?from=${NOW}&to=2026-10-31T11:00:00.000Z&granularity=hour&limit=10&cursor=page-2`,
      { headers: READ_HEADERS },
    );
    expect(usage.status).toBe(200);
    expect(await usage.json()).toEqual({ items: [USAGE_ROW], next_cursor: null });
    expect(inputs.at(-1)).toMatchObject({
      operation: "usage.get",
      granularity: "hour",
      limit: 10,
      cursor: "page-2",
    });

    for (const query of [
      `from=${NOW}&to=${NOW}&granularity=hour`,
      `from=2026-10-31T10:30:00.000Z&to=2026-10-31T11:00:00.000Z&granularity=hour`,
      `from=2026-01-01T00:00:00.000Z&to=2026-10-31T11:00:00.000Z&granularity=day`,
      `from=${NOW}&granularity=hour`,
      `from=${NOW}&to=${LATER}&granularity=week`,
    ]) {
      const invalid = await app.request(`${PATH}/execution-usage?${query}`, {
        headers: READ_HEADERS,
      });
      expect(invalid.status).toBe(400);
    }
  });

  it("hides a denied project behind not found and reports an unexpected boundary failure under the template route label", async () => {
    const denied = createControlApi(
      dependencies({
        authorization: { check: async () => "deny" as const },
        projectDatabaseEvents: createProjectDatabaseEventsPort(
          eventsBinding().binding,
          admissionOf().admission,
          CLOCK,
        ),
      }),
    );
    const response = await denied.request(`${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`, {
      headers: READ_HEADERS,
    });
    expect(response.status).toBe(404);

    const { app, reported } = appWith({
      "webhook.get": () => ({ status: "ok", value: { ...WEBHOOK, environment: "prod" } }),
    });
    const mismatch = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`, {
      headers: READ_HEADERS,
    });
    expect(mismatch.status).toBe(503);
    const foreignReplay = appWith({
      "delivery.replay": () => ok({ delivery_id: OTHER_DELIVERY_ID, state: "pending" }),
    }).app;
    const replayed = await foreignReplay.request(
      `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay?environment=dev`,
      { method: "POST", headers: WRITE_HEADERS },
    );
    expect(replayed.status).toBe(503);
    expect(reported.at(-1)).toEqual({
      code: "PRODUCT_SURFACE_UNAVAILABLE",
      route: "/v1/projects/{project_id}/database/webhooks/{webhook_id}",
    });
  });
});

describe("Control API database watches", () => {
  const scope = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    principalId: "user:1",
    requestId: "request",
    environment: "dev" as const,
  };
  const createBody = { environment: "dev", table: "orders", columns: ["id", "total"] };

  it("creates, lists and deletes watches through the boundary with exactly the RPC fields", async () => {
    const { binding, inputs } = eventsBinding();
    const port = createProjectDatabaseEventsPort(binding, admissionOf().admission, CLOCK);

    expect(await port.createWatch({ ...scope, request: WATCH_REQUEST })).toEqual(WATCH);
    expect(inputs.at(-1)).toEqual({
      operation: "watch.create",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      schema: "public",
      table: "orders",
      columns: ["id", "total"],
      operations: ["insert", "update", "delete"],
    });
    expect(await port.listWatches(scope)).toEqual({ items: [WATCH] });
    expect(inputs.at(-1)).toMatchObject({ operation: "watch.list", environment: "dev" });
    expect(await port.deleteWatch({ ...scope, watchId: WATCH_ID })).toEqual({
      id: WATCH_ID,
      deleted: true,
    });
    expect(inputs.slice(-2).map((input) => input["operation"])).toEqual([
      "watch.list",
      "watch.delete",
    ]);
    expect(inputs.at(-1)).toEqual({
      operation: "watch.delete",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      environment: "dev",
      schema: "public",
      table: "orders",
    });
  });

  it("answers null for every absent watch answer and deletes nothing for an id the list does not return", async () => {
    const absent = eventsBinding({
      "watch.create": () => ({ status: "absent" }),
      "watch.list": () => ({ status: "absent" }),
      "watch.delete": () => ({ status: "absent" }),
    });
    const port = createProjectDatabaseEventsPort(absent.binding, admissionOf().admission, CLOCK);
    expect(await port.createWatch({ ...scope, request: WATCH_REQUEST })).toBeNull();
    expect(await port.listWatches(scope)).toBeNull();
    expect(await port.deleteWatch({ ...scope, watchId: WATCH_ID })).toBeNull();

    const empty = eventsBinding({ "watch.list": () => ok({ items: [] }) });
    const emptyPort = createProjectDatabaseEventsPort(
      empty.binding,
      admissionOf().admission,
      CLOCK,
    );
    expect(await emptyPort.deleteWatch({ ...scope, watchId: OTHER_WATCH_ID })).toBeNull();
    expect(empty.inputs.map((input) => input["operation"])).toEqual(["watch.list"]);
  });

  it("maps every watch refusal to its code and refuses a rejection code outside the contract", async () => {
    for (const code of [
      "watch_table_unavailable",
      "watch_column_unavailable",
      "watch_events_unavailable",
      "watch_conflict",
      "watch_limit",
      "pending",
    ]) {
      const { binding } = eventsBinding({
        "watch.create": () => ({ status: "rejected", code }),
      });
      const port = createProjectDatabaseEventsPort(binding, admissionOf().admission, CLOCK);
      const failure = await port
        .createWatch({ ...scope, request: WATCH_REQUEST })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProjectDatabaseEventsError);
      expect(failure).toMatchObject({ code });
    }
    const unknown = createProjectDatabaseEventsPort(
      eventsBinding({ "watch.list": () => ({ status: "rejected", code: "watch_other" }) }).binding,
      admissionOf().admission,
      CLOCK,
    );
    await expect(unknown.listWatches(scope)).rejects.toThrow(TypeError);
  });

  it("refuses watch answers about another environment, table, id or with an extra key", async () => {
    const other = (overrides: Record<string, unknown>) =>
      createProjectDatabaseEventsPort(
        eventsBinding({ "watch.create": () => ok({ ...WATCH, ...overrides }) }).binding,
        admissionOf().admission,
        CLOCK,
      );
    await expect(
      other({ environment: "prod" }).createWatch({ ...scope, request: WATCH_REQUEST }),
    ).rejects.toThrow("Database events scope mismatch");
    await expect(
      other({ table: "invoices", topic: "invoices", event_type: "data.invoices" }).createWatch({
        ...scope,
        request: WATCH_REQUEST,
      }),
    ).rejects.toThrow("Database events scope mismatch");
    await expect(
      other({ schema: "sales" }).createWatch({ ...scope, request: WATCH_REQUEST }),
    ).rejects.toThrow("Database events scope mismatch");
    await expect(
      other({ secret: "x" }).createWatch({ ...scope, request: WATCH_REQUEST }),
    ).rejects.toThrow(TypeError);

    const listWith = (items: unknown) =>
      createProjectDatabaseEventsPort(
        eventsBinding({ "watch.list": () => ok(items) }).binding,
        admissionOf().admission,
        CLOCK,
      );
    await expect(
      listWith({ items: [{ ...WATCH, secret: "x" }] }).listWatches(scope),
    ).rejects.toThrow(TypeError);
    await expect(listWith({ items: [WATCH], extra: 1 }).listWatches(scope)).rejects.toThrow(
      TypeError,
    );
    await expect(
      listWith({ items: [{ ...WATCH, secret: "x" }] }).deleteWatch({ ...scope, watchId: WATCH_ID }),
    ).rejects.toThrow(TypeError);

    const deleteWith = (answer: unknown) =>
      createProjectDatabaseEventsPort(
        eventsBinding({ "watch.delete": () => ok(answer) }).binding,
        admissionOf().admission,
        CLOCK,
      ).deleteWatch({ ...scope, watchId: WATCH_ID });
    await expect(deleteWith({ id: WATCH_ID, deleted: true, secret: "x" })).rejects.toThrow(
      TypeError,
    );
    await expect(deleteWith({ id: WATCH_ID, deleted: false })).rejects.toThrow(TypeError);

    const foreignList = createProjectDatabaseEventsPort(
      eventsBinding({
        "watch.list": () => ok({ items: [{ ...WATCH, environment: "prod" }] }),
      }).binding,
      admissionOf().admission,
      CLOCK,
    );
    await expect(foreignList.listWatches(scope)).rejects.toThrow("Database events scope mismatch");

    const foreignDelete = createProjectDatabaseEventsPort(
      eventsBinding({ "watch.delete": () => ok({ id: OTHER_WATCH_ID, deleted: true }) }).binding,
      admissionOf().admission,
      CLOCK,
    );
    await expect(foreignDelete.deleteWatch({ ...scope, watchId: WATCH_ID })).rejects.toThrow(
      "Database events scope mismatch",
    );
  });

  it("refuses a create that the budget admission does not admit, before the binding is touched, with the Core's reason", async () => {
    for (const code of ["project_budget_exceeded", "insufficient_organization_credits"]) {
      const { binding, inputs } = eventsBinding();
      const port = createProjectDatabaseEventsPort(
        binding,
        admissionOf({ status: "rejected", code }).admission,
        CLOCK,
      );
      await expect(port.createWatch({ ...scope, request: WATCH_REQUEST })).rejects.toMatchObject({
        code,
      });
      await expect(port.deleteWatch({ ...scope, watchId: WATCH_ID })).rejects.toMatchObject({
        code,
      });
      expect(inputs).toEqual([]);
    }
  });

  it("answers null for a scope the Core does not know, asks the admission question before any watch list and refuses a list while the budget is reached", async () => {
    const unknown = admissionOf({ status: "rejected", code: "organization_credit_scope_missing" });
    const { binding, inputs } = eventsBinding();
    const port = createProjectDatabaseEventsPort(binding, unknown.admission, CLOCK);
    await expect(port.createWatch({ ...scope, request: WATCH_REQUEST })).resolves.toBeNull();
    await expect(port.deleteWatch({ ...scope, watchId: WATCH_ID })).resolves.toBeNull();
    await expect(port.listWatches(scope)).resolves.toBeNull();
    expect(inputs).toEqual([]);
    expect(unknown.questions).toEqual([
      { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, environment: "dev", now: NOW },
      { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, environment: "dev", now: NOW },
      { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, environment: "dev", now: NOW },
    ]);

    const reached = admissionOf({ status: "rejected", code: "project_budget_exceeded" });
    const refused = eventsBinding();
    const refusing = createProjectDatabaseEventsPort(refused.binding, reached.admission, CLOCK);
    await expect(refusing.listWatches(scope)).rejects.toMatchObject({
      code: "project_budget_exceeded",
    });
    expect(refused.inputs).toEqual([]);
    expect(reached.questions).toEqual([
      { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, environment: "dev", now: NOW },
    ]);

    const listing = eventsBinding();
    const admittedPort = createProjectDatabaseEventsPort(
      listing.binding,
      admissionOf().admission,
      CLOCK,
    );
    await expect(admittedPort.listWatches(scope)).resolves.toEqual({ items: [WATCH] });
    expect(listing.inputs.map((input) => input["operation"])).toEqual(["watch.list"]);
  });

  it("answers 201 with no-store for a watch create, and the RPC carries the schema and the operations", async () => {
    const { app, inputs } = appWith();
    const response = await app.request(`${PATH}/watches`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(WATCH);
    expect(inputs.at(-1)).toMatchObject({
      operation: "watch.create",
      environment: "dev",
      schema: "public",
      table: "orders",
      columns: ["id", "total"],
      operations: ["insert", "update", "delete"],
    });
    expect(inputs.at(-1)).not.toHaveProperty("idempotencyKey");
  });

  it("refuses every malformed watch create before the boundary", async () => {
    const { app, inputs } = appWith();
    const valid = { ...createBody };
    const cases: Array<{ path: string; headers: Record<string, string>; body: string }> = [
      { path: "", headers: JSON_HEADERS, body: JSON.stringify(valid) },
      {
        path: "",
        headers: WRITE_HEADERS,
        body: JSON.stringify({ table: "orders", columns: ["id"] }),
      },
      { path: "?environment=dev", headers: WRITE_HEADERS, body: JSON.stringify(valid) },
      { path: "", headers: WRITE_HEADERS, body: JSON.stringify({ ...valid, project_id: "p" }) },
      { path: "", headers: WRITE_HEADERS, body: JSON.stringify({ ...valid, role: "app" }) },
      { path: "", headers: WRITE_HEADERS, body: JSON.stringify({ ...valid, trigger: "t" }) },
      { path: "", headers: WRITE_HEADERS, body: JSON.stringify({ ...valid, columns: [] }) },
      {
        path: "",
        headers: WRITE_HEADERS,
        body: JSON.stringify({ ...valid, columns: ["id", "id"] }),
      },
      {
        path: "",
        headers: WRITE_HEADERS,
        body: JSON.stringify({ ...valid, columns: Array.from({ length: 33 }, (_, i) => `c${i}`) }),
      },
      { path: "", headers: WRITE_HEADERS, body: JSON.stringify({ ...valid, table: '"orders"' }) },
      { path: "", headers: WRITE_HEADERS, body: JSON.stringify({ ...valid, schema: "pgcf" }) },
      {
        path: "",
        headers: WRITE_HEADERS,
        body: JSON.stringify({ ...valid, schema: "pg_catalog" }),
      },
      { path: "", headers: WRITE_HEADERS, body: "[]" },
    ];
    for (const item of cases) {
      const response = await app.request(`${PATH}/watches${item.path}`, {
        method: "POST",
        headers: item.headers,
        body: item.body,
      });
      expect(response.status).toBe(400);
    }
    expect(inputs).toEqual([]);
  });

  it("lists watches of dev by default and of the environment asked, and refuses any other query key", async () => {
    const { app, inputs } = appWith();
    const dev = await app.request(`${PATH}/watches`, { headers: READ_HEADERS });
    expect(dev.status).toBe(200);
    expect(await dev.json()).toEqual({ items: [WATCH] });
    expect(inputs.at(-1)).toMatchObject({ operation: "watch.list", environment: "dev" });
    const prodApp = appWith({
      "watch.list": () => ok({ items: [{ ...WATCH, environment: "prod" }] }),
    }).app;
    const prod = await prodApp.request(`${PATH}/watches?environment=prod`, {
      headers: READ_HEADERS,
    });
    expect(prod.status).toBe(200);
    expect(await prod.json()).toEqual({ items: [{ ...WATCH, environment: "prod" }] });
    const other = await app.request(`${PATH}/watches?table=orders`, { headers: READ_HEADERS });
    expect(other.status).toBe(400);
  });

  it("deletes a listed watch by its id and refuses the other inputs with 400 or not found", async () => {
    const { app, inputs } = appWith();
    const deleted = await app.request(`${PATH}/watches/${WATCH_ID}?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ id: WATCH_ID, deleted: true });
    expect(inputs.slice(-2).map((input) => input["operation"])).toEqual([
      "watch.list",
      "watch.delete",
    ]);
    expect(inputs.at(-1)).toMatchObject({ schema: "public", table: "orders" });

    const noEnvironment = await app.request(`${PATH}/watches/${WATCH_ID}`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(noEnvironment.status).toBe(400);
    const noKey = await app.request(`${PATH}/watches/${WATCH_ID}?environment=dev`, {
      method: "DELETE",
      headers: READ_HEADERS,
    });
    expect(noKey.status).toBe(400);
    const malformed = await app.request(`${PATH}/watches/whk_x?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(malformed.status).toBe(400);
    const unlisted = await app.request(`${PATH}/watches/${OTHER_WATCH_ID}?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(unlisted.status).toBe(404);
    expect(await unlisted.json()).toMatchObject({ code: "resource_not_found" });
    expect(inputs.filter((input) => input["operation"] === "watch.delete")).toHaveLength(1);
  });

  it("hides a denied project behind not found and reports a scope mismatch under the template label", async () => {
    const denied = createControlApi(
      dependencies({
        authorization: { check: async () => "deny" as const },
        projectDatabaseEvents: createProjectDatabaseEventsPort(
          eventsBinding().binding,
          admissionOf().admission,
          CLOCK,
        ),
      }),
    );
    const hidden = await denied.request(`${PATH}/watches?environment=dev`, {
      headers: READ_HEADERS,
    });
    expect(hidden.status).toBe(404);

    const { app, reported } = appWith({
      "watch.list": () => ok({ items: [{ ...WATCH, environment: "prod" }] }),
    });
    const mismatch = await app.request(`${PATH}/watches/${WATCH_ID}?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(mismatch.status).toBe(503);
    expect(reported.at(-1)).toEqual({
      code: "PRODUCT_SURFACE_UNAVAILABLE",
      route: "/v1/projects/{project_id}/database/watches/{watch_id}",
    });
  });

  it("maps every watch refusal to its own problem, with the policy text and fixed details", async () => {
    const cases: Array<[string, string]> = [
      [
        "watch_table_unavailable",
        "The table does not exist in this database, is not an ordinary table owned by the application, or is in a schema that cannot be watched.",
      ],
      ["watch_column_unavailable", "A listed column does not exist in the table."],
      [
        "watch_events_unavailable",
        "The platform event schema is not installed in this database yet.",
      ],
      [
        "watch_conflict",
        "The table already has a different capture trigger, or the watch name is taken by another trigger.",
      ],
      ["watch_limit", "This database already has the maximum number of watches."],
    ];
    for (const [rejection, detail] of cases) {
      const { app } = appWith({
        "watch.create": () => ({ status: "rejected", code: rejection }),
      });
      const response = await app.request(`${PATH}/watches`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: JSON.stringify(createBody),
      });
      const code = `database_${rejection}`;
      expect(response.status).toBe(409);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        code,
        retryable: false,
        detail,
        title: PROBLEM_POLICY[code as keyof typeof PROBLEM_POLICY].title,
        suggested_action: PROBLEM_POLICY[code as keyof typeof PROBLEM_POLICY].action,
      });
    }
  });

  it("answers a pending watch with a neutral retryable unavailable", async () => {
    const { app } = appWith({ "watch.create": () => ({ status: "rejected", code: "pending" }) });
    const response = await app.request(`${PATH}/watches`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "service_unavailable",
      retryable: true,
      detail: "The database event request is still being processed. Retry shortly.",
    });
  });

  it("answers 402 with the Core's reason for a watch list, a watch create and a watch delete while the budget is reached", async () => {
    const reached = admissionOf({ status: "rejected", code: "project_budget_exceeded" });
    const { app, inputs } = appWith({}, reached.admission);
    const list = await app.request(`${PATH}/watches`, { headers: READ_HEADERS });
    expect(list.status).toBe(402);
    expect(await list.json()).toMatchObject({ code: "project_budget_exceeded" });
    const create = await app.request(`${PATH}/watches`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(createBody),
    });
    expect(create.status).toBe(402);
    expect(await create.json()).toMatchObject({ code: "project_budget_exceeded" });
    const remove = await app.request(`${PATH}/watches/${WATCH_ID}?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(remove.status).toBe(402);
    expect(await remove.json()).toMatchObject({ code: "project_budget_exceeded" });
    expect(inputs).toEqual([]);
  });

  it("accepts data event types on a webhook and explains the refusal of * and of other unknown types", async () => {
    const { app, inputs } = appWith();
    const accepted = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        url: "https://hooks.example.com/ohmyhost",
        event_types: ["data.orders", "data.*", "database.woke"],
      }),
    });
    expect(accepted.status).toBe(201);
    expect(inputs.at(-1)).toMatchObject({
      eventTypes: ["data.orders", "data.*", "database.woke"],
    });

    for (const eventTypes of [["*"], ["data.Orders"], ["database.*"]]) {
      const refused = await app.request(`${PATH}/webhooks?environment=dev`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: JSON.stringify({
          url: "https://hooks.example.com/ohmyhost",
          event_types: eventTypes,
        }),
      });
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ code: "invalid_request" });
      expect(String(body["detail"])).toContain("does not include data events");
      expect(String(body["detail"])).toContain("data.<topic>");
    }

    const badUrl = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ url: "http://hooks.example.com/x", event_types: ["data.orders"] }),
    });
    expect(await badUrl.json()).toMatchObject({ detail: "Request fields are invalid." });

    const notJson = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ code: "invalid_request" });
  });
});

describe("the stop budget guard of billable schedule work", () => {
  const scope = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environment: "dev" as const,
    principalId: "user:1",
    requestId: "request",
  };
  const setRequest = {
    cron: null,
    every_seconds: 60,
    statements: ["select 1"],
    timeout_ms: 10_000,
    enabled: true,
  };
  const refused = (code: string) => ({ status: "rejected", code });

  it("refuses a schedule set to run and a run now before the database is touched, with the Core's reason", async () => {
    for (const code of ["project_budget_exceeded", "insufficient_organization_credits"]) {
      const { binding, inputs } = eventsBinding();
      const port = createProjectDatabaseEventsPort(
        binding,
        admissionOf(refused(code)).admission,
        CLOCK,
      );
      await expect(
        port.setSchedule({ ...scope, name: "nightly_cleanup", request: setRequest }),
      ).rejects.toMatchObject({ code });
      await expect(
        port.runSchedule({ ...scope, idempotencyKey: "events-key-0001", name: "nightly_cleanup" }),
      ).rejects.toMatchObject({
        code,
      });
      expect(inputs).toEqual([]);
    }
  });

  it("answers null for a scope the Core does not know, for both billable operations", async () => {
    const { binding, inputs } = eventsBinding();
    const port = createProjectDatabaseEventsPort(
      binding,
      admissionOf(refused("organization_credit_scope_missing")).admission,
      CLOCK,
    );
    await expect(
      port.setSchedule({ ...scope, name: "nightly_cleanup", request: setRequest }),
    ).resolves.toBeNull();
    await expect(
      port.runSchedule({ ...scope, idempotencyKey: "events-key-0001", name: "nightly_cleanup" }),
    ).resolves.toBeNull();
    expect(inputs).toEqual([]);
  });

  it("refuses an admission answer that is not the contract", async () => {
    for (const answer of [
      { status: "admitted", extra: true },
      { status: "rejected", code: "unknown_code" },
      { status: "rejected" },
      null,
    ]) {
      const port = createProjectDatabaseEventsPort(
        eventsBinding().binding,
        admissionOf(answer).admission,
        CLOCK,
      );
      await expect(
        port.runSchedule({ ...scope, idempotencyKey: "events-key-0001", name: "nightly_cleanup" }),
      ).rejects.toThrow(TypeError);
    }
  });

  it("asks the Core with exactly the scope and the clock, and admitted work reaches the binding", async () => {
    const { admission, questions } = admissionOf();
    const { binding, inputs } = eventsBinding();
    const port = createProjectDatabaseEventsPort(binding, admission, CLOCK);
    await expect(
      port.setSchedule({ ...scope, name: "nightly_cleanup", request: setRequest }),
    ).resolves.toEqual(SCHEDULE);
    await expect(
      port.runSchedule({ ...scope, idempotencyKey: "events-key-0001", name: "nightly_cleanup" }),
    ).resolves.toEqual({
      schedule: "nightly_cleanup",
      state: "queued",
    });
    expect(questions).toEqual([
      { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, environment: "dev", now: NOW },
      { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID, environment: "dev", now: NOW },
    ]);
    expect(inputs.map((input) => input["operation"])).toEqual(["schedule.set", "schedule.run"]);
  });

  it("never asks the Core about a disable or a read, and those still reach the binding while the budget is reached", async () => {
    const { admission, questions } = admissionOf(refused("project_budget_exceeded"));
    const { binding, inputs } = eventsBinding();
    const port = createProjectDatabaseEventsPort(binding, admission, CLOCK);
    await port.setSchedule({
      ...scope,
      name: "nightly_cleanup",
      request: { ...setRequest, enabled: false },
    });
    await port.listSchedules(scope);
    await port.getSchedule({ ...scope, name: "nightly_cleanup" });
    await port.deleteSchedule({ ...scope, name: "nightly_cleanup" });
    await port.listScheduleRuns({ ...scope, name: "nightly_cleanup", limit: 20 });
    await port.readExecutionUsage({
      ...scope,
      window: { from: NOW, to: LATER, granularity: "hour" },
      limit: 50,
      cursor: null,
    });
    await port.listWebhooks(scope);
    expect(questions).toEqual([]);
    expect(inputs.map((input) => input["operation"])).toEqual([
      "schedule.set",
      "schedule.list",
      "schedule.get",
      "schedule.delete",
      "schedule.runs",
      "usage.get",
      "webhook.list",
    ]);
  });

  it("answers 402 with the Core's reason for a schedule set to run and a run now while the budget is reached", async () => {
    const { admission } = admissionOf(refused("project_budget_exceeded"));
    const { app, inputs } = appWith({}, admission);
    const put = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ every_seconds: 60, statements: ["select 1"], confirm: true }),
    });
    expect(put.status).toBe(402);
    expect(await put.json()).toMatchObject({ code: "project_budget_exceeded" });
    const run = await app.request(`${PATH}/schedules/nightly_cleanup/run?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(run.status).toBe(402);
    expect(await run.json()).toMatchObject({ code: "project_budget_exceeded" });
    expect(inputs).toEqual([]);

    const disable = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        every_seconds: 60,
        statements: ["select 1"],
        enabled: false,
        confirm: true,
      }),
    });
    expect(disable.status).toBe(200);
    for (const [method, path] of [
      ["GET", `${PATH}/schedules`],
      ["GET", `${PATH}/schedules/nightly_cleanup`],
      ["GET", `${PATH}/schedules/nightly_cleanup/runs?limit=5`],
      ["DELETE", `${PATH}/schedules/nightly_cleanup?environment=dev`],
    ] as const) {
      const response = await app.request(path, { method, headers: READ_HEADERS });
      expect(response.status).toBe(200);
    }
  });

  it("allows the same requests while the budget is not reached", async () => {
    const { app } = appWith();
    const put = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ every_seconds: 60, statements: ["select 1"], confirm: true }),
    });
    expect(put.status).toBe(200);
    const run = await app.request(`${PATH}/schedules/nightly_cleanup/run?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(run.status).toBe(202);
  });

  it("answers not found for an environment the Core does not know, and asks nothing for a denied project", async () => {
    const { app } = appWith(
      {},
      admissionOf(refused("organization_credit_scope_missing")).admission,
    );
    const missing = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ every_seconds: 60, statements: ["select 1"], confirm: true }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "resource_not_found" });

    const { admission, questions } = admissionOf(refused("project_budget_exceeded"));
    const denied = createControlApi(
      dependencies({
        authorization: { check: async () => "deny" as const },
        projectDatabaseEvents: createProjectDatabaseEventsPort(
          eventsBinding().binding,
          admission,
          CLOCK,
        ),
      }),
    );
    const response = await denied.request(`${PATH}/schedules/nightly_cleanup/run?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(response.status).toBe(404);
    expect(questions).toEqual([]);
  });
});

function dependencies(overrides: Partial<ControlApiDependencies> = {}): ControlApiDependencies {
  return {
    authentication: {
      authenticate: async () => ({
        actorId: "user:user_1",
        credentialId: "workos_session:session_1",
        authorizationPrincipal: { kind: "user", subjectId: "user:user_1" },
        organizationIds: [ORGANIZATION_ID],
      }),
    },
    authorization: { check: async () => "allow" },
    persistence: {
      submitFeedback: async () => {
        throw new Error("Unused feedback fixture");
      },
      readFeedbackStatus: async () => {
        throw new Error("Unused feedback fixture");
      },
      listProjects: async () => ({ projects: [], nextCursor: null }),
      takenProjectHandles: async () => new Set<string>(),
      createProject: async () => {
        throw new Error("unused");
      },
      getProject: async (organizationId, projectId) => ({
        dataMode: "isolated" as const,
        region: "us" as const,
        organizationId,
        projectId,
        name: "fixture",
        handle: "calm-otter-waves",
        createdAt: NOW,
      }),
      getOperation: async () => null,
      readAuditEvents: async () => ({ events: [], nextCursor: null }),
    },
    productSurface: createUnavailableProductSurfacePort(),
    providerReconciliation: createUnavailableProviderReconciliationPort(),
    environmentSecrets: createUnavailableEnvironmentSecretsPort(),
    projectMailDomains: createUnavailableProjectMailDomainsPort(),
    devAccessTickets: {
      issue: async () => {
        throw new Error("unused");
      },
    },
    clock: { now: () => new Date(NOW) },
    ids: { next: () => EVENT_ID },
    allowedOrigins: new Set(),
    applicationId: "control-api-test",
    rateLimits: { consume: async () => ({ allowed: true }) },
    reporter: { report: () => undefined },
    requestId: () => "req_database_events",
    ...overrides,
  };
}

describe("the state-changing database event routes", () => {
  it("refuses every state-changing request without an Idempotency-Key before the boundary is touched", async () => {
    const { app, inputs } = appWith();
    const routes = [
      ["DELETE", `${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`],
      ["POST", `${PATH}/webhooks/${WEBHOOK_ID}/test?environment=dev`],
      ["POST", `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay?environment=dev`],
      ["POST", `${PATH}/schedules/nightly_cleanup/run?environment=dev`],
    ] as const;
    for (const [method, path] of routes) {
      const response = await app.request(path, { method, headers: READ_HEADERS });
      expect(response.status, `${method} ${path}`).toBe(400);
    }
    expect(inputs).toEqual([]);
  });
});

describe("the Idempotency-Key of the replaying database event routes", () => {
  it("passes the caller's key to the boundary of each replaying operation and answers the stored outcome", async () => {
    const { app, inputs } = appWith();
    const routes = [
      ["DELETE", `${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`, "webhook.delete", 200],
      ["POST", `${PATH}/webhooks/${WEBHOOK_ID}/test?environment=dev`, "webhook.test", 200],
      [
        "POST",
        `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay?environment=dev`,
        "delivery.replay",
        202,
      ],
      ["POST", `${PATH}/schedules/nightly_cleanup/run?environment=dev`, "schedule.run", 202],
    ] as const;
    for (const [method, path, operation, status] of routes) {
      const response = await app.request(path, { method, headers: WRITE_HEADERS });
      expect(response.status, operation).toBe(status);
      expect(inputs.at(-1), operation).toMatchObject({
        operation,
        environment: "dev",
        idempotencyKey: "events-key-0001",
      });
    }
  });

  it("forwards the key of each replaying operation through the port", async () => {
    const { binding, inputs } = eventsBinding();
    const port = createProjectDatabaseEventsPort(binding, admissionOf().admission, CLOCK);
    const scope = {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      principalId: "user:1",
      requestId: "request",
      environment: "dev" as const,
      idempotencyKey: "events-key-0002",
    };
    await port.deleteWebhook({ ...scope, webhookId: WEBHOOK_ID });
    await port.testWebhook({ ...scope, webhookId: WEBHOOK_ID });
    await port.replayDelivery({ ...scope, deliveryId: DELIVERY_ID });
    await port.runSchedule({ ...scope, name: "nightly_cleanup" });
    expect(inputs.map((input) => input["operation"])).toEqual([
      "webhook.delete",
      "webhook.test",
      "delivery.replay",
      "schedule.run",
    ]);
    expect(inputs.map((input) => input["idempotencyKey"])).toEqual([
      "events-key-0002",
      "events-key-0002",
      "events-key-0002",
      "events-key-0002",
    ]);
  });

  it("answers a key the boundary reports as reused for another request with 409 on each replaying route", async () => {
    const { app } = appWith({
      "webhook.delete": () => ({ status: "rejected", code: "idempotency_key_reused" }),
      "webhook.test": () => ({ status: "rejected", code: "idempotency_key_reused" }),
      "delivery.replay": () => ({ status: "rejected", code: "idempotency_key_reused" }),
      "schedule.run": () => ({ status: "rejected", code: "idempotency_key_reused" }),
    });
    for (const [method, path] of [
      ["DELETE", `${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`],
      ["POST", `${PATH}/webhooks/${WEBHOOK_ID}/test?environment=dev`],
      ["POST", `${PATH}/webhook-deliveries/${DELIVERY_ID}/replay?environment=dev`],
      ["POST", `${PATH}/schedules/nightly_cleanup/run?environment=dev`],
    ] as const) {
      const response = await app.request(path, { method, headers: WRITE_HEADERS });
      expect(response.status, path).toBe(409);
      expect(await response.json(), path).toMatchObject({ code: "idempotency_key_reused" });
    }
  });
});

describe("the statements of a schedule", () => {
  it("shows the statement text only to a caller with projects:write and a digest to every other caller", async () => {
    const statement = "delete from events where created_at < now() - interval '1 day'";
    const digest = `sha256:${createHash("sha256").update(statement).digest("hex")}`;
    const appAs = (decide: (action: string) => "allow" | "deny") => {
      const { binding } = eventsBinding({
        "schedule.list": () => ok({ items: [SCHEDULE] }),
        "schedule.get": () => ok(SCHEDULE),
      });
      return createControlApi(
        dependencies({
          authorization: { check: async ({ action }) => decide(action) },
          projectDatabaseEvents: createProjectDatabaseEventsPort(
            binding,
            admissionOf().admission,
            CLOCK,
          ),
        }),
      );
    };
    const reader = appAs((action) => (action === "projects:write" ? "deny" : "allow"));
    for (const path of [
      `${PATH}/schedules?environment=dev`,
      `${PATH}/schedules/nightly_cleanup?environment=dev`,
    ]) {
      const text = await (await reader.request(path, { headers: READ_HEADERS })).text();
      expect(text).not.toContain("delete from events");
      expect(text).toContain(digest);
    }
    const owner = appAs(() => "allow");
    const full = await owner.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      headers: READ_HEADERS,
    });
    expect(await full.text()).toContain("delete from events");
  });
});

describe("the audit of database event changes", () => {
  it("records one principal audit event per change with its environment and resource, and only the host of a webhook URL", async () => {
    const audits: Record<string, unknown>[] = [];
    const admission: ProjectDatabaseAdmissionRuntime = {
      readProjectDatabaseAdmission: async () => ({ status: "admitted" }),
      recordProjectDatabaseEventAudit: async (input) => {
        audits.push(input as Record<string, unknown>);
        return { recorded: true };
      },
    };
    const { binding } = eventsBinding();
    const app = createControlApi(
      dependencies({
        projectDatabaseEvents: createProjectDatabaseEventsPort(binding, admission, CLOCK),
      }),
    );
    const created = await app.request(`${PATH}/webhooks?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        url: "https://hooks.example.com/catch/SECRETTOKEN?k=SECRET2",
        event_types: ["database.woke"],
      }),
    });
    expect(created.status).toBe(201);
    const deleted = await app.request(`${PATH}/webhooks/${WEBHOOK_ID}?environment=dev`, {
      method: "DELETE",
      headers: WRITE_HEADERS,
    });
    expect(deleted.status).toBe(200);
    const ran = await app.request(`${PATH}/schedules/nightly_cleanup/run?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(ran.status).toBe(202);

    expect(audits.map((audit) => audit["payload"])).toEqual([
      {
        operation: "webhook.create",
        environment: "dev",
        resource_id: WEBHOOK_ID,
        host: "hooks.example.com",
      },
      { operation: "webhook.delete", environment: "dev", resource_id: WEBHOOK_ID },
      { operation: "schedule.run", environment: "dev", resource_id: "nightly_cleanup" },
    ]);
    for (const audit of audits) {
      expect(audit).toMatchObject({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        environment: "dev",
        principalId: "user:user_1",
        eventType: "ProjectDatabaseEventChangedV1",
      });
    }
    expect(JSON.stringify(audits)).not.toContain("SECRETTOKEN");
  });

  it("writes no audit event for a change the boundary refuses", async () => {
    const audits: unknown[] = [];
    const admission: ProjectDatabaseAdmissionRuntime = {
      readProjectDatabaseAdmission: async () => ({ status: "admitted" }),
      recordProjectDatabaseEventAudit: async (input) => {
        audits.push(input);
        return { recorded: true };
      },
    };
    const { binding } = eventsBinding({
      "schedule.run": () => ({ status: "rejected", code: "schedule_not_runnable" }),
    });
    const app = createControlApi(
      dependencies({
        projectDatabaseEvents: createProjectDatabaseEventsPort(binding, admission, CLOCK),
      }),
    );
    const refused = await app.request(`${PATH}/schedules/nightly_cleanup/run?environment=dev`, {
      method: "POST",
      headers: WRITE_HEADERS,
    });
    expect(refused.status).toBe(409);
    expect(audits).toEqual([]);
  });
});

describe("the order of a database event request", () => {
  it("answers a caller the project denies with not found before its body is parsed", async () => {
    const { binding, inputs } = eventsBinding();
    const app = createControlApi(
      dependencies({
        authorization: {
          check: async ({ action }) => (action === "projects:write" ? "deny" : "allow"),
        },
        projectDatabaseEvents: createProjectDatabaseEventsPort(
          binding,
          admissionOf().admission,
          CLOCK,
        ),
      }),
    );
    const response = await app.request(`${PATH}/schedules/nightly_cleanup?environment=dev`, {
      method: "PUT",
      headers: JSON_HEADERS,
      body: "{ not json",
    });
    expect(response.status).toBe(404);
    expect(inputs).toEqual([]);
  });
});
