import { describe, expect, it } from "vitest";

import { createGatewayRoutingHandlers } from "../src/gateway-routing.js";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`;

describe("private shared gateway routing", () => {
  it("fails closed when the private Core bindings are absent and refuses a direct Core binding", async () => {
    const d1 = { DEV_ACCESS_SESSION_PUBLIC_JWK: "unused" };
    const gateway = createGatewayRoutingHandlers(d1);
    const scope = { organizationId: id("AV"), projectId: id("AW"), environmentId: id("AX") };
    const mutation = { ...scope, operationId: id("AY"), claimId: id("AZ"), expectedRevision: 1 };
    await expect(gateway.resolve({ hostname: "project.example.com" })).rejects.toThrow(
      "Gateway routing is unavailable",
    );
    await expect(gateway.observe(scope)).rejects.toThrow("Gateway routing is unavailable");
    await expect(
      gateway.activate({ ...mutation, candidateReceiptId: id("B0"), egressAllowedOrigins: [] }),
    ).rejects.toThrow("Gateway routing is unavailable");
    await expect(gateway.remove(mutation)).rejects.toThrow("Gateway routing is unavailable");
    await expect(gateway.compensate(mutation)).rejects.toThrow("Gateway routing is unavailable");
    await expect(
      gateway.authorizeCandidateRemoval({
        ...scope,
        operationId: id("AY"),
        claimId: id("AZ"),
        candidateReceiptId: id("B0"),
        productDeploymentId: id("B1"),
        scriptName: `p-${scope.projectId.toLowerCase()}-dev-${id("B1").toLowerCase()}`,
        providerTag: "a".repeat(32),
      }),
    ).rejects.toThrow("Gateway routing is unavailable");
    for (const extra of [
      { CONTROL_CORE: {} },
      { CONTROL_GLOBAL: {} },
      { CONTROL_DIRECTORY: {} },
      { CONTROL_SHARD_0000: {} },
    ])
      expect(() => createGatewayRoutingHandlers({ ...d1, ...extra })).toThrow(
        "Gateway routing is unavailable",
      );
  });

  it("rejects malformed and cross-scope removal requests before a provider call", async () => {
    const gateway = createGatewayRoutingHandlers({ DEV_ACCESS_SESSION_PUBLIC_JWK: "unused" });
    expect(() => gateway.authorizeCandidateRemoval({})).toThrow("Invalid gateway routing request");
    expect(() =>
      gateway.authorizeCandidateRemoval({
        organizationId: id("AV"),
        projectId: id("AW"),
        environmentId: id("AX"),
        operationId: id("AY"),
        claimId: id("AZ"),
        candidateReceiptId: id("B0"),
        productDeploymentId: id("B1"),
        scriptName: `p-${id("B2").toLowerCase()}-dev-${id("B1").toLowerCase()}`,
        providerTag: "a".repeat(32),
      }),
    ).toThrow("Invalid candidate removal identity");
    expect(() =>
      gateway.activate({
        organizationId: id("AV"),
        projectId: id("AW"),
        environmentId: id("AX"),
        operationId: id("AY"),
        claimId: id("AZ"),
        candidateReceiptId: id("B0"),
        expectedRevision: null,
        egressAllowedOrigins: [],
        browserPolicy: { connect: ["https://api.example.com"] },
      }),
    ).toThrow("Invalid browser capability policy");
  });
});
