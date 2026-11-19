import { expect, test, vi } from "vitest";
import {
  makeAuthorizationUrl,
  exchangeMakeCode,
  refreshMakeToken,
  revokeMakeToken,
} from "../src/providers/make-oauth.js";
import { makeRegistration } from "../src/registry.js";

test("Make OAuth uses the pinned registration and never retries a dispatched code", async () => {
  const registration = makeRegistration("development");
  const url = new URL(
    await makeAuthorizationUrl(registration, "client", "state", "v".repeat(43), null),
  );
  expect(url.origin + url.pathname).toBe(registration.authorizationEndpoint);
  expect(url.searchParams.get("redirect_uri")).toBe(registration.redirectUri);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("v".repeat(43))),
  ).toString("base64url");
  const wrongChallenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("w".repeat(43))),
  ).toString("base64url");
  expect(url.searchParams.get("code_challenge")).toBe(challenge);
  expect(url.searchParams.get("code_challenge")).not.toBe(wrongChallenge);
  expect(url.searchParams.has("nonce")).toBe(false);
  expect(new Set(url.searchParams.get("scope")?.split(" "))).toEqual(
    new Set([
      "apps:read",
      "organizations:read",
      "scenarios:read",
      "scenarios:write",
      "connections:read",
      "connections:write",
      "teams:read",
      "sdk-apps:read",
      "sdk-apps:write",
      "scenarios:run",
      "openid",
      "profile",
      "email",
      "credential-requests:read",
      "scenarios-shared:read",
      "scenarios-shared:write",
      "credential-requests:write",
      "endpoints:read",
      "endpoints:run",
    ]),
  );
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("client_secret")).toBe("secret");
    expect(form.get("code_verifier")).toBe("v".repeat(43));
    return Response.json({
      access_token: "a",
      refresh_token: "r",
      id_token: "id",
      expires_in: 300,
      token_type: "Bearer",
    });
  });
  expect(
    await exchangeMakeCode(
      registration,
      { clientId: "client", clientSecret: "secret" },
      "code",
      "v".repeat(43),
      fetcher,
    ),
  ).toMatchObject({ accessToken: "a", refreshToken: "r", idToken: "id", expiresIn: 300 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await expect(
      exchangeMakeCode(
        registration,
        { clientId: "private-client", clientSecret: "private-secret" },
        "private-code",
        "v".repeat(43),
        async () => new Response("private-body", { status: 400 }),
      ),
    ).rejects.toThrow("authorization_outcome_unknown");
    expect(JSON.stringify(diagnostics.mock.calls)).not.toMatch(/private-/);
  } finally {
    diagnostics.mockRestore();
  }
  for (const [body, status, expected] of [
    [{ error: "invalid_grant" }, 400, "provider_authorization_denied"],
    [{ error: "invalid_client" }, 401, "provider_authorization_denied"],
    [{ error: "invalid_grant", access_token: "issued" }, 400, "authorization_outcome_unknown"],
    [{ error: "other" }, 400, "authorization_outcome_unknown"],
    [{ error: "invalid_grant" }, 500, "authorization_outcome_unknown"],
  ] as const) {
    await expect(
      exchangeMakeCode(
        registration,
        { clientId: "client", clientSecret: "secret" },
        "code",
        "v".repeat(43),
        async () => Response.json(body, { status }),
      ),
    ).rejects.toThrow(expected);
  }
  const lost = vi.fn(async () => {
    throw new Error("sensitive provider details");
  });
  await expect(
    exchangeMakeCode(
      registration,
      { clientId: "client", clientSecret: "secret" },
      "code",
      "v".repeat(43),
      lost,
    ),
  ).rejects.toThrow("authorization_outcome_unknown");
  expect(lost).toHaveBeenCalledTimes(1);
  const malformed = async () =>
    Response.json({
      access_token: "issued",
      refresh_token: "",
      id_token: "id",
      token_type: "Bearer",
      expires_in: 300,
    });
  expect(
    await exchangeMakeCode(
      registration,
      { clientId: "client", clientSecret: "secret" },
      "code",
      "v".repeat(43),
      malformed,
    ),
  ).toEqual({ accessToken: "issued", idToken: "id", expiresIn: 0 });
  const refresh = vi.fn(async () =>
    Response.json({ access_token: "new", token_type: "Bearer", expires_in: 300 }),
  );
  expect(
    (
      await refreshMakeToken(
        registration,
        { clientId: "client", clientSecret: "secret" },
        "old",
        refresh,
      )
    ).refreshToken,
  ).toBeUndefined();
  await expect(
    refreshMakeToken(
      registration,
      { clientId: "client", clientSecret: "secret" },
      "old",
      async () => new Response(null, { status: 429 }),
    ),
  ).rejects.toThrow("provider_rate_limited");
  const revoke = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe(registration.revocationEndpoint);
    expect(init?.headers).toEqual(
      expect.objectContaining({ authorization: "Basic Y2xpZW50OnNlY3JldA==" }),
    );
    expect([...new URLSearchParams(String(init?.body)).entries()]).toEqual([["token", "old"]]);
    return new Response(null, { status: 200 });
  });
  await expect(
    revokeMakeToken(registration, { clientId: "client", clientSecret: "secret" }, "old", revoke),
  ).resolves.toBeUndefined();
  await expect(
    revokeMakeToken(
      registration,
      { clientId: "id: space", clientSecret: "s+é" },
      "old",
      async (_url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          `Basic ${btoa("id%3A+space:s%2B%C3%A9")}`,
        );
        expect([...new URLSearchParams(String(init?.body)).entries()]).toEqual([["token", "old"]]);
        return new Response(null, { status: 200 });
      },
    ),
  ).resolves.toBeUndefined();
  await expect(
    revokeMakeToken(registration, { clientId: "client", clientSecret: "secret" }, "old", lost),
  ).rejects.toThrow("revocation_outcome_unknown");
});

test("Make token scope reflects only recognized provider-returned authority", async () => {
  const registration = makeRegistration("development");
  const client = { clientId: "client", clientSecret: "secret" };
  const response = (scope?: unknown) => async () =>
    Response.json({
      access_token: "token",
      expires_in: 300,
      token_type: "Bearer",
      ...(scope === undefined ? {} : { scope }),
    });
  expect(
    (await refreshMakeToken(registration, client, "refresh", response())).scopes,
  ).toBeUndefined();
  expect(
    (
      await refreshMakeToken(
        registration,
        client,
        "refresh",
        response("scenarios:run unknown scenarios:read scenarios:run"),
      )
    ).scopes,
  ).toEqual(["scenarios:run", "scenarios:read"]);
  expect(
    (await refreshMakeToken(registration, client, "refresh", response(["scenarios:run"]))).scopes,
  ).toEqual([]);
  expect(
    (
      await refreshMakeToken(
        registration,
        client,
        "refresh",
        response("scenarios:run\nscenarios:read"),
      )
    ).scopes,
  ).toEqual([]);
});
