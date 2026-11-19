import { describe, expect, it, vi } from "vitest";
import { APPLICATION_ROOT_CONFORMANCE_CORPUS } from "@ohmyhost/contracts/application-root";
import { normalizeBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import {
  parseNewProductionFrameworkPlan,
  serializeNewProductionFrameworkPlanPreimage,
} from "@ohmyhost/platform";

import {
  BuildBrokerCapacityError,
  BuildBrokerConflictError,
  BuildBrokerInputError,
  BuildBrokerTransportError,
  BuildBrokerUncertainError,
  createBuildBroker,
  fingerprintBuildStartInput,
  operationPaths,
  parseVerifiedArtifactBundle,
  type BuildBrokerDependencies,
  type BuildExecutor,
  type ObjectStore,
} from "./index.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const scope = Object.freeze({
  projectId: "01J00000000000000000000001",
  environmentId: "01J00000000000000000000002",
  operationId: "01J00000000000000000000003",
});
const BUILD_ID = "ohmyho-sandbox-vite:01J00000000000000000000003";
const buildIdentity = Object.freeze({
  deploymentId: "01J00000000000000000000004",
  commitSha: "c".repeat(40),
  buildPlanSha256: "812d2dcf80cf510050dd211aaede19ad2b95aac35ea7fcd24fb0467e07f60222",
  frameworkPlan: parseNewProductionFrameworkPlan({
    schemaVersion: "ohmyhost.framework-plan/v5" as const,
    applicationRoot: "site",
    adapter: "vite-static" as const,
    runtime: "static" as const,
    installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
    buildCommand: "pnpm run build",
    outputDirectory: "dist",
    runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [] },
    database: { enabled: false },
    auth: { provider: "none" },
    mail: { enabled: false },
    storage: { enabled: false },
  }),
});
const encoder = new TextEncoder();
const tanStackEdgePlan = parseNewProductionFrameworkPlan({
  schemaVersion: "ohmyhost.framework-plan/v5" as const,
  applicationRoot: "site",
  adapter: "tanstack-start" as const,
  runtime: "edge" as const,
  installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
  buildCommand: "pnpm run build",
  outputDirectory: "dist/client" as const,
  serverOutputDirectory: "dist/server" as const,
  serverEntryPoint: "dist/server/index.js" as const,
  serverConfigPath: "dist/server/wrangler.json" as const,
  compatibilityDate: "2026-08-21",
  compatibilityFlags: ["nodejs_compat"] as const,
  runtimePolicy: buildIdentity.frameworkPlan.runtimePolicy,
  database: buildIdentity.frameworkPlan.database,
  auth: buildIdentity.frameworkPlan.auth,
  mail: buildIdentity.frameworkPlan.mail,
  storage: buildIdentity.frameworkPlan.storage,
});
const legacyNextPlan = parseNewProductionFrameworkPlan({
  ...buildIdentity.frameworkPlan,
  adapter: "nextjs",
  runtime: "edge",
  outputDirectory: ".open-next/assets",
  serverOutputDirectory: ".ohmyhost-worker",
  serverEntryPoint: ".ohmyhost-worker/worker.js",
  serverConfigPath: "wrangler.jsonc",
  compatibilityDate: "2024-09-23",
  compatibilityFlags: ["nodejs_compat"],
});

async function hex(body: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(body).buffer));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function planDigest(plan: unknown): Promise<string> {
  return hex(encoder.encode(serializeNewProductionFrameworkPlanPreimage(plan)));
}

function tar(entries: readonly { path: string; body: Uint8Array; type?: number }[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const split = entry.path.length > 100 ? entry.path.lastIndexOf("/") : -1;
    header.set(encoder.encode(entry.path.slice(split + 1)), 0);
    if (split !== -1) header.set(encoder.encode(entry.path.slice(0, split)), 345);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(encoder.encode(`${entry.body.byteLength.toString(8).padStart(11, "0")}\0`), 124);
    header.set(encoder.encode("00000000000\0"), 136);
    header.fill(32, 148, 156);
    header[156] = entry.type ?? 48;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(encoder.encode(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
    blocks.push(header, entry.body, new Uint8Array((512 - (entry.body.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const result = new Uint8Array(blocks.reduce((sum, block) => sum + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.byteLength;
  }
  return result;
}

function deterministicNoise(byteLength: number): Uint8Array {
  const result = new Uint8Array(byteLength);
  let state = 0x9e3779b9;
  for (let index = 0; index < result.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result[index] = state & 0xff;
  }
  return result;
}

async function gzip(body: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([new Uint8Array(body).buffer])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function observeStreamInput(
  NativeStream: typeof CompressionStream | typeof DecompressionStream,
  inputs: Uint8Array[],
) {
  return class {
    public readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    public readonly writable: WritableStream<Uint8Array<ArrayBuffer>>;

    public constructor(format: CompressionFormat) {
      const input = new TransformStream<Uint8Array<ArrayBuffer>, BufferSource>({
        transform(chunk, controller) {
          inputs.push(chunk);
          controller.enqueue(chunk);
        },
      });
      this.writable = input.writable;
      this.readable = input.readable.pipeThrough(new NativeStream(format));
    }
  };
}

async function lifecycleEvidence(frameworkPlan: {
  readonly adapter: string;
  readonly runtime: string;
}) {
  return {
    configurationDigest: "0".repeat(64),
    frozenInstall: {
      packageManager: "pnpm",
      packageManagerVersion: "10.28.2",
      lockfile: "pnpm-lock.yaml",
      lockfileSha256: "1".repeat(64),
      installCommandSha256: "2".repeat(64),
      dependencyInventorySha256: "3".repeat(64),
    },
    frameworkBuild: {
      framework: frameworkPlan.adapter === "vite-static" ? "vite" : frameworkPlan.adapter,
      runtime: frameworkPlan.runtime,
      buildCommandSha256: "4".repeat(64),
      frameworkPlanSha256: await planDigest(frameworkPlan),
      buildOutputSha256: "5".repeat(64),
    },
    buildSandbox: {
      buildId: BUILD_ID,
      projectName: "ohmyho-sandbox-vite",
      buildInputFingerprint: "6".repeat(64),
      sourceArchiveSha256: "a".repeat(64),
      terminalStatus: "SUCCEEDED",
    },
    credentialScan: {
      scannerSha256: "7".repeat(64),
      rulesSha256: "8".repeat(64),
      findingsCount: 0,
    },
  } as const;
}

async function buildBundle(
  overrides: Record<string, unknown> = {},
  extraEntries: readonly { path: string; body: Uint8Array; type?: number }[] = [],
  frameworkPlan = buildIdentity.frameworkPlan,
) {
  const index = encoder.encode("<!doctype html><title>ok</title>");
  const sbom = encoder.encode(
    JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1 }),
  );
  const assets = [
    { path: "/index.html", digest: `sha256:${await hex(index)}`, size: index.byteLength },
  ];
  const migrations = await Promise.all(
    extraEntries
      .filter((entry) => entry.path.startsWith("migrations/") && entry.type === undefined)
      .map(async (entry) => ({
        path: entry.path.slice("migrations/".length),
        digest: `sha256:${await hex(entry.body)}`,
        size: entry.body.byteLength,
      })),
  );
  const artifactDigest = `sha256:${await hex(
    encoder.encode(
      JSON.stringify({
        applicationRoot: frameworkPlan.applicationRoot,
        frameworkPlanSchemaVersion: frameworkPlan.schemaVersion,
        runtimePolicy: frameworkPlan.runtimePolicy,
        database: frameworkPlan.database,
        auth: frameworkPlan.auth,
        storage: frameworkPlan.storage,
        ...(frameworkPlan.database.enabled ? { migrations } : {}),
        assets,
      }),
    ),
  )}`;
  const manifest = encoder.encode(
    JSON.stringify({
      schemaVersion: "ohmyhost.artifact/v3",
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      deploymentId: buildIdentity.deploymentId,
      operationId: scope.operationId,
      buildId: BUILD_ID,
      sourceCommit: buildIdentity.commitSha,
      sourceDigest: `sha256:${"a".repeat(64)}`,
      buildPlanDigest: `sha256:${buildIdentity.buildPlanSha256}`,
      applicationRoot: frameworkPlan.applicationRoot,
      frameworkPlanSchemaVersion: frameworkPlan.schemaVersion,
      runtimePolicy: frameworkPlan.runtimePolicy,
      database: frameworkPlan.database,
      auth: frameworkPlan.auth,
      storage: frameworkPlan.storage,
      lifecycleEvidence: await lifecycleEvidence(frameworkPlan),
      ...(frameworkPlan.database.enabled ? { migrations } : {}),
      artifactDigest,
      sbom: { path: "sbom.cdx.json", digest: `sha256:${await hex(sbom)}` },
      assets,
      ...overrides,
    }),
  );
  return gzip(
    tar([
      { path: "manifest.json", body: manifest },
      { path: "sbom.cdx.json", body: sbom },
      { path: "assets/index.html", body: index },
      ...extraEntries,
    ]),
  );
}

async function buildEdgeBundle(
  runtimeOverrides: Record<string, unknown> = {},
  main: Uint8Array = encoder.encode(
    'import chunk from "./assets/chunk.js"; export default chunk;\n',
  ),
  artifactDigestOverride?: `sha256:${string}`,
  includeChunkOverride?: boolean,
  frameworkPlan = buildIdentity.frameworkPlan,
  wasmBody?: Uint8Array,
  chunkPath = "assets/chunk.js",
  extraModules: readonly {
    path: string;
    body: Uint8Array;
    contentType?: string;
    digest?: string;
    size?: number;
  }[] = [],
  extraAssets: readonly { path: string; body: Uint8Array }[] = [],
  customSbom?: Uint8Array,
) {
  const client = encoder.encode("console.log('client')");
  const chunk = encoder.encode(
    'export default { async fetch() { return new Response("edge"); } };\n',
  );
  const sbom =
    customSbom ??
    encoder.encode(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1 }));
  const assets = [
    { path: "/assets/client.js", digest: `sha256:${await hex(client)}`, size: client.byteLength },
    ...(await Promise.all(
      extraAssets.map(async ({ path, body }) => ({
        path,
        digest: `sha256:${await hex(body)}`,
        size: body.byteLength,
      })),
    )),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const runtime = {
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: "2026-08-21",
    compatibilityFlags: ["nodejs_compat"],
    entryWrapperVersion: "tanstack-edge-wrapper-v1",
    ...runtimeOverrides,
  };
  const indexModule = {
    path: "index.js",
    contentType: "application/javascript+module",
    digest: `sha256:${await hex(main)}`,
    size: main.byteLength,
  };
  const includeChunk =
    includeChunkOverride ??
    (runtime.entryWrapperVersion !== "nextjs-opennext-wrapper-v1" &&
      runtime.entryWrapperVersion !== "vite-api-companion-v1");
  const modules = (
    !includeChunk
      ? [indexModule]
      : [
          {
            path: chunkPath,
            contentType: "application/javascript+module",
            digest: `sha256:${await hex(chunk)}`,
            size: chunk.byteLength,
          },
          indexModule,
        ]
  ).sort((left, right) => left.path.localeCompare(right.path));
  if (wasmBody !== undefined) {
    modules.push({
      path: "codec.wasm",
      contentType: "application/wasm",
      digest: `sha256:${await hex(wasmBody)}`,
      size: wasmBody.byteLength,
    });
    modules.sort((left, right) => left.path.localeCompare(right.path));
  }
  for (const module of extraModules) {
    modules.push({
      path: module.path,
      contentType: module.contentType ?? "application/octet-stream",
      digest: module.digest ?? `sha256:${await hex(module.body)}`,
      size: module.size ?? module.body.byteLength,
    });
  }
  modules.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const artifactDigest = `sha256:${await hex(
    encoder.encode(
      JSON.stringify({
        applicationRoot: frameworkPlan.applicationRoot,
        frameworkPlanSchemaVersion: frameworkPlan.schemaVersion,
        runtimePolicy: frameworkPlan.runtimePolicy,
        database: frameworkPlan.database,
        auth: frameworkPlan.auth,
        storage: frameworkPlan.storage,
        ...(frameworkPlan.functions === undefined ? {} : { functions: frameworkPlan.functions }),
        runtime,
        assets,
        modules,
      }),
    ),
  )}`;
  const manifest = encoder.encode(
    JSON.stringify({
      schemaVersion: "ohmyhost.artifact/v3",
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      deploymentId: buildIdentity.deploymentId,
      operationId: scope.operationId,
      buildId: BUILD_ID,
      sourceCommit: buildIdentity.commitSha,
      sourceDigest: `sha256:${"a".repeat(64)}`,
      buildPlanDigest: `sha256:${await planDigest(frameworkPlan)}`,
      applicationRoot: frameworkPlan.applicationRoot,
      frameworkPlanSchemaVersion: frameworkPlan.schemaVersion,
      runtimePolicy: frameworkPlan.runtimePolicy,
      database: frameworkPlan.database,
      auth: frameworkPlan.auth,
      storage: frameworkPlan.storage,
      lifecycleEvidence: await lifecycleEvidence(frameworkPlan),
      ...(frameworkPlan.functions === undefined ? {} : { functions: frameworkPlan.functions }),
      artifactDigest: artifactDigestOverride ?? artifactDigest,
      sbom: { path: "sbom.cdx.json", digest: `sha256:${await hex(sbom)}` },
      runtime,
      assets,
      modules,
    }),
  );
  return gzip(
    tar([
      { path: "manifest.json", body: manifest },
      { path: "sbom.cdx.json", body: sbom },
      { path: "assets/assets/client.js", body: client },
      ...extraAssets.map(({ path, body }) => ({ path: `assets${path}`, body })),
      { path: "worker/index.js", body: main },
      ...(wasmBody === undefined ? [] : [{ path: "worker/codec.wasm", body: wasmBody }]),
      ...(includeChunk ? [{ path: `worker/${chunkPath}`, body: chunk }] : []),
      ...extraModules.map((module) => ({ path: `worker/${module.path}`, body: module.body })),
    ]),
  );
}

function setup(overrides: Partial<BuildBrokerDependencies> = {}) {
  const objectStore: ObjectStore = {
    listMultipartUploads: vi.fn(async () => []),
    createMultipartUpload: vi.fn(async () => ({ uploadId: "upload-1" })),
    uploadPart: vi.fn(async () => ({ eTag: '"etag-1"' })),
    completeMultipartUpload: vi.fn(async () => ({ versionId: "version-1", eTag: '"final"' })),
    abortMultipartUpload: vi.fn(async () => undefined),
    headObject: vi.fn(async () => null),
    verifyObjectSha256: vi.fn(async (command) => ({
      byteLength: 3,
      sha256: command.expectedSha256,
    })),
    readObject: vi.fn(async () => ({ body: new Uint8Array([1, 2, 3]), sha256: "a".repeat(64) })),
    deleteObject: vi.fn(async () => undefined),
  };
  const executor: BuildExecutor = {
    startBuild: vi.fn(async (command) => ({
      buildId: command.buildId,
      projectName: command.buildProject,
    })),
    batchGetBuilds: vi.fn(async () => []),
    stopBuild: vi.fn(async (command) => ({
      buildId: command.buildId,
      status: "STOPPED" as const,
    })),
  };
  const dependencies: BuildBrokerDependencies = {
    objectStore,
    executor,
    now: () => NOW,
    sleep: vi.fn(async () => undefined),
    bucket: "ohmyho-sandbox-builds",
    buildProject: "ohmyho-sandbox-vite",
    requestTimeoutMs: 5_000,
    retryDelayMs: 1,
    maximumAttempts: 2,
    ...overrides,
  };
  return { broker: createBuildBroker(dependencies), executor, dependencies, objectStore };
}

describe("operationPaths", () => {
  it("derives the exact operation-scoped input, output and log keys", () => {
    expect(operationPaths(scope)).toEqual({
      inputKey:
        "runs/01J00000000000000000000001/01J00000000000000000000002/01J00000000000000000000003/input/source.tar.gz",
      outputPrefix:
        "runs/01J00000000000000000000001/01J00000000000000000000002/01J00000000000000000000003/output/",
      bundleKey:
        "runs/01J00000000000000000000001/01J00000000000000000000002/01J00000000000000000000003/output/bundle.tar.gz",
      failureKey:
        "logs/01J00000000000000000000001/01J00000000000000000000002/01J00000000000000000000003.failure.json",
      logKey:
        "logs/01J00000000000000000000001/01J00000000000000000000002/01J00000000000000000000003.log",
    });
  });

  it("keeps every stored operation object except the inputs and bundle under the logs prefix", () => {
    const { inputKey, outputPrefix, bundleKey, ...expiring } = operationPaths(scope);
    expect(inputKey.startsWith("runs/")).toBe(true);
    expect(bundleKey.startsWith(outputPrefix)).toBe(true);
    for (const key of Object.values(expiring)) {
      expect(key.startsWith("logs/")).toBe(true);
    }
  });

  it("rejects path injection", () => {
    expect(() => operationPaths({ ...scope, operationId: "../other-run" })).toThrow(
      BuildBrokerInputError,
    );
  });

  it("rejects ULIDs whose first Crockford digit exceeds the ULID range", () => {
    expect(() => operationPaths({ ...scope, projectId: "81J00000000000000000000001" })).toThrow(
      BuildBrokerInputError,
    );
  });
});

describe("multipart archive lifecycle", () => {
  it("begins the exact tar.gz upload without touching the build executor", async () => {
    const { broker, dependencies, executor, objectStore } = setup();
    const receipt = await broker.beginArchive({ scope });

    expect(receipt).toEqual({
      bucket: "ohmyho-sandbox-builds",
      key: operationPaths(scope).inputKey,
      uploadId: "upload-1",
      scope,
    });
    expect(objectStore.createMultipartUpload).toHaveBeenCalledWith(
      {
        bucket: dependencies.bucket,
        key: operationPaths(scope).inputKey,
        contentType: "application/gzip",
        metadata: { operation: scope.operationId },
      },
      expect.any(AbortSignal),
    );
    expect(executor.startBuild).not.toHaveBeenCalled();
    expect(executor.batchGetBuilds).not.toHaveBeenCalled();
  });

  it("uploads parts, completes with an immutable VersionId, and observes it", async () => {
    const { broker, objectStore } = setup();
    const upload = await broker.beginArchive({ scope });
    const part = await broker.uploadArchivePart({
      upload,
      partNumber: 1,
      body: new Uint8Array([1, 2, 3]),
      checksumSha256: "b".repeat(64),
    });
    expect(part).toEqual({ partNumber: 1, eTag: '"etag-1"', checksumSha256: "b".repeat(64) });

    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "version-1",
      eTag: '"final"',
      byteLength: 3,
      metadata: { operation: scope.operationId, sourceSha256: "a".repeat(64) },
    });
    const object = await broker.completeArchive({
      upload,
      parts: [part],
      byteLength: 3,
      sourceSha256: "a".repeat(64),
    });
    expect(objectStore.completeMultipartUpload).toHaveBeenCalledWith(
      {
        bucket: upload.bucket,
        key: upload.key,
        uploadId: upload.uploadId,
        parts: [{ partNumber: 1, eTag: '"etag-1"', checksumSha256: "b".repeat(64) }],
      },
      expect.any(AbortSignal),
    );
    expect(object.versionId).toBe("version-1");
    expect(await broker.observeArchive({ scope, sourceSha256: "a".repeat(64) })).toEqual(object);
  });

  it("never claims an unproven pending multipart upload after a crash", async () => {
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.listMultipartUploads).mockResolvedValueOnce([
      { uploadId: "upload-before-crash", key: operationPaths(scope).inputKey },
    ]);

    await expect(broker.beginArchive({ scope })).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(objectStore.createMultipartUpload).not.toHaveBeenCalled();
  });

  it("rejects a completed object whose exact VersionId hashes to different bytes", async () => {
    const { broker, objectStore } = setup();
    const upload = await broker.beginArchive({ scope });
    vi.mocked(objectStore.verifyObjectSha256).mockResolvedValueOnce({
      byteLength: 3,
      sha256: "f".repeat(64),
    });
    await expect(
      broker.completeArchive({
        upload,
        parts: [{ partNumber: 1, eTag: '"etag"', checksumSha256: "b".repeat(64) }],
        byteLength: 3,
        sourceSha256: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(objectStore.verifyObjectSha256).toHaveBeenCalledWith(
      {
        bucket: upload.bucket,
        key: upload.key,
        versionId: "version-1",
        expectedSha256: "a".repeat(64),
      },
      expect.any(AbortSignal),
    );
  });

  it("reconciles timeout-after-commit instead of starting another upload", async () => {
    const { broker, objectStore } = setup();
    const upload = await broker.beginArchive({ scope });
    vi.mocked(objectStore.completeMultipartUpload).mockRejectedValueOnce(
      new TypeError("socket closed"),
    );
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "version-after-timeout",
      eTag: '"final"',
      byteLength: 3,
      metadata: { operation: scope.operationId, sourceSha256: "a".repeat(64) },
    });

    await expect(
      broker.completeArchive({
        upload,
        parts: [{ partNumber: 1, eTag: '"etag"', checksumSha256: "b".repeat(64) }],
        byteLength: 3,
        sourceSha256: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ versionId: "version-after-timeout" });
  });

  it("reports an uncertain mutation when completion cannot be reconciled", async () => {
    const { broker, objectStore } = setup();
    const upload = await broker.beginArchive({ scope });
    vi.mocked(objectStore.completeMultipartUpload).mockRejectedValueOnce(
      new TypeError("socket closed"),
    );
    await expect(
      broker.completeArchive({
        upload,
        parts: [{ partNumber: 1, eTag: '"etag"', checksumSha256: "b".repeat(64) }],
        byteLength: 3,
        sourceSha256: "a".repeat(64),
      }),
    ).rejects.toBeInstanceOf(BuildBrokerUncertainError);
  });

  it("aborts idempotently and rejects cross-run receipts and conflicting observations", async () => {
    const { broker, objectStore } = setup();
    const upload = await broker.beginArchive({ scope });
    await expect(broker.abortArchive(upload)).resolves.toBeUndefined();
    vi.mocked(objectStore.abortMultipartUpload).mockRejectedValueOnce({ code: "NoSuchUpload" });
    await expect(broker.abortArchive(upload)).resolves.toBeUndefined();

    await expect(
      broker.uploadArchivePart({
        upload: {
          ...upload,
          key: operationPaths({ ...scope, operationId: "01J00000000000000000000004" }).inputKey,
        },
        partNumber: 1,
        body: new Uint8Array([1]),
        checksumSha256: "b".repeat(64),
      }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);

    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "wrong",
      eTag: '"wrong"',
      byteLength: 1,
      metadata: { operation: "01J00000000000000000000004", sourceSha256: "c".repeat(64) },
    });
    await expect(
      broker.observeArchive({ scope, sourceSha256: "a".repeat(64) }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
  });

  it("removes only the exact immutable source version and proves idempotent absence", async () => {
    const { broker, objectStore } = setup();
    const upload = await broker.beginArchive({ scope });
    const archive = await broker.completeArchive({
      upload,
      parts: [{ partNumber: 1, eTag: '"etag"', checksumSha256: "b".repeat(64) }],
      byteLength: 3,
      sourceSha256: "a".repeat(64),
    });
    vi.mocked(objectStore.headObject)
      .mockResolvedValueOnce({
        versionId: archive.versionId,
        eTag: archive.eTag,
        byteLength: archive.byteLength,
        metadata: { operation: scope.operationId, sourceSha256: archive.sourceSha256 },
      })
      .mockResolvedValueOnce(null);
    await expect(broker.removeArchive(archive)).resolves.toEqual({
      state: "absent",
      scope,
      key: archive.key,
      versionId: archive.versionId,
    });
    expect(objectStore.deleteObject).toHaveBeenCalledWith(
      { bucket: archive.bucket, key: archive.key, versionId: archive.versionId },
      expect.any(AbortSignal),
    );
    vi.mocked(objectStore.headObject).mockRejectedValueOnce({ code: "HTTP403", retryable: false });
    await expect(broker.removeArchive(archive)).resolves.toMatchObject({ state: "absent" });
    expect(objectStore.deleteObject).toHaveBeenCalledTimes(2);
  });

  it("rejects source receipt drift and reconciles timeout-after-delete only from exact absence", async () => {
    const { broker, objectStore } = setup();
    const upload = await broker.beginArchive({ scope });
    const archive = await broker.completeArchive({
      upload,
      parts: [{ partNumber: 1, eTag: '"etag"', checksumSha256: "b".repeat(64) }],
      byteLength: 3,
      sourceSha256: "a".repeat(64),
    });
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: archive.versionId,
      eTag: '"drift"',
      byteLength: archive.byteLength,
      metadata: { operation: scope.operationId },
    });
    await expect(broker.removeArchive(archive)).rejects.toBeInstanceOf(BuildBrokerConflictError);

    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: archive.versionId,
      eTag: archive.eTag,
      byteLength: archive.byteLength,
      metadata: { operation: scope.operationId },
    });
    vi.mocked(objectStore.deleteObject).mockRejectedValueOnce(new TypeError("response lost"));
    vi.mocked(objectStore.headObject).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(broker.removeArchive(archive)).resolves.toMatchObject({ state: "absent" });

    vi.mocked(objectStore.headObject).mockResolvedValue({
      versionId: archive.versionId,
      eTag: archive.eTag,
      byteLength: archive.byteLength,
      metadata: { operation: scope.operationId },
    });
    vi.mocked(objectStore.deleteObject).mockRejectedValueOnce(new TypeError("response lost"));
    await expect(broker.removeArchive(archive)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
  });
});

describe("fixed build sandbox lifecycle", () => {
  async function archived(broker: ReturnType<typeof createBuildBroker>) {
    const upload = await broker.beginArchive({ scope });
    return broker.completeArchive({
      upload,
      parts: [{ partNumber: 1, eTag: '"etag"', checksumSha256: "b".repeat(64) }],
      byteLength: 3,
      sourceSha256: "a".repeat(64),
    });
  }

  function observedState(
    inputFingerprint: `sha256:${string}`,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      buildId: BUILD_ID,
      projectName: "ohmyho-sandbox-vite",
      status: "IN_PROGRESS" as const,
      startTime: NOW,
      operationId: scope.operationId,
      inputFingerprint,
      usage: null,
      ...overrides,
    };
  }

  it("fingerprints the complete canonical build-start identity", async () => {
    const { broker } = setup();
    const archive = await archived(broker);
    const input = { scope, archive, ...buildIdentity };
    const fingerprint = await fingerprintBuildStartInput(input);
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await expect(
      fingerprintBuildStartInput({
        ...input,
        frameworkPlan: Object.fromEntries(
          Object.entries(buildIdentity.frameworkPlan).reverse(),
        ) as never,
      }),
    ).resolves.toBe(fingerprint);
    for (const archiveOverride of [
      { versionId: "different-version" },
      { eTag: '"different-etag"' },
      { byteLength: 4 },
      { sourceSha256: "e".repeat(64) },
    ]) {
      await expect(
        fingerprintBuildStartInput({
          ...input,
          archive: { ...archive, ...archiveOverride },
        }),
      ).resolves.not.toBe(fingerprint);
    }
  });

  it("keeps the core idempotency token and build id stable across leased reissues", async () => {
    const { broker, executor } = setup();
    const archive = await archived(broker);
    await broker.startBuild({ scope, archive, ...buildIdentity });
    await broker.startBuild({ scope, archive, ...buildIdentity });
    const commands = vi.mocked(executor.startBuild).mock.calls.map(([command]) => command);
    expect(commands.map((command) => command.idempotencyToken)).toEqual([
      `oh-${scope.operationId}-${buildIdentity.buildPlanSha256.slice(0, 32)}`,
      `oh-${scope.operationId}-${buildIdentity.buildPlanSha256.slice(0, 32)}`,
    ]);
    expect(commands.map((command) => command.buildId)).toEqual([BUILD_ID, BUILD_ID]);
    expect(commands[0]).toEqual(commands[1]);
  });

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.accepted)(
    "accepts canonical application root at the broker fingerprint boundary: $name",
    async ({ value }) => {
      const plan = parseNewProductionFrameworkPlan({
        ...buildIdentity.frameworkPlan,
        applicationRoot: value,
      });
      await expect(
        fingerprintBuildStartInput({
          scope,
          archive: {
            bucket: "ohmyho-sandbox-builds",
            key: operationPaths(scope).inputKey,
            versionId: "version-root-corpus",
            eTag: '"root-corpus"',
            byteLength: 3,
            scope,
            sourceSha256: "a".repeat(64),
          },
          deploymentId: buildIdentity.deploymentId,
          commitSha: buildIdentity.commitSha,
          buildPlanSha256: await planDigest(plan),
          frameworkPlan: plan,
        }),
      ).resolves.toMatch(/^sha256:[0-9a-f]{64}$/u);
    },
  );

  it.each(APPLICATION_ROOT_CONFORMANCE_CORPUS.rejected)(
    "rejects unsafe application root at the broker fingerprint boundary: $name",
    async ({ value }) => {
      await expect(
        fingerprintBuildStartInput({
          scope,
          archive: {
            bucket: "ohmyho-sandbox-builds",
            key: operationPaths(scope).inputKey,
            versionId: "version-root-corpus",
            eTag: '"root-corpus"',
            byteLength: 3,
            scope,
            sourceSha256: "a".repeat(64),
          },
          deploymentId: buildIdentity.deploymentId,
          commitSha: buildIdentity.commitSha,
          buildPlanSha256: buildIdentity.buildPlanSha256,
          frameworkPlan: { ...buildIdentity.frameworkPlan, applicationRoot: value } as never,
        }),
      ).rejects.toBeInstanceOf(BuildBrokerInputError);
    },
  );

  it("starts only the fixed build project with the exact versioned source and run outputs", async () => {
    const { broker, executor, objectStore } = setup();
    const object = await archived(broker);
    const receipt = await broker.startBuild({ scope, archive: object, ...buildIdentity });
    expect(receipt).toEqual({ buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite", scope });
    expect(executor.startBuild).toHaveBeenCalledWith(
      {
        buildProject: "ohmyho-sandbox-vite",
        buildId: BUILD_ID,
        idempotencyToken: `oh-${scope.operationId}-${buildIdentity.buildPlanSha256.slice(0, 32)}`,
        environment: [
          {
            name: "BUILD_INPUT_FINGERPRINT",
            value: await fingerprintBuildStartInput({ scope, archive: object, ...buildIdentity }),
          },
          { name: "BUILD_ID", value: BUILD_ID },
          { name: "EXPECTED_SOURCE_SHA256", value: object.sourceSha256 },
          { name: "BUILD_PLAN_SHA256", value: buildIdentity.buildPlanSha256 },
          { name: "APPLICATION_ROOT", value: "site" },
          { name: "INSTALL_COMMAND", value: "pnpm install --frozen-lockfile --ignore-scripts" },
          { name: "BUILD_COMMAND", value: "pnpm run build" },
          {
            name: "RUNTIME_POLICY_JSON",
            value: JSON.stringify(buildIdentity.frameworkPlan.runtimePolicy),
          },
          {
            name: "DATABASE_REQUIREMENT_JSON",
            value: JSON.stringify(buildIdentity.frameworkPlan.database),
          },
          {
            name: "AUTH_REQUIREMENT_JSON",
            value: JSON.stringify(buildIdentity.frameworkPlan.auth),
          },
          {
            name: "MAIL_REQUIREMENT_JSON",
            value: JSON.stringify(buildIdentity.frameworkPlan.mail),
          },
          {
            name: "STORAGE_REQUIREMENT_JSON",
            value: JSON.stringify(buildIdentity.frameworkPlan.storage),
          },
          { name: "FUNCTIONS_REQUIREMENT_JSON", value: "" },
          { name: "FRAMEWORK_ADAPTER", value: "vite-static" },
          { name: "FRAMEWORK_RUNTIME", value: "static" },
          { name: "BUILD_OUTPUT_DIRECTORY", value: "dist" },
          { name: "SERVER_OUTPUT_DIRECTORY", value: "" },
          { name: "SERVER_ENTRYPOINT", value: "" },
          { name: "SERVER_CONFIG_PATH", value: "" },
          { name: "COMPATIBILITY_DATE", value: "" },
          { name: "COMPATIBILITY_FLAGS", value: "" },
          { name: "SOURCE_COMMIT_SHA", value: buildIdentity.commitSha },
          { name: "PROJECT_ID", value: scope.projectId },
          { name: "ENVIRONMENT_ID", value: scope.environmentId },
          { name: "DEPLOYMENT_ID", value: buildIdentity.deploymentId },
          { name: "OPERATION_ID", value: scope.operationId },
        ],
        source: {
          bucket: "ohmyho-sandbox-builds",
          key: operationPaths(scope).inputKey,
          versionId: object.versionId,
          sha256: object.sourceSha256,
          byteLength: object.byteLength,
        },
        outputs: {
          bundleKey: operationPaths(scope).bundleKey,
          failureKey: operationPaths(scope).failureKey,
          logKey: operationPaths(scope).logKey,
        },
      },
      expect.any(AbortSignal),
    );
    const environmentNames = vi
      .mocked(executor.startBuild)
      .mock.calls[0]?.[0].environment.map(({ name }) => name);
    expect(
      environmentNames?.filter(
        (name) =>
          name.startsWith("CODEBUILD_") || name.endsWith("_URL") || /TOKEN|SECRET/u.test(name),
      ),
    ).toEqual([]);
    const callsBeforeStart = vi.mocked(objectStore.headObject).mock.calls.length;
    await broker.startBuild({ scope, archive: object, ...buildIdentity });
    expect(objectStore.headObject).toHaveBeenCalledTimes(callsBeforeStart);
  });

  it("does not persist a start receipt bound to another project or build id", async () => {
    const { broker, executor } = setup();
    const object = await archived(broker);
    vi.mocked(executor.startBuild).mockResolvedValueOnce({
      buildId: "other-project:01J00000000000000000000003",
      projectName: "other-project",
    });

    await expect(
      broker.startBuild({ scope, archive: object, ...buildIdentity }),
    ).rejects.toBeInstanceOf(BuildBrokerUncertainError);

    vi.mocked(executor.startBuild).mockResolvedValueOnce({
      buildId: "ohmyho-sandbox-vite:01J00000000000000000000004",
      projectName: "ohmyho-sandbox-vite",
    });
    await expect(
      broker.startBuild({ scope, archive: object, ...buildIdentity }),
    ).rejects.toBeInstanceOf(BuildBrokerUncertainError);
  });

  it.each([
    ["bun install --frozen-lockfile --ignore-scripts", "bun run build"],
    ["npm ci --ignore-scripts", "npm run build"],
    ["pnpm install --frozen-lockfile --ignore-scripts", "pnpm run build"],
    ["yarn install --immutable --mode=skip-build", "yarn run build"],
  ])(
    "passes the exact allowlisted command pair to the build sandbox",
    async (installCommand, buildCommand) => {
      const { broker, executor } = setup();
      const object = await archived(broker);
      const frameworkPlan = parseNewProductionFrameworkPlan({
        ...buildIdentity.frameworkPlan,
        installCommand,
        buildCommand,
      });
      await broker.startBuild({
        scope,
        archive: object,
        deploymentId: buildIdentity.deploymentId,
        commitSha: buildIdentity.commitSha,
        buildPlanSha256: await planDigest(frameworkPlan),
        frameworkPlan,
      });
      expect(executor.startBuild).toHaveBeenLastCalledWith(
        expect.objectContaining({
          environment: expect.arrayContaining([
            { name: "INSTALL_COMMAND", value: installCommand },
            { name: "BUILD_COMMAND", value: buildCommand },
          ]),
        }),
        expect.any(AbortSignal),
      );
    },
  );

  it("reissues the same idempotency token after a lost start response", async () => {
    const { broker, executor } = setup();
    const archive = await archived(broker);
    vi.mocked(executor.startBuild)
      .mockRejectedValueOnce(new TypeError("start response lost"))
      .mockResolvedValueOnce({ buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite" });

    await expect(broker.startBuild({ scope, archive, ...buildIdentity })).rejects.toBeInstanceOf(
      BuildBrokerUncertainError,
    );
    await expect(broker.startBuild({ scope, archive, ...buildIdentity })).resolves.toEqual({
      buildId: BUILD_ID,
      projectName: "ohmyho-sandbox-vite",
      scope,
    });
    expect(
      vi.mocked(executor.startBuild).mock.calls.map(([command]) => command.idempotencyToken),
    ).toEqual([
      `oh-${scope.operationId}-${buildIdentity.buildPlanSha256.slice(0, 32)}`,
      `oh-${scope.operationId}-${buildIdentity.buildPlanSha256.slice(0, 32)}`,
    ]);
  });

  it("recovers the deterministic build by direct lookup after the start response is lost", async () => {
    const { broker, executor } = setup();
    const archive = await archived(broker);
    const input = { scope, archive, ...buildIdentity };
    const fingerprint = await fingerprintBuildStartInput(input);
    vi.mocked(executor.startBuild).mockRejectedValueOnce(new TypeError("response lost"));
    await expect(broker.startBuild(input)).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([observedState(fingerprint)]);
    await expect(broker.observeBuildStart(input, NOW)).resolves.toEqual({
      state: "found",
      receipt: { buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite", scope },
    });
    expect(executor.batchGetBuilds).toHaveBeenCalledTimes(1);
    expect(executor.batchGetBuilds).toHaveBeenCalledWith(
      { buildIds: [BUILD_ID], bucket: "ohmyho-sandbox-builds" },
      expect.any(AbortSignal),
    );
  });

  it("keeps a same-token parameter-mismatch signal safe and recoverable", async () => {
    const { broker, executor } = setup();
    const archive = await archived(broker);
    const input = { scope, archive, ...buildIdentity };
    const fingerprint = await fingerprintBuildStartInput(input);
    vi.mocked(executor.startBuild).mockRejectedValueOnce({
      code: "StartParameterMismatch",
      message: "idempotency token parameter mismatch https://secret.invalid/capability",
    });
    const start = broker.startBuild(input);
    await expect(start).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    await expect(start).rejects.not.toThrow(/secret\.invalid|parameter mismatch/u);

    vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
      observedState(fingerprint, { status: "SUCCEEDED" }),
    ]);
    await expect(broker.observeBuildStart(input, NOW)).resolves.toMatchObject({
      state: "found",
      receipt: { buildId: BUILD_ID },
    });
  });

  it("returns absent only when the executor answers without the deterministic build", async () => {
    const { broker, executor } = setup();
    const archive = await archived(broker);
    const input = { scope, archive, ...buildIdentity };
    vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([]);
    await expect(broker.observeBuildStart(input, NOW)).resolves.toEqual({ state: "absent" });
    expect(executor.startBuild).not.toHaveBeenCalled();
  });

  it("reports a conflict when the operation's build was started with another input", async () => {
    const { broker, executor } = setup();
    const archive = await archived(broker);
    const input = { scope, archive, ...buildIdentity };
    vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
      observedState(`sha256:${"b".repeat(64)}`),
    ]);
    await expect(broker.observeBuildStart(input, NOW)).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("rejects an observation without a valid reservation time", async () => {
    const { broker, executor } = setup();
    const archive = await archived(broker);
    const input = { scope, archive, ...buildIdentity };
    for (const reservationCreatedAt of [new Date(Number.NaN), "2026-08-19T12:00:00.000Z"]) {
      await expect(
        broker.observeBuildStart(input, reservationCreatedAt as never),
      ).rejects.toBeInstanceOf(BuildBrokerInputError);
    }
    expect(executor.batchGetBuilds).not.toHaveBeenCalled();
  });

  it("returns unknown for missing or malformed broker identity metadata", async () => {
    for (const overrides of [
      { operationId: undefined },
      { inputFingerprint: undefined },
      { operationId: "not-an-operation" },
      { inputFingerprint: "not-a-fingerprint" },
      { operationId: "01J00000000000000000000004" },
      { projectName: "other-project" },
      { buildId: "ohmyho-sandbox-vite:01J00000000000000000000004" },
    ]) {
      const { broker, executor } = setup();
      const archive = await archived(broker);
      const input = { scope, archive, ...buildIdentity };
      const fingerprint = await fingerprintBuildStartInput(input);
      vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
        observedState(fingerprint, overrides),
      ]);

      await expect(broker.observeBuildStart(input, NOW)).resolves.toEqual({ state: "unknown" });
    }
  });

  it("returns unknown for a start time outside the reservation window", async () => {
    for (const startTime of [
      new Date(NOW.getTime() + 5 * 60_000 + 1),
      new Date(NOW.getTime() - 5 * 60_000 - 1),
    ]) {
      const { broker, executor } = setup();
      const archive = await archived(broker);
      const input = { scope, archive, ...buildIdentity };
      const fingerprint = await fingerprintBuildStartInput(input);
      vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
        observedState(fingerprint, { startTime }),
      ]);

      await expect(broker.observeBuildStart(input, NOW)).resolves.toEqual({ state: "unknown" });
    }
  });

  it("returns unknown, never absence, for duplicate, malformed and failed lookups", async () => {
    const cases = [
      (executor: BuildExecutor, fingerprint: `sha256:${string}`) => {
        vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
          observedState(fingerprint),
          observedState(fingerprint),
        ]);
      },
      (executor: BuildExecutor) => {
        vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce(null as never);
      },
      (executor: BuildExecutor, fingerprint: `sha256:${string}`) => {
        vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
          observedState(fingerprint, { startTime: "secret-url" }) as never,
        ]);
      },
      (executor: BuildExecutor, fingerprint: `sha256:${string}`) => {
        vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
          observedState(fingerprint, { status: "QUEUED" }) as never,
        ]);
      },
      (executor: BuildExecutor, fingerprint: `sha256:${string}`) => {
        vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
          { ...observedState(fingerprint), arn: "unexpected" } as never,
        ]);
      },
      (executor: BuildExecutor) => {
        vi.mocked(executor.batchGetBuilds).mockRejectedValue(new TypeError("network"));
      },
    ];
    for (const arrange of cases) {
      const { broker, executor } = setup();
      const archive = await archived(broker);
      const input = { scope, archive, ...buildIdentity };
      arrange(executor, await fingerprintBuildStartInput(input));
      await expect(broker.observeBuildStart(input, NOW)).resolves.toEqual({ state: "unknown" });
    }
  });

  it("binds the exact validated TanStack edge outputs into the fixed build", async () => {
    const { broker, executor } = setup();
    const object = await archived(broker);
    const frameworkPlan = parseNewProductionFrameworkPlan({
      schemaVersion: "ohmyhost.framework-plan/v5" as const,
      applicationRoot: "site",
      adapter: "tanstack-start" as const,
      runtime: "edge" as const,
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: "dist/client" as const,
      serverOutputDirectory: "dist/server" as const,
      serverEntryPoint: "dist/server/index.js" as const,
      serverConfigPath: "dist/server/wrangler.json" as const,
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"] as const,
      runtimePolicy: buildIdentity.frameworkPlan.runtimePolicy,
      database: buildIdentity.frameworkPlan.database,
      auth: buildIdentity.frameworkPlan.auth,
      mail: buildIdentity.frameworkPlan.mail,
      storage: buildIdentity.frameworkPlan.storage,
    });
    await broker.startBuild({
      scope,
      archive: object,
      ...buildIdentity,
      buildPlanSha256: await planDigest(frameworkPlan),
      frameworkPlan,
    });

    expect(executor.startBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.arrayContaining([
          { name: "FRAMEWORK_ADAPTER", value: "tanstack-start" },
          { name: "FRAMEWORK_RUNTIME", value: "edge" },
          { name: "BUILD_OUTPUT_DIRECTORY", value: "dist/client" },
          { name: "SERVER_OUTPUT_DIRECTORY", value: "dist/server" },
          { name: "SERVER_ENTRYPOINT", value: "dist/server/index.js" },
          {
            name: "SERVER_CONFIG_PATH",
            value: "dist/server/wrangler.json",
          },
          { name: "COMPATIBILITY_DATE", value: "2026-08-21" },
          { name: "COMPATIBILITY_FLAGS", value: "nodejs_compat" },
          {
            name: "STORAGE_REQUIREMENT_JSON",
            value: JSON.stringify(frameworkPlan.storage),
          },
        ]),
      }),
      expect.any(AbortSignal),
    );
  });

  it("binds the fixed credential-free Vite companion build contract", async () => {
    const { broker, executor } = setup();
    const object = await archived(broker);
    const frameworkPlan = parseNewProductionFrameworkPlan({
      schemaVersion: "ohmyhost.framework-plan/v5" as const,
      applicationRoot: "site",
      adapter: "vite-static" as const,
      runtime: "edge" as const,
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: "dist" as const,
      serverOutputDirectory: ".ohmyhost/vite-companion" as const,
      serverEntryPoint: ".ohmyhost/vite-companion/worker.js" as const,
      serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc" as const,
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"] as const,
      runtimePolicy: buildIdentity.frameworkPlan.runtimePolicy,
      database: { enabled: true, migrations: "migrations" },
      auth: {
        provider: "better-auth",
        version: "1.7.7",
        deployment: "companion",
        routePath: "/api/auth",
        databaseSchema: "auth",
        databaseBindingName: "OHMYHOST_DATABASE",
        authSecretName: "BETTER_AUTH_SECRET",
      },
      mail: { enabled: true },
      storage: { enabled: true, provider: "r2", jurisdiction: "eu", public: false },
      functions: { crons: ["*/5 * * * *"] },
    });
    if (frameworkPlan.adapter !== "vite-static" || frameworkPlan.runtime !== "edge")
      throw new Error("expected Vite companion fixture");

    await broker.startBuild({
      scope,
      archive: object,
      ...buildIdentity,
      buildPlanSha256: await planDigest(frameworkPlan),
      frameworkPlan,
    });

    expect(executor.startBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.arrayContaining([
          { name: "FRAMEWORK_ADAPTER", value: "vite-static" },
          { name: "FRAMEWORK_RUNTIME", value: "edge" },
          { name: "BUILD_OUTPUT_DIRECTORY", value: "dist" },
          {
            name: "SERVER_OUTPUT_DIRECTORY",
            value: ".ohmyhost/vite-companion",
          },
          {
            name: "SERVER_ENTRYPOINT",
            value: ".ohmyhost/vite-companion/worker.js",
          },
          { name: "COMPATIBILITY_DATE", value: "2025-01-01" },
          {
            name: "FUNCTIONS_REQUIREMENT_JSON",
            value: '{"crons":["*/5 * * * *"]}',
          },
        ]),
      }),
      expect.any(AbortSignal),
    );
  });

  it("binds the exact validated Next.js adapter and credential-free Wrangler outputs", async () => {
    const { broker, executor } = setup();
    const object = await archived(broker);
    const frameworkPlan = parseNewProductionFrameworkPlan({
      schemaVersion: "ohmyhost.framework-plan/v5" as const,
      applicationRoot: "site",
      adapter: "nextjs" as const,
      runtime: "edge" as const,
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: ".open-next/assets" as const,
      serverOutputDirectory: ".ohmyhost-worker" as const,
      serverEntryPoint: ".ohmyhost-worker/worker.js" as const,
      serverConfigPath: "wrangler.jsonc" as const,
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"] as const,
      nextRevalidatePath: true,
      runtimePolicy: buildIdentity.frameworkPlan.runtimePolicy,
      database: buildIdentity.frameworkPlan.database,
      auth: buildIdentity.frameworkPlan.auth,
      mail: buildIdentity.frameworkPlan.mail,
      storage: {
        enabled: true,
        provider: "r2",
        jurisdiction: "eu",
        public: false,
      },
    });

    await broker.startBuild({
      scope,
      archive: object,
      ...buildIdentity,
      buildPlanSha256: await planDigest(frameworkPlan),
      frameworkPlan,
    });

    expect(executor.startBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        environment: expect.arrayContaining([
          { name: "FRAMEWORK_ADAPTER", value: "nextjs" },
          { name: "FRAMEWORK_RUNTIME", value: "edge" },
          { name: "SSG_CACHE_MAX_BYTES", value: "33554432" },
          { name: "NEXT_REVALIDATE_PATH", value: "1" },
          { name: "BUILD_OUTPUT_DIRECTORY", value: ".open-next/assets" },
          { name: "SERVER_OUTPUT_DIRECTORY", value: ".ohmyhost-worker" },
          {
            name: "SERVER_ENTRYPOINT",
            value: ".ohmyhost-worker/worker.js",
          },
          { name: "SERVER_CONFIG_PATH", value: "wrangler.jsonc" },
          { name: "COMPATIBILITY_DATE", value: "2026-08-21" },
          { name: "COMPATIBILITY_FLAGS", value: "nodejs_compat" },
        ]),
      }),
      expect.any(AbortSignal),
    );
  });

  it("rejects every caller override and cross-run archive", async () => {
    const { broker } = setup();
    const object = await archived(broker);
    for (const field of [
      "projectName",
      "buildspec",
      "image",
      "serviceRole",
      "privilegedMode",
      "cache",
      "artifacts",
      "debugSessionEnabled",
      "timeoutInMinutes",
    ]) {
      await expect(
        broker.startBuild({ scope, archive: object, ...buildIdentity, [field]: "attacker" }),
      ).rejects.toBeInstanceOf(BuildBrokerInputError);
    }
    await expect(
      broker.startBuild({
        scope: { ...scope, operationId: "01J00000000000000000000004" },
        archive: object,
        ...buildIdentity,
      }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
  });

  it("returns uncertain after a lost start response without looking the build up itself", async () => {
    const { broker, executor } = setup();
    const object = await archived(broker);
    vi.mocked(executor.startBuild).mockRejectedValueOnce(new TypeError("timeout"));
    await expect(
      broker.startBuild({ scope, archive: object, ...buildIdentity }),
    ).rejects.toBeInstanceOf(BuildBrokerUncertainError);
    expect(executor.batchGetBuilds).not.toHaveBeenCalled();
  });

  it("reads only the known receipt build id and rejects conflicting metadata", async () => {
    const { broker, executor } = setup();
    vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([
      {
        buildId: BUILD_ID,
        projectName: "other-project",
        status: "SUCCEEDED",
        usage: null,
        startTime: NOW,
        operationId: scope.operationId,
        inputFingerprint: `sha256:${"a".repeat(64)}`,
      },
    ]);
    await expect(
      broker.readBuild({ buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite", scope }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(executor.batchGetBuilds).toHaveBeenCalledWith(
      { buildIds: [BUILD_ID], bucket: "ohmyho-sandbox-builds" },
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid commit and build-plan digests", async () => {
    const { broker, executor } = setup();
    const object = await archived(broker);
    await expect(
      broker.startBuild({ scope, archive: object, ...buildIdentity, commitSha: "C".repeat(40) }),
    ).rejects.toBeInstanceOf(BuildBrokerInputError);
    await expect(
      broker.startBuild({ scope, archive: object, ...buildIdentity, buildPlanSha256: "short" }),
    ).rejects.toBeInstanceOf(BuildBrokerInputError);
    await expect(
      broker.startBuild({
        scope,
        archive: object,
        ...buildIdentity,
        buildPlanSha256: "d".repeat(64),
      }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(
      broker.startBuild({
        scope,
        archive: object,
        ...buildIdentity,
        frameworkPlan: { ...buildIdentity.frameworkPlan, adapter: "unknown" as never },
      }),
    ).rejects.toBeInstanceOf(BuildBrokerInputError);
    await expect(
      broker.startBuild({
        scope,
        archive: object,
        ...buildIdentity,
        frameworkPlan: {
          adapter: "vite-static",
          runtime: "static",
          installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
          buildCommand: "pnpm run build",
          outputDirectory: "dist",
        } as never,
      }),
    ).rejects.toBeInstanceOf(BuildBrokerInputError);
    expect(executor.startBuild).not.toHaveBeenCalled();
  });

  it("reads the runtime's customer-safe excerpt of a failed build", async () => {
    const { broker, executor, objectStore } = setup();
    const receipt = { buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite", scope } as const;
    const failed = {
      buildId: BUILD_ID,
      projectName: "ohmyho-sandbox-vite",
      status: "FAILED" as const,
      usage: null,
      startTime: NOW,
      operationId: scope.operationId,
      inputFingerprint: `sha256:${"a".repeat(64)}`,
    };
    const uploaded = (value: unknown) => {
      const body = new TextEncoder().encode(JSON.stringify(value));
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "failure-version",
        eTag: '"failure-etag"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: "b".repeat(64) });
    };
    const excerpt = {
      schemaVersion: "ohmyhost.build-failure/v1",
      operationId: scope.operationId,
      excerpt: "src/main.ts(3,1): error TS2304: Cannot find name 'foo'.\nELIFECYCLE Command failed",
      truncated: true,
      logBytes: 70000,
    };
    vi.mocked(executor.batchGetBuilds).mockResolvedValue([failed]);

    uploaded(excerpt);
    await expect(broker.readBuild(receipt)).resolves.toEqual({
      ...receipt,
      status: "failed",
      usage: null,
      failure: { excerpt: excerpt.excerpt, truncated: true },
    });
    expect(objectStore.headObject).toHaveBeenCalledWith(
      {
        bucket: "ohmyho-sandbox-builds",
        key: operationPaths(scope).failureKey,
      },
      expect.any(AbortSignal),
    );
    expect(objectStore.readObject).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "failure-version", maximumBytes: 81920 }),
      expect.any(AbortSignal),
    );

    await expect(broker.readBuild(receipt)).resolves.toMatchObject({
      status: "failed",
      failure: null,
    });
    for (const foreign of [
      { ...excerpt, operationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      { ...excerpt, schemaVersion: "ohmyhost.build-failure/v2" },
      { ...excerpt, excerpt: "" },
      { ...excerpt, excerpt: "\u001b[31mred\u001b[0m" },
      { ...excerpt, excerpt: "x".repeat(16385) },
      { ...excerpt, excerpt: "trailing  " },
      { ...excerpt, credential: "must-not-leak" },
    ]) {
      uploaded(foreign);
      await expect(broker.readBuild(receipt)).resolves.toMatchObject({ failure: null });
    }
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "failure-version",
      eTag: '"failure-etag"',
      byteLength: 81921,
      metadata: {},
    });
    await expect(broker.readBuild(receipt)).resolves.toMatchObject({ failure: null });
    expect(objectStore.readObject).toHaveBeenCalledTimes(8);
    vi.mocked(executor.batchGetBuilds).mockResolvedValue([{ ...failed, status: "IN_PROGRESS" }]);
    await expect(broker.readBuild(receipt)).resolves.toMatchObject({
      status: "running",
      failure: null,
    });
    expect(objectStore.headObject).toHaveBeenCalledTimes(10);
  });

  it("reads and stops the fixed build idempotently", async () => {
    const { broker, executor, objectStore } = setup();
    const receipt = { buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite", scope } as const;
    vi.mocked(executor.batchGetBuilds).mockResolvedValue([
      {
        buildId: BUILD_ID,
        projectName: "ohmyho-sandbox-vite",
        status: "SUCCEEDED",
        usage: null,
        startTime: NOW,
        operationId: scope.operationId,
        inputFingerprint: `sha256:${"a".repeat(64)}`,
      },
    ]);
    await expect(broker.readBuild(receipt)).resolves.toMatchObject({ status: "succeeded" });
    await expect(broker.stopBuild(receipt)).resolves.toBeUndefined();
    expect(executor.stopBuild).toHaveBeenCalledWith(
      { buildId: BUILD_ID, bucket: "ohmyho-sandbox-builds" },
      expect.any(AbortSignal),
    );
    vi.mocked(executor.stopBuild).mockRejectedValueOnce({ code: "BuildNotRunning" });
    await expect(broker.stopBuild(receipt)).resolves.toBeUndefined();
    expect(objectStore.headObject).not.toHaveBeenCalled();
  });

  it("reconciles a lost stop response only from an observed stopped build", async () => {
    const { broker, executor } = setup();
    const receipt = { buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite", scope } as const;
    const state = {
      buildId: BUILD_ID,
      projectName: "ohmyho-sandbox-vite",
      usage: null,
      startTime: NOW,
      operationId: scope.operationId,
      inputFingerprint: `sha256:${"a".repeat(64)}` as const,
    };
    vi.mocked(executor.stopBuild).mockRejectedValueOnce(new TypeError("response lost"));
    vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([{ ...state, status: "STOPPED" }]);
    await expect(broker.stopBuild(receipt)).resolves.toBeUndefined();

    vi.mocked(executor.stopBuild).mockRejectedValueOnce(new TypeError("response lost"));
    vi.mocked(executor.batchGetBuilds).mockResolvedValueOnce([{ ...state, status: "IN_PROGRESS" }]);
    await expect(broker.stopBuild(receipt)).rejects.toBeInstanceOf(BuildBrokerUncertainError);

    vi.mocked(executor.stopBuild).mockResolvedValueOnce({
      buildId: "ohmyho-sandbox-vite:01J00000000000000000000004",
      status: "STOPPED",
    });
    await expect(broker.stopBuild(receipt)).rejects.toBeInstanceOf(BuildBrokerConflictError);
  });

  it("rejects a receipt whose build id is not the operation's deterministic id before any call", async () => {
    const { broker, executor } = setup();
    const foreign = {
      buildId: "ohmyho-sandbox-vite:01J00000000000000000000004",
      projectName: "ohmyho-sandbox-vite",
      scope,
    } as const;
    await expect(broker.readBuild(foreign)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(broker.stopBuild(foreign)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    expect(executor.batchGetBuilds).not.toHaveBeenCalled();
    expect(executor.stopBuild).not.toHaveBeenCalled();
  });
});

describe("verified build artifact lifecycle", () => {
  const expectation = (
    receipt = { buildId: BUILD_ID, projectName: "ohmyho-sandbox-vite", scope },
    frameworkPlan = buildIdentity.frameworkPlan,
  ) => ({
    receipt,
    deploymentId: buildIdentity.deploymentId,
    commitSha: buildIdentity.commitSha,
    sourceSha256: "a".repeat(64),
    buildPlanSha256: buildIdentity.buildPlanSha256,
    frameworkPlan,
  });

  it("re-reads a plan-authorized mutable Next cache only from its verified artifact", async () => {
    const writablePlan = parseNewProductionFrameworkPlan({
      ...legacyNextPlan,
      nextRevalidatePath: true,
    });
    for (const { plan, enabled } of [
      { plan: writablePlan, enabled: true },
      { plan: legacyNextPlan, enabled: false },
    ]) {
      const body = await buildEdgeBundle(
        {
          entryWrapperVersion: "nextjs-opennext-wrapper-v1",
          ...(enabled ? { nextRevalidatePath: true } : {}),
        },
        undefined,
        undefined,
        undefined,
        plan,
      );
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-next-cache",
        eTag: '"next-cache"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      const artifact = await broker.readBuildArtifact({
        ...expectation(undefined, plan),
        buildPlanSha256: await planDigest(plan),
      });
      expect(artifact.runtime?.nextRevalidatePath).toBe(enabled ? true : undefined);
      await expect(
        parseVerifiedArtifactBundle({ body, expectedProvenance: artifact.provenance }),
      ).resolves.toEqual(artifact);

      // Updating the stored-object hash cannot authorize either flag change under the original artifact digest.
      const altered = await buildEdgeBundle(
        {
          entryWrapperVersion: "nextjs-opennext-wrapper-v1",
          ...(!enabled ? { nextRevalidatePath: true } : {}),
        },
        undefined,
        undefined,
        undefined,
        plan,
      );
      await expect(
        parseVerifiedArtifactBundle({
          body: altered,
          expectedProvenance: {
            ...artifact.provenance,
            output: {
              ...artifact.provenance.output,
              byteLength: altered.byteLength,
              sha256: await hex(altered),
            },
          },
        }),
      ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    }
  });

  it("hashes exact owned byte views and streams bounded views through native codecs", async () => {
    const main = deterministicNoise(192 * 1024 + 7);
    const compressed = await buildEdgeBundle(
      { entryWrapperVersion: "nextjs-opennext-wrapper-v1" },
      main,
      undefined,
      undefined,
      legacyNextPlan,
      undefined,
      undefined,
      [{ path: "data/empty.json", body: new Uint8Array() }],
    );
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-stream",
      eTag: '"stream"',
      byteLength: compressed.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({
      body: compressed,
      sha256: await hex(compressed),
    });
    const expected = await broker.readBuildArtifact({
      ...expectation(undefined, legacyNextPlan),
      buildPlanSha256: await planDigest(legacyNextPlan),
    });
    const padded = new Uint8Array(compressed.byteLength + 34).fill(0xa5);
    padded.set(compressed, 17);
    const body = padded.subarray(17, 17 + compressed.byteLength);
    const decompressedInputs: Uint8Array[] = [];
    const compressedInputs: Uint8Array[] = [];
    const digestInputs: BufferSource[] = [];
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, input) => {
      digestInputs.push(input);
      return nativeDigest(algorithm, input);
    });
    vi.stubGlobal(
      "DecompressionStream",
      observeStreamInput(DecompressionStream, decompressedInputs),
    );
    vi.stubGlobal("CompressionStream", observeStreamInput(CompressionStream, compressedInputs));
    try {
      const actual = await parseVerifiedArtifactBundle({
        body,
        expectedProvenance: expected.provenance,
      });
      expect(actual).toEqual(expected);
      const mainModule = actual.modules.find(({ path }) => path === "index.js");
      if (mainModule === undefined) throw new Error("stream fixture has no main module");
      for (const [inputs, source] of [
        [decompressedInputs, body],
        [compressedInputs, mainModule.body],
      ] as const) {
        expect(inputs.length).toBeGreaterThan(1);
        let offset = source.byteOffset;
        for (const chunk of inputs) {
          expect(chunk.buffer === source.buffer).toBe(true);
          expect(chunk.byteOffset).toBe(offset);
          expect(chunk.byteLength).toBeGreaterThan(0);
          expect(chunk.byteLength).toBeLessThanOrEqual(64 * 1024);
          offset += chunk.byteLength;
        }
        expect(offset).toBe(source.byteOffset + source.byteLength);
      }
      expect(digestInputs[0] === body).toBe(true);
      for (const file of [...actual.files, ...actual.modules]) {
        expect(digestInputs.some((input) => input === file.body)).toBe(true);
      }
      expect(padded.subarray(0, 17)).toEqual(new Uint8Array(17).fill(0xa5));
      expect(padded.subarray(padded.length - 17)).toEqual(new Uint8Array(17).fill(0xa5));
    } finally {
      digest.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("snapshots a shared bundle once before hashing and native decompression", async () => {
    const compressed = await buildBundle();
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-shared",
      eTag: '"shared"',
      byteLength: compressed.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({
      body: compressed,
      sha256: await hex(compressed),
    });
    const expected = await broker.readBuildArtifact(expectation());
    const shared = new Uint8Array(new SharedArrayBuffer(compressed.byteLength + 18)).fill(0xa5);
    shared.set(compressed, 9);
    const body = shared.subarray(9, 9 + compressed.byteLength);
    const inputs: Uint8Array[] = [];
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    let snapshot: BufferSource | undefined;
    const digest = vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, input) => {
      const result = nativeDigest(algorithm, input);
      if (snapshot === undefined) {
        snapshot = input;
        // Shared memory can change independently after the verification snapshot is taken.
        body.fill(0);
      }
      return result;
    });
    vi.stubGlobal("DecompressionStream", observeStreamInput(DecompressionStream, inputs));
    try {
      await expect(
        parseVerifiedArtifactBundle({ body, expectedProvenance: expected.provenance }),
      ).resolves.toEqual(expected);
      expect(snapshot).toBeInstanceOf(Uint8Array);
      expect((snapshot as Uint8Array).buffer).toBeInstanceOf(ArrayBuffer);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.buffer === (snapshot as Uint8Array).buffer).toBe(true);
      expect(inputs[0]).toEqual(compressed);
    } finally {
      digest.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("rejects correctly hashed malformed, truncated, and oversized gzip streams", async () => {
    const compressed = await buildBundle();
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-invalid-stream",
      eTag: '"invalid-stream"',
      byteLength: compressed.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({
      body: compressed,
      sha256: await hex(compressed),
    });
    const expected = await broker.readBuildArtifact(expectation());
    const cases = [
      encoder.encode("not a gzip stream"),
      compressed.subarray(0, compressed.byteLength - 8),
      await gzip(new Uint8Array(30 * 1024 * 1024 + 1)),
    ];
    for (const body of cases) {
      await expect(
        parseVerifiedArtifactBundle({
          body,
          expectedProvenance: {
            ...expected.provenance,
            output: {
              ...expected.provenance.output,
              byteLength: body.byteLength,
              sha256: await hex(body),
            },
          },
        }),
      ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    }
  });

  it("reads only the exact versioned output and returns a credential-free verified bundle", async () => {
    const { broker, objectStore } = setup();
    const body = await buildBundle({}, [{ path: "assets/", body: new Uint8Array(), type: 53 }]);
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-1",
      eTag: '"output"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
    const artifact = await broker.readBuildArtifact(expectation());
    expect(artifact).toMatchObject({
      provenance: {
        scope,
        deploymentId: buildIdentity.deploymentId,
        buildId: BUILD_ID,
        output: { versionId: "output-version-1" },
      },
      files: [{ path: "/index.html" }],
    });
    expect(objectStore.readObject).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "output-version-1", maximumBytes: 30 * 1024 * 1024 }),
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(artifact)).not.toMatch(/signature|secret/u);

    await expect(
      parseVerifiedArtifactBundle({ body, expectedProvenance: artifact.provenance }),
    ).resolves.toEqual(artifact);
    await expect(
      parseVerifiedArtifactBundle({
        body,
        expectedProvenance: {
          ...artifact.provenance,
          runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [42] } as never,
        },
      }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    const invalidPolicyBody = await buildBundle({
      runtimePolicy: { healthCheckPath: "/", egressAllowedOrigins: [42] },
    });
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-1",
      eTag: '"output"',
      byteLength: invalidPolicyBody.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({
      body: invalidPolicyBody,
      sha256: await hex(invalidPolicyBody),
    });
    await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("independently validates and returns exact source-bound migration bytes", async () => {
    const frameworkPlan = parseNewProductionFrameworkPlan({
      ...buildIdentity.frameworkPlan,
      database: { enabled: true, migrations: "supabase/migrations" },
    });
    const buildPlanSha256 = await planDigest(frameworkPlan);
    const migration = encoder.encode("create table source_bound(id bigint);\n");
    const body = await buildBundle(
      { buildPlanDigest: `sha256:${buildPlanSha256}` },
      [{ path: "migrations/20260821090000_source_bound.sql", body: migration }],
      frameworkPlan,
    );
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "migration-version",
      eTag: '"migration"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });

    const artifact = await broker.readBuildArtifact({
      ...expectation(undefined, frameworkPlan),
      buildPlanSha256,
    });

    expect(artifact.migrations).toEqual([
      {
        path: "20260821090000_source_bound.sql",
        digest: `sha256:${await hex(migration)}`,
        size: migration.byteLength,
        body: migration,
      },
    ]);
    await expect(
      parseVerifiedArtifactBundle({ body, expectedProvenance: artifact.provenance }),
    ).resolves.toEqual(artifact);
  });

  it.each([
    { applicationRoot: "." },
    { frameworkPlanSchemaVersion: "ohmyhost.framework-plan/v1" },
    { schemaVersion: "ohmyhost.artifact/v1" },
    { schemaVersion: "ohmyhost.artifact/v2" },
  ])("rejects v5 artifact plan evidence mismatch %#", async (override) => {
    const { broker, objectStore } = setup();
    const body = await buildBundle(override);
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "mismatch-version",
      eTag: '"mismatch"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
    await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("rejects the superseded customer-facing Hyperdrive auth binding in build output", async () => {
    const { broker, objectStore } = setup();
    const body = await buildBundle({
      auth: {
        provider: "better-auth",
        version: "1.7.7",
        deployment: "embedded",
        routePath: "/api/auth",
        databaseSchema: "auth",
        databaseBindingName: "HYPERDRIVE",
        authSecretName: "BETTER_AUTH_SECRET",
      },
    });
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "legacy-binding-version",
      eTag: '"legacy-binding"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });

    await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("validates and returns the complete executable edge module inventory", async () => {
    const { broker, objectStore } = setup();
    const body = await buildEdgeBundle(
      undefined,
      undefined,
      undefined,
      undefined,
      tanStackEdgePlan,
    );
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-edge",
      eTag: '"edge"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });

    const artifact = await broker.readBuildArtifact({
      ...expectation(undefined, tanStackEdgePlan),
      buildPlanSha256: await planDigest(tanStackEdgePlan),
    });

    expect(artifact).toMatchObject({
      runtime: {
        kind: "cloudflare-worker",
        mainModule: "index.js",
        compatibilityFlags: ["nodejs_compat"],
      },
      files: [{ path: "/assets/client.js" }],
      modules: [{ path: "assets/chunk.js" }, { path: "index.js" }],
    });
    await expect(
      parseVerifiedArtifactBundle({ body, expectedProvenance: artifact.provenance }),
    ).resolves.toEqual(artifact);
  });

  it("accepts the canonical Next.js wrapper and its larger bundled Worker", async () => {
    const { broker, objectStore } = setup();
    const main = new Uint8Array(6 * 1024 * 1024).fill(97);
    const body = await buildEdgeBundle(
      {
        compatibilityDate: "2024-09-23",
        entryWrapperVersion: "nextjs-opennext-wrapper-v1",
      },
      main,
      undefined,
      undefined,
      legacyNextPlan,
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    );
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-next",
      eTag: '"next"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });

    const artifact = await broker.readBuildArtifact({
      ...expectation(undefined, legacyNextPlan),
      buildPlanSha256: await planDigest(legacyNextPlan),
    });

    expect(artifact.runtime?.entryWrapperVersion).toBe("nextjs-opennext-wrapper-v1");
    expect(Object.hasOwn(artifact.runtime ?? {}, "ssgCacheMaxBytes")).toBe(false);
    expect(artifact.runtime?.compatibilityDate).toBe("2024-09-23");
    expect(artifact.modules).toHaveLength(2);
    expect(artifact.modules.find((module) => module.path === "codec.wasm")?.contentType).toBe(
      "application/wasm",
    );
    expect(artifact.modules.find((module) => module.path === "index.js")?.size).toBe(
      main.byteLength,
    );
  });

  it("preserves traced Next.js data bytes privately, including scoped metadata and empty files", async () => {
    const data = [
      { path: "content/article.md", body: encoder.encode("# Public article\n") },
      { path: "data/binary.bin", body: new Uint8Array([0, 255, 13, 10, 42]) },
      {
        path: "node_modules/@scope/package/package.json",
        body: encoder.encode('{"name":"@scope/package"}'),
      },
      { path: "public/empty.txt", body: new Uint8Array() },
      { path: `${"a".repeat(147)}/${"b".repeat(95)}.json`, body: encoder.encode("{}") },
      { path: "node_modules/.pnpm/@scope+package@1.0.0/LICENSE", body: encoder.encode("License") },
    ];
    const body = await buildEdgeBundle(
      { entryWrapperVersion: "nextjs-opennext-wrapper-v1" },
      undefined,
      undefined,
      undefined,
      legacyNextPlan,
      undefined,
      undefined,
      data,
    );
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-data",
      eTag: '"data"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
    const artifact = await broker.readBuildArtifact({
      ...expectation(undefined, legacyNextPlan),
      buildPlanSha256: await planDigest(legacyNextPlan),
    });
    for (const file of data) {
      expect(artifact.modules.find(({ path }) => path === file.path)).toMatchObject({
        ...file,
        contentType: "application/octet-stream",
        size: file.body.byteLength,
      });
      expect(artifact.files.some(({ path }) => path === `/${file.path}`)).toBe(false);
    }
    await expect(
      parseVerifiedArtifactBundle({ body, expectedProvenance: artifact.provenance }),
    ).resolves.toEqual(artifact);
  });

  it("rejects data module type, path, integrity, runtime, and budget confusion", async () => {
    const data = { path: "content/article.md", body: encoder.encode("# Article") };
    const cases = [
      ...[
        "/absolute.json",
        "../outside.json",
        "content/../outside.json",
        "content//data.json",
        "content/./data.json",
        "C:\\data.json",
        "content/data\n.json",
        "addon.node",
        "addon.NODE",
        "worker.js",
        "worker.mjs",
        "worker.cjs",
        "module.wasm",
        "index.js",
        "ohmyhost-worker.js",
        "ohmyhost-entry.mjs",
        `${"a".repeat(148)}/${"b".repeat(95)}.json`,
      ].map((path) => ({ module: { ...data, path } })),
      { module: { ...data, contentType: "text/plain" } },
      { module: { ...data, contentType: "application/javascript+module" } },
      {
        module: {
          path: "empty.js",
          contentType: "application/javascript+module",
          body: new Uint8Array(),
        },
      },
      { module: { ...data, digest: "sha256:bad" } },
      { module: { ...data, digest: `sha256:${"f".repeat(64)}` } },
      { module: { ...data, size: data.body.byteLength + 1 } },
      { module: { ...data, size: -1 } },
      { module: { ...data, size: 0.5 } },
      { module: { ...data, size: 5 * 1024 * 1024 + 1 } },
      { module: data, entryWrapperVersion: "tanstack-edge-wrapper-v1" },
      { module: data, entryWrapperVersion: "vite-api-companion-v1" },
      { module: data, entryWrapperVersion: "functions-v1" },
    ];
    for (const candidate of cases) {
      const body = await buildEdgeBundle(
        {
          entryWrapperVersion:
            "entryWrapperVersion" in candidate
              ? candidate.entryWrapperVersion
              : "nextjs-opennext-wrapper-v1",
        },
        undefined,
        undefined,
        undefined,
        buildIdentity.frameworkPlan,
        undefined,
        undefined,
        [candidate.module],
      );
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-invalid-data",
        eTag: '"data"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      await expect(
        broker.readBuildArtifact(expectation()),
        JSON.stringify(candidate),
      ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    }
  });

  it("refuses Next data modules named like the upload metadata part", async () => {
    const reserved = ["metadata", "content/Metadata", "content/METADATA"];
    for (const path of ["content/metadata.md", ...reserved]) {
      const body = await buildEdgeBundle(
        { entryWrapperVersion: "nextjs-opennext-wrapper-v1" },
        undefined,
        undefined,
        undefined,
        legacyNextPlan,
        undefined,
        undefined,
        [{ path, body: encoder.encode("# Article") }],
      );
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-reserved-data",
        eTag: '"data"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      const read = broker.readBuildArtifact({
        ...expectation(undefined, legacyNextPlan),
        buildPlanSha256: await planDigest(legacyNextPlan),
      });
      if (reserved.includes(path)) {
        await expect(read, path).rejects.toBeInstanceOf(BuildBrokerConflictError);
      } else {
        await expect(read, path).resolves.toMatchObject({
          modules: expect.arrayContaining([expect.objectContaining({ path })]),
        });
      }
    }
  });

  it("takes the runtime shape from the build plan, so a static plan refuses an edge artifact", async () => {
    const { broker, objectStore } = setup();
    const body = await buildEdgeBundle();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-static-edge",
      eTag: '"static-edge"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
    await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("refuses executable modules named like the edge wrapper, case-insensitively", async () => {
    for (const path of ["ohmyhost-entry.mjs", "Ohmyhost-Entry.mjs"]) {
      const body = await buildEdgeBundle(
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [
          {
            path,
            body: encoder.encode("export default {};"),
            contentType: "application/javascript+module",
          },
        ],
      );
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-reserved-entry",
        eTag: '"entry"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      await expect(broker.readBuildArtifact(expectation()), path).rejects.toBeInstanceOf(
        BuildBrokerConflictError,
      );
    }
  });

  it("keeps an executable module under a non-reserved name", async () => {
    const body = await buildEdgeBundle(
      {},
      undefined,
      undefined,
      undefined,
      tanStackEdgePlan,
      undefined,
      undefined,
      [
        {
          path: "entry/ohmyhost-entry.mjs",
          body: encoder.encode("export default {};"),
          contentType: "application/javascript+module",
        },
      ],
    );
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-entry-control",
      eTag: '"entry-control"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
    await expect(
      broker.readBuildArtifact({
        ...expectation(undefined, tanStackEdgePlan),
        buildPlanSha256: await planDigest(tanStackEdgePlan),
      }),
    ).resolves.toMatchObject({
      modules: expect.arrayContaining([
        expect.objectContaining({ path: "entry/ohmyhost-entry.mjs" }),
      ]),
    });
  });

  it("counts private data toward Next.js raw, compressed, and inventory limits", async () => {
    const dataBody = deterministicNoise(4 * 1024 * 1024);
    const inventory = Array.from({ length: 1000 }, (_, index) => ({
      path: `data/${String(index).padStart(4, "0")}.bin`,
      body: new Uint8Array(),
    }));
    const cases = [
      // Every item is below its own limit; together these exceed the compressed Worker limit.
      [0, 1, 2].map((index) => ({ path: `data/${index}.bin`, body: dataBody })),
      [0, 1, 2, 3].map((index) => ({
        path: `data/${index}.bin`,
        body: new Uint8Array(4 * 1024 * 1024),
      })),
      inventory,
    ];
    for (const modules of cases) {
      const body = await buildEdgeBundle(
        { entryWrapperVersion: "nextjs-opennext-wrapper-v1" },
        undefined,
        undefined,
        undefined,
        buildIdentity.frameworkPlan,
        undefined,
        undefined,
        modules,
      );
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-oversize-data",
        eTag: '"data"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
        BuildBrokerConflictError,
      );
    }
  });

  it("accepts the canonical Vite API companion with bounded ESM and WASM modules", async () => {
    const { broker, objectStore } = setup();
    const frameworkPlan = parseNewProductionFrameworkPlan({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: "site",
      adapter: "vite-static",
      runtime: "edge",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: "dist",
      serverOutputDirectory: ".ohmyhost/vite-companion",
      serverEntryPoint: ".ohmyhost/vite-companion/worker.js",
      serverConfigPath: ".ohmyhost/vite-companion/wrangler.jsonc",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      runtimePolicy: {
        ...buildIdentity.frameworkPlan.runtimePolicy,
        browser: normalizeBrowserPolicy({ connect: ["https://browser.example.test"] }),
      },
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
      functions: { crons: ["*/5 * * * *"] },
    });
    if (frameworkPlan.adapter !== "vite-static" || frameworkPlan.runtime !== "edge")
      throw new Error("expected Vite scheduled fixture");
    const buildPlanSha256 = await planDigest(frameworkPlan);
    const body = await buildEdgeBundle(
      { compatibilityDate: "2025-01-01", entryWrapperVersion: "vite-api-companion-v1" },
      encoder.encode('import "./assets/chunk.mjs"; import "./codec.wasm"; export default {};'),
      undefined,
      true,
      frameworkPlan,
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
      "assets/chunk.mjs",
    );
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-vite-companion",
      eTag: '"vite-companion"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });

    const artifact = await broker.readBuildArtifact({
      ...expectation(undefined, frameworkPlan),
      buildPlanSha256,
    });

    expect(artifact.runtime?.entryWrapperVersion).toBe("vite-api-companion-v1");
    expect(artifact.runtime?.compatibilityDate).toBe("2025-01-01");
    expect(artifact.modules.map((module) => module.path)).toEqual([
      "assets/chunk.mjs",
      "codec.wasm",
      "index.js",
    ]);
    expect(artifact.provenance.functions).toEqual({ crons: ["*/5 * * * *"] });
    expect(artifact.provenance.runtimePolicy.browser?.connect).toEqual([
      "https://browser.example.test",
    ]);
    await expect(
      parseVerifiedArtifactBundle({ body, expectedProvenance: artifact.provenance }),
    ).resolves.toEqual(artifact);
  });

  it("accepts the asset-free single-module functions runtime", async () => {
    const { broker, objectStore } = setup();
    const frameworkPlan = parseNewProductionFrameworkPlan({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: "site",
      adapter: "functions",
      runtime: "functions",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      runtimePolicy: buildIdentity.frameworkPlan.runtimePolicy,
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
      functions: { crons: ["0 3 * * *"] },
    });
    if (frameworkPlan.runtime !== "functions") throw new Error("expected functions fixture");
    const buildPlanSha256 = await planDigest(frameworkPlan);
    const main = encoder.encode(
      'export default { fetch() { return new Response("ok"); }, async scheduled() {} };\n',
    );
    const sbom = encoder.encode(
      JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", version: 1 }),
    );
    const runtime = {
      kind: "cloudflare-worker",
      mainModule: "index.js",
      compatibilityDate: "2025-01-01",
      compatibilityFlags: ["nodejs_compat"],
      entryWrapperVersion: "functions-v1",
    };
    const modules = [
      {
        path: "index.js",
        contentType: "application/javascript+module",
        digest: `sha256:${await hex(main)}`,
        size: main.byteLength,
      },
    ];
    const bundle = async (overrides: Record<string, unknown>) => {
      const manifestValue = {
        schemaVersion: "ohmyhost.artifact/v3",
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        deploymentId: buildIdentity.deploymentId,
        operationId: scope.operationId,
        buildId: BUILD_ID,
        sourceCommit: buildIdentity.commitSha,
        sourceDigest: `sha256:${"a".repeat(64)}`,
        buildPlanDigest: `sha256:${buildPlanSha256}`,
        applicationRoot: frameworkPlan.applicationRoot,
        frameworkPlanSchemaVersion: frameworkPlan.schemaVersion,
        runtimePolicy: frameworkPlan.runtimePolicy,
        database: frameworkPlan.database,
        auth: frameworkPlan.auth,
        storage: frameworkPlan.storage,
        lifecycleEvidence: await lifecycleEvidence(frameworkPlan),
        functions: frameworkPlan.functions,
        artifactDigest: `sha256:${await hex(
          encoder.encode(
            JSON.stringify({
              applicationRoot: frameworkPlan.applicationRoot,
              frameworkPlanSchemaVersion: frameworkPlan.schemaVersion,
              runtimePolicy: frameworkPlan.runtimePolicy,
              database: frameworkPlan.database,
              auth: frameworkPlan.auth,
              storage: frameworkPlan.storage,
              functions: frameworkPlan.functions,
              runtime,
              assets: [],
              modules,
            }),
          ),
        )}`,
        sbom: { path: "sbom.cdx.json", digest: `sha256:${await hex(sbom)}` },
        runtime,
        assets: [],
        modules,
        ...overrides,
      };
      return gzip(
        tar([
          { path: "manifest.json", body: encoder.encode(JSON.stringify(manifestValue)) },
          { path: "sbom.cdx.json", body: sbom },
          { path: "worker/index.js", body: main },
        ]),
      );
    };
    const body = await bundle({});
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-functions",
      eTag: '"functions"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });

    const artifact = await broker.readBuildArtifact({
      ...expectation(undefined, frameworkPlan),
      buildPlanSha256,
    });

    expect(artifact.runtime?.entryWrapperVersion).toBe("functions-v1");
    expect(artifact.files.some(({ path }) => path.startsWith("assets/"))).toBe(false);
    expect(artifact.modules.map((module) => module.path)).toEqual(["index.js"]);
    expect(artifact.provenance.functions).toEqual({ crons: ["0 3 * * *"] });
    expect(artifact.provenance.lifecycleEvidence.frameworkBuild.runtime).toBe("functions");
    await expect(
      parseVerifiedArtifactBundle({ body, expectedProvenance: artifact.provenance }),
    ).resolves.toEqual(artifact);

    for (const invalid of [
      await bundle({ runtime: { ...runtime, entryWrapperVersion: "vite-api-companion-v1" } }),
      await bundle({ runtime: { ...runtime, compatibilityDate: "2025-01-02" } }),
      await bundle({
        modules: [...modules, { ...modules[0], path: "ohmyhost-worker.js" }],
      }),
    ]) {
      const invalidSetup = setup();
      vi.mocked(invalidSetup.objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-functions-invalid",
        eTag: '"functions-invalid"',
        byteLength: invalid.byteLength,
        metadata: {},
      });
      vi.mocked(invalidSetup.objectStore.readObject).mockResolvedValueOnce({
        body: invalid,
        sha256: await hex(invalid),
      });
      await expect(
        invalidSetup.broker.readBuildArtifact({
          ...expectation(undefined, frameworkPlan),
          buildPlanSha256,
        }),
      ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    }
  });

  it("binds the private Next cache budget to its trusted plan independently of public assets", async () => {
    const mib = 1024 * 1024;
    const plan = parseNewProductionFrameworkPlan({
      ...buildIdentity.frameworkPlan,
      adapter: "nextjs",
      runtime: "edge",
      outputDirectory: ".open-next/assets",
      serverOutputDirectory: ".ohmyhost-worker",
      serverEntryPoint: ".ohmyhost-worker/worker.js",
      serverConfigPath: "wrangler.jsonc",
      compatibilityDate: "2026-08-21",
      compatibilityFlags: ["nodejs_compat"],
      ssgCacheMaxBytes: 32 * mib,
    });
    const check = async (
      assets: readonly { path: string; body: Uint8Array }[],
      selected = 32 * mib,
      descriptor: number | null = selected,
      sbom?: Uint8Array,
      trustedPlan = parseNewProductionFrameworkPlan({ ...plan, ssgCacheMaxBytes: selected }),
      wrapper = "nextjs-opennext-wrapper-v1",
      revalidatePath?: unknown,
    ) => {
      const selectedPlan = trustedPlan;
      const body = await buildEdgeBundle(
        {
          entryWrapperVersion: wrapper,
          ...(descriptor === null ? {} : { ssgCacheMaxBytes: descriptor }),
          ...(revalidatePath === undefined ? {} : { nextRevalidatePath: revalidatePath }),
        },
        undefined,
        undefined,
        undefined,
        selectedPlan,
        undefined,
        undefined,
        [],
        assets,
        sbom,
      );
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "quota-version",
        eTag: '"quota"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      return broker.readBuildArtifact({
        ...expectation(undefined, selectedPlan),
        buildPlanSha256: await planDigest(selectedPlan),
      });
    };
    const manyCacheFiles = Array.from({ length: 400 }, (_, index) => ({
      path: `/cdn-cgi/_next_cache/build/${String(index).padStart(4, "0")}-${"a".repeat(50)}.cache`,
      body: new Uint8Array([123, 125]),
    }));
    const largeManifest = await check(manyCacheFiles);
    expect(largeManifest.manifestBody.byteLength).toBeGreaterThan(64 * 1024);
    expect(largeManifest.manifestBody.byteLength).toBeLessThan(1024 * 1024);
    expect(largeManifest.files.length).toBeGreaterThanOrEqual(400);
    const assets = [
      ...[0, 1, 2].map((index) => ({
        path: `/public-${index}.bin`,
        body: new Uint8Array(8 * mib),
      })),
      ...[0, 1, 2, 3].map((index) => ({
        path: `/cdn-cgi/_next_cache/build/${index}.cache`,
        body: new Uint8Array(8 * mib),
      })),
    ];
    const valid = await check(assets);
    expect(valid.files).toHaveLength(8);
    expect(valid.runtime?.ssgCacheMaxBytes).toBe(32 * mib);
    const writablePlan = parseNewProductionFrameworkPlan({ ...plan, nextRevalidatePath: true });
    await expect(
      check([], 32 * mib, 32 * mib, undefined, writablePlan, "nextjs-opennext-wrapper-v1", true),
    ).resolves.toMatchObject({ runtime: { nextRevalidatePath: true } });
    await expect(check([], 32 * mib, 32 * mib, undefined, writablePlan)).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
    await expect(
      check([], 32 * mib, 32 * mib, undefined, plan, "nextjs-opennext-wrapper-v1", true),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(
      check([], 32 * mib, 32 * mib, undefined, plan, "nextjs-opennext-wrapper-v1", false),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(
      check(
        [{ path: "/cdn-cgi/_next_cache/build/over.cache", body: new Uint8Array(mib + 1) }],
        mib,
      ),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(check([], mib, 2 * mib)).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(
      check([], 64 * mib, 64 * mib, undefined, buildIdentity.frameworkPlan),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(
      check([], 32 * mib, null, undefined, plan, "tanstack-edge-wrapper-v1"),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(
      check(
        [
          ...[0, 1, 2].map((index) => ({
            path: `/public-${index}.bin`,
            body: new Uint8Array(8 * mib),
          })),
          { path: "/public-over.bin", body: new Uint8Array(mib) },
        ],
        64 * mib,
      ),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    for (const padding of [Array.from({ length: 20_000 }, () => ({})), Array(70_000).fill(0)]) {
      await expect(
        check(
          [],
          32 * mib,
          32 * mib,
          encoder.encode(JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6", padding })),
        ),
      ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    }
    await expect(
      check(
        [],
        32 * mib,
        32 * mib,
        encoder.encode(
          `{"bomFormat":"CycloneDX","specVersion":"1.6","padding":${"[".repeat(65)}0${"]".repeat(65)}}`,
        ),
      ),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
    await expect(
      check(
        [],
        32 * mib,
        32 * mib,
        encoder.encode(
          JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.6",
            padding: '["quoted"],{"data":":"}'.repeat(20_000),
          }),
        ),
      ),
    ).resolves.toMatchObject({ runtime: { ssgCacheMaxBytes: 32 * mib } });
  });

  it("requires the bundled Worker module exactly when a Next.js plan declares crons", async () => {
    const { broker, objectStore } = setup();
    const frameworkPlan = parseNewProductionFrameworkPlan({
      schemaVersion: "ohmyhost.framework-plan/v5",
      applicationRoot: "site",
      adapter: "nextjs",
      runtime: "edge",
      installCommand: "pnpm install --frozen-lockfile --ignore-scripts",
      buildCommand: "pnpm run build",
      outputDirectory: ".open-next/assets",
      serverOutputDirectory: ".ohmyhost-worker",
      serverEntryPoint: ".ohmyhost-worker/worker.js",
      serverConfigPath: "wrangler.jsonc",
      compatibilityDate: "2024-09-23",
      compatibilityFlags: ["nodejs_compat"],
      runtimePolicy: buildIdentity.frameworkPlan.runtimePolicy,
      database: { enabled: false },
      auth: { provider: "none" },
      mail: { enabled: false },
      storage: { enabled: false },
      functions: { crons: ["0 3 * * *"] },
    });
    if (frameworkPlan.adapter !== "nextjs" || frameworkPlan.runtime !== "edge")
      throw new Error("expected Next.js crons fixture");
    const buildPlanSha256 = await planDigest(frameworkPlan);
    const withoutWorkerModule = await buildEdgeBundle(
      { compatibilityDate: "2024-09-23", entryWrapperVersion: "nextjs-opennext-wrapper-v1" },
      undefined,
      undefined,
      undefined,
      frameworkPlan,
    );
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-next-crons",
      eTag: '"next-crons"',
      byteLength: withoutWorkerModule.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({
      body: withoutWorkerModule,
      sha256: await hex(withoutWorkerModule),
    });
    await expect(
      broker.readBuildArtifact({ ...expectation(undefined, frameworkPlan), buildPlanSha256 }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
  });

  it("rejects edge wrapper, main-module, raw-size and artifact-digest confusion", async () => {
    const oversizedTanStack = new Uint8Array(6 * 1024 * 1024).fill(97);
    const cases = [
      await buildEdgeBundle({ entryWrapperVersion: "unknown-wrapper-v1" }),
      await buildEdgeBundle({ basePath: `/p/${scope.projectId}/` }),
      await buildEdgeBundle({
        entryWrapperVersion: "nextjs-opennext-wrapper-v1",
        mainModule: "worker.js",
      }),
      await buildEdgeBundle(
        { entryWrapperVersion: "nextjs-opennext-wrapper-v1" },
        undefined,
        undefined,
        true,
        buildIdentity.frameworkPlan,
        undefined,
        "assets/native.node",
      ),
      await buildEdgeBundle({ compatibilityDate: "2024-09-23" }),
      await buildEdgeBundle({
        compatibilityDate: "2024-09-22",
        entryWrapperVersion: "nextjs-opennext-wrapper-v1",
      }),
      await buildEdgeBundle({
        compatibilityDate: "2024-12-31",
        entryWrapperVersion: "vite-api-companion-v1",
      }),
      await buildEdgeBundle(
        { compatibilityDate: "2025-01-01", entryWrapperVersion: "vite-api-companion-v1" },
        undefined,
        undefined,
        true,
        buildIdentity.frameworkPlan,
        undefined,
        "ohmyhost-worker.js",
      ),
      await buildEdgeBundle({}, oversizedTanStack),
    ];
    for (const body of cases) {
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-invalid-edge",
        eTag: '"invalid-edge"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
        BuildBrokerConflictError,
      );
    }

    // Artifact digests are validated over the exact runtime, assets, and module inventory.
    const wrongDigest = await buildEdgeBundle(
      { entryWrapperVersion: "nextjs-opennext-wrapper-v1" },
      undefined,
      `sha256:${"e".repeat(64)}`,
    );
    const { broker, objectStore } = setup();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-wrong-digest",
      eTag: '"wrong-digest"',
      byteLength: wrongDigest.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({
      body: wrongDigest,
      sha256: await hex(wrongDigest),
    });
    await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("rejects a Next.js Worker above the compressed upload ceiling", async () => {
    const { broker, objectStore } = setup();
    const main = deterministicNoise(11 * 1024 * 1024);
    const body = await buildEdgeBundle({ entryWrapperVersion: "nextjs-opennext-wrapper-v1" }, main);
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-next-compressed-limit",
      eTag: '"next-compressed-limit"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });

    await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );
  });

  it("rejects source, build, deployment, digest, traversal, duplicate and link mismatches", async () => {
    const cases = [
      await buildBundle({ deploymentId: "01J00000000000000000000005" }),
      await buildBundle({ sourceCommit: "e".repeat(40) }),
      await buildBundle({ buildPlanDigest: `sha256:${"e".repeat(64)}` }),
      await buildBundle({ sourceDigest: `sha256:${"e".repeat(64)}` }),
      await buildBundle({ artifactDigest: `sha256:${"e".repeat(64)}` }),
      await buildBundle({}, [{ path: "../escape", body: encoder.encode("x") }]),
      await buildBundle({}, [{ path: "assets/%2e%2e/escape", body: encoder.encode("x") }]),
      await buildBundle({}, [{ path: "assets/index.html", body: encoder.encode("again") }]),
      await buildBundle({}, [{ path: "assets/link", body: new Uint8Array(), type: 50 }]),
    ];
    for (const body of cases) {
      const { broker, objectStore } = setup();
      vi.mocked(objectStore.headObject).mockResolvedValueOnce({
        versionId: "output-version-1",
        eTag: '"output"',
        byteLength: body.byteLength,
        metadata: {},
      });
      vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
      await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
        BuildBrokerConflictError,
      );
    }
  });

  it("returns pending absence and deletes exactly one immutable version idempotently", async () => {
    const { broker, objectStore } = setup();
    await expect(broker.observeBuildArtifact(expectation())).resolves.toBeNull();
    await expect(broker.readBuildArtifact(expectation())).rejects.toBeInstanceOf(
      BuildBrokerUncertainError,
    );

    const body = await buildBundle();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-1",
      eTag: '"output"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
    const artifact = await broker.readBuildArtifact(expectation());
    vi.mocked(objectStore.headObject)
      .mockResolvedValueOnce({
        versionId: "output-version-1",
        eTag: '"output"',
        byteLength: body.byteLength,
        metadata: {},
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    await expect(broker.removeBuildArtifact(artifact)).resolves.toMatchObject({ state: "absent" });
    expect(objectStore.deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "output-version-1" }),
      expect.any(AbortSignal),
    );

    vi.mocked(objectStore.headObject).mockResolvedValue(null);
    await expect(broker.removeBuildArtifact(artifact)).resolves.toMatchObject({ state: "absent" });
  });

  it("replays artifact cleanup from its exact persisted object locator after bytes are absent", async () => {
    const { broker, objectStore } = setup();
    const locator = {
      bucket: "ohmyho-sandbox-builds",
      key: `${operationPaths(scope).outputPrefix}bundle.tar.gz`,
      versionId: "output-version-1",
      scope,
    };
    vi.mocked(objectStore.headObject).mockRejectedValueOnce({ code: "HTTP403", retryable: false });

    await expect(broker.removeBuildArtifactObject(locator)).resolves.toEqual({
      state: "absent",
      scope,
      key: locator.key,
      versionId: locator.versionId,
    });
    expect(objectStore.deleteObject).toHaveBeenCalledWith(
      { bucket: locator.bucket, key: locator.key, versionId: locator.versionId },
      expect.any(AbortSignal),
    );
    vi.mocked(objectStore.headObject).mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    vi.mocked(objectStore.deleteObject).mockRejectedValueOnce(
      new TypeError("delete response lost"),
    );
    await expect(broker.removeBuildArtifactObject(locator)).resolves.toMatchObject({
      state: "absent",
    });
    const present = {
      versionId: locator.versionId,
      eTag: '"retained"',
      byteLength: 32,
      metadata: {},
    };
    vi.mocked(objectStore.headObject).mockResolvedValueOnce(present).mockResolvedValueOnce(present);
    vi.mocked(objectStore.deleteObject).mockRejectedValueOnce(
      new TypeError("delete response lost"),
    );
    await expect(broker.removeBuildArtifactObject(locator)).rejects.toBeInstanceOf(
      BuildBrokerUncertainError,
    );
    await expect(
      broker.removeBuildArtifactObject({ ...locator, key: `${locator.key}.other` }),
    ).rejects.toBeInstanceOf(BuildBrokerConflictError);
  });

  it("refuses output version drift and reconciles timeout-after-delete only through exact absence", async () => {
    const { broker, objectStore } = setup();
    const body = await buildBundle();
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-1",
      eTag: '"output"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(objectStore.readObject).mockResolvedValueOnce({ body, sha256: await hex(body) });
    const artifact = await broker.readBuildArtifact(expectation());
    vi.mocked(objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-2",
      eTag: '"drift"',
      byteLength: body.byteLength,
      metadata: {},
    });
    await expect(broker.removeBuildArtifact(artifact)).rejects.toBeInstanceOf(
      BuildBrokerConflictError,
    );

    const recovered = setup();
    vi.mocked(recovered.objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-1",
      eTag: '"output"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(recovered.objectStore.readObject).mockResolvedValueOnce({
      body,
      sha256: await hex(body),
    });
    const recoveredArtifact = await recovered.broker.readBuildArtifact(expectation());
    vi.mocked(recovered.objectStore.headObject)
      .mockResolvedValueOnce({
        versionId: "output-version-1",
        eTag: '"output"',
        byteLength: body.byteLength,
        metadata: {},
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    vi.mocked(recovered.objectStore.deleteObject).mockRejectedValueOnce(
      new TypeError("response lost"),
    );
    await expect(recovered.broker.removeBuildArtifact(recoveredArtifact)).resolves.toMatchObject({
      state: "absent",
    });

    const uncertain = setup();
    vi.mocked(uncertain.objectStore.headObject).mockResolvedValueOnce({
      versionId: "output-version-1",
      eTag: '"output"',
      byteLength: body.byteLength,
      metadata: {},
    });
    vi.mocked(uncertain.objectStore.readObject).mockResolvedValueOnce({
      body,
      sha256: await hex(body),
    });
    const uncertainArtifact = await uncertain.broker.readBuildArtifact(expectation());
    const present = {
      versionId: "output-version-1",
      eTag: '"output"',
      byteLength: body.byteLength,
      metadata: {},
    };
    vi.mocked(uncertain.objectStore.headObject).mockResolvedValue(present);
    vi.mocked(uncertain.objectStore.deleteObject).mockRejectedValueOnce(
      new TypeError("response lost"),
    );
    await expect(uncertain.broker.removeBuildArtifact(uncertainArtifact)).rejects.toBeInstanceOf(
      BuildBrokerUncertainError,
    );
  });
});

describe("fail-closed boundaries", () => {
  it("retries bounded read failures but not mutations", async () => {
    const { broker, dependencies, objectStore } = setup();
    vi.mocked(objectStore.headObject)
      .mockRejectedValueOnce({ retryable: true })
      .mockResolvedValueOnce(null);
    await expect(
      broker.observeArchive({ scope, sourceSha256: "a".repeat(64) }),
    ).resolves.toBeNull();
    expect(dependencies.sleep).toHaveBeenCalledTimes(1);

    vi.mocked(objectStore.headObject)
      .mockRejectedValueOnce({ code: "SlowDown", retryable: true })
      .mockResolvedValueOnce(null);
    await expect(
      broker.observeArchive({ scope, sourceSha256: "a".repeat(64) }),
    ).resolves.toBeNull();
    expect(dependencies.sleep).toHaveBeenCalledTimes(2);

    vi.mocked(objectStore.headObject).mockRejectedValueOnce({
      code: "AccessDenied",
      retryable: false,
    });
    await expect(broker.observeArchive({ scope, sourceSha256: "a".repeat(64) })).rejects.toThrow(
      "build_provider_signal:AccessDenied",
    );

    vi.mocked(objectStore.createMultipartUpload).mockRejectedValueOnce({ retryable: true });
    await expect(broker.beginArchive({ scope })).rejects.toBeInstanceOf(BuildBrokerUncertainError);
  });

  it("fails timeouts and invalid configuration without leaking secrets", async () => {
    const never = new Promise<never>(() => undefined);
    const timed = setup({ requestTimeoutMs: 1 });
    vi.mocked(timed.objectStore.headObject).mockReturnValueOnce(never);
    await expect(
      timed.broker.observeArchive({ scope, sourceSha256: "a".repeat(64) }),
    ).rejects.toBeInstanceOf(BuildBrokerTransportError);

    const leaking = setup();
    vi.mocked(leaking.objectStore.headObject).mockRejectedValueOnce(new Error("secret-value"));
    const leaked = await leaking.broker
      .observeArchive({ scope, sourceSha256: "a".repeat(64) })
      .catch((error: unknown) => error);
    expect(leaked).toBeInstanceOf(BuildBrokerTransportError);
    expect(String(leaked)).not.toContain("secret-value");

    for (const error of [
      new BuildBrokerInputError(),
      new BuildBrokerTransportError(),
      new BuildBrokerConflictError(),
      new BuildBrokerUncertainError(),
    ]) {
      expect(error.message).not.toMatch(/secret|signature/u);
      expect(JSON.stringify(error)).not.toMatch(/secret|signature/u);
    }

    expect(() => createBuildBroker({ ...setup().dependencies, maximumAttempts: 0 })).toThrow(
      BuildBrokerInputError,
    );
    expect(() => createBuildBroker({ ...setup().dependencies, executor: {} as never })).toThrow(
      BuildBrokerInputError,
    );
    const providerCredentialed = { ...setup().dependencies, region: "us-east-2" };
    expect(() => createBuildBroker(providerCredentialed)).toThrow(BuildBrokerInputError);
  });
});

describe("closed build refusal codes", () => {
  it("names the capacity refusal a full organization receives with its closed code", () => {
    // The build runner throws this class when the control store reports the organization's open capacity full.
    const refusal = new BuildBrokerCapacityError();
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({
      name: "BuildBrokerCapacityError",
      code: "build_capacity_reached",
      message: "build_capacity_reached",
    });
  });
});
