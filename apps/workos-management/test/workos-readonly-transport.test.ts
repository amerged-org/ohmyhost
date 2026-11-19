import { describe, expect, it, vi } from "vitest";
import { parseWorkosSessionStatusRequest } from "@ohmyhost/workos-auth-contracts";

import { WorkosTransportFailure, createWorkosReadOnlyBoundary } from "../src/index.js";

const SECRET = "sk_test_private_management_value";
const CONNECT_SECRET = "connect_private_client_secret";

const capabilityProbe = {
  authkitDomain: "https://sandbox.authkit.app",
  connectApplicationId: "app_01M0B63KF2Z7EQZRRDERP1QNRM",
  connectClientId: "client_00000000000000000000000027",
  connectClientSecret: CONNECT_SECRET,
} as const;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const organization = {
  object: "organization",
  id: "org_01",
  name: "Example",
  created_at: "2026-08-19T08:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
  domains: [{ domain: "example.test", verification_token: "must-not-cross" }],
};

const membership = {
  object: "organization_membership",
  id: "om_01",
  organization_id: "org_01",
  user_id: "user_01",
  status: "active",
  roles: [{ slug: "admin" }],
  created_at: "2026-08-19T08:00:00.000Z",
  updated_at: "2026-08-19T09:00:00.000Z",
  user: { email: "private@example.test", custom_attributes: { token: "must-not-cross" } },
};

const sessionRequest = {
  sessionId: "session_01",
  userId: "user_01",
  organizationId: "org_01",
  tokenExpiresAt: 1_787_137_200,
} as const;

const session = (patch: Readonly<Record<string, unknown>> = {}) => ({
  object: "session",
  id: "session_01",
  user_id: "user_01",
  organization_id: "org_01",
  status: "active",
  expires_at: "2026-08-26T11:00:00.000Z",
  ...patch,
});

describe("WorkOS read-only credential boundary", () => {
  it("keeps the secret inside an opaque capability and emits only minimized snapshot fields", async () => {
    const requests: Request[] = [];
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher: async function (this: unknown, request) {
        expect(this).toBe(globalThis);
        requests.push(request);
        return request.url.endsWith("/organizations/org_01")
          ? jsonResponse(organization)
          : jsonResponse({
              object: "list",
              data: [membership],
              list_metadata: { before: null, after: null },
            });
      },
    });

    const result = await boundary.resolver.withWorkosManagementCredential((credential) => {
      expect(JSON.stringify(credential)).not.toContain(SECRET);
      return boundary.transport.fetchCurrentOrganizationSnapshot(credential, "org_01");
    });

    expect(result).toEqual({
      organization: {
        id: "org_01",
        name: "Example",
        created_at: "2026-08-19T08:00:00.000Z",
        updated_at: "2026-08-19T09:00:00.000Z",
      },
      memberships: [
        {
          id: "om_01",
          organization_id: "org_01",
          user_id: "user_01",
          status: "active",
          roles: [{ slug: "admin" }],
          created_at: "2026-08-19T08:00:00.000Z",
          updated_at: "2026-08-19T09:00:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/verification_token|private@example|token/u);
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "https://api.workos.com/organizations/org_01" },
      {
        method: "GET",
        url: "https://api.workos.com/user_management/organization_memberships?organization_id=org_01&limit=100&order=asc",
      },
    ]);
    for (const request of requests) {
      expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    }
  });

  it("rejects foreign credentials, invalid identifiers, oversized bodies, and redacts upstream failures", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ error: SECRET }, 401));
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher,
      maxResponseBytes: 32,
    });

    await expect(
      boundary.transport.fetchCurrentOrganizationSnapshot(Object.freeze({}) as never, "org_01"),
    ).rejects.toMatchObject({ name: "WorkosTransportFailure", code: "permanent" });
    await expect(
      boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.fetchCurrentOrganizationSnapshot(credential, "../escape"),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(fetcher).not.toHaveBeenCalled();

    await expect(
      boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.fetchCurrentOrganizationSnapshot(credential, "org_01"),
      ),
    ).rejects.toMatchObject({ code: "permanent" });
    await expect(
      boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.fetchCurrentOrganizationSnapshot(credential, "org_01"),
      ),
    ).rejects.not.toThrow(SECRET);
  });

  it("classifies a WorkOS outage as retryable and every other transport answer as permanent", async () => {
    const sessionCheck = (fetcher: (request: Request) => Promise<Response>) => {
      const boundary = createWorkosReadOnlyBoundary({ secret: SECRET, fetcher });
      return boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.isSessionActive(credential, sessionRequest),
      );
    };
    for (const status of [408, 429, 500, 503]) {
      await expect(
        sessionCheck(async () => jsonResponse({ detail: SECRET }, status)),
      ).rejects.toMatchObject({
        code: "unavailable",
      });
    }
    await expect(
      sessionCheck(async () => {
        throw new TypeError("fetch failed");
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    for (const status of [400, 401, 403, 422]) {
      await expect(
        sessionCheck(async () => jsonResponse({ detail: SECRET }, status)),
      ).rejects.toMatchObject({
        code: "permanent",
      });
    }
    await expect(
      sessionCheck(async () => new Response(null, { status: 200 })),
    ).rejects.toMatchObject({
      code: "permanent",
    });
    let pages = 0;
    await expect(
      sessionCheck(async () =>
        jsonResponse({
          object: "list",
          data: [],
          list_metadata: { after: `cursor_${(pages += 1)}` },
        }),
      ),
    ).rejects.toMatchObject({ code: "permanent" });
    expect(pages).toBe(100);
  });

  it("follows only bounded WorkOS membership cursors", async () => {
    const requests: string[] = [];
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher: async (request) => {
        requests.push(request.url);
        if (request.url.endsWith("/organizations/org_01")) return jsonResponse(organization);
        return requests.length === 2
          ? jsonResponse({
              object: "list",
              data: [membership],
              list_metadata: { before: null, after: "cursor_2" },
            })
          : jsonResponse({
              object: "list",
              data: [{ ...membership, id: "om_02", user_id: "user_02" }],
              list_metadata: { before: "cursor_1", after: null },
            });
      },
    });

    const snapshot = await boundary.resolver.withWorkosManagementCredential((credential) =>
      boundary.transport.fetchCurrentOrganizationSnapshot(credential, "org_01"),
    );
    expect((snapshot as { memberships: unknown[] }).memberships).toHaveLength(2);
    expect(requests.at(-1)).toBe(
      "https://api.workos.com/user_management/organization_memberships?organization_id=org_01&limit=100&order=asc&after=cursor_2",
    );
  });

  it("aborts the complete paginated snapshot when its globally capped budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      let requests = 0;
      const boundary = createWorkosReadOnlyBoundary({
        secret: SECRET,
        timeoutMs: 10,
        snapshotTimeoutMs: 9,
        fetcher: (request) =>
          new Promise((resolve, reject) => {
            requests += 1;
            const current = requests;
            const timer = setTimeout(
              () =>
                resolve(
                  current === 1
                    ? jsonResponse(organization)
                    : jsonResponse({
                        object: "list",
                        data: [membership],
                        list_metadata: { after: current === 2 ? "cursor_2" : null },
                      }),
                ),
              4,
            );
            request.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error(`upstream detail ${SECRET}`));
              },
              { once: true },
            );
          }),
      });
      const snapshot = boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.fetchCurrentOrganizationSnapshot(credential, "org_01"),
      );
      const rejection = expect(snapshot).rejects.toEqual(new WorkosTransportFailure("unavailable"));
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(requests).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paginates official user sessions and requires one exact active identity covering the token lifetime", async () => {
    const requests: string[] = [];
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher: async (request) => {
        requests.push(request.url);
        return requests.length === 1
          ? jsonResponse({
              object: "list",
              data: [session({ id: "session_other" })],
              list_metadata: { before: null, after: "cursor_2" },
            })
          : jsonResponse({
              object: "list",
              data: [session()],
              list_metadata: { before: "cursor_1", after: null },
            });
      },
    });
    const active = await boundary.resolver.withWorkosManagementCredential((credential) =>
      boundary.transport.isSessionActive(credential, sessionRequest),
    );
    expect(active).toBe(true);
    expect(requests).toEqual([
      "https://api.workos.com/user_management/users/user_01/sessions?limit=100&order=desc",
      "https://api.workos.com/user_management/users/user_01/sessions?limit=100&order=desc&after=cursor_2",
    ]);
  });

  it("reads user sessions newest first, so the current session on a long history is on the first page", async () => {
    const requests: string[] = [];
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher: async (request) => {
        requests.push(request.url);
        const newestFirst = new URL(request.url).searchParams.get("order") === "desc";
        // A long history: the current session is the newest, so it is the first entry of a newest-first page.
        const data = newestFirst
          ? [
              session(),
              ...Array.from({ length: 99 }, (_, index) => session({ id: `session_old_${index}` })),
            ]
          : Array.from({ length: 100 }, (_, index) => session({ id: `session_old_${index}` }));
        return jsonResponse({
          object: "list",
          data,
          list_metadata: { before: null, after: "cursor_2" },
        });
      },
    });
    const active = await boundary.resolver.withWorkosManagementCredential((credential) =>
      boundary.transport.isSessionActive(credential, sessionRequest),
    );
    expect(active).toBe(true);
    expect(requests).toEqual([
      "https://api.workos.com/user_management/users/user_01/sessions?limit=100&order=desc",
    ]);
  });

  it("checks session identity independently of optional initial organization metadata", async () => {
    for (const organizationId of ["org_original_sign_in", null, undefined]) {
      const boundary = createWorkosReadOnlyBoundary({
        secret: SECRET,
        fetcher: async () =>
          jsonResponse({
            object: "list",
            data: [session({ organization_id: organizationId })],
            list_metadata: { before: null, after: null },
          }),
      });

      await expect(
        boundary.resolver.withWorkosManagementCredential((credential) =>
          boundary.transport.isSessionActive(
            credential,
            parseWorkosSessionStatusRequest({
              ...sessionRequest,
              organizationId: organizationId === null ? null : sessionRequest.organizationId,
            }),
          ),
        ),
      ).resolves.toBe(true);
    }
  });

  it.each([
    { name: "session", patch: { id: "session_other" } },
    { name: "user", patch: { user_id: "user_other" } },
    { name: "status", patch: { status: "ended" } },
    { name: "expiry", patch: { expires_at: "2026-08-19T10:59:59.000Z" } },
  ])("returns inactive for wrong $name identity", async ({ patch }) => {
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher: async () =>
        jsonResponse({
          object: "list",
          data: [session(patch)],
          list_metadata: { before: null, after: null },
        }),
    });
    await expect(
      boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.isSessionActive(credential, sessionRequest),
      ),
    ).resolves.toBe(false);
  });

  it("returns inactive when the requested session is missing", async () => {
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher: async () =>
        jsonResponse({ object: "list", data: [], list_metadata: { before: null, after: null } }),
    });

    await expect(
      boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.isSessionActive(credential, sessionRequest),
      ),
    ).resolves.toBe(false);
  });

  it.each([404, 429, 500])("fails closed for WorkOS session status %s", async (status) => {
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      fetcher: async () => jsonResponse({ detail: SECRET }, status),
    });
    await expect(
      boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.isSessionActive(credential, sessionRequest),
      ),
    ).rejects.toBeInstanceOf(WorkosTransportFailure);
  });

  it("aborts a timed-out WorkOS session request", async () => {
    vi.useFakeTimers();
    try {
      const boundary = createWorkosReadOnlyBoundary({
        secret: SECRET,
        timeoutMs: 5,
        fetcher: (request) =>
          new Promise((_resolve, reject) => {
            request.signal.addEventListener("abort", () => reject(new Error("upstream detail")));
          }),
      });
      const status = boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.isSessionActive(credential, sessionRequest),
      );
      const rejection = expect(status).rejects.toBeInstanceOf(WorkosTransportFailure);
      await vi.advanceTimersByTimeAsync(6);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed session pages and cursor loops", async () => {
    for (const body of [
      { object: "list", data: [{}], list_metadata: { after: null } },
      {
        object: "list",
        data: [session({ id: "session_other" })],
        list_metadata: { after: "same" },
      },
    ]) {
      const boundary = createWorkosReadOnlyBoundary({
        secret: SECRET,
        fetcher: async () => jsonResponse(body),
      });
      await expect(
        boundary.resolver.withWorkosManagementCredential((credential) =>
          boundary.transport.isSessionActive(credential, sessionRequest),
        ),
      ).rejects.toBeInstanceOf(WorkosTransportFailure);
    }
  });

  it("probes the complete allowlisted capability matrix without returning credentials", async () => {
    const requests: Request[] = [];
    const boundary = createWorkosReadOnlyBoundary({
      secret: SECRET,
      capabilityProbe,
      fetcher: async (request) => {
        requests.push(request);
        const url = new URL(request.url);
        if (url.origin === "https://sandbox.authkit.app") {
          if (url.pathname === "/.well-known/openid-configuration") {
            return jsonResponse({
              issuer: url.origin,
              token_endpoint: `${url.origin}/oauth2/token`,
            });
          }
          if (url.pathname === "/oauth2/token") {
            return jsonResponse({
              access_token: "must-not-cross",
              expires_in: 300,
              token_type: "bearer",
            });
          }
        }
        if (url.pathname === "/organizations") {
          return jsonResponse({ object: "list", data: [organization] });
        }
        if (url.pathname === "/user_management/organization_memberships") {
          return jsonResponse({ object: "list", data: [membership] });
        }
        if (url.pathname === "/connect/applications/app_01M0B63KF2Z7EQZRRDERP1QNRM") {
          return jsonResponse({
            object: "connect_application",
            id: capabilityProbe.connectApplicationId,
          });
        }
        if (url.pathname.endsWith("/client_secrets")) {
          return jsonResponse([{ object: "connect_application_secret", secret_hint: "6057" }]);
        }
        if (url.pathname === "/authorization/resources") {
          return jsonResponse({ object: "list", data: [] });
        }
        if (url.pathname === "/webhook_endpoints") {
          return jsonResponse({
            object: "list",
            data: [{ id: "we_01", secret: "must-not-cross" }],
          });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      },
    });

    const observations = await boundary.resolver.withWorkosManagementCredential((credential) =>
      boundary.transport.probeReadOnlyCapabilities(credential),
    );
    expect(observations).toEqual([
      { id: "authkit_oidc_metadata", available: true, statusCode: 200 },
      { id: "connect_applications_read", available: true, statusCode: 200, count: 1 },
      { id: "connect_client_secrets_metadata_read", available: true, statusCode: 200, count: 1 },
      { id: "fga_resources_read", available: true, statusCode: 200, count: 0 },
      { id: "memberships_read", available: true, statusCode: 200, count: 1 },
      { id: "m2m_token_flow", available: true, statusCode: 200 },
      { id: "organizations_read", available: true, statusCode: 200, count: 1 },
      { id: "webhook_endpoints_read", available: true, statusCode: 200, count: 1 },
    ]);
    const tokenRequest = requests.find(({ url }) => url.endsWith("/oauth2/token"));
    expect(tokenRequest?.method).toBe("POST");
    expect(await tokenRequest?.clone().text()).toBe(
      `client_id=${capabilityProbe.connectClientId}&client_secret=${CONNECT_SECRET}&grant_type=client_credentials`,
    );
    expect(JSON.stringify(observations)).not.toMatch(/must-not-cross|6057|connect_private/u);
    for (const request of requests.filter(({ url }) => url.startsWith("https://api.workos.com"))) {
      expect(request.method).toBe("GET");
      expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    }
    await expect(
      boundary.resolver.withWorkosManagementCredential((credential) =>
        boundary.transport.checkCandidateFga(credential, {
          principal: { kind: "user", id: "user:user_1", authenticationMethod: "interactive" },
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          resource: { type: "organization", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
          action: "project.create",
        }),
      ),
    ).rejects.toMatchObject({ code: "permanent" });
  });

  it("fails closed when the capability configuration is incomplete or crosses an origin", () => {
    expect(() =>
      createWorkosReadOnlyBoundary({
        secret: SECRET,
        capabilityProbe: { ...capabilityProbe, authkitDomain: "https://attacker.example" },
        fetcher: async () => jsonResponse({}),
      }),
    ).toThrow("capability");
    expect(() =>
      createWorkosReadOnlyBoundary({
        secret: SECRET,
        capabilityProbe: { ...capabilityProbe, connectClientSecret: "" },
        fetcher: async () => jsonResponse({}),
      }),
    ).toThrow("capability");
    for (const snapshotTimeoutMs of [0, 20_001]) {
      expect(() =>
        createWorkosReadOnlyBoundary({
          secret: SECRET,
          snapshotTimeoutMs,
          fetcher: async () => jsonResponse({}),
        }),
      ).toThrow("snapshot timeout");
    }
  });
});
