import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTestControl,
  type TestControl,
} from "../../control-store/test/support/control-d1.js";
import { workflowFixture } from "../../control-store/test/provisioning/workflow-fixture.js";
import { claimProductProviderMutation } from "../../control-store/src/catalog/provisioning/provider-claim.js";
import { coreRouter } from "../../control-store/test/support/control-d1.js";

const host = vi.hoisted(() => ({ env: undefined as unknown }));
/** Only the `cloudflare:workers` base class is replaced; entrypoints, Core commands and D1 are the production code. */
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = host.env;
  },
}));

const ACCOUNT = "a".repeat(32);
let control: TestControl;
const buckets = new Set<string>();
const stats = { creates: 0, rateLimited: false };
const success = (result: unknown) =>
  Response.json({ success: true, errors: [], messages: [], result });
/** The Cloudflare API boundary: bucket CRUD and the analytics GraphQL endpoint. */
async function cloudflare(address: string | URL | Request, init?: RequestInit) {
  const request = new Request(address, init);
  const url = new URL(request.url);
  if (url.pathname.endsWith("/graphql"))
    return stats.rateLimited
      ? Response.json(
          { errors: [{ message: "rate limited" }] },
          { status: 429, headers: { "retry-after": "60" } },
        )
      : Response.json({
          data: { viewer: { accounts: [{ storage: [], operations: [] }] } },
          errors: [],
        });
  const name = url.pathname.split("/r2/buckets/")[1]?.split("/")[0];
  if (request.method === "POST") {
    const body = (await request.json()) as { name: string };
    buckets.add(body.name);
    stats.creates++;
    return success({ name: body.name, jurisdiction: "eu", storage_class: "Standard" });
  }
  if (!name || !buckets.has(name))
    return Response.json(
      {
        success: false,
        errors: [{ code: 10006, message: "Bucket not found" }],
        messages: [],
        result: null,
      },
      { status: 404 },
    );
  if (url.pathname.endsWith("/domains/managed"))
    return success({
      bucketId: "c".repeat(32),
      domain: `pub-${"c".repeat(32)}.r2.dev`,
      enabled: false,
    });
  if (url.pathname.endsWith("/domains/custom")) return success({ domains: [] });
  if (url.pathname.endsWith("/objects")) return success([]);
  if (request.method === "DELETE") {
    buckets.delete(name);
    return success({});
  }
  return success({ name, jurisdiction: "eu", storage_class: "Standard" });
}

beforeEach(async () => {
  control = await createTestControl();
  buckets.clear();
  stats.creates = 0;
  stats.rateLimited = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(cloudflare as typeof fetch);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await control.dispose();
});

async function scope() {
  const r = await workflowFixture(control);
  await claimProductProviderMutation(
    { directory: control.core, router: coreRouter(control) },
    r.input,
  );
  return {
    organizationId: r.p.organizationId,
    projectId: r.p.projectId,
    environmentId: r.input.environmentId,
    operationId: r.input.operationId,
    claimId: r.input.claimId,
    jurisdiction: "eu" as const,
  };
}
async function service(runtime?: unknown) {
  const entry = await import("../../control-store/src/worker-main.js"),
    module = await import("../src/worker-main.js");
  host.env = control.bindings;
  const core = runtime ?? new entry.R2ManagementRuntime({}, control.bindings);
  const bindings = {
    RUNTIME_CONFIGURATION_STATE: "configured" as const,
    R2_MANAGEMENT_RUNTIME: core,
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_R2_API_TOKEN: "token-" + "a".repeat(32),
    CLOUDFLARE_R2_ANALYTICS_TOKEN: "analytics-" + "b".repeat(32),
  };
  host.env = bindings;
  return {
    entry,
    module,
    core,
    bindings,
    service: new module.R2ManagementService({} as never, bindings),
    worker: new module.default({} as never, bindings),
  };
}

describe("R2 management over the fixed Core RPC", () => {
  it("creates, replays, reads, meters and purges a bucket on a real D1 and keeps the worker's public surface private", async () => {
    const input = await scope(),
      { service: s, worker, module, bindings } = await service();
    const ensured = (await s.ensureBucket(input)) as unknown as {
      receipt: { bucketName: string };
    };
    expect(ensured).toMatchObject({ status: "ready", outcome: "created" });
    expect(stats.creates).toBe(1);
    expect(await s.ensureBucket(input)).toMatchObject({ status: "ready", outcome: "replayed" });
    expect(stats.creates).toBe(1);
    // The same claim for another target (jurisdiction) can never succeed: the Core's refusal is the typed conflict.
    expect(await s.ensureBucket({ ...input, jurisdiction: "us" })).toEqual({
      status: "conflict",
      reason: "target_changed",
    });
    expect(
      await s.readRuntimeBinding({
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
      }),
    ).toMatchObject({ status: "ready", jurisdiction: "eu" });
    await expect(worker.fetch()).resolves.toMatchObject({ status: 404 });
    // The Core answers the confirmed-storage read for the day; the provider answers no operations.
    const bucket = { bucketName: ensured.receipt.bucketName, jurisdiction: "eu" as const };
    const day = "2026-10-01T00:00:00.000Z";
    expect(await s.collectUsage({ day, buckets: [bucket] })).toEqual({
      day,
      buckets: [{ ...bucket, storagePeakBytes: "0", classA: "0", classB: "0", inexactHours: 0 }],
    });
    // A day that is not final yet is refused before the provider or the Core is read.
    const reads = vi.mocked(fetch).mock.calls.length;
    const today = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000).toISOString();
    await expect(s.collectUsage({ day: today, buckets: [bucket] })).rejects.toThrow(
      "R2 usage day is not finished",
    );
    expect(vi.mocked(fetch).mock.calls).toHaveLength(reads);
    // A provider rate limit fails the whole call: nothing is returned for the day.
    stats.rateLimited = true;
    await expect(s.collectUsage({ day, buckets: [bucket] })).rejects.toThrow(
      "R2 usage rate limited",
    );
    expect(await s.purgeAndDeleteBucket(ensured.receipt)).toMatchObject({
      status: "absent",
      outcome: "deleted",
    });
    // A Worker without its private Core capability fails closed.
    const broken = { ...bindings, R2_MANAGEMENT_RUNTIME: {} };
    host.env = broken;
    await expect(
      new module.R2ManagementService({} as never, broken).collectUsage({
        day,
        buckets: [bucket],
      }),
    ).rejects.toThrow("R2 management private Core runtime is unavailable");
  });

  it("never repeats a bucket creation whose Core authorization reply was lost", async () => {
    const entry = await import("../../control-store/src/worker-main.js");
    host.env = control.bindings;
    const lostRuntime = new entry.R2ManagementRuntime({}, control.bindings);
    const authorizeBucket = lostRuntime.authorizeBucket.bind(lostRuntime);
    Object.defineProperty(lostRuntime, "authorizeBucket", {
      value: async (input: unknown): Promise<boolean> => {
        await authorizeBucket(input);
        throw new Error("Network connection lost after create marker");
      },
    });
    const input = await scope(),
      lost = await service(lostRuntime);
    await expect(lost.service.ensureBucket(input)).rejects.toThrow("Network connection lost");
    expect(stats.creates).toBe(0);
    const healthy = await service();
    expect(await healthy.service.ensureBucket(input)).toMatchObject({
      status: "reconciliation_required",
      reason: "provider_absent",
    });
    expect(stats.creates).toBe(0);
  });
});

describe("R2 Core response validation", () => {
  const core = (overrides: Record<string, unknown>) => ({
    claimBucket: async () => ({ status: "claimed", mode: "create" }),
    authorizeBucket: async () => true,
    putBucket: async () => "created",
    readBucket: async () => null,
    proveBucketAbsence: async () => "proven",
    supersedeBucketReservation: async () => "superseded",
    confirmedStorage: async () => [],
    ...overrides,
  });

  it("refuses a malformed bucket reply and passes a well-formed one", async () => {
    const { module } = await service(),
      input = await scope();
    const persistence = (overrides: Record<string, unknown>) =>
      module.createCoreR2Persistence(core(overrides) as never);
    expect(await persistence({}).claim(input as never)).toEqual({
      status: "claimed",
      mode: "create",
    });
    expect(await persistence({}).authorize(input as never)).toBe(true);
    expect(await persistence({}).read(input as never)).toBeNull();
    await expect(
      persistence({ claimBucket: async () => "x" }).claim(input as never),
    ).rejects.toThrow("Invalid R2 Core response");
    await expect(
      persistence({ claimBucket: async () => ({ status: "claimed", mode: "other" }) }).claim(
        input as never,
      ),
    ).rejects.toThrow("Invalid R2 Core claim response");
    await expect(
      persistence({ authorizeBucket: async () => "yes" }).authorize(input as never),
    ).rejects.toThrow("Invalid R2 Core authorization response");
    const absence = {
      ...input,
      bucketName: "ohmyho-x",
      observedAt: new Date("2026-11-13T10:00:00Z"),
    };
    const sent: unknown[] = [];
    expect(
      await persistence({
        proveBucketAbsence: async (value: unknown) => {
          sent.push(value);
          return "proven";
        },
      }).proveBucketAbsence(absence as never),
    ).toBe("proven");
    expect(sent).toEqual([
      {
        organizationId: input.organizationId,
        projectId: input.projectId,
        environmentId: input.environmentId,
        operationId: input.operationId,
        claimId: input.claimId,
        bucketName: "ohmyho-x",
        observedAt: "2026-11-13T10:00:00.000Z",
      },
    ]);
    expect(
      await persistence({
        supersedeBucketReservation: async () => "operation_open",
      }).supersedeBucketReservation(absence as never),
    ).toBe("operation_open");
    await expect(
      persistence({ proveBucketAbsence: async () => "yes" }).proveBucketAbsence(absence as never),
    ).rejects.toThrow("Invalid R2 Core absence response");
    await expect(
      persistence({ supersedeBucketReservation: async () => "gone" }).supersedeBucketReservation(
        absence as never,
      ),
    ).rejects.toThrow("Invalid R2 Core supersede response");
    await expect(
      persistence({ putBucket: async () => "gone" }).put({
        ...input,
        observedAt: new Date(),
      } as never),
    ).rejects.toThrow("Invalid R2 Core receipt response");
    await expect(
      persistence({ claimBucket: async () => Promise.reject(new Error("storage down")) }).claim(
        input as never,
      ),
    ).rejects.toThrow("storage down");
  });

  it("demands exactly the Core methods it uses", async () => {
    const read = {
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
    };
    const ready = await service(core({}));
    await expect(ready.service.readRuntimeBinding(read)).resolves.toEqual({
      status: "unavailable",
    });
    for (const name of [
      "claimBucket",
      "authorizeBucket",
      "putBucket",
      "readBucket",
      "proveBucketAbsence",
      "supersedeBucketReservation",
      "confirmedStorage",
    ]) {
      const partial = await service(core({ [name]: undefined }));
      await expect(partial.service.readRuntimeBinding(read)).rejects.toThrow(
        "R2 management private Core runtime is unavailable",
      );
    }
  });
});
