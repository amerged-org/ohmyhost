import { createHash } from "node:crypto";
import { serialize } from "node:v8";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BuildReceiptPersistence } from "../src/persistent-broker.js";
import type { BuildRunnerBindings, StartBuildInput } from "../src/worker-main.js";
import { MemoryR2Bucket, SandboxPlatformDouble } from "./doubles.js";

const workerState = vi.hoisted(() => ({ env: undefined as unknown }));

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly env = workerState.env;
  },
}));
vi.mock("@cloudflare/containers", async () => ({
  Container: (await import("./doubles.js")).ContainerBaseDouble,
}));

const BUCKET = "ohmyho-builds-test";
const BUCKET_EU = "ohmyho-builds-test-eu";
const scope = Object.freeze({
  projectId: "01J00000000000000000000001",
  environmentId: "01J00000000000000000000002",
  operationId: "01J00000000000000000000003",
});
const frameworkPlan = {
  schemaVersion: "ohmyhost.framework-plan/v5",
  applicationRoot: ".",
  adapter: "vite-static",
  runtime: "static",
  installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
  buildCommand: "pnpm run build",
  outputDirectory: "dist",
  runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
  database: { enabled: false },
  auth: { provider: "none" },
  mail: { enabled: false },
  storage: { enabled: false },
} as unknown as StartBuildInput["frameworkPlan"];
const BUILD_PLAN_SHA256 = "61530b251355acd239d65eea44adecfa6f808412316cafa538f360ee962a2b6f";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function receipts(): BuildReceiptPersistence {
  return {
    claimBuildInput: vi.fn(async () => ({
      status: "claimed" as const,
      mode: "start" as const,
      attemptNumber: 1,
      reservationCreatedAt: new Date(Date.now() - 1_000),
      startAllowedUntil: new Date(Date.now() + 4 * 60_000),
      leaseExpiresAt: new Date(Date.now() + 30_000),
    })),
    authorizeBuildStart: vi.fn(async () => true),
    putBuildReceipt: vi.fn(async () => undefined),
    putBuildUsage: vi.fn(async () => undefined),
  };
}

/** Every `get` hands out a new object over the operation's platform, as after an eviction. */
async function sandboxNamespace(
  objects: Pick<
    BuildRunnerBindings,
    "BUILD_OBJECTS_US" | "BUILD_OBJECTS_EU" | "BUILD_OBJECTS_BUCKET_US" | "BUILD_OBJECTS_BUCKET_EU"
  >,
  region: "us" | "eu",
) {
  const { BuildSandbox, BuildSandboxEu } = await import("../src/worker-main.js");
  const platforms = new Map<string, SandboxPlatformDouble>();
  const platformOf = (operationId: string) => {
    const platform = platforms.get(operationId) ?? new SandboxPlatformDouble();
    platforms.set(operationId, platform);
    return platform;
  };
  const sandboxOf = (operationId: string) =>
    new (region === "us" ? BuildSandbox : BuildSandboxEu)(
      platformOf(operationId).context as never,
      objects,
    );
  return {
    platformOf,
    sandboxOf,
    namespace: {
      idFromName: (name: string) => name,
      get: vi.fn((id: unknown) => sandboxOf(id as string)),
    },
  };
}

async function bindings(): Promise<
  BuildRunnerBindings & {
    readonly BUILD_OBJECTS_US: MemoryR2Bucket;
    readonly BUILD_OBJECTS_EU: MemoryR2Bucket;
    readonly sandboxes: Awaited<ReturnType<typeof sandboxNamespace>>;
    readonly sandboxesEu: Awaited<ReturnType<typeof sandboxNamespace>>;
  }
> {
  const objects = {
    BUILD_OBJECTS_US: new MemoryR2Bucket(),
    BUILD_OBJECTS_EU: new MemoryR2Bucket(),
    BUILD_OBJECTS_BUCKET_US: BUCKET,
    BUILD_OBJECTS_BUCKET_EU: BUCKET_EU,
  };
  const sandboxes = await sandboxNamespace(objects, "us");
  const sandboxesEu = await sandboxNamespace(objects, "eu");
  return {
    ...objects,
    BUILD_PROJECT: "test-build",
    BUILD_SANDBOX: sandboxes.namespace,
    BUILD_SANDBOX_EU: sandboxesEu.namespace,
    BUILD_RECEIPTS: receipts(),
    sandboxes,
    sandboxesEu,
  };
}

describe("build runner Worker", () => {
  beforeEach(async () => {
    workerState.env = await bindings();
  });

  it("keeps the default fetch entrypoint private", async () => {
    const { default: worker } = await import("../src/worker-main.js");
    await expect(worker.fetch()).resolves.toMatchObject({ status: 404 });
  });

  it("fails closed on override-shaped, cyclic and oversized RPC input on every method", async () => {
    const { BuildRunnerService } = await import("../src/worker-main.js");
    const env = workerState.env as Awaited<ReturnType<typeof bindings>>;
    const service = new BuildRunnerService({} as never, env);
    const forbidden = { scope, bucketOverride: "another-bucket" } as never;
    const calls = [
      () => service.beginArchive(forbidden),
      () => service.uploadArchivePart(forbidden),
      () => service.completeArchive(forbidden),
      () => service.abortArchive(forbidden),
      () => service.observeArchive(forbidden),
      () => service.removeArchive(forbidden),
      () => service.startBuild(forbidden),
      () => service.readBuild(forbidden),
      () => service.stopBuild(forbidden),
      () => service.observeBuildArtifact(forbidden),
      () => service.readBuildArtifact(forbidden),
      () => service.removeBuildArtifact(forbidden),
      () => service.removeBuildArtifactObject(forbidden),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    }
    for (const name of ["buildProject", "imageOverride", "agentToken", "timeoutOverride"]) {
      await expect(
        service.readBuild({ receipt: { nested: [{ [name]: "x" }] }, bucket: BUCKET } as never),
      ).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    }
    const cyclic: Record<string, unknown> = { scope };
    cyclic["self"] = cyclic;
    await expect(service.beginArchive(cyclic as never)).rejects.toMatchObject({
      code: "build_broker_input_invalid",
    });
    await expect(
      service.beginArchive({ scope, wide: Array.from({ length: 20_051 }, () => ({})) } as never),
    ).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    await expect(
      service.uploadArchivePart({
        upload: {},
        partNumber: 1,
        body: new Uint8Array(16 * 1024 * 1024 + 1),
        checksumSha256: "b".repeat(64),
      } as never),
    ).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    await expect(
      service.uploadArchivePart({ upload: {}, partNumber: 1, body: "text" } as never),
    ).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    await expect(
      service.completeArchive({
        upload: {},
        parts: [],
        byteLength: 512 * 1024 * 1024 + 1,
      } as never),
    ).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    // Domain validation still applies after the outer guard accepts the envelope.
    for (const call of [
      () => service.startBuild({ archive: { bucket: BUCKET } } as never),
      () => service.readBuildArtifact({ expectation: { receipt: {} }, bucket: BUCKET } as never),
      () => service.observeBuildArtifact({ expectation: { receipt: {} }, bucket: BUCKET } as never),
      () => service.removeBuildArtifact({ provenance: { output: { bucket: BUCKET } } } as never),
      () => service.removeBuildArtifactObject({ bucket: BUCKET } as never),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    }
    // A bucket this Worker does not bind is refused before any object or sandbox is reached.
    for (const call of [
      () => service.beginArchive({ scope, bucket: "ohmyho-builds-other" }),
      () =>
        service.observeArchive({ scope, bucket: undefined, sourceSha256: "b".repeat(64) } as never),
      () => service.startBuild({ scope, archive: { bucket: "ohmyho-builds-other" } } as never),
      () => service.readBuild({ receipt: {}, bucket: "ohmyho-builds-other" } as never),
      () => service.removeArchive({ bucket: "ohmyho-builds-other" } as never),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "build_broker_input_invalid" });
    }
    expect(env.BUILD_OBJECTS_US.calls).toEqual([]);
    expect(env.BUILD_OBJECTS_EU.calls).toEqual([]);
    expect(env.sandboxes.namespace.get).not.toHaveBeenCalled();
    expect(env.sandboxesEu.namespace.get).not.toHaveBeenCalled();
  });

  it("refuses incomplete or malformed bindings without naming them", async () => {
    const { createBuildRunnerRuntime } = await import("../src/worker-main.js");
    const valid = await bindings();
    expect(createBuildRunnerRuntime(valid, BUCKET)).toHaveProperty("observeBuildStart");
    expect(createBuildRunnerRuntime(valid, BUCKET_EU)).toHaveProperty("observeBuildStart");
    const invalid: unknown[] = [
      null,
      "bindings",
      { ...valid, BUILD_OBJECTS_BUCKET_US: "Not_A_Bucket" },
      { ...valid, BUILD_OBJECTS_BUCKET_EU: "10.0.0.1" },
      { ...valid, BUILD_OBJECTS_BUCKET_US: undefined },
      { ...valid, BUILD_OBJECTS_BUCKET_EU: undefined },
      { ...valid, BUILD_OBJECTS_BUCKET_EU: BUCKET },
      { ...valid, BUILD_PROJECT: "has:colon" },
      { ...valid, BUILD_PROJECT: undefined },
      { ...valid, BUILD_OBJECTS_US: undefined },
      { ...valid, BUILD_OBJECTS_EU: undefined },
      { ...valid, BUILD_OBJECTS_US: { head: valid.BUILD_OBJECTS_US.head } },
      { ...valid, BUILD_SANDBOX: undefined },
      { ...valid, BUILD_SANDBOX_EU: undefined },
      { ...valid, BUILD_SANDBOX: { idFromName: valid.BUILD_SANDBOX.idFromName } },
      { ...valid, BUILD_RECEIPTS: undefined },
      { ...valid, BUILD_RECEIPTS: null },
      { ...valid, BUILD_RECEIPTS: {} },
    ];
    for (const value of invalid) {
      expect(() => createBuildRunnerRuntime(value as never, BUCKET)).toThrowError(
        "build_runner_configuration_invalid",
      );
    }
  });

  it("returns a typed terminal result after exact build-start absence", async () => {
    const { startBuildRpc } = await import("../src/worker-main.js");
    const { BuildStartAbsentError } = await import("../src/persistent-broker.js");

    await expect(
      startBuildRpc(async () => Promise.reject(new BuildStartAbsentError())),
    ).resolves.toEqual({ status: "failed", errorCode: "BUILD_NOT_STARTED" });
    const other = new Error("other");
    await expect(startBuildRpc(async () => Promise.reject(other))).rejects.toBe(other);
  });

  it("returns a typed terminal result for immutable build-artifact conflicts", async () => {
    const { buildArtifactRpc } = await import("../src/worker-main.js");
    const { BuildBrokerConflictError, BuildBrokerUncertainError } = await import(
      "@ohmyhost/build-broker"
    );

    await expect(
      buildArtifactRpc(async () => Promise.reject(new BuildBrokerConflictError())),
    ).resolves.toEqual({ status: "failed", errorCode: "BUILD_FAILED" });
    await expect(
      buildArtifactRpc(async () => Promise.reject(new BuildBrokerUncertainError())),
    ).rejects.toMatchObject({ code: "build_broker_result_uncertain" });
  });

  it("keeps verified artifact RPC results below 32 MiB while preserving migration custody", async () => {
    const { buildArtifactRpc, BuildRunnerService } = await import("../src/worker-main.js");
    const manifestBody = new Uint8Array(1024 * 1024);
    const migrationBody = new Uint8Array(2 * 1024 * 1024);
    const migration = {
      path: "migrations/001_schema.sql",
      digest: `sha256:${sha256(migrationBody)}` as const,
      size: migrationBody.byteLength,
      body: migrationBody,
    };
    const provenance = { scope, output: { bucket: BUCKET, versionId: "verified-version" } };
    const artifact = {
      manifestDigest: `sha256:${sha256(manifestBody)}` as const,
      manifestBody,
      migrations: [migration],
      provenance,
      files: [{ path: "assets/large.txt", body: new Uint8Array(52 * 1024 * 1024) }],
      modules: [{ path: "index.js", body: new Uint8Array(5 * 1024 * 1024) }],
      sbomBody: new Uint8Array(4 * 1024 * 1024),
      runtime: { kind: "cloudflare-worker" },
    };
    expect(serialize(artifact).byteLength).toBeGreaterThan(32 * 1024 * 1024);
    const result = await buildArtifactRpc(async () => artifact as never);
    expect(Object.keys(result).sort()).toEqual([
      "manifestBody",
      "manifestDigest",
      "migrations",
      "provenance",
    ]);
    expect(serialize(result).byteLength).toBeLessThan(5 * 1024 * 1024);
    expect(result).toMatchObject({ manifestDigest: artifact.manifestDigest });
    if (!("manifestBody" in result)) throw new Error("Expected verified artifact metadata");
    expect(result.manifestBody).toBe(manifestBody);
    expect(result.migrations).toBe(artifact.migrations);
    expect(result.provenance).toBe(provenance);
    const env = workerState.env as Awaited<ReturnType<typeof bindings>>;
    const service = new BuildRunnerService({} as never, env);
    const expectation = {
      receipt: { buildId: `test-build:${scope.operationId}`, projectName: "test-build", scope },
      deploymentId: "01J00000000000000000000004",
      commitSha: "c".repeat(40),
      sourceSha256: sha256(new TextEncoder().encode("source")),
      buildPlanSha256: BUILD_PLAN_SHA256,
      frameworkPlan,
    };
    await expect(service.observeBuildArtifact({ expectation, bucket: BUCKET })).resolves.toBeNull();
    await expect(service.readBuildArtifact({ expectation, bucket: BUCKET })).rejects.toMatchObject({
      code: "build_broker_result_uncertain",
    });
  });

  it("uses bounded real-time retries for object reads", async () => {
    const { createBuildRunnerRuntime } = await import("../src/worker-main.js");
    const env = await bindings();
    const reads: number[] = [];
    const head = env.BUILD_OBJECTS_US.head.bind(env.BUILD_OBJECTS_US);
    env.BUILD_OBJECTS_US.head = async (key) => {
      reads.push(Date.now());
      if (reads.length === 1) throw new Error("Service unavailable (10043)");
      return head(key);
    };

    await expect(
      createBuildRunnerRuntime(env, BUCKET).observeArchive({ scope, sourceSha256: "b".repeat(64) }),
    ).resolves.toBeNull();

    const [firstRead, secondRead] = reads;
    if (firstRead === undefined || secondRead === undefined || reads.length !== 2) {
      throw new Error("Expected two bounded read attempts");
    }
    expect(secondRead - firstRead).toBeGreaterThanOrEqual(90);
  });

  it.each([
    ["US", BUCKET, "BUILD_OBJECTS_US", "sandboxes", "enam"],
    ["EU", BUCKET_EU, "BUILD_OBJECTS_EU", "sandboxesEu", "weur"],
  ] as const)(
    "runs an %s operation from the archive through the sandbox of its region to the persisted usage",
    async (_region, bucket, objects, sandboxes, locationHint) => {
      const { BuildRunnerService } = await import("../src/worker-main.js");
      const env = workerState.env as Awaited<ReturnType<typeof bindings>>;
      const other = objects === "BUILD_OBJECTS_US" ? env.BUILD_OBJECTS_EU : env.BUILD_OBJECTS_US;
      const otherSandboxes = sandboxes === "sandboxes" ? env.sandboxesEu : env.sandboxes;
      const service = new BuildRunnerService({} as never, env);
      const source = new TextEncoder().encode("source archive bytes");

      const upload = await service.beginArchive({ scope, bucket });
      expect(upload).toMatchObject({ bucket });
      const part = await service.uploadArchivePart({
        upload,
        partNumber: 1,
        body: source,
        checksumSha256: sha256(source),
      });
      const archive = await service.completeArchive({
        upload,
        parts: [part],
        byteLength: source.byteLength,
        sourceSha256: sha256(source),
      });
      await expect(
        service.observeArchive({ scope, bucket, sourceSha256: sha256(source) }),
      ).resolves.toEqual(archive);

      const input: StartBuildInput = {
        scope,
        archive,
        deploymentId: "01J00000000000000000000004",
        commitSha: "c".repeat(40),
        buildPlanSha256: BUILD_PLAN_SHA256,
        frameworkPlan,
      };
      const receipt = await service.startBuild(input);
      expect(receipt).toEqual({
        buildId: `test-build:${scope.operationId}`,
        projectName: "test-build",
        scope,
      });
      expect(env.BUILD_RECEIPTS.putBuildReceipt).toHaveBeenCalledWith(
        expect.objectContaining({ receipt }),
      );
      if (!("buildId" in receipt)) throw new Error("the build was not started");

      expect(env[sandboxes].namespace.get).toHaveBeenCalledWith(scope.operationId, {
        locationHint,
      });
      expect(otherSandboxes.namespace.get).not.toHaveBeenCalled();
      const platform = env[sandboxes].platformOf(scope.operationId);
      await platform.fire(env[sandboxes].sandboxOf(scope.operationId));
      expect(platform.agent?.source).toEqual(source);
      expect(platform.agent?.environment).toMatchObject({
        BUILD_ID: receipt.buildId,
        EXPECTED_SOURCE_SHA256: sha256(source),
        OPERATION_ID: scope.operationId,
      });
      await expect(service.readBuild({ receipt, bucket })).resolves.toMatchObject({
        status: "running",
        usage: null,
        failure: null,
      });
      expect(env.BUILD_RECEIPTS.putBuildUsage).not.toHaveBeenCalled();

      // A start whose answer was lost is recovered by looking the deterministic build id up.
      vi.mocked(env.BUILD_RECEIPTS.claimBuildInput).mockResolvedValueOnce({
        status: "claimed",
        mode: "observe",
        attemptNumber: 2,
        reservationCreatedAt: new Date(Date.now() - 1_000),
        startAllowedUntil: new Date(Date.now() + 4 * 60_000),
        leaseExpiresAt: new Date(Date.now() + 30_000),
      });
      await expect(service.startBuild(input)).resolves.toEqual(receipt);
      expect(env.BUILD_RECEIPTS.putBuildReceipt).toHaveBeenCalledTimes(2);
      expect(env.BUILD_RECEIPTS.authorizeBuildStart).toHaveBeenCalledTimes(1);
      expect(platform.startOptions).toHaveLength(1);

      platform.agent?.fail(
        {
          schemaVersion: "ohmyhost.build-failure/v1",
          operationId: scope.operationId,
          excerpt: "vite: build failed",
          truncated: false,
          logBytes: 18,
        },
        "vite: build failed",
        new Date(Date.now() + 1_000).toISOString(),
      );
      await platform.fire(env[sandboxes].sandboxOf(scope.operationId));

      const observed = await service.readBuild({ receipt, bucket });
      expect(observed).toMatchObject({
        status: "failed",
        failure: { excerpt: "vite: build failed", truncated: false },
        usage: { runner: "cloudflare-build-sandbox", instanceType: "standard-3", status: "FAILED" },
      });
      expect(env.BUILD_RECEIPTS.putBuildUsage).toHaveBeenCalledWith({
        receipt,
        usage: observed.usage,
      });
      expect(platform.destroyed).toBe(1);
      // A terminal build cannot be stopped any more; the broker treats that as done.
      await expect(service.stopBuild({ receipt, bucket })).resolves.toBeUndefined();
      await expect(service.removeArchive(archive)).resolves.toMatchObject({ state: "absent" });
      await expect(service.abortArchive(upload)).resolves.toBeUndefined();
      expect(other.calls).toEqual([]);
      expect(otherSandboxes.namespace.get).not.toHaveBeenCalled();
    },
  );
});
