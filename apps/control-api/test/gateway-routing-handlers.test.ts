import { describe, expect, it } from "vitest";

import { createGatewayRoutingHandlers } from "../src/gateway-routing.js";

const ulid = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`;
const scope = {
  organizationId: ulid("AV"),
  projectId: ulid("AW"),
  environmentId: ulid("AX"),
};
const operationId = ulid("AY");
const claimId = ulid("AZ");
const deploymentId = ulid("B1");

function devResolution(hostname: string) {
  return {
    ...scope,
    environmentName: "dev" as const,
    handle: "calm-river-studio",
    hostname,
    publicOrigin: `https://${hostname}`,
    targetDeploymentId: deploymentId,
    targetScriptName: `p-${scope.projectId.toLowerCase()}-dev-${deploymentId.toLowerCase()}`,
    egressAllowedOrigins: [],
    poweredBy: false,
  };
}

describe("shared gateway private Control handlers", () => {
  it("resolves Dev only with a validated public key", async () => {
    const hostname = "dev-calm-river-studio.dev.check.omh.st";
    const pair = await globalThis.crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    const exported = await globalThis.crypto.subtle.exportKey("jwk", pair.publicKey);
    const publicJwk = { crv: exported.crv, kty: exported.kty, x: exported.x, y: exported.y };
    const lookup = { resolve: async () => devResolution(hostname) };
    const dev = createGatewayRoutingHandlers({
      GATEWAY_LOOKUP_RUNTIME: lookup,
      DEV_ACCESS_SESSION_PUBLIC_JWK: JSON.stringify(publicJwk),
    });
    const resolved = await dev.resolve({ hostname });
    expect(resolved?.devAccess).toMatchObject({
      keyId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    const unusable = createGatewayRoutingHandlers({
      GATEWAY_LOOKUP_RUNTIME: lookup,
      DEV_ACCESS_SESSION_PUBLIC_JWK: "{}",
    });
    await expect(unusable.resolve({ hostname })).rejects.toThrow();
  });

  it("rejects malformed authority before calling Core and redacts Core failures", async () => {
    const management = {
      activate: async () => ({}),
      observe: async () => {
        throw new Error("sensitive SQL or tenant detail");
      },
      remove: async () => ({}),
      compensate: async () => ({}),
      authorizeCandidateRemoval: async () => ({}),
    };
    const handlers = createGatewayRoutingHandlers({
      GATEWAY_MANAGEMENT_RUNTIME: management,
      DEV_ACCESS_SESSION_PUBLIC_JWK: "{}",
    });
    await expect(handlers.resolve({ hostname: 3 })).rejects.toThrow("Invalid gateway hostname");
    expect(() =>
      handlers.activate({ ...scope, operationId, claimId, expectedRevision: null }),
    ).toThrow("Invalid gateway routing request");
    expect(() =>
      handlers.remove({ ...scope, operationId, claimId, expectedRevision: null }),
    ).toThrow("Invalid gateway routing revision");
    await expect(handlers.observe(scope)).rejects.toThrow("Gateway routing is unavailable");
  });
});
