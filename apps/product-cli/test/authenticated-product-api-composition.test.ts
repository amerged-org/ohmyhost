import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";

import {
  createProductionAuthenticatedProductApi,
  ProductApiAuthenticationError,
  runProductionCli,
} from "../src/composition.js";
import { ProfileSelectionError } from "../src/profile-store.js";
import { login, memoryProfiles } from "./memory-profiles.js";

const OWNER = login("owner", "user_owner", "01M0WRKSPACEAAAAAAAAAAAAAA");
const OTHER = login("other", "user_other", "01M0WRKSPACEBBBBBBBBBBBBBB");

const deployment = {
  id: "01K2F3G4H5J6K7M8N9P0QRSTVY",
  project_id: "01K2F3G4H5J6K7M8N9P0QRSTVW",
  operation_id: "01K2F3G4H5J6K7M8N9P0QRSTVX",
  commit_sha: "a".repeat(40),
  source_digest: "b".repeat(64),
  build_plan_digest: "c".repeat(64),
  artifact_digest: "d".repeat(64),
  status: "active" as const,
  url: "https://calm-otter-waves.your-omh-account.workers.dev",
  created_at: "2026-08-26T00:00:00.000Z",
  updated_at: "2026-08-26T00:01:00.000Z",
};

async function refreshFixture() {
  const nativeFetch = globalThis.fetch;
  const requests: { path: string; body: URLSearchParams; authorization?: string }[] = [];
  let mode = "ok";
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({
      path: request.url ?? "/",
      body: new URLSearchParams(body),
      ...(request.headers.authorization === undefined
        ? {}
        : { authorization: request.headers.authorization }),
    });
    response.setHeader("content-type", "application/json");
    if (mode !== "ok") {
      response.statusCode = mode === "invalid_grant" ? 400 : mode === "unavailable" ? 503 : 200;
      response.end(
        JSON.stringify(
          mode === "malformed"
            ? { access_token: "secret-canary" }
            : { error: mode, error_description: "secret-canary" },
        ),
      );
      return;
    }
    const segment = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    response.end(
      JSON.stringify({
        access_token: `${segment({ alg: "RS256" })}.${segment({ exp: 1787724000 })}.YQ`,
        refresh_token: "refresh-replacement",
        token_type: "Bearer",
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP fixture port");
  return {
    requests,
    setMode(value: string) {
      mode = value;
    },
    fetch: ((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe("https://api.workos.com");
      return nativeFetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
    }) as typeof globalThis.fetch,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("authenticated ProductApi composition", () => {
  it("refreshes through public HTTP with the selected client and persists the replacement before SDK use", async () => {
    const fixture = await refreshFixture();
    try {
      for (const name of ["development", "production"]) {
        const saved = await memoryProfiles([
          {
            profile: OWNER,
            credential: {
              accessToken: "expired",
              refreshToken: "refresh-original",
              expiresAt: "2026-08-26T00:00:00.000Z",
            },
          },
        ]);
        await createProductionAuthenticatedProductApi(new AbortController().signal, {
          environment: { OHMYHOST_ENVIRONMENT: name },
          profiles: saved.registry,
          fetch: fixture.fetch,
          now: () => new Date("2026-08-26T01:00:00.000Z"),
        });
        const credential = await saved.credential(OWNER);
        expect(credential?.refreshToken).toBe("refresh-replacement");
        expect(Date.parse(credential?.expiresAt ?? "")).toBe(1787724000000);
        expect(await saved.registry.list()).toEqual([OWNER]);
      }
      expect(fixture.requests.map((r) => r.body.get("client_id"))).toEqual([
        "client_00000000000000000000000017",
        "client_00000000000000000000000018",
      ]);
      for (const request of fixture.requests) {
        expect(request.path).toBe("/user_management/authenticate");
        expect([...request.body.keys()].sort()).toEqual([
          "client_id",
          "grant_type",
          "refresh_token",
        ]);
        expect(request.body.get("grant_type")).toBe("refresh_token");
        expect(request.authorization).toBeUndefined();
      }
    } finally {
      await fixture.close();
    }
  });

  it("clears only the rejected selected session and requires a new login", async () => {
    const fixture = await refreshFixture();
    fixture.setMode("invalid_grant");
    const rejected = {
      accessToken: "expired",
      refreshToken: "invalid",
      expiresAt: "2026-08-26T00:00:00.000Z",
    };
    const retained = { ...rejected, accessToken: "other-access", refreshToken: "other-refresh" };
    try {
      const saved = await memoryProfiles([
        { profile: OWNER, credential: rejected },
        { profile: OTHER, credential: retained },
      ]);
      await expect(
        createProductionAuthenticatedProductApi(new AbortController().signal, {
          environment: { OHMYHOST_ENVIRONMENT: "production" },
          fetch: fixture.fetch,
          now: () => new Date("2026-08-26T01:00:00.000Z"),
          profiles: saved.registry,
          request: { name: OWNER.name },
        }),
      ).rejects.toEqual(new ProductApiAuthenticationError("authentication_required"));
      // Only the login the provider rejected is removed; the other account's login stays saved.
      expect(await saved.credential(OWNER)).toBeUndefined();
      expect(await saved.registry.list()).toEqual([OTHER]);
      expect(await saved.credential(OTHER)).toEqual(retained);
      expect(fixture.requests).toHaveLength(1);
      await saved.registry.save(OWNER, rejected);
      vi.stubGlobal("fetch", fixture.fetch);
      const output: string[] = [];
      expect(
        await runProductionCli(
          ["whoami", "--profile-name", OWNER.name, "--json"],
          { OHMYHOST_ENVIRONMENT: "production" },
          { writeStdout: (value) => output.push(value), writeStderr: () => undefined },
          new AbortController().signal,
          { profiles: saved.registry },
        ),
      ).toBe(5);
      expect(JSON.parse(output.join("")).error).toMatchObject({
        code: "authentication_required",
        retryable: false,
        suggested_action:
          "The sign-in of saved login owner (user user_owner, organization 01M0WRKSPACEAAAAAAAAAAAAAA) ended and it was removed. Run 'OHMYHOST_ENVIRONMENT=production ohmyhost login --organization 01M0WRKSPACEAAAAAAAAAAAAAA --user user_owner --profile-name owner --json' to sign it in again.",
      });
      expect(await saved.registry.list()).toEqual([OTHER]);
      expect(await saved.credential(OTHER)).toEqual(retained);
      expect(fixture.requests).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
      await fixture.close();
    }
  });

  it("retains credentials on uncertain or malformed refresh responses without leaking provider content or retrying", async () => {
    const fixture = await refreshFixture();
    try {
      for (const mode of ["unavailable", "malformed"]) {
        fixture.setMode(mode);
        const retained = {
          accessToken: "expired",
          refreshToken: "retained-refresh",
          expiresAt: "2026-08-26T00:00:00.000Z",
        };
        const saved = await memoryProfiles([{ profile: OWNER, credential: retained }]);
        const before = fixture.requests.length;
        await expect(
          createProductionAuthenticatedProductApi(new AbortController().signal, {
            environment: { OHMYHOST_ENVIRONMENT: "production" },
            fetch: fixture.fetch,
            profiles: saved.registry,
          }),
        ).rejects.toEqual(new ProductApiAuthenticationError("token_refresh_failed"));
        expect(await saved.credential(OWNER)).toEqual(retained);
        expect(saved.writes).toEqual([]);
        expect(fixture.requests).toHaveLength(before + 1);
      }
    } finally {
      await fixture.close();
    }
  });
  it("reads an unexpired native credential and exposes the generated REST deployment projection", async () => {
    const saved = await memoryProfiles([
      {
        profile: OWNER,
        credential: {
          accessToken: "access-current",
          refreshToken: "refresh-current",
          expiresAt: "2026-08-26T02:00:00.000Z",
        },
      },
    ]);
    let requestedUrl = "";
    let authorization: string | null = null;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      authorization = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ).get("authorization");
      return Response.json(deployment);
    });
    const api = await createProductionAuthenticatedProductApi(new AbortController().signal, {
      profiles: saved.registry,
      fetch,
      now: () => new Date("2026-08-26T01:00:00.000Z"),
      productApiOrigin: "https://control.example.test",
    });

    await expect(
      api.getDeployment({ projectId: deployment.project_id, deploymentId: deployment.id }),
    ).resolves.toEqual(deployment);
    expect(requestedUrl).toBe(
      `https://control.example.test/v1/projects/${deployment.project_id}/deployments/${deployment.id}`,
    );
    expect(authorization).toBe("Bearer access-current");
    expect(saved.writes).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes an expired credential through the existing lifecycle port before SDK creation", async () => {
    const saved = await memoryProfiles([
      {
        profile: OWNER,
        credential: {
          accessToken: "access-expired",
          refreshToken: "refresh-current",
          expiresAt: "2026-08-26T00:00:00.000Z",
        },
      },
    ]);
    const refresh = vi.fn(async (refreshToken: string) => {
      expect(refreshToken).toBe("refresh-current");
      return {
        accessToken: "access-refreshed",
        refreshToken: "refresh-refreshed",
        expiresAt: "2026-08-26T03:00:00.000Z",
      };
    });
    let authorization: string | null = null;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      authorization = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      ).get("authorization");
      return Response.json(deployment);
    });
    const api = await createProductionAuthenticatedProductApi(new AbortController().signal, {
      profiles: saved.registry,
      fetch,
      now: () => new Date("2026-08-26T01:00:00.000Z"),
      productApiOrigin: "https://control.example.test",
      tokenRefresher: { refresh },
    });
    await api.getDeployment({ projectId: deployment.project_id, deploymentId: deployment.id });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await saved.credential(OWNER)).toEqual({
      accessToken: "access-refreshed",
      refreshToken: "refresh-refreshed",
      expiresAt: "2026-08-26T03:00:00.000Z",
    });
    expect(authorization).toBe("Bearer access-refreshed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails before SDK or network creation when authentication is unavailable", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createProductionAuthenticatedProductApi(new AbortController().signal, {
        profiles: (await memoryProfiles()).registry,
        fetch,
      }),
    ).rejects.toEqual(
      new ProfileSelectionError(
        "authentication_required",
        5,
        "No login is saved on this computer. Run 'OHMYHOST_ENVIRONMENT=production ohmyhost login --json'.",
      ),
    );
    // A saved login whose credential entry is gone asks for exactly that login again.
    const orphaned = await memoryProfiles([
      {
        profile: OWNER,
        credential: {
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    ]);
    await orphaned.registry.credential(OWNER).clear();
    await expect(
      createProductionAuthenticatedProductApi(new AbortController().signal, {
        profiles: orphaned.registry,
        fetch,
      }),
    ).rejects.toEqual(
      new ProfileSelectionError(
        "authentication_required",
        5,
        "The saved login owner has no credential on this computer. Run 'OHMYHOST_ENVIRONMENT=production ohmyhost login --organization 01M0WRKSPACEAAAAAAAAAAAAAA --profile-name owner --json'.",
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails closed when an expired credential cannot be refreshed", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createProductionAuthenticatedProductApi(new AbortController().signal, {
        profiles: (
          await memoryProfiles([
            {
              profile: OWNER,
              credential: { accessToken: "expired", refreshToken: "refresh", expiresAt: "" },
            },
          ])
        ).registry,
        fetch,
        tokenRefresher: { refresh: async () => Promise.reject(new Error("offline")) },
      }),
    ).rejects.toEqual(new ProductApiAuthenticationError("token_refresh_failed"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
