import { describe, expect, it } from "vitest";

import {
  createWorkosManagementWorkerRuntime,
  type WorkosManagementWorkerBindings,
} from "../src/worker-runtime.js";
import { FixtureDatabase, FixedIds, FixedOrganizationIds, SequenceClock } from "./fixtures.js";

const bindings = (): WorkosManagementWorkerBindings => ({
  WORKOS_DEPLOYMENT: "production",
  WORKOS_MANAGEMENT_CREDENTIAL: "sk_test_private_management_value",
  MANAGEMENT_ARTIFACT_SHA256: "a".repeat(64),
  CF_VERSION_METADATA: {
    id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
    tag: "a".repeat(64),
    timestamp: "2026-08-19T10:00:00.000Z",
  },
  CONTROL_RUNTIME: {},
});

describe("private WorkOS management Worker runtime", () => {
  it("fails closed when required secret or service bindings are absent", () => {
    const dependencies = {
      sessionAnswers: new Map(),
      database: new FixtureDatabase(),
      fetcher: async () => new Response("{}"),
      clock: new SequenceClock([new Date("2026-08-19T10:00:00.000Z")]),
      ids: new FixedIds(),
      organizationIds: new FixedOrganizationIds(),
    };
    expect(() => createWorkosManagementWorkerRuntime({ ...dependencies, bindings: {} })).toThrow(
      "bindings",
    );
    expect(() =>
      createWorkosManagementWorkerRuntime({
        ...dependencies,
        bindings: {
          WORKOS_MANAGEMENT_CREDENTIAL: "sk_test_private_management_value",
          MANAGEMENT_ARTIFACT_SHA256: "a".repeat(64),
          CF_VERSION_METADATA: {
            id: "095f00a7-23a7-43b7-a227-e4c97cab5f22",
            tag: "a".repeat(64),
            timestamp: "2026-08-19T10:00:00.000Z",
          },
          WORKOS_AUTHKIT_DOMAIN: "https://sandbox.authkit.app",
          WORKOS_CONNECT_APPLICATION_ID: "app_test",
          WORKOS_CONNECT_CLIENT_ID: "client_test",
          WORKOS_CONNECT_CLIENT_SECRET: "connect_test_private_value",
        },
      }),
    ).toThrow("bindings");
    expect(() =>
      createWorkosManagementWorkerRuntime({
        ...dependencies,
        bindings: { ...bindings(), WORKOS_AUTHKIT_DOMAIN: "https://sandbox.authkit.app" },
      }),
    ).toThrow("bindings");
  });

  it("serves private organization RPC without a separate Connect probe credential", async () => {
    const secret = bindings().WORKOS_MANAGEMENT_CREDENTIAL;
    const runtime = createWorkosManagementWorkerRuntime({
      sessionAnswers: new Map(),
      bindings: bindings(),
      database: new FixtureDatabase(),
      clock: new SequenceClock([new Date("2026-08-19T10:00:00.000Z")]),
      ids: new FixedIds(),
      organizationIds: new FixedOrganizationIds(),
      fetcher: async (request) => {
        expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
        return request.url.includes("organization_memberships")
          ? new Response(
              JSON.stringify({ object: "list", data: [], list_metadata: { after: null } }),
            )
          : new Response(
              JSON.stringify({
                id: "org_01",
                name: "Example",
                created_at: "2026-08-19T08:00:00.000Z",
                updated_at: "2026-08-19T09:00:00.000Z",
              }),
            );
      },
    });

    const response = await runtime.handler.fetch(
      new Request("https://workos-management.internal/rpc", {
        method: "POST",
        body: JSON.stringify({
          method: "organizations.get_current_snapshot",
          requestId: "request_1",
          payload: { workosOrganizationId: "org_01" },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).toContain('"id":"org_01"');
    expect(serialized).not.toContain(secret);
    expect(runtime.graph.deployment).toBe("production");
    const probe = await runtime.handler.fetch(
      new Request("https://workos-management.internal/rpc", {
        method: "POST",
        body: JSON.stringify({
          method: "capabilities.probe_read_only",
          requestId: "request_probe",
          payload: {},
        }),
      }),
    );
    expect(probe.status).toBe(503);
    expect(await probe.json()).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("serves minimized uncached session status without a separate Connect probe credential", async () => {
    const database = new FixtureDatabase();
    const runtime = createWorkosManagementWorkerRuntime({
      sessionAnswers: new Map(),
      bindings: bindings(),
      database,
      clock: new SequenceClock([new Date("2026-08-19T10:00:00.000Z")]),
      ids: new FixedIds(),
      organizationIds: new FixedOrganizationIds(),
      fetcher: async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "session",
                id: "session_01",
                user_id: "user_01",
                organization_id: "org_01",
                status: "active",
                expires_at: "2026-08-19T11:00:00.000Z",
              },
            ],
            list_metadata: { before: null, after: null },
          }),
        ),
    });
    const response = await runtime.handler.fetch(
      new Request("https://workos-management.internal/session-status", {
        method: "POST",
        body: JSON.stringify({
          sessionId: "session_01",
          userId: "user_01",
          organizationId: "org_01",
          tokenExpiresAt: 1_787_137_200,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ active: true });
  });
});
