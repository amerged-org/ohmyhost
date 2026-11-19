import type { ProviderRegistration } from "../registry.js";
import { KnownExchangeRejection, type OAuthClient, type OAuthTokens } from "../adapter.js";
function validate(registration: ProviderRegistration, clientId: string): void {
  if (
    registration.provider !== "make" ||
    registration.issuer !== "https://www.make.com" ||
    registration.tokenEndpoint !== "https://www.make.com/oauth/v2/token" ||
    registration.authorizationEndpoint !== "https://www.make.com/oauth/v2/authorize" ||
    ![
      "https://connect.ohmyho.st/oauth/callback",
      "https://dev.connect.ohmyho.st/oauth/callback",
    ].includes(registration.redirectUri) ||
    registration.registration !==
      (registration.redirectUri === "https://connect.ohmyho.st/oauth/callback"
        ? "make-production-3"
        : "make-development-3") ||
    !clientId
  )
    throw new Error("provider_unconfigured");
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
export async function makeAuthorizationUrl(
  registration: ProviderRegistration,
  clientId: string,
  state: string,
  verifier: string,
  nonce: string | null,
): Promise<string> {
  validate(registration, clientId);
  if (
    registration.noncePolicy !== "not_requested" ||
    nonce !== null ||
    !state ||
    !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)
  )
    throw new Error("invalid_authorization_request");
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const url = new URL(registration.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: registration.redirectUri,
    scope: registration.allowedScopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}
async function isKnownExchangeRejection(response: Response): Promise<boolean> {
  if (
    !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
    !response.body
  )
    return false;
  try {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 8192) {
          await reader.cancel();
          return false;
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if ((text.match(/"error"\s*:/gu) ?? []).length !== 1) return false;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const data = value as Record<string, unknown>;
    return (
      Object.keys(data).every(
        (key) =>
          ["error", "error_description", "error_uri"].includes(key) &&
          typeof data[key] === "string",
      ) &&
      [
        "invalid_request",
        "invalid_client",
        "invalid_grant",
        "unauthorized_client",
        "unsupported_grant_type",
        "invalid_scope",
      ].includes(data["error"] as string)
    );
  } catch {
    return false;
  }
}
async function requestToken(
  registration: ProviderRegistration,
  client: OAuthClient,
  body: URLSearchParams,
  fetcher: typeof fetch,
  uncertainty: string,
): Promise<OAuthTokens> {
  validate(registration, client.clientId);
  if (!client.clientSecret) throw new Error("provider_unconfigured");
  body.set("client_id", client.clientId);
  body.set("client_secret", client.clientSecret);
  let response: Response;
  try {
    response = await fetcher(registration.tokenEndpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
  } catch {
    if (body.get("grant_type") === "authorization_code")
      console.error(
        JSON.stringify({
          event: "connection_broker_failure",
          phase: "token_exchange",
          reason: "network",
        }),
      );
    throw new Error(uncertainty);
  }
  if (!response.ok) {
    if (
      body.get("grant_type") === "authorization_code" &&
      (response.status === 400 || response.status === 401)
    ) {
      if (await isKnownExchangeRejection(response)) throw new KnownExchangeRejection();
      throw new Error(uncertainty);
    }
    if (body.get("grant_type") === "authorization_code") {
      const reason =
        response.status >= 500
          ? "http_5xx"
          : response.status >= 400
            ? "http_4xx"
            : response.status >= 300
              ? "http_3xx"
              : "network";
      console.error(
        JSON.stringify({ event: "connection_broker_failure", phase: "token_exchange", reason }),
      );
    }
    if (body.get("grant_type") === "authorization_code") throw new Error(uncertainty);
    throw new Error(
      response.status === 429 && body.get("grant_type") === "refresh_token"
        ? "provider_rate_limited"
        : response.status >= 500
          ? uncertainty
          : "provider_authorization_denied",
    );
  }
  try {
    if (!response.body) throw new Error();
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65536) {
          await reader.cancel();
          throw new Error();
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const data = value as Record<string, unknown>;
    if (
      typeof data["access_token"] !== "string" ||
      !data["access_token"] ||
      data["access_token"].length > 16384
    )
      throw new Error();
    const refresh = data["refresh_token"],
      idToken = data["id_token"];
    const validOptional = (value: unknown) =>
      value === undefined ||
      (typeof value === "string" && value.length > 0 && value.length <= 16384);
    const validRefresh = validOptional(refresh),
      validIdentity = validOptional(idToken);
    // Return already-issued tokens to the caller for revocation even if expiry or
    // token type is malformed; zero is never accepted for activation or refresh.
    const validExpiry =
      validRefresh &&
      validIdentity &&
      typeof data["expires_in"] === "number" &&
      Number.isSafeInteger(data["expires_in"]) &&
      data["expires_in"] > 0 &&
      data["expires_in"] <= 315360000 &&
      typeof data["token_type"] === "string" &&
      data["token_type"].toLowerCase() === "bearer";
    // Only provider-returned scopes prove consent. An absent scope is distinct
    // from a malformed scope, which must never preserve or grant authority.
    const scope = data["scope"];
    const scopes =
      scope === undefined
        ? undefined
        : typeof scope === "string" &&
            scope.length <= 4096 &&
            /^(?:[\x21\x23-\x5B\x5D-\x7E]+)(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/u.test(scope)
          ? [
              ...new Set(
                scope.split(" ").filter((item) => registration.allowedScopes.includes(item)),
              ),
            ]
          : [];
    return {
      accessToken: data["access_token"],
      ...(scopes === undefined ? {} : { scopes }),
      expiresIn: validExpiry ? (data["expires_in"] as number) : 0,
      ...(typeof refresh === "string" && validRefresh ? { refreshToken: refresh } : {}),
      ...(typeof idToken === "string" && validIdentity ? { idToken } : {}),
    };
  } catch {
    throw new Error(uncertainty);
  }
}
export async function exchangeMakeCode(
  registration: ProviderRegistration,
  client: OAuthClient,
  code: string,
  verifier: string,
  fetcher: typeof fetch = fetch,
): Promise<OAuthTokens> {
  if (!code || code.length > 4096 || !/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier))
    throw new Error("invalid_authorization_request");
  const result = await requestToken(
    registration,
    client,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: registration.redirectUri,
      code_verifier: verifier,
    }),
    fetcher,
    "authorization_outcome_unknown",
  );
  return result;
}
export async function refreshMakeToken(
  registration: ProviderRegistration,
  client: OAuthClient,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<OAuthTokens> {
  if (!refreshToken || refreshToken.length > 16384) throw new Error("invalid_refresh_request");
  return requestToken(
    registration,
    client,
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    fetcher,
    "refresh_outcome_unknown",
  );
}

export async function revokeMakeToken(
  registration: ProviderRegistration,
  client: OAuthClient,
  refreshToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  validate(registration, client.clientId);
  if (
    registration.revocationEndpoint !== "https://www.make.com/oauth/v2/revoke" ||
    !client.clientSecret ||
    !refreshToken ||
    refreshToken.length > 16384
  )
    throw new Error("invalid_revocation_request");
  let reason: "network" | "http_3xx" | "http_4xx" | "http_5xx" = "network";
  try {
    const response = await fetcher(registration.revocationEndpoint, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${btoa(`${new URLSearchParams({ x: client.clientId }).toString().slice(2)}:${new URLSearchParams({ x: client.clientSecret }).toString().slice(2)}`)}`,
      },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    if (!response.ok) {
      if (response.status >= 500) reason = "http_5xx";
      else if (response.status >= 400) reason = "http_4xx";
      else if (response.status >= 300) reason = "http_3xx";
      throw new Error();
    }
  } catch {
    console.error(
      JSON.stringify({ event: "connection_broker_failure", phase: "revocation", reason }),
    );
    throw new Error("revocation_outcome_unknown");
  }
}
