import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _ctx: unknown,
      protected env: unknown,
    ) {}
  },
}));
import { GrowthIdentityService } from "../src/worker-main.js";
import { createGrowthIdentityReader } from "../src/growth-identity.js";

describe("growth identity provider boundary", () => {
  it("returns only original minimized events and rejects invalid pagination", async () => {
    const reader = createGrowthIdentityReader({
      credential: "secret-value",
      environment: "development",
      fetcher: async (request) => {
        expect(new URL(request.url).searchParams.get("limit")).toBe("3");
        return Response.json({
          data: [
            {
              id: "event_1",
              event: "user.created",
              created_at: "2026-01-01T00:00:00.000Z",
              data: { id: "user_1", email: "private@example.com" },
              context: { client_id: "client_1" },
            },
            {
              id: "event_2",
              event: "session.created",
              created_at: "2026-01-02T00:00:00.000Z",
              data: { user_id: "user_1", token: "secret" },
            },
            {
              id: "event_3",
              event: "user.deleted",
              created_at: "2026-01-03T00:00:00.000Z",
              data: { id: "user_1", email: "private@example.com" },
            },
          ],
          list_metadata: { after: "event_2" },
        });
      },
    });
    const result = await reader.readGrowthIdentityPage({ cursor: null, limit: 3 });
    expect(result.facts).toMatchObject([
      {
        event_id: "event_1",
        event_name: "account_created",
        account_id: "user_1",
        occurred_at: "2026-01-01T00:00:00.000Z",
      },
      { event_id: "event_3", event_name: "account_deleted", account_id: "user_1" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private@example|secret|client_1/);
    expect(result.next_cursor).toBe("event_2");
    await expect(reader.readGrowthIdentityPage({ cursor: null, limit: 201 })).rejects.toThrow();
  });
  it("backfills current users without inventing authentication history", async () => {
    const reader = createGrowthIdentityReader({
      credential: "secret-value",
      environment: "development",
      fetcher: async () =>
        Response.json({
          data: [
            {
              id: "user_1",
              created_at: "2020-01-01T00:00:00.000Z",
              last_sign_in_at: "2025-01-01T00:00:00.000Z",
              email: "private@example.com",
            },
          ],
          list_metadata: { after: null },
        }),
    });
    const page = await reader.readGrowthUserSnapshotPage({ cursor: null, limit: 200 });
    expect(page.facts).toMatchObject([
      {
        event_id: "snapshot:user_1",
        event_name: "account_created",
        evidence_kind: "snapshot",
        occurred_at: "2020-01-01T00:00:00.000Z",
      },
    ]);
    expect(page.history_floor).toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/private@example|2025-01-01/);
  });

  it("resolves only one exact existing user and minimizes identity", async () => {
    const reader = createGrowthIdentityReader({
      credential: "secret-value",
      environment: "development",
      fetcher: async () =>
        Response.json({
          id: "user_1",
          email: "name@example.com",
          first_name: "Alex",
          last_name: "Smith",
          metadata: { secret: "hidden" },
        }),
    });
    expect(await reader.getGrowthIdentity({ user_id: "user_1" })).toEqual({
      name: "Alex Smith",
      email: "name@example.com",
    });
    await expect(
      reader.getGrowthIdentity({ user_id: "user_1", other: true } as never),
    ).rejects.toThrow();
    const unavailable = createGrowthIdentityReader({
      credential: "secret-value",
      environment: "development",
      fetcher: async () => new Response(null, { status: 404 }),
    });
    await expect(unavailable.getGrowthIdentity({ user_id: "user_1" })).rejects.toThrow(
      "workos_growth_unavailable",
    );
  });
});

it("uses private Worker bindings for all identity RPCs and returns minimized data", async () => {
  const calls: string[] = [];
  const fetcher = vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    calls.push(url.pathname);
    expect(request.headers.get("authorization")).toBe("Bearer sk_test_private_fixture");
    if (url.pathname === "/user_management/users/user_1")
      return Response.json({
        id: "user_1",
        first_name: "Alex",
        email: "alex@example.test",
        metadata: { secret: "hidden" },
      });
    if (url.pathname === "/events")
      return Response.json({
        data: [
          {
            id: "event_1",
            event: "user.created",
            created_at: "2026-01-01T00:00:00.000Z",
            data: { id: "user_1", email: "private@example.test" },
          },
        ],
        list_metadata: { after: null },
      });
    if (url.pathname === "/user_management/users")
      return Response.json({
        data: [
          { id: "user_1", created_at: "2020-01-01T00:00:00.000Z", email: "private@example.test" },
        ],
        list_metadata: { after: null },
      });
    throw new Error(`unexpected path ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetcher);
  try {
    const Entry = GrowthIdentityService as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => GrowthIdentityService;
    const env = {
      WORKOS_DEPLOYMENT: "development",
      WORKOS_MANAGEMENT_CREDENTIAL: "sk_test_private_fixture",
      MANAGEMENT_ARTIFACT_SHA256: "a".repeat(64),
      CF_VERSION_METADATA: {
        id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
        tag: "a".repeat(64),
        timestamp: "2026-08-19T10:00:00.000Z",
      },
      CONTROL_RUNTIME: {},
    };
    const service = new Entry({}, env);
    const events = await service.readGrowthIdentityPage({ cursor: null, limit: 3 });
    const users = await service.readGrowthUserSnapshotPage({ cursor: null, limit: 3 });
    const identity = await service.getGrowthIdentity({ user_id: "user_1" });
    expect(events.facts).toMatchObject([{ event_id: "event_1", account_id: "user_1" }]);
    expect(users.facts).toMatchObject([{ event_id: "snapshot:user_1", account_id: "user_1" }]);
    expect(identity).toEqual({ name: "Alex", email: "alex@example.test" });
    expect(JSON.stringify([events, users, identity])).not.toMatch(/private@example|hidden|sk_test/);
    expect(calls).toEqual(["/events", "/user_management/users", "/user_management/users/user_1"]);
    const invalid = new Entry({}, { ...env, WORKOS_DEPLOYMENT: "wrong" });
    await expect(invalid.readGrowthIdentityPage({ cursor: null, limit: 3 })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    vi.unstubAllGlobals();
  }
});
