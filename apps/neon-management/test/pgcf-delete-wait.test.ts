const host = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    readonly env = host.env;
  },
}));
import { createTestControl } from "../../control-store/test/support/control-d1.js";
import { makePaid } from "../../control-store/test/support/credit-fixtures.js";
import {
  CORE_DATABASE_ID,
  MANAGEMENT_CLAIM,
  seedManagementDeletion,
  seedManagementReauthorization,
  seedManagementScope,
} from "./support/d1-pgcf-scope.js";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { projectSqlRoleName } from "@ohmyhost/platform";
import { pgcfFixture, id, databaseId } from "./pgcf-runtime-fixture.js";

/** A placed PGCF database whose deletion is ready to run through the D1-backed service. */
async function placedDatabase() {
  const control = await createTestControl(),
    provider = await pgcfFixture(false);
  const entry = await import("../../control-store/src/worker-main.js"),
    { NeonManagementService } = await import("../src/worker-main.js");
  const coreBindings = {
    CONTROL_CORE: control.core,
    CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
    CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
  };
  host.env = coreBindings;
  const runtime = new entry.DatabaseManagementRuntime({}, coreBindings);
  const bindings = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    DATABASE_MANAGEMENT_RUNTIME: runtime,
    PROJECT_DATABASE_ADMIN_US: provider.admin("us"),
    PROJECT_DATABASE_ADMIN_EU: provider.admin("eu"),
    PGCF_API_URL: "https://pgcf-api.aixyte.com",
    PGCF_APPS_PROJECT_ID: provider.provider.projectId,
    PGCF_APPS_API_KEY: "test-only-integrator-key",
  };
  host.env = bindings;
  const service = new NeonManagementService(
    {},
    bindings,
    provider.connect,
    undefined,
    provider.sleep,
  );
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(provider.providerFetch);
  await seedManagementScope(control.core);
  await makePaid(control.core, id(1), "2099-01-01T00:00:00.000Z", new Date().toISOString());
  expect(await service.placeProject(MANAGEMENT_CLAIM)).toMatchObject({ status: "ready" });
  const sql = "CREATE TABLE public.records(id integer PRIMARY KEY,value text NOT NULL);",
    body = new TextEncoder().encode(sql);
  expect(
    await service.migrateProject({
      ...MANAGEMENT_CLAIM,
      migrations: [
        {
          path: "20261029000000_records.sql",
          body,
          size: body.byteLength,
          digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        },
      ],
      auth: { provider: "none" },
    }),
  ).toMatchObject({ status: "ready" });
  // The deletion is seeded at registration version 2, as the integration test does after reauthorization.
  const reauthorization = await seedManagementReauthorization(control.core);
  expect(await service.reauthorizeDataEnvironment(reauthorization)).toMatchObject({
    status: "ready",
    databaseRegistration: { registrationVersion: 2 },
  });
  const request = {
    ...(await seedManagementDeletion(control.core, databaseId)),
    providerProjectId: provider.provider.projectId,
  };
  return {
    control,
    provider,
    service,
    request,
    dispose: async () => {
      fetch.mockRestore();
      await control.dispose();
      await provider.control.stop();
    },
  };
}

it("finishes an asynchronous database creation in one placement and records each synchronous role without an operation", async () => {
  const control = await createTestControl(),
    provider = await pgcfFixture(false);
  const entry = await import("../../control-store/src/worker-main.js"),
    { NeonManagementService } = await import("../src/worker-main.js");
  const coreBindings = {
    CONTROL_CORE: control.core,
    CONTROL_CORE_DATABASE_ID: CORE_DATABASE_ID,
    CONTROL_PLATFORM_ENVIRONMENT: "development" as const,
  };
  host.env = coreBindings;
  const runtime = new entry.DatabaseManagementRuntime({}, coreBindings);
  const bindings = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    DATABASE_MANAGEMENT_RUNTIME: runtime,
    PROJECT_DATABASE_ADMIN_US: provider.admin("us"),
    PROJECT_DATABASE_ADMIN_EU: provider.admin("eu"),
    PGCF_API_URL: "https://pgcf-api.aixyte.com",
    PGCF_APPS_PROJECT_ID: provider.provider.projectId,
    PGCF_APPS_API_KEY: "test-only-integrator-key",
  };
  host.env = bindings;
  const closeFailure = new Error("synthetic close failure"),
    queryFailure = new Error("synthetic query failure");
  let connectionFailure: "close" | "both" | null = null;
  const connect: typeof provider.connect = async (...args) => {
    const connected = await provider.connect(...args);
    if (connectionFailure === null) return connected;
    return {
      client:
        connectionFailure === "both"
          ? ({
              query: async () => {
                throw queryFailure;
              },
            } as typeof connected.client)
          : connected.client,
      close: async () => {
        await connected.close();
        throw closeFailure;
      },
    };
  };
  const service = new NeonManagementService({}, bindings, connect, undefined, provider.sleep);
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(provider.providerFetch);
  try {
    await seedManagementScope(control.core);
    await makePaid(control.core, id(1), "2099-01-01T00:00:00.000Z", new Date().toISOString());
    provider.state.createStatus = "running";
    provider.state.createSucceedsAfterReads = 2;
    expect(await service.placeProject(MANAGEMENT_CLAIM)).toMatchObject({ status: "ready" });
    expect(provider.stats.creates).toBe(1);
    expect(provider.stats.roleCreates).toBe(4);
    expect(provider.state.createReads).toBe(2);
    // Only the database creation waits; the roles are created synchronously and need no wait.
    expect(provider.sleeps).toEqual(Array(2).fill(1000));
    const operations = await control.core
      .prepare(
        "SELECT step,state,provider_operation_id FROM database_provider_operations ORDER BY step",
      )
      .all<{ step: string; state: string; provider_operation_id: string | null }>();
    expect(operations.results).toHaveLength(5);
    expect(operations.results.every((operation) => operation.state === "succeeded")).toBe(true);
    // PGCF answers each role create with 201 and the Role, so only the database operation has a provider id.
    expect(
      operations.results.filter((operation) => operation.provider_operation_id !== null),
    ).toEqual([expect.objectContaining({ step: "database.create" })]);
    const closeLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const failure of ["close", "both"] as const) {
        connectionFailure = failure;
        await expect(service.placeProject(MANAGEMENT_CLAIM)).rejects.toBe(closeFailure);
        expect(closeLog).toHaveBeenLastCalledWith(
          '{"event":"pgcf_role_readiness_failed","phase":"close"}',
        );
      }
    } finally {
      connectionFailure = null;
      closeLog.mockRestore();
    }
    const role = projectSqlRoleName(id(4), "migration");
    await provider.control.pool.query(`ALTER ROLE ${role} NOLOGIN`);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(service.placeProject(MANAGEMENT_CLAIM)).rejects.toThrow();
      expect(log).toHaveBeenCalledWith('{"event":"pgcf_role_readiness_failed","phase":"connect"}');
    } finally {
      log.mockRestore();
    }
    provider.state.observedState = "error";
    await expect(service.placeProject(MANAGEMENT_CLAIM)).rejects.toThrow(
      "PGCF database readiness failed",
    );
  } finally {
    fetch.mockRestore();
    await control.dispose();
    await provider.control.stop();
  }
}, 120000);

it("waits on the same delete operation until it succeeds within one call", async () => {
  const fixture = await placedDatabase();
  try {
    fixture.provider.state.deleteStatus = "running";
    fixture.provider.state.deleteSucceedsAfterReads = 3;
    expect(await fixture.service.deleteProject(fixture.request)).toMatchObject({
      status: "absent",
      provider: "pgcf",
      outcome: "deleted",
    });
    expect(fixture.provider.sleeps).toEqual([1000, 1000, 1000]);
    expect(fixture.provider.state.deleteReads).toBe(3);
    expect(
      await fixture.control.core
        .prepare("SELECT state FROM database_provider_target_heads")
        .first(),
    ).toEqual({ state: "retired" });
  } finally {
    await fixture.dispose();
  }
}, 120000);

it("hands an unsettled delete to reconciliation after 30 waits and resumes the recorded operation", async () => {
  const fixture = await placedDatabase();
  try {
    fixture.provider.state.deleteStatus = "running";
    expect(await fixture.service.deleteProject(fixture.request)).toMatchObject({
      status: "reconciliation_required",
      phase: "pgcf",
    });
    expect(fixture.provider.sleeps).toEqual(Array(30).fill(1000));
    expect(fixture.provider.state.deleteReads).toBe(30);
    fixture.provider.state.deleteStatus = "succeeded";
    fixture.provider.state.observedState = "deleted";
    fixture.provider.state.observedGeneration = fixture.provider.state.generation;
    expect(await fixture.service.deleteProject(fixture.request)).toMatchObject({
      status: "absent",
      provider: "pgcf",
    });
    expect(fixture.provider.sleeps).toHaveLength(30);
  } finally {
    await fixture.dispose();
  }
}, 120000);

it("removes the webhooks of the deleted database, and only those, before it retires the target", async () => {
  const fixture = await placedDatabase();
  try {
    const hook = (index: number, databaseIds: string[] | null) => ({
      id: `whk_${"a".repeat(16)}${String(index).padStart(4, "0")}`,
      project_id: fixture.provider.provider.projectId,
      url: "https://receiver.example.com/hooks",
      event_types: ["database.ready"],
      database_ids: databaseIds,
      header_names: [],
      created_at: "2026-11-01T10:00:00.000Z",
    });
    const other = "zyxwvutsrqponmlkjihg";
    // PGCF keeps every subscription of the shared project after its database is deleted. A hook counts as this
    // database's only when it names exactly this database. The first of them sits on the second listing page behind
    // 100 others; a hook the strict parser rejects stays where it is.
    const foreign = [
      ...Array.from({ length: 100 }, (_, index) => hook(index, [other])),
      hook(100, [databaseId, other]),
      hook(101, null),
    ];
    const unparseable = { ...hook(104, [databaseId]), url: "http://receiver.example.com/hooks" };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const head = () =>
      fixture.control.core.prepare("SELECT state FROM database_provider_target_heads").first();
    fixture.provider.state.deleteStatus = "running";
    fixture.provider.state.deleteSucceedsAfterReads = 1;
    // More webhooks than the page limit allows: the deletion goes to reconciliation, never to a plain error.
    fixture.provider.webhooks.push(
      ...Array.from({ length: 5001 }, (_, index) => hook(1000 + index, [other])),
    );
    expect(await fixture.service.deleteProject(fixture.request)).toMatchObject({
      status: "reconciliation_required",
      phase: "pgcf",
    });
    expect(await head()).toEqual({ state: "active" });
    fixture.provider.webhooks.length = 0;
    fixture.provider.webhooks.push(
      ...foreign.slice(0, 100),
      hook(102, [databaseId]),
      ...foreign.slice(100),
      hook(103, [databaseId]),
      unparseable,
      hook(105, [databaseId]),
    );
    // The first webhook is deleted, the second is already gone (404 counts as deleted) and PGCF refuses the third:
    // the target stays active and the deletion goes to reconciliation after a partial removal.
    fixture.provider.state.webhookDeleteStatuses.push(204, 404, 503);
    expect(await fixture.service.deleteProject(fixture.request)).toMatchObject({
      status: "reconciliation_required",
      phase: "pgcf",
    });
    expect(await head()).toEqual({ state: "active" });
    expect(fixture.provider.webhooks).toEqual([...foreign, unparseable, hook(105, [databaseId])]);
    expect(await fixture.service.deleteProject(fixture.request)).toMatchObject({
      status: "absent",
      provider: "pgcf",
    });
    expect(fixture.provider.webhooks).toEqual([...foreign, unparseable]);
    expect(await head()).toEqual({ state: "retired" });
    // The rejected hook is skipped with a fixed line that carries no webhook content.
    const skipped = log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("database_webhook_cleanup_skipped"));
    expect(skipped).toEqual(
      Array(2).fill('{"event":"database_webhook_cleanup_skipped","count":1}'),
    );
    log.mockRestore();
  } finally {
    await fixture.dispose();
  }
}, 120000);

it("stops waiting and rejects when the delete operation fails during the wait", async () => {
  const fixture = await placedDatabase();
  try {
    fixture.provider.state.deleteStatus = "running";
    fixture.provider.state.deleteFailsAfterReads = 2;
    await expect(fixture.service.deleteProject(fixture.request)).rejects.toThrow(
      "PGCF database deletion failed",
    );
    expect(fixture.provider.sleeps).toEqual([1000, 1000]);
  } finally {
    await fixture.dispose();
  }
}, 120000);

it("pauses for the requested time between provider re-reads in production", async () => {
  const { pause } = await import("../src/pgcf-runtime.js");
  const started = performance.now();
  await pause(25);
  expect(performance.now() - started).toBeGreaterThanOrEqual(20);
});
