import {
  classifyGithubResponse,
  GithubInstallationNotFoundError,
  GithubProviderAuthenticationError,
  GithubProviderContractError,
  GithubProviderInputError,
  GithubProviderTransportError,
  GithubProviderUncertainError,
} from "./errors.js";
import { readBoundedProviderJson } from "./provider-json.js";
import { isRecord, requireBoundedString, requireSafePositiveInteger } from "./validation.js";

export interface GithubUserTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly refreshExpiresAt: string;
}

export function createGithubUserAuthorization(input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly userAgent: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly requestTimeoutMs?: number;
}) {
  const clientId = opaque(input.clientId, 256);
  const clientSecret = opaque(input.clientSecret, 4096);
  let redirect: URL;
  try {
    redirect = new URL(input.redirectUri);
  } catch {
    throw new GithubProviderInputError("invalid_user_authorization");
  }
  const userAgent = requireBoundedString(input.userAgent, 256, "invalid_user_agent");
  const timeout = input.requestTimeoutMs ?? 10_000;
  if (
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.href !== input.redirectUri ||
    /[\r\n]/u.test(userAgent) ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 30_000
  ) {
    throw new GithubProviderInputError("invalid_user_authorization");
  }

  const request = async (
    url: string,
    signal: AbortSignal,
    accessToken?: string,
    form?: URLSearchParams,
    maximumBytes = 64 * 1024,
    installationLookup = false,
  ): Promise<unknown> => {
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await Reflect.apply(input.fetch, globalThis, [
        url,
        {
          method: form ? "POST" : "GET",
          redirect: "manual",
          signal,
          headers: {
            Accept: "application/json",
            "User-Agent": userAgent,
            "X-GitHub-Api-Version": "2026-03-10",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
            ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(form ? { body: form.toString() } : {}),
        },
      ]);
    } catch {
      throw form ? new GithubProviderUncertainError() : new GithubProviderTransportError();
    }
    if (response.status !== 200) {
      // Only the installation lookup reads a 404 as a missing installation; elsewhere it stays an authentication failure.
      if (installationLookup && response.status === 404)
        throw new GithubInstallationNotFoundError();
      classifyGithubResponse(response, form !== undefined);
    }
    const value = await readBoundedProviderJson(response, maximumBytes);
    if (isRecord(value) && value["error"] !== undefined)
      throw new GithubProviderAuthenticationError();
    return value;
  };

  const tokens = async (
    fields: Record<string, string>,
    deadline?: AbortSignal,
  ): Promise<GithubUserTokens> => {
    const value = await request(
      "https://github.com/login/oauth/access_token",
      deadline
        ? AbortSignal.any([deadline, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
      undefined,
      new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
    );
    const now = (input.now?.() ?? new Date()).getTime();
    if (
      !isRecord(value) ||
      value["token_type"] !== "bearer" ||
      !validSecret(value["access_token"]) ||
      !validSecret(value["refresh_token"]) ||
      !positive(value["expires_in"]) ||
      !positive(value["refresh_token_expires_in"]) ||
      !Number.isFinite(now)
    )
      throw new GithubProviderContractError();
    const expiry = now + value["expires_in"] * 1000;
    const refreshExpiry = now + value["refresh_token_expires_in"] * 1000;
    if (
      !Number.isFinite(new Date(expiry).getTime()) ||
      !Number.isFinite(new Date(refreshExpiry).getTime()) ||
      refreshExpiry < expiry
    )
      throw new GithubProviderContractError();
    return Object.freeze({
      accessToken: value["access_token"],
      refreshToken: value["refresh_token"],
      expiresAt: new Date(expiry).toISOString(),
      refreshExpiresAt: new Date(refreshExpiry).toISOString(),
    });
  };

  return Object.freeze({
    /** Installation OAuth does not forward a documented PKCE challenge; state is checked by Control. */
    exchangeInstallationCode(code: string, deadline?: AbortSignal) {
      return tokens({ code: opaque(code, 4096), redirect_uri: redirect.href }, deadline);
    },
    async observeInstallation(target: {
      readonly appJwt: string;
      readonly installationId: number;
    }) {
      return installation(
        await request(
          `https://api.github.com/app/installations/${requireSafePositiveInteger(target.installationId, "invalid_installation_id")}`,
          AbortSignal.timeout(timeout),
          opaque(target.appJwt, 8192),
          undefined,
          64 * 1024,
          true,
        ),
        clientId,
        target.installationId,
      );
    },
    async verifyInstallationOwnership(target: {
      readonly appJwt: string;
      readonly accessToken: string;
      readonly installationId: number;
      readonly deadline?: AbortSignal;
    }) {
      const signal = target.deadline
        ? AbortSignal.any([target.deadline, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout);
      const accessToken = opaque(target.accessToken, 4096);
      const installationId = requireSafePositiveInteger(
        target.installationId,
        "invalid_installation_id",
      );
      const user = await request("https://api.github.com/user", signal, accessToken);
      if (!isRecord(user) || !positive(user["id"]) || !accountLogin(user["login"]))
        throw new GithubProviderContractError();
      const observed = installation(
        await request(
          `https://api.github.com/app/installations/${installationId}`,
          signal,
          opaque(target.appJwt, 8192),
        ),
        clientId,
        installationId,
      );
      const includes = async (
        path: string,
        field: string | null,
        predicate: (value: Record<string, unknown>) => boolean,
      ) => {
        for (let page = 1; page <= 100; page++) {
          const value = await request(
            `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
            signal,
            accessToken,
            undefined,
            2 * 1024 * 1024,
          );
          const rows = field === null ? value : isRecord(value) ? value[field] : undefined;
          if (!Array.isArray(rows) || rows.length > 100 || rows.some((row) => !isRecord(row)))
            throw new GithubProviderContractError();
          if (rows.some((row) => predicate(row as Record<string, unknown>))) return true;
          if (rows.length < 100) return false;
        }
        throw new GithubProviderContractError();
      };
      if (
        !(await includes(
          "https://api.github.com/user/installations",
          "installations",
          (row) => row["id"] === installationId,
        ))
      )
        throw new GithubProviderAuthenticationError();
      const owner =
        observed.accountType === "User"
          ? observed.accountId === user["id"]
          : await includes(
              "https://api.github.com/user/memberships/orgs?state=active",
              null,
              (row) =>
                row["state"] === "active" &&
                row["role"] === "admin" &&
                isRecord(row["organization"]) &&
                row["organization"]["id"] === observed.accountId,
            );
      if (!owner) throw new GithubProviderAuthenticationError();
      return Object.freeze({ ...observed, userId: user["id"], userLogin: user["login"] });
    },
    async resolveRepositoryInstallation(target: {
      readonly appJwt: string;
      readonly owner: string;
      readonly repository: string;
    }): Promise<number> {
      if (
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(target.owner) ||
        !/^[A-Za-z0-9_.-]{1,100}$/u.test(target.repository)
      ) {
        throw new GithubProviderInputError("invalid_user_authorization");
      }
      const value = await request(
        `https://api.github.com/repos/${target.owner}/${target.repository}/installation`,
        AbortSignal.timeout(timeout),
        opaque(target.appJwt, 8192),
      );
      if (
        !isRecord(value) ||
        !positive(value["id"]) ||
        typeof value["client_id"] !== "string" ||
        !(value["suspended_at"] === null || typeof value["suspended_at"] === "string")
      ) {
        throw new GithubProviderContractError();
      }
      if (value["client_id"] !== clientId || value["suspended_at"] !== null) {
        throw new GithubProviderAuthenticationError();
      }
      return value["id"];
    },
    authorizationUrl({
      state,
      codeChallenge,
    }: {
      readonly state: string;
      readonly codeChallenge: string;
    }): string {
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(state) || !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge))
        throw new GithubProviderInputError("invalid_user_authorization");
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect.href,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return url.href;
    },
    exchangeCode({
      code,
      codeVerifier,
      deadline,
    }: {
      readonly code: string;
      readonly codeVerifier: string;
      readonly deadline?: AbortSignal;
    }) {
      if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier))
        throw new GithubProviderInputError("invalid_user_authorization");
      return tokens(
        {
          code: opaque(code, 4096),
          code_verifier: codeVerifier,
          redirect_uri: redirect.href,
        },
        deadline,
      );
    },
    refresh(refreshToken: string) {
      return tokens({ grant_type: "refresh_token", refresh_token: opaque(refreshToken, 4096) });
    },
    async verifyRepositoryAccess(target: {
      readonly accessToken: string;
      readonly installationId: number;
      readonly owner: string;
      readonly repository: string;
    }) {
      const accessToken = opaque(target.accessToken, 4096);
      const installationId = requireSafePositiveInteger(
        target.installationId,
        "invalid_installation_id",
      );
      if (
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(target.owner) ||
        !/^[A-Za-z0-9_.-]{1,100}$/u.test(target.repository)
      )
        throw new GithubProviderInputError("invalid_user_authorization");
      const signal = AbortSignal.timeout(timeout);
      const user = await request("https://api.github.com/user", signal, accessToken);
      if (!isRecord(user) || !positive(user["id"])) throw new GithubProviderContractError();
      const fullName = `${target.owner}/${target.repository}`.toLowerCase();
      for (let page = 1; page <= 100; page++) {
        const value = await request(
          `https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
          signal,
          accessToken,
          undefined,
          2 * 1024 * 1024,
        );
        if (
          !isRecord(value) ||
          !Array.isArray(value["repositories"]) ||
          value["repositories"].length > 100
        )
          throw new GithubProviderContractError();
        const repositories: unknown[] = value["repositories"];
        const matches = repositories.filter(
          (repository) =>
            isRecord(repository) &&
            typeof repository["full_name"] === "string" &&
            repository["full_name"].toLowerCase() === fullName,
        );
        if (matches.length > 1) throw new GithubProviderContractError();
        if (matches.length === 1) {
          const repository = matches[0];
          if (
            !isRecord(repository) ||
            !positive(repository["id"]) ||
            !isRecord(repository["permissions"])
          )
            throw new GithubProviderContractError();
          if (repository["permissions"]["pull"] !== true)
            throw new GithubProviderAuthenticationError();
          return Object.freeze({
            userId: user["id"],
            installationId,
            repositoryId: repository["id"],
            owner: target.owner,
            repository: target.repository,
            permission: "contents:read" as const,
          });
        }
        if (repositories.length < 100) throw new GithubProviderAuthenticationError();
      }
      throw new GithubProviderContractError();
    },
  });
}

function accountLogin(value: unknown): value is string {
  return (
    typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value)
  );
}

function installation(value: unknown, clientId: string, id: number) {
  if (
    !isRecord(value) ||
    value["id"] !== id ||
    typeof value["client_id"] !== "string" ||
    !(value["suspended_at"] === null || typeof value["suspended_at"] === "string") ||
    !isRecord(value["account"]) ||
    !positive(value["account"]["id"]) ||
    !accountLogin(value["account"]["login"]) ||
    !(value["account"]["type"] === "User" || value["account"]["type"] === "Organization") ||
    !(value["repository_selection"] === "all" || value["repository_selection"] === "selected") ||
    typeof value["html_url"] !== "string"
  )
    throw new GithubProviderContractError();
  if (value["client_id"] !== clientId || value["suspended_at"] !== null)
    throw new GithubProviderAuthenticationError();
  const settings = new URL(value["html_url"]);
  if (
    settings.origin !== "https://github.com" ||
    settings.username ||
    settings.password ||
    settings.search ||
    settings.hash ||
    !/^\/(?:settings|organizations\/[A-Za-z0-9-]+\/settings)\/installations\/[1-9][0-9]*$/u.test(
      settings.pathname,
    ) ||
    !settings.pathname.endsWith(`/${id}`)
  )
    throw new GithubProviderContractError();
  return Object.freeze({
    installationId: id,
    accountId: value["account"]["id"],
    accountLogin: value["account"]["login"],
    accountType: value["account"]["type"],
    repositorySelection: value["repository_selection"],
    settingsUrl: settings.href,
  });
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[\u0021-\u007e]+$/u.test(value)
  );
}

function opaque(value: string, maximum: number): string {
  if (!validSecret(value) || value.length > maximum)
    throw new GithubProviderInputError("invalid_user_authorization");
  return value;
}
