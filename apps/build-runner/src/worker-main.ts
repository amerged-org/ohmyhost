import {
  BuildBrokerConflictError,
  BuildBrokerInputError,
  createBuildBroker,
  type ArchiveObjectReceipt,
  type ArchivePartReceipt,
  type ArchiveUploadReceipt,
  type ArtifactObjectReceipt,
  type BuildArtifactExpectation,
  type BuildBroker,
  type BuildReceipt,
  type OperationScope,
  type RecoverableBuildBroker,
  type VerifiedArtifactBundle,
} from "@ohmyhost/build-broker";
import { WorkerEntrypoint } from "cloudflare:workers";

import {
  BuildStartAbsentError,
  createPersistingBuildBroker,
  type BuildReceiptPersistence,
} from "./persistent-broker.js";
import { buildPlacements, ofBucket, type BuildPlacementBindings } from "./build-placement.js";
import { createR2ObjectStore } from "./r2-object-store.js";
import { createSandboxExecutor } from "./sandbox-executor.js";

export { BuildSandbox, BuildSandboxEu } from "./build-sandbox.js";

const MAX_RPC_PART_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const FORBIDDEN_OVERRIDE_KEYS = new Set([
  "bucketOverride",
  "keyOverride",
  "projectOverride",
  "buildProject",
  "imageOverride",
  "instanceTypeOverride",
  "entrypointOverride",
  "environmentOverride",
  "timeoutOverride",
  "agentToken",
]);

/**
 * `BUILD_OBJECTS_US` / `BUILD_OBJECTS_EU` are the R2 buckets that hold source archives, bundles,
 * failure excerpts and build logs of each region; `BUILD_OBJECTS_BUCKET_US` /
 * `BUILD_OBJECTS_BUCKET_EU` name them and receipts carry the name. `BUILD_SANDBOX` /
 * `BUILD_SANDBOX_EU` are the sandbox namespaces of the two container applications.
 */
export interface BuildRunnerBindings extends BuildPlacementBindings {
  /** The build project name; build ids are `${BUILD_PROJECT}:${operationId}`. */
  readonly BUILD_PROJECT: string;
  /** The control API's `BuildReceiptPersistenceService`. */
  readonly BUILD_RECEIPTS: BuildReceiptPersistence;
}

/** `bucket` is the build objects bucket of the project's region; it names where the archive goes. */
export interface BeginArchiveInput {
  readonly scope: OperationScope;
  readonly bucket: string;
}

export interface UploadArchivePartInput {
  readonly upload: ArchiveUploadReceipt;
  readonly partNumber: number;
  readonly body: Uint8Array;
  readonly checksumSha256: string;
}

export interface CompleteArchiveInput {
  readonly upload: ArchiveUploadReceipt;
  readonly parts: readonly ArchivePartReceipt[];
  readonly byteLength: number;
  readonly sourceSha256: string;
}

export interface ObserveArchiveInput {
  readonly scope: OperationScope;
  readonly bucket: string;
  readonly sourceSha256: string;
}

export type StartBuildInput = Parameters<BuildBroker["startBuild"]>[0];

/** A build receipt carries no bucket; the caller names the build objects bucket of its region. */
export interface BuildReceiptInput {
  readonly receipt: BuildReceipt;
  readonly bucket: string;
}

/** An artifact expectation carries no bucket; the caller names the bucket that holds the bundle. */
export interface BuildArtifactInput {
  readonly expectation: BuildArtifactExpectation;
  readonly bucket: string;
}

/**
 * The broker of one build objects bucket: every receipt it accepts or issues names `bucket`, and
 * the sandbox namespace and location hint follow the bucket's region.
 */
export function createBuildRunnerRuntime(
  bindings: BuildRunnerBindings,
  bucket: string,
  dependencies: Readonly<{
    now?: () => Date;
    sleep?: (milliseconds: number) => Promise<void>;
  }> = {},
): RecoverableBuildBroker {
  validateBindings(bindings);
  const placements = buildPlacements(bindings);
  const broker = createBuildBroker({
    objectStore: createR2ObjectStore({
      buckets: placements,
      maximumObjectBytes: MAX_ARCHIVE_BYTES,
    }),
    executor: createSandboxExecutor({
      placements,
      buildProject: bindings.BUILD_PROJECT,
    }),
    now: dependencies.now ?? (() => new Date()),
    sleep:
      dependencies.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    bucket: ofBucket(placements, bucket).bucketName,
    buildProject: bindings.BUILD_PROJECT,
    requestTimeoutMs: 10_000,
    retryDelayMs: 100,
    maximumAttempts: 2,
  });
  return createPersistingBuildBroker(broker, bindings.BUILD_RECEIPTS, {
    buildProject: bindings.BUILD_PROJECT,
  });
}

export async function startBuildRpc(
  run: () => Promise<BuildReceipt>,
): Promise<BuildReceipt | { readonly status: "failed"; readonly errorCode: "BUILD_NOT_STARTED" }> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof BuildStartAbsentError) {
      return Object.freeze({ status: "failed" as const, errorCode: "BUILD_NOT_STARTED" as const });
    }
    throw error;
  }
}

type ArtifactRpcMetadata = Pick<
  VerifiedArtifactBundle,
  "manifestDigest" | "manifestBody" | "migrations" | "provenance"
>;

function artifactRpcMetadata(artifact: VerifiedArtifactBundle): ArtifactRpcMetadata {
  // The broker verifies all bytes; WFP loads that same private object itself. Sending the
  // expanded assets here exceeded Cloudflare's 32-MiB RPC limit in operation 01M3SXFZTET1AJZT9V4X302CMQ.
  return Object.freeze({
    manifestDigest: artifact.manifestDigest,
    manifestBody: artifact.manifestBody,
    migrations: artifact.migrations,
    provenance: artifact.provenance,
  });
}

export async function buildArtifactRpc(
  run: () => Promise<VerifiedArtifactBundle>,
): Promise<
  ArtifactRpcMetadata | { readonly status: "failed"; readonly errorCode: "BUILD_FAILED" }
> {
  try {
    return artifactRpcMetadata(await run());
  } catch (error) {
    if (error instanceof BuildBrokerConflictError) {
      return Object.freeze({ status: "failed" as const, errorCode: "BUILD_FAILED" as const });
    }
    throw error;
  }
}

const privateWorker = {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};

export default privateWorker;

/** Every RPC names its bucket: directly, or through the receipt it carries. */
export class BuildRunnerService extends WorkerEntrypoint<BuildRunnerBindings> {
  public async beginArchive(input: BeginArchiveInput) {
    guardRpcInput(input);
    return createBuildRunnerRuntime(this.env, input.bucket).beginArchive({ scope: input.scope });
  }

  public async uploadArchivePart(input: UploadArchivePartInput) {
    guardRpcInput(input);
    if (!(input.body instanceof Uint8Array) || input.body.byteLength > MAX_RPC_PART_BYTES) {
      throw new BuildBrokerInputError();
    }
    return createBuildRunnerRuntime(this.env, input.upload?.bucket).uploadArchivePart(input);
  }

  public async completeArchive(input: CompleteArchiveInput) {
    guardRpcInput(input);
    if (input.byteLength > MAX_ARCHIVE_BYTES) throw new BuildBrokerInputError();
    return createBuildRunnerRuntime(this.env, input.upload?.bucket).completeArchive(input);
  }

  public async abortArchive(upload: ArchiveUploadReceipt) {
    guardRpcInput(upload);
    return createBuildRunnerRuntime(this.env, upload.bucket).abortArchive(upload);
  }

  public async observeArchive(input: ObserveArchiveInput) {
    guardRpcInput(input);
    return createBuildRunnerRuntime(this.env, input.bucket).observeArchive({
      scope: input.scope,
      sourceSha256: input.sourceSha256,
    });
  }

  public async removeArchive(archive: ArchiveObjectReceipt) {
    guardRpcInput(archive);
    return createBuildRunnerRuntime(this.env, archive.bucket).removeArchive(archive);
  }

  public async startBuild(input: StartBuildInput) {
    guardRpcInput(input);
    return startBuildRpc(() =>
      createBuildRunnerRuntime(this.env, input.archive?.bucket).startBuild(input),
    );
  }

  public async readBuild(input: BuildReceiptInput) {
    guardRpcInput(input);
    return createBuildRunnerRuntime(this.env, input.bucket).readBuild(input.receipt);
  }

  public async stopBuild(input: BuildReceiptInput) {
    guardRpcInput(input);
    return createBuildRunnerRuntime(this.env, input.bucket).stopBuild(input.receipt);
  }

  public async observeBuildArtifact(input: BuildArtifactInput) {
    guardRpcInput(input);
    const artifact = await createBuildRunnerRuntime(this.env, input.bucket).observeBuildArtifact(
      input.expectation,
    );
    return artifact === null ? null : artifactRpcMetadata(artifact);
  }

  public async readBuildArtifact(input: BuildArtifactInput) {
    guardRpcInput(input);
    return buildArtifactRpc(() =>
      createBuildRunnerRuntime(this.env, input.bucket).readBuildArtifact(input.expectation),
    );
  }

  public async removeBuildArtifact(artifact: VerifiedArtifactBundle) {
    guardRpcInput(artifact);
    return createBuildRunnerRuntime(
      this.env,
      artifact.provenance?.output?.bucket,
    ).removeBuildArtifact(artifact);
  }

  public async removeBuildArtifactObject(artifact: ArtifactObjectReceipt) {
    guardRpcInput(artifact);
    return createBuildRunnerRuntime(this.env, artifact.bucket).removeBuildArtifactObject(artifact);
  }
}

function validateBindings(bindings: BuildRunnerBindings): void {
  if (
    bindings === null ||
    typeof bindings !== "object" ||
    typeof bindings.BUILD_PROJECT !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{1,149}$/u.test(bindings.BUILD_PROJECT) ||
    bindings.BUILD_RECEIPTS === undefined ||
    bindings.BUILD_RECEIPTS === null
  ) {
    throw new Error("build_runner_configuration_invalid");
  }
}

function guardRpcInput(input: unknown): void {
  const seen = new Set<object>();
  const pending: unknown[] = [input];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null || value instanceof Uint8Array) continue;
    if (seen.has(value)) throw new BuildBrokerInputError();
    seen.add(value);
    visited += 1;
    if (visited > 20_050) throw new BuildBrokerInputError();
    for (const [name, child] of Object.entries(value)) {
      if (FORBIDDEN_OVERRIDE_KEYS.has(name)) throw new BuildBrokerInputError();
      pending.push(child);
    }
  }
}
