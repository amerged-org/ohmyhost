import type {
  ExactSourceIdentity,
  ProviderMutationContext,
  SourceArchiveAcquireInput,
  SourceArchiveCommit,
  SourceArchiveProvider,
  SourceArchiveReceipt,
  SourceArchiveSink,
  SourceArchiveWriter,
} from "@ohmyhost/platform";
import type { SourceArchiveIdentity } from "@ohmyhost/platform";

import { createGithubAppJwt, type CreateGithubAppJwtInput } from "./app-jwt.js";
import {
  classifyGithubResponse,
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderTransportError,
  GithubProviderUncertainError,
} from "./errors.js";
import { requestGithubInstallationToken } from "./installation-token.js";
import { readBoundedProviderText } from "./provider-json.js";
import { StreamingSha256 } from "./sha256.js";
import { isLowercaseNonzeroSha, requireSafePositiveInteger } from "./validation.js";

const GITHUB_API_VERSION = "2026-03-10";
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TEMPORARY_ARCHIVE_TOKEN_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/u;
const EXACT_COMMIT_SHA_BYTES = 40;

function isSafeArchiveId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !value.includes("://") &&
    !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  );
}

export interface GitHubRepositoryGrant {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly owner: string;
  readonly repository: string;
}

export interface GitHubRepositoryGrantResolver {
  resolve(input: {
    readonly context: ProviderMutationContext;
    readonly source: ExactSourceIdentity;
    readonly deadline: Date;
  }): Promise<GitHubRepositoryGrant>;
}

export interface GitHubAppJwtIssuer {
  issue(now: Date): Promise<string>;
}

export interface GitHubProviderClock {
  now(): Date;
}

export interface CreateGitHubSourceArchiveProviderInput {
  readonly repositoryGrantResolver: GitHubRepositoryGrantResolver;
  readonly appJwtIssuer: GitHubAppJwtIssuer;
  readonly fetch: typeof globalThis.fetch;
  readonly clock: GitHubProviderClock;
  readonly userAgent: string;
  readonly requestTimeoutMs: number;
}

export function createGitHubAppJwtIssuer(
  input: Omit<CreateGithubAppJwtInput, "now">,
): GitHubAppJwtIssuer {
  return Object.freeze({ issue: async (now: Date) => createGithubAppJwt({ ...input, now }) });
}

function assertFactoryInput(input: CreateGitHubSourceArchiveProviderInput): void {
  if (
    typeof input.userAgent !== "string" ||
    input.userAgent.length === 0 ||
    input.userAgent.length > 256
  ) {
    throw new GithubProviderInputError("invalid_user_agent");
  }
  if (!Number.isSafeInteger(input.requestTimeoutMs) || input.requestTimeoutMs <= 0) {
    throw new GithubProviderInputError("invalid_archive_timeout");
  }
}

function assertAcquireInput(
  input: Parameters<SourceArchiveProvider["acquireExact"]>[0],
  now: Date,
): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new GithubProviderInputError("invalid_clock");
  }
  if (
    input.identity.source.provider !== "github" ||
    !OWNER_PATTERN.test(input.identity.source.repository.owner) ||
    !REPOSITORY_PATTERN.test(input.identity.source.repository.name) ||
    !/^[1-9]\d*$/u.test(input.identity.source.externalRepositoryId) ||
    !isLowercaseNonzeroSha(input.identity.source.requestedCommitSha) ||
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes <= 0 ||
    !(input.deadline instanceof Date) ||
    !Number.isFinite(input.deadline.getTime()) ||
    input.deadline.getTime() <= now.getTime()
  ) {
    throw new GithubProviderInputError("invalid_requested_sha");
  }
}

function assertExactGrant(grant: GitHubRepositoryGrant, source: ExactSourceIdentity): void {
  const installationId = requireSafePositiveInteger(
    grant.installationId,
    "invalid_installation_id",
  );
  const repositoryId = requireSafePositiveInteger(grant.repositoryId, "invalid_repository_id");
  if (
    installationId !== grant.installationId ||
    String(repositoryId) !== source.externalRepositoryId ||
    grant.owner !== source.repository.owner ||
    grant.repository !== source.repository.name
  ) {
    throw new GithubProviderContractError();
  }
}

function receiptMatches(
  receipt: SourceArchiveReceipt,
  identity: SourceArchiveIdentity,
  maximumBytes: number,
): boolean {
  try {
    return (
      receipt.identity.context.operationId === identity.context.operationId &&
      receipt.identity.context.projectId === identity.context.projectId &&
      receipt.identity.context.environmentId === identity.context.environmentId &&
      receipt.identity.context.idempotencyKey === identity.context.idempotencyKey &&
      receipt.identity.source.provider === identity.source.provider &&
      receipt.identity.source.sourceConnectionId === identity.source.sourceConnectionId &&
      receipt.identity.source.externalRepositoryId === identity.source.externalRepositoryId &&
      receipt.identity.source.repository.owner === identity.source.repository.owner &&
      receipt.identity.source.repository.name === identity.source.repository.name &&
      receipt.identity.source.requestedCommitSha === identity.source.requestedCommitSha &&
      receipt.archiveFormat === "tar.gz" &&
      isSafeArchiveId(receipt.archiveId) &&
      Number.isSafeInteger(receipt.byteLength) &&
      receipt.byteLength > 0 &&
      receipt.byteLength <= maximumBytes &&
      DIGEST_PATTERN.test(receipt.sha256)
    );
  } catch {
    return false;
  }
}

function committedReceiptMatches(
  receipt: SourceArchiveReceipt,
  identity: SourceArchiveIdentity,
  metadata: SourceArchiveCommit,
  maximumBytes: number,
): boolean {
  return (
    receiptMatches(receipt, identity, maximumBytes) &&
    receipt.archiveFormat === metadata.archiveFormat &&
    receipt.byteLength === metadata.byteLength &&
    receipt.sha256 === metadata.sha256
  );
}

function remainingTimeout(input: CreateGitHubSourceArchiveProviderInput, deadline: Date): number {
  const remaining = deadline.getTime() - input.clock.now().getTime();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new GithubProviderTransportError("github_request_timeout");
  }
  return Math.max(1, Math.min(input.requestTimeoutMs, Math.floor(remaining)));
}

async function githubRequest(
  input: CreateGitHubSourceArchiveProviderInput,
  deadline: Date,
  url: string,
  init: RequestInit,
): Promise<Readonly<{ response: Response; signal: AbortSignal }>> {
  const signal = AbortSignal.timeout(remainingTimeout(input, deadline));
  try {
    return { response: await input.fetch(url, { ...init, signal }), signal };
  } catch {
    throw new GithubProviderTransportError(
      signal.aborted ? "github_request_timeout" : "github_request_failed",
    );
  }
}

function githubHeaders(token: string, userAgent: string): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": userAgent,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function resolveExactCommit(
  input: CreateGitHubSourceArchiveProviderInput,
  source: ExactSourceIdentity,
  token: string,
  deadline: Date,
): Promise<void> {
  const repositoryPath = `${encodeURIComponent(source.repository.owner)}/${encodeURIComponent(source.repository.name)}`;
  const { response, signal } = await githubRequest(
    input,
    deadline,
    `https://api.github.com/repos/${repositoryPath}/commits/${source.requestedCommitSha}`,
    {
      method: "GET",
      headers: {
        ...githubHeaders(token, input.userAgent),
        Accept: "application/vnd.github.sha",
      },
    },
  );
  if (response.status === 422) throw new GithubProviderInputError("requested_commit_not_found");
  if (response.status !== 200) classifyGithubResponse(response, false);
  const resolvedSha = await readBoundedProviderText(response, EXACT_COMMIT_SHA_BYTES).catch(
    (error: unknown) => {
      if (signal.aborted) throw new GithubProviderTransportError("github_request_timeout");
      throw error;
    },
  );
  if (!isLowercaseNonzeroSha(resolvedSha) || resolvedSha !== source.requestedCommitSha) {
    throw new GithubProviderContractError("commit_sha_mismatch");
  }
}

function exactRedirect(response: Response, source: ExactSourceIdentity): string {
  if (response.status !== 302 && response.status !== 307) {
    throw new GithubProviderContractError("unsafe_archive_redirect");
  }
  const location = response.headers.get("Location");
  if (location === null) throw new GithubProviderContractError("unsafe_archive_redirect");
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new GithubProviderContractError("unsafe_archive_redirect");
  }
  const temporaryTokens = url.searchParams.getAll("token");
  const validTemporaryQuery =
    url.search === "" ||
    (Array.from(url.searchParams.keys()).length === 1 &&
      temporaryTokens.length === 1 &&
      TEMPORARY_ARCHIVE_TOKEN_PATTERN.test(temporaryTokens[0] ?? ""));
  if (
    url.protocol !== "https:" ||
    url.hostname !== "codeload.github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    !validTemporaryQuery ||
    url.hash !== "" ||
    url.pathname !==
      `/${source.repository.owner}/${source.repository.name}/legacy.tar.gz/${source.requestedCommitSha}`
  ) {
    throw new GithubProviderContractError("unsafe_archive_redirect");
  }
  return url.href;
}

async function archiveRedirect(
  input: CreateGitHubSourceArchiveProviderInput,
  source: ExactSourceIdentity,
  token: string,
  deadline: Date,
): Promise<string> {
  const repositoryPath = `${encodeURIComponent(source.repository.owner)}/${encodeURIComponent(source.repository.name)}`;
  const { response } = await githubRequest(
    input,
    deadline,
    `https://api.github.com/repos/${repositoryPath}/tarball/${source.requestedCommitSha}`,
    { method: "GET", headers: githubHeaders(token, input.userAgent), redirect: "manual" },
  );
  return exactRedirect(response, source);
}

function declaredArchiveLength(response: Response, maximumBytes: number): number | undefined {
  const value = response.headers.get("Content-Length");
  if (value === null) return undefined;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new GithubProviderContractError("archive_content_length_invalid");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maximumBytes) {
    throw new GithubProviderContractError("archive_content_length_invalid");
  }
  return length;
}

async function streamArchive(
  response: Response,
  signal: AbortSignal,
  writer: SourceArchiveWriter,
  maximumBytes: number,
): Promise<Readonly<{ byteLength: number; sha256: string }>> {
  const declaredLength = declaredArchiveLength(response, maximumBytes);
  if (response.body === null) throw new GithubProviderContractError();
  const reader = response.body.getReader();
  const hasher = new StreamingSha256();
  let byteLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new GithubProviderContractError("archive_stream_too_large");
      }
      hasher.update(result.value);
      await writer.write(result.value);
    }
  } catch (error) {
    if (error instanceof GithubProviderContractError) throw error;
    if (signal.aborted) throw new GithubProviderTransportError("github_request_timeout");
    throw error;
  }
  if (byteLength === 0) throw new GithubProviderContractError("archive_content_length_invalid");
  if (declaredLength !== undefined && byteLength !== declaredLength) {
    throw new GithubProviderContractError("archive_content_length_mismatch");
  }
  return { byteLength, sha256: hasher.digestHex() };
}

async function abortAfterFailure(writer: SourceArchiveWriter, failure: unknown): Promise<never> {
  try {
    await writer.abort();
  } catch (abortFailure) {
    throw new AggregateError(
      [failure, abortFailure],
      "GitHub archive acquisition and sink abort failed",
    );
  }
  throw failure;
}

export function createGitHubSourceArchiveProvider(
  dependencies: CreateGitHubSourceArchiveProviderInput,
): SourceArchiveProvider {
  assertFactoryInput(dependencies);
  return Object.freeze({
    async acquireExact(
      input: SourceArchiveAcquireInput,
      sink: SourceArchiveSink,
    ): Promise<SourceArchiveReceipt> {
      const now = dependencies.clock.now();
      assertAcquireInput(input, now);
      const existing = await sink.observe(input.identity);
      if (existing !== null) {
        if (!receiptMatches(existing, input.identity, input.maxBytes)) {
          throw new GithubProviderContractError();
        }
        return existing;
      }

      const grant = await dependencies.repositoryGrantResolver.resolve({
        context: input.identity.context,
        source: input.identity.source,
        deadline: input.deadline,
      });
      assertExactGrant(grant, input.identity.source);
      const credentialNow = dependencies.clock.now();
      if (!(credentialNow instanceof Date) || !Number.isFinite(credentialNow.getTime())) {
        throw new GithubProviderInputError("invalid_clock");
      }
      const appJwt = await dependencies.appJwtIssuer.issue(credentialNow);
      const installation = await requestGithubInstallationToken({
        appJwt,
        installationId: grant.installationId,
        repositoryId: grant.repositoryId,
        now: credentialNow,
        userAgent: dependencies.userAgent,
        fetch: dependencies.fetch,
        requestTimeoutMs: remainingTimeout(dependencies, input.deadline),
      });
      await resolveExactCommit(
        dependencies,
        input.identity.source,
        installation.token,
        input.deadline,
      );
      const redirect = await archiveRedirect(
        dependencies,
        input.identity.source,
        installation.token,
        input.deadline,
      );

      const writer = await sink.begin(input.identity);
      let metadata: SourceArchiveCommit;
      try {
        const { response, signal } = await githubRequest(dependencies, input.deadline, redirect, {
          method: "GET",
          headers: { Accept: "application/octet-stream", "User-Agent": dependencies.userAgent },
          redirect: "manual",
        });
        if (response.status !== 200) classifyGithubResponse(response, false);
        metadata = {
          archiveFormat: "tar.gz",
          ...(await streamArchive(response, signal, writer, input.maxBytes)),
        };
      } catch (failure) {
        return abortAfterFailure(writer, failure);
      }

      let receipt: SourceArchiveReceipt;
      try {
        receipt = await writer.commit(metadata);
      } catch {
        throw new GithubProviderUncertainError("github_archive_commit_reconciliation_required");
      }
      if (!committedReceiptMatches(receipt, input.identity, metadata, input.maxBytes)) {
        throw new GithubProviderUncertainError("github_archive_commit_reconciliation_required");
      }
      return receipt;
    },
  });
}
