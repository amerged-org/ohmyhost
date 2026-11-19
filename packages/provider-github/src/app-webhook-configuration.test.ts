import { describe, expect, it, vi } from "vitest";

import {
  createGitHubAppWebhookConfigurationProvider,
  type GitHubAppWebhookConfigurationProvider,
} from "./app-webhook-configuration.js";

const NOW = new Date("2026-08-25T18:00:00.000Z");
const APP = Object.freeze({ id: 123, clientId: "Iv1.poc-client", slug: "ohmyhost-poc" });
const PREVIOUS_URL = "https://old.example.test/webhooks/github";
const TARGET_URL = "https://api.example.test/webhooks/github";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function appResponse(overrides: Readonly<Record<string, unknown>> = {}): Response {
  return jsonResponse({
    id: APP.id,
    client_id: APP.clientId,
    slug: APP.slug,
    events: ["push"],
    permissions: { contents: "read", metadata: "read" },
    ...overrides,
  });
}

function hookResponse(url = PREVIOUS_URL, overrides: Readonly<Record<string, unknown>> = {}) {
  return jsonResponse({
    url,
    content_type: "json",
    insecure_ssl: "0",
    secret: "********",
    ...overrides,
  });
}

function provider(fetch: typeof globalThis.fetch): GitHubAppWebhookConfigurationProvider {
  return createGitHubAppWebhookConfigurationProvider({
    appJwtIssuer: { issue: vi.fn(async () => "secret.jwt.value") },
    fetch,
    clock: { now: () => new Date(NOW) },
    userAgent: "ohmyhost-tests",
    requestTimeoutMs: 1_000,
  });
}

describe("GitHub App webhook configuration provider", () => {
  it("observes an exact app and safe webhook configuration without mutation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse(TARGET_URL));

    const receipt = await provider(fetch).observe({ expectedApp: APP, targetUrl: TARGET_URL });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.method ?? "GET"])).toEqual([
      ["https://api.github.com/app", "GET"],
      ["https://api.github.com/app/hook/config", "GET"],
    ]);
    expect(receipt).toMatchObject({
      schemaVersion: "github.app-webhook-configuration.v1",
      scope: "configuration_only",
      deliveryVerification: "not_evaluated",
      app: APP,
      changed: false,
      previous: { origin: "https://api.example.test", path: "/webhooks/github" },
      current: { origin: "https://api.example.test", path: "/webhooks/github" },
      observedAt: NOW.toISOString(),
    });
    expect(receipt.previous.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(receipt.current.sha256).toBe(receipt.previous.sha256);
    expect(JSON.stringify(receipt)).not.toContain("secret.jwt.value");
  });

  it("fails a read-only observation when the webhook URL has drifted", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse(PREVIOUS_URL));

    await expect(
      provider(fetch).observe({ expectedApp: APP, targetUrl: TARGET_URL }),
    ).rejects.toMatchObject({
      name: "GithubProviderContractError",
      code: "github_provider_contract_invalid",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
  });

  it.each([
    ["wrong app id", { id: 999 }],
    ["wrong client id", { client_id: "Iv1.foreign" }],
    ["wrong slug", { slug: "foreign-app" }],
    ["wrong events", { events: ["push", "issues"] }],
    ["missing events", { events: [] }],
    ["write contents", { permissions: { contents: "write" } }],
    ["missing metadata", { permissions: { contents: "read" } }],
    ["extra write permission", { permissions: { contents: "read", issues: "write" } }],
  ])("rejects %s", async (_label, override) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(appResponse(override));
    await expect(
      provider(fetch).ensure({ expectedApp: APP, targetUrl: TARGET_URL }),
    ).rejects.toMatchObject({
      name: "GithubProviderContractError",
      code: "github_provider_contract_invalid",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["http", "http://api.example.test/webhooks/github", {}],
    ["credentials", "https://user@api.example.test/webhooks/github", {}],
    ["query", "https://api.example.test/webhooks/github?secret=value", {}],
    ["fragment", "https://api.example.test/webhooks/github#secret", {}],
    ["target path", "https://api.example.test/webhooks/github/secret", {}],
    ["observed path", TARGET_URL, { url: "https://old.example.test/secret/in/path" }],
    ["wrong TLS", TARGET_URL, { insecure_ssl: "1" }],
    ["wrong content type", TARGET_URL, { content_type: "form" }],
    ["missing masked secret", TARGET_URL, { secret: undefined }],
    ["unmasked secret", TARGET_URL, { secret: "real-secret-value" }],
  ])("rejects unsafe %s configuration", async (_label, targetUrl, hookOverride) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse(PREVIOUS_URL, hookOverride));
    const result = provider(fetch).ensure({ expectedApp: APP, targetUrl });
    await expect(result).rejects.toMatchObject({
      code:
        targetUrl === TARGET_URL ? "github_provider_contract_invalid" : "invalid_webhook_payload",
    });
  });

  it("updates only the URL and requires exact readback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse())
      .mockResolvedValueOnce(hookResponse(TARGET_URL))
      .mockResolvedValueOnce(hookResponse(TARGET_URL));

    const receipt = await provider(fetch).ensure({ expectedApp: APP, targetUrl: TARGET_URL });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({ method: "PATCH" });
    expect(fetch.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({ url: TARGET_URL }));
    expect(String(fetch.mock.calls[2]?.[1]?.body)).not.toContain("secret");
    expect(receipt).toMatchObject({
      changed: true,
      previous: { origin: "https://old.example.test", path: "/webhooks/github" },
      current: { origin: "https://api.example.test", path: "/webhooks/github" },
    });
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer secret.jwt.value",
      "User-Agent": "ohmyhost-tests",
      "X-GitHub-Api-Version": "2026-03-10",
    });
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer secret.jwt.value",
      "User-Agent": "ohmyhost-tests",
      "X-GitHub-Api-Version": "2026-03-10",
    });
    expect(fetch.mock.calls[2]?.[1]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer secret.jwt.value",
      "Content-Type": "application/json",
      "User-Agent": "ohmyhost-tests",
      "X-GitHub-Api-Version": "2026-03-10",
    });
    expect(fetch.mock.calls[3]?.[1]?.headers).toEqual({
      Accept: "application/vnd.github+json",
      Authorization: "Bearer secret.jwt.value",
      "User-Agent": "ohmyhost-tests",
      "X-GitHub-Api-Version": "2026-03-10",
    });
  });

  it("adopts an exact target after a lost PATCH response without retrying the mutation", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse())
      .mockRejectedValueOnce(new Error("socket failed with secret.jwt.value"))
      .mockResolvedValueOnce(hookResponse(TARGET_URL));

    const receipt = await provider(fetch).ensure({ expectedApp: APP, targetUrl: TARGET_URL });

    expect(receipt.changed).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("fails uncertain when mutation readback belongs to a foreign URL", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse())
      .mockRejectedValueOnce(new Error("lost response with token"))
      .mockResolvedValueOnce(hookResponse("https://foreign.example.test/webhooks/github"));

    const failure = provider(fetch).ensure({ expectedApp: APP, targetUrl: TARGET_URL });
    await expect(failure).rejects.toMatchObject({
      name: "GithubProviderUncertainError",
      code: "github_result_uncertain",
      message: "GitHub provider operation result is uncertain",
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("fails uncertain when a successful PATCH is followed by foreign readback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse())
      .mockResolvedValueOnce(hookResponse(TARGET_URL))
      .mockResolvedValueOnce(hookResponse("https://foreign.example.test/webhooks/github"));

    await expect(
      provider(fetch).ensure({ expectedApp: APP, targetUrl: TARGET_URL }),
    ).rejects.toMatchObject({
      name: "GithubProviderUncertainError",
      code: "github_result_uncertain",
    });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("returns a typed contract failure for a definitely rejected PATCH", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse())
      .mockResolvedValueOnce(jsonResponse({ secret: "must not leak" }, 422));

    await expect(
      provider(fetch).ensure({ expectedApp: APP, targetUrl: TARGET_URL }),
    ).rejects.toMatchObject({
      name: "GithubProviderContractError",
      code: "github_provider_contract_invalid",
      message: "GitHub provider response is invalid",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([401, 403])("redacts GitHub %s failures", async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: "secret.jwt.value", body: "private" }, status));
    const failure = provider(fetch).ensure({ expectedApp: APP, targetUrl: TARGET_URL });
    await expect(failure).rejects.toMatchObject({
      name: "GithubProviderAuthenticationError",
      code: "github_authentication_failed",
      message: "GitHub provider authentication failed",
    });
    await expect(failure).rejects.not.toHaveProperty("cause");
  });

  it("redacts an App JWT issuer failure", async () => {
    const configured = createGitHubAppWebhookConfigurationProvider({
      appJwtIssuer: {
        issue: async () => {
          throw new Error("private key and token leaked here");
        },
      },
      fetch: vi.fn<typeof globalThis.fetch>(),
      clock: { now: () => new Date(NOW) },
      userAgent: "ohmyhost-tests",
      requestTimeoutMs: 1_000,
    });

    await expect(
      configured.ensure({ expectedApp: APP, targetUrl: TARGET_URL }),
    ).rejects.toMatchObject({
      name: "GithubProviderAuthenticationError",
      code: "github_authentication_failed",
      message: "GitHub provider authentication failed",
    });
  });

  it("classifies a timed-out observation as transport failure without retry", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async (_url, init) => {
      await new Promise<void>((resolve) =>
        init?.signal?.addEventListener("abort", () => resolve()),
      );
      throw new Error("timeout leaked token");
    });
    const timedProvider = createGitHubAppWebhookConfigurationProvider({
      appJwtIssuer: { issue: async () => "secret.jwt.value" },
      fetch,
      clock: { now: () => new Date(NOW) },
      userAgent: "ohmyhost-tests",
      requestTimeoutMs: 100,
    });

    await expect(
      timedProvider.ensure({ expectedApp: APP, targetUrl: TARGET_URL }),
    ).rejects.toMatchObject({
      name: "GithubProviderTransportError",
      code: "github_request_timeout",
      message: "GitHub provider request failed",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry a timed-out PATCH and adopts exact readback", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(appResponse())
      .mockResolvedValueOnce(hookResponse())
      .mockImplementationOnce(async (_url, init) => {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener("abort", () => resolve()),
        );
        throw new Error("timeout with secret.jwt.value");
      })
      .mockResolvedValueOnce(hookResponse(TARGET_URL));
    const timedProvider = createGitHubAppWebhookConfigurationProvider({
      appJwtIssuer: { issue: async () => "secret.jwt.value" },
      fetch,
      clock: { now: () => new Date(NOW) },
      userAgent: "ohmyhost-tests",
      requestTimeoutMs: 100,
    });

    await expect(
      timedProvider.ensure({ expectedApp: APP, targetUrl: TARGET_URL }),
    ).resolves.toMatchObject({ changed: true });
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects request timeouts above the bounded maximum before creating an AbortSignal", () => {
    expect(() =>
      createGitHubAppWebhookConfigurationProvider({
        appJwtIssuer: { issue: async () => "secret.jwt.value" },
        fetch: vi.fn<typeof globalThis.fetch>(),
        clock: { now: () => new Date(NOW) },
        userAgent: "ohmyhost-tests",
        requestTimeoutMs: 30_001,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "GithubProviderInputError",
        code: "invalid_webhook_configuration_timeout",
        message: "GitHub provider input is invalid",
      }),
    );
  });
});
