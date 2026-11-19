import { describe, expect, it } from "vitest";

import { createWorkosManagementRpc, WorkosTransportFailure } from "../src/index.js";
import {
  FixtureAuthenticator,
  FixtureResolver,
  FixtureTransport,
  SequenceClock,
} from "./fixtures.js";

const organizationRequest = {
  method: "organizations.get_current_snapshot",
  requestId: "request_1",
  payload: { workosOrganizationId: "org_workos" },
};

const fgaRequest = {
  method: "fga.check_candidate",
  requestId: "request_2",
  payload: {
    principal: { kind: "user", id: "user:user_1", authenticationMethod: "interactive" },
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    resource: { type: "organization", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    action: "project.create",
  },
};

const createRpc = (candidateFgaEnabled = false) => {
  const authenticator = new FixtureAuthenticator();
  const resolver = new FixtureResolver();
  const transport = new FixtureTransport();
  return {
    authenticator,
    resolver,
    transport,
    rpc: createWorkosManagementRpc({
      authenticator,
      resolver,
      transport,
      candidateFgaEnabled,
      clock: new SequenceClock([new Date("2026-08-18T12:00:00.000Z")]),
    }),
  };
};

describe("internal WorkOS management RPC", () => {
  it("rejects malformed and unauthenticated requests without invoking credential resolution", async () => {
    const malformed = createRpc();
    await expect(malformed.rpc.dispatch({ method: "secrets.get" }, "proof")).resolves.toEqual({
      status: 400,
      body: { ok: false, error: { code: "invalid_request" } },
    });
    expect(malformed.resolver.uses).toBe(0);

    const unauthenticated = createRpc();
    unauthenticated.authenticator.allowed = false;
    await expect(unauthenticated.rpc.dispatch(organizationRequest, "bad-proof")).resolves.toEqual({
      status: 401,
      body: { ok: false, error: { code: "invalid_request" } },
    });
    expect(unauthenticated.resolver.uses).toBe(0);
  });

  it("returns a validated current snapshot through the opaque resolver capability", async () => {
    const fixture = createRpc();
    const result = await fixture.rpc.dispatch(organizationRequest, "proof");
    expect(result).toMatchObject({
      status: 200,
      body: {
        method: "organizations.get_current_snapshot",
        requestId: "request_1",
        ok: true,
        result: { snapshot: { organization: { id: "org_workos" } } },
      },
    });
    expect(fixture.transport.snapshotRequests).toEqual(["org_workos"]);
    expect(fixture.resolver.uses).toBe(1);
  });

  it("keeps FGA absent unless the nonproduction candidate explicitly enables it", async () => {
    const disabled = createRpc();
    await expect(disabled.rpc.dispatch(fgaRequest, "proof")).resolves.toMatchObject({
      status: 200,
      body: { ok: false, error: { code: "not_found" } },
    });
    expect(disabled.resolver.uses).toBe(0);

    const enabled = createRpc(true);
    enabled.transport.fgaDecision = "allow";
    await expect(enabled.rpc.dispatch(fgaRequest, "proof")).resolves.toMatchObject({
      status: 200,
      body: { ok: true, result: { decision: "allow" } },
    });
    expect(enabled.transport.fgaRequests).toHaveLength(1);
  });

  it("returns only sanitized read-only capability observations", async () => {
    const fixture = createRpc();
    fixture.transport.capabilityObservations = [
      { id: "organizations_read", available: true, statusCode: 200, count: 1 },
      { id: "webhook_endpoints_read", available: false, statusCode: 403 },
    ];
    await expect(
      fixture.rpc.dispatch(
        { method: "capabilities.probe_read_only", requestId: "request_3", payload: {} },
        "proof",
      ),
    ).resolves.toEqual({
      status: 200,
      body: {
        method: "capabilities.probe_read_only",
        requestId: "request_3",
        ok: true,
        result: { observations: fixture.transport.capabilityObservations },
      },
    });
  });

  it("maps provider failures to allowlisted redacted results", async () => {
    const missing = createRpc();
    missing.transport.snapshotError = new WorkosTransportFailure("not_found");
    await expect(missing.rpc.dispatch(organizationRequest, "proof")).resolves.toMatchObject({
      status: 200,
      body: { ok: false, error: { code: "not_found" } },
    });

    const unavailable = createRpc();
    unavailable.transport.snapshotError = new Error("raw provider detail must not escape");
    await expect(unavailable.rpc.dispatch(organizationRequest, "proof")).resolves.toEqual({
      status: 503,
      body: { ok: false, error: { code: "unavailable" } },
    });
    expect(
      JSON.stringify(await unavailable.rpc.dispatch(organizationRequest, "proof")),
    ).not.toContain("raw provider detail");
  });
});
