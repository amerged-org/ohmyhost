import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createGithubUserAuthorization } from "./user-authorization.js";

async function fixture() {
  const calls: { path: string; authorization: string | undefined; body: string }[] = [];
  let mode = "ok";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const path = request.url ?? "/";
    calls.push({ path, authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (mode === "unavailable") {
      response.writeHead(503);
      response.end('{"message":"secret-canary"}');
      return;
    }
    if (mode === "oversize") {
      response.end(JSON.stringify({ value: "x".repeat(3 * 1024 * 1024) }));
      return;
    }
    if (path === "/app/installations/42") {
      response.end(
        JSON.stringify({
          id: 42,
          client_id: "client-id",
          suspended_at: null,
          account: {
            id: mode.startsWith("org") ? 70 : 7,
            login: mode.startsWith("org") ? "team" : "customer",
            type: mode.startsWith("org") ? "Organization" : "User",
          },
          repository_selection: "all",
          html_url: "https://github.com/settings/installations/42",
        }),
      );
    } else if (path.startsWith("/user/installations?")) {
      response.end(
        JSON.stringify({ installations: mode === "foreign-installation" ? [] : [{ id: 42 }] }),
      );
    } else if (path.startsWith("/user/memberships/orgs?")) {
      response.end(
        JSON.stringify([
          {
            state: "active",
            role: mode === "org-member" ? "member" : "admin",
            organization: { id: 70 },
          },
        ]),
      );
    } else if (path === "/repos/customer/app/installation") {
      response.end(
        JSON.stringify({
          id: 42,
          client_id: mode === "foreign-app" ? "another-client" : "client-id",
          suspended_at: null,
        }),
      );
    } else if (path === "/login/oauth/access_token") {
      response.end(
        JSON.stringify(
          mode === "malformed"
            ? { access_token: "secret-canary" }
            : {
                access_token: "user-access-token",
                refresh_token: "user-refresh-token",
                token_type: "bearer",
                expires_in: 28800,
                refresh_token_expires_in: 15897600,
              },
        ),
      );
    } else if (path === "/user")
      response.end('{"id":7,"login":"customer","email":"not-returned@example.test"}');
    else if (path.startsWith("/user/installations/42/repositories?")) {
      if (
        mode === "paged" &&
        new URL(path, "http://fixture.test").searchParams.get("page") === "1"
      ) {
        response.end(
          JSON.stringify({
            total_count: 101,
            repositories: Array.from({ length: 100 }, (_, id) => ({
              id: id + 1000,
              full_name: `customer/other-${id}`,
            })),
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          total_count: 1,
          repositories: [
            {
              id: 99,
              name: "app",
              full_name: "customer/app",
              owner: { login: "customer" },
              permissions: { pull: mode !== "denied" },
              temp_clone_token: "secret-canary",
            },
          ],
        }),
      );
    } else {
      response.writeHead(404);
      response.end('{"message":"secret-canary"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const provider = createGithubUserAuthorization({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
    userAgent: "ohmyhost-test",
    now: () => new Date("2026-09-05T00:00:00.000Z"),
    fetch: (input, init) => {
      const original = new URL(String(input));
      expect(["https://github.com", "https://api.github.com"]).toContain(original.origin);
      return fetch(`http://127.0.0.1:${address.port}${original.pathname}${original.search}`, init);
    },
  });
  return {
    provider,
    calls,
    setMode(value: string) {
      mode = value;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("GitHub customer authorization", () => {
  it("proves the installation owner before granting organization-wide access and drops tokens", async () => {
    const test = await fixture();
    try {
      const target = {
        accessToken: "user-access-token",
        appJwt: "private-app-jwt",
        installationId: 42,
      };
      await expect(test.provider.observeInstallation(target)).resolves.toMatchObject({
        installationId: 42,
        accountId: 7,
      });
      await expect(test.provider.verifyInstallationOwnership(target)).resolves.toMatchObject({
        installationId: 42,
        accountId: 7,
        accountLogin: "customer",
        accountType: "User",
        userId: 7,
        userLogin: "customer",
      });
      test.setMode("org-admin");
      const proof = await test.provider.verifyInstallationOwnership(target);
      expect(proof).toMatchObject({ accountId: 70, accountType: "Organization" });
      expect(JSON.stringify(proof)).not.toContain("token");
      for (const mode of ["org-member", "foreign-installation"]) {
        test.setMode(mode);
        await expect(test.provider.verifyInstallationOwnership(target)).rejects.toMatchObject({
          code: "github_authentication_failed",
        });
      }
      await test.provider.exchangeInstallationCode("install-code");
      expect(new URLSearchParams(test.calls.at(-1)?.body).has("code_verifier")).toBe(false);
    } finally {
      await test.close();
    }
  });
  it("resolves the selected repository through this App before checking the customer's access", async () => {
    const test = await fixture();
    try {
      await expect(
        test.provider.resolveRepositoryInstallation({
          appJwt: "private-app-jwt",
          owner: "customer",
          repository: "app",
        }),
      ).resolves.toBe(42);
      expect(test.calls[0]).toMatchObject({
        path: "/repos/customer/app/installation",
        authorization: "Bearer private-app-jwt",
      });
      test.setMode("foreign-app");
      await expect(
        test.provider.resolveRepositoryInstallation({
          appJwt: "private-app-jwt",
          owner: "customer",
          repository: "app",
        }),
      ).rejects.toThrow();
      await expect(
        test.provider.resolveRepositoryInstallation({
          appJwt: "private-app-jwt",
          owner: "../foreign",
          repository: "app",
        }),
      ).rejects.toThrow();
      expect(test.calls).toHaveLength(2);
    } finally {
      await test.close();
    }
  });
  it("uses PKCE and user-scoped repository access, returning only the selected identity", async () => {
    const test = await fixture();
    try {
      const url = new URL(
        test.provider.authorizationUrl({ state: "s".repeat(43), codeChallenge: "c".repeat(43) }),
      );
      expect(url.origin).toBe("https://github.com");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("prompt")).toBe("select_account");
      expect(url.href).not.toContain("client-secret");
      const tokens = await test.provider.exchangeCode({
        code: "authorization-code",
        codeVerifier: "v".repeat(64),
      });
      expect(tokens.expiresAt).toBe("2026-09-05T08:00:00.000Z");
      expect(new URLSearchParams(test.calls[0]?.body).get("code_verifier")).toBe("v".repeat(64));
      await test.provider.refresh("user-refresh-token");
      expect(new URLSearchParams(test.calls[1]?.body).get("grant_type")).toBe("refresh_token");
      test.setMode("paged");
      const proof = await test.provider.verifyRepositoryAccess({
        accessToken: tokens.accessToken,
        installationId: 42,
        owner: "customer",
        repository: "app",
      });
      expect(proof).toEqual({
        userId: 7,
        installationId: 42,
        repositoryId: 99,
        owner: "customer",
        repository: "app",
        permission: "contents:read",
      });
      expect(JSON.stringify(proof)).not.toContain("secret-canary");
      expect(test.calls.at(-1)?.path).toContain("page=2");
      expect(
        test.calls.slice(2).every((call) => call.authorization === "Bearer user-access-token"),
      ).toBe(true);
    } finally {
      await test.close();
    }
  });

  it("denies a foreign installation and missing user read permission without app-token fallback", async () => {
    const test = await fixture();
    try {
      const target = {
        accessToken: "user-access-token",
        installationId: 43,
        owner: "customer",
        repository: "app",
      };
      await expect(test.provider.verifyRepositoryAccess(target)).rejects.toMatchObject({
        code: "github_authentication_failed",
      });
      test.setMode("denied");
      await expect(
        test.provider.verifyRepositoryAccess({ ...target, installationId: 42 }),
      ).rejects.toMatchObject({ code: "github_authentication_failed" });
      expect(test.calls.every((call) => !call.path.startsWith("/app/"))).toBe(true);
    } finally {
      await test.close();
    }
  });

  it("bounds responses and redacts failed or uncertain token exchanges without retrying them", async () => {
    const test = await fixture();
    try {
      for (const mode of ["malformed", "oversize", "unavailable"]) {
        test.setMode(mode);
        const count = test.calls.length;
        const failure: unknown = await test.provider
          .exchangeCode({ code: "authorization-code", codeVerifier: "v".repeat(64) })
          .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error("Expected a provider failure");
        expect(failure.message).toMatch(/GitHub provider/);
        expect(failure.message).not.toContain("secret-canary");
        expect(test.calls.length).toBe(count + 1);
      }
      expect(() =>
        test.provider.authorizationUrl({ state: "short", codeChallenge: "c".repeat(43) }),
      ).toThrow();
    } finally {
      await test.close();
    }
  });
});

describe("GitHub installation observation", () => {
  const observe = (status: number) =>
    createGithubUserAuthorization({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
      userAgent: "ohmyhost-test",
      now: () => new Date("2026-09-05T00:00:00.000Z"),
      fetch: async () => new Response("{}", { status }),
    }).observeInstallation({ appJwt: "private-app-jwt", installationId: 42 });

  it("reports only a missing installation as not found, never an authentication failure", async () => {
    for (const status of [401, 403]) {
      const failure = await observe(status).catch((error: unknown) => error);
      expect(failure, String(status)).toMatchObject({ name: "GithubProviderAuthenticationError" });
    }
    await expect(observe(404)).rejects.toMatchObject({
      name: "GithubInstallationNotFoundError",
    });
  });
});
