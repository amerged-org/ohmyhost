import { describe, expect, it, vi } from "vitest";

import type { WorkosPollResult } from "../src/poller.js";
import worker, {
  createWorkosManagementWorkerEntrypoint,
  SCHEDULED_POLL_BUDGET_MS,
  SCHEDULED_POLL_MAX_CONSECUTIVE_FAILURES,
  SCHEDULED_POLL_MAX_EVENTS,
  SignupFeedbackRecipientsService,
} from "../src/worker-main.js";

// Host-runtime adapter only; the entrypoint is exercised with real parsing and composition.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _context: unknown,
      protected readonly env: unknown,
    ) {}
  },
}));

const capabilityBindings = {
  WORKOS_DEPLOYMENT: "development",
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
  CONTROL_RUNTIME: {},
} as const;

const scheduledAt = Date.parse("2026-08-19T10:01:00.000Z");
const fixtureClaimToken = [8, 4, 4, 4, 12]
  .map((length, index) => (index === 2 ? "4" : index === 3 ? "8" : "").padEnd(length, "0"))
  .join("-");

describe("Cloudflare workos-management entrypoint", () => {
  it("resolves feedback recipients only through the exact private claim capability", async () => {
    const claim = { userId: "user_123", claimToken: fixtureClaimToken };
    const isSignupFeedbackClaim = vi.fn().mockResolvedValue(true);
    const fetcher = vi.fn(async () =>
      Response.json({
        object: "user",
        id: claim.userId,
        email_verified: true,
        email: "person@example.test",
        first_name: "Sam",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const Entry = SignupFeedbackRecipientsService as unknown as new (
        context: unknown,
        env: unknown,
      ) => SignupFeedbackRecipientsService;
      const service = new Entry(
        {},
        {
          ...capabilityBindings,
          WORKOS_MANAGEMENT_CREDENTIAL: "sk_test_private_management_value",
          CONTROL_RUNTIME: { isSignupFeedbackClaim },
        },
      );
      await expect(service.resolve(claim)).resolves.toEqual({
        eligible: true,
        email: "person@example.test",
        firstName: "Sam",
      });
      expect(isSignupFeedbackClaim).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("composes the read-only WorkOS transport and the private RPC over the service binding", async () => {
    const secret = "sk_test_private_management_value";
    const entrypoint = createWorkosManagementWorkerEntrypoint({
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
    const response = await entrypoint.fetch(
      new Request("https://internal/rpc", {
        method: "POST",
        body: JSON.stringify({
          method: "organizations.get_current_snapshot",
          requestId: "request_1",
          payload: { workosOrganizationId: "org_01" },
        }),
      }),
      { WORKOS_MANAGEMENT_CREDENTIAL: secret, ...capabilityBindings },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-ohmyhost-management-artifact-sha256")).toBe("a".repeat(64));
    expect(response.headers.get("x-ohmyhost-cloudflare-version-id")).toBe(
      "095f00a7-23a7-43b7-a227-e4c97cab5f22",
    );
    expect(await response.text()).not.toContain(secret);
  });

  it("drains a bounded batch of durable poll claims per scheduled invocation, recovery first", async () => {
    const acknowledged = { outcome: "acknowledged" as const, eventId: "event", changedScope: "o" };
    const failed = {
      outcome: "retry_scheduled" as const,
      eventId: "event",
      errorCode: "WORKOS_UNAVAILABLE",
    };
    const run = async (results: (() => WorkosPollResult) | readonly WorkosPollResult[]) => {
      const recoverOneExpiredFinalClaim = vi.fn(async () => ({
        outcome: "reconciliation_required" as const,
        eventId: "event_expired",
        errorCode: "WORKOS_LEASE_EXPIRED",
      }));
      let index = 0;
      const pollOne = vi.fn(async () =>
        typeof results === "function"
          ? results()
          : (results[index++] ?? ({ outcome: "idle" } as const)),
      );
      const entrypoint = createWorkosManagementWorkerEntrypoint({
        fetcher: async () => new Response("{}"),
        runtimeFactory: vi.fn(() => ({
          graph: { poller: { pollOne, recoverOneExpiredFinalClaim } },
          handler: { fetch: vi.fn() },
        })),
      });
      const outcome = await entrypoint.scheduled(
        { cron: "*/1 * * * *", scheduledTime: scheduledAt },
        { WORKOS_MANAGEMENT_CREDENTIAL: "sk_test_private_management_value", ...capabilityBindings },
      );
      expect(recoverOneExpiredFinalClaim.mock.invocationCallOrder[0]).toBeLessThan(
        pollOne.mock.invocationCallOrder[0] ?? 0,
      );
      return { outcome, polls: pollOne.mock.calls.length };
    };

    // An idle queue is one claim; a queue with work is drained until it is idle.
    expect(await run([])).toEqual({
      outcome: {
        ok: true,
        recovery: {
          outcome: "reconciliation_required",
          eventId: "event_expired",
          errorCode: "WORKOS_LEASE_EXPIRED",
        },
        poll: { outcome: "idle" },
        polled: 0,
      },
      polls: 1,
    });
    expect(await run([acknowledged, acknowledged, acknowledged])).toMatchObject({
      outcome: { poll: acknowledged, polled: 3 },
      polls: 4,
    });
    // Never more than the event budget, however deep the queue is.
    expect(await run(() => acknowledged)).toMatchObject({
      outcome: { polled: SCHEDULED_POLL_MAX_EVENTS },
      polls: SCHEDULED_POLL_MAX_EVENTS,
    });
    // A provider outage stops the run after a few failures instead of spending an attempt of every queued event;
    // an acknowledgement in between resets the count, so a single poisoned event never stops the drain.
    expect(await run(() => failed)).toMatchObject({
      outcome: { poll: failed, polled: SCHEDULED_POLL_MAX_CONSECUTIVE_FAILURES },
      polls: SCHEDULED_POLL_MAX_CONSECUTIVE_FAILURES,
    });
    expect(
      await run([failed, failed, acknowledged, failed, failed, acknowledged, acknowledged]),
    ).toMatchObject({ outcome: { polled: 7 }, polls: 8 });
    // The run ends when its time budget is spent, so it never overlaps the next minute's run.
    vi.useFakeTimers({ toFake: ["Date"], now: scheduledAt });
    try {
      expect(
        await run(() => {
          vi.setSystemTime(Date.now() + SCHEDULED_POLL_BUDGET_MS / 2 + 1);
          return acknowledged;
        }),
      ).toMatchObject({ outcome: { polled: 2 }, polls: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns only a safe scheduled failure when polling fails", async () => {
    const secret = "sk_test_private_management_value";
    const pollOne = vi.fn(async () => {
      throw new Error(`provider rejected ${secret}`);
    });
    const entrypoint = createWorkosManagementWorkerEntrypoint({
      fetcher: async () => new Response("{}"),
      runtimeFactory: () => ({
        graph: { poller: { pollOne, recoverOneExpiredFinalClaim: async () => null } },
        handler: { fetch: vi.fn() },
      }),
    });

    const result = await entrypoint.scheduled(
      { cron: "*/1 * * * *", scheduledTime: scheduledAt },
      { WORKOS_MANAGEMENT_CREDENTIAL: secret, ...capabilityBindings },
    );
    expect(result).toEqual({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(pollOne).toHaveBeenCalledOnce();
  });

  it("does not claim new work when the bounded recovery scan fails", async () => {
    const pollOne = vi.fn(async () => ({ outcome: "idle" as const }));
    const entrypoint = createWorkosManagementWorkerEntrypoint({
      fetcher: async () => new Response("{}"),
      runtimeFactory: () => ({
        graph: {
          poller: {
            pollOne,
            recoverOneExpiredFinalClaim: async () => {
              throw new Error("database detail must not escape");
            },
          },
        },
        handler: { fetch: vi.fn() },
      }),
    });

    await expect(
      entrypoint.scheduled(
        { cron: "*/1 * * * *", scheduledTime: scheduledAt },
        { WORKOS_MANAGEMENT_CREDENTIAL: "sk_test_private_management_value", ...capabilityBindings },
      ),
    ).resolves.toEqual({ ok: false, error: { code: "unavailable" } });
    expect(pollOne).not.toHaveBeenCalled();
  });

  it("keeps the default Worker entrypoint private and read-only", async () => {
    const secret = "sk_test_default_worker_value";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (url.origin === "https://sandbox.authkit.app") {
          if (url.pathname === "/.well-known/openid-configuration") {
            return new Response(
              JSON.stringify({ issuer: url.origin, token_endpoint: `${url.origin}/oauth2/token` }),
            );
          }
          return new Response(
            JSON.stringify({ access_token: "opaque", expires_in: 300, token_type: "bearer" }),
          );
        }
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
        if (url.pathname === "/connect/applications/app_test") {
          return new Response(JSON.stringify({ object: "connect_application", id: "app_test" }));
        }
        if (url.pathname.endsWith("/client_secrets")) return new Response(JSON.stringify([]));
        return new Response(JSON.stringify({ object: "list", data: [] }));
      }),
    );
    try {
      const response = await worker.fetch(
        new Request("https://internal/rpc", {
          method: "POST",
          body: JSON.stringify({
            method: "capabilities.probe_read_only",
            requestId: "request_default",
            payload: {},
          }),
        }),
        { WORKOS_MANAGEMENT_CREDENTIAL: secret, ...capabilityBindings },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("x-ohmyhost-management-artifact-sha256")).toBe("a".repeat(64));
      expect(response.headers.get("x-ohmyhost-cloudflare-version-id")).toBe(
        "095f00a7-23a7-43b7-a227-e4c97cab5f22",
      );
      expect(await response.json()).toMatchObject({ ok: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
