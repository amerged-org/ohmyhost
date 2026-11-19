import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; the entrypoint, configuration reader and provider are production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));

const PROJECT = "prj_abcdefghij0123456789",
  DATABASE = "aaaaaaaaaaaaaaaaaaaa",
  HOUR = 3_600_000;
const bindings = {
  RUNTIME_CONFIGURATION_STATE: "configured" as const,
  CONTROL_STORAGE_PROVIDER: "d1" as const,
  PGCF_API_URL: "https://pgcf-api.aixyte.com",
  PGCF_APPS_PROJECT_ID: PROJECT,
  PGCF_APPS_API_KEY: "test-only-integrator-key",
  NEON_TRAFFIC_ENABLED: "false" as const,
  DATABASE_NEW_PROVIDER: "pgcf" as const,
};
async function service(env: unknown = bindings) {
  host.env = env;
  const { NeonManagementService } = await import("../src/worker-main.js");
  return new NeonManagementService({}, env as typeof bindings);
}
/** The newest final hour ended two hours before the current hour. */
function window(hours: number) {
  const to = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  return {
    from: new Date(to - hours * HOUR).toISOString(),
    to: new Date(to).toISOString(),
    hour: (offset: number) => new Date(to - (hours - offset) * HOUR).toISOString(),
  };
}
const nativeRow = (start: string, end: string, overrides: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  database_id: DATABASE,
  start,
  end,
  final: true,
  metrics: { memory_mib_seconds: 512 * 3600 },
  gaps: [],
  ...overrides,
});

afterEach(() => vi.restoreAllMocks());

describe("NeonManagementService.collectUsage", () => {
  it("returns the final rollups of the native usage pages and nothing else", async () => {
    const { from, to, hour } = window(3);
    const requested: URL[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      requested.push(url);
      expect(url.origin + url.pathname).toBe("https://pgcf-api.aixyte.com/v1/usage");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        project_id: PROJECT,
        from,
        to,
        granularity: "hour",
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer test-only-integrator-key",
      );
      return Response.json(
        url.searchParams.get("cursor") === null
          ? {
              data: [nativeRow(hour(1), hour(2)), nativeRow(hour(2), hour(3), { final: false })],
              next_cursor: "page-2",
            }
          : { data: [nativeRow(hour(0), hour(1))], next_cursor: null },
      );
    });
    const result = await (await service()).collectUsage({ from, to });
    expect(result).toEqual({
      from,
      to,
      rollups: [
        { databaseId: DATABASE, hourStart: hour(0), memoryMibMilliseconds: "1843200000" },
        { databaseId: DATABASE, hourStart: hour(1), memoryMibMilliseconds: "1843200000" },
      ],
      pending: [{ databaseId: DATABASE, hourStart: hour(2) }],
      unbillableHours: 0,
    });
    expect(requested.map((url) => url.searchParams.get("cursor"))).toEqual([null, "page-2"]);
  });

  it.each([
    ["no request", undefined],
    ["null", null],
    ["an array", []],
    ["a missing end", { from: "2026-10-30T00:00:00.000Z" }],
    ["an extra member", { from: "2026-10-30T00:00:00.000Z", to: "2026-10-30T01:00:00.000Z", x: 1 }],
    ["numbers for the window", { from: 0, to: 1 }],
  ])("refuses %s before any provider request", async (_label, input) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect((await service()).collectUsage(input)).rejects.toThrow("Invalid usage request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a window that is not final yet", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const now = Math.floor(Date.now() / HOUR) * HOUR;
    await expect(
      (await service()).collectUsage({
        from: new Date(now - HOUR).toISOString(),
        to: new Date(now).toISOString(),
      }),
    ).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an unconfigured Worker", async () => {
    const { from, to } = window(1);
    await expect(
      (await service({ ...bindings, PGCF_APPS_API_KEY: undefined })).collectUsage({ from, to }),
    ).rejects.toThrow("PGCF D1 configuration is unavailable");
  });

  it("lets a provider failure through instead of reporting an empty result", async () => {
    const { from, to } = window(1);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("secret provider text", { status: 503 }),
    );
    await expect((await service()).collectUsage({ from, to })).rejects.toMatchObject({
      name: "PgcfProviderError",
      code: "rejected",
    });
  });

  it("offers the memory rollups only", async () => {
    expect("collectExecutions" in (await service())).toBe(false);
  });
});

describe("NeonUsageService", () => {
  it("exposes only the usage rollup and the budget sweep to the credit service", async () => {
    host.env = bindings;
    const { NeonUsageService } = await import("../src/worker-main.js");
    const methods = Object.getOwnPropertyNames(NeonUsageService.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    expect(methods).toEqual(["collectUsage", "stopSchedules"]);
  });

  it("answers collectUsage through the management service's own input check", async () => {
    host.env = bindings;
    const { NeonUsageService } = await import("../src/worker-main.js");
    const usage = new NeonUsageService({}, bindings as typeof bindings);
    await expect(usage.collectUsage({})).rejects.toThrow("Invalid usage request");
  });

  it("stops a project's schedules for the budget sweep and refuses a request that is not the project scope", async () => {
    const reads = vi.fn(async () => ({
      physicalEnvironmentId: "01J6ABCDEFGHJKMNPQRSTVWXYZ",
      dataMode: "shared",
      target: null,
    }));
    // Every product method is present; only the compute scope read is exercised by the sweep.
    const product = new Proxy(
      {},
      {
        get: (_target, method) =>
          method === "readProductComputeScope" ? reads : async () => undefined,
      },
    );
    host.env = { ...bindings, DATABASE_PRODUCT_RUNTIME: product };
    const { NeonUsageService } = await import("../src/worker-main.js");
    const usage = new NeonUsageService({}, host.env as typeof bindings);
    const fetch = vi.spyOn(globalThis, "fetch");
    const scope = {
      organizationId: "01J5ABCDEFGHJKMNPQRSTVWXYZ",
      projectId: "01J7ABCDEFGHJKMNPQRSTVWXYZ",
    };
    await expect(usage.stopSchedules({ organizationId: scope.organizationId })).rejects.toThrow(
      "Invalid stop schedules request",
    );
    expect(reads).not.toHaveBeenCalled();
    // A project without a database has no schedules in either environment, so the sweep stops none.
    await expect(usage.stopSchedules(scope)).resolves.toEqual({ stopped: 0 });
    expect(reads).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("pgcf NeonUsageService", () => {
  it("exports the same two-method usage entrypoint from the module the alternate production config deploys", async () => {
    host.env = bindings;
    const { NeonUsageService } = await import("../src/pgcf-worker-main.js");
    const methods = Object.getOwnPropertyNames(NeonUsageService.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    expect(methods).toEqual(["collectUsage", "stopSchedules"]);
  });
});
