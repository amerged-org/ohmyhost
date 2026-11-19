import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FixedClock,
  creditMicros,
  parseUlid,
  type DeploymentApplyInput,
  type FrameworkPlan,
  type ProviderRef,
} from "@ohmyhost/platform";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FakeProviderStore } from "./fake-provider-store.js";
import {
  FakeProviderConflictError,
  FakeProviderFailureError,
  FakeProviderTimeoutError,
  FakeStaticHostingProvider,
} from "./fake-static-hosting-provider.js";

const PROJECT_ID = parseUlid("01J00000000000000000000000");
const ENVIRONMENT_ID = parseUlid("01J00000000000000000000001");
const OPERATION_ID = parseUlid("01J00000000000000000000002");
const SECOND_PROJECT_ID = parseUlid("01J00000000000000000000003");
const SECOND_OPERATION_ID = parseUlid("01J00000000000000000000004");
const SECOND_ENVIRONMENT_ID = parseUlid("01J00000000000000000000005");
const NOW = new Date("2026-08-17T10:00:00.000Z");
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const FRAMEWORK_PLAN: FrameworkPlan & { buildCommand: string; outputDirectory: string } = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: "." as never,
  adapter: "ohmyhost-config",
  runtime: "static",
  installCommand: "pnpm install --frozen-lockfile",
  buildCommand: "pnpm build",
  outputDirectory: "dist",
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
};
const activeDirectories: string[] = [];
const createdDirectories: string[] = [];

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  activeDirectories.push(directory);
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of activeDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  for (const directory of createdDirectories) {
    await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

function applyInput(
  idempotencyKey = "deploy-1",
  artifactDigest = DIGEST_A,
  operationId = OPERATION_ID,
  projectId = PROJECT_ID,
): DeploymentApplyInput<"static-hosting"> {
  return {
    artifactDigest,
    context: {
      projectId,
      environmentId: ENVIRONMENT_ID,
      operationId,
      idempotencyKey,
    },
    frameworkPlan: FRAMEWORK_PLAN,
    plan: {
      capability: "static-hosting",
      actions: [`build:${FRAMEWORK_PLAN.buildCommand}`, `publish:${artifactDigest}:dist`],
      estimatedCreditCharge: creditMicros(0n),
    },
  };
}

describe("FakeStaticHostingProvider", () => {
  let store: FakeProviderStore;

  beforeEach(async () => {
    const directory = await createTemporaryDirectory("ohmyhost-provider-");
    store = new FakeProviderStore(join(directory, "state.json"));
  });

  it("plans deterministically without mutation or network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const input = {
      projectId: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      artifactDigest: DIGEST_A,
      frameworkPlan: FRAMEWORK_PLAN,
    };

    const first = await provider.plan(input);
    const second = await provider.plan(input);

    expect(second).toEqual(first);
    expect(first).toEqual({
      capability: "static-hosting",
      actions: ["build:pnpm build", `publish:${DIGEST_A}:dist`],
      estimatedCreditCharge: 0n,
    });
    await expect(store.list()).resolves.toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("applies once and replays the exact original resource", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });

    const first = await provider.apply(applyInput());
    const replay = await provider.apply(applyInput());

    expect(replay).toEqual(first);
    expect(replay).toBe(first);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("rejects reuse of an idempotency key with different canonical input", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    await provider.apply(applyInput());

    await expect(provider.apply(applyInput("deploy-1", DIGEST_B))).rejects.toBeInstanceOf(
      FakeProviderConflictError,
    );
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("includes the framework plan in the apply idempotency fingerprint", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const original = applyInput();
    await provider.apply(original);

    await expect(
      provider.apply({
        ...original,
        frameworkPlan: { ...FRAMEWORK_PLAN, outputDirectory: "public" },
      }),
    ).rejects.toBeInstanceOf(FakeProviderConflictError);
  });

  it("replays a semantically equal framework plan regardless of object key order", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const original = applyInput();
    const first = await provider.apply(original);
    const reordered: FrameworkPlan = {
      outputDirectory: FRAMEWORK_PLAN.outputDirectory,
      buildCommand: FRAMEWORK_PLAN.buildCommand,
      installCommand: FRAMEWORK_PLAN.installCommand,
      runtime: FRAMEWORK_PLAN.runtime,
      adapter: FRAMEWORK_PLAN.adapter,
      applicationRoot: FRAMEWORK_PLAN.applicationRoot,
      runtimePolicy: FRAMEWORK_PLAN.runtimePolicy,
      database: FRAMEWORK_PLAN.database,
      auth: FRAMEWORK_PLAN.auth,
      mail: FRAMEWORK_PLAN.mail,
      storage: FRAMEWORK_PLAN.storage,
      schemaVersion: FRAMEWORK_PLAN.schemaVersion,
    };

    await expect(provider.apply({ ...original, frameworkPlan: reordered })).resolves.toBe(first);
  });

  it("scopes the same idempotency key to its operation", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });

    const first = await provider.apply(applyInput());
    const second = await provider.apply(
      applyInput("deploy-1", DIGEST_B, SECOND_OPERATION_ID, SECOND_PROJECT_ID),
    );

    expect(second.externalId).not.toBe(first.externalId);
    await expect(store.list()).resolves.toHaveLength(2);
  });

  it("atomically resolves concurrent different payloads for the same operation and key", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });

    const results = await Promise.allSettled([
      provider.apply(applyInput("deploy-race", DIGEST_A)),
      provider.apply(applyInput("deploy-race", DIGEST_B)),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({ reason: expect.any(FakeProviderConflictError) });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("rejects concurrent external-ID duplication from a new key without corrupting the store", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });

    const results = await Promise.allSettled([
      provider.apply(applyInput("deploy-first", DIGEST_A)),
      provider.apply(applyInput("deploy-second", DIGEST_A)),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejection = results.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({ reason: expect.any(FakeProviderConflictError) });
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("fails before commit without writing state", async () => {
    const provider = new FakeStaticHostingProvider({
      store,
      clock: new FixedClock(NOW),
      scenario: "failure-before-commit",
    });

    await expect(provider.apply(applyInput())).rejects.toBeInstanceOf(FakeProviderFailureError);
    await expect(store.list()).resolves.toEqual([]);
  });

  it("times out after commit once and converges on retry", async () => {
    const provider = new FakeStaticHostingProvider({
      store,
      clock: new FixedClock(NOW),
      scenario: "timeout-after-commit",
    });

    await expect(provider.apply(applyInput())).rejects.toBeInstanceOf(FakeProviderTimeoutError);
    expect(await store.list()).toHaveLength(1);

    const replay = await provider.apply(applyInput());
    expect(replay.externalId).toMatch(/^fake-static-/);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  it("observes injected drift and removed state", async () => {
    const provider = new FakeStaticHostingProvider({
      store,
      clock: new FixedClock(NOW),
      scenario: "drift",
    });
    const resource = await provider.apply(applyInput());

    await expect(provider.observe(resource)).resolves.toEqual({
      ref: {
        capability: "static-hosting",
        provider: resource.provider,
        externalId: resource.externalId,
      },
      state: "failed",
      observedAt: NOW,
    });

    await provider.remove({
      ref: resource,
      context: applyInput("remove-1", DIGEST_A, SECOND_OPERATION_ID).context,
    });
    await provider.remove({
      ref: resource,
      context: applyInput("remove-1", DIGEST_A, SECOND_OPERATION_ID).context,
    });
    await expect(provider.observe(resource)).resolves.toMatchObject({ state: "removed" });
  });

  it("reports unknown resources as removed and rejects foreign provider refs", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const unknown: ProviderRef<"static-hosting"> = {
      capability: "static-hosting",
      provider: "fake-static",
      externalId: "fake-static-unknown",
    };
    await expect(provider.observe(unknown)).resolves.toMatchObject({ state: "removed" });

    await expect(provider.observe({ ...unknown, provider: "foreign" })).rejects.toThrow(
      "Unsupported provider reference",
    );
  });

  it("observes a persisted resource by its complete mutation context", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const input = applyInput();
    const resource = await provider.apply(input);

    await expect(provider.observeByMutation(input.context)).resolves.toEqual({
      ref: {
        capability: "static-hosting",
        provider: resource.provider,
        externalId: resource.externalId,
      },
      state: "ready",
      observedAt: NOW,
    });
  });

  it("returns null when a mutation-scoped resource does not exist", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });

    await expect(
      provider.observeByMutation(applyInput("missing", DIGEST_A, SECOND_OPERATION_ID).context),
    ).resolves.toBeNull();
  });

  it("rejects mutation observation when persisted ownership does not match", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const input = applyInput();
    await provider.apply(input);

    await expect(
      provider.observeByMutation({ ...input.context, projectId: SECOND_PROJECT_ID }),
    ).rejects.toThrow("Observe context does not match resource scope");
    await expect(
      provider.observeByMutation({ ...input.context, environmentId: SECOND_ENVIRONMENT_ID }),
    ).rejects.toThrow("Observe context does not match resource scope");
  });

  it("rejects incomplete mutation context for apply and remove", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const resource = await provider.apply(applyInput());
    const invalid = {
      ...applyInput("remove-1").context,
      idempotencyKey: "",
    };

    await expect(provider.apply({ ...applyInput(), context: invalid })).rejects.toThrow(
      "idempotency key must not be empty",
    );
    await expect(provider.remove({ ref: resource, context: invalid })).rejects.toThrow(
      "idempotency key must not be empty",
    );

    const validContext = applyInput("remove-2").context;
    const invalidUlids = [
      [{ ...validContext, operationId: "" as typeof OPERATION_ID }, "operationId"],
      [{ ...validContext, projectId: "" as typeof PROJECT_ID }, "projectId"],
      [{ ...validContext, environmentId: "" as typeof ENVIRONMENT_ID }, "environmentId"],
    ] as const;
    for (const [context, field] of invalidUlids) {
      await expect(provider.remove({ ref: resource, context })).rejects.toThrow(
        `${field} must be a canonical ULID`,
      );
    }
  });

  it("rejects cross-scope remove without changing observed state", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const resource = await provider.apply(applyInput());
    const originalContext = applyInput("remove-1").context;
    const foreignContexts = [
      { ...originalContext, projectId: SECOND_PROJECT_ID },
      { ...originalContext, environmentId: SECOND_ENVIRONMENT_ID },
    ];

    for (const context of foreignContexts) {
      await expect(provider.remove({ ref: resource, context })).rejects.toThrow(
        "Remove context does not match resource scope",
      );
      await expect(provider.observe(resource)).resolves.toMatchObject({ state: "ready" });
    }
  });

  it("allows a distinct delete operation within the owning project and environment", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });
    const resource = await provider.apply(applyInput());
    const deleteContext = applyInput("delete-1", DIGEST_A, SECOND_OPERATION_ID).context;

    await provider.remove({ ref: resource, context: deleteContext });
    await provider.remove({ ref: resource, context: deleteContext });

    await expect(provider.observe(resource)).resolves.toMatchObject({ state: "removed" });
    await expect(
      provider.remove({
        ref: resource,
        context: { ...deleteContext, projectId: SECOND_PROJECT_ID },
      }),
    ).rejects.toThrow("Remove context does not match resource scope");
  });

  it("rejects incomplete sha256 digests", async () => {
    const provider = new FakeStaticHostingProvider({ store, clock: new FixedClock(NOW) });

    await expect(
      provider.plan({
        projectId: PROJECT_ID,
        environmentId: ENVIRONMENT_ID,
        artifactDigest: "sha256:abc",
        frameworkPlan: FRAMEWORK_PLAN,
      }),
    ).rejects.toThrow("artifact digest must be a complete sha256 digest");
  });
});
