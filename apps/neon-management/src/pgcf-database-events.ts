import { projectSqlRoleName } from "@ohmyhost/platform";
import type { DatabaseEnvironment } from "@ohmyhost/contracts/database-access";
import {
  DATABASE_PAGE_MAX_ITEMS,
  DATABASE_WEBHOOK_LIMIT,
  assertDatabaseExecutionUsagePage,
  assertDatabaseSchedule,
  assertDatabaseSchedulePage,
  assertDatabaseScheduleDeleted,
  assertDatabaseScheduleRunPage,
  assertDatabaseScheduleRunAccepted,
  assertDatabaseWebhook,
  assertDatabaseWebhookCreated,
  assertDatabaseWebhookDeleted,
  assertDatabaseWebhookDeliveryPage,
  assertDatabaseWebhookPage,
  assertDatabaseWebhookReplayAccepted,
  assertDatabaseWebhookTest,
  parseDatabaseCursor,
  parseDatabaseDeliveryId,
  parseDatabaseListLimit,
  parseDatabaseScheduleName,
  parseDatabaseScheduleSetRequest,
  parseDatabaseUsageWindow,
  parseDatabaseWebhookCreateRequest,
  parseDatabaseWebhookId,
  type DatabaseExecutionUsagePage,
  type DatabaseSchedule,
  type DatabaseSchedulePage,
  type DatabaseScheduleDeleted,
  type DatabaseScheduleRunAccepted,
  type DatabaseScheduleRunPage,
  type DatabaseScheduleSetRequest,
  type DatabaseUsageWindow,
  type DatabaseWebhook,
  type DatabaseWebhookCreateRequest,
  type DatabaseWebhookCreated,
  type DatabaseWebhookDeleted,
  type DatabaseWebhookDeliveryPage,
  type DatabaseWebhookPage,
  type DatabaseWebhookReplayAccepted,
  type DatabaseWebhookTestResult,
  type DatabaseWebhookSubscription,
  type DatabaseWebhookSubscriptionActivation,
} from "@ohmyhost/contracts/database-events";
import {
  PgcfProviderError,
  type PgcfProjectProvider,
  type PgcfSchedule,
  type PgcfScheduleUpsert,
  type PgcfScheduleRun,
  type PgcfWebhook,
  type PgcfWebhookDelivery,
} from "@ohmyhost/provider-pgcf";
import {
  parseDatabaseRequest,
  resolveDatabaseScope,
  sha256Hex,
  type DatabaseRequestEnvelope,
  type DatabaseRequestShapes,
  type ReadDatabaseScope,
} from "./pgcf-database-request.js";

/** The provider calls the database events port makes; every one is scoped by the caller below. */
export type DatabaseEventsProvider = Pick<
  PgcfProjectProvider,
  | "projectId"
  | "listWebhooks"
  | "createWebhook"
  | "getWebhook"
  | "deleteWebhook"
  | "testWebhook"
  | "listWebhookDeliveries"
  | "replayWebhookDelivery"
  | "getSchedule"
  | "putSchedule"
  | "listSchedules"
  | "deleteSchedule"
  | "listScheduleRuns"
  | "runScheduleNow"
  | "readExecutionUsage"
>;

export interface PgcfDatabaseEventsDependencies {
  readonly readScope: ReadDatabaseScope;
  readonly provider: DatabaseEventsProvider;
}

export type DatabaseEventRejection =
  | "invalid"
  | "webhook_limit"
  | "schedule_limit"
  | "schedule_not_runnable"
  | "delivery_pending"
  | "throttled"
  | "idempotency_key_reused"
  | "pending";

export type DatabaseEventValue =
  | DatabaseWebhookSubscription
  | DatabaseWebhookSubscriptionActivation
  | DatabaseWebhookCreated
  | DatabaseWebhookPage
  | DatabaseWebhook
  | DatabaseWebhookDeleted
  | DatabaseWebhookTestResult
  | DatabaseWebhookDeliveryPage
  | DatabaseWebhookReplayAccepted
  | DatabaseSchedule
  | DatabaseSchedulePage
  | DatabaseScheduleDeleted
  | DatabaseScheduleRunPage
  | DatabaseScheduleRunAccepted
  | DatabaseExecutionUsagePage;

export type DatabaseEventOutcome =
  | { readonly status: "ok"; readonly value: DatabaseEventValue }
  | { readonly status: "absent" }
  | { readonly status: "rejected"; readonly code: DatabaseEventRejection };

type Refused = Exclude<DatabaseEventOutcome, { readonly status: "ok" }>;
type Outcome<T> = { readonly status: "ok"; readonly value: T } | Refused;

export type DatabaseEventOperation =
  | "webhook.create"
  | "webhook.list"
  | "webhook.get"
  | "webhook.delete"
  | "webhook.test"
  | "delivery.list"
  | "delivery.replay"
  | "schedule.set"
  | "schedule.list"
  | "schedule.get"
  | "schedule.delete"
  | "schedule.runs"
  | "schedule.run"
  | "usage.get";

/** Parsed and closed: every field has passed the contract parsers; no database id, role or project id comes from the caller. */
export type DatabaseEventRequest = DatabaseRequestEnvelope &
  (
    | {
        readonly operation: "webhook.create";
        readonly webhook: DatabaseWebhookCreateRequest;
        readonly idempotencyKey: string;
      }
    | { readonly operation: "webhook.list" }
    | { readonly operation: "webhook.get"; readonly webhookId: string }
    | {
        readonly operation: "webhook.delete" | "webhook.test";
        readonly webhookId: string;
        readonly idempotencyKey: string;
      }
    | {
        readonly operation: "delivery.list";
        readonly limit: number;
        readonly webhookId?: string;
        readonly cursor?: string;
      }
    | {
        readonly operation: "delivery.replay";
        readonly deliveryId: string;
        readonly idempotencyKey: string;
      }
    | {
        readonly operation: "schedule.set";
        readonly name: string;
        readonly schedule: DatabaseScheduleSetRequest;
      }
    | { readonly operation: "schedule.list" }
    | { readonly operation: "schedule.get" | "schedule.delete"; readonly name: string }
    | { readonly operation: "schedule.run"; readonly name: string; readonly idempotencyKey: string }
    | { readonly operation: "schedule.runs"; readonly name: string; readonly limit: number }
    | {
        readonly operation: "usage.get";
        readonly window: DatabaseUsageWindow;
        readonly limit: number;
        readonly cursor?: string;
      }
  );

const PAGE_LIMIT = 100;
const MAX_WEBHOOK_PAGES = 50;
const MAX_DELIVERY_PAGES = 10;
const MAX_CURSOR_LENGTH = 128;
const MAX_SCHEDULE_RUNS = 50;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/u;

/** Accepted operation keys and their member keys; the envelope keys are required for every operation. */
const SHAPES: DatabaseRequestShapes<DatabaseEventOperation> = {
  "webhook.create": [["url", "eventTypes", "idempotencyKey"], ["headers"]],
  "webhook.list": [[], []],
  "webhook.get": [["webhookId"], []],
  "webhook.delete": [["webhookId", "idempotencyKey"], []],
  "webhook.test": [["webhookId", "idempotencyKey"], []],
  "delivery.list": [["limit"], ["webhookId", "cursor"]],
  "delivery.replay": [["deliveryId", "idempotencyKey"], []],
  "schedule.set": [
    ["name", "statements"],
    ["cron", "everySeconds", "timeoutMs", "enabled"],
  ],
  "schedule.list": [[], []],
  "schedule.get": [["name"], []],
  "schedule.delete": [["name"], []],
  "schedule.runs": [["name", "limit"], []],
  "schedule.run": [["name", "idempotencyKey"], []],
  "usage.get": [["from", "to", "granularity", "limit"], ["cursor"]],
};

const ok = <T>(value: T): Outcome<T> => ({ status: "ok", value });
const ABSENT: Refused = { status: "absent" };
const refuse = (code: DatabaseEventRejection): Refused => ({ status: "rejected", code });
/** PGCF refuses a key reused for another request, and a key whose first request is still running. */
const REPLAY_REFUSALS: readonly Refusal[] = [
  { status: 409, reason: "idempotency_conflict", outcome: refuse("idempotency_key_reused") },
  { status: 409, reason: "idempotency_in_progress", outcome: refuse("pending") },
];

/**
 * A provider failure that becomes a closed outcome; `reason` null matches a 409 without a reason. `input` matches the
 * provider refusing a request it could not send (before any request), which is the customer's invalid input.
 */
interface Refusal {
  readonly status: number | "input";
  readonly reason?: string | null;
  readonly outcome: Refused;
}
const NOT_FOUND: Refusal = { status: 404, outcome: ABSENT };
const INVALID: Refusal = { status: 400, outcome: refuse("invalid") };
const INPUT: Refusal = { status: "input", outcome: refuse("invalid") };

function refusalOf(error: unknown, refusals: readonly Refusal[]): Refused | undefined {
  if (!(error instanceof PgcfProviderError)) return undefined;
  if (error.code === "input")
    return refusals.find((refusal) => refusal.status === "input")?.outcome;
  if (error.code !== "rejected") return undefined;
  return refusals.find(
    (refusal) =>
      refusal.status === error.status &&
      (refusal.reason === undefined || refusal.reason === (error.conflictReason ?? null)),
  )?.outcome;
}

/** Runs one provider call; a listed rejection becomes its outcome and every other failure is rethrown. */
async function guard<T>(work: () => Promise<T>, refusals: readonly Refusal[]): Promise<Outcome<T>> {
  try {
    return ok(await work());
  } catch (error) {
    const refused = refusalOf(error, refusals);
    if (refused === undefined) throw error;
    return refused;
  }
}

/** A webhook belongs to a database only when PGCF stores it for exactly that one database of this PGCF project. */
const storedForDatabase = (
  provider: Pick<DatabaseEventsProvider, "projectId">,
  databaseId: string,
  webhook: PgcfWebhook,
): boolean =>
  webhook.projectId === provider.projectId &&
  webhook.databaseIds !== null &&
  webhook.databaseIds.length === 1 &&
  webhook.databaseIds[0] === databaseId;

/** PGCF stores more webhooks than the listing is allowed to page through. */
export class WebhookListLimitError extends Error {
  constructor() {
    super("Database webhook list exceeded its page limit");
    this.name = "WebhookListLimitError";
  }
}

/**
 * Every webhook PGCF stores for exactly this database; PGCF lists the webhooks of all customers in one project. With
 * `skipUnparseable` a webhook the strict parser rejects is counted instead of failing the listing (never returned).
 */
export async function databaseWebhooks(
  provider: Pick<DatabaseEventsProvider, "projectId" | "listWebhooks">,
  databaseId: string,
  skipUnparseable = false,
): Promise<{ readonly webhooks: PgcfWebhook[]; readonly skipped: number }> {
  const webhooks: PgcfWebhook[] = [];
  let skipped = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_WEBHOOK_PAGES; page += 1) {
    const result = await provider.listWebhooks({
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
      ...(skipUnparseable ? { skipUnparseable } : {}),
    });
    skipped += result.skipped ?? 0;
    webhooks.push(
      ...result.items.filter((webhook) => storedForDatabase(provider, databaseId, webhook)),
    );
    if (result.nextCursor === null) return { webhooks, skipped };
    cursor = result.nextCursor;
  }
  throw new WebhookListLimitError();
}

/**
 * Removes the webhooks PGCF still holds for databases that are gone. A deleted database keeps its webhooks, which count
 * against the one cap every customer shares; the deletion path removes the webhooks of the database it deletes, and this
 * pass removes those of earlier deletions. A webhook of a live database is never touched. A pass deletes at most
 * `maxDeletes` webhooks and reports `complete` only when no orphan is left to delete and every page was read.
 */
export async function sweepOrphanDatabaseWebhooks(
  provider: Pick<DatabaseEventsProvider, "projectId" | "listWebhooks" | "deleteWebhook"> & {
    readDatabase(databaseId: string): Promise<{
      readonly desiredState: string;
      readonly observedState: string;
    }>;
  },
  options: { readonly maxDeletes: number },
): Promise<{ readonly deleted: number; readonly complete: boolean }> {
  const byDatabase = new Map<string, string[]>();
  let cursor: string | undefined;
  let complete = true;
  for (let page = 0; ; page += 1) {
    if (page === MAX_WEBHOOK_PAGES) {
      complete = false;
      break;
    }
    const result = await provider.listWebhooks({
      limit: PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
      skipUnparseable: true,
    });
    for (const webhook of result.items) {
      const [databaseId] = webhook.databaseIds ?? [];
      if (
        webhook.projectId !== provider.projectId ||
        databaseId === undefined ||
        webhook.databaseIds?.length !== 1
      )
        continue;
      byDatabase.set(databaseId, [...(byDatabase.get(databaseId) ?? []), webhook.id]);
    }
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
  }
  let deleted = 0;
  for (const [databaseId, webhookIds] of byDatabase) {
    if (!(await databaseGone(provider, databaseId))) continue;
    for (const webhookId of webhookIds) {
      if (deleted >= options.maxDeletes) return { deleted, complete: false };
      await provider
        .deleteWebhook(webhookId, { key: webhookCleanupKey(webhookId) })
        .catch((error: unknown) => {
          if (!(error instanceof PgcfProviderError && error.status === 404)) throw error;
        });
      deleted += 1;
    }
  }
  return { deleted, complete };
}

/** A database PGCF no longer serves, or reports as deleted, whose webhooks no customer can still receive from. */
async function databaseGone(
  provider: { readDatabase(databaseId: string): Promise<{ desiredState: string }> },
  databaseId: string,
): Promise<boolean> {
  try {
    return (await provider.readDatabase(databaseId)).desiredState === "deleted";
  } catch (error) {
    if (error instanceof PgcfProviderError && error.status === 404) return true;
    throw error;
  }
}

/**
 * The PGCF key of a customer request that PGCF replays: the customer's Idempotency-Key scoped to this project and
 * environment. The same key with the same request gets PGCF's stored answer; the same key with another request is
 * refused by PGCF as idempotency_conflict, which the operations map to idempotency_key_reused.
 */
async function databaseEventKey(
  request: DatabaseRequestEnvelope,
  idempotencyKey: string,
): Promise<string> {
  return `omh-wh-${await sha256Hex(
    `${request.organizationId}:${request.projectId}:${request.environment}:${idempotencyKey}`,
  )}`;
}

/** The PGCF key of a compensating or deletion-time webhook delete, fixed by the webhook it removes. */
export const webhookCleanupKey = (webhookId: string): string => `omh-delete-webhook-${webhookId}`;

/** Creation order of webhooks: the earlier PGCF timestamp first, the id breaks ties. */
const byCreation = (a: PgcfWebhook, b: PgcfWebhook): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function webhookWire(webhook: PgcfWebhook, environment: DatabaseEnvironment): DatabaseWebhook {
  const value: unknown = {
    id: webhook.id,
    environment,
    url: webhook.url,
    event_types: [...webhook.eventTypes],
    header_names: [...webhook.headerNames],
    created_at: webhook.createdAt,
  };
  assertDatabaseWebhook(value);
  return value;
}

function deliveryWire(delivery: PgcfWebhookDelivery) {
  return {
    id: delivery.id,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    webhook_id: delivery.webhookId,
    state: delivery.state,
    attempts: delivery.attempts,
    created_at: delivery.createdAt,
    next_attempt_at: delivery.nextAttemptAt,
    delivered_at: delivery.deliveredAt,
    last_status: delivery.lastStatus,
    last_error: delivery.lastError,
  };
}

function scheduleWire(schedule: PgcfSchedule, environment: DatabaseEnvironment): DatabaseSchedule {
  const value: unknown = {
    name: schedule.name,
    environment,
    cron: schedule.cron,
    every_seconds: schedule.everySeconds,
    statements: [...schedule.statements],
    timeout_ms: schedule.timeoutMs,
    enabled: schedule.enabled,
    next_run_at: schedule.nextRunAt,
    created_at: schedule.createdAt,
  };
  assertDatabaseSchedule(value);
  return value;
}

function scheduleRunWire(run: PgcfScheduleRun) {
  return {
    id: run.id,
    schedule: run.schedule,
    scheduled_at: run.scheduledAt,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    outcome: run.outcome,
    sqlstate: run.sqlstate,
    attempts: run.attempts,
    manual: run.manual,
  };
}

/**
 * Every database event operation, scoped to the one PGCF database that the product compute scope names. A webhook
 * or schedule is visible only when PGCF stores it for exactly that database (and, for schedules, the application's
 * own runtime role); anything else answers absent, indistinguishable from an unknown id. An environment without a
 * database answers absent for every operation.
 */
export function createPgcfDatabaseEvents(dependencies: PgcfDatabaseEventsDependencies) {
  const { provider, readScope } = dependencies;

  async function scopeOf(request: DatabaseRequestEnvelope) {
    const scope = await resolveDatabaseScope({ readScope, provider }, request);
    if (scope === null) return null;
    return {
      databaseId: scope.databaseId,
      runtimeRole: projectSqlRoleName(scope.physicalEnvironmentId, "runtime"),
      environment: scope.environment,
    };
  }
  type Scope = NonNullable<Awaited<ReturnType<typeof scopeOf>>>;

  const ownedBy = (scope: Scope, webhook: PgcfWebhook): boolean =>
    storedForDatabase(provider, scope.databaseId, webhook);

  const ownedWebhooks = async (scope: Scope): Promise<PgcfWebhook[]> =>
    (await databaseWebhooks(provider, scope.databaseId)).webhooks;

  async function ownedWebhook(scope: Scope, webhookId: string): Promise<Outcome<PgcfWebhook>> {
    const found = await guard(() => provider.getWebhook(webhookId), [NOT_FOUND]);
    if (found.status !== "ok") return found;
    return ownedBy(scope, found.value) ? found : ABSENT;
  }

  async function ownedSchedule(scope: Scope, name: string): Promise<Outcome<PgcfSchedule>> {
    const found = await guard(() => provider.getSchedule(scope.databaseId, name), [NOT_FOUND]);
    if (found.status !== "ok") return found;
    return found.value.role === scope.runtimeRole ? found : ABSENT;
  }

  async function findDelivery(
    databaseId: string,
    deliveryId: string,
  ): Promise<PgcfWebhookDelivery | null> {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DELIVERY_PAGES; page += 1) {
      const result = await provider.listWebhookDeliveries(
        databaseId,
        cursor === undefined ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
      );
      const found = result.items.find((delivery) => delivery.id === deliveryId);
      if (found !== undefined) return found;
      if (result.nextCursor === null) return null;
      cursor = result.nextCursor;
    }
    return null;
  }

  async function createWebhook(
    scope: Scope,
    request: Extract<DatabaseEventRequest, { operation: "webhook.create" }>,
  ): Promise<Outcome<DatabaseWebhookCreated>> {
    if ((await ownedWebhooks(scope)).length >= DATABASE_WEBHOOK_LIMIT)
      return refuse("webhook_limit");
    const key = await databaseEventKey(request, request.idempotencyKey);
    const headers = request.webhook.headers;
    const created = await guard(async () => {
      const webhook = await provider.createWebhook(
        {
          url: request.webhook.url,
          eventTypes: request.webhook.event_types,
          databaseIds: [scope.databaseId],
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
        },
        { key },
      );
      if (!ownedBy(scope, webhook)) {
        // An untrusted provider answer naming another database grants no authority to delete it.
        throw new Error("Database webhook ownership changed during creation");
      }
      return webhook;
    }, [
      INPUT,
      INVALID,
      { status: 409, reason: "idempotency_conflict", outcome: refuse("idempotency_key_reused") },
      { status: 409, reason: "idempotency_in_progress", outcome: refuse("pending") },
      { status: 409, reason: null, outcome: refuse("webhook_limit") },
    ]);
    if (created.status !== "ok") return created;
    // Concurrent creates each pass the first check; the cap holds because only the first DATABASE_WEBHOOK_LIMIT
    // webhooks in creation order survive. A later one is removed again (best effort) and refused.
    const position = (await ownedWebhooks(scope))
      .sort(byCreation)
      .findIndex((webhook) => webhook.id === created.value.id);
    // A creation answer absent from the current owned list is not proof of an active webhook.
    if (position < 0) return refuse("idempotency_key_reused");
    if (position >= DATABASE_WEBHOOK_LIMIT) {
      await provider
        .deleteWebhook(created.value.id, { key: webhookCleanupKey(created.value.id) })
        .catch(() => undefined);
      return refuse("webhook_limit");
    }
    const value: unknown = {
      ...webhookWire(created.value, scope.environment),
      secret: created.value.secret,
    };
    assertDatabaseWebhookCreated(value);
    return ok(value);
  }

  async function listWebhooks(scope: Scope): Promise<Outcome<DatabaseWebhookPage>> {
    const value: unknown = {
      items: (await ownedWebhooks(scope)).map((webhook) => webhookWire(webhook, scope.environment)),
    };
    assertDatabaseWebhookPage(value);
    return ok(value);
  }

  async function listDeliveries(
    scope: Scope,
    request: Extract<DatabaseEventRequest, { operation: "delivery.list" }>,
  ): Promise<Outcome<DatabaseWebhookDeliveryPage>> {
    const webhookId = request.webhookId;
    const owned = new Set((await ownedWebhooks(scope)).map((webhook) => webhook.id));
    if (webhookId !== undefined && !owned.has(webhookId)) return ABSENT;
    // The cursor comes from the customer: PGCF refuses one it cannot decode, which is the customer's invalid input.
    const page = await guard(
      () =>
        provider.listWebhookDeliveries(scope.databaseId, {
          limit: request.limit,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        }),
      [INVALID, NOT_FOUND],
    );
    if (page.status !== "ok") return page;
    const value: unknown = {
      items: page.value.items
        .filter(
          (delivery) =>
            owned.has(delivery.webhookId) &&
            (webhookId === undefined || delivery.webhookId === webhookId),
        )
        .map(deliveryWire),
      next_cursor: page.value.nextCursor,
    };
    assertDatabaseWebhookDeliveryPage(value);
    return ok(value);
  }

  async function replayDelivery(
    scope: Scope,
    request: Extract<DatabaseEventRequest, { operation: "delivery.replay" }>,
  ): Promise<Outcome<DatabaseWebhookReplayAccepted>> {
    const deliveryId = request.deliveryId;
    const delivery = await findDelivery(scope.databaseId, deliveryId);
    if (delivery === null) return ABSENT;
    const webhooks = await ownedWebhooks(scope);
    if (!webhooks.some((webhook) => webhook.id === delivery.webhookId)) return ABSENT;
    const key = await databaseEventKey(request, request.idempotencyKey);
    return guard(async () => {
      const accepted = await provider.replayWebhookDelivery(scope.databaseId, deliveryId, { key });
      const value: unknown = { delivery_id: accepted.deliveryId, state: accepted.state };
      assertDatabaseWebhookReplayAccepted(value);
      return value;
    }, [NOT_FOUND, ...REPLAY_REFUSALS, { status: 409, outcome: refuse("delivery_pending") }]);
  }

  async function setSchedule(
    scope: Scope,
    request: Extract<DatabaseEventRequest, { operation: "schedule.set" }>,
  ): Promise<Outcome<DatabaseSchedule>> {
    // A name held by a schedule of another role is never replaced by a customer request.
    const existing = await guard(
      () => provider.getSchedule(scope.databaseId, request.name),
      [NOT_FOUND],
    );
    if (existing.status === "ok" && existing.value.role !== scope.runtimeRole) return ABSENT;
    const schedule = request.schedule;
    return guard(async () => {
      const stored = await provider.putSchedule(scope.databaseId, request.name, {
        ...(schedule.cron === null ? {} : { cron: schedule.cron }),
        ...(schedule.every_seconds === null ? {} : { everySeconds: schedule.every_seconds }),
        statements: [...schedule.statements],
        role: scope.runtimeRole,
        timeoutMs: schedule.timeout_ms,
        enabled: schedule.enabled,
      } satisfies PgcfScheduleUpsert);
      return scheduleWire(stored, scope.environment);
    }, [INPUT, INVALID, { status: 409, outcome: refuse("schedule_limit") }]);
  }

  async function listSchedules(scope: Scope): Promise<Outcome<DatabaseSchedulePage>> {
    const schedules = await provider.listSchedules(scope.databaseId);
    const value: unknown = {
      items: schedules
        .filter((schedule) => schedule.role === scope.runtimeRole)
        .map((schedule) => scheduleWire(schedule, scope.environment)),
    };
    assertDatabaseSchedulePage(value);
    return ok(value);
  }

  async function deleteSchedule(
    scope: Scope,
    name: string,
  ): Promise<Outcome<DatabaseScheduleDeleted>> {
    const found = await ownedSchedule(scope, name);
    if (found.status !== "ok") return found;
    return guard(async () => {
      await provider.deleteSchedule(scope.databaseId, name);
      const value: unknown = { name, deleted: true };
      assertDatabaseScheduleDeleted(value);
      return value;
    }, [NOT_FOUND]);
  }

  async function runsOf(
    scope: Scope,
    request: Extract<DatabaseEventRequest, { operation: "schedule.runs" }>,
  ): Promise<Outcome<DatabaseScheduleRunPage>> {
    const found = await ownedSchedule(scope, request.name);
    if (found.status !== "ok") return found;
    return guard(async () => {
      const runs = await provider.listScheduleRuns(scope.databaseId, request.name, request.limit);
      const value: unknown = { items: runs.map(scheduleRunWire) };
      assertDatabaseScheduleRunPage(value);
      return value;
    }, [NOT_FOUND]);
  }

  async function runNow(
    scope: Scope,
    request: Extract<DatabaseEventRequest, { operation: "schedule.run" }>,
  ): Promise<Outcome<DatabaseScheduleRunAccepted>> {
    const name = request.name;
    const found = await ownedSchedule(scope, name);
    if (found.status !== "ok") return found;
    const key = await databaseEventKey(request, request.idempotencyKey);
    return guard(async () => {
      const accepted = await provider.runScheduleNow(scope.databaseId, name, { key });
      const value: unknown = { schedule: accepted.schedule, state: accepted.state };
      assertDatabaseScheduleRunAccepted(value);
      return value;
    }, [NOT_FOUND, ...REPLAY_REFUSALS, { status: 409, outcome: refuse("schedule_not_runnable") }]);
  }

  async function usage(
    scope: Scope,
    request: Extract<DatabaseEventRequest, { operation: "usage.get" }>,
  ): Promise<Outcome<DatabaseExecutionUsagePage>> {
    const cursor = request.cursor;
    if (
      cursor !== undefined &&
      (cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(`${scope.databaseId}|`))
    )
      return refuse("invalid");
    // The cursor comes from the customer: PGCF refuses one it cannot decode, which is the customer's invalid input.
    const page = await guard(
      () =>
        provider.readExecutionUsage({
          scope: { databaseId: scope.databaseId },
          from: request.window.from,
          to: request.window.to,
          granularity: request.window.granularity,
          limit: request.limit,
          ...(cursor === undefined ? {} : { cursor }),
        }),
      [INVALID, NOT_FOUND],
    );
    if (page.status !== "ok") return page;
    const value: unknown = {
      items: page.value.rows.map((row) => {
        if (row.databaseId !== scope.databaseId || row.projectId !== provider.projectId)
          throw new Error("Database usage page returned a foreign scope");
        return { start: row.start, end: row.end, final: row.final, metrics: { ...row.metrics } };
      }),
      next_cursor: page.value.nextCursor,
    };
    assertDatabaseExecutionUsagePage(value);
    return ok(value);
  }

  async function run(request: DatabaseEventRequest): Promise<DatabaseEventOutcome> {
    const scope = await scopeOf(request);
    if (scope === null) return ABSENT;
    switch (request.operation) {
      case "webhook.create":
        return createWebhook(scope, request);
      case "webhook.list":
        return listWebhooks(scope);
      case "webhook.get": {
        const found = await ownedWebhook(scope, request.webhookId);
        if (found.status !== "ok") return found;
        return ok(webhookWire(found.value, scope.environment));
      }
      case "webhook.delete": {
        const found = await ownedWebhook(scope, request.webhookId);
        if (found.status !== "ok") return found;
        const key = await databaseEventKey(request, request.idempotencyKey);
        return guard(async () => {
          await provider.deleteWebhook(request.webhookId, { key });
          const value: unknown = { id: request.webhookId, deleted: true };
          assertDatabaseWebhookDeleted(value);
          return value;
        }, [NOT_FOUND, ...REPLAY_REFUSALS]);
      }
      case "webhook.test": {
        const found = await ownedWebhook(scope, request.webhookId);
        if (found.status !== "ok") return found;
        const key = await databaseEventKey(request, request.idempotencyKey);
        return guard(async () => {
          const result = await provider.testWebhook(request.webhookId, { key });
          const value: unknown = {
            delivered: result.delivered,
            status: result.status,
            error: result.error,
            duration_ms: result.durationMs,
          };
          assertDatabaseWebhookTest(value);
          return value;
        }, [NOT_FOUND, ...REPLAY_REFUSALS, { status: 429, outcome: refuse("throttled") }]);
      }
      case "delivery.list":
        return listDeliveries(scope, request);
      case "delivery.replay":
        return replayDelivery(scope, request);
      case "schedule.set":
        return setSchedule(scope, request);
      case "schedule.list":
        return listSchedules(scope);
      case "schedule.get": {
        const found = await ownedSchedule(scope, request.name);
        if (found.status !== "ok") return found;
        return ok(scheduleWire(found.value, scope.environment));
      }
      case "schedule.delete":
        return deleteSchedule(scope, request.name);
      case "schedule.runs":
        return runsOf(scope, request);
      case "schedule.run":
        return runNow(scope, request);
      case "usage.get":
        return usage(scope, request);
    }
  }

  return { run };
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value))
    throw new TypeError("Invalid database event request");
  return value;
}

/**
 * Parses the RPC envelope of `databaseEvents`. It returns the closed request only; the database, role and PGCF
 * project never come from the input.
 */
export function parseDatabaseEventRequest(value: unknown): DatabaseEventRequest {
  const { operation: op, envelope, input } = parseDatabaseRequest(value, SHAPES);
  switch (op) {
    case "webhook.create":
      return {
        ...envelope,
        operation: op,
        webhook: parseDatabaseWebhookCreateRequest({
          url: input["url"],
          event_types: input["eventTypes"],
          ...(input["headers"] === undefined ? {} : { headers: input["headers"] }),
        }),
        idempotencyKey: idempotencyKey(input["idempotencyKey"]),
      };
    case "webhook.list":
    case "schedule.list":
      return { ...envelope, operation: op };
    case "webhook.get":
      return { ...envelope, operation: op, webhookId: parseDatabaseWebhookId(input["webhookId"]) };
    case "webhook.delete":
    case "webhook.test":
      return {
        ...envelope,
        operation: op,
        webhookId: parseDatabaseWebhookId(input["webhookId"]),
        idempotencyKey: idempotencyKey(input["idempotencyKey"]),
      };
    case "delivery.list": {
      const cursor = parseDatabaseCursor(input["cursor"]) ?? undefined,
        webhookId =
          input["webhookId"] === undefined ? undefined : parseDatabaseWebhookId(input["webhookId"]);
      return {
        ...envelope,
        operation: op,
        limit: parseDatabaseListLimit(
          input["limit"],
          DATABASE_PAGE_MAX_ITEMS,
          DATABASE_PAGE_MAX_ITEMS,
        ),
        ...(webhookId === undefined ? {} : { webhookId }),
        ...(cursor === undefined ? {} : { cursor }),
      };
    }
    case "delivery.replay":
      return {
        ...envelope,
        operation: op,
        deliveryId: parseDatabaseDeliveryId(input["deliveryId"]),
        idempotencyKey: idempotencyKey(input["idempotencyKey"]),
      };
    case "schedule.set":
      return {
        ...envelope,
        operation: op,
        name: parseDatabaseScheduleName(input["name"]),
        schedule: parseDatabaseScheduleSetRequest({
          ...(input["cron"] === undefined ? {} : { cron: input["cron"] }),
          ...(input["everySeconds"] === undefined ? {} : { every_seconds: input["everySeconds"] }),
          statements: input["statements"],
          ...(input["timeoutMs"] === undefined ? {} : { timeout_ms: input["timeoutMs"] }),
          ...(input["enabled"] === undefined ? {} : { enabled: input["enabled"] }),
          confirm: true,
        }),
      };
    case "schedule.get":
    case "schedule.delete":
      return { ...envelope, operation: op, name: parseDatabaseScheduleName(input["name"]) };
    case "schedule.run":
      return {
        ...envelope,
        operation: op,
        name: parseDatabaseScheduleName(input["name"]),
        idempotencyKey: idempotencyKey(input["idempotencyKey"]),
      };
    case "schedule.runs":
      return {
        ...envelope,
        operation: op,
        name: parseDatabaseScheduleName(input["name"]),
        limit: parseDatabaseListLimit(input["limit"], MAX_SCHEDULE_RUNS, MAX_SCHEDULE_RUNS),
      };
    case "usage.get": {
      const cursor = parseDatabaseCursor(input["cursor"]) ?? undefined;
      return {
        ...envelope,
        operation: op,
        window: parseDatabaseUsageWindow(input["from"], input["to"], input["granularity"]),
        limit: parseDatabaseListLimit(input["limit"], PAGE_LIMIT, PAGE_LIMIT),
        ...(cursor === undefined ? {} : { cursor }),
      };
    }
  }
}
