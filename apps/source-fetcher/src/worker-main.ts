import {
  createGitHubSourceArchiveProvider,
  createGithubUserAuthorization,
  GithubInstallationNotFoundError,
  GithubProviderAuthenticationError,
} from "@ohmyhost/provider-github";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { ProjectPreviewRuntime } from "@ohmyhost/contracts/previews";

import { createBuildArchiveSink, type BuildRunnerBinding } from "./build-archive-sink.js";
import { createBase64GithubAppJwtIssuer } from "./github-app-signer.js";
import { createRepositoryLinkValidator } from "./repository-link-validator.js";
import { createManagedGitRpc, type ManagedSourceBindings } from "./managed-git-rpc.js";
import { createManagedSourceRuntime, isManagedSourceRequest } from "./managed-source-runtime.js";
import { createPreviewSourceReader } from "./preview-source.js";
import {
  createPreviewGithubHeadReader,
  type PreviewGithubHeadRequest,
} from "./preview-github-head.js";
import {
  createSourceFetcher,
  SourceFetcherConfigurationError,
  SourceFetcherInputError,
  type SourceFetcherConfig,
} from "./source-fetcher.js";

export interface SourceFetcherBindings extends ManagedSourceBindings {
  readonly PREVIEW_CONTROL?: Pick<ProjectPreviewRuntime, "readSource">;
  readonly BUILD_RUNNER: BuildRunnerBinding;
  /** The build objects bucket of US projects; part of every stored archive reference. */
  readonly BUILD_OBJECTS_BUCKET_US: string;
  /** The build objects bucket of EU projects; part of every stored archive reference. */
  readonly BUILD_OBJECTS_BUCKET_EU: string;
  /** Worker secret; PKCS#8 DER encoded with canonical standard base64. */
  readonly GITHUB_APP_PRIVATE_KEY_BASE64: string;
  readonly GITHUB_APP_CLIENT_ID: string;
  /** Worker secret used only for customer OAuth code exchange. */
  readonly GITHUB_APP_CLIENT_SECRET: string;
  readonly GITHUB_APP_SLUG: string;
  readonly GITHUB_OAUTH_REDIRECT_URI: string;
  readonly GITHUB_USER_AGENT: string;
  readonly SOURCE_ARCHIVE_MAX_BYTES: string;
  readonly SOURCE_FETCH_TIMEOUT_MS: string;
  readonly PROVIDER_REQUEST_TIMEOUT_MS: string;
  readonly BINDING_REQUEST_TIMEOUT_MS: string;
}

interface RuntimeOverrides {
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly crypto?: SubtleCrypto;
}

function positiveInteger(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/u.test(value)) {
    throw new SourceFetcherConfigurationError();
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new SourceFetcherConfigurationError();
  return parsed;
}

function authorizationInput<const Keys extends readonly string[]>(
  value: unknown,
  keys: Keys,
): Record<Keys[number], string> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SourceFetcherInputError();
  const entries = Object.entries(value);
  if (
    entries.length !== keys.length ||
    entries.some(
      ([key, item]) =>
        !keys.includes(key) || typeof item !== "string" || item.length === 0 || item.length > 4096,
    )
  )
    throw new SourceFetcherInputError();
  return value as Record<Keys[number], string>;
}

export function createSourceFetcherRuntime(
  bindings: SourceFetcherBindings,
  overrides: RuntimeOverrides = {},
) {
  if (
    bindings.BUILD_RUNNER === undefined ||
    typeof bindings.BUILD_OBJECTS_BUCKET_US !== "string" ||
    !/^ohmyho-builds-(?:development|production)$/u.test(bindings.BUILD_OBJECTS_BUCKET_US) ||
    typeof bindings.BUILD_OBJECTS_BUCKET_EU !== "string" ||
    !/^ohmyho-builds-(?:development|production)-eu$/u.test(bindings.BUILD_OBJECTS_BUCKET_EU) ||
    bindings.BUILD_OBJECTS_BUCKET_EU !== `${bindings.BUILD_OBJECTS_BUCKET_US}-eu` ||
    typeof bindings.GITHUB_APP_PRIVATE_KEY_BASE64 !== "string" ||
    typeof bindings.GITHUB_APP_CLIENT_ID !== "string" ||
    typeof bindings.GITHUB_APP_CLIENT_SECRET !== "string" ||
    bindings.GITHUB_APP_CLIENT_SECRET.length < 8 ||
    typeof bindings.GITHUB_APP_SLUG !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/u.test(bindings.GITHUB_APP_SLUG) ||
    typeof bindings.GITHUB_OAUTH_REDIRECT_URI !== "string" ||
    typeof bindings.GITHUB_USER_AGENT !== "string"
  ) {
    throw new SourceFetcherConfigurationError();
  }
  const now = overrides.now ?? (() => new Date());
  const providerFetch: typeof globalThis.fetch =
    overrides.fetch ?? ((request, init) => globalThis.fetch(request, init));
  const subtle = overrides.crypto ?? globalThis.crypto.subtle;
  const providerRequestTimeoutMs = positiveInteger(bindings.PROVIDER_REQUEST_TIMEOUT_MS);
  const bindingRequestTimeoutMs = positiveInteger(bindings.BINDING_REQUEST_TIMEOUT_MS);
  const config: SourceFetcherConfig = {
    maximumArchiveBytes: positiveInteger(bindings.SOURCE_ARCHIVE_MAX_BYTES),
    operationTimeoutMs: positiveInteger(bindings.SOURCE_FETCH_TIMEOUT_MS),
  };
  const buildObjectsBucket = {
    us: bindings.BUILD_OBJECTS_BUCKET_US,
    eu: bindings.BUILD_OBJECTS_BUCKET_EU,
  } as const;
  const appJwtIssuer = createBase64GithubAppJwtIssuer({
    clientId: bindings.GITHUB_APP_CLIENT_ID,
    privateKeyBase64: bindings.GITHUB_APP_PRIVATE_KEY_BASE64,
    crypto: subtle,
  });
  const authorization = createGithubUserAuthorization({
    clientId: bindings.GITHUB_APP_CLIENT_ID,
    clientSecret: bindings.GITHUB_APP_CLIENT_SECRET,
    redirectUri: bindings.GITHUB_OAUTH_REDIRECT_URI,
    userAgent: bindings.GITHUB_USER_AGENT,
    fetch: providerFetch,
    now,
    requestTimeoutMs: providerRequestTimeoutMs,
  });
  const fetcher = createSourceFetcher({
    config,
    now,
    providerFactory: ({ resolver }) =>
      createGitHubSourceArchiveProvider({
        repositoryGrantResolver: resolver,
        appJwtIssuer,
        fetch: providerFetch,
        clock: { now },
        userAgent: bindings.GITHUB_USER_AGENT,
        requestTimeoutMs: providerRequestTimeoutMs,
      }),
    sinkFactory: ({ request, deadline }) =>
      createBuildArchiveSink({
        binding: bindings.BUILD_RUNNER,
        bucket: buildObjectsBucket[request.region],
        knownArchiveSha256: request.knownArchiveSha256,
        expectedSourceSha256: request.expectedSourceSha256,
        deadline,
        now,
        requestTimeoutMs: bindingRequestTimeoutMs,
        crypto: subtle,
      }),
    repositoryLinkValidator: createRepositoryLinkValidator({
      appJwtIssuer,
      fetch: providerFetch,
      now,
      userAgent: bindings.GITHUB_USER_AGENT,
      requestTimeoutMs: providerRequestTimeoutMs,
    }),
  });
  return Object.freeze({
    ...fetcher,
    resolvePreviewGithubHead: createPreviewGithubHeadReader({
      appJwtIssuer,
      fetch: providerFetch,
      now,
      userAgent: bindings.GITHUB_USER_AGENT,
      requestTimeoutMs: providerRequestTimeoutMs,
    }),
    async acquireExact(raw: unknown) {
      if (isManagedSourceRequest(raw))
        return createManagedSourceRuntime(bindings, { now, crypto: subtle }).acquireExact(raw);
      return fetcher.acquireExact(raw);
    },
    async inspectExact(raw: unknown) {
      if (isManagedSourceRequest(raw))
        return createManagedSourceRuntime(bindings, { now, crypto: subtle }).inspectExact(raw);
      return fetcher.inspectExact(raw);
    },
    async beginOrganizationAuthorization(raw: unknown) {
      const value = authorizationInput(raw, ["state", "codeChallenge"]);
      return {
        installationUrl: `https://github.com/apps/${bindings.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(value["state"])}`,
        authorizationUrl: authorization.authorizationUrl({
          state: value["state"],
          codeChallenge: value["codeChallenge"],
        }),
      };
    },
    async completeOrganizationAuthorization(raw: unknown) {
      const hasDeadline =
        !!raw && typeof raw === "object" && !Array.isArray(raw) && "leaseExpiresAt" in raw;
      const value = hasDeadline
        ? authorizationInput(raw, [
            "code",
            "codeVerifier",
            "installationId",
            "flow",
            "leaseExpiresAt",
          ])
        : authorizationInput(raw, ["code", "codeVerifier", "installationId", "flow"]);
      const deadlineValue = hasDeadline
        ? (value as Record<string, string>)["leaseExpiresAt"]
        : undefined;
      const expiresAt = deadlineValue === undefined ? undefined : Date.parse(deadlineValue);
      if (
        deadlineValue !== undefined &&
        (expiresAt === undefined ||
          !Number.isFinite(expiresAt) ||
          new Date(expiresAt).toISOString() !== deadlineValue)
      )
        throw new SourceFetcherInputError();
      const remaining =
        expiresAt === undefined ? 45_000 : Math.min(45_000, expiresAt - Date.now() - 5_000);
      if (remaining <= 0) throw new SourceFetcherInputError();
      if (
        !/^[1-9][0-9]*$/u.test(value["installationId"]) ||
        !["installation", "oauth"].includes(value["flow"])
      )
        throw new SourceFetcherInputError();
      const deadline = AbortSignal.timeout(remaining);
      let tokens;
      try {
        tokens =
          value["flow"] === "installation"
            ? await authorization.exchangeInstallationCode(value["code"], deadline)
            : await authorization.exchangeCode({
                code: value["code"],
                codeVerifier: value["codeVerifier"],
                deadline,
              });
      } catch (error) {
        if (error instanceof GithubProviderAuthenticationError)
          return { status: "authorization_code_rejected" as const };
        throw error;
      }
      try {
        return await authorization.verifyInstallationOwnership({
          accessToken: tokens.accessToken,
          appJwt: await appJwtIssuer.issue(now()),
          installationId: Number(value["installationId"]),
          deadline,
        });
      } catch (error) {
        if (error instanceof GithubProviderAuthenticationError)
          return { status: "account_admin_required" as const };
        throw error;
      }
    },
    async observeOrganizationInstallation(raw: unknown) {
      const value = authorizationInput(raw, ["installationId"]);
      if (!/^[1-9][0-9]*$/u.test(value["installationId"])) throw new SourceFetcherInputError();
      try {
        return await authorization.observeInstallation({
          appJwt: await appJwtIssuer.issue(now()),
          installationId: Number(value["installationId"]),
        });
      } catch (error) {
        // Only a definitive 404 revokes; a rejected credential or a suspended installation leaves the connection as it is.
        if (error instanceof GithubInstallationNotFoundError) return { status: "revoked" as const };
        throw error;
      }
    },
    async validateOrganizationRepository(raw: unknown) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new SourceFetcherInputError();
      const value = raw as Record<string, unknown>;
      if (typeof value["owner"] !== "string" || typeof value["name"] !== "string")
        throw new SourceFetcherInputError();
      try {
        const installationId = await authorization.resolveRepositoryInstallation({
          appJwt: await appJwtIssuer.issue(now()),
          owner: value["owner"],
          repository: value["name"],
        });
        if (installationId !== value["installationId"])
          return { status: "repository_not_installed" as const };
        return await fetcher.validateRepositoryLink(raw);
      } catch (error) {
        if (error instanceof GithubProviderAuthenticationError)
          return { status: "repository_not_installed" as const };
        throw error;
      }
    },
    async beginRepositoryAuthorization(raw: unknown) {
      const value = authorizationInput(raw, ["state", "codeChallenge"]);
      return {
        authorizationUrl: authorization.authorizationUrl({
          state: value["state"],
          codeChallenge: value["codeChallenge"],
        }),
        installationUrl: `https://github.com/apps/${bindings.GITHUB_APP_SLUG}/installations/new`,
      };
    },
    async completeRepositoryAuthorization(raw: unknown) {
      const value = authorizationInput(raw, ["code", "codeVerifier", "owner", "repository"]);
      const owner = value["owner"];
      const repository = value["repository"];
      if (
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
        !/^[A-Za-z0-9_.-]{1,100}$/u.test(repository)
      )
        throw new SourceFetcherInputError();
      // GitHub answers all three customer-fixable denials the same way, and only the step that
      // met one knows which it is. Thrown, they reach the customer as a platform outage.
      let tokens;
      try {
        tokens = await authorization.exchangeCode({
          code: value["code"],
          codeVerifier: value["codeVerifier"],
        });
      } catch (error) {
        if (error instanceof GithubProviderAuthenticationError)
          return { status: "authorization_code_rejected" as const };
        throw error;
      }
      let installationId: number;
      try {
        installationId = await authorization.resolveRepositoryInstallation({
          appJwt: await appJwtIssuer.issue(now()),
          owner,
          repository,
        });
      } catch (error) {
        if (error instanceof GithubProviderAuthenticationError)
          return { status: "repository_not_installed" as const };
        throw error;
      }
      try {
        return await authorization.verifyRepositoryAccess({
          accessToken: tokens.accessToken,
          installationId,
          owner,
          repository,
        });
      } catch (error) {
        if (error instanceof GithubProviderAuthenticationError)
          return { status: "repository_access_required" as const };
        throw error;
      }
    },
  });
}

const privateWorker = {
  async fetch(): Promise<Response> {
    return new Response("Not Found", { status: 404 });
  },
};

export default privateWorker;

export class SourceFetcherService extends WorkerEntrypoint<SourceFetcherBindings> {
  public async resolvePreviewGithubHead(input: PreviewGithubHeadRequest) {
    return createSourceFetcherRuntime(this.env).resolvePreviewGithubHead(input);
  }
  public async previewDiff(
    input: Parameters<ReturnType<typeof createPreviewSourceReader>["diff"]>[0],
  ) {
    const control = this.env.PREVIEW_CONTROL;
    if (control === undefined) throw new SourceFetcherConfigurationError();
    const reader = createPreviewSourceReader({
      readSource: (request) => control.readSource(request),
      readArchive: (source, commitSha, sequence) => {
        const common = {
          organizationId: source.organizationId,
          billingEpochId: source.billingEpochId,
          projectId: source.projectId,
          environmentId: source.environmentId,
          operationId: input.previewId,
          idempotencyKey: `preview:${input.previewId}:${sequence}`,
          sourceConnectionId: source.sourceConnectionId,
          repository: source.repository,
          commitSha,
          grant: source.grant,
        };
        return source.provider === "managed"
          ? createManagedSourceRuntime(this.env).readArchive({
              ...common,
              provider: "managed",
              region: source.region,
            })
          : createSourceFetcherRuntime(this.env).readArchive(common);
      },
    });
    return reader.diff(input);
  }

  public async managedGit(method: string, input: unknown) {
    return createManagedGitRpc(this.env).managedGit(method, input);
  }

  public async managedBlob(method: string, input: unknown) {
    return createManagedGitRpc(this.env).managedBlob(method, input);
  }
  public async beginOrganizationAuthorization(input: unknown) {
    return createSourceFetcherRuntime(this.env).beginOrganizationAuthorization(input);
  }
  public async completeOrganizationAuthorization(input: unknown) {
    return createSourceFetcherRuntime(this.env).completeOrganizationAuthorization(input);
  }
  public async observeOrganizationInstallation(input: unknown) {
    return createSourceFetcherRuntime(this.env).observeOrganizationInstallation(input);
  }
  public async validateOrganizationRepository(input: unknown) {
    return createSourceFetcherRuntime(this.env).validateOrganizationRepository(input);
  }
  public async beginRepositoryAuthorization(input: unknown) {
    return createSourceFetcherRuntime(this.env).beginRepositoryAuthorization(input);
  }

  public async completeRepositoryAuthorization(input: unknown) {
    return createSourceFetcherRuntime(this.env).completeRepositoryAuthorization(input);
  }

  public async acquireExact(input: unknown) {
    if (isManagedSourceRequest(input))
      return createManagedSourceRuntime(this.env).acquireExact(input);
    return createSourceFetcherRuntime(this.env).acquireExact(input);
  }

  /**
   * Refusals are thrown SourceFetcher errors whose own properties (code, adapter, requirement,
   * diagnostic) Control reads. Enhanced error serialization, the default since compatibility date
   * 2026-04-21, carries them across RPC; worker-main.test.ts pins it at the production dates.
   */
  public async inspectExact(input: unknown) {
    if (isManagedSourceRequest(input))
      return createManagedSourceRuntime(this.env).inspectExact(input);
    return createSourceFetcherRuntime(this.env).inspectExact(input);
  }

  public async validateRepositoryLink(input: unknown) {
    return createSourceFetcherRuntime(this.env).validateRepositoryLink(input);
  }
}
