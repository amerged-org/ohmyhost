import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProviderTarget } from "@ohmyhost/database";
import {
  PgcfProviderError,
  type PgcfExecutionUsageRow,
  type PgcfSchedule,
  type PgcfScheduleRun,
  type PgcfWebhook,
  type PgcfWebhookDelivery,
} from "@ohmyhost/provider-pgcf";
import {
  createPgcfDatabaseEvents,
  parseDatabaseEventRequest,
  sweepOrphanDatabaseWebhooks,
  type DatabaseEventsProvider,
} from "../src/pgcf-database-events.js";
import {
  isDatabaseWebhookSubscriptionOperation,
  parseDatabaseWebhookSubscriptionRequest,
} from "../src/pgcf-webhook-subscriptions.js";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; the entrypoint and the parsers are production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));

afterEach(() => vi.restoreAllMocks());

// Identifiers follow the shapes of the PGCF and OMH contracts (contracts/src/database-events.ts, provider-pgcf).
const PGCF_PROJECT = "prj_abcdefghij0123456789",
  OMH_PROJECT = "01J7ABCDEFGHJKMNPQRSTVWXYZ",
  OTHER_PROJECT = `01J7${"B".repeat(22)}`,
  ORG = "01J5ABCDEFGHJKMNPQRSTVWXYZ",
  OTHER_ORG = `01J5${"B".repeat(22)}`,
  PHYSICAL = "01J6ABCDEFGHJKMNPQRSTVWXYZ",
  DB = "aaaaaaaaaaaaaaaaaaaa",
  OTHER_DB = "bbbbbbbbbbbbbbbbbbbb",
  RUNTIME_ROLE = "ohmyho_rw_01j6abcdefghjkmnpqrstvwxyz",
  FOREIGN_ROLE = "ohmyho_m_01j6abcdefghjkmnpqrstvwxyz",
  WH_MINE = `whk_${"m".repeat(20)}`,
  WH_OTHER = `whk_${"o".repeat(20)}`,
  WH_THIRD = `whk_${"t".repeat(20)}`,
  DLV_MINE = `dlv_${"0".repeat(19)}1`,
  DLV_OTHER = `dlv_${"0".repeat(19)}2`,
  DLV_LATER = `dlv_${"0".repeat(19)}3`,
  WH_LATER = `whk_${"l".repeat(20)}`,
  EVT = `evt_${"0".repeat(19)}1`,
  HOUR_START = "2026-10-30T10:00:00.000Z",
  HOUR_END = "2026-10-30T11:00:00.000Z";

const KEY = "replay-key-0001";

const envelope = {
  organizationId: ORG,
  projectId: OMH_PROJECT,
  environment: "dev" as const,
};

const unexpected = (): never => {
  throw new Error("Unexpected provider call");
};

/** A PGCF webhook as `listWebhooks`/`getWebhook` return it; `databaseIds` decides ownership. */
function webhook(
  id: string,
  databaseIds: readonly string[] | null,
  overrides: Partial<PgcfWebhook> = {},
): PgcfWebhook {
  return {
    id,
    projectId: PGCF_PROJECT,
    url: "https://example.com/hook",
    eventTypes: ["database.ready"],
    databaseIds,
    headerNames: [],
    createdAt: "2026-10-30T10:00:00.000Z",
    ...overrides,
  };
}

function schedule(name: string, role = RUNTIME_ROLE): PgcfSchedule {
  return {
    name,
    cron: null,
    everySeconds: 3600,
    statements: ["SELECT 1"],
    role,
    timeoutMs: 10_000,
    enabled: true,
    nextRunAt: "2026-10-30T11:00:00.000Z",
    createdAt: "2026-10-30T10:00:00.000Z",
  };
}

function delivery(id: string, webhookId: string): PgcfWebhookDelivery {
  return {
    id,
    eventId: EVT,
    eventType: "database.ready",
    webhookId,
    state: "pending",
    attempts: 1,
    createdAt: "2026-10-30T10:00:00.000Z",
    nextAttemptAt: null,
    deliveredAt: null,
    lastStatus: null,
    lastError: null,
  };
}

function target(databaseId = DB, providerProjectId = PGCF_PROJECT): DatabaseProviderTarget {
  return {
    provider: "pgcf",
    organizationId: ORG,
    projectId: OMH_PROJECT,
    physicalEnvironmentId: PHYSICAL,
    targetVersion: 1,
    providerProjectId,
    regionId: "eu-dev",
    runtimeRole: RUNTIME_ROLE,
    credentialReference: "pgcf-dev",
    activatedAt: null,
    databaseId,
    sizeClassId: "small",
  };
}

const scopeOf = (resolved: DatabaseProviderTarget | null) => async () => ({
  physicalEnvironmentId: PHYSICAL,
  target: resolved,
});

function provider(overrides: Partial<DatabaseEventsProvider>): DatabaseEventsProvider {
  return {
    projectId: PGCF_PROJECT,
    listWebhooks: unexpected,
    createWebhook: unexpected,
    getWebhook: unexpected,
    deleteWebhook: unexpected,
    testWebhook: unexpected,
    listWebhookDeliveries: unexpected,
    replayWebhookDelivery: unexpected,
    getSchedule: unexpected,
    putSchedule: unexpected,
    listSchedules: unexpected,
    deleteSchedule: unexpected,
    listScheduleRuns: unexpected,
    runScheduleNow: unexpected,
    readExecutionUsage: unexpected,
    ...overrides,
  };
}

const events = (
  overrides: Partial<DatabaseEventsProvider>,
  resolved: DatabaseProviderTarget | null = target(),
) => createPgcfDatabaseEvents({ readScope: scopeOf(resolved), provider: provider(overrides) });

describe("tenant isolation of webhooks", () => {
  it("lists and reads only webhooks PGCF stores for exactly this database", async () => {
    const pages = [
      {
        items: [
          webhook(WH_MINE, [DB]),
          webhook(WH_OTHER, [DB, OTHER_DB]),
          webhook(WH_THIRD, null),
          webhook(`whk_${"u".repeat(20)}`, [DB], { projectId: "prj_otherprojectxxxxxxxx" }),
        ],
        nextCursor: "page-2",
      },
      { items: [webhook(`whk_${"v".repeat(20)}`, [OTHER_DB])], nextCursor: null },
    ];
    const cursors: (string | undefined)[] = [];
    const service = events({
      listWebhooks: async (input) => {
        cursors.push(input.cursor);
        return pages[cursors.length - 1] as (typeof pages)[number];
      },
      getWebhook: async (id) =>
        id === WH_MINE ? webhook(WH_MINE, [DB]) : webhook(WH_OTHER, [OTHER_DB]),
    });
    const listed = await service.run({ ...envelope, operation: "webhook.list" });
    expect(listed).toMatchObject({
      status: "ok",
      value: { items: [{ id: WH_MINE, environment: "dev", event_types: ["database.ready"] }] },
    });
    expect(cursors).toEqual([undefined, "page-2"]);
    expect(JSON.stringify(listed)).not.toContain("database_ids");
    await expect(
      service.run({ ...envelope, operation: "webhook.get", webhookId: WH_OTHER }),
    ).resolves.toEqual({
      status: "absent",
    });
  });

  it("answers absent for a webhook of several databases, of none or of another project", async () => {
    for (const stored of [
      webhook(WH_OTHER, [OTHER_DB]),
      webhook(WH_OTHER, [DB, OTHER_DB]),
      webhook(WH_OTHER, null),
      webhook(WH_OTHER, [DB], { projectId: "prj_otherprojectxxxxxxxx" }),
    ]) {
      // PGCF is never asked to delete or send for a webhook that is not owned.
      const service = events({
        getWebhook: async () => stored,
        deleteWebhook: unexpected,
        testWebhook: unexpected,
      });
      for (const operation of ["webhook.delete", "webhook.test"] as const) {
        await expect(
          service.run({ ...envelope, operation, webhookId: WH_OTHER, idempotencyKey: KEY }),
        ).resolves.toEqual({ status: "absent" });
      }
    }
  });

  it("refuses a provider answer for another database without deleting the foreign webhook", async () => {
    const deleted: string[] = [];
    const service = events({
      listWebhooks: async () => ({ items: [], nextCursor: null }),
      createWebhook: async () => ({ ...webhook(WH_OTHER, [OTHER_DB]), secret: "whsec_test" }),
      deleteWebhook: async (id) => void deleted.push(id),
    });
    await expect(
      service.run({
        ...envelope,
        operation: "webhook.create",
        webhook: { url: "https://example.com/hook", event_types: ["database.ready"], headers: {} },
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow("Database webhook ownership changed during creation");
    expect(deleted).toEqual([]);
    const stuck = events({
      listWebhooks: async () => ({ items: [], nextCursor: null }),
      createWebhook: async () => ({ ...webhook(WH_OTHER, [OTHER_DB]), secret: "whsec_test" }),
      deleteWebhook: async () => {
        throw new PgcfProviderError("transport");
      },
    });
    await expect(
      stuck.run({
        ...envelope,
        operation: "webhook.create",
        webhook: { url: "https://example.com/hook", event_types: ["database.ready"], headers: {} },
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow("Database webhook ownership changed during creation");
  });

  it("creates a webhook for its database with a derived key and returns the secret once", async () => {
    const keys: string[] = [];
    const bodies: unknown[] = [];
    let created = false;
    const service = events({
      listWebhooks: async () => ({
        items: created ? [webhook(WH_MINE, [DB])] : [],
        nextCursor: null,
      }),
      createWebhook: async (input, options) => {
        created = true;
        bodies.push(input);
        keys.push(options.key);
        return { ...webhook(WH_MINE, [DB], { headerNames: ["x-token"] }), secret: "whsec_test" };
      },
    });
    const result = await service.run({
      ...envelope,
      operation: "webhook.create",
      webhook: {
        url: "https://example.com/hook",
        event_types: ["database.ready"],
        headers: { "x-token": "value" },
      },
      idempotencyKey: "key-1",
    });
    expect(result).toEqual({
      status: "ok",
      value: {
        id: WH_MINE,
        environment: "dev",
        url: "https://example.com/hook",
        event_types: ["database.ready"],
        header_names: ["x-token"],
        created_at: "2026-10-30T10:00:00.000Z",
        secret: "whsec_test",
      },
    });
    expect(bodies).toEqual([
      {
        url: "https://example.com/hook",
        eventTypes: ["database.ready"],
        databaseIds: [DB],
        headers: { "x-token": "value" },
      },
    ]);
    expect(keys[0]).toMatch(/^omh-wh-[0-9a-f]{64}$/u);
    const deletedReceipt = events({
      listWebhooks: async () => ({ items: [], nextCursor: null }),
      createWebhook: async () => ({ ...webhook(WH_MINE, [DB]), secret: "whsec_test" }),
    });
    expect(
      await deletedReceipt.run({
        ...envelope,
        operation: "webhook.create",
        webhook: { url: "https://example.com/hook", event_types: ["database.ready"], headers: {} },
        idempotencyKey: "key-1",
      }),
    ).toEqual({ status: "rejected", code: "idempotency_key_reused" });
  });

  it("refuses a new webhook at the environment limit before PGCF is asked", async () => {
    const owned = Array.from({ length: 5 }, (_, index) =>
      webhook(`whk_${String(index).repeat(20)}`, [DB]),
    );
    const service = events({
      listWebhooks: async () => ({ items: owned, nextCursor: null }),
    });
    await expect(
      service.run({
        ...envelope,
        operation: "webhook.create",
        webhook: { url: "https://example.com/hook", event_types: ["database.ready"], headers: {} },
        idempotencyKey: "key-1",
      }),
    ).resolves.toEqual({ status: "rejected", code: "webhook_limit" });
  });

  it("maps PGCF create refusals to closed codes and leaves other failures to the caller", async () => {
    const answer = (error: PgcfProviderError) =>
      events({
        listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
        createWebhook: async () => {
          throw error;
        },
      }).run({
        ...envelope,
        operation: "webhook.create",
        webhook: { url: "https://example.com/hook", event_types: ["database.ready"], headers: {} },
        idempotencyKey: "key-1",
      });
    await expect(
      answer(new PgcfProviderError("rejected", 409, false, "idempotency_conflict")),
    ).resolves.toEqual({
      status: "rejected",
      code: "idempotency_key_reused",
    });
    await expect(
      answer(new PgcfProviderError("rejected", 409, false, "idempotency_in_progress")),
    ).resolves.toEqual({
      status: "rejected",
      code: "pending",
    });
    await expect(answer(new PgcfProviderError("rejected", 409))).resolves.toEqual({
      status: "rejected",
      code: "webhook_limit",
    });
    await expect(answer(new PgcfProviderError("rejected", 400))).resolves.toEqual({
      status: "rejected",
      code: "invalid",
    });
    // The provider refuses a URL it cannot send before any request: the customer's input is invalid.
    await expect(answer(new PgcfProviderError("input"))).resolves.toEqual({
      status: "rejected",
      code: "invalid",
    });
    // A conflict with another reason is not a webhook limit: it is rethrown.
    await expect(
      answer(new PgcfProviderError("rejected", 409, false, "database_deleted")),
    ).rejects.toMatchObject({ code: "rejected", status: 409 });
    await expect(answer(new PgcfProviderError("transport"))).rejects.toMatchObject({
      code: "transport",
    });
  });

  it("refuses a create beyond the limit even when PGCF refuses its removal", async () => {
    const earlier = Array.from({ length: 5 }, (_, index) =>
      webhook(`whk_${String(index).padStart(20, "0")}`, [DB], {
        createdAt: `2026-10-30T10:00:0${index}.000Z`,
      }),
    );
    const created = webhook(WH_LATER, [DB], { createdAt: "2026-10-30T10:00:09.000Z" });
    const listings = [earlier.slice(0, 4), [...earlier, created]];
    const service = events({
      listWebhooks: async () => ({ items: listings.shift() ?? [], nextCursor: null }),
      createWebhook: async () => ({ ...created, secret: "whsec_test" }),
      deleteWebhook: async () => {
        throw new PgcfProviderError("transport");
      },
    });
    await expect(
      service.run({
        ...envelope,
        operation: "webhook.create",
        webhook: { url: "https://example.com/hook", event_types: ["database.ready"], headers: {} },
        idempotencyKey: "key-1",
      }),
    ).resolves.toEqual({ status: "rejected", code: "webhook_limit" });
  });

  it("derives the PGCF idempotency key from the tenant, environment and caller key", async () => {
    const keys: string[] = [];
    const scopes: unknown[] = [];
    const service = createPgcfDatabaseEvents({
      readScope: async (input) => {
        scopes.push(input);
        return { physicalEnvironmentId: PHYSICAL, target: target() };
      },
      provider: provider({
        listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
        createWebhook: async (_input, options) => {
          keys.push(options.key);
          return { ...webhook(WH_MINE, [DB]), secret: "whsec_test" };
        },
      }),
    });
    const create = (
      scope: { organizationId?: string; projectId?: string; environment?: "dev" | "prod" },
      idempotencyKey = "key-1",
    ) =>
      service.run({
        ...envelope,
        ...scope,
        operation: "webhook.create",
        webhook: { url: "https://example.com/hook", event_types: ["database.ready"], headers: {} },
        idempotencyKey,
      });
    const digest = (text: string) => createHash("sha256").update(text).digest("hex");
    await create({});
    await create({});
    // A retried create (same request) sends the same key, so PGCF replays it instead of duplicating.
    expect(keys).toEqual([
      `omh-wh-${digest(`${ORG}:${OMH_PROJECT}:dev:key-1`)}`,
      `omh-wh-${digest(`${ORG}:${OMH_PROJECT}:dev:key-1`)}`,
    ]);
    await create({ organizationId: OTHER_ORG });
    await create({ projectId: OTHER_PROJECT });
    await create({}, "key-2");
    // Every other tenant, environment or caller key gets a key of its own.
    const prod = await create({ environment: "prod" });
    expect(prod).toMatchObject({ status: "ok", value: { environment: "prod" } });
    expect(new Set(keys).size).toBe(5);
    expect(scopes.at(-1)).toEqual({
      organizationId: ORG,
      projectId: OMH_PROJECT,
      environment: "prod",
    });
  });

  it("keeps parallel creates at the environment limit with a stable winner", async () => {
    // Four webhooks exist; three parallel creates each pass the first check before any of them is stored.
    const stored: PgcfWebhook[] = Array.from({ length: 4 }, (_, index) =>
      webhook(`whk_${String(index).padStart(20, "0")}`, [DB], {
        createdAt: `2026-10-30T10:00:0${index}.000Z`,
      }),
    );
    let sequence = 4;
    const service = events({
      listWebhooks: async () => ({ items: [...stored], nextCursor: null }),
      createWebhook: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const created = webhook(`whk_${String(sequence).padStart(20, "0")}`, [DB], {
          createdAt: `2026-10-30T10:00:${String(sequence).padStart(2, "0")}.000Z`,
        });
        sequence += 1;
        stored.push(created);
        return { ...created, secret: "whsec_test" };
      },
      deleteWebhook: async (id) => {
        stored.splice(
          stored.findIndex((webhook) => webhook.id === id),
          1,
        );
      },
    });
    const request = {
      ...envelope,
      operation: "webhook.create" as const,
      webhook: {
        url: "https://example.com/hook",
        event_types: ["database.ready"] as const,
        headers: {},
      },
    };
    const results = await Promise.all(
      ["key-a", "key-b", "key-c"].map((idempotencyKey) =>
        service.run({ ...request, idempotencyKey }),
      ),
    );
    expect(results.filter((result) => result.status === "ok")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", code: "webhook_limit" },
      { status: "rejected", code: "webhook_limit" },
    ]);
    expect(stored).toHaveLength(5);
  });

  it("serves get, delete and test of an owned webhook and maps PGCF refusals", async () => {
    const service = events({
      getWebhook: async () => webhook(WH_MINE, [DB]),
      deleteWebhook: async () => undefined,
      testWebhook: async () => ({ delivered: false, status: 500, error: "http", durationMs: 12 }),
    });
    await expect(
      service.run({ ...envelope, operation: "webhook.get", webhookId: WH_MINE }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { id: WH_MINE },
    });
    await expect(
      service.run({
        ...envelope,
        operation: "webhook.delete",
        webhookId: WH_MINE,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({
      status: "ok",
      value: { id: WH_MINE, deleted: true },
    });
    await expect(
      service.run({
        ...envelope,
        operation: "webhook.test",
        webhookId: WH_MINE,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({
      status: "ok",
      value: { delivered: false, status: 500, error: "http", duration_ms: 12 },
    });
    const throttled = events({
      getWebhook: async () => webhook(WH_MINE, [DB]),
      testWebhook: async () => {
        throw new PgcfProviderError("rejected", 429);
      },
    });
    await expect(
      throttled.run({
        ...envelope,
        operation: "webhook.test",
        webhookId: WH_MINE,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "throttled",
    });
  });
});

describe("tenant isolation of deliveries", () => {
  it("lists only deliveries of owned webhooks and replays only those", async () => {
    const service = events({
      listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
      listWebhookDeliveries: async () => ({
        items: [delivery(DLV_MINE, WH_MINE), delivery(DLV_OTHER, WH_OTHER)],
        nextCursor: "next",
      }),
      replayWebhookDelivery: async (_database, id) => ({ deliveryId: id, state: "pending" }),
    });
    const page = await service.run({ ...envelope, operation: "delivery.list", limit: 50 });
    expect(page).toMatchObject({
      status: "ok",
      value: { items: [{ id: DLV_MINE, event_type: "database.ready" }], next_cursor: "next" },
    });
    await expect(
      service.run({ ...envelope, operation: "delivery.list", limit: 50, webhookId: WH_OTHER }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      service.run({
        ...envelope,
        operation: "delivery.replay",
        deliveryId: DLV_MINE,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ status: "ok", value: { delivery_id: DLV_MINE, state: "pending" } });
  });

  it("answers absent for a delivery of a foreign webhook and maps a delivery still retried", async () => {
    const foreign = events({
      listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
      listWebhookDeliveries: async () => ({
        items: [delivery(DLV_OTHER, WH_OTHER)],
        nextCursor: null,
      }),
    });
    await expect(
      foreign.run({
        ...envelope,
        operation: "delivery.replay",
        deliveryId: DLV_OTHER,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      foreign.run({
        ...envelope,
        operation: "delivery.replay",
        deliveryId: DLV_MINE,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ status: "absent" });
    const retried = events({
      listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
      listWebhookDeliveries: async () => ({
        items: [delivery(DLV_MINE, WH_MINE)],
        nextCursor: null,
      }),
      replayWebhookDelivery: async () => {
        throw new PgcfProviderError("rejected", 409, false, "delivery_retrying");
      },
    });
    await expect(
      retried.run({
        ...envelope,
        operation: "delivery.replay",
        deliveryId: DLV_MINE,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ status: "rejected", code: "delivery_pending" });
  });
});

describe("delivery cursors and filters", () => {
  it("answers invalid for a customer cursor that PGCF refuses, not a retryable failure", async () => {
    const refused = new PgcfProviderError("rejected", 400);
    const service = events({
      listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
      listWebhookDeliveries: async () => {
        throw refused;
      },
      readExecutionUsage: async () => {
        throw refused;
      },
    });
    await expect(
      service.run({ ...envelope, operation: "delivery.list", limit: 50, cursor: "garbage" }),
    ).resolves.toEqual({ status: "rejected", code: "invalid" });
    await expect(
      service.run({
        ...envelope,
        operation: "usage.get",
        window: { from: HOUR_START, to: HOUR_END, granularity: "hour" },
        limit: 50,
        cursor: `${DB}|garbage`,
      }),
    ).resolves.toEqual({ status: "rejected", code: "invalid" });
  });

  it("lists the deliveries of the requested owned webhook only and replays one from a later page", async () => {
    const service = events({
      listWebhooks: async () => ({
        items: [webhook(WH_MINE, [DB]), webhook(WH_LATER, [DB])],
        nextCursor: null,
      }),
      listWebhookDeliveries: async (_database, input) =>
        input.cursor === undefined
          ? {
              items: [delivery(DLV_MINE, WH_MINE), delivery(DLV_OTHER, WH_LATER)],
              nextCursor: "page-2",
            }
          : { items: [delivery(DLV_LATER, WH_MINE)], nextCursor: null },
      replayWebhookDelivery: async (_database, id) => ({ deliveryId: id, state: "pending" }),
    });
    await expect(
      service.run({ ...envelope, operation: "delivery.list", limit: 50, webhookId: WH_MINE }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { items: [{ id: DLV_MINE }], next_cursor: "page-2" },
    });
    await expect(
      service.run({
        ...envelope,
        operation: "delivery.replay",
        deliveryId: DLV_LATER,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ status: "ok", value: { delivery_id: DLV_LATER, state: "pending" } });
  });

  it("answers absent for a replay of a delivery PGCF no longer has", async () => {
    const service = events({
      listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
      listWebhookDeliveries: async () => ({
        items: [delivery(DLV_MINE, WH_MINE)],
        nextCursor: null,
      }),
      replayWebhookDelivery: async () => {
        throw new PgcfProviderError("rejected", 404);
      },
    });
    await expect(
      service.run({
        ...envelope,
        operation: "delivery.replay",
        deliveryId: DLV_MINE,
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({ status: "absent" });
  });
});

describe("tenant isolation of schedules", () => {
  it("hides and refuses schedules that run as another role and never replaces them", async () => {
    let put = false;
    const service = events({
      listSchedules: async () => [schedule("mine"), schedule("theirs", FOREIGN_ROLE)],
      getSchedule: async (_database, name) =>
        name === "theirs" ? schedule("theirs", FOREIGN_ROLE) : schedule(name),
      putSchedule: async () => {
        put = true;
        return schedule("theirs");
      },
      deleteSchedule: async () => undefined,
      listScheduleRuns: async () => [] as readonly PgcfScheduleRun[],
      runScheduleNow: async () => ({ schedule: "mine", state: "queued" as const }),
    });
    const listed = await service.run({ ...envelope, operation: "schedule.list" });
    expect(listed).toMatchObject({ status: "ok", value: { items: [{ name: "mine" }] } });
    for (const operation of [
      "schedule.get",
      "schedule.delete",
      "schedule.runs",
      "schedule.run",
    ] as const) {
      const request =
        operation === "schedule.runs"
          ? { ...envelope, operation, name: "theirs", limit: 20 }
          : operation === "schedule.run"
            ? { ...envelope, operation, name: "theirs", idempotencyKey: KEY }
            : { ...envelope, operation, name: "theirs" };
      await expect(service.run(request)).resolves.toEqual({ status: "absent" });
    }
    await expect(
      service.run({
        ...envelope,
        operation: "schedule.set",
        name: "theirs",
        schedule: {
          cron: null,
          every_seconds: 3600,
          statements: ["SELECT 1"],
          timeout_ms: 10_000,
          enabled: true,
        },
      }),
    ).resolves.toEqual({ status: "absent" });
    expect(put).toBe(false);
  });

  it("sets an owned schedule with the application's runtime role and maps the PGCF limits", async () => {
    const roles: string[] = [];
    const service = events({
      getSchedule: async () => {
        throw new PgcfProviderError("rejected", 404);
      },
      putSchedule: async (database, name, body) => {
        expect(database).toBe(DB);
        roles.push(body.role);
        return {
          ...schedule(name),
          statements: [...body.statements],
          timeoutMs: body.timeoutMs ?? 0,
        };
      },
    });
    await expect(
      service.run({
        ...envelope,
        operation: "schedule.set",
        name: "nightly",
        schedule: {
          cron: null,
          every_seconds: 3600,
          statements: ["SELECT 1"],
          timeout_ms: 10_000,
          enabled: true,
        },
      }),
    ).resolves.toMatchObject({ status: "ok", value: { name: "nightly", every_seconds: 3600 } });
    expect(roles).toEqual([RUNTIME_ROLE]);
    const limited = events({
      getSchedule: async () => {
        throw new PgcfProviderError("rejected", 404);
      },
      putSchedule: async () => {
        throw new PgcfProviderError("rejected", 409, false, "schedule_limit");
      },
    });
    await expect(
      limited.run({
        ...envelope,
        operation: "schedule.set",
        name: "nightly",
        schedule: {
          cron: null,
          every_seconds: 3600,
          statements: ["SELECT 1"],
          timeout_ms: 10_000,
          enabled: true,
        },
      }),
    ).resolves.toEqual({ status: "rejected", code: "schedule_limit" });
  });

  it("serves owned schedule reads, runs and deletes and maps a schedule that cannot run", async () => {
    const run: PgcfScheduleRun = {
      id: 1,
      schedule: "nightly",
      scheduledAt: HOUR_START,
      startedAt: HOUR_START,
      finishedAt: HOUR_END,
      outcome: "succeeded",
      sqlstate: null,
      attempts: 1,
      manual: false,
    };
    const service = events({
      getSchedule: async (_database, name) => schedule(name),
      listScheduleRuns: async () => [run],
      runScheduleNow: async () => ({ schedule: "nightly", state: "queued" as const }),
      deleteSchedule: async () => undefined,
    });
    await expect(
      service.run({ ...envelope, operation: "schedule.get", name: "nightly" }),
    ).resolves.toMatchObject({
      status: "ok",
      value: { name: "nightly", environment: "dev" },
    });
    await expect(
      service.run({ ...envelope, operation: "schedule.runs", name: "nightly", limit: 20 }),
    ).resolves.toMatchObject({ status: "ok", value: { items: [{ id: 1, outcome: "succeeded" }] } });
    await expect(
      service.run({ ...envelope, operation: "schedule.run", name: "nightly", idempotencyKey: KEY }),
    ).resolves.toEqual({
      status: "ok",
      value: { schedule: "nightly", state: "queued" },
    });
    await expect(
      service.run({ ...envelope, operation: "schedule.delete", name: "nightly" }),
    ).resolves.toEqual({
      status: "ok",
      value: { name: "nightly", deleted: true },
    });
    const notRunnable = events({
      getSchedule: async (_database, name) => schedule(name),
      runScheduleNow: async () => {
        throw new PgcfProviderError("rejected", 409, false, "schedule_running");
      },
    });
    await expect(
      notRunnable.run({
        ...envelope,
        operation: "schedule.run",
        name: "nightly",
        idempotencyKey: KEY,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "schedule_not_runnable",
    });
  });
});

describe("schedule status mapping", () => {
  it("answers absent for a schedule PGCF does not know and refuses an invalid schedule", async () => {
    const service = events({
      getSchedule: async () => {
        throw new PgcfProviderError("rejected", 404);
      },
      listScheduleRuns: unexpected,
      putSchedule: async () => {
        throw new PgcfProviderError("rejected", 400);
      },
    });
    await expect(
      service.run({ ...envelope, operation: "schedule.get", name: "nightly" }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      service.run({ ...envelope, operation: "schedule.runs", name: "nightly", limit: 20 }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      service.run({ ...envelope, operation: "schedule.delete", name: "nightly" }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      service.run({ ...envelope, operation: "schedule.run", name: "nightly", idempotencyKey: KEY }),
    ).resolves.toEqual({ status: "absent" });
    const request = {
      ...envelope,
      operation: "schedule.set" as const,
      name: "nightly",
      schedule: {
        cron: null,
        every_seconds: 3600,
        statements: ["SELECT 1"],
        timeout_ms: 10_000,
        enabled: true,
      },
    };
    await expect(service.run(request)).resolves.toEqual({ status: "rejected", code: "invalid" });
    // The provider refuses a schedule it cannot send before any request: the customer's input is invalid.
    const refusedBeforeSend = events({
      getSchedule: async () => {
        throw new PgcfProviderError("rejected", 404);
      },
      putSchedule: async () => {
        throw new PgcfProviderError("input");
      },
    });
    await expect(refusedBeforeSend.run(request)).resolves.toEqual({
      status: "rejected",
      code: "invalid",
    });
  });

  it("passes the parsed arguments of each schedule and usage call to PGCF unchanged", async () => {
    const calls: unknown[] = [];
    const service = events({
      getSchedule: async (_database, name) => schedule(name),
      putSchedule: async (database, name, body) => {
        calls.push(["putSchedule", database, name, body]);
        return { ...schedule(name), timeoutMs: body.timeoutMs ?? 0 };
      },
      deleteSchedule: async (database, name) => {
        calls.push(["deleteSchedule", database, name]);
      },
      listScheduleRuns: async (database, name, limit) => {
        calls.push(["listScheduleRuns", database, name, limit]);
        return [];
      },
      runScheduleNow: async (database, name) => {
        calls.push(["runScheduleNow", database, name]);
        return { schedule: name, state: "queued" as const };
      },
      listWebhookDeliveries: async (database, input) => {
        calls.push(["listWebhookDeliveries", database, input]);
        return { items: [], nextCursor: null };
      },
      listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
      readExecutionUsage: async (input) => {
        calls.push(["readExecutionUsage", input]);
        return { rows: [], nextCursor: null };
      },
    });
    await service.run({
      ...envelope,
      operation: "schedule.set",
      name: "nightly",
      schedule: {
        cron: "0 * * * *",
        every_seconds: null,
        statements: ["SELECT 1"],
        timeout_ms: 15_000,
        enabled: false,
      },
    });
    await service.run({ ...envelope, operation: "schedule.delete", name: "nightly" });
    await service.run({ ...envelope, operation: "schedule.runs", name: "nightly", limit: 20 });
    await service.run({
      ...envelope,
      operation: "schedule.run",
      name: "nightly",
      idempotencyKey: KEY,
    });
    await service.run({ ...envelope, operation: "delivery.list", limit: 7, cursor: "abc|1" });
    await service.run({
      ...envelope,
      operation: "usage.get",
      window: { from: HOUR_START, to: HOUR_END, granularity: "hour" },
      limit: 7,
      cursor: `${DB}|2`,
    });
    expect(calls).toEqual([
      [
        "putSchedule",
        DB,
        "nightly",
        {
          cron: "0 * * * *",
          statements: ["SELECT 1"],
          role: RUNTIME_ROLE,
          timeoutMs: 15_000,
          enabled: false,
        },
      ],
      ["deleteSchedule", DB, "nightly"],
      ["listScheduleRuns", DB, "nightly", 20],
      ["runScheduleNow", DB, "nightly"],
      ["listWebhookDeliveries", DB, { limit: 7, cursor: "abc|1" }],
      [
        "readExecutionUsage",
        {
          scope: { databaseId: DB },
          from: HOUR_START,
          to: HOUR_END,
          granularity: "hour",
          limit: 7,
          cursor: `${DB}|2`,
        },
      ],
    ]);
  });
});

describe("tenant isolation of execution usage", () => {
  const usageRow = (
    databaseId: string,
    overrides: Partial<PgcfExecutionUsageRow> = {},
  ): PgcfExecutionUsageRow => ({
    databaseId,
    projectId: PGCF_PROJECT,
    start: HOUR_START,
    end: HOUR_END,
    final: true,
    metrics: {
      schedule_runs_succeeded: 2,
      schedule_runs_failed: 0,
      schedule_runs_timed_out: 0,
      schedule_runs_outcome_unknown: 0,
      schedule_runs_rejected: 0,
      schedule_runs_skipped: 0,
      events_emitted: 0,
      event_bytes: 0,
      webhook_attempts: 3,
      webhook_deliveries_delivered: 0,
      webhook_deliveries_dead_lettered: 0,
    },
    ...overrides,
  });
  const usage = {
    window: { from: HOUR_START, to: HOUR_END, granularity: "hour" as const },
    limit: 50,
  };

  it("returns the usage of its database and asks PGCF by database id only", async () => {
    const scopes: unknown[] = [];
    const service = events({
      readExecutionUsage: async (input) => {
        scopes.push(input.scope);
        return { rows: [usageRow(DB)], nextCursor: null };
      },
    });
    await expect(
      service.run({ ...envelope, operation: "usage.get", ...usage }),
    ).resolves.toMatchObject({
      status: "ok",
      value: {
        items: [{ start: HOUR_START, final: true, metrics: { webhook_attempts: 3 } }],
        next_cursor: null,
      },
    });
    expect(scopes).toEqual([{ databaseId: DB }]);
  });

  it("refuses a usage row of another database and a cursor of another database", async () => {
    const foreignRow = events({
      readExecutionUsage: async () => ({ rows: [usageRow(OTHER_DB)], nextCursor: null }),
    });
    await expect(foreignRow.run({ ...envelope, operation: "usage.get", ...usage })).rejects.toThrow(
      "Database usage page returned a foreign scope",
    );
    const foreignProject = events({
      readExecutionUsage: async () => ({
        rows: [usageRow(DB, { projectId: "prj_otherprojectxxxxxxxx" })],
        nextCursor: null,
      }),
    });
    await expect(
      foreignProject.run({ ...envelope, operation: "usage.get", ...usage }),
    ).rejects.toThrow("Database usage page returned a foreign scope");
    const foreignCursor = events({ readExecutionUsage: unexpected });
    await expect(
      foreignCursor.run({ ...envelope, operation: "usage.get", ...usage, cursor: `${OTHER_DB}|2` }),
    ).resolves.toEqual({ status: "rejected", code: "invalid" });
    // A cursor PGCF would not decode for this database is refused before any request, by length too.
    await expect(
      foreignCursor.run({
        ...envelope,
        operation: "usage.get",
        ...usage,
        cursor: `${DB}|${"1".repeat(130)}`,
      }),
    ).resolves.toEqual({ status: "rejected", code: "invalid" });
  });
});

describe("scope and provider failures", () => {
  it("refuses a database that PGCF does not place in this provider project", async () => {
    const service = events({ getWebhook: unexpected }, target(DB, "prj_otherprojectxxxxxxxx"));
    await expect(service.run({ ...envelope, operation: "webhook.list" })).rejects.toThrow(
      "Database compute scope unavailable",
    );
    const neon: DatabaseProviderTarget = {
      provider: "neon",
      organizationId: ORG,
      projectId: OMH_PROJECT,
      physicalEnvironmentId: PHYSICAL,
      targetVersion: 1,
      providerProjectId: PGCF_PROJECT,
      regionId: "eu-dev",
      runtimeRole: RUNTIME_ROLE,
      credentialReference: "pgcf-dev",
      activatedAt: null,
      branchId: "br_neonhistoric0001",
    };
    const historic = events({}, neon);
    await expect(historic.run({ ...envelope, operation: "webhook.list" })).rejects.toThrow(
      "Database compute scope unavailable",
    );
  });

  it("answers absent for a missing PGCF webhook and rethrows an outcome-unknown failure", async () => {
    await expect(
      events({
        getWebhook: async () => {
          throw new PgcfProviderError("rejected", 404);
        },
      }).run({ ...envelope, operation: "webhook.get", webhookId: WH_MINE }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      events({
        getWebhook: async () => {
          throw new PgcfProviderError("rejected", 503, true);
        },
      }).run({ ...envelope, operation: "webhook.get", webhookId: WH_MINE }),
    ).rejects.toMatchObject({ code: "rejected", status: 503 });
  });
});

describe("request parsing", () => {
  it("accepts a schedule set with the defaults of the contract", () => {
    expect(
      parseDatabaseEventRequest({
        ...envelope,
        operation: "schedule.set",
        name: "nightly",
        everySeconds: 3600,
        statements: ["SELECT 1"],
      }),
    ).toEqual({
      ...envelope,
      operation: "schedule.set",
      name: "nightly",
      schedule: {
        cron: null,
        every_seconds: 3600,
        statements: ["SELECT 1"],
        timeout_ms: 10_000,
        enabled: true,
      },
    });
  });

  it.each([
    ["a database id from the caller", { databaseIds: [DB] }],
    ["a role from the caller", { role: FOREIGN_ROLE }],
    ["a PGCF project from the caller", { providerProjectId: PGCF_PROJECT }],
    ["an unknown operation", { operation: "webhook.purge" }],
  ])("refuses %s", (_label, extra) => {
    expect(() =>
      parseDatabaseEventRequest({
        ...envelope,
        operation: "webhook.list",
        ...extra,
      }),
    ).toThrow(TypeError);
  });

  it("refuses a webhook create whose idempotency key is not a printable header value", () => {
    expect(() =>
      parseDatabaseEventRequest({
        ...envelope,
        operation: "webhook.create",
        url: "https://example.com/hook",
        eventTypes: ["database.ready"],
        idempotencyKey: "two words",
      }),
    ).toThrow(TypeError);
  });

  it("refuses a malformed project and a schedule without a cadence", () => {
    expect(() =>
      parseDatabaseEventRequest({
        ...envelope,
        projectId: "not-a-ulid",
        operation: "webhook.list",
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseDatabaseEventRequest({
        ...envelope,
        operation: "schedule.set",
        name: "nightly",
        statements: ["SELECT 1"],
      }),
    ).toThrow(TypeError);
  });
});

describe("the idempotency of webhook tests, deletes, delivery replays and schedule runs", () => {
  const replaying = [
    ["webhook.delete", { webhookId: WH_MINE }],
    ["webhook.test", { webhookId: WH_MINE }],
    ["delivery.replay", { deliveryId: DLV_MINE }],
    ["schedule.run", { name: "nightly" }],
  ] as const;

  it("refuses each of them without an Idempotency-Key, before any provider call", () => {
    for (const [operation, input] of replaying) {
      expect(() => parseDatabaseEventRequest({ ...envelope, operation, ...input })).toThrow(
        TypeError,
      );
    }
  });

  it("sends PGCF the same key for a retry of the same request and another key for another request", async () => {
    const keys: string[] = [];
    const service = events({
      listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
      getWebhook: async () => webhook(WH_MINE, [DB]),
      deleteWebhook: async (_id, options) => {
        keys.push(options.key);
      },
      testWebhook: async (_id, options) => {
        keys.push(options.key);
        return { delivered: true, status: 200, error: null, durationMs: 1 };
      },
      listWebhookDeliveries: async () => ({
        items: [delivery(DLV_MINE, WH_MINE)],
        nextCursor: null,
      }),
      replayWebhookDelivery: async (_database, id, options) => {
        keys.push(options.key);
        return { deliveryId: id, state: "pending" as const };
      },
      getSchedule: async (_database, name) => schedule(name),
      runScheduleNow: async (_database, name, options) => {
        keys.push(options.key);
        return { schedule: name, state: "queued" as const };
      },
    });
    const retry = { idempotencyKey: "retry-key-0001" };
    const requests = [
      { ...envelope, operation: "webhook.delete", webhookId: WH_MINE, ...retry },
      { ...envelope, operation: "webhook.test", webhookId: WH_MINE, ...retry },
      { ...envelope, operation: "delivery.replay", deliveryId: DLV_MINE, ...retry },
      { ...envelope, operation: "schedule.run", name: "nightly", ...retry },
    ] as const;
    for (const request of requests) await service.run(request);
    const first = [...keys];
    for (const request of requests) await service.run(request);
    expect(keys).toEqual([...first, ...first]);
    // The key names the customer's request key within this project and environment; PGCF tells the requests apart.
    expect(new Set(first)).toHaveLength(1);
    for (const key of first) expect(key).toMatch(/^omh-wh-[0-9a-f]{64}$/u);
    await service.run({
      ...envelope,
      operation: "webhook.delete",
      webhookId: WH_MINE,
      idempotencyKey: "other-key-0001",
    });
    expect(keys.at(-1)).not.toBe(first[0]);
  });

  it("maps a PGCF refusal of a reused key to idempotency_key_reused and of a running key to pending", async () => {
    const reused = new PgcfProviderError("rejected", 409, false, "idempotency_conflict");
    const running = new PgcfProviderError("rejected", 409, false, "idempotency_in_progress");
    const service = (error: unknown) =>
      events({
        listWebhooks: async () => ({ items: [webhook(WH_MINE, [DB])], nextCursor: null }),
        getWebhook: async () => webhook(WH_MINE, [DB]),
        deleteWebhook: async () => {
          throw error;
        },
        testWebhook: async () => {
          throw error;
        },
        listWebhookDeliveries: async () => ({
          items: [delivery(DLV_MINE, WH_MINE)],
          nextCursor: null,
        }),
        replayWebhookDelivery: async () => {
          throw error;
        },
        getSchedule: async (_database, name) => schedule(name),
        runScheduleNow: async () => {
          throw error;
        },
      });
    const requests = [
      { ...envelope, operation: "webhook.delete", webhookId: WH_MINE, idempotencyKey: KEY },
      { ...envelope, operation: "webhook.test", webhookId: WH_MINE, idempotencyKey: KEY },
      { ...envelope, operation: "delivery.replay", deliveryId: DLV_MINE, idempotencyKey: KEY },
      { ...envelope, operation: "schedule.run", name: "nightly", idempotencyKey: KEY },
    ] as const;
    for (const request of requests) {
      await expect(service(reused).run(request)).resolves.toEqual({
        status: "rejected",
        code: "idempotency_key_reused",
      });
      await expect(service(running).run(request)).resolves.toEqual({
        status: "rejected",
        code: "pending",
      });
    }
  });
});

describe("every operation of the port", () => {
  // One valid RPC input per operation, as apps/control-api sends it (camelCase keys), and its closed request.
  const cases: readonly [operation: string, input: Record<string, unknown>, parsed: object][] = [
    [
      "webhook.create",
      {
        url: "https://example.com/hook",
        eventTypes: ["database.ready"],
        headers: { "x-token": "value" },
        idempotencyKey: "key-1",
      },
      {
        webhook: {
          url: "https://example.com/hook",
          event_types: ["database.ready"],
          headers: { "x-token": "value" },
        },
        idempotencyKey: "key-1",
      },
    ],
    ["webhook.list", {}, {}],
    ["webhook.get", { webhookId: WH_MINE }, { webhookId: WH_MINE }],
    [
      "webhook.delete",
      { webhookId: WH_MINE, idempotencyKey: "key-1" },
      { webhookId: WH_MINE, idempotencyKey: "key-1" },
    ],
    [
      "webhook.test",
      { webhookId: WH_MINE, idempotencyKey: "key-1" },
      { webhookId: WH_MINE, idempotencyKey: "key-1" },
    ],
    [
      "delivery.list",
      { limit: 50, webhookId: WH_MINE, cursor: "abc|1" },
      { limit: 50, webhookId: WH_MINE, cursor: "abc|1" },
    ],
    [
      "delivery.replay",
      { deliveryId: DLV_MINE, idempotencyKey: "key-1" },
      { deliveryId: DLV_MINE, idempotencyKey: "key-1" },
    ],
    [
      "schedule.set",
      {
        name: "nightly",
        cron: "0 * * * *",
        timeoutMs: 15_000,
        enabled: false,
        statements: ["SELECT 1"],
      },
      {
        name: "nightly",
        schedule: {
          cron: "0 * * * *",
          every_seconds: null,
          statements: ["SELECT 1"],
          timeout_ms: 15_000,
          enabled: false,
        },
      },
    ],
    ["schedule.list", {}, {}],
    ["schedule.get", { name: "nightly" }, { name: "nightly" }],
    ["schedule.delete", { name: "nightly" }, { name: "nightly" }],
    [
      "schedule.run",
      { name: "nightly", idempotencyKey: "key-1" },
      { name: "nightly", idempotencyKey: "key-1" },
    ],
    ["schedule.runs", { name: "nightly", limit: 20 }, { name: "nightly", limit: 20 }],
    [
      "usage.get",
      { from: HOUR_START, to: HOUR_END, granularity: "hour", limit: 50, cursor: `${DB}|2` },
      {
        window: { from: HOUR_START, to: HOUR_END, granularity: "hour" },
        limit: 50,
        cursor: `${DB}|2`,
      },
    ],
  ];

  it("parses each operation into its closed request and refuses keys outside its shape", () => {
    for (const [operation, input, parsed] of cases) {
      expect(parseDatabaseEventRequest({ ...envelope, operation, ...input })).toEqual({
        ...envelope,
        operation,
        ...parsed,
      });
      for (const extra of ["databaseIds", "role", "providerProjectId"]) {
        expect(() =>
          parseDatabaseEventRequest({ ...envelope, operation, ...input, [extra]: "caller" }),
        ).toThrow(TypeError);
      }
    }
  });

  it("answers absent for all fourteen operations when the environment has no database yet", async () => {
    expect(cases).toHaveLength(14);
    for (const [operation, input] of cases) {
      const request = parseDatabaseEventRequest({ ...envelope, operation, ...input });
      await expect(events({}, null).run(request)).resolves.toEqual({ status: "absent" });
    }
  });

  it("refuses out-of-range and malformed values of the envelope and of each operation", () => {
    const refused: Record<string, unknown>[] = [
      { ...envelope, organizationId: "not-a-ulid", operation: "webhook.list" },
      { ...envelope, environment: "staging", operation: "webhook.list" },
      { ...envelope, operation: "webhook.get", webhookId: "whk_short" },
      { ...envelope, operation: "delivery.replay", deliveryId: "dlv_1" },
      { ...envelope, operation: "delivery.list", limit: 101 },
      { ...envelope, operation: "delivery.list", limit: 10, cursor: "with space" },
      { ...envelope, operation: "schedule.get", name: "Nightly" },
      { ...envelope, operation: "schedule.runs", name: "nightly", limit: 51 },
      {
        ...envelope,
        operation: "usage.get",
        from: "2026-10-30T10:30:00.000Z",
        to: HOUR_END,
        granularity: "hour",
        limit: 10,
      },
    ];
    for (const input of refused) expect(() => parseDatabaseEventRequest(input)).toThrow(TypeError);
  });
});

describe("NeonManagementService.databaseEvents", () => {
  it("refuses an invalid request before reading any binding and fails without the product binding", async () => {
    host.env = {
      RUNTIME_CONFIGURATION_STATE: "configured",
      CONTROL_STORAGE_PROVIDER: "d1",
      PGCF_API_URL: "https://pgcf-api.aixyte.com",
      PGCF_APPS_PROJECT_ID: PGCF_PROJECT,
      PGCF_APPS_API_KEY: "test-only-integrator-key",
      NEON_TRAFFIC_ENABLED: "false",
      DATABASE_NEW_PROVIDER: "pgcf",
    };
    const { NeonManagementService } = await import("../src/worker-main.js");
    const service = new NeonManagementService({}, host.env as never);
    await expect(service.databaseEvents({ operation: "webhook.list" })).rejects.toThrow(TypeError);
    await expect(
      service.databaseEvents({
        ...envelope,
        operation: "subscription.status",
        subscriptionId: "invalid",
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      service.databaseEvents({ ...envelope, operation: "webhook.list" }),
    ).rejects.toThrow("D1 product database binding is unavailable");
  });

  /** A service whose product binding answers only the compute scope; every other binding method refuses the test. */
  async function serviceWith(scope: { target: DatabaseProviderTarget | null }, custody = false) {
    const binding = new Proxy(
      {},
      {
        get: (_target, method) =>
          method === "readProductComputeScope"
            ? async () => ({ physicalEnvironmentId: PHYSICAL, dataMode: "shared", ...scope })
            : async () => unexpected(),
      },
    );
    host.env = {
      RUNTIME_CONFIGURATION_STATE: "configured",
      CONTROL_STORAGE_PROVIDER: "d1",
      PGCF_API_URL: "https://pgcf-api.aixyte.com",
      PGCF_APPS_PROJECT_ID: PGCF_PROJECT,
      PGCF_APPS_API_KEY: "test-only-integrator-key",
      NEON_TRAFFIC_ENABLED: "false",
      DATABASE_NEW_PROVIDER: "pgcf",
      DATABASE_PRODUCT_RUNTIME: binding,
      ...(custody
        ? {
            DATABASE_WEBHOOK_SECRET_KEY_BASE64: Buffer.alloc(32, 4).toString("base64"),
            DATABASE_WEBHOOK_SECRET_KEY_VERSION: "1",
          }
        : {}),
    };
    const { NeonManagementService } = await import("../src/worker-main.js");
    return new NeonManagementService({}, host.env as never);
  }

  it("answers absent for an environment without a database, without any PGCF request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const service = await serviceWith({ target: null });
    await expect(
      service.databaseEvents({ ...envelope, operation: "webhook.list" }),
    ).resolves.toEqual({ status: "absent" });
    await expect(
      service.readCompute({ organizationId: ORG, projectId: OMH_PROJECT, environment: "dev" }),
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    const subscriptions = await serviceWith({ target: null }, true);
    await expect(
      subscriptions.databaseEvents({
        ...envelope,
        operation: "subscription.status",
        subscriptionId: PHYSICAL,
      }),
    ).resolves.toEqual({ status: "absent" });
    for (const request of [
      {
        ...envelope,
        operation: "subscription.activate",
        subscriptionId: PHYSICAL,
        generation: 1,
        idempotencyKey: "key",
        url: "https://example.com/hook",
        eventTypes: ["data.*"],
      },
      {
        ...envelope,
        operation: "subscription.deactivate",
        subscriptionId: PHYSICAL,
        generation: 1,
        idempotencyKey: "key",
      },
      { ...envelope, operation: "subscription.status", subscriptionId: PHYSICAL },
    ])
      expect(parseDatabaseWebhookSubscriptionRequest(request).operation).toBe(request.operation);
    expect(() =>
      parseDatabaseWebhookSubscriptionRequest({
        ...envelope,
        operation: "subscription.status",
        subscriptionId: PHYSICAL,
        extra: "no",
      }),
    ).toThrow(TypeError);
    expect(isDatabaseWebhookSubscriptionOperation(null)).toBe(false);
  });

  it("refuses a database that PGCF does not place in this provider project", async () => {
    const service = await serviceWith({ target: target(DB, "prj_otherprojectxxxxxxxx") });
    await expect(
      service.databaseEvents({ ...envelope, operation: "webhook.list" }),
    ).rejects.toThrow("Database compute scope unavailable");
    await expect(
      service.readCompute({ organizationId: ORG, projectId: OMH_PROJECT, environment: "dev" }),
    ).rejects.toThrow("Database compute scope unavailable");
  });
});

describe("orphan database webhook sweep", () => {
  it("deletes the webhooks of databases PGCF reports gone, bounded per pass, and never a live database's webhook", async () => {
    const GONE = "cccccccccccccccccccc",
      DELETED = "dddddddddddddddddddd";
    const pages = [
      {
        items: [
          webhook(WH_MINE, [GONE]),
          webhook(WH_OTHER, [DB]),
          webhook(WH_THIRD, [DELETED]),
          webhook(WH_LATER, [GONE]),
        ],
        nextCursor: null,
      },
    ];
    const deleted: string[] = [];
    const provider = {
      projectId: PGCF_PROJECT,
      listWebhooks: async () => ({
        items: (pages[0]?.items ?? []).filter((item) => !deleted.includes(item.id)),
        nextCursor: null,
      }),
      deleteWebhook: async (id: string) => void deleted.push(id),
      readDatabase: async (id: string) => {
        if (id === GONE) throw new PgcfProviderError("rejected", 404, false);
        if (id === DELETED) return { id, desiredState: "deleted", observedState: "deleted" };
        return { id, desiredState: "running", observedState: "running" };
      },
    };
    const first = await sweepOrphanDatabaseWebhooks(
      provider as unknown as Parameters<typeof sweepOrphanDatabaseWebhooks>[0],
      { maxDeletes: 2 },
    );
    expect(first).toEqual({ deleted: 2, complete: false });
    expect(deleted).toEqual([WH_MINE, WH_LATER]);
    const second = await sweepOrphanDatabaseWebhooks(
      provider as unknown as Parameters<typeof sweepOrphanDatabaseWebhooks>[0],
      { maxDeletes: 2 },
    );
    expect(second).toEqual({ deleted: 1, complete: true });
    expect(deleted).toEqual([WH_MINE, WH_LATER, WH_THIRD]);
  });

  it("counts a webhook PGCF already removed as swept and fails the pass on any other refusal", async () => {
    const GONE = "cccccccccccccccccccc";
    const removed = new Set([WH_MINE]);
    const deleted: string[] = [];
    const provider = {
      projectId: PGCF_PROJECT,
      listWebhooks: async () => ({
        items: [webhook(WH_MINE, [GONE]), webhook(WH_LATER, [GONE])],
        nextCursor: null,
      }),
      deleteWebhook: async (id: string) => {
        if (removed.has(id)) throw new PgcfProviderError("rejected", 404, false);
        deleted.push(id);
      },
      readDatabase: async (id: string) => ({
        id,
        desiredState: "deleted",
        observedState: "deleted",
      }),
    };
    const sweep = (target: unknown) =>
      sweepOrphanDatabaseWebhooks(target as Parameters<typeof sweepOrphanDatabaseWebhooks>[0], {
        maxDeletes: 5,
      });
    await expect(sweep(provider)).resolves.toEqual({ deleted: 2, complete: true });
    expect(deleted).toEqual([WH_LATER]);

    const refused = {
      ...provider,
      deleteWebhook: async () => {
        throw new PgcfProviderError("rejected", 500, false);
      },
    };
    await expect(sweep(refused)).rejects.toMatchObject({ status: 500 });
  });
});
