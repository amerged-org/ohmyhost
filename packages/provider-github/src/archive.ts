import {
  classifyGithubResponse,
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderTransportError,
} from "./errors.js";
import { isLowercaseNonzeroSha, requireSafePositiveInteger } from "./validation.js";
import { readBoundedProviderText } from "./provider-json.js";

const GITHUB_API_VERSION = "2026-03-10";
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;
const EXACT_COMMIT_SHA_BYTES = 40;

export interface FetchExactGithubArchiveInput {
  readonly owner: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly requestedSha: string;
  readonly installationToken: string;
  readonly userAgent: string;
  readonly maxArchiveBytes: number;
  readonly requestTimeoutMs: number;
  readonly overallTimeoutMs: number;
  readonly fetch: typeof globalThis.fetch;
  readonly crypto?: SubtleCrypto;
}

export interface ExactGithubArchive {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sha256: string;
  readonly owner: string;
  readonly repository: string;
  readonly repositoryId: number;
  readonly requestedSha: string;
  readonly resolvedCommitSha: string;
}

function providerHeaders(input: FetchExactGithubArchiveInput): Readonly<Record<string, string>> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${input.installationToken}`,
    "User-Agent": input.userAgent,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
}

async function request(
  input: FetchExactGithubArchiveInput,
  url: string,
  init: RequestInit,
  overallSignal: AbortSignal,
): Promise<Response> {
  const signal = AbortSignal.any([overallSignal, AbortSignal.timeout(input.requestTimeoutMs)]);
  try {
    return await input.fetch(url, { ...init, signal });
  } catch {
    throw new GithubProviderTransportError(
      signal.aborted ? "github_request_timeout" : "github_request_failed",
    );
  }
}

function validateInput(input: FetchExactGithubArchiveInput): void {
  if (!OWNER_PATTERN.test(input.owner))
    throw new GithubProviderInputError("invalid_repository_owner");
  if (!REPOSITORY_PATTERN.test(input.repository)) {
    throw new GithubProviderInputError("invalid_repository_name");
  }
  requireSafePositiveInteger(input.repositoryId, "invalid_repository_id");
  if (!isLowercaseNonzeroSha(input.requestedSha)) {
    throw new GithubProviderInputError("invalid_requested_sha");
  }
  if (typeof input.installationToken !== "string" || input.installationToken.length === 0) {
    throw new GithubProviderInputError("invalid_installation_token");
  }
  if (
    typeof input.userAgent !== "string" ||
    input.userAgent.length === 0 ||
    input.userAgent.length > 256
  ) {
    throw new GithubProviderInputError("invalid_user_agent");
  }
  if (!Number.isSafeInteger(input.maxArchiveBytes) || input.maxArchiveBytes <= 0) {
    throw new GithubProviderInputError("invalid_archive_limit");
  }
  if (
    !Number.isSafeInteger(input.requestTimeoutMs) ||
    input.requestTimeoutMs <= 0 ||
    !Number.isSafeInteger(input.overallTimeoutMs) ||
    input.overallTimeoutMs < input.requestTimeoutMs
  ) {
    throw new GithubProviderInputError("invalid_archive_timeout");
  }
}

function validateRedirect(response: Response, input: FetchExactGithubArchiveInput): string {
  if (response.status !== 302 && response.status !== 307)
    throw new GithubProviderContractError("unsafe_archive_redirect");
  const location = response.headers.get("Location");
  if (location === null) throw new GithubProviderContractError("unsafe_archive_redirect");
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    throw new GithubProviderContractError("unsafe_archive_redirect");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "codeload.github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== `/${input.owner}/${input.repository}/legacy.tar.gz/${input.requestedSha}`
  ) {
    throw new GithubProviderContractError("unsafe_archive_redirect");
  }
  return url.href;
}

async function readBoundedArchive(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const header = response.headers.get("Content-Length");
  let declaredLength: number | undefined;
  if (header !== null) {
    if (!/^[1-9]\d*$/u.test(header)) {
      throw new GithubProviderContractError("archive_content_length_invalid");
    }
    declaredLength = Number(header);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
      throw new GithubProviderContractError("archive_content_length_invalid");
    }
  }
  if (response.body === null) throw new GithubProviderContractError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new GithubProviderContractError("archive_stream_too_large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof GithubProviderContractError) throw error;
    throw new GithubProviderTransportError(
      signal.aborted ? "github_request_timeout" : "github_request_failed",
    );
  }
  if (total === 0) throw new GithubProviderContractError("archive_content_length_invalid");
  if (declaredLength !== undefined && total !== declaredLength) {
    throw new GithubProviderContractError("archive_content_length_mismatch");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

export async function fetchExactGithubArchive(
  input: FetchExactGithubArchiveInput,
): Promise<ExactGithubArchive> {
  validateInput(input);
  const overallSignal = AbortSignal.timeout(input.overallTimeoutMs);
  const repositoryPath = `${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`;
  const commitResponse = await request(
    input,
    `https://api.github.com/repos/${repositoryPath}/commits/${input.requestedSha}`,
    {
      method: "GET",
      headers: { ...providerHeaders(input), Accept: "application/vnd.github.sha" },
    },
    overallSignal,
  );
  if (commitResponse.status === 422)
    throw new GithubProviderInputError("requested_commit_not_found");
  if (commitResponse.status !== 200) classifyGithubResponse(commitResponse, false);
  const resolvedSha = await readBoundedProviderText(commitResponse, EXACT_COMMIT_SHA_BYTES);
  if (!isLowercaseNonzeroSha(resolvedSha) || resolvedSha !== input.requestedSha) {
    throw new GithubProviderContractError("commit_sha_mismatch");
  }

  const tarballResponse = await request(
    input,
    `https://api.github.com/repos/${repositoryPath}/tarball/${input.requestedSha}`,
    { method: "GET", headers: providerHeaders(input), redirect: "manual" },
    overallSignal,
  );
  const archiveUrl = validateRedirect(tarballResponse, input);
  const archiveResponse = await request(
    input,
    archiveUrl,
    {
      method: "GET",
      headers: { Accept: "application/octet-stream", "User-Agent": input.userAgent },
      redirect: "manual",
    },
    overallSignal,
  );
  if (archiveResponse.status !== 200) classifyGithubResponse(archiveResponse, false);
  const bytes = await readBoundedArchive(archiveResponse, input.maxArchiveBytes, overallSignal);
  const digest = await (input.crypto ?? globalThis.crypto.subtle).digest(
    "SHA-256",
    Uint8Array.from(bytes),
  );
  return Object.freeze({
    bytes,
    byteLength: bytes.byteLength,
    sha256: toHex(new Uint8Array(digest)),
    owner: input.owner,
    repository: input.repository,
    repositoryId: input.repositoryId,
    requestedSha: input.requestedSha,
    resolvedCommitSha: input.requestedSha,
  });
}
