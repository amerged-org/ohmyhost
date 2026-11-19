import type { GitHubAppJwtIssuer } from "@ohmyhost/provider-github";

import { SourceFetcherContractError, SourceFetcherTransportError } from "./source-fetcher.js";

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;

interface RepositoryLinkValidatorInput {
  readonly installationId: number;
  readonly owner: string;
  readonly repository: string;
  readonly deadline: Date;
}

interface CreateRepositoryLinkValidatorInput {
  readonly appJwtIssuer: GitHubAppJwtIssuer;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => Date;
  readonly userAgent: string;
  readonly requestTimeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createRepositoryLinkValidator(input: CreateRepositoryLinkValidatorInput) {
  return async ({ installationId, owner, repository, deadline }: RepositoryLinkValidatorInput) => {
    const now = input.now();
    const remaining = deadline.getTime() - now.getTime();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new SourceFetcherTransportError();
    const jwt = await input.appJwtIssuer.issue(now);
    let response: Response;
    try {
      response = await input.fetch(
        `https://api.github.com/app/installations/${String(installationId)}/access_tokens`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${jwt}`,
            "Content-Type": "application/json",
            "User-Agent": input.userAgent,
            "X-GitHub-Api-Version": "2026-03-10",
          },
          body: JSON.stringify({
            repositories: [repository],
            permissions: { contents: "read" },
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(input.requestTimeoutMs, remaining))),
        },
      );
    } catch {
      throw new SourceFetcherTransportError();
    }
    if (response.status !== 201) throw new SourceFetcherTransportError();
    const contentLength = response.headers.get("content-length");
    if (
      contentLength !== null &&
      (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAXIMUM_RESPONSE_BYTES)
    ) {
      throw new SourceFetcherContractError();
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_RESPONSE_BYTES) {
      throw new SourceFetcherContractError();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new SourceFetcherContractError();
    }
    if (!isRecord(value) || value["repository_selection"] !== "selected") {
      throw new SourceFetcherContractError();
    }
    const token = value["token"];
    const expiresAt = value["expires_at"];
    const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    const permissions = value["permissions"];
    const repositories = value["repositories"];
    const selectedRepository = Array.isArray(repositories) ? repositories[0] : undefined;
    const name = isRecord(selectedRepository) ? selectedRepository["name"] : undefined;
    const fullName = isRecord(selectedRepository) ? selectedRepository["full_name"] : undefined;
    // GitHub matches the requested names without regard to case and answers with its canonical spelling.
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      !Number.isFinite(expiry) ||
      expiry <= now.getTime() ||
      expiry > now.getTime() + 61 * 60 * 1000 ||
      !isRecord(permissions) ||
      permissions["contents"] !== "read" ||
      Object.entries(permissions).some(
        ([name, access]) => (name !== "contents" && name !== "metadata") || access !== "read",
      ) ||
      !Array.isArray(repositories) ||
      repositories.length !== 1 ||
      !isRecord(selectedRepository) ||
      !Number.isSafeInteger(selectedRepository["id"]) ||
      typeof selectedRepository["id"] !== "number" ||
      selectedRepository["id"] <= 0 ||
      typeof name !== "string" ||
      name.toLowerCase() !== repository.toLowerCase() ||
      typeof fullName !== "string" ||
      fullName.toLowerCase() !== `${owner}/${repository}`.toLowerCase() ||
      fullName.indexOf("/") !== fullName.lastIndexOf("/") ||
      fullName.slice(fullName.indexOf("/") + 1) !== name
    ) {
      throw new SourceFetcherContractError();
    }
    const canonicalOwner = fullName.slice(0, fullName.indexOf("/"));
    return Object.freeze({
      repositoryId: selectedRepository["id"],
      owner: canonicalOwner,
      name,
    });
  };
}
