import {
  FRAMEWORK_PLAN_SCHEMA_VERSION,
  isRecordedBetterAuthVersion,
  parseNewProductionFrameworkPlan,
  serializeNewProductionFrameworkPlanPreimage,
  type ProductionFrameworkPlan,
  type FunctionsRequirement,
} from "@ohmyhost/platform";
import { normalizeApplicationRoot } from "@ohmyhost/contracts/application-root";
import { parseBrowserPolicy } from "@ohmyhost/contracts/browser-capabilities";
import { normalizeCrons } from "@ohmyhost/contracts/functions";

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const ETAG_PATTERN = /^"[^"\r\n]{1,256}"$/u;
const MAX_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_EXPANDED_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_PUBLIC_ASSET_TOTAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_SSG_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_SBOM_BYTES = 4 * 1024 * 1024;
const MAX_BUILD_FAILURE_BYTES = 80 * 1024;
const BUILD_FAILURE_SCHEMA_VERSION = "ohmyhost.build-failure/v1";
const BUILD_FAILURE_MAX_CHARACTERS = 16384;
const BUILD_FAILURE_FORBIDDEN_PATTERN = /(?![\t\n])\p{Cc}|\p{Cs}/u;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_COUNT = 1_000;
const MAX_TANSTACK_MODULE_BYTES = 5 * 1024 * 1024;
const MAX_NEXTJS_MODULE_BYTES = 15 * 1024 * 1024;
const MAX_NEXTJS_COMPRESSED_MODULE_BYTES = 10 * 1024 * 1024;
const MAX_MODULE_BYTES = MAX_NEXTJS_MODULE_BYTES;
const MAX_MODULE_COUNT = 1_000;
const BYTE_STREAM_CHUNK_BYTES = 64 * 1024;
const MAX_MIGRATION_BYTES = 256 * 1024;
const MAX_MIGRATION_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_MIGRATION_COUNT = 128;
const BUILD_START_CLOCK_SKEW_MILLISECONDS = 5 * 60_000;

export type BuildBrokerErrorCode =
  | "build_broker_conflict"
  | "build_capacity_reached"
  | "build_broker_input_invalid"
  | "build_broker_transport_failed"
  | "build_broker_result_uncertain";

class SafeBuildBrokerError extends Error {
  public constructor(
    name: string,
    public readonly code: BuildBrokerErrorCode,
  ) {
    super(code);
    this.name = name;
  }
}

class ProviderSignal extends Error {
  public constructor(public readonly providerCode: string) {
    super(
      `build_provider_signal:${/^[A-Za-z0-9._-]{1,128}$/u.test(providerCode) ? providerCode : "Unknown"}`,
    );
    this.name = "ProviderSignal";
  }
}

export class BuildBrokerInputError extends SafeBuildBrokerError {
  public constructor() {
    super("BuildBrokerInputError", "build_broker_input_invalid");
  }
}

export class BuildBrokerConflictError extends SafeBuildBrokerError {
  public constructor() {
    super("BuildBrokerConflictError", "build_broker_conflict");
  }
}

export class BuildBrokerCapacityError extends SafeBuildBrokerError {
  public constructor() {
    super("BuildBrokerCapacityError", "build_capacity_reached");
  }
}

export class BuildBrokerTransportError extends SafeBuildBrokerError {
  public constructor() {
    super("BuildBrokerTransportError", "build_broker_transport_failed");
  }
}

export class BuildBrokerUncertainError extends SafeBuildBrokerError {
  public constructor() {
    super("BuildBrokerUncertainError", "build_broker_result_uncertain");
  }
}

export interface OperationScope {
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
}

export interface OperationPaths {
  readonly inputKey: string;
  readonly outputPrefix: string;
  readonly bundleKey: string;
  /** The customer failure excerpt; under `logs/` so the bucket's seven-day lifecycle rule expires it. */
  readonly failureKey: string;
  /** The full customer build log; the bucket's `logs/` lifecycle rule expires it. */
  readonly logKey: string;
}

export function operationPaths(scope: OperationScope): OperationPaths {
  validateScope(scope);
  const root = `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}`;
  return Object.freeze({
    inputKey: `${root}/input/source.tar.gz`,
    outputPrefix: `${root}/output/`,
    bundleKey: `${root}/output/bundle.tar.gz`,
    logKey: `logs/${scope.projectId}/${scope.environmentId}/${scope.operationId}.log`,
    failureKey: `logs/${scope.projectId}/${scope.environmentId}/${scope.operationId}.failure.json`,
  });
}

export interface StoredObjectState {
  readonly versionId: string;
  readonly eTag: string;
  readonly byteLength: number;
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * The versioned object store that holds source archives, bundles, failure excerpts and logs.
 * `versionId` is the store's immutable object version and `eTag` its entity tag. A rejection may
 * carry `retryable: true` (reads are retried) and a string `code`; the broker interprets
 * `NoSuchUpload` from `abortMultipartUpload` as an already removed upload and `HTTP403` from an
 * exact-version `headObject` as a version that is no longer readable.
 */
export interface ObjectStore {
  listMultipartUploads(
    command: Readonly<{ bucket: string; key: string }>,
    signal: AbortSignal,
  ): Promise<readonly Readonly<{ uploadId: string; key: string }>[]>;
  createMultipartUpload(
    command: Readonly<{
      bucket: string;
      key: string;
      contentType: "application/gzip";
      metadata: Readonly<Record<string, string>>;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ uploadId: string }>>;
  uploadPart(
    command: Readonly<{
      bucket: string;
      key: string;
      uploadId: string;
      partNumber: number;
      body: Uint8Array;
      checksumSha256: string;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ eTag: string }>>;
  completeMultipartUpload(
    command: Readonly<{
      bucket: string;
      key: string;
      uploadId: string;
      parts: readonly Readonly<{
        partNumber: number;
        eTag: string;
        checksumSha256: string;
      }>[];
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ versionId: string; eTag: string }>>;
  abortMultipartUpload(
    command: Readonly<{ bucket: string; key: string; uploadId: string }>,
    signal: AbortSignal,
  ): Promise<void>;
  headObject(
    command: Readonly<{ bucket: string; key: string; versionId?: string }>,
    signal: AbortSignal,
  ): Promise<StoredObjectState | null>;
  /** Streams the exact immutable object version and computes its full-object SHA-256. */
  verifyObjectSha256(
    command: Readonly<{
      bucket: string;
      key: string;
      versionId: string;
      expectedSha256: string;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ byteLength: number; sha256: string }>>;
  /** Returns owned bytes that remain unchanged and attached while artifact validation runs. */
  readObject(
    command: Readonly<{
      bucket: string;
      key: string;
      versionId: string;
      maximumBytes: number;
    }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ body: Uint8Array; sha256: string }>>;
  deleteObject(
    command: Readonly<{ bucket: string; key: string; versionId: string }>,
    signal: AbortSignal,
  ): Promise<void>;
}

export type BuildStatus =
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "FAULT"
  | "STOPPED"
  | "TIMED_OUT";

export interface BuildState {
  readonly buildId: string;
  readonly projectName: string;
  readonly status: BuildStatus;
  readonly startTime: Date;
  readonly operationId: string | null | undefined;
  readonly inputFingerprint: string | null | undefined;
  readonly usage: BuildUsage | null;
}

/** Runner-measured execution facts, not a credit charge or an invoice estimate. */
export interface BuildUsage {
  readonly runner: "cloudflare-build-sandbox";
  readonly instanceType: string;
  readonly status: Exclude<BuildStatus, "IN_PROGRESS">;
  /** ISO 8601 instant at which the build sandbox was requested. */
  readonly startedAt: string;
  /** ISO 8601 instant at which the customer build started inside the sandbox, if it ever did. */
  readonly provisioningStartedAt: string | null;
  /** ISO 8601 instant at which the build reached its terminal status. */
  readonly completedAt: string;
}

export interface BuildSourceObject {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface BuildOutputKeys {
  readonly bundleKey: string;
  readonly failureKey: string;
  readonly logKey: string;
}

export interface BuildStartCommand {
  readonly buildProject: string;
  /** Deterministic: `${buildProject}:${operationId}`. Starting the same id again is a replay. */
  readonly buildId: string;
  readonly idempotencyToken: string;
  readonly environment: readonly Readonly<{ name: string; value: string }>[];
  readonly source: BuildSourceObject;
  readonly outputs: BuildOutputKeys;
}

/**
 * The build runner that executes one build sandbox per build id. A rejection may carry
 * `retryable: true` (reads are retried) and a string `code`; the broker interprets
 * `BuildNotRunning` from `stopBuild` as a build that already reached a terminal status.
 * `batchGetBuilds` returns no entry for an id the runner has never started.
 */
export interface BuildExecutor {
  startBuild(
    command: BuildStartCommand,
    signal: AbortSignal,
  ): Promise<Readonly<{ buildId: string; projectName: string }>>;
  /** `bucket` is the build objects bucket of the builds; it names the build sandbox region. */
  batchGetBuilds(
    command: Readonly<{ buildIds: readonly string[]; bucket: string }>,
    signal: AbortSignal,
  ): Promise<readonly BuildState[]>;
  stopBuild(
    command: Readonly<{ buildId: string; bucket: string }>,
    signal: AbortSignal,
  ): Promise<Readonly<{ buildId: string; status: BuildStatus }>>;
}

export interface BuildBrokerDependencies {
  readonly objectStore: ObjectStore;
  readonly executor: BuildExecutor;
  readonly now: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly bucket: string;
  readonly buildProject: string;
  readonly requestTimeoutMs: number;
  readonly retryDelayMs: number;
  readonly maximumAttempts: number;
}

export interface ArchiveUploadReceipt {
  readonly bucket: string;
  readonly key: string;
  readonly uploadId: string;
  readonly scope: OperationScope;
}

export interface ArchivePartReceipt {
  readonly partNumber: number;
  readonly eTag: string;
  readonly checksumSha256: string;
}

export interface ArchiveObjectReceipt {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly eTag: string;
  readonly byteLength: number;
  readonly scope: OperationScope;
  readonly sourceSha256: string;
}

export interface BuildReceipt {
  readonly buildId: string;
  readonly projectName: string;
  readonly scope: OperationScope;
}

export interface BuildStartInput {
  readonly scope: OperationScope;
  readonly archive: ArchiveObjectReceipt;
  readonly deploymentId: string;
  readonly commitSha: string;
  readonly buildPlanSha256: string;
  readonly frameworkPlan: ProductionFrameworkPlan;
}

export async function fingerprintBuildStartInput(
  input: BuildStartInput,
): Promise<`sha256:${string}`> {
  return (await canonicalBuildStartInput(input)).fingerprint;
}

export interface BuildArtifactExpectation {
  readonly receipt: BuildReceipt;
  readonly deploymentId: string;
  readonly commitSha: string;
  readonly sourceSha256: string;
  readonly buildPlanSha256: string;
  readonly frameworkPlan: ProductionFrameworkPlan;
}

interface ArtifactProvenanceCommon {
  readonly scope: OperationScope;
  readonly deploymentId: string;
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly sourceDigest: `sha256:${string}`;
  readonly buildPlanDigest: `sha256:${string}`;
  readonly artifactDigest: `sha256:${string}`;
  readonly output: Readonly<{
    bucket: string;
    key: string;
    versionId: string;
    eTag: string;
    byteLength: number;
    sha256: string;
  }>;
}

type ArtifactProvenance = ArtifactProvenanceCommon &
  Readonly<{
    applicationRoot: ProductionFrameworkPlan["applicationRoot"];
    frameworkPlanSchemaVersion: typeof FRAMEWORK_PLAN_SCHEMA_VERSION;
    runtimePolicy: ProductionFrameworkPlan["runtimePolicy"];
    database: ProductionFrameworkPlan["database"];
    auth: ProductionFrameworkPlan["auth"];
    storage: ProductionFrameworkPlan["storage"];
    lifecycleEvidence: VerifiedBuildLifecycleEvidence;
    functions?: VerifiedFunctionsRequirement;
  }>;

export interface VerifiedBuildLifecycleEvidence {
  readonly configurationDigest: string;
  readonly frozenInstall: Readonly<{
    packageManager: string;
    packageManagerVersion: string;
    lockfile: string;
    lockfileSha256: string;
    installCommandSha256: string;
    dependencyInventorySha256: string;
  }>;
  readonly frameworkBuild: Readonly<{
    framework: string;
    runtime: "static" | "edge" | "functions";
    buildCommandSha256: string;
    frameworkPlanSha256: string;
    buildOutputSha256: string;
  }>;
  readonly buildSandbox: Readonly<{
    buildId: string;
    projectName: string;
    buildInputFingerprint: string;
    sourceArchiveSha256: string;
    terminalStatus: "SUCCEEDED";
  }>;
  readonly credentialScan: Readonly<{
    scannerSha256: string;
    rulesSha256: string;
    findingsCount: 0;
  }>;
}

/** Declared crons carried by the artifact; the Worker module's scheduled handler receives them. */
export interface VerifiedFunctionsRequirement {
  readonly crons: readonly string[];
}

export interface VerifiedArtifactBundle {
  readonly manifestDigest: `sha256:${string}`;
  readonly manifestBody: Uint8Array;
  readonly sbomBody: Uint8Array;
  readonly files: readonly Readonly<{ path: string; body: Uint8Array }>[];
  readonly runtime: VerifiedArtifactRuntime | null;
  readonly modules: readonly VerifiedArtifactModule[];
  readonly migrations: readonly VerifiedArtifactMigration[];
  readonly provenance: ArtifactProvenance;
}

export interface VerifiedArtifactRuntime {
  readonly kind: "cloudflare-worker";
  readonly mainModule: "index.js";
  readonly compatibilityDate: string;
  readonly compatibilityFlags: readonly ["nodejs_compat"];
  readonly ssgCacheMaxBytes?: number;
  readonly nextRevalidatePath?: true;
  readonly entryWrapperVersion:
    | "nextjs-opennext-wrapper-v1"
    | "astro-edge-wrapper-v1"
    | "tanstack-edge-wrapper-v1"
    | "vite-api-companion-v1"
    | "functions-v1";
}

export interface VerifiedArtifactModule {
  readonly path: string;
  readonly contentType:
    | "application/javascript+module"
    | "application/wasm"
    | "application/octet-stream";
  readonly digest: `sha256:${string}`;
  readonly size: number;
  readonly body: Uint8Array;
}

export interface VerifiedArtifactMigration {
  readonly path: string;
  readonly digest: `sha256:${string}`;
  readonly size: number;
  readonly body: Uint8Array;
}

export interface VerifiedArtifactObjectInput {
  /** Owned bytes must remain unchanged and attached until validation settles; shared bytes are snapshotted. */
  readonly body: Uint8Array;
  readonly expectedProvenance: VerifiedArtifactBundle["provenance"];
}

/**
 * Re-validates an immutable build bundle after a different trusted runtime has
 * read its exact object version. This keeps the Workers for Platforms upload
 * boundary on the same artifact contract as the build broker.
 */
export async function parseVerifiedArtifactBundle(
  input: VerifiedArtifactObjectInput,
): Promise<VerifiedArtifactBundle> {
  if (!isRecord(input) || !(input.body instanceof Uint8Array)) {
    throw new BuildBrokerInputError();
  }
  assertOnlyKeys(input, ["body", "expectedProvenance"]);
  const provenance = input.expectedProvenance;
  if (!isRecord(provenance) || !isRecord(provenance.output)) {
    throw new BuildBrokerInputError();
  }
  assertOnlyKeys(provenance, [
    "scope",
    "deploymentId",
    "buildId",
    "sourceCommit",
    "sourceDigest",
    "buildPlanDigest",
    "artifactDigest",
    "output",
    "applicationRoot",
    "frameworkPlanSchemaVersion",
    "runtimePolicy",
    "database",
    "auth",
    "storage",
    "lifecycleEvidence",
    ...(Object.hasOwn(provenance, "functions") ? ["functions"] : []),
  ]);
  assertOnlyKeys(provenance.output, ["bucket", "key", "versionId", "eTag", "byteLength", "sha256"]);
  validateScope(provenance.scope);
  validateOpaque(provenance.buildId);
  validateOpaque(provenance.output.versionId);
  validateEtag(provenance.output.eTag);
  let applicationRoot: ProductionFrameworkPlan["applicationRoot"];
  try {
    applicationRoot = normalizeApplicationRoot(provenance.applicationRoot);
  } catch {
    throw new BuildBrokerConflictError();
  }
  if (
    !ULID_PATTERN.test(provenance.deploymentId) ||
    !COMMIT_SHA_PATTERN.test(provenance.sourceCommit) ||
    !isPrefixedDigest(provenance.sourceDigest) ||
    !isPrefixedDigest(provenance.buildPlanDigest) ||
    provenance.frameworkPlanSchemaVersion !== FRAMEWORK_PLAN_SCHEMA_VERSION ||
    !isPrefixedDigest(provenance.artifactDigest) ||
    !SAFE_NAME_PATTERN.test(provenance.output.bucket) ||
    provenance.output.key !== operationPaths(provenance.scope).bundleKey ||
    !Number.isSafeInteger(provenance.output.byteLength) ||
    provenance.output.byteLength <= 0 ||
    provenance.output.byteLength > MAX_BUNDLE_BYTES ||
    !SHA256_PATTERN.test(provenance.output.sha256) ||
    input.body.byteLength !== provenance.output.byteLength
  ) {
    throw new BuildBrokerConflictError();
  }
  const body = arrayBufferView(input.body);
  const bodySha256 = (await prefixedDigest(body)).slice("sha256:".length);
  if (bodySha256 !== provenance.output.sha256) throw new BuildBrokerConflictError();
  const parsed = await parseVerifiedBundle(
    {
      receipt: {
        buildId: provenance.buildId,
        projectName: provenance.lifecycleEvidence.buildSandbox.projectName,
        scope: provenance.scope,
      },
      deploymentId: provenance.deploymentId,
      commitSha: provenance.sourceCommit,
      sourceSha256: provenance.sourceDigest.slice("sha256:".length),
      buildPlanSha256: provenance.buildPlanDigest.slice("sha256:".length),
      applicationRoot,
      runtimePolicy: parseRuntimePolicyEvidence(provenance.runtimePolicy),
      database: parseDatabaseEvidence(provenance.database),
      auth: parseCustomerAuthEvidence(provenance.auth),
      storage: parseStorageEvidence(provenance.storage),
      frameworkAdapter: frameworkAdapterFromLifecycle(provenance.lifecycleEvidence),
      frameworkRuntime: provenance.lifecycleEvidence.frameworkBuild.runtime,
      nextCacheAuthority: { kind: "verified-artifact", artifactDigest: provenance.artifactDigest },
      ...(Object.hasOwn(provenance, "functions")
        ? { functions: planFunctionsFromVerified(provenance.functions) }
        : {}),
      frameworkPlanSchemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
    },
    {
      versionId: provenance.output.versionId,
      eTag: provenance.output.eTag,
      byteLength: provenance.output.byteLength,
      metadata: {},
    },
    provenance.output.bucket,
    provenance.output.key,
    { body, sha256: bodySha256 },
  );
  if (parsed.provenance.artifactDigest !== provenance.artifactDigest) {
    throw new BuildBrokerConflictError();
  }
  return parsed;
}

/** Where the isolated build leaves the Worker module of each runtime. */
function buildServerOutput(frameworkPlan: ProductionFrameworkPlan): Readonly<{
  outputDirectory: string;
  entryPoint: string;
  configPath: string;
  compatibilityDate: string;
  compatibilityFlags: string;
}> {
  if (frameworkPlan.runtime === "functions") {
    return Object.freeze({
      outputDirectory: ".ohmyhost/functions",
      entryPoint: ".ohmyhost/functions/worker.js",
      configPath: ".ohmyhost/functions/wrangler.jsonc",
      compatibilityDate: frameworkPlan.compatibilityDate,
      compatibilityFlags: frameworkPlan.compatibilityFlags.join(","),
    });
  }
  if (frameworkPlan.runtime === "static") {
    return Object.freeze({
      outputDirectory: "",
      entryPoint: "",
      configPath: "",
      compatibilityDate: "",
      compatibilityFlags: "",
    });
  }
  return Object.freeze({
    outputDirectory: frameworkPlan.serverOutputDirectory,
    entryPoint: frameworkPlan.serverEntryPoint,
    configPath: frameworkPlan.serverConfigPath,
    compatibilityDate: frameworkPlan.compatibilityDate,
    compatibilityFlags: frameworkPlan.compatibilityFlags.join(","),
  });
}

function frameworkAdapterFromLifecycle(
  evidence: VerifiedBuildLifecycleEvidence,
): ProductionFrameworkPlan["adapter"] {
  if (evidence.frameworkBuild.framework === "vite") return "vite-static";
  if (
    evidence.frameworkBuild.framework === "astro" ||
    evidence.frameworkBuild.framework === "tanstack-start" ||
    evidence.frameworkBuild.framework === "nextjs" ||
    evidence.frameworkBuild.framework === "functions"
  ) {
    return evidence.frameworkBuild.framework;
  }
  throw new BuildBrokerConflictError();
}

export interface ArtifactAbsenceReceipt {
  readonly state: "absent";
  readonly scope: OperationScope;
  readonly key: string;
  readonly versionId: string;
}

export type ArchiveAbsenceReceipt = ArtifactAbsenceReceipt;

export interface ArtifactObjectReceipt {
  readonly bucket: string;
  readonly key: string;
  readonly versionId: string;
  readonly scope: OperationScope;
}

/** The customer-visible tail of a failed build, sanitized and bounded by the build runtime. */
export interface BuildFailureExcerpt {
  readonly excerpt: string;
  readonly truncated: boolean;
}

export interface BuildObservation extends BuildReceipt {
  readonly status: "running" | "succeeded" | "failed" | "stopped";
  readonly usage: BuildUsage | null;
  /** Present only for a failed or stopped build whose runtime uploaded an excerpt. */
  readonly failure: BuildFailureExcerpt | null;
}

export interface BuildBroker {
  beginArchive(input: Readonly<{ scope: OperationScope }>): Promise<ArchiveUploadReceipt>;
  uploadArchivePart(
    input: Readonly<{
      upload: ArchiveUploadReceipt;
      partNumber: number;
      body: Uint8Array;
      checksumSha256: string;
    }>,
  ): Promise<ArchivePartReceipt>;
  completeArchive(
    input: Readonly<{
      upload: ArchiveUploadReceipt;
      parts: readonly ArchivePartReceipt[];
      byteLength: number;
      sourceSha256: string;
    }>,
  ): Promise<ArchiveObjectReceipt>;
  abortArchive(upload: ArchiveUploadReceipt): Promise<void>;
  observeArchive(
    input: Readonly<{ scope: OperationScope; sourceSha256: string }>,
  ): Promise<ArchiveObjectReceipt | null>;
  removeArchive(archive: ArchiveObjectReceipt): Promise<ArchiveAbsenceReceipt>;
  startBuild(input: Readonly<BuildStartInput>): Promise<BuildReceipt>;
  readBuild(receipt: BuildReceipt): Promise<BuildObservation>;
  stopBuild(receipt: BuildReceipt): Promise<void>;
  observeBuildArtifact(input: BuildArtifactExpectation): Promise<VerifiedArtifactBundle | null>;
  readBuildArtifact(input: BuildArtifactExpectation): Promise<VerifiedArtifactBundle>;
  removeBuildArtifact(artifact: VerifiedArtifactBundle): Promise<ArtifactAbsenceReceipt>;
  removeBuildArtifactObject(artifact: ArtifactObjectReceipt): Promise<ArtifactAbsenceReceipt>;
}

export type BuildStartObservation =
  | Readonly<{ state: "found"; receipt: BuildReceipt }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "unknown" }>;

export interface RecoverableBuildBroker extends BuildBroker {
  observeBuildStart(
    input: Readonly<BuildStartInput>,
    reservationCreatedAt: Date,
  ): Promise<BuildStartObservation>;
}

export function createBuildBroker(dependencies: BuildBrokerDependencies): RecoverableBuildBroker {
  validateDependencies(dependencies);

  async function readBuildFailure(scope: OperationScope): Promise<BuildFailureExcerpt | null> {
    const key = operationPaths(scope).failureKey;
    const state = await timed(
      dependencies,
      (signal) => dependencies.objectStore.headObject({ bucket: dependencies.bucket, key }, signal),
      "read",
    );
    if (state === null) return null;
    validateObjectState(state);
    if (state.byteLength > MAX_BUILD_FAILURE_BYTES) return null;
    const object = await timed(
      dependencies,
      (signal) =>
        dependencies.objectStore.readObject(
          {
            bucket: dependencies.bucket,
            key,
            versionId: state.versionId,
            maximumBytes: MAX_BUILD_FAILURE_BYTES,
          },
          signal,
        ),
      "read",
    );
    if (object.body.byteLength !== state.byteLength) throw new BuildBrokerConflictError();
    return parseBuildFailureExcerpt(object.body, scope.operationId);
  }

  async function observeArchiveObject(
    input: Readonly<{ scope: OperationScope; sourceSha256: string }>,
  ): Promise<ArchiveObjectReceipt | null> {
    validateDigest(input.sourceSha256);
    const paths = operationPaths(input.scope);
    const state = await timed(
      dependencies,
      (signal) =>
        dependencies.objectStore.headObject(
          { bucket: dependencies.bucket, key: paths.inputKey },
          signal,
        ),
      "read",
    );
    if (state === null) return null;
    validateObjectState(state);
    if (state.metadata["operation"] !== input.scope.operationId) {
      throw new BuildBrokerConflictError();
    }
    const receipt = Object.freeze({
      bucket: dependencies.bucket,
      key: paths.inputKey,
      versionId: state.versionId,
      eTag: state.eTag,
      byteLength: state.byteLength,
      scope: freezeScope(input.scope),
      sourceSha256: input.sourceSha256,
    });
    await verifyExactObject(dependencies, receipt);
    return receipt;
  }

  const broker: RecoverableBuildBroker = {
    async beginArchive(input: Readonly<{ scope: OperationScope }>) {
      assertOnlyKeys(input, ["scope"]);
      const paths = operationPaths(input.scope);
      const committed = await timed(
        dependencies,
        (signal) =>
          dependencies.objectStore.headObject(
            { bucket: dependencies.bucket, key: paths.inputKey },
            signal,
          ),
        "read",
      );
      if (committed !== null) throw new BuildBrokerConflictError();
      const pending = await timed(
        dependencies,
        (signal) =>
          dependencies.objectStore.listMultipartUploads(
            { bucket: dependencies.bucket, key: paths.inputKey },
            signal,
          ),
        "read",
      );
      if (pending.length > 1) throw new BuildBrokerConflictError();
      const replay = pending[0];
      if (replay !== undefined) {
        throw new BuildBrokerUncertainError();
      }
      try {
        const result = await timed(
          dependencies,
          (signal) =>
            dependencies.objectStore.createMultipartUpload(
              {
                bucket: dependencies.bucket,
                key: paths.inputKey,
                contentType: "application/gzip",
                metadata: { operation: input.scope.operationId },
              },
              signal,
            ),
          "mutation",
        );
        validateOpaque(result.uploadId);
        return Object.freeze({
          bucket: dependencies.bucket,
          key: paths.inputKey,
          uploadId: result.uploadId,
          scope: freezeScope(input.scope),
        });
      } catch (error) {
        if (error instanceof BuildBrokerInputError) throw error;
        throw new BuildBrokerUncertainError();
      }
    },

    async uploadArchivePart(
      input: Readonly<{
        upload: ArchiveUploadReceipt;
        partNumber: number;
        body: Uint8Array;
        checksumSha256: string;
      }>,
    ) {
      assertOnlyKeys(input, ["upload", "partNumber", "body", "checksumSha256"]);
      validateUploadReceipt(input.upload, dependencies.bucket);
      validateDigest(input.checksumSha256);
      if (
        !Number.isSafeInteger(input.partNumber) ||
        input.partNumber < 1 ||
        input.partNumber > 10_000 ||
        !(input.body instanceof Uint8Array) ||
        input.body.byteLength === 0
      ) {
        throw new BuildBrokerInputError();
      }
      let result: Readonly<{ eTag: string }>;
      try {
        result = await timed(
          dependencies,
          (signal) =>
            dependencies.objectStore.uploadPart(
              {
                bucket: input.upload.bucket,
                key: input.upload.key,
                uploadId: input.upload.uploadId,
                partNumber: input.partNumber,
                body: input.body,
                checksumSha256: input.checksumSha256,
              },
              signal,
            ),
          "mutation",
        );
      } catch {
        throw new BuildBrokerUncertainError();
      }
      validateEtag(result.eTag);
      return Object.freeze({
        partNumber: input.partNumber,
        eTag: result.eTag,
        checksumSha256: input.checksumSha256,
      });
    },

    async completeArchive(
      input: Readonly<{
        upload: ArchiveUploadReceipt;
        parts: readonly ArchivePartReceipt[];
        byteLength: number;
        sourceSha256: string;
      }>,
    ) {
      assertOnlyKeys(input, ["upload", "parts", "byteLength", "sourceSha256"]);
      validateUploadReceipt(input.upload, dependencies.bucket);
      validateParts(input.parts);
      validateDigest(input.sourceSha256);
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
        throw new BuildBrokerInputError();
      }
      let result: Readonly<{ versionId: string; eTag: string }>;
      try {
        result = await timed(
          dependencies,
          (signal) =>
            dependencies.objectStore.completeMultipartUpload(
              {
                bucket: input.upload.bucket,
                key: input.upload.key,
                uploadId: input.upload.uploadId,
                parts: input.parts.map(({ partNumber, eTag, checksumSha256 }) => ({
                  partNumber,
                  eTag,
                  checksumSha256,
                })),
              },
              signal,
            ),
          "mutation",
        );
      } catch {
        let observed: ArchiveObjectReceipt | null;
        try {
          observed = await observeArchiveObject({
            scope: input.upload.scope,
            sourceSha256: input.sourceSha256,
          });
        } catch (error) {
          if (error instanceof BuildBrokerConflictError) throw error;
          observed = null;
        }
        if (observed !== null && observed.byteLength === input.byteLength) return observed;
        throw new BuildBrokerUncertainError();
      }
      validateOpaque(result.versionId);
      validateEtag(result.eTag);
      const receipt = Object.freeze({
        bucket: input.upload.bucket,
        key: input.upload.key,
        versionId: result.versionId,
        eTag: result.eTag,
        byteLength: input.byteLength,
        scope: freezeScope(input.upload.scope),
        sourceSha256: input.sourceSha256,
      });
      await verifyExactObject(dependencies, receipt);
      return receipt;
    },

    async abortArchive(upload: ArchiveUploadReceipt) {
      validateUploadReceipt(upload, dependencies.bucket);
      try {
        await timed(
          dependencies,
          (signal) =>
            dependencies.objectStore.abortMultipartUpload(
              { bucket: upload.bucket, key: upload.key, uploadId: upload.uploadId },
              signal,
            ),
          "mutation",
        );
      } catch (error) {
        if (providerCode(error) === "NoSuchUpload") return;
        throw new BuildBrokerUncertainError();
      }
    },

    async observeArchive(input: Readonly<{ scope: OperationScope; sourceSha256: string }>) {
      assertOnlyKeys(input, ["scope", "sourceSha256"]);
      return observeArchiveObject(input);
    },

    async removeArchive(archive: ArchiveObjectReceipt) {
      validateObjectReceipt(archive, dependencies.bucket);
      const command = {
        bucket: archive.bucket,
        key: archive.key,
        versionId: archive.versionId,
      };
      let before: StoredObjectState | null = null;
      try {
        before = await timed(
          dependencies,
          (signal) => dependencies.objectStore.headObject(command, signal),
          "read",
        );
      } catch (error) {
        if (!(error instanceof ProviderSignal) || error.providerCode !== "HTTP403") throw error;
      }
      if (before !== null) validateArchiveState(before, archive);
      try {
        await timed(
          dependencies,
          (signal) => dependencies.objectStore.deleteObject(command, signal),
          "mutation",
        );
      } catch {
        try {
          const observed = await timed(
            dependencies,
            (signal) => dependencies.objectStore.headObject(command, signal),
            "read",
          );
          if (observed !== null) throw new BuildBrokerUncertainError();
        } catch {
          throw new BuildBrokerUncertainError();
        }
      }
      return Object.freeze({
        state: "absent" as const,
        scope: freezeScope(archive.scope),
        key: archive.key,
        versionId: archive.versionId,
      });
    },

    async startBuild(input: Readonly<BuildStartInput>) {
      const canonical = await canonicalBuildStartInput(input);
      validateObjectReceipt(input.archive, dependencies.bucket);
      const frameworkPlan = canonical.frameworkPlan;
      const paths = operationPaths(input.scope);
      const buildId = deterministicBuildId(dependencies.buildProject, input.scope);
      const serverOutput = buildServerOutput(frameworkPlan);
      try {
        const result = await timed(
          dependencies,
          (signal) =>
            dependencies.executor.startBuild(
              {
                buildProject: dependencies.buildProject,
                buildId,
                idempotencyToken: `oh-${input.scope.operationId}-${input.buildPlanSha256.slice(0, 32)}`,
                environment: [
                  { name: "BUILD_INPUT_FINGERPRINT", value: canonical.fingerprint },
                  { name: "BUILD_ID", value: buildId },
                  { name: "EXPECTED_SOURCE_SHA256", value: input.archive.sourceSha256 },
                  { name: "BUILD_PLAN_SHA256", value: input.buildPlanSha256 },
                  { name: "APPLICATION_ROOT", value: frameworkPlan.applicationRoot },
                  { name: "INSTALL_COMMAND", value: frameworkPlan.installCommand },
                  { name: "BUILD_COMMAND", value: frameworkPlan.buildCommand ?? "" },
                  {
                    name: "RUNTIME_POLICY_JSON",
                    value: JSON.stringify(frameworkPlan.runtimePolicy),
                  },
                  {
                    name: "DATABASE_REQUIREMENT_JSON",
                    value: JSON.stringify(frameworkPlan.database),
                  },
                  { name: "AUTH_REQUIREMENT_JSON", value: JSON.stringify(frameworkPlan.auth) },
                  { name: "MAIL_REQUIREMENT_JSON", value: JSON.stringify(frameworkPlan.mail) },
                  {
                    name: "STORAGE_REQUIREMENT_JSON",
                    value: JSON.stringify(frameworkPlan.storage),
                  },
                  {
                    name: "FUNCTIONS_REQUIREMENT_JSON",
                    value:
                      frameworkPlan.functions === undefined
                        ? ""
                        : JSON.stringify(frameworkPlan.functions),
                  },
                  { name: "FRAMEWORK_ADAPTER", value: frameworkPlan.adapter },
                  { name: "FRAMEWORK_RUNTIME", value: frameworkPlan.runtime },
                  ...(frameworkPlan.adapter === "nextjs"
                    ? [
                        {
                          name: "SSG_CACHE_MAX_BYTES",
                          value: String(
                            frameworkPlan.ssgCacheMaxBytes ?? DEFAULT_SSG_CACHE_MAX_BYTES,
                          ),
                        },
                      ]
                    : []),
                  ...(frameworkPlan.adapter === "nextjs" &&
                  frameworkPlan.nextRevalidatePath === true
                    ? [{ name: "NEXT_REVALIDATE_PATH", value: "1" }]
                    : []),
                  { name: "BUILD_OUTPUT_DIRECTORY", value: frameworkPlan.outputDirectory ?? "" },
                  { name: "SERVER_OUTPUT_DIRECTORY", value: serverOutput.outputDirectory },
                  { name: "SERVER_ENTRYPOINT", value: serverOutput.entryPoint },
                  { name: "SERVER_CONFIG_PATH", value: serverOutput.configPath },
                  { name: "COMPATIBILITY_DATE", value: serverOutput.compatibilityDate },
                  { name: "COMPATIBILITY_FLAGS", value: serverOutput.compatibilityFlags },
                  { name: "SOURCE_COMMIT_SHA", value: input.commitSha },
                  { name: "PROJECT_ID", value: input.scope.projectId },
                  { name: "ENVIRONMENT_ID", value: input.scope.environmentId },
                  { name: "DEPLOYMENT_ID", value: input.deploymentId },
                  { name: "OPERATION_ID", value: input.scope.operationId },
                ],
                source: {
                  bucket: input.archive.bucket,
                  key: input.archive.key,
                  versionId: input.archive.versionId,
                  sha256: input.archive.sourceSha256,
                  byteLength: input.archive.byteLength,
                },
                outputs: {
                  bundleKey: paths.bundleKey,
                  failureKey: paths.failureKey,
                  logKey: paths.logKey,
                },
              },
              signal,
            ),
          "mutation",
        );
        if (result.buildId !== buildId || result.projectName !== dependencies.buildProject) {
          throw new BuildBrokerConflictError();
        }
        return buildReceipt(dependencies.buildProject, input.scope, buildId);
      } catch {
        throw new BuildBrokerUncertainError();
      }
    },

    async observeBuildStart(input: Readonly<BuildStartInput>, reservationCreatedAt: Date) {
      const canonical = await canonicalBuildStartInput(input);
      validateObjectReceipt(input.archive, dependencies.bucket);
      if (!(reservationCreatedAt instanceof Date)) {
        throw new BuildBrokerInputError();
      }
      const reservationTime = reservationCreatedAt.getTime();
      if (!Number.isFinite(reservationTime)) throw new BuildBrokerInputError();
      try {
        return await observeStartedBuild(
          dependencies,
          input.scope,
          canonical.fingerprint,
          reservationTime,
        );
      } catch (error) {
        if (error instanceof BuildBrokerInputError || error instanceof BuildBrokerConflictError) {
          throw error;
        }
        return Object.freeze({ state: "unknown" as const });
      }
    },

    async readBuild(receipt: BuildReceipt) {
      validateBuildReceipt(receipt, dependencies.buildProject);
      const state = await findBuild(dependencies, receipt.scope, receipt.buildId);
      if (state === null || state.buildId !== receipt.buildId) throw new BuildBrokerConflictError();
      const status = mapStatus(state.status);
      const failure =
        status === "failed" || status === "stopped" ? await readBuildFailure(receipt.scope) : null;
      return Object.freeze({ ...receipt, status, usage: state.usage, failure });
    },

    async stopBuild(receipt: BuildReceipt) {
      validateBuildReceipt(receipt, dependencies.buildProject);
      try {
        const result = await timed(
          dependencies,
          (signal) =>
            dependencies.executor.stopBuild(
              { buildId: receipt.buildId, bucket: dependencies.bucket },
              signal,
            ),
          "mutation",
        );
        if (result.buildId !== receipt.buildId) throw new BuildBrokerConflictError();
      } catch (error) {
        if (providerCode(error) === "BuildNotRunning") return;
        if (error instanceof BuildBrokerConflictError) throw error;
        const state = await findBuild(dependencies, receipt.scope, receipt.buildId);
        if (state?.status === "STOPPED") return;
        throw new BuildBrokerUncertainError();
      }
    },

    async observeBuildArtifact(input: BuildArtifactExpectation) {
      const expectation = await validateArtifactExpectation(input, dependencies.buildProject);
      const key = operationPaths(input.receipt.scope).bundleKey;
      const state = await timed(
        dependencies,
        (signal) =>
          dependencies.objectStore.headObject({ bucket: dependencies.bucket, key }, signal),
        "read",
      );
      if (state === null) return null;
      validateObjectState(state);
      if (state.byteLength > MAX_BUNDLE_BYTES) throw new BuildBrokerConflictError();
      const object = await timed(
        dependencies,
        (signal) =>
          dependencies.objectStore.readObject(
            {
              bucket: dependencies.bucket,
              key,
              versionId: state.versionId,
              maximumBytes: MAX_BUNDLE_BYTES,
            },
            signal,
          ),
        "read",
      );
      if (object.body.byteLength !== state.byteLength || !SHA256_PATTERN.test(object.sha256)) {
        throw new BuildBrokerConflictError();
      }
      return parseVerifiedBundle(expectation, state, dependencies.bucket, key, object);
    },

    async readBuildArtifact(input: BuildArtifactExpectation) {
      const artifact = await broker.observeBuildArtifact(input);
      if (artifact === null) throw new BuildBrokerUncertainError();
      return artifact;
    },

    async removeBuildArtifact(artifact: VerifiedArtifactBundle) {
      validateVerifiedArtifactReceipt(artifact, dependencies.bucket);
      const expected = artifact.provenance.output;
      const latest = await timed(
        dependencies,
        (signal) =>
          dependencies.objectStore.headObject(
            { bucket: expected.bucket, key: expected.key },
            signal,
          ),
        "read",
      );
      if (latest !== null && latest.versionId !== expected.versionId) {
        throw new BuildBrokerConflictError();
      }
      if (latest !== null) {
        try {
          await timed(
            dependencies,
            (signal) =>
              dependencies.objectStore.deleteObject(
                { bucket: expected.bucket, key: expected.key, versionId: expected.versionId },
                signal,
              ),
            "mutation",
          );
        } catch {
          const observed = await timed(
            dependencies,
            (signal) =>
              dependencies.objectStore.headObject(
                { bucket: expected.bucket, key: expected.key, versionId: expected.versionId },
                signal,
              ),
            "read",
          );
          if (observed !== null) throw new BuildBrokerUncertainError();
        }
      }
      const exact = await timed(
        dependencies,
        (signal) =>
          dependencies.objectStore.headObject(
            { bucket: expected.bucket, key: expected.key, versionId: expected.versionId },
            signal,
          ),
        "read",
      );
      const remaining = await timed(
        dependencies,
        (signal) =>
          dependencies.objectStore.headObject(
            { bucket: expected.bucket, key: expected.key },
            signal,
          ),
        "read",
      );
      if (exact !== null || remaining !== null) throw new BuildBrokerConflictError();
      return Object.freeze({
        state: "absent" as const,
        scope: freezeScope(artifact.provenance.scope),
        key: expected.key,
        versionId: expected.versionId,
      });
    },

    async removeBuildArtifactObject(artifact: ArtifactObjectReceipt) {
      validateArtifactObjectReceipt(artifact, dependencies.bucket);
      const exactCommand = {
        bucket: artifact.bucket,
        key: artifact.key,
        versionId: artifact.versionId,
      };
      let before: StoredObjectState | null = null;
      try {
        before = await timed(
          dependencies,
          (signal) => dependencies.objectStore.headObject(exactCommand, signal),
          "read",
        );
      } catch (error) {
        if (!(error instanceof ProviderSignal) || error.providerCode !== "HTTP403") throw error;
      }
      if (before !== null) {
        validateObjectState(before);
        if (before.versionId !== artifact.versionId) throw new BuildBrokerConflictError();
      }
      try {
        await timed(
          dependencies,
          (signal) => dependencies.objectStore.deleteObject(exactCommand, signal),
          "mutation",
        );
      } catch {
        try {
          const observed = await timed(
            dependencies,
            (signal) => dependencies.objectStore.headObject(exactCommand, signal),
            "read",
          );
          if (observed !== null) throw new BuildBrokerUncertainError();
        } catch {
          throw new BuildBrokerUncertainError();
        }
      }
      return Object.freeze({
        state: "absent" as const,
        scope: freezeScope(artifact.scope),
        key: artifact.key,
        versionId: artifact.versionId,
      });
    },
  };
  return Object.freeze(broker);
}

async function canonicalBuildStartInput(input: BuildStartInput): Promise<
  Readonly<{
    frameworkPlan: ProductionFrameworkPlan;
    fingerprint: `sha256:${string}`;
  }>
> {
  assertOnlyKeys(input, [
    "scope",
    "archive",
    "deploymentId",
    "commitSha",
    "buildPlanSha256",
    "frameworkPlan",
  ]);
  validateScope(input.scope);
  validatePortableArchiveReceipt(input.archive);
  if (!sameScope(input.scope, input.archive.scope)) throw new BuildBrokerConflictError();
  if (!ULID_PATTERN.test(input.deploymentId) || !COMMIT_SHA_PATTERN.test(input.commitSha)) {
    throw new BuildBrokerInputError();
  }
  validateDigest(input.buildPlanSha256);
  let frameworkPlan: ProductionFrameworkPlan;
  try {
    frameworkPlan = parseNewProductionFrameworkPlan(input.frameworkPlan);
  } catch {
    throw new BuildBrokerInputError();
  }
  const frameworkPlanPreimage = serializeNewProductionFrameworkPlanPreimage(frameworkPlan);
  const recomputedBuildPlanSha256 = (
    await prefixedDigest(new TextEncoder().encode(frameworkPlanPreimage))
  ).slice("sha256:".length);
  if (recomputedBuildPlanSha256 !== input.buildPlanSha256) {
    throw new BuildBrokerConflictError();
  }
  const fingerprint = await prefixedDigest(
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: "ohmyhost.build-start-input/v1",
        scope: {
          projectId: input.scope.projectId,
          environmentId: input.scope.environmentId,
          operationId: input.scope.operationId,
        },
        archive: {
          bucket: input.archive.bucket,
          key: input.archive.key,
          versionId: input.archive.versionId,
          eTag: input.archive.eTag,
          byteLength: input.archive.byteLength,
          sourceSha256: input.archive.sourceSha256,
        },
        deploymentId: input.deploymentId,
        commitSha: input.commitSha,
        buildPlanSha256: input.buildPlanSha256,
        frameworkPlan: JSON.parse(frameworkPlanPreimage),
      }),
    ),
  );
  return Object.freeze({ frameworkPlan, fingerprint });
}

function validatePortableArchiveReceipt(receipt: ArchiveObjectReceipt): void {
  assertOnlyKeys(receipt, [
    "bucket",
    "key",
    "versionId",
    "eTag",
    "byteLength",
    "scope",
    "sourceSha256",
  ]);
  validateScope(receipt.scope);
  validateDigest(receipt.sourceSha256);
  validateOpaque(receipt.versionId);
  validateEtag(receipt.eTag);
  if (
    !SAFE_NAME_PATTERN.test(receipt.bucket) ||
    receipt.key !== operationPaths(receipt.scope).inputKey ||
    !Number.isSafeInteger(receipt.byteLength) ||
    receipt.byteLength <= 0
  ) {
    throw new BuildBrokerInputError();
  }
}

async function verifyExactObject(
  dependencies: BuildBrokerDependencies,
  receipt: ArchiveObjectReceipt,
): Promise<void> {
  const verified = await timed(
    dependencies,
    (signal) =>
      dependencies.objectStore.verifyObjectSha256(
        {
          bucket: receipt.bucket,
          key: receipt.key,
          versionId: receipt.versionId,
          expectedSha256: receipt.sourceSha256,
        },
        signal,
      ),
    "read",
  );
  if (
    !Number.isSafeInteger(verified.byteLength) ||
    verified.byteLength !== receipt.byteLength ||
    !SHA256_PATTERN.test(verified.sha256) ||
    verified.sha256 !== receipt.sourceSha256
  ) {
    throw new BuildBrokerConflictError();
  }
}

interface ParsedBuildManifest {
  readonly projectId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly operationId: string;
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly sourceDigest: `sha256:${string}`;
  readonly buildPlanDigest: `sha256:${string}`;
  readonly applicationRoot: ProductionFrameworkPlan["applicationRoot"];
  readonly frameworkPlanSchemaVersion: typeof FRAMEWORK_PLAN_SCHEMA_VERSION;
  readonly runtimePolicy: ProductionFrameworkPlan["runtimePolicy"];
  readonly database: ProductionFrameworkPlan["database"];
  readonly auth: ProductionFrameworkPlan["auth"];
  readonly storage: ProductionFrameworkPlan["storage"];
  readonly lifecycleEvidence: VerifiedBuildLifecycleEvidence;
  readonly functions?: VerifiedFunctionsRequirement;
  readonly artifactDigest: `sha256:${string}`;
  readonly sbom: Readonly<{ path: "sbom.cdx.json"; digest: `sha256:${string}` }>;
  readonly assets: readonly Readonly<{ path: string; digest: `sha256:${string}`; size: number }>[];
  readonly runtime: VerifiedArtifactRuntime | null;
  readonly modules: readonly Omit<VerifiedArtifactModule, "body">[];
  readonly migrations: readonly Omit<VerifiedArtifactMigration, "body">[];
}

interface ArtifactPlanEvidence {
  readonly receipt: BuildReceipt;
  readonly deploymentId: string;
  readonly commitSha: string;
  readonly sourceSha256: string;
  readonly buildPlanSha256: string;
  readonly applicationRoot: ProductionFrameworkPlan["applicationRoot"];
  readonly frameworkPlanSchemaVersion: typeof FRAMEWORK_PLAN_SCHEMA_VERSION;
  readonly runtimePolicy: ProductionFrameworkPlan["runtimePolicy"];
  readonly database: ProductionFrameworkPlan["database"];
  readonly auth: ProductionFrameworkPlan["auth"];
  readonly storage: ProductionFrameworkPlan["storage"];
  readonly frameworkAdapter: ProductionFrameworkPlan["adapter"];
  readonly frameworkRuntime: ProductionFrameworkPlan["runtime"];
  readonly ssgCacheMaxBytes?: number;
  // Initial admission uses the plan; a re-read instead pins the complete artifact including its runtime.
  readonly nextCacheAuthority:
    | Readonly<{ kind: "plan"; enabled: boolean }>
    | Readonly<{ kind: "verified-artifact"; artifactDigest: `sha256:${string}` }>;
  readonly functions?: FunctionsRequirement;
}

async function parseVerifiedBundle(
  expectation: ArtifactPlanEvidence,
  state: StoredObjectState,
  bucket: string,
  key: string,
  object: Readonly<{ body: Uint8Array; sha256: string }>,
): Promise<VerifiedArtifactBundle> {
  const files = await readTarGzip(object.body);
  const manifestBody = files.get("manifest.json");
  const sbomBody = files.get("sbom.cdx.json");
  if (
    manifestBody === undefined ||
    sbomBody === undefined ||
    manifestBody.byteLength > MAX_MANIFEST_BYTES
  ) {
    throw new BuildBrokerConflictError();
  }
  const manifest = await parseBuildManifest(manifestBody, expectation);
  if ((await prefixedDigest(sbomBody)) !== manifest.sbom.digest) {
    throw new BuildBrokerConflictError();
  }
  validateCycloneDx(sbomBody);
  const assetFiles = new Map<string, Uint8Array>();
  const moduleFiles = new Map<string, Uint8Array>();
  const migrationFiles = new Map<string, Uint8Array>();
  for (const [archivePath, body] of files) {
    if (archivePath === "manifest.json" || archivePath === "sbom.cdx.json") continue;
    if (archivePath.startsWith("assets/")) {
      const path = `/${archivePath.slice("assets/".length)}`;
      validateAssetPath(path);
      if (assetFiles.has(path) || body.byteLength > MAX_ASSET_BYTES) {
        throw new BuildBrokerConflictError();
      }
      assetFiles.set(path, body);
      continue;
    }
    if (archivePath.startsWith("migrations/")) {
      const migrationPath = archivePath.slice("migrations/".length);
      validateMigrationPath(migrationPath);
      if (migrationFiles.has(migrationPath) || body.byteLength > MAX_MIGRATION_BYTES) {
        throw new BuildBrokerConflictError();
      }
      migrationFiles.set(migrationPath, body);
      continue;
    }
    if (!archivePath.startsWith("worker/")) throw new BuildBrokerConflictError();
    const path = archivePath.slice("worker/".length);
    const module = manifest.modules.find((candidate) => candidate.path === path);
    if (module === undefined) throw new BuildBrokerConflictError();
    validateModulePath(path, module.contentType === "application/octet-stream");
    if (moduleFiles.has(path) || body.byteLength > MAX_MODULE_BYTES) {
      throw new BuildBrokerConflictError();
    }
    moduleFiles.set(path, body);
  }
  if (assetFiles.size !== manifest.assets.length) throw new BuildBrokerConflictError();
  for (const asset of manifest.assets) {
    const body = assetFiles.get(asset.path);
    if (
      body === undefined ||
      body.byteLength !== asset.size ||
      (await prefixedDigest(body)) !== asset.digest
    ) {
      throw new BuildBrokerConflictError();
    }
  }
  if (moduleFiles.size !== manifest.modules.length) throw new BuildBrokerConflictError();
  for (const module of manifest.modules) {
    const body = moduleFiles.get(module.path);
    if (
      body === undefined ||
      body.byteLength !== module.size ||
      (await prefixedDigest(body)) !== module.digest
    ) {
      throw new BuildBrokerConflictError();
    }
  }
  if (
    manifest.runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1" &&
    !(await hasMaximumGzipSize(moduleFiles.values(), MAX_NEXTJS_COMPRESSED_MODULE_BYTES))
  ) {
    throw new BuildBrokerConflictError();
  }
  if (migrationFiles.size !== manifest.migrations.length) throw new BuildBrokerConflictError();
  for (const migration of manifest.migrations) {
    const body = migrationFiles.get(migration.path);
    if (
      body === undefined ||
      body.byteLength !== migration.size ||
      (await prefixedDigest(body)) !== migration.digest
    ) {
      throw new BuildBrokerConflictError();
    }
  }
  if (
    (await prefixedDigest(
      new TextEncoder().encode(
        manifest.runtime === null
          ? JSON.stringify({
              applicationRoot: manifest.applicationRoot,
              frameworkPlanSchemaVersion: manifest.frameworkPlanSchemaVersion,
              runtimePolicy: manifest.runtimePolicy,
              database: manifest.database,
              auth: manifest.auth,
              storage: manifest.storage,
              ...(manifest.functions === undefined ? {} : { functions: manifest.functions }),
              ...(manifest.database.enabled ? { migrations: manifest.migrations } : {}),
              assets: manifest.assets,
            })
          : JSON.stringify({
              applicationRoot: manifest.applicationRoot,
              frameworkPlanSchemaVersion: manifest.frameworkPlanSchemaVersion,
              runtimePolicy: manifest.runtimePolicy,
              database: manifest.database,
              auth: manifest.auth,
              storage: manifest.storage,
              ...(manifest.functions === undefined ? {} : { functions: manifest.functions }),
              ...(manifest.database.enabled ? { migrations: manifest.migrations } : {}),
              runtime: manifest.runtime,
              assets: manifest.assets,
              modules: manifest.modules,
            }),
      ),
    )) !== manifest.artifactDigest ||
    (expectation.nextCacheAuthority.kind === "verified-artifact" &&
      manifest.artifactDigest !== expectation.nextCacheAuthority.artifactDigest)
  ) {
    throw new BuildBrokerConflictError();
  }
  const output = Object.freeze({
    bucket,
    key,
    versionId: state.versionId,
    eTag: state.eTag,
    byteLength: state.byteLength,
    sha256: object.sha256,
  });
  const commonProvenance = {
    scope: freezeScope(expectation.receipt.scope),
    deploymentId: expectation.deploymentId,
    buildId: expectation.receipt.buildId,
    sourceCommit: expectation.commitSha,
    sourceDigest: `sha256:${expectation.sourceSha256}` as const,
    buildPlanDigest: `sha256:${expectation.buildPlanSha256}` as const,
    artifactDigest: manifest.artifactDigest,
    output,
  };
  return Object.freeze({
    manifestDigest: await prefixedDigest(manifestBody),
    manifestBody,
    sbomBody,
    files: Object.freeze(
      manifest.assets.map((asset) =>
        Object.freeze({ path: asset.path, body: assetFiles.get(asset.path) as Uint8Array }),
      ),
    ),
    runtime: manifest.runtime,
    modules: Object.freeze(
      manifest.modules.map((module) =>
        Object.freeze({ ...module, body: moduleFiles.get(module.path) as Uint8Array }),
      ),
    ),
    migrations: Object.freeze(
      manifest.migrations.map((migration) =>
        Object.freeze({
          ...migration,
          body: migrationFiles.get(migration.path) as Uint8Array,
        }),
      ),
    ),
    provenance: Object.freeze({
      ...commonProvenance,
      applicationRoot: expectation.applicationRoot,
      frameworkPlanSchemaVersion: expectation.frameworkPlanSchemaVersion,
      runtimePolicy: expectation.runtimePolicy,
      database: expectation.database,
      auth: expectation.auth,
      storage: expectation.storage,
      lifecycleEvidence: manifest.lifecycleEvidence,
      ...(manifest.functions === undefined ? {} : { functions: manifest.functions }),
    }),
  });
}

/** The entry wrapper the plan's adapter and runtime build; the manifest may name no other. */
function expectedEntryWrapper(
  expectation: ArtifactPlanEvidence,
): VerifiedArtifactRuntime["entryWrapperVersion"] | undefined {
  if (expectation.frameworkRuntime === "functions") return "functions-v1";
  if (expectation.frameworkRuntime !== "edge") return undefined;
  if (expectation.frameworkAdapter === "nextjs") return "nextjs-opennext-wrapper-v1";
  if (expectation.frameworkAdapter === "astro") return "astro-edge-wrapper-v1";
  if (expectation.frameworkAdapter === "tanstack-start") return "tanstack-edge-wrapper-v1";
  if (expectation.frameworkAdapter === "vite-static") return "vite-api-companion-v1";
  return undefined;
}

async function parseBuildManifest(
  body: Uint8Array,
  expectation: ArtifactPlanEvidence,
): Promise<ParsedBuildManifest> {
  let value: unknown;
  try {
    validateJsonComplexity(body);
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new BuildBrokerConflictError();
  }
  const commonKeys = [
    "schemaVersion",
    "projectId",
    "environmentId",
    "deploymentId",
    "operationId",
    "buildId",
    "sourceCommit",
    "sourceDigest",
    "buildPlanDigest",
    "artifactDigest",
    "sbom",
    "assets",
    "applicationRoot",
    "frameworkPlanSchemaVersion",
    "runtimePolicy",
    "database",
    "auth",
    "storage",
    "lifecycleEvidence",
    ...(expectation.functions === undefined ? [] : ["functions"]),
    ...(expectation.database.enabled ? ["migrations"] : []),
  ];
  if (!isRecord(value)) throw new BuildBrokerConflictError();
  // The runtime shape is the plan's: the artifact may neither add nor drop the edge sections.
  const edge = expectation.frameworkRuntime !== "static";
  const keys = edge ? [...commonKeys, "runtime", "modules"] : commonKeys;
  if (!hasExactKeys(value, keys)) throw new BuildBrokerConflictError();
  const sbom = value["sbom"];
  const assets = value["assets"];
  const migrations = expectation.database.enabled ? value["migrations"] : [];
  const auth = parseCustomerAuthEvidence(value["auth"]);
  const storage = parseStorageEvidence(value["storage"]);
  const lifecycleEvidence = parseBuildLifecycleEvidence(value["lifecycleEvidence"], expectation);
  const functions =
    expectation.functions === undefined
      ? undefined
      : parseVerifiedFunctionsEvidence(value["functions"], expectation.functions);
  const scope = expectation.receipt.scope;
  if (
    value["schemaVersion"] !== "ohmyhost.artifact/v3" ||
    value["projectId"] !== scope.projectId ||
    value["environmentId"] !== scope.environmentId ||
    value["deploymentId"] !== expectation.deploymentId ||
    value["operationId"] !== scope.operationId ||
    value["buildId"] !== expectation.receipt.buildId ||
    value["sourceCommit"] !== expectation.commitSha ||
    value["sourceDigest"] !== `sha256:${expectation.sourceSha256}` ||
    value["buildPlanDigest"] !== `sha256:${expectation.buildPlanSha256}` ||
    value["applicationRoot"] !== expectation.applicationRoot ||
    JSON.stringify(value["runtimePolicy"]) !== JSON.stringify(expectation.runtimePolicy) ||
    JSON.stringify(value["database"]) !== JSON.stringify(expectation.database) ||
    JSON.stringify(storage) !== JSON.stringify(expectation.storage) ||
    JSON.stringify(auth) !== JSON.stringify(expectation.auth) ||
    (functions === undefined && Object.hasOwn(value, "functions")) ||
    value["frameworkPlanSchemaVersion"] !== FRAMEWORK_PLAN_SCHEMA_VERSION ||
    !isPrefixedDigest(value["artifactDigest"]) ||
    !isRecord(sbom) ||
    !hasExactKeys(sbom, ["path", "digest"]) ||
    sbom["path"] !== "sbom.cdx.json" ||
    !isPrefixedDigest(sbom["digest"]) ||
    !Array.isArray(assets) ||
    (assets.length === 0) !== (expectation.frameworkRuntime === "functions") ||
    assets.length > MAX_ASSET_COUNT
  ) {
    throw new BuildBrokerConflictError();
  }
  let previous = "";
  const parsedAssets = assets.map((candidate) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["path", "digest", "size"])) {
      throw new BuildBrokerConflictError();
    }
    const path = candidate["path"];
    validateAssetPath(path);
    if (
      path <= previous ||
      !isPrefixedDigest(candidate["digest"]) ||
      !Number.isSafeInteger(candidate["size"]) ||
      Number(candidate["size"]) < 0 ||
      Number(candidate["size"]) > MAX_ASSET_BYTES
    ) {
      throw new BuildBrokerConflictError();
    }
    previous = path;
    return Object.freeze({
      path,
      digest: candidate["digest"],
      size: Number(candidate["size"]),
    });
  });
  const parsedMigrations = expectation.database.enabled
    ? parseArtifactMigrations(migrations)
    : Object.freeze([]);
  let runtime: VerifiedArtifactRuntime | null = null;
  let modules: readonly Omit<VerifiedArtifactModule, "body">[] = Object.freeze([]);
  if (edge) {
    runtime = parseArtifactRuntime(value["runtime"]);
    if (runtime.entryWrapperVersion !== expectedEntryWrapper(expectation))
      throw new BuildBrokerConflictError();
    modules = parseArtifactModules(value["modules"], runtime, functions);
  }
  if (
    (runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1") !==
    (expectation.frameworkAdapter === "nextjs" && expectation.frameworkRuntime === "edge")
  )
    throw new BuildBrokerConflictError();
  if (
    runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1" &&
    expectation.ssgCacheMaxBytes !== undefined &&
    (runtime.ssgCacheMaxBytes ?? DEFAULT_SSG_CACHE_MAX_BYTES) !== expectation.ssgCacheMaxBytes
  )
    throw new BuildBrokerConflictError();
  if (
    expectation.nextCacheAuthority.kind === "plan" &&
    (runtime?.nextRevalidatePath === true) !== expectation.nextCacheAuthority.enabled
  )
    throw new BuildBrokerConflictError();
  let publicBytes = 0;
  let cacheBytes = 0;
  for (const asset of parsedAssets) {
    if (
      runtime?.entryWrapperVersion === "nextjs-opennext-wrapper-v1" &&
      asset.path.startsWith("/cdn-cgi/_next_cache/")
    )
      cacheBytes += asset.size;
    else publicBytes += asset.size;
  }
  if (
    publicBytes > MAX_PUBLIC_ASSET_TOTAL_BYTES ||
    cacheBytes > (runtime?.ssgCacheMaxBytes ?? DEFAULT_SSG_CACHE_MAX_BYTES)
  )
    throw new BuildBrokerConflictError();
  if (
    (runtime?.entryWrapperVersion === "functions-v1") !==
    (expectation.frameworkRuntime === "functions")
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    deploymentId: expectation.deploymentId,
    operationId: scope.operationId,
    buildId: expectation.receipt.buildId,
    sourceCommit: expectation.commitSha,
    sourceDigest: `sha256:${expectation.sourceSha256}` as const,
    buildPlanDigest: `sha256:${expectation.buildPlanSha256}` as const,
    applicationRoot: expectation.applicationRoot,
    frameworkPlanSchemaVersion: expectation.frameworkPlanSchemaVersion,
    runtimePolicy: expectation.runtimePolicy,
    database: expectation.database,
    auth,
    storage,
    lifecycleEvidence,
    ...(functions === undefined ? {} : { functions }),
    artifactDigest: value["artifactDigest"],
    sbom: Object.freeze({ path: "sbom.cdx.json" as const, digest: sbom["digest"] }),
    assets: Object.freeze(parsedAssets),
    runtime,
    modules,
    migrations: parsedMigrations,
  });
}

function parseBuildLifecycleEvidence(
  value: unknown,
  expectation: ArtifactPlanEvidence,
): VerifiedBuildLifecycleEvidence {
  const evidence = parseVerifiedBuildLifecycleEvidence(value);
  const expectedFramework =
    expectation.frameworkAdapter === "vite-static" ? "vite" : expectation.frameworkAdapter;
  if (
    evidence.frameworkBuild.framework !== expectedFramework ||
    evidence.frameworkBuild.runtime !== expectation.frameworkRuntime ||
    evidence.frameworkBuild.frameworkPlanSha256 !== expectation.buildPlanSha256 ||
    evidence.buildSandbox.buildId !== expectation.receipt.buildId ||
    evidence.buildSandbox.projectName !== expectation.receipt.projectName ||
    evidence.buildSandbox.sourceArchiveSha256 !== expectation.sourceSha256
  ) {
    throw new BuildBrokerConflictError();
  }
  return evidence;
}

export function parseVerifiedBuildLifecycleEvidence(
  value: unknown,
): VerifiedBuildLifecycleEvidence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "buildSandbox",
      "configurationDigest",
      "credentialScan",
      "frameworkBuild",
      "frozenInstall",
    ])
  ) {
    throw new BuildBrokerConflictError();
  }
  const frozenInstall = value["frozenInstall"];
  const frameworkBuild = value["frameworkBuild"];
  const buildSandbox = value["buildSandbox"];
  const credentialScan = value["credentialScan"];
  if (
    !isRecord(frozenInstall) ||
    !hasExactKeys(frozenInstall, [
      "dependencyInventorySha256",
      "installCommandSha256",
      "lockfile",
      "lockfileSha256",
      "packageManager",
      "packageManagerVersion",
    ]) ||
    !isRecord(frameworkBuild) ||
    !hasExactKeys(frameworkBuild, [
      "buildCommandSha256",
      "buildOutputSha256",
      "framework",
      "frameworkPlanSha256",
      "runtime",
    ]) ||
    !isRecord(buildSandbox) ||
    !hasExactKeys(buildSandbox, [
      "buildId",
      "buildInputFingerprint",
      "projectName",
      "sourceArchiveSha256",
      "terminalStatus",
    ]) ||
    !isRecord(credentialScan) ||
    !hasExactKeys(credentialScan, ["findingsCount", "rulesSha256", "scannerSha256"])
  ) {
    throw new BuildBrokerConflictError();
  }
  const digests = [
    value["configurationDigest"],
    frozenInstall["lockfileSha256"],
    frozenInstall["installCommandSha256"],
    frozenInstall["dependencyInventorySha256"],
    frameworkBuild["buildCommandSha256"],
    frameworkBuild["frameworkPlanSha256"],
    frameworkBuild["buildOutputSha256"],
    buildSandbox["buildInputFingerprint"],
    buildSandbox["sourceArchiveSha256"],
    credentialScan["scannerSha256"],
    credentialScan["rulesSha256"],
  ];
  if (
    !digests.every((digest) => typeof digest === "string" && /^[0-9a-f]{64}$/u.test(digest)) ||
    typeof frozenInstall["packageManager"] !== "string" ||
    typeof frozenInstall["packageManagerVersion"] !== "string" ||
    typeof frozenInstall["lockfile"] !== "string" ||
    frozenInstall["packageManager"].length === 0 ||
    frozenInstall["packageManagerVersion"].length === 0 ||
    frozenInstall["lockfile"].length === 0 ||
    typeof frameworkBuild["framework"] !== "string" ||
    (frameworkBuild["runtime"] !== "static" &&
      frameworkBuild["runtime"] !== "edge" &&
      frameworkBuild["runtime"] !== "functions") ||
    typeof buildSandbox["buildId"] !== "string" ||
    typeof buildSandbox["projectName"] !== "string" ||
    buildSandbox["terminalStatus"] !== "SUCCEEDED" ||
    credentialScan["findingsCount"] !== 0
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({
    configurationDigest: value["configurationDigest"] as string,
    frozenInstall: Object.freeze(
      frozenInstall as unknown as VerifiedBuildLifecycleEvidence["frozenInstall"],
    ),
    frameworkBuild: Object.freeze(
      frameworkBuild as unknown as VerifiedBuildLifecycleEvidence["frameworkBuild"],
    ),
    buildSandbox: Object.freeze(
      buildSandbox as unknown as VerifiedBuildLifecycleEvidence["buildSandbox"],
    ),
    credentialScan: Object.freeze(
      credentialScan as unknown as VerifiedBuildLifecycleEvidence["credentialScan"],
    ),
  });
}

function parseArtifactMigrations(
  value: unknown,
): readonly Omit<VerifiedArtifactMigration, "body">[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MIGRATION_COUNT) {
    throw new BuildBrokerConflictError();
  }
  let previous = "";
  let totalBytes = 0;
  return Object.freeze(
    value.map((candidate) => {
      if (!isRecord(candidate) || !hasExactKeys(candidate, ["path", "digest", "size"])) {
        throw new BuildBrokerConflictError();
      }
      const path = candidate["path"];
      validateMigrationPath(path);
      const size = candidate["size"];
      if (
        path <= previous ||
        !isPrefixedDigest(candidate["digest"]) ||
        !Number.isSafeInteger(size) ||
        Number(size) < 1 ||
        Number(size) > MAX_MIGRATION_BYTES
      ) {
        throw new BuildBrokerConflictError();
      }
      totalBytes += Number(size);
      if (totalBytes > MAX_MIGRATION_TOTAL_BYTES) throw new BuildBrokerConflictError();
      previous = path;
      return Object.freeze({ path, digest: candidate["digest"], size: Number(size) });
    }),
  );
}

function parseArtifactRuntime(value: unknown): VerifiedArtifactRuntime {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "kind",
      "mainModule",
      "compatibilityDate",
      "compatibilityFlags",
      "entryWrapperVersion",
      ...(Object.hasOwn(value, "ssgCacheMaxBytes") ? ["ssgCacheMaxBytes"] : []),
      ...(Object.hasOwn(value, "nextRevalidatePath") ? ["nextRevalidatePath"] : []),
    ]) ||
    value["kind"] !== "cloudflare-worker" ||
    value["mainModule"] !== "index.js" ||
    typeof value["compatibilityDate"] !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value["compatibilityDate"]) ||
    !Array.isArray(value["compatibilityFlags"]) ||
    value["compatibilityFlags"].length !== 1 ||
    value["compatibilityFlags"][0] !== "nodejs_compat" ||
    (value["entryWrapperVersion"] !== "astro-edge-wrapper-v1" &&
      value["entryWrapperVersion"] !== "tanstack-edge-wrapper-v1" &&
      value["entryWrapperVersion"] !== "nextjs-opennext-wrapper-v1" &&
      value["entryWrapperVersion"] !== "vite-api-companion-v1" &&
      value["entryWrapperVersion"] !== "functions-v1")
  ) {
    throw new BuildBrokerConflictError();
  }
  if (
    Object.hasOwn(value, "nextRevalidatePath") &&
    (value["entryWrapperVersion"] !== "nextjs-opennext-wrapper-v1" ||
      value["nextRevalidatePath"] !== true)
  )
    throw new BuildBrokerConflictError();
  if (
    Object.hasOwn(value, "ssgCacheMaxBytes") &&
    (value["entryWrapperVersion"] !== "nextjs-opennext-wrapper-v1" ||
      !Number.isSafeInteger(value["ssgCacheMaxBytes"]) ||
      Number(value["ssgCacheMaxBytes"]) < 1024 * 1024 ||
      Number(value["ssgCacheMaxBytes"]) > 64 * 1024 * 1024 ||
      Number(value["ssgCacheMaxBytes"]) % (1024 * 1024) !== 0)
  )
    throw new BuildBrokerConflictError();
  if (
    (value["entryWrapperVersion"] === "astro-edge-wrapper-v1" &&
      value["compatibilityDate"] < "2026-10-12") ||
    (value["entryWrapperVersion"] === "tanstack-edge-wrapper-v1" &&
      value["compatibilityDate"] < "2025-04-01") ||
    (value["entryWrapperVersion"] === "nextjs-opennext-wrapper-v1" &&
      value["compatibilityDate"] < "2024-09-23") ||
    ((value["entryWrapperVersion"] === "vite-api-companion-v1" ||
      value["entryWrapperVersion"] === "functions-v1") &&
      value["compatibilityDate"] !== "2025-01-01")
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({
    kind: "cloudflare-worker",
    mainModule: "index.js",
    compatibilityDate: value["compatibilityDate"],
    compatibilityFlags: Object.freeze(["nodejs_compat"] as const),
    entryWrapperVersion: value["entryWrapperVersion"],
    ...(Object.hasOwn(value, "ssgCacheMaxBytes")
      ? { ssgCacheMaxBytes: Number(value["ssgCacheMaxBytes"]) }
      : {}),
    ...(value["nextRevalidatePath"] === true ? { nextRevalidatePath: true as const } : {}),
  });
}

/** The bundled Worker module of declared crons beside an edge framework's own modules. */
const FUNCTIONS_WORKER_MODULE = "ohmyhost-worker.js";

function parseArtifactModules(
  value: unknown,
  runtime: VerifiedArtifactRuntime,
  functions: VerifiedFunctionsRequirement | undefined,
): readonly Omit<VerifiedArtifactModule, "body">[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MODULE_COUNT) {
    throw new BuildBrokerConflictError();
  }
  let previous = "";
  const modules = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["path", "contentType", "digest", "size"])
    ) {
      throw new BuildBrokerConflictError();
    }
    const path = candidate["path"];
    const data = candidate["contentType"] === "application/octet-stream";
    validateModulePath(path, data);
    const maximumModuleBytes =
      runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1" && path === runtime.mainModule
        ? MAX_NEXTJS_MODULE_BYTES
        : MAX_TANSTACK_MODULE_BYTES;
    if (
      path <= previous ||
      (data
        ? runtime.entryWrapperVersion !== "nextjs-opennext-wrapper-v1"
        : candidate["contentType"] !==
          (path.endsWith(".wasm") ? "application/wasm" : "application/javascript+module")) ||
      !isPrefixedDigest(candidate["digest"]) ||
      !Number.isSafeInteger(candidate["size"]) ||
      Number(candidate["size"]) < (data ? 0 : 1) ||
      Number(candidate["size"]) > maximumModuleBytes
    ) {
      throw new BuildBrokerConflictError();
    }
    previous = path;
    return Object.freeze({
      path,
      contentType: candidate["contentType"] as VerifiedArtifactModule["contentType"],
      digest: candidate["digest"],
      size: Number(candidate["size"]),
    });
  });
  if (!modules.some((module) => module.path === runtime.mainModule)) {
    throw new BuildBrokerConflictError();
  }
  const workerModule = modules.some(({ path }) => path === FUNCTIONS_WORKER_MODULE);
  const frameworkWorker =
    runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1" ||
    runtime.entryWrapperVersion === "tanstack-edge-wrapper-v1" ||
    runtime.entryWrapperVersion === "astro-edge-wrapper-v1";
  if (
    (frameworkWorker ? workerModule !== (functions !== undefined) : workerModule) ||
    modules.reduce((total, module) => total + module.size, 0) >
      (runtime.entryWrapperVersion === "nextjs-opennext-wrapper-v1"
        ? MAX_NEXTJS_MODULE_BYTES
        : 10_485_760)
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze(modules);
}

function arrayBufferView(body: Uint8Array): Uint8Array<ArrayBuffer> {
  // Preserve the exact owned byte range; WebCrypto and codecs cannot consume shared buffers.
  return body.buffer instanceof ArrayBuffer
    ? (body as Uint8Array<ArrayBuffer>)
    : new Uint8Array(body);
}

function boundedByteStream(body: Uint8Array): ReadableStream<Uint8Array<ArrayBuffer>> {
  // The caller owns these immutable bytes. Snapshot shared memory once, never detach the input.
  const bytes = arrayBufferView(body);
  const byteLength = bytes.byteLength;
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset < byteLength) {
        const end = Math.min(offset + BYTE_STREAM_CHUNK_BYTES, byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      }
      if (offset === byteLength) controller.close();
    },
  });
}

async function hasMaximumGzipSize(
  bodies: Iterable<Uint8Array>,
  maximumBytes: number,
): Promise<boolean> {
  try {
    let byteLength = 0;
    for (const body of bodies) {
      const reader = boundedByteStream(body).pipeThrough(new CompressionStream("gzip")).getReader();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        byteLength += item.value.byteLength;
        if (byteLength > maximumBytes) {
          await reader.cancel();
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function validateModulePath(value: unknown, data = false): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 248 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    (data
      ? /\.(?:[cm]?js|wasm|node)$/iu.test(value)
      : !value.endsWith(".js") && !value.endsWith(".mjs") && !value.endsWith(".wasm")) ||
    value.toLowerCase() === "ohmyhost-entry.mjs" ||
    value.toLowerCase().split("/").at(-1) === "metadata" ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    !(data ? /^[A-Za-z0-9._@/+-]+$/u : /^[A-Za-z0-9._/-]+$/u).test(value)
  ) {
    throw new BuildBrokerConflictError();
  }
}

function validateMigrationPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 248 ||
    !/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*\d{14}_[a-z0-9][a-z0-9_-]*\.sql$/u.test(value)
  ) {
    throw new BuildBrokerConflictError();
  }
}

async function readTarGzip(compressed: Uint8Array): Promise<ReadonlyMap<string, Uint8Array>> {
  const reader = boundedByteStream(compressed)
    .pipeThrough(new DecompressionStream("gzip"))
    .getReader();
  const files = new Map<string, Uint8Array>();
  let chunk = new Uint8Array(0);
  let chunkOffset = 0;
  let expandedBytes = 0;
  let entries = 0;
  // Retain each file once. Never keep decompression chunks beside a second complete TAR buffer.
  const read = async (
    size: number,
    retain = true,
    allowEnd = false,
  ): Promise<Uint8Array | undefined> => {
    const result = new Uint8Array(retain ? size : 0);
    let offset = 0;
    while (offset < size) {
      if (chunkOffset === chunk.byteLength) {
        const item = await reader.read();
        if (item.done) {
          if (allowEnd && offset === 0) return undefined;
          throw new BuildBrokerConflictError();
        }
        expandedBytes += item.value.byteLength;
        if (expandedBytes > MAX_EXPANDED_BUNDLE_BYTES) throw new BuildBrokerConflictError();
        chunk = item.value;
        chunkOffset = 0;
      }
      const length = Math.min(size - offset, chunk.byteLength - chunkOffset);
      if (retain) result.set(chunk.subarray(chunkOffset, chunkOffset + length), offset);
      chunkOffset += length;
      offset += length;
    }
    return result;
  };
  try {
    for (;;) {
      const header = await read(512, true, true);
      if (header === undefined) break;
      if (header.every((byte) => byte === 0)) {
        // Count trailing output too, so a valid prefix cannot conceal a decompression bomb.
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          expandedBytes += item.value.byteLength;
          if (expandedBytes > MAX_EXPANDED_BUNDLE_BYTES) throw new BuildBrokerConflictError();
        }
        break;
      }
      verifyTarChecksum(header);
      const name = tarText(header.subarray(0, 100));
      const prefix = tarText(header.subarray(345, 500));
      const rawPath = prefix.length === 0 ? name : `${prefix}/${name}`;
      const type = header[156];
      const path = type === 53 && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      validateArchivePath(path);
      const size = tarOctal(header.subarray(124, 136));
      if (type === 0 || type === 48) {
        const maximum =
          path === "manifest.json"
            ? MAX_MANIFEST_BYTES
            : path === "sbom.cdx.json"
              ? MAX_SBOM_BYTES
              : path.startsWith("assets/")
                ? MAX_ASSET_BYTES
                : path.startsWith("worker/")
                  ? MAX_MODULE_BYTES
                  : path.startsWith("migrations/")
                    ? MAX_MIGRATION_BYTES
                    : 0;
        const consumedBytes = expandedBytes - (chunk.byteLength - chunkOffset);
        if (files.has(path) || size > maximum || consumedBytes + size > MAX_EXPANDED_BUNDLE_BYTES)
          throw new BuildBrokerConflictError();
        const body = await read(size);
        if (body === undefined) throw new BuildBrokerConflictError();
        files.set(path, body);
        entries += 1;
        if (entries > MAX_ASSET_COUNT + MAX_MODULE_COUNT + MAX_MIGRATION_COUNT + 2)
          throw new BuildBrokerConflictError();
      } else if (type === 53) {
        if (size > MAX_EXPANDED_BUNDLE_BYTES) throw new BuildBrokerConflictError();
        await read(size, false);
      } else throw new BuildBrokerConflictError();
      await read((512 - (size % 512)) % 512, false);
    }
    return files;
  } catch {
    throw new BuildBrokerConflictError();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function verifyTarChecksum(header: Uint8Array): void {
  const expected = tarOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  if (actual !== expected) throw new BuildBrokerConflictError();
}

function tarText(value: Uint8Array): string {
  const end = value.indexOf(0);
  const slice = end === -1 ? value : value.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    throw new BuildBrokerConflictError();
  }
}

function tarOctal(value: Uint8Array): number {
  const text = tarText(value).trim();
  if (!/^[0-7]+$/u.test(text)) throw new BuildBrokerConflictError();
  const result = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(result) || result < 0) throw new BuildBrokerConflictError();
  return result;
}

function validateArchivePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 255 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new BuildBrokerConflictError();
  }
}

function validateAssetPath(path: unknown): asserts path is string {
  let decoded: string;
  try {
    decoded = typeof path === "string" ? decodeURIComponent(path) : "";
  } catch {
    throw new BuildBrokerConflictError();
  }
  if (
    typeof path !== "string" ||
    path.length < 2 ||
    path.length > 255 ||
    !path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    Array.from(path).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    }) ||
    decoded
      .split("/")
      .some((part, index) => index > 0 && (part === "" || part === "." || part === ".."))
  ) {
    throw new BuildBrokerConflictError();
  }
}

function validateJsonComplexity(body: Uint8Array): void {
  let quoted = false;
  let escaped = false;
  let depth = 0;
  let nodes = 0;
  let separators = 0;
  for (const byte of body) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === 34) quoted = false;
    } else if (byte === 34) quoted = true;
    else if (byte === 123 || byte === 91) {
      depth += 1;
      nodes += 1;
      if (depth > 64 || nodes > 16_384) throw new BuildBrokerConflictError();
    } else if (byte === 125 || byte === 93) depth -= 1;
    else if (byte === 44 || byte === 58) {
      separators += 1;
      if (separators > 65_536) throw new BuildBrokerConflictError();
    }
  }
}

function validateCycloneDx(body: Uint8Array): void {
  try {
    validateJsonComplexity(body);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    if (!isRecord(value) || value["bomFormat"] !== "CycloneDX" || value["specVersion"] !== "1.6") {
      throw new BuildBrokerConflictError();
    }
  } catch (error) {
    if (error instanceof BuildBrokerConflictError) throw error;
    throw new BuildBrokerConflictError();
  }
}

async function prefixedDigest(body: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBufferView(body)));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function isPrefixedDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && [...keys].sort().every((key, index) => actual[index] === key)
  );
}

async function findBuild(
  dependencies: BuildBrokerDependencies,
  scope: OperationScope,
  buildId: string,
): Promise<BuildState | null> {
  const states = await timed(
    dependencies,
    (signal) =>
      dependencies.executor.batchGetBuilds(
        { buildIds: [buildId], bucket: dependencies.bucket },
        signal,
      ),
    "read",
  );
  if (states.length === 0) return null;
  if (states.length !== 1) throw new BuildBrokerConflictError();
  const state = states[0];
  if (
    state === undefined ||
    state.projectName !== dependencies.buildProject ||
    state.operationId !== scope.operationId
  ) {
    throw new BuildBrokerConflictError();
  }
  validateOpaque(state.buildId);
  mapStatus(state.status);
  return state;
}

function deterministicBuildId(buildProject: string, scope: OperationScope): string {
  return `${buildProject}:${scope.operationId}`;
}

function buildReceipt(projectName: string, scope: OperationScope, buildId: string): BuildReceipt {
  return Object.freeze({ buildId, projectName, scope: freezeScope(scope) });
}

/** The build runtime's excerpt object, or null when it is absent, foreign or not customer-safe. */
export function parseBuildFailureExcerpt(
  body: Uint8Array,
  operationId: string,
): BuildFailureExcerpt | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "excerpt,logBytes,operationId,schemaVersion,truncated" ||
    value["schemaVersion"] !== BUILD_FAILURE_SCHEMA_VERSION ||
    value["operationId"] !== operationId ||
    typeof value["truncated"] !== "boolean" ||
    !Number.isSafeInteger(value["logBytes"]) ||
    (value["logBytes"] as number) < 1
  ) {
    return null;
  }
  const excerpt = value["excerpt"];
  if (
    typeof excerpt !== "string" ||
    excerpt.length === 0 ||
    excerpt.length > BUILD_FAILURE_MAX_CHARACTERS ||
    excerpt !== excerpt.trimEnd() ||
    BUILD_FAILURE_FORBIDDEN_PATTERN.test(excerpt)
  ) {
    return null;
  }
  return Object.freeze({ excerpt, truncated: value["truncated"] });
}

function mapStatus(status: BuildStatus): BuildObservation["status"] {
  switch (status) {
    case "IN_PROGRESS":
      return "running";
    case "SUCCEEDED":
      return "succeeded";
    case "STOPPED":
      return "stopped";
    case "FAILED":
    case "FAULT":
    case "TIMED_OUT":
      return "failed";
    default:
      throw new BuildBrokerConflictError();
  }
}

async function timed<T>(
  dependencies: BuildBrokerDependencies,
  operation: (signal: AbortSignal) => Promise<T>,
  kind: "read" | "mutation",
): Promise<T> {
  const attempts = kind === "read" ? dependencies.maximumAttempts : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new BuildBrokerTransportError());
        }, dependencies.requestTimeoutMs);
      });
      return await Promise.race([operation(controller.signal), timeout]);
    } catch (error) {
      if (error instanceof BuildBrokerTransportError) throw error;
      const code = providerCode(error);
      if (attempt < attempts && isRetryable(error)) {
        await dependencies.sleep(dependencies.retryDelayMs);
        continue;
      }
      if (code !== null) throw new ProviderSignal(code);
      throw new BuildBrokerTransportError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  throw new BuildBrokerTransportError();
}

/**
 * Recovers a lost start response by looking up the operation's deterministic build id. Only an
 * executor answer without that id proves absence; every answer the broker cannot fully verify is
 * `unknown`, and a verified build of this operation with another input is a conflict.
 */
async function observeStartedBuild(
  dependencies: BuildBrokerDependencies,
  scope: OperationScope,
  inputFingerprint: `sha256:${string}`,
  reservationTime: number,
): Promise<BuildStartObservation> {
  const buildId = deterministicBuildId(dependencies.buildProject, scope);
  const states = await timed(
    dependencies,
    (signal) =>
      dependencies.executor.batchGetBuilds(
        { buildIds: [buildId], bucket: dependencies.bucket },
        signal,
      ),
    "read",
  );
  if (!Array.isArray(states) || states.length > 1) {
    return Object.freeze({ state: "unknown" as const });
  }
  if (states.length === 0) return Object.freeze({ state: "absent" as const });
  const state: unknown = states[0];
  if (!validObservedBuildMinimum(state) || state.buildId !== buildId) {
    return Object.freeze({ state: "unknown" as const });
  }
  const startTime = state.startTime.getTime();
  if (
    startTime > dependencies.now().getTime() + BUILD_START_CLOCK_SKEW_MILLISECONDS ||
    startTime < reservationTime - BUILD_START_CLOCK_SKEW_MILLISECONDS ||
    !validObservedBuildIdentity(state) ||
    state.projectName !== dependencies.buildProject ||
    state.operationId !== scope.operationId
  ) {
    return Object.freeze({ state: "unknown" as const });
  }
  if (state.inputFingerprint !== inputFingerprint) throw new BuildBrokerConflictError();
  return Object.freeze({
    state: "found" as const,
    receipt: buildReceipt(dependencies.buildProject, scope, buildId),
  });
}

function validObservedBuildMinimum(value: unknown): value is BuildState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "buildId",
      "inputFingerprint",
      "operationId",
      "projectName",
      "startTime",
      "status",
      "usage",
    ]) ||
    !isOpaqueValue(value["buildId"]) ||
    typeof value["projectName"] !== "string" ||
    !SAFE_NAME_PATTERN.test(value["projectName"]) ||
    !(value["startTime"] instanceof Date) ||
    !Number.isFinite(value["startTime"].getTime())
  ) {
    return false;
  }
  return (
    value["status"] === "IN_PROGRESS" ||
    value["status"] === "SUCCEEDED" ||
    value["status"] === "FAILED" ||
    value["status"] === "FAULT" ||
    value["status"] === "STOPPED" ||
    value["status"] === "TIMED_OUT"
  );
}

function validObservedBuildIdentity(value: BuildState): value is BuildState & {
  readonly operationId: string;
  readonly inputFingerprint: `sha256:${string}`;
} {
  return (
    typeof value.operationId === "string" &&
    ULID_PATTERN.test(value.operationId) &&
    isPrefixedDigest(value.inputFingerprint)
  );
}

function validateDependencies(input: BuildBrokerDependencies): void {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof input.objectStore?.headObject !== "function" ||
    typeof input.executor?.startBuild !== "function" ||
    typeof input.now !== "function" ||
    typeof input.sleep !== "function" ||
    !SAFE_NAME_PATTERN.test(input.bucket) ||
    !SAFE_NAME_PATTERN.test(input.buildProject) ||
    !isPositiveInteger(input.requestTimeoutMs) ||
    !isPositiveInteger(input.retryDelayMs) ||
    !isPositiveInteger(input.maximumAttempts) ||
    input.maximumAttempts > 3
  )
    throw new BuildBrokerInputError();
  assertOnlyKeys(input, [
    "objectStore",
    "executor",
    "now",
    "sleep",
    "bucket",
    "buildProject",
    "requestTimeoutMs",
    "retryDelayMs",
    "maximumAttempts",
  ]);
}

function validateScope(scope: OperationScope): void {
  if (
    scope === null ||
    typeof scope !== "object" ||
    !ULID_PATTERN.test(scope.projectId) ||
    !ULID_PATTERN.test(scope.environmentId) ||
    !ULID_PATTERN.test(scope.operationId)
  )
    throw new BuildBrokerInputError();
  assertOnlyKeys(scope, ["projectId", "environmentId", "operationId"]);
}

function validateDigest(value: string): void {
  if (!SHA256_PATTERN.test(value)) throw new BuildBrokerInputError();
}

function validateOpaque(value: string): void {
  if (!isOpaqueValue(value)) throw new BuildBrokerInputError();
}

function isOpaqueValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  );
}

function validateEtag(value: string): void {
  if (!ETAG_PATTERN.test(value)) throw new BuildBrokerInputError();
}

function validateObjectState(state: StoredObjectState): void {
  validateOpaque(state.versionId);
  validateEtag(state.eTag);
  if (
    !Number.isSafeInteger(state.byteLength) ||
    state.byteLength <= 0 ||
    state.metadata === null ||
    typeof state.metadata !== "object"
  ) {
    throw new BuildBrokerConflictError();
  }
}

function validateArchiveState(state: StoredObjectState, archive: ArchiveObjectReceipt): void {
  validateObjectState(state);
  if (
    state.versionId !== archive.versionId ||
    state.eTag !== archive.eTag ||
    state.byteLength !== archive.byteLength ||
    state.metadata["operation"] !== archive.scope.operationId
  ) {
    throw new BuildBrokerConflictError();
  }
}

function validateUploadReceipt(receipt: ArchiveUploadReceipt, bucket: string): void {
  assertOnlyKeys(receipt, ["bucket", "key", "uploadId", "scope"]);
  validateScope(receipt.scope);
  validateOpaque(receipt.uploadId);
  const paths = operationPaths(receipt.scope);
  if (receipt.bucket !== bucket || receipt.key !== paths.inputKey)
    throw new BuildBrokerConflictError();
}

function validateObjectReceipt(receipt: ArchiveObjectReceipt, bucket: string): void {
  assertOnlyKeys(receipt, [
    "bucket",
    "key",
    "versionId",
    "eTag",
    "byteLength",
    "scope",
    "sourceSha256",
  ]);
  validateScope(receipt.scope);
  validateDigest(receipt.sourceSha256);
  validateOpaque(receipt.versionId);
  validateEtag(receipt.eTag);
  if (!Number.isSafeInteger(receipt.byteLength) || receipt.byteLength <= 0)
    throw new BuildBrokerInputError();
  const paths = operationPaths(receipt.scope);
  if (receipt.bucket !== bucket || receipt.key !== paths.inputKey)
    throw new BuildBrokerConflictError();
}

function validateParts(parts: readonly ArchivePartReceipt[]): void {
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10_000)
    throw new BuildBrokerInputError();
  let expected = 1;
  for (const part of parts) {
    assertOnlyKeys(part, ["partNumber", "eTag", "checksumSha256"]);
    if (part.partNumber !== expected) throw new BuildBrokerInputError();
    validateEtag(part.eTag);
    validateDigest(part.checksumSha256);
    expected += 1;
  }
}

function validateBuildReceipt(receipt: BuildReceipt, projectName: string): void {
  assertOnlyKeys(receipt, ["buildId", "projectName", "scope"]);
  validateScope(receipt.scope);
  validateOpaque(receipt.buildId);
  if (
    receipt.projectName !== projectName ||
    receipt.buildId !== deterministicBuildId(projectName, receipt.scope)
  ) {
    throw new BuildBrokerConflictError();
  }
}

async function validateArtifactExpectation(
  input: BuildArtifactExpectation,
  projectName: string,
): Promise<ArtifactPlanEvidence> {
  assertOnlyKeys(input, [
    "receipt",
    "deploymentId",
    "commitSha",
    "sourceSha256",
    "buildPlanSha256",
    "frameworkPlan",
  ]);
  validateBuildReceipt(input.receipt, projectName);
  if (!ULID_PATTERN.test(input.deploymentId) || !COMMIT_SHA_PATTERN.test(input.commitSha)) {
    throw new BuildBrokerInputError();
  }
  validateDigest(input.sourceSha256);
  validateDigest(input.buildPlanSha256);
  let frameworkPlan: ProductionFrameworkPlan;
  try {
    frameworkPlan = parseNewProductionFrameworkPlan(input.frameworkPlan);
  } catch {
    throw new BuildBrokerInputError();
  }
  const recomputed = (
    await prefixedDigest(
      new TextEncoder().encode(serializeNewProductionFrameworkPlanPreimage(frameworkPlan)),
    )
  ).slice("sha256:".length);
  if (recomputed !== input.buildPlanSha256) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({
    receipt: input.receipt,
    deploymentId: input.deploymentId,
    commitSha: input.commitSha,
    sourceSha256: input.sourceSha256,
    buildPlanSha256: input.buildPlanSha256,
    applicationRoot: frameworkPlan.applicationRoot,
    runtimePolicy: frameworkPlan.runtimePolicy,
    database: frameworkPlan.database,
    auth: frameworkPlan.auth,
    storage: frameworkPlan.storage,
    frameworkAdapter: frameworkPlan.adapter,
    frameworkRuntime: frameworkPlan.runtime,
    ...(frameworkPlan.adapter === "nextjs"
      ? { ssgCacheMaxBytes: frameworkPlan.ssgCacheMaxBytes ?? DEFAULT_SSG_CACHE_MAX_BYTES }
      : {}),
    nextCacheAuthority: {
      kind: "plan" as const,
      enabled: frameworkPlan.adapter === "nextjs" && frameworkPlan.nextRevalidatePath === true,
    },
    ...(frameworkPlan.functions === undefined ? {} : { functions: frameworkPlan.functions }),
    frameworkPlanSchemaVersion: FRAMEWORK_PLAN_SCHEMA_VERSION,
  });
}

function validateVerifiedArtifactReceipt(artifact: VerifiedArtifactBundle, bucket: string): void {
  if (
    !isRecord(artifact) ||
    !isRecord(artifact.provenance) ||
    !isRecord(artifact.provenance.output)
  ) {
    throw new BuildBrokerInputError();
  }
  const provenance = artifact.provenance;
  const output = provenance.output;
  validateScope(provenance.scope);
  if (
    output.bucket !== bucket ||
    output.key !== operationPaths(provenance.scope).bundleKey ||
    !isPrefixedDigest(artifact.manifestDigest) ||
    !isPrefixedDigest(provenance.artifactDigest) ||
    !SHA256_PATTERN.test(output.sha256) ||
    !Number.isSafeInteger(output.byteLength) ||
    output.byteLength <= 0
  ) {
    throw new BuildBrokerConflictError();
  }
  validateOpaque(output.versionId);
  validateEtag(output.eTag);
}

function defaultDatabaseRequirement(): ProductionFrameworkPlan["database"] {
  return Object.freeze({ enabled: false as const });
}

function defaultCustomerAuthRequirement(): ProductionFrameworkPlan["auth"] {
  return Object.freeze({ provider: "none" as const });
}

function defaultStorageRequirement(): ProductionFrameworkPlan["storage"] {
  return Object.freeze({ enabled: false as const });
}

function parseCustomerAuthEvidence(value: unknown): ProductionFrameworkPlan["auth"] {
  if (!isRecord(value)) throw new BuildBrokerConflictError();
  if (value["provider"] === "none" && hasExactKeys(value, ["provider"])) {
    return defaultCustomerAuthRequirement();
  }
  if (
    value["provider"] === "omh-native" &&
    hasExactKeys(value, ["provider", "routePath", "bindingName"]) &&
    value["routePath"] === "/api/auth/v1" &&
    value["bindingName"] === "OHMYHOST_AUTH"
  ) {
    return Object.freeze({
      provider: "omh-native" as const,
      routePath: "/api/auth/v1" as const,
      bindingName: "OHMYHOST_AUTH" as const,
    });
  }
  if (
    !hasExactKeys(value, [
      "authSecretName",
      "databaseSchema",
      "databaseBindingName",
      "deployment",
      "provider",
      "routePath",
      "version",
    ]) ||
    value["provider"] !== "better-auth" ||
    !isRecordedBetterAuthVersion(value["version"]) ||
    (value["deployment"] !== "embedded" && value["deployment"] !== "companion") ||
    value["routePath"] !== "/api/auth" ||
    value["databaseSchema"] !== "auth" ||
    value["databaseBindingName"] !== "OHMYHOST_DATABASE" ||
    value["authSecretName"] !== "BETTER_AUTH_SECRET"
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({
    provider: "better-auth" as const,
    version: value["version"],
    deployment: value["deployment"],
    routePath: "/api/auth" as const,
    databaseSchema: "auth" as const,
    databaseBindingName: "OHMYHOST_DATABASE" as const,
    authSecretName: "BETTER_AUTH_SECRET" as const,
  });
}

function parseStorageEvidence(value: unknown): ProductionFrameworkPlan["storage"] {
  if (!isRecord(value)) throw new BuildBrokerConflictError();
  if (value["enabled"] === false && hasExactKeys(value, ["enabled"])) {
    return defaultStorageRequirement();
  }
  if (
    !hasExactKeys(value, ["enabled", "jurisdiction", "provider", "public"]) ||
    value["enabled"] !== true ||
    value["provider"] !== "r2" ||
    (value["jurisdiction"] !== "eu" && value["jurisdiction"] !== "us") ||
    value["public"] !== false
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({
    enabled: true as const,
    provider: "r2" as const,
    jurisdiction: value["jurisdiction"],
    public: false as const,
  });
}

function parseVerifiedFunctionsEvidence(
  value: unknown,
  expected?: FunctionsRequirement,
): VerifiedFunctionsRequirement {
  if (!isRecord(value) || !hasExactKeys(value, ["crons"]) || !Array.isArray(value["crons"]))
    throw new BuildBrokerConflictError();
  let crons: readonly string[];
  try {
    crons = normalizeCrons(value["crons"]);
  } catch {
    throw new BuildBrokerConflictError();
  }
  if (
    JSON.stringify(crons) !== JSON.stringify(value["crons"]) ||
    (expected !== undefined && JSON.stringify(crons) !== JSON.stringify(expected.crons))
  )
    throw new BuildBrokerConflictError();
  return Object.freeze({ crons });
}

function planFunctionsFromVerified(value: unknown): FunctionsRequirement {
  return parseVerifiedFunctionsEvidence(value);
}

function parseDatabaseEvidence(value: unknown): ProductionFrameworkPlan["database"] {
  if (!isRecord(value)) throw new BuildBrokerConflictError();
  if (value["enabled"] === false && hasExactKeys(value, ["enabled"])) {
    return defaultDatabaseRequirement();
  }
  if (
    value["enabled"] !== true ||
    !hasExactKeys(value, ["enabled", "migrations"]) ||
    typeof value["migrations"] !== "string" ||
    value["migrations"].length === 0
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({ enabled: true as const, migrations: value["migrations"] });
}

function parseRuntimePolicyEvidence(value: unknown): ProductionFrameworkPlan["runtimePolicy"] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "egressAllowedOrigins",
      "healthCheckPath",
      ...(value["browser"] === undefined ? [] : ["browser"]),
    ])
  ) {
    throw new BuildBrokerConflictError();
  }
  const healthCheckPath = value["healthCheckPath"];
  const origins = value["egressAllowedOrigins"];
  if (
    typeof healthCheckPath !== "string" ||
    !healthCheckPath.startsWith("/") ||
    !Array.isArray(origins) ||
    origins.some((origin) => typeof origin !== "string")
  ) {
    throw new BuildBrokerConflictError();
  }
  return Object.freeze({
    healthCheckPath,
    egressAllowedOrigins: Object.freeze([...origins] as string[]),
    ...(value["browser"] === undefined ? {} : { browser: parseBrowserPolicy(value["browser"]) }),
  });
}

function validateArtifactObjectReceipt(artifact: ArtifactObjectReceipt, bucket: string): void {
  assertOnlyKeys(artifact, ["bucket", "key", "versionId", "scope"]);
  validateScope(artifact.scope);
  validateOpaque(artifact.versionId);
  if (artifact.bucket !== bucket || artifact.key !== operationPaths(artifact.scope).bundleKey)
    throw new BuildBrokerConflictError();
}

function assertOnlyKeys(value: object, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new BuildBrokerInputError();
}

function freezeScope(scope: OperationScope): OperationScope {
  validateScope(scope);
  return Object.freeze({ ...scope });
}

function sameScope(left: OperationScope, right: OperationScope): boolean {
  return (
    left.projectId === right.projectId &&
    left.environmentId === right.environmentId &&
    left.operationId === right.operationId
  );
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "retryable" in error && error.retryable === true
  );
}

function providerCode(error: unknown): string | null {
  if (error instanceof ProviderSignal) return error.providerCode;
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}
