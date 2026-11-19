import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseProviderTarget } from "@ohmyhost/database";
import type { PgcfSchedule, PgcfScheduleUpsert } from "@ohmyhost/provider-pgcf";
import {
  createPgcfDatabaseEvents,
  type DatabaseEventsProvider,
} from "../src/pgcf-database-events.js";
import {
  createPgcfScheduleStopper,
  parseStopSchedulesRequest,
} from "../src/pgcf-stop-schedules.js";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; the entrypoint and the stopper are production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));

afterEach(() => vi.restoreAllMocks());

// Identifiers follow the shapes of the PGCF and OMH contracts, as in pgcf-database-events.test.ts.
const PGCF_PROJECT = "prj_abcdefghij0123456789",
  OMH_PROJECT = "01J7ABCDEFGHJKMNPQRSTVWXYZ",
  ORG = "01J5ABCDEFGHJKMNPQRSTVWXYZ",
  PHYSICAL = "01J6ABCDEFGHJKMNPQRSTVWXYZ",
  DB = "aaaaaaaaaaaaaaaaaaaa",
  RUNTIME_ROLE = "ohmyho_rw_01j6abcdefghjkmnpqrstvwxyz",
  FOREIGN_ROLE = "ohmyho_m_01j6abcdefghjkmnpqrstvwxyz",
  STAMP = "2026-10-30T10:00:00.000Z";

const scope = { organizationId: ORG, projectId: OMH_PROJECT };

const unexpected = (): never => {
  throw new Error("Unexpected provider call");
};

function target(): DatabaseProviderTarget {
  return {
    provider: "pgcf",
    organizationId: ORG,
    projectId: OMH_PROJECT,
    physicalEnvironmentId: PHYSICAL,
    targetVersion: 1,
    providerProjectId: PGCF_PROJECT,
    regionId: "eu-dev",
    runtimeRole: RUNTIME_ROLE,
    credentialReference: "pgcf-dev",
    activatedAt: null,
    databaseId: DB,
    sizeClassId: "small",
  };
}

/** A PGCF schedule as the provider returns it: exactly one of a cron and an interval. */
function schedule(
  name: string,
  overrides: Partial<PgcfSchedule> & { readonly interval?: number } = {},
): PgcfSchedule {
  const { interval, ...rest } = overrides;
  return {
    name,
    cron: interval === undefined ? "30 3 * * *" : null,
    everySeconds: interval ?? null,
    statements: ["SELECT 1"],
    role: RUNTIME_ROLE,
    timeoutMs: 10_000,
    enabled: true,
    nextRunAt: STAMP,
    createdAt: STAMP,
    ...rest,
  };
}

/** A PGCF database whose schedules live in memory; the write bodies are recorded as PGCF receives them. */
function database(initial: PgcfSchedule[]) {
  const store = new Map(initial.map((item) => [item.name, item]));
  const puts: { name: string; body: PgcfScheduleUpsert }[] = [];
  const provider: DatabaseEventsProvider = {
    projectId: PGCF_PROJECT,
    listWebhooks: unexpected,
    createWebhook: unexpected,
    getWebhook: unexpected,
    deleteWebhook: unexpected,
    testWebhook: unexpected,
    listWebhookDeliveries: unexpected,
    replayWebhookDelivery: unexpected,
    getSchedule: async (_database, name) => {
      const found = store.get(name);
      if (found === undefined) throw new Error("schedule not found");
      return found;
    },
    putSchedule: async (_database, name, body) => {
      puts.push({ name, body });
      const previous = store.get(name) ?? schedule(name);
      const stored: PgcfSchedule = {
        ...previous,
        cron: body.cron ?? null,
        everySeconds: body.everySeconds ?? null,
        statements: [...body.statements],
        role: body.role,
        timeoutMs: body.timeoutMs ?? previous.timeoutMs,
        enabled: body.enabled ?? previous.enabled,
      };
      store.set(name, stored);
      return stored;
    },
    listSchedules: async () => [...store.values()],
    deleteSchedule: unexpected,
    listScheduleRuns: unexpected,
    runScheduleNow: unexpected,
    readExecutionUsage: unexpected,
  };
  const stopper = createPgcfScheduleStopper(
    createPgcfDatabaseEvents({
      // dev and prod of this project share one database and one runtime role
      readScope: async () => ({ physicalEnvironmentId: PHYSICAL, target: target() }),
      provider,
    }),
  );
  return { stopper, store, puts };
}

describe("stopping the schedules of a project", () => {
  it("disables each enabled schedule of the runtime role once, in dev and prod of one shared database", async () => {
    const shared = database([
      schedule("nightly"),
      schedule("paused", { enabled: false }),
      schedule("foreign", { role: FOREIGN_ROLE }),
      schedule("hourly", { interval: 3600 }),
    ]);

    expect(await shared.stopper(scope)).toEqual({ stopped: 2 });

    expect(shared.puts).toEqual([
      {
        name: "nightly",
        body: {
          cron: "30 3 * * *",
          statements: ["SELECT 1"],
          role: RUNTIME_ROLE,
          timeoutMs: 10_000,
          enabled: false,
        },
      },
      {
        name: "hourly",
        body: {
          everySeconds: 3600,
          statements: ["SELECT 1"],
          role: RUNTIME_ROLE,
          timeoutMs: 10_000,
          enabled: false,
        },
      },
    ]);
    expect(shared.store.get("foreign")?.enabled).toBe(true);
    expect(shared.store.get("paused")?.enabled).toBe(false);

    // the next pass finds nothing enabled: nothing is written and nothing is counted again
    expect(await shared.stopper(scope)).toEqual({ stopped: 0 });
    expect(shared.puts).toHaveLength(2);
  });

  it("skips an environment without a database and stops the other one", async () => {
    const seen: string[] = [];
    const stopper = createPgcfScheduleStopper({
      run: async (request) => {
        seen.push(`${request.environment}:${request.operation}`);
        if (request.environment === "dev") return { status: "absent" };
        if (request.operation === "schedule.list")
          return {
            status: "ok",
            value: {
              items: [
                {
                  name: "nightly",
                  environment: "prod",
                  cron: "30 3 * * *",
                  every_seconds: null,
                  statements: ["SELECT 1"],
                  timeout_ms: 10_000,
                  enabled: true,
                  next_run_at: STAMP,
                  created_at: STAMP,
                },
              ],
            },
          };
        return { status: "ok", value: {} as never };
      },
    });

    expect(await stopper(scope)).toEqual({ stopped: 1 });
    expect(seen).toEqual(["dev:schedule.list", "prod:schedule.list", "prod:schedule.set"]);
  });

  it("refuses the whole project when a schedule cannot be disabled or PGCF fails, and never swallows it", async () => {
    const refused = createPgcfScheduleStopper({
      run: async (request) =>
        request.operation === "schedule.list"
          ? {
              status: "ok",
              value: {
                items: [
                  {
                    name: "nightly",
                    environment: "dev",
                    cron: "30 3 * * *",
                    every_seconds: null,
                    statements: ["SELECT 1"],
                    timeout_ms: 10_000,
                    enabled: true,
                    next_run_at: STAMP,
                    created_at: STAMP,
                  },
                ],
              },
            }
          : { status: "rejected", code: "schedule_limit" },
    });
    await expect(refused(scope)).rejects.toThrow("a schedule could not be disabled");

    const down = createPgcfScheduleStopper(
      createPgcfDatabaseEvents({
        readScope: async () => ({ physicalEnvironmentId: PHYSICAL, target: target() }),
        provider: failingProvider(),
      }),
    );
    await expect(down(scope)).rejects.toThrow("provider down");
  });
});

function failingProvider(): DatabaseEventsProvider {
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
    listSchedules: async () => {
      throw new Error("provider down");
    },
    deleteSchedule: unexpected,
    listScheduleRuns: unexpected,
    runScheduleNow: unexpected,
    readExecutionUsage: unexpected,
  };
}

describe("parseStopSchedulesRequest", () => {
  it("accepts exactly the two canonical ULIDs", () => {
    expect(parseStopSchedulesRequest({ organizationId: ORG, projectId: OMH_PROJECT })).toEqual(
      scope,
    );
  });

  it("refuses extra or missing keys, malformed ids and every non-object", () => {
    const valid = { organizationId: ORG, projectId: OMH_PROJECT };
    for (const input of [
      null,
      [],
      "scope",
      { ...valid, environment: "dev" },
      { organizationId: ORG },
      { ...valid, projectId: "prj_abcdefghij0123456789" },
      { ...valid, organizationId: 5 },
      { organizationId: ORG, projectId: "not a ulid" },
    ])
      expect(() => parseStopSchedulesRequest(input)).toThrow("Invalid stop schedules request");
  });
});

describe("NeonManagementService.stopSchedules", () => {
  const bindings = {
    RUNTIME_CONFIGURATION_STATE: "configured",
    CONTROL_STORAGE_PROVIDER: "d1",
    PGCF_API_URL: "https://pgcf-api.aixyte.com",
    PGCF_APPS_PROJECT_ID: PGCF_PROJECT,
    PGCF_APPS_API_KEY: "test-only-integrator-key",
    NEON_TRAFFIC_ENABLED: "false",
    DATABASE_NEW_PROVIDER: "pgcf",
  };

  /** The PGCF wire of one schedule, as GET and PUT answer it. */
  const wire = (item: PgcfSchedule) => ({
    name: item.name,
    cron: item.cron,
    every_seconds: item.everySeconds,
    statements: [...item.statements],
    role: item.role,
    timeout_ms: item.timeoutMs,
    enabled: item.enabled,
    next_run_at: item.nextRunAt,
    created_at: item.createdAt,
  });

  it("disables the enabled schedules through PGCF with the stored body and the project key", async () => {
    const pgcf = new Map<string, Record<string, unknown>>([
      ["nightly", wire(schedule("nightly"))],
      ["paused", wire(schedule("paused", { enabled: false }))],
    ]);
    const puts: { name: string; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-only-integrator-key",
      );
      if (init?.method === "GET" && url.pathname === `/v1/databases/${DB}/schedules`)
        return Response.json({ data: [...pgcf.values()], next_cursor: null });
      if (init?.method === "GET" && url.pathname.startsWith(`/v1/databases/${DB}/schedules/`))
        return Response.json(pgcf.get(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")));
      if (init?.method === "PUT" && url.pathname.startsWith(`/v1/databases/${DB}/schedules/`)) {
        const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        puts.push({ name, body });
        const stored = { ...(pgcf.get(name) as Record<string, unknown>), enabled: body["enabled"] };
        pgcf.set(name, stored);
        return Response.json(stored);
      }
      throw new Error(`unexpected ${String(init?.method)} ${url.pathname}`);
    });
    const service = await serviceWith({ target: target() });

    await expect(service.stopSchedules(scope)).resolves.toEqual({ stopped: 1 });

    expect(puts).toEqual([
      {
        name: "nightly",
        body: {
          cron: "30 3 * * *",
          statements: ["SELECT 1"],
          role: RUNTIME_ROLE,
          timeout_ms: 10_000,
          enabled: false,
        },
      },
    ]);
  });

  it("refuses an invalid request before reading any binding, and fails without the product binding", async () => {
    const reads = vi.fn(async () => ({ physicalEnvironmentId: PHYSICAL, target: target() }));
    const service = await serviceWith({ target: target() }, reads);
    await expect(service.stopSchedules({ organizationId: ORG })).rejects.toThrow(TypeError);
    expect(reads).not.toHaveBeenCalled();

    host.env = { ...bindings };
    const { NeonManagementService: Service } = await import("../src/worker-main.js");
    const bare = new Service({}, host.env as never);
    await expect(bare.stopSchedules(scope)).rejects.toThrow(
      "D1 product database binding is unavailable",
    );
  });
});

/** A service whose product binding answers the compute scope and counts its reads. */
async function serviceWith(
  resolved: { target: DatabaseProviderTarget | null },
  reads: (input: unknown) => Promise<unknown> = async () => ({
    physicalEnvironmentId: PHYSICAL,
    dataMode: "shared",
    ...resolved,
  }),
) {
  const binding = new Proxy(
    {},
    {
      get: (_target, method) =>
        method === "readProductComputeScope"
          ? async (input: unknown) => reads(input)
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
  };
  const { NeonManagementService } = await import("../src/worker-main.js");
  return new NeonManagementService({}, host.env as never);
}
