import {
  parseHostingRegion,
  type HostingRegion,
  type SourceArchiveIdentity,
  type SourceArchiveProvider,
  type SourceArchiveReceipt,
  type SourceArchiveSink,
  type Ulid,
} from "@ohmyhost/platform";
import {
  NextWorkersIncompatibleError,
  type NextWorkersIncompatibilityFinding,
} from "@ohmyhost/adapter-next";
import {
  GithubProviderAuthenticationError,
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderRateLimitError,
  GithubProviderTransportError,
  GithubProviderUncertainError,
  type GitHubRepositoryGrant,
  type GitHubRepositoryGrantResolver,
} from "@ohmyhost/provider-github";

import {
  FrameworkConversionRequiredError,
  inspectFrameworkArchive,
  MigrationFilenameNoncanonicalError,
  RepositoryConfigurationMissingError,
  ViteArchiveInspectionError,
} from "./vite-archive-inspector.js";
import type { ArchiveObjectReceipt, BuildArchiveSink } from "./build-archive-sink.js";

export { inspectFrameworkArchive, safeFailure as normalizeSourceFetcherFailure };

const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const COMMIT_PATTERN = /^(?!0{40}$)[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d{0,15}$/u;

type SourceFetcherErrorCode =
  | "source_commit_not_found"
  | "source_repository_configuration_missing"
  | "source_fetch_configuration_unavailable"
  | "source_fetch_contract_invalid"
  | "source_framework_conversion_required"
  | "source_migration_filename_noncanonical"
  | "source_runtime_workers_incompatible"
  | "source_fetch_input_invalid"
  | "source_fetch_transport_failed"
  | "source_fetch_result_uncertain";

class SafeSourceFetcherError extends Error {
  public constructor(
    name: string,
    public readonly code: SourceFetcherErrorCode,
    message: string,
  ) {
    super(message);
    this.name = name;
  }
}

export class SourceFetcherConfigurationError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherConfigurationError",
      "source_fetch_configuration_unavailable",
      "Source fetcher configuration is unavailable",
    );
  }
}

export class SourceFetcherRepositoryConfigurationMissingError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherRepositoryConfigurationMissingError",
      "source_repository_configuration_missing",
      "The Git repository root must contain ohmyhost.yaml",
    );
  }
}

/** The requested SHA is not in the linked repository, usually a commit that was never pushed. */
export class SourceFetcherCommitNotFoundError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherCommitNotFoundError",
      "source_commit_not_found",
      "The linked GitHub repository has no such commit",
    );
  }
}

export class SourceFetcherInputError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherInputError",
      "source_fetch_input_invalid",
      "Source fetch request is invalid",
    );
  }
}

export class SourceFetcherContractError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherContractError",
      "source_fetch_contract_invalid",
      "Source archive provider response is invalid",
    );
  }
}

export class SourceFetcherTransportError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherTransportError",
      "source_fetch_transport_failed",
      "Source archive acquisition failed",
    );
  }
}

export class SourceFetcherUncertainError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherUncertainError",
      "source_fetch_result_uncertain",
      "Source archive acquisition requires reconciliation",
    );
  }
}

export class SourceFetcherWorkersIncompatibleError extends SafeSourceFetcherError {
  public readonly classification = "unsupported";
  public readonly findings: readonly NextWorkersIncompatibilityFinding[];

  public constructor(findings: readonly NextWorkersIncompatibilityFinding[]) {
    super(
      "SourceFetcherWorkersIncompatibleError",
      "source_runtime_workers_incompatible",
      "Source uses a native addon or a Node.js API that does not function on Workers",
    );
    this.findings = Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
  }
}

export class SourceFetcherFrameworkConversionRequiredError extends SafeSourceFetcherError {
  public readonly adapter: FrameworkConversionRequiredError["adapter"];
  public readonly requirement: FrameworkConversionRequiredError["requirement"];
  public readonly diagnostic: FrameworkConversionRequiredError["diagnostic"];

  public constructor(error: FrameworkConversionRequiredError) {
    super(
      "SourceFetcherFrameworkConversionRequiredError",
      "source_framework_conversion_required",
      "Source framework conversion is incomplete",
    );
    this.adapter = error.adapter;
    this.requirement = error.requirement;
    this.diagnostic = error.diagnostic;
  }
}

export class SourceFetcherMigrationFilenameNoncanonicalError extends SafeSourceFetcherError {
  public constructor() {
    super(
      "SourceFetcherMigrationFilenameNoncanonicalError",
      "source_migration_filename_noncanonical",
      "Source PostgreSQL migration filenames are noncanonical",
    );
  }
}

export interface ApprovedRepositoryGrant {
  readonly status: "approved";
  readonly grantId: string;
  readonly organizationId: string;
  readonly billingEpochId: string;
  readonly projectId: string;
  readonly sourceConnectionId: string;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly owner: string;
  readonly repository: string;
  readonly permission: "contents:read";
  readonly grantedAt: string;
  readonly revokedAt: null;
}

export interface SourceFetchRequest {
  readonly organizationId: string;
  readonly billingEpochId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly sourceConnectionId: string;
  /** The project's hosting region; it chooses the build objects bucket of the archive. */
  readonly region: HostingRegion;
  readonly knownArchiveSha256: string | null;
  readonly expectedSourceSha256: string;
  readonly repository: Readonly<{
    owner: string;
    name: string;
    externalRepositoryId: string;
  }>;
  readonly commitSha: string;
  readonly grant: ApprovedRepositoryGrant;
}

export interface ImmutableSourceArchiveReceipt {
  readonly organizationId: string;
  readonly billingEpochId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly sourceConnectionId: string;
  readonly grantId: string;
  readonly repositoryId: string;
  readonly repository: Readonly<{ owner: string; name: string }>;
  readonly commitSha: string;
  readonly archiveId: string;
  readonly archiveFormat: "tar.gz";
  readonly byteLength: number;
  readonly sha256: string;
  readonly archive: ArchiveObjectReceipt;
}

export interface SourceFetcherConfig {
  readonly maximumArchiveBytes: number;
  readonly operationTimeoutMs: number;
}

export interface SourceFetcherDependencies {
  readonly config: SourceFetcherConfig;
  readonly now: () => Date;
  readonly providerFactory: (input: {
    readonly grant: GitHubRepositoryGrant;
    readonly resolver: GitHubRepositoryGrantResolver;
    readonly deadline: Date;
  }) => SourceArchiveProvider;
  readonly sinkFactory: (input: {
    readonly request: SourceFetchRequest;
    readonly deadline: Date;
  }) => BuildArchiveSink;
  readonly repositoryLinkValidator: (input: {
    readonly installationId: number;
    readonly owner: string;
    readonly repository: string;
    readonly deadline: Date;
  }) => Promise<Readonly<{ repositoryId: number; owner: string; name: string }>>;
}

export type SourceInspectionRequest = Omit<
  SourceFetchRequest,
  "expectedSourceSha256" | "knownArchiveSha256" | "region"
>;

export interface RepositoryLinkRequest {
  readonly organizationId: string;
  readonly billingEpochId: string;
  readonly projectId: string;
  readonly environmentId: string;
  readonly operationId: string;
  readonly installationId: number;
  readonly owner: string;
  readonly name: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function parseGrant(
  value: unknown,
  request: Omit<SourceFetchRequest, "grant">,
): ApprovedRepositoryGrant {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "billingEpochId",
      "grantId",
      "grantedAt",
      "installationId",
      "organizationId",
      "owner",
      "permission",
      "projectId",
      "repository",
      "repositoryId",
      "revokedAt",
      "sourceConnectionId",
      "status",
    ]) ||
    value["status"] !== "approved" ||
    typeof value["grantId"] !== "string" ||
    !ULID_PATTERN.test(value["grantId"]) ||
    value["organizationId"] !== request.organizationId ||
    value["billingEpochId"] !== request.billingEpochId ||
    value["projectId"] !== request.projectId ||
    value["sourceConnectionId"] !== request.sourceConnectionId ||
    !positiveSafeInteger(value["installationId"]) ||
    !positiveSafeInteger(value["repositoryId"]) ||
    value["owner"] !== request.repository.owner ||
    value["repository"] !== request.repository.name ||
    String(value["repositoryId"]) !== request.repository.externalRepositoryId ||
    value["permission"] !== "contents:read" ||
    !canonicalTimestamp(value["grantedAt"]) ||
    value["revokedAt"] !== null
  ) {
    throw new SourceFetcherInputError();
  }
  return value as unknown as ApprovedRepositoryGrant;
}

function parseRequest(
  value: unknown,
  config: SourceFetcherConfig,
  now: Date,
  inspection: boolean,
): SourceFetchRequest | SourceInspectionRequest {
  const requestKeys = inspection
    ? [
        "billingEpochId",
        "commitSha",
        "environmentId",
        "grant",
        "idempotencyKey",
        "operationId",
        "organizationId",
        "projectId",
        "repository",
        "sourceConnectionId",
      ]
    : [
        "billingEpochId",
        "commitSha",
        "environmentId",
        "expectedSourceSha256",
        "grant",
        "idempotencyKey",
        "knownArchiveSha256",
        "operationId",
        "organizationId",
        "projectId",
        "region",
        "repository",
        "sourceConnectionId",
      ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, requestKeys) ||
    typeof value["organizationId"] !== "string" ||
    typeof value["billingEpochId"] !== "string" ||
    typeof value["projectId"] !== "string" ||
    typeof value["environmentId"] !== "string" ||
    typeof value["operationId"] !== "string" ||
    typeof value["sourceConnectionId"] !== "string" ||
    ![
      value["organizationId"],
      value["billingEpochId"],
      value["projectId"],
      value["environmentId"],
      value["operationId"],
      value["sourceConnectionId"],
    ].every((candidate) => ULID_PATTERN.test(candidate)) ||
    typeof value["idempotencyKey"] !== "string" ||
    value["idempotencyKey"].length === 0 ||
    value["idempotencyKey"].length > 255 ||
    value["idempotencyKey"].trim() !== value["idempotencyKey"] ||
    (!inspection &&
      value["knownArchiveSha256"] !== null &&
      (typeof value["knownArchiveSha256"] !== "string" ||
        !DIGEST_PATTERN.test(value["knownArchiveSha256"]))) ||
    (!inspection &&
      (typeof value["expectedSourceSha256"] !== "string" ||
        !DIGEST_PATTERN.test(value["expectedSourceSha256"]))) ||
    (!inspection &&
      value["knownArchiveSha256"] !== null &&
      value["knownArchiveSha256"] !== value["expectedSourceSha256"]) ||
    (!inspection && value["region"] !== "us" && value["region"] !== "eu") ||
    typeof value["commitSha"] !== "string" ||
    !COMMIT_PATTERN.test(value["commitSha"]) ||
    !isRecord(value["repository"]) ||
    !hasExactKeys(value["repository"], ["externalRepositoryId", "name", "owner"]) ||
    typeof value["repository"]["owner"] !== "string" ||
    typeof value["repository"]["name"] !== "string" ||
    typeof value["repository"]["externalRepositoryId"] !== "string" ||
    !OWNER_PATTERN.test(value["repository"]["owner"]) ||
    !REPOSITORY_PATTERN.test(value["repository"]["name"]) ||
    !POSITIVE_DECIMAL_PATTERN.test(value["repository"]["externalRepositoryId"])
  ) {
    throw new SourceFetcherInputError();
  }
  const withoutGrant = {
    organizationId: value["organizationId"],
    billingEpochId: value["billingEpochId"],
    projectId: value["projectId"],
    environmentId: value["environmentId"],
    operationId: value["operationId"],
    idempotencyKey: value["idempotencyKey"],
    sourceConnectionId: value["sourceConnectionId"],
    ...(!inspection
      ? {
          region: parseHostingRegion(value["region"]),
          knownArchiveSha256: value["knownArchiveSha256"] as string | null,
          expectedSourceSha256: value["expectedSourceSha256"] as string,
        }
      : {}),
    repository: {
      owner: value["repository"]["owner"],
      name: value["repository"]["name"],
      externalRepositoryId: value["repository"]["externalRepositoryId"],
    },
    commitSha: value["commitSha"],
  } as Omit<SourceFetchRequest, "grant">;
  const grant = parseGrant(value["grant"], withoutGrant);
  if (Date.parse(grant.grantedAt) > now.getTime()) {
    throw new SourceFetcherInputError();
  }
  return Object.freeze({ ...withoutGrant, grant });
}

function validateConfig(config: SourceFetcherConfig): void {
  if (
    !positiveSafeInteger(config.maximumArchiveBytes) ||
    !positiveSafeInteger(config.operationTimeoutMs)
  ) {
    throw new SourceFetcherConfigurationError();
  }
}

function parseRepositoryLink(value: unknown): RepositoryLinkRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "billingEpochId",
      "environmentId",
      "installationId",
      "name",
      "operationId",
      "organizationId",
      "owner",
      "projectId",
    ]) ||
    !["organizationId", "billingEpochId", "projectId", "environmentId", "operationId"].every(
      (key) => typeof value[key] === "string" && ULID_PATTERN.test(value[key] as string),
    ) ||
    !positiveSafeInteger(value["installationId"]) ||
    typeof value["owner"] !== "string" ||
    !OWNER_PATTERN.test(value["owner"]) ||
    typeof value["name"] !== "string" ||
    !REPOSITORY_PATTERN.test(value["name"])
  ) {
    throw new SourceFetcherInputError();
  }
  return Object.freeze(value) as unknown as RepositoryLinkRequest;
}

function validateNow(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new SourceFetcherConfigurationError();
  }
}

function exactIdentity(
  request: SourceFetchRequest | SourceInspectionRequest,
): SourceArchiveIdentity {
  return Object.freeze({
    context: Object.freeze({
      projectId: request.projectId as Ulid,
      environmentId: request.environmentId as Ulid,
      operationId: request.operationId as Ulid,
      idempotencyKey: request.idempotencyKey,
    }),
    source: Object.freeze({
      provider: "github",
      sourceConnectionId: request.sourceConnectionId as Ulid,
      externalRepositoryId: request.repository.externalRepositoryId,
      repository: Object.freeze({ owner: request.repository.owner, name: request.repository.name }),
      requestedCommitSha: request.commitSha,
    }),
  });
}

function exactGrantResolver(
  identity: SourceArchiveIdentity,
  deadline: Date,
  grant: GitHubRepositoryGrant,
): GitHubRepositoryGrantResolver {
  return Object.freeze({
    async resolve(input: Parameters<GitHubRepositoryGrantResolver["resolve"]>[0]) {
      if (
        input.context.projectId !== identity.context.projectId ||
        input.context.environmentId !== identity.context.environmentId ||
        input.context.operationId !== identity.context.operationId ||
        input.context.idempotencyKey !== identity.context.idempotencyKey ||
        input.source.sourceConnectionId !== identity.source.sourceConnectionId ||
        input.source.externalRepositoryId !== identity.source.externalRepositoryId ||
        input.source.repository.owner !== identity.source.repository.owner ||
        input.source.repository.name !== identity.source.repository.name ||
        input.source.requestedCommitSha !== identity.source.requestedCommitSha ||
        input.deadline.getTime() !== deadline.getTime()
      ) {
        throw new SourceFetcherInputError();
      }
      return grant;
    },
  });
}

function inspectionSink(maximumBytes: number): Readonly<{
  sink: SourceArchiveSink;
  archive: () => Uint8Array;
}> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const sink = Object.freeze({
    async observe() {
      return null;
    },
    async begin(identity: SourceArchiveIdentity) {
      let byteLength = 0;
      return Object.freeze({
        async write(chunk: Uint8Array) {
          if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
            throw new SourceFetcherContractError();
          }
          byteLength += chunk.byteLength;
          if (!Number.isSafeInteger(byteLength) || byteLength > maximumBytes) {
            throw new SourceFetcherContractError();
          }
          const owned = new Uint8Array(chunk.byteLength);
          owned.set(chunk);
          chunks.push(owned);
          total += owned.byteLength;
        },
        async commit(metadata: { archiveFormat: "tar.gz"; byteLength: number; sha256: string }) {
          if (
            metadata.archiveFormat !== "tar.gz" ||
            metadata.byteLength !== byteLength ||
            byteLength <= 0 ||
            !DIGEST_PATTERN.test(metadata.sha256)
          ) {
            throw new SourceFetcherContractError();
          }
          return Object.freeze({ identity, archiveId: "inspection", ...metadata });
        },
        async abort() {},
      });
    },
  });
  return Object.freeze({
    sink,
    archive() {
      const archive = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        archive.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return archive;
    },
  });
}

function sameReceipt(
  receipt: SourceArchiveReceipt,
  identity: SourceArchiveIdentity,
  limit: number,
): boolean {
  return (
    receipt.identity.context.projectId === identity.context.projectId &&
    receipt.identity.context.environmentId === identity.context.environmentId &&
    receipt.identity.context.operationId === identity.context.operationId &&
    receipt.identity.context.idempotencyKey === identity.context.idempotencyKey &&
    receipt.identity.source.provider === "github" &&
    receipt.identity.source.sourceConnectionId === identity.source.sourceConnectionId &&
    receipt.identity.source.externalRepositoryId === identity.source.externalRepositoryId &&
    receipt.identity.source.repository.owner === identity.source.repository.owner &&
    receipt.identity.source.repository.name === identity.source.repository.name &&
    receipt.identity.source.requestedCommitSha === identity.source.requestedCommitSha &&
    receipt.archiveFormat === "tar.gz" &&
    typeof receipt.archiveId === "string" &&
    receipt.archiveId.length > 0 &&
    receipt.archiveId.length <= 512 &&
    receipt.archiveId.trim() === receipt.archiveId &&
    !receipt.archiveId.includes("://") &&
    Number.isSafeInteger(receipt.byteLength) &&
    receipt.byteLength > 0 &&
    receipt.byteLength <= limit &&
    DIGEST_PATTERN.test(receipt.sha256)
  );
}

function immutableReceipt(
  request: SourceFetchRequest,
  receipt: SourceArchiveReceipt,
  archive: ArchiveObjectReceipt,
): ImmutableSourceArchiveReceipt {
  const identity = exactIdentity(request);
  const expectedArchiveId = `r2-version:${archive.bucket}/${archive.key}#${archive.versionId}`;
  if (
    !sameReceipt(receipt, identity, Number.MAX_SAFE_INTEGER) ||
    archive.byteLength !== receipt.byteLength ||
    archive.sourceSha256 !== receipt.sha256 ||
    archive.scope.projectId !== request.projectId ||
    archive.scope.environmentId !== request.environmentId ||
    archive.scope.operationId !== request.operationId ||
    archive.key !==
      `runs/${request.projectId}/${request.environmentId}/${request.operationId}/input/source.tar.gz` ||
    receipt.archiveId !== expectedArchiveId
  ) {
    throw new SourceFetcherContractError();
  }
  return Object.freeze({
    organizationId: request.organizationId,
    billingEpochId: request.billingEpochId,
    projectId: request.projectId,
    environmentId: request.environmentId,
    operationId: request.operationId,
    sourceConnectionId: request.sourceConnectionId,
    grantId: request.grant.grantId,
    repositoryId: request.repository.externalRepositoryId,
    repository: Object.freeze({ owner: request.repository.owner, name: request.repository.name }),
    commitSha: request.commitSha,
    archiveId: receipt.archiveId,
    archiveFormat: receipt.archiveFormat,
    byteLength: receipt.byteLength,
    sha256: receipt.sha256,
    archive: Object.freeze({ ...archive, scope: Object.freeze({ ...archive.scope }) }),
  });
}

function safeFailure(error: unknown): SafeSourceFetcherError {
  if (error instanceof SafeSourceFetcherError) return error;
  if (isRecord(error)) {
    if (error["code"] === "managed_source_result_uncertain")
      return new SourceFetcherUncertainError();
    if (error["code"] === "managed_source_not_found") return new SourceFetcherCommitNotFoundError();
    if (error["code"] === "managed_source_input_invalid") return new SourceFetcherInputError();
    if (
      error["code"] === "managed_source_provider_invalid" ||
      error["code"] === "managed_source_limit_exceeded"
    )
      return new SourceFetcherContractError();
  }
  if (
    error instanceof AggregateError &&
    Array.from(error.errors).some(
      (failure) =>
        failure instanceof SourceFetcherUncertainError ||
        failure instanceof GithubProviderUncertainError ||
        (isRecord(failure) && failure["code"] === "build_broker_result_uncertain"),
    )
  ) {
    return new SourceFetcherUncertainError();
  }
  if (error instanceof GithubProviderInputError) {
    // The provider reports GitHub's 422 for a SHA the linked repository lacks with this code.
    const code: string = error.code;
    return code === "requested_commit_not_found"
      ? new SourceFetcherCommitNotFoundError()
      : new SourceFetcherInputError();
  }
  if (error instanceof GithubProviderContractError) return new SourceFetcherContractError();
  if (error instanceof NextWorkersIncompatibleError) {
    return new SourceFetcherWorkersIncompatibleError(error.findings);
  }
  if (error instanceof FrameworkConversionRequiredError) {
    return new SourceFetcherFrameworkConversionRequiredError(error);
  }
  if (error instanceof MigrationFilenameNoncanonicalError) {
    return new SourceFetcherMigrationFilenameNoncanonicalError();
  }
  if (error instanceof RepositoryConfigurationMissingError)
    return new SourceFetcherRepositoryConfigurationMissingError();
  if (error instanceof ViteArchiveInspectionError) return new SourceFetcherContractError();
  if (error instanceof GithubProviderUncertainError) return new SourceFetcherUncertainError();
  if (
    error instanceof GithubProviderTransportError ||
    error instanceof GithubProviderAuthenticationError ||
    error instanceof GithubProviderRateLimitError
  ) {
    return new SourceFetcherTransportError();
  }
  if (isRecord(error) && error["code"] === "build_broker_result_uncertain") {
    return new SourceFetcherUncertainError();
  }
  return new SourceFetcherTransportError();
}

export function createSourceFetcher(dependencies: SourceFetcherDependencies) {
  validateConfig(dependencies.config);
  return Object.freeze({
    async acquireExact(value: unknown): Promise<ImmutableSourceArchiveReceipt> {
      const now = dependencies.now();
      validateNow(now);
      const request = parseRequest(value, dependencies.config, now, false) as SourceFetchRequest;
      const identity = exactIdentity(request);
      const deadline = new Date(now.getTime() + dependencies.config.operationTimeoutMs);
      const grant = Object.freeze({
        installationId: request.grant.installationId,
        repositoryId: request.grant.repositoryId,
        owner: request.grant.owner,
        repository: request.grant.repository,
      });
      const resolver = exactGrantResolver(identity, deadline, grant);
      try {
        const provider = dependencies.providerFactory({ grant, resolver, deadline });
        const sink = dependencies.sinkFactory({ request, deadline });
        const receipt = await provider.acquireExact(
          { identity, maxBytes: dependencies.config.maximumArchiveBytes, deadline },
          sink,
        );
        if (
          !sameReceipt(receipt, identity, dependencies.config.maximumArchiveBytes) ||
          receipt.sha256 !== request.expectedSourceSha256
        ) {
          throw new SourceFetcherContractError();
        }
        return immutableReceipt(request, receipt, sink.archiveReceipt());
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async inspectExact(value: unknown) {
      const now = dependencies.now();
      validateNow(now);
      const request = parseRequest(
        value,
        dependencies.config,
        now,
        true,
      ) as SourceInspectionRequest;
      const identity = exactIdentity(request);
      const deadline = new Date(now.getTime() + dependencies.config.operationTimeoutMs);
      const grant = Object.freeze({
        installationId: request.grant.installationId,
        repositoryId: request.grant.repositoryId,
        owner: request.grant.owner,
        repository: request.grant.repository,
      });
      const resolver = exactGrantResolver(identity, deadline, grant);
      try {
        const provider = dependencies.providerFactory({ grant, resolver, deadline });
        const inspection = inspectionSink(dependencies.config.maximumArchiveBytes);
        const receipt = await provider.acquireExact(
          { identity, maxBytes: dependencies.config.maximumArchiveBytes, deadline },
          inspection.sink,
        );
        if (!sameReceipt(receipt, identity, dependencies.config.maximumArchiveBytes)) {
          throw new SourceFetcherContractError();
        }
        const framework = await inspectFrameworkArchive(inspection.archive());
        return Object.freeze({
          resolvedCommitSha: request.commitSha,
          sourceSha256: receipt.sha256,
          byteLength: receipt.byteLength,
          ...framework,
        });
      } catch (error) {
        throw safeFailure(error);
      }
    },
    /** Return the exact GitHub commit archive only to a trusted service caller. */
    async readArchive(value: unknown): Promise<Uint8Array> {
      const now = dependencies.now();
      validateNow(now);
      const request = parseRequest(
        value,
        dependencies.config,
        now,
        true,
      ) as SourceInspectionRequest;
      const identity = exactIdentity(request);
      const deadline = new Date(now.getTime() + dependencies.config.operationTimeoutMs);
      const grant = Object.freeze({
        installationId: request.grant.installationId,
        repositoryId: request.grant.repositoryId,
        owner: request.grant.owner,
        repository: request.grant.repository,
      });
      const resolver = exactGrantResolver(identity, deadline, grant);
      try {
        const inspection = inspectionSink(dependencies.config.maximumArchiveBytes);
        const receipt = await dependencies
          .providerFactory({ grant, resolver, deadline })
          .acquireExact(
            { identity, maxBytes: dependencies.config.maximumArchiveBytes, deadline },
            inspection.sink,
          );
        const archive = inspection.archive();
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(archive).buffer)),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        if (
          !sameReceipt(receipt, identity, dependencies.config.maximumArchiveBytes) ||
          receipt.byteLength !== archive.byteLength ||
          receipt.sha256 !== hash
        )
          throw new SourceFetcherContractError();
        return archive;
      } catch (error) {
        throw safeFailure(error);
      }
    },
    async validateRepositoryLink(value: unknown) {
      const now = dependencies.now();
      validateNow(now);
      const request = parseRepositoryLink(value);
      const deadline = new Date(now.getTime() + dependencies.config.operationTimeoutMs);
      try {
        const repository = await dependencies.repositoryLinkValidator({
          installationId: request.installationId,
          owner: request.owner,
          repository: request.name,
          deadline,
        });
        // The validator answers with GitHub's canonical owner and name; the requested casing may differ.
        if (
          !positiveSafeInteger(repository.repositoryId) ||
          repository.owner.toLowerCase() !== request.owner.toLowerCase() ||
          repository.name.toLowerCase() !== request.name.toLowerCase()
        ) {
          throw new SourceFetcherContractError();
        }
        return Object.freeze({
          installationId: request.installationId,
          externalRepositoryId: String(repository.repositoryId),
          owner: repository.owner,
          name: repository.name,
          permission: "contents:read" as const,
        });
      } catch (error) {
        throw safeFailure(error);
      }
    },
  });
}
