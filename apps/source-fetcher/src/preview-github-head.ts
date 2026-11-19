import type { GitHubAppJwtIssuer } from "@ohmyhost/provider-github";
import { requestGithubInstallationToken } from "@ohmyhost/provider-github/internal/installation-token";
import {
  SourceFetcherContractError,
  SourceFetcherInputError,
  SourceFetcherTransportError,
} from "./source-fetcher.js";

export interface PreviewGithubHeadRequest {
  readonly installationId: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  /** Null selects the verified repository default branch. */
  readonly ref: string | null;
}
function validRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") || value.length > 1024) return false;
  const branch = value.slice("refs/heads/".length);
  return (
    branch.length > 0 &&
    !Array.from(branch).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(character);
    }) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith(".") &&
    branch
      .split("/")
      .every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok || response.body === null) throw new SourceFetcherTransportError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > 64 * 1024) {
      await reader.cancel();
      throw new SourceFetcherContractError();
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let result: unknown;
  try {
    result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SourceFetcherContractError();
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new SourceFetcherContractError();
  return result as Record<string, unknown>;
}

/** Re-observe provider head so delayed verified webhooks cannot roll the preview backwards. */
export function createPreviewGithubHeadReader(input: {
  readonly appJwtIssuer: GitHubAppJwtIssuer;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => Date;
  readonly userAgent: string;
  readonly requestTimeoutMs: number;
}) {
  return async (request: PreviewGithubHeadRequest) => {
    const installationId = Number(request.installationId),
      repositoryId = Number(request.repositoryId);
    if (
      !/^[1-9][0-9]{0,15}$/u.test(request.installationId) ||
      !Number.isSafeInteger(installationId) ||
      !/^[1-9][0-9]{0,15}$/u.test(request.repositoryId) ||
      !Number.isSafeInteger(repositoryId) ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u.test(
        request.repositoryFullName,
      ) ||
      (request.ref !== null && !validRef(request.ref))
    )
      throw new SourceFetcherInputError();
    const now = input.now();
    const token = await requestGithubInstallationToken({
      appJwt: await input.appJwtIssuer.issue(now),
      installationId,
      repositoryId,
      now,
      userAgent: input.userAgent,
      fetch: input.fetch,
      requestTimeoutMs: input.requestTimeoutMs,
    });
    const repositoryPath = request.repositoryFullName.split("/").map(encodeURIComponent).join("/");
    const get = async (path: string) => {
      let response: Response;
      try {
        response = await input.fetch(`https://api.github.com/repos/${repositoryPath}${path}`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token.token}`,
            "User-Agent": input.userAgent,
            "X-GitHub-Api-Version": "2026-03-10",
          },
          signal: AbortSignal.timeout(input.requestTimeoutMs),
        });
      } catch {
        throw new SourceFetcherTransportError();
      }
      return boundedJson(response);
    };
    const repo = await get("");
    if (
      repo["id"] !== repositoryId ||
      typeof repo["full_name"] !== "string" ||
      repo["full_name"].toLowerCase() !== request.repositoryFullName.toLowerCase() ||
      typeof repo["default_branch"] !== "string" ||
      !validRef(`refs/heads/${repo["default_branch"]}`)
    )
      throw new SourceFetcherContractError();
    const selectedRef = request.ref ?? `refs/heads/${repo["default_branch"]}`;
    const branchPath = selectedRef
      .slice("refs/".length)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const ref = await get(`/git/ref/${branchPath}`);
    const object = ref["object"];
    if (
      ref["ref"] !== selectedRef ||
      !object ||
      typeof object !== "object" ||
      Array.isArray(object) ||
      (object as Record<string, unknown>)["type"] !== "commit" ||
      typeof (object as Record<string, unknown>)["sha"] !== "string" ||
      !/^(?!0{40}$)[0-9a-f]{40}$/u.test((object as Record<string, unknown>)["sha"] as string)
    )
      throw new SourceFetcherContractError();
    return {
      defaultBranch: `refs/heads/${repo["default_branch"]}`,
      head: (object as { sha: string }).sha,
    };
  };
}
