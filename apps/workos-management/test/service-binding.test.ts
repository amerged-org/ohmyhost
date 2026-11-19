import { describe, expect, it } from "vitest";

import {
  createPrivateServiceBindingHandler,
  createServiceBindingAuthenticator,
} from "../src/index.js";

describe("private Cloudflare service-binding RPC", () => {
  it("accepts only the module-private binding capability and rejects lookalikes", async () => {
    const boundary = createServiceBindingAuthenticator();
    await expect(
      boundary.authenticator.authenticate({ authentication: {}, requestId: "request_1" }),
    ).resolves.toBe(false);
    await expect(
      boundary.authenticator.authenticate({ authentication: "proof", requestId: "request_1" }),
    ).resolves.toBe(false);
    await expect(
      boundary.authenticator.authenticate({
        authentication: boundary.authentication,
        requestId: "request_1",
      }),
    ).resolves.toBe(true);
  });

  it("exposes one bounded POST endpoint without forwarding caller authentication", async () => {
    const calls: unknown[] = [];
    const handler = createPrivateServiceBindingHandler({
      rpc: {
        dispatch: async (request, authentication) => {
          calls.push({ request, authentication });
          return {
            status: 200,
            body: {
              method: "organizations.get_current_snapshot",
              requestId: "request_1",
              ok: false,
              error: { code: "not_found" },
            },
          };
        },
      },
      maxRequestBytes: 256,
    });

    const response = await handler.fetch(
      new Request("https://workos-management.internal/rpc", {
        method: "POST",
        body: JSON.stringify({ method: "organizations.get_current_snapshot" }),
        headers: { authorization: "Bearer caller-controlled", "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("caller-controlled");

    await expect(
      handler.fetch(new Request("https://workos-management.internal/rpc", { method: "GET" })),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      handler.fetch(
        new Request("https://workos-management.internal/rpc", {
          method: "POST",
          body: "x".repeat(257),
        }),
      ),
    ).resolves.toMatchObject({ status: 413 });
  });

  it("keeps session status separate, minimized, and unavailable on any uncertainty", async () => {
    const checks: unknown[] = [];
    const handler = createPrivateServiceBindingHandler({
      rpc: {
        dispatch: async () => ({
          status: 503,
          body: { ok: false, error: { code: "unavailable" } },
        }),
      },
      sessionStatus: {
        check: async (value: unknown) => {
          checks.push(value);
          return { active: false };
        },
      },
      maxRequestBytes: 256,
    });
    const body = {
      sessionId: "session_01",
      userId: "user_01",
      organizationId: "org_01",
      tokenExpiresAt: 1_787_137_200,
    };
    const response = await handler.fetch(
      new Request("https://workos-management.internal/session-status", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ active: false });
    expect(checks).toEqual([body]);

    const unavailable = createPrivateServiceBindingHandler({
      rpc: {
        dispatch: async () => ({
          status: 503,
          body: { ok: false, error: { code: "unavailable" } },
        }),
      },
      sessionStatus: { check: async () => Promise.reject(new Error("sensitive detail")) },
      maxRequestBytes: 8,
    });
    for (const request of [
      new Request("https://workos-management.internal/session-status", {
        method: "POST",
        body: "not-json",
      }),
      new Request("https://workos-management.internal/session-status", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    ]) {
      const failure = await unavailable.fetch(request);
      expect(failure.status).toBe(503);
      expect(await failure.json()).toEqual({ active: false });
    }
  });
});
