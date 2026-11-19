import type { DatabaseEnvironment } from "@ohmyhost/contracts/database-access";
import {
  assertDatabaseTableCreated,
  parseDatabaseTableCreateRequest,
  type DatabaseTableColumn,
  type DatabaseTableRequest,
} from "@ohmyhost/contracts/database-tables";
import { OrganizationCreditError } from "@ohmyhost/database";
import type { Clock } from "@ohmyhost/platform";
import {
  assertDatabaseExecutionUsagePage,
  assertDatabaseSchedule,
  assertDatabaseSchedulePage,
  assertDatabaseScheduleDeleted,
  assertDatabaseScheduleRunAccepted,
  assertDatabaseScheduleRunPage,
  assertDatabaseWebhook,
  assertDatabaseWebhookCreated,
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
  parseDatabaseEnvironment,
  type DatabaseScheduleSetRequest,
} from "@ohmyhost/contracts/database-events";

import {
  ProjectDatabaseEventsError,
  type ProductSurfaceContext,
  type ProjectDatabaseEventsPort,
  type ProjectDatabaseEventsRejection,
  type ProjectDatabaseTableCreated,
} from "./contracts.js";

/** The neon-management RPCs: `databaseEvents` for webhooks, schedules, watches and usage, `createDatabaseTable` for tables. */
export interface ProjectDatabaseEventsBinding {
  databaseEvents(input: unknown): Promise<unknown>;
  createDatabaseTable(input: unknown): Promise<unknown>;
}

/** The Core's admission of one database environment for billable work (`readProjectDatabaseAdmission`). */
export interface ProjectDatabaseAdmissionRuntime {
  readProjectDatabaseAdmission(input: unknown): Promise<unknown>;
  /** Writes one principal audit event for a change of database events (`recordProjectDatabaseEventAudit`). */
  recordProjectDatabaseEventAudit(input: unknown): Promise<unknown>;
}

/** The route's parameters: the resolved environment and the raw text of every other accepted value. */
export interface DatabaseEventsQuery {
  readonly environment: DatabaseEnvironment;
  readonly values: Readonly<Record<string, string>>;
}

const REJECTIONS: readonly ProjectDatabaseEventsRejection[] = [
  "invalid",
  "webhook_limit",
  "schedule_limit",
  "schedule_not_runnable",
  "delivery_pending",
  "throttled",
  "idempotency_key_reused",
  "pending",
  "watch_table_unavailable",
  "watch_column_unavailable",
  "watch_events_unavailable",
  "watch_conflict",
  "watch_limit",
];

const TABLE_REJECTIONS: readonly ProjectDatabaseEventsRejection[] = [
  "table_conflict",
  "table_limit",
  "pending",
];

const TABLE_CREATE_BODY_KEYS: readonly string[] = [
  "environment",
  "table",
  "columns",
  "primary_key",
];

type Scope = ProductSurfaceContext & { readonly environment: DatabaseEnvironment };

/**
 * Product boundary over the neon-management RPCs `databaseEvents` and `createDatabaseTable`. The service decides
 * the database and the tenant; this port only checks the wire shape of every answer and maps refusals to codes.
 * Work that bills or wakes the database (a schedule set to run, a schedule run now, a table created, a watch list) is
 * first admitted by the Core's serving decision, so a reached stop budget or exhausted credit refuses it before the
 * database is touched. Disabling and reading a schedule are never refused.
 */
export function createProjectDatabaseEventsPort(
  binding: ProjectDatabaseEventsBinding,
  admission: ProjectDatabaseAdmissionRuntime,
  clock: Clock,
): ProjectDatabaseEventsPort {
  if (
    !isRecord(binding) ||
    typeof binding.databaseEvents !== "function" ||
    typeof binding.createDatabaseTable !== "function" ||
    !isRecord(admission) ||
    typeof admission.readProjectDatabaseAdmission !== "function" ||
    typeof admission.recordProjectDatabaseEventAudit !== "function"
  ) {
    throw new TypeError("Project database events binding is invalid");
  }
  const call = (scope: Scope, operation: string, extra: Record<string, unknown>) =>
    invoke(binding, scope, operation, extra);
  const admitted = (scope: Scope) => admit(admission, scope, clock);
  const audit = (
    scope: Scope,
    operation: string,
    resourceId: string,
    extra: Readonly<Record<string, string>> = {},
  ) => record(admission, scope, clock, operation, resourceId, extra);
  const watches = async (scope: Scope) => {
    const value = await call(scope, "watch.list", {});
    if (value === null) return null;
    assertDatabaseWatchPage(value);
    for (const item of value.items) assertScope(item.environment === scope.environment);
    return value;
  };
  return {
    async activateWebhookSubscription(input) {
      const value = await call(input, "subscription.activate", {
        subscriptionId: input.subscriptionId,
        generation: input.generation,
        idempotencyKey: input.idempotencyKey,
        url: input.request.url,
        eventTypes: [...input.request.event_types],
        ...(Object.keys(input.request.headers).length
          ? { headers: { ...input.request.headers } }
          : {}),
      });
      if (value === null) return null;
      assertDatabaseWebhookSubscriptionActivation(value);
      assertScope(
        value.id === input.subscriptionId &&
          value.environment === input.environment &&
          value.generation === input.generation,
      );
      await audit(input, "subscription.activate", input.subscriptionId, {
        host: new URL(input.request.url).host,
      });
      return value;
    },
    async deactivateWebhookSubscription(input) {
      const value = await call(input, "subscription.deactivate", {
        subscriptionId: input.subscriptionId,
        generation: input.generation,
        idempotencyKey: input.idempotencyKey,
      });
      if (value === null) return null;
      assertDatabaseWebhookSubscription(value);
      assertScope(
        value.id === input.subscriptionId &&
          value.environment === input.environment &&
          value.generation === input.generation &&
          value.state === "inactive",
      );
      await audit(input, "subscription.deactivate", input.subscriptionId);
      return value;
    },
    async getWebhookSubscription(input) {
      const value = await call(input, "subscription.status", {
        subscriptionId: input.subscriptionId,
      });
      if (value === null) return null;
      assertDatabaseWebhookSubscription(value);
      assertScope(value.id === input.subscriptionId && value.environment === input.environment);
      return value;
    },
    async createWebhook(input) {
      const value = await call(input, "webhook.create", {
        url: input.request.url,
        eventTypes: [...input.request.event_types],
        ...(Object.keys(input.request.headers).length === 0
          ? {}
          : { headers: { ...input.request.headers } }),
        idempotencyKey: input.idempotencyKey,
      });
      if (value === null) return null;
      assertDatabaseWebhookCreated(value);
      assertScope(value.environment === input.environment);
      await audit(input, "webhook.create", value.id, {
        host: new URL(input.request.url).host,
      });
      return value;
    },
    async listWebhooks(input) {
      const value = await call(input, "webhook.list", {});
      if (value === null) return null;
      assertDatabaseWebhookPage(value);
      for (const item of value.items) assertScope(item.environment === input.environment);
      return value;
    },
    async getWebhook(input) {
      const value = await call(input, "webhook.get", { webhookId: input.webhookId });
      if (value === null) return null;
      assertDatabaseWebhook(value);
      assertScope(value.id === input.webhookId && value.environment === input.environment);
      return value;
    },
    async deleteWebhook(input) {
      const value = await call(input, "webhook.delete", {
        webhookId: input.webhookId,
        idempotencyKey: input.idempotencyKey,
      });
      if (value === null) return null;
      assertDatabaseWebhookDeleted(value);
      assertScope(value.id === input.webhookId);
      await audit(input, "webhook.delete", input.webhookId);
      return value;
    },
    async testWebhook(input) {
      const value = await call(input, "webhook.test", {
        webhookId: input.webhookId,
        idempotencyKey: input.idempotencyKey,
      });
      if (value === null) return null;
      assertDatabaseWebhookTest(value);
      await audit(input, "webhook.test", input.webhookId);
      return value;
    },
    async listDeliveries(input) {
      const value = await call(input, "delivery.list", {
        ...(input.webhookId === null ? {} : { webhookId: input.webhookId }),
        limit: input.limit,
        ...(input.cursor === null ? {} : { cursor: input.cursor }),
      });
      if (value === null) return null;
      assertDatabaseWebhookDeliveryPage(value);
      if (input.webhookId !== null) {
        for (const item of value.items) assertScope(item.webhook_id === input.webhookId);
      }
      return value;
    },
    async replayDelivery(input) {
      const value = await call(input, "delivery.replay", {
        deliveryId: input.deliveryId,
        idempotencyKey: input.idempotencyKey,
      });
      if (value === null) return null;
      assertDatabaseWebhookReplayAccepted(value);
      assertScope(value.delivery_id === input.deliveryId);
      await audit(input, "delivery.replay", input.deliveryId);
      return value;
    },
    async createWatch(input) {
      if (!(await admitted(input))) return null;
      // The service's create shape is closed: the Idempotency-Key only shapes the request digest, it is not forwarded.
      const value = await call(input, "watch.create", {
        schema: input.request.schema,
        table: input.request.table,
        columns: [...input.request.columns],
        operations: [...input.request.operations],
      });
      if (value === null) return null;
      assertDatabaseWatch(value);
      assertScope(
        value.environment === input.environment &&
          value.schema === input.request.schema &&
          value.table === input.request.table,
      );
      await audit(input, "watch.create", value.id, { table: input.request.table });
      return value;
    },
    async listWatches(input) {
      // A list opens a migration session that wakes the database, so it is admitted like the other billable work.
      return (await admitted(input)) ? watches(input) : null;
    },
    async createTable(input) {
      if (!(await admitted(input))) return null;
      // The service creates the table of the request's own name in the public schema, and no other.
      const raw = await binding.createDatabaseTable(
        envelope(input, "table.create", {
          table: input.request.table,
          columns: input.request.columns.map(rpcColumn),
          ...(input.request.primaryKey.length === 0
            ? {}
            : { primaryKey: [...input.request.primaryKey] }),
        }),
      );
      const value = settle(raw, TABLE_REJECTIONS);
      if (value === null) return null;
      assertDatabaseTableCreated(value);
      assertScope(value.table.table === input.request.table);
      await audit(input, "table.create", value.table.table);
      return { ...value, environment: input.environment };
    },
    async deleteWatch(input) {
      if (!(await admitted(input))) return null;
      // The trigger name is a hash of schema and table: the listed item names the table to delete, and no other.
      const target = (await watches(input))?.items.find((item) => item.id === input.watchId);
      if (target === undefined) return null;
      const value = await call(input, "watch.delete", {
        schema: target.schema,
        table: target.table,
      });
      if (value === null) return null;
      assertDatabaseWatchDeleted(value);
      assertScope(value.id === input.watchId);
      await audit(input, "watch.delete", input.watchId);
      return value;
    },
    async setSchedule(input) {
      if (input.request.enabled && !(await admitted(input))) return null;
      const value = await call(input, "schedule.set", scheduleFields(input.name, input.request));
      if (value === null) return null;
      assertDatabaseSchedule(value);
      assertScope(value.name === input.name && value.environment === input.environment);
      await audit(input, "schedule.set", input.name);
      return value;
    },
    async listSchedules(input) {
      const value = await call(input, "schedule.list", {});
      if (value === null) return null;
      assertDatabaseSchedulePage(value);
      for (const item of value.items) assertScope(item.environment === input.environment);
      return value;
    },
    async getSchedule(input) {
      const value = await call(input, "schedule.get", { name: input.name });
      if (value === null) return null;
      assertDatabaseSchedule(value);
      assertScope(value.name === input.name && value.environment === input.environment);
      return value;
    },
    async deleteSchedule(input) {
      const value = await call(input, "schedule.delete", { name: input.name });
      if (value === null) return null;
      assertDatabaseScheduleDeleted(value);
      assertScope(value.name === input.name);
      await audit(input, "schedule.delete", input.name);
      return value;
    },
    async listScheduleRuns(input) {
      const value = await call(input, "schedule.runs", { name: input.name, limit: input.limit });
      if (value === null) return null;
      assertDatabaseScheduleRunPage(value);
      for (const item of value.items) assertScope(item.schedule === input.name);
      return value;
    },
    async runSchedule(input) {
      if (!(await admitted(input))) return null;
      const value = await call(input, "schedule.run", {
        name: input.name,
        idempotencyKey: input.idempotencyKey,
      });
      if (value === null) return null;
      assertDatabaseScheduleRunAccepted(value);
      assertScope(value.schedule === input.name);
      await audit(input, "schedule.run", input.name);
      return value;
    },
    async readExecutionUsage(input) {
      const value = await call(input, "usage.get", {
        from: input.window.from,
        to: input.window.to,
        granularity: input.window.granularity,
        limit: input.limit,
        ...(input.cursor === null ? {} : { cursor: input.cursor }),
      });
      if (value === null) return null;
      assertDatabaseExecutionUsagePage(value);
      return value;
    },
  };
}

/** Accepts only the listed keys; dev is the environment of a read that names none. */
export function parseDatabaseEventsQuery(
  search: URLSearchParams,
  allowed: readonly string[],
  environment: "required" | "optional",
): DatabaseEventsQuery {
  const entries = [...search.entries()];
  const keys = entries.map(([key]) => key);
  if (keys.some((key) => !allowed.includes(key)) || new Set(keys).size !== keys.length) {
    throw new TypeError("Invalid database events query");
  }
  const values: Record<string, string> = Object.fromEntries(entries);
  const { environment: rawEnvironment, ...rest } = values;
  if (rawEnvironment === undefined && environment === "required") {
    throw new TypeError("Database environment is required");
  }
  return { environment: parseDatabaseEnvironment(rawEnvironment ?? "dev"), values: rest };
}

/** The scheduled SQL is sent exactly as the customer wrote it; the name is the route's own key. */
function scheduleFields(
  name: string,
  request: DatabaseScheduleSetRequest,
): Record<string, unknown> {
  return {
    name,
    ...(request.cron === null ? {} : { cron: request.cron }),
    ...(request.every_seconds === null ? {} : { everySeconds: request.every_seconds }),
    statements: [...request.statements],
    timeoutMs: request.timeout_ms,
    enabled: request.enabled,
  };
}

async function invoke(
  binding: ProjectDatabaseEventsBinding,
  scope: Scope,
  operation: string,
  extra: Record<string, unknown>,
): Promise<unknown> {
  return settle(await binding.databaseEvents(envelope(scope, operation, extra)), REJECTIONS);
}

function envelope(
  scope: Scope,
  operation: string,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    operation,
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environment: scope.environment,
    ...extra,
  };
}

/** One RPC answer: absent is null, a rejection throws its code when the call allows it, and anything else is refused. */
function settle(raw: unknown, rejections: readonly ProjectDatabaseEventsRejection[]): unknown {
  if (!isRecord(raw)) throw new TypeError("Project database events result is invalid");
  if (raw["status"] === "absent" && exactKeys(raw, ["status"])) return null;
  if (raw["status"] === "rejected" && exactKeys(raw, ["code", "status"])) {
    const code = raw["code"];
    if (!rejections.some((rejection) => rejection === code)) {
      throw new TypeError("Project database events rejection is invalid");
    }
    throw new ProjectDatabaseEventsError(code as ProjectDatabaseEventsRejection);
  }
  if (raw["status"] === "ok" && exactKeys(raw, ["status", "value"])) return raw["value"];
  throw new TypeError("Project database events result is invalid");
}

/** The REST body of a table create, snake_case; only its own keys reach the contract, so a camelCase key is refused. */
export function parseDatabaseTableCreateBody(body: Record<string, unknown>): {
  readonly environment: DatabaseEnvironment;
  readonly request: DatabaseTableRequest;
} {
  if (!Object.keys(body).every((key) => TABLE_CREATE_BODY_KEYS.includes(key))) {
    throw new TypeError("Invalid database table request");
  }
  const { environment, primary_key: primaryKey, ...table } = body;
  return {
    environment: parseDatabaseEnvironment(environment),
    request: parseDatabaseTableCreateRequest({
      ...table,
      ...(primaryKey === undefined ? {} : { primaryKey }),
    }),
  };
}

/** The table as the REST answer shows it, with whether this request created it. */
export function databaseTableBody(created: ProjectDatabaseTableCreated): Record<string, unknown> {
  return {
    table: {
      environment: created.environment,
      schema: created.table.schema,
      table: created.table.table,
      columns: created.table.columns.map((column) => ({ ...column })),
      primary_key: [...created.table.primaryKey],
      created: created.created,
    },
  };
}

/** A column as the service reads it: a default is named only when the column has one. */
function rpcColumn(column: DatabaseTableColumn): Record<string, unknown> {
  return {
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    identity: column.identity,
    ...(column.default === null ? {} : { default: column.default }),
  };
}

/**
 * Writes the audit event of one customer change of database events. The Core refuses an unknown project, and an
 * answer that is not the contract is refused here, so no change is reported without its audit event.
 */
async function record(
  admission: ProjectDatabaseAdmissionRuntime,
  scope: Scope,
  clock: Clock,
  operation: string,
  resourceId: string,
  extra: Readonly<Record<string, string>>,
): Promise<void> {
  const raw = await admission.recordProjectDatabaseEventAudit({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environment: scope.environment,
    principalId: scope.principalId,
    eventType: "ProjectDatabaseEventChangedV1",
    payload: { operation, environment: scope.environment, resource_id: resourceId, ...extra },
    occurredAt: clock.now().toISOString(),
  });
  if (!isRecord(raw) || !exactKeys(raw, ["recorded"]) || raw["recorded"] !== true)
    throw new TypeError("Project database event audit result is invalid");
}

/**
 * Whether the Core admits billable database work in this environment now. A scope the Core does not know answers
 * false, which the caller turns into the same not found as an absent database; a refusal for credit or budget
 * throws its own error, so the customer sees the reason (402).
 */
async function admit(
  admission: ProjectDatabaseAdmissionRuntime,
  scope: Scope,
  clock: Clock,
): Promise<boolean> {
  const raw = await admission.readProjectDatabaseAdmission({
    organizationId: scope.organizationId,
    projectId: scope.projectId,
    environment: scope.environment,
    now: clock.now().toISOString(),
  });
  if (!isRecord(raw)) throw new TypeError("Project database admission result is invalid");
  if (raw["status"] === "admitted" && exactKeys(raw, ["status"])) return true;
  if (raw["status"] === "rejected" && exactKeys(raw, ["code", "status"])) {
    const code = raw["code"];
    if (code === "organization_credit_scope_missing") return false;
    if (code === "insufficient_organization_credits" || code === "project_budget_exceeded")
      throw new OrganizationCreditError(code);
  }
  throw new TypeError("Project database admission result is invalid");
}

/** An answer about another object, name or environment than the request asked for is refused. */
function assertScope(matches: boolean): void {
  if (!matches) throw new TypeError("Database events scope mismatch");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
