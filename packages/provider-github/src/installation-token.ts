import {
  classifyGithubResponse,
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderUncertainError,
} from "./errors.js";
import { isRecord, requireBoundedString, requireSafePositiveInteger } from "./validation.js";
import { readBoundedProviderJson } from "./provider-json.js";

const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAXIMUM_TOKEN_LIFETIME_MS = 60 * 60 * 1_000;
const EXPIRY_TOLERANCE_MS = 60 * 1_000;
const MAXIMUM_TOKEN_RESPONSE_BYTES = 64 * 1_024;

export interface RequestGithubInstallationTokenInput {
  readonly appJwt: string;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly now: Date;
  readonly userAgent: string;
  readonly fetch: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

export interface GithubInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
  readonly installationId: number;
  readonly repositoryId: number;
  readonly permissions: Readonly<{ contents: "read" }>;
}

function parseTokenResponse(
  value: unknown,
  input: Readonly<{ now: Date; installationId: number; repositoryId: number }>,
): GithubInstallationToken {
  if (!isRecord(value)) throw new GithubProviderContractError();
  const token = value["token"];
  const expiresAt = value["expires_at"];
  const selection = value["repository_selection"];
  const permissions = value["permissions"];
  if (typeof token !== "string" || token.length === 0 || typeof expiresAt !== "string") {
    throw new GithubProviderContractError();
  }
  const expiryMs = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiryMs) ||
    expiryMs <= input.now.getTime() ||
    expiryMs > input.now.getTime() + MAXIMUM_TOKEN_LIFETIME_MS + EXPIRY_TOLERANCE_MS
  ) {
    throw new GithubProviderContractError();
  }
  if (selection !== "selected" || !isRecord(permissions) || permissions["contents"] !== "read") {
    throw new GithubProviderContractError();
  }
  for (const [permission, access] of Object.entries(permissions)) {
    if ((permission !== "contents" && permission !== "metadata") || access !== "read") {
      throw new GithubProviderContractError();
    }
  }
  const repositories = value["repositories"];
  if (
    !Array.isArray(repositories) ||
    repositories.length !== 1 ||
    !isRecord(repositories[0]) ||
    repositories[0]["id"] !== input.repositoryId
  ) {
    throw new GithubProviderContractError();
  }
  return Object.freeze({
    token,
    expiresAt,
    installationId: input.installationId,
    repositoryId: input.repositoryId,
    permissions: Object.freeze({ contents: "read" as const }),
  });
}

export async function requestGithubInstallationToken(
  input: RequestGithubInstallationTokenInput,
): Promise<GithubInstallationToken> {
  const installationId = requireSafePositiveInteger(
    input.installationId,
    "invalid_installation_id",
  );
  const repositoryId = requireSafePositiveInteger(input.repositoryId, "invalid_repository_id");
  const appJwt = requireBoundedString(input.appJwt, 16_384, "invalid_installation_token");
  const userAgent = requireBoundedString(input.userAgent, 256, "invalid_user_agent");
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    throw new GithubProviderInputError("invalid_clock");
  }
  const timeoutMs = input.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GithubProviderInputError("invalid_archive_timeout");
  }

  let response: Response;
  try {
    response = await input.fetch(
      `https://api.github.com/app/installations/${String(installationId)}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt}`,
          "Content-Type": "application/json",
          "User-Agent": userAgent,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
        body: JSON.stringify({ repository_ids: [repositoryId], permissions: { contents: "read" } }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch {
    throw new GithubProviderUncertainError();
  }
  if (response.status !== 201) classifyGithubResponse(response, true);

  const body = await readBoundedProviderJson(response, MAXIMUM_TOKEN_RESPONSE_BYTES);
  return parseTokenResponse(body, { now: input.now, installationId, repositoryId });
}
