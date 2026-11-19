import { describe, expect, it, vi } from "vitest";

import {
  GithubProviderAuthenticationError,
  GithubProviderContractError,
  GithubProviderRateLimitError,
  GithubProviderUncertainError,
} from "./errors.js";
import { requestGithubInstallationToken } from "./installation-token.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");
const APP_JWT = "header.payload.fixture-signature";

function response(body: unknown, status = 201, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

function validBody(): unknown {
  return {
    token: "ghs_opaque",
    expires_at: "2026-08-19T12:59:59.000Z",
    repository_selection: "selected",
    repositories: [{ id: 987_654 }],
    permissions: { contents: "read", metadata: "read" },
  };
}

describe("GitHub installation token", () => {
  it("requests exactly one repository with read-only contents and returns an opaque token", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(_input.toString()).toBe("https://api.github.com/app/installations/123/access_tokens");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(
        JSON.stringify({ repository_ids: [987_654], permissions: { contents: "read" } }),
      );
      expect(new Headers(init?.headers)).toEqual(
        new Headers({
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${APP_JWT}`,
          "Content-Type": "application/json",
          "User-Agent": "ohmyhost-test",
          "X-GitHub-Api-Version": "2026-03-10",
        }),
      );
      return response(validBody());
    });

    await expect(
      requestGithubInstallationToken({
        appJwt: APP_JWT,
        installationId: 123,
        repositoryId: 987_654,
        now: NOW,
        userAgent: "ohmyhost-test",
        fetch,
      }),
    ).resolves.toEqual({
      token: "ghs_opaque",
      expiresAt: "2026-08-19T12:59:59.000Z",
      installationId: 123,
      repositoryId: 987_654,
      permissions: { contents: "read" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects unsafe installation IDs (%s)",
    async (installationId) => {
      await expect(
        requestGithubInstallationToken({
          appJwt: APP_JWT,
          installationId,
          repositoryId: 1,
          now: NOW,
          userAgent: "test",
          fetch: vi.fn(),
        }),
      ).rejects.toMatchObject({ code: "invalid_installation_id" });
    },
  );

  it.each([
    ["empty token", { ...(validBody() as object), token: "" }],
    ["past expiry", { ...(validBody() as object), expires_at: "2026-08-19T11:59:59.000Z" }],
    ["too-long expiry", { ...(validBody() as object), expires_at: "2026-08-19T13:01:00.001Z" }],
    ["all repositories", { ...(validBody() as object), repository_selection: "all" }],
    ["wrong repository", { ...(validBody() as object), repositories: [{ id: 123 }] }],
    [
      "multiple repositories",
      { ...(validBody() as object), repositories: [{ id: 987_654 }, { id: 2 }] },
    ],
    ["missing repositories", { ...(validBody() as object), repositories: undefined }],
    ["write permission", { ...(validBody() as object), permissions: { contents: "write" } }],
    [
      "other admin permission",
      { ...(validBody() as object), permissions: { contents: "read", administration: "write" } },
    ],
    [
      "extra read permission",
      {
        ...(validBody() as object),
        permissions: { contents: "read", metadata: "read", issues: "read" },
      },
    ],
    [
      "invalid metadata permission",
      { ...(validBody() as object), permissions: { contents: "read", metadata: "write" } },
    ],
    ["malformed JSON", Symbol("malformed")],
  ])("rejects malformed provider contract: %s", async (_name, body) => {
    const fetch = vi.fn(async () =>
      typeof body === "symbol" ? new Response("not-json", { status: 201 }) : response(body),
    );
    await expect(
      requestGithubInstallationToken({
        appJwt: APP_JWT,
        installationId: 123,
        repositoryId: 987_654,
        now: NOW,
        userAgent: "test",
        fetch,
      }),
    ).rejects.toBeInstanceOf(GithubProviderContractError);
  });

  it("classifies provider authentication without leaking the JWT", async () => {
    const fetch = vi.fn(async () => new Response("denied", { status: 401 }));
    const failure = await requestGithubInstallationToken({
      appJwt: APP_JWT,
      installationId: 123,
      repositoryId: 987_654,
      now: NOW,
      userAgent: "test",
      fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubProviderAuthenticationError);
    expect(String(failure)).not.toContain(APP_JWT);
  });

  it("classifies primary and secondary rate limits", async () => {
    for (const responseValue of [
      new Response("limited", { status: 429, headers: { "Retry-After": "10" } }),
      new Response("limited", { status: 403, headers: { "X-RateLimit-Remaining": "0" } }),
    ]) {
      await expect(
        requestGithubInstallationToken({
          appJwt: APP_JWT,
          installationId: 123,
          repositoryId: 987_654,
          now: NOW,
          userAgent: "test",
          fetch: vi.fn(async () => responseValue),
        }),
      ).rejects.toBeInstanceOf(GithubProviderRateLimitError);
    }
  });

  it("classifies POST transport ambiguity as uncertain and redacts thrown details", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(`socket exposed ${APP_JWT}`);
    });
    const failure = await requestGithubInstallationToken({
      appJwt: APP_JWT,
      installationId: 123,
      repositoryId: 987_654,
      now: NOW,
      userAgent: "test",
      fetch,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GithubProviderUncertainError);
    expect(String(failure)).not.toContain(APP_JWT);
  });

  it("rejects an oversized streamed token response without an unbounded JSON read", async () => {
    const oversized = new TextEncoder().encode(`{"token":"${"x".repeat(70_000)}"}`);
    const fetch = vi.fn(async () => new Response(oversized, { status: 201 }));
    await expect(
      requestGithubInstallationToken({
        appJwt: APP_JWT,
        installationId: 123,
        repositoryId: 987_654,
        now: NOW,
        userAgent: "test",
        fetch,
      }),
    ).rejects.toMatchObject({ code: "github_provider_contract_invalid" });
  });

  it.each(["0", "invalid", "70000"])(
    "rejects an invalid declared token response length (%s)",
    async (contentLength) => {
      const fetch = vi.fn(
        async () =>
          new Response(JSON.stringify(validBody()), {
            status: 201,
            headers: { "Content-Length": contentLength },
          }),
      );
      await expect(
        requestGithubInstallationToken({
          appJwt: APP_JWT,
          installationId: 123,
          repositoryId: 987_654,
          now: NOW,
          userAgent: "test",
          fetch,
        }),
      ).rejects.toBeInstanceOf(GithubProviderContractError);
    },
  );

  it("uses decoded stream bounds rather than encoded length for unknown content codings", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(validBody()), {
          status: 201,
          headers: { "Content-Encoding": "future-coding", "Content-Length": "1" },
        }),
    );
    await expect(
      requestGithubInstallationToken({
        appJwt: APP_JWT,
        installationId: 123,
        repositoryId: 987_654,
        now: NOW,
        userAgent: "test",
        fetch,
      }),
    ).resolves.toMatchObject({ repositoryId: 987_654, permissions: { contents: "read" } });
  });
});
