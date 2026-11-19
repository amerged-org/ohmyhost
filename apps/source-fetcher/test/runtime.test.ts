import { webcrypto } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    public readonly runtime = "test";
  },
}));

import { createSourceFetcherRuntime, type SourceFetcherBindings } from "../src/worker-main.js";
import type { SourceFetchRequest } from "../src/source-fetcher.js";
import { gzipTar, viteEntries } from "./tar-fixture.js";

const now = new Date("2026-08-19T20:00:00.000Z");
const commit = "ee7a8623801d48e9d355a7766397a4ed291a9025";
const archiveDigest = "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
const scope = {
  projectId: "01J00000000000000000000002",
  environmentId: "01J00000000000000000000003",
  operationId: "01J00000000000000000000004",
};
const upload = {
  bucket: "ohmyho-builds-development",
  key: `runs/${scope.projectId}/${scope.environmentId}/${scope.operationId}/input/source.tar.gz`,
  uploadId: "multipart-1",
  scope,
};
let signingKeyBase64 = "";

beforeAll(async () => {
  const pair = await webcrypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  signingKeyBase64 = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", pair.privateKey),
  ).toString("base64");
});

function request(knownArchiveSha256: string | null = null): SourceFetchRequest {
  return {
    organizationId: "01J00000000000000000000000",
    billingEpochId: "01J00000000000000000000001",
    projectId: scope.projectId,
    environmentId: scope.environmentId,
    operationId: scope.operationId,
    idempotencyKey: "deploy:one",
    sourceConnectionId: "01J00000000000000000000005",
    region: "us",
    knownArchiveSha256,
    expectedSourceSha256: knownArchiveSha256 ?? archiveDigest,
    repository: {
      owner: "aixyte",
      name: "ohmyho.st",
      externalRepositoryId: "1339976528",
    },
    commitSha: commit,
    grant: {
      status: "approved",
      grantId: "01J00000000000000000000006",
      organizationId: "01J00000000000000000000000",
      billingEpochId: "01J00000000000000000000001",
      projectId: scope.projectId,
      sourceConnectionId: "01J00000000000000000000005",
      installationId: 154436098,
      repositoryId: 1339976528,
      owner: "aixyte",
      repository: "ohmyho.st",
      permission: "contents:read",
      grantedAt: "2026-08-19T18:00:00.000Z",
      revokedAt: null,
    },
  };
}

function bindings(): SourceFetcherBindings {
  return {
    BUILD_RUNNER: {
      observeArchive: vi.fn().mockResolvedValue(null),
      beginArchive: vi.fn().mockResolvedValue(upload),
      uploadArchivePart: vi.fn((input) =>
        Promise.resolve({
          partNumber: (input as { partNumber: number }).partNumber,
          eTag: '"part-etag"',
          checksumSha256: (input as { checksumSha256: string }).checksumSha256,
        }),
      ),
      completeArchive: vi.fn((input) =>
        Promise.resolve({
          bucket: upload.bucket,
          key: upload.key,
          versionId: "0123456789abcdef0123456789abcdef",
          eTag: '"object-etag"',
          byteLength: (input as { byteLength: number }).byteLength,
          scope,
          sourceSha256: (input as { sourceSha256: string }).sourceSha256,
        }),
      ),
      abortArchive: vi.fn().mockResolvedValue(undefined),
    },
    BUILD_OBJECTS_BUCKET_US: upload.bucket,
    BUILD_OBJECTS_BUCKET_EU: `${upload.bucket}-eu`,
    GITHUB_APP_PRIVATE_KEY_BASE64: signingKeyBase64,
    GITHUB_APP_CLIENT_ID: "Iv23Example000000001",
    GITHUB_APP_CLIENT_SECRET: "private-client-secret",
    GITHUB_APP_SLUG: "ohmyhost-test",
    GITHUB_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
    GITHUB_USER_AGENT: "ohmyho-source-fetcher/sandbox",
    SOURCE_ARCHIVE_MAX_BYTES: "25000000",
    SOURCE_FETCH_TIMEOUT_MS: "30000",
    PROVIDER_REQUEST_TIMEOUT_MS: "10000",
    BINDING_REQUEST_TIMEOUT_MS: "10000",
  };
}

describe("production source fetcher composition", () => {
  it("exchanges customer PKCE consent privately and returns only user-authorized repository metadata", async () => {
    const calls: string[] = [];
    let denied = false;
    let tokenDenied = false;
    let uninstalled = false;
    let rejectedApp = false;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      calls.push(path);
      response.setHeader("Content-Type", "application/json");
      if (path === "/login/oauth/access_token") {
        if (tokenDenied) {
          response.writeHead(401).end("{}");
          return;
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        if (
          form.get("client_secret") !== "private-client-secret" ||
          (form.get("code") === "installation-code"
            ? form.has("code_verifier")
            : form.get("code_verifier") !== "v".repeat(64))
        ) {
          response.writeHead(401).end("{}");
          return;
        }
        response.end(
          JSON.stringify({
            token_type: "bearer",
            access_token: "private-user-token",
            refresh_token: "private-refresh-token",
            expires_in: 28800,
            refresh_token_expires_in: 15811200,
          }),
        );
      } else if (path === "/repos/customer/application/installation") {
        if (uninstalled) {
          response.writeHead(404).end("{}");
          return;
        }
        const jwt = request.headers.authorization?.split(" ")[1] ?? "";
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
        response.end(JSON.stringify({ id: 42, client_id: payload.iss, suspended_at: null }));
      } else if (path === "/app/installations/42") {
        if (rejectedApp) {
          response.writeHead(401).end("{}");
          return;
        }
        if (uninstalled) {
          response.writeHead(404).end("{}");
          return;
        }
        const jwt = request.headers.authorization?.split(" ")[1] ?? "";
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString());
        response.end(
          JSON.stringify({
            id: 42,
            client_id: payload.iss,
            suspended_at: null,
            account: { id: 7, login: "customer", type: "User" },
            repository_selection: "all",
            html_url: "https://github.com/settings/installations/42",
          }),
        );
      } else if (request.headers.authorization !== "Bearer private-user-token") {
        response.writeHead(401).end("{}");
      } else if (path === "/user") {
        response.end(JSON.stringify({ id: 7, login: "customer" }));
      } else if (path === "/user/installations") {
        response.end(JSON.stringify({ installations: denied ? [] : [{ id: 42 }] }));
      } else if (path === "/user/installations/42/repositories") {
        response.end(
          JSON.stringify({
            repositories: [
              { id: 99, full_name: "customer/application", permissions: { pull: !denied } },
            ],
          }),
        );
      } else response.writeHead(404).end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture endpoint");
    const configuration = {
      ...bindings(),
      GITHUB_APP_CLIENT_SECRET: "private-client-secret",
      GITHUB_APP_SLUG: "ohmyhost-test",
      GITHUB_OAUTH_REDIRECT_URI: "https://dev.app.ohmyho.st/v1/github/oauth/callback",
    };
    const runtime = createSourceFetcherRuntime(configuration, {
      now: () => now,
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
      fetch: (target, init) => {
        const url = new URL(String(target));
        return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
      },
    });
    try {
      const handoff = await runtime.beginRepositoryAuthorization({
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
      });
      expect(new URL(handoff.authorizationUrl).searchParams.get("code_challenge_method")).toBe(
        "S256",
      );
      expect(new URL(handoff.authorizationUrl).searchParams.get("prompt")).toBe("select_account");
      expect(handoff.installationUrl).toBe(
        "https://github.com/apps/ohmyhost-test/installations/new",
      );
      const request = {
        code: "one-use-code",
        codeVerifier: "v".repeat(64),
        owner: "customer",
        repository: "application",
      };
      const result = await runtime.completeRepositoryAuthorization(request);
      expect(result).toEqual({
        userId: 7,
        installationId: 42,
        repositoryId: 99,
        owner: "customer",
        repository: "application",
        permission: "contents:read",
      });
      expect(JSON.stringify({ handoff, result })).not.toMatch(/private-|one-use-code/);
      expect(calls).toEqual([
        "/login/oauth/access_token",
        "/repos/customer/application/installation",
        "/user",
        "/user/installations/42/repositories",
      ]);
      const before = calls.length;
      await expect(
        runtime.completeRepositoryAuthorization({ ...request, installationId: 999 }),
      ).rejects.toMatchObject({ code: "source_fetch_input_invalid" });
      expect(calls).toHaveLength(before);
      denied = true;
      await expect(
        runtime.completeRepositoryAuthorization({ ...request, code: "another-one-use-code" }),
      ).resolves.toEqual({ status: "repository_access_required" });
      // Both remaining denials are states the customer can leave, so each is an answer the caller
      // can act on rather than an exception that reads like an outage.
      uninstalled = true;
      await expect(
        runtime.completeRepositoryAuthorization({ ...request, code: "uninstalled-code" }),
      ).resolves.toEqual({ status: "repository_not_installed" });
      uninstalled = false;
      tokenDenied = true;
      await expect(
        runtime.completeRepositoryAuthorization({ ...request, code: "rejected-code" }),
      ).resolves.toEqual({ status: "authorization_code_rejected" });
      expect(calls).not.toContain("/app/installations/42/access_tokens");
      tokenDenied = false;
      denied = false;
      const organizationHandoff = await runtime.beginOrganizationAuthorization({
        state: "s".repeat(43),
        codeChallenge: "c".repeat(43),
      });
      expect(new URL(organizationHandoff.installationUrl).searchParams.get("state")).toBe(
        "s".repeat(43),
      );
      await expect(
        runtime.observeOrganizationInstallation({ installationId: "42" }),
      ).resolves.toMatchObject({ installationId: 42, accountId: 7 });
      await expect(
        runtime.completeOrganizationAuthorization({
          code: "installation-code",
          codeVerifier: "v".repeat(64),
          installationId: "42",
          flow: "installation",
        }),
      ).resolves.toMatchObject({
        userId: 7,
        userLogin: "customer",
        accountId: 7,
        installationId: 42,
      });
      denied = true;
      await expect(
        runtime.completeOrganizationAuthorization({
          code: "oauth-code",
          codeVerifier: "v".repeat(64),
          installationId: "42",
          flow: "oauth",
        }),
      ).resolves.toEqual({ status: "account_admin_required" });
      // A rejected App credential is a provider problem: the connection is not revoked by it.
      rejectedApp = true;
      await expect(
        runtime.observeOrganizationInstallation({ installationId: "42" }),
      ).rejects.toThrow();
      rejectedApp = false;
      uninstalled = true;
      await expect(
        runtime.observeOrganizationInstallation({ installationId: "42" }),
      ).resolves.toEqual({ status: "revoked" });
      await expect(
        runtime.validateOrganizationRepository({
          owner: "customer",
          name: "application",
          installationId: 42,
        }),
      ).resolves.toEqual({ status: "repository_not_installed" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("streams the exact GitHub archive through the actual build runner RPC", async () => {
    const archive = new Uint8Array([1, 2, 3, 4]);
    const providerFetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "installation-token",
            expires_at: "2026-08-19T20:59:00.000Z",
            repository_selection: "selected",
            permissions: { contents: "read", metadata: "read" },
            repositories: [{ id: 1339976528 }],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("/commits/")) return new Response(commit, { status: 200 });
      if (href.includes("/tarball/")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://codeload.github.com/aixyte/ohmyho.st/legacy.tar.gz/${commit}`,
          },
        });
      }
      return new Response(new Uint8Array(archive).buffer, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      });
    });
    const runtime = createSourceFetcherRuntime(bindings(), {
      fetch: providerFetch as typeof globalThis.fetch,
      now: () => now,
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });

    const result = await runtime.acquireExact(request());
    expect(result).toMatchObject({
      commitSha: commit,
      byteLength: archive.byteLength,
      archiveId: expect.stringMatching(/^r2-version:ohmyho-builds-development\/runs\//u),
      archive: {
        bucket: upload.bucket,
        key: upload.key,
        versionId: "0123456789abcdef0123456789abcdef",
        eTag: '"object-etag"',
        byteLength: archive.byteLength,
        scope,
        sourceSha256: archiveDigest,
      },
    });
    expect(JSON.stringify(result)).not.toContain("installation-token");
    expect(JSON.stringify(result)).not.toContain(signingKeyBase64);
  });

  it("inspects the exact archive without invoking the build runner", async () => {
    const archive = await gzipTar(viteEntries());
    const digestBytes = await webcrypto.subtle.digest("SHA-256", archive);
    const digest = Buffer.from(digestBytes).toString("hex");
    const baseBindings = bindings();
    const providerFetch = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "installation-token",
            expires_at: "2026-08-19T20:59:00.000Z",
            repository_selection: "selected",
            permissions: { contents: "read", metadata: "read" },
            repositories: [{ id: 1339976528 }],
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      if (href.includes("/commits/")) return new Response(commit, { status: 200 });
      if (href.includes("/tarball/")) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://codeload.github.com/aixyte/ohmyho.st/legacy.tar.gz/${commit}`,
          },
        });
      }
      return new Response(new Uint8Array(archive).buffer, {
        status: 200,
        headers: { "content-length": String(archive.byteLength) },
      });
    });
    const runtime = createSourceFetcherRuntime(baseBindings, {
      fetch: providerFetch as typeof globalThis.fetch,
      now: () => now,
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });
    const {
      knownArchiveSha256: _known,
      expectedSourceSha256: _expected,
      region: _region,
      ...inspection
    } = request();
    void _known;
    void _expected;
    void _region;

    await expect(runtime.inspectExact(inspection)).resolves.toEqual({
      resolvedCommitSha: commit,
      sourceSha256: digest,
      byteLength: archive.byteLength,
      frameworkPlan: expect.objectContaining({ adapter: "vite-static", runtime: "static" }),
      buildPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    for (const method of Object.values(baseBindings.BUILD_RUNNER)) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("uses a real clock by default while remaining fail-closed on invalid input", async () => {
    const runtime = createSourceFetcherRuntime(bindings());
    await expect(runtime.acquireExact({})).rejects.toMatchObject({
      code: "source_fetch_input_invalid",
    });
  });

  it("refuses to start with build buckets that are not the platform bucket pair of one deployment", () => {
    for (const override of [
      { BUILD_OBJECTS_BUCKET_US: "ohmyho-builds-staging" },
      { BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-staging-eu" },
      { BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-production-eu" },
      { BUILD_OBJECTS_BUCKET_EU: "ohmyho-builds-development" },
      { BUILD_OBJECTS_BUCKET_EU: undefined },
    ]) {
      expect(() => createSourceFetcherRuntime({ ...bindings(), ...override } as never)).toThrow(
        expect.objectContaining({ code: "source_fetch_configuration_unavailable" }),
      );
    }
  });

  it("stores an EU project's archive in the EU build bucket", async () => {
    const digest = "b".repeat(64);
    const baseBindings = bindings();
    const euBindings: SourceFetcherBindings = {
      ...baseBindings,
      BUILD_RUNNER: {
        ...baseBindings.BUILD_RUNNER,
        observeArchive: vi.fn().mockResolvedValue({
          bucket: "ohmyho-builds-development-eu",
          key: upload.key,
          versionId: "fedcba9876543210fedcba9876543210",
          eTag: '"object-etag"',
          byteLength: 4,
          scope,
          sourceSha256: digest,
        }),
      },
    };
    const runtime = createSourceFetcherRuntime(euBindings, {
      fetch: vi.fn() as typeof globalThis.fetch,
      now: () => now,
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });

    await expect(runtime.acquireExact({ ...request(digest), region: "eu" })).resolves.toMatchObject(
      {
        archiveId: expect.stringMatching(/^r2-version:ohmyho-builds-development-eu\/runs\//u),
        archive: expect.objectContaining({ bucket: "ohmyho-builds-development-eu" }),
      },
    );
    expect(euBindings.BUILD_RUNNER.observeArchive).toHaveBeenCalledWith({
      scope,
      bucket: "ohmyho-builds-development-eu",
      sourceSha256: digest,
    });
    // The same object in the US bucket is not the EU project's archive.
    await expect(runtime.acquireExact(request(digest))).rejects.toMatchObject({
      code: "source_fetch_contract_invalid",
    });
  });

  it("replays an exact immutable object version without minting a GitHub token", async () => {
    const digest = "a".repeat(64);
    const baseBindings = bindings();
    const replayBindings: SourceFetcherBindings = {
      ...baseBindings,
      BUILD_RUNNER: {
        ...baseBindings.BUILD_RUNNER,
        observeArchive: vi.fn().mockResolvedValue({
          bucket: upload.bucket,
          key: upload.key,
          versionId: "fedcba9876543210fedcba9876543210",
          eTag: '"object-etag"',
          byteLength: 4,
          scope,
          sourceSha256: digest,
        }),
      },
    };
    const providerFetch = vi.fn();
    const runtime = createSourceFetcherRuntime(replayBindings, {
      fetch: providerFetch as typeof globalThis.fetch,
      now: () => now,
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });

    await expect(runtime.acquireExact(request(digest))).resolves.toMatchObject({
      archiveId: expect.stringMatching(/^r2-version:ohmyho-builds-development\/runs\//u),
      byteLength: 4,
      sha256: digest,
      archive: expect.objectContaining({
        versionId: "fedcba9876543210fedcba9876543210",
        sourceSha256: digest,
        scope,
      }),
    });
    expect(providerFetch).not.toHaveBeenCalled();
    expect(replayBindings.BUILD_RUNNER.beginArchive).not.toHaveBeenCalled();
  });

  it("validates a requested one-repository installation without build runner access", async () => {
    const baseBindings = bindings();
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "must-not-escape",
          expires_at: "2026-08-19T20:59:00.000Z",
          repository_selection: "selected",
          permissions: { contents: "read", metadata: "read" },
          repositories: [{ id: 24681012, name: "stay-simpli", full_name: "aixyte/stay-simpli" }],
        }),
        { status: 201 },
      ),
    );
    const runtime = createSourceFetcherRuntime(baseBindings, {
      fetch: providerFetch,
      now: () => now,
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });
    const link = {
      organizationId: "01J00000000000000000000000",
      billingEpochId: "01J00000000000000000000001",
      projectId: scope.projectId,
      environmentId: scope.environmentId,
      operationId: scope.operationId,
      installationId: 154436098,
      owner: "aixyte",
      name: "stay-simpli",
    };
    await expect(runtime.validateRepositoryLink(link)).resolves.toMatchObject({
      externalRepositoryId: "24681012",
      owner: "aixyte",
      name: "stay-simpli",
      permission: "contents:read",
    });
    const tokenRequest = providerFetch.mock.calls[0]?.[1];
    expect(JSON.parse(String(tokenRequest?.body))).toEqual({
      repositories: ["stay-simpli"],
      permissions: { contents: "read" },
    });
    for (const method of Object.values(baseBindings.BUILD_RUNNER)) {
      expect(method).not.toHaveBeenCalled();
    }

    providerFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "must-not-escape",
          expires_at: "2026-08-19T20:59:00.000Z",
          repository_selection: "selected",
          permissions: { contents: "read", metadata: "read", issues: "read" },
          repositories: [{ id: 24681012, name: "stay-simpli", full_name: "aixyte/stay-simpli" }],
        }),
        { status: 201 },
      ),
    );
    await expect(runtime.validateRepositoryLink(link)).rejects.toMatchObject({
      code: "source_fetch_contract_invalid",
      message: "Source archive provider response is invalid",
    });
  });

  it("links a repository typed in another letter case under GitHub's canonical owner and name", async () => {
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: "must-not-escape",
          expires_at: "2026-08-19T20:59:00.000Z",
          repository_selection: "selected",
          permissions: { contents: "read", metadata: "read" },
          repositories: [{ id: 24681012, name: "stay-simpli", full_name: "aixyte/stay-simpli" }],
        }),
        { status: 201 },
      ),
    );
    const runtime = createSourceFetcherRuntime(bindings(), {
      fetch: providerFetch,
      now: () => now,
      crypto: webcrypto.subtle as unknown as SubtleCrypto,
    });
    // GitHub matches the repository name without regard to case and answers with its canonical spelling.
    await expect(
      runtime.validateRepositoryLink({
        organizationId: "01J00000000000000000000000",
        billingEpochId: "01J00000000000000000000001",
        projectId: scope.projectId,
        environmentId: scope.environmentId,
        operationId: scope.operationId,
        installationId: 154436098,
        owner: "Aixyte",
        name: "Stay-Simpli",
      }),
    ).resolves.toMatchObject({
      externalRepositoryId: "24681012",
      owner: "aixyte",
      name: "stay-simpli",
      permission: "contents:read",
    });
  });

  it("calls the Workers global fetch with its required runtime receiver", async () => {
    const originalFetch = globalThis.fetch;
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: "must-not-escape",
            expires_at: "2026-08-19T20:59:00.000Z",
            repository_selection: "selected",
            permissions: { contents: "read", metadata: "read" },
            repositories: [{ id: 24681012, name: "stay-simpli", full_name: "aixyte/stay-simpli" }],
          }),
          { status: 201 },
        ),
      );
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: receiverSensitiveFetch,
      writable: true,
    });
    try {
      const runtime = createSourceFetcherRuntime(bindings(), {
        now: () => now,
        crypto: webcrypto.subtle as unknown as SubtleCrypto,
      });
      await expect(
        runtime.validateRepositoryLink({
          organizationId: "01J00000000000000000000000",
          billingEpochId: "01J00000000000000000000001",
          projectId: scope.projectId,
          environmentId: scope.environmentId,
          operationId: scope.operationId,
          installationId: 154436098,
          owner: "aixyte",
          name: "stay-simpli",
        }),
      ).resolves.toMatchObject({
        externalRepositoryId: "24681012",
        owner: "aixyte",
        name: "stay-simpli",
        permission: "contents:read",
      });
    } finally {
      Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
      });
    }
    expect(receiverSensitiveFetch).toHaveBeenCalledOnce();
  });
});

it("aborts the organization authorization exchange and later lookups under one cumulative deadline", async () => {
  const rejectedFetch = vi.fn();
  const expiredRuntime = createSourceFetcherRuntime(bindings(), {
    fetch: rejectedFetch as typeof globalThis.fetch,
    crypto: webcrypto.subtle as SubtleCrypto,
  });
  await expect(
    expiredRuntime.completeOrganizationAuthorization({
      code: "one-use-code",
      codeVerifier: "v".repeat(64),
      installationId: "42",
      flow: "oauth",
      leaseExpiresAt: new Date(Date.now() + 4000).toISOString(),
    }),
  ).rejects.toMatchObject({ code: "source_fetch_input_invalid" });
  expect(rejectedFetch).not.toHaveBeenCalled();
  for (const stalled of ["exchange", "lookup"] as const) {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    // Per-request timers must stay live while the shared deadline is controlled by the test.
    timeout.mockImplementation((ms) =>
      ms === 45_000 ? deadline.signal : new AbortController().signal,
    );
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (
        (stalled === "exchange" && path === "/login/oauth/access_token") ||
        (stalled === "lookup" && path === "/user")
      ) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(new Error("aborted"));
          else
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        token_type: "bearer",
        expires_in: 100,
        refresh_token_expires_in: 200,
      });
    }) as typeof globalThis.fetch;
    try {
      const runtime = createSourceFetcherRuntime(bindings(), {
        fetch,
        crypto: webcrypto.subtle as SubtleCrypto,
      });
      const result = runtime.completeOrganizationAuthorization({
        code: "one-use-code",
        codeVerifier: "v".repeat(64),
        installationId: "42",
        flow: "oauth",
      });
      while (!calls.includes(stalled === "exchange" ? "/login/oauth/access_token" : "/user"))
        await new Promise((resolve) => setTimeout(resolve, 0));
      deadline.abort();
      await expect(result).rejects.toMatchObject({
        code: stalled === "exchange" ? "github_result_uncertain" : "github_request_failed",
      });
      expect(timeout).toHaveBeenCalledWith(45_000);
      expect(calls).toEqual(
        stalled === "exchange"
          ? ["/login/oauth/access_token"]
          : ["/login/oauth/access_token", "/user"],
      );
    } finally {
      timeout.mockRestore();
    }
  }
});
