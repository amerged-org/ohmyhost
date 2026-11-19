import cliPackage from "../package.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { once } from "node:events";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  GeneratedSdkSessionRevoker,
  PublicWorkosTokenRefresher,
  createAuthenticatedProductTransport,
  createBoundedFetch,
  readSecretValueFromStandardInput,
  readBoundedResponseBody,
  runProductionCli,
  resolveProductCliEnvironment,
} from "../src/composition.js";
import {
  NetworkTransportError,
  PublicResponseTooLargeError,
  cliMetadataResult,
} from "../src/cli.js";
import { GeneratedSdkProductApi } from "../src/product-api.js";
import { login, memoryProfiles } from "./memory-profiles.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SAVED = login("owner", "user_owner", null);
const VITE_CONFIGURATION =
  "version: 1\nproject: vite-app\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: static\n";
const CURRENT = {
  accessToken: "access-a",
  refreshToken: "refresh-a",
  expiresAt: "2099-08-18T01:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("production CLI composition", () => {
  it("advertises user-key lifecycle while requiring an authenticated session to list keys", async () => {
    const output: string[] = [];
    const io = {
      writeStdout(value: string) {
        output.push(value);
      },
      writeStderr() {
        throw new Error("Unexpected diagnostic");
      },
    };
    await runProductionCli(["--help"], {}, io, new AbortController().signal);
    const help = JSON.parse(output.pop() ?? "{}");
    expect(
      help.commands.some((item: { command: string }) => item.command.startsWith("token ")),
    ).toBe(true);
    expect(
      help.commands.some((item: { command: string }) => item.command === "export create"),
    ).toBe(true);
    // Without a link in this directory a missing --project stays an invalid command.
    expect(
      await runProductionCli(
        ["project", "status", "--json"],
        {},
        io,
        new AbortController().signal,
        {
          workingDirectory: await mkdtemp(join(tmpdir(), "ohmyhost-unlinked-")),
        },
      ),
    ).toBe(2);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({ error: { code: "invalid_command" } });
    const code = await runProductionCli(
      ["token", "list", "--organization", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--json"],
      {},
      io,
      new AbortController().signal,
      { profiles: (await memoryProfiles()).registry },
    );
    expect(code).toBe(5);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      error: { code: "authentication_required" },
    });
  });

  it("binds each declared platform environment to its own API, identity client and credential namespace", () => {
    const dev = resolveProductCliEnvironment({ OHMYHOST_ENVIRONMENT: "development" });
    const prod = resolveProductCliEnvironment({});
    expect(dev).toEqual({
      commandPrefix: "OHMYHOST_ENVIRONMENT=development ohmyhost",
      apiOrigin: "https://dev.app.ohmyho.st",
      clientId: "client_00000000000000000000000017",
      verificationUri: "https://orderly-laugh-73-staging.authkit.app/device",
      credentialService: "ohmyhost",
      linkDirectory: ".ohmyhost",
    });
    expect(prod).toEqual({
      commandPrefix: "OHMYHOST_ENVIRONMENT=production ohmyhost",
      apiOrigin: "https://app.ohmyho.st",
      clientId: "client_00000000000000000000000018",
      verificationUri: "https://divine-climb-22.authkit.app/device",
      credentialService: "ohmyhost.production",
      linkDirectory: ".ohmyhost/production",
    });
    expect(resolveProductCliEnvironment({ OHMYHOST_ENVIRONMENT: "production" })).toEqual(prod);
    expect(JSON.parse(cliMetadataResult("help").stdout).environment).toBe(
      "OHMYHOST_ENVIRONMENT=development|production (default: production); OHMYHOST_PROFILE=NAME binds this process to one saved login",
    );
  });

  it("rejects unknown environments before logout can clear any credential", async () => {
    const saved = await memoryProfiles([{ profile: SAVED, credential: CURRENT }]);
    const output: string[] = [];
    for (const value of ["prod", "", "https://attacker.example"]) {
      expect(
        await runProductionCli(
          ["logout", "--json"],
          { OHMYHOST_ENVIRONMENT: value },
          { writeStdout: (text) => output.push(text), writeStderr: () => undefined },
          new AbortController().signal,
          { profiles: saved.registry },
        ),
      ).toBe(2);
      expect(await saved.credential(SAVED)).toEqual(CURRENT);
    }
    expect(output.every((text) => JSON.parse(text).error.code === "invalid_environment")).toBe(
      true,
    );
  });

  it("sends each environment's public client ID through the real Device Flow HTTP transport", async () => {
    const calls: { path: string; clientId: string | null; authorization: string | undefined }[] =
      [];
    let refreshAccessToken = "";
    let refreshExpiry = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      const clientId = new URLSearchParams(body).get("client_id");
      const path = request.url ?? "/";
      calls.push({ path, clientId, authorization: request.headers.authorization });
      response.setHeader("content-type", "application/json");
      if (path.endsWith("/device")) {
        response.end(
          JSON.stringify({
            device_code: "device-fixture",
            user_code: "ABCD-EFGH",
            verification_uri:
              clientId === "client_00000000000000000000000018"
                ? "https://divine-climb-22.authkit.app/device"
                : "https://orderly-laugh-73-staging.authkit.app/device",
            expires_in: 300,
            interval: 1,
          }),
        );
      } else if (new URLSearchParams(body).get("grant_type") === "refresh_token") {
        refreshExpiry = Math.floor(Date.now() / 1000) + 600;
        refreshAccessToken = [
          JSON.stringify({ alg: "RS256", typ: "JWT" }),
          JSON.stringify({ exp: refreshExpiry }),
          "signature",
        ]
          .map((value) => Buffer.from(value).toString("base64url"))
          .join(".");
        response.end(
          JSON.stringify({
            access_token: refreshAccessToken,
            refresh_token: "refreshed-refresh",
            token_type: "Bearer",
          }),
        );
      } else {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "access_denied" }));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No HTTP fixture address");
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://api.workos.com");
      return nativeFetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
    });
    try {
      for (const environment of ["development", "production"]) {
        const messages: string[] = [];
        const documents: string[] = [];
        expect(
          await runProductionCli(
            ["login", "--json"],
            { OHMYHOST_ENVIRONMENT: environment },
            {
              writeStdout: (text) => documents.push(text),
              writeStderr: (text) => messages.push(text),
            },
            new AbortController().signal,
            { profiles: (await memoryProfiles()).registry },
          ),
        ).toBe(4);
        // Exit code 4 also covers a transport failure, so name the outcome. Without this the
        // fixture's denial and a request that never reached it look identical.
        expect(documents.map((text) => JSON.parse(text).error.code)).toEqual([
          "device_authorization_denied",
        ]);
        expect(messages.join("")).toContain(
          resolveProductCliEnvironment({ OHMYHOST_ENVIRONMENT: environment }).verificationUri,
        );
      }
      expect(calls.map((call) => call.clientId)).toEqual([
        "client_00000000000000000000000017",
        "client_00000000000000000000000017",
        "client_00000000000000000000000018",
        "client_00000000000000000000000018",
      ]);
      expect(calls.every((call) => call.authorization === undefined)).toBe(true);
      const before = Date.now();
      const refresher = new PublicWorkosTokenRefresher({ OHMYHOST_ENVIRONMENT: "production" });
      const credential = await refresher.refresh("refresh-fixture", new AbortController().signal);
      expect(credential).toMatchObject({
        accessToken: refreshAccessToken,
        refreshToken: "refreshed-refresh",
      });
      expect(credential.expiresAt).toBe(new Date(refreshExpiry * 1000).toISOString());
      expect(Date.parse(credential.expiresAt)).toBeGreaterThan(before);
      expect(calls.at(-1)).toMatchObject({
        clientId: "client_00000000000000000000000018",
        authorization: undefined,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("carries the selected workspace through every token refresh", async () => {
    // The workspace lives in the access token. A refresh that forgets it silently drops the
    // customer back to a credential that can see nothing.
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          access_token: [
            JSON.stringify({ alg: "RS256", typ: "JWT" }),
            // The refresher checks expiry against the real clock, so the token must outlive it.
            JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
            "signature",
          ]
            .map((value) => Buffer.from(value).toString("base64url"))
            .join("."),
          refresh_token: "refreshed",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const refresher = new PublicWorkosTokenRefresher({ OHMYHOST_ENVIRONMENT: "production" });

    await refresher.refresh("refresh-fixture", new AbortController().signal, "org_01ABCDEF");
    expect(new URLSearchParams(bodies[0] ?? "").get("organization_id")).toBe("org_01ABCDEF");

    // Without a selection the request must stay exactly as it was.
    await refresher.refresh("refresh-fixture", new AbortController().signal);
    expect(new URLSearchParams(bodies[1] ?? "").has("organization_id")).toBe(false);

    // The refreshed credential the SDK transport stores must still name the selected workspace.
    const workspace = login("workspace", "user_owner", "01M0WRKSPACEAAAAAAAAAAAAAA");
    const saved = await memoryProfiles([
      {
        profile: workspace,
        credential: {
          accessToken: "expired-access",
          refreshToken: "refresh-fixture",
          expiresAt: "2026-09-15T00:00:00.000Z",
          workosOrganizationId: "org_01ABCDEF",
          organizationId: "01M0WRKSPACEAAAAAAAAAAAAAA",
        },
      },
    ]);
    await createAuthenticatedProductTransport(new AbortController().signal, {
      profiles: saved.registry,
      environment: { OHMYHOST_ENVIRONMENT: "production" },
      now: () => new Date("2026-09-16T00:00:00.000Z"),
    });
    expect(new URLSearchParams(bodies[2] ?? "").get("organization_id")).toBe("org_01ABCDEF");
    expect(await saved.credential(workspace)).toMatchObject({
      refreshToken: "refreshed",
      workosOrganizationId: "org_01ABCDEF",
      organizationId: "01M0WRKSPACEAAAAAAAAAAAAAA",
    });
  });

  it.each(["not_connected", "connected", "unavailable"] as const)(
    "signs in through read-only onboarding ports with GitHub %s",
    async (githubStatus) => {
      const workingDirectory = await mkdtemp(join(tmpdir(), "ohmyhost-onboarding-github-"));
      onTestFinished(() => rm(workingDirectory, { recursive: true, force: true }));
      execFileSync("git", ["init", "--quiet"], { cwd: workingDirectory });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/example/fixture.git"], {
        cwd: workingDirectory,
      });
      // The exact journey a new customer takes: device sign-in, then the workspace the platform
      // already knows about, without a second login.
      const jwt = (expires: string): string =>
        [
          JSON.stringify({ alg: "RS256", typ: "JWT" }),
          JSON.stringify({ exp: Math.floor(Date.parse(expires) / 1000) }),
          "signature",
        ]
          .map((value) => Buffer.from(value).toString("base64url"))
          .join(".");
      const seen: string[] = [];
      let scoped = false;
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = new URLSearchParams(String(init?.body ?? ""));
        seen.push(url.pathname);
        const json = (value: unknown) =>
          new Response(JSON.stringify(value), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.pathname.endsWith("/authorize/device"))
          return json({
            device_code: "device-fixture",
            user_code: "ABCD-EFGH",
            verification_uri: "https://divine-climb-22.authkit.app/device",
            expires_in: 300,
            interval: 1,
          });
        if (url.pathname.endsWith("/authenticate")) {
          if (body.get("organization_id") === "org_fixture") scoped = true;
          return json({
            // Login checks expiry against the real clock, so the token must outlive it.
            access_token: jwt(new Date(Date.now() + 3_600_000).toISOString()),
            refresh_token: "refresh-fixture",
            token_type: "Bearer",
          });
        }
        if (url.pathname === "/v1/me")
          return json({
            actor_id: "user:user_fixture",
            email: "fixture@example.test",
            organization_ids: scoped ? ["01M2NFNNQV8C4N1WDYJQJ6RQXC"] : [],
            organizations: scoped ? [{ id: "01M2NFNNQV8C4N1WDYJQJ6RQXC", name: "Fixture" }] : [],
          });
        if (url.pathname === "/v1/me/profile")
          return json({
            user_id: "user_fixture",
            name: "Fixture Owner",
            email: "owner@example.test",
            email_verified: true,
            organizations: [
              {
                id: "01M2NFNNQV8C4N1WDYJQJ6RQXC",
                workos_id: "org_fixture",
                name: "ONBOARDING-FIXTURE",
              },
            ],
            organization_ids: ["01M2NFNNQV8C4N1WDYJQJ6RQXC"],
            signup_source: null,
            attributed_at: null,
            initial_workspace_id: "01M2NFNNQV8C4N1WDYJQJ6RQXC",
          });
        if (url.pathname === "/v1/organizations/01M2NFNNQV8C4N1WDYJQJ6RQXC/github") {
          const request = new Request(input, init);
          expect(request.method).toBe("GET");
          expect(request.headers.get("authorization")).toMatch(/^Bearer /u);
          expect(request.headers.get("idempotency-key")).toBeNull();
          if (githubStatus === "unavailable") return new Response(null, { status: 503 });
          return json({
            status: githubStatus,
            connection:
              githubStatus === "not_connected"
                ? null
                : {
                    connection_id: "01M2NFNNQV8C4N1WDYJQJ6RQXB",
                    organization_id: "01M2NFNNQV8C4N1WDYJQJ6RQXC",
                    installation_id: "42",
                    account_id: "7",
                    account_login: "owner",
                    account_type: "User",
                    github_user_id: "7",
                    github_user_login: "owner",
                    connected_at: "2026-09-19T00:00:00.000Z",
                    revoked_at: null,
                    settings_url: "https://github.com/settings/installations/42",
                  },
          });
        }
        throw new Error(`unexpected request to ${url.pathname}`);
      });
      const saved = await memoryProfiles();
      const documents: string[] = [];

      const exitCode = await runProductionCli(
        ["login", "--json"],
        { OHMYHOST_ENVIRONMENT: "production" },
        { writeStdout: (text) => documents.push(text), writeStderr: () => undefined },
        new AbortController().signal,
        { profiles: saved.registry, workingDirectory },
      );

      expect(exitCode).toBe(0);
      // The scoped token is verified before anything is saved; the GitHub read comes after.
      expect(seen.filter((path) => path.startsWith("/v1/"))).toEqual([
        "/v1/me/profile",
        "/v1/me",
        "/v1/organizations/01M2NFNNQV8C4N1WDYJQJ6RQXC/github",
      ]);
      const document = JSON.parse(documents.join(""));
      expect(document.status).toBe("authenticated");
      if (githubStatus === "not_connected")
        expect(document.next_action).toContain(
          "github connect --organization 01M2NFNNQV8C4N1WDYJQJ6RQXC",
        );
      else expect(document.next_action).toBeUndefined();
      expect(scoped).toBe(true);
      const onboardingFixture = login(
        "onboarding-fixture",
        "user_fixture",
        "01M2NFNNQV8C4N1WDYJQJ6RQXC",
        "ONBOARDING-FIXTURE",
      );
      expect(await saved.registry.list()).toEqual([onboardingFixture]);
      expect(document.profile).toEqual({
        name: "onboarding-fixture",
        user_id: "user_fixture",
        organization_id: "01M2NFNNQV8C4N1WDYJQJ6RQXC",
        organization_name: "ONBOARDING-FIXTURE",
      });
      expect(await saved.credential(onboardingFixture)).toMatchObject({
        workosOrganizationId: "org_fixture",
        organizationId: "01M2NFNNQV8C4N1WDYJQJ6RQXC",
      });
    },
  );

  it("runs help and version offline without WorkOS configuration, credentials, or network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const stdout: string[] = [];

    for (const argv of [["--help"], ["--version"], ["project", "create", "--help"]]) {
      await expect(
        runProductionCli(
          argv,
          {},
          { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
          new AbortController().signal,
        ),
      ).resolves.toBe(0);
    }

    expect(stdout.map((value) => JSON.parse(value))).toEqual([
      expect.objectContaining({ command: "help", status: "succeeded" }),
      expect.objectContaining({ command: "version", cli_version: cliPackage.version }),
      expect.objectContaining({
        command: "help",
        status: "succeeded",
        commands: [
          {
            command: "project create",
            usage:
              "ohmyhost project create --organization ULID --name NAME [--include-development-environment true|false] [--data-mode shared|isolated] [--dev-access-mode protected|public] [--region us|eu] --idempotency-key KEY --json (Dev defaults to included; add it later with project dev add. Data mode defaults to shared; later changes do not copy data. The region is chosen once: us defaults to US; eu selects EU database, new files and builds; the customer API cannot change region later)",
          },
        ],
      }),
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lists the commands of a group for help database and refuses an unknown help topic", async () => {
    const output: string[] = [];
    const io = {
      writeStdout: (value: string) => output.push(value),
      writeStderr: () => undefined,
    };
    await expect(
      runProductionCli(["help", "database", "--json"], {}, io, new AbortController().signal),
    ).resolves.toBe(0);
    const help = JSON.parse(output.pop() ?? "{}") as { commands: { command: string }[] };
    expect(help.commands.length).toBeGreaterThan(0);
    expect(help.commands.every((entry) => entry.command.startsWith("database "))).toBe(true);
    expect(help.commands.map((entry) => entry.command)).toContain("database webhook create");

    await expect(
      runProductionCli(["help", "nosuchgroup", "--json"], {}, io, new AbortController().signal),
    ).resolves.toBe(2);
    expect(JSON.parse(output.pop() ?? "{}")).toMatchObject({
      error: { code: "invalid_command" },
    });
  });

  it("reads one bounded UTF-8 secret value from standard input", async () => {
    const input = (async function* () {
      yield new TextEncoder().encode("postgres://");
      yield "private";
    })();

    await expect(
      readSecretValueFromStandardInput(input, new AbortController().signal),
    ).resolves.toBe("postgres://private");
  });

  it("rejects oversized piped secrets through the production stdin reader before any API request", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    if (!descriptor) throw new Error("Process stdin is unavailable");
    const input = Readable.from([Buffer.alloc(5121, 120)]);
    const dispatcher = getGlobalDispatcher();
    const http = new MockAgent();
    http.disableNetConnect();
    const output: string[] = [],
      diagnostics: string[] = [];
    const retained = {
      accessToken: "retained-test-session",
      refreshToken: "retained-test-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const saved = await memoryProfiles([{ profile: SAVED, credential: retained }]);
    try {
      Object.defineProperty(process, "stdin", { configurable: true, value: input });
      setGlobalDispatcher(http);
      const code = await runProductionCli(
        [
          "secret",
          "set",
          "APP_SECRET",
          "--project",
          "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          "--environment",
          "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          "--idempotency-key",
          "oversized-stdin",
          "--stdin",
          "--json",
        ],
        { OHMYHOST_TOKEN: `sk_${"test-only-".repeat(4)}` },
        {
          writeStdout(value) {
            output.push(value);
          },
          writeStderr(value) {
            diagnostics.push(value);
          },
        },
        new AbortController().signal,
        { profiles: saved.registry },
      );
      expect(code).toBe(2);
      expect(JSON.parse(output.join(""))).toMatchObject({
        command: "secret set",
        status: "error",
        error: { code: "secret_input_invalid" },
      });
      expect(output.join("") + diagnostics.join("")).not.toContain("x".repeat(5121));
      expect(await saved.credential(SAVED)).toEqual(retained);
      expect(saved.writes).toEqual([]);
      http.assertNoPendingInterceptors();
    } finally {
      Object.defineProperty(process, "stdin", descriptor);
      setGlobalDispatcher(dispatcher);
      input.destroy();
      await http.close();
    }
  });

  it("rejects empty, invalid UTF-8, and oversized secret input", async () => {
    const empty = (async function* () {})();
    const invalid = (async function* () {
      yield new Uint8Array([0xff]);
    })();
    const oversized = (async function* () {
      yield new Uint8Array(5_121);
    })();

    await expect(
      readSecretValueFromStandardInput(empty, new AbortController().signal),
    ).rejects.toThrow("secret input is invalid");
    await expect(
      readSecretValueFromStandardInput(invalid, new AbortController().signal),
    ).rejects.toThrow("secret input is invalid");
    await expect(
      readSecretValueFromStandardInput(oversized, new AbortController().signal),
    ).rejects.toThrow("secret input is invalid");
  });

  it("runs init offline without WorkOS configuration, credentials, or network", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-production-init-"));
    try {
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "fixture-app",
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          devDependencies: { vite: "7.1.0" },
        })}\n`,
      );
      await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      const fetch = vi.fn<typeof globalThis.fetch>();
      vi.stubGlobal("fetch", fetch);
      const stdout: string[] = [];

      const exitCode = await runProductionCli(
        ["init", "--directory", directory, "--dry-run", "--json"],
        {},
        { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
        new AbortController().signal,
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        version: 1,
        command: "init",
        status: "analyzed",
        applicationRoot: ".",
        applicationRootSource: "repository",
        inventory: { framework: "vite", database: { provider: "none" } },
        compatibility: {
          frameworks: [
            {
              package: "vite",
              declared: "7.1.0",
              resolved: null,
              status: "admitted",
              minimum: "5.4.6",
            },
          ],
        },
        blockers: [],
        pending: [
          { code: "frozen_install", message: expect.stringContaining("frozen install") },
          { code: "framework_build", message: expect.stringContaining("scripts.build") },
          {
            code: "reachable_runtime_sources",
            message: expect.stringContaining("Workers-incompatible imports"),
          },
          { code: "project_state", message: expect.stringContaining("storage.jurisdiction") },
        ],
        companion: null,
        runtime: null,
      });
      expect(fetch).not.toHaveBeenCalled();
      await mkdir(join(directory, ".git"));
      await mkdir(join(directory, "website"));
      stdout.length = 0;
      const nestedExit = await runProductionCli(
        ["init", "--directory", join(directory, "website"), "--json"],
        {},
        { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
        new AbortController().signal,
      );
      expect(nestedExit).toBe(2);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "error",
        error: {
          code: "repository_root_required",
          retryable: false,
          suggested_action: expect.stringContaining("--root website"),
        },
      });
      await expect(readFile(join(directory, "website/ohmyhost.yaml"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("reports a blocked dry run as status blocked and exit code 9", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-blocked-init-"));
    try {
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "blocked-app",
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          devDependencies: { vite: "8.2.2" },
        })}\n`,
      );
      await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await writeFile(
        join(directory, "ohmyhost.yaml"),
        "version: 1\nproject: blocked-app\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: edge\nstorage:\n  provider: r2\n  jurisdiction: us\n  public: false\n",
      );
      await mkdir(join(directory, "src", "ohmyhost"), { recursive: true });
      const companion = join(directory, "src", "ohmyhost", "companion.ts");
      await writeFile(companion, "export default { fetch: () => new Response('ok') };\n");
      const stdout: string[] = [];
      const run = async (): Promise<number> =>
        runProductionCli(
          ["init", "--directory", directory, "--dry-run", "--json"],
          {},
          { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
          new AbortController().signal,
        );

      const blockedExitCode = await run();

      expect(blockedExitCode).toBe(9);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        version: 1,
        command: "init",
        status: "blocked",
        written: false,
        blockers: [
          {
            code: "storage_client_missing",
            message: expect.stringContaining("createPrivateStorageClient") as unknown as string,
          },
        ],
        configuration: { path: "ohmyhost.yaml" },
        inventory: { framework: "vite" },
        requirements: [],
        companion: { sourceEntryPoint: "src/ohmyhost/companion.ts" },
        worker: null,
      });

      stdout.splice(0);
      await writeFile(
        companion,
        'import { createPrivateStorageClient } from "@ohmyhost/customer-runtime/storage";\n' +
          "export default { fetch: (request, env) =>\n" +
          "  Response.json(createPrivateStorageClient({ key: env.OHMYHOST_STORAGE_KEY })) };\n",
      );

      const cleanExitCode = await run();

      expect(cleanExitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({ status: "analyzed", blockers: [] });

      // A range no lockfile resolves is pending: reported, admitted, never a blocker or exit 9.
      stdout.splice(0);
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "blocked-app",
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          devDependencies: { vite: "^5.4.0" },
        })}\n`,
      );

      const pendingExitCode = await run();

      expect(pendingExitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "analyzed",
        blockers: [],
        compatibility: {
          frameworks: [
            {
              package: "vite",
              declared: "^5.4.0",
              resolved: null,
              status: "pending",
              minimum: "5.4.6",
            },
          ],
        },
        pending: [
          {
            code: "installed_version",
            message: expect.stringContaining("compatibility.frameworks"),
          },
          { code: "frozen_install" },
          { code: "framework_build" },
          { code: "reachable_runtime_sources" },
          { code: "project_state" },
        ],
      });

      // An ohmyhost.yaml planning refuses is a blocker naming the exact field, not an init error.
      stdout.splice(0);
      await writeFile(
        join(directory, "ohmyhost.yaml"),
        "version: 1\nproject: blocked-app\nbuild:\n  install: pnpm install --frozen-lockfile --ignore-scripts\n  command: pnpm run build\n  output: dist\nruntime:\n  mode: container\n",
      );

      const invalidExitCode = await run();

      expect(invalidExitCode).toBe(9);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        status: "blocked",
        blockers: [
          {
            code: "repository_configuration_invalid",
            path: "ohmyhost.yaml",
            message:
              "ohmyhost.yaml is invalid: /runtime/mode must be equal to one of the allowed values. Fix that in ohmyhost.yaml and run init again; init never rewrites an existing ohmyhost.yaml, so do not delete it.",
          },
        ],
        compatibility: { frameworks: [] },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("writes the resolved hosting region as the storage jurisdiction of the proposed ohmyhost.yaml", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-region-init-"));
    try {
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "video-vite",
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          devDependencies: { vite: "8.2.2", wrangler: "4.125.0" },
        })}\n`,
      );
      await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await mkdir(join(directory, "worker"), { recursive: true });
      await writeFile(
        join(directory, "worker", "wrangler.toml"),
        '[[r2_buckets]]\nbinding = "CLIPS"\nbucket_name = "clips"\n',
      );
      // Storage runs in the edge companion, which planning requires before the build.
      await mkdir(join(directory, "src", "ohmyhost"), { recursive: true });
      await writeFile(
        join(directory, "src", "ohmyhost", "companion.ts"),
        "export default { fetch() { return new Response('ok'); } };\n",
      );
      const stdout: string[] = [];

      const exitCode = await runProductionCli(
        ["init", "--directory", directory, "--region", "eu", "--dry-run", "--json"],
        {},
        { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
        new AbortController().signal,
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        configuration: {
          yaml: expect.stringContaining("storage:\n  provider: r2\n  jurisdiction: eu\n"),
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("returns the executable Vite companion scaffold through the public init JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-vite-companion-init-"));
    try {
      await writeFile(
        join(directory, "package.json"),
        `${JSON.stringify({
          name: "vite-companion",
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          dependencies: {},
          devDependencies: { vite: "8.2.2" },
        })}\n`,
      );
      await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      await mkdir(join(directory, "postgres", "migrations"), { recursive: true });
      await writeFile(
        join(directory, "postgres", "migrations", "20260824000000_app.sql"),
        "create table public.events(id uuid);\n",
      );
      await mkdir(join(directory, "src", "ohmyhost"), { recursive: true });
      await writeFile(
        join(directory, "src", "ohmyhost", "companion.ts"),
        "export default { fetch() { return new Response('ok'); } };\n",
      );
      const stdout: string[] = [];

      const exitCode = await runProductionCli(
        ["init", "--directory", directory, "--dry-run", "--json"],
        {},
        { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
        new AbortController().signal,
      );

      expect(exitCode).toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        configuration: { yaml: expect.stringContaining("mode: edge") },
        requirements: [],
        companion: {
          schemaVersion: "ohmyhost.vite-api-companion/v1",
          sourceEntryPoint: "src/ohmyhost/companion.ts",
          missingFiles: [],
          packages: {
            customerRuntime: expect.stringMatching(
              /^npm:@amerged\/ohmyhost-runtime@\d+\.\d+\.\d+$/u,
            ),
          },
          bindings: ["OHMYHOST_DATABASE"],
        },
        runtime: {
          packages: {
            customerRuntime: expect.stringMatching(
              /^npm:@amerged\/ohmyhost-runtime@\d+\.\d+\.\d+$/u,
            ),
          },
          bindings: ["OHMYHOST_DATABASE"],
        },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it.each([
    {
      label: "a login flag",
      files: {},
      argv: ["--profile-name", "owner", "--dry-run"],
      code: "invalid_command",
      action:
        "ohmyhost init runs offline and uses no login: remove --profile-name and run it again.",
    },
    {
      label: "an existing configuration",
      files: { "ohmyhost.yaml": VITE_CONFIGURATION },
      argv: [],
      code: "repository_configuration_exists",
      action:
        "ohmyhost.yaml already exists and init never overwrites it; that file stays authoritative. Run 'ohmyhost init --dry-run --json' to check it and list blockers, then edit the file by hand. Do not delete it to rerun init.",
    },
    {
      label: "a configuration larger than init reads",
      files: { "ohmyhost.yaml": `${VITE_CONFIGURATION}${"#".repeat(64 * 1024)}\n` },
      argv: ["--dry-run"],
      code: "repository_configuration_invalid",
      action:
        "ohmyhost.yaml must be one regular file of at most 64 KiB. Fix that, then run 'ohmyhost init --dry-run --json' again; do not delete ohmyhost.yaml.",
    },
    {
      label: "a configuration for another root",
      files: { "ohmyhost.yaml": `${VITE_CONFIGURATION}applicationRoot: web\n` },
      argv: ["--dry-run"],
      code: "repository_configuration_root_mismatch",
      action:
        "ohmyhost.yaml sets applicationRoot to 'web', but init selected '.'. Run 'ohmyhost init --root web --dry-run --json', or correct applicationRoot.",
    },
    {
      label: "a root outside the repository",
      files: {},
      argv: ["--root", "../site", "--dry-run"],
      code: "application_root_invalid",
      action:
        "Application root must be a canonical repository-relative POSIX path. Pass --root as a path relative to the repository root, for example apps/web.",
    },
    {
      label: "no supported application",
      files: { "package.json": JSON.stringify({ name: "tooling", dependencies: {} }) },
      argv: ["--dry-run"],
      code: "application_root_not_found",
      action:
        "No self-contained supported application root was found. init needs a package.json that depends on next (without vite or @tanstack/react-start), on vite, or on @tanstack/react-start, or a functions app with src/ohmyhost/worker.ts. Pass --root DIR with the app's directory, or fix its package.json, then run init again.",
    },
    {
      label: "an unreadable package manifest",
      files: { "package.json": "{" },
      argv: ["--root", ".", "--dry-run"],
      code: "application_root_unsupported",
      action:
        "Application root '.' is not a self-contained supported application. init needs a package.json that depends on next (without vite or @tanstack/react-start), on vite, or on @tanstack/react-start, or a functions app with src/ohmyhost/worker.ts. Pass --root DIR with the app's directory, or fix its package.json, then run init again.",
    },
  ])("tells how to fix init with $label", async ({ files, argv, code, action }) => {
    const directory = await mkdtemp(join(tmpdir(), "ohmyhost-init-failure-"));
    try {
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: "vite-app",
          packageManager: "pnpm@10.28.2",
          scripts: { build: "vite build" },
          devDependencies: { vite: "8.2.2" },
        }),
      );
      await writeFile(join(directory, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      for (const [name, contents] of Object.entries(files))
        await writeFile(join(directory, name), contents);
      const stdout: string[] = [];

      const exitCode = await runProductionCli(
        ["init", "--directory", directory, ...argv, "--json"],
        {},
        { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
        new AbortController().signal,
      );

      expect(exitCode).toBe(2);
      expect(JSON.parse(stdout.join(""))).toEqual({
        version: 1,
        command: "init",
        status: "error",
        error: { code, retryable: false, suggested_action: action },
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("loads the complete public barrel", async () => {
    await expect(import("../src/index.js")).resolves.toMatchObject({
      ProductCli: expect.any(Function),
      runProductionCli: expect.any(Function),
      GeneratedSdkProductApi: expect.any(Function),
    });
  });

  it("returns a stable allowlisted error for an invalid command before config", async () => {
    const stdout: Array<string> = [];

    const exitCode = await runProductionCli(
      ["login", "--token", "secret-value"],
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
      new AbortController().signal,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      command: "login",
      error: { code: "invalid_command" },
    });
    expect(stdout.join("")).not.toContain("secret-value");
  });

  it("rejects file-store selection before credential access or network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const stdout: string[] = [];

    const exitCode = await runProductionCli(
      ["operation", "get", "01K2F3G4H5J6K7M8N9P0QRSTVW", "--credential-store=file", "--json"],
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
      new AbortController().signal,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      command: "operation get",
      error: { code: "invalid_command", retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("streams validated SSE events immediately through production stdout", async () => {
    const saved = await memoryProfiles([{ profile: SAVED, credential: CURRENT }]);
    const event = {
      event_id: "01K2F3G4H5J6K7M8N9P0QRSTVZ",
      operation_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
      project_id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
      type: "OperationSucceeded",
      occurred_at: "2026-08-18T00:00:01.000Z",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toContain("https://app.ohmyho.st/v1/operations/");
      // The operation is read first, so an unknown one is answered before any stream opens.
      if (!request.url.endsWith("/events"))
        return Response.json({
          id: event.operation_id,
          state: "running",
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
        });
      return new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    const stdout: string[] = [];

    const exitCode = await runProductionCli(
      ["logs", event.operation_id, "--follow", "--json"],
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
      new AbortController().signal,
      { profiles: saved.registry },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(2);
    expect(JSON.parse(stdout[0] ?? "")).toEqual(event);
    expect(JSON.parse(stdout[1] ?? "")).toMatchObject({
      command: "logs",
      status: "completed",
      event_count: 1,
    });
  });

  it("answers an unknown operation's log stream once instead of retrying it forever", async () => {
    const saved = await memoryProfiles([{ profile: SAVED, credential: CURRENT }]);
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          type: "https://docs.ohmyho.st/errors/resource-not-found",
          title: "Resource not found",
          status: 404,
          code: "resource_not_found",
          request_id: "request-missing",
          retryable: false,
          suggested_action: "Resource not found.",
        },
        { status: 404, headers: { "content-type": "application/problem+json" } },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const stdout: string[] = [];

    const exitCode = await runProductionCli(
      ["logs", "01K2F3G4H5J6K7M8N9P0QRSTVW", "--follow", "--json"],
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
      new AbortController().signal,
      { profiles: saved.registry },
    );

    expect(exitCode).toBe(7);
    expect(JSON.parse(stdout.at(-1) ?? "")).toMatchObject({
      command: "logs",
      error: { code: "resource_not_found", request_id: "request-missing" },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("names the command of an unexpected failure while choosing the account", async () => {
    const saved = await memoryProfiles([{ profile: SAVED, credential: CURRENT }]);
    const registry = Object.assign(Object.create(saved.registry) as typeof saved.registry, {
      list: async () => {
        throw new TypeError("programming detail");
      },
    });
    for (const [argv, command, subsystem] of [
      [["project", "status", "--profile-name", "owner", "--json"], "project status", "parser"],
      [["whoami", "--json"], "whoami", "authentication"],
    ] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await runProductionCli(
        argv,
        {},
        { writeStdout: (value) => stdout.push(value), writeStderr: (value) => stderr.push(value) },
        new AbortController().signal,
        {
          profiles: registry,
          workingDirectory: await mkdtemp(join(tmpdir(), "ohmyhost-unlinked-")),
        },
      );
      expect(exitCode).toBe(1);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        command,
        error: {
          code: "internal_error",
          suggested_action: expect.stringContaining("the stderr line starting with [ohmyhost:"),
        },
      });
      expect(stderr.join("")).toMatch(
        new RegExp(`^\\[ohmyhost:[^\\]]+\\] internal/${subsystem}/unexpected\\n$`, "u"),
      );
      expect(stdout.join("") + stderr.join("")).not.toContain("programming detail");
    }
  });

  it.each([
    [["logout", "--json"], 0, "logged_out"],
    [["logout", "--revoke", "--json"], 6, "error"],
  ] as const)("clears the injected local store for %j", async (argv, expectedCode, status) => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("network unavailable");
    });
    const saved = await memoryProfiles([{ profile: SAVED, credential: CURRENT }]);
    const stdout: string[] = [];
    const exitCode = await runProductionCli(
      argv,
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
      new AbortController().signal,
      { profiles: saved.registry },
    );

    expect(exitCode).toBe(expectedCode);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({ command: "logout", status });
    expect(await saved.registry.list()).toEqual([]);
    expect(await saved.credential(SAVED)).toBeUndefined();
  });

  it("rejects an argv API-origin override before credential access or network", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const stdout: Array<string> = [];

    const exitCode = await runProductionCli(
      [
        "operation",
        "get",
        "01K2F3G4H5J6K7M8N9P0QRSTVW",
        "--api-url",
        "https://attacker.example/token-collector",
        "--json",
      ],
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: () => undefined },
      new AbortController().signal,
    );

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      command: "operation get",
      error: { code: "invalid_command", retryable: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("composes public Device Flow transport, presentation, clock, and polling", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: "device-a",
            user_code: "ABCD-EFGH",
            verification_uri: "https://divine-climb-22.authkit.app/device",
            expires_in: 600,
            interval: 5,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "access_denied" }), {
          headers: { "content-type": "application/json" },
          status: 400,
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];

    const pending = runProductionCli(
      ["login", "--json"],
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: (value) => stderr.push(value) },
      new AbortController().signal,
      { profiles: (await memoryProfiles()).registry },
    );
    await vi.waitFor(() => expect(stderr.join("")).toContain("ABCD-EFGH"));
    await vi.advanceTimersByTimeAsync(5_000);
    const exitCode = await pending;

    expect(exitCode).toBe(4);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      command: "login",
      error: { code: "device_authorization_denied" },
    });
    expect(stderr.join("")).toContain("ABCD-EFGH");
    expect(fetch).toHaveBeenCalledTimes(2);
    const firstCall = fetch.mock.calls[0];
    if (firstCall === undefined) throw new Error("Expected Device Authorization request");
    const request = new Request(firstCall[0], firstCall[1]);
    const body = new URLSearchParams(await request.text());
    expect(body.get("client_id")).toBe("client_00000000000000000000000018");
  });

  it("cancels the production Device Flow wait through its AbortSignal", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            device_code: "device-a",
            user_code: "ABCD-EFGH",
            verification_uri: "https://divine-climb-22.authkit.app/device",
            expires_in: 600,
            interval: 5,
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    const stdout: Array<string> = [];
    const stderr: Array<string> = [];
    const pending = runProductionCli(
      ["login", "--json"],
      {},
      { writeStdout: (value) => stdout.push(value), writeStderr: (value) => stderr.push(value) },
      controller.signal,
      { profiles: (await memoryProfiles()).registry },
    );
    await vi.waitFor(() => expect(stderr.join("")).toContain("ABCD-EFGH"));

    controller.abort(new DOMException("Cancelled", "AbortError"));
    const exitCode = await pending;

    expect(exitCode).toBe(130);
    expect(JSON.parse(stdout[0] ?? "")).toMatchObject({
      command: "login",
      error: { code: "command_cancelled" },
    });
  });

  it("revokes through the selected profile's generated SDK without sending refresh tokens or foreign targets", async () => {
    const received: { path: string; method?: string; authorization?: string; body: string }[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      received.push({
        path: request.url ?? "",
        method: request.method,
        authorization: request.headers.authorization,
        body,
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ revoked: true }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const actualFetch = globalThis.fetch;
    const other = login("other", "user_other", null);
    const saved = await memoryProfiles([
      { profile: other, credential: { ...CURRENT, accessToken: "other-access" } },
      {
        profile: SAVED,
        credential: {
          accessToken: "current-access",
          refreshToken: "private-refresh",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    ]);
    const lifecycle = new GeneratedSdkSessionRevoker({
      environment: { OHMYHOST_ENVIRONMENT: "production" },
      profiles: saved.registry,
      request: { name: SAVED.name },
      fetch: async (input, init) => {
        const request = new Request(input, init),
          url = new URL(request.url);
        expect(url.origin).toBe("https://app.ohmyho.st");
        expect(request.headers.get("idempotency-key")).toBeTruthy();
        return actualFetch(new Request(`http://127.0.0.1:${address.port}${url.pathname}`, request));
      },
    });
    try {
      await lifecycle.revoke("private-refresh", new AbortController().signal);
      expect(received).toEqual([
        {
          path: "/v1/session:revoke",
          method: "POST",
          authorization: "Bearer current-access",
          body: "",
        },
      ]);
      expect(JSON.stringify(received)).not.toContain("private-refresh");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects declared and streamed response overflow before buffering the full body", async () => {
    await expect(
      readBoundedResponseBody(new Response("small", { headers: { "content-length": "101" } }), 100),
    ).rejects.toEqual(new PublicResponseTooLargeError());

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(60));
        controller.enqueue(new Uint8Array(60));
        controller.close();
      },
    });
    await expect(readBoundedResponseBody(new Response(stream), 100)).rejects.toEqual(
      new PublicResponseTooLargeError(),
    );
    let cancelled = false;
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(101));
      },
      cancel() {
        cancelled = true;
        throw new Error("private stream cancellation detail");
      },
    });
    await expect(readBoundedResponseBody(new Response(interrupted), 100)).rejects.toEqual(
      new PublicResponseTooLargeError(),
    );
    expect(cancelled).toBe(true);
  });

  it("bounds streamed generated-SDK responses before the client buffers JSON", async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"'));
        controller.enqueue(new Uint8Array(200));
        controller.close();
      },
    });
    const boundedFetch = createBoundedFetch(
      async () => new Response(oversized, { status: 200 }),
      new AbortController().signal,
      1_000,
      100,
    );
    const api = new GeneratedSdkProductApi(
      "https://control.example.test",
      "access-a",
      boundedFetch,
    );

    await expect(api.getOperation("01K2F3G4H5J6K7M8N9P0QRSTVW")).rejects.toEqual(
      new PublicResponseTooLargeError(),
    );
    let cancelled = false;
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(101));
      },
      cancel() {
        cancelled = true;
        throw new Error("private SDK stream cancellation detail");
      },
    });
    const interruptedApi = new GeneratedSdkProductApi(
      "https://control.example.test",
      "access-a",
      createBoundedFetch(
        async () => new Response(interrupted),
        new AbortController().signal,
        1_000,
        100,
      ),
    );
    await expect(interruptedApi.getOperation("01K2F3G4H5J6K7M8N9P0QRSTVW")).rejects.toEqual(
      new PublicResponseTooLargeError(),
    );
    expect(cancelled).toBe(true);
  });

  it("keeps generated SDK SSE responses streaming until the caller aborts", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
    });
    const response = new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const boundedFetch = createBoundedFetch(
      async () => response,
      new AbortController().signal,
      1,
      1,
    );

    await expect(
      boundedFetch("https://control.example.test/v1/operations/a/events", {
        headers: { Accept: "text/event-stream" },
      }),
    ).resolves.toBe(response);
  });

  it("does not consume a generated-SDK Request body while detecting SSE", async () => {
    let observedBody = "";
    const boundedFetch = createBoundedFetch(
      async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        observedBody = await request.text();
        return new Response('{"state":"accepted"}', {
          headers: { "content-type": "application/json" },
          status: 202,
        });
      },
      new AbortController().signal,
      1_000,
      1_000,
    );
    const request = new Request("https://control.example.test/v1/projects", {
      body: JSON.stringify({ name: "sandbox" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(boundedFetch(request)).resolves.toMatchObject({ status: 202 });
    expect(observedBody).toBe('{"name":"sandbox"}');
  });

  it("maps only failures raised at the fetch boundary to NetworkTransportError", async () => {
    const boundedFetch = createBoundedFetch(
      async () => {
        throw new TypeError("raw socket detail");
      },
      new AbortController().signal,
      1_000,
      100,
    );

    await expect(boundedFetch("https://control.example.test/v1/projects")).rejects.toEqual(
      new NetworkTransportError(),
    );
  });

  it("contains no secret environment names or helper-process credential paths", async () => {
    const source = await Promise.all(
      ["src/bin.ts", "src/composition.ts", "src/file-credential-store.ts"].map((path) =>
        readFile(join(packageRoot, path), "utf8"),
      ),
    ).then((files) => files.join("\n"));

    expect(source).not.toMatch(
      /WORKOS_API_KEY|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN|child_process|security -w|secret-tool/u,
    );
    // The only child process is the customer's own psql; it never sees an authentication credential.
    const psql = await readFile(join(packageRoot, "src/psql-session.ts"), "utf8");
    expect(psql).not.toMatch(
      /WORKOS_API_KEY|CLIENT_SECRET|REFRESH_TOKEN|ACCESS_TOKEN|security -w|secret-tool/u,
    );
    expect(psql).toMatch(
      /spawn\(\s*"psql",\s*\["-h", bridge\.host, "-U", input\.user, "-d", input\.database\]/u,
    );
    expect(psql).not.toMatch(/input\.password[^;]*args|--password|-W\b/u);
  });
});

it("shows the provider's prefilled sign-in link instead of asking for the code", async () => {
  const { StderrDeviceAuthorizationPresenter } = await import("../src/composition.js");
  const lines: string[] = [];
  const io = {
    writeStdout: () => undefined,
    writeStderr: (value: string) => lines.push(value),
  } as unknown as ConstructorParameters<typeof StderrDeviceAuthorizationPresenter>[0];

  const presenter = new StderrDeviceAuthorizationPresenter(io);
  await presenter.present({
    verificationUri: "https://divine-climb-22.authkit.app/device",
    verificationUriComplete: "https://divine-climb-22.authkit.app/device?user_code=ABCD-EFGH",
    userCode: "ABCD-EFGH",
    expiresInSeconds: 300,
  });
  expect(lines[0]).toContain("https://divine-climb-22.authkit.app/device?user_code=ABCD-EFGH");
  expect(lines[0]).toContain("ABCD-EFGH");
  expect(lines[0]).toMatch(/create your account on that page/iu);
  expect(lines[0]).not.toMatch(/enter code/iu);
  // The customer must know the code stops working, or they read a rejection as a broken product.
  expect(lines[0]).toContain("valid for 5 minutes");

  // Without the prefilled link the customer still gets the manual instruction.
  await presenter.present({
    verificationUri: "https://divine-climb-22.authkit.app/device",
    userCode: "ABCD-EFGH",
    expiresInSeconds: 300,
  });
  expect(lines[1]).toBe(
    "Open https://divine-climb-22.authkit.app/device and enter code ABCD-EFGH. It is valid for 5 minutes; if it lapses, a fresh code appears here.\n",
  );
});
