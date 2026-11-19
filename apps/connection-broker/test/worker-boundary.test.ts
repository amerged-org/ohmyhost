import { expect, test, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    constructor(
      _context: unknown,
      readonly env: unknown,
    ) {}
  },
}));
import worker, { ConnectionBrokerManagementService } from "../src/worker-main.js";

test("unconfigured public worker never offers authorization or management", async () => {
  for (const path of [
    "/oauth/start?handoff=x",
    "/oauth/callback?code=x&state=x",
    "/v1/execute",
    "/private/management",
  ]) {
    const response = await worker.fetch(new Request(`https://connect.ohmyho.st${path}`), {});
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/access_token|refresh_token|authorization_endpoint/);
  }
  const configuredBindings = {
    PLATFORM_ENVIRONMENT: "development",
    CONNECTION_CORE: {},
    CONNECTION_AUTHORITY: {},
  };
  expect(
    (
      await worker.fetch(
        new Request("https://dev.connect.ohmyho.st/oauth/start?handoff=x"),
        configuredBindings as never,
      )
    ).status,
  ).toBe(503);
  const management = new ConnectionBrokerManagementService({}, {});
  expect(await management.providerReadiness({ provider: "make" })).toEqual({
    state: "provider_unconfigured",
  });
  expect(await management.catalogReadiness({ provider: "make" })).toEqual({
    state: "provider_unavailable",
  });
  await expect(management.beginBrowser({} as never)).rejects.toThrow(
    "connection_provider_unavailable",
  );
  await expect(
    management.complete({ result: "x", principalId: "x", sessionId: "x" }),
  ).rejects.toThrow("connection_provider_unavailable");
  await expect(management.listConnectionCatalog({} as never)).rejects.toThrow(
    "connection_provider_unavailable",
  );
  await expect(management.disconnectConnectionGrant({} as never)).rejects.toThrow(
    "connection_provider_unavailable",
  );
  await worker.scheduled({}, {});
});

test("rate-limits public OAuth requests before a Core or provider call", async () => {
  const rateLimitConnectionRequest = vi.fn(async () => false);
  const response = await worker.fetch(
    new Request("https://dev.connect.ohmyho.st/oauth/start?handoff=x", {
      headers: { "cf-connecting-ip": "192.0.2.1" },
    }),
    {
      PLATFORM_ENVIRONMENT: "development",
      CONNECTION_CORE: {},
      CONNECTION_AUTHORITY: { rateLimitConnectionRequest },
    } as never,
  );
  expect(response.status).toBe(429);
  expect(rateLimitConnectionRequest).toHaveBeenCalledWith({ clientAddress: "192.0.2.1" });
});

test("cutover maintenance refuses public OAuth before any Core or provider effect", async () => {
  const rateLimitConnectionRequest = vi.fn();
  for (const path of ["/oauth/start?handoff=x", "/oauth/callback?code=x&state=x"]) {
    const response = await worker.fetch(new Request(`https://dev.connect.ohmyho.st${path}`), {
      OMH_DATABASE_CUTOVER_MAINTENANCE: "on",
      CONNECTION_AUTHORITY: { rateLimitConnectionRequest },
    } as never);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
  }
  expect(rateLimitConnectionRequest).not.toHaveBeenCalled();
});
