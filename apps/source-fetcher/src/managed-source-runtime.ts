import { parseUlid, type SourceArchiveIdentity } from "@ohmyhost/platform";
import { createBuildArchiveSink, type BuildRunnerBinding } from "./build-archive-sink.js";
import {
  createManagedGitRpc,
  withManagedSourceMemoryBudget,
  observeManagedSourceOperation,
  type ManagedSourceBindings,
} from "./managed-git-rpc.js";
import {
  inspectFrameworkArchive,
  normalizeSourceFetcherFailure,
  SourceFetcherConfigurationError,
  SourceFetcherContractError,
  SourceFetcherInputError,
  type ImmutableSourceArchiveReceipt,
} from "./source-fetcher.js";

const SHA = /^(?!0{40}$)[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

export interface ManagedSourceRuntimeBindings extends ManagedSourceBindings {
  readonly BUILD_RUNNER: BuildRunnerBinding;
  readonly BINDING_REQUEST_TIMEOUT_MS: string;
}

interface ManagedExactRequest {
  readonly provider: "managed";
  readonly organizationId: string;
  readonly billingEpochId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly sourceConnectionId: string;
  readonly region: "us" | "eu";
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly externalRepositoryId: string;
  };
  readonly commitSha: string;
  readonly grant: { readonly grantId: string; readonly grantedAt: string };
  readonly expectedSourceSha256?: string;
  readonly knownArchiveSha256?: string | null;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isManagedSourceRequest(value: unknown): boolean {
  return object(value) && value["provider"] === "managed";
}

function positive(value: string): number {
  const result = Number(value);
  if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(result))
    throw new SourceFetcherConfigurationError();
  return result;
}

function parseRequest(value: unknown, now: Date, inspection: boolean): ManagedExactRequest {
  if (
    !object(value) ||
    value["provider"] !== "managed" ||
    !object(value["repository"]) ||
    !object(value["grant"])
  )
    throw new SourceFetcherInputError();
  const repository = value["repository"];
  if (
    typeof repository["owner"] !== "string" ||
    !NAME.test(repository["owner"]) ||
    typeof repository["name"] !== "string" ||
    !NAME.test(repository["name"]) ||
    repository["externalRepositoryId"] !== `${repository["owner"]}/${repository["name"]}` ||
    typeof value["commitSha"] !== "string" ||
    !SHA.test(value["commitSha"]) ||
    (value["region"] !== "us" && value["region"] !== "eu") ||
    typeof value["idempotencyKey"] !== "string" ||
    value["idempotencyKey"].trim() !== value["idempotencyKey"] ||
    value["idempotencyKey"].length === 0 ||
    value["idempotencyKey"].length > 255
  )
    throw new SourceFetcherInputError();
  for (const key of [
    "organizationId",
    "billingEpochId",
    "projectId",
    "environmentId",
    "operationId",
    "sourceConnectionId",
  ]) {
    if (typeof value[key] !== "string") throw new SourceFetcherInputError();
    try {
      parseUlid(value[key]);
    } catch {
      throw new SourceFetcherInputError();
    }
  }
  const grant = value["grant"];
  if (
    grant["status"] !== "approved" ||
    grant["permission"] !== "contents:read" ||
    grant["revokedAt"] !== null ||
    grant["installationId"] !== null ||
    grant["repositoryId"] !== repository["externalRepositoryId"] ||
    grant["owner"] !== repository["owner"] ||
    grant["repository"] !== repository["name"] ||
    typeof grant["grantId"] !== "string" ||
    typeof grant["grantedAt"] !== "string"
  )
    throw new SourceFetcherInputError();
  try {
    parseUlid(grant["grantId"]);
  } catch {
    throw new SourceFetcherInputError();
  }
  for (const key of ["organizationId", "billingEpochId", "projectId", "sourceConnectionId"])
    if (grant[key] !== value[key]) throw new SourceFetcherInputError();
  const grantedAt = Date.parse(grant["grantedAt"]);
  if (
    !Number.isFinite(grantedAt) ||
    new Date(grantedAt).toISOString() !== grant["grantedAt"] ||
    grantedAt > now.getTime()
  )
    throw new SourceFetcherInputError();
  if (
    !inspection &&
    (typeof value["expectedSourceSha256"] !== "string" ||
      !DIGEST.test(value["expectedSourceSha256"]) ||
      (value["knownArchiveSha256"] !== null &&
        value["knownArchiveSha256"] !== value["expectedSourceSha256"]))
  )
    throw new SourceFetcherInputError();
  return value as unknown as ManagedExactRequest;
}

function identity(request: ManagedExactRequest): SourceArchiveIdentity {
  return {
    context: {
      projectId: parseUlid(request.projectId),
      environmentId: parseUlid(request.environmentId),
      operationId: parseUlid(request.operationId),
      idempotencyKey: request.idempotencyKey,
    },
    source: {
      provider: "managed",
      sourceConnectionId: parseUlid(request.sourceConnectionId),
      externalRepositoryId: request.repository.externalRepositoryId,
      repository: { owner: request.repository.owner, name: request.repository.name },
      requestedCommitSha: request.commitSha,
    },
  };
}

export function createManagedSourceRuntime(
  bindings: ManagedSourceRuntimeBindings,
  overrides: { readonly now?: () => Date; readonly crypto?: SubtleCrypto } = {},
) {
  const now = overrides.now ?? (() => new Date());
  const subtle = overrides.crypto ?? crypto.subtle;
  const rpc = createManagedGitRpc(bindings);
  async function exportSource(raw: unknown, inspection: boolean) {
    const time = now();
    if (!(time instanceof Date) || !Number.isFinite(time.getTime()))
      throw new SourceFetcherConfigurationError();
    const request = parseRequest(raw, time, inspection);
    if (
      bindings.MANAGED_ARTIFACTS_NAMESPACE_US === undefined ||
      bindings.MANAGED_ARTIFACTS_NAMESPACE_EU === undefined
    )
      throw new SourceFetcherConfigurationError();
    // The grant pins the existing repository; current compute placement does not move Git.
    const namespace = request.repository.owner;
    if (
      namespace !== bindings.MANAGED_ARTIFACTS_NAMESPACE_US &&
      namespace !== bindings.MANAGED_ARTIFACTS_NAMESPACE_EU
    )
      throw new SourceFetcherInputError();
    const archive = await rpc
      .adapterForNamespace(namespace)
      .exportCommit({ name: request.repository.name, commitSha: request.commitSha });
    return { request, archive, time };
  }
  return Object.freeze({
    async readArchive(raw: unknown): Promise<Uint8Array> {
      try {
        return await withManagedSourceMemoryBudget(async () => {
          const { archive } = await exportSource(raw, true);
          const hash = Array.from(
            new Uint8Array(await subtle.digest("SHA-256", new Uint8Array(archive.bytes).buffer)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join("");
          if (archive.byteLength !== archive.bytes.byteLength || archive.sha256 !== hash)
            throw new SourceFetcherContractError();
          return archive.bytes;
        });
      } catch (error) {
        throw normalizeSourceFetcherFailure(error);
      }
    },
    async inspectExact(raw: unknown) {
      try {
        return await withManagedSourceMemoryBudget(async () => {
          const { request, archive } = await exportSource(raw, true);
          return Object.freeze({
            resolvedCommitSha: request.commitSha,
            sourceSha256: archive.sha256,
            byteLength: archive.byteLength,
            ...(await inspectFrameworkArchive(archive.bytes)),
          });
        });
      } catch (error) {
        throw normalizeSourceFetcherFailure(error);
      }
    },
    async acquireExact(raw: unknown): Promise<ImmutableSourceArchiveReceipt> {
      try {
        return await withManagedSourceMemoryBudget(async () => {
          const { request, archive, time } = await exportSource(raw, false);
          if (archive.sha256 !== request.expectedSourceSha256)
            throw new SourceFetcherContractError();
          const bucket =
            request.region === "us"
              ? bindings.BUILD_OBJECTS_BUCKET_US
              : bindings.BUILD_OBJECTS_BUCKET_EU;
          if (!/^ohmyho-builds-(?:development|production)(?:-eu)?$/u.test(bucket))
            throw new SourceFetcherConfigurationError();
          const sink = createBuildArchiveSink({
            binding: bindings.BUILD_RUNNER,
            bucket,
            knownArchiveSha256: request.knownArchiveSha256 ?? null,
            expectedSourceSha256: archive.sha256,
            deadline: new Date(time.getTime() + positive(bindings.SOURCE_FETCH_TIMEOUT_MS)),
            now,
            requestTimeoutMs: positive(bindings.BINDING_REQUEST_TIMEOUT_MS),
            crypto: subtle,
            underlyingOperation: observeManagedSourceOperation,
          });
          const exactIdentity = identity(request);
          const observed = await sink.observe(exactIdentity);
          if (observed === null) {
            const writer = await sink.begin(exactIdentity);
            try {
              await writer.write(archive.bytes);
              await writer.commit({
                archiveFormat: "tar.gz",
                byteLength: archive.byteLength,
                sha256: archive.sha256,
              });
            } catch (error) {
              await writer.abort();
              throw error;
            }
          } else if (
            observed.sha256 !== archive.sha256 ||
            observed.byteLength !== archive.byteLength
          )
            throw new SourceFetcherContractError();
          const receipt = sink.archiveReceipt();
          return Object.freeze({
            organizationId: request.organizationId,
            billingEpochId: request.billingEpochId,
            projectId: request.projectId,
            environmentId: request.environmentId,
            operationId: request.operationId,
            sourceConnectionId: request.sourceConnectionId,
            grantId: request.grant.grantId,
            repositoryId: request.repository.externalRepositoryId,
            repository: Object.freeze({
              owner: request.repository.owner,
              name: request.repository.name,
            }),
            commitSha: request.commitSha,
            archiveId: `r2-version:${receipt.bucket}/${receipt.key}#${receipt.versionId}`,
            archiveFormat: "tar.gz",
            byteLength: archive.byteLength,
            sha256: archive.sha256,
            archive: receipt,
          });
        });
      } catch (error) {
        throw normalizeSourceFetcherFailure(error);
      }
    },
  });
}
